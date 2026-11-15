import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { resolveFfmpegPath } from '../src/media/convert.js';
import { isTgsBuffer, validateMedia } from '../src/media/validate.js';
import {
  toCustomEmojiStatic,
  toCustomEmojiVideo,
  toCustomEmojiAsset,
  toHdMediaFromEmoji,
  toRegularStickerFromEmoji
} from '../src/stickers/emojiConverter.js';

async function makeTransparentSubjectPng(size = 240) {
  // Transparent canvas with a centered bright magenta box (50% size)
  const boxSize = Math.max(20, Math.floor(size * 0.5));
  const box = await sharp({
    create: { width: boxSize, height: boxSize, channels: 4, background: { r: 235, g: 60, b: 140, alpha: 1 } }
  }).png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: box, left: Math.floor((size - boxSize) / 2), top: Math.floor((size - boxSize) / 2) }])
    .png()
    .toBuffer();
}

function makeSampleMp4(ffmpegPath, { seconds = 1.5, width = 320, height = 240 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-ce-mp4-'));
  try {
    const out = join(dir, 'sample.mp4');
    const r = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out
    ], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`ffmpeg sample mp4 failed: ${r.stderr?.toString()}`);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeTransparentSampleWebm(ffmpegPath, { seconds = 1.2, width = 100, height = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-ce-webm-'));
  try {
    const pngPath = join(dir, 'frame.png');
    const out = join(dir, 'alpha.webm');
    const raw = Buffer.alloc(width * height * 4, 0);
    // Centered opaque green square (30..70), corners transparent (alpha = 0)
    for (let y = 30; y < 70; y++) {
      for (let x = 30; x < 70; x++) {
        const idx = (y * width + x) * 4;
        raw[idx] = 40;
        raw[idx + 1] = 220;
        raw[idx + 2] = 120;
        raw[idx + 3] = 255;
      }
    }
    const pngSync = join(dir, 'gen.png');
    // Build minimal PNG via sharp inside async caller instead, or let caller pass pngBuffer!
    return { dir, out, pngPath };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

test('Custom Emoji Converter: static PNG & JPEG -> 100x100 WebP <=512KB with alpha & smart trim', async () => {
  const pngBuf = await makeTransparentSubjectPng(240);
  const resPng = await toCustomEmojiStatic(pngBuf, { autoEnhance: true, smartBorderTrim: true });
  assert.equal(resPng.format, 'static');
  assert.equal(resPng.width, 100);
  assert.equal(resPng.height, 100);
  assert.ok(resPng.bytes <= 512 * 1024);

  const metaPng = await sharp(resPng.buffer).metadata();
  assert.equal(metaPng.format, 'webp');
  assert.equal(metaPng.width, 100);
  assert.equal(metaPng.height, 100);
  assert.equal(metaPng.hasAlpha, true);

  const jpgBuf = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 20, g: 130, b: 220 } }
  }).jpeg({ quality: 92 }).toBuffer();
  const resJpg = await toCustomEmojiStatic(jpgBuf);
  const metaJpg = await sharp(resJpg.buffer).metadata();
  assert.equal(metaJpg.format, 'webp');
  assert.equal(metaJpg.width, 100);
  assert.equal(metaJpg.height, 100);
  assert.ok(resJpg.bytes <= 512 * 1024);
});

test('Custom Emoji Converter: TGS detection, validation & lossless pass-through', async () => {
  const tgsJson = JSON.stringify({ v: '5.5.2', fr: 60, ip: 0, op: 60, w: 512, h: 512, layers: [{ nm: 'shape' }] });
  const tgsBuf = gzipSync(Buffer.from(tgsJson, 'utf8'));
  assert.equal(isTgsBuffer(tgsBuf), true);
  assert.equal(isTgsBuffer(gzipSync(Buffer.from('{"hello":"world"}', 'utf8'))), false);

  const val = await validateMedia(tgsBuf);
  assert.equal(val.type, 'animated');
  assert.equal(val.mime, 'application/x-tgsticker');

  const asset = await toCustomEmojiAsset({ buffer: tgsBuf, emoji: ['🔥'] });
  assert.equal(asset.format, 'animated');
  assert.equal(asset.filename, 'emoji.tgs');
  assert.deepEqual(asset.emoji, ['🔥']);
  assert.equal(asset.buffer.equals(tgsBuf), true);
});

test('Custom Emoji Converter: MP4 video + alpha WebM + reverse HD 1024px alpha-safe upscaling & 512px sticker', async () => {
  const ffmpegPath = resolveFfmpegPath('');
  assert.ok(ffmpegPath, 'FFmpeg must be present in workspace environment');

  // 1. MP4 -> 100x100 VP9 WebM <=256KB
  const mp4 = makeSampleMp4(ffmpegPath, { seconds: 1.5, width: 320, height: 240 });
  const vidEmoji = await toCustomEmojiVideo(mp4, { configuredFfmpeg: ffmpegPath });
  assert.equal(vidEmoji.format, 'video');
  assert.equal(vidEmoji.width, 100);
  assert.equal(vidEmoji.height, 100);
  assert.ok(vidEmoji.bytes <= 256 * 1024, `expected <= 256KB got ${vidEmoji.bytes}`);
  assert.equal(vidEmoji.filename, 'emoji.webm');

  // 2. Transparent 100x100 WebP -> Reverse HD 1024x1024 PNG (must preserve corner alpha == 0!)
  const pngSrc = await makeTransparentSubjectPng(200);
  const emojiStatic = await toCustomEmojiStatic(pngSrc, { smartBorderTrim: false });
  const hdPng = await toHdMediaFromEmoji(emojiStatic.buffer, {
    outputFormat: 'png_doc',
    targetSize: 1024,
    configuredFfmpeg: ffmpegPath
  });
  assert.equal(hdPng.mediaKind, 'document');
  assert.equal(hdPng.width, 1024);
  assert.equal(hdPng.height, 1024);
  const { data, info } = await sharp(hdPng.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
  assert.equal(info.channels, 4);
  // Corner (5,5) must stay transparent (alpha near 0), center (512,512) must stay opaque (alpha >= 240)
  const cornerAlpha = data[(5 * 1024 + 5) * 4 + 3];
  const centerAlpha = data[(512 * 1024 + 512) * 4 + 3];
  assert.ok(cornerAlpha < 20, `expected transparent corner alpha < 20, got ${cornerAlpha}`);
  assert.ok(centerAlpha >= 240, `expected opaque center alpha >= 240, got ${centerAlpha}`);

  // 3. Reverse HD JPG photo (1024x1024)
  const hdJpg = await toHdMediaFromEmoji(emojiStatic.buffer, {
    outputFormat: 'photo',
    targetSize: 1024,
    configuredFfmpeg: ffmpegPath
  });
  assert.equal(hdJpg.mediaKind, 'photo');
  const jpgMeta = await sharp(hdJpg.buffer).metadata();
  assert.equal(jpgMeta.format, 'jpeg');
  assert.equal(jpgMeta.width, 1024);
  assert.equal(jpgMeta.height, 1024);

  // 4. Reverse HD MP4 video (720x720 H.264) from 100x100 WebM
  const hdMp4 = await toHdMediaFromEmoji(vidEmoji.buffer, {
    outputFormat: 'mp4',
    targetSize: 720,
    configuredFfmpeg: ffmpegPath
  });
  assert.equal(hdMp4.mediaKind, 'video');
  assert.equal(hdMp4.width, 720);
  assert.equal(hdMp4.height, 720);
  assert.ok(hdMp4.buffer.length > 1000);

  // 5. Reverse Regular 512x512 Sticker (static & transparent animated webm!)
  const regStatic = await toRegularStickerFromEmoji(emojiStatic.buffer, { configuredFfmpeg: ffmpegPath });
  assert.equal(regStatic.format, 'static');
  assert.equal(regStatic.width, 512);
  assert.equal(regStatic.height, 512);
  assert.ok(regStatic.bytes <= 512 * 1024);

  // Create transparent 100x100 WebM emoji and verify 512x512 upscaled regular WebM keeps corner alpha == 0!
  const { dir, out } = makeTransparentSampleWebm(ffmpegPath, { width: 100, height: 100 });
  try {
    const png100 = await makeTransparentSubjectPng(100);
    const pngPath = join(dir, 'frame100.png');
    writeFileSync(pngPath, png100);
    const mk = spawnSync(ffmpegPath, [
      '-y', '-loop', '1', '-i', pngPath, '-t', '0.6', '-r', '10',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '80k', out
    ], { stdio: 'pipe' });
    assert.equal(mk.status, 0);
    const alphaWebmEmoji = readFileSync(out);

    const regVideo = await toRegularStickerFromEmoji(alphaWebmEmoji, { configuredFfmpeg: ffmpegPath });
    assert.equal(regVideo.format, 'video');
    assert.equal(regVideo.width, 512);
    assert.equal(regVideo.height, 512);
    assert.ok(regVideo.bytes <= 256 * 1024);

    // Extract 1st frame of upscaled 512px WebM using libvpx-vp9 decoder to verify alpha is preserved
    const regWebmPath = join(dir, 'reg.webm');
    const outPngPath = join(dir, 'check512.png');
    writeFileSync(regWebmPath, regVideo.buffer);
    const ext = spawnSync(ffmpegPath, [
      '-y', '-c:v', 'libvpx-vp9', '-i', regWebmPath, '-frames:v', '1', outPngPath
    ], { stdio: 'pipe' });
    assert.equal(ext.status, 0);
    const chk = await sharp(readFileSync(outPngPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(chk.info.width, 512);
    assert.equal(chk.info.height, 512);
    const cAlpha = chk.data[(5 * 512 + 5) * 4 + 3];
    const mAlpha = chk.data[(256 * 512 + 256) * 4 + 3];
    assert.ok(cAlpha < 20, `expected transparent 512px WebM sticker corner alpha < 20, got ${cAlpha}`);
    assert.ok(mAlpha >= 240, `expected opaque 512px WebM sticker center alpha >= 240, got ${mAlpha}`);

    // 6. Fast-path passthrough: already 100x100 WebP & compliant 100x100 VP9 WebM skip re-encode byte-for-byte
    const passStatic = await toCustomEmojiAsset({ buffer: emojiStatic.buffer }, { configuredFfmpeg: ffmpegPath });
    assert.equal(passStatic.format, 'static');
    assert.equal(Buffer.compare(passStatic.buffer, emojiStatic.buffer), 0, '100x100 static WebP should pass through without re-encoding');

    const reStatic = await toCustomEmojiStatic(emojiStatic.buffer, { allowPassthrough: false });
    assert.equal(reStatic.width, 100);
    assert.equal(reStatic.height, 100);

    const passVideo = await toCustomEmojiAsset({ buffer: alphaWebmEmoji, isVideo: true }, { configuredFfmpeg: ffmpegPath });
    assert.equal(passVideo.format, 'video');
    assert.equal(Buffer.compare(passVideo.buffer, alphaWebmEmoji), 0, 'compliant 100x100 VP9 WebM should pass through without re-encoding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
