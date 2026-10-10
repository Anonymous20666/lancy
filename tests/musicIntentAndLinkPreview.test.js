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

test('Downloader State: URL_DOWNLOADER_INPUT in mode url rejects non-URL plain text without downloading music', async () => {
  const { createDownloaderScreen } = await import('../src/telegram/screens/downloader.js');
  const { StateMachine, States } = await import('../src/core/stateMachine.js');
  const { Database } = await import('../src/core/db.js');

  let downloadTriggered = false;
  let rejectedMsgSent = false;
  const db = new Database(':memory:');
  const sm = new StateMachine();
  const app = {
    telegram: {
      api: {
        sendRichMessage: async () => { rejectedMsgSent = true; return { message_id: 101 }; },
        sendMessage: async () => { rejectedMsgSent = true; return { message_id: 101 }; }
      }
    },
    mediaDownloader: {
      download: async () => {
        downloadTriggered = true;
        return { mediaItems: [] };
      }
    }
  };

  const dl = createDownloaderScreen({ app });
  dl.registerStateHandlers(sm);

  // Transition into URL mode
  await sm.transition('100', States.URL_DOWNLOADER_INPUT, { context: { mode: 'url' }, chatId: 100 });
  const handled = await sm.handleMessage('100', {
    chat: { id: 100 },
    from: { id: 100 },
    text: 'random song or query'
  });

  assert.equal(handled, true);
  assert.equal(downloadTriggered, false, 'Non-URL plain text in mode url must NOT trigger download');
  assert.equal(rejectedMsgSent, true, 'User must be notified that a valid link is required');
  db.close();
});

test('Downloader State: MUSIC_SEARCH_INPUT in mode music executes download for song titles', async () => {
  const { createDownloaderScreen } = await import('../src/telegram/screens/downloader.js');
  const { StateMachine, States } = await import('../src/core/stateMachine.js');
  const { Database } = await import('../src/core/db.js');

  let downloadedUrl = null;
  const db = new Database(':memory:');
  const sm = new StateMachine();
  const app = {
    telegram: {
      api: {
        sendRichMessage: async () => ({ message_id: 102 }),
        sendMessage: async () => ({ message_id: 102 }),
        editMessageRich: async () => true,
        sendChatAction: async () => true
      }
    },
    mediaDownloader: {
      download: async (url) => {
        downloadedUrl = url;
        return {
          platform: 'spotify',
          title: 'Die With A Smile',
          artist: 'Lady Gaga & Bruno Mars',
          mediaItems: [],
          audioTrack: { buffer: Buffer.from('mp3'), title: 'Die With A Smile', performer: 'Lady Gaga' }
        };
      }
    }
  };

  const dl = createDownloaderScreen({ app });
  dl.registerStateHandlers(sm);

  await sm.transition('100', States.MUSIC_SEARCH_INPUT, { context: { mode: 'music' }, chatId: 100 });
  const handled = await sm.handleMessage('100', {
    chat: { id: 100 },
    from: { id: 100 },
    text: 'Die With A Smile'
  });

  assert.equal(handled, true);
  assert.equal(downloadedUrl, 'Die With A Smile', 'Plain text song title in MUSIC_SEARCH_INPUT triggers music download');
  db.close();
});
