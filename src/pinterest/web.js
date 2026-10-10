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
    // 1. Try Pinterest BaseSearchResource API (modern public JSON endpoint)
    try {
      const apiResult = await this.#searchViaResourceApi({ query, bookmark, signal });
      if (apiResult?.items?.length > 0) {
        this.log.debug({ query, found: apiResult.items.length, hasMore: !!apiResult.bookmark }, 'pinterest resource api success');
        return apiResult;
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err;
      this.log.debug({ err: err.message }, 'resource api failed, trying html fallback');
    }

    // 2. HTML extraction fallback
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

  async #searchViaResourceApi({ query, bookmark = null, signal } = {}) {
    const BASE_URL = 'https://www.pinterest.com';
    const source_url = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0';

    const baseHeaders = {
      'Host': 'www.pinterest.com',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Ch-Ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
      'Sec-Ch-Ua-Model': '""',
      'Sec-Ch-Ua-Mobile': '?0',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*, q=0.01',
      'X-Pinterest-Source-Url': source_url,
      'X-Pinterest-Appstate': 'active',
      'Accept-Language': 'en-US,en;q=0.9',
      'Screen-Dpr': '1',
      'X-Pinterest-Pws-Handler': 'www/search/[scope].js',
      'User-Agent': userAgent,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Referer': `${BASE_URL}/`
    };

    let cookieHeader = '';
    try {
      const warmupRes = await fetch(`${BASE_URL}${source_url}`, {
        headers: baseHeaders,
        signal
      });
      const rawCookies = warmupRes.headers.getSetCookie ? warmupRes.headers.getSetCookie() : [warmupRes.headers.get('set-cookie')].filter(Boolean);
      cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    // NOTE: the whole payload is URL-encoded once below — never pre-encode
    // individual fields or Pinterest searches for the literal "%20" string.
    const payload = {
      options: {
        page_size: '50',
        query,
        redux_normalize_feed: true,
        rs: 'typed',
        scope: 'pins',
        source_url,
        ...(bookmark ? { bookmarks: [bookmark] } : {})
      },
      context: {}
    };

    const encodedData = encodeURIComponent(JSON.stringify(payload));
    const apiUrl = `${BASE_URL}/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(source_url)}&data=${encodedData}&_=${Date.now()}`;
    const headers = { ...baseHeaders };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const apiRes = await fetch(apiUrl, { headers, signal });
    if (!apiRes.ok) return null;

    const json = await apiRes.json().catch(() => null);
    const results = json?.resource_response?.data?.results || [];
    const items = [];
    for (const pin of results) {
      const item = this.#pinToCandidate(pin);
      if (item) items.push(item);
    }
    const nextBookmark = json?.resource_response?.bookmark ?? null;
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

    // Video first if present and playable. Classic video pins carry
    // `videos.video_list`; story/idea pins carry it inside a page block.
    let videoList = pin.videos?.video_list ?? pin.video_list;
    if (!videoList && pin.story_pin_data?.pages) {
      for (const page of pin.story_pin_data.pages) {
        const vb = (page?.blocks ?? []).find((blk) => blk?.video?.video_list);
        if (vb) { videoList = vb.video.video_list; break; }
      }
    }
    if (videoList && typeof videoList === 'object') {
      // Prefer progressive MP4 (V_720P etc.) over HLS, then highest resolution.
      const renditions = Object.values(videoList)
        .filter((v) => v && v.url)
        .sort((a, b) => {
          const mp4 = (v) => (/\.mp4(\?|$)/i.test(v.url) ? 1 : 0);
          return (mp4(b) - mp4(a)) || ((b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
        });
      const best = renditions[0];
      if (best?.url) {
        return {
          pinId,
          sourceUrl,
          mediaUrl: best.url,
          thumbnailUrl: best.thumbnail ?? null,
          type: 'video',
          width: best.width ?? null,
          height: best.height ?? null,
          duration: best.duration ? best.duration / 1000 : (pin.videos?.duration ?? null)
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
