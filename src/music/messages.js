import { randomUUID } from 'node:crypto';

/** Only API-returned bot messages enter this registry. Callback/user-supplied
 * message IDs cannot become deletion targets. Failures never stop playback. */
export class TemporaryBotMessages {
  constructor({ maxEntries = 512, retryDelayMs = 10000 } = {}) {
    this.entries = new Map(); this.maxEntries = maxEntries; this.retryDelayMs = retryDelayMs; this.closed = false;
  }
  remember(ctx, sent, { ttlMs = 600000 } = {}) {
    if (this.closed || !sent?.message_id || !ctx.api?.deleteMessage) return null;
    if (this.entries.size >= this.maxEntries) void this.remove(this.entries.keys().next().value, { retry: false });
    const token = randomUUID();
    this.entries.set(token, { api: ctx.api, chatId: Number(ctx.chatId), messageId: sent.message_id, attempts: 0 });
    this.expire(token, ttlMs); return token;
  }
  expire(token, ttlMs) {
    const entry = this.entries.get(token); if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.remove(token); }, ttlMs); entry.timer.unref?.();
  }
  hold(token) { const entry = this.entries.get(token); if (entry) clearTimeout(entry.timer); }
  keep(token) {
    const entry = this.entries.get(token); if (!entry) return;
    clearTimeout(entry.timer); this.entries.delete(token);
  }
  async remove(token, { retry = true } = {}) {
    const entry = this.entries.get(token); if (!entry) return false;
    this.keep(token); let wait = this.retryDelayMs;
    try {
      const result = entry.api.call
        ? await entry.api.call('deleteMessage', { chat_id: entry.chatId, message_id: entry.messageId }, { timeoutMs: 5000, dropOnFloodWait: true })
        : await entry.api.deleteMessage(entry.chatId, entry.messageId);
      if (result === true) return true;
    } catch (error) { wait = Math.max(wait, Number(error.parameters?.retry_after || error.retryAfter || 0) * 1000); }
    if (retry && !this.closed && entry.attempts < 2 && this.entries.size < this.maxEntries) {
      entry.attempts++; this.entries.set(token, entry); this.expire(token, wait);
    }
    return false;
  }
  async shutdown() {
    this.closed = true;
    const tokens = [...this.entries.keys()];
    // Bounded deletion concurrency; do not flood Telegram during shutdown.
    for (let i = 0; i < tokens.length; i += 4) await Promise.allSettled(tokens.slice(i, i + 4).map(token => this.remove(token, { retry: false })));
  }
}
