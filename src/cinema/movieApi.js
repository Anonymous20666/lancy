import { logger } from '../core/logger.js';

export class MovieApiError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'MovieApiError';
    this.code = code;
    this.status = status;
  }
}

export class MovieApiClient {
  constructor({
    baseUrl = process.env.MOVIE_API_BASE_URL || 'https://pappy-hosting.duckdns.org/media/api/v1/movies',
    timeoutMs = 12000,
    maxRetries = 2,
    log
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.log = log || logger().child({ module: 'cinema:movie-api' });
    this.cache = new Map(); // key -> { data, expiresAt }
  }

  #getCache(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }

  #setCache(key, data, ttlMs = 300000) {
    // Keep max 500 cached entries
    if (this.cache.size >= 500) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  async request(endpoint, { query = {}, ttlMs = 0, retries = this.maxRetries } = {}) {
    const url = new URL(`${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }

    const cacheKey = url.toString();
    if (ttlMs > 0) {
      const cached = this.#getCache(cacheKey);
      if (cached) return cached;
    }

    let attempt = 0;
    while (attempt <= retries) {
      attempt++;
      try {
        const res = await fetch(url.toString(), {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PappyCinemaBot/1.0'
          },
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (res.status === 404) {
          throw new MovieApiError('NOT_FOUND', `Item not found at ${endpoint}`, 404);
        }

        if (!res.ok) {
          if (res.status >= 500 && attempt <= retries) {
            await new Promise(r => setTimeout(r, attempt * 500));
            continue;
          }
          throw new MovieApiError('HTTP_ERROR', `Movie API returned HTTP ${res.status}`, res.status);
        }

        const data = await res.json();
        if (ttlMs > 0) {
          this.#setCache(cacheKey, data, ttlMs);
        }
        return data;
      } catch (err) {
        if (err instanceof MovieApiError) throw err;
        if (attempt <= retries && (err.name === 'TimeoutError' || err.name === 'TypeError')) {
          await new Promise(r => setTimeout(r, attempt * 500));
          continue;
        }
        this.log.warn({ endpoint, err: err?.message }, 'Movie API request failed');
        throw new MovieApiError('NETWORK_ERROR', err?.message || 'Failed to reach Movie Intelligence API', 503);
      }
    }
  }

  // ── Health ──
  async getHealth() {
    return this.request('/health', { retries: 1 });
  }

  // ── Discovery (Cached 5–15 mins) ──
  async getHome() {
    return this.request('/home', { ttlMs: 300000 });
  }

  async getTrending({ window = 'day', type = 'all' } = {}) {
    return this.request('/trending', { query: { window, type }, ttlMs: 300000 });
  }

  async getLatestMovies(page = 1) {
    return this.request('/latest/movies', { query: { page }, ttlMs: 300000 });
  }

  async getLatestEpisodes(page = 1) {
    return this.request('/latest/episodes', { query: { page }, ttlMs: 300000 });
  }

  async getPopular({ type = 'movie', page = 1 } = {}) {
    return this.request('/popular', { query: { type, page }, ttlMs: 300000 });
  }

  async getTopRated({ type = 'movie', page = 1 } = {}) {
    return this.request('/top-rated', { query: { type, page }, ttlMs: 300000 });
  }

  // ── Search (Cached 2 mins) ──
  async search(q, { type = 'movie', page = 1 } = {}) {
    return this.request('/search', { query: { q, type, page }, ttlMs: 120000 });
  }

  // ── Categories & Genres ──
  async getGenres() {
    return this.request('/genres', { ttlMs: 86400000 });
  }

  async getCategories() {
    return this.request('/categories', { ttlMs: 86400000 });
  }

  async browse({ category, genreId, type = 'movie', sortBy, page = 1 } = {}) {
    return this.request('/browse', { query: { category, genreId, type, sortBy, page }, ttlMs: 300000 });
  }

  // ── Movie Details ──
  async getMovieDetails(id) {
    return this.request(`/movie/${id}`, { ttlMs: 600000 });
  }

  // ── TV Series Details ──
  async getTvDetails(id) {
    return this.request(`/tv/${id}`, { ttlMs: 600000 });
  }

  async getTvSeasons(id) {
    return this.request(`/tv/${id}/seasons`, { ttlMs: 600000 });
  }

  async getTvSeason(id, seasonNumber) {
    return this.request(`/tv/${id}/season/${seasonNumber}`, { ttlMs: 600000 });
  }

  async getTvEpisode(id, seasonNumber, episodeNumber) {
    return this.request(`/tv/${id}/season/${seasonNumber}/episode/${episodeNumber}`, { ttlMs: 600000 });
  }

  // ── Playback Resolution (Cached 60s) ──
  async getPlayback(id, { type = 'movie', season = null, episode = null } = {}) {
    const endpoint = type === 'tv'
      ? `/playback/${id}?type=tv&season=${season}&episode=${episode}`
      : `/playback/${id}?type=movie`;
    return this.request(endpoint, { ttlMs: 60000 });
  }

  // ── Telegram Card Endpoints ──
  async getTelegramCard(type, id, { season = null, episode = null } = {}) {
    let endpoint;
    if (type === 'tv' && season != null && episode != null) {
      endpoint = `/telegram-episode/${id}/${season}/${episode}`;
    } else if (type === 'tv' && season != null) {
      endpoint = `/telegram-season/${id}/${season}`;
    } else if (type === 'tv') {
      endpoint = `/telegram-card/tv/${id}`;
    } else {
      endpoint = `/telegram-card/movie/${id}`;
    }
    return this.request(endpoint, { ttlMs: 300000 });
  }
}
