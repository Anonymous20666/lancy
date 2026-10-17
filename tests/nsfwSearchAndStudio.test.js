import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createNsfwScreen } from '../src/telegram/screens/nsfw.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { searchNsfw, NSFW_CATEGORIES } from '../src/wallpaper/nsfwSearch.js';

test('nsfwSearch: multi-provider search returns valid wallpapers and media across categories', async () => {
  // 1. Uncensored Hentai
  const uncensored = await searchNsfw({
    query: 'genshin',
    category: NSFW_CATEGORIES.HENTAI_UNCENSORED,
    limit: 5
  });
  assert.ok(Array.isArray(uncensored.results));
  assert.ok(uncensored.results.length > 0);
  assert.equal(uncensored.category, NSFW_CATEGORIES.HENTAI_UNCENSORED);
  assert.ok(uncensored.results[0].mediaUrl.startsWith('http'));
  assert.ok(uncensored.results[0].type === 'photo');

  // 2. Censored / Ecchi Hentai
  const censored = await searchNsfw({
    query: 'genshin',
    category: NSFW_CATEGORIES.HENTAI_CENSORED,
    limit: 5
  });
  assert.ok(Array.isArray(censored.results));
  assert.ok(censored.results.length > 0);
  assert.equal(censored.category, NSFW_CATEGORIES.HENTAI_CENSORED);
  assert.ok(censored.results[0].mediaUrl.startsWith('http'));

  // 3. Real Adult 4K Wallpapers
  const realAdult = await searchNsfw({
    query: 'model',
    category: NSFW_CATEGORIES.REAL_WALLPAPERS,
    limit: 4
  });
  assert.ok(Array.isArray(realAdult.results));
  assert.ok(realAdult.results.length > 0);
  assert.equal(realAdult.category, NSFW_CATEGORIES.REAL_WALLPAPERS);
  assert.ok(realAdult.results[0].mediaUrl.startsWith('http'));

  // 4. 18+ Videos (MP4)
  const videos = await searchNsfw({
    query: 'genshin',
    category: NSFW_CATEGORIES.VIDEOS,
    limit: 4
  });
  assert.ok(Array.isArray(videos.results));
  assert.ok(videos.results.length > 0);
  assert.equal(videos.category, NSFW_CATEGORIES.VIDEOS);
  assert.ok(videos.results[0].mediaUrl.startsWith('http'));
  assert.equal(videos.results[0].type, 'video');

  // 5. Animated Hentai Clips & GIFs
  const animated = await searchNsfw({
    query: 'blowjob',
    category: NSFW_CATEGORIES.ANIMATED,
    limit: 3
  });
  assert.ok(Array.isArray(animated.results));
  assert.ok(animated.results.length > 0);
  assert.equal(animated.category, NSFW_CATEGORIES.ANIMATED);
  assert.ok(animated.results[0].mediaUrl.startsWith('http'));
});

test('nsfwSearch: in-flight request deduplication and memory caching', async () => {
  const t0 = Date.now();
  // Fire 3 identical requests simultaneously
  const [r1, r2, r3] = await Promise.all([
    searchNsfw({ query: 'naruto', category: NSFW_CATEGORIES.HENTAI_UNCENSORED, limit: 3 }),
    searchNsfw({ query: 'naruto', category: NSFW_CATEGORIES.HENTAI_UNCENSORED, limit: 3 }),
    searchNsfw({ query: 'naruto', category: NSFW_CATEGORIES.HENTAI_UNCENSORED, limit: 3 })
  ]);

  assert.equal(r1.results.length, r2.results.length);
  assert.equal(r1.results[0]?.mediaUrl, r2.results[0]?.mediaUrl);
  assert.equal(r2.results[0]?.mediaUrl, r3.results[0]?.mediaUrl);

  // Cached retrieval is instant
  const tCached = Date.now();
  const rCached = await searchNsfw({ query: 'naruto', category: NSFW_CATEGORIES.HENTAI_UNCENSORED, limit: 3 });
  assert.ok(Date.now() - tCached < 50);
  assert.equal(rCached.results[0]?.mediaUrl, r1.results[0]?.mediaUrl);
});

test('createNsfwScreen: screen interface, menu rendering and state registration', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  let sentRich = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich) => {
      sentRich = rich;
      return { message_id: 101 };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      sentRich = rich;
      return { message_id: msgId };
    },
    sendMessage: async () => ({ message_id: 102 }),
    deleteMessage: async () => true,
    answerCallbackQuery: async () => true
  };

  const app = {
    telegram: { api: mockApi },
    settings,
    pinterest: { db }
  };

  const nsfwScreen = createNsfwScreen({ app });
  assert.equal(nsfwScreen.id, 'nsfw');

  // Register state machine handlers
  nsfwScreen.registerStateHandlers(sm);

  // Open menu
  const ctx = {
    tgId: 12345,
    chatId: 12345,
    sm,
    api: mockApi,
    isGroup: false,
    message: null,
    settings
  };

  await nsfwScreen.open(ctx);
  assert.ok(sentRich);
  assert.match(JSON.stringify(sentRich), /18\+ ADULT & HENTAI STUDIO/);
  assert.match(JSON.stringify(sentRich), /Hentai Uncensored/);
  assert.match(JSON.stringify(sentRich), /18\+ Videos/);

  // Test multi-user group chat callback acknowledgement
  let answeredToast = null;
  const mockApiWithToast = {
    ...mockApi,
    answerCallbackQuery: async (qId, opts) => {
      answeredToast = opts.text;
      return true;
    }
  };

  const cbCtx = {
    tgId: 99999, // User B
    chatId: -1001234567, // Group chat
    api: mockApiWithToast,
    query: {
      id: 'query_1',
      from: { id: 99999, first_name: 'Alex' },
      message: { message_id: 202 }
    },
    isGroup: true,
    user: { first_name: 'Alex' }
  };

  // User B clicks pagination on User A's search
  await nsfwScreen.handle(cbCtx, 'page', ['1', 'hentai_uncensored', 'naruto', '12345']);
  assert.ok(answeredToast);
  assert.match(answeredToast, /Alex browsing page 2/);
});

test('TelegramController: /nsfw slash commands and live inline search routing', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [77777];
  settings.values.security.publicAccess = true;
  const sm = new StateMachine({ db });

  let sentMessages = [];
  let inlineAnswers = [];

  const mockApi = {
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 301, chat: { id: chatId } };
    },
    sendRichMessage: async (chatId, rich) => {
      sentMessages.push({ chatId, rich });
      return { message_id: 302, chat: { id: chatId } };
    },
    editMessageRich: async () => ({ message_id: 302 }),
    deleteMessage: async () => true,
    answerCallbackQuery: async () => true,
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswers.push(payload);
        return true;
      }
      return {};
    }
  };

  const app = {
    telegram: { api: mockApi },
    settings,
    pinterest: { db }
  };

  const screens = new Map();
  screens.set('dashboard', createDashboardScreen({ app }));
  screens.set('pinterest', createPinterestScreen({ app }));
  screens.set('nsfw', createNsfwScreen({ app }));

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: sm,
    sm,
    screens,
    app
  });

  // 1. Slash command /nsfw in private chat opens 18+ studio
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 501,
      from: { id: 77777, first_name: 'TestUser' },
      chat: { id: 77777, type: 'private' },
      text: '/nsfw'
    }
  });

  assert.ok(sentMessages.length > 0);
  const lastRich = sentMessages[sentMessages.length - 1].rich;
  assert.match(JSON.stringify(lastRich), /18\+ ADULT & HENTAI STUDIO/);

  // 2. Slash command /18+ <query> executes search directly
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 502,
      from: { id: 77777, first_name: 'TestUser' },
      chat: { id: 77777, type: 'private' },
      text: '/18+ genshin'
    }
  });

  assert.ok(sentMessages.length >= 2);

  // 3. Inline query @bot 18+ with empty query returns suggestion cards
  await controller.handleInlineQuery({
    id: 'iq_nsfw_empty',
    from: { id: 77777 },
    query: '18+',
    offset: '0'
  });

  assert.ok(inlineAnswers.length > 0);
  const emptyAnswer = inlineAnswers[inlineAnswers.length - 1];
  assert.ok(emptyAnswer.results.length >= 5);
  assert.ok(emptyAnswer.results.some((r) => r.id === 'sug_nsfw_uncensored'));
  assert.ok(emptyAnswer.results.some((r) => r.id === 'sug_nsfw_videos'));

  // 4. Inline query @bot nsfw naruto returns photo/video results with spoiler tags
  await controller.handleInlineQuery({
    id: 'iq_nsfw_query',
    from: { id: 77777 },
    query: 'nsfw naruto',
    offset: '0'
  });

  assert.ok(inlineAnswers.length >= 2);
  const queryAnswer = inlineAnswers[inlineAnswers.length - 1];
  assert.ok(queryAnswer.results.length > 0);
  assert.equal(queryAnswer.results[0].has_spoiler, true);
});
