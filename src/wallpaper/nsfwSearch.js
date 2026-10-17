import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';

const log = logger().child({ module: 'nsfw-search' });

// ── In-Memory Caches & In-Flight Dedup ───────────────────────────────────────
const searchCache = new Map(); // key -> { results, timestamp }
const inFlightRequests = new Map(); // key -> Promise
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const NSFW_CATEGORIES = {
  ALL: 'all',
  HENTAI_UNCENSORED: 'hentai_uncensored',
  HENTAI_CENSORED: 'hentai_censored',
  REAL_WALLPAPERS: 'real_wallpapers',
  VIDEOS: 'videos',
  ANIMATED: 'animated'
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sanitizeBooruTag(q) {
  let s = String(q || '').toLowerCase().trim();
  s = s.replace(/\b(wallpaper|wallpapers|photo|photos|pic|pics|image|images|art|4k|hd|18\+|nsfw|hentai|uncensored|censored|ecchi|r18)\b/gi, '').trim();
  s = s.replace(/[\s\-_]+/g, '_');
  return s.replace(/^_+|_+$/g, '');
}

/**
 * Fetch uncensored anime / hentai wallpapers from Yande.re & Nekobot.
 */
async function fetchHentaiUncensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];

  // 1. Try Yande.re explicit + sanitized tag
  try {
    const tags = ['rating:explicit'];
    if (cleanTag && cleanTag.length >= 2) {
      tags.push(cleanTag);
    } else {
      tags.push('uncensored');
    }
    const url = `https://yande.re/post.json?limit=${Math.min(30, limit * 2)}&page=${page + 1}&tags=${encodeURIComponent(tags.join(' '))}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const posts = await res.json();
      if (Array.isArray(posts) && posts.length > 0) {
        for (const post of posts) {
          const mediaUrl = post.file_url || post.sample_url || post.jpeg_url;
          if (mediaUrl) {
            results.push({
              id: `yandere_${post.id}`,
              title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Uncensored Hentai Wallpaper',
              type: 'photo',
              mediaUrl,
              thumbUrl: post.preview_url || post.sample_url || mediaUrl,
              width: post.width || 1280,
              height: post.height || 720,
              category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
              source: 'Yande.re (Uncensored)'
            });
          }
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'yandere uncensored fetch failed');
  }

  // 1b. If specific tag had 0 results, fall back to general explicit on Yande.re
  if (results.length === 0) {
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
            if (mediaUrl) {
              results.push({
                id: `yandere_fb_${post.id}`,
                title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Uncensored Hentai Wallpaper',
                type: 'photo',
                mediaUrl,
                thumbUrl: post.preview_url || post.sample_url || mediaUrl,
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

  // 2. Supplement with Nekobot if needed
  if (results.length < limit) {
    try {
      const types = ['hentai', 'paizuri', 'hass', 'hboobs'];
      const pickType = types[Math.floor(Math.random() * types.length)];
      const fetchCount = Math.min(6, limit - results.length);
      const promises = Array.from({ length: fetchCount }, () =>
        fetch(`https://nekobot.xyz/api/image?type=${pickType}`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal || AbortSignal.timeout(6000)
        }).then(r => r.json()).catch(() => null)
      );
      const settled = await Promise.all(promises);
      for (const s of settled) {
        if (s?.success && s?.message) {
          results.push({
            id: `neko_${Math.random().toString(36).slice(2, 9)}`,
            title: `Hentai ${pickType.toUpperCase()} Wallpaper`,
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
    } catch (err) {
      log.debug({ err: err?.message }, 'nekobot hentai fetch failed');
    }
  }

  return results;
}

/**
 * Fetch censored / ecchi anime wallpapers from Yande.re.
 */
async function fetchHentaiCensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];

  try {
    const tags = ['rating:questionable'];
    if (cleanTag && cleanTag.length >= 2) {
      tags.push(cleanTag);
    }
    const url = `https://yande.re/post.json?limit=${Math.min(30, limit * 2)}&page=${page + 1}&tags=${encodeURIComponent(tags.join(' '))}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const posts = await res.json();
      if (Array.isArray(posts) && posts.length > 0) {
        for (const post of posts) {
          const mediaUrl = post.sample_url || post.file_url || post.jpeg_url;
          if (mediaUrl) {
            results.push({
              id: `yandere_q_${post.id}`,
              title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Ecchi / Censored Anime Wallpaper',
              type: 'photo',
              mediaUrl,
              thumbUrl: post.preview_url || post.sample_url || mediaUrl,
              width: post.width || 1280,
              height: post.height || 720,
              category: NSFW_CATEGORIES.HENTAI_CENSORED,
              source: 'Yande.re (Ecchi/Censored)'
            });
          }
        }
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'yandere ecchi fetch failed');
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
            if (mediaUrl) {
              results.push({
                id: `yandere_q_fb_${post.id}`,
                title: post.tags ? post.tags.slice(0, 50).replace(/_/g, ' ') : 'Ecchi / Censored Anime Wallpaper',
                type: 'photo',
                mediaUrl,
                thumbUrl: post.preview_url || post.sample_url || mediaUrl,
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
 * Fetch Real Adult 18+ 4K Wallpapers and Photos from Nekobot (4k, gonewild, boobs, ass).
 */
async function fetchRealAdultWallpapers(query = '', page = 0, limit = 10, signal = null) {
  const cleanQ = String(query || '').toLowerCase();
  const results = [];

  let types = ['4k', 'gonewild', 'boobs', 'ass'];
  if (/boob|breast|tits|cleavage/i.test(cleanQ)) types = ['boobs', '4k'];
  else if (/ass|booty|butt/i.test(cleanQ)) types = ['ass', '4k'];
  else if (/amateur|nude|real|girl/i.test(cleanQ)) types = ['gonewild', '4k'];

  const countToFetch = Math.min(15, Math.max(limit, 8));
  const promises = Array.from({ length: countToFetch }, (_, idx) => {
    const t = types[idx % types.length];
    return fetch(`https://nekobot.xyz/api/image?type=${t}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(7000)
    }).then(r => r.json()).catch(() => null);
  });

  const settled = await Promise.all(promises);
  const seenUrls = new Set();
  for (const s of settled) {
    if (s?.success && s?.message && !seenUrls.has(s.message)) {
      seenUrls.add(s.message);
      results.push({
        id: `real_adult_${Math.random().toString(36).slice(2, 9)}`,
        title: cleanQ ? `Real 18+ HD Wallpaper (${cleanQ})` : 'Real 18+ 4K HD Wallpaper',
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

  return results;
}

/**
 * Fetch 18+ Videos (Direct MP4 streams from Spankbang + XVideos fallback).
 * Supports both Hentai & Real Adult videos.
 */
async function fetch18PlusVideos(query = '', page = 0, limit = 10, signal = null) {
  const cleanQ = String(query || '').trim() || 'trending';
  const results = [];

  // 1. Spankbang direct MP4 video previews
  try {
    const spankbangUrl = `https://spankbang.com/s/${encodeURIComponent(cleanQ)}/${page > 0 ? `${page + 1}/` : ''}`;
    const res = await fetch(spankbangUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(9000)
    });
    if (res.ok) {
      const html = await res.text();
      const mp4Map = new Map();
      const mp4Regex = /https:\/\/tbv\.sb-cd\.com\/t\/(\d+)\/([0-9a-z]+)\/([0-9a-z]+)\/td\.mp4/g;
      let m;
      while ((m = mp4Regex.exec(html)) !== null) {
        mp4Map.set(m[1], m[0]);
      }

      const $ = cheerio.load(html);
      $('.js-video-item').each((i, el) => {
        const dataId = $(el).attr('data-id');
        const a = $(el).find('a').first();
        const href = a.attr('href');
        const img = $(el).find('img').first();
        const title = img.attr('alt') || a.attr('title') || '18+ HD Video Clip';
        const thumb = img.attr('src') || img.attr('data-src');
        const mp4Url = dataId ? mp4Map.get(dataId) : null;
        if (mp4Url && thumb) {
          results.push({
            id: `sb_vid_${dataId || i}`,
            title: title.slice(0, 60),
            type: 'video',
            mediaUrl: mp4Url,
            thumbUrl: thumb,
            pageUrl: href ? `https://spankbang.com${href}` : null,
            duration: $(el).find('.l, .duration').text().trim() || 'HD',
            category: NSFW_CATEGORIES.VIDEOS,
            source: '18+ Video Network'
          });
        }
      });
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'spankbang video fetch failed');
  }

  // 2. Fallback to XVideos for additional titles and video representations
  if (results.length < limit) {
    try {
      const xvUrl = `https://www.xvideos.com/?k=${encodeURIComponent(cleanQ)}${page > 0 ? `&p=${page + 1}` : ''}`;
      const res = await fetch(xvUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal || AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);
        $('.thumb-block').each((i, el) => {
          const titleA = $(el).find('.thumb-under p.title a');
          const title = titleA.attr('title') || titleA.text().trim() || '18+ Video';
          const href = titleA.attr('href');
          const img = $(el).find('.thumb img');
          const thumb = img.attr('data-src') || img.attr('src');
          const duration = $(el).find('.duration').text().trim();
          if (href && thumb && !results.some(r => r.title === title)) {
            results.push({
              id: `xv_vid_${i}_${Date.now()}`,
              title: title.slice(0, 60),
              type: 'video',
              mediaUrl: thumb, // Thumbnail preview card
              thumbUrl: thumb,
              pageUrl: `https://www.xvideos.com${href}`,
              duration: duration || 'HD',
              category: NSFW_CATEGORIES.VIDEOS,
              source: 'XVideos Network'
            });
          }
        });
      }
    } catch (err) {
      log.debug({ err: err?.message, query }, 'xvideos fetch failed');
    }
  }

  return results.slice(0, limit * 2);
}

/**
 * Fetch Animated Hentai Clips & GIFs from PurrBot & Nekobot.
 */
async function fetchAnimatedHentai(query = '', page = 0, limit = 10, signal = null) {
  const cleanQ = String(query || '').toLowerCase();
  const results = [];

  const purrEndpoints = ['blowjob', 'fuck', 'anal', 'cum', 'pussylick', 'solo'];
  let selected = purrEndpoints;
  if (/blowjob|oral|bj/i.test(cleanQ)) selected = ['blowjob'];
  else if (/anal/i.test(cleanQ)) selected = ['anal'];
  else if (/cum/i.test(cleanQ)) selected = ['cum'];

  const count = Math.min(8, Math.max(limit, 4));
  const promises = Array.from({ length: count }, (_, idx) => {
    const tag = selected[idx % selected.length];
    return fetch(`https://purrbot.site/api/img/nsfw/${tag}/gif`, {
      signal: signal || AbortSignal.timeout(6000)
    }).then(r => r.json()).catch(() => null);
  });

  // Also include Nekobot pgif
  promises.push(
    fetch('https://nekobot.xyz/api/image?type=pgif', {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6000)
    }).then(r => r.json()).catch(() => null)
  );

  const settled = await Promise.all(promises);
  for (const s of settled) {
    const link = s?.link || (s?.success && s?.message ? s.message : null);
    if (link && !results.some(r => r.mediaUrl === link)) {
      results.push({
        id: `anim_${Math.random().toString(36).slice(2, 9)}`,
        title: cleanQ ? `Animated Hentai Clip (${cleanQ})` : 'Animated Hentai GIF Clip',
        type: 'photo', // Telegram delivers GIF via photo/document or animated format
        mediaUrl: link,
        thumbUrl: link,
        width: 800,
        height: 600,
        category: NSFW_CATEGORIES.ANIMATED,
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
 * - Smart query routing (hentai, uncensored, censored, real adult, video, animated)
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
  const cacheKey = `nsfw_${category}_${cleanQuery.toLowerCase()}_${page}_${limit}`;

  // Check memory cache
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  // Deduplicate in-flight requests (coalesce concurrent requests from same or different group chats!)
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
      if (/\b(video|videos|clip|clips|movie|watch|trailer)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.VIDEOS;
      } else if (/\b(real|amateur|gonewild|4k|baddie|model|blonde|latina|asian|boobs|ass)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.REAL_WALLPAPERS;
      } else if (/\b(gif|animated|motion)\b/i.test(cleanQuery)) {
        effectiveCategory = NSFW_CATEGORIES.ANIMATED;
      } else if (/\b(ecchi|censored|soft|questionable)\b/i.test(cleanQuery)) {
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
      case NSFW_CATEGORIES.VIDEOS:
        items = await fetch18PlusVideos(cleanQuery, page, limit, signal);
        break;
      case NSFW_CATEGORIES.ANIMATED:
        items = await fetchAnimatedHentai(cleanQuery, page, limit, signal);
        break;
      default: {
        // Multi-source hybrid mix
        const [uncensored, realWallpapers, vids] = await Promise.all([
          fetchHentaiUncensored(cleanQuery, page, Math.ceil(limit / 2), signal).catch(() => []),
          fetchRealAdultWallpapers(cleanQuery, page, Math.ceil(limit / 4), signal).catch(() => []),
          fetch18PlusVideos(cleanQuery, page, Math.ceil(limit / 4), signal).catch(() => [])
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
