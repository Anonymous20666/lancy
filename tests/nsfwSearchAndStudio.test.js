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
import { encodeCallback } from '../src/telegram/rich.js';

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
  assert.match(JSON.stringify(sentRich), /Hentai Wallpapers/);
  assert.match(JSON.stringify(sentRich), /Adult Wallpapers/);

  // Test opening Hentai Wallpapers submenu
  await nsfwScreen.handle(ctx, 'sub', ['hentai_wallpapers']);
  assert.match(JSON.stringify(sentRich), /HENTAI WALLPAPERS/);
  assert.match(JSON.stringify(sentRich), /Censored \/ Ecchi/);
  assert.match(JSON.stringify(sentRich), /Uncensored/);

  // Test opening Real Adult Wallpapers submenu (no censored option)
  await nsfwScreen.handle(ctx, 'sub', ['real_wallpapers']);
  assert.match(JSON.stringify(sentRich), /REAL ADULT 4K WALLPAPERS/);
  assert.ok(!JSON.stringify(sentRich).includes('Censored'));

  // Test opening Real Adult Videos submenu (clips + full)
  await nsfwScreen.handle(ctx, 'sub', ['real_videos']);
  assert.match(JSON.stringify(sentRich), /REAL ADULT VIDEOS/);
  assert.match(JSON.stringify(sentRich), /Video Clips & Previews/);
  assert.match(JSON.stringify(sentRich), /Full Adult Videos/);

  // Test askCount selection screen
  await nsfwScreen.handle(ctx, 'askCountDirect', ['tifa', 'hentai_uncensored']);
  assert.match(JSON.stringify(sentRich), /18\+ RESULT COUNT/);
  assert.match(JSON.stringify(sentRich), /Continuous Exploration/);

  // Test multi-user group chat callback acknowledgement on album pagination
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

  // User B clicks pagination on search album
  await nsfwScreen.handle(cbCtx, 'moreAlbum', ['12345', '10', 'hentai_uncensored']);
  assert.ok(answeredToast);
  assert.match(answeredToast, /Alex browsing picks 11–20/);
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

test('nsfwSearch: real adult category separation and preview rendering', async () => {
  // Test real adult search with anime query does not label result as anime
  const realRes = await searchNsfw({
    query: 'chainsaw_man',
    category: NSFW_CATEGORIES.REAL_WALLPAPERS,
    limit: 3
  });
  assert.ok(realRes.results.length > 0);
  assert.equal(realRes.category, NSFW_CATEGORIES.REAL_WALLPAPERS);
  // Verify title is clean and not falsely claiming Nekobot model is chainsaw man
  assert.ok(!realRes.results[0].title.includes('chainsaw_man'));
  assert.equal(realRes.results[0].title, 'Real 18+ 4K Adult Wallpaper');
});

test('18+ Studio E2E Parity with Pinterest: in-place edits, message deletions, and clean replacement on pagination failure', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'normal',
      depth TEXT NOT NULL DEFAULT 'deep',
      result_count INTEGER NOT NULL DEFAULT 0,
      duplicates_found INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      pin_id TEXT,
      media_url TEXT NOT NULL,
      sha256 TEXT,
      type TEXT NOT NULL DEFAULT 'photo',
      mime TEXT,
      quality_score REAL NOT NULL DEFAULT 1.0,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'valid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  let deletedMessages = [];
  let sentRichMessages = [];
  let editedRichMessages = [];
  let markedMediaDeliveryIds = [];
  let nextMsgId = 1000;

  const mockApi = {
    sendRichMessage: async (chatId, rich, opts, files) => {
      const msgId = ++nextMsgId;
      sentRichMessages.push({ chatId, msgId, rich, opts, files });
      return { message_id: msgId, chat: { id: chatId } };
    },
    editMessageRich: async (chatId, msgId, rich, opts, files) => {
      editedRichMessages.push({ chatId, msgId, rich, opts, files });
      return { message_id: msgId, chat: { id: chatId } };
    },
    deleteMessage: async (chatId, messageId) => {
      deletedMessages.push({ chatId, messageId });
      return true;
    },
    sendMessage: async (chatId, text) => ({ message_id: ++nextMsgId, chat: { id: chatId } }),
    answerCallbackQuery: async () => true
  };

  const app = {
    telegram: {
      api: mockApi,
      markMediaDeliveryMessage: (id) => markedMediaDeliveryIds.push(id),
      userScreenMessage: new Map()
    },
    settings,
    pinterest: { db }
  };

  const nsfwScreen = createNsfwScreen({ app });
  nsfwScreen.registerStateHandlers(sm);

  // 1. Private DM flow: User enters query -> user input message is deleted, existing screen message is edited to count card
  const dmUserId = 55555;
  await sm.transition(dmUserId, States.NSFW_SEARCH_INPUT, {
    context: { category: 'hentai_uncensored', stage: 'query', screenMessageId: 700 },
    chatId: dmUserId,
    screenMessageId: 700
  });

  const dmCtx = sm.ctxFor(dmUserId);
  dmCtx.api = mockApi;
  const dmMsg = {
    message_id: 801,
    chat: { id: dmUserId, type: 'private' },
    from: { id: dmUserId },
    text: 'tifa'
  };

  deletedMessages = [];
  editedRichMessages = [];
  const handledDm = await sm.handleMessage(dmUserId, dmMsg, { api: mockApi });
  assert.equal(handledDm, true);
  // User input message 801 was deleted
  assert.equal(deletedMessages.some(d => d.messageId === 801), true);
  // Screen message 700 was edited in-place to the count card
  assert.equal(editedRichMessages.some(e => e.msgId === 700), true);

  // 2. Group Chat flow: User replies to prompt in group -> bot deletes outdated prompt, quotes user message
  const gcChatId = -100999999;
  const gcUserId = 66666;
  await sm.transition(gcUserId, States.NSFW_SEARCH_INPUT, {
    context: { category: 'real_wallpapers', stage: 'query', screenMessageId: 750 },
    chatId: gcChatId,
    screenMessageId: 750
  });

  const gcCtx = sm.ctxFor(gcUserId);
  gcCtx.api = mockApi;
  const gcMsg = {
    message_id: 802,
    chat: { id: gcChatId, type: 'supergroup' },
    from: { id: gcUserId },
    reply_to_message: { message_id: 750 },
    text: 'asian model'
  };

  deletedMessages = [];
  sentRichMessages = [];
  const handledGc = await sm.handleMessage(gcUserId, gcMsg, { api: mockApi });
  assert.equal(handledGc, true);
  // Old bot prompt 750 was deleted from GC
  assert.equal(deletedMessages.some(d => d.messageId === 750), true);
  // Sent count card quotes user message 802
  assert.equal(sentRichMessages.some(s => s.opts?.reply_parameters?.message_id === 802 || s.opts?.reply_to_message_id === 802), true);

  // 3. Album Pagination with Clean Replacement:
  // Setup 25 media items for search 100
  db.run(`INSERT INTO pinterest_searches (id, user_id, query, normalized_query, mode, result_count) VALUES (100, ${dmUserId}, 'tifa', 'tifa', 'nsfw', 25)`);
  for (let i = 1; i <= 25; i++) {
    db.run(
      `INSERT INTO pinterest_media (search_id, user_id, media_url, sha256, type, quality_score, is_duplicate, status)
       VALUES (100, ${dmUserId}, 'https://example.com/tifa_${i}.jpg', 'sha_${i}', 'photo', ${100 - i}, 0, 'valid')`
    );
  }

  // 3a. In-place edit succeeds when API accepts it
  editedRichMessages = [];
  await nsfwScreen.handle({
    tgId: dmUserId,
    chatId: dmUserId,
    messageId: 900,
    api: mockApi,
    sm
  }, 'moreAlbum', ['100', '10', 'hentai_uncensored']);
  assert.equal(editedRichMessages.some(e => e.msgId === 900), true);

  // 3b. When Telegram Bot API rejects editing media attachments in-place:
  // Clean replacement sends the new card AND deletes old message 900 so only 1 card exists!
  mockApi.editMessageRich = async () => {
    throw new Error('Telegram editMessageText: Bad Request: message can\'t be edited');
  };

  deletedMessages = [];
  sentRichMessages = [];
  await nsfwScreen.handle({
    tgId: dmUserId,
    chatId: dmUserId,
    messageId: 900,
    api: mockApi,
    sm
  }, 'moreAlbum', ['100', '20', 'hentai_uncensored']);

  assert.equal(sentRichMessages.length, 1, 'Replacement card was sent');
  assert.equal(deletedMessages.some(d => d.messageId === 900), true, 'Old card 900 was deleted to prevent duplicates');
  assert.ok(markedMediaDeliveryIds.includes(sentRichMessages[0].msgId), 'New card is marked as media delivery');
});

test('18+ Studio E2E Parity with Pinterest: navigating back to menu from delivered media search never overwrites media card', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [12345];
  settings.values.security.publicAccess = true;
  settings.set('general.ownerIds', [12345]);
  const sm = new StateMachine({ db });

  let sentMessages = [];
  let editedMessages = [];
  let nextMsgId = 2000;

  const mockApi = {
    sendRichMessage: async (chatId, rich, opts, files) => {
      const msgId = ++nextMsgId;
      sentMessages.push({ chatId, msgId, rich, opts, files });
      return { message_id: msgId, chat: { id: chatId } };
    },
    editMessageRich: async (chatId, messageId, rich, opts, files) => {
      editedMessages.push({ chatId, messageId, rich, opts, files });
      return { message_id: messageId, chat: { id: chatId } };
    },
    deleteMessage: async () => true,
    answerCallbackQuery: async () => true,
    call: async () => ({})
  };

  const app = {
    telegram: { api: mockApi },
    settings,
    pinterest: { db }
  };

  const screens = new Map();
  screens.set('dashboard', createDashboardScreen({ app }));
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

  // Simulate delivered media card at message 2050
  controller.markMediaDeliveryMessage(2050);

  // User clicks "🔞 18+ Studio Menu" from the media card (has from_media)
  await controller.handleUpdate({
    update_id: 10,
    callback_query: {
      id: 'cb_menu_from_media',
      from: { id: 12345, first_name: 'TestUser' },
      message: { message_id: 2050, chat: { id: 12345, type: 'private' } },
      data: encodeCallback('nsfw', 'menu', 'from_media')
    }
  });

  // Verify that message 2050 was NOT edited or overwritten!
  assert.equal(editedMessages.some(e => e.messageId === 2050), false, 'Media message 2050 MUST NOT be edited into a menu');
  // Verify a fresh menu message was sent instead, preserving the media card above
  assert.equal(sentMessages.length, 1, 'A fresh screen message was sent');
  assert.match(JSON.stringify(sentMessages[0].rich), /18\+ ADULT & HENTAI STUDIO/);
});

