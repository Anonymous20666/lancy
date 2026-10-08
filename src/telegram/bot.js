import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { LancyError, friendlyTelegramError } from '../core/errors.js';
import { decodeCallback, NOOP_CALLBACK } from './rich.js';
import { States } from '../core/stateMachine.js';
import { sleep } from '../utils/time.js';

/**
 * TelegramController — the control center.
 *
 * - Long-polls getUpdates (never blocks on media/AI/WhatsApp work).
 * - Owner/admin guard on every update.
 * - Routes callback queries by screen prefix to screen handlers.
 * - Routes text/photos/documents to the user's state machine.
 * - Every failure becomes a friendly message — never a stack trace.
 */
export class TelegramController extends EventEmitter {
  constructor({ api, db, settings, stateMachine, screens = new Map(), app = null, log } = {}) {
    super();
    this.api = api;
    this.db = db;
    this.settings = settings;
    this.sm = stateMachine;
    this.screens = screens; // Map<screenId, screenModule>
    this.app = app; // the composed application (services)
    this.log = log ?? logger().child({ module: 'telegram' });
    this.offset = 0;
    this.running = false;
    this.abort = null;
    this.globalCallbacks = new Map(); // action -> handler (state-agnostic)
  }

  /** Register a screen module: { id, render(ctx), handle(ctx, action, args) } */
  registerScreen(screen) {
    this.screens.set(screen.id, screen);
    return this;
  }

  /** Register a state-agnostic callback route (e.g. 'noop'). */
  onAction(action, handler) {
    this.globalCallbacks.set(action, handler);
    return this;
  }

  isAllowed(tgId) {
    const ownerIds = new Set(this.settings.get('general.ownerIds') ?? []);
    const adminIds = new Set(this.settings.get('telegram.adminIds') ?? []);
    const allowed = this.settings.get('security.allowedUsers') ?? [];
    if (ownerIds.has(tgId) || adminIds.has(tgId)) return { ok: true, role: ownerIds.has(tgId) ? 'owner' : 'admin' };
    if (allowed.length === 0) return { ok: false, role: 'stranger' };
    if (allowed.map(Number).includes(Number(tgId))) return { ok: true, role: 'allowed' };
    return { ok: false, role: 'stranger' };
  }

  isOwner(tgId) {
    return (this.settings.get('general.ownerIds') ?? []).map(Number).includes(Number(tgId));
  }

  async start() {
    const me = await this.api.getMe();
    this.botUsername = me.username;
    this.settings.values.telegram.botUsername = me.username;
    this.log.info({ bot: `@${me.username}` }, 'telegram connected');

    this.abort = new AbortController();
    this.running = true;
    void this.#pollLoop();
    this.emit('ready', me);
    return me;
  }

  async stop() {
    this.running = false;
    this.abort?.abort();
  }

  async #pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api.poll({ offset: this.offset, timeout: 30, signal: this.abort.signal });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.#handleUpdate(update).catch((error) => {
            this.log.error({ err: error, updateId: update.update_id }, 'update handling failed');
          });
        }
      } catch (error) {
        if (!this.running || error?.name === 'AbortError') return;
        this.log.error({ err: error }, 'polling failed — retrying in 3s');
        await sleep(3000);
      }
    }
  }

  async #handleUpdate(update) {
    if (update.callback_query) return this.#handleCallback(update.callback_query);
    if (update.message) return this.#handleMessage(update.message);
    if (update.edited_message) return this.#handleMessage(update.edited_message, { edited: true });
  }

  #upsertUser(user) {
    if (!user?.id) return null;
    const existing = this.db.get('SELECT id FROM users WHERE tg_id = ?', user.id);
    const isOwner = this.isOwner(user.id);
    const isAdmin = (this.settings.get('telegram.adminIds') ?? []).map(Number).includes(Number(user.id));
    if (existing) {
      this.db.run(
        `UPDATE users SET username = ?, first_name = ?, last_name = ?, last_seen = datetime('now'),
           is_owner = ?, is_admin = ? WHERE tg_id = ?`,
        user.username ?? null, user.first_name ?? null, user.last_name ?? null,
        isOwner ? 1 : 0, isAdmin ? 1 : 0, user.id
      );
      return this.db.get('SELECT * FROM users WHERE tg_id = ?', user.id);
    }
    this.db.run(
      `INSERT INTO users (tg_id, username, first_name, last_name, is_owner, is_admin, is_allowed)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null,
      isOwner ? 1 : 0, isAdmin ? 1 : 0
    );
    this.db.audit(user.id, 'user.seen', { username: user.username });
    return this.db.get('SELECT * FROM users WHERE tg_id = ?', user.id);
  }

  async #handleCallback(query) {
    const user = this.#upsertUser(query.from);
    const guard = this.isAllowed(query.from.id);
    if (!guard.ok) {
      await this.api.answerCallbackQuery(query.id, { text: 'This Lancy belongs to someone else ♡', showAlert: true });
      return;
    }
    const tgId = String(query.from.id);
    const data = query.data ?? '';

    try {
      if (data === NOOP_CALLBACK || data.startsWith('l1:noop')) {
        await this.api.answerCallbackQuery(query.id);
        return;
      }
      const decoded = decodeCallback(data);
      if (!decoded) {
        await this.api.answerCallbackQuery(query.id);
        return;
      }
      const { screen, action, args } = decoded;

      // State-agnostic global actions.
      if (this.globalCallbacks.has(action)) {
        await this.api.answerCallbackQuery(query.id);
        await this.globalCallbacks.get(action)(this.#ctx(tgId, query), args);
        return;
      }

      // Screen-routed action.
      const screenModule = this.screens.get(screen);
      if (!screenModule?.handle) {
        await this.api.answerCallbackQuery(query.id, { text: '♡ That screen is not available right now.' });
        return;
      }
      await this.api.answerCallbackQuery(query.id);
      const ctx = this.#ctx(tgId, query);
      await screenModule.handle(ctx, action, args);
    } catch (error) {
      this.log.error({ err: error, tgId, data }, 'callback failed');
      await this.api.answerCallbackQuery(query.id, { text: friendly(error), showAlert: true }).catch(() => {});
    }
  }

  async #handleMessage(message, { edited = false } = {}) {
    const user = this.#upsertUser(message.from);
    const guard = this.isAllowed(message.from.id);
    if (!guard.ok) return; // silent for strangers in groups
    const tgId = String(message.from.id);
    const chatId = message.chat.id;

    // Commands
    const text = message.text ?? '';
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const command = cmd.toLowerCase().split('@')[0];
      if (command === '/start') {
        await this.sm.reset(tgId, { reason: 'start' });
        const dashboard = this.screens.get('dashboard');
        await dashboard?.open(this.#ctx(tgId, { message }));
        return;
      }
      if (command === '/cancel') {
        const state = this.sm.state(tgId);
        if (state !== States.IDLE) {
          await this.sm.cancel(tgId);
          await this.api.sendMessage(chatId, `${'♡'} Cancelled — back to the dashboard.`);
        }
        const dashboard = this.screens.get('dashboard');
        await dashboard?.open(this.#ctx(tgId, { message }));
        return;
      }
      if (command === '/help') {
        const help = this.screens.get('help');
        await help?.open(this.#ctx(tgId, { message }));
        return;
      }
      // Unknown command: gentle hint.
      await this.api.sendMessage(chatId, '♡ That is not a command I know — try /start ♡');
      return;
    }

    // Route to the state machine (flows handle text/photos/documents).
    try {
      const handled = await this.sm.handleMessage(tgId, { ...message, chatId });
      if (!handled && this.sm.state(tgId) === States.IDLE) {
        await this.api.sendMessage(chatId, '♡ Use /start to open your control center ♡');
      }
    } catch (error) {
      this.log.error({ err: error, tgId }, 'message handling failed');
      await this.api.sendMessage(chatId, friendly(error)).catch(() => {});
    }
  }

  #ctx(tgId, source) {
    return {
      tgId,
      user: this.db.get('SELECT * FROM users WHERE tg_id = ?', Number(tgId)),
      chatId: source.message?.chat?.id ?? source.callback_query?.message?.chat?.id ?? source.chatId ?? Number(tgId),
      messageId: source.callback_query?.message?.message_id ?? source.message?.message_id ?? null,
      message: source.message ?? source.callback_query?.message ?? null,
      query: source.callback_query ?? null,
      controller: this,
      api: this.api,
      db: this.db,
      settings: this.settings,
      sm: this.sm,
      screens: this.screens,
      reply: (text, extra = {}) => this.api.sendMessage(this.#chatIdFor(tgId, source), text, extra),
      replyRich: (rich, extra = {}) => this.api.sendRichMessage(this.#chatIdFor(tgId, source), rich, extra),
      editScreen: (rich, extra = {}) => this.api.editMessageRich(
        source.callback_query?.message?.chat?.id ?? this.#chatIdFor(tgId, source),
        source.callback_query?.message?.message_id,
        rich,
        extra
      ).catch((error) => {
        if (!/not modified|message to edit not found/i.test(String(error?.description ?? error?.message))) throw error;
      })
    };
  }

  #chatIdFor(tgId, source) {
    return source?.message?.chat?.id
      ?? source?.callback_query?.message?.chat?.id
      ?? source?.chatId
      ?? Number(tgId);
  }
}

function friendly(error) {
  if (error instanceof LancyError) return error.userMessage;
  const tg = friendlyTelegramError(error);
  if (tg) return tg;
  return '♡ Something went wrong on my side — the details are in my log ♡';
}
