import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWhatsAppStickerBuffer } from '../src/whatsapp/publisher.js';
import { TelegramAPI } from '../src/telegram/api.js';
import sharp from 'sharp';

test('validateWhatsAppStickerBuffer validates compliant 512x512 WebP buffers', async () => {
  const validWebp = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } }
  }).webp().toBuffer();

  const result = await validateWhatsAppStickerBuffer(validWebp);
  assert.equal(result, true);
});

test('validateWhatsAppStickerBuffer rejects non-512x512 dimensions or empty buffers', async () => {
  await assert.rejects(async () => {
    await validateWhatsAppStickerBuffer(Buffer.alloc(0));
  }, /empty/i);

  const nonSquareWebp = await sharp({
    create: { width: 341, height: 512, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } }
  }).webp().toBuffer();

  await assert.rejects(async () => {
    await validateWhatsAppStickerBuffer(nonSquareWebp);
  }, /512x512/i);
});

test('TelegramAPI.sendMessage attaches link_preview_options when URL is present', async () => {
  let captured = null;
  const api = new TelegramAPI('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  api.call = async (method, params) => {
    captured = { method, params };
    return { ok: true, result: { message_id: 1 } };
  };

  await api.sendMessage(100, 'Check this song out: https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(captured.method, 'sendMessage');
  assert.ok(captured.params.link_preview_options, 'link_preview_options must be set');
  assert.equal(captured.params.link_preview_options.is_disabled, false);
  assert.equal(captured.params.link_preview_options.prefer_large_media, true);

  // Without URL
  captured = null;
  await api.sendMessage(100, 'Hello without any link');
  assert.equal(captured.params.link_preview_options, undefined);
});
