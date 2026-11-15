import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  resolveFfmpegPath,
  perceptualHash,
  isAnimatedWebP,
  isVideoBuffer,
  isWebPBuffer
} from '../media/convert.js';
import { sha256Hex } from '../utils/hash.js';
import { isTgsBuffer } from '../media/validate.js';

const CUSTOM_EMOJI_SIZE = 100;
const REGULAR_STICKER_SIZE = 512;
const STATIC_MAX_BYTES = 512 * 1024;
const VIDEO_MAX_BYTES = 256 * 1024;
const TGS_MAX_BYTES = 64 * 1024;

function isGifBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF';
}

function isWebmBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4
    && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
}

function spawnFfmpeg(ffmpegPath, args, timeoutMs = 45000) {
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
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 600)}`));
    });
  });
}

async function ffprobeFile(ffmpegPath, filePath, { inputCodec = null } = {}) {
  const candidate = ffmpegPath && ffmpegPath !== 'ffmpeg' ? ffmpegPath.replace(/ffmpeg$/, 'ffprobe') : null;
  const ffprobePath = candidate && existsSync(candidate) ? candidate : 'ffprobe';
  const args = [
    '-v', 'error',
    ...(inputCodec ? ['-c:v', inputCodec] : []),
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.slice(0, 300) || `ffprobe exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

async function probeViaFfmpegStderr(ffmpegPath, filePath, { inputCodec = null } = {}) {
  const args = [...(inputCodec ? ['-c:v', inputCodec] : []), '-i', filePath];
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath || 'ffmpeg', args);
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const vidLine = err.split('\n').find((l) => /Video:\s/i.test(l)) || '';
      const durMatch = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const fpsMatch = vidLine.match(/([\d.]+)\s*fps\b/i);
      const dimMatch = vidLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
      const duration = durMatch
        ? (Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])) || null
        : null;
      const fps = fpsMatch ? Math.min(30, Math.max(1, Math.round(Number(fpsMatch[1]) || 30))) : 30;
      const hasAlpha = /(?:yuva420p|rgba|bgra|argb|abgr|gbrap|pal8)/i.test(vidLine) || /alpha_mode\s*:\s*1/i.test(err);
      const codecMatch = vidLine.match(/Video:\s*([a-z0-9_]+)/i);
      resolve({
        width: dimMatch ? Number(dimMatch[1]) : null,
        height: dimMatch ? Number(dimMatch[2]) : null,
        duration,
        fps,
        pixFmt: '',
        hasAlpha,
        hasAudio: /Audio:\s/i.test(err),
        codec: codecMatch ? codecMatch[1].toLowerCase() : null
      });
    });
  });
}

async function probeMediaDetails(ffmpegPath, filePath, { isWebm = false } = {}) {
  const info = await ffprobeFile(ffmpegPath, filePath, { inputCodec: isWebm ? 'libvpx-vp9' : null }).catch(() => null);
  const vs = (info?.streams ?? []).find((s) => s.codec_type === 'video');
  if (!vs) {
    const fallback = await probeViaFfmpegStderr(ffmpegPath, filePath, { inputCodec: isWebm ? 'libvpx-vp9' : null }).catch(() => null);
    if (fallback) return fallback;
  }
  const as = (info?.streams ?? []).find((s) => s.codec_type === 'audio');
  const pixFmt = String(vs?.pix_fmt || '');
  const hasAlphaTag = String(vs?.tags?.alpha_mode || vs?.tags?.ALPHA_MODE || '') === '1';
  const hasAlpha = hasAlphaTag || /(?:yuva|rgba|bgra|argb|abgr|gbrap|pal8)/i.test(pixFmt);
  let fps = 30;
  if (vs?.avg_frame_rate && vs.avg_frame_rate.includes('/')) {
    const [num, den] = vs.avg_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) fps = Math.min(30, Math.max(1, Math.round(num / den)));
  }
  const duration = Number(info?.format?.duration ?? vs?.duration ?? 0) || null;
  return {
    width: vs?.width ?? null,
    height: vs?.height ?? null,
    duration,
    fps,
    pixFmt,
    hasAlpha,
    hasAudio: Boolean(as),
    codec: vs?.codec_name ?? null
  };
}

/** Decode animated WebP to PNG frame sequence in parallel chunks so alpha is preserved losslessly. */
async function unpackAnimatedWebpToFrames(buffer, dir) {
  const meta = await sharp(buffer, { animated: true, failOn: 'none' }).metadata();
  const pages = Math.max(1, Math.min(meta.pages || 1, 90));
  const delays = Array.isArray(meta.delay) ? meta.delay : [];
  const avgDelayMs = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 40;
  const fps = Math.min(30, Math.max(8, Math.round(1000 / Math.max(20, avgDelayMs))));

  const chunkSize = 8;
  for (let start = 0; start < pages; start += chunkSize) {
    const end = Math.min(pages, start + chunkSize);
    await Promise.all(
      Array.from({ length: end - start }, (_, k) => start + k).map(async (i) => {
        const frameBuf = await sharp(buffer, { page: i, failOn: 'none' }).ensureAlpha().png().toBuffer();
        writeFileSync(join(dir, `frame_${String(i).padStart(4, '0')}.png`), frameBuf);
      })
    );
  }
  return {
    fps,
    duration: Math.max(0.2, (pages * avgDelayMs) / 1000),
    hasAlpha: Boolean(meta.hasAlpha)
  };
}

/**
 * Convert a static image buffer to a crisp 100x100 Telegram custom emoji WebP.
 * Applies fast passthrough for already-compliant 100x100 WebP, or smart transparent
 * border trim + Lanczos3 + edge sharpening + lossless-first WebP.
 */
export async function toCustomEmojiStatic(buffer, {
  maxBytes = STATIC_MAX_BYTES,
  autoEnhance = true,
  smartBorderTrim = true,
  allowPassthrough = true,
  configuredFfmpeg = ''
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Static custom emoji requires a non-empty image buffer');
  }

  let base = sharp(buffer, { page: 0, failOn: 'none' }).rotate();
  const meta = await base.metadata().catch(() => ({}));

  if (
    allowPassthrough
    && meta.format === 'webp'
    && !isAnimatedWebP(buffer)
    && meta.width === CUSTOM_EMOJI_SIZE
    && meta.height === CUSTOM_EMOJI_SIZE
    && buffer.length <= maxBytes
  ) {
    const sha256 = sha256Hex(buffer);
    const phash = await perceptualHash(buffer).catch(() => null);
    return {
      buffer,
      format: 'static',
      width: CUSTOM_EMOJI_SIZE,
      height: CUSTOM_EMOJI_SIZE,
      bytes: buffer.length,
      filename: 'emoji.webp',
      sha256,
      phash,
      passthrough: true
    };
  }

  if (smartBorderTrim && meta.hasAlpha) {
    try {
      const { data: trimmedBuf, info: trimmedInfo } = await sharp(buffer, { page: 0, failOn: 'none' })
        .rotate()
        .ensureAlpha()
        .trim({ threshold: 10 })
        .png()
        .toBuffer({ resolveWithObject: true });
      if ((trimmedInfo?.width ?? 0) >= 4 && (trimmedInfo?.height ?? 0) >= 4) {
        base = sharp(trimmedBuf);
      }
    } catch {
      // Skip trim if uniform/solid image
    }
  }

  const innerSize = smartBorderTrim ? 92 : CUSTOM_EMOJI_SIZE;
  const margin = smartBorderTrim ? 4 : 0;

  let pipeline = base
    .ensureAlpha()
    .resize(innerSize, innerSize, {
      fit: 'contain',
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

  if (margin > 0) {
    pipeline = pipeline.extend({
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }

  if (autoEnhance) {
    pipeline = pipeline.sharpen({ sigma: 0.65, m1: 0.8, m2: 1.5 });
  }

  // Prefer lossless WebP first at 100x100 (effort 2 cuts encode latency >2x at 100x100 with crisp edges).
  let webp = await pipeline.clone().webp({ lossless: true, effort: 2 }).toBuffer();
  if (webp.length > maxBytes) {
    for (const q of [96, 90, 80, 68, 55]) {
      webp = await pipeline.clone().webp({ quality: q, alphaQuality: 100, effort: 2 }).toBuffer();
      if (webp.length <= maxBytes) break;
    }
  }
  if (webp.length > maxBytes) {
    throw new Error(`Could not fit 100x100 static emoji under ${(maxBytes / 1024).toFixed(0)} KB`);
  }

  const sha256 = sha256Hex(webp);
  const phash = await perceptualHash(webp).catch(() => null);
  return {
    buffer: webp,
    format: 'static',
    width: CUSTOM_EMOJI_SIZE,
    height: CUSTOM_EMOJI_SIZE,
    bytes: webp.length,
    filename: 'emoji.webp',
    sha256,
    phash
  };
}

/**
 * Convert a video, GIF, animated WebP, or static image into an exact 100x100
 * VP9 WebM Telegram custom emoji (<= 256 KB, <= 3.0s, <= 30fps, alpha-safe, no audio).
 */
export async function toCustomEmojiVideo(buffer, {
  maxBytes = VIDEO_MAX_BYTES,
  maxDuration = 2.95,
  autoEnhance = true,
  allowPassthrough = true,
  configuredFfmpeg = ''
} = {}) {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (!ffmpegPath) {
    throw new Error('FFmpeg is required for video custom emojis');
  }

  const durCap = Math.min(2.95, Math.max(0.5, Number(maxDuration) || 2.95));
  const dir = mkdtempSync(join(tmpdir(), 'lancy-cemoji-v-'));
  try {
    let inputArgs = [];
    let hasAlpha = false;
    let sourceDuration = null;
    let sourceFps = 30;
    let firstFramePngPath = null;
    let inPath = null;

    if (isAnimatedWebP(buffer)) {
      const seq = await unpackAnimatedWebpToFrames(buffer, dir);
      inputArgs = ['-framerate', String(seq.fps), '-i', join(dir, 'frame_%04d.png')];
      hasAlpha = seq.hasAlpha;
      sourceDuration = seq.duration;
      sourceFps = seq.fps;
      const f0 = join(dir, 'frame_0000.png');
      if (existsSync(f0)) firstFramePngPath = f0;
    } else if (isGifBuffer(buffer)) {
      inPath = join(dir, 'input.gif');
      writeFileSync(inPath, buffer);
      const info = await probeMediaDetails(ffmpegPath, inPath);
      inputArgs = ['-i', inPath];
      hasAlpha = info.hasAlpha || Boolean((await sharp(buffer).metadata().catch(() => ({}))).hasAlpha);
      sourceDuration = info.duration;
      sourceFps = info.fps || 24;
    } else if (isVideoBuffer(buffer)) {
      const isWebm = isWebmBuffer(buffer);
      inPath = join(dir, isWebm ? 'input.webm' : 'input.mp4');
      writeFileSync(inPath, buffer);
      const info = await probeMediaDetails(ffmpegPath, inPath, { isWebm });

      // Fast-path passthrough: already a compliant 100x100 VP9 WebM custom emoji (<=256KB, <=2.95s, no audio)
      if (
        allowPassthrough
        && isWebm
        && info.codec === 'vp9'
        && info.width === CUSTOM_EMOJI_SIZE
        && info.height === CUSTOM_EMOJI_SIZE
        && !info.hasAudio
        && info.duration
        && info.duration <= durCap
        && (info.fps || 30) <= 30
        && buffer.length <= maxBytes
      ) {
        const thumbPath = join(dir, 'thumb.png');
        await spawnFfmpeg(ffmpegPath, [
          '-y', '-c:v', 'libvpx-vp9', '-i', inPath, '-frames:v', '1', '-vf', 'scale=64:64:flags=fast_bilinear', thumbPath
        ], 15000).catch(() => {});
        const phash = existsSync(thumbPath) ? await perceptualHash(readFileSync(thumbPath)).catch(() => null) : null;
        return {
          buffer,
          format: 'video',
          width: CUSTOM_EMOJI_SIZE,
          height: CUSTOM_EMOJI_SIZE,
          duration: info.duration,
          hasAlpha: Boolean(info.hasAlpha),
          bytes: buffer.length,
          filename: 'emoji.webm',
          sha256: sha256Hex(buffer),
          phash,
          passthrough: true
        };
      }

      // Explicitly pass libvpx-vp9 as input decoder for WebM so VP9 alpha plane decodes intact.
      inputArgs = [...(isWebm ? ['-c:v', 'libvpx-vp9'] : []), '-i', inPath];
      hasAlpha = info.hasAlpha;
      sourceDuration = info.duration;
      sourceFps = info.fps || 30;
    } else {
      // Static image turned into a brief subtle 1.5s custom video emoji loop if requested explicitly
      const pngBuf = await sharp(buffer, { page: 0, failOn: 'none' }).ensureAlpha().png().toBuffer();
      inPath = join(dir, 'static.png');
      writeFileSync(inPath, pngBuf);
      inputArgs = ['-loop', '1', '-i', inPath];
      hasAlpha = true;
      sourceDuration = 1.5;
      sourceFps = 24;
      firstFramePngPath = inPath;
    }

    // Speed up slightly if between 3.0s and 6.5s so the whole animation loop completes cleanly.
    let speedExpr = '';
    let effectiveDuration = Math.min(durCap, Math.max(0.5, Number(sourceDuration) || durCap));
    if (sourceDuration && sourceDuration > durCap && sourceDuration <= 6.5) {
      const factor = (durCap - 0.05) / sourceDuration;
      speedExpr = `setpts=${factor.toFixed(4)}*PTS,`;
      effectiveDuration = durCap - 0.05;
    }

    const outPath = join(dir, 'emoji.webm');
    const pixFmt = hasAlpha ? 'yuva420p' : 'yuv420p';
    const enhanceFilter = autoEnhance ? ',cas=0.35,unsharp=3:3:0.30:3:3:0.0' : '';

    // Smart byte-budget bitrate selection so 1st pass fits <= 256 KB cleanly in ~0.3s via -cpu-used 4.
    const budgetKbps = Math.floor((maxBytes * 8 * 0.76) / (Math.max(0.5, effectiveDuration) * 1000));
    const p1Kbps = Math.max(115, Math.min(280, budgetKbps));
    const p2Kbps = Math.max(85, Math.min(180, Math.floor(p1Kbps * 0.65)));
    const p3Kbps = Math.max(65, Math.min(120, Math.floor(p2Kbps * 0.65)));
    const profiles = [
      { crf: 25, bitrate: `${p1Kbps}k`, maxrate: `${Math.round(p1Kbps * 1.25)}k`, fps: Math.min(30, sourceFps) },
      { crf: 34, bitrate: `${p2Kbps}k`, maxrate: `${Math.round(p2Kbps * 1.25)}k`, fps: Math.min(24, sourceFps) },
      { crf: 44, bitrate: `${p3Kbps}k`, maxrate: `${Math.round(p3Kbps * 1.25)}k`, fps: Math.min(18, sourceFps) }
    ];

    let webm = null;
    for (const prof of profiles) {
      const vf = `${speedExpr}format=rgba,scale=100:100:flags=lanczos:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=${prof.fps}${enhanceFilter},format=${pixFmt}`;
      await spawnFfmpeg(ffmpegPath, [
        '-y',
        ...inputArgs,
        '-t', String(durCap),
        '-vf', vf,
        '-an',
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', pixFmt,
        '-crf', String(prof.crf),
        '-b:v', prof.bitrate,
        '-maxrate', prof.maxrate,
        '-bufsize', '400k',
        '-deadline', 'good',
        '-cpu-used', '4',
        '-threads', '2',
        '-row-mt', '1',
        outPath
      ]);
      webm = readFileSync(outPath);
      if (webm.length <= maxBytes) break;
    }

    if (!webm || webm.length > maxBytes) {
      throw new Error(`Could not fit 100x100 video emoji under ${(maxBytes / 1024).toFixed(0)} KB`);
    }

    if (!firstFramePngPath) {
      const thumbPath = join(dir, 'thumb.png');
      await spawnFfmpeg(ffmpegPath, [
        '-y', '-c:v', 'libvpx-vp9', '-i', outPath, '-frames:v', '1', '-vf', 'scale=64:64:flags=fast_bilinear', thumbPath
      ], 15000).catch(() => {});
      if (existsSync(thumbPath)) firstFramePngPath = thumbPath;
    }
    const phash = firstFramePngPath ? await perceptualHash(readFileSync(firstFramePngPath)).catch(() => null) : null;
    return {
      buffer: webm,
      format: 'video',
      width: CUSTOM_EMOJI_SIZE,
      height: CUSTOM_EMOJI_SIZE,
      duration: effectiveDuration,
      hasAlpha,
      bytes: webm.length,
      filename: 'emoji.webm',
      sha256: sha256Hex(webm),
      phash
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Automatically classify and convert ANY incoming Telegram media/sticker buffer
 * (image, MP4, MOV, WebM, GIF, animated WebP, or TGS) into a Telegram Custom Emoji item.
 */
export async function toCustomEmojiAsset(descriptor, opts = {}) {
  const buf = descriptor?.buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) {
    throw new Error('Empty media buffer passed to toCustomEmojiAsset');
  }

  const configuredFfmpeg = opts.configuredFfmpeg ?? '';
  const sourceSha256 = sha256Hex(buf);
  const allowPassthrough = opts.allowPassthrough !== undefined
    ? Boolean(opts.allowPassthrough)
    : (descriptor?.allowPassthrough !== undefined ? Boolean(descriptor.allowPassthrough) : true);

  let converted;
  if (isTgsBuffer(buf) || descriptor?.format === 'animated' || descriptor?.isAnimated) {
    if (!isTgsBuffer(buf)) {
      throw new Error('Animated sticker is not a valid TGS Lottie gzip file');
    }
    if (buf.length > TGS_MAX_BYTES) {
      throw new Error(`TGS custom emoji exceeds 64 KB (${(buf.length / 1024).toFixed(1)} KB)`);
    }
    converted = {
      buffer: buf,
      format: 'animated',
      width: 512,
      height: 512,
      bytes: buf.length,
      filename: 'emoji.tgs',
      sha256: sourceSha256,
      phash: null
    };
  } else if (
    isVideoBuffer(buf)
    || isAnimatedWebP(buf)
    || (isGifBuffer(buf) && ((await sharp(buf, { animated: true, failOn: 'none' }).metadata().catch(() => ({}))).pages ?? 1) > 1)
    || descriptor?.isVideo
    || descriptor?.type === 'video'
  ) {
    converted = await toCustomEmojiVideo(buf, {
      autoEnhance: opts.autoEnhance ?? true,
      allowPassthrough,
      configuredFfmpeg
    });
  } else {
    converted = await toCustomEmojiStatic(buf, {
      autoEnhance: opts.autoEnhance ?? true,
      smartBorderTrim: opts.smartBorderTrim ?? true,
      allowPassthrough,
      configuredFfmpeg
    });
  }

  return {
    ...converted,
    emoji: descriptor?.emoji?.length
      ? (Array.isArray(descriptor.emoji) ? descriptor.emoji : [descriptor.emoji])
      : [opts.defaultEmoji || '✨'],
    sourceSha256,
    sourceBuffer: buf
  };
}

/**
 * Reverse HD Converter: Turn a 100x100 custom emoji (or 512x512 sticker) back into
 * crisp HD Media (1024px lossless PNG / HQ JPG / 720p MP4 / transparent HD GIF / .tgs).
 */
export async function toHdMediaFromEmoji(buffer, {
  outputFormat = 'png_doc', // 'png_doc' | 'photo' | 'mp4' | 'gif'
  targetSize = 1024,
  originalSourceBuffer = null,
  configuredFfmpeg = ''
} = {}) {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  const size = Math.min(1280, Math.max(512, Number(targetSize) || 1024));

  // If we have the un-downscaled original source in cache and user wants native photo/video back:
  if (Buffer.isBuffer(originalSourceBuffer) && originalSourceBuffer.length) {
    if ((outputFormat === 'png_doc' || outputFormat === 'photo') && !isVideoBuffer(originalSourceBuffer) && !isTgsBuffer(originalSourceBuffer)) {
      const meta = await sharp(originalSourceBuffer, { page: 0, failOn: 'none' }).metadata().catch(() => ({}));
      if ((meta.width ?? 0) >= 512 || (meta.height ?? 0) >= 512) {
        if (outputFormat === 'photo') {
          const jpg = await sharp(originalSourceBuffer, { page: 0, failOn: 'none' })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 96, mozjpeg: true })
            .toBuffer();
          return { buffer: jpg, mediaKind: 'photo', filename: 'hd_emoji.jpg', width: meta.width, height: meta.height, fromOriginal: true };
        }
        const png = await sharp(originalSourceBuffer, { page: 0, failOn: 'none' }).ensureAlpha().png().toBuffer();
        return { buffer: png, mediaKind: 'document', filename: 'hd_emoji.png', width: meta.width, height: meta.height, fromOriginal: true };
      }
    }
  }

  if (isTgsBuffer(buffer)) {
    return {
      buffer,
      mediaKind: 'document',
      filename: 'emoji.tgs',
      format: 'animated',
      width: 512,
      height: 512
    };
  }

  const isAnimatedInput = isVideoBuffer(buffer) || isAnimatedWebP(buffer)
    || (isGifBuffer(buffer) && ((await sharp(buffer, { animated: true, failOn: 'none' }).metadata().catch(() => ({}))).pages ?? 1) > 1);

  if (isAnimatedInput) {
    if (!ffmpegPath) throw new Error('FFmpeg is required for HD video emoji export');
    const dir = mkdtempSync(join(tmpdir(), 'lancy-hd-rev-'));
    try {
      let inputArgs = [];
      let hasAlpha = false;
      let duration = 2.0;
      let srcWidth = 100;
      let srcHeight = 100;

      if (isAnimatedWebP(buffer)) {
        const seq = await unpackAnimatedWebpToFrames(buffer, dir);
        const wpMeta = await sharp(buffer, { page: 0, failOn: 'none' }).metadata().catch(() => ({}));
        inputArgs = ['-framerate', String(seq.fps), '-i', join(dir, 'frame_%04d.png')];
        hasAlpha = seq.hasAlpha;
        duration = seq.duration;
        srcWidth = wpMeta.width || 100;
        srcHeight = wpMeta.height || 100;
      } else {
        const isWebm = isWebmBuffer(buffer);
        const inPath = join(dir, isWebm ? 'in.webm' : (isGifBuffer(buffer) ? 'in.gif' : 'in.mp4'));
        writeFileSync(inPath, buffer);
        const info = await probeMediaDetails(ffmpegPath, inPath, { isWebm });
        hasAlpha = info.hasAlpha;
        duration = info.duration || 2.0;
        srcWidth = info.width || 100;
        srcHeight = info.height || 100;
        const loopArgs = duration < 1.5 ? ['-stream_loop', '1'] : [];
        inputArgs = [...loopArgs, ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []), '-i', inPath];
      }

      const useXbr = srcWidth <= 256 && srcHeight <= 256;

      if (outputFormat === 'gif') {
        const gifSize = Math.min(720, size);
        const outGif = join(dir, 'hd.gif');
        const rgbUp = useXbr
          ? `format=bgr0,hqdn3d=1.2:1.2:4:4,xbr=4,scale=${gifSize}:${gifSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${gifSize}:${gifSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,cas=0.40`
          : `format=rgba,hqdn3d=1.0:1.0:3:3,scale=${gifSize}:${gifSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${gifSize}:${gifSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,cas=0.35`;
        const alphaUp = useXbr
          ? `alphaextract,format=bgr0,xbr=4,scale=${gifSize}:${gifSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${gifSize}:${gifSize}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`
          : `alphaextract,scale=${gifSize}:${gifSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${gifSize}:${gifSize}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`;
        const filter = hasAlpha
          ? `[0:v]split=2[rgb][a];[rgb]${rgbUp}[r];[a]${alphaUp}[al];[r][al]alphamerge,format=rgba,split[s0][s1];[s0]palettegen=stats_mode=diff:reserve_transparent=on[p];[s1][p]paletteuse=dither=sierra2_4a`
          : `[0:v]${rgbUp},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`;
        await spawnFfmpeg(ffmpegPath, ['-y', ...inputArgs, '-filter_complex', filter, outGif]);
        const gifBuf = readFileSync(outGif);
        return { buffer: gifBuf, mediaKind: 'animation', filename: 'hd_emoji.gif', width: gifSize, height: gifSize };
      }

      const vidSize = Math.min(720, size);
      const evenSize = vidSize % 2 === 0 ? vidSize : vidSize - 1;
      const outMp4 = join(dir, 'hd.mp4');
      // Composite transparent video emojis cleanly over sleek obsidian matte (#0f1115) for crisp H.264 MP4 playback
      const rgbVideoUp = useXbr
        ? `format=bgr0,hqdn3d=1.2:1.2:4:4,xbr=4,scale=${evenSize}:${evenSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${evenSize}:${evenSize}:(ow-iw)/2:(oh-ih)/2:color=#0f1115,deband=1thr=0.02:2thr=0.02:3thr=0.02,cas=0.42`
        : `format=bgr0,hqdn3d=1.0:1.0:3:3,scale=${evenSize}:${evenSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${evenSize}:${evenSize}:(ow-iw)/2:(oh-ih)/2:color=#0f1115,deband=1thr=0.02:2thr=0.02:3thr=0.02,cas=0.35`;
      const alphaVideoUp = useXbr
        ? `alphaextract,format=bgr0,xbr=4,scale=${evenSize}:${evenSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${evenSize}:${evenSize}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`
        : `alphaextract,scale=${evenSize}:${evenSize}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${evenSize}:${evenSize}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`;
      const filter = hasAlpha
        ? `[0:v]split=2[rgb][a];[rgb]${rgbVideoUp}[r];[a]${alphaVideoUp}[al];[r][al]alphamerge,format=rgba[fg];color=c=#0f1115:s=${evenSize}x${evenSize}[bg];[bg][fg]overlay=shortest=1:format=auto,format=yuv420p`
        : `[0:v]${rgbVideoUp},format=yuv420p`;

      await spawnFfmpeg(ffmpegPath, [
        '-y',
        ...inputArgs,
        '-filter_complex', filter,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '17',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outMp4
      ]);
      const mp4Buf = readFileSync(outMp4);
      return { buffer: mp4Buf, mediaKind: 'video', filename: 'hd_emoji.mp4', width: evenSize, height: evenSize };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Static custom emoji / sticker -> HD upscaled crisp PNG or JPG
  const meta = await sharp(buffer, { page: 0, failOn: 'none' }).metadata();
  const hasAlpha = Boolean(meta.hasAlpha);
  const staticXbr = (meta.width ?? 100) <= 512 && (meta.height ?? 100) <= 512;
  let upscaledPng;

  if (ffmpegPath) {
    const dir = mkdtempSync(join(tmpdir(), 'lancy-hd-img-'));
    try {
      const inPng = join(dir, 'in.png');
      const outPng = join(dir, 'out.png');
      writeFileSync(inPng, await sharp(buffer, { page: 0, failOn: 'none' }).ensureAlpha().png().toBuffer());

      const imgScaleRgb = staticXbr
        ? `format=bgr0,hqdn3d=1.0:1.0:3:3,xbr=4,scale=${size}:${size}:flags=lanczos+accurate_rnd:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2,deband=1thr=0.02:2thr=0.02:3thr=0.02,cas=0.42`
        : `format=bgr0,hqdn3d=0.8:0.8:3:3,scale=${size}:${size}:flags=lanczos+accurate_rnd:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2,cas=0.35`;
      const imgScaleAlpha = staticXbr
        ? `alphaextract,format=bgr0,xbr=4,scale=${size}:${size}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`
        : `alphaextract,scale=${size}:${size}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray`;

      const filter = hasAlpha
        ? `[0:v]split=2[rgb][a];[rgb]${imgScaleRgb}[r];[a]${imgScaleAlpha}[al];[r][al]alphamerge,format=rgba`
        : `[0:v]${imgScaleRgb},unsharp=3:3:0.25:3:3:0.0,format=rgba`;

      await spawnFfmpeg(ffmpegPath, ['-y', '-i', inPng, '-filter_complex', filter, '-frames:v', '1', outPng]);
      upscaledPng = readFileSync(outPng);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    upscaledPng = await sharp(buffer, { page: 0, failOn: 'none' })
      .ensureAlpha()
      .resize(size, size, { fit: 'contain', kernel: sharp.kernel.lanczos3, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .sharpen({ sigma: 0.7 })
      .png()
      .toBuffer();
  }

  if (outputFormat === 'photo') {
    const jpg = await sharp(upscaledPng)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 96, mozjpeg: true })
      .toBuffer();
    return { buffer: jpg, mediaKind: 'photo', filename: 'hd_emoji.jpg', width: size, height: size };
  }

  return { buffer: upscaledPng, mediaKind: 'document', filename: 'hd_emoji.png', width: size, height: size };
}

/**
 * Convert a Custom Emoji (100x100) cleanly up into a 512x512 Regular Telegram Sticker
 * (static WebP, alpha-safe VP9 WebM, or lossless .tgs).
 */
export async function toRegularStickerFromEmoji(buffer, { configuredFfmpeg = '' } = {}) {
  const ffmpegPath = resolveFfmpegPath(configuredFfmpeg);
  if (isTgsBuffer(buffer)) {
    return { buffer, format: 'animated', width: 512, height: 512, filename: 'sticker.tgs', bytes: buffer.length };
  }

  const isAnim = isVideoBuffer(buffer) || isAnimatedWebP(buffer)
    || (isGifBuffer(buffer) && ((await sharp(buffer, { animated: true, failOn: 'none' }).metadata().catch(() => ({}))).pages ?? 1) > 1);

  if (isAnim) {
    if (!ffmpegPath) throw new Error('FFmpeg is required for video stickers');
    const dir = mkdtempSync(join(tmpdir(), 'lancy-ce2st-'));
    try {
      const isWebm = isWebmBuffer(buffer);
      const inPath = join(dir, isWebm ? 'in.webm' : 'in.mp4');
      writeFileSync(inPath, buffer);
      const info = await probeMediaDetails(ffmpegPath, inPath, { isWebm });
      const pixFmt = info.hasAlpha ? 'yuva420p' : 'yuv420p';
      const outPath = join(dir, 'sticker.webm');

      const profiles = [
        { crf: 26, bitrate: '280k', fps: 30 },
        { crf: 36, bitrate: '190k', fps: 30 },
        { crf: 44, bitrate: '130k', fps: 24 }
      ];
      let outBuf = null;
      for (const p of profiles) {
        const scaleSpec = `scale=${REGULAR_STICKER_SIZE}:${REGULAR_STICKER_SIZE}:flags=lanczos:force_original_aspect_ratio=decrease`;
        const filter = info.hasAlpha
          ? `[0:v]split=2[rgb][a];[rgb]format=bgr0,xbr=4,${scaleSpec}[r];[a]alphaextract,format=bgr0,xbr=4,${scaleSpec},format=gray[al];[r][al]alphamerge,format=rgba,fps=${p.fps},cas=0.35,format=${pixFmt}`
          : `[0:v]format=bgr0,xbr=4,${scaleSpec},fps=${p.fps},cas=0.35,format=${pixFmt}`;
        await spawnFfmpeg(ffmpegPath, [
          '-y',
          ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []),
          '-i', inPath,
          '-t', '2.95',
          '-filter_complex', filter,
          '-an',
          '-c:v', 'libvpx-vp9',
          '-pix_fmt', pixFmt,
          '-crf', String(p.crf),
          '-b:v', p.bitrate,
          '-deadline', 'good',
          '-cpu-used', '2',
          '-row-mt', '1',
          outPath
        ]);
        outBuf = readFileSync(outPath);
        if (outBuf.length <= VIDEO_MAX_BYTES) break;
      }
      if (!outBuf || outBuf.length > VIDEO_MAX_BYTES) {
        throw new Error('Could not fit upscaled 512px video sticker under 256 KB');
      }
      return { buffer: outBuf, format: 'video', width: 512, height: 512, filename: 'sticker.webm', bytes: outBuf.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Static: upscale via HD pipeline first then save crisp 512x512 WebP
  const hd = await toHdMediaFromEmoji(buffer, { outputFormat: 'png_doc', targetSize: REGULAR_STICKER_SIZE, configuredFfmpeg });
  let webp = await sharp(hd.buffer).webp({ lossless: true, effort: 4 }).toBuffer();
  if (webp.length > STATIC_MAX_BYTES) {
    for (const q of [94, 86, 76, 65]) {
      webp = await sharp(hd.buffer).webp({ quality: q, alphaQuality: 100, effort: 4 }).toBuffer();
      if (webp.length <= STATIC_MAX_BYTES) break;
    }
  }
  return { buffer: webp, format: 'static', width: 512, height: 512, filename: 'sticker.webp', bytes: webp.length };
}
