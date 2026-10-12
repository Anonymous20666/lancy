import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { SettingsManager } from '../src/config/settings.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { TelegramController } from '../src/telegram/bot.js';
import { MediaDownloader } from '../src/media/downloader.js';

test('MediaDownloader detects matching PFP album and extracts multiple slots', async () => {
  const dl = new MediaDownloader();
  const mockPinData = {
    title: 'Gojo and Geto matching pfp icons',
    description: 'matching icons for you and bestie',
    images: { orig: { url: 'https://i.pinimg.com/originals/slot1.jpg' } },
    carousel_data: {
      carousel_slots: [
        { images: { orig: { url: 'https://i.pinimg.com/originals/slot1.jpg' } } },
        { images: { orig: { url: 'https://i.pinimg.com/originals/slot2.jpg' } } }
      ]
    }
  };

  // Mock internal fetch in downloader
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('slot1') || String(url).includes('slot2')) {
      const imgBuf = await sharp({
        create: { width: 400, height: 400, channels: 3, background: { r: 100, g: 150, b: 200 } }
      }).jpeg().toBuffer();
      return new Response(imgBuf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(
      `<html><body><script id="__PWS_DATA__" type="application/json">${JSON.stringify({
        props: {
          initialReduxState: {
            pins: { '123456': mockPinData }
          }
        }
      })}</script></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  };

  try {
    const res = await dl.download('https://www.pinterest.com/pin/123456/');
    assert.equal(res.platform, 'pinterest');
    assert.equal(res.isMatchingPfp, true);
    assert.ok(res.mediaItems.length >= 2, `expected >= 2 media items, got ${res.mediaItems.length}`);
    assert.equal(res.mediaItems[0].type, 'photo');
    assert.equal(res.mediaItems[1].type, 'photo');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('downloader screen renders gothic aesthetic card with matching PFP action buttons', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  let sentRich = null;
  let sentFiles = null;

  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      sentRich = rich;
      sentFiles = files;
      return { message_id: 101 };
    },
    sendChatAction: async () => {},
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      sentRich = rich;
      sentFiles = files;
      return { message_id: 101 };
    },
    answerCallbackQuery: async () => {}
  };

  const app = {
    db,
    settings,
    mediaDownloader: {
      download: async () => ({
        platform: 'pinterest',
        title: 'Anime Duo Matching PFP',
        isMatchingPfp: true,
        mediaItems: [
          { type: 'photo', buffer: Buffer.from('img1'), filename: '1.jpg', mimeType: 'image/jpeg' },
          { type: 'photo', buffer: Buffer.from('img2'), filename: '2.jpg', mimeType: 'image/jpeg' }
        ]
      })
    },
    telegram: { api: mockApi }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStates(sm);

  const ctx = {
    tgId: 2001,
    chatId: 2001,
    api: mockApi,
    db,
    settings,
    sm,
    user: { first_name: 'AestheticUser' },
    isGroup: false
  };

  await downloader.executeDownload(ctx, 'https://www.pinterest.com/pin/123456/');

  assert.ok(sentRich, 'should have sent rich message');
  const fullText = JSON.stringify(sentRich);
  assert.ok(fullText.includes('MATCHING PFP') || fullText.includes('𝑴𝑨𝑻𝑪𝑯𝑰𝑵𝑮 𝑷𝑭𝑷'), 'should include matching pfp header');
  assert.ok(fullText.includes('Send 2 PFPs Separately'), 'should include Send Separately button');
  assert.ok(fullText.includes('1:1 Avatar Crop'), 'should include 1:1 Avatar Crop button');
  assert.ok(fullText.includes('Sticker Pair (2)'), 'should include Sticker Pair button');
  assert.ok(fullText.includes('More Matching PFPs'), 'should include More Matching PFPs button');

  db.close();
});

test('pfp_sep delivers individual photos with instructions and pfp_crop creates 640x640 avatar', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  // Create real test image buffers with sharp
  const img1 = await sharp({
    create: { width: 500, height: 750, channels: 3, background: { r: 255, g: 100, b: 150 } }
  }).jpeg().toBuffer();

  const img2 = await sharp({
    create: { width: 500, height: 750, channels: 3, background: { r: 100, g: 200, b: 255 } }
  }).jpeg().toBuffer();

  const sentPhotos = [];
  const mockApi = {
    answerCallbackQuery: async () => {},
    sendChatAction: async () => {},
    sendPhoto: async (chatId, photo, opts) => {
      sentPhotos.push({ chatId, photo, opts });
      return { message_id: 300 + sentPhotos.length };
    },
    sendMessage: async () => ({ message_id: 500 }),
    editMessageRich: async (chatId, msgId, rich) => {
      sentRich = rich;
      return { message_id: 201 };
    }
  };

  const app = {
    db,
    settings,
    mediaDownloader: {
      download: async () => ({
        platform: 'pinterest',
        title: 'Couple PFP',
        isMatchingPfp: true,
        mediaItems: [
          { type: 'photo', buffer: img1, filename: 'p1.jpg', mimeType: 'image/jpeg' },
          { type: 'photo', buffer: img2, filename: 'p2.jpg', mimeType: 'image/jpeg' }
        ]
      })
    },
    telegram: { api: mockApi }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStates(sm);

  // Execute download first to populate album/image cache
  const ctx = {
    tgId: 3001,
    chatId: 3001,
    api: mockApi,
    db,
    settings,
    sm,
    user: { first_name: 'TestUser' }
  };

  let sentRich = null;
  mockApi.sendRichMessage = async (c, rich, extra, files) => {
    sentRich = rich;
    return { message_id: 201 };
  };

  await downloader.executeDownload(ctx, 'https://www.pinterest.com/pin/999999/');

  // Extract pfpKey from the buttons
  let pfpKey = null;
  for (const b of sentRich?.blocks || []) {
    if (b.type === 'buttons') {
      for (const btn of b.buttons || []) {
        if (btn.callback_data?.includes(':pfp_sep:')) {
          pfpKey = btn.callback_data.split(':pfp_sep:')[1];
        }
      }
    }
  }
  assert.ok(pfpKey, 'should have extracted pfpKey');

  // Test 1: pfp_sep (separate delivery)
  sentPhotos.length = 0;
  await downloader.handle(ctx, 'pfp_sep', [pfpKey]);

  assert.equal(sentPhotos.length, 2, 'should have sent 2 separate photos');
  assert.ok(sentPhotos[0].opts.caption.includes('MATCHING PFP (1/2)'));
  assert.ok(sentPhotos[0].opts.caption.includes('Set as Profile Photo'));
  assert.ok(sentPhotos[1].opts.caption.includes('MATCHING PFP (2/2)'));

  // Test 2: pfp_crop (1:1 square crop with sharp)
  sentPhotos.length = 0;
  await downloader.handle(ctx, 'pfp_crop', [pfpKey]);

  assert.equal(sentPhotos.length, 2, 'should have sent 2 cropped photos');
  assert.ok(sentPhotos[0].opts.caption.includes('1:1 AVATAR CROP (1/2)'));
  assert.ok(sentPhotos[0].opts.caption.includes('640×640'));

  // Verify cropped dimensions are 640x640
  const meta1 = await sharp(sentPhotos[0].photo).metadata();
  assert.equal(meta1.width, 640);
  assert.equal(meta1.height, 640);

  const meta2 = await sharp(sentPhotos[1].photo).metadata();
  assert.equal(meta2.width, 640);
  assert.equal(meta2.height, 640);

  db.close();
});

test('bot routes /pfp and /matching commands and offers inline query hints', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('general.ownerIds', [12345]);
  const sm = new StateMachine({ db });

  let pfpSearchExecuted = null;
  let pfpMenuOpened = false;

  const mockDownloaderScreen = {
    executeDownload: async () => {},
    executePfpSearch: async (ctx, query) => {
      pfpSearchExecuted = query;
    },
    handle: async (ctx, action) => {
      if (action === 'pfp_menu') pfpMenuOpened = true;
      return { message_id: 888 };
    }
  };

  let sentInlineAnswers = null;
  const mockApi = {
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        sentInlineAnswers = payload.results;
      }
      return true;
    },
    sendMessage: async () => ({ message_id: 111 })
  };

  const bot = new TelegramController({
    api: mockApi,
    db,
    settings,
    sm,
    screens: new Map([['downloader', mockDownloaderScreen]]),
    log: console
  });

  // Test /pfp with theme
  await bot.handleUpdate({
    message: {
      message_id: 1,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, first_name: 'Test' },
      text: '/pfp cat couple'
    }
  });
  assert.equal(pfpSearchExecuted, 'cat couple');

  // Test /matching without args (opens matching menu)
  await bot.handleUpdate({
    message: {
      message_id: 2,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, first_name: 'Test' },
      text: '/matching'
    }
  });
  assert.equal(pfpMenuOpened, true);

  // Test inline query suggestion includes pfp
  await bot.handleUpdate({
    inline_query: {
      id: 'query_1',
      from: { id: 12345 },
      query: ''
    }
  });

  assert.ok(sentInlineAnswers?.length > 0);
  const pfpArticle = sentInlineAnswers.find((it) => it.id?.includes('pfp'));
  assert.ok(pfpArticle, 'should provide pfp inline command suggestion');
  assert.ok(pfpArticle.title.toLowerCase().includes('pfp'));

  db.close();
});
