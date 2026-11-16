import { throttle } from '../utils/time.js';
import { logger } from '../core/logger.js';
import { ActionIndicator } from './indicator.js';
import { isPermissionError, recordChatPermissionRestriction, formatMediaRestrictedNotice } from './permissions.js';

/**
 * ProgressTracker — ONE editable Rich Message that streams live progress.
 * No "Loading…", "Searching…", "Done…" message spam: a single message,
 * edited in place, throttled to stay inside Telegram's edit rate limits.
 *
 * Live mode: `live(state => rich, initialState)` keeps a render function and
 * re-renders on every `set(patch)` AND on a heartbeat, so elapsed time and
 * ETA keep ticking even when the underlying job is quiet for a while.
 */
const BENIGN_EDIT_ERRORS = /not modified|message to edit not found|canceled by new edit|too many requests|flood wait|skipped during active flood wait|FLOOD_WAIT/i;
const activeTrackersByChat = new Map(); // `${botKey}:${chatId}` -> Set<ProgressTracker>
const trackerApiIds = new WeakMap();
let nextTrackerApiId = 1;

function trackerBotKey(api) {
  if (api?.me?.id) return String(api.me.id);
  const tokenId = typeof api?.token === 'string' ? api.token.split(':')[0] : '';
  if (/^\d+$/.test(tokenId)) return tokenId;
  if (api && typeof api === 'object') {
    let id = trackerApiIds.get(api);
    if (!id) {
      id = `api_${nextTrackerApiId++}`;
      trackerApiIds.set(api, id);
    }
    return id;
  }
  return 'default';
}

function trackerChatKey(chatId, api = null) {
  return `${trackerBotKey(api)}:${String(chatId)}`;
}

export class ProgressTracker {
  static stopForChat(chatId, api = null) {
    if (chatId === undefined || chatId === null) return;
    if (api) {
      const key = trackerChatKey(chatId, api);
      const set = activeTrackersByChat.get(key);
      if (!set) return;
      for (const t of set) {
        try { t.stop(); } catch {}
      }
      activeTrackersByChat.delete(key);
      return;
    }
    const suffix = `:${String(chatId)}`;
    for (const [key, set] of Array.from(activeTrackersByChat.entries())) {
      if (!key.endsWith(suffix)) continue;
      for (const t of set) {
        try { t.stop(); } catch {}
      }
      activeTrackersByChat.delete(key);
    }
  }

  constructor({ api, chatId, messageId = null, replyToMessageId = null, heartbeatMs = 3500, action = 'typing', log } = {}) {
    this.api = api;
    this.chatId = chatId;
    this.messageId = messageId;
    this.replyToMessageId = replyToMessageId;
    this.heartbeatMs = Math.max(3000, Number(heartbeatMs) || 3500);
    this.action = action;
    this.log = log ?? logger().child({ module: 'progress' });
    this.indicator = action && api && chatId ? new ActionIndicator(api, chatId, action) : null;
    this.lastRender = null;
    this.closed = false;
    this.startedAt = Date.now();
    this.state = {};
    this.renderFn = null;
    this.timer = null;
  }

  setAction(action) {
    this.action = action;
    if (this.indicator) {
      this.indicator.setAction(action);
    }
  }

  /** Send the initial progress message or edit existing screen message (returns its id). */
  async start(richMessage) {
    if (this.chatId !== undefined && this.chatId !== null) {
      const key = trackerChatKey(this.chatId, this.api);
      const existing = activeTrackersByChat.get(key);
      if (existing) {
        for (const prev of existing) {
          if (prev !== this && (!this.messageId || prev.messageId === this.messageId)) {
            try { prev.stop(); } catch {}
          }
        }
      }
      if (!activeTrackersByChat.has(key)) activeTrackersByChat.set(key, new Set());
      activeTrackersByChat.get(key).add(this);
    }
    this.startedAt = Date.now();
    if (this.indicator) {
      this.indicator.start(this.action);
    }
    const prevMsgId = this.messageId;
    if (this.messageId) {
      try {
        await this.api.editMessageRich(this.chatId, this.messageId, richMessage);
        this.lastRender = JSON.stringify(richMessage);
        return this.messageId;
      } catch {
        // Fall back to sending a new message if editing fails
      }
    }
    const sendExtra = this.replyToMessageId
      ? { reply_to_message_id: this.replyToMessageId, allow_sending_without_reply: true }
      : {};
    const message = await this.api.sendRichMessage(this.chatId, richMessage, sendExtra);
    if (prevMsgId && message?.message_id && message.message_id !== prevMsgId) {
      await this.api.call?.('deleteMessage', { chat_id: this.chatId, message_id: prevMsgId })?.catch?.(() => {});
    }
    this.messageId = message?.message_id;
    this.lastRender = JSON.stringify(richMessage);
    return this.messageId;
  }

  /**
   * Live mode: render(state, { elapsedMs }) is called on every set() and on a
   * heartbeat until finish()/cleanup().
   */
  async live(render, initialState = {}) {
    this.renderFn = render;
    this.state = { ...initialState };
    await this.start(this.#render());
    this.timer = setInterval(() => {
      if (this.closed || this.elapsedMs() > 180000) {
        this.#stop();
        return;
      }
      void this.update(this.#render());
    }, this.heartbeatMs);
    this.timer.unref?.();
    return this.messageId;
  }

  stop() {
    this.#stop();
  }

  /** Merge new progress into the live state and re-render (throttled). */
  set(patch = {}) {
    this.state = { ...this.state, ...patch };
    if (this.renderFn) void this.update(this.#render());
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  #render() {
    try {
      return this.renderFn(this.state, { elapsedMs: this.elapsedMs(), startedAt: this.startedAt });
    } catch (error) {
      this.log.warn({ err: error }, 'progress render failed');
      return null;
    }
  }

  /** Edit in place. Throttled; identical renders are skipped. */
  async update(richMessage) {
    if (this.closed || !this.messageId || !richMessage) return;
    const json = JSON.stringify(richMessage);
    if (json === this.lastRender) return;
    this.lastRender = json;
    this.#edit(richMessage);
  }

  /** Throttled edit (leading + trailing) — stays safely under Telegram's ~20 edits/min limit. */
  #edit = throttle(async (richMessage) => {
    if (this.closed) return;
    try {
      await this.api.editMessageRich(this.chatId, this.messageId, richMessage, { dropOnFloodWait: true });
    } catch (error) {
      const errText = `${error?.code || ''} ${error?.description || ''} ${error?.message || ''}`;
      if (!BENIGN_EDIT_ERRORS.test(errText)) {
        this.log.warn({ err: error }, 'progress edit failed');
      }
    }
  }, 2500);

  #stop() {
    this.closed = true;
    if (this.chatId !== undefined && this.chatId !== null) {
      const key = trackerChatKey(this.chatId, this.api);
      const set = activeTrackersByChat.get(key);
      if (set) {
        set.delete(this);
        if (set.size === 0) activeTrackersByChat.delete(key);
      }
    }
    if (this.indicator) {
      this.indicator.stop();
    }
    clearInterval(this.timer);
    this.timer = null;
    this.#edit.cancel?.();
  }

  async #handlePermissionDenied() {
    recordChatPermissionRestriction(this.chatId, { canSendPhotos: false, canSendVideos: false }, this.api);
    if (this.messageId) {
      const prevId = this.messageId;
      this.messageId = null;
      await this.api.deleteMessage(this.chatId, prevId).catch(() => {});
    }
    const botUser = this.api.botUsername || this.api.me?.username || 'Lancy_easy_bot';
    const notice = formatMediaRestrictedNotice({
      botUsername: botUser,
      url: this.state?.url || null
    });
    return await this.api.sendMessage(this.chatId, notice.text, {
      parse_mode: 'HTML',
      reply_markup: notice.reply_markup
    }).catch(() => null);
  }

  /** Final edit + unthrottle. Optional files for media-bearing final cards. */
  async finish(richMessage, files = null) {
    this.#stop();
    const sendExtra = this.replyToMessageId
      ? { reply_to_message_id: this.replyToMessageId, allow_sending_without_reply: true }
      : {};
    if (!this.messageId) {
      const sent = await this.api.sendRichMessage(this.chatId, richMessage, sendExtra, files).catch(async (err) => {
        if (isPermissionError(err)) {
          return await this.#handlePermissionDenied();
        }
        return null;
      });
      this.messageId = sent?.message_id ?? null;
      return sent;
    }
    try {
      const res = await this.api.editMessageRich(this.chatId, this.messageId, richMessage, sendExtra, files);
      this.lastRender = JSON.stringify(richMessage);
      return res;
    } catch (error) {
      if (/not modified/i.test(String(error?.description ?? error?.message))) return null;
      if (isPermissionError(error)) {
        return await this.#handlePermissionDenied();
      }
      // Message vanished (user deleted it) or could not be edited with media → send a fresh one.
      const prevMsgId = this.messageId;
      const sent = await this.api.sendRichMessage(this.chatId, richMessage, sendExtra, files).catch(async (err) => {
        this.log.warn({ err }, 'final progress edit failed');
        if (isPermissionError(err)) {
          return await this.#handlePermissionDenied();
        }
        return null;
      });
      if (prevMsgId && sent?.message_id && sent.message_id !== prevMsgId) {
        await this.api.call?.('deleteMessage', { chat_id: this.chatId, message_id: prevMsgId })?.catch?.(() => {});
      }
      if (sent?.message_id) this.messageId = sent.message_id;
      return sent;
    }
  }

  /** Delete the progress message (used for cleanup). */
  async cleanup() {
    this.#stop();
    if (this.messageId) {
      await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
    }
  }
}
