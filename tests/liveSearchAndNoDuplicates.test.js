import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { DeepSearchPipeline } from '../src/pinterest/search.js';
import { FixtureProvider } from '../src/pinterest/fixtures.js';
import { TelegramController, inlinePinterestCache, inlineMusicCache } from '../src/telegram/bot.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { StateMachine, States } from '../src/core/stateMachine.js';

let server;
let baseUrl;
let tmp;
const imageCache = new Map();

async function makeImage(i, { w = 800, h = 800 } = {}) {
  const key = `${i}-${w}x${h}`;
  if (!imageCache.has(key)) {
    const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="hsl(${(i * 47) % 360},70%,60%)"/><circle cx="${(i * 73) % w}" cy="${(i * 101) % h}" r="${50 + (i % 50)}" fill="hsl(${(i * 91) % 360},80%,70%)"/><text x="20" y="50" font-size="40" fill="white">${i}</text></svg>`;
    imageCache.set(key, await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer());
  }
  return imageCache.get(key);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'lancy-live-test-'));
  server = createServer(async (req, res) => {
    const match = /\/media\/pin-(\d+)\.jpg/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404).end('nope');
      return;
    }
    const i = Number(match[1]);
    const img = await makeImage(i);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': img.length }).end(img);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makePins(n) {
  const pins = [];
  for (let i = 0; i < n; i++) {
    pins.push({
      pinId: `pin-${String(i).padStart(4, '0')}`,
      mediaUrl: `${baseUrl}/media/pin-${i}.jpg`,
      type: 'image',
      width: 800,
      height: 800,
      tags: ['test', 'anime', 'aesthetic anime']
    });
  }
  return pins;
}

test('DeepSearchPipeline: consecutive searches by same user never return duplicate pins and crawl deeper', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, {});
  const media = new MediaPipeline({ db, cacheDir: join(tmp, 'cache'), settings });
  const provider = new FixtureProvider({ pins: makePins(40), pageSize: 10 });
  const search = new DeepSearchPipeline({ provider, media, db, settings });

  const userId = 8888;
  const first = await search.search({ userId, query: 'aesthetic anime', mode: 'images', goal: 5 });
  assert.ok(first.results.length >= 5);

  const firstPinIds = new Set(first.results.map((r) => r.pinId));

  // Second search: same query and same user
  const second = await search.search({ userId, query: 'aesthetic anime', mode: 'images', goal: 5 });
  assert.ok(second.results.length >= 5);

  for (const r of second.results) {
    assert.equal(firstPinIds.has(r.pinId), false, `Pin ${r.pinId} should NOT repeat in second search`);
  }

  // History table contains delivered records
  const historyCount = db.get('SELECT COUNT(*) as c FROM user_media_history WHERE user_id = ?', userId)?.c;
  assert.ok(historyCount >= 10, 'All delivered results tracked in user_media_history');

  db.close();
});

test('Inline search: Pinterest search runs live without 3-minute stale cache and sets cache_time: 1 with is_personal: true', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, {});
  let answeredPayload = null;

  const mockApi = {
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        answeredPayload = payload;
      }
      return true;
    }
  };

  const app = {
    db,
    settings,
    pinterest: {
      provider: {
        search: async ({ query, bookmark }) => ({
          items: [
            { pinId: `live_pin_${Date.now()}_1`, mediaUrl: `${baseUrl}/media/pin-1.jpg`, type: 'image' },
            { pinId: `live_pin_${Date.now()}_2`, mediaUrl: `${baseUrl}/media/pin-2.jpg`, type: 'image' }
          ],
          bookmark: 'next_page'
        })
      }
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    settings,
    db,
    app,
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });

  await controller.handleInlineQuery({
    id: 'query_live_pint',
    from: { id: 7777, first_name: 'Test' },
    query: 'pint cyberpunk',
    offset: ''
  });

  assert.ok(answeredPayload, 'Inline query was answered');
  assert.equal(answeredPayload.cache_time, 1, 'Telegram cache_time must be 1 (live)');
  assert.equal(answeredPayload.is_personal, true, 'Telegram is_personal must be true (no shared caching)');
  assert.ok(answeredPayload.results.length > 0, 'Results returned');

  db.close();
});

test('Matching PFP studio: consecutive searches track delivered couples and prevent duplicates', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  let sentPayload = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      sentPayload = { rich, files };
      return { message_id: 201 };
    },
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      sentPayload = { rich, files };
      return { message_id: 201 };
    },
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    answerCallbackQuery: async () => {}
  };

  let searchCalls = 0;
  const mockPinterest = {
    provider: {
      search: async () => {
        searchCalls++;
        return {
          items: [
            {
              pinId: `couple_pin_${searchCalls}`,
              isAlbum: true,
              albumImages: [
                `${baseUrl}/media/pin-1.jpg`,
                `${baseUrl}/media/pin-2.jpg`
              ]
            },
            {
              pinId: `couple_pin_${searchCalls}_b`,
              isAlbum: true,
              albumImages: [
                `${baseUrl}/media/pin-3.jpg`,
                `${baseUrl}/media/pin-4.jpg`
              ]
            }
          ],
          bookmark: null
        };
      }
    }
  };

  const app = {
    db,
    settings,
    pinterest: mockPinterest,
    telegram: { api: mockApi }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStates(sm);

  const ctx = {
    tgId: '9999',
    chatId: 9999,
    api: mockApi,
    db,
    sm,
    user: { id: 9999 }
  };

  // First search
  await downloader.executePfpSearch(ctx, 'anime couple', { goal: 2 });
  assert.ok(sentPayload, 'Delivered first couple');

  // Verify delivered pin was recorded in user_media_history
  const history = db.all('SELECT * FROM user_media_history WHERE user_id = 9999');
  assert.ok(history.length >= 2, 'Delivered couple album images recorded in user_media_history');

  // Second search: should filter out first couple's pin and images
  await downloader.executePfpSearch(ctx, 'anime couple', { goal: 2 });
  const updatedHistory = db.all('SELECT * FROM user_media_history WHERE user_id = 9999');
  assert.ok(updatedHistory.length > history.length, 'New search delivered new couple and updated history');

  db.close();
});
