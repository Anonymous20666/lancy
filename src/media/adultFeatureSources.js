import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const log = logger().child({ module: 'adult-feature-sources' });

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TYPO_REPLACEMENTS = new Map([
  ['stegenneti', 'stagnetti'],
  ['stagenetti', 'stagnetti'],
  ['stagnatti', 'stagnetti'],
  ['stagneti', 'stagnetti'],
  ['stagnneti', 'stagnetti'],
  ['stagnety', 'stagnetti'],
  ['femaelien', 'femalien'],
  ['femalion', 'femalien'],
  ['kamasuthra', 'kamasutra'],
  ['kamasootra', 'kamasutra'],
  ['gianess', 'giantess'],
  ['giantes', 'giantess'],
  ['ilicit', 'illicit'],
  ['pirate', 'pirates']
]);

const KNOWN_FEATURE_TOKENS = [
  'stagnetti', 'pirates', 'revenge', 'kamasutra', 'femalien', 'cosmic', 'crush',
  'giantess', 'illicit', 'desires', 'machine', 'gunner', 'sorrow', 'pickup', 'deadly',
  'casey', 'jesse', 'jane', 'belladonna', 'stoya', 'katsuni', 'sasha', 'grey',
  'noir', 'calvert', 'angel', 'kisses', 'voxxx', 'kayley', 'brazzers', 'wicked',
  'digital', 'playground', 'vixen', 'tushy', 'blacked', 'parody', 'stella'
];

const QUERY_FILLER_RE = /\b(?:sex\s+movies?|porn\s+movies?|adult\s+movies?|full\s+movies?|watch\s+online|online\s+free|by\s+porn\s*stars?|and\s+so\s+on|n\s+so\s+on|etc|to\s+stream|free\s+stream)\b/gi;
const ADULT_INTENT_RE = /\b(?:st[ae]g+n+e+t+i?|porn\s*stars?|sex\s+movies?|porn\s+movies?|xxx|parod(?:y|ies)|hentai|nsfw|erotic|lust\s+cinema|adult\s+time|full\s+moon)\b/i;

export function decodeHtmlEntities(str = '') {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&rsquo;/g, '’');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function formatSec(seconds = 0, fallback = 'Full Movie') {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  if (!sec) return fallback;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function parseClockSec(raw = '') {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  const m = String(raw || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return 0;
}

/**
 * Repair common typos and noisy phrasing in adult feature & parody searches.
 */
export function normalizeAdultMovieQuery(rawQuery = '') {
  const originalQuery = String(rawQuery || '').trim();
  if (!originalQuery) {
    return {
      originalQuery: '',
      cleanQuery: '',
      primaryQuery: '',
      fallbackQueries: [],
      preferFullFeatures: false,
      year: null
    };
  }

  const yearMatch = originalQuery.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  let working = originalQuery
    .replace(QUERY_FILLER_RE, ' ')
    .replace(/['’]s\b/gi, '')
    .replace(/[^\w\s:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // When searching for a Pirates XXX parody, drop "of the caribbean" noise if present
  if (/stagnet|pirate/i.test(working)) {
    working = working.replace(/\bof\s+the\s+caribbean\b/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  const tokens = working.split(/\s+/).filter(Boolean);
  const repaired = tokens.map((tok) => {
    const low = tok.toLowerCase();
    if (TYPO_REPLACEMENTS.has(low)) {
      return low === 'pirate' && tokens.length > 1 ? 'pirates' : TYPO_REPLACEMENTS.get(low);
    }
    if (low.length >= 6) {
      let bestWord = null;
      let bestDist = 3;
      for (const vocab of KNOWN_FEATURE_TOKENS) {
        const d = levenshtein(low, vocab);
        if (d < bestDist) {
          bestDist = d;
          bestWord = vocab;
        }
      }
      if (bestWord && bestDist <= 2) return bestWord;
    }
    return tok;
  });

  const cleanQuery = repaired.join(' ').trim() || originalQuery;
  const preferFullFeatures =
    ADULT_INTENT_RE.test(originalQuery) ||
    ADULT_INTENT_RE.test(cleanQuery) ||
    /\b(?:full\s+movies?|parod(?:y|ies)|feature)\b/i.test(originalQuery);
  const noYearQuery = cleanQuery.replace(/\b(19\d\d|20\d\d)\b/g, '').replace(/\s+/g, ' ').trim() || cleanQuery;

  const fallbacks = new Set([cleanQuery, noYearQuery]);
  if (/stagnetti/i.test(noYearQuery)) {
    fallbacks.add('Pirates Stagnetti');
    fallbacks.add('Stagnetti');
    fallbacks.add('Pirates II');
  }
  if (/pirates/i.test(noYearQuery) && preferFullFeatures) {
    fallbacks.add('Pirates Jesse Jane');
  }

  return {
    originalQuery,
    cleanQuery,
    primaryQuery: noYearQuery,
    fallbackQueries: [...fallbacks].filter(Boolean),
    preferFullFeatures,
    year
  };
}

/**
 * Pure-regex Dean Edwards P.A.C.K.E.R script unpacker (no eval or Function()).
 */
export function unpackPacker(html = '') {
  const src = String(html || '');
  const re = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\(\s*'((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\(\s*['"]\|['"]\s*\)/g;
  const outputs = [];
  for (const m of src.matchAll(re)) {
    let p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const a = Number(m[2]);
    let c = Number(m[3]);
    const k = m[4].split('|');
    if (!a || a < 2 || a > 62 || !Number.isFinite(c)) continue;

    const encode = (num) => {
      const prefix = num < a ? '' : encode(Math.floor(num / a));
      const rem = num % a;
      return prefix + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36));
    };
    const dict = new Map();
    while (c--) {
      const token = encode(c);
      dict.set(token, k[c] || token);
    }
    outputs.push(p.replace(/\b\w+\b/g, (word) => dict.get(word) ?? word));
  }
  return outputs.join('\n');
}

function extractStreamTapeUrl(html = '') {
  const m = String(html || '').match(/getElementById\(\s*['"](?:ideoolink|robotlink|norobotlink)['"]\s*\)\.innerHTML\s*=\s*([^;<\n]+)/i);
  if (!m) return null;
  const expr = m[1];
  const parts = expr.split('+').map((s) => s.trim()).filter(Boolean);
  let assembled = '';
  for (const part of parts) {
    const subMatch = part.match(/^\(?\s*['"]([^'"]+)['"]\s*\)?((?:\.substring\(\d+\))+)$/);
    if (subMatch) {
      let val = subMatch[1];
      for (const sm of subMatch[2].matchAll(/\.substring\((\d+)\)/g)) {
        val = val.slice(Number(sm[1]));
      }
      assembled += val;
      continue;
    }
    const lit = part.match(/^['"]([^'"]*)['"]$/);
    if (lit) assembled += lit[1];
  }
  if (!assembled || !/get_video/i.test(assembled)) return null;
  if (assembled.startsWith('//')) return `https:${assembled}`;
  if (assembled.startsWith('/')) return `https://streamtape.com${assembled}`;
  return /^https?:\/\//i.test(assembled) ? assembled : `https://${assembled.replace(/^\/+/, '')}`;
}

export function scoreAdultTitleMatch(query = '', candidateTitle = '') {
  const cleanYears = (s) => s.replace(/\b(?:19\d{2}|20[0-3]\d)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const qNorm = cleanYears(String(query || '').toLowerCase().replace(/[^\w\s]+/g, ' '));
  const cNorm = cleanYears(decodeHtmlEntities(candidateTitle).toLowerCase().replace(/[^\w\s]+/g, ' '));
  if (!qNorm || !cNorm) return 0;
  if (cNorm === qNorm) return 100;
  if (cNorm.startsWith(qNorm)) return 85;

  const stop = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'and', 'movie', 'full', 'film', 'porn', 'xxx', 'watch', 'online', 'free', 'hd', '480p', '720p', '1080p', 'english', 'web', 'dl', 'x264']);
  const qToks = [...new Set(qNorm.split(/\s+/).filter((t) => t.length >= 2 && !stop.has(t)))];
  const cTokList = cNorm.split(/\s+/).filter(Boolean);
  const cToks = new Set(cTokList);
  if (!qToks.length) return cNorm.includes(qNorm) ? 70 : 10;

  const tokenMatches = (t, set, fullStr) => (
    set.has(t)
    || (t.endsWith('s') && t.length >= 4 && set.has(t.slice(0, -1)))
    || (!t.endsWith('s') && t.length >= 3 && set.has(`${t}s`))
    || (t.length >= 4 && fullStr.includes(t.replace(/s$/, '')))
  );

  let hits = 0;
  for (const t of qToks) {
    if (tokenMatches(t, cToks, cNorm)) hits++;
  }
  let score = Math.round((hits / qToks.length) * 60);

  // Reward when query tokens appear in the leading title segment rather than buried inside a long scene caption
  const leadSlice = cTokList.slice(0, qToks.length + 2);
  const leadSet = new Set(leadSlice);
  const leadStr = leadSlice.join(' ');
  const leadHits = qToks.filter((t) => tokenMatches(t, leadSet, leadStr)).length;
  if (hits === qToks.length && leadHits === qToks.length) {
    score = Math.max(score + 22, 82);
  } else if (cNorm.includes(qNorm)) {
    score = cTokList.length >= 10 && leadHits === 0 ? Math.max(score, 54) : Math.max(score, 70);
  } else if (cTokList.length >= 12 && leadHits === 0 && hits > 0) {
    score = Math.max(20, score - 12);
  }
  return Math.min(100, score);
}

async function defaultYtDlpExtract(url, { referer = null, signal = null } = {}) {
  const args = ['--no-warnings', '--dump-single-json'];
  if (referer) args.push('--referer', referer);
  args.push(url);
  const { stdout } = await execFileAsync('yt-dlp', args, {
    timeout: 14000,
    maxBuffer: 4 * 1024 * 1024,
    signal: signal || undefined
  });
  return JSON.parse(stdout || '{}');
}

function buildVariantsFromYtInfo(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const variants = [];
  const seen = new Set();

  for (const f of formats) {
    if (!f?.url || !/^https?:\/\//i.test(f.url)) continue;
    if (f.vcodec === 'none' || f.acodec === 'none') continue;
    const h = Number(f.height || 0);
    if (!h) continue;
    const isHls = f.protocol?.includes('m3u8') || /\.m3u8(\?|$)/i.test(f.url);
    const key = `${h}:${isHls ? 'hls' : 'mp4'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      quality: `${h}p`,
      qualityLabel: `${h}p`,
      height: h,
      url: f.url,
      isHls,
      sizeBytes: Number(f.filesize || f.filesize_approx || 0) || null
    });
  }

  variants.sort((a, b) => (a.isHls - b.isHls) || (b.height - a.height));
  return variants;
}

/**
 * Resolve direct MP4/HLS streams from MixDrop, LuluStream, StreamTape, or VOE embed URLs.
 */
export async function extractEmbedStream(embedUrl, {
  referer = 'https://pandamovies.org/',
  fetchImpl = fetch,
  ytExtractFn = null,
  signal = null
} = {}) {
  const rawUrl = String(embedUrl || '').trim();
  if (!/^https?:\/\//i.test(rawUrl)) return null;
  if (/\.(mp4|m3u8)(\?|$)/i.test(rawUrl)) {
    const isHls = /\.m3u8(\?|$)/i.test(rawUrl);
    return {
      streamUrl: rawUrl,
      isHls,
      variants: [{ quality: '720p', qualityLabel: 'HD', height: 720, url: rawUrl, isHls, sizeBytes: null }],
      fallbackUrls: [rawUrl],
      headers: { Referer: referer, 'User-Agent': DEFAULT_USER_AGENT }
    };
  }

  const headers = { 'User-Agent': DEFAULT_USER_AGENT, Referer: referer };
  try {
    const res = await fetchImpl(rawUrl, { headers, signal: signal || AbortSignal.timeout(7000) });
    if (!res?.ok) return null;
    const html = await res.text();
    const unpacked = unpackPacker(html) || html;

    // 1. StreamTape robotlink decode
    if (/streamtape\./i.test(rawUrl)) {
      const stUrl = extractStreamTapeUrl(html);
      if (stUrl) {
        let finalUrl = stUrl;
        try {
          const redir = await fetchImpl(stUrl, { method: 'HEAD', headers: { 'User-Agent': DEFAULT_USER_AGENT, Referer: rawUrl }, redirect: 'manual', signal: signal || AbortSignal.timeout(4500) });
          const loc = redir?.headers?.get?.('location');
          if (loc && /^https?:\/\//i.test(loc)) finalUrl = loc;
        } catch {}
        return {
          streamUrl: finalUrl,
          isHls: false,
          variants: [{ quality: '720p', qualityLabel: '720p', height: 720, url: finalUrl, isHls: false, sizeBytes: null }],
          fallbackUrls: [finalUrl, stUrl],
          headers: { Referer: rawUrl, 'User-Agent': DEFAULT_USER_AGENT }
        };
      }
      return null;
    }

    // 2. LuluStream / MixDrop P.A.C.K.E.R direct extraction
    const wurlMatch = unpacked.match(/MDCore\.wurl\s*=\s*['"]([^'"]+)['"]/i);
    const directCandidates = [
      ...(wurlMatch ? [wurlMatch[1]] : []),
      ...[...unpacked.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)[^\s"'<>\\]*/gi)].map((m) => m[0])
    ]
      .map((u) => (u.startsWith('//') ? `https:${u}` : u))
      .filter((u) => /^https?:\/\//i.test(u) && !/\.(js|css|png|jpg|vtt|srt)(\?|$)/i.test(u));

    const uniq = [...new Set(directCandidates)];
    const mp4Url = uniq.find((u) => /\.mp4(\?|$)/i.test(u) || wurlMatch);
    const m3u8Url = uniq.find((u) => /\.m3u8(\?|$)/i.test(u));
    const chosen = mp4Url || m3u8Url;
    if (chosen) {
      const isHls = !mp4Url && Boolean(m3u8Url);
      const variants = [];
      if (mp4Url) variants.push({ quality: '720p', qualityLabel: '720p', height: 720, url: mp4Url, isHls: false, sizeBytes: null });
      if (m3u8Url) variants.push({ quality: '720p', qualityLabel: '720p HLS', height: 720, url: m3u8Url, isHls: true, sizeBytes: null });
      return {
        streamUrl: chosen,
        hlsUrl: m3u8Url || null,
        isHls,
        variants,
        fallbackUrls: uniq,
        headers: { Referer: rawUrl, 'User-Agent': DEFAULT_USER_AGENT }
      };
    }

    // 3. VOE redirect + yt-dlp fallback
    const redirMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    const nextUrl = redirMatch?.[1] && /^https?:\/\//i.test(redirMatch[1]) ? redirMatch[1] : rawUrl;
    if (/voe\.|arianathankspecial/i.test(rawUrl) || redirMatch) {
      const ytFn = ytExtractFn || ((u) => defaultYtDlpExtract(u, { referer: rawUrl, signal }));
      const info = await ytFn(nextUrl).catch(() => null);
      const url = info?.url || info?.requested_downloads?.[0]?.url;
      if (url && /^https?:\/\//i.test(url)) {
        const isHls = /\.m3u8(\?|$)/i.test(url);
        const variants = buildVariantsFromYtInfo(info);
        if (!variants.length) {
          variants.push({ quality: '720p', qualityLabel: '720p', height: 720, url, isHls, sizeBytes: null });
        }
        return {
          streamUrl: variants[0]?.url || url,
          hlsUrl: isHls ? url : null,
          isHls: variants[0]?.isHls ?? isHls,
          variants,
          fallbackUrls: [...new Set([url, ...variants.map((v) => v.url)])],
          durationSeconds: Number(info.duration || 0) || 0,
          headers: info.http_headers || { Referer: nextUrl, 'User-Agent': DEFAULT_USER_AGENT }
        };
      }
    }
  } catch (err) {
    log.debug({ err: err?.message, embedUrl: rawUrl }, 'embed extraction failed');
  }
  return null;
}

/**
 * FullXCinema (fullxcinema.com) provider — 1,700+ full adult & erotic feature movies with direct MP4 CDN.
 */
export async function searchFullXCinema({
  query = '',
  page = 0,
  limit = 15,
  categoryId = null,
  isBlocked = () => false,
  fetchImpl = fetch,
  signal = null
} = {}) {
  const norm = normalizeAdultMovieQuery(query);
  const q = norm.primaryQuery || norm.cleanQuery || '';
  const perPage = Math.min(25, Math.max(12, Number(limit) || 15));
  const pageNum = Math.max(0, Number(page) || 0);
  const params = new URLSearchParams({
    per_page: String(perPage),
    page: String(pageNum + 1),
    _embed: '1'
  });
  if (q && !/^(trending|hot|popular|all|full\s*movies?)$/i.test(q)) {
    params.set('search', q);
  }
  if (categoryId) params.set('categories', String(categoryId));

  try {
    const res = await fetchImpl(`https://fullxcinema.com/wp-json/wp/v2/posts?${params}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(7000)
    });
    if (!res?.ok) return { results: [], totalPages: 1 };
    const totalPages = Math.min(350, Math.max(1, Number(res.headers?.get?.('x-wp-totalpages') || 1)));
    const posts = await res.json();
    if (!Array.isArray(posts)) return { results: [], totalPages: 1 };

    const mapped = posts
      .map((p) => {
        const title = decodeHtmlEntities(p?.title?.rendered || '').trim();
        if (!title || isBlocked(title) || !p?.link) return null;
        const thumb = p?._embedded?.['wp:featuredmedia']?.[0]?.source_url || null;
        const yearMatch = title.match(/\b(19\d\d|20\d\d)\b/);
        return {
          id: `fxc_${p.id}`,
          title: title.slice(0, 180),
          type: 'video',
          mediaType: 'video',
          isAdult: true,
          isFeature: true,
          mediaUrl: p.link,
          videoUrl: null,
          streamUrl: null,
          fallbackUrls: [],
          thumbUrl: thumb,
          poster: thumb,
          pageUrl: p.link,
          year: yearMatch ? Number(yearMatch[1]) : null,
          duration: 'Full Feature',
          durationSeconds: 4500,
          quality: 'HD MP4',
          artist: 'FullXCinema Studio',
          headers: { Referer: p.link, 'User-Agent': DEFAULT_USER_AGENT },
          streamHeaders: { Referer: p.link, 'User-Agent': DEFAULT_USER_AGENT },
          category: 'adult_movies',
          sourceKey: 'fullxcinema',
          source: 'FullXCinema',
          _matchScore: q ? scoreAdultTitleMatch(q, title) : 10
        };
      })
      .filter(Boolean)
      .sort((a, b) => b._matchScore - a._matchScore)
      .slice(0, limit);

    return { results: mapped, totalPages, page: pageNum, source: 'FullXCinema' };
  } catch (err) {
    log.debug({ err: err?.message, query: q }, 'FullXCinema search failed');
    return { results: [], totalPages: 1 };
  }
}

export async function resolveFullXCinemaStream(pageUrl, { fetchImpl = fetch, ytExtractFn = null, signal = null } = {}) {
  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/([^/]+\.)?fullxcinema\.com\//i.test(url)) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(7500)
    });
    if (!res?.ok) return null;
    const html = await res.text();

    // Clean-tube-player base64 video payload -> direct cdn.freevidco.com MP4
    for (const m of html.matchAll(/player-x\.php\?q=([A-Za-z0-9+/=%_-]+)/gi)) {
      try {
        const b64 = decodeURIComponent(m[1]);
        const inner = decodeURIComponent(Buffer.from(b64, 'base64').toString('utf8'));
        const srcMatch = inner.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
        if (srcMatch?.[1]) {
          const mp4Url = srcMatch[1];
          const isHls = /\.m3u8(\?|$)/i.test(mp4Url);
          return {
            streamUrl: mp4Url,
            highUrl: mp4Url,
            lowUrl: mp4Url,
            hlsUrl: isHls ? mp4Url : null,
            isHls,
            fallbackUrls: [mp4Url],
            variants: [{ quality: '720p', qualityLabel: '720p MP4', height: 720, url: mp4Url, isHls, sizeBytes: null }],
            headers: { Referer: url, 'User-Agent': DEFAULT_USER_AGENT }
          };
        }
      } catch {}
    }

    // Direct HTML5 <video>/<source> or third-party embed fallback
    const directSrc = html.match(/<(?:video|source)[^>]+src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i)?.[1];
    if (directSrc) {
      const isHls = /\.m3u8(\?|$)/i.test(directSrc);
      return {
        streamUrl: directSrc,
        isHls,
        variants: [{ quality: '720p', qualityLabel: 'HD', height: 720, url: directSrc, isHls, sizeBytes: null }],
        fallbackUrls: [directSrc],
        headers: { Referer: url, 'User-Agent': DEFAULT_USER_AGENT }
      };
    }

    for (const im of html.matchAll(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) {
      if (/magsrv|juicyads|exoclick|traffic/i.test(im[1])) continue;
      const ext = await extractEmbedStream(im[1], { referer: url, fetchImpl, ytExtractFn, signal });
      if (ext?.streamUrl) return ext;
    }
  } catch (err) {
    log.debug({ err: err?.message, url }, 'FullXCinema resolve failed');
  }
  return null;
}

async function resolvePandaTaxonomyId(taxonomy, nameOrId, fetchImpl, signal) {
  if (!nameOrId) return null;
  if (/^\d+$/.test(String(nameOrId).trim())) return Number(nameOrId);
  const cleanName = String(nameOrId)
    .replace(/^\/?(?:pornstars|models|channels|cast|studios)\//i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleanName) return null;
  try {
    const res = await fetchImpl(
      `https://pandamovies.org/wp-json/wp/v2/${taxonomy}?search=${encodeURIComponent(cleanName)}&per_page=8&orderby=count&order=desc`,
      { headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal: signal || AbortSignal.timeout(5500) }
    );
    if (!res?.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    const low = cleanName.toLowerCase();
    const exact = list.find((x) => decodeHtmlEntities(x.name || '').toLowerCase() === low) || list[0];
    return exact?.id || null;
  } catch {
    return null;
  }
}

export async function listPandaTaxonomies(taxonomy = 'cast', { query = '', page = 0, perPage = 24, fetchImpl = fetch, signal = null } = {}) {
  try {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(Math.max(1, page + 1)),
      orderby: 'count',
      order: 'desc'
    });
    if (query) params.set('search', query.trim());
    const res = await fetchImpl(`https://pandamovies.org/wp-json/wp/v2/${taxonomy}?${params}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(6000)
    });
    if (!res?.ok) return [];
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : [])
      .filter((t) => t?.id && t?.name && Number(t.count) > 0)
      .map((t) => ({
        id: Number(t.id),
        name: decodeHtmlEntities(t.name),
        slug: t.slug,
        count: Number(t.count)
      }));
  } catch {
    return [];
  }
}

/**
 * PandaMovies (pandamovies.org) provider — 121K+ full adult feature movies indexed by title, cast, studio, and genre.
 */
export async function searchPandaMovies({
  query = '',
  page = 0,
  limit = 15,
  artist = null,
  studio = null,
  genre = null,
  isBlocked = () => false,
  fetchImpl = fetch,
  signal = null
} = {}) {
  const norm = normalizeAdultMovieQuery(query);
  const q = norm.primaryQuery || norm.cleanQuery || '';
  const perPage = Math.min(25, Math.max(12, Number(limit) || 15));
  const pageNum = Math.max(0, Number(page) || 0);

  const [castId, studioId, genreId] = await Promise.all([
    artist ? resolvePandaTaxonomyId('cast', artist, fetchImpl, signal) : null,
    studio ? resolvePandaTaxonomyId('studios', studio, fetchImpl, signal) : null,
    genre ? resolvePandaTaxonomyId('genres', genre, fetchImpl, signal) : null
  ]);

  if (artist && !castId && !q) {
    // Fallback to text search for that star's name
    return searchPandaMovies({ query: String(artist).replace(/[-_]+/g, ' '), page, limit, studio, genre, isBlocked, fetchImpl, signal });
  }

  const params = new URLSearchParams({
    per_page: String(perPage),
    page: String(pageNum + 1),
    _embed: '1'
  });
  if (q && !/^(trending|hot|popular|all|full\s*movies?)$/i.test(q)) params.set('search', q);
  if (castId) params.set('cast', String(castId));
  if (studioId) params.set('studios', String(studioId));
  if (genreId) params.set('genres', String(genreId));

  try {
    const res = await fetchImpl(`https://pandamovies.org/wp-json/wp/v2/posts?${params}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(7500)
    });
    const totalPages = res?.ok ? Math.min(500, Math.max(1, Number(res.headers?.get?.('x-wp-totalpages') || 1))) : 1;
    let posts = res?.ok ? await res.json().catch(() => []) : [];
    if (!Array.isArray(posts)) posts = [];

    // Supplement with HTML card scrape when WP full-text REST search misses or returns unrelated tag hits
    const mapped = [];
    const seenUrls = new Set();
    const pushItem = (item) => {
      if (!item || seenUrls.has(item.pageUrl) || isBlocked(item.title)) return;
      seenUrls.add(item.pageUrl);
      mapped.push(item);
    };

    for (const p of posts) {
      const title = decodeHtmlEntities(p?.title?.rendered || '').trim();
      if (!title || !p?.link) continue;
      const thumb = p?._embedded?.['wp:featuredmedia']?.[0]?.source_url
        || p?.yoast_head_json?.og_image?.[0]?.url
        || null;
      const castList = (p?._embedded?.['wp:term'] || []).flat().filter((t) => t?.taxonomy === 'cast').map((t) => decodeHtmlEntities(t.name));
      const studioList = (p?._embedded?.['wp:term'] || []).flat().filter((t) => t?.taxonomy === 'studios').map((t) => decodeHtmlEntities(t.name));
      pushItem({
        id: `pm_${p.id}`,
        title: title.slice(0, 180),
        type: 'video',
        mediaType: 'video',
        isAdult: true,
        isFeature: true,
        mediaUrl: p.link,
        videoUrl: null,
        streamUrl: null,
        fallbackUrls: [],
        thumbUrl: thumb,
        poster: thumb,
        pageUrl: p.link,
        duration: 'Full Feature',
        durationSeconds: 4800,
        quality: 'HD Feature',
        artist: castList.slice(0, 2).join(', ') || studioList[0] || (artist ? String(artist).replace(/[-_]+/g, ' ') : 'PandaMovies'),
        categories: studioList.slice(0, 4),
        headers: { Referer: p.link, 'User-Agent': DEFAULT_USER_AGENT },
        streamHeaders: { Referer: p.link, 'User-Agent': DEFAULT_USER_AGENT },
        category: 'adult_movies',
        sourceKey: 'pandamovies',
        source: 'PandaMovies',
        _matchScore: q ? scoreAdultTitleMatch(q, title) : 15
      });
    }

    if (q && mapped.length < 3 && pageNum === 0) {
      const htmlRes = await fetchImpl(`https://pandamovies.org/?s=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
        signal: signal || AbortSignal.timeout(6500)
      }).catch(() => null);
      if (htmlRes?.ok) {
        const html = await htmlRes.text();
        for (const m of html.matchAll(/<a[^>]+href="(https:\/\/pandamovies\.org\/watch-[^"]+)"[^>]*title="([^"]{2,120})"/gi)) {
          const title = decodeHtmlEntities(m[2]).trim();
          pushItem({
            id: `pm_s_${mapped.length}`,
            title,
            type: 'video',
            mediaType: 'video',
            isAdult: true,
            isFeature: true,
            mediaUrl: m[1],
            videoUrl: null,
            streamUrl: null,
            fallbackUrls: [],
            thumbUrl: null,
            poster: null,
            pageUrl: m[1],
            duration: 'Full Feature',
            durationSeconds: 4800,
            quality: 'HD Feature',
            artist: artist ? String(artist).replace(/[-_]+/g, ' ') : 'PandaMovies',
            headers: { Referer: m[1], 'User-Agent': DEFAULT_USER_AGENT },
            streamHeaders: { Referer: m[1], 'User-Agent': DEFAULT_USER_AGENT },
            category: 'adult_movies',
            sourceKey: 'pandamovies',
            source: 'PandaMovies',
            _matchScore: scoreAdultTitleMatch(q, title)
          });
        }
      }
    }

    mapped.sort((a, b) => b._matchScore - a._matchScore);
    return { results: mapped.slice(0, limit), totalPages, page: pageNum, source: 'PandaMovies' };
  } catch (err) {
    log.debug({ err: err?.message, query: q }, 'PandaMovies search failed');
    return { results: [], totalPages: 1 };
  }
}

export async function resolvePandaMoviesStream(pageUrl, { fetchImpl = fetch, ytExtractFn = null, signal = null } = {}) {
  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/([^/]+\.)?pandamovies\.org\//i.test(url)) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(7500)
    });
    if (!res?.ok) return null;
    const html = await res.text();
    const rawAttr = (html.match(/data-[a-z-]+="(\[\{(?:&quot;|")[^"]+)"/i) || [])[1];
    if (!rawAttr || !/(?:&quot;|")u(?:&quot;|")\s*:/.test(rawAttr)) return null;

    const list = JSON.parse(rawAttr.replace(/&quot;/g, '"').replace(/\\\//g, '/'));
    if (!Array.isArray(list) || !list.length) return null;

    // Prioritize direct MP4 hosts first (MixDrop -> StreamTape), then HLS (LuluStream -> VOE)
    const rankHost = (entry) => {
      const lbl = `${entry?.l || ''} ${entry?.u || ''}`.toLowerCase();
      if (/mixdrop/.test(lbl)) return 4;
      if (/streamtape/.test(lbl)) return 3;
      if (/lulu/.test(lbl)) return 2;
      if (/voe/.test(lbl)) return 1;
      return 0;
    };
    const ordered = [...list]
      .filter((e) => /^https?:\/\//i.test(e?.u || '') && rankHost(e) > 0)
      .sort((a, b) => rankHost(b) - rankHost(a));

    const resolvedStreams = [];
    for (const candidate of ordered.slice(0, 4)) {
      const ext = await extractEmbedStream(candidate.u, { referer: url, fetchImpl, ytExtractFn, signal });
      if (ext?.streamUrl) {
        resolvedStreams.push(ext);
        // Stop early once we have a direct non-HLS MP4, otherwise try one more for MP4 backup
        if (!ext.isHls) break;
      }
    }
    if (!resolvedStreams.length) return null;

    const primary = resolvedStreams.find((s) => !s.isHls) || resolvedStreams[0];
    const allVariants = resolvedStreams.flatMap((s) => s.variants || []);
    const allFallbacks = [...new Set(resolvedStreams.flatMap((s) => [s.streamUrl, ...(s.fallbackUrls || [])]).filter(Boolean))];
    return {
      ...primary,
      variants: allVariants.length ? allVariants : primary.variants,
      fallbackUrls: allFallbacks
    };
  } catch (err) {
    log.debug({ err: err?.message, url }, 'PandaMovies resolve failed');
    return null;
  }
}

/**
 * xHamster search + yt-dlp stream extractor.
 */
export async function searchXHamster({
  query = '',
  page = 0,
  limit = 15,
  minMinutes = 20,
  isBlocked = () => false,
  fetchImpl = fetch,
  signal = null
} = {}) {
  const norm = normalizeAdultMovieQuery(query);
  const q = norm.primaryQuery || norm.cleanQuery || 'full movie';
  const pageNum = Math.max(0, Number(page) || 0);
  const minDur = Math.max(0, Number(minMinutes) || 0);
  const targetUrl = `https://xhamster.com/search/${encodeURIComponent(q)}?${minDur ? `min-duration=${minDur}&` : ''}page=${pageNum + 1}`;

  try {
    const res = await fetchImpl(targetUrl, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: signal || AbortSignal.timeout(7500)
    });
    if (!res?.ok) return { results: [], totalPages: 1 };
    const html = await res.text();
    const m = html.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return { results: [], totalPages: 1 };

    const init = JSON.parse(m[1]);
    const rawList = init?.searchResult?.videoThumbProps || init?.layoutPage?.videoListProps?.videoThumbProps || [];
    const results = [];
    for (const v of rawList) {
      const title = decodeHtmlEntities(v?.title || '').trim();
      if (!title || !v?.pageURL || isBlocked(title)) continue;
      const durSec = Number(v.duration) || 0;
      results.push({
        id: `xh_${v.id || results.length}`,
        title: title.slice(0, 180),
        type: 'video',
        mediaType: 'video',
        isAdult: true,
        mediaUrl: v.pageURL,
        videoUrl: null,
        streamUrl: null,
        fallbackUrls: [],
        thumbUrl: v.thumbURL || v.imageURL || null,
        poster: v.thumbURL || v.imageURL || null,
        pageUrl: v.pageURL,
        duration: formatSec(durSec, 'HD'),
        durationSeconds: durSec,
        quality: v.isUHD ? '4K' : (v.isHD ? '720p+' : 'HD'),
        artist: v.landing?.name || 'xHamster Creator',
        headers: { Referer: 'https://xhamster.com/', 'User-Agent': DEFAULT_USER_AGENT },
        streamHeaders: { Referer: 'https://xhamster.com/', 'User-Agent': DEFAULT_USER_AGENT },
        category: 'xhamster',
        sourceKey: 'xhamster',
        source: 'xHamster'
      });
      if (results.length >= limit) break;
    }
    return { results, totalPages: results.length ? 20 : 1, page: pageNum, source: 'xHamster' };
  } catch (err) {
    log.debug({ err: err?.message, query: q }, 'xHamster search failed');
    return { results: [], totalPages: 1 };
  }
}

export async function probeReachableStreamUrl(url, headers = {}, fetchImpl = fetch) {
  const target = String(url || '').trim();
  if (!target || !/^https?:\/\//i.test(target)) return false;
  try {
    const res = await fetchImpl(target, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(4000)
    });
    res?.body?.cancel?.().catch?.(() => {});
    if (!res || (!res.ok && res.status !== 206)) return false;
    const ct = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/plain')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function resolveXHamsterStream(pageUrl, { ytExtractFn = null, fetchImpl = fetch, signal = null } = {}) {
  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/([a-z0-9-]+\.)?xhamster\./i.test(url)) return null;
  try {
    const fn = ytExtractFn || ((u) => defaultYtDlpExtract(u, { referer: 'https://xhamster.com/', signal }));
    const info = await fn(url);
    const variants = buildVariantsFromYtInfo(info);
    const primary = variants.find((v) => v.height === 720 && !v.isHls) || variants[0];
    const urlFallback = info?.url || primary?.url;
    if (!urlFallback) return null;

    const cleanHeaders = { Referer: 'https://xhamster.com/', 'User-Agent': DEFAULT_USER_AGENT };
    if (info?.http_headers && typeof info.http_headers === 'object') {
      for (const [k, v] of Object.entries(info.http_headers)) {
        if (!v || /^(?:sec-fetch-mode|accept)$/i.test(k)) continue;
        cleanHeaders[k] = v;
      }
    }

    const fallbackPool = [
      ...new Set([
        primary?.url,
        ...variants.filter((v) => !v.isHls).map((v) => v.url),
        urlFallback,
        ...variants.filter((v) => v.isHls && !/av1/i.test(v.url)).map((v) => v.url),
        ...variants.map((v) => v.url)
      ].filter(Boolean))
    ];

    let chosenUrl = primary?.url || urlFallback;
    if (!ytExtractFn && fetchImpl === fetch) {
      let verified = null;
      // Probe MP4 first, then H.264/HLS fallbacks so 403 MP4 CDN URLs automatically fail over to 200/206 HLS
      for (const candUrl of fallbackPool.slice(0, 6)) {
        if (await probeReachableStreamUrl(candUrl, cleanHeaders, fetchImpl)) {
          verified = candUrl;
          break;
        }
      }
      if (!verified) return null;
      chosenUrl = verified;
    }

    const isChosenHls = /\.m3u8(\?|$)/i.test(chosenUrl) || Boolean(variants.find((v) => v.url === chosenUrl)?.isHls);
    const orderedFallbacks = [chosenUrl, ...fallbackPool.filter((u) => u !== chosenUrl)];
    return {
      streamUrl: chosenUrl,
      highUrl: variants.find((v) => v.height >= 720)?.url || chosenUrl,
      lowUrl: variants.at(-1)?.url || chosenUrl,
      hlsUrl: variants.find((v) => v.isHls)?.url || (isChosenHls ? chosenUrl : null),
      isHls: isChosenHls,
      variants: variants.length ? variants : [{ quality: '720p', qualityLabel: '720p', height: 720, url: chosenUrl, isHls: isChosenHls, sizeBytes: null }],
      fallbackUrls: orderedFallbacks,
      durationSeconds: Number(info?.duration || 0) || 0,
      headers: cleanHeaders
    };
  } catch (err) {
    log.debug({ err: err?.message, url }, 'xHamster resolve failed');
    return null;
  }
}

/**
 * PornTrex (porntrex.com) search + flashvars direct 1080p/720p MP4 extractor.
 */
export async function searchPornTrex({
  query = '',
  page = 0,
  limit = 15,
  isBlocked = () => false,
  fetchImpl = fetch,
  signal = null
} = {}) {
  const norm = normalizeAdultMovieQuery(query);
  const q = (norm.primaryQuery || norm.cleanQuery || 'full movie').trim();
  const slug = q.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-');
  if (!slug) return { results: [], totalPages: 1 };
  const pageNum = Math.max(0, Number(page) || 0);
  const targetUrl = `https://www.porntrex.com/search/${encodeURIComponent(slug)}/${pageNum > 0 ? `latest/${pageNum + 1}/` : ''}`;

  try {
    const res = await fetchImpl(targetUrl, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: signal || AbortSignal.timeout(7500)
    });
    if (!res?.ok) return { results: [], totalPages: 1 };
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.video-item, .thumb-item').each((i, el) => {
      if (results.length >= limit) return;
      const linkEl = $(el).find('a[href*="/video/"]').first();
      const pageUrl = linkEl.attr('href') || '';
      const title = decodeHtmlEntities($(el).find('.title a, a[title]').first().attr('title') || $(el).find('.title').text() || '').trim();
      if (!title || !pageUrl || isBlocked(title)) return;
      const img = $(el).find('img').first();
      let thumb = img.attr('data-src') || img.attr('src') || null;
      if (thumb?.startsWith('//')) thumb = `https:${thumb}`;
      const durText = $(el).find('.duration, .durations').first().text().trim() || 'HD';
      const durSec = parseClockSec(durText);
      const idMatch = pageUrl.match(/\/video\/(\d+)\//);
      results.push({
        id: `pt_${idMatch?.[1] || i}`,
        title: title.slice(0, 180),
        type: 'video',
        mediaType: 'video',
        isAdult: true,
        mediaUrl: pageUrl,
        videoUrl: null,
        streamUrl: null,
        fallbackUrls: [],
        thumbUrl: thumb,
        poster: thumb,
        pageUrl,
        duration: durText,
        durationSeconds: durSec,
        quality: $(el).find('.hd-text-icon').length ? '1080p' : 'HD',
        artist: 'PornTrex Studio',
        headers: { Referer: 'https://www.porntrex.com/', 'User-Agent': DEFAULT_USER_AGENT },
        streamHeaders: { Referer: 'https://www.porntrex.com/', 'User-Agent': DEFAULT_USER_AGENT },
        category: 'porntrex',
        sourceKey: 'porntrex',
        source: 'PornTrex'
      });
    });

    return { results, totalPages: results.length ? 15 : 1, page: pageNum, source: 'PornTrex' };
  } catch (err) {
    log.debug({ err: err?.message, query: q }, 'PornTrex search failed');
    return { results: [], totalPages: 1 };
  }
}

export async function resolvePornTrexStream(pageUrl, { fetchImpl = fetch, signal = null } = {}) {
  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/([^/]+\.)?porntrex\.com\//i.test(url)) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Referer: 'https://www.porntrex.com/' },
      signal: signal || AbortSignal.timeout(7000)
    });
    if (!res?.ok) return null;
    const html = await res.text();
    const u1080 = html.match(/video_alt_url2\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
    const u720 = html.match(/video_alt_url\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
    const uSd = html.match(/video_url\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
    const variants = [];
    if (u720) variants.push({ quality: '720p', qualityLabel: '720p', height: 720, url: u720, isHls: false, sizeBytes: null });
    if (u1080) variants.push({ quality: '1080p', qualityLabel: '1080p', height: 1080, url: u1080, isHls: false, sizeBytes: null });
    if (uSd) variants.push({ quality: '480p', qualityLabel: '480p', height: 480, url: uSd, isHls: false, sizeBytes: null });
    const headers = { Referer: url, 'User-Agent': DEFAULT_USER_AGENT };
    let primary = u720 || u1080 || uSd;
    if (!primary) return null;
    const rawPool = variants.map((v) => v.url);
    if (fetchImpl === fetch) {
      let working = null;
      for (const candUrl of rawPool) {
        if (await probeReachableStreamUrl(candUrl, headers, fetchImpl)) {
          working = candUrl;
          break;
        }
      }
      if (!working) return null;
      primary = working;
    }
    return {
      streamUrl: primary,
      highUrl: u1080 || u720 || primary,
      lowUrl: uSd || u720 || primary,
      hlsUrl: null,
      isHls: false,
      variants,
      fallbackUrls: [primary, ...rawPool.filter((u) => u !== primary)],
      headers
    };
  } catch (err) {
    log.debug({ err: err?.message, url }, 'PornTrex resolve failed');
    return null;
  }
}
