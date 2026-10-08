import { EventEmitter } from 'node:events';

/**
 * Internal event bus — decouples Telegram, WhatsApp, Pinterest, AI and jobs.
 * Nothing calls across modules directly; everything important goes through
 * here so features stay modular and independently testable.
 */
export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** Typed emit with error isolation. */
  emitSafe(event, payload) {
    for (const listener of this.listeners(event)) {
      try {
        const result = listener(payload);
        if (result?.catch) result.catch((error) => this.emitSafe('listenerError', { event, error }));
      } catch (error) {
        this.emitSafe('listenerError', { event, error });
      }
    }
    return this.emit(event, payload);
  }
}

export function createBus() {
  return new Bus();
}
