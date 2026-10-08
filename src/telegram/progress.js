import { throttle } from '../utils/time.js';
import { logger } from '../core/logger.js';

/**
 * ProgressTracker — ONE editable Rich Message that streams live progress.
 * No "Loading…", "Searching…", "Done…" message spam: a single message,
 * edited in place, throttled to stay inside Telegram's edit rate limits.
 */
export class ProgressTracker {
  constructor({ api, chatId, log } = {}) {
    this.api = api;
    this.chatId = chatId;
    this.log = log ?? logger().child({ module: 'progress' });
    this.messageId = null;
    this.lastRender = null;
    this.closed = false;
  }

  /** Send the initial progress message (returns its id). */
  async start(richMessage) {
    const message = await this.api.sendRichMessage(this.chatId, richMessage);
    this.messageId = message.message_id;
    return this.messageId;
  }

  /** Edit in place. Throttled; identical renders are skipped. */
  async update(richMessage) {
    if (this.closed || !this.messageId) return;
    const json = JSON.stringify(richMessage);
    if (json === this.lastRender) return;
    this.lastRender = json;
    this.#edit(richMessage);
  }

  /** Throttled edit (leading + trailing). */
  #edit = throttle(async (richMessage) => {
    try {
      await this.api.editMessageRich(this.chatId, this.messageId, richMessage);
    } catch (error) {
      // "message is not modified" is fine; anything else is logged, not spammed.
      if (!/not modified|message to edit not found/i.test(String(error?.description ?? error?.message))) {
        this.log.warn({ err: error }, 'progress edit failed');
      }
    }
  }, 900);

  /** Final edit + unthrottle. */
  async finish(richMessage) {
    this.closed = true;
    this.#edit.cancel?.();
    if (!this.messageId) return;
    try {
      await this.api.editMessageRich(this.chatId, this.messageId, richMessage);
      this.lastRender = JSON.stringify(richMessage);
    } catch (error) {
      this.log.warn({ err: error }, 'final progress edit failed');
    }
  }

  /** Delete the progress message (used for cleanup). */
  async cleanup() {
    this.closed = true;
    this.#edit.cancel?.();
    if (this.messageId) {
      await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
    }
  }
}
