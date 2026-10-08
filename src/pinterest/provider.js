import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';

/**
 * Pinterest provider interface.
 *
 * A provider performs PUBLIC searches only: it reads publicly accessible
 * search result pages and returns normalized pin candidates. It must never
 * bypass private pins, login walls, access controls or DRM.
 *
 * Candidate shape:
 * { pinId, sourceUrl, mediaUrl, type: 'image'|'video', width, height,
 *   duration?, previewUrl? }
 */
export class PinterestProvider extends EventEmitter {
  constructor({ name = 'base', log } = {}) {
    super();
    this.name = name;
    this.log = log ?? logger().child({ module: 'pinterest', provider: name });
  }

  /**
   * Search public Pinterest results.
   * @returns {Promise<{ items: object[], bookmark: string|null }>}
   */
  async search() {
    throw new Error('not implemented');
  }

  /** Human-readable label for the UI. */
  get label() {
    return this.name;
  }
}

/** Registry so providers are pluggable (web, fixture, …). */
export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    this.providers.set(provider.name, provider);
    return this;
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Unknown Pinterest provider: ${name}`);
    return provider;
  }

  list() {
    return [...this.providers.values()];
  }
}
