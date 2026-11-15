/**
 * ActionIndicator — manages persistent Telegram chat action loops
 * (typing, upload_photo, upload_video, record_voice, etc.)
 * Coalesces concurrent indicators per chatId so busy group chats never
 * spawn overlapping sendChatAction intervals that trigger 429 FloodWaits.
 */
const activeChatLoops = new Map(); // key -> { count, timer, action, api, chatId }

export class ActionIndicator {
  constructor(api, chatId, defaultAction = 'typing', intervalMs = 4200) {
    this.api = api;
    this.chatId = chatId;
    this.action = defaultAction;
    this.intervalMs = Math.max(3500, Number(intervalMs) || 4200);
    this.timer = null;
    this._activeKey = null;
  }

  start(action = null) {
    if (action) this.action = action;
    this.stop();
    if (!this.api || !this.chatId) return this;
    const key = `${this.api.token || 'bot'}:${this.chatId}`;
    this._activeKey = key;

    let entry = activeChatLoops.get(key);
    if (entry) {
      entry.count += 1;
      entry.action = this.action;
      this.timer = entry.timer;
      return this;
    }

    if (typeof this.api.sendChatAction === 'function') {
      try { this.api.sendChatAction(this.chatId, this.action)?.catch?.(() => {}); } catch {}
    }
    const timer = setInterval(() => {
      const cur = activeChatLoops.get(key);
      if (!cur || !cur.api) return;
      if (typeof cur.api.sendChatAction === 'function') {
        try { cur.api.sendChatAction(cur.chatId, cur.action)?.catch?.(() => {}); } catch {}
      }
    }, this.intervalMs);
    timer.unref?.();

    entry = { count: 1, timer, action: this.action, api: this.api, chatId: this.chatId };
    activeChatLoops.set(key, entry);
    this.timer = timer;
    return this;
  }

  setAction(action) {
    if (!action || this.action === action) return;
    this.action = action;
    if (this._activeKey && activeChatLoops.has(this._activeKey)) {
      activeChatLoops.get(this._activeKey).action = action;
    }
    if (this.api && this.chatId && typeof this.api.sendChatAction === 'function') {
      try { this.api.sendChatAction(this.chatId, this.action)?.catch?.(() => {}); } catch {}
    }
  }

  stop() {
    if (this._activeKey) {
      const entry = activeChatLoops.get(this._activeKey);
      this._activeKey = null;
      if (entry) {
        entry.count -= 1;
        if (entry.count <= 0) {
          clearInterval(entry.timer);
          activeChatLoops.delete(`${entry.api?.token || 'bot'}:${entry.chatId}`);
        }
      }
    } else if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
  }
}
