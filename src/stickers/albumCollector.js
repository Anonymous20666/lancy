/**
 * AlbumCollector — debounces Telegram media_group_id bursts into single ordered batches.
 * Prevents N concurrent state messages / progress tracker races when users upload albums
 * of photos, videos, GIFs, or documents at once.
 */
export class AlbumCollector {
  constructor({ settleMs = 750, maxWaitMs = 4000, maxItems = 20 } = {}) {
    this.settleMs = settleMs;
    this.maxWaitMs = maxWaitMs;
    this.maxItems = maxItems;
    this.pending = new Map(); // groupKey -> { messages, timer, startedAt, onFlush }
  }

  /**
   * Enqueue an album message. Messages with the same chat+user+media_group_id are
   * buffered until settleMs of quiet time (or maxWaitMs / maxItems cap), sorted by
   * message_id ascending, and delivered once to onFlush(messages).
   */
  push({ chatId, userId, mediaGroupId, message, onFlush }) {
    if (!mediaGroupId || !message) return false;
    const key = `${chatId}:${userId}:${mediaGroupId}`;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        key,
        messages: [],
        startedAt: Date.now(),
        timer: null,
        onFlush
      };
      this.pending.set(key, entry);
    }

    if (entry.messages.some((m) => m.message_id === message.message_id)) {
      return true;
    }
    entry.messages.push(message);
    if (onFlush) entry.onFlush = onFlush;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const elapsed = Date.now() - entry.startedAt;
    if (entry.messages.length >= this.maxItems || elapsed >= this.maxWaitMs) {
      this.#flush(key);
      return true;
    }

    const delay = Math.min(this.settleMs, Math.max(50, this.maxWaitMs - elapsed));
    entry.timer = setTimeout(() => this.#flush(key), delay);
    return true;
  }

  async #flush(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const ordered = [...entry.messages].sort((a, b) => (a.message_id ?? 0) - (b.message_id ?? 0));
    try {
      await entry.onFlush?.(ordered);
    } catch {
      // Caller logs/handles errors internally
    }
  }

  has({ chatId, userId, mediaGroupId }) {
    if (!mediaGroupId) return false;
    return this.pending.has(`${chatId}:${userId}:${mediaGroupId}`);
  }

  clearAll() {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
