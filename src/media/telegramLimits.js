import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;

/**
 * Telegram's cloud Bot API rejects bot uploads above 50 MB (photos above 10 MB).
 * A self-hosted Bot API server (`--local`) raises this to 2000 MB; set
 * TELEGRAM_UPLOAD_LIMIT_MB accordingly. A small margin covers multipart overhead.
 */
export function uploadLimitBytes(env = process.env) {
  const mb = Number(env.TELEGRAM_UPLOAD_LIMIT_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? Math.min(mb, 2000) : 50) * MB * 0.96);
}
export const PHOTO_LIMIT_BYTES = Math.floor(10 * MB * 0.95);
/** Below this video bitrate a re-encode is not worth delivering; report instead. */
export const MIN_VIDEO_KBPS = 220;
const AUDIO_KBPS = 96;

/** Data-aware downloader quality presets (Mobile Data Saver -> Balanced -> HD). */
export const DOWNLOAD_QUALITY_PROFILES = {
  '360p': { id: '360p', label: '360p · Saver', short: '360p', height: 360, videoKbps: 380, audioKbps: 64, crf: 27, maxrateKbps: 520 },
  '480p': { id: '480p', label: '480p · Balanced', short: '480p', height: 480, videoKbps: 760, audioKbps: 96, crf: 24, maxrateKbps: 1050 },
  '720p': { id: '720p', label: '720p · HD', short: '720p', height: 720, videoKbps: 1550, audioKbps: 128, crf: 23, maxrateKbps: 2200 }
};

export function normalizeDownloadQuality(raw, fallback = '480p') {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s === '360' || s === '360p' || s === 'low' || s === 'saver') return '360p';
  if (s === '480' || s === '480p' || s === 'med' || s === 'balanced') return '480p';
  if (s === '720' || s === '720p' || s === 'hd' || s === 'high') return '720p';
  return fallback;
}

/** Estimate file size (MB) from upstream variant bytes or preset target bitrate * runtime. */
export function estimateDownloadSizeMb({
  durationSeconds = 0,
  quality = '480p',
  variantBytes = null,
  limitBytes = uploadLimitBytes()
} = {}) {
  const q = normalizeDownloadQuality(quality);
  const profile = DOWNLOAD_QUALITY_PROFILES[q];
  let estBytes = 0;
  if (Number.isFinite(Number(variantBytes)) && Number(variantBytes) > 0) {
    estBytes = Number(variantBytes);
  } else {
    const dur = Math.max(60, Number(durationSeconds) || 5400);
    estBytes = Math.round(((profile.videoKbps + profile.audioKbps) * 1000) / 8 * dur);
  }
  const limitMb = Math.max(1, Math.round(limitBytes / MB));
  const exceedsLimit = estBytes > limitBytes;
  const rawMb = Math.max(1, Math.round(estBytes / MB));
  const displayMb = exceedsLimit ? limitMb : rawMb;
  return {
    quality: q,
    profile,
    estimatedBytes: estBytes,
    estimatedMb: rawMb,
    displayMb,
    exceedsLimit,
    limitMb,
    text: exceedsLimit ? `≤${limitMb}MB fit` : `~${rawMb}MB`
  };
}

async function probeDuration(path, runner) {
  try {
    const { stdout } = await runner('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 15000 });
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

/** Plan a fitting encode, or explain why it can't fit. Pure, so it is unit-testable. */
export function planVideoFit({ sizeBytes, durationSeconds, limitBytes }) {
  if (sizeBytes <= limitBytes) return { action: 'keep' };
  if (!durationSeconds) return { action: 'reject', reason: 'unknown_duration' };
  const totalKbps = Math.floor((limitBytes * 8 * 0.92) / durationSeconds / 1000);
  const videoKbps = totalKbps - AUDIO_KBPS;
  if (videoKbps < MIN_VIDEO_KBPS) return { action: 'reject', reason: 'too_long', maxMinutes: Math.floor((limitBytes * 8 * 0.92) / ((MIN_VIDEO_KBPS + AUDIO_KBPS) * 1000) / 60) };
  const height = videoKbps >= 1800 ? 720 : videoKbps >= 900 ? 540 : videoKbps >= 500 ? 480 : 360;
  return { action: 'transcode', videoKbps, height };
}

async function transcodeVideo(buffer, plan, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'lancy_fit_'));
  try {
    const input = join(dir, 'in'), output = join(dir, 'out.mp4');
    writeFileSync(input, buffer);
    await runner('ffmpeg', ['-nostdin', '-y', '-i', input, '-vf', `scale=-2:'min(${plan.height},ih)'`, '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${plan.videoKbps}k`, '-maxrate', `${Math.floor(plan.videoKbps * 1.15)}k`, '-bufsize', `${plan.videoKbps * 2}k`,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-movflags', '+faststart', output], { timeout: 600000, maxBuffer: 1024 * 1024 });
    return existsSync(output) ? readFileSync(output) : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function durationOf(buffer, runner) {
  const dir = mkdtempSync(join(tmpdir(), 'lancy_probe_'));
  try { const p = join(dir, 'm'); writeFileSync(p, buffer); return await probeDuration(p, runner); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Make a downloader result deliverable. Never claims success for a file Telegram
 * will refuse: oversized items are compressed when watchable, otherwise removed
 * and listed in `oversized` so the UI can say exactly what happened.
 */
export async function fitResultForTelegram(result, { limitBytes = uploadLimitBytes(), runner = execFileAsync, onProgress, sharpImpl } = {}) {
  const oversized = [];
  const kept = [];
  for (const item of result?.mediaItems || []) {
    const size = item?.buffer?.length || item?.sizeBytes || (item?.filePath && existsSync(item.filePath) ? statSync(item.filePath).size : 0);
    if (item.type === 'photo' && size > PHOTO_LIMIT_BYTES) {
      try {
        const sharp = sharpImpl || (await import('sharp')).default;
        const src = item.buffer || item.filePath;
        const buf = await sharp(src, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        if (buf.length <= PHOTO_LIMIT_BYTES) { kept.push({ ...item, buffer: buf, mimeType: 'image/jpeg' }); continue; }
      } catch {}
      oversized.push({ type: 'photo', sizeBytes: size, reason: 'photo_too_large' });
      continue;
    }
    if (item.type !== 'video' || size <= limitBytes) { kept.push(item); continue; }
    const durationSeconds = item.filePath && existsSync(item.filePath)
      ? await probeDuration(item.filePath, runner)
      : await durationOf(item.buffer, runner);
    const plan = planVideoFit({ sizeBytes: size, durationSeconds, limitBytes });
    if (plan.action === 'transcode' && item.buffer) {
      onProgress?.(`Compressing ${Math.round(size / MB)} MB video to fit Telegram (${plan.height}p)…`);
      const out = await transcodeVideo(item.buffer, plan, runner).catch(() => null);
      if (out && out.length <= limitBytes) { kept.push({ ...item, buffer: out, mimeType: 'video/mp4', compressedFrom: size }); continue; }
      oversized.push({ type: 'video', sizeBytes: size, durationSeconds, reason: 'compression_failed' });
    } else oversized.push({ type: 'video', sizeBytes: size, durationSeconds, ...plan });
  }
  let audioTrack = result?.audioTrack || null;
  if (audioTrack?.buffer?.length > limitBytes) { oversized.push({ type: 'audio', sizeBytes: audioTrack.buffer.length, reason: 'audio_too_large' }); audioTrack = null; }
  return { ...result, mediaItems: kept, audioTrack, oversized };
}

/** Short, honest user-facing explanation for dropped items. */
export function describeOversized(oversized, limitBytes = uploadLimitBytes()) {
  if (!oversized?.length) return null;
  const limitMb = Math.round(limitBytes / MB / 0.96);
  return oversized.map(o => {
    const mb = Math.round(o.sizeBytes / MB);
    if (o.reason === 'too_long') return `Video (${mb} MB) is too long to fit Telegram's ${limitMb} MB bot limit at watchable quality (max ≈${o.maxMinutes} min).`;
    if (o.reason === 'unknown_duration') return `Video (${mb} MB) exceeds the ${limitMb} MB bot limit and its length couldn't be read to compress it.`;
    if (o.reason === 'compression_failed') return `Video (${mb} MB) couldn't be compressed under the ${limitMb} MB bot limit.`;
    if (o.type === 'photo') return `A ${mb} MB image exceeds Telegram's 10 MB photo limit.`;
    return `Audio (${mb} MB) exceeds the ${limitMb} MB bot limit.`;
  }).join('\n');
}

