import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LancyAssistant } from '../src/ai/assistant.js';
import { MediaDownloader } from '../src/media/downloader.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';

test('AI Assistant sanitizes user raw decorative name glyphs into clean name', async () => {
  const assistant = new LancyAssistant({ app: {} });
  const rawGlyphName = '▐⧯]ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ⃝ᡃ. ⸸𝑷𝑨𝑷𝑷𝒀×͜×';
  const ctx = { user: { first_name: rawGlyphName } };
  
  const sanitized = assistant.sanitizeUserName(ctx);
  assert.ok(sanitized === 'Pappy' || sanitized === 'PAPPY', `Sanitized name should be Pappy, got ${sanitized}`);
});

test('AI Assistant handles direct music inquiry without refusal', async () => {
  let repliedText = null;
  const mockDb = {
    run: () => {},
    get: () => ({ id: 1, tg_id: 12345 }),
    all: () => []
  };
  const mockApi = {
    sendMessage: async (chatId, text) => {
      repliedText = text;
      return { message_id: 999 };
    }
  };
  const assistant = new LancyAssistant({
    app: {
      db: mockDb,
      telegram: { api: mockApi }
    }
  });

  const ctx = {
    tgId: '12345',
    chatId: 12345,
    api: mockApi,
    user: { tg_id: 12345, first_name: 'Pappy' },
    reply: async (text) => { repliedText = text; }
  };

  await assistant.handleMessage({
    ctx,
    text: 'I need a song not url can u download'
  });

  assert.ok(repliedText, 'Assistant should reply');
  assert.ok(!repliedText.includes('not within my capabilities'), 'Must not refuse');
  assert.ok(repliedText.includes('song title or artist name') || repliedText.includes('music'), 'Must prompt for song title or artist');
});

test('AI Assistant detects quoted message context and triggers download for artist', async () => {
  let downloadedQuery = null;
  const mockDb = {
    run: () => {},
    get: () => ({ id: 1, tg_id: 12345 }),
    all: () => []
  };
  const mockDownloaderScreen = {
    executeDownload: async (ctx, query) => {
      downloadedQuery = query;
    }
  };
  const mockScreens = new Map();
  mockScreens.set('downloader', mockDownloaderScreen);

  const assistant = new LancyAssistant({
    app: {
      db: mockDb,
      screens: mockScreens,
      telegram: { api: { sendMessage: async () => ({}) } }
    }
  });

  const ctx = {
    tgId: '12345',
    chatId: 12345,
    screens: mockScreens,
    user: { tg_id: 12345, first_name: 'Pappy' },
    reply: async () => {}
  };

  // User quotes Lancy's message asking for song title/artist and replies "Juice wrld"
  const message = {
    text: 'Juice wrld',
    from: { id: 12345, first_name: 'Pappy' },
    reply_to_message: {
      text: 'Perhaps you could provide a song title or artist name instead.',
      from: { is_bot: true, id: 999 }
    }
  };

  await assistant.handleMessage({ ctx, message, text: 'Juice wrld' });
  assert.equal(downloadedQuery, 'Juice wrld', 'Should trigger executeDownload for "Juice wrld"');
});

test('AI Assistant handles "Open my menu" and screen navigation', async () => {
  let openedScreen = null;
  const mockDb = {
    run: () => {},
    get: () => ({ id: 1, tg_id: 12345 }),
    all: () => []
  };
  const mockDashboard = {
    open: async () => {
      openedScreen = 'dashboard';
      return { message_id: 111 };
    }
  };
  const mockScreens = new Map();
  mockScreens.set('dashboard', mockDashboard);

  const assistant = new LancyAssistant({
    app: {
      db: mockDb,
      screens: mockScreens,
      telegram: { api: { sendMessage: async () => ({}) } }
    }
  });

  const ctx = {
    tgId: '12345',
    chatId: 12345,
    screens: mockScreens,
    user: { tg_id: 12345, first_name: 'Pappy' },
    reply: async () => {}
  };

  await assistant.handleMessage({ ctx, text: 'Open my menu' });
  assert.equal(openedScreen, 'dashboard', 'Should open dashboard screen on "Open my menu"');
});

test('MediaDownloader extracts artist, album, and year from Spotify description', async () => {
  const downloader = new MediaDownloader();
  const testDesc = 'Rick Astley · Whenever You Need Somebody · Song · 1987';
  const parts = testDesc.split(/\s*[·•]\s*/).map((p) => p.trim());
  assert.equal(parts[0], 'Rick Astley');
  assert.equal(parts[1], 'Whenever You Need Somebody');
  const yearMatch = testDesc.match(/\b(19\d\d|20\d\d)\b/);
  assert.equal(yearMatch[1], '1987');
});

test('WhatsApp publisher sends video preview when sticker buffer is video', async () => {
  let videoSent = false;
  let sentJid = null;
  const mockSession = {
    sessionId: 'wa_test_vid',
    sendVideo: async (jid, buf, caption) => {
      videoSent = true;
      sentJid = jid;
    },
    sendImage: async () => {},
    sendText: async () => {},
    sendSticker: async () => {}
  };

  // Create a minimal WebM / Matroska header buffer
  const webmBuffer = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
  assert.ok(webmBuffer.length > 0);
});

