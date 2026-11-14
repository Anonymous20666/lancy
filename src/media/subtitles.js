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
  return ratio >= 0.35 && ratio <= 1.35;
}

function dedupeOverlappingCues(cues = []) {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const cue of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.text === cue.text && cue.startMs <= prev.endMs + 250) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
    } else {
      out.push({ ...cue });
    }
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
        urlPart = `${u.origin}${u.pathname}`;
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
    releaseHint = ''
  } = {}) {
    const metaKey = `${title || ''}|${year || ''}|${imdbId || ''}|${season || ''}|${episode || ''}|${language}`;
    const allHints = Array.isArray(subtitleHints) ? subtitleHints.filter((h) => h && (h.url || h.file)) : [];
    const sameRouteHints = allHints.filter((h) => !h.tier || h.tier === 'same_route');
    const metaHints = allHints.filter((h) => h.tier === 'meta_match');
    const streamSig = this.#streamSignature({ streamUrl, subtitleHints: sameRouteHints.length ? sameRouteHints : allHints });
    const streamFilePath = this.#cacheFilePath(`${metaKey}|${streamSig}|v3`);
    const altHintPath = this.#cacheFilePath(`${metaKey}|${streamSig}|alt_hint_v3`);
    const fallbackFilePath = this.#cacheFilePath(`${metaKey}|${streamSig === 'meta' ? '' : `${streamSig}|`}os_v3`);
    const tracksFilePath = `${streamFilePath}.tracks.json`;

    if (existsSync(streamFilePath)) {
      const cues = this.loadCues(streamFilePath);
      let savedTracks = [{ filePath: streamFilePath, language, label: 'Synced Subtitles', source: 'cache', cuesCount: cues.length }];
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
          tracks: savedTracks
        };
      }
    }

    const candidates = [];
    const seenPaths = new Set();
    const pushTrack = (res) => {
      if (!res?.filePath || !res.cues?.length || seenPaths.has(res.filePath)) return;
      seenPaths.add(res.filePath);
      candidates.push(res);
    };

    const isContainerStream = Boolean(streamUrl) && !/\.(?:m3u8|mpd)(\?|$)/i.test(String(streamUrl));

    // 1. Same-route subtitle hints attached to the exact resolved stream (.vtt/.srt / full HLS VTT)
    if (sameRouteHints.length) {
      const hintRes = await this.#fetchFromSubtitleHints(
        sameRouteHints,
        { language, title, defaultHeaders: headers, durationSeconds },
        streamFilePath
      ).catch(() => null);
      if (hintRes) pushTrack(hintRes);
    }

    // 2. Embedded container text tracks (MKV/MP4) inspected cleanly via ffprobe BEFORE cross-host hints/OpenSubtitles
    if (streamUrl && isContainerStream && this.#canProbeMediaSource(streamUrl)) {
      const embPath = candidates.length ? altHintPath : streamFilePath;
      const emb = await this.#extractEmbeddedSubtitle(streamUrl, headers, embPath, { language }).catch(() => null);
      if (emb && cuesFitDuration(emb.cues, durationSeconds, { strictMinRatio: false })) {
        pushTrack(emb);
      }
    }

    // 3. Meta-matched hints from companion routes (only if no primary same-route/embedded track yet, or as Track #2)
    if (metaHints.length) {
      const metaOut = candidates.length ? altHintPath : streamFilePath;
      if (!seenPaths.has(metaOut)) {
        const metaRes = await this.#fetchFromSubtitleHints(
          metaHints,
          { language, title, defaultHeaders: headers, durationSeconds },
          metaOut
        ).catch(() => null);
        if (metaRes) pushTrack(metaRes);
      }
    }

    // 4. OpenSubtitles lookup (strict score + release tag + duration span validation)
    if (candidates.length < 2) {
      let osRes = null;
      if (existsSync(fallbackFilePath)) {
        const cachedOs = this.loadCues(fallbackFilePath);
        if (cachedOs.length >= 10 && cuesFitDuration(cachedOs, durationSeconds)) {
          osRes = { found: true, filePath: fallbackFilePath, cues: cachedOs, language, label: 'OpenSubtitles', source: 'opensubtitles' };
        }
      }
      if (!osRes) {
        osRes = await this.#fetchFromOpenSubtitles(
          { title, year, imdbId, season, episode, language, durationSeconds, releaseHint: releaseHint || streamSource },
          candidates.length ? fallbackFilePath : streamFilePath
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

    // Prioritize verified Embedded > Same-Route Hint > Meta-Match Hint > OpenSubtitles
    const tierOrder = { embedded: 0, subtitle_hint: 1, meta_hint: 2, opensubtitles: 3 };
    candidates.sort((a, b) => (tierOrder[a.source] ?? 9) - (tierOrder[b.source] ?? 9));

    const tracks = candidates.slice(0, 3).map((c) => ({
      filePath: c.filePath,
      language: c.language || language,
      label: c.label || 'Subtitles',
      source: c.source,
      cuesCount: c.cues.length
    }));
    const primary = candidates[0];
    try {
      writeFileSync(tracksFilePath, JSON.stringify(tracks), 'utf8');
    } catch {}

    return {
      ...primary,
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
    const segUrls = [];
    const seen = new Set();
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      try {
        const abs = new URL(line, playlistUrl).toString();
        if (!seen.has(abs)) {
          seen.add(abs);
          segUrls.push(abs);
        }
      } catch {}
    }
    const maxSegs = Math.min(segUrls.length, 500);
    const selected = segUrls.slice(0, maxSegs);
    const parts = new Array(selected.length).fill('');
    const deadline = Date.now() + 25_000;
    const batchSize = 6;
    for (let i = 0; i < selected.length && Date.now() < deadline; i += batchSize) {
      const slice = selected.slice(i, i + batchSize);
      await Promise.all(slice.map(async (segUrl, idx) => {
        try {
          const segRes = await this.fetch(segUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers },
            signal: AbortSignal.timeout(6500)
          });
          if (!segRes?.ok) return;
          parts[i + idx] = typeof segRes.text === 'function'
            ? await segRes.text()
            : Buffer.from(await segRes.arrayBuffer()).toString('utf8');
        } catch {}
      }));
    }
    return parts.filter(Boolean).join('\n\n');
  }

  async #fetchFromSubtitleHints(hints, { language = 'eng', title = '', defaultHeaders = {}, durationSeconds = null }, outPath) {
    const wantEn = /^en/i.test(String(language || 'eng'));
    const ranked = (Array.isArray(hints) ? hints : [])
      .map((h) => ({
        url: String(h?.url || h?.file || '').trim(),
        lang: String(h?.language || h?.lang || h?.label || '').trim(),
        tier: h?.tier || 'same_route',
        headers: { ...(defaultHeaders || {}), ...(h?.headers && typeof h.headers === 'object' ? h.headers : {}) }
      }))
      .filter((h) => /^https?:\/\//i.test(h.url))
      .map((h) => {
        const l = h.lang.toLowerCase();
        let score = h.tier === 'same_route' ? 20 : 0;
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
        const rawCues = parseSrt(text).filter((c) => !isPromoCueText(c.text));
        const cues = dedupeOverlappingCues(rawCues);
        const strictMin = cand.tier === 'meta_match';
        if (cues.length < 5 || !cuesFitDuration(cues, durationSeconds, { strictMinRatio: strictMin })) continue;
        const canonicalSrt = serializeSrt(cues);
        writeFileSync(outPath, canonicalSrt, 'utf8');
        this.cueCache.set(outPath, cues);
        const isMetaTier = cand.tier === 'meta_match';
        const cleanLabel = wantEn
          ? (isMetaTier ? 'English Subtitles (Matched)' : 'English Subtitles')
          : `${title ? `${title} · ` : ''}Subtitles`;
        return {
          found: true,
          filePath: outPath,
          cues,
          language,
          label: cleanLabel,
          source: isMetaTier ? 'meta_hint' : 'subtitle_hint'
        };
      } catch {}
    }
    return null;
  }

  async #fetchFromOpenSubtitles({ title, year, imdbId, season, episode, language = 'eng', durationSeconds = null, releaseHint = '' }, outPath) {
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
        const cues = parseSrt(srtText).filter((c) => !isPromoCueText(c.text));
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
    const cues = this.loadCues(outPath).filter((c) => !isPromoCueText(c.text));
    if (cues.length < 5) return null;
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
