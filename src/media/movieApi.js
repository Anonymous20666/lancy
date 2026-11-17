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

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 32))
    .replace(/\s+/g, ' ')
    .trim();
}

function expandCamelCaseTitle(title = '') {
  return String(title || '')
    .replace(/([a-z]{3,})([A-Z][a-z]{2,})/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normTitleMergeKey(title = '') {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

const NON_FEATURE_PROMO_RE = /\b(?:trailers?|teasers?|previews?|promos?|sneak\s*peeks?|clips?|samples?|excerpts?|snippets?|recaps?|featurettes?|behind\s*the\s*scenes|making\s*of|deleted\s+scenes?|bloopers?|gag\s+reel|short\s*films?|compilations?|highlights?|interviews?|fan\s*edits?|youtube\s*shorts?|opening\s+scenes?|final\s+scenes?|how\s+to\s+download|announcement|telegram\s+channel)\b/i;

function isNonFeaturePromoTitle(title = '') {
  return NON_FEATURE_PROMO_RE.test(String(title || ''));
}

function parseArchiveRuntimeMinutes(rawRuntime) {
  const val = Array.isArray(rawRuntime) ? rawRuntime[0] : rawRuntime;
  const s = String(val || '').trim();
  if (!s) return null;
  const hms = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const a = Number(hms[1]);
    const b = Number(hms[2]);
    const c = hms[3] !== undefined ? Number(hms[3]) : null;
    const totalSec = c !== null ? (a * 3600 + b * 60 + c) : (a * 60 + b);
    return totalSec > 0 ? Math.max(1, Math.round(totalSec / 60)) : null;
  }
  const numM = s.match(/(\d+(?:\.\d+)?)\s*(?:min|minutes?|m\b)/i);
  if (numM) return Math.max(1, Math.round(Number(numM[1])));
  if (/^\d{1,3}$/.test(s)) return Math.max(1, Number(s));
  return null;
}

function firstLangValue(lang) {
  const val = Array.isArray(lang) ? lang[0] : lang;
  const s = String(val || '').trim();
  return s || null;
}

function cleanWpMovieTitle(rawTitle = '') {
  return stripHtml(rawTitle)
    .replace(/^(?:download|watch(?:\s+online)?)\s*[:\-–]?\s*/i, '')
    .replace(/\s*\((?:download(?:\s+movie)?|full\s+movie|hd\s+mp4)\)/gi, '')
    .replace(/\s*\|\s*(?:nkiri|thenkiri|netnaija|fzmovies).*$/i, '')
    .replace(/\s*(?:full\s+movie|complete\s+season.*|hd\s+mp4|mkv).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeListItem(item, fallbackType = null) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.provider_id ?? item.id ?? '').trim();
  const title = String(item.title || item.name || item.original_title || '').trim();
  if (!id || !title) return null;
  const typeRaw = String(item.type || item.media_type || fallbackType || 'movie').toLowerCase();
  const type = typeRaw === 'tv' || typeRaw === 'series' || typeRaw === 'show' ? 'tv' : 'movie';
  const imdbRaw = item.imdb_id || item.imdbId || (/^tt\d+$/i.test(id) ? id : null);
  const tmdbRaw = item.tmdb_id || item.tmdbId || (/^\d+$/.test(id) ? id : null);
  return {
    provider: item.provider || 'holaflix',
    sourceProvider: item.sourceProvider || item.source || item.provider || 'holaflix',
    id,
    providerId: id,
    imdbId: imdbRaw ? String(imdbRaw).trim() : null,
    tmdbId: tmdbRaw ? String(tmdbRaw).trim() : null,
    tvmazeId: item.tvmazeId || null,
    type,
    title,
    originalTitle: item.original_title || item.originalTitle || null,
    originalLanguage: item.original_language || item.originalLanguage || null,
    language: item.language || item.original_language || null,
    releaseDate: item.release_date || item.first_air_date || null,
    year: item.year ? Number(item.year) : (item.release_date ? Number(String(item.release_date).slice(0, 4)) || null : null),
    poster: item.poster || null,
    backdrop: item.backdrop || null,
    overview: String(item.overview || '').trim(),
    genres: Array.isArray(item.genre) ? item.genre : (Array.isArray(item.genres) ? item.genres : []),
    rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
    runtimeMinutes: Number(item.runtimeMinutes || item.runtime) || null,
    runtimeSeconds: Number(item.runtimeSeconds) || (Number(item.runtimeMinutes || item.runtime) ? Number(item.runtimeMinutes || item.runtime) * 60 : null),
    adult: Boolean(item.adult),
    detailUrl: item.detail_url || item.detailUrl || null,
    playUrl: item.play_url || item.playUrl || null,
    downloadUrls: Array.isArray(item.downloadUrls) ? item.downloadUrls : [],
    cast: Array.isArray(item.cast) ? item.cast.slice(0, 8) : []
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
    this.externalItems = new Map();
    this.tmdbMappingCache = new TtlCache(300);
  }

  #rememberExternalItem(item) {
    if (!item?.id) return;
    if (this.externalItems.size > 400) {
      const oldest = this.externalItems.keys().next().value;
      if (oldest !== undefined) this.externalItems.delete(oldest);
    }
    this.externalItems.set(`${item.type || 'movie'}:${item.id}`, item);
    this.externalItems.set(String(item.id), item);
  }

  async #fetchExternalJson(url, { ttlMs = 180_000, headers = {}, timeoutMs = 4200 } = {}) {
    if (!url || typeof this.fetch !== 'function') return null;
    if (ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit) return hit;
    }
    try {
      const res = await this.fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'LancyBot/10.3',
          ...headers
        },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs || 9000, timeoutMs))
      });
      if (!res?.ok) return null;
      const data = await res.json();
      if (ttlMs > 0 && data) this.cache.set(url, data, ttlMs);
      return data;
    } catch {
      return null;
    }
  }

  async #searchCinemeta(query, { type = 'multi', limit = 10 } = {}) {
    const types = type === 'tv' ? ['series'] : (type === 'movie' ? ['movie'] : ['movie', 'series']);
    const responses = await Promise.all(
      types.map((cType) =>
        this.#fetchExternalJson(
          `https://v3-cinemeta.strem.io/catalog/${cType}/top/search=${encodeURIComponent(query)}.json`,
          { ttlMs: 300_000 }
        ).then((d) => ({ cType, metas: Array.isArray(d?.metas) ? d.metas : [] }))
      )
    );
    const out = [];
    for (const { cType, metas } of responses) {
      for (const m of metas.slice(0, limit)) {
        const imdb = String(m.imdb_id || m.id || '').trim();
        if (!imdb || !m.name) continue;
        const ym = String(m.releaseInfo || m.year || '').match(/\d{4}/);
        const rtMin = parseArchiveRuntimeMinutes(m.runtime) || null;
        const norm = normalizeListItem({
          id: imdb,
          imdb_id: /^tt\d+$/i.test(imdb) ? imdb : null,
          type: cType === 'series' ? 'tv' : 'movie',
          title: m.name,
          year: ym ? Number(ym[0]) : null,
          poster: m.poster || m.background || null,
          backdrop: m.background || null,
          overview: m.description || '',
          genres: Array.isArray(m.genres) ? m.genres : [],
          rating: m.imdbRating,
          runtime: m.runtime || null,
          runtimeMinutes: rtMin,
          runtimeSeconds: rtMin ? rtMin * 60 : null,
          cast: Array.isArray(m.cast) ? m.cast : [],
          provider: 'cinemeta',
          sourceProvider: 'cinemeta'
        });
        if (norm) {
          this.#rememberExternalItem(norm);
          out.push(norm);
        }
      }
    }
    return out;
  }

  async #searchImdbSuggest(query, { type = 'multi', limit = 8 } = {}) {
    const clean = String(query || '').trim().toLowerCase().replace(/[^a-z0-9\s_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const first = /^[a-z0-9]/.test(clean) ? clean[0] : '_';
    const slug = clean.replace(/\s+/g, '_');
    const url = `https://v3.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(slug)}.json`;
    const data = await this.#fetchExternalJson(url, { ttlMs: 300_000 });
    const list = Array.isArray(data?.d) ? data.d : [];
    const out = [];
    for (const d of list) {
      const id = String(d?.id || '').trim();
      if (!/^tt\d+$/i.test(id) || !d?.l) continue;
      const qid = String(d.qid || d.q || '').toLowerCase();
      if (qid.includes('game') || qid.includes('podcast')) continue;
      const isTv = qid.includes('tvseries') || qid.includes('tvminiseries') || qid.includes('series');
      const itemType = isTv ? 'tv' : 'movie';
      if (type === 'movie' && itemType !== 'movie') continue;
      if (type === 'tv' && itemType !== 'tv') continue;
      const norm = normalizeListItem({
        id,
        imdb_id: id,
        type: itemType,
        title: d.l,
        year: Number(d.y) || null,
        poster: d.i?.imageUrl || null,
        overview: d.s ? `Starring: ${d.s}` : '',
        cast: d.s ? String(d.s).split(',').map((s) => s.trim()).filter(Boolean) : [],
        provider: 'imdb',
        sourceProvider: 'imdb'
      });
      if (norm) {
        this.#rememberExternalItem(norm);
        out.push(norm);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async #searchTvMaze(query, { limit = 8 } = {}) {
    const data = await this.#fetchExternalJson(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`,
      { ttlMs: 300_000 }
    );
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const row of data.slice(0, limit)) {
      const s = row?.show;
      if (!s?.id || !s?.name) continue;
      const imdb = s.externals?.imdb && /^tt\d+$/i.test(s.externals.imdb) ? s.externals.imdb : null;
      const norm = normalizeListItem({
        id: imdb || `tvmaze:${s.id}`,
        imdb_id: imdb,
        tvmazeId: s.id,
        type: 'tv',
        title: s.name,
        year: s.premiered ? Number(String(s.premiered).slice(0, 4)) || null : null,
        poster: s.image?.original || s.image?.medium || null,
        overview: stripHtml(s.summary || ''),
        genres: Array.isArray(s.genres) ? s.genres : [],
        rating: s.rating?.average,
        runtime: s.runtime || s.averageRuntime || null,
        language: s.language || null,
        detail_url: s.url || null,
        provider: 'tvmaze',
        sourceProvider: 'tvmaze'
      });
      if (norm) {
        this.#rememberExternalItem(norm);
        out.push(norm);
      }
    }
    return out;
  }

  async #searchYtsMovies(query, { limit = 8 } = {}) {
    const data = await this.#fetchExternalJson(
      `https://movies-api.accel.li/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=${Math.min(12, Math.max(4, limit))}&sort_by=download_count`,
      { ttlMs: 300_000 }
    );
    const movies = Array.isArray(data?.data?.movies) ? data.data.movies : [];
    const out = [];
    for (const m of movies.slice(0, limit)) {
      const imdb = m.imdb_code && /^tt\d+$/i.test(m.imdb_code) ? m.imdb_code : null;
      const id = imdb || (m.id ? `yts:${m.id}` : '');
      if (!id || !m.title) continue;
      const norm = normalizeListItem({
        id,
        imdb_id: imdb,
        type: 'movie',
        title: m.title_english || m.title,
        year: Number(m.year) || null,
        poster: m.large_cover_image || m.medium_cover_image || null,
        backdrop: m.background_image_original || m.background_image || null,
        overview: m.description_full || m.summary || '',
        genres: Array.isArray(m.genres) ? m.genres : [],
        rating: m.rating,
        runtime: m.runtime || null,
        language: m.language || null,
        detail_url: m.url || null,
        provider: 'yts',
        sourceProvider: 'yts'
      });
      if (norm) {
        this.#rememberExternalItem(norm);
        out.push(norm);
      }
    }
    return out;
  }

  async #searchWordpressIndexes(query, { type = 'multi', limit = 6 } = {}) {
    const hosts = [
      { key: 'thenkiri', base: 'https://thenkiri.com' },
      { key: 'nkiriink', base: 'https://nkiri.ink' }
    ];
    const perHost = Math.min(5, Math.max(3, limit));
    const lists = await Promise.all(
      hosts.map((h) =>
        this.#fetchExternalJson(
          `${h.base}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=${perHost}`,
          { ttlMs: 300_000, timeoutMs: 3800 }
        ).then((posts) => ({ host: h, posts: Array.isArray(posts) ? posts : [] }))
      )
    );
    const out = [];
    for (const { host, posts } of lists) {
      for (const post of posts) {
        const rawTitle = stripHtml(post?.title?.rendered || '');
        if (!post?.id || !rawTitle) continue;
        if (isNonFeaturePromoTitle(rawTitle)) continue;
        const link = String(post.link || '').trim();
        const isTv = /\b(?:season\s*\d+|s\d{1,2}|complete\s+(?:series|season)|tv\s+series|miniseries|mini[\s-]?series|episodes?\s*\d+(?:\s*[-–&to]+\s*\d+)?)\b/i.test(`${rawTitle} ${link}`);
        if (type === 'movie' && isTv) continue;
        if (type === 'tv' && !isTv) continue;
        const ym = rawTitle.match(/\((19\d{2}|20[0-3]\d)\)/) || rawTitle.match(/\b(19\d{2}|20[0-3]\d)\b/);
        const html = String(post?.content?.rendered || '');
        const imgM = post.jetpack_featured_media_url || html.match(/<img[^>]+src=["'](https:\/\/[^"']+)["']/i)?.[1] || null;
        const dlMatches = [...html.matchAll(/href=["'](https:\/\/(?:[^"']*(?:downloadwella|nkiri|sabishare|mega|mediafire)[^"']*))["']/gi)].map((m) => m[1]);
        const cleanTitle = cleanWpMovieTitle(rawTitle);
        if (!cleanTitle) continue;
        const norm = normalizeListItem({
          id: `wp:${host.key}:${post.id}`,
          type: isTv ? 'tv' : 'movie',
          title: cleanTitle,
          year: ym ? Number(ym[1]) : null,
          poster: imgM,
          overview: stripHtml(post?.excerpt?.rendered || '').slice(0, 320),
          detail_url: link || null,
          downloadUrls: [...new Set(dlMatches)].slice(0, 40),
          provider: 'nkiri',
          sourceProvider: host.key
        });
        if (norm) {
          this.#rememberExternalItem(norm);
          out.push(norm);
        }
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async #searchInternetArchive(query, { limit = 5 } = {}) {
    const aq = `(${String(query || '').trim()}) AND mediatype:(movies)`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(aq)}&fl[]=identifier,title,year,description,runtime,language&rows=${Math.min(8, limit)}&output=json`;
    const data = await this.#fetchExternalJson(url, { ttlMs: 360_000, timeoutMs: 3800 });
    const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
    const out = [];
    for (const doc of docs.slice(0, limit)) {
      const ident = String(doc?.identifier || '').trim();
      const title = Array.isArray(doc?.title) ? doc.title[0] : doc?.title;
      if (!ident || !title || isNonFeaturePromoTitle(title)) continue;
      const rtMin = parseArchiveRuntimeMinutes(doc?.runtime);
      if (rtMin !== null && rtMin > 0 && rtMin < 20) continue;
      const desc = Array.isArray(doc.description) ? doc.description[0] : doc.description;
      const yrMatch = String(doc.year || '').match(/\d{4}/);
      const docLang = firstLangValue(doc?.language);
      const norm = normalizeListItem({
        id: `archive:${ident}`,
        type: 'movie',
        title: cleanWpMovieTitle(title),
        year: yrMatch ? Number(yrMatch[0]) : null,
        poster: `https://archive.org/services/img/${encodeURIComponent(ident)}`,
        overview: stripHtml(desc || '').slice(0, 320),
        detail_url: `https://archive.org/details/${encodeURIComponent(ident)}`,
        runtimeMinutes: rtMin,
        original_language: docLang,
        language: docLang,
        provider: 'archive',
        sourceProvider: 'archive'
      });
      if (norm) {
        this.#rememberExternalItem(norm);
        out.push(norm);
      }
    }
    return out;
  }

  #mergeCatalogResults(primary = [], external = []) {
    const out = [];
    const byId = new Map();
    const byImdb = new Map();
    const byTitleBuckets = new Map();
    const byNormAnyType = new Map();

    const mergeInto = (target, src) => {
      if (!target.imdbId && src.imdbId) target.imdbId = src.imdbId;
      if (!target.tmdbId && src.tmdbId) target.tmdbId = src.tmdbId;
      if (!target.tvmazeId && src.tvmazeId) target.tvmazeId = src.tvmazeId;
      if (!target.poster && src.poster) target.poster = src.poster;
      if (!target.backdrop && src.backdrop) target.backdrop = src.backdrop;
      if (!target.overview && src.overview) target.overview = src.overview;
      if (!target.year && src.year) target.year = src.year;
      if (!target.rating && src.rating) target.rating = src.rating;
      if (!target.originalTitle && src.originalTitle) target.originalTitle = src.originalTitle;
      if (!target.originalLanguage && src.originalLanguage) target.originalLanguage = src.originalLanguage;
      if (!target.language && src.language) target.language = src.language;
      if (!target.runtimeMinutes && src.runtimeMinutes) {
        target.runtimeMinutes = src.runtimeMinutes;
        target.runtimeSeconds = src.runtimeSeconds || src.runtimeMinutes * 60;
      }
      if ((!target.genres || !target.genres.length) && Array.isArray(src.genres) && src.genres.length) {
        target.genres = src.genres;
      }
      if ((!target.cast || !target.cast.length) && Array.isArray(src.cast) && src.cast.length) {
        target.cast = src.cast;
      }
      if (Array.isArray(src.downloadUrls) && src.downloadUrls.length) {
        target.downloadUrls = [...new Set([...(target.downloadUrls || []), ...src.downloadUrls])];
      }
      if (!target.detailUrl && src.detailUrl) target.detailUrl = src.detailUrl;
    };

    const addItem = (item) => {
      if (!item?.id || !item?.title) return;
      const idKey = `${item.type}:${item.id}`;
      const existingById = byId.get(idKey);
      if (existingById) {
        mergeInto(existingById, item);
        return;
      }
      if (item.imdbId) {
        const imdbKey = `${item.type}:${item.imdbId}`;
        const existingByImdb = byImdb.get(imdbKey);
        if (existingByImdb) {
          mergeInto(existingByImdb, item);
          byId.set(idKey, existingByImdb);
          return;
        }
      }
      const normTitle = normTitleMergeKey(expandCamelCaseTitle(item.title));
      const tKey = `${item.type}:${normTitle}`;
      const bucket = byTitleBuckets.get(tKey) || [];
      let existingSameTitle = null;
      if (bucket.length) {
        if (item.year) {
          existingSameTitle = bucket.find(
            (cand) => cand.year && Math.abs(Number(item.year) - Number(cand.year)) <= 1
          ) || (bucket.length === 1 && !bucket[0].year ? bucket[0] : null);
        } else {
          // Undated duplicate/stub merges into the primary dated entry rather than cloning another card.
          existingSameTitle = bucket.find((cand) => Boolean(cand.year)) || bucket[0];
        }
      }
      // Cross-type undated metadata-empty stub (e.g. Cinemeta "Arcane (null)" placeholder when TV series Arcane exists).
      if (!existingSameTitle && !item.year && !item.overview && normTitle) {
        const anyBucket = byNormAnyType.get(normTitle) || [];
        if (anyBucket.length) {
          const host = anyBucket.find((cand) => cand.poster || cand.overview || cand.year) || anyBucket[0];
          if (host) {
            mergeInto(host, item);
            byId.set(idKey, host);
            return;
          }
        }
      }
      if (existingSameTitle) {
        mergeInto(existingSameTitle, item);
        byId.set(idKey, existingSameTitle);
        if (item.imdbId) byImdb.set(`${item.type}:${item.imdbId}`, existingSameTitle);
        return;
      }

      const clone = { ...item };
      out.push(clone);
      byId.set(idKey, clone);
      if (clone.imdbId) byImdb.set(`${clone.type}:${clone.imdbId}`, clone);
      if (normTitle) {
        bucket.push(clone);
        byTitleBuckets.set(tKey, bucket);
        const anyB = byNormAnyType.get(normTitle) || [];
        anyB.push(clone);
        byNormAnyType.set(normTitle, anyB);
      }
    };

    for (const p of primary) addItem(p);
    for (const e of external) addItem(e);
    return out;
  }

  #consolidateSearchResults(results = [], query = '') {
    if (!Array.isArray(results) || results.length <= 1) return results;
    const normQ = normTitleMergeKey(expandCamelCaseTitle(query));
    const qLower = String(query || '').toLowerCase();
    const wantsPromo = /\b(?:behind\s+the\s+scenes|fan\s*film|making\s+of|minisode|revealed|featurette)\b/i.test(qLower);
    const currentYear = new Date().getUTCFullYear();

    const tvEntries = results
      .filter((r) => r?.type === 'tv' && r?.title)
      .map((r) => ({
        item: r,
        norm: normTitleMergeKey(expandCamelCaseTitle(r.title)),
        spacedLower: expandCamelCaseTitle(r.title).toLowerCase()
      }))
      .filter((t) => t.norm.length >= 6);

    const bestByNormType = new Map();
    for (const r of results) {
      const nk = `${r.type}:${normTitleMergeKey(expandCamelCaseTitle(r.title))}`;
      const quality = (r.tmdbId ? 8 : 0) + (r.year ? 4 : 0) + (r.poster ? 2 : 0) + (r.overview ? 2 : 0) + (r.rating ? 1 : 0);
      const prev = bestByNormType.get(nk);
      if (!prev || quality > prev.quality) bestByNormType.set(nk, { item: r, quality });
    }

    const primary = [];
    const deferred = [];
    const foldedCompilations = [];

    for (const r of results) {
      const normTitle = normTitleMergeKey(expandCamelCaseTitle(r.title));
      const nk = `${r.type}:${normTitle}`;
      const best = bestByNormType.get(nk);

      // Drop undated / zero-metadata ghost duplicates when a populated entry for the same title+type exists.
      if (best && best.item !== r && !r.year && !r.overview && !r.rating) {
        if (!best.item.imdbId && r.imdbId) best.item.imdbId = r.imdbId;
        if (!best.item.tmdbId && r.tmdbId) best.item.tmdbId = r.tmdbId;
        continue;
      }

      // Demote non-feature promos / fan films / minisodes unless user explicitly queried them.
      if (!wantsPromo && /\b(?:behind\s+the\s+scenes|fan\s*film|making\s+of|minisodes?|revealed)\b/i.test(String(r.title || ''))) {
        deferred.push(r);
        continue;
      }

      // Demote sparse far-future placeholder entries when an earlier released match exists.
      if (r.year && Number(r.year) > currentYear + 1 && !r.overview && !r.rating && best && Number(best.item.year || 0) <= currentYear + 1) {
        deferred.push(r);
        continue;
      }

      // Fold same-run episode-arc compilation TV-movies when the parent TV series is in results.
      if (r.type === 'movie' && tvEntries.length) {
        const spacedMovie = expandCamelCaseTitle(r.title);
        const colonIdx = spacedMovie.search(/\s*[:\-–]\s*/);
        if (colonIdx >= 5) {
          const prefixNorm = normTitleMergeKey(spacedMovie.slice(0, colonIdx));
          const subNorm = normTitleMergeKey(spacedMovie.slice(colonIdx));
          const matchingTv = tvEntries.find((tv) => (
            tv.norm === prefixNorm
            && tv.item.year
            && r.year
            && Number(r.year) >= Number(tv.item.year) - 1
            && Number(r.year) <= Number(tv.item.year) + 2
          ));
          const userAskedSub = subNorm.length >= 4 && normQ.includes(subNorm);
          if (matchingTv && !userAskedSub) {
            foldedCompilations.push(r);
            continue;
          }
        }
      }

      primary.push(r);
    }

    if (primary.length > 0) {
      return [...primary, ...deferred];
    }
    return [...foldedCompilations, ...deferred];
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

  async #searchWikidataTitles(query, { limit = 5, year = null, type = 'multi', markAdultHint = false } = {}) {
    const fetchFn = this.fetch || this.fetchImpl || globalThis.fetch;
    if (typeof fetchFn !== 'function') return [];
    let normalized;
    try {
      const mod = await import('./adultFeatureSources.js');
      normalized = mod.normalizeAdultMovieQuery(query);
    } catch {
      normalized = { cleanQuery: String(query || '').trim(), primaryQuery: String(query || '').trim(), fallbackQueries: [String(query || '').trim()], year };
    }
    const queriesToTry = [...new Set([normalized.primaryQuery, ...normalized.fallbackQueries].filter(Boolean))].slice(0, 3);
    if (!queriesToTry.length) return [];

    const qids = [];
    const seenQids = new Set();
    for (const term of queriesToTry) {
      if (qids.length >= 10) break;
      try {
        const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&format=json&limit=8&type=item`;
        const resp = await fetchFn(searchUrl, {
          headers: { 'user-agent': 'LancyBot/2.0 (movie metadata resolver)', accept: 'application/json' },
          signal: AbortSignal.timeout(4500)
        });
        if (!resp?.ok) continue;
        const json = await resp.json();
        for (const item of json?.search || []) {
          if (item?.id && !seenQids.has(item.id)) {
            seenQids.add(item.id);
            qids.push(item.id);
          }
        }
      } catch {
        // ignore transient wikidata search failures
      }
    }
    if (!qids.length) return [];

    const tmdbHits = [];
    const allowMovie = type !== 'tv';
    const allowTv = type !== 'movie';
    try {
      const entitiesUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qids.slice(0, 12).join('|'))}&props=claims|labels&languages=en&format=json`;
      const resp = await fetchFn(entitiesUrl, {
        headers: { 'user-agent': 'LancyBot/2.0 (movie metadata resolver)', accept: 'application/json' },
        signal: AbortSignal.timeout(4500)
      });
      if (!resp?.ok) return [];
      const data = await resp.json();
      const entities = data?.entities || {};
      const seenHits = new Set();
      const wantYear = year || normalized.year || null;

      for (const qid of qids) {
        const ent = entities[qid];
        const tmdbMovieVal = allowMovie ? ent?.claims?.P4947?.[0]?.mainsnak?.datavalue?.value : null;
        const tmdbTvVal = allowTv ? ent?.claims?.P4983?.[0]?.mainsnak?.datavalue?.value : null;
        const imdbVal = ent?.claims?.P345?.[0]?.mainsnak?.datavalue?.value;
        const pubTime = ent?.claims?.P577?.[0]?.mainsnak?.datavalue?.value?.time
          || ent?.claims?.P580?.[0]?.mainsnak?.datavalue?.value?.time
          || '';
        const ym = pubTime.match(/([12]\d{3})/);
        const entYear = ym ? Number(ym[1]) : null;
        const yearDiff = wantYear && entYear ? Math.abs(wantYear - entYear) : 0;

        if (tmdbTvVal) {
          const tid = String(tmdbTvVal).trim();
          if (tid && !seenHits.has(`tv:${tid}`)) {
            seenHits.add(`tv:${tid}`);
            tmdbHits.push({ id: tid, kind: 'tv', label: ent?.labels?.en?.value || '', yearDiff });
          }
        }
        if (tmdbMovieVal) {
          const mid = String(tmdbMovieVal).trim();
          if (mid && !seenHits.has(`movie:${mid}`)) {
            seenHits.add(`movie:${mid}`);
            tmdbHits.push({ id: mid, kind: 'movie', label: ent?.labels?.en?.value || '', yearDiff });
          }
        }
        if (!tmdbTvVal && !tmdbMovieVal && imdbVal && /^tt\d+$/i.test(String(imdbVal).trim())) {
          const iid = String(imdbVal).trim();
          const kind = type === 'tv' ? 'tv' : 'movie';
          if (!seenHits.has(`${kind}:${iid}`)) {
            seenHits.add(`${kind}:${iid}`);
            tmdbHits.push({ id: iid, kind, label: ent?.labels?.en?.value || '', yearDiff });
          }
        }
      }
      tmdbHits.sort((a, b) => a.yearDiff - b.yearDiff);
    } catch {
      return [];
    }

    const hydrated = [];
    for (const hit of tmdbHits.slice(0, limit)) {
      try {
        const item = hit.kind === 'tv'
          ? await this.getTvShow(hit.id)
          : await this.getMovie(hit.id);
        if (item?.id && item?.title) {
          hydrated.push({
            ...item,
            ...(markAdultHint ? { isAdultHint: true } : {}),
            source: item.source || 'wikidata_tmdb'
          });
        }
      } catch {
        // skip unresolvable entries
      }
    }
    return hydrated;
  }

  async search(query, { type = 'multi', year, page = 1, limit = 20, includeAdultFallback = true, expandCatalog = true } = {}) {
    const q = String(query || '').trim();
    if (!q) return { query: '', count: 0, results: [] };

    // Extract optional trailing release year ("Title 2018" or "Title (2018)") so backend search matches exact titles
    const yearSuffixMatch = !year
      ? q.match(/^(.+?)\s+(?:\(((?:19\d{2}|20[0-3]\d))\)|((?:19\d{2}|20[0-3]\d)))$/)
      : null;
    const parsedTitle = yearSuffixMatch ? yearSuffixMatch[1].trim() : q;
    const searchTitle = parsedTitle.length >= 2 ? parsedTitle : q;
    const searchYear = year || (yearSuffixMatch ? Number(yearSuffixMatch[2] || yearSuffixMatch[3]) : undefined);

    const primaryPromise = this.#getJson('/search', { q: searchTitle, type, year: searchYear, page, limit }, { ttlMs: 180_000 })
      .catch(() => null);

    let extCinemeta = [];
    let extImdb = [];
    let extTvMaze = [];
    let extYts = [];
    let extWp = [];
    let extArchive = [];
    if (expandCatalog && page === 1) {
      const extTasks = [
        this.#searchCinemeta(searchTitle, { type, limit: 10 }).then((r) => { extCinemeta = r; }).catch(() => {}),
        this.#searchImdbSuggest(searchTitle, { type, limit: 8 }).then((r) => { extImdb = r; }).catch(() => {}),
        this.#searchWordpressIndexes(searchTitle, { type, limit: 6 }).then((r) => { extWp = r; }).catch(() => {})
      ];
      if (type !== 'tv') {
        extTasks.push(this.#searchYtsMovies(searchTitle, { limit: 8 }).then((r) => { extYts = r; }).catch(() => {}));
      }
      if (type !== 'movie') {
        extTasks.push(this.#searchTvMaze(searchTitle, { limit: 6 }).then((r) => { extTvMaze = r; }).catch(() => {}));
      }
      await Promise.all([primaryPromise, ...extTasks]);
    }

    let data = await primaryPromise;
    let results = (data?.results || []).map((x) => normalizeListItem(x, type === 'tv' ? 'tv' : null)).filter(Boolean);

    // Retry without year filter if strict year parameter yielded zero hits
    if (!results.length && searchYear && searchTitle !== q) {
      const retryData = await this.#getJson('/search', { q: searchTitle, type, page, limit }, { ttlMs: 180_000 }).catch(() => null);
      const retryResults = (retryData?.results || []).map((x) => normalizeListItem(x, type === 'tv' ? 'tv' : null)).filter(Boolean);
      if (retryResults.length) {
        data = retryData;
        results = retryResults;
      }
    }

    // Merge Cinemeta, IMDb Suggestion, TVMaze, YTS & WordPress direct indexes
    if (expandCatalog && page === 1) {
      const externalPool = [...extCinemeta, ...extImdb, ...extYts, ...extTvMaze, ...extWp];
      if (externalPool.length) {
        results = this.#mergeCatalogResults(results, externalPool);
      }
    }

    const qTokens = searchTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
    const hasExactishHit = results.some((item) => {
      const lowTitle = String(item?.title || '').toLowerCase();
      const yearMatches = !searchYear || !item?.year || Math.abs(Number(item.year) - Number(searchYear)) <= 1;
      return yearMatches && qTokens.length > 0 && qTokens.every((t) => lowTitle.includes(t));
    });

    // Wikidata adult/indie TMDB lookup (when includeAdultFallback is enabled)
    if (includeAdultFallback && page === 1 && type !== 'tv' && (!results.length || !hasExactishHit)) {
      const wikidataHits = await this.#searchWikidataTitles(searchTitle, {
        limit: Math.min(5, limit),
        year: searchYear,
        type: 'movie',
        markAdultHint: true
      }).catch(() => []);
      if (wikidataHits.length) {
        results = this.#mergeCatalogResults(results, wikidataHits);
      }
    }

    // Wikidata TV/miniseries TMDB lookup when TV/multi results lack an exactish match
    if (includeAdultFallback && page === 1 && type !== 'movie' && (!results.length || !hasExactishHit)) {
      const wikidataTvHits = await this.#searchWikidataTitles(searchTitle, {
        limit: Math.min(5, limit),
        year: searchYear,
        type: 'tv',
        markAdultHint: false
      }).catch(() => []);
      if (wikidataTvHits.length) {
        results = this.#mergeCatalogResults(results, wikidataTvHits);
      }
    }

    // Internet Archive fallback for classic/public-domain/sparse queries
    if (expandCatalog && page === 1 && type !== 'tv' && (results.length < 3 || (searchYear && searchYear <= 1985))) {
      extArchive = await this.#searchInternetArchive(searchTitle, { limit: 4 }).catch(() => []);
      if (extArchive.length) {
        results = this.#mergeCatalogResults(results, extArchive);
      }
    }

    const normSearch = normTitleMergeKey(expandCamelCaseTitle(searchTitle));
    const targetY = searchYear ? Number(searchYear) : null;
    if (results.length > 1) {
      results.sort((a, b) => {
        const exactA = normTitleMergeKey(expandCamelCaseTitle(a.title)) === normSearch ? 0 : 1;
        const exactB = normTitleMergeKey(expandCamelCaseTitle(b.title)) === normSearch ? 0 : 1;
        if (exactA !== exactB) return exactA - exactB;
        if (targetY) {
          const dyA = a.year ? Math.abs(Number(a.year) - targetY) : 99;
          const dyB = b.year ? Math.abs(Number(b.year) - targetY) : 99;
          const bucketA = dyA === 0 ? 0 : (dyA <= 1 ? 1 : 2);
          const bucketB = dyB === 0 ? 0 : (dyB <= 1 ? 1 : 2);
          if (bucketA !== bucketB) return bucketA - bucketB;
        }
        const holaA = a.tmdbId && /^\d+$/.test(String(a.tmdbId)) ? 0 : 1;
        const holaB = b.tmdbId && /^\d+$/.test(String(b.tmdbId)) ? 0 : 1;
        return holaA - holaB;
      });
    }

    results = this.#consolidateSearchResults(results, q);

    return {
      provider: data?.provider || (results[0]?.provider || 'holaflix'),
      query: data?.query || q,
      count: Number(Math.max(Number(data?.count || 0), results.length)),
      results: results.slice(0, limit)
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

  async browse({ type = 'movie', genreId, category, year, sortBy = 'popularity.desc', page = 1, limit = 20, includeUpcoming = false } = {}) {
    const data = await this.#getJson('/browse', { type, genreId, category, year, sortBy, page, limit }, { ttlMs: 300_000 });
    const rawResults = (data?.results || []).map((x) => normalizeListItem(x, type)).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const released = includeUpcoming
      ? rawResults
      : rawResults.filter((item) => !item.releaseDate || String(item.releaseDate).slice(0, 10) <= today);
    const results = released.length ? released : rawResults;
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

  async #fetchCinemetaMeta(type, imdbId) {
    if (!/^tt\d+$/i.test(String(imdbId || ''))) return null;
    const cType = String(type).toLowerCase() === 'tv' ? 'series' : 'movie';
    const data = await this.#fetchExternalJson(`https://v3-cinemeta.strem.io/meta/${cType}/${encodeURIComponent(imdbId)}.json`, { ttlMs: 900_000 });
    return data?.meta || null;
  }

  async #fetchTvMazeWithEpisodes(idStr) {
    const num = String(idStr || '').replace(/^tvmaze:/i, '').trim();
    if (!/^\d+$/.test(num)) return null;
    return await this.#fetchExternalJson(`https://api.tvmaze.com/shows/${num}?embed=episodes`, { ttlMs: 900_000 });
  }

  async getMovie(id) {
    const idStr = String(id || '').trim();
    const isNumeric = /^\d+$/.test(idStr);
    if (isNumeric) {
      const data = await this.#getJson(`/movie/${encodeURIComponent(idStr)}`, null, { ttlMs: 900_000 }).catch(() => null);
      const base = normalizeListItem(data, 'movie');
      if (base) {
        return {
          ...base,
          runtimeMinutes: Number(data.runtime) || base.runtimeMinutes || null,
          runtimeSeconds: Number(data.runtime) ? Number(data.runtime) * 60 : base.runtimeSeconds || null,
          imdbId: data.imdb_id || data.imdbId || base.imdbId || null,
          cast: Array.isArray(data.cast) ? data.cast.slice(0, 8) : [],
          director: data.director || null,
          language: data.language || data.original_language || base.language || null,
          originalLanguage: data.original_language || data.originalLanguage || base.originalLanguage || null,
          originalTitle: data.original_title || data.originalTitle || base.originalTitle || null,
          genres: Array.isArray(data.genres) ? data.genres : base.genres,
          media: data.media || null
        };
      }
    }
    const cached = this.externalItems.get(`movie:${idStr}`) || this.externalItems.get(idStr) || null;
    if (/^tt\d+$/i.test(idStr)) {
      const meta = await this.#fetchCinemetaMeta('movie', idStr);
      if (meta) {
        const ym = String(meta.releaseInfo || meta.year || '').match(/\d{4}/);
        const rtMin = Number(String(meta.runtime || '').match(/\d+/)?.[0] || 0) || cached?.runtimeMinutes || null;
        const metaLang = firstLangValue(meta.language) || cached?.originalLanguage || cached?.language || null;
        return normalizeListItem({
          ...cached,
          id: idStr,
          imdb_id: idStr,
          type: 'movie',
          title: meta.name || cached?.title || idStr,
          original_title: meta.originalTitle || cached?.originalTitle || null,
          original_language: cached?.originalLanguage || metaLang,
          language: cached?.language || metaLang,
          year: ym ? Number(ym[0]) : cached?.year || null,
          poster: meta.poster || meta.background || cached?.poster || null,
          backdrop: meta.background || cached?.backdrop || null,
          overview: meta.description || cached?.overview || '',
          genres: Array.isArray(meta.genres) ? meta.genres : (cached?.genres || []),
          rating: meta.imdbRating ?? cached?.rating ?? null,
          runtimeMinutes: rtMin,
          runtimeSeconds: rtMin ? rtMin * 60 : null,
          cast: Array.isArray(meta.cast) ? meta.cast : (cached?.cast || []),
          provider: cached?.provider || 'cinemeta',
          sourceProvider: cached?.sourceProvider || 'cinemeta'
        }, 'movie');
      }
    }
    return cached;
  }

  async #findFallbackTvMeta({ idStr = '', imdbId = null, title = '', year = null } = {}) {
    let effImdb = imdbId && /^tt\d+$/i.test(String(imdbId)) ? String(imdbId) : (/^tt\d+$/i.test(String(idStr)) ? String(idStr) : null);
    let cinemeta = effImdb ? await this.#fetchCinemetaMeta('tv', effImdb) : null;
    if (!cinemeta && title) {
      const cmHits = await this.#searchCinemeta(title, { type: 'tv', limit: 6 }).catch(() => []);
      const normT = normTitleMergeKey(title);
      const best = cmHits.find((h) => {
        const nt = normTitleMergeKey(h.title);
        const yOk = !year || !h.year || Math.abs(Number(h.year) - Number(year)) <= 2;
        return yOk && (nt === normT || nt.includes(normT) || normT.includes(nt));
      }) || (year ? null : cmHits.find((h) => normTitleMergeKey(h.title) === normT));
      if (best?.imdbId || (best?.id && /^tt\d+$/i.test(best.id))) {
        effImdb = best.imdbId || best.id;
        cinemeta = await this.#fetchCinemetaMeta('tv', effImdb);
      }
    }
    let tvmaze = null;
    if (/^tvmaze:\d+$/i.test(idStr)) {
      tvmaze = await this.#fetchTvMazeWithEpisodes(idStr);
    } else if (effImdb) {
      const lookup = await this.#fetchExternalJson(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(effImdb)}`, { ttlMs: 900_000 });
      if (lookup?.id) tvmaze = await this.#fetchTvMazeWithEpisodes(`tvmaze:${lookup.id}`);
    }
    if (!tvmaze && title) {
      const candidates = await this.#fetchExternalJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, { ttlMs: 300_000 });
      if (Array.isArray(candidates) && candidates.length) {
        const normT = normTitleMergeKey(title);
        const pick = candidates.map((c) => c?.show).filter(Boolean).find((s) => {
          const nt = normTitleMergeKey(s.name || '');
          const sy = s.premiered ? Number(String(s.premiered).slice(0, 4)) : null;
          const yOk = !year || !sy || Math.abs(sy - Number(year)) <= 2;
          return yOk && (nt === normT || nt.includes(normT) || normT.includes(nt));
        });
        if (pick?.id) tvmaze = await this.#fetchTvMazeWithEpisodes(`tvmaze:${pick.id}`);
      }
    }
    return { cinemeta, tvmaze, imdbId: effImdb || tvmaze?.externals?.imdb || null };
  }

  #mergeTvSeasonsLists(primary = [], secondary = []) {
    const byNum = new Map();
    for (const s of [...primary, ...secondary]) {
      const sn = Number(s?.seasonNumber ?? s?.season_number);
      if (!Number.isFinite(sn) || sn < 0) continue;
      const prev = byNum.get(sn);
      const ec = Number(s?.episodeCount ?? s?.episode_count ?? 0) || 0;
      if (!prev) {
        byNum.set(sn, {
          seasonNumber: sn,
          name: String(s?.name || (sn === 0 ? 'Specials' : `Season ${sn}`)),
          overview: String(s?.overview || '').trim(),
          poster: s?.poster || null,
          airDate: s?.airDate || s?.air_date || null,
          episodeCount: ec
        });
      } else {
        if (ec > prev.episodeCount) prev.episodeCount = ec;
        if (!prev.overview && s?.overview) prev.overview = String(s.overview).trim();
        if (!prev.poster && s?.poster) prev.poster = s.poster;
        if (!prev.airDate && (s?.airDate || s?.air_date)) prev.airDate = s.airDate || s.air_date;
      }
    }
    return normalizeSeasonsList([...byNum.values()]);
  }

  async resolveNumericTmdbInfo({ id = null, imdbId = null, type = 'multi', title = '', year = null } = {}) {
    const idStr = String(id || '').trim();
    if (/^\d+$/.test(idStr)) {
      return {
        tmdbId: idStr,
        imdbId: /^tt\d+$/i.test(String(imdbId || '')) ? String(imdbId) : null,
        franchiseTmdbId: null,
        franchiseTitle: null,
        franchiseSeasonNumber: null,
        franchiseSeasonName: null
      };
    }

    const wantType = String(type || 'multi').toLowerCase() === 'tv'
      ? 'tv'
      : (String(type || 'multi').toLowerCase() === 'movie' ? 'movie' : 'multi');
    const cached = (idStr && (this.externalItems.get(`${wantType === 'multi' ? 'tv' : wantType}:${idStr}`) || this.externalItems.get(idStr))) || null;
    if (cached && (cached.tmdbId || cached.franchiseTmdbId)) {
      return {
        tmdbId: cached.tmdbId || cached.franchiseTmdbId || null,
        imdbId: cached.imdbId || (/^tt\d+$/i.test(idStr) ? idStr : imdbId) || null,
        franchiseTmdbId: cached.franchiseTmdbId || null,
        franchiseTitle: cached.franchiseTitle || null,
        franchiseSeasonNumber: cached.franchiseSeasonNumber ?? null,
        franchiseSeasonName: cached.franchiseSeasonName || null
      };
    }

    const effImdb = /^tt\d+$/i.test(String(imdbId || ''))
      ? String(imdbId)
      : (/^tt\d+$/i.test(idStr) ? idStr : (cached?.imdbId || null));
    const effTitle = String(title || cached?.title || '').trim();
    const effYear = year ?? cached?.year ?? null;
    const cacheKey = `${wantType}:${effImdb || idStr || normTitleMergeKey(expandCamelCaseTitle(effTitle))}:${effYear || ''}`;
    const hit = this.tmdbMappingCache.get(cacheKey);
    if (hit) return hit;

    const empty = {
      tmdbId: null,
      imdbId: effImdb,
      franchiseTmdbId: null,
      franchiseTitle: null,
      franchiseSeasonNumber: null,
      franchiseSeasonName: null
    };
    const saveAndReturn = (mapping) => {
      this.tmdbMappingCache.set(cacheKey, mapping, 900_000);
      if (cached && mapping?.tmdbId) {
        if (!cached.tmdbId) cached.tmdbId = mapping.tmdbId;
        if (mapping.franchiseTmdbId) {
          cached.franchiseTmdbId = mapping.franchiseTmdbId;
          cached.franchiseTitle = mapping.franchiseTitle;
          cached.franchiseSeasonNumber = mapping.franchiseSeasonNumber;
          cached.franchiseSeasonName = mapping.franchiseSeasonName;
        }
      }
      return mapping;
    };

    const spacedTitle = expandCamelCaseTitle(effTitle);
    const normTarget = normTitleMergeKey(spacedTitle);

    // 1. Primary HolaFlix TMDB catalog lookup (handles standalone entries AND franchise seasons like Power Rangers -> Dino Thunder S12)
    if (spacedTitle && normTarget) {
      const searchTerms = spacedTitle !== effTitle ? [spacedTitle, effTitle] : [spacedTitle];
      const candidates = [];
      for (const term of searchTerms) {
        const sData = await this.#getJson('/search', {
          q: term,
          type: wantType === 'multi' ? undefined : wantType,
          page: 1,
          limit: 12
        }, { ttlMs: 180_000 }).catch(() => null);
        for (const raw of (sData?.results || [])) {
          const item = normalizeListItem(raw, wantType === 'tv' ? 'tv' : null);
          if (item && /^\d+$/.test(String(item.id))) candidates.push(item);
        }
        if (candidates.length) break;
      }

      // Direct exact match
      const directMatch = candidates.find((c) => {
        if (wantType !== 'multi' && c.type !== wantType) return false;
        if (normTitleMergeKey(expandCamelCaseTitle(c.title)) !== normTarget) return false;
        if (effYear && c.year && Math.abs(Number(c.year) - Number(effYear)) > 1) return false;
        return true;
      });
      if (directMatch) {
        return saveAndReturn({
          ...empty,
          tmdbId: String(directMatch.id),
          imdbId: effImdb || directMatch.imdbId || null
        });
      }

      // Franchise-parent TV show season match (e.g. "Power Rangers" id=2328 Season 12 "Dino Thunder" air_date=2004)
      if (wantType !== 'movie') {
        const prefixParents = candidates.filter((c) => {
          if (c.type !== 'tv') return false;
          const pNorm = normTitleMergeKey(expandCamelCaseTitle(c.title));
          return pNorm.length >= 4 && normTarget.startsWith(pNorm) && normTarget.length > pNorm.length + 2;
        });
        for (const parent of prefixParents.slice(0, 3)) {
          const pNorm = normTitleMergeKey(expandCamelCaseTitle(parent.title));
          const subNorm = normTarget.slice(pNorm.length);
          const sData = await this.#getJson(`/tv/${encodeURIComponent(parent.id)}/seasons`, null, { ttlMs: 900_000 }).catch(() => null);
          const parentSeasons = normalizeSeasonsList(sData?.seasons);
          const matchedSeason = parentSeasons.find((se) => {
            const sNorm = normTitleMergeKey(expandCamelCaseTitle(se.name));
            if (!sNorm || sNorm === `season${se.seasonNumber}`) return false;
            const nameMatch = sNorm === subNorm || sNorm.includes(subNorm) || subNorm.includes(sNorm);
            if (!nameMatch) return false;
            const sy = se.airDate ? Number(String(se.airDate).slice(0, 4)) || null : null;
            if (effYear && sy && Math.abs(sy - Number(effYear)) > 2) return false;
            return true;
          });
          if (matchedSeason) {
            return saveAndReturn({
              ...empty,
              tmdbId: String(parent.id),
              franchiseTmdbId: String(parent.id),
              franchiseTitle: String(parent.title),
              franchiseSeasonNumber: Number(matchedSeason.seasonNumber),
              franchiseSeasonName: String(matchedSeason.name || spacedTitle)
            });
          }
        }
      }
    }

    // 2. Wikidata IMDb -> TMDB claim fallback, validated against HolaFlix so deleted TMDB IDs (e.g. 139440) are skipped
    if (effImdb && typeof this.fetch === 'function') {
      try {
        const srUrl = `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P345=${effImdb}`)}&srlimit=3&format=json`;
        const sr = await this.#fetchExternalJson(srUrl, {
          ttlMs: 900_000,
          headers: { 'user-agent': 'LancyBot/2.0 (movie metadata resolver)' },
          timeoutMs: 4000
        });
        const qids = (sr?.query?.search || []).map((x) => x?.title).filter((t) => /^Q\d+$/i.test(String(t || '')));
        if (qids.length) {
          const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qids.join('|'))}&props=claims&format=json`;
          const entRes = await this.#fetchExternalJson(entUrl, {
            ttlMs: 900_000,
            headers: { 'user-agent': 'LancyBot/2.0 (movie metadata resolver)' },
            timeoutMs: 4000
          });
          for (const qid of qids) {
            const claims = entRes?.entities?.[qid]?.claims || {};
            const candMovie = wantType !== 'tv' ? claims.P4947?.[0]?.mainsnak?.datavalue?.value : null;
            const candTv = wantType !== 'movie' ? claims.P4983?.[0]?.mainsnak?.datavalue?.value : null;
            const candId = candTv || candMovie;
            const candType = candTv ? 'tv' : 'movie';
            if (candId && /^\d+$/.test(String(candId))) {
              const checkPath = candType === 'tv' ? `/tv/${encodeURIComponent(candId)}` : `/movie/${encodeURIComponent(candId)}`;
              const verified = await this.#getJson(checkPath, null, { ttlMs: 900_000 }).catch(() => null);
              if (verified && (verified.id || verified.provider_id || verified.title || verified.name)) {
                return saveAndReturn({ ...empty, tmdbId: String(candId) });
              }
            }
          }
        }
      } catch {}
    }

    return saveAndReturn(empty);
  }

  async getTvShow(id) {
    const idStr = String(id || '').trim();
    const isNumeric = /^\d+$/.test(idStr);
    const cached = this.externalItems.get(`tv:${idStr}`) || this.externalItems.get(idStr) || null;
    if (isNumeric) {
      const data = await this.#getJson(`/tv/${encodeURIComponent(idStr)}`, null, { ttlMs: 900_000 }).catch(() => null);
      const base = normalizeListItem(data, 'tv');
      if (base) {
        let seasons = normalizeSeasonsList(data.seasons);
        let resolvedImdb = data.imdb_id || data.imdbId || base.imdbId || cached?.imdbId || null;
        let totalEpisodes = Number(data.total_episodes) || null;
        let overview = base.overview || '';
        let year = base.year || cached?.year || null;
        let poster = base.poster || cached?.poster || null;
        let rating = base.rating ?? cached?.rating ?? null;
        let genres = Array.isArray(data.genres) && data.genres.length ? data.genres : (base.genres?.length ? base.genres : (cached?.genres || []));
        let runtimeMinutes = base.runtimeMinutes || cached?.runtimeMinutes || null;
        let tvmazeId = cached?.tvmazeId || null;

        if (!seasons.length || !resolvedImdb || seasons.some((s) => s.episodeCount <= 0)) {
          const fb = await this.#findFallbackTvMeta({
            idStr,
            imdbId: resolvedImdb,
            title: base.title,
            year
          }).catch(() => null);
          if (fb?.imdbId && !resolvedImdb) resolvedImdb = fb.imdbId;
          if (fb?.tvmaze?.id) tvmazeId = fb.tvmaze.id;
          const fbSeasons = [];
          if (fb?.cinemeta) {
            const videos = Array.isArray(fb.cinemeta.videos) ? fb.cinemeta.videos : [];
            const bySeason = new Map();
            for (const v of videos) {
              const sn = v.season == null ? 1 : Number(v.season);
              if (Number.isFinite(sn)) bySeason.set(sn, (bySeason.get(sn) || 0) + 1);
            }
            for (const [sn, count] of bySeason.entries()) {
              fbSeasons.push({ seasonNumber: sn, name: sn === 0 ? 'Specials' : `Season ${sn}`, episodeCount: count, poster: fb.cinemeta.poster || null });
            }
            if (!overview && fb.cinemeta.description) overview = fb.cinemeta.description;
            if (!poster && (fb.cinemeta.poster || fb.cinemeta.background)) poster = fb.cinemeta.poster || fb.cinemeta.background;
            if (!year) {
              const ym = String(fb.cinemeta.releaseInfo || fb.cinemeta.year || '').match(/\d{4}/);
              if (ym) year = Number(ym[0]);
            }
            if (!rating && fb.cinemeta.imdbRating) rating = Number(fb.cinemeta.imdbRating) || rating;
            if (!genres?.length && Array.isArray(fb.cinemeta.genres)) genres = fb.cinemeta.genres;
            if (!runtimeMinutes) runtimeMinutes = parseArchiveRuntimeMinutes(fb.cinemeta.runtime) || runtimeMinutes;
          }
          if (fb?.tvmaze?._embedded?.episodes?.length) {
            const bySeason = new Map();
            for (const ep of fb.tvmaze._embedded.episodes) {
              const sn = ep.season == null ? 1 : Number(ep.season);
              if (Number.isFinite(sn)) bySeason.set(sn, (bySeason.get(sn) || 0) + 1);
            }
            for (const [sn, count] of bySeason.entries()) {
              fbSeasons.push({ seasonNumber: sn, name: sn === 0 ? 'Specials' : `Season ${sn}`, episodeCount: count, poster: fb.tvmaze.image?.original || null });
            }
            if (!overview && fb.tvmaze.summary) overview = stripHtml(fb.tvmaze.summary);
            if (!poster && fb.tvmaze.image?.original) poster = fb.tvmaze.image.original;
            if (!year && fb.tvmaze.premiered) year = Number(String(fb.tvmaze.premiered).slice(0, 4)) || year;
            if (!runtimeMinutes && (fb.tvmaze.runtime || fb.tvmaze.averageRuntime)) runtimeMinutes = Number(fb.tvmaze.runtime || fb.tvmaze.averageRuntime);
          }
          if (fbSeasons.length) {
            seasons = this.#mergeTvSeasonsLists(seasons, fbSeasons);
            const sumEps = seasons.filter((s) => s.seasonNumber > 0).reduce((acc, s) => acc + (s.episodeCount || 0), 0);
            if (sumEps > (totalEpisodes || 0)) totalEpisodes = sumEps;
          }
        }
        const outShow = {
          ...base,
          year,
          poster,
          overview,
          rating,
          genres,
          runtimeMinutes,
          runtimeSeconds: runtimeMinutes ? runtimeMinutes * 60 : base.runtimeSeconds || null,
          totalSeasons: Math.max(Number(data.total_seasons ?? 0) || 0, seasons.filter((s) => s.seasonNumber > 0).length) || seasons.length,
          totalEpisodes,
          status: data.status || null,
          imdbId: resolvedImdb,
          tvmazeId,
          language: data.language || data.original_language || base.language || null,
          originalLanguage: data.original_language || data.originalLanguage || base.originalLanguage || null,
          originalTitle: data.original_title || data.originalTitle || base.originalTitle || null,
          cast: Array.isArray(data.cast) ? data.cast.slice(0, 8) : [],
          seasons
        };
        this.#rememberExternalItem(outShow);
        return outShow;
      }
    }

    if (/^tt\d+$/i.test(idStr)) {
      const meta = await this.#fetchCinemetaMeta('tv', idStr);
      if (meta) {
        const videos = Array.isArray(meta.videos) ? meta.videos : [];
        const bySeason = new Map();
        for (const v of videos) {
          const sn = v.season == null ? 1 : Number(v.season);
          if (!Number.isFinite(sn)) continue;
          bySeason.set(sn, (bySeason.get(sn) || 0) + 1);
        }
        let seasons = normalizeSeasonsList([...bySeason.entries()].map(([sn, count]) => ({
          season_number: sn,
          name: sn === 0 ? 'Specials' : `Season ${sn}`,
          episode_count: count,
          poster: meta.poster || null
        })));
        const ym = String(meta.releaseInfo || meta.year || '').match(/\d{4}/);
        const effYear = ym ? Number(ym[0]) : cached?.year || null;
        const effTitle = meta.name || cached?.title || idStr;
        const tmdbMap = await this.resolveNumericTmdbInfo({
          id: idStr,
          imdbId: idStr,
          type: 'tv',
          title: effTitle,
          year: effYear
        }).catch(() => null);
        let mappedTotalEps = videos.length || null;
        let franchiseSeasonsCount = null;
        if (tmdbMap?.franchiseTmdbId && tmdbMap?.franchiseSeasonNumber != null) {
          const frSeason = await this.#getJson(
            `/tv/${encodeURIComponent(tmdbMap.franchiseTmdbId)}/season/${Number(tmdbMap.franchiseSeasonNumber)}`,
            null,
            { ttlMs: 900_000 }
          ).catch(() => null);
          const frCount = Number(frSeason?.episode_count ?? frSeason?.episodes?.length ?? 0) || 0;
          if (frCount > 0) {
            mappedTotalEps = Math.max(mappedTotalEps || 0, frCount);
            const s1 = seasons.find((s) => Number(s.seasonNumber) === 1);
            if (s1) {
              if (frCount > s1.episodeCount) s1.episodeCount = frCount;
              if (frSeason?.name) s1.name = frSeason.name;
            } else {
              seasons = normalizeSeasonsList([
                ...seasons,
                {
                  season_number: 1,
                  name: frSeason?.name || effTitle,
                  episode_count: frCount,
                  poster: frSeason?.poster || meta.poster || null
                }
              ]);
            }
          }
          franchiseSeasonsCount = seasons.filter((s) => s.seasonNumber > 0).length || 1;
        } else if (tmdbMap?.tmdbId && /^\d+$/.test(String(tmdbMap.tmdbId))) {
          const tmdbSeasonsRes = await this.#getJson(`/tv/${encodeURIComponent(tmdbMap.tmdbId)}/seasons`, null, { ttlMs: 900_000 }).catch(() => null);
          const tmdbSeasons = normalizeSeasonsList(tmdbSeasonsRes?.seasons);
          if (tmdbSeasons.length) {
            seasons = this.#mergeTvSeasonsLists(tmdbSeasons, seasons);
            const sumEps = seasons.filter((s) => s.seasonNumber > 0).reduce((acc, s) => acc + (s.episodeCount || 0), 0);
            if (sumEps > (mappedTotalEps || 0)) mappedTotalEps = sumEps;
          }
        }
        const rtMin = parseArchiveRuntimeMinutes(meta.runtime) || cached?.runtimeMinutes || null;
        const metaLang = firstLangValue(meta.language) || cached?.originalLanguage || cached?.language || null;
        const outShow = {
          ...normalizeListItem({
            ...cached,
            id: idStr,
            imdb_id: idStr,
            tmdb_id: tmdbMap?.tmdbId || cached?.tmdbId || null,
            type: 'tv',
            title: effTitle,
            original_title: meta.originalTitle || cached?.originalTitle || null,
            original_language: cached?.originalLanguage || metaLang,
            language: cached?.language || metaLang,
            year: effYear,
            poster: meta.poster || meta.background || cached?.poster || null,
            backdrop: meta.background || cached?.backdrop || null,
            overview: meta.description || cached?.overview || '',
            genres: Array.isArray(meta.genres) ? meta.genres : (cached?.genres || []),
            rating: meta.imdbRating ?? cached?.rating ?? null,
            runtimeMinutes: rtMin,
            runtimeSeconds: rtMin ? rtMin * 60 : null,
            cast: Array.isArray(meta.cast) ? meta.cast : (cached?.cast || []),
            provider: cached?.provider || 'cinemeta'
          }, 'tv'),
          franchiseTmdbId: tmdbMap?.franchiseTmdbId || null,
          franchiseTitle: tmdbMap?.franchiseTitle || null,
          franchiseSeasonNumber: tmdbMap?.franchiseSeasonNumber ?? null,
          franchiseSeasonName: tmdbMap?.franchiseSeasonName || null,
          totalSeasons: franchiseSeasonsCount || (seasons.filter((s) => s.seasonNumber > 0).length || seasons.length),
          totalEpisodes: mappedTotalEps,
          seasons
        };
        this.#rememberExternalItem(outShow);
        return outShow;
      }
    }

    if (/^tvmaze:\d+$/i.test(idStr)) {
      const show = await this.#fetchTvMazeWithEpisodes(idStr);
      if (show?.id) {
        const eps = Array.isArray(show._embedded?.episodes) ? show._embedded.episodes : [];
        const bySeason = new Map();
        for (const ep of eps) {
          const sn = ep.season == null ? 1 : Number(ep.season);
          bySeason.set(sn, (bySeason.get(sn) || 0) + 1);
        }
        const seasons = normalizeSeasonsList([...bySeason.entries()].map(([sn, count]) => ({
          season_number: sn,
          name: sn === 0 ? 'Specials' : `Season ${sn}`,
          episode_count: count,
          poster: show.image?.original || show.image?.medium || null
        })));
        const outShow = {
          ...normalizeListItem({
            ...cached,
            id: show.externals?.imdb || idStr,
            imdb_id: show.externals?.imdb || null,
            tvmazeId: show.id,
            type: 'tv',
            title: show.name,
            year: show.premiered ? Number(String(show.premiered).slice(0, 4)) || null : null,
            poster: show.image?.original || show.image?.medium || cached?.poster || null,
            overview: stripHtml(show.summary || '') || cached?.overview || '',
            genres: Array.isArray(show.genres) ? show.genres : [],
            rating: show.rating?.average ?? null,
            runtimeMinutes: show.runtime || show.averageRuntime || null,
            provider: 'tvmaze'
          }, 'tv'),
          totalSeasons: seasons.filter((s) => s.seasonNumber > 0).length || seasons.length,
          totalEpisodes: eps.length || null,
          seasons
        };
        this.#rememberExternalItem(outShow);
        return outShow;
      }
    }

    if (cached) {
      const fb = await this.#findFallbackTvMeta({ idStr, imdbId: cached.imdbId, title: cached.title, year: cached.year }).catch(() => null);
      const fbSeasons = [];
      if (fb?.cinemeta?.videos?.length) {
        const byS = new Map();
        for (const v of fb.cinemeta.videos) {
          const sn = v.season == null ? 1 : Number(v.season);
          if (Number.isFinite(sn)) byS.set(sn, (byS.get(sn) || 0) + 1);
        }
        for (const [sn, count] of byS.entries()) fbSeasons.push({ seasonNumber: sn, name: sn === 0 ? 'Specials' : `Season ${sn}`, episodeCount: count });
      }
      const seasons = fbSeasons.length
        ? normalizeSeasonsList(fbSeasons)
        : [{ seasonNumber: 1, name: 'Season 1', overview: '', poster: cached.poster || null, airDate: null, episodeCount: 1 }];
      return {
        ...cached,
        imdbId: cached.imdbId || fb?.imdbId || null,
        tvmazeId: cached.tvmazeId || fb?.tvmaze?.id || null,
        totalSeasons: seasons.filter((s) => s.seasonNumber > 0).length || seasons.length,
        totalEpisodes: seasons.reduce((a, s) => a + (s.episodeCount || 0), 0) || 1,
        seasons
      };
    }
    return null;
  }

  async getTvSeasons(id) {
    const idStr = String(id || '').trim();
    let apiSeasons = [];
    let apiData = null;
    if (/^\d+$/.test(idStr)) {
      apiData = await this.#getJson(`/tv/${encodeURIComponent(idStr)}/seasons`, null, { ttlMs: 900_000 }).catch(() => null);
      if (apiData) {
        apiSeasons = normalizeSeasonsList(apiData?.seasons);
        if (apiSeasons.length >= 2 && apiSeasons.every((s) => s.episodeCount > 0)) {
          return {
            seriesId: String(apiData?.series_id ?? idStr),
            title: String(apiData?.title || 'TV Series'),
            totalSeasons: Number(apiData?.total_seasons ?? apiSeasons.filter((s) => s.seasonNumber > 0).length) || apiSeasons.length,
            totalEpisodes: Number(apiData?.total_episodes) || null,
            seasons: apiSeasons
          };
        }
      }
    }
    const show = await this.getTvShow(idStr);
    let seasons = this.#mergeTvSeasonsLists(apiSeasons, Array.isArray(show?.seasons) ? show.seasons : []);
    if (!seasons.length && /^\d+$/.test(idStr)) {
      // Bounded probe for season 1..4 when upstream index omits season manifest
      const probeRes = await Promise.allSettled([1, 2, 3, 4].map((sn) =>
        this.#getJson(`/tv/${encodeURIComponent(idStr)}/season/${sn}`, null, { ttlMs: 900_000 })
      ));
      const probed = [];
      probeRes.forEach((r, idx) => {
        if (r.status === 'fulfilled' && Array.isArray(r.value?.episodes) && r.value.episodes.length) {
          probed.push({
            seasonNumber: idx + 1,
            name: r.value?.name || `Season ${idx + 1}`,
            episodeCount: r.value.episodes.length,
            poster: r.value?.poster || show?.poster || null
          });
        }
      });
      seasons = normalizeSeasonsList(probed);
    }
    if (!seasons.length) {
      seasons = [{ seasonNumber: 1, name: 'Season 1', overview: '', poster: show?.poster || null, airDate: null, episodeCount: 1 }];
    }
    return {
      seriesId: String(apiData?.series_id ?? idStr),
      title: String(apiData?.title || show?.title || 'TV Series'),
      totalSeasons: Math.max(Number(apiData?.total_seasons || 0), Number(show?.totalSeasons || 0), seasons.filter((s) => s.seasonNumber > 0).length) || seasons.length,
      totalEpisodes: Number(apiData?.total_episodes || 0) || show?.totalEpisodes || null,
      seasons
    };
  }

  async getTvSeasonEpisodes(id, seasonNumber = 1) {
    const idStr = String(id || '').trim();
    const sNum = (seasonNumber === undefined || seasonNumber === null || seasonNumber === '')
      ? 1
      : Math.max(0, Number(seasonNumber) || 0);
    const cached = this.externalItems.get(`tv:${idStr}`) || this.externalItems.get(idStr) || null;
    const isNumeric = /^\d+$/.test(idStr);

    let apiData = null;
    let apiEpisodes = [];
    if (isNumeric) {
      apiData = await this.#getJson(`/tv/${encodeURIComponent(idStr)}/season/${sNum}`, null, { ttlMs: 900_000 }).catch(() => null);
      if (apiData && Array.isArray(apiData?.episodes)) {
        apiEpisodes = apiData.episodes.map((ep) => ({
          seriesId: String(ep.series_id ?? idStr),
          seasonNumber: Number(ep.season_number ?? sNum),
          episodeNumber: Number(ep.episode_number ?? 1),
          title: String(ep.title || ep.name || `Episode ${ep.episode_number ?? ''}`).trim(),
          overview: String(ep.overview || '').trim(),
          airDate: ep.air_date || null,
          runtimeMinutes: Number(ep.runtime) || null,
          runtimeSeconds: Number(ep.runtime) ? Number(ep.runtime) * 60 : null,
          still: ep.still || ep.still_path || apiData?.poster || null
        }));
      }
    } else if (/^(?:tt\d+|tvmaze:\d+)$/i.test(idStr) || cached?.title) {
      const tmdbMap = (cached?.tmdbId || cached?.franchiseTmdbId)
        ? {
            tmdbId: cached.tmdbId || cached.franchiseTmdbId,
            franchiseTmdbId: cached.franchiseTmdbId || null,
            franchiseSeasonNumber: cached.franchiseSeasonNumber ?? null
          }
        : await this.resolveNumericTmdbInfo({
            id: idStr,
            imdbId: /^tt\d+$/i.test(idStr) ? idStr : cached?.imdbId,
            type: 'tv',
            title: cached?.title || '',
            year: cached?.year || null
          }).catch(() => null);
      const fetchShowId = tmdbMap?.franchiseTmdbId || tmdbMap?.tmdbId || null;
      const fetchSeason = tmdbMap?.franchiseTmdbId
        ? (sNum === 1 ? tmdbMap.franchiseSeasonNumber : null)
        : sNum;
      if (fetchShowId && fetchSeason != null) {
        apiData = await this.#getJson(`/tv/${encodeURIComponent(fetchShowId)}/season/${fetchSeason}`, null, { ttlMs: 900_000 }).catch(() => null);
        if (apiData && Array.isArray(apiData?.episodes)) {
          apiEpisodes = apiData.episodes.map((ep) => ({
            seriesId: idStr,
            seasonNumber: sNum,
            episodeNumber: Number(ep.episode_number ?? 1),
            title: String(ep.title || ep.name || `Episode ${ep.episode_number ?? ''}`).trim(),
            overview: String(ep.overview || '').trim(),
            airDate: ep.air_date || null,
            runtimeMinutes: Number(ep.runtime) || null,
            runtimeSeconds: Number(ep.runtime) ? Number(ep.runtime) * 60 : null,
            still: ep.still || ep.still_path || apiData?.poster || null
          }));
        }
      }
    }

    let fbEpisodes = [];
    let fbOverview = '';
    let fbPoster = null;
    const needFallback = !apiEpisodes.length || (isNumeric && (apiEpisodes.length <= 4 || apiEpisodes.some((ep) => !ep.runtimeMinutes)));
    if (/^tt\d+$/i.test(idStr) || /^tvmaze:\d+$/i.test(idStr) || needFallback) {
      const imdbHint = /^tt\d+$/i.test(idStr) ? idStr : (cached?.imdbId || null);
      let showTitle = cached?.title || apiData?.title || '';
      let showYear = cached?.year || null;
      let effImdb = imdbHint;
      let effTvMaze = cached?.tvmazeId || (/^tvmaze:\d+$/i.test(idStr) ? idStr.replace(/^tvmaze:/i, '') : null);
      if (isNumeric && !effImdb && !showTitle) {
        const show = await this.getTvShow(idStr).catch(() => null);
        if (show) {
          effImdb = show.imdbId || null;
          showTitle = show.title || '';
          showYear = show.year || null;
          effTvMaze = show.tvmazeId || null;
        }
      }
      if (effImdb) {
        const meta = await this.#fetchCinemetaMeta('tv', effImdb);
        if (meta && Array.isArray(meta.videos)) {
          const showRtMin = parseArchiveRuntimeMinutes(meta.runtime) || cached?.runtimeMinutes || null;
          fbOverview = String(meta.description || '').trim();
          fbPoster = meta.poster || null;
          fbEpisodes = meta.videos
            .filter((v) => (v.season == null ? 1 : Number(v.season)) === sNum)
            .map((v, idx) => ({
              seriesId: idStr,
              seasonNumber: sNum,
              episodeNumber: Number(v.episode ?? v.number ?? (idx + 1)),
              title: String(v.name || v.title || `Episode ${v.episode ?? (idx + 1)}`).trim(),
              overview: String(v.overview || v.description || '').trim(),
              airDate: v.released ? String(v.released).slice(0, 10) : null,
              runtimeMinutes: showRtMin,
              runtimeSeconds: showRtMin ? showRtMin * 60 : null,
              still: v.thumbnail || meta.poster || null
            }));
        }
      }
      if ((!fbEpisodes.length || !apiEpisodes.length) && (effTvMaze || showTitle)) {
        let tmShow = effTvMaze ? await this.#fetchTvMazeWithEpisodes(`tvmaze:${effTvMaze}`) : null;
        if (!tmShow && !/^tvmaze:\d+$/i.test(idStr) && showTitle) {
          const fb = await this.#findFallbackTvMeta({ idStr, imdbId: effImdb, title: showTitle, year: showYear }).catch(() => null);
          tmShow = fb?.tvmaze || null;
        }
        const tmEps = (tmShow?._embedded?.episodes || []).filter((ep) => (ep.season == null ? 1 : Number(ep.season)) === sNum);
        if (tmEps.length > fbEpisodes.length) {
          if (!fbOverview) fbOverview = stripHtml(tmShow?.summary || '');
          if (!fbPoster) fbPoster = tmShow?.image?.original || null;
          fbEpisodes = tmEps.map((ep) => {
            const rt = Number(ep.runtime || tmShow?.runtime || tmShow?.averageRuntime) || null;
            return {
              seriesId: idStr,
              seasonNumber: sNum,
              episodeNumber: Number(ep.number ?? 1),
              title: String(ep.name || `Episode ${ep.number ?? 1}`).trim(),
              overview: stripHtml(ep.summary || ''),
              airDate: ep.airdate || null,
              runtimeMinutes: rt,
              runtimeSeconds: rt ? rt * 60 : null,
              still: ep.image?.original || ep.image?.medium || tmShow?.image?.original || null
            };
          });
        }
      }
    }

    if (apiEpisodes.length || fbEpisodes.length) {
      const byEp = new Map();
      for (const ep of fbEpisodes) byEp.set(ep.episodeNumber, ep);
      for (const ep of apiEpisodes) {
        const prev = byEp.get(ep.episodeNumber);
        if (!prev) {
          byEp.set(ep.episodeNumber, ep);
        } else {
          byEp.set(ep.episodeNumber, {
            ...prev,
            ...ep,
            title: (!/^episode\s*\d+$/i.test(ep.title) ? ep.title : (prev.title || ep.title)),
            overview: ep.overview || prev.overview || '',
            runtimeMinutes: ep.runtimeMinutes || prev.runtimeMinutes || null,
            runtimeSeconds: ep.runtimeSeconds || prev.runtimeSeconds || null,
            still: ep.still || prev.still || null
          });
        }
      }
      const merged = [...byEp.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
      return {
        seriesId: String(apiData?.series_id ?? idStr),
        seasonNumber: Number(apiData?.season_number ?? sNum),
        name: String(apiData?.name || (sNum === 0 ? 'Specials' : `Season ${sNum}`)),
        overview: String(apiData?.overview || fbOverview || '').trim(),
        poster: apiData?.poster || fbPoster || null,
        airDate: apiData?.air_date || merged[0]?.airDate || null,
        episodeCount: Math.max(Number(apiData?.episode_count ?? 0), merged.length),
        episodes: merged
      };
    }

    return {
      seriesId: idStr,
      seasonNumber: sNum,
      name: sNum === 0 ? 'Specials' : `Season ${sNum}`,
      overview: '',
      poster: null,
      airDate: null,
      episodeCount: 1,
      episodes: [{
        seriesId: idStr,
        seasonNumber: sNum,
        episodeNumber: 1,
        title: 'Episode 1',
        overview: '',
        airDate: null,
        runtimeMinutes: null,
        runtimeSeconds: null,
        still: null
      }]
    };
  }

  async getPlaybackInfo(type, id, { season, episode, title = '', year = null, imdbId = null } = {}) {
    const t = String(type).toLowerCase() === 'tv' ? 'tv' : 'movie';
    const idStr = String(id || '').trim();
    let targetId = /^\d+$/.test(idStr) ? idStr : null;
    let targetSeason = season;
    let tmdbMap = null;
    if (!targetId && idStr) {
      tmdbMap = await this.resolveNumericTmdbInfo({
        id: idStr,
        imdbId,
        type: t,
        title,
        year
      }).catch(() => null);
      if (tmdbMap?.franchiseTmdbId && tmdbMap?.franchiseSeasonNumber != null && t === 'tv' && (season == null || Number(season) === 1)) {
        targetId = String(tmdbMap.franchiseTmdbId);
        targetSeason = Number(tmdbMap.franchiseSeasonNumber);
      } else if (tmdbMap?.tmdbId && /^\d+$/.test(String(tmdbMap.tmdbId))) {
        targetId = String(tmdbMap.tmdbId);
      }
    }
    const isNumeric = Boolean(targetId && /^\d+$/.test(targetId));
    const data = isNumeric
      ? await this.#getJson(`/playback/${encodeURIComponent(targetId)}`, {
        type: t,
        ...(t === 'tv' && targetSeason != null ? { season: targetSeason } : {}),
        ...(t === 'tv' && episode != null ? { episode } : {})
      }, { ttlMs: 120_000 }).catch(() => null)
      : null;
    const safeServers = (Array.isArray(data?.servers) ? data.servers : [])
      .filter((s) => s && s.id !== 'autoembed' && s.url);
    return {
      available: Boolean(data?.available ?? !isNumeric),
      tmdbId: isNumeric ? targetId : null,
      franchiseTmdbId: tmdbMap?.franchiseTmdbId || null,
      franchiseTitle: tmdbMap?.franchiseTitle || null,
      franchiseSeasonNumber: tmdbMap?.franchiseSeasonNumber ?? null,
      franchiseSeasonName: tmdbMap?.franchiseSeasonName || null,
      defaultServer: data?.default_server || safeServers[0]?.id || (isNumeric ? 'cinezo' : 'direct'),
      embedUrl: data?.embed_url || safeServers[0]?.url || null,
      webappPlayerUrl: data?.webapp_player_url
        || (isNumeric
          ? `${this.baseUrl}/player?type=${t}&id=${encodeURIComponent(targetId)}${t === 'tv' && targetSeason != null && episode != null ? `&season=${targetSeason}&episode=${episode}` : ''}`
          : null),
      servers: safeServers,
      qualities: Array.isArray(data?.qualities) ? data.qualities : [],
      subtitles: Array.isArray(data?.subtitles) ? data.subtitles : [],
      originalLanguage: data?.original_language || data?.originalLanguage || null,
      rootStream: data?.root_stream || null,
      viewingUrl: data?.viewing_url || null
    };
  }
}
