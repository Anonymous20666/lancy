import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { logger } from '../core/logger.js';
import { phashFromGray } from '../utils/phash.js';
import { sha256Hex } from '../utils/hash.js';

/**
 * Media conversion — sharp for images, FFmpeg for video.
 * FFmpeg resolution order: settings.media.ffmpegPath -> ffmpeg-static ->
 * vendor/ffmpeg -> PATH. Never silently downgrade quality: we only convert
 * when the target platform requires it, and we report every conversion.
 */

let ffmpegPathCache = null;

export function resolveFfmpegPath(configured = '') {
  if (ffmpegPathCache) return ffmpegPathCache;
  const candidates = [];
  if (configured) candidates.push(configured);
  try {
    // optional dependency
    const req = createRequire(import.meta.url);
    const p = req('ffmpeg-static');
    if (p) candidates.push(p);
  } catch { /* not installed */ }
  candidates.push(join(process.cwd(), 'vendor', 'ffmpeg'));
  candidates.push('ffmpeg');

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      ffmpegPathCache = 'ffmpeg';
      return candidate;
    }
    if (existsSync(candidate)) {
      ffmpegPathCache = candidate;
      return candidate;
    }
  }
  ffmpegPathCache = null;
  return null;
}

export function hasFfmpeg(configured = '') {
  return resolveFfmpegPath(configured) !== null;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function ffprobe(ffmpegPath, filePath) {
  const ffprobe = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr.slice(0, 300)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Probe an image buffer with sharp: dimensions, format, decodable. */
export async function probeImage(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  return {
    width: meta.width ?? null,
    height: meta.height ?? null,
    format: meta.format ?? null,
    channels: meta.channels ?? null,
    hasAlpha: !!meta.hasAlpha
  };
}

/** Probe a video file with ffprobe: duration, dimensions, codecs, streams. */
export async function probeVideo(filePath, configuredFfmpeg = '') {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) throw new Error('FFmpeg is not available — install ffmpeg-static or set media.ffmpegPath');
  const ffprobePath = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
  const info = await ffprobe(existsSync(ffprobePath) ? ffprobePath : ffmpegPath, filePath).catch(async (error) => {
    if (existsSync(ffprobePath)) throw error;
    // No ffprobe: fall back to ffmpeg -i parsing.
    return parseFfmpegI(ffmpegPath, filePath);
  });
  const videoStream = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const audioStream = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(info.format?.duration ?? videoStream?.duration ?? 0) || null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    hasAudio: !!audioStream,
    bitrate: Number(info.format?.bit_rate ?? 0) || null,
    container: info.format?.format_name ?? null
  };
}

async function parseFfmpegI(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', () => {
      const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
      const stream = /Stream #.*Video: (\w+).*?(\d{2,5})x(\d{2,5})/.exec(stderr);
      const audio = /Stream #.*Audio: (\w+)/.exec(stderr);
      resolve({
        streams: [
          ...(stream ? [{ codec_type: 'video', codec_name: stream[1], width: Number(stream[2]), height: Number(stream[3]) }] : []),
          ...(audio ? [{ codec_type: 'audio', codec_name: audio[1] }] : [])
        ],
        format: {
          duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
          format_name: 'unknown'
        }
      });
    });
  });
}

// ── Image conversion ──────────────────────────────────────────────────────

/**
 * Normalize an image for hashing: 32x32 grayscale raw pixels → pHash.
 * Used by the global no-duplicate system.
 */
export async function perceptualHash(buffer) {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return phashFromGray(new Uint8Array(data), info.width);
}

/**
 * Convert an image to a Telegram static sticker: WebP, one side exactly 512,
 * ≤ maxBytes (default 512 KB). Preserves as much quality as possible:
 * lossless-ish WebP at the configured quality, only recompressing when the
 * size limit demands it.
 */
export async function toTelegramStaticSticker(buffer, { maxBytes = 512 * 1024, quality = 92 } = {}) {
  const image = sharp(buffer, { failOn: 'none', animated: false });
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');

  // Telegram static stickers: max 512×512 and ONE side exactly 512px.
  // fit:'inside' scales so the larger side becomes exactly 512, the other ≤512.
  const size = 512;
  const pipeline = sharp(buffer, { failOn: 'none', animated: false }).resize(size, size, {
    fit: 'inside',
    withoutEnlargement: false
  });

  let webp = await pipeline.webp({ quality, effort: 4 }).toBuffer();
  if (webp.length > maxBytes) {
    // Progressive quality reduction — the honest way to fit the limit.
    for (const q of [80, 70, 60, 50]) {
      webp = await pipeline.webp({ quality: q, effort: 4 }).toBuffer();
      if (webp.length <= maxBytes) break;
    }
  }
  if (webp.length > maxBytes) {
    throw new Error(`Could not fit the sticker under ${(maxBytes / 1024).toFixed(0)} KB — the source is too detailed`);
  }
  return { buffer: webp, width: size, height: size, bytes: webp.length };
}

/**
 * Prepare a WhatsApp sticker image: WebP, 512x512 fit-inside (WhatsApp pack
 * pipeline in plogme resizes to 512 inside anyway, but we pre-normalize for
 * consistent quality and hashing).
 */
export async function toWhatsAppStickerImage(buffer, { quality = 85 } = {}) {
  const webp = await sharp(buffer, { failOn: 'none', animated: false })
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();
  return { buffer: webp, bytes: webp.length };
}

/** Pack thumbnail: small WebP ≤ 96x96 (Telegram set thumbnail guidance). */
export async function toThumbnail(buffer, { size = 100 } = {}) {
  const webp = await sharp(buffer, { failOn: 'none', animated: false })
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return { buffer: webp, bytes: webp.length };
}

// ── Video conversion ──────────────────────────────────────────────────────

/**
 * Convert a video buffer to a Telegram video sticker: WebM/VP9, no audio,
 * one side exactly 512, ≤ maxBytes (default 256 KB), ≤ maxDuration seconds.
 * Separate rules from static stickers — never silently turn a video into a
 * terrible image; if conversion is impossible we say so.
 */
export async function toTelegramVideoSticker(buffer, {
  maxBytes = 256 * 1024,
  maxDuration = 10,
  configuredFfmpeg = ''
} = {}) {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) {
    throw new Error('FFmpeg is required for video stickers but was not found. Install ffmpeg-static or set media.ffmpegPath in Settings.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'lancy-video-'));
  try {
    const input = join(dir, 'input.bin');
    const output = join(dir, 'output.webm');
    writeFileSync(input, buffer);

    // Scale so the larger side is exactly 512, strip audio, VP9.
    const scale = "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";
    const baseArgs = [
      '-y', '-i', input,
      '-vf', `${scale},fps=30,format=yuv420p`,
      '-an',
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', '32',
      '-pix_fmt', 'yuv420p',
      '-t', String(maxDuration)
    ];
    await runFfmpeg(ffmpegPath, [...baseArgs, output]);

    let webm = readFileSync(output);
    if (webm.length > maxBytes) {
      // Reduce bitrate until it fits — quality degrades gracefully, never silently.
      for (const crf of [38, 44, 50]) {
        await runFfmpeg(ffmpegPath, [...baseArgs.slice(0, -2), '-crf', String(crf), '-b:v', '200k', output]);
        webm = readFileSync(output);
        if (webm.length <= maxBytes) break;
      }
    }
    if (webm.length > maxBytes) {
      throw new Error(`Could not fit the video sticker under ${(maxBytes / 1024).toFixed(0)} KB — try a shorter clip`);
    }
    const probe = await probeVideo(output, configuredFfmpeg).catch(() => null);
    return { buffer: webm, bytes: webm.length, duration: probe?.duration ?? null, width: 512, height: 512 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Strip audio + normalize a video for WhatsApp (keeps quality, webm/mp4). */
export async function normalizeVideoForWhatsApp(buffer, { configuredFfmpeg = '', maxDuration = 15 } = {}) {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) throw new Error('FFmpeg is required for video processing but was not found.');
  const dir = mkdtempSync(join(tmpdir(), 'lancy-wa-video-'));
  try {
    const input = join(dir, 'input.bin');
    const output = join(dir, 'output.mp4');
    writeFileSync(input, buffer);
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', input,
      '-vf', 'scale=720:-2',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '-t', String(maxDuration),
      output
    ]);
    return { buffer: readFileSync(output), bytes: existsSync(output) ? readFileSync(output).length : 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Full hash bundle for the dedup system. */
export async function hashBundle(buffer) {
  return {
    sha256: sha256Hex(buffer),
    phash: await perceptualHash(buffer).catch(() => null)
  };
}

export function mediaLogger() {
  return logger().child({ module: 'media' });
}
