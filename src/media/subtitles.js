import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { logger } from '../core/logger.js';
import { resolveFfmpegPath } from './convert.js';

const exec = promisify(execFile);

const OPENSUBTITLES_HEADERS = {
  'User-Agent': 'TemporaryUserAgent',
  Accept: 'application/json'
};

export function parseTimestampMs(raw) {
  const cleaned = String(raw || '').trim();
  const full = cleaned.match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (full) {
    const h = Number(full[1]), min = Number(full[2]), s = Number(full[3]);
    const ms = Number(full[4].padEnd(3, '0').slice(0, 3));
    return (((h * 60) + min) * 60 + s) * 1000 + ms;
  }
  const shortVtt = cleaned.match(/^(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
  if (shortVtt) {
    const min = Number(shortVtt[1]), s = Number(shortVtt[2]);
    const ms = Number(shortVtt[3].padEnd(3, '0').slice(0, 3));
    return (min * 60 + s) * 1000 + ms;
  }
  return null;
}

export function formatTimestampSrt(totalMs) {
  const clamped = Math.max(0, Math.floor(totalMs));
  const ms = clamped % 1000;
  const totalSec = Math.floor(clamped / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function serializeSrt(cues = []) {
  return (Array.isArray(cues) ? cues : [])
    .map((c, idx) => `${idx + 1}\n${formatTimestampSrt(c.startMs)} --> ${formatTimestampSrt(c.endMs)}\n${c.text}`)
    .join('\n\n')
    .concat(cues.length ? '\n' : '');
}

export function parseSrt(srtText) {
  const blocks = String(srtText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    if (!lines.length) continue;
    if (/^(?:WEBVTT|NOTE\b|STYLE\b|REGION\b)/i.test(lines[0])) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue;
    const [left, right] = lines[timingIdx].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const startMs = parseTimestampMs(left);
    const endMs = parseTimestampMs(right);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = lines.slice(timingIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

export function getCueAt(cues, positionMs) {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(positionMs)) return null;
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (positionMs < c.startMs) hi = mid - 1;
    else if (positionMs > c.endMs) lo = mid + 1;
    else return c;
  }
  return null;
}

export function shiftSrtText(srtText, offsetSeconds = 0) {
  const shiftMs = Math.max(0, Number(offsetSeconds) || 0) * 1000;
  if (!shiftMs) return String(srtText || '');
  const cues = parseSrt(srtText);
  const out = [];
  let idx = 1;
  for (const cue of cues) {
    if (cue.endMs <= shiftMs) continue;
    const startMs = Math.max(0, cue.startMs - shiftMs);
    const endMs = Math.max(startMs + 250, cue.endMs - shiftMs);
    out.push(`${idx++}\n${formatTimestampSrt(startMs)} --> ${formatTimestampSrt(endMs)}\n${cue.text}`);
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

function cleanTitleForSearch(title) {
  return String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-zA-Z0-9\s:'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROMO_SUB_RE = /\b(?:opensubtitles\.(?:org|com)|osdb\.link|subscene\.com|yify-?subtitles|addic7ed\.com|podnapisi\.net|hoofoot\.ru|advertise\s+your\s+product|api\.opensubtitles|ai\.opensubtitles)\b/i;

function isPromoCueText(text = '') {
  return PROMO_SUB_RE.test(String(text || ''));
}

function tokenizeSubTitle(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreSubtitleCandidate(sub, { title, year, season, episode } = {}) {
  const subName = String(sub?.SubFileName || sub?.MovieReleaseName || '').toLowerCase();
  const movieName = String(sub?.MovieName || '').toLowerCase();
  const clean = cleanTitleForSearch(title).toLowerCase();
  const titleWords = tokenizeSubTitle(clean).filter((w) => w.length >= 2 && !['the', 'and', 'for', 'with'].includes(w));
  const candToks = new Set([
    ...tokenizeSubTitle(movieName),
    ...tokenizeSubTitle(subName)
  ]);

  let matchedWords = 0;
  for (const w of titleWords) {
    if (candToks.has(w)) matchedWords += 1;
  }
  if (titleWords.length > 0 && matchedWords === 0) return -100;
  if (titleWords.length >= 2 && matchedWords / titleWords.length < 0.75) return -80;

  let score = matchedWords * 12;
  if (titleWords.length > 0 && matchedWords === titleWords.length) score += 12;

  const candYear = Number(sub?.MovieYear || 0);
  if (year && candYear > 1900) {
    if (candYear === Number(year)) score += 20;
    else if (Math.abs(candYear - Number(year)) > 1) return -60;
  }

  if (season && episode) {
    const tS = Number(season);
    const tE = Number(episode);
    const cS = Number(sub?.SeriesSeason || 0);
    const cE = Number(sub?.SeriesEpisode || 0);
    if ((cS && cS !== tS) || (cE && cE !== tE)) return -100;
    const seMatch = subName.match(/\bs(\d{1,2})e(\d{1,3})\b/i);
    if (seMatch && (Number(seMatch[1]) !== tS || Number(seMatch[2]) !== tE)) return -100;

    if (cS === tS && cE === tE) score += 45;
    const seTag = `s${String(tS).padStart(2, '0')}e${String(tE).padStart(2, '0')}`;
    if (subName.includes(seTag)) score += 35;
  } else {
    if (sub?.SeriesSeason || sub?.SeriesEpisode || /\bs\d{1,2}e\d{1,3}\b/i.test(subName)) return -80;
    if (String(sub?.MovieKind || '').toLowerCase() === 'movie') score += 10;
  }

  if (String(sub?.SubFormat || '').toLowerCase() === 'srt') score += 8;
  if (sub?.SubBad === '1') score -= 60;
  score += Math.min(12, Math.log10((Number(sub?.SubDownloadsCnt) || 1) + 1) * 3);
  return score;
}

export class SubtitleService {
  constructor({ cacheDir, ffmpeg = resolveFfmpegPath(process.env.FFMPEG_PATH || '') || 'ffmpeg', fetchImpl = fetch, runner = exec, log } = {}) {
    this.cacheDir = cacheDir || '/tmp/lancy-subs';
    this.ffmpeg = ffmpeg;
    this.fetch = fetchImpl;
    this.runner = runner;
    this.log = log || logger().child({ module: 'subtitles' });
    this.cueCache = new Map();
    try { mkdirSync(this.cacheDir, { recursive: true }); } catch {}
  }

  #cacheFilePath(key) {
    const hash = createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
    return join(this.cacheDir, `${hash}.srt`);
  }

  loadCues(srtPath) {
    if (!srtPath || !existsSync(srtPath)) return [];
    const hit = this.cueCache.get(srtPath);
    if (hit) return hit;
    try {
      const cues = parseSrt(readFileSync(srtPath, 'utf8'));
      if (this.cueCache.size > 40) {
        const first = this.cueCache.keys().next().value;
        if (first) this.cueCache.delete(first);
      }
      this.cueCache.set(srtPath, cues);
      return cues;
    } catch {
      return [];
    }
  }

  #streamSignature({ streamUrl = '', subtitleHints = [] } = {}) {
    const hintKey = (Array.isArray(subtitleHints) ? subtitleHints : [])
      .map((h) => String(h?.url || h?.file || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(',');
    if (hintKey) return createHash('sha1').update(`hints|${hintKey}`).digest('hex').slice(0, 10);
    if (streamUrl) {
      try {
        const u = new URL(String(streamUrl));
        return createHash('sha1').update(`${u.origin}${u.pathname}`).digest('hex').slice(0, 10);
      } catch {
        return createHash('sha1').update(String(streamUrl)).digest('hex').slice(0, 10);
      }
    }
    return 'meta';
  }

  async resolveForMedia({ title, year, imdbId, season, episode, streamUrl, headers, streamSource = '', language = 'eng', subtitleHints = [] } = {}) {
    const metaKey = `${title || ''}|${year || ''}|${imdbId || ''}|${season || ''}|${episode || ''}|${language}`;
    const hasHints = Array.isArray(subtitleHints) && subtitleHints.length > 0;
    const streamSig = this.#streamSignature({ streamUrl, subtitleHints });
    const streamFilePath = this.#cacheFilePath(`${metaKey}|${streamSig}`);
    const fallbackFilePath = this.#cacheFilePath(`${metaKey}|os_v2`);

    if (existsSync(streamFilePath)) {
      const cues = this.loadCues(streamFilePath);
      if (cues.length >= 5) return { found: true, filePath: streamFilePath, cues, language, source: 'cache' };
    }

    // 1. Try direct subtitle hints returned with this specific video stream (.vtt/.srt)
    if (hasHints) {
      const hintRes = await this.#fetchFromSubtitleHints(subtitleHints, { language, title }, streamFilePath).catch(() => null);
      if (hintRes) return hintRes;
    }

    // 2. Direct container tracks (MKV/MP4 from fallback catalogs) carry frame-exact embedded subtitles
    const isHls = /\.m3u8(\?|$)/i.test(String(streamUrl || '')) || String(streamSource).includes('tmdb');
    if (streamUrl && !isHls) {
      const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, streamFilePath).catch(() => null);
      if (emb) return emb;
    }

    // 3. OpenSubtitles lookup (strict score threshold + promo cue cleanup, scoped to os_v2 key)
    if (existsSync(fallbackFilePath)) {
      const cues = this.loadCues(fallbackFilePath);
      if (cues.length >= 10) return { found: true, filePath: fallbackFilePath, cues, language, source: 'cache' };
    }
    const osRes = await this.#fetchFromOpenSubtitles({ title, year, imdbId, season, episode, language }, fallbackFilePath).catch(() => null);
    if (osRes) return osRes;

    // 4. Last resort: check embedded stream even if HLS/unknown URL
    if (streamUrl && isHls) {
      const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, streamFilePath).catch(() => null);
      if (emb) return emb;
    }

    return null;
  }

  async #fetchFromSubtitleHints(hints, { language = 'eng', title = '' }, outPath) {
    const wantEn = /^en/i.test(String(language || 'eng'));
    const ranked = (Array.isArray(hints) ? hints : [])
      .map((h) => ({
        url: String(h?.url || h?.file || '').trim(),
        lang: String(h?.language || h?.lang || h?.label || '').trim(),
        headers: h?.headers && typeof h.headers === 'object' ? h.headers : {}
      }))
      .filter((h) => /^https?:\/\//i.test(h.url))
      .map((h) => {
        const l = h.lang.toLowerCase();
        let score = 0;
        if (wantEn && /\b(en|eng|english)\b/i.test(l)) score += 30;
        else if (!wantEn && l.includes(String(language).toLowerCase())) score += 30;
        if (/sdh|hearing|cc|forced/i.test(l)) score -= 4;
        if (/\.srt(\?|$)/i.test(h.url)) score += 3;
        return { ...h, score };
      })
      .sort((a, b) => b.score - a.score);

    for (const cand of ranked.slice(0, 4)) {
      if (wantEn && ranked.some((r) => r.score >= 25) && cand.score < 20) break;
      try {
        const res = await this.fetch(cand.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...cand.headers },
          signal: AbortSignal.timeout(7000)
        });
        if (!res?.ok) continue;
        let text = '';
        if (typeof res.arrayBuffer === 'function') {
          const buf = Buffer.from(await res.arrayBuffer());
          text = (buf[0] === 0x1f && buf[1] === 0x8b)
            ? gunzipSync(buf).toString('utf8')
            : buf.toString('utf8');
        } else if (typeof res.text === 'function') {
          text = await res.text();
        }
        const cues = parseSrt(text).filter((c) => !isPromoCueText(c.text));
        if (cues.length < 5) continue;
        const canonicalSrt = serializeSrt(cues);
        writeFileSync(outPath, canonicalSrt, 'utf8');
        this.cueCache.set(outPath, cues);
        const cleanLabel = wantEn ? 'English Subtitles' : `${title ? `${title} · ` : ''}Subtitles`;
        return {
          found: true,
          filePath: outPath,
          cues,
          language,
          label: cleanLabel,
          source: 'subtitle_hint'
        };
      } catch {}
    }
    return null;
  }

  async #fetchFromOpenSubtitles({ title, year, imdbId, season, episode, language = 'eng' }, outPath) {
    const parts = [];
    if (season && episode) {
      parts.push(`episode-${Number(episode)}`);
    }
    if (imdbId) {
      const numericImdb = String(imdbId).replace(/^tt/i, '').replace(/[^\d]/g, '');
      if (numericImdb) parts.push(`imdbid-${numericImdb}`);
    }
    const cleanTitle = cleanTitleForSearch(title);
    if (!imdbId && cleanTitle) {
      parts.push(`query-${encodeURIComponent(cleanTitle.toLowerCase())}`);
    }
    if (season && episode) {
      parts.push(`season-${Number(season)}`);
    }
    parts.push(`sublanguageid-${encodeURIComponent(language)}`);

    const url = `https://rest.opensubtitles.org/search/${parts.join('/')}`;
    const res = await this.fetch(url, { headers: OPENSUBTITLES_HEADERS, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length) return null;

    const ranked = rows
      .filter((r) => r?.SubDownloadLink && String(r?.SubFormat || '').toLowerCase() === 'srt')
      .map((r) => ({ item: r, score: scoreSubtitleCandidate(r, { title, year, season, episode }) }))
      .filter((r) => r.score >= 28)
      .sort((a, b) => b.score - a.score);

    for (const { item } of ranked.slice(0, 3)) {
      try {
        const dlRes = await this.fetch(item.SubDownloadLink, {
          headers: { 'User-Agent': 'TemporaryUserAgent' },
          signal: AbortSignal.timeout(8000)
        });
        if (!dlRes.ok) continue;
        const buf = Buffer.from(await dlRes.arrayBuffer());
        const srtText = (item.SubDownloadLink.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b))
          ? gunzipSync(buf).toString('utf8')
          : buf.toString('utf8');
        const cues = parseSrt(srtText).filter((c) => !isPromoCueText(c.text));
        if (cues.length < 10) continue;
        const canonicalSrt = serializeSrt(cues);
        writeFileSync(outPath, canonicalSrt, 'utf8');
        this.cueCache.set(outPath, cues);
        return {
          found: true,
          filePath: outPath,
          cues,
          language,
          label: item.SubFileName || `${title} (${language.toUpperCase()})`,
          source: 'opensubtitles'
        };
      } catch {}
    }
    return null;
  }

  async #extractEmbeddedSubtitle(streamUrl, headers, outPath) {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    if (headers && typeof headers === 'object') {
      const hdrStr = Object.entries(headers)
        .filter(([k, v]) => k && v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      if (hdrStr) args.push('-headers', `${hdrStr}\r\n`);
    }
    args.push('-i', streamUrl, '-map', '0:s:0', '-f', 'srt', outPath);
    await this.runner(this.ffmpeg, args, { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
    if (!existsSync(outPath)) return null;
    const cues = this.loadCues(outPath);
    if (cues.length < 5) return null;
    return { found: true, filePath: outPath, cues, language: 'eng', label: 'Embedded MKV', source: 'embedded' };
  }
}
