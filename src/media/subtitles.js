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

const VTT_TIMING_RE = /^(\d{1,3}:\d{2}(?::\d{2})?[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}(?::\d{2})?[,.]\d{1,3})(?:\s|$)/;

export function parseSrt(srtText) {
  const lines = String(srtText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const cues = [];
  let skipBlock = false;
  let activeCue = null;

  const flushActive = () => {
    if (!activeCue) return;
    const text = activeCue.lines
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();
    if (text && activeCue.endMs > activeCue.startMs) {
      cues.push({ startMs: activeCue.startMs, endMs: activeCue.endMs, text });
    }
    activeCue = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      skipBlock = false;
      flushActive();
      continue;
    }
    if (!activeCue && (/^(?:WEBVTT(?:\s|$)|X-TIMESTAMP-MAP\b)/i.test(trimmed))) {
      continue;
    }
    if (!activeCue && /^(?:NOTE\b|STYLE\b|REGION\b)/i.test(trimmed)) {
      skipBlock = true;
      continue;
    }
    const timingM = trimmed.match(VTT_TIMING_RE);
    if (timingM) {
      skipBlock = false;
      flushActive();
      const startMs = parseTimestampMs(timingM[1]);
      const endMs = parseTimestampMs(timingM[2]);
      if (startMs !== null && endMs !== null && endMs > startMs) {
        activeCue = { startMs, endMs, lines: [] };
      }
      continue;
    }
    if (skipBlock) continue;
    // Skip cue identifier/index line right before a timing line (only before cue text or for numeric SRT indices)
    if (i + 1 < lines.length && VTT_TIMING_RE.test(lines[i + 1].trim())) {
      if (!activeCue || (activeCue.lines.length > 0 && /^\d+$/.test(trimmed))) {
        flushActive();
        continue;
      }
    }
    if (activeCue) {
      activeCue.lines.push(line);
    }
  }
  flushActive();
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

function decodeTtmlEntities(text = '') {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseTtmlTimestampMs(raw, tickRate = 10000000, frameRate = 24) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const standard = parseTimestampMs(s);
  if (standard !== null) return standard;
  const effFps = (Number.isFinite(Number(frameRate)) && Number(frameRate) > 0) ? Number(frameRate) : 24;
  const colonFrames = s.match(/^(\d{1,3}):(\d{2}):(\d{2})[:.](\d{1,2})$/);
  if (colonFrames) {
    const h = Number(colonFrames[1]), m = Number(colonFrames[2]), sec = Number(colonFrames[3]), f = Number(colonFrames[4]);
    return (((h * 60 + m) * 60 + sec) * 1000) + Math.round((f / effFps) * 1000);
  }
  const frameM = s.match(/^(\d+(?:\.\d+)?)f$/i);
  if (frameM) return Math.round((Number(frameM[1]) / effFps) * 1000);
  const tickM = s.match(/^(\d+(?:\.\d+)?)t$/i);
  if (tickM && tickRate > 0) return Math.round((Number(tickM[1]) / tickRate) * 1000);
  const msM = s.match(/^(\d+(?:\.\d+)?)ms$/i);
  if (msM) return Math.round(Number(msM[1]));
  const secM = s.match(/^(\d+(?:\.\d+)?)s$/i);
  if (secM) return Math.round(Number(secM[1]) * 1000);
  const minM = s.match(/^(\d+(?:\.\d+)?)m$/i);
  if (minM) return Math.round(Number(minM[1]) * 60000);
  const hrM = s.match(/^(\d+(?:\.\d+)?)h$/i);
  if (hrM) return Math.round(Number(hrM[1]) * 3600000);
  return null;
}

export function parseTtml(xmlText) {
  const src = String(xmlText || '').replace(/^\uFEFF/, '');
  const tickMatch = src.match(/\b(?:ttp:)?tickRate\s*=\s*["'](\d+)["']/i);
  const tickRate = tickMatch ? Number(tickMatch[1]) || 10000000 : 10000000;
  const fpsMatch = src.match(/\b(?:ttp:)?frameRate\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
  const multMatch = src.match(/\b(?:ttp:)?frameRateMultiplier\s*=\s*["'](\d+)\s+(\d+)["']/i);
  let frameRate = fpsMatch ? (Number(fpsMatch[1]) || 24) : 24;
  if (multMatch && Number(multMatch[2]) > 0) {
    frameRate *= Number(multMatch[1]) / Number(multMatch[2]);
  }
  const cues = [];
  for (const m of src.matchAll(/<(?:[a-z0-9]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[a-z0-9]+:)?p>/gi)) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const beginRaw = attrs.match(/\bbegin\s*=\s*["']([^"']+)["']/i)?.[1];
    const endRaw = attrs.match(/\bend\s*=\s*["']([^"']+)["']/i)?.[1];
    const durRaw = attrs.match(/\bdur\s*=\s*["']([^"']+)["']/i)?.[1];
    const startMs = parseTtmlTimestampMs(beginRaw, tickRate, frameRate);
    let endMs = parseTtmlTimestampMs(endRaw, tickRate, frameRate);
    if (startMs !== null && endMs === null && durRaw) {
      const durMs = parseTtmlTimestampMs(durRaw, tickRate, frameRate);
      if (durMs !== null && durMs > 0) endMs = startMs + durMs;
    }
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = decodeTtmlEntities(
      inner
        .replace(/<(?:[a-z0-9]+:)?br\b[^>]*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

function parseAssTimestampMs(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[.:](\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]), s = Number(m[3]), frac = m[4];
  const ms = frac.length === 2 ? Number(frac) * 10 : Number(frac.padEnd(3, '0').slice(0, 3));
  return (((h * 60 + min) * 60 + s) * 1000) + ms;
}

export function parseAss(assText) {
  const lines = String(assText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  let startIdx = 1, endIdx = 2, textIdx = 9;
  const cues = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Format\s*:/i.test(line)) {
      const cols = line.replace(/^Format\s*:/i, '').split(',').map((c) => c.trim().toLowerCase());
      const sI = cols.indexOf('start');
      const eI = cols.indexOf('end');
      const tI = cols.indexOf('text');
      if (sI >= 0 && eI >= 0 && tI >= 0) {
        startIdx = sI;
        endIdx = eI;
        textIdx = tI;
      }
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const payload = line.replace(/^Dialogue\s*:\s*/i, '');
    const parts = payload.split(',');
    if (parts.length <= Math.max(startIdx, endIdx, textIdx)) continue;
    const startMs = parseAssTimestampMs(parts[startIdx]);
    const endMs = parseAssTimestampMs(parts[endIdx]);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const rawText = parts.slice(textIdx).join(',');
    // Skip ASS vector drawing paths (\p1..)
    if (/\{[^}]*\\p[1-9][^}]*\}/.test(rawText)) continue;
    const cleanText = rawText
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[nN]/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!cleanText) continue;
    cues.push({ startMs, endMs, text: cleanText });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

export function parseAnySubtitleText(rawText, extHint = '') {
  const sample = String(rawText || '').replace(/^\uFEFF/, '').trimStart();
  const hint = String(extHint || '').toLowerCase();
  if (!sample) return [];
  if (hint === 'ttml' || hint === 'dfxp' || /^(?:<\?xml\b|<tt\b)/i.test(sample) || /<(?:tt:)?p\b[^>]*\bbegin=/i.test(sample.slice(0, 2000))) {
    const ttmlCues = parseTtml(sample);
    if (ttmlCues.length) return ttmlCues;
  }
  if (hint === 'ass' || hint === 'ssa' || /^\[Script Info\]/im.test(sample.slice(0, 1200)) || /^Dialogue\s*:/im.test(sample)) {
    const assCues = parseAss(sample);
    if (assCues.length) return assCues;
  }
  return parseSrt(sample);
}

const CUE_MAX_SPAN_CACHE = new WeakMap();

function getMaxCueSpanMs(cues) {
  let maxSpan = CUE_MAX_SPAN_CACHE.get(cues);
  if (maxSpan === undefined) {
    maxSpan = 0;
    for (let i = 0; i < cues.length; i++) {
      const span = (Number(cues[i]?.endMs) || 0) - (Number(cues[i]?.startMs) || 0);
      if (span > maxSpan) maxSpan = span;
    }
    CUE_MAX_SPAN_CACHE.set(cues, maxSpan);
  }
  return maxSpan;
}

export function getCueAt(cues, positionMs) {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(positionMs)) return null;
  // Upper-bound binary search: find rightmost cue with startMs <= positionMs
  let lo = 0, hi = cues.length - 1, right = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startMs <= positionMs) {
      right = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (right < 0) return null;
  const maxSpan = getMaxCueSpanMs(cues);
  const active = [];
  for (let i = right; i >= 0; i--) {
    const c = cues[i];
    if (positionMs - c.startMs > maxSpan + 1000) break;
    if (c.startMs <= positionMs && positionMs <= c.endMs) {
      active.push(c);
    }
  }
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  active.reverse();
  const seenLines = new Set();
  const lines = [];
  let minStart = active[0].startMs;
  let maxEnd = active[0].endMs;
  for (const c of active) {
    if (c.startMs < minStart) minStart = c.startMs;
    if (c.endMs > maxEnd) maxEnd = c.endMs;
    for (const ln of String(c.text || '').split(/\r?\n/)) {
      const clean = ln.trim();
      if (!clean || seenLines.has(clean)) continue;
      seenLines.add(clean);
      lines.push(clean);
    }
  }
  return { startMs: minStart, endMs: maxEnd, text: lines.join('\n') };
}

export function mapMediaSecToSubMs(mediaSec, { offsetSec = 0, driftRate = 0, driftAnchorSec = 0 } = {}) {
  const t = Number(mediaSec) || 0;
  const off = Number(offsetSec) || 0;
  const rawDrift = Number(driftRate) || 0;
  const drift = Math.max(-0.08, Math.min(0.08, rawDrift));
  const anchor = Number(driftAnchorSec) || 0;
  const subSec = t - off - (drift * (t - anchor));
  return Math.max(0, Math.round(subSec * 1000));
}

export function shiftSrtText(srtText, offsetSeconds = 0) {
  const shiftMs = Math.round((Number(offsetSeconds) || 0) * 1000);
  if (Math.abs(shiftMs) < 10) return String(srtText || '');
  const cues = parseSrt(srtText);
  const out = [];
  let idx = 1;
  for (const cue of cues) {
    if (cue.endMs - shiftMs <= 0) continue;
    const startMs = Math.max(0, cue.startMs - shiftMs);
    const endMs = Math.max(startMs + 250, cue.endMs - shiftMs);
    out.push(`${idx++}\n${formatTimestampSrt(startMs)} --> ${formatTimestampSrt(endMs)}\n${cue.text}`);
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

function cleanTitleForSearch(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-zA-Z0-9\s:'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TMDB_SUB_CDN = 'https://cache.vdrk.site/v1/vtt';
const CDN_LANG_NAMES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', pt: 'Portuguese', por: 'Portuguese', it: 'Italian', ita: 'Italian',
  ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi', tr: 'Turkish', tur: 'Turkish', ru: 'Russian', rus: 'Russian'
};

export function buildTmdbCdnSubtitleHints({ tmdbId, type = '', season = null, episode = null, language = 'eng' } = {}) {
  const idStr = String(tmdbId || '').trim();
  if (!/^\d+$/.test(idStr)) return [];
  const isTv = String(type || '').toLowerCase() === 'tv' || Boolean(season && episode);
  if (isTv && !(Number(season) > 0 && Number(episode) > 0)) return [];
  const base = isTv
    ? `${TMDB_SUB_CDN}/tv/${idStr}/${Number(season)}/${Number(episode)}`
    : `${TMDB_SUB_CDN}/movie/${idStr}`;
  const wantKey = String(language || 'eng').toLowerCase();
  const names = [];
  const wantName = CDN_LANG_NAMES[wantKey] || CDN_LANG_NAMES[wantKey.slice(0, 2)];
  if (wantName) names.push(wantName);
  if (!names.includes('English')) names.push('English');
  return names.map((n) => ({
    url: `${base}/${n}.vtt`,
    language: n,
    label: `${n} Subtitles`,
    type: 'vtt',
    tier: 'meta_match'
  }));
}

const PROMO_SUB_RE = /\b(?:opensubtitles\.(?:org|com)|osdb\.link|subscene\.com|yify-?subtitles|addic7ed\.com|podnapisi\.net|hoofoot\.ru|advertise\s+your\s+product|api\.opensubtitles|ai\.opensubtitles|getray\.app)\b/i;

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

function scoreSubtitleCandidate(sub, { title, year, season, episode, releaseHint = '' } = {}) {
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
  if (/\b(?:web-?dl|webrip)\b/i.test(subName)) score += 4;
  if (/\b(?:sdh|hi)\b/i.test(subName) || String(sub?.SubHearingImpaired || '') === '1') score -= 3;
  if (releaseHint && /\b(?:bluray|bdrip|brrip|web-?dl|webrip|hdtv)\b/i.test(releaseHint)) {
    const relTok = releaseHint.toLowerCase().match(/\b(bluray|bdrip|brrip|web-?dl|webrip|hdtv)\b/i)?.[1]?.replace('-', '') || '';
    if (relTok && subName.replace(/-/g, '').includes(relTok)) score += 8;
  }
  if (sub?.SubBad === '1') score -= 60;
  score += Math.min(12, Math.log10((Number(sub?.SubDownloadsCnt) || 1) + 1) * 3);
  return score;
}

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

function resolveFfprobeFromFfmpeg(ffmpegPath) {
  const s = String(ffmpegPath || '').trim();
  if (!s || s === 'ffmpeg') return 'ffprobe';
  return s.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function cuesFitDuration(cues, durationSeconds, { strictMinRatio = true } = {}) {
  const dur = Number(durationSeconds || 0);
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(dur) || dur < 600) return true;
  const lastEndSec = (Number(cues[cues.length - 1]?.endMs) || 0) / 1000;
  if (!lastEndSec) return false;
  const ratio = lastEndSec / dur;
  if (!strictMinRatio || cues.length < 20) return ratio <= 1.5;
  const minRatio = dur >= 1200 ? 0.62 : 0.50;
  const maxRatio = dur >= 1200 ? 1.25 : 1.32;
  if (ratio < minRatio || ratio > maxRatio) return false;
  if (dur >= 1200 && cues.length >= 40) {
    const midSec = (Number(cues[Math.floor(cues.length / 2)]?.startMs) || 0) / 1000;
    const midRatio = midSec / dur;
    if (midRatio < 0.12 || midRatio > 0.90) return false;
  }
  return true;
}

function dedupeOverlappingCues(cues = []) {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const cue of sorted) {
    let merged = false;
    for (let j = out.length - 1; j >= 0 && j >= out.length - 6; j--) {
      const prev = out[j];
      if (cue.startMs > prev.endMs + 250) continue;
      if (prev.text === cue.text) {
        prev.endMs = Math.max(prev.endMs, cue.endMs);
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ ...cue });
  }
  return out;
}

export class SubtitleService {
  constructor({ cacheDir, ffmpeg = resolveFfmpegPath(process.env.FFMPEG_PATH || '') || 'ffmpeg', ffprobe = null, fetchImpl = fetch, runner = exec, log } = {}) {
    this.cacheDir = cacheDir || '/tmp/lancy-subs';
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe || resolveFfprobeFromFfmpeg(ffmpeg);
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
    let urlPart = '';
    if (streamUrl) {
      try {
        const u = new URL(String(streamUrl));
        const volatileParams = new Set(['token', 'sig', 'expires', 'exp', 'hdnea', 'hmac', 'ip', 'ts', '_t', 'auth', 'key', 'signature', 'policy', 'st', 'e_ts']);
        const stableQuery = [];
        for (const [k, v] of u.searchParams.entries()) {
          if (!v || volatileParams.has(String(k).toLowerCase())) continue;
          stableQuery.push([k, v]);
        }
        stableQuery.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        const qs = stableQuery.map(([k, v]) => `${k}=${v}`).join('&');
        urlPart = qs ? `${u.origin}${u.pathname}?${qs}` : `${u.origin}${u.pathname}`;
      } catch {
        urlPart = String(streamUrl);
      }
    }
    const hintKey = (Array.isArray(subtitleHints) ? subtitleHints : [])
      .map((h) => String(h?.url || h?.file || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(',');
    const combined = [urlPart, hintKey].filter(Boolean).join('|');
    if (combined) return createHash('sha1').update(combined).digest('hex').slice(0, 12);
    return 'meta';
  }

  #canProbeMediaSource(streamUrl) {
    if (!streamUrl) return false;
    const isRemote = /^https?:\/\//i.test(String(streamUrl));
    const isLocal = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):/i.test(String(streamUrl));
    if (isRemote && !isLocal && this.fetch !== fetch && this.runner === exec) {
      return false;
    }
    return true;
  }

  async resolveForMedia({
    title,
    year,
    imdbId,
    season,
    episode,
    streamUrl,
    headers,
    streamSource = '',
    language = 'eng',
    subtitleHints = [],
    durationSeconds = null,
    releaseHint = '',
    embeddedOnly = false,
    tmdbId = null,
    type = ''
  } = {}) {
    const metaKey = `${title || ''}|${year || ''}|${imdbId || ''}|${season || ''}|${episode || ''}|${language}`;
    const allHints = Array.isArray(subtitleHints) ? subtitleHints.filter((h) => h && (h.url || h.file)) : [];
    const sameRouteHints = allHints.filter((h) => !h.tier || h.tier === 'same_route');
    const metaHints = allHints.filter((h) => h.tier === 'meta_match');
    const streamSig = this.#streamSignature({ streamUrl, subtitleHints: sameRouteHints.length ? sameRouteHints : allHints });
    // Backup tier: TMDB-keyed subtitle CDN so every resolved title gets a track even when
    // the DASH/HLS manifest carries no text adaptation sets.
    for (const h of buildTmdbCdnSubtitleHints({ tmdbId, type, season, episode, language })) {
      if (!metaHints.some((m) => (m.url || m.file) === h.url)) metaHints.push(h);
    }
    const baseTrackKey = `${metaKey}|${streamSig}`;
    const streamFilePath = this.#cacheFilePath(`${baseTrackKey}|v4`);
    const altHintPath = this.#cacheFilePath(`${baseTrackKey}|alt_hint_v4`);
    const fallbackFilePath = this.#cacheFilePath(`${metaKey}|${streamSig === 'meta' ? '' : `${streamSig}|`}os_v4`);
    const tracksFilePath = `${streamFilePath}.tracks.json`;

    if (existsSync(streamFilePath)) {
      const cues = this.loadCues(streamFilePath);
      let savedTracks = [{ filePath: streamFilePath, language, label: 'Synced Subtitles', source: 'cache', sameRoute: false, cuesCount: cues.length }];
      if (existsSync(tracksFilePath)) {
        try {
          const parsedTracks = JSON.parse(readFileSync(tracksFilePath, 'utf8'));
          if (Array.isArray(parsedTracks) && parsedTracks.length) {
            savedTracks = parsedTracks.filter((tr) => tr?.filePath && existsSync(tr.filePath));
          }
        } catch {}
      }
      const isRouteBound = ['embedded', 'subtitle_hint'].includes(savedTracks[0]?.source);
      if (cues.length >= 5 && cuesFitDuration(cues, durationSeconds, { strictMinRatio: !isRouteBound })) {
        return {
          found: true,
          filePath: savedTracks[0]?.filePath || streamFilePath,
          cues,
          language,
          label: savedTracks[0]?.label || 'Synced Subtitles',
          source: savedTracks[0]?.source || 'cache',
          sameRoute: Boolean(isRouteBound || savedTracks[0]?.sameRoute),
          tracks: savedTracks
        };
      }
    }

    const candidates = [];
    const seenPaths = new Set();
    const seenSigs = new Set();
    const pushTrack = (res) => {
      if (!res?.filePath || !res.cues?.length || seenPaths.has(res.filePath)) return;
      const firstTxt = String(res.cues[0]?.text || '').slice(0, 48);
      const dedupSig = `${String(res.language || '').toLowerCase()}|${String(res.label || '').toLowerCase()}|${res.cues.length}|${firstTxt}`;
      if (seenSigs.has(dedupSig)) return;
      seenPaths.add(res.filePath);
      seenSigs.add(dedupSig);
      candidates.push(res);
    };

    const isContainerStream = Boolean(streamUrl) && !/\.(?:m3u8|mpd)(\?|$)/i.test(String(streamUrl));

    if (embeddedOnly) {
      if (streamUrl && isContainerStream && this.#canProbeMediaSource(streamUrl)) {
        const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, streamFilePath, { language }).catch(() => null);
        if (emb && cuesFitDuration(emb.cues, durationSeconds, { strictMinRatio: false })) {
          return {
            ...emb,
            sameRoute: true,
            tracks: [{
              filePath: emb.filePath,
              language: emb.language || language,
              label: emb.label || 'Embedded Track',
              source: 'embedded',
              sameRoute: true,
              cuesCount: emb.cues?.length || 0
            }]
          };
        }
      }
      return null;
    }

    // 1. ALL same-route subtitle hints attached to the exact resolved stream (.vtt/.srt/.ttml/.ass / full HLS VTT)
    if (sameRouteHints.length) {
      const hintTracks = await this.#fetchFromSubtitleHints(
        sameRouteHints,
        { language, title, defaultHeaders: headers, durationSeconds },
        streamFilePath,
        { collectAll: true, baseKey: baseTrackKey }
      ).catch(() => []);
      for (const ht of (Array.isArray(hintTracks) ? hintTracks : (hintTracks ? [hintTracks] : []))) {
        pushTrack(ht);
      }
    }

    // 2. Embedded container text tracks (MKV/MP4) inspected cleanly via ffprobe BEFORE cross-host hints/OpenSubtitles
    if (streamUrl && isContainerStream && this.#canProbeMediaSource(streamUrl)) {
      const embPath = seenPaths.has(streamFilePath) ? altHintPath : streamFilePath;
      const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, embPath, { language }).catch(() => null);
      if (emb && cuesFitDuration(emb.cues, durationSeconds, { strictMinRatio: false })) {
        pushTrack(emb);
      }
    }

    // 3. ALL meta-matched hints from companion routes (e.g. Punkflix/Berlin/stream nodes)
    if (metaHints.length) {
      const metaPrimaryPath = seenPaths.has(streamFilePath)
        ? (seenPaths.has(altHintPath) ? this.#cacheFilePath(`${baseTrackKey}|meta_primary_v4`) : altHintPath)
        : streamFilePath;
      const metaTracks = await this.#fetchFromSubtitleHints(
        metaHints,
        { language, title, defaultHeaders: headers, durationSeconds },
        metaPrimaryPath,
        { collectAll: true, baseKey: `${baseTrackKey}|meta` }
      ).catch(() => []);
      for (const mt of (Array.isArray(metaTracks) ? metaTracks : (metaTracks ? [metaTracks] : []))) {
        pushTrack(mt);
      }
    }

    // 4. OpenSubtitles lookup ONLY when source tracks don't already have a clean full target-language dialogue track (or <2 total and lacking clean source)
    const wantEn = /^en/i.test(String(language || 'eng'));
    const hasCleanSourceDialogue = candidates.some((c) => {
      if (!['embedded', 'subtitle_hint'].includes(c.source)) return false;
      const lang = String(c.language || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      const langMatches = wantEn ? /^(?:en|eng|english)\b/.test(lang) : lang.includes(String(language).toLowerCase());
      return langMatches && !/\b(?:forced|signs)\b/.test(lbl);
    });
    if (candidates.length < 2 && !hasCleanSourceDialogue) {
      let osRes = null;
      if (existsSync(fallbackFilePath)) {
        const cachedOs = this.loadCues(fallbackFilePath);
        if (cachedOs.length >= 10 && cuesFitDuration(cachedOs, durationSeconds)) {
          osRes = { found: true, filePath: fallbackFilePath, cues: cachedOs, language, label: 'OpenSubtitles', source: 'opensubtitles' };
        }
      }
      if (!osRes) {
        const osOutPath = seenPaths.has(streamFilePath) ? fallbackFilePath : streamFilePath;
        osRes = await this.#fetchFromOpenSubtitles(
          { title, year, imdbId, season, episode, language, durationSeconds, releaseHint: releaseHint || streamSource },
          osOutPath
        ).catch(() => null);
      }
      if (osRes) pushTrack(osRes);
    }

    // 5. Last resort: embedded stream even if HLS/unknown URL when nothing else found
    if (!candidates.length && streamUrl && !isContainerStream && this.#canProbeMediaSource(streamUrl)) {
      const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, streamFilePath, { language }).catch(() => null);
      if (emb && cuesFitDuration(emb.cues, durationSeconds, { strictMinRatio: false })) pushTrack(emb);
    }

    if (!candidates.length) return null;

    // Prioritize Embedded > Same-Route Hint > Meta-Match Hint > OpenSubtitles, preferring clean dialogue in target language
    const tierOrder = { embedded: 0, subtitle_hint: 1, meta_hint: 2, opensubtitles: 3 };
    const rankCandidate = (c) => {
      const tier = tierOrder[c.source] ?? 9;
      const lang = String(c.language || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      const langOk = wantEn ? (/^(?:en|eng|english)\b/.test(lang) || /\benglish\b/.test(lbl)) : lang.includes(String(language).toLowerCase());
      const isForcedOrSigns = /\b(?:forced|signs)\b/.test(lbl);
      const isSdh = /\b(?:sdh|cc|hearing\s*impaired)\b/.test(lbl);
      return (tier * 100) + (langOk ? 0 : 40) + (isForcedOrSigns ? 20 : isSdh ? 5 : 0);
    };
    candidates.sort((a, b) => rankCandidate(a) - rankCandidate(b));

    const tracks = candidates.slice(0, 8).map((c) => ({
      filePath: c.filePath,
      language: c.language || language,
      label: c.label || 'Subtitles',
      source: c.source,
      sameRoute: ['embedded', 'subtitle_hint'].includes(c.source),
      cuesCount: c.cues.length
    }));
    const primary = candidates[0];
    // Ensure primary track is also cached at streamFilePath so cache-hit lookup succeeds cleanly
    if (primary.filePath !== streamFilePath && !existsSync(streamFilePath)) {
      try {
        writeFileSync(streamFilePath, serializeSrt(primary.cues), 'utf8');
        this.cueCache.set(streamFilePath, primary.cues);
      } catch {}
    }
    try {
      writeFileSync(tracksFilePath, JSON.stringify(tracks), 'utf8');
    } catch {}

    return {
      ...primary,
      sameRoute: ['embedded', 'subtitle_hint'].includes(primary?.source),
      tracks
    };
  }

  async #fetchHlsVttPlaylist(playlistUrl, headers, durationSeconds = null) {
    const res = await this.fetch(playlistUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers },
      signal: AbortSignal.timeout(8000)
    });
    if (!res?.ok) return '';
    const bufOrText = typeof res.arrayBuffer === 'function'
      ? (() => res.arrayBuffer().then((ab) => {
          const b = Buffer.from(ab);
          return (b[0] === 0x1f && b[1] === 0x8b) ? gunzipSync(b).toString('utf8') : b.toString('utf8');
        }))()
      : res.text();
    let text = await bufOrText;
    if (!text || !text.trimStart().startsWith('#EXTM3U')) return text || '';

    const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Handle nested variant subtitle playlist once if present
    const nestedLine = rawLines.find((l) => !l.startsWith('#') && /\.m3u8(\?|$)/i.test(l));
    if (nestedLine) {
      const nestedUrl = new URL(nestedLine, playlistUrl).toString();
      const nestedRes = await this.fetch(nestedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers },
        signal: AbortSignal.timeout(8000)
      }).catch(() => null);
      if (nestedRes?.ok && typeof nestedRes.text === 'function') {
        text = await nestedRes.text();
        playlistUrl = nestedUrl;
      }
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const segEntries = [];
    const seen = new Set();
    let pendingDurSec = 0;
    let accumStartMs = 0;
    for (const line of lines) {
      const extMatch = line.match(/^#EXTINF\s*:\s*([0-9.]+)/i);
      if (extMatch) {
        pendingDurSec = Math.max(0, parseFloat(extMatch[1]) || 0);
        continue;
      }
      if (line.startsWith('#')) continue;
      try {
        const abs = new URL(line, playlistUrl).toString();
        if (!seen.has(abs)) {
          seen.add(abs);
          segEntries.push({ url: abs, startMs: Math.round(accumStartMs), durMs: Math.round(pendingDurSec * 1000) });
        }
        accumStartMs += pendingDurSec * 1000;
        pendingDurSec = 0;
      } catch {}
    }
    const maxSegs = Math.min(segEntries.length, 2500);
    const selected = segEntries.slice(0, maxSegs);
    const rawSegs = new Array(selected.length).fill('');
    const deadline = Date.now() + 30_000;
    const batchSize = 10;
    for (let i = 0; i < selected.length && Date.now() < deadline; i += batchSize) {
      const slice = selected.slice(i, i + batchSize);
      await Promise.all(slice.map(async (seg, idx) => {
        try {
          const segRes = await this.fetch(seg.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers },
            signal: AbortSignal.timeout(6500)
          });
          if (!segRes?.ok) return;
          if (typeof segRes.arrayBuffer === 'function') {
            const b = Buffer.from(await segRes.arrayBuffer());
            rawSegs[i + idx] = (b[0] === 0x1f && b[1] === 0x8b) ? gunzipSync(b).toString('utf8') : b.toString('utf8');
          } else if (typeof segRes.text === 'function') {
            rawSegs[i + idx] = await segRes.text();
          }
        } catch {}
      }));
    }

    let baseMpegtsOriginMs = null;
    const mergedCues = [];
    for (let i = 0; i < selected.length; i++) {
      const segText = rawSegs[i];
      if (!segText) continue;
      const segStartMs = selected[i].startMs;
      const segDurMs = selected[i].durMs || 60000;
      let segCues = parseSrt(segText);
      const tsMapM = segText.match(/X-TIMESTAMP-MAP=.*?(?:MPEGTS:(\d+).*?LOCAL:([0-9:.]+)|LOCAL:([0-9:.]+).*?MPEGTS:(\d+))/i);
      if (tsMapM) {
        const mpegtsTicks = Number(tsMapM[1] || tsMapM[4] || 0);
        const localRaw = tsMapM[2] || tsMapM[3] || '';
        const localMs = parseTimestampMs(localRaw);
        if (Number.isFinite(mpegtsTicks) && localMs !== null) {
          const mpegtsMs = (mpegtsTicks * 1000) / 90000;
          const mapDeltaMs = mpegtsMs - localMs;
          const firstCueMs = segCues.length ? segCues[0].startMs : 0;
          if (baseMpegtsOriginMs === null && localMs === 0 && mpegtsMs >= 0) {
            if (i === 0 && (!segCues.length || firstCueMs < Math.max(segDurMs + 5000, 120000))) {
              baseMpegtsOriginMs = mpegtsMs;
            } else if (i > 0) {
              const cuesLookLocal = !segCues.length || firstCueMs < Math.max(segStartMs - 1000, segDurMs + 5000);
              baseMpegtsOriginMs = cuesLookLocal ? Math.max(0, mpegtsMs - segStartMs) : mpegtsMs;
            }
          }
          if (segCues.length) {
            let shiftByMs = 0;
            if (mpegtsTicks === 0 && localMs > 1000 && firstCueMs >= localMs - 500) {
              shiftByMs = -localMs;
            } else {
              const origin = baseMpegtsOriginMs ?? 0;
              const candidateDeltaMs = mapDeltaMs - origin;
              const alreadyGlobal = segStartMs > 1000 && firstCueMs >= segStartMs - 1000;
              if (!alreadyGlobal && Math.abs(candidateDeltaMs) > 500) {
                shiftByMs = candidateDeltaMs;
              }
            }
            if (Math.abs(shiftByMs) > 500) {
              segCues = segCues
                .map((c) => {
                  const sMs = Math.max(0, Math.round(c.startMs + shiftByMs));
                  const eMs = Math.max(sMs + 250, Math.round(c.endMs + shiftByMs));
                  return c.endMs + shiftByMs <= 0 ? null : { startMs: sMs, endMs: eMs, text: c.text };
                })
                .filter(Boolean);
            }
          }
        }
      } else if (segCues.length && segStartMs >= 2000) {
        // Segment-local WebVTT cues without X-TIMESTAMP-MAP restart near 00:00 per segment
        const firstCueMs = segCues[0].startMs;
        const lastCueMs = segCues[segCues.length - 1].endMs;
        if (lastCueMs <= Math.max(segDurMs + 8000, 45000) && firstCueMs < segStartMs * 0.5) {
          segCues = segCues.map((c) => ({
            startMs: Math.round(c.startMs + segStartMs),
            endMs: Math.round(Math.max(c.startMs + 250, c.endMs) + segStartMs),
            text: c.text
          }));
        }
      }
      for (const c of segCues) mergedCues.push(c);
    }
    return mergedCues.length ? serializeSrt(dedupeOverlappingCues(mergedCues)) : '';
  }

  async #fetchFromSubtitleHints(hints, { language = 'eng', title = '', defaultHeaders = {}, durationSeconds = null }, outPath, { collectAll = false, baseKey = '' } = {}) {
    const wantEn = /^en/i.test(String(language || 'eng'));
    const seenUrls = new Set();
    const ranked = (Array.isArray(hints) ? hints : [])
      .map((h) => ({
        url: String(h?.url || h?.file || '').trim(),
        lang: String(h?.language || h?.lang || h?.langCode || '').trim(),
        label: String(h?.label || '').trim(),
        typeHint: String(h?.type || h?.format || '').trim().toLowerCase(),
        tier: h?.tier || 'same_route',
        headers: { ...(defaultHeaders || {}), ...(h?.headers && typeof h.headers === 'object' ? h.headers : {}) }
      }))
      .filter((h) => {
        if (!/^https?:\/\//i.test(h.url) || seenUrls.has(h.url)) return false;
        seenUrls.add(h.url);
        return true;
      })
      .map((h) => {
        const l = `${h.lang} ${h.label}`.toLowerCase();
        let score = h.tier === 'same_route' ? 25 : 0;
        if (wantEn && /\b(en|eng|english)\b/i.test(l)) score += 40;
        else if (!wantEn && l.includes(String(language).toLowerCase())) score += 40;
        if (/\b(?:forced|signs)\b/i.test(l)) score -= 12;
        else if (/\b(?:sdh|hearing|cc)\b/i.test(l)) score -= 4;
        if (/\.srt(\?|$)/i.test(h.url)) score += 3;
        return { ...h, score };
      })
      .sort((a, b) => b.score - a.score);

    const collected = [];
    const maxCandidates = collectAll ? 12 : 4;
    for (let idx = 0; idx < Math.min(ranked.length, maxCandidates); idx++) {
      const cand = ranked[idx];
      if (!collectAll && wantEn && ranked.some((r) => r.score >= 25) && cand.score < 20) break;
      try {
        const res = await this.fetch(cand.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...cand.headers },
          signal: AbortSignal.timeout(8000)
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
        if ((text && text.trimStart().startsWith('#EXTM3U')) || /\.m3u8(\?|$)/i.test(cand.url)) {
          if (text.trimStart().startsWith('#EXTM3U')) {
            text = await this.#fetchHlsVttPlaylist(cand.url, cand.headers, durationSeconds);
          }
        }
        const extHint = cand.typeHint || (cand.url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
        const rawCues = parseAnySubtitleText(text, extHint).filter((c) => !isPromoCueText(c.text));
        const cues = dedupeOverlappingCues(rawCues);
        const strictMin = cand.tier === 'meta_match';
        if (cues.length < 5 || !cuesFitDuration(cues, durationSeconds, { strictMinRatio: strictMin })) continue;
        const canonicalSrt = serializeSrt(cues);
        const urlHash = createHash('sha1').update(cand.url).digest('hex').slice(0, 10);
        const targetOut = (collectAll && collected.length > 0)
          ? this.#cacheFilePath(`${baseKey || outPath}|hint|${urlHash}|v4`)
          : outPath;
        writeFileSync(targetOut, canonicalSrt, 'utf8');
        this.cueCache.set(targetOut, cues);
        const isMetaTier = cand.tier === 'meta_match';
        const fallbackLabel = wantEn
          ? (isMetaTier ? 'English Subtitles (Matched)' : 'English Subtitles')
          : `${title ? `${title} · ` : ''}Subtitles`;
        const cleanLabel = cand.label || (cand.lang && !/^(?:en|eng|english)$/i.test(cand.lang) ? `${cand.lang} Subtitles` : fallbackLabel);
        const trackObj = {
          found: true,
          filePath: targetOut,
          cues,
          language: cand.lang || language,
          label: isMetaTier && !cand.label ? fallbackLabel : cleanLabel,
          source: isMetaTier ? 'meta_hint' : 'subtitle_hint'
        };
        if (!collectAll) return trackObj;
        collected.push(trackObj);
      } catch {}
    }
    return collectAll ? collected : null;
  }

  async #resolveImdbIdViaCinemeta({ title, year, season, episode } = {}) {
    const clean = cleanTitleForSearch(title);
    if (!clean) return '';
    const isSeries = Boolean(season && episode);
    const kind = isSeries ? 'series' : 'movie';
    const wantToks = tokenizeSubTitle(clean).filter((w) => w.length >= 2 && !['the', 'and', 'for', 'with'].includes(w));
    try {
      const res = await this.fetch(
        `https://v3-cinemeta.strem.io/catalog/${kind}/top/search=${encodeURIComponent(clean)}.json`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
      );
      if (!res?.ok) return '';
      const data = await res.json().catch(() => null);
      const metas = Array.isArray(data?.metas) ? data.metas : [];
      let bestId = '';
      let bestScore = -1;
      for (const m of metas.slice(0, 8)) {
        const imdb = String(m?.imdb_id || m?.id || '').trim();
        if (!/^tt\d+$/i.test(imdb)) continue;
        const candToks = new Set(tokenizeSubTitle(m?.name || ''));
        let hits = 0;
        for (const w of wantToks) {
          if (candToks.has(w)) hits += 1;
        }
        if (wantToks.length > 0 && hits === 0) continue;
        let score = hits * 15;
        if (wantToks.length > 0 && hits === wantToks.length) score += 20;
        const relYr = Number(String(m?.releaseInfo || m?.year || '').slice(0, 4)) || 0;
        if (year && relYr > 1900) {
          if (relYr === Number(year)) score += 18;
          else if (Math.abs(relYr - Number(year)) > 2) score -= 25;
        }
        if (score > bestScore) {
          bestScore = score;
          bestId = imdb;
        }
      }
      return bestScore >= 10 ? bestId : '';
    } catch {
      return '';
    }
  }

  async #fetchFromStremioOpenSubtitles({ title, imdbId, season, episode, language = 'eng', durationSeconds = null, releaseHint = '' }, outPath) {
    const normImdb = String(imdbId || '').trim();
    if (!/^tt\d+$/i.test(normImdb)) return null;
    const isSeries = Boolean(season && episode);
    const endpoint = isSeries
      ? `https://opensubtitles-v3.strem.io/subtitles/series/${normImdb}:${Number(season)}:${Number(episode)}.json`
      : `https://opensubtitles-v3.strem.io/subtitles/movie/${normImdb}.json`;
    try {
      const res = await this.fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
      if (!res?.ok) return null;
      const data = await res.json().catch(() => null);
      const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];
      if (!subs.length) return null;

      const wantLang = String(language || 'eng').toLowerCase();
      const wantPrefix = wantLang.slice(0, 2);
      const relLower = String(releaseHint || '').toLowerCase();
      const relSource = relLower.match(/\b(web-?dl|webrip|bluray|bdrip|brrip|hdtv|dvdrip)\b/i)?.[1]?.replace('-', '') || '';
      const targetTag = isSeries ? `s${String(Number(season)).padStart(2, '0')}e${String(Number(episode)).padStart(2, '0')}` : '';

      const candidates = subs
        .filter((s) => s?.url && typeof s.url === 'string')
        .map((s) => {
          const sl = String(s?.lang || '').toLowerCase();
          const urlL = s.url.toLowerCase();
          const nameL = String(s?.MovieReleaseName || s?.SubFileName || s?.label || s?.id || '').toLowerCase();
          let score = 0;
          if (sl === wantLang || (wantPrefix === 'en' && /^(?:en|eng|english)$/.test(sl))) score += 50;
          else if (wantPrefix && sl.startsWith(wantPrefix)) score += 35;
          else if (/^(?:en|eng)/.test(sl)) score += 5;
          else return { s, score: -100 };

          if (targetTag) {
            const seM = nameL.match(/\bs(\d{1,2})e(\d{1,3})\b/i);
            if (seM && (Number(seM[1]) !== Number(season) || Number(seM[2]) !== Number(episode))) {
              return { s, score: -100 };
            }
            if (nameL.includes(targetTag)) score += 16;
          }
          if (urlL.includes('.srt')) score += 10;
          else if (urlL.includes('.vtt')) score += 6;
          if (String(s?.SubEncoding || '').toUpperCase().includes('UTF')) score += 4;
          if (relSource && nameL.replace(/-/g, '').includes(relSource)) score += 14;
          if (/\b(?:web-?dl|webrip|bluray|bdrip|brrip)\b/i.test(nameL)) score += 6;
          if (/\b(?:cam|hdcam|telesync|telecine|\bts\b|hdts)\b/i.test(nameL)) score -= 32;
          if (/\b(?:auto.?translat|machine.?translat)\b/i.test(nameL)) score -= 24;
          if (/\b(?:forced|signs)\b/i.test(nameL)) score -= 22;
          else if (/\b(?:sdh|hi|hearing)\b/i.test(nameL) || String(s?.SubHearingImpaired || '') === '1') score -= 4;
          if (Number(s?.SubDownloadsCnt) > 0) {
            score += Math.min(10, Math.log10(Number(s.SubDownloadsCnt) + 1) * 2.5);
          }
          return { s, score };
        })
        .filter((x) => x.score >= 25)
        .sort((a, b) => b.score - a.score);

      for (const { s } of candidates.slice(0, 4)) {
        try {
          const dlRes = await this.fetch(s.url, { headers: { Accept: 'text/plain,*/*' }, signal: AbortSignal.timeout(8000) });
          if (!dlRes?.ok) continue;
          const buf = Buffer.from(await dlRes.arrayBuffer());
          const rawText = (s.url.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b))
            ? gunzipSync(buf).toString('utf8')
            : buf.toString('utf8');
          const cues = dedupeOverlappingCues(parseAnySubtitleText(rawText).filter((c) => !isPromoCueText(c.text)));
          if (cues.length < 10 || !cuesFitDuration(cues, durationSeconds)) continue;
          const canonicalSrt = serializeSrt(cues);
          writeFileSync(outPath, canonicalSrt, 'utf8');
          this.cueCache.set(outPath, cues);
          return {
            found: true,
            filePath: outPath,
            cues,
            language: String(s?.lang || language || 'eng'),
            label: `${title} (${String(s?.lang || language || 'ENG').toUpperCase()})`,
            source: 'opensubtitles'
          };
        } catch {}
      }
    } catch {}
    return null;
  }

  async #fetchFromWyzieSubtitles({ imdbId, season, episode, language = 'eng', durationSeconds = null, title = '' }, outPath) {
    const apiKey = String(process.env.WYZIE_API_KEY || '').trim();
    const normImdb = String(imdbId || '').trim();
    if (!apiKey || !/^tt\d+$/i.test(normImdb)) return null;
    try {
      const params = new URLSearchParams({
        id: normImdb,
        language: /^en/i.test(String(language || 'eng')) ? 'en' : String(language).slice(0, 2).toLowerCase(),
        format: 'srt',
        key: apiKey
      });
      if (season && episode) {
        params.set('season', String(Number(season)));
        params.set('episode', String(Number(episode)));
      }
      const res = await this.fetch(`https://sub.wyzie.ru/search?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6500)
      });
      if (!res?.ok) return null;
      const rows = await res.json().catch(() => null);
      const list = Array.isArray(rows) ? rows : [];
      for (const item of list.slice(0, 4)) {
        if (!item?.url) continue;
        const dlRes = await this.fetch(item.url, { headers: { Accept: 'text/plain,*/*' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (!dlRes?.ok) continue;
        const rawText = await dlRes.text();
        const cues = dedupeOverlappingCues(parseAnySubtitleText(rawText).filter((c) => !isPromoCueText(c.text)));
        if (cues.length < 10 || !cuesFitDuration(cues, durationSeconds)) continue;
        writeFileSync(outPath, serializeSrt(cues), 'utf8');
        this.cueCache.set(outPath, cues);
        return {
          found: true,
          filePath: outPath,
          cues,
          language,
          label: item.display || `${title} (${String(language || 'ENG').toUpperCase()})`,
          source: 'opensubtitles'
        };
      }
    } catch {}
    return null;
  }

  async #fetchFromSubdlSubtitles({ title, imdbId, season, episode, language = 'eng', durationSeconds = null }, outPath) {
    const apiKey = String(process.env.SUBDL_API_KEY || '').trim();
    if (!apiKey) return null;
    const normImdb = String(imdbId || '').trim();
    try {
      const params = new URLSearchParams({
        api_key: apiKey,
        languages: /^en/i.test(String(language || 'eng')) ? 'EN' : String(language).slice(0, 2).toUpperCase(),
        subs_per_page: '10'
      });
      if (/^tt\d+$/i.test(normImdb)) params.set('imdb_id', normImdb);
      else if (title) params.set('film_name', cleanTitleForSearch(title));
      else return null;
      if (season && episode) {
        params.set('type', 'tv');
        params.set('season_number', String(Number(season)));
        params.set('episode_number', String(Number(episode)));
      }
      const res = await this.fetch(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6500)
      });
      if (!res?.ok) return null;
      const data = await res.json().catch(() => null);
      const list = Array.isArray(data?.subtitles) ? data.subtitles : [];
      for (const item of list.slice(0, 4)) {
        const subUrl = String(item?.url || '').trim();
        if (!subUrl || /\.zip(\?|$)/i.test(subUrl)) continue;
        const absUrl = subUrl.startsWith('http') ? subUrl : `https://dl.subdl.com${subUrl.startsWith('/') ? '' : '/'}${subUrl}`;
        const dlRes = await this.fetch(absUrl, { headers: { Accept: 'text/plain,*/*' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (!dlRes?.ok) continue;
        const buf = Buffer.from(await dlRes.arrayBuffer());
        const rawText = (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        if (buf[0] === 0x50 && buf[1] === 0x4b) continue;
        const cues = dedupeOverlappingCues(parseAnySubtitleText(rawText).filter((c) => !isPromoCueText(c.text)));
        if (cues.length < 10 || !cuesFitDuration(cues, durationSeconds)) continue;
        writeFileSync(outPath, serializeSrt(cues), 'utf8');
        this.cueCache.set(outPath, cues);
        return {
          found: true,
          filePath: outPath,
          cues,
          language,
          label: item.release_name || `${title} (${String(language || 'ENG').toUpperCase()})`,
          source: 'opensubtitles'
        };
      }
    } catch {}
    return null;
  }

  async #fetchFromOpenSubtitles({ title, year, imdbId, season, episode, language = 'eng', durationSeconds = null, releaseHint = '' }, outPath) {
    let effImdb = imdbId ? (String(imdbId).startsWith('tt') ? String(imdbId) : `tt${String(imdbId).replace(/[^\d]/g, '')}`) : '';
    if (!/^tt\d+$/i.test(effImdb)) {
      effImdb = await this.#resolveImdbIdViaCinemeta({ title, year, season, episode });
    }
    if (effImdb) {
      const stremioHit = await this.#fetchFromStremioOpenSubtitles(
        { title, imdbId: effImdb, season, episode, language, durationSeconds, releaseHint },
        outPath
      );
      if (stremioHit) return stremioHit;
    }

    const parts = [];
    if (season && episode) {
      parts.push(`episode-${Number(episode)}`);
    }
    if (effImdb) {
      const numericImdb = effImdb.replace(/^tt/i, '').replace(/[^\d]/g, '');
      if (numericImdb) parts.push(`imdbid-${numericImdb}`);
    }
    const cleanTitle = cleanTitleForSearch(title);
    if (!effImdb && cleanTitle) {
      parts.push(`query-${encodeURIComponent(cleanTitle.toLowerCase())}`);
    }
    if (season && episode) {
      parts.push(`season-${Number(season)}`);
    }
    parts.push(`sublanguageid-${encodeURIComponent(language)}`);

    const url = `https://rest.opensubtitles.org/search/${parts.join('/')}`;
    const res = await this.fetch(url, { headers: OPENSUBTITLES_HEADERS, signal: AbortSignal.timeout(7000) });
    if (res?.ok) {
      const rows = await res.json().catch(() => null);
      const ranked = (Array.isArray(rows) ? rows : [])
        .filter((r) => r?.SubDownloadLink && ['srt', 'vtt', ''].includes(String(r?.SubFormat || '').toLowerCase()))
        .map((r) => ({ item: r, score: scoreSubtitleCandidate(r, { title, year, season, episode, releaseHint }) }))
        .filter((r) => r.score >= 28)
        .sort((a, b) => b.score - a.score);

      for (const { item } of ranked.slice(0, 4)) {
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
          const cues = dedupeOverlappingCues(parseAnySubtitleText(srtText).filter((c) => !isPromoCueText(c.text)));
          if (cues.length < 10 || !cuesFitDuration(cues, durationSeconds)) continue;
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
    }

    const wyzieHit = await this.#fetchFromWyzieSubtitles({ title, imdbId: effImdb, season, episode, language, durationSeconds }, outPath).catch(() => null);
    if (wyzieHit) return wyzieHit;

    const subdlHit = await this.#fetchFromSubdlSubtitles({ title, imdbId: effImdb, season, episode, language, durationSeconds }, outPath).catch(() => null);
    if (subdlHit) return subdlHit;

    return null;
  }

  async #probeEmbeddedSubtitleStream(streamUrl, headers, { language = 'eng' } = {}) {
    try {
      const args = ['-v', 'error'];
      const isHttp = /^https?:\/\//i.test(String(streamUrl));
      if (isHttp) {
        args.push('-rw_timeout', '3500000');
      }
      if (headers && typeof headers === 'object' && isHttp) {
        const hdrStr = Object.entries(headers)
          .filter(([k, v]) => k && v)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        if (hdrStr) args.push('-headers', `${hdrStr}\r\n`);
      }
      args.push(
        '-select_streams', 's',
        '-show_entries', 'stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced',
        '-of', 'json',
        streamUrl
      );
      const { stdout } = await this.runner(this.ffprobe, args, { timeout: 6000, maxBuffer: 512 * 1024 });
      const data = JSON.parse(String(stdout || '{}'));
      const streams = (Array.isArray(data?.streams) ? data.streams : [])
        .filter((s) => TEXT_SUBTITLE_CODECS.has(String(s?.codec_name || '').toLowerCase()));
      if (!streams.length) return null;

      const wantEn = /^en/i.test(String(language || 'eng'));
      streams.sort((a, b) => {
        const rank = (s) => {
          const lang = String(s?.tags?.language || '').toLowerCase();
          const title = String(s?.tags?.title || '').toLowerCase();
          let score = 0;
          if (wantEn && /^(en|eng|english)/.test(lang)) score += 40;
          else if (!wantEn && lang.startsWith(String(language).toLowerCase())) score += 40;
          if (s?.disposition?.default) score += 6;
          if (s?.disposition?.forced || /\bforced\b/.test(title)) score -= 25;
          if (/\b(?:sdh|hi|commentary|signs|songs)\b/.test(title)) score -= 12;
          return score;
        };
        return rank(b) - rank(a);
      });
      const chosen = streams[0];
      return {
        streamIndex: Number(chosen.index),
        language: chosen?.tags?.language || language,
        label: chosen?.tags?.title
          ? `Embedded (${chosen.tags.title})`
          : `Embedded ${String(chosen?.tags?.language || 'EN').toUpperCase()}`
      };
    } catch {
      return null;
    }
  }

  async #extractEmbeddedSubtitle(streamUrl, headers, outPath, { language = 'eng' } = {}) {
    const probedTrack = await this.#probeEmbeddedSubtitleStream(streamUrl, headers, { language });
    // If ffprobe ran and found ONLY bitmap subtitle tracks (or none), skip blind extraction
    if (probedTrack === null && this.runner === exec) {
      return null;
    }
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    const isHttp = /^https?:\/\//i.test(String(streamUrl));
    if (isHttp) {
      args.push('-rw_timeout', '5000000');
    }
    if (headers && typeof headers === 'object' && isHttp) {
      const hdrStr = Object.entries(headers)
        .filter(([k, v]) => k && v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      if (hdrStr) args.push('-headers', `${hdrStr}\r\n`);
    }
    const mapSpec = probedTrack?.streamIndex != null ? `0:${probedTrack.streamIndex}` : '0:s:0';
    args.push('-i', streamUrl, '-map', mapSpec, '-f', 'srt', outPath);
    await this.runner(this.ffmpeg, args, { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
    if (!existsSync(outPath)) return null;
    const cues = dedupeOverlappingCues(this.loadCues(outPath).filter((c) => !isPromoCueText(c.text)));
    if (cues.length < 5) return null;
    writeFileSync(outPath, serializeSrt(cues), 'utf8');
    this.cueCache.set(outPath, cues);
    return {
      found: true,
      filePath: outPath,
      cues,
      language: probedTrack?.language || language,
      label: probedTrack?.label || 'Embedded Track',
      source: 'embedded'
    };
  }
}
