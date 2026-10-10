import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * Explicit per-user state machine.
 *
 * States are declared with: timeout, cancel, back, cleanup, safe recovery.
 * The machine is persisted (state + context) so a restart never leaves a
 * user stuck in a half-flow — on boot, stale states are reset to IDLE and
 * their cleanup hooks run.
 */
export const States = {
  IDLE: 'IDLE',
  PINTEREST_SEARCH: 'PINTEREST_SEARCH',
  PINTEREST_RESULTS: 'PINTEREST_RESULTS',
  STICKER_COUNT_SELECTION: 'STICKER_COUNT_SELECTION',
  MANUAL_STICKER_COLLECTION: 'MANUAL_STICKER_COLLECTION',
  PACK_PREVIEW: 'PACK_PREVIEW',
  PACK_CREATION: 'PACK_CREATION',
  STICKER_PACK_CLONE: 'STICKER_PACK_CLONE',
  WA_PAIR_NAME: 'WA_PAIR_NAME',
  WA_PAIR_NUMBER: 'WA_PAIR_NUMBER',
  WA_PAIRING: 'WA_PAIRING',
  WA_SESSION_MENU: 'WA_SESSION_MENU',
  WA_PACK_SELECTION: 'WA_PACK_SELECTION',
  WA_CAPTION_EDITOR: 'WA_CAPTION_EDITOR',
  WA_PACK_NAME_EDITOR: 'WA_PACK_NAME_EDITOR',
  WA_CHANNEL_SELECTION: 'WA_CHANNEL_SELECTION',
  WA_CHANNEL_INPUT: 'WA_CHANNEL_INPUT',
  WA_FINAL_PREVIEW: 'WA_FINAL_PREVIEW',
  WA_PUBLISHING: 'WA_PUBLISHING',
  AI_CHAT: 'AI_CHAT',
  SETTINGS: 'SETTINGS',
  URL_DOWNLOADER: 'URL_DOWNLOADER',
  URL_DOWNLOADER_INPUT: 'URL_DOWNLOADER_INPUT',
  MUSIC_SEARCH_INPUT: 'MUSIC_SEARCH_INPUT',
  CLONE_BOT_NAME_INPUT: 'CLONE_BOT_NAME_INPUT',
  CLONE_BOT_TOKEN_INPUT: 'CLONE_BOT_TOKEN_INPUT',
  CLONE_BOT_BROADCAST_INPUT: 'CLONE_BOT_BROADCAST_INPUT'
};

export const DEFAULT_STATE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * @typedef {object} StateHandler
 * @property {(ctx, payload) => Promise<void>|void} [onEnter]
 * @property {(ctx, payload) => Promise<boolean|void>} [onMessage] return true if handled
 * @property {(ctx, payload) => Promise<boolean|void>} [onCallback]
 * @property {() => Promise<void>|void} [onTimeout]
 * @property {() => Promise<void>|void} [onCancel]
 * @property {() => Promise<void>|void} [onCleanup]
 */

export class StateMachine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(tgId: string) => any} [opts.loadPersisted] load { state, context } from DB
   * @param {(tgId: string, record: object|null) => void} [opts.persist]
   */
  constructor({ loadPersisted, persist, log } = {}) {
    super();
    this.handlers = new Map(); // state -> StateHandler
    this.users = new Map();    // tgId -> { state, context, screenMessageId, chatId, timer, history }
    this.loadPersisted = loadPersisted ?? (() => null);
    this.persist = persist ?? (() => {});
    this.log = log ?? logger().child({ module: 'stateMachine' });
    // Every declared state always has a (default no-op) handler so a
    // transition can never throw "Unknown state" — screens enrich the
    // defaults via register().
    for (const state of Object.values(States)) {
      this.handlers.set(state, {});
    }
  }

  /**
   * Register handlers for a state. onMessage handlers COMPOSE: the newly
   * registered handler runs first and may defer (return false / undefined)
   * to the previously registered one — this is how two screens can share a
   * state (e.g. PINTEREST_SEARCH for plain search and the p2s pack flow).
   * All other hooks are replaced when re-registered.
   */
  register(state, handler) {
    const existing = this.handlers.get(state) ?? {};
    const merged = { ...existing };
    if (typeof handler.onMessage === 'function' && typeof existing.onMessage === 'function') {
      const previous = existing.onMessage;
      const next = handler.onMessage;
      merged.onMessage = async (sctx, message) => {
        const handled = await next(sctx, message);
        if (handled === true) return true;
        return previous(sctx, message);
      };
    } else if (handler.onMessage) {
      merged.onMessage = handler.onMessage;
    }
    for (const hook of ['onEnter', 'onCallback', 'onTimeout', 'onCancel', 'onCleanup']) {
      if (handler[hook]) merged[hook] = handler[hook];
    }
    this.handlers.set(state, merged);
    return this;
  }

  /** Get (or recover) a user's record. */
  for(tgId) {
    const key = String(tgId);
    if (!this.users.has(key)) {
      const persisted = this.loadPersisted(key);
      const record = {
        state: persisted?.state && this.handlers.has(persisted.state) ? persisted.state : States.IDLE,
        context: persisted?.context ?? {},
        screenMessageId: persisted?.screenMessageId ?? null,
        chatId: persisted?.chatId ?? null,
        timer: null,
        history: [],
        expiresAt: null
      };
      if (persisted?.state && record.state !== persisted.state) {
        // State no longer known — treat as recovered.
        record.context = { ...record.context, recoveredFrom: persisted.state };
      }
      this.users.set(key, record);
      this.#armTimeout(key, record);
    }
    return this.users.get(key);
  }

  get(tgId) {
    return this.for(tgId);
  }

  state(tgId) {
    return this.for(tgId).state;
  }

  context(tgId) {
    return this.for(tgId).context;
  }

  /** The same context object handlers receive (for flows that need it). */
  ctxFor(tgId) {
    const key = String(tgId);
    return this.#ctx(key, this.for(key));
  }

  /**
   * Transition to a new state. Runs onCleanup of the old state,
   * persists, arms the timeout, then calls onEnter.
   */
  async transition(tgId, nextState, { context = {}, screenMessageId = null, chatId = null, timeoutMs = DEFAULT_STATE_TIMEOUT_MS, pushHistory = true } = {}) {
    const key = String(tgId);
    const record = this.for(key);
    const handler = this.handlers.get(nextState);
    if (!handler) throw new Error(`Unknown state: ${nextState}`);

    const previous = record.state;
    const previousHandler = this.handlers.get(previous);
    if (previous === nextState) {
      // Same-state refresh (e.g. re-render): merge context, re-enter.
      record.context = { ...record.context, ...context };
      this.#persistRecord(key, record);
      await handler.onEnter?.(this.#ctx(key, record), { reason: 'refresh' });
      return record;
    }

    if (pushHistory && previous !== States.IDLE) {
      record.history.push({ state: previous, context: record.context, screenMessageId: record.screenMessageId });
      if (record.history.length > 10) record.history.shift();
    }

    // Cleanup old state (temp files, collectors, etc.)
    try {
      await previousHandler?.onCleanup?.(this.#ctx(key, record));
    } catch (error) {
      this.log.warn({ err: error, tgId: key, previous }, 'state cleanup failed');
    }

    record.state = nextState;
    record.context = context;
    record.screenMessageId = screenMessageId ?? record.screenMessageId;
    record.chatId = chatId ?? record.chatId;
    record.expiresAt = Date.now() + timeoutMs;
    this.#persistRecord(key, record);
    this.#armTimeout(key, record, timeoutMs);

    this.emit('transition', { tgId: key, from: previous, to: nextState });
    await handler.onEnter?.(this.#ctx(key, record), { reason: 'enter', from: previous });
    return record;
  }

  /** Update context in place and persist. */
  update(tgId, patch) {
    const key = String(tgId);
    const record = this.for(key);
    record.context = { ...record.context, ...patch };
    this.#persistRecord(key, record);
    return record.context;
  }

  /** Route an incoming text message to the current state. Returns true if handled. */
  async handleMessage(tgId, message, extraCtx = null) {
    const key = String(tgId);
    const record = this.for(key);
    const handler = this.handlers.get(record.state);
    if (!handler?.onMessage) return false;
    this.#touch(key, record);
    const baseCtx = this.#ctx(key, record);
    const ctx = extraCtx && typeof extraCtx === 'object' ? Object.assign(baseCtx, extraCtx) : baseCtx;
    const handled = await handler.onMessage(ctx, message);
    return handled === true;
  }

  /** Route an incoming callback query to the current state. Returns true if handled. */
  async handleCallback(tgId, query, extraCtx = null) {
    const key = String(tgId);
    const record = this.for(key);
    const handler = this.handlers.get(record.state);
    if (!handler?.onCallback) return false;
    this.#touch(key, record);
    const baseCtx = this.#ctx(key, record);
    const ctx = extraCtx && typeof extraCtx === 'object' ? Object.assign(baseCtx, extraCtx) : baseCtx;
    const handled = await handler.onCallback(ctx, query);
    return handled === true;
  }

  /** Global callback router: handlers can also register state-agnostic routes. */
  async routeCallback(tgId, query) {
    if (await this.handleCallback(tgId, query)) return true;
    return false;
  }

  /** Go back to the previous state in history (safe recovery). */
  async back(tgId, fallbackState = States.IDLE) {
    const key = String(tgId);
    const record = this.for(key);
    const previous = record.history.pop();
    if (!previous) {
      await this.transition(key, fallbackState, { pushHistory: false });
      return record.state;
    }
    const target = this.handlers.has(previous.state) ? previous.state : fallbackState;
    await this.transition(key, target, {
      context: previous.context ?? {},
      screenMessageId: previous.screenMessageId ?? null,
      pushHistory: false
    });
    return record.state;
  }

  /** Cancel the current flow: run onCancel, cleanup, return to IDLE. */
  async cancel(tgId, { reason = 'user' } = {}) {
    const key = String(tgId);
    const record = this.for(key);
    const handler = this.handlers.get(record.state);
    try {
      await handler?.onCancel?.(this.#ctx(key, record), { reason });
    } catch (error) {
      this.log.warn({ err: error, tgId: key }, 'onCancel failed');
    }
    await this.transition(key, States.IDLE, { context: {}, pushHistory: false });
    return record.state;
  }

  /** Reset to IDLE without running onCancel (used on recovery/timeout). */
  async reset(tgId, { reason = 'reset' } = {}) {
    const key = String(tgId);
    const record = this.for(key);
    const handler = this.handlers.get(record.state);
    try {
      await handler?.onCleanup?.(this.#ctx(key, record));
    } catch (error) {
      this.log.warn({ err: error, tgId: key }, 'cleanup during reset failed');
    }
    record.state = States.IDLE;
    record.context = {};
    record.history = [];
    if (reason === 'clear') {
      record.screenMessageId = null;
    }
    this.#clearTimer(record);
    this.#persistRecord(key, record);
    this.emit('reset', { tgId: key, reason });
  }

  /** Recover all persisted non-IDLE states at boot (safe recovery). */
  async recoverAll() {
    // The persistence layer hands us every stored user state.
    // Anything still mid-flow is reset to IDLE with cleanup.
    this.emit('recover');
  }

  #ctx(key, record) {
    return {
      tgId: key,
      state: record.state,
      context: record.context,
      screenMessageId: record.screenMessageId,
      chatId: record.chatId,
      machine: this,
      update: (patch) => this.update(key, patch),
      transition: (state, opts) => this.transition(key, state, opts),
      back: (fallback) => this.back(key, fallback),
      cancel: (opts) => this.cancel(key, opts),
      reset: (opts) => this.reset(key, opts)
    };
  }

  #persistRecord(key, record) {
    try {
      this.persist(key, {
        state: record.state,
        context: record.context,
        screenMessageId: record.screenMessageId,
        chatId: record.chatId,
        expiresAt: record.expiresAt
      });
    } catch (error) {
      this.log.warn({ err: error, tgId: key }, 'persist state failed');
    }
  }

  #armTimeout(key, record, timeoutMs = DEFAULT_STATE_TIMEOUT_MS) {
    this.#clearTimer(record);
    record.expiresAt = Date.now() + timeoutMs;
    record.timer = setTimeout(() => {
      void (async () => {
        const handler = this.handlers.get(record.state);
        this.log.info({ tgId: key, state: record.state }, 'state timed out');
        try {
          await handler?.onTimeout?.(this.#ctx(key, record));
        } catch (error) {
          this.log.warn({ err: error, tgId: key }, 'onTimeout failed');
        }
        await this.reset(key, { reason: 'timeout' });
        this.emit('timeout', { tgId: key, state: record.state });
      })();
    }, timeoutMs);
    if (record.timer.unref) record.timer.unref();
  }

  #clearTimer(record) {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  }

  #touch(key, record) {
    // Activity keeps the timeout alive.
    if (record.timer) {
      // Re-arm with fresh expiry based on state default.
      this.#armTimeout(key, record);
      this.#persistRecord(key, record);
    }
  }
}
