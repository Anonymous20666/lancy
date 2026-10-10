/**
 * ActionIndicator — manages persistent Telegram chat action loops
 * (typing, upload_photo, upload_video, record_voice, etc.)
 * Telegram chat actions expire after 5 seconds, so this maintains a 3.5s heartbeat
 * until explicitly stopped.
 */
export class ActionIndicator {
  constructor(api, chatId, defaultAction = 'typing', intervalMs = 3500) {
    this.api = api;
    this.chatId = chatId;
    this.action = defaultAction;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start(action = null) {
    if (action) this.action = action;
    this.stop();
    if (!this.api || !this.chatId) return this;
    if (typeof this.api.sendChatAction === 'function') {
      try { this.api.sendChatAction(this.chatId, this.action)?.catch?.(() => {}); } catch {}
    }
    this.timer = setInterval(() => {
      if (typeof this.api.sendChatAction === 'function') {
        try { this.api.sendChatAction(this.chatId, this.action)?.catch?.(() => {}); } catch {}
      }
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  setAction(action) {
    if (!action || this.action === action) return;
    this.action = action;
    if (this.api && this.chatId && typeof this.api.sendChatAction === 'function') {
      try { this.api.sendChatAction(this.chatId, this.action)?.catch?.(() => {}); } catch {}
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
