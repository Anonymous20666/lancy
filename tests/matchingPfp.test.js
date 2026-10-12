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

test('splitMatchingCollage: accurately splits 2-in-1 side-by-side and stacked collages into separate 1:1 avatars', async () => {
  const { splitMatchingCollage } = await import('../src/media/convert.js');

  // 1. Side-by-side duo (1000x500)
  const duo = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: { r: 255, g: 100, b: 150 } }
  }).jpeg().toBuffer();
  const duoParts = await splitMatchingCollage(duo);
  assert.equal(duoParts.length, 2, 'should split side-by-side 2:1 image into 2 parts');
  const dMeta1 = await sharp(duoParts[0]).metadata();
  const dMeta2 = await sharp(duoParts[1]).metadata();
  assert.equal(dMeta1.width, 500);
  assert.equal(dMeta1.height, 500);
  assert.equal(dMeta2.width, 500);
  assert.equal(dMeta2.height, 500);

  // 2. Stacked vertical duo (500x1000)
  const stacked = await sharp({
    create: { width: 500, height: 1000, channels: 3, background: { r: 100, g: 150, b: 255 } }
  }).jpeg().toBuffer();
  const stackedParts = await splitMatchingCollage(stacked);
  assert.equal(stackedParts.length, 2, 'should split stacked 1:2 image into 2 parts');
  const sMeta1 = await sharp(stackedParts[0]).metadata();
  const sMeta2 = await sharp(stackedParts[1]).metadata();
  assert.equal(sMeta1.width, 500);
  assert.equal(sMeta1.height, 500);
  assert.equal(sMeta2.width, 500);
  assert.equal(sMeta2.height, 500);

  // 3. Normal portrait pin (1000x1500) — must NOT be split
  const normal = await sharp({
    create: { width: 1000, height: 1500, channels: 3, background: { r: 150, g: 255, b: 150 } }
  }).jpeg().toBuffer();
  const normalParts = await splitMatchingCollage(normal);
  assert.equal(normalParts.length, 1, 'should preserve normal portrait image intact');
});

test('executePfpSearch: deep searches multi-slide pins and pages with pfp_nav', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const imgBuf1 = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 50, b: 50 } } }).jpeg().toBuffer();
  const imgBuf2 = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 50, g: 50, b: 255 } } }).jpeg().toBuffer();
  const imgBuf3 = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 50, g: 255, b: 50 } } }).jpeg().toBuffer();
  const imgBuf4 = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 50 } } }).jpeg().toBuffer();

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const sUrl = String(url);
    if (sUrl.includes('album1_1')) return new Response(imgBuf1, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (sUrl.includes('album1_2')) return new Response(imgBuf2, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (sUrl.includes('album2_1')) return new Response(imgBuf3, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (sUrl.includes('album2_2')) return new Response(imgBuf4, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response(Buffer.alloc(0), { status: 404 });
  };

  let sentRichMessages = [];
  let editedRichMessages = [];
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      const msg = { message_id: 800 + sentRichMessages.length };
      sentRichMessages.push({ rich, files });
      return msg;
    },
    editMessageRich: async (chatId, messageId, rich, extra, files) => {
      editedRichMessages.push({ messageId, rich, files });
      return { message_id: messageId };
    },
    sendChatAction: async () => {},
    answerCallbackQuery: async () => {}
  };

  const mockProvider = {
    search: async ({ query }) => {
      return {
        items: [
          // Album 1 (2 slides)
          {
            pinId: 'pin_album_1',
            isAlbum: true,
            albumImages: ['https://example.com/album1_1.jpg', 'https://example.com/album1_2.jpg'],
            albumCount: 2
          },
          // Album 2 (2 slides)
          {
            pinId: 'pin_album_2',
            isAlbum: true,
            albumImages: ['https://example.com/album2_1.jpg', 'https://example.com/album2_2.jpg'],
            albumCount: 2
          },
          // Single pin (should be ignored because it is not an album)
          {
            pinId: 'pin_single_bad',
            isAlbum: false,
            mediaUrl: 'https://example.com/single.jpg'
          }
        ],
        bookmark: null
      };
    }
  };

  const app = {
    db,
    settings,
    telegram: { api: mockApi },
    pinterest: { provider: mockProvider }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStates(sm);

  const ctx = {
    tgId: 4001,
    chatId: 4001,
    api: mockApi,
    db,
    settings,
    sm,
    user: { first_name: 'Test' }
  };

  try {
    // 1. Initial deep search delivers Album 1 (2 matching avatars from same pin)
    await downloader.executePfpSearch(ctx, 'Tanjiro Nezuko');
    const delivery1 = editedRichMessages[editedRichMessages.length - 1] || sentRichMessages[sentRichMessages.length - 1];
    assert.ok(delivery1, 'should have delivered album 1 card');
    const text1 = JSON.stringify(delivery1.rich);
    assert.ok(text1.includes('MATCHING PFP') || text1.includes('𝑴𝑨𝑻𝑪𝑯𝑰𝑵𝑮 𝑷𝑭𝑷'));
    assert.ok(text1.includes('Next Set (2/2) →'));

    // Extract sessionKey from callback_data
    let sessionKey = null;
    for (const blk of delivery1.rich.blocks || []) {
      if (blk.type === 'buttons') {
        for (const btn of blk.buttons || []) {
          if (btn.callback_data?.includes(':pfp_nav:')) {
            sessionKey = btn.callback_data.split(':pfp_nav:')[1].split(':')[0];
          }
        }
      }
    }
    assert.ok(sessionKey, 'should have extracted sessionKey');

    // 2. Next set callback delivers Album 2
    await downloader.handle(ctx, 'pfp_nav', [sessionKey, '1']);
    const delivery2 = editedRichMessages[editedRichMessages.length - 1] || sentRichMessages[sentRichMessages.length - 1];
    assert.ok(delivery2, 'should have delivered album 2 card');
    const text2 = JSON.stringify(delivery2.rich);
    assert.ok(text2.includes('Prev Set (1/2)'));
  } finally {
    globalThis.fetch = origFetch;
    db.close();
  }
});

test('Matching PFP preserves complete albums without dropping slides (10 requested with 4+5+6 albums yields 15 total, 10 - 5extra)', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const origFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    const imgBuf = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 120, g: 150, b: 180 } }
    }).jpeg().toBuffer();
    return new Response(imgBuf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };

  const sentRichMessages = [];
  const editedRichMessages = [];
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      const msg = { message_id: 2001, rich, extra, files };
      sentRichMessages.push(msg);
      return msg;
    },
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      const msg = { message_id: msgId, rich, extra, files };
      editedRichMessages.push(msg);
      return msg;
    },
    sendChatAction: async () => {},
    answerCallbackQuery: async () => {}
  };

  // Mock Pinterest Provider with 3 candidate albums:
  // Album 1 has 4 photos
  // Album 2 has 5 photos
  // Album 3 has 6 photos
  // Total across all 3 = 15 photos!
  const mockProvider = {
    search: async () => ({
      items: [
        {
          pinId: 'pin_album_4',
          isAlbum: true,
          albumImages: [
            'https://example.com/alb1_1.jpg',
            'https://example.com/alb1_2.jpg',
            'https://example.com/alb1_3.jpg',
            'https://example.com/alb1_4.jpg'
          ],
          albumCount: 4
        },
        {
          pinId: 'pin_album_5',
          isAlbum: true,
          albumImages: [
            'https://example.com/alb2_1.jpg',
            'https://example.com/alb2_2.jpg',
            'https://example.com/alb2_3.jpg',
            'https://example.com/alb2_4.jpg',
            'https://example.com/alb2_5.jpg'
          ],
          albumCount: 5
        },
        {
          pinId: 'pin_album_6',
          isAlbum: true,
          albumImages: [
            'https://example.com/alb3_1.jpg',
            'https://example.com/alb3_2.jpg',
            'https://example.com/alb3_3.jpg',
            'https://example.com/alb3_4.jpg',
            'https://example.com/alb3_5.jpg',
            'https://example.com/alb3_6.jpg'
          ],
          albumCount: 6
        }
      ],
      bookmark: null
    })
  };

  const app = {
    db,
    settings,
    telegram: { api: mockApi },
    pinterest: { provider: mockProvider }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStates(sm);

  const ctx = {
    tgId: 4002,
    chatId: 4002,
    api: mockApi,
    db,
    settings,
    sm,
    user: { first_name: 'TestUser' }
  };

  try {
    // User requests "10 pit" (10 matching pictures)
    await downloader.executePfpSearch(ctx, 'Tanjiro Nezuko 10 pit');

    const delivery = editedRichMessages[editedRichMessages.length - 1] || sentRichMessages[sentRichMessages.length - 1];
    assert.ok(delivery, 'should have delivered matching pfp message');
    const text = JSON.stringify(delivery.rich);

    // Verify all 15 pictures from the 3 albums were downloaded (none were dropped!)
    assert.ok(text.includes('10 - 5extra'), `Expected '10 - 5extra' in delivery, got: ${text}`);
    assert.ok(text.includes('15') || text.includes('05 FULL ALBUM'), 'Expected 15 total items or extra count');

    // Verify files map contains 2 slideshow items for couple 1 (partner 1 & partner 2 duo)
    assert.ok(delivery.files, 'files should be attached');
    assert.ok(delivery.files.photo_0, 'photo_0 should exist');
    assert.ok(delivery.files.photo_1, 'photo_1 should exist');

    // Verify couple pagination button for next couple exists
    assert.ok(text.includes('Next Couple') || text.includes('Next Couple (2/'), `Expected Next Couple button, got: ${text}`);
  } finally {
    globalThis.fetch = origFetch;
    db.close();
  }
});

test('Pinterest DeepSearchPipeline preserves full carousel slides beyond goal and records extraCount', async () => {
  const { DeepSearchPipeline } = await import('../src/pinterest/search.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  // Setup minimal pinterest schema
  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      normalized_query TEXT,
      mode TEXT DEFAULT 'normal',
      depth TEXT DEFAULT 'deep',
      result_count INTEGER DEFAULT 0,
      duplicates_found INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      pin_id TEXT,
      source_url TEXT,
      media_url TEXT NOT NULL,
      type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration REAL,
      size INTEGER,
      mime TEXT,
      sha256 TEXT,
      phash TEXT,
      quality_score REAL DEFAULT 0,
      is_duplicate INTEGER DEFAULT 0,
      status TEXT DEFAULT 'valid'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_media_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sha256 TEXT,
      phash TEXT,
      pin_id TEXT,
      media_url TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS media_hashes (
      sha256 TEXT PRIMARY KEY,
      hits INTEGER DEFAULT 1,
      last_seen TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const mockProvider = {
    search: async () => ({
      items: [
        {
          pinId: 'cand_1',
          isAlbum: true,
          type: 'image',
          mediaUrl: 'https://example.com/p1_1.jpg',
          albumImages: [
            'https://example.com/p1_1.jpg',
            'https://example.com/p1_2.jpg',
            'https://example.com/p1_3.jpg',
            'https://example.com/p1_4.jpg'
          ],
          albumCount: 4
        },
        {
          pinId: 'cand_2',
          isAlbum: true,
          type: 'image',
          mediaUrl: 'https://example.com/p2_1.jpg',
          albumImages: [
            'https://example.com/p2_1.jpg',
            'https://example.com/p2_2.jpg',
            'https://example.com/p2_3.jpg',
            'https://example.com/p2_4.jpg',
            'https://example.com/p2_5.jpg'
          ],
          albumCount: 5
        },
        {
          pinId: 'cand_3',
          isAlbum: true,
          type: 'image',
          mediaUrl: 'https://example.com/p3_1.jpg',
          albumImages: [
            'https://example.com/p3_1.jpg',
            'https://example.com/p3_2.jpg',
            'https://example.com/p3_3.jpg',
            'https://example.com/p3_4.jpg',
            'https://example.com/p3_5.jpg',
            'https://example.com/p3_6.jpg'
          ],
          albumCount: 6
        }
      ],
      bookmark: null
    })
  };

  let mockCount = 0;
  const mockMedia = {
    process: async (cand) => {
      mockCount++;
      return {
        ...cand,
        sha256: `sha_${cand.mediaUrl}`,
        phash: `phash_${mockCount}`,
        mime: 'image/jpeg',
        type: 'image',
        width: 800,
        height: 800,
        size: 50000,
        duplicate: false
      };
    },
    dedup: {
      check: () => ({ duplicate: false }),
      registerCandidate: () => {}
    }
  };

  const pipeline = new DeepSearchPipeline({
    provider: mockProvider,
    media: mockMedia,
    db,
    settings
  });

  const res = await pipeline.search({
    userId: 9001,
    query: 'anime matching',
    goal: 10
  });

  assert.equal(res.requestedGoal, 10);
  // 4 + 5 + 6 = 15 total, no slides from album 3 were dropped!
  assert.equal(res.results.length, 15);
  assert.equal(res.stats.extraCount, 5);
  assert.equal(res.stats.valid, 15);

  db.close();
});

test('Matching Studio menu from A to Z edits same message in-place and scroll contains up to 10 photos', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const sentMessages = [];
  const editedMessages = [];

  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      const msg = { message_id: 800 + sentMessages.length, rich, files };
      sentMessages.push(msg);
      return msg;
    },
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      const msg = { message_id: msgId, rich, files };
      editedMessages.push(msg);
      return msg;
    },
    answerCallbackQuery: async () => ({ ok: true })
  };

  const app = {
    db,
    settings,
    telegram: { api: mockApi, controller: null }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStateHandlers(sm);

  const ctx = {
    chatId: 99999,
    tgId: '99999',
    api: mockApi,
    query: { id: 'cb1', message: { message_id: 555 } },
    messageId: 555,
    screenMessageId: 555,
    db,
    settings,
    sm,
    editScreen: async (rich, extra = {}, files = null) => {
      return mockApi.editMessageRich(99999, 555, rich, extra, files);
    }
  };

  // 1. Enter Matching Studio menu: must edit in-place
  await downloader.handle(ctx, 'pfp_menu', []);
  assert.equal(editedMessages.length, 1);
  assert.equal(editedMessages[0].message_id, 555);

  // 2. Select amount picker: must edit in-place
  await downloader.handle(ctx, 'pfp_ask_count', ['naruto sasuke']);
  assert.equal(editedMessages.length, 2);
  assert.equal(editedMessages[1].message_id, 555);

  // 3. Pick 10 count preset: must edit in-place
  await downloader.handle(ctx, 'pfp_count', ['10']);
  assert.equal(editedMessages.length, 3);
  assert.equal(editedMessages[2].message_id, 555);

  // 4. Custom count prompt: must edit in-place
  await downloader.handle(ctx, 'pfp_custom_count_ask', ['anime']);
  assert.equal(editedMessages.length, 4);
  assert.equal(editedMessages[3].message_id, 555);

  // 5. Custom topic prompt: must edit in-place
  await downloader.handle(ctx, 'pfp_custom', []);
  assert.equal(editedMessages.length, 5);
  assert.equal(editedMessages[4].message_id, 555);

  // 6. Return back to menu: must edit in-place
  await downloader.handle(ctx, 'pfp_menu', []);
  assert.equal(editedMessages.length, 6);
  assert.equal(editedMessages[5].message_id, 555);

  // No separate messages should have been sent during menu navigation
  assert.equal(sentMessages.length, 0, 'No extra messages sent during Matching menu from A to Z');

  // 7. Verify slideshow contains 10 photos in scroll
  const albumKey = 'test_pfp_scroll_10';
  const tenPhotos = Array.from({ length: 10 }, (_, i) => ({
    type: 'photo',
    buffer: Buffer.from(`img_${i + 1}`),
    filename: `pfp_${i + 1}.jpg`
  }));

  downloader.saveAlbum(albumKey, {
    mediaItems: tenPhotos,
    platform: 'pinterest',
    title: 'Gojo Geto Matching',
    isMatchingPfp: true
  });

  await downloader.handle(ctx, 'moreSlide', [albumKey, '0']);
  assert.equal(editedMessages.length, 7);
  const delivery = editedMessages[6];
  assert.ok(delivery.files, 'Files must be attached');
  for (let i = 0; i < 10; i++) {
    assert.ok(delivery.files[`photo_${i}`], `photo_${i} must be in the slideshow scroll`);
  }

  db.close();
});

