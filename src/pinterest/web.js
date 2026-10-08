import { PinterestProvider } from './provider.js';
import { LancyError } from '../core/errors.js';

/**
 * PinterestWebProvider — deep search over PUBLIC Pinterest search pages.
 *
 * How it works (public behavior only):
 *   1. GET https://www.pinterest.com/search/pins/?q=<query> with a normal
 *      browser user-agent (public page, no login).
 *   2. Extract the embedded JSON state (`__PWS_DATA__` / `initialReduxState`)
 *      and walk it for pin objects.
 *   3. For each pin, resolve the highest-quality public media URL:
 *      images → `images.orig` (fall back to `564x`, `736x`…), videos →
 *      `videos.video_list` best rendition.
 *   4. Return the page's `bookmark` so the caller can paginate deeper.
 *
 * Legal/technical constraints honored:
 *   - Only publicly visible search results are read.
 *   - No login, no private pins, no access-control bypass, no DRM circumvention.
 *   - If Pinterest changes its markup, extraction degrades to fewer results
 *     instead of crashing — the pipeline validates everything downstream.
 */

const SEARCH_URL = 'https://www.pinterest.com/search/pins/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class PinterestWebProvider extends PinterestProvider {
  constructor(opts = {}) {
    super({ name: 'web', ...opts });
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.maxPages = opts.maxPages ?? 10;
  }

  get label() {
    return 'Pinterest (public search)';
  }

  /**
   * @param {object} opts { query, bookmark?, signal }
   * @returns {Promise<{ items: object[], bookmark: string|null, page: number }>}
   */
  async search({ query, bookmark = null, signal } = {}) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', query);
    if (bookmark) url.searchParams.set('bookmark', bookmark);

    const html = await this.#fetchPage(url, signal);
    const state = this.#extractState(html);
    const pins = this.#collectPins(state);
    const items = [];
    for (const pin of pins) {
      const item = this.#pinToCandidate(pin);
      if (item) items.push(item);
    }
    const nextBookmark = this.#extractBookmark(state) ?? null;
    this.log.debug({ query, found: items.length, hasMore: !!nextBookmark }, 'pinterest page parsed');
    return { items, bookmark: nextBookmark, page: bookmark ? 2 : 1 };
  }

  async #fetchPage(url, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      if (response.status === 429) {
        throw new LancyError('♡ Pinterest is rate-limiting me right now — try again in a moment.', { code: 'RATE_LIMITED', retryable: true });
      }
      if (!response.ok) {
        throw new LancyError(`♡ Pinterest search failed (HTTP ${response.status}).`, { code: 'HTTP_' + response.status, retryable: response.status >= 500 });
      }
      return await response.text();
    } catch (error) {
      if (error instanceof LancyError) throw error;
      if (error.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
      throw LancyError.wrap(error, '♡ I could not reach Pinterest right now.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Pull the embedded JSON state out of the search page HTML. */
  #extractState(html) {
    // Modern pages embed JSON in <script id="__PWS_DATA__" type="application/json">…</script>
    const pwsMatch = /<script[^>]*id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (pwsMatch) {
      try {
        return JSON.parse(pwsMatch[1]);
      } catch { /* fall through */ }
    }
    // Fallback: window.__PWS_DATA__ = {...};
    const inlineMatch = /window\.__PWS_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i.exec(html);
    if (inlineMatch) {
      try {
        return JSON.parse(inlineMatch[1]);
      } catch { /* fall through */ }
    }
    // Older redux embed.
    const reduxMatch = /<script[^>]*id="initialReduxState"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (reduxMatch) {
      try {
        return JSON.parse(reduxMatch[1]);
      } catch { /* give up */ }
    }
    return {};
  }

  /** Walk the state tree and collect pin-like objects. */
  #collectPins(state) {
    const pins = [];
    const seen = new Set();
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      const id = node.id ?? node.pin_id ?? node.pinId;
      if (id && (node.images || node.videos || node.image_large_url || node.grid_image_src)) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          pins.push(node);
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') visit(value, depth + 1);
      }
    };
    visit(state);
    return pins;
  }

  /** Normalize one pin object into a media candidate (best quality first). */
  #pinToCandidate(pin) {
    const pinId = String(pin.id ?? pin.pin_id ?? pin.pinId ?? '');
    if (!pinId) return null;
    const sourceUrl = pin.link ? `https://www.pinterest.com${pin.link}` : (pin.url ?? null);

    // Video first if present and playable.
    const videoList = pin.videos?.video_list ?? pin.video_list;
    if (videoList && typeof videoList === 'object') {
      const renditions = Object.values(videoList)
        .filter((v) => v && v.url)
        .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
      const best = renditions[0];
      if (best?.url) {
        return {
          pinId,
          sourceUrl,
          mediaUrl: best.url,
          type: 'video',
          width: best.width ?? null,
          height: best.height ?? null,
          duration: pin.videos?.duration ?? null
        };
      }
    }

    // Images: prefer orig, then largest available rendition.
    const images = pin.images ?? {};
    const imageUrl =
      images.orig?.url ??
      images['1200x']?.url ??
      images['736x']?.url ??
      images['564x']?.url ??
      images['474x']?.url ??
      pin.image_large_url ??
      pin.grid_image_src ??
      null;
    if (!imageUrl) return null;
    return {
      pinId,
      sourceUrl,
      mediaUrl: imageUrl,
      type: 'image',
      width: images.orig?.width ?? null,
      height: images.orig?.height ?? null
    };
  }

  #extractBookmark(state) {
    const bookmark =
      state?.props?.initialReduxState?.feeds?.bookmark ??
      state?.props?.initialReduxState?.pins?.bookmark ??
      state?.resourceResponses?.[0]?.options?.bookmarks?.[0] ??
      state?.bookmarks?.[0] ??
      null;
    return bookmark ? String(bookmark) : null;
  }
}
