import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';

const log = logger().child({ module: 'nsfw-search' });

// ── In-Memory Caches & In-Flight Dedup ───────────────────────────────────────
const searchCache = new Map(); // key -> { results, timestamp }
const inFlightRequests = new Map(); // key -> Promise
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
 * Fetch uncensored anime / hentai wallpapers from Yande.re, TBIB & Wallhaven.
 * Supports exact character lookups (Tifa, Makima, Tsunade, Yor, 2B, etc.) and tags (pussy, blowjob, etc.).
 */
async function fetchHentaiUncensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];
  const seenUrls = new Set();

  // 1. Try Yande.re explicit with wildcard matching for characters/tags
  try {
    const tags = ['rating:explicit'];
    if (cleanTag && cleanTag.length >= 2) {
      // Use wildcard to match any variant of the character name or tag (e.g. *tifa* -> tifa_lockhart)
      tags.push(cleanTag.includes('*') ? cleanTag : `*${cleanTag}*`);
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
          if (mediaUrl && !seenUrls.has(mediaUrl)) {
            seenUrls.add(mediaUrl);
            results.push({
              id: `yandere_${post.id}`,
              title: post.tags ? post.tags.slice(0, 60).replace(/_/g, ' ') : `${cleanTag || 'Hentai'} Wallpaper`,
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
  } catch (err) {
    log.debug({ err: err?.message, query }, 'yandere uncensored fetch failed');
  }

  // 2. TBIB (The Big ImageBoard) for additional character & tag coverage
  if (cleanTag && cleanTag.length >= 2 && results.length < limit) {
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

  return results;
}

/**
 * Fetch censored / ecchi anime wallpapers from Wallhaven & Yande.re.
 */
async function fetchHentaiCensored(query = '', page = 0, limit = 10, signal = null) {
  const cleanTag = sanitizeBooruTag(query);
  const results = [];

  // 1. Fetch 4K Wallhaven sensual / ecchi anime wallpapers (purity 010)
  const whItems = await fetchWallhaven(query, '010', '010', page + 1, Math.min(8, limit), signal);
  for (const it of whItems) {
    it.category = NSFW_CATEGORIES.HENTAI_CENSORED;
    results.push(it);
  }

  // 2. Fetch Yande.re rating:questionable
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
 * Fetch Real Adult 18+ 4K Wallpapers and Photos from Wallhaven & Nekobot.
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

  // 1. Fetch exact matching photos from Nekobot
  const fetchCount = Math.min(10, Math.max(limit, 6));
  const promises = Array.from({ length: fetchCount }, (_, idx) => {
    const t = nekoTypes[idx % nekoTypes.length];
    return fetch(`https://nekobot.xyz/api/image?type=${t}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(6500)
    }).then(r => r.json()).catch(() => null);
  });

  const settled = await Promise.all(promises);
  for (const s of settled) {
    if (s?.success && s?.message && !seenUrls.has(s.message)) {
      seenUrls.add(s.message);
      const isModelKeyword = /model|asian|blonde|brunette|latina|baddie|glamour|fitness|goth|4k|boob|ass|amateur|pussy|vagina|thigh|anal|paizuri/i.test(cleanQ);
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

  // 2. Fetch 4K Wallhaven general/people wallpapers
  const whQuery = cleanQ || 'model';
  const whItems = await fetchWallhaven(whQuery, '010', '100', page + 1, Math.min(8, limit), signal);
  for (const it of whItems) {
    if (!seenUrls.has(it.mediaUrl)) {
      seenUrls.add(it.mediaUrl);
      it.category = NSFW_CATEGORIES.REAL_WALLPAPERS;
      it.title = cleanQ ? `4K Model Wallpaper (${cleanQ})` : '4K Adult Glamour Wallpaper';
      results.push(it);
    }
  }

  return results;
}

/**
 * Fetch 18+ Videos (Primary XVideos direct playable MP4 previews + SpankBang secondary).
 */
async function fetch18PlusVideos(query = '', page = 0, limit = 10, category = NSFW_CATEGORIES.REAL_FULL_VIDEOS, signal = null) {
  const cleanQ = String(query || '').trim() || (category === NSFW_CATEGORIES.HENTAI_FULL_VIDEOS ? 'hentai' : 'trending');
  const results = [];
  const seenUrls = new Set();

  // 1. XVideos - Direct MP4 Video Previews (via data-pvv attribute)
  try {
    const isHentai = category === NSFW_CATEGORIES.HENTAI_FULL_VIDEOS || /hentai|anime|3d/i.test(cleanQ);
    const xvSearchTerm = isHentai && !/hentai/i.test(cleanQ) ? `${cleanQ} hentai` : cleanQ;
    const xvUrl = `https://www.xvideos.com/?k=${encodeURIComponent(xvSearchTerm)}${page > 0 ? `&p=${page + 1}` : ''}`;
    const res = await fetch(xvUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(9000)
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      $('.thumb-block').each((i, el) => {
        const titleA = $(el).find('.thumb-under p.title a');
        const title = titleA.attr('title') || titleA.text().trim() || '18+ Video';
        const href = titleA.attr('href');
        const img = $(el).find('.thumb img, img');
        const thumb = img.attr('data-src') || img.attr('src');
        const pvvUrl = img.attr('data-pvv') || $(el).attr('data-pvv');
        const duration = $(el).find('.duration').text().trim();

        // ONLY accept videos that have a genuine direct playable MP4 preview
        if (href && pvvUrl && pvvUrl.endsWith('.mp4') && !seenUrls.has(pvvUrl)) {
          seenUrls.add(pvvUrl);
          results.push({
            id: `xv_vid_${i}_${Date.now()}`,
            title: title.slice(0, 70),
            type: 'video',
            mediaUrl: pvvUrl,
            videoUrl: pvvUrl,
            thumbUrl: thumb || pvvUrl,
            pageUrl: `https://www.xvideos.com${href}`,
            duration: duration || 'HD',
            category,
            source: 'XVideos Network'
          });
        }
      });
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'xvideos fetch failed');
  }

  // 2. Spankbang Direct MP4 Video Previews (td.mp4)
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
        if (mp4Url && thumb && !seenUrls.has(mp4Url)) {
          seenUrls.add(mp4Url);
          results.push({
            id: `sb_vid_${dataId || i}`,
            title: title.slice(0, 70),
            type: 'video',
            mediaUrl: mp4Url,
            videoUrl: mp4Url,
            thumbUrl: thumb,
            pageUrl: href ? `https://spankbang.com${href}` : null,
            duration: $(el).find('.l, .duration').text().trim() || 'HD',
            category,
            source: '18+ Video Network'
          });
        }
      });
    }
  } catch (err) {
    log.debug({ err: err?.message, query }, 'spankbang video fetch failed');
  }

  // Sort results by relevance to query keywords
  const qWords = cleanQ.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !['video', 'videos', 'clip', 'clips', 'full'].includes(w));
  if (qWords.length > 0) {
    results.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();
      const aScore = qWords.reduce((acc, w) => acc + (aTitle.includes(w) ? 2 : 0), 0);
      const bScore = qWords.reduce((acc, w) => acc + (bTitle.includes(w) ? 2 : 0), 0);
      return bScore - aScore;
    });
  }

  return results.slice(0, Math.max(limit * 2, 20));
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
        type: 'photo',
        mediaUrl: link,
        thumbUrl: link,
        width: 800,
        height: 600,
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
