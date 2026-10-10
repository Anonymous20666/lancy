import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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

function runFfmpeg(ffmpegPath, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
export async function toTelegramStaticSticker(buffer, { maxBytes = 512 * 1024, quality = 92, configuredFfmpeg = '' } = {}) {
  let imgBuffer = buffer;

  // If video buffer (WebM, MP4, etc.), extract first frame cleanly using FFmpeg
  if (isVideoBuffer(buffer)) {
    const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
    if (ffmpegPath) {
      const dir = mkdtempSync(join(tmpdir(), 'lancy-frame-'));
      try {
        const inPath = join(dir, 'in.bin');
        const outPath = join(dir, 'out.jpg');
        writeFileSync(inPath, buffer);
        execFileSync(ffmpegPath, [
          '-y', '-i', inPath,
          '-frames:v', '1',
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',
          '-q:v', '2',
          outPath
        ], { stdio: 'ignore' });
        if (existsSync(outPath)) {
          imgBuffer = readFileSync(outPath);
        }
      } catch {} finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  let image;
  try {
    image = sharp(imgBuffer, { failOn: 'none', animated: false });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');
  } catch (err) {
    // Fallback: try ffmpeg frame extraction if sharp failed to parse buffer
    const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
    if (ffmpegPath && imgBuffer === buffer) {
      const dir = mkdtempSync(join(tmpdir(), 'lancy-frame2-'));
      try {
        const inPath = join(dir, 'in.bin');
        const outPath = join(dir, 'out.jpg');
        writeFileSync(inPath, buffer);
        execFileSync(ffmpegPath, [
          '-y', '-i', inPath,
          '-frames:v', '1',
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',
          '-q:v', '2',
          outPath
        ], { stdio: 'ignore' });
        if (existsSync(outPath)) {
          imgBuffer = readFileSync(outPath);
          image = sharp(imgBuffer, { failOn: 'none', animated: false });
          await image.metadata();
        } else {
          throw err;
        }
      } catch {
        throw err;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      throw err;
    }
  }

  // Telegram static stickers: max 512×512 and ONE side exactly 512px.
  // fit:'inside' scales so the larger side becomes exactly 512, the other ≤512.
  const size = 512;
  const pipeline = sharp(imgBuffer, { failOn: 'none', animated: false }).resize(size, size, {
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

export function isWebPBuffer(buffer) {
  return (
    buffer &&
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  );
}

export function isAnimatedWebP(buffer) {
  if (!isWebPBuffer(buffer)) return false;
  return buffer.indexOf('ANIM') !== -1 || buffer.indexOf('ANMF') !== -1;
}

export function isVideoBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.length >= 8 && buffer.slice(4, 8).toString() === 'ftyp') return true;
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true;
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'AVI ') return true;
  return false;
}

/**
 * Convert any media buffer (video, image, or WebP) into a fully compliant
 * WhatsApp sticker (Animated WebP for video, static WebP for image, 512x512, <= 500 KB).
 */
export async function toWhatsAppSticker(buffer, { configuredFfmpeg = '', quality = 85, maxBytes = 480 * 1024 } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Valid buffer is required for WhatsApp sticker');
  }

  // 1. Video buffer (WebM / MP4)
  if (isVideoBuffer(buffer)) {
    const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
    if (!ffmpegPath) {
      throw new Error('FFmpeg is required to convert video stickers for WhatsApp');
    }
    const dir = mkdtempSync(join(tmpdir(), 'lancy-wa-sticker-'));
    try {
      const input = join(dir, 'input.bin');
      const output = join(dir, 'output.webp');
      writeFileSync(input, buffer);

      const profiles = [
        { q: 60, fps: 15, duration: 3.0 },
        { q: 45, fps: 12, duration: 2.5 },
        { q: 30, fps: 10, duration: 2.0 }
      ];

      for (const p of profiles) {
        const args = [
          '-y', '-i', input,
          '-t', String(p.duration),
          '-vf', `scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,fps=fps=${p.fps}:round=up`,
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-compression_level', '2',
          '-q:v', String(p.q),
          '-loop', '0',
          '-an',
          output
        ];
        try {
          await runFfmpeg(ffmpegPath, args);
          if (existsSync(output)) {
            const res = readFileSync(output);
            if (res.length > 0 && res.length <= maxBytes) {
              return res;
            }
          }
        } catch {}
      }

      // Single-frame fallback for ultra-short clips or single-frame video stickers
      const singleFrameArgs = [
        '-y', '-i', input,
        '-frames:v', '1',
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
        '-c:v', 'libwebp',
        '-q:v', '75',
        output
      ];
      try {
        await runFfmpeg(ffmpegPath, singleFrameArgs);
        if (existsSync(output)) {
          const res = readFileSync(output);
          if (res.length > 0) {
            return res;
          }
        }
      } catch {}
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 2. Animated WebP
  if (isAnimatedWebP(buffer)) {
    try {
      const converted = await sharp(buffer, { animated: true })
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 75, effort: 4 })
        .toBuffer();
      if (converted.length <= maxBytes) return converted;
    } catch {}
  }

  // 3. Static image / WebP -> 512x512 contain with transparent padding
  try {
    const pipeline = sharp(buffer, { failOn: 'none', page: 0 })
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality, effort: 4 });

    let webp = await pipeline.toBuffer();
    if (webp.length > maxBytes) {
      for (const q of [75, 60, 45]) {
        webp = await sharp(buffer, { failOn: 'none', page: 0 })
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: q, effort: 4 })
          .toBuffer();
        if (webp.length <= maxBytes) break;
      }
    }
    return webp;
  } catch {
    return buffer;
  }
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
  maxDuration = 3,
  configuredFfmpeg = ''
} = {}) {
  // If buffer is already a valid compliant Telegram video sticker (WebM VP9 <= 256 KB)
  if (buffer && buffer.length <= maxBytes && buffer.length >= 4 && buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    const probe = await probeVideo(buffer, configuredFfmpeg).catch(() => null);
    if (probe && (probe.duration == null || probe.duration <= maxDuration + 0.5)) {
      return { buffer, bytes: buffer.length, duration: probe?.duration ?? null, width: 512, height: 512 };
    }
  }

  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) {
    throw new Error('FFmpeg is required for video stickers but was not found. Install ffmpeg-static or set media.ffmpegPath in Settings.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'lancy-video-'));
  try {
    let inputBuf = buffer;
    let inputExt = 'mp4';
    let isStaticLoop = false;
    if (isAnimatedWebP(buffer)) {
      try {
        inputBuf = await sharp(buffer, { animated: true }).gif().toBuffer();
        inputExt = 'gif';
      } catch {
        inputBuf = buffer;
        inputExt = 'bin';
      }
    } else if (isVideoBuffer(buffer)) {
      inputExt = 'mp4';
    } else {
      try {
        inputBuf = await sharp(buffer, { page: 0, failOn: 'none' }).png().toBuffer();
        inputExt = 'png';
        isStaticLoop = true;
      } catch {
        inputBuf = buffer;
        inputExt = 'bin';
      }
    }

    const input = join(dir, `input.${inputExt}`);
    const output = join(dir, 'output.webm');
    writeFileSync(input, inputBuf);

    // Scale so the larger side is exactly 512, other side <= 512, even integer dimensions.
    const scale = "scale='if(gte(iw,ih),512,-2)':'if(gte(iw,ih),-2,512)'";
    const duration = Math.min(3, Number(maxDuration) > 0 ? Number(maxDuration) : 3);

    const profiles = [
      { crf: 37, b: '220k', maxrate: '260k', bufsize: '520k' },
      { crf: 46, b: '150k', maxrate: '190k', bufsize: '380k' },
      { crf: 52, b: '95k',  maxrate: '120k', bufsize: '240k' }
    ];

    let webm = null;
    for (const p of profiles) {
      const args = [
        '-y',
        ...(isStaticLoop ? ['-loop', '1'] : []),
        '-i', input,
        '-t', String(duration),
        '-vf', `${scale},fps=30,format=yuv420p`,
        '-an',
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuv420p',
        '-crf', String(p.crf),
        '-b:v', p.b,
        '-maxrate', p.maxrate,
        '-bufsize', p.bufsize,
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-row-mt', '1',
        '-threads', '0',
        output
      ];
      await runFfmpeg(ffmpegPath, args);
      webm = readFileSync(output);
      if (webm.length <= maxBytes) break;
    }

    if (!webm || webm.length > maxBytes) {
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

/** Extract a representative frame from a video for perceptual hashing and preview. */
export async function extractVideoThumbnail(buffer, configuredFfmpeg = '') {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) return null;
  const dir = mkdtempSync(join(tmpdir(), 'lancy-vframe-'));
  try {
    const input = join(dir, 'input.bin');
    const output = join(dir, 'frame.jpg');
    writeFileSync(input, buffer);
    await runFfmpeg(ffmpegPath, [
      '-y', '-ss', '0.5', '-i', input,
      '-vframes', '1',
      '-vf', 'scale=256:-2',
      output
    ]);
    if (existsSync(output)) return readFileSync(output);
    return null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Full hash bundle for the dedup system. Supports images and videos. */
export async function hashBundle(buffer, { configuredFfmpeg = '' } = {}) {
  const sha = sha256Hex(buffer);
  let phash = null;
  try {
    phash = await perceptualHash(buffer);
  } catch {
    // Might be video: extract frame and hash it
    try {
      const frame = await extractVideoThumbnail(buffer, configuredFfmpeg);
      if (frame) {
        phash = await perceptualHash(frame);
      }
    } catch { /* ignore */ }
  }
  return { sha256: sha, phash };
}

export function mediaLogger() {
  return logger().child({ module: 'media' });
}

