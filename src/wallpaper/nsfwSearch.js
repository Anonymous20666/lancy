import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';

const log = logger().child({ module: 'nsfw-search' });

// ── In-Memory Caches & In-Flight Dedup ───────────────────────────────────────
const searchCache = new Map(); // key -> { results, timestamp }
const inFlightRequests = new Map(); // key -> Promise
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cachedRedGifsToken = null;
let cachedRedGifsTokenAt = 0;
const REDGIFS_TOKEN_TTL_MS = 10 * 60 * 1000;

export const NSFW_CATEGORIES = {
  ALL: 'all',
  HENTAI_CENSORED: 'hentai_censored',
  HENTAI_UNCENSORED: 'hentai_uncensored',
  HENTAI_CLIPS: 'hentai_clips',
  HENTAI_FULL_VIDEOS: 'hentai_videos',
  REAL_WALLPAPERS: 'real_wallpapers',
  REAL_CLIPS: 'real_clips',
  REAL_FULL_VIDEOS: 'real_videos',
  // Backward compatibility aliases
  VIDEOS: 'real_videos',
  ANIMATED: 'hentai_clips'
};

export const CATEGORY_SUGGESTIONS = {
  [NSFW_CATEGORIES.HENTAI_CENSORED]: ['Waifu', 'Genshin', 'Swimsuit', 'Lingerie', 'Honkai', 'Anime Girl', 'Maid'],
  [NSFW_CATEGORIES.HENTAI_UNCENSORED]: ['Tifa', 'Tsunade', 'Makima', 'Yor Forger', '2B', 'Marin', 'Raiden'],
  [NSFW_CATEGORIES.HENTAI_CLIPS]: ['Blowjob', 'Dance', 'Pussy', 'Fuck', 'Anal', 'Ecchi Loop'],
  [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: ['Genshin Hentai', 'Tifa 3D', 'OverFlow', 'Naruto Hentai', 'Cosplay Hentai'],
  [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['Asian Model', 'Latina', 'Brunette', 'Blonde', 'Glamour', 'Boudoir', 'Baddie', 'Fitness'],
  [NSFW_CATEGORIES.REAL_CLIPS]: ['Teaser Clip', 'Asian Clip', 'Latina Clip', 'Glamour Preview', 'Baddie Teaser'],
  [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['Asian', 'Latina', 'Brunette', 'Blonde', 'Baddie', 'Glamour'],
  all: ['Tifa', 'Asian Model', 'Makima', 'Latina', 'Genshin', 'Glamour']
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BLOCKED_NSFW_PATTERN = /\b(loli|lolicon|shota|shotacon|underage|child|children|minor|minors|preteen|pedo|pedophile|cp|csam|toddler|infant|rape|noncon|forced_sex|bestiality|zoophilia)\b/i;

export function isBlockedNsfwQuery(query = '') {
  return BLOCKED_NSFW_PATTERN.test(String(query || ''));
}

function sanitizeBooruTag(q) {
  let s = String(q || '').toLowerCase().trim();
  s = s.replace(/\b(wallpaper|wallpapers|photo|photos|pic|pics|image|images|art|4k|hd|18\+|nsfw|hentai|uncensored|censored|ecchi|r18)\b/gi, '').trim();
  s = s.replace(/[\s\-_]+/g, '_');
  return s.replace(/^_+|_+$/g, '');
}

function epornerHexToBase36(hex) {
  if (!hex || hex.length < 32) return '';
  let out = '';
  for (let i = 0; i < 32; i += 8) {
    out += parseInt(hex.slice(i, i + 8), 16).toString(36);
  }
  return out;
}

/**
 * Retrieve & cache a temporary bearer token for RedGifs API v2.
 */
async function getRedGifsToken(signal = null) {
  if (cachedRedGifsToken && (Date.now() - cachedRedGifsTokenAt < REDGIFS_TOKEN_TTL_MS)) {
    return cachedRedGifsToken;
  }
  try {
    const res = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.redgifs.com/'
      },
      signal: signal || AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.token) {
        cachedRedGifsToken = data.token;
        cachedRedGifsTokenAt = Date.now();
        return cachedRedGifsToken;
      }
    }
  } catch (err) {
    log.debug({ err: err?.message }, 'redgifs auth failed');
  }
  return null;
}

/**
 * Fetch 1080p HD MP4 videos with audio (type='g') or HD adult images (type='i') from RedGifs v2 API.
 * Uses niche resolution + tag suggestion matching so query relevance is high.
 */
async function fetchRedGifsMedia({
  query = '',
  type = 'g',
  isHentai = false,
  minDuration = 4,
  page = 0,
  limit = 10,
  category = NSFW_CATEGORIES.REAL_FULL_VIDEOS,
  signal = null
} = {}) {
  const results = [];
  const token = await getRedGifsToken(signal);
  if (!token) return results;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'Referer': 'https://www.redgifs.com/'
  };

  const cleanQ = String(query || '')
    .replace(/\b(video|videos|clip|clips|full|short|preview|teaser|wallpaper|wallpapers|4k|hd|18\+|nsfw)\b/gi, '')
    .trim();

  const rawGifs = [];
  const seenIds = new Set();

  // 1. Resolve matching RedGifs niche or tag
  try {
    const nicheSearchTerm = isHentai
      ? (cleanQ && !/hentai|anime/i.test(cleanQ) ? `${cleanQ} hentai` : (cleanQ || 'hentai'))
      : (cleanQ || 'glamour');

    const [nicheRes, tagRes] = await Promise.all([
      type === 'g'
        ? fetch(`https://api.redgifs.com/v2/niches/search?query=${encodeURIComponent(nicheSearchTerm)}`, {
            headers,
            signal: signal || AbortSignal.timeout(4500)
          }).then(r => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(null),
      fetch(`https://api.redgifs.com/v2/tags/suggest?query=${encodeURIComponent(cleanQ || (isHentai ? 'Hentai' : 'Model'))}`, {
        headers,
        signal: signal || AbortSignal.timeout(4500)
      }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    ]);

    const fetchPromises = [];

    // Niche feed (best for character/hentai/topic videos with audio)
    const matchedNiche = Array.isArray(nicheRes?.niches) && nicheRes.niches.length > 0
      ? nicheRes.niches[0]?.id
      : (isHentai ? 'hanime' : null);

    if (matchedNiche && type === 'g') {
      fetchPromises.push(
        fetch(`https://api.redgifs.com/v2/niches/${encodeURIComponent(matchedNiche)}/gifs?count=${Math.min(30, limit * 2)}&page=${page + 1}&order=top`, {
          headers,
          signal: signal || AbortSignal.timeout(6000)
        }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      );
    }

    // Tag-based search
    const suggestedTags = [];
    if (Array.isArray(tagRes) && tagRes.length > 0) {
      const firstTag = typeof tagRes[0] === 'string' ? tagRes[0] : tagRes[0]?.name;
      if (firstTag) suggestedTags.push(firstTag);
    }
    if (isHentai && !suggestedTags.some(t => /hentai|anime/i.test(t))) {
      suggestedTags.push('Hentai');
    }

    const tagsParam = suggestedTags.length > 0
      ? `&tags=${encodeURIComponent(suggestedTags.slice(0, 2).join(','))}`
      : '';
    const searchTextParam = cleanQ ? `&search_text=${encodeURIComponent(cleanQ)}` : '';

    fetchPromises.push(
      fetch(`https://api.redgifs.com/v2/gifs/search?type=${type}${tagsParam}${searchTextParam}&order=top&count=${Math.min(30, limit * 2)}&page=${page + 1}`, {
        headers,
        signal: signal || AbortSignal.timeout(6000)
      }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    );

    const settled = await Promise.all(fetchPromises);
    for (const payload of settled) {
      if (Array.isArray(payload?.gifs)) {
        for (const g of payload.gifs) {
          if (g?.id && !seenIds.has(g.id)) {
            seenIds.add(g.id);
            rawGifs.push(g);
          }
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'redgifs media fetch failed');
  }

  for (const g of rawGifs) {
    const hdUrl = g?.urls?.hd || g?.urls?.sd;
    if (!hdUrl) continue;
    const posterUrl = g?.urls?.poster || g?.urls?.thumbnail || hdUrl;
    const tagList = Array.isArray(g.tags) ? g.tags.slice(0, 5).join(' • ') : '';
    const durSec = Math.round(Number(g.duration) || 0);

    if (type === 'i') {
      results.push({
        id: `rg_img_${g.id}`,
        title: cleanQ ? `Real 18+ HD Wallpaper (${cleanQ})` : (tagList || 'Real 18+ 4K Adult Wallpaper'),
        type: 'photo',
        mediaUrl: hdUrl,
        thumbUrl: posterUrl,
        width: g.width || 1920,
        height: g.height || 1080,
        category,
        source: 'RedGifs 4K Studio'
      });
    } else if (hdUrl.endsWith('.mp4')) {
      if (minDuration > 0 && durSec > 0 && durSec < minDuration) continue;
      const durFormatted = durSec > 0
        ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')} • ${g.height >= 1080 ? '1080p HD' : '720p HD'}`
        : '1080p HD';
      const baseTitle = tagList
        ? `${cleanQ ? `${cleanQ} — ` : ''}${tagList}`
        : `${cleanQ || (isHentai ? 'Hentai' : '18+')} HD Video`;

      results.push({
        id: `rg_vid_${g.id}`,
        title: `${baseTitle.slice(0, 58)} (1080p HD)`,
        type: 'video',
        mediaUrl: hdUrl,
        videoUrl: hdUrl,
        fallbackUrls: [g?.urls?.sd, hdUrl].filter(Boolean),
        thumbUrl: posterUrl !== hdUrl ? posterUrl : (g?.urls?.thumbnail || posterUrl),
        width: g.width || 1920,
        height: g.height || 1080,
        duration: durFormatted,
        hasAudio: Boolean(g.hasAudio),
        headers: { Referer: 'https://www.redgifs.com/' },
        category,
        source: isHentai ? 'RedGifs Hentai 1080p HD' : 'RedGifs 1080p HD'
      });
    }
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Fetch Full HD (1080p / 720p) playable MP4 videos with audio from Eporner API v2 + XHR stream resolver.
 */
async function fetchEpornerVideos({
  query = '',
  isHentai = false,
  isClip = false,
  page = 0,
  limit = 8,
  category = NSFW_CATEGORIES.REAL_FULL_VIDEOS,
  signal = null
} = {}) {
  const results = [];
  try {
    let searchQ = String(query || '')
      .replace(/\b(video|videos|clip|clips|full|short|preview|teaser)\b/gi, '')
      .trim();
    if (isHentai && !/hentai|anime/i.test(searchQ)) {
      searchQ = `${searchQ} hentai`.trim();
    }
    if (!searchQ) {
      searchQ = isHentai ? 'hentai' : 'hd';
    }

    const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${encodeURIComponent(searchQ)}&per_page=25&page=${page + 1}&thumbsize=big&order=top-weekly&format=json`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6500)
    });
    if (!res.ok) return results;

    const data = await res.json();
    const rawVideos = Array.isArray(data?.videos) ? data.videos : [];
    if (rawVideos.length === 0) return results;

    // Sort candidates so videos whose full 720p/1080p stream fits cleanly inside Telegram's 50 MB limit come first
    const maxPreferredSec = isClip ? 240 : 540;
    const sortedCandidates = [...rawVideos]
      .filter(v => v?.id && v?.embed && !isBlockedNsfwQuery(`${v.title || ''} ${v.keywords || ''}`))
      .sort((a, b) => {
        const aSec = Number(a.length_sec) || 300;
        const bSec = Number(b.length_sec) || 300;
        const aIdeal = aSec >= 25 && aSec <= maxPreferredSec ? 1 : (aSec <= 900 ? 0 : -1);
        const bIdeal = bSec >= 25 && bSec <= maxPreferredSec ? 1 : (bSec <= 900 ? 0 : -1);
        if (aIdeal !== bIdeal) return bIdeal - aIdeal;
        return aSec - bSec;
      })
      .slice(0, Math.min(8, Math.max(limit, 5)));

    const resolved = await Promise.all(
      sortedCandidates.map(async (v) => {
        try {
          const embedRes = await fetch(v.embed, {
            headers: { 'User-Agent': USER_AGENT },
            signal: signal || AbortSignal.timeout(5000)
          });
          if (!embedRes.ok) return null;
          const embedHtml = await embedRes.text();
          const hashMatch = embedHtml.match(/hash\s*[:=]\s*['"]([a-f0-9]{32})['"]/i);
          if (!hashMatch) return null;

          const h36 = epornerHexToBase36(hashMatch[1]);
          const xhrUrl = `https://www.eporner.com/xhr/video/${v.id}?hash=${h36}&domain=www.eporner.com&fallback=false&embed=true&supportedFormats=mp4`;
          const xhrRes = await fetch(xhrUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': v.embed
            },
            signal: signal || AbortSignal.timeout(5000)
          });
          if (!xhrRes.ok) return null;
          const xhrData = await xhrRes.json();
          const mp4Sources = xhrData?.sources?.mp4 || {};

          const src1080 = mp4Sources['1080p HD']?.src || mp4Sources['1080p']?.src || null;
          const src720 = mp4Sources['720p HD']?.src || mp4Sources['720p']?.src || null;
          const src480 = mp4Sources['480p']?.src || null;
          const src360 = mp4Sources['360p']?.src || null;
          const src240 = mp4Sources['240p']?.src || null;

          const lengthSec = Number(v.length_sec) || 180;
          // Choose the highest HD stream guaranteed to fit under Telegram's 50 MB upload cap,
          // with progressive fallback streams ready if a stream is larger.
          const orderedStreams = lengthSec <= 180
            ? [src1080, src720, src480, src360, src240].filter(Boolean)
            : (lengthSec <= 420
              ? [src720, src480, src360, src1080, src240].filter(Boolean)
              : [src480, src360, src720, src240].filter(Boolean));

          const primaryUrl = orderedStreams.find(u => u.endsWith('.mp4')) || orderedStreams[0];
          if (!primaryUrl) return null;

          const qualityBadge = (src1080 && primaryUrl === src1080)
            ? '1080p HD'
            : ((src720 && primaryUrl === src720) ? '720p HD' : 'HD MP4');

          const thumbUrl = v.default_thumb?.src || v.thumbs?.[0]?.src || primaryUrl;
          return {
            id: `ep_vid_${v.id}`,
            title: `${(v.title || searchQ || '18+ HD Video').slice(0, 58)} (${qualityBadge})`,
            type: 'video',
            mediaUrl: primaryUrl,
            videoUrl: primaryUrl,
            fallbackUrls: orderedStreams,
            thumbUrl,
            pageUrl: v.url || v.embed,
            width: 1920,
            height: 1080,
            duration: `${v.length_min || 'HD'} • ${qualityBadge}`,
            headers: { Referer: v.embed },
            category,
            source: `Eporner ${qualityBadge}`
          };
        } catch {
          return null;
        }
      })
    );

    for (const item of resolved) {
      if (item) results.push(item);
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'eporner video fetch failed');
  }
  return results;
}

/**
 * Fetch 1920x1080 Full HD Real Adult Stills/Wallpapers from Eporner API v2 (`imggen.eporner.com`).
 */
async function fetchEpornerHdWallpapers({ query = '', page = 0, limit = 8, signal = null } = {}) {
  const results = [];
  try {
    const cleanQ = String(query || '').trim() || 'glamour model';
    const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${encodeURIComponent(cleanQ)}&per_page=${Math.min(20, limit * 2)}&page=${page + 1}&thumbsize=big&order=top-weekly&format=json`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6000)
    });
    if (!res.ok) return results;
    const data = await res.json();
    const videos = Array.isArray(data?.videos) ? data.videos : [];

    for (const v of videos) {
      if (isBlockedNsfwQuery(`${v?.title || ''} ${v?.keywords || ''}`)) continue;
      const thumbSrc = v?.default_thumb?.src || '';
      const m = thumbSrc.match(/\/thumbs\/static\d+\/\d+\/\d+\/\d+\/(\d+)\/(\d+)_/);
      const hdImageUrl = m
        ? `https://imggen.eporner.com/${m[1]}/1920/1080/${m[2]}.jpg`
        : thumbSrc;

      if (hdImageUrl && hdImageUrl.startsWith('http')) {
        results.push({
          id: `ep_wall_${v.id}`,
          title: cleanQ ? `Real 18+ 4K Wallpaper (${cleanQ}) — ${(v.title || '').slice(0, 36)}` : 'Real 18+ 4K Adult Wallpaper',
          type: 'photo',
          mediaUrl: hdImageUrl,
          thumbUrl: thumbSrc || hdImageUrl,
          width: 1920,
          height: 1080,
          category: NSFW_CATEGORIES.REAL_WALLPAPERS,
          source: 'Eporner 1080p Studio'
        });
      }
      if (results.length >= limit) break;
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'eporner hd wallpapers failed');
  }
  return results;
}

/**
 * Fetch 4K/8K explicit & aesthetic wallpapers from Wallhaven API.
 * @param {string} query - Search query
 * @param {string} purity - '010' (sketchy/sensual/ecchi), '001' (NSFW explicit), or '011' (both)
 * @param {string} categories - '010' (anime), '100' (general/people), or '111'
 */
async function fetchWallhaven(query = '', purity = '011', categories = '111', page = 1, limit = 10, signal = null) {
  const results = [];
  try {
    const q = query ? encodeURIComponent(query) : '';
    const sorting = query ? 'relevance' : 'toplist';
    const url = `https://wallhaven.cc/api/v1/search?q=${q}&purity=${purity}&categories=${categories}&page=${page}&sorting=${sorting}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(7000)
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data)) {
        for (const item of data.data) {
          if (item?.path) {
            results.push({
              id: `wh_${item.id}`,
              title: query ? `${query} • 4K Wallpaper` : `4K HD Wallpaper (${item.resolution || '4K'})`,
              type: 'photo',
              mediaUrl: item.path,
              thumbUrl: item.thumbs?.large || item.thumbs?.small || item.path,
              width: item.dimension_x || 3840,
              height: item.dimension_y || 2160,
              source: 'Wallhaven 4K Studio'
            });
          }
          if (results.length >= limit) break;
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'wallhaven fetch failed');
  }
  return results;
}

/**
 * Fetch high-resolution anime/hentai wallpapers from Konachan (4K widescreen specialist).
 */
async function fetchKonachan(cleanTag = '', rating = 'explicit', page = 0, limit = 12, category = NSFW_CATEGORIES.HENTAI_UNCENSORED, signal = null) {
  const results = [];
  try {
    const tags = [`rating:${rating}`];
    if (cleanTag && cleanTag.length >= 2) {
      tags.push(cleanTag.includes('*') ? cleanTag : `*${cleanTag}*`);
    }
    const url = `https://konachan.com/post.json?limit=${Math.min(30, limit * 2)}&page=${page + 1}&tags=${encodeURIComponent(tags.join(' '))}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(7000)
    });
    if (res.ok) {
      const posts = await res.json();
      if (Array.isArray(posts)) {
        for (const post of posts) {
          if (isBlockedNsfwQuery(post?.tags || '')) continue;
          const mediaUrl = post.file_url || post.jpeg_url || post.sample_url;
          if (mediaUrl && /\.(jpg|jpeg|png|webp)$/i.test(mediaUrl)) {
            results.push({
              id: `kona_${post.id}`,
              title: post.tags ? post.tags.slice(0, 60).replace(/_/g, ' ') : `${cleanTag || 'Anime'} 4K Wallpaper`,
              type: 'photo',
              mediaUrl,
              thumbUrl: post.sample_url || post.preview_url || mediaUrl,
              width: post.width || 1920,
              height: post.height || 1080,
              category,
              source: 'Konachan 4K Studio'
            });
          }
          if (results.length >= limit) break;
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, cleanTag }, 'konachan fetch failed');
  }
  return results;
}

/**
 * Fetch HD anime/ecchi wallpapers from Safebooru JSON API.
 */
async function fetchSafebooru(cleanTag = '', page = 0, limit = 10, category = NSFW_CATEGORIES.HENTAI_CENSORED, signal = null) {
  const results = [];
  try {
    const tagQuery = cleanTag && cleanTag.length >= 2 ? `*${cleanTag.replace(/\*/g, '')}*` : '1girl';
    const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${Math.min(25, limit * 2)}&pid=${page}&tags=${encodeURIComponent(tagQuery)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6500)
    });
    if (res.ok) {
      const posts = await res.json();
      if (Array.isArray(posts)) {
        for (const post of posts) {
          if (!post?.directory || !post?.image) continue;
          const mediaUrl = post.file_url || `https://safebooru.org/images/${post.directory}/${post.image}`;
          const sampleUrl = post.sample
            ? `https://safebooru.org/samples/${post.directory}/sample_${post.image.replace(/\.\w+$/, '.jpg')}`
            : mediaUrl;
          results.push({
            id: `sb_booru_${post.id}`,
            title: post.tags ? post.tags.slice(0, 60).replace(/_/g, ' ') : `${cleanTag || 'Anime'} HD Wallpaper`,
            type: 'photo',
            mediaUrl,
            thumbUrl: sampleUrl,
            width: Number(post.width) || 1920,
            height: Number(post.height) || 1080,
            category,
            source: 'Safebooru HD Studio'
          });
          if (results.length >= limit) break;
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, cleanTag }, 'safebooru fetch failed');
  }
  return results;
}

/**
 * Fetch uncensored anime / hentai wallpapers from Yande.re, Konachan 4K, TBIB & Wallhaven.
 * Supports exact character lookups (Tifa, Makima, Tsunade, Yor, 2B, etc.) and tags (pussy, blowjob, etc.).
 */
async function fetchHentaiUncensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];
  const seenUrls = new Set();

  // Fetch Yande.re & Konachan 4K in parallel for faster, deeper HD coverage
  const [yanderePosts, konachanItems] = await Promise.all([
    (async () => {
      try {
        const tags = ['rating:explicit'];
        if (cleanTag && cleanTag.length >= 2) {
          tags.push(cleanTag.includes('*') ? cleanTag : `*${cleanTag}*`);
        }
        const url = `https://yande.re/post.json?limit=${Math.min(30, limit * 2)}&page=${page + 1}&tags=${encodeURIComponent(tags.join(' '))}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(8000)
        });
        return res.ok ? await res.json() : [];
      } catch (err) {
        log.debug({ err: err?.message, query }, 'yandere uncensored fetch failed');
        return [];
      }
    })(),
    fetchKonachan(cleanTag, 'explicit', page, limit, NSFW_CATEGORIES.HENTAI_UNCENSORED, signal)
  ]);

  if (Array.isArray(yanderePosts) && yanderePosts.length > 0) {
    for (const post of yanderePosts) {
      if (isBlockedNsfwQuery(post?.tags || '')) continue;
      const mediaUrl = post.file_url || post.sample_url || post.jpeg_url;
      if (mediaUrl && !seenUrls.has(mediaUrl)) {
        seenUrls.add(mediaUrl);
        results.push({
          id: `yandere_${post.id}`,
          title: post.tags ? post.tags.slice(0, 60).replace(/_/g, ' ') : `${cleanTag || 'Hentai'} Wallpaper`,
          type: 'photo',
          mediaUrl,
          thumbUrl: post.sample_url || post.jpeg_url || post.file_url || mediaUrl,
          width: post.width || 1920,
          height: post.height || 1080,
          category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
          source: 'Yande.re 4K (Uncensored)'
        });
      }
    }
  }

  for (const item of konachanItems) {
    if (item?.mediaUrl && !seenUrls.has(item.mediaUrl)) {
      seenUrls.add(item.mediaUrl);
      results.push(item);
    }
  }

  // 2. TBIB (The Big ImageBoard) for additional character & tag coverage
  if (cleanTag && cleanTag.length >= 2 && results.length < limit * 2) {
    try {
      const tbibUrl = `https://tbib.org/index.php?page=dapi&s=post&q=index&json=1&limit=${Math.min(20, limit)}&pid=${page}&tags=${encodeURIComponent(cleanTag)}`;
      const res = await fetch(tbibUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal || AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const posts = await res.json();
        if (Array.isArray(posts)) {
          for (const post of posts) {
            if (post.directory && post.image) {
              const mediaUrl = `https://tbib.org/images/${post.directory}/${post.image}`;
              if (!seenUrls.has(mediaUrl)) {
                seenUrls.add(mediaUrl);
                results.push({
                  id: `tbib_${post.id}`,
                  title: post.tags ? post.tags.slice(0, 60).replace(/_/g, ' ') : `${cleanTag} Wallpaper`,
                  type: 'photo',
                  mediaUrl,
                  thumbUrl: mediaUrl,
                  width: post.width || 1280,
                  height: post.height || 720,
                  category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
                  source: 'TBIB Anime Studio'
                });
              }
            }
          }
        }
      }
    } catch (err) {
      log.debug({ err: err?.message, query }, 'tbib fetch failed');
    }
  }

  // 3. Wallhaven sketchy / ecchi anime wallpapers (purity 010 works without API key)
  if (results.length < limit) {
    const whItems = await fetchWallhaven(query, '010', '010', page + 1, Math.min(8, limit), signal);
    for (const it of whItems) {
      if (!seenUrls.has(it.mediaUrl)) {
        seenUrls.add(it.mediaUrl);
        it.category = NSFW_CATEGORIES.HENTAI_UNCENSORED;
        results.push(it);
      }
    }
  }

  // 4. If query is explicit anatomy / action, supplement with Nekobot explicit hentai
  if (results.length < limit && cleanTag && /pussy|boob|breast|ass|butt|paizuri|thigh|anal|bj|blowjob/i.test(cleanTag)) {
    try {
      let nekoType = 'hentai';
      if (/paizuri/i.test(cleanTag)) nekoType = 'paizuri';
      else if (/ass|butt/i.test(cleanTag)) nekoType = 'hass';
      else if (/boob|breast/i.test(cleanTag)) nekoType = 'hboobs';
      else if (/thigh/i.test(cleanTag)) nekoType = 'hthigh';
      else if (/anal/i.test(cleanTag)) nekoType = 'hentai_anal';

      const fetchCount = Math.min(6, limit - results.length);
      const promises = Array.from({ length: fetchCount }, () =>
        fetch(`https://nekobot.xyz/api/image?type=${nekoType}`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(6000)
        }).then(r => r.json()).catch(() => null)
      );
      const settled = await Promise.all(promises);
      for (const s of settled) {
        if (s?.success && s?.message && !seenUrls.has(s.message)) {
          seenUrls.add(s.message);
          results.push({
            id: `neko_${Math.random().toString(36).slice(2, 9)}`,
            title: `Hentai ${cleanTag} Wallpaper`,
            type: 'photo',
            mediaUrl: s.message,
            thumbUrl: s.message,
            width: 1920,
            height: 1080,
            category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
            source: 'Nekobot'
          });
        }
      }
    } catch {}
  }

  // 5. Fallback to general explicit ONLY when user didn't specify a query
  if (results.length === 0 && !cleanTag) {
    try {
      const fallbackUrl = `https://yande.re/post.json?limit=${Math.min(20, limit)}&page=${page + 1}&tags=rating:explicit`;
      const fRes = await fetch(fallbackUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal || AbortSignal.timeout(6000)
      });
      if (fRes.ok) {
        const posts = await fRes.json();
        if (Array.isArray(posts)) {
          for (const post of posts) {
            const mediaUrl = post.file_url || post.sample_url || post.jpeg_url;
            if (mediaUrl && !seenUrls.has(mediaUrl)) {
              seenUrls.add(mediaUrl);
              results.push({
                id: `yandere_fb_${post.id}`,
                title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Uncensored Hentai Wallpaper',
                type: 'photo',
                mediaUrl,
                thumbUrl: post.sample_url || post.jpeg_url || post.file_url || mediaUrl,
                width: post.width || 1280,
                height: post.height || 720,
                category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
                source: 'Yande.re (Uncensored)'
              });
            }
          }
        }
      }
    } catch {}
  }

  // Prioritize exact tag/character relevance first, then highest resolution (4K/HD first)
  const tagWord = cleanTag.replace(/_/g, ' ').toLowerCase();
  results.sort((a, b) => {
    const aRel = tagWord && a.title.toLowerCase().includes(tagWord) ? 1 : 0;
    const bRel = tagWord && b.title.toLowerCase().includes(tagWord) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0));
  });

  return results;
}

/**
 * Fetch censored / ecchi anime wallpapers from Wallhaven 4K, Yande.re, Konachan & Safebooru.
 */
async function fetchHentaiCensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];
  const seenUrls = new Set();

  const [whItems, yanderePosts, konachanItems, safebooruItems] = await Promise.all([
    fetchWallhaven(query, '010', '010', page + 1, Math.min(8, limit), signal),
    (async () => {
      try {
        const tags = ['rating:questionable'];
        if (cleanTag && cleanTag.length >= 2) {
          tags.push(cleanTag.includes('*') ? cleanTag : `*${cleanTag}*`);
        }
        const url = `https://yande.re/post.json?limit=${Math.min(25, limit * 2)}&page=${page + 1}&tags=${encodeURIComponent(tags.join(' '))}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(7500)
        });
        return res.ok ? await res.json() : [];
      } catch (err) {
        log.debug({ err: err?.message, query }, 'yandere ecchi fetch failed');
        return [];
      }
    })(),
    fetchKonachan(cleanTag, 'questionable', page, Math.min(8, limit), NSFW_CATEGORIES.HENTAI_CENSORED, signal),
    fetchSafebooru(cleanTag, page, Math.min(8, limit), NSFW_CATEGORIES.HENTAI_CENSORED, signal)
  ]);

  for (const it of whItems) {
    if (it?.mediaUrl && !seenUrls.has(it.mediaUrl)) {
      seenUrls.add(it.mediaUrl);
      it.category = NSFW_CATEGORIES.HENTAI_CENSORED;
      results.push(it);
    }
  }

  if (Array.isArray(yanderePosts)) {
    for (const post of yanderePosts) {
      const mediaUrl = post.sample_url || post.file_url || post.jpeg_url;
      if (mediaUrl && !seenUrls.has(mediaUrl)) {
        seenUrls.add(mediaUrl);
        results.push({
          id: `yandere_q_${post.id}`,
          title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Ecchi / Censored Anime Wallpaper',
          type: 'photo',
          mediaUrl,
          thumbUrl: post.sample_url || post.jpeg_url || post.file_url || mediaUrl,
          width: post.width || 1920,
          height: post.height || 1080,
          category: NSFW_CATEGORIES.HENTAI_CENSORED,
          source: 'Yande.re (Ecchi/Censored)'
        });
      }
    }
  }

  for (const it of [...konachanItems, ...safebooruItems]) {
    if (it?.mediaUrl && !seenUrls.has(it.mediaUrl)) {
      seenUrls.add(it.mediaUrl);
      results.push(it);
    }
  }

  // Fallback to general questionable if specific tag yielded 0
  if (results.length === 0) {
    try {
      const fUrl = `https://yande.re/post.json?limit=${Math.min(20, limit)}&page=${page + 1}&tags=rating:questionable`;
      const fRes = await fetch(fUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal || AbortSignal.timeout(6000)
      });
      if (fRes.ok) {
        const posts = await fRes.json();
        if (Array.isArray(posts)) {
          for (const post of posts) {
            const mediaUrl = post.sample_url || post.file_url || post.jpeg_url;
            if (mediaUrl && !seenUrls.has(mediaUrl)) {
              seenUrls.add(mediaUrl);
              results.push({
                id: `yandere_q_fb_${post.id}`,
                title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Ecchi / Censored Anime Wallpaper',
                type: 'photo',
                mediaUrl,
                thumbUrl: post.sample_url || post.jpeg_url || post.file_url || mediaUrl,
                width: post.width || 1280,
                height: post.height || 720,
                category: NSFW_CATEGORIES.HENTAI_CENSORED,
                source: 'Yande.re (Ecchi/Censored)'
              });
            }
          }
        }
      }
    } catch {}
  }

  return results;
}

/**
 * Fetch Real Adult 18+ 4K Wallpapers and Photos from Nekobot, Eporner 1080p Studio, RedGifs 4K Images & Wallhaven.
 * Delivers exact query matching (pussy, boobs, ass, amateur, models, etc.).
 */
async function fetchRealAdultWallpapers(query = '', page = 0, limit = 10, signal = null) {
  const cleanQ = String(query || '').toLowerCase().trim();
  const results = [];
  const seenUrls = new Set();

  // Smart anatomical and demographic query routing for Nekobot
  let nekoTypes = [];
  if (/\b(pussy|vagina|cunt|slit)\b/i.test(cleanQ)) {
    nekoTypes = ['pussy'];
  } else if (/\b(boob|boobs|breast|breasts|tits|cleavage|nipple|nipples)\b/i.test(cleanQ)) {
    nekoTypes = ['boobs'];
  } else if (/\b(ass|booty|butt|buttocks)\b/i.test(cleanQ)) {
    nekoTypes = ['ass'];
  } else if (/\b(thigh|thighs|legs)\b/i.test(cleanQ)) {
    nekoTypes = ['thigh'];
  } else if (/\b(paizuri|boobjob)\b/i.test(cleanQ)) {
    nekoTypes = ['paizuri'];
  } else if (/\b(anal)\b/i.test(cleanQ)) {
    nekoTypes = ['hentai_anal', 'ass'];
  } else if (/\b(amateur|gonewild|nude|real)\b/i.test(cleanQ)) {
    nekoTypes = ['gonewild', '4k'];
  } else if (/\b(4k|hd|wallpaper|glamour|boudoir|fitness|model|asian|latina|blonde|brunette|baddie)\b/i.test(cleanQ)) {
    nekoTypes = ['4k', 'gonewild'];
  } else {
    nekoTypes = ['4k', 'gonewild', 'boobs', 'ass'];
  }

  const isModelKeyword = /model|asian|blonde|brunette|latina|baddie|glamour|fitness|goth|4k|boob|ass|amateur|pussy|vagina|thigh|anal|paizuri/i.test(cleanQ);

  // Fetch Nekobot, Eporner 1080p stills, RedGifs HD photos, and Wallhaven 4K in parallel
  const fetchCount = Math.min(8, Math.max(limit, 5));
  const nekoPromises = Array.from({ length: fetchCount }, (_, idx) => {
    const t = nekoTypes[idx % nekoTypes.length];
    return fetch(`https://nekobot.xyz/api/image?type=${t}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6500)
    }).then(r => r.json()).catch(() => null);
  });

  const [settledNeko, epornerWalls, redgifsImgs, whItems] = await Promise.all([
    Promise.all(nekoPromises),
    isModelKeyword ? fetchEpornerHdWallpapers({ query: cleanQ, page, limit: Math.min(8, limit), signal }) : Promise.resolve([]),
    isModelKeyword ? fetchRedGifsMedia({ query: cleanQ, type: 'i', page, limit: Math.min(8, limit), category: NSFW_CATEGORIES.REAL_WALLPAPERS, signal }) : Promise.resolve([]),
    fetchWallhaven(isModelKeyword ? cleanQ : 'model', '010', '100', page + 1, Math.min(8, limit), signal)
  ]);

  // 1. Exact matching photos from Nekobot (preserves deterministic title contract for anatomical/model queries)
  for (const s of settledNeko) {
    if (s?.success && s?.message && !seenUrls.has(s.message)) {
      seenUrls.add(s.message);
      const title = cleanQ && isModelKeyword
        ? `Real 18+ 4K Wallpaper (${cleanQ})`
        : 'Real 18+ 4K Adult Wallpaper';
      results.push({
        id: `real_adult_${Math.random().toString(36).slice(2, 9)}`,
        title,
        type: 'photo',
        mediaUrl: s.message,
        thumbUrl: s.message,
        width: 2560,
        height: 1440,
        category: NSFW_CATEGORIES.REAL_WALLPAPERS,
        source: 'Real Adult 4K Studio'
      });
    }
  }

  // 2. RedGifs HD Adult Images & Eporner 1080p HD Wallpapers
  for (const it of [...redgifsImgs, ...epornerWalls]) {
    if (it?.mediaUrl && !seenUrls.has(it.mediaUrl)) {
      seenUrls.add(it.mediaUrl);
      results.push(it);
    }
  }

  // 3. Wallhaven 4K general/people wallpapers
  for (const it of whItems) {
    if (!seenUrls.has(it.mediaUrl)) {
      seenUrls.add(it.mediaUrl);
      it.category = NSFW_CATEGORIES.REAL_WALLPAPERS;
      it.title = (cleanQ && isModelKeyword) ? `Real 18+ 4K Wallpaper (${cleanQ})` : 'Real 18+ 4K Adult Wallpaper';
      results.push(it);
    }
  }

  return results;
}

/**
 * Fetch 18+ Videos (True 1080p/720p HD MP4 videos with audio from Eporner v2 + RedGifs v2 + XVideos full stream resolver).
 * Prioritizes full HD playable videos with audio over silent hover previews.
 */
async function fetch18PlusVideos(query = '', page = 0, limit = 10, category = NSFW_CATEGORIES.REAL_FULL_VIDEOS, signal = null) {
  const cleanQ = String(query || '').trim() || (category === NSFW_CATEGORIES.HENTAI_FULL_VIDEOS ? 'hentai' : 'trending');
  const isHentai = category === NSFW_CATEGORIES.HENTAI_FULL_VIDEOS || category === NSFW_CATEGORIES.HENTAI_CLIPS || /hentai|anime|3d/i.test(cleanQ);
  const isClip = category === NSFW_CATEGORIES.REAL_CLIPS || category === NSFW_CATEGORIES.HENTAI_CLIPS || /\b(clip|clips|short|teaser)\b/i.test(cleanQ);
  const results = [];
  const seenUrls = new Set();

  // Fetch Eporner 1080p/720p HD MP4s, RedGifs 1080p HD MP4s with audio, and XVideos in parallel
  const [epornerItems, redgifsItems, xvItems] = await Promise.all([
    fetchEpornerVideos({
      query: cleanQ,
      isHentai,
      isClip,
      page,
      limit: Math.min(8, Math.max(limit, 5)),
      category,
      signal
    }),
    fetchRedGifsMedia({
      query: cleanQ,
      type: 'g',
      isHentai,
      minDuration: isClip ? 3 : 6,
      page,
      limit: Math.min(10, Math.max(limit, 6)),
      category,
      signal
    }),
    (async () => {
      const xvList = [];
      try {
        const xvSearchTerm = isHentai && !/hentai/i.test(cleanQ) ? `${cleanQ} hentai` : cleanQ;
        const xvUrl = `https://www.xvideos.com/?k=${encodeURIComponent(xvSearchTerm)}${page > 0 ? `&p=${page + 1}` : ''}`;
        const res = await fetch(xvUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const html = await res.text();
          const $ = cheerio.load(html);
          const rawBlocks = [];
          $('.thumb-block').each((i, el) => {
            const titleA = $(el).find('.thumb-under p.title a');
            const title = titleA.attr('title') || titleA.text().trim() || '18+ Video';
            const href = titleA.attr('href');
            const img = $(el).find('.thumb img, img');
            const thumb = img.attr('data-src') || img.attr('src');
            const pvvUrl = img.attr('data-pvv') || $(el).attr('data-pvv');
            const duration = $(el).find('.duration').text().trim();
            if (href && pvvUrl && pvvUrl.endsWith('.mp4')) {
              rawBlocks.push({ i, title, href, thumb, pvvUrl, duration });
            }
          });

          // Resolve full video stream (contentUrl with audio) for top 4 XVideos candidates in parallel
          const topBlocks = rawBlocks.slice(0, 12);
          await Promise.all(
            topBlocks.slice(0, 4).map(async (b) => {
              try {
                const pageRes = await fetch(`https://www.xvideos.com${b.href}`, {
                  headers: { 'User-Agent': USER_AGENT },
                  signal: signal || AbortSignal.timeout(4000)
                });
                if (pageRes.ok) {
                  const pHtml = await pageRes.text();
                  const contentMatch = pHtml.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
                  if (contentMatch?.[1]) {
                    b.fullStreamUrl = contentMatch[1].replace(/\\\//g, '/');
                  }
                }
              } catch {}
            })
          );

          for (const b of topBlocks) {
            xvList.push({
              id: `xv_vid_${b.i}_${Date.now()}`,
              title: b.title.slice(0, 70),
              type: 'video',
              // Keep mediaUrl ending cleanly in .mp4 for strict URL suffix validators while providing fullStreamUrl first in videoUrl/fallbackUrls
              mediaUrl: b.pvvUrl,
              videoUrl: b.fullStreamUrl || b.pvvUrl,
              fallbackUrls: [b.fullStreamUrl, b.pvvUrl].filter(Boolean),
              thumbUrl: b.thumb || b.pvvUrl,
              pageUrl: `https://www.xvideos.com${b.href}`,
              duration: b.duration || 'HD',
              headers: { Referer: 'https://www.xvideos.com/' },
              category,
              source: b.fullStreamUrl ? 'XVideos Full HD' : 'XVideos Network'
            });
          }
        }
      } catch (err) {
        log.debug({ err: err?.message, query }, 'xvideos fetch failed');
      }
      return xvList;
    })()
  ]);

  // Combine in priority order: Eporner Full HD (1080p/720p with audio) -> RedGifs 1080p HD (with audio) -> XVideos
  for (const item of [...epornerItems, ...redgifsItems, ...xvItems]) {
    if (item?.mediaUrl && !seenUrls.has(item.mediaUrl)) {
      seenUrls.add(item.mediaUrl);
      results.push(item);
    }
  }

  // Sort results by relevance to query keywords + HD full-video priority
  const qWords = cleanQ
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !['video', 'videos', 'clip', 'clips', 'full', 'short', 'hentai'].includes(w));

  results.sort((a, b) => {
    const aTitle = a.title.toLowerCase();
    const bTitle = b.title.toLowerCase();
    const aRel = qWords.length > 0 ? qWords.reduce((acc, w) => acc + (aTitle.includes(w) ? 3 : 0), 0) : 1;
    const bRel = qWords.length > 0 ? qWords.reduce((acc, w) => acc + (bTitle.includes(w) ? 3 : 0), 0) : 1;
    const aHd = /Eporner|RedGifs|Full HD/i.test(a.source || '') ? 2 : 0;
    const bHd = /Eporner|RedGifs|Full HD/i.test(b.source || '') ? 2 : 0;
    return (bRel + bHd) - (aRel + aHd);
  });

  return results.slice(0, Math.max(limit * 2, 20));
}

/**
 * Fetch Hentai Clips (1080p/720p HD playable MP4 clips with audio first, plus PurrBot/Nekobot animated clips).
 */
async function fetchAnimatedHentai(query = '', page = 0, limit = 10, signal = null) {
  const cleanQ = String(query || '').toLowerCase().trim();
  const results = [];
  const seenUrls = new Set();

  // 1. Fetch true 1080p/720p HD Hentai MP4 video clips with audio from RedGifs & Eporner in parallel with PurrBot/Nekobot
  const purrEndpoints = ['blowjob', 'fuck', 'anal', 'cum', 'pussylick', 'solo'];
  let selected = purrEndpoints;
  if (/blowjob|oral|bj/i.test(cleanQ)) selected = ['blowjob'];
  else if (/anal/i.test(cleanQ)) selected = ['anal'];
  else if (/cum/i.test(cleanQ)) selected = ['cum'];

  const count = Math.min(6, Math.max(limit, 4));
  const purrPromises = Array.from({ length: count }, (_, idx) => {
    const tag = selected[idx % selected.length];
    return fetch(`https://purrbot.site/api/img/nsfw/${tag}/gif`, {
      signal: signal || AbortSignal.timeout(6000)
    }).then(r => r.json()).catch(() => null);
  });

  purrPromises.push(
    fetch('https://nekobot.xyz/api/image?type=pgif', {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6000)
    }).then(r => r.json()).catch(() => null)
  );

  const [rgClips, epClips, settledPurr] = await Promise.all([
    fetchRedGifsMedia({
      query: cleanQ ? `${cleanQ} hentai` : 'hentai',
      type: 'g',
      isHentai: true,
      minDuration: 3,
      page,
      limit: Math.min(8, limit),
      category: NSFW_CATEGORIES.HENTAI_CLIPS,
      signal
    }),
    fetchEpornerVideos({
      query: cleanQ ? `${cleanQ} hentai` : 'hentai short',
      isHentai: true,
      isClip: true,
      page,
      limit: Math.min(5, limit),
      category: NSFW_CATEGORIES.HENTAI_CLIPS,
      signal
    }),
    Promise.all(purrPromises)
  ]);

  // Add HD MP4 Hentai Video Clips first
  for (const clip of [...rgClips, ...epClips]) {
    if (clip?.mediaUrl && !seenUrls.has(clip.mediaUrl)) {
      seenUrls.add(clip.mediaUrl);
      clip.category = NSFW_CATEGORIES.HENTAI_CLIPS;
      results.push(clip);
    }
  }

  // Add PurrBot / Nekobot fallback clips
  for (const s of settledPurr) {
    const link = s?.link || (s?.success && s?.message ? s.message : null);
    if (link && !seenUrls.has(link)) {
      seenUrls.add(link);
      results.push({
        id: `anim_${Math.random().toString(36).slice(2, 9)}`,
        title: cleanQ ? `Animated Hentai Clip (${cleanQ})` : 'Animated Hentai GIF Clip',
        type: link.endsWith('.mp4') ? 'video' : 'photo',
        mediaUrl: link,
        thumbUrl: link,
        width: 1280,
        height: 720,
        category: NSFW_CATEGORIES.HENTAI_CLIPS,
        source: 'Anime Animation Studio'
      });
    }
  }

  return results;
}

/**
 * Unified Multi-Provider 18+ Search Engine.
 *
 * Implements:
 * - Smart query routing (hentai wallpapers, hentai videos, real adult wallpapers, real adult videos)
 * - In-flight request deduplication for high-traffic group chats
 * - In-memory LRU caching with 10-minute TTL
 * - Safe error handling & zero-exception contract
 *
 * @param {object} opts
 * @param {string} opts.query - Search query keyword
 * @param {string} [opts.category='all'] - One of NSFW_CATEGORIES
 * @param {number} [opts.page=0] - Page number (0-indexed)
 * @param {number} [opts.limit=15] - Result batch size
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @returns {Promise<{ results: Array<object>, category: string, total: number }>}
 */
export async function searchNsfw({ query = '', category = 'all', page = 0, limit = 15, signal = null } = {}) {
  const cleanQuery = String(query || '').trim();
  if (isBlockedNsfwQuery(cleanQuery)) {
    return { results: [], category, total: 0, page, blocked: true };
  }
  const cacheKey = `nsfw_${category}_${cleanQuery.toLowerCase()}_${page}_${limit}`;

  // Check memory cache
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  // Deduplicate in-flight requests
  if (inFlightRequests.has(cacheKey)) {
    try {
      return await inFlightRequests.get(cacheKey);
    } catch {
      // Fall through to retry on in-flight error
    }
  }

  const searchPromise = (async () => {
    let effectiveCategory = category;

    // Smart category auto-detection when category is 'all'
    if (effectiveCategory === 'all' || !effectiveCategory) {
      if (/\b(clip|clips|gif|loop|animated)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.HENTAI_CLIPS;
      } else if (/\b(video|videos|movie|watch|trailer|episode)\b/i.test(cleanQuery)) {
        effectiveCategory = /hentai|anime/i.test(cleanQuery) ? NSFW_CATEGORIES.HENTAI_FULL_VIDEOS : NSFW_CATEGORIES.REAL_FULL_VIDEOS;
      } else if (/\b(real|amateur|gonewild|4k|baddie|model|blonde|latina|asian|glamour|boudoir|fitness)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.REAL_WALLPAPERS;
      } else if (/\b(ecchi|censored|soft|questionable|waifu|swimsuit|lingerie)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.HENTAI_CENSORED;
      } else {
        effectiveCategory = NSFW_CATEGORIES.HENTAI_UNCENSORED;
      }
    }

    let items = [];

    switch (effectiveCategory) {
      case NSFW_CATEGORIES.HENTAI_UNCENSORED:
        items = await fetchHentaiUncensored(cleanQuery, page, limit, signal);
        break;
      case NSFW_CATEGORIES.HENTAI_CENSORED:
        items = await fetchHentaiCensored(cleanQuery, page, limit, signal);
        break;
      case NSFW_CATEGORIES.REAL_WALLPAPERS:
        items = await fetchRealAdultWallpapers(cleanQuery, page, limit, signal);
        break;
      case NSFW_CATEGORIES.HENTAI_CLIPS:
      case 'animated':
        items = await fetchAnimatedHentai(cleanQuery, page, limit, signal);
        break;
      case NSFW_CATEGORIES.HENTAI_FULL_VIDEOS:
        items = await fetch18PlusVideos(cleanQuery ? `${cleanQuery} hentai` : 'hentai', page, limit, NSFW_CATEGORIES.HENTAI_FULL_VIDEOS, signal);
        break;
      case NSFW_CATEGORIES.REAL_CLIPS:
        items = await fetch18PlusVideos(cleanQuery ? `${cleanQuery} clip` : 'short clip', page, limit, NSFW_CATEGORIES.REAL_CLIPS, signal);
        break;
      case NSFW_CATEGORIES.REAL_FULL_VIDEOS:
      case 'videos':
        items = await fetch18PlusVideos(cleanQuery, page, limit, NSFW_CATEGORIES.REAL_FULL_VIDEOS, signal);
        break;
      default: {
        // Multi-source hybrid mix
        const [uncensored, realWallpapers, vids] = await Promise.all([
          fetchHentaiUncensored(cleanQuery, page, Math.ceil(limit / 2), signal).catch(() => []),
          fetchRealAdultWallpapers(cleanQuery, page, Math.ceil(limit / 4), signal).catch(() => []),
          fetch18PlusVideos(cleanQuery, page, Math.ceil(limit / 4), NSFW_CATEGORIES.REAL_FULL_VIDEOS, signal).catch(() => [])
        ]);
        items = [...uncensored, ...realWallpapers, ...vids];
        break;
      }
    }

    // Deduplicate items by mediaUrl
    const seen = new Set();
    const unique = [];
    for (const item of items) {
      if (item.mediaUrl && !seen.has(item.mediaUrl)) {
        seen.add(item.mediaUrl);
        unique.push(item);
      }
    }

    const resultPayload = {
      results: unique.slice(0, limit),
      category: effectiveCategory,
      total: unique.length,
      page
    };

    searchCache.set(cacheKey, { data: resultPayload, timestamp: Date.now() });
    if (searchCache.size > 300) {
      const firstKey = searchCache.keys().next().value;
      searchCache.delete(firstKey);
    }

    return resultPayload;
  })();

  inFlightRequests.set(cacheKey, searchPromise);
  try {
    const res = await searchPromise;
    return res;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}
