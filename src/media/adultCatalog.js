import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';
import {
  normalizeAdultMovieQuery,
  scoreAdultTitleMatch,
  searchFullXCinema,
  resolveFullXCinemaStream,
  listPandaTaxonomies,
  searchPandaMovies,
  resolvePandaMoviesStream,
  searchXHamster,
  resolveXHamsterStream,
  searchPornTrex,
  resolvePornTrexStream,
  probeReachableStreamUrl
} from './adultFeatureSources.js';

const log = logger().child({ module: 'adult-catalog' });

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCKED_NSFW_PATTERN = /\b(loli|lolicon|shota|shotacon|underage|child|children|minor|minors|preteen|pedo|pedophile|cp|csam|toddler|infant|rape|noncon|forced_sex|bestiality|zoophilia)\b/i;

export function isBlockedAdultText(text = '') {
  return BLOCKED_NSFW_PATTERN.test(String(text || ''));
}

export function parseDurationToSeconds(raw = '') {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  const str = String(raw || '').trim().toLowerCase();
  if (!str) return 0;
  // Format "HH:MM:SS" or "MM:SS"
  const colonMatch = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (colonMatch) {
    const h = Number(colonMatch[1] || 0);
    const m = Number(colonMatch[2] || 0);
    const s = Number(colonMatch[3] || 0);
    return h * 3600 + m * 60 + s;
  }
  let total = 0;
  const hrMatch = str.match(/(\d+)\s*h(?:our|r)?s?/);
  const minMatch = str.match(/(\d+)\s*m(?:in(?:ute)?s?)?/);
  const secMatch = str.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/);
  if (hrMatch) total += Number(hrMatch[1]) * 3600;
  if (minMatch) total += Number(minMatch[1]) * 60;
  if (secMatch) total += Number(secMatch[1]);
  return total;
}

export function formatDurationLabel(seconds = 0, fallback = 'HD') {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  if (!sec) return fallback;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function epornerHexToBase36(hex) {
  let out = '';
  for (let i = 0; i < 32; i += 8) {
    const chunk = parseInt(hex.slice(i, i + 8), 16);
    if (Number.isNaN(chunk)) return '';
    out += chunk.toString(36);
  }
  return out;
}

export const ADULT_CATEGORIES = [
  { id: 'amateur', label: '📸 Amateur', xvSlug: 'amateur', phSlug: 'amateur' },
  { id: 'asian', label: '🌸 Asian', xvSlug: 'asian', phSlug: 'asian' },
  { id: 'ebony', label: '🍫 Ebony', xvSlug: 'ebony', phSlug: 'ebony' },
  { id: 'latina', label: '💃 Latina', xvSlug: 'latina', phSlug: 'latina' },
  { id: 'blonde', label: '👱‍♀️ Blonde', xvSlug: 'blonde', phSlug: 'blonde' },
  { id: 'brunette', label: '👩🏻 Brunette', xvSlug: 'brunette', phSlug: 'brunette' },
  { id: 'redhead', label: '🦊 Redhead', xvSlug: 'redhead', phSlug: 'redhead' },
  { id: 'milf', label: '🍷 MILF', xvSlug: 'milf', phSlug: 'milf' },
  { id: 'big-tits', label: '🍒 Big Tits', xvSlug: 'big-tits', phSlug: 'big-tits' },
  { id: 'big-ass', label: '🍑 Big Ass', xvSlug: 'big-ass', phSlug: 'big-ass' },
  { id: 'babe', label: '💎 Babe', xvSlug: 'babe', phSlug: 'babe' },
  { id: 'pov', label: '👀 POV', xvSlug: 'pov', phSlug: 'pov' },
  { id: 'hardcore', label: '🔥 Hardcore', xvSlug: 'hardcore', phSlug: 'hardcore' },
  { id: 'creampie', label: '💦 Creampie', xvSlug: 'creampie', phSlug: 'creampie' },
  { id: 'blowjob', label: '💋 Blowjob', xvSlug: 'blowjob', phSlug: 'blowjob' },
  { id: 'lesbian', label: '👭 Lesbian', xvSlug: 'lesbian', phSlug: 'lesbian' },
  { id: 'threesome', label: '✨ Threesome', xvSlug: 'threesome', phSlug: 'threesome' },
  { id: 'massage', label: '💆‍♀️ Massage', xvSlug: 'massage', phSlug: 'massage' },
  { id: 'romantic', label: '❤️ Romantic', xvSlug: 'romantic', phSlug: 'romantic' },
  { id: 'interracial', label: '🌍 Interracial', xvSlug: 'interracial', phSlug: 'interracial' },
  { id: 'anal', label: '🍑 Anal', xvSlug: 'anal', phSlug: 'anal' },
  { id: 'squirt', label: '🌊 Squirt', xvSlug: 'squirt', phSlug: 'squirt' },
  { id: 'cosplay', label: '🎭 Cosplay', xvSlug: 'cosplay', phSlug: 'cosplay' },
  { id: 'hentai', label: '🎌 Hentai', xvSlug: 'hentai', phSlug: 'hentai' },
  { id: 'japanese', label: '🗾 Japanese', xvSlug: 'japanese', phSlug: 'japanese' },
  { id: 'indian', label: '🪷 Indian', xvSlug: 'indian', phSlug: 'indian' },
  { id: 'arab', label: '🌙 Arab', xvSlug: 'arab', phSlug: 'arab' },
  { id: 'bbw', label: '🍯 BBW / Curvy', xvSlug: 'bbw', phSlug: 'bbw' },
  { id: 'mature', label: '🥂 Mature', xvSlug: 'mature', phSlug: 'mature' },
  { id: 'college', label: '🎓 College (18+)', xvSlug: 'college', phSlug: 'college' },
  { id: 'public', label: '🏖️ Public / Outdoor', xvSlug: 'public', phSlug: 'public' },
  { id: 'solo-female', label: '🌸 Solo Female', xvSlug: 'solo', phSlug: 'solo-female' },
  { id: 'verified-models', label: '👑 Verified Models', xvSlug: 'pornstar', phSlug: 'verified-models' },
  { id: 'step-fantasy', label: '🏠 Step Fantasy', xvSlug: 'step', phSlug: 'step-fantasy' },
  { id: 'full-movie', label: '🎬 Full Feature Movie', xvSlug: 'full-movie', phSlug: 'hd-porn' },
  { id: 'parody', label: '🏴‍☠️ Parodies & Blockbusters', xvSlug: 'parody', phSlug: 'parody' },
  { id: 'avn-winners', label: '🏆 AVN Feature Winners', xvSlug: 'avn', phSlug: 'pornstar' },
  { id: 'erotic-thriller', label: '🔥 Erotic Indie Cinema', xvSlug: 'erotic', phSlug: 'romantic' },
  { id: 'celebrity-erotic', label: '🎬 Lust & Bellesa Films', xvSlug: 'feature', phSlug: 'hd-porn' },
  { id: 'vr', label: '🥽 VR / 3D', xvSlug: 'vr', phSlug: 'virtual-reality' }
].map((c) => ({ ...c, slug: c.id, query: c.xvSlug || c.id }));

export const FEATURED_ARTISTS = [
  { name: 'Jesse Jane', xvSlug: 'jesse-jane', xvType: 'pornstars', phName: 'Jesse Jane' },
  { name: 'Kira Noir', xvSlug: 'kira-noir', xvType: 'pornstars', phName: 'Kira Noir' },
  { name: 'Kayley Gunner', xvSlug: 'kayley-gunner', xvType: 'pornstars', phName: 'Kayley Gunner' },
  { name: 'Casey Kisses', xvSlug: 'casey-kisses', xvType: 'pornstars', phName: 'Casey Kisses' },
  { name: 'Belladonna', xvSlug: 'belladonna', xvType: 'pornstars', phName: 'Belladonna' },
  { name: 'Stoya', xvSlug: 'stoya', xvType: 'pornstars', phName: 'Stoya' },
  { name: 'Sasha Grey', xvSlug: 'sasha-grey', xvType: 'pornstars', phName: 'Sasha Grey' },
  { name: 'Tori Black', xvSlug: 'tori-black', xvType: 'pornstars', phName: 'Tori Black' },
  { name: 'Katsuni', xvSlug: 'katsuni', xvType: 'pornstars', phName: 'Katsuni' },
  { name: 'Evan Stone', xvSlug: 'evan-stone', xvType: 'pornstars', phName: 'Evan Stone' },
  { name: 'Joanna Angel', xvSlug: 'joanna-angel', xvType: 'pornstars', phName: 'Joanna Angel' },
  { name: 'Casey Calvert', xvSlug: 'casey-calvert', xvType: 'pornstars', phName: 'Casey Calvert' },
  { name: 'Victoria Voxxx', xvSlug: 'victoria-voxxx', xvType: 'pornstars', phName: 'Victoria Voxxx' },
  { name: 'Lilly Bell', xvSlug: 'lilly-bell', xvType: 'pornstars', phName: 'Lilly Bell' },
  { name: 'Lana Rhoades', xvSlug: 'lana-rhoades', xvType: 'pornstars', phName: 'Lana Rhoades' },
  { name: 'Mia Malkova', xvSlug: 'mia-malkova', xvType: 'pornstars', phName: 'Mia Malkova' },
  { name: 'Angela White', xvSlug: 'angela-white', xvType: 'pornstars', phName: 'Angela White' },
  { name: 'Abella Danger', xvSlug: 'abella-danger', xvType: 'pornstars', phName: 'Abella Danger' },
  { name: 'Eva Elfie', xvSlug: 'eva-elfie', xvType: 'pornstars', phName: 'Eva Elfie' },
  { name: 'Violet Myers', xvSlug: 'violet-myers', xvType: 'pornstars', phName: 'Violet Myers' },
  { name: 'Riley Reid', xvSlug: 'riley-reid', xvType: 'pornstars', phName: 'Riley Reid' },
  { name: 'Sweetie Fox', xvSlug: 'sweetie-fox', xvType: 'models', phName: 'Sweetie Fox' },
  { name: 'Gabbie Carter', xvSlug: 'gabbie-carter', xvType: 'pornstars', phName: 'Gabbie Carter' },
  { name: 'Autumn Falls', xvSlug: 'autumn-falls', xvType: 'pornstars', phName: 'Autumn Falls' },
  { name: 'Savannah Bond', xvSlug: 'savannah-bond', xvType: 'pornstars', phName: 'Savannah Bond' },
  { name: 'Emily Willis', xvSlug: 'emily-willis', xvType: 'pornstars', phName: 'Emily Willis' },
  { name: 'Adriana Chechik', xvSlug: 'adriana-chechik', xvType: 'pornstars', phName: 'Adriana Chechik' },
  { name: 'Kendra Sunderland', xvSlug: 'kendra-sunderland', xvType: 'pornstars', phName: 'Kendra Sunderland' },
  { name: 'Valentina Nappi', xvSlug: 'valentina-nappi', xvType: 'pornstars', phName: 'Valentina Nappi' },
  { name: 'Alexis Texas', xvSlug: 'alexis-texas', xvType: 'pornstars', phName: 'Alexis Texas' },
  { name: 'Skye Blue', xvSlug: 'skye-blue', xvType: 'pornstars', phName: 'Skye Blue' },
  { name: 'Stacy Cruz', xvSlug: 'stacy-cruz', xvType: 'pornstars', phName: 'Stacy Cruz' },
  { name: 'Lia Lin', xvSlug: 'lia-lin', xvType: 'pornstars', phName: 'Lia Lin' },
  { name: 'Blake Blossom', xvSlug: 'blake-blossom', xvType: 'pornstars', phName: 'Blake Blossom' },
  { name: 'Melody Marks', xvSlug: 'melody-marks', xvType: 'pornstars', phName: 'Melody Marks' },
  { name: 'Leah Gotti', xvSlug: 'leah-gotti', xvType: 'pornstars', phName: 'Leah Gotti' },
  { name: 'Dillion Harper', xvSlug: 'dillion-harper', xvType: 'pornstars', phName: 'Dillion Harper' },
  { name: 'Brandi Love', xvSlug: 'brandi-love', xvType: 'pornstars', phName: 'Brandi Love' }
];

export const FEATURED_STUDIOS = [
  { name: 'Digital Playground', slug: 'digital-playground' },
  { name: 'Wicked Pictures', slug: 'wicked-pictures' },
  { name: 'Brazzers', slug: 'brazzers' },
  { name: 'Adult Time', slug: 'adult-time' },
  { name: 'Lust Cinema', slug: 'lust-cinema' },
  { name: 'Vixen', slug: 'vixen' },
  { name: 'Blacked', slug: 'blacked' },
  { name: 'Tushy', slug: 'tushy' },
  { name: 'Deeper', slug: 'deeper' },
  { name: 'Vivid', slug: 'vivid' },
  { name: 'Evil Angel', slug: 'evil-angel' },
  { name: 'Pure Taboo', slug: 'pure-taboo' },
  { name: 'Full Moon Features', slug: 'full-moon-features' },
  { name: 'Zero Tolerance', slug: 'zero-tolerance' },
  { name: 'Erika Lust', slug: 'erika-lust' },
  { name: 'Naughty America', slug: 'naughty-america' }
];

export class AdultCatalog {
  constructor({ fetchImpl = null, cacheTtlMs = 10 * 60 * 1000 } = {}) {
    this._customFetch = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.searchCache = new Map();
    this.streamCache = new Map();
    this.inFlight = new Map();
    this.dynamicStarsCache = null;
    this.dynamicStarsAt = 0;
  }

  get fetch() {
    return this._customFetch || globalThis.fetch;
  }

  #getCached(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.cacheTtlMs) {
      map.delete(key);
      return null;
    }
    return entry.data;
  }

  #setCached(map, key, data, maxEntries = 300) {
    if (map.size >= maxEntries) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    map.set(key, { data, at: Date.now() });
    return data;
  }

  getCategories({ page = 0, perPage = 12 } = {}) {
    const total = ADULT_CATEGORIES.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const items = ADULT_CATEGORIES.slice(safePage * perPage, (safePage + 1) * perPage);
    return { items, total, totalPages, page: safePage, perPage };
  }

  async getArtists({ query = '', page = 0, perPage = 12, signal = null } = {}) {
    let pool = [...FEATURED_ARTISTS];
    const cleanQ = String(query || '').trim().toLowerCase();

    // Enrich with PandaMovies cast index (for full-length pornstar filmographies) & XVideos stars index
    if (cleanQ || page > 1) {
      const [xvTask, pmTask] = await Promise.allSettled([
        (!this.dynamicStarsCache || Date.now() - this.dynamicStarsAt > 30 * 60 * 1000)
          ? (async () => {
              const res = await this.fetch('https://www.xvideos.com/pornstars-index', {
                headers: { 'User-Agent': USER_AGENT },
                signal: signal || AbortSignal.timeout(5000)
              });
              if (!res?.ok) return [];
              const html = await res.text();
              const extra = [];
              const seen = new Set(pool.map((p) => p.name.toLowerCase()));
              for (const m of html.matchAll(/href="\/(pornstars|models)\/([^"/?#]+)"[^>]*>([^<]{2,40})</gi)) {
                const xvType = m[1].toLowerCase();
                const xvSlug = m[2].trim();
                const rawName = m[3].replace(/\s+/g, ' ').trim();
                if (!rawName || /^\d+$/.test(rawName) || seen.has(rawName.toLowerCase())) continue;
                seen.add(rawName.toLowerCase());
                extra.push({ name: rawName, xvSlug, xvType, phName: rawName });
                if (extra.length >= 120) break;
              }
              if (extra.length) {
                this.dynamicStarsCache = extra;
                this.dynamicStarsAt = Date.now();
              }
              return extra;
            })()
          : Promise.resolve(this.dynamicStarsCache),
        listPandaTaxonomies('cast', {
          query: cleanQ,
          page: cleanQ ? 0 : Math.max(0, Number(page) || 0),
          perPage: 24,
          fetchImpl: this.fetch,
          signal
        })
      ]);

      const pmStars = pmTask.status === 'fulfilled' && Array.isArray(pmTask.value) ? pmTask.value : [];
      if (pmStars.length) {
        const seen = new Set(pool.map((p) => p.name.toLowerCase()));
        for (const st of pmStars) {
          if (!st?.name || isBlockedAdultText(st.name)) continue;
          const low = st.name.toLowerCase();
          if (seen.has(low)) {
            const existing = pool.find((p) => p.name.toLowerCase() === low);
            if (existing && !existing.movieCount) existing.movieCount = st.count;
            continue;
          }
          seen.add(low);
          pool.push({
            name: st.name,
            xvSlug: st.slug || low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
            xvType: 'pornstars',
            phName: st.name,
            pandaId: st.id,
            movieCount: st.count
          });
        }
      }
      void xvTask;
    }

    if (Array.isArray(this.dynamicStarsCache)) {
      const seen = new Set(pool.map((p) => p.name.toLowerCase()));
      for (const st of this.dynamicStarsCache) {
        if (!seen.has(st.name.toLowerCase())) {
          seen.add(st.name.toLowerCase());
          pool.push(st);
        }
      }
    }

    if (cleanQ) {
      pool = pool.filter((a) => a.name.toLowerCase().includes(cleanQ) || a.xvSlug.toLowerCase().includes(cleanQ));
      if (pool.length === 0 && !isBlockedAdultText(cleanQ)) {
        const slug = cleanQ.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        const titleName = cleanQ.replace(/\b\w/g, (c) => c.toUpperCase());
        pool.push({ name: titleName, xvSlug: slug, xvType: 'pornstars', phName: titleName });
      }
    }

    const total = pool.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const items = pool.slice(safePage * perPage, (safePage + 1) * perPage);
    return { items, total, totalPages, page: safePage, perPage, query: cleanQ };
  }

  async getStudios({ query = '', page = 0, perPage = 12, signal = null } = {}) {
    const cleanQ = String(query || '').trim().toLowerCase();
    const pool = [...FEATURED_STUDIOS];
    const seen = new Set(pool.map((s) => s.name.toLowerCase()));

    try {
      const pmStudios = await listPandaTaxonomies('studios', {
        query: cleanQ,
        page: cleanQ ? 0 : Math.max(0, Number(page) || 0),
        perPage: 24,
        fetchImpl: this.fetch,
        signal
      });
      for (const st of pmStudios || []) {
        if (!st?.name || isBlockedAdultText(st.name)) continue;
        const low = st.name.toLowerCase();
        if (seen.has(low)) {
          const existing = pool.find((p) => p.name.toLowerCase() === low);
          if (existing && !existing.movieCount) existing.movieCount = st.count;
          continue;
        }
        seen.add(low);
        pool.push({
          name: st.name,
          slug: st.slug || low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
          pandaId: st.id,
          movieCount: st.count
        });
      }
    } catch {}

    const filtered = cleanQ
      ? pool.filter((s) => s.name.toLowerCase().includes(cleanQ) || s.slug.toLowerCase().includes(cleanQ))
      : pool;
    const finalPool = filtered.length || !cleanQ
      ? filtered
      : [{ name: cleanQ.replace(/\b\w/g, (c) => c.toUpperCase()), slug: cleanQ.replace(/[^a-z0-9]+/g, '-') }];

    const total = finalPool.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const items = finalPool.slice(safePage * perPage, (safePage + 1) * perPage);
    return { items, total, totalPages, page: safePage, perPage, query: cleanQ };
  }

  /**
   * Unified search across FullXCinema, PandaMovies, Eporner, XVideos, Pornhub, xHamster, PornTrex, or All.
   * By default `lazy: true` for interactive UI so search returns rapidly without blocking on stream scrapes.
   */
  async search({
    source = 'xvideos',
    query = '',
    page = 0,
    limit = 15,
    sort = 'relevance',
    durationFilter = 'all',
    category = null,
    artist = null,
    studio = null,
    minMinutes = 12,
    lazy = true,
    signal = null
  } = {}) {
    const cleanQ = String(query || '').trim();
    if (isBlockedAdultText(cleanQ) || isBlockedAdultText(category) || isBlockedAdultText(artist) || isBlockedAdultText(studio)) {
      return { results: [], total: 0, totalPages: 1, page: 0, blocked: true, source };
    }

    const normSource = String(source || 'xvideos').toLowerCase();
    const isMovieDur = durationFilter === 'movie';
    const effMinMin = isMovieDur ? Math.max(45, Number(minMinutes || 0)) : minMinutes;
    const effDur = isMovieDur ? '20min+' : durationFilter;
    const normObj = normalizeAdultMovieQuery(cleanQ);
    const normQ = normObj.primaryQuery || normObj.cleanQuery || cleanQ;

    if (normSource === 'fullxcinema' || normSource === 'fxc') {
      const fxRes = await searchFullXCinema({ query: normQ, page, limit, isBlocked: isBlockedAdultText, fetchImpl: this.fetch, signal });
      return {
        results: fxRes.results,
        category: 'fullxcinema',
        total: fxRes.results.length,
        totalPages: fxRes.totalPages || 1,
        page,
        source: 'FullXCinema'
      };
    }
    if (normSource === 'pandamovies' || normSource === 'panda') {
      const pmRes = await searchPandaMovies({
        query: normQ,
        page,
        limit,
        artist,
        studio: studio || null,
        isBlocked: isBlockedAdultText,
        fetchImpl: this.fetch,
        signal
      });
      return {
        results: pmRes.results,
        category: 'pandamovies',
        total: pmRes.results.length,
        totalPages: pmRes.totalPages || 1,
        page,
        source: 'PandaMovies'
      };
    }
    if (normSource === 'xhamster' || normSource === 'xh') {
      const xhRes = await searchXHamster({
        query: normQ,
        page,
        limit,
        minMinutes: effMinMin || 20,
        isBlocked: isBlockedAdultText,
        fetchImpl: this.fetch,
        signal
      });
      return {
        results: xhRes.results,
        category: 'xhamster',
        total: xhRes.results.length,
        totalPages: xhRes.totalPages || 1,
        page,
        source: 'xHamster'
      };
    }
    if (normSource === 'porntrex' || normSource === 'pt') {
      const ptRes = await searchPornTrex({ query: normQ, page, limit, isBlocked: isBlockedAdultText, fetchImpl: this.fetch, signal });
      return {
        results: ptRes.results,
        category: 'porntrex',
        total: ptRes.results.length,
        totalPages: ptRes.totalPages || 1,
        page,
        source: 'PornTrex'
      };
    }
    if (normSource === 'pornhub' || normSource === 'ph') {
      return this.searchPornhub({ query: cleanQ, page, limit, sort, durationFilter: effDur, category, artist, lazy, signal });
    }
    if (normSource === 'adult_movies' || normSource === 'movies' || normSource === 'features' || normSource === 'eporner') {
      return this.searchAdultMovies({
        query: cleanQ,
        page,
        limit,
        sort,
        category,
        artist,
        studio: studio || null,
        minMinutes: effMinMin,
        epornerOnly: normSource === 'eporner',
        lazy,
        signal
      });
    }
    if (normSource === 'all') {
      const perSource = Math.max(6, Math.ceil(limit / 2));
      const [am, xv, ph] = await Promise.allSettled([
        this.searchAdultMovies({
          query: cleanQ,
          page,
          limit: perSource,
          sort,
          category,
          artist,
          studio: studio || null,
          minMinutes: isMovieDur ? Math.max(45, effMinMin || 45) : 15,
          lazy,
          signal
        }),
        this.searchXvideos({ query: cleanQ || studio || '', page, limit: perSource, sort, durationFilter: effDur, category, artist, lazy, signal }),
        this.searchPornhub({ query: cleanQ || studio || '', page, limit: perSource, sort, durationFilter: effDur, category, artist, lazy, signal })
      ]);
      const amRes = am.status === 'fulfilled' ? am.value : { results: [], totalPages: 1 };
      const xvRes = xv.status === 'fulfilled' ? xv.value : { results: [], totalPages: 1 };
      const phRes = ph.status === 'fulfilled' ? ph.value : { results: [], totalPages: 1 };
      const blended = [];
      const seenKeys = new Set();
      const pushUnique = (item) => {
        if (!item?.title) return;
        const key = `${item.sourceKey || item.category || ''}:${item.pageUrl || item.id || item.title.toLowerCase()}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        blended.push(item);
      };
      const maxLen = Math.max(amRes.results?.length || 0, xvRes.results?.length || 0, phRes.results?.length || 0);
      const featuresFirst = normObj.preferFullFeatures || isMovieDur || Boolean(studio);
      for (let i = 0; i < maxLen; i++) {
        if (featuresFirst) {
          pushUnique(amRes.results?.[i]);
          pushUnique(xvRes.results?.[i]);
          pushUnique(phRes.results?.[i]);
        } else {
          pushUnique(xvRes.results?.[i]);
          pushUnique(amRes.results?.[i]);
          pushUnique(phRes.results?.[i]);
        }
      }
      const sliced = blended.slice(0, limit);
      return {
        results: sliced,
        total: sliced.length,
        totalPages: Math.max(amRes.totalPages || 1, xvRes.totalPages || 1, phRes.totalPages || 1),
        page: Math.max(0, Number(page) || 0),
        source: 'all'
      };
    }
    return this.searchXvideos({ query: cleanQ, page, limit, sort, durationFilter: effDur, category, artist, lazy, signal });
  }

  /**
   * Dedicated XVideos search, category, and pornstar/model listing resolver.
   */
  async searchXvideos({
    query = '',
    page = 0,
    limit = 15,
    sort = 'relevance',
    durationFilter = 'all',
    category = null,
    artist = null,
    lazy = false,
    signal = null
  } = {}) {
    const cleanQuery = String(query || '').trim();
    if (isBlockedAdultText(cleanQuery)) {
      return { results: [], category: 'xvideos', total: 0, totalPages: 1, page, blocked: true };
    }
    const pageNum = Math.max(0, Number(page) || 0);
    const maxItems = Math.max(1, Math.min(30, Number(limit) || 15));
    const cacheKey = `xv:${sort}:${durationFilter}:${category || ''}:${artist || ''}:${cleanQuery.toLowerCase()}:${pageNum}:${maxItems}:${lazy ? 'L' : 'E'}`;

    const cached = this.#getCached(this.searchCache, cacheKey);
    if (cached) return cached;
    if (this.inFlight.has(cacheKey)) {
      try { return await this.inFlight.get(cacheKey); } catch {}
    }

    const job = (async () => {
      const durMap = {
        short: '1-3min',
        medium: '3-10min',
        long: '10-20min',
        '10m+': '10-20min',
        full: '20min+',
        '20m+': '20min+'
      };
      const durParam = durMap[durationFilter] ? `&durf=${encodeURIComponent(durMap[durationFilter])}` : '';
      const sortParam = sort && sort !== 'relevance' ? `&sort=${encodeURIComponent(sort)}` : '';

      let targetUrl;
      if (artist && !cleanQuery) {
        const slug = String(artist).trim().replace(/^\/+|\/+$/g, '');
        if (/^(pornstars|models|channels|profiles)\//i.test(slug)) {
          targetUrl = `https://www.xvideos.com/${slug}${pageNum > 0 ? `/${pageNum}` : ''}`;
        } else {
          const found = FEATURED_ARTISTS.find((a) => a.xvSlug.toLowerCase() === slug.toLowerCase() || a.name.toLowerCase() === slug.toLowerCase());
          const cleanSlug = found ? found.xvSlug : slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
          targetUrl = `https://www.xvideos.com/?k=${encodeURIComponent(found?.name || cleanSlug.replace(/-/g, ' '))}${pageNum > 0 ? `&p=${pageNum}` : ''}${sortParam}${durParam}`;
        }
      } else if (category && !cleanQuery) {
        const catObj = ADULT_CATEGORIES.find((c) => c.id === category || c.xvSlug === category);
        const catSlug = catObj ? catObj.xvSlug : String(category).toLowerCase().trim();
        targetUrl = `https://www.xvideos.com/?k=${encodeURIComponent(catSlug.replace(/-/g, ' '))}${pageNum > 0 ? `&p=${pageNum}` : ''}${sortParam}${durParam}`;
      } else {
        const isTrending = !cleanQuery || /^(trending|hot|popular|top|best)$/i.test(cleanQuery);
        targetUrl = isTrending && !durParam && (!sort || sort === 'relevance')
          ? `https://www.xvideos.com/${pageNum > 0 ? `new/${pageNum}` : ''}`
          : `https://www.xvideos.com/?k=${encodeURIComponent(cleanQuery || 'hd')}${pageNum > 0 ? `&p=${pageNum}` : ''}${sortParam}${durParam}`;
      }

      const results = [];
      let totalPages = Math.max(10, pageNum + 5);
      try {
        const res = await this.fetch(targetUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(8000)
        });
        if (!res.ok) return { results, category: 'xvideos', total: 0, totalPages: 1, page: pageNum, source: 'XVideos' };
        const html = await res.text();
        const $ = cheerio.load(html);

        // Extract max page number from pagination bar if present
        let maxDiscoveredPage = pageNum + 1;
        $('.pagination ul li a, .pagination a').each((_, a) => {
          const txt = $(a).text().trim();
          if (/^\d+$/.test(txt)) {
            const pVal = Number(txt);
            if (pVal > maxDiscoveredPage) maxDiscoveredPage = pVal;
          }
        });
        if (maxDiscoveredPage > 1) totalPages = maxDiscoveredPage;

        const blocks = [];
        $('.thumb-block').each((i, el) => {
          const titleA = $(el).find('.thumb-under p.title a');
          const title = (titleA.attr('title') || titleA.text() || '').trim();
          const href = titleA.attr('href') || '';
          const img = $(el).find('.thumb img, img');
          const thumb = img.attr('data-src') || img.attr('src') || null;
          const pvvUrl = img.attr('data-pvv') || $(el).attr('data-pvv') || null;
          const duration = $(el).find('.duration').first().text().trim() || 'HD';
          const qualityBadge = $(el).find('.video-hd-mark').text().trim() || '';
          const uploaderEl = $(el).find('.thumb-under .name, .uploader-tag .name, a[href*="/pornstars/"], a[href*="/models/"], a[href*="/channels/"]').first();
          const uploaderName = uploaderEl.text().trim() || null;
          const uploaderHref = uploaderEl.attr('href') || null;

          if (!title || !href || href.startsWith('#') || isBlockedAdultText(title)) return;
          const fullPageUrl = href.startsWith('http') ? href : `https://www.xvideos.com${href.startsWith('/') ? '' : '/'}${href}`;
          blocks.push({
            id: $(el).attr('data-id') || `xv_${pageNum}_${i}`,
            title,
            fullPageUrl,
            thumb,
            pvvUrl: pvvUrl && pvvUrl.endsWith('.mp4') ? pvvUrl : null,
            duration,
            durationSeconds: parseDurationToSeconds(duration),
            quality: qualityBadge || 'HD',
            artist: uploaderName,
            artistUrl: uploaderHref
          });
        });

        const sliced = blocks.slice(0, maxItems);
        // Only resolve upfront when lazy === false (e.g. legacy direct caller/tests)
        if (!lazy && sliced.length > 0) {
          const eagerCount = Math.min(6, sliced.length);
          await Promise.all(
            sliced.slice(0, eagerCount).map(async (b) => {
              b.resolved = await this.resolveXvideosStream(b.fullPageUrl, signal).catch(() => null);
            })
          );
        }

        for (const b of sliced) {
          const fallbackUrls = [...new Set([
            ...(b.resolved?.fallbackUrls || []),
            b.pvvUrl
          ].filter(Boolean))];
          const videoUrl = b.resolved?.streamUrl || b.pvvUrl || null;
          results.push({
            id: String(b.id),
            title: b.title.slice(0, 180),
            type: 'video',
            mediaType: 'video',
            isAdult: true,
            mediaUrl: videoUrl || b.thumb || b.fullPageUrl,
            videoUrl,
            streamUrl: b.resolved?.streamUrl || null,
            hlsUrl: b.resolved?.hlsUrl || null,
            variants: b.resolved?.variants || null,
            fallbackUrls,
            thumbUrl: b.thumb || b.pvvUrl || null,
            poster: b.thumb || null,
            pageUrl: b.fullPageUrl,
            duration: b.duration,
            durationSeconds: b.durationSeconds || b.resolved?.durationSeconds || 0,
            quality: b.quality,
            artist: b.resolved?.artist || b.artist || 'XVideos Creator',
            artistSlug: b.resolved?.artistSlug || b.artistUrl || null,
            categories: b.resolved?.categories || (category ? [category] : []),
            headers: { Referer: 'https://www.xvideos.com/', 'User-Agent': USER_AGENT },
            streamHeaders: { Referer: 'https://www.xvideos.com/', 'User-Agent': USER_AGENT },
            category: 'xvideos',
            source: 'XVideos'
          });
        }
      } catch (err) {
        log.debug({ err: err?.message, query: cleanQuery }, 'xvideos search failed');
      }

      const payload = {
        results,
        category: 'xvideos',
        total: results.length,
        totalPages: results.length ? totalPages : 1,
        page: pageNum,
        source: 'XVideos'
      };
      return this.#setCached(this.searchCache, cacheKey, payload);
    })();

    this.inFlight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Dedicated Pornhub search, category, and pornstar catalog resolver via official Webmasters JSON API
   * with HTML fallback.
   */
  async searchPornhub({
    query = '',
    page = 0,
    limit = 15,
    sort = 'relevance',
    durationFilter = 'all',
    category = null,
    artist = null,
    lazy = true,
    signal = null
  } = {}) {
    const cleanQuery = String(query || '').trim();
    if (isBlockedAdultText(cleanQuery)) {
      return { results: [], category: 'pornhub', total: 0, totalPages: 1, page, blocked: true, source: 'Pornhub' };
    }
    const pageNum = Math.max(0, Number(page) || 0);
    const maxItems = Math.max(1, Math.min(30, Number(limit) || 15));
    const cacheKey = `ph:${sort}:${durationFilter}:${category || ''}:${artist || ''}:${cleanQuery.toLowerCase()}:${pageNum}:${maxItems}`;

    const cached = this.#getCached(this.searchCache, cacheKey);
    if (cached) return cached;
    if (this.inFlight.has(cacheKey)) {
      try { return await this.inFlight.get(cacheKey); } catch {}
    }

    const job = (async () => {
      const orderMap = {
        relevance: 'mostviewed',
        views: 'mostviewed',
        rating: 'rating',
        uploaddate: 'newest',
        newest: 'newest',
        length: 'longest'
      };
      const ordering = orderMap[sort] || 'mostviewed';
      const params = new URLSearchParams({
        page: String(pageNum + 1),
        ordering,
        thumbsize: 'large'
      });

      if (artist) {
        const cleanArtist = String(artist).replace(/^\/?(pornstars|models|channels)\//i, '').replace(/-/g, ' ').trim();
        params.set('stars[]', cleanArtist);
        if (cleanQuery) params.set('search', cleanQuery);
      } else if (category) {
        const catObj = ADULT_CATEGORIES.find((c) => c.id === category || c.phSlug === category);
        params.set('category', catObj ? catObj.phSlug : String(category).toLowerCase());
        if (cleanQuery) params.set('search', cleanQuery);
      } else if (cleanQuery && !/^(trending|hot|popular|top|best)$/i.test(cleanQuery)) {
        params.set('search', cleanQuery);
      }

      const apiUrl = `https://www.pornhub.com/webmasters/search?${params.toString()}`;
      const results = [];
      let totalPages = Math.max(20, pageNum + 5);

      try {
        const res = await this.fetch(apiUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
          signal: signal || AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          const rawVideos = Array.isArray(data?.videos) ? data.videos : [];
          let filtered = rawVideos.filter((v) => v?.video_id && v?.url && !isBlockedAdultText(v.title || ''));

          if (durationFilter === '10m+' || durationFilter === 'long') {
            const longOnly = filtered.filter((v) => parseDurationToSeconds(v.duration) >= 600);
            if (longOnly.length >= 2) filtered = longOnly;
          } else if (durationFilter === '20m+' || durationFilter === 'full') {
            const fullOnly = filtered.filter((v) => parseDurationToSeconds(v.duration) >= 1200);
            if (fullOnly.length >= 2) filtered = fullOnly;
          }

          for (const v of filtered.slice(0, maxItems)) {
            const durSec = parseDurationToSeconds(v.duration);
            const stars = Array.isArray(v.pornstars)
              ? v.pornstars.map((p) => p?.pornstar_name).filter(Boolean)
              : [];
            const cats = Array.isArray(v.categories)
              ? v.categories.map((c) => c?.category).filter(Boolean)
              : [];
            const tags = Array.isArray(v.tags)
              ? v.tags.map((t) => t?.tag_name).filter(Boolean)
              : [];
            const ratingNum = Number(v.rating);
            const ratingStr = Number.isFinite(ratingNum) && ratingNum > 0 ? `${Math.round(ratingNum)}%` : null;

            results.push({
              id: `ph_${v.video_id}`,
              videoId: String(v.video_id),
              title: String(v.title || 'Pornhub HD Video').slice(0, 180),
              type: 'video',
              mediaType: 'video',
              isAdult: true,
              mediaUrl: v.url,
              videoUrl: null,
              streamUrl: null,
              fallbackUrls: [],
              thumbUrl: v.default_thumb || v.thumb || v.thumbs?.[0]?.src || null,
              poster: v.default_thumb || v.thumb || null,
              pageUrl: v.url,
              duration: String(v.duration || 'HD'),
              durationSeconds: durSec,
              views: Number(v.views) || 0,
              rating: ratingStr,
              quality: 'HD',
              artist: stars[0] || 'Pornhub Creator',
              pornstars: stars,
              categories: [...new Set([...cats, ...tags.slice(0, 6)])].slice(0, 10),
              headers: {
                Referer: 'https://www.pornhub.com/',
                Origin: 'https://www.pornhub.com',
                Cookie: 'accessAgeDisclaimerPH=1; platform=pc',
                'User-Agent': USER_AGENT
              },
              streamHeaders: {
                Referer: 'https://www.pornhub.com/',
                Origin: 'https://www.pornhub.com',
                Cookie: 'accessAgeDisclaimerPH=1; platform=pc',
                'User-Agent': USER_AGENT
              },
              category: 'pornhub',
              source: 'Pornhub'
            });
          }

          if (!lazy && results.length > 0) {
            const firstResolved = await this.resolvePornhubStream(results[0].pageUrl, signal).catch(() => null);
            if (firstResolved?.streamUrl) {
              results[0].streamUrl = firstResolved.streamUrl;
              results[0].videoUrl = firstResolved.streamUrl;
              results[0].mediaUrl = firstResolved.streamUrl;
              results[0].variants = firstResolved.variants;
              results[0].streamHeaders = firstResolved.headers;
            }
          }
        }
      } catch (err) {
        log.debug({ err: err?.message, query: cleanQuery }, 'pornhub search failed');
      }

      const payload = {
        results,
        category: 'pornhub',
        total: results.length,
        totalPages: results.length ? totalPages : 1,
        page: pageNum,
        source: 'Pornhub'
      };
      return this.#setCached(this.searchCache, cacheKey, payload);
    })();

    this.inFlight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Dedicated 18+ Adult Full-Length Movies search (Eporner v2 API).
   */
  async searchAdultMovies({
    query = '',
    page = 0,
    limit = 12,
    sort = 'relevance',
    category = null,
    artist = null,
    studio = null,
    minMinutes = 12,
    epornerOnly = false,
    lazy = false,
    signal = null
  } = {}) {
    const rawQuery = String(query || artist || studio || category || '').trim();
    if (isBlockedAdultText(rawQuery)) {
      return { results: [], category: 'adult_movies', total: 0, totalPages: 1, page, blocked: true };
    }
    const norm = normalizeAdultMovieQuery(rawQuery);
    const cleanQuery = norm.primaryQuery || norm.cleanQuery || rawQuery;
    const isBrowseAll = !rawQuery || /^(trending|hot|popular|all|full\s*movies?)$/i.test(cleanQuery);
    const pageNum = Math.max(0, Number(page) || 0);
    const maxItems = Math.max(1, Math.min(24, Number(limit) || 12));
    const minSec = Math.max(60, (Number(minMinutes) || 12) * 60);
    const cacheKey = `am2:${sort}:${epornerOnly ? 'ep' : 'multi'}:${cleanQuery.toLowerCase()}:${artist || ''}:${studio || ''}:${pageNum}:${maxItems}:${minSec}:${lazy ? 'L' : 'E'}`;

    const cached = this.#getCached(this.searchCache, cacheKey);
    if (cached) return cached;
    if (this.inFlight.has(cacheKey)) {
      try { return await this.inFlight.get(cacheKey); } catch {}
    }

    const job = (async () => {
      let results = [];
      let totalPages = Math.max(10, pageNum + 5);
      const aggregated = [];

      try {
        const orderMap = {
          relevance: isBrowseAll ? 'top-weekly' : 'longest',
          views: 'most-popular',
          rating: 'top-rated',
          uploaddate: 'latest',
          length: 'longest'
        };
        const order = orderMap[sort] || 'longest';
        const epQuery = isBrowseAll
          ? 'full movie'
          : (cleanQuery.split(/\s+/).length >= 2 || /movie|film|full/i.test(cleanQuery) ? cleanQuery : `${cleanQuery} full`);

        const fetchEporner = async () => {
          const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${encodeURIComponent(epQuery)}&per_page=30&page=${pageNum + 1}&thumbsize=big&order=${order}&format=json`;
          const res = await this.fetch(apiUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: signal || AbortSignal.timeout(7000)
          });
          if (!res?.ok) return [];
          const data = await res.json();
          if (Number(data?.total_pages) > 0) {
            totalPages = Math.min(500, Number(data.total_pages));
          }
          const rawVideos = Array.isArray(data?.videos) ? data.videos : [];
          const safe = rawVideos.filter((v) => v?.id && v?.embed && !isBlockedAdultText(`${v.title || ''} ${v.keywords || ''}`));
          let longForm = safe.filter((v) => Number(v.length_sec) >= minSec);
          if (longForm.length < 3) longForm = safe.filter((v) => Number(v.length_sec) >= 300);
          if (longForm.length === 0) longForm = safe;

          return longForm.map((v) => {
            const keywords = String(v.keywords || '')
              .split(',')
              .map((k) => k.trim())
              .filter((k) => k && k.length <= 28)
              .slice(0, 8);
            return {
              id: `am_${v.id}`,
              epornerId: String(v.id),
              embedUrl: v.embed,
              title: String(v.title || cleanQuery || '18+ Feature Film').slice(0, 180),
              type: 'video',
              mediaType: 'video',
              isAdult: true,
              isFeature: Number(v.length_sec) >= 2400,
              mediaUrl: v.url || v.embed,
              videoUrl: null,
              streamUrl: null,
              fallbackUrls: [],
              thumbUrl: v.default_thumb?.src || v.thumbs?.[0]?.src || null,
              poster: v.default_thumb?.src || v.thumbs?.[0]?.src || null,
              pageUrl: v.url || v.embed,
              width: 1920,
              height: 1080,
              durationSec: Number(v.length_sec) || 0,
              durationSeconds: Number(v.length_sec) || 0,
              duration: `${v.length_min || 'Full HD'}`,
              length_sec: Number(v.length_sec) || 0,
              length_min: v.length_min,
              views: Number(v.views) || 0,
              rating: v.rate ? `${v.rate}` : null,
              artist: 'Eporner Studio',
              categories: keywords,
              headers: { Referer: v.embed, 'User-Agent': USER_AGENT },
              streamHeaders: { Referer: v.embed, 'User-Agent': USER_AGENT },
              category: 'adult_movies',
              sourceKey: 'eporner',
              source: 'Eporner'
            };
          });
        };

        if (epornerOnly) {
          const epItems = await fetchEporner();
          aggregated.push(...epItems);
        } else {
          const tasks = [
            fetchEporner(),
            searchFullXCinema({
              query: isBrowseAll ? '' : cleanQuery,
              page: pageNum,
              limit: maxItems,
              isBlocked: isBlockedAdultText,
              fetchImpl: this.fetch,
              signal
            }).then((r) => r?.results || []),
            searchPandaMovies({
              query: isBrowseAll && !artist && !studio ? '' : cleanQuery,
              page: pageNum,
              limit: maxItems,
              artist,
              studio,
              isBlocked: isBlockedAdultText,
              fetchImpl: this.fetch,
              signal
            }).then((r) => {
              if (Number(r?.totalPages) > totalPages) totalPages = r.totalPages;
              return r?.results || [];
            }),
            searchXHamster({
              query: epQuery,
              page: pageNum,
              limit: Math.min(8, maxItems),
              minMinutes: Math.max(20, Math.round(minSec / 60)),
              isBlocked: isBlockedAdultText,
              fetchImpl: this.fetch,
              signal
            }).then((r) => r?.results || []),
            searchPornTrex({
              query: epQuery,
              page: pageNum,
              limit: Math.min(8, maxItems),
              isBlocked: isBlockedAdultText,
              fetchImpl: this.fetch,
              signal
            }).then((r) => r?.results || [])
          ];
          if (!isBrowseAll && !studio) {
            tasks.push(
              this.searchPornhub({
                query: cleanQuery,
                page: pageNum,
                limit: Math.min(6, maxItems),
                sort,
                durationFilter: 'long',
                lazy: true,
                signal
              }).then((r) => r?.results || []).catch(() => [])
            );
          }

          const settled = await Promise.allSettled(tasks);
          for (const s of settled) {
            if (s.status === 'fulfilled' && Array.isArray(s.value)) {
              aggregated.push(...s.value);
            }
          }
        }

        // Rank by title match relevance + full-length feature priority, keeping long features >= minSec first
        const ranked = aggregated
          .filter((item) => item && item.title && !isBlockedAdultText(item.title))
          .map((item) => {
            const matchScore = !isBrowseAll ? scoreAdultTitleMatch(cleanQuery, item.title) : 10;
            const dur = Number(item.durationSeconds || item.durationSec || 0);
            const featureBonus = (item.sourceKey === 'fullxcinema' || item.sourceKey === 'pandamovies' || item.isFeature)
              ? 18
              : (dur >= 2400 ? 14 : (dur >= 1200 ? 6 : (dur > 0 && dur < 600 ? -15 : 0)));
            const durOk = item.isFeature || item.sourceKey === 'fullxcinema' || item.sourceKey === 'pandamovies' || dur === 0 || dur >= minSec;
            return {
              item,
              score: (matchScore * 2) + featureBonus + (durOk ? 10 : 0)
            };
          })
          .sort((a, b) => b.score - a.score || (Number(b.item.durationSeconds || 0) - Number(a.item.durationSeconds || 0)));

        const seen = new Set();
        const deduped = [];
        for (const entry of ranked) {
          const normTitle = entry.item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const key = `${entry.item.sourceKey || entry.item.category}:${normTitle || entry.item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(entry.item);
          if (deduped.length >= maxItems) break;
        }

        if (lazy) {
          results = deduped;
        } else {
          // Eager resolve up to top 2 items (all Eporner items if unit test expects eager resolve)
          const resolvedList = await Promise.all(
            deduped.map(async (item, idx) => {
              if (item.sourceKey === 'eporner' || item.epornerId) {
                const ep = await this.resolveEpornerVideo(item, cleanQuery, signal);
                return ep || item;
              }
              if (idx < 2) {
                await this.resolveStream(item, { signal }).catch(() => null);
              }
              return item;
            })
          );
          results = resolvedList.filter(Boolean);
        }
      } catch (err) {
        log.debug({ err: err?.message, query: cleanQuery }, 'adult movies search failed');
      }

      const payload = {
        results,
        category: 'adult_movies',
        total: results.length,
        totalPages: results.length ? totalPages : 1,
        page: pageNum,
        source: epornerOnly ? 'Eporner' : '18+ Adult Cinema'
      };
      return this.#setCached(this.searchCache, cacheKey, payload);
    })();

    this.inFlight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async resolveEpornerVideo(v, fallbackTitle = '18+ Feature Film', signal = null) {
    try {
      const embedUrl = v.embedUrl || v.embed || v.pageUrl;
      const epornerId = v.epornerId || String(v.id || '').replace(/^am_/, '');
      if (!embedUrl || !epornerId) return null;

      const embedRes = await this.fetch(embedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal || AbortSignal.timeout(5000)
      });
      if (!embedRes.ok) return null;
      const embedHtml = await embedRes.text();
      const hashMatch = embedHtml.match(/hash\s*[:=]\s*['"]([a-f0-9]{32})['"]/i);
      if (!hashMatch) return null;

      const h36 = epornerHexToBase36(hashMatch[1]);
      const xhrUrl = `https://www.eporner.com/xhr/video/${epornerId}?hash=${h36}&domain=www.eporner.com&fallback=false&embed=true&supportedFormats=mp4`;
      const xhrRes = await this.fetch(xhrUrl, {
        headers: { 'User-Agent': USER_AGENT, Referer: embedUrl },
        signal: signal || AbortSignal.timeout(5000)
      });
      if (!xhrRes.ok) return null;
      const xhrData = await xhrRes.json();
      const mp4Sources = xhrData?.sources?.mp4 || {};
      const variants = [];
      for (const [label, obj] of Object.entries(mp4Sources)) {
        if (!obj?.src) continue;
        const hMatch = label.match(/(\d{3,4})p/i);
        const height = hMatch ? Number(hMatch[1]) : 480;
        variants.push({
          qualityLabel: `${height}p`,
          height,
          url: obj.src,
          isHls: false,
          sizeBytes: null
        });
      }
      const ordered = [
        mp4Sources['720p HD']?.src || mp4Sources['720p']?.src,
        mp4Sources['1080p HD']?.src || mp4Sources['1080p']?.src,
        mp4Sources['480p']?.src,
        mp4Sources['360p']?.src,
        mp4Sources['240p']?.src
      ].filter(Boolean);
      const primaryUrl = ordered[0];
      if (!primaryUrl) return null;

      const durSec = Number(v.length_sec || v.durationSeconds || v.durationSec) || 0;
      return {
        id: `am_${epornerId}`,
        title: String(v.title || fallbackTitle || '18+ Feature Film').slice(0, 180),
        type: 'video',
        mediaType: 'video',
        isAdult: true,
        mediaUrl: primaryUrl,
        videoUrl: primaryUrl,
        streamUrl: primaryUrl,
        fallbackUrls: ordered,
        variants,
        thumbUrl: v.thumbUrl || v.default_thumb?.src || v.thumbs?.[0]?.src || null,
        poster: v.poster || v.default_thumb?.src || v.thumbs?.[0]?.src || null,
        pageUrl: v.url || v.pageUrl || embedUrl,
        width: 1920,
        height: 1080,
        durationSec: durSec,
        durationSeconds: durSec,
        duration: `${v.length_min || v.duration || 'Full HD'}`,
        headers: { Referer: embedUrl, 'User-Agent': USER_AGENT },
        streamHeaders: { Referer: embedUrl, 'User-Agent': USER_AGENT },
        category: 'adult_movies',
        source: '18+ Adult Cinema'
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve direct high-res MP4 / HLS stream URLs, quality variants, uploader/pornstar,
   * and tags from an XVideos watch page.
   */
  async resolveXvideosStream(pageUrl, signal = null) {
    const url = String(pageUrl || '').trim();
    if (!url || !/^https?:\/\/([a-z0-9-]+\.)*xvideos\./i.test(url)) return null;
    const cached = this.#getCached(this.streamCache, `xv:${url}`);
    if (cached) return cached;

    const headers = {
      'User-Agent': USER_AGENT,
      Referer: 'https://www.xvideos.com/'
    };
    try {
      const res = await this.fetch(url, {
        headers,
        signal: signal || AbortSignal.timeout(6500)
      });
      if (!res.ok) return null;
      const html = await res.text();
      const highMatch = html.match(/html5player\.setVideoUrlHigh\s*\(\s*['"]([^'"]+)['"]/i);
      const lowMatch = html.match(/html5player\.setVideoUrlLow\s*\(\s*['"]([^'"]+)['"]/i);
      const hlsMatch = html.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]/i);
      const jsonContentMatch = html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
      const durMatch = html.match(/"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/i);

      const highUrl = (highMatch?.[1] || jsonContentMatch?.[1] || '').replace(/\\\//g, '/') || null;
      const lowUrl = (lowMatch?.[1] || '').replace(/\\\//g, '/') || null;
      const hlsUrl = (hlsMatch?.[1] || '').replace(/\\\//g, '/') || null;
      const fallbackUrls = [...new Set([highUrl, lowUrl, hlsUrl].filter(Boolean))];
      const streamUrl = highUrl || lowUrl || hlsUrl || null;
      if (!streamUrl) return null;

      let durationSeconds = 0;
      if (durMatch) {
        durationSeconds = (Number(durMatch[1] || 0) * 3600) + (Number(durMatch[2] || 0) * 60) + Number(durMatch[3] || 0);
      }

      // Extract uploader / pornstar & tags
      let artist = null;
      let artistSlug = null;
      const upMatch = html.match(/<a[^>]+href="(\/(?:pornstars|models|channels|profiles)\/[^"]+)"[^>]*>[\s\S]{0,160}?<span class="name">([^<]+)<\/span>/i)
        || html.match(/href="(\/(?:pornstars|models|channels)\/[^"]+)"[^>]*class="[^"]*btn[^"]*"[^>]*>([^<]+)</i);
      if (upMatch) {
        artistSlug = upMatch[1].trim();
        artist = upMatch[2].trim();
      }
      const categories = [];
      for (const tm of html.matchAll(/<a[^>]+href="\/tags\/([^"/?#]+)"[^>]*>([^<]{2,28})<\/a>/gi)) {
        const tag = tm[2].trim();
        if (tag && !isBlockedAdultText(tag) && !categories.includes(tag)) {
          categories.push(tag);
          if (categories.length >= 8) break;
        }
      }

      const variants = [];
      if (lowUrl) variants.push({ quality: '360p', qualityLabel: '360p', height: 360, url: lowUrl, isHls: false, sizeBytes: null });
      if (highUrl) {
        variants.push({ quality: '480p', qualityLabel: '480p', height: 480, url: highUrl, isHls: false, sizeBytes: null });
        variants.push({ quality: '720p', qualityLabel: '720p', height: 720, url: highUrl, isHls: false, sizeBytes: null });
      }

      // Parse HLS master playlist if present to unlock true 720p/1080p/360p sub-playlists
      if (hlsUrl && /^https?:\/\//i.test(hlsUrl)) {
        try {
          const hlsRes = await this.fetch(hlsUrl, {
            headers,
            signal: AbortSignal.timeout(2500)
          });
          if (hlsRes?.ok) {
            const m3u8 = await hlsRes.text();
            const lines = m3u8.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i) || line.match(/NAME="(\d+)p"/i);
                const nextUri = lines[i + 1]?.trim();
                if (resMatch && nextUri && !nextUri.startsWith('#')) {
                  const h = Number(resMatch[1]);
                  const fullSubUrl = new URL(nextUri, hlsUrl).toString();
                  if (!variants.some((v) => v.height === h && !v.isHls)) {
                    variants.push({ quality: `${h}p`, qualityLabel: `${h}p`, height: h, url: fullSubUrl, isHls: true, sizeBytes: null });
                  }
                }
              }
            }
          }
        } catch {}
      }

      const payload = {
        streamUrl,
        highUrl,
        lowUrl,
        hlsUrl,
        isHls: Boolean(!highUrl && !lowUrl && hlsUrl),
        fallbackUrls,
        variants,
        durationSeconds,
        artist,
        artistSlug,
        categories,
        headers
      };
      return this.#setCached(this.streamCache, `xv:${url}`, payload);
    } catch (err) {
      log.debug({ err: err?.message, url }, 'xvideos stream resolution failed');
      return null;
    }
  }

  /**
   * Resolve direct signed MP4 variants (240p, 480p, 720p, 1080p) and metadata from a Pornhub watch page.
   */
  async resolvePornhubStream(pageUrl, signal = null) {
    const url = String(pageUrl || '').trim();
    if (!url || !/pornhub\.com/i.test(url)) return null;
    const cached = this.#getCached(this.streamCache, `ph:${url}`);
    if (cached) return cached;

    const cookieJar = ['accessAgeDisclaimerPH=1', 'platform=pc'];
    const baseHeaders = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.pornhub.com/',
      Origin: 'https://www.pornhub.com'
    };

    try {
      const res = await this.fetch(url, {
        headers: { ...baseHeaders, Cookie: cookieJar.join('; ') },
        signal: signal || AbortSignal.timeout(7500)
      });
      if (!res.ok) return null;
      const setCookies = res.headers?.getSetCookie?.() || [];
      for (const sc of setCookies) {
        const pair = String(sc).split(';')[0]?.trim();
        if (pair && !cookieJar.includes(pair)) cookieJar.push(pair);
      }
      const fullCookie = cookieJar.join('; ');
      const html = await res.text();

      const fvMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});\s*(?:\r?\n|$|<)/);
      if (!fvMatch) return null;
      const fv = JSON.parse(fvMatch[1]);
      const mediaDefs = Array.isArray(fv.mediaDefinitions) ? fv.mediaDefinitions : [];
      const variants = [];

      // Fetch direct MP4 variants from get_media endpoint
      const getMediaDef = mediaDefs.find((m) => m?.videoUrl && String(m.videoUrl).includes('get_media'));
      if (getMediaDef?.videoUrl) {
        try {
          const mRes = await this.fetch(getMediaDef.videoUrl, {
            headers: {
              ...baseHeaders,
              Referer: url,
              Cookie: fullCookie,
              'X-Requested-With': 'XMLHttpRequest'
            },
            signal: signal || AbortSignal.timeout(5500)
          });
          if (mRes.ok) {
            const mp4List = await mRes.json();
            if (Array.isArray(mp4List)) {
              for (const item of mp4List) {
                const h = Number(item?.height || item?.quality) || 0;
                if (h > 0 && item?.videoUrl) {
                  variants.push({
                    quality: `${h}p`,
                    qualityLabel: `${h}p`,
                    height: h === 240 ? 360 : h,
                    rawHeight: h,
                    url: item.videoUrl,
                    isHls: item.format === 'hls',
                    sizeBytes: null
                  });
                }
              }
            }
          }
        } catch {}
      }

      // Fallback to HLS mediaDefinitions if get_media didn't yield direct MP4s
      if (variants.length === 0) {
        for (const m of mediaDefs) {
          const h = Number(m?.quality) || 0;
          if (h > 0 && m?.videoUrl && !String(m.videoUrl).includes('get_media')) {
            variants.push({
              quality: `${h}p`,
              qualityLabel: `${h}p`,
              height: h,
              url: m.videoUrl,
              isHls: m.format === 'hls' || /\.m3u8/i.test(m.videoUrl),
              sizeBytes: null
            });
          }
        }
      }

      if (variants.length === 0) return null;

      // Prefer 720p -> 480p -> 1080p -> 240p for primary streamUrl
      const sorted = [...variants].sort((a, b) => {
        const score = (v) => (v.height === 720 ? 4 : v.height === 480 ? 3 : v.height === 1080 ? 2 : 1) + (v.isHls ? 0 : 10);
        return score(b) - score(a);
      });
      const primary = sorted[0];
      const streamHeaders = {
        ...baseHeaders,
        Referer: url,
        Cookie: fullCookie
      };

      const payload = {
        streamUrl: primary.url,
        highUrl: sorted.find((v) => v.height >= 720)?.url || primary.url,
        lowUrl: sorted.find((v) => v.height <= 480)?.url || primary.url,
        hlsUrl: variants.find((v) => v.isHls)?.url || null,
        isHls: Boolean(primary.isHls),
        fallbackUrls: sorted.map((v) => v.url),
        variants: sorted,
        durationSeconds: Number(fv.video_duration) || 0,
        headers: streamHeaders
      };
      return this.#setCached(this.streamCache, `ph:${url}`, payload);
    } catch (err) {
      log.debug({ err: err?.message, url }, 'pornhub stream resolution failed');
      return null;
    }
  }

  /**
   * Unified lazy stream & detail resolver for any adult catalog item (`XVideos`, `Pornhub`, `Eporner`).
   * Optionally probes `HEAD` Content-Length on the primary MP4 stream so quality selector pills
   * display accurate MB estimates.
   */
  async resolveStream(itemOrUrl, { preferredHeight = 720, probeSize = false, signal = null } = {}) {
    const isObj = itemOrUrl && typeof itemOrUrl === 'object';
    const pageUrl = isObj ? (itemOrUrl.pageUrl || itemOrUrl.embedUrl || itemOrUrl.mediaUrl) : String(itemOrUrl || '');
    const sk = String(isObj ? (itemOrUrl.sourceKey || '') : '').toLowerCase();

    let resolved = null;
    if (sk === 'fullxcinema' || /fullxcinema\.com/i.test(pageUrl)) {
      resolved = await resolveFullXCinemaStream(pageUrl, { fetchImpl: this.fetch, signal });
    } else if (sk === 'pandamovies' || /pandamovies\.org/i.test(pageUrl)) {
      resolved = await resolvePandaMoviesStream(pageUrl, { fetchImpl: this.fetch, signal });
    } else if (sk === 'xhamster' || /xhamster\./i.test(pageUrl)) {
      resolved = await resolveXHamsterStream(pageUrl, { fetchImpl: this.fetch, signal });
    } else if (sk === 'porntrex' || /porntrex\.com/i.test(pageUrl)) {
      resolved = await resolvePornTrexStream(pageUrl, { fetchImpl: this.fetch, signal });
    } else if (isObj && (itemOrUrl.epornerId || /eporner\.com/i.test(pageUrl) || (itemOrUrl.category === 'adult_movies' && !sk))) {
      const ep = await this.resolveEpornerVideo(itemOrUrl, itemOrUrl.title, signal);
      if (ep) {
        resolved = {
          streamUrl: ep.streamUrl,
          highUrl: ep.streamUrl,
          lowUrl: ep.fallbackUrls?.at(-1) || ep.streamUrl,
          hlsUrl: null,
          isHls: false,
          fallbackUrls: ep.fallbackUrls || [ep.streamUrl],
          variants: ep.variants || [],
          durationSeconds: ep.durationSeconds || itemOrUrl.durationSeconds || 0,
          headers: ep.streamHeaders || ep.headers
        };
      }
    } else if (/pornhub\.com/i.test(pageUrl) || (isObj && itemOrUrl.category === 'pornhub')) {
      resolved = await this.resolvePornhubStream(pageUrl, signal);
    } else if (/xvideos\./i.test(pageUrl) || (isObj && itemOrUrl.category === 'xvideos')) {
      resolved = await this.resolveXvideosStream(pageUrl, signal);
    }

    if (!resolved) {
      if (isObj && (itemOrUrl.streamUrl || itemOrUrl.videoUrl)) {
        return {
          streamUrl: itemOrUrl.streamUrl || itemOrUrl.videoUrl,
          isHls: Boolean(itemOrUrl.isHls),
          variants: itemOrUrl.variants || [],
          durationSeconds: itemOrUrl.durationSeconds || 0,
          headers: itemOrUrl.streamHeaders || itemOrUrl.headers || {}
        };
      }
      return null;
    }

    // Select progressive MP4 before HLS; closest height to preferredHeight wins
    let chosenUrl = resolved.streamUrl;
    let chosenIsHls = Boolean(resolved.isHls);
    if (Array.isArray(resolved.variants) && resolved.variants.length > 0 && preferredHeight) {
      const best = [...resolved.variants].sort((a, b) => {
        const diffA = Math.abs((Number(a.height) || 480) - preferredHeight) + (a.isHls ? 2000 : 0);
        const diffB = Math.abs((Number(b.height) || 480) - preferredHeight) + (b.isHls ? 2000 : 0);
        return diffA - diffB;
      })[0];
      if (best?.url) {
        chosenUrl = best.url;
        chosenIsHls = Boolean(best.isHls);
      }
    }

    // Optional lightweight HEAD probe for accurate MP4 size estimation on Detail Card
    if (probeSize && Array.isArray(resolved.variants)) {
      await Promise.all(
        resolved.variants
          .filter((v) => !v.isHls && !v.sizeBytes && /^https?:\/\//i.test(v.url))
          .slice(0, 3)
          .map(async (v) => {
            try {
              const headRes = await this.fetch(v.url, {
                method: 'HEAD',
                headers: resolved.headers || { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(2000)
              });
              const cl = Number(headRes?.headers?.get?.('content-length') || 0);
              if (cl > 10000) v.sizeBytes = cl;
            } catch {}
          })
      );
    }

    const finalStreamUrl = chosenUrl || resolved.streamUrl;
    if (isObj && finalStreamUrl) {
      itemOrUrl.videoUrl = finalStreamUrl;
      itemOrUrl.streamUrl = finalStreamUrl;
      if (resolved.hlsUrl) itemOrUrl.hlsUrl = resolved.hlsUrl;
      if (Array.isArray(resolved.variants) && resolved.variants.length) itemOrUrl.variants = resolved.variants;
      if (Array.isArray(resolved.fallbackUrls) && resolved.fallbackUrls.length) {
        itemOrUrl.fallbackUrls = [...new Set([...resolved.fallbackUrls, ...(itemOrUrl.fallbackUrls || [])])];
      }
      if (resolved.durationSeconds && !itemOrUrl.durationSeconds) {
        itemOrUrl.durationSeconds = resolved.durationSeconds;
        itemOrUrl.durationSec = resolved.durationSeconds;
      }
      if (resolved.artist && (!itemOrUrl.artist || /^(xvideos|pornhub)/i.test(itemOrUrl.artist))) {
        itemOrUrl.artist = resolved.artist;
      }
      if (Array.isArray(resolved.categories) && resolved.categories.length && (!itemOrUrl.categories || !itemOrUrl.categories.length)) {
        itemOrUrl.categories = resolved.categories;
      }
      if (resolved.headers) {
        itemOrUrl.headers = resolved.headers;
        itemOrUrl.streamHeaders = resolved.headers;
      }
      itemOrUrl._fullResolved = true;
    }

    return {
      ...resolved,
      streamUrl: finalStreamUrl,
      isHls: chosenIsHls
    };
  }

  /**
   * Resolve a direct playable full-feature 18+ stream for MovieStreamResolver fallback
   * when mainstream movie providers fail or return no playable HTTP stream.
   */
  async resolveFeatureMatch({ title, year = null, preferredHeight = 720, signal = null } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || isBlockedAdultText(cleanTitle)) return null;

    const norm = normalizeAdultMovieQuery(cleanTitle);
    const yearSuffix = cleanTitle.match(/\b((?:19\d{2}|20[0-3]\d))\b\s*$/);
    const targetYear = year || (yearSuffix ? Number(yearSuffix[1]) : null);
    const matchTarget = norm.primaryQuery || cleanTitle;

    const searchRes = await this.searchAdultMovies({
      query: matchTarget,
      limit: 12,
      minMinutes: 20,
      lazy: true,
      signal
    });

    let candidates = Array.isArray(searchRes?.results) ? searchRes.results : [];
    if (!candidates.length && norm.fallbackQueries?.[1]) {
      const retry = await this.searchAdultMovies({
        query: norm.fallbackQueries[1],
        limit: 10,
        minMinutes: 20,
        lazy: true,
        signal
      });
      candidates = Array.isArray(retry?.results) ? retry.results : [];
    }
    if (!candidates.length) return null;

    const nonFeatureClipRe = /\b(?:trailers?|teasers?|previews?|promos?|samples?|clips?|excerpts?|snippets?|highlights?|behind\s+the\s+scenes|making\s+of|bloopers?|gag\s+reel|(?:opening|final|ending|best|top|iconic|deleted|bonus|sex|fight)\s+scenes?|scene\s+\d+)\b/i;
    const escapedTarget = matchTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const stripTitleFrom = (txt = '') => (
      matchTarget.length >= 3 ? String(txt || '').replace(new RegExp(escapedTarget, 'ig'), ' ') : String(txt || '')
    );

    const scored = candidates
      .filter((cand) => !nonFeatureClipRe.test(stripTitleFrom(cand?.title || '')))
      .map((cand) => {
        const titleScore = scoreAdultTitleMatch(matchTarget, cand.title);
        if (titleScore < 50) return { cand, score: -1 };
        const dur = Number(cand.durationSeconds || cand.durationSec || 0);
        if (dur > 0 && dur < 1200) return { cand, score: -1 };
        const candYearMatch = String(cand.title || '').match(/\b(19\d\d|20\d\d)\b/);
        const candYear = cand.year || (candYearMatch ? Number(candYearMatch[1]) : null);
        if (targetYear && candYear && Math.abs(Number(targetYear) - candYear) > 2) {
          return { cand, score: titleScore - 20 };
        }
        const yearBonus = targetYear && candYear && Math.abs(Number(targetYear) - candYear) <= 1 ? 15 : 0;
        const durationBonus = dur >= 3600 ? 14 : (dur > 0 && dur < 2400 ? -8 : 0);
        const sourceBonus = cand.sourceKey === 'fullxcinema' ? 14 : (cand.sourceKey === 'pandamovies' ? 10 : (cand.sourceKey === 'eporner' ? 8 : 4));
        return { cand, score: titleScore + yearBonus + durationBonus + sourceBonus };
      })
      .filter((x) => x.score >= 52)
      .sort((a, b) => b.score - a.score);

    const shouldVerifyReachable = this.fetch === fetch;
    for (const { cand } of scored.slice(0, 5)) {
      const resolved = await this.resolveStream(cand, { preferredHeight, signal }).catch(() => null);
      if (!resolved?.streamUrl || !/^https?:\/\//i.test(resolved.streamUrl)) continue;
      if (/(?:^|[_./-])(?:(?:index_)?previews?|trailers?|teasers?|samples?|clips?)(?:[_./-]|$)/i.test(resolved.streamUrl)) continue;
      const resolvedDur = Number(resolved.durationSeconds || 0);
      if (resolvedDur > 0 && resolvedDur < 1200) continue;
      const headers = resolved.headers || cand.streamHeaders || cand.headers || {};

      let finalUrl = resolved.streamUrl;
      if (shouldVerifyReachable) {
        const pool = [...new Set([resolved.streamUrl, ...(resolved.fallbackUrls || [])].filter((u) => u && /^https?:\/\//i.test(u)))];
        let working = null;
        for (const u of pool.slice(0, 4)) {
          if (await probeReachableStreamUrl(u, headers, this.fetch)) {
            working = u;
            break;
          }
        }
        if (!working) continue;
        finalUrl = working;
      }

      const isHls = /\.m3u8(\?|$)/i.test(finalUrl) || (finalUrl === resolved.streamUrl && Boolean(resolved.isHls));
      const bestVar = Array.isArray(resolved.variants) && resolved.variants.find((v) => v.url === finalUrl);
      return {
        url: finalUrl,
        headers,
        format: isHls ? 'hls' : 'mp4',
        isHls,
        durationSeconds: resolved.durationSeconds || cand.durationSeconds || 4500,
        qualityLabel: bestVar?.qualityLabel || (isHls ? 'HLS' : 'HD MP4'),
        source: `adult_${cand.sourceKey || 'cinema'}`,
        pageUrl: cand.pageUrl,
        title: cand.title
      };
    }
    return null;
  }
}

export const defaultAdultCatalog = new AdultCatalog();
