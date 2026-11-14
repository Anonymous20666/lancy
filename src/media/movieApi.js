import { logger } from '../core/logger.js';

const DEFAULT_BASE_URL = 'https://pappy-hosting.duckdns.org/media/api/v1/movies';

class TtlCache {
  constructor(maxEntries = 300) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value, ttlMs = 180_000) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

function normalizeListItem(item, fallbackType = null) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.provider_id ?? item.id ?? '').trim();
  const title = String(item.title || item.name || item.original_title || '').trim();
  if (!id || !title) return null;
  const typeRaw = String(item.type || item.media_type || fallbackType || 'movie').toLowerCase();
  const type = typeRaw === 'tv' || typeRaw === 'series' || typeRaw === 'show' ? 'tv' : 'movie';
  return {
    provider: item.provider || 'holaflix',
    id,
    providerId: id,
    type,
    title,
    originalTitle: item.original_title || null,
    releaseDate: item.release_date || item.first_air_date || null,
    year: item.year ? Number(item.year) : (item.release_date ? Number(String(item.release_date).slice(0, 4)) || null : null),
    poster: item.poster || null,
    backdrop: item.backdrop || null,
    overview: String(item.overview || '').trim(),
    genres: Array.isArray(item.genre) ? item.genre : (Array.isArray(item.genres) ? item.genres : []),
    rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
    detailUrl: item.detail_url || null,
    playUrl: item.play_url || null
  };
}

export function normalizeSeasonsList(seasons = []) {
  const list = (Array.isArray(seasons) ? seasons : [])
    .map((s) => ({
      seasonNumber: Number(s.season_number ?? s.seasonNumber ?? 0),
      name: String(s.name || `Season ${s.season_number ?? 0}`),
      overview: String(s.overview || '').trim(),
      poster: s.poster || null,
      airDate: s.air_date || null,
      episodeCount: Number(s.episode_count ?? s.episodeCount ?? 0)
    }))
    .filter((s) => Number.isFinite(s.seasonNumber) && (s.episodeCount > 0 || s.seasonNumber >= 1));

  // Always present Season 1..N first, placing Specials (0) at the end
  list.sort((a, b) => {
    if (a.seasonNumber === 0 && b.seasonNumber !== 0) return 1;
    if (b.seasonNumber === 0 && a.seasonNumber !== 0) return -1;
    return a.seasonNumber - b.seasonNumber;
  });
  return list;
}

export class MovieApiClient {
  constructor({ baseUrl = process.env.MOVIE_API_BASE_URL || DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = 9000, log } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = log || logger().child({ module: 'movie-api' });
    this.cache = new TtlCache(350);
  }

  async #getJson(path, query = null, { ttlMs = 180_000, forceRefresh = false } = {}) {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const cacheKey = url.toString();
    if (ttlMs > 0 && !forceRefresh) {
      const hit = this.cache.get(cacheKey);
      if (hit) return hit;
    }

    const res = await this.fetch(cacheKey, {
      headers: { Accept: 'application/json', 'User-Agent': 'LancyBot/10.3' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      const err = new Error(`Movie API HTTP ${res.status}: ${msg.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (ttlMs > 0) this.cache.set(cacheKey, data, ttlMs);
    return data;
  }

  async search(query, { type = 'multi', year, page = 1, limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { query: '', count: 0, results: [] };
    const data = await this.#getJson('/search', { q, type, year, page, limit }, { ttlMs: 180_000 });
    const results = (data?.results || []).map((x) => normalizeListItem(x, type === 'tv' ? 'tv' : null)).filter(Boolean);
    return {
      provider: data?.provider || 'holaflix',
      query: data?.query || q,
      count: Number(data?.count ?? results.length),
      results
    };
  }

  async trending({ window = 'day', type = 'all', page = 1, includeUpcoming = false, forceRefresh = false } = {}) {
    const primaryFallback = type === 'tv' ? 'tv' : 'movie';
    const requests = [
      this.#getJson('/trending', { window, type, page }, { ttlMs: 60_000, forceRefresh })
        .then((d) => ({ items: d?.results || [], fallbackType: primaryFallback }))
    ];
    if (window === 'day' && type === 'all' && Number(page) === 1) {
      requests.push(
        this.#getJson('/trending', { window: 'day', type: 'movie', page: 1 }, { ttlMs: 60_000, forceRefresh })
          .then((d) => ({ items: d?.results || [], fallbackType: 'movie' })),
        this.#getJson('/trending', { window: 'day', type: 'tv', page: 1 }, { ttlMs: 60_000, forceRefresh })
          .then((d) => ({ items: d?.results || [], fallbackType: 'tv' })),
        this.#getJson('/trending', { window: 'week', type: 'all', page: 1 }, { ttlMs: 120_000, forceRefresh })
          .then((d) => ({ items: d?.results || [], fallbackType: 'movie' })),
        this.#getJson('/popular', { type: 'movie', page: 1 }, { ttlMs: 180_000, forceRefresh })
          .then((d) => ({ items: d?.results || [], fallbackType: 'movie' }))
      );
    }

    const settled = await Promise.allSettled(requests);
    const primaryRes = settled[0];
    if (primaryRes.status === 'rejected' && settled.every((r) => r.status === 'rejected')) {
      throw primaryRes.reason;
    }

    const seen = new Set();
    const merged = [];
    for (const entry of settled) {
      if (entry.status !== 'fulfilled' || !entry.value) continue;
      for (const raw of entry.value.items) {
        const norm = normalizeListItem(raw, entry.value.fallbackType);
        if (!norm) continue;
        const key = `${norm.type}:${norm.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(norm);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const results = includeUpcoming
      ? merged
      : merged.filter((item) => !item.releaseDate || String(item.releaseDate).slice(0, 10) <= today);
    const finalResults = results.length ? results : merged;
    return { window, type, count: finalResults.length, results: finalResults };
  }

  async popular({ type = 'movie', page = 1 } = {}) {
    const data = await this.#getJson('/popular', { type, page }, { ttlMs: 300_000 });
    const results = (data?.results || []).map((x) => normalizeListItem(x, type)).filter(Boolean);
    return { type, count: results.length, results };
  }

  async topRated({ type = 'movie', page = 1 } = {}) {
    const data = await this.#getJson('/top-rated', { type, page }, { ttlMs: 300_000 });
    const results = (data?.results || []).map((x) => normalizeListItem(x, type)).filter(Boolean);
    return { type, count: results.length, results };
  }

  async browse({ type = 'movie', genreId, category, year, sortBy = 'popularity.desc', page = 1, limit = 20 } = {}) {
    const data = await this.#getJson('/browse', { type, genreId, category, year, sortBy, page, limit }, { ttlMs: 300_000 });
    const results = (data?.results || []).map((x) => normalizeListItem(x, type)).filter(Boolean);
    return { page: Number(data?.page || page), count: results.length, results };
  }

  async categories() {
    const data = await this.#getJson('/categories', null, { ttlMs: 3_600_000 });
    return Array.isArray(data?.categories) ? data.categories : [];
  }

  async genres() {
    const data = await this.#getJson('/genres', null, { ttlMs: 3_600_000 });
    return Array.isArray(data?.genres) ? data.genres : [];
  }

  async pickRandom({ type = 'all', category = null, genreId = null } = {}) {
    const page = 1 + Math.floor(Math.random() * 4);
    let pool = [];
    if (category || genreId) {
      const pickedType = type === 'tv' ? 'tv' : 'movie';
      const b = await this.browse({ type: pickedType, category, genreId, page }).catch(() => null);
      pool = b?.results || [];
      if (!pool.length && page > 1) {
        const b1 = await this.browse({ type: pickedType, category, genreId, page: 1 }).catch(() => null);
        pool = b1?.results || [];
      }
    }
    if (!pool.length) {
      const fn = Math.random() < 0.55
        ? () => this.trending({ window: 'week', type, page })
        : () => this.popular({ type: type === 'all' ? (Math.random() < 0.5 ? 'movie' : 'tv') : type, page });
      const res = await fn().catch(() => null) || await this.trending({ window: 'day', type: 'all', page: 1 }).catch(() => null);
      pool = res?.results || [];
    }
    if (!pool.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const released = pool.filter((item) => !item.releaseDate || String(item.releaseDate).slice(0, 10) <= today);
    const pickFrom = released.length ? released : pool;
    return pickFrom[Math.floor(Math.random() * pickFrom.length)];
  }

  async getMovie(id) {
    const data = await this.#getJson(`/movie/${encodeURIComponent(id)}`, null, { ttlMs: 900_000 });
    const base = normalizeListItem(data, 'movie');
    if (!base) return null;
    return {
      ...base,
      runtimeMinutes: Number(data.runtime) || null,
      runtimeSeconds: Number(data.runtime) ? Number(data.runtime) * 60 : null,
      imdbId: data.imdb_id || data.imdbId || null,
      cast: Array.isArray(data.cast) ? data.cast.slice(0, 8) : [],
      director: data.director || null,
      language: data.language || null,
      genres: Array.isArray(data.genres) ? data.genres : base.genres,
      media: data.media || null
    };
  }

  async getTvShow(id) {
    const data = await this.#getJson(`/tv/${encodeURIComponent(id)}`, null, { ttlMs: 900_000 });
    const base = normalizeListItem(data, 'tv');
    if (!base) return null;
    const seasons = normalizeSeasonsList(data.seasons);
    return {
      ...base,
      totalSeasons: Number(data.total_seasons ?? seasons.filter((s) => s.seasonNumber > 0).length) || seasons.length,
      totalEpisodes: Number(data.total_episodes) || null,
      status: data.status || null,
      imdbId: data.imdb_id || data.imdbId || null,
      cast: Array.isArray(data.cast) ? data.cast.slice(0, 8) : [],
      genres: Array.isArray(data.genres) ? data.genres : base.genres,
      seasons
    };
  }

  async getTvSeasons(id) {
    const data = await this.#getJson(`/tv/${encodeURIComponent(id)}/seasons`, null, { ttlMs: 900_000 });
    const seasons = normalizeSeasonsList(data?.seasons);
    return {
      seriesId: String(data?.series_id ?? id),
      title: String(data?.title || 'TV Series'),
      totalSeasons: Number(data?.total_seasons ?? seasons.filter((s) => s.seasonNumber > 0).length) || seasons.length,
      totalEpisodes: Number(data?.total_episodes) || null,
      seasons
    };
  }

  async getTvSeasonEpisodes(id, seasonNumber = 1) {
    const sNum = Math.max(0, Number(seasonNumber) || 1);
    const data = await this.#getJson(`/tv/${encodeURIComponent(id)}/season/${sNum}`, null, { ttlMs: 900_000 });
    const episodes = (Array.isArray(data?.episodes) ? data.episodes : []).map((ep) => ({
      seriesId: String(ep.series_id ?? id),
      seasonNumber: Number(ep.season_number ?? sNum),
      episodeNumber: Number(ep.episode_number ?? 1),
      title: String(ep.title || ep.name || `Episode ${ep.episode_number ?? ''}`).trim(),
      overview: String(ep.overview || '').trim(),
      airDate: ep.air_date || null,
      runtimeMinutes: Number(ep.runtime) || null,
      runtimeSeconds: Number(ep.runtime) ? Number(ep.runtime) * 60 : null,
      still: ep.still || ep.still_path || data?.poster || null
    }));
    episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
    return {
      seriesId: String(data?.series_id ?? id),
      seasonNumber: Number(data?.season_number ?? sNum),
      name: String(data?.name || `Season ${sNum}`),
      overview: String(data?.overview || '').trim(),
      poster: data?.poster || null,
      airDate: data?.air_date || null,
      episodeCount: Number(data?.episode_count ?? episodes.length),
      episodes
    };
  }

  async getPlaybackInfo(type, id, { season, episode } = {}) {
    const t = String(type).toLowerCase() === 'tv' ? 'tv' : 'movie';
    const data = await this.#getJson(`/playback/${encodeURIComponent(id)}`, {
      type: t,
      ...(t === 'tv' && season ? { season } : {}),
      ...(t === 'tv' && episode ? { episode } : {})
    }, { ttlMs: 120_000 });
    const safeServers = (Array.isArray(data?.servers) ? data.servers : [])
      .filter((s) => s && s.id !== 'autoembed' && s.url);
    return {
      available: Boolean(data?.available),
      defaultServer: data?.default_server || safeServers[0]?.id || 'cinezo',
      embedUrl: data?.embed_url || safeServers[0]?.url || null,
      webappPlayerUrl: data?.webapp_player_url
        || `${this.baseUrl}/player?type=${t}&id=${encodeURIComponent(id)}${t === 'tv' && season && episode ? `&season=${season}&episode=${episode}` : ''}`,
      servers: safeServers,
      qualities: Array.isArray(data?.qualities) ? data.qualities : [],
      subtitles: Array.isArray(data?.subtitles) ? data.subtitles : [],
      rootStream: data?.root_stream || null,
      viewingUrl: data?.viewing_url || null
    };
  }
}
