import { PinterestProvider } from './provider.js';

/**
 * FixtureProvider — deterministic demo/test data. Lets the whole product run
 * (and be tested) without touching the network.
 *
 * Pins are described declaratively; media URLs point at data served by the
 * test harness or can be replaced by a local HTTP server in demos.
 */
export class FixtureProvider extends PinterestProvider {
  constructor({ pins = [], pageSize = 12 } = {}) {
    super({ name: 'fixture' });
    this.pins = pins;
    this.pageSize = pageSize;
  }

  get label() {
    return `Fixture (${this.pins.length} pins)`;
  }

  async search({ query, bookmark = null } = {}) {
    const q = String(query ?? '').toLowerCase();
    const matching = this.pins.filter(
      (p) => !q || p.tags?.some((t) => t.toLowerCase().includes(q)) || p.pinId.toLowerCase().includes(q)
    );
    const start = bookmark ? Number(bookmark) : 0;
    const page = matching.slice(start, start + this.pageSize);
    const next = start + this.pageSize < matching.length ? String(start + this.pageSize) : null;
    return {
      items: page.map((p) => ({
        pinId: p.pinId,
        sourceUrl: p.sourceUrl ?? `https://pinterest.com/pin/${p.pinId}/`,
        mediaUrl: p.mediaUrl,
        type: p.type ?? 'image',
        width: p.width ?? 1000,
        height: p.height ?? 1000,
        duration: p.duration ?? null
      })),
      bookmark: next,
      page: Math.floor(start / this.pageSize) + 1
    };
  }
}

/** Build N deterministic fixture pins. Media URLs point at a local server. */
export function makeFixturePins(n, { baseUrl = 'http://127.0.0.1:9', type = 'image', seed = 'lancy' } = {}) {
  const pins = [];
  for (let i = 0; i < n; i++) {
    pins.push({
      pinId: `${seed}-pin-${String(i).padStart(4, '0')}`,
      mediaUrl: `${baseUrl}/media/${seed}-${i}.${type === 'video' ? 'mp4' : 'jpg'}`,
      type,
      width: 1000 + (i % 7) * 100,
      height: 1000 + (i % 5) * 100,
      duration: type === 'video' ? 2 + (i % 8) : null,
      tags: [seed, type]
    });
  }
  return pins;
}
