import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { MultiBotManager } from '../src/telegram/multiBotManager.js';
import { t, getLanguageName, SUPPORTED_LANGUAGES } from '../src/core/i18n.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';

test('i18n: translations, fallback and parameter substitution work across all languages', () => {
  // 1. All supported languages exist
  assert.ok(SUPPORTED_LANGUAGES.length >= 7);
  assert.ok(SUPPORTED_LANGUAGES.some((l) => l.code === 'en'));
  assert.ok(SUPPORTED_LANGUAGES.some((l) => l.code === 'es'));
  assert.ok(SUPPORTED_LANGUAGES.some((l) => l.code === 'fr'));

  // 2. Language names
  assert.match(getLanguageName('en'), /English/);
  assert.match(getLanguageName('es'), /Español/);
  assert.match(getLanguageName('fr'), /Français/);

  // 3. Parameter interpolation
  const enWelcome = t('en', 'welcome_title', { botName: 'Luna' });
  assert.match(enWelcome, /Luna/);

  const esWelcome = t('es', 'welcome_title', { botName: 'Luna' });
  assert.match(esWelcome, /BIENVENIDO A Luna/);

  const frWelcome = t('fr', 'welcome_title', { botName: 'Luna' });
  assert.match(frWelcome, /BIENVENUE SUR Luna/);

  const reqBy = t('en', 'group_requested_by', { user: 'Sophia' });
  assert.match(reqBy, /Sophia/);

  // 4. Fallback to English for missing language
  const fallback = t('xx', 'group_restricted_notice');
  assert.match(fallback, /\/play/);
});

test('MultiBotManager: token validation, registration, lifecycle, and audience tracking', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  const mgr = new MultiBotManager({ db, settings, app: {} });

  // 1. Token validation
  const inv1 = await mgr.validateToken('invalid_token');
  assert.equal(inv1.ok, false);

  const inv2 = await mgr.validateToken('12345:not-a-telegram-token');
  assert.equal(inv2.ok, false);

  // 2. Register bot in cloned_bots table
  const botId = db.run(
    `INSERT INTO cloned_bots (token, bot_name, bot_username, owner_tg_id, status)
     VALUES (?, ?, ?, ?, 'active')`,
    '123456789:ABCdefGHIjklMNOpqrsTUVwxyz12345678', 'AestheticBot', 'aesthetic_bot', 99999
  ).lastInsertRowid;

  assert.ok(botId > 0);
  const row = db.get('SELECT * FROM cloned_bots WHERE id = ?', botId);
  assert.equal(row.bot_name, 'AestheticBot');
  assert.equal(row.status, 'active');

  // 3. Audience tracking per bot in bot_users
  db.run(
    'INSERT INTO bot_users (bot_id, tg_id, username, first_name, language) VALUES (?, ?, ?, ?, ?)',
    botId, 1001, 'user1', 'Alice', 'en'
  );
  db.run(
    'INSERT INTO bot_users (bot_id, tg_id, username, first_name, language) VALUES (?, ?, ?, ?, ?)',
    botId, 1002, 'user2', 'Bob', 'es'
  );

  const count = db.get('SELECT COUNT(*) AS c FROM bot_users WHERE bot_id = ?', botId).c;
  assert.equal(count, 2);

  // 4. Pause and Delete lifecycle
  await mgr.pauseBot(botId);
  assert.equal(db.get('SELECT status FROM cloned_bots WHERE id = ?', botId).status, 'paused');

  const deleted = await mgr.deleteBot(botId, 99999);
  assert.equal(deleted, true);
  assert.equal(db.get('SELECT id FROM cloned_bots WHERE id = ?', botId), undefined);

  db.close();
});

test('Group Chat: dashboard hides WhatsApp and AI assistant, displays group branding', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  const dashboard = createDashboardScreen({ app: { db, settings } });

  // 1. Group context
  const groupCtx = {
    tgId: '12345',
    chatId: -100987654321,
    isGroup: true,
    chatType: 'supergroup',
    botName: 'LunaBot',
    user: { id: 12345, first_name: 'Charlie' },
    settings,
    db
  };

  const groupRendered = dashboard.render(groupCtx, {});
  const jsonStr = JSON.stringify(groupRendered);

  // Verify group branding and omission of WhatsApp & AI
  assert.match(jsonStr, /LUNABOT/);
  assert.match(jsonStr, /group media & music companion/);
  assert.doesNotMatch(jsonStr, /WhatsApp/);
  assert.doesNotMatch(jsonStr, /Aesthetic AI/);

  // 2. Private chat context
  const privateCtx = {
    tgId: '12345',
    chatId: 12345,
    isGroup: false,
    chatType: 'private',
    botName: 'Lancy',
    user: { id: 12345, first_name: 'Charlie' },
    settings,
    db
  };

  const privateRendered = dashboard.render(privateCtx, {});
  const privateJsonStr = JSON.stringify(privateRendered);

  assert.match(privateJsonStr, /Clone Bot/);
  assert.match(privateJsonStr, /Language/);

  db.close();
});

test('Group Chat: Downloader screen attributes requesting user on media cards', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  let deliveredRich = null;
  const fakeApi = {
    editMessageText: async () => ({ message_id: 200 }),
    sendRichMessage: async (chatId, rich) => {
      deliveredRich = rich;
      return { message_id: 201 };
    },
    sendMessage: async () => ({ message_id: 202 }),
    deleteMessage: async () => true
  };

  const fakeDownloader = {
    detectPlatform: () => 'tiktok',
    download: async () => ({
      platform: 'tiktok',
      media: [{ type: 'video', buffer: Buffer.from('fake_video'), filename: 'vid.mp4' }],
      title: 'Trending Sound',
      author: 'creator123'
    })
  };

  const downloader = createDownloaderScreen({
    app: {
      db,
      settings,
      mediaDownloader: fakeDownloader,
      telegram: { api: fakeApi }
    }
  });

  const ctx = {
    tgId: '12345',
    chatId: -100987654321,
    isGroup: true,
    chatType: 'supergroup',
    botName: 'LunaBot',
    user: { id: 12345, first_name: 'Sophia' },
    settings,
    db,
    api: fakeApi,
    sendRichMessage: fakeApi.sendRichMessage
  };

  await downloader.executeDownload(ctx, 'https://vm.tiktok.com/fake');

  assert.ok(deliveredRich);
  const jsonStr = JSON.stringify(deliveredRich);
  assert.match(jsonStr, /Requested By/);
  assert.match(jsonStr, /Sophia/);
  assert.match(jsonStr, /LunaBot/);

  db.close();
});

test('TelegramController: group commands restrict WhatsApp and AI to private DM with notice', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('security.publicAccess', true);
  const sm = new StateMachine(db);

  let sentMessages = [];
  const fakeApi = {
    call: async () => ({}),
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 111 };
    },
    deleteMessage: async () => true,
    getMe: async () => ({ id: 999, username: 'lancybot' })
  };

  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 0, botName: 'Lancy', isClone: false }
  });

  // Simulate group message /whatsapp
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: -1001234567, type: 'supergroup' },
      from: { id: 77777, first_name: 'TestUser' },
      text: '/whatsapp'
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /WHATSAPP/);
  assert.match(sentMessages[0].text, /only available in private DM/);

  // Simulate group message /ai
  sentMessages = [];
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: -1001234567, type: 'supergroup' },
      from: { id: 77777, first_name: 'TestUser' },
      text: '/ai'
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /AI/);
  assert.match(sentMessages[0].text, /only available in private DM/);

  // Simulate group message /clone
  sentMessages = [];
  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      chat: { id: -1001234567, type: 'supergroup' },
      from: { id: 77777, first_name: 'TestUser' },
      text: '/clone'
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /clone your own bot/);

  db.close();
});

test('E2E Clone Bot Flow: state machine handles name & token input without ctx.replyRich or sm.get errors', async () => {
  const { createCloneScreen } = await import('../src/telegram/screens/clone.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('security.publicAccess', true);
  const sm = new StateMachine();

  const registeredBots = [];
  const fakeMultiBotManager = {
    getBotsForOwner: () => [],
    registerAndStartBot: async ({ ownerTgId, token, botName }) => {
      const record = {
        id: 1,
        owner_tg_id: ownerTgId,
        token,
        bot_name: botName,
        bot_username: 'pappy_cloned_bot',
        status: 'active'
      };
      registeredBots.push(record);
      return record;
    }
  };

  const sentRichMessages = [];
  const fakeApi = {
    call: async () => ({}),
    sendMessage: async () => ({ message_id: 888 }),
    sendRichMessage: async (chatId, rich) => {
      sentRichMessages.push({ chatId, rich });
      return { message_id: 889 };
    },
    deleteMessage: async () => true,
    getMe: async () => ({ id: 999, username: 'lancybot' })
  };

  const app = {
    db,
    settings,
    telegram: { api: fakeApi },
    multiBotManager: fakeMultiBotManager
  };

  const cloneScreen = createCloneScreen({ app });
  cloneScreen.registerStateHandlers(sm);

  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 0, botName: 'Lancy', isClone: false }
  });
  bot.screens.set('clone', cloneScreen);

  const testUser = { id: 8380969639, first_name: 'Pappy' };

  // 1. User starts clone flow
  await sm.transition(testUser.id, States.CLONE_BOT_NAME_INPUT);
  assert.equal(sm.state(testUser.id), States.CLONE_BOT_NAME_INPUT);

  // 2. User sends bot name "pappy"
  await bot.handleUpdate({
    update_id: 101,
    message: {
      message_id: 201,
      chat: { id: testUser.id, type: 'private' },
      from: testUser,
      text: 'pappy'
    }
  });

  // Verify transition to token input and token prompt sent
  assert.equal(sm.state(testUser.id), States.CLONE_BOT_TOKEN_INPUT);
  assert.equal(sm.context(testUser.id).botName, 'pappy');
  assert.ok(sentRichMessages.length >= 1, 'Token prompt sent as rich message');

  // Verify blockquote in token prompt
  const lastPrompt = sentRichMessages[sentRichMessages.length - 1].rich;
  const quoteBlocks = lastPrompt.blocks.filter((b) => b.type === 'blockquote');
  assert.ok(quoteBlocks.length > 0, 'Token prompt card contains aesthetic blockquote');

  // 3. User sends bot token
  await bot.handleUpdate({
    update_id: 102,
    message: {
      message_id: 202,
      chat: { id: testUser.id, type: 'private' },
      from: testUser,
      text: '8539878707:AAFuUbhEiCrfqrivMdQCplf2iOcWiu2Z-Uk'
    }
  });

  // Verify bot registered and state reset to IDLE without any runtime errors
  assert.equal(registeredBots.length, 1);
  assert.equal(registeredBots[0].bot_name, 'pappy');
  assert.equal(sm.state(testUser.id), States.IDLE, 'State reset to IDLE after success');

  // Verify success card was delivered with blockquote and no raw <b> tags
  assert.ok(sentRichMessages.length >= 2, 'Success card sent as rich message');
  const successCard = sentRichMessages[sentRichMessages.length - 1].rich;
  const successJson = JSON.stringify(successCard);
  assert.match(successJson, /pappy_cloned_bot/);
  assert.match(successJson, /blockquote/);
  assert.doesNotMatch(successJson, /<b>/);
  assert.doesNotMatch(successJson, /<\/b>/);

  db.close();
});

test('Remove Bot Flow: /rmbot and "rm bot" handle 0 bots, 1 bot, multiple bots picker, and target args', async () => {
  const { createCloneScreen } = await import('../src/telegram/screens/clone.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('security.publicAccess', true);
  const sm = new StateMachine();

  const userBots = [
    { id: 1, owner_tg_id: 11111, bot_name: 'MoonBot', bot_username: 'moon_bot', status: 'active' },
    { id: 2, owner_tg_id: 11111, bot_name: 'StarBot', bot_username: 'star_bot', status: 'active' }
  ];
  let deletedBotId = null;

  const fakeMultiBotManager = {
    getBotsForOwner: (ownerId) => userBots.filter((b) => b.owner_tg_id === Number(ownerId)),
    getBotById: (botId) => userBots.find((b) => b.id === Number(botId)),
    deleteBot: async (botId, ownerId) => {
      deletedBotId = botId;
      const idx = userBots.findIndex((b) => b.id === Number(botId) && b.owner_tg_id === Number(ownerId));
      if (idx !== -1) userBots.splice(idx, 1);
      return true;
    }
  };

  const sentMessages = [];
  const sentRichMessages = [];
  const answeredCallbacks = [];

  const fakeApi = {
    call: async () => ({}),
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 901 };
    },
    sendRichMessage: async (chatId, rich) => {
      sentRichMessages.push({ chatId, rich });
      return { message_id: 902 };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      sentRichMessages.push({ chatId, msgId, rich });
      return { message_id: msgId };
    },
    answerCallbackQuery: async (id, opts) => {
      answeredCallbacks.push({ id, opts });
      return true;
    },
    deleteMessage: async () => true,
    getMe: async () => ({ id: 999, username: 'lancybot' })
  };

  const app = {
    db,
    settings,
    telegram: { api: fakeApi },
    multiBotManager: fakeMultiBotManager
  };

  const cloneScreen = createCloneScreen({ app });
  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 0, botName: 'Lancy', isClone: false },
    app
  });
  bot.screens.set('clone', cloneScreen);

  // 1. User with 0 bots runs /rmbot
  await bot.handleUpdate({
    update_id: 201,
    message: {
      message_id: 301,
      chat: { id: 22222, type: 'private' },
      from: { id: 22222, first_name: 'NoBotsUser' },
      text: '/rmbot'
    }
  });
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /You don't have any active cloned bots to remove/);
  assert.match(sentMessages[0].text, /<blockquote>/);

  // 2. User in a group chat sends /rmbot -> notice to open DM
  await bot.handleUpdate({
    update_id: 202,
    message: {
      message_id: 302,
      chat: { id: -100999, type: 'supergroup' },
      from: { id: 11111, first_name: 'BotOwner' },
      text: '/rmbot'
    }
  });
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /please open a private DM with the bot/);

  // 3. User with multiple bots sends natural text "rm bot" -> triggers rm_picker
  sentRichMessages.length = 0;
  await bot.handleUpdate({
    update_id: 203,
    message: {
      message_id: 303,
      chat: { id: 11111, type: 'private' },
      from: { id: 11111, first_name: 'BotOwner' },
      text: 'rm bot'
    }
  });
  assert.ok(sentRichMessages.length >= 1, 'rm_picker rich card sent');
  const pickerCard = sentRichMessages[sentRichMessages.length - 1].rich;
  const pickerJson = JSON.stringify(pickerCard);
  assert.match(pickerJson, /REMOVE A CLONED BOT/);
  assert.match(pickerJson, /moon_bot/);
  assert.match(pickerJson, /star_bot/);

  // 4. Target argument /rmbot @star_bot -> directly confirms deletion for star_bot (id: 2)
  sentRichMessages.length = 0;
  await bot.handleUpdate({
    update_id: 204,
    message: {
      message_id: 304,
      chat: { id: 11111, type: 'private' },
      from: { id: 11111, first_name: 'BotOwner' },
      text: '/rmbot @star_bot'
    }
  });
  assert.ok(sentRichMessages.length >= 1, 'delete_confirm card sent for star_bot');
  const confirmCard = sentRichMessages[sentRichMessages.length - 1].rich;
  const confirmJson = JSON.stringify(confirmCard);
  assert.match(confirmJson, /CONFIRM DELETE BOT/);
  assert.match(confirmJson, /star_bot/);
  assert.match(confirmJson, /Yes, Delete/);

  // 5. User clicks 'Yes, Delete' callback (action: delete)
  await bot.handleUpdate({
    update_id: 205,
    callback_query: {
      id: 'cb_del_2',
      from: { id: 11111, first_name: 'BotOwner' },
      message: { message_id: 902, chat: { id: 11111, type: 'private' } },
      data: 'l1:clone:delete:2'
    }
  });
  assert.equal(deletedBotId, 2);
  assert.equal(userBots.length, 1);
  assert.equal(userBots[0].id, 1);
  assert.ok(answeredCallbacks.some((cb) => cb.opts?.text?.includes('star_bot')));

  // 6. User now has 1 bot left. Calling /rmbot directly opens delete_confirm for that remaining bot
  sentRichMessages.length = 0;
  await bot.handleUpdate({
    update_id: 206,
    message: {
      message_id: 306,
      chat: { id: 11111, type: 'private' },
      from: { id: 11111, first_name: 'BotOwner' },
      text: '/rmbot'
    }
  });
  assert.ok(sentRichMessages.length >= 1, 'delete_confirm card sent directly for sole bot');
  const soleConfirm = JSON.stringify(sentRichMessages[sentRichMessages.length - 1].rich);
  assert.match(soleConfirm, /CONFIRM DELETE BOT/);
  assert.match(soleConfirm, /moon_bot/);

  // 7. Non-existent bot target: /rmbot @unknown_bot
  await bot.handleUpdate({
    update_id: 207,
    message: {
      message_id: 307,
      chat: { id: 11111, type: 'private' },
      from: { id: 11111, first_name: 'BotOwner' },
      text: '/rmbot @unknown_bot'
    }
  });
  const lastMsg = sentMessages[sentMessages.length - 1];
  assert.match(lastMsg.text, /Could not find a cloned bot matching/);
  assert.match(lastMsg.text, /unknown_bot/);

  db.close();
});

test('Cloned Bot Downloader: executes download and progress updates via cloned bot API without chat not found', async () => {
  const { createDownloaderScreen } = await import('../src/telegram/screens/downloader.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('security.publicAccess', true);
  const sm = new StateMachine();

  const mainApiCalls = [];
  const fakeMainApi = {
    call: async () => ({}),
    sendRichMessage: async (...args) => { mainApiCalls.push(['sendRichMessage', ...args]); return { message_id: 101 }; },
    editMessageRich: async (...args) => { mainApiCalls.push(['editMessageRich', ...args]); return { message_id: 101 }; },
    sendMessage: async (...args) => { mainApiCalls.push(['sendMessage', ...args]); return { message_id: 102 }; },
    getMe: async () => ({ id: 1000, username: 'main_bot' })
  };

  const cloneApiCalls = [];
  const fakeCloneApi = {
    call: async () => ({}),
    sendRichMessage: async (chatId, rich) => {
      cloneApiCalls.push(['sendRichMessage', chatId, rich]);
      return { message_id: 201 };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      cloneApiCalls.push(['editMessageRich', chatId, msgId, rich]);
      return { message_id: msgId };
    },
    sendMessage: async (chatId, text) => {
      cloneApiCalls.push(['sendMessage', chatId, text]);
      return { message_id: 202 };
    },
    sendChatAction: async () => ({ ok: true }),
    getMe: async () => ({ id: 2000, username: 'pappy_clone_bot' })
  };

  const fakeMediaDownloader = {
    detectPlatform: () => 'spotify',
    download: async (query) => ({
      platform: 'spotify',
      mediaItems: [],
      audioTrack: {
        buffer: Buffer.from('mock_audio'),
        title: 'Ransom',
        performer: 'Lil Tecca'
      },
      title: 'Ransom',
      artist: 'Lil Tecca'
    })
  };

  const app = {
    db,
    settings,
    mediaDownloader: fakeMediaDownloader,
    telegram: {
      api: fakeMainApi,
      controller: null
    }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStateHandlers(sm);

  const cloneBot = new TelegramController({
    api: fakeCloneApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 2, botName: 'PappyBot', isClone: true, ownerId: 8380969639 },
    app
  });
  cloneBot.screens.set('downloader', downloader);

  // Set user state to MUSIC_SEARCH_INPUT in clone bot
  await sm.transition(8380969639, States.MUSIC_SEARCH_INPUT, {
    chatId: 8380969639,
    screenMessageId: 555
  });

  // User sends "ransom" to cloned bot
  await cloneBot.handleUpdate({
    update_id: 301,
    message: {
      message_id: 777,
      chat: { id: 8380969639, type: 'private' },
      from: { id: 8380969639, first_name: 'Pappy' },
      text: 'ransom'
    }
  });

  // Verify clone API was called for rich message delivery
  assert.ok(cloneApiCalls.length > 0, 'Clone API received calls for progress and delivery');
  // Verify main bot API was NOT called
  assert.equal(mainApiCalls.length, 0, 'Main bot API must never be called for cloned bot interactions');

  db.close();
});

test('TelegramController: registers group chat commands including /play for all_group_chats', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const registeredCommandCalls = [];
  const fakeApi = {
    call: async (method, payload) => {
      if (method === 'setMyCommands') {
        registeredCommandCalls.push(payload);
      }
      return { ok: true };
    },
    getMe: async () => ({ id: 500, username: 'group_test_bot', first_name: 'GroupBot' }),
    poll: async () => []
  };

  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 0, botName: 'Lancy', isClone: false }
  });

  await bot.start();
  await bot.stop();

  assert.ok(registeredCommandCalls.length >= 3, 'Registered commands across multiple scopes');
  const groupScope = registeredCommandCalls.find((c) => c.scope?.type === 'all_group_chats');
  assert.ok(groupScope, 'all_group_chats scope registered');
  assert.ok(groupScope.commands.some((cmd) => cmd.command === 'play'), '/play included in group commands');
  assert.ok(groupScope.commands.some((cmd) => cmd.command === 'download'), '/download included in group commands');

  db.close();
});

test('Group Chat Dashboard: renders user pfp or aesthetic fallback banner so hero image is never empty', async () => {
  const { createDashboardScreen } = await import('../src/telegram/screens/dashboard.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  let deliveredRich = null;
  let deliveredFiles = null;
  const fakeApi = {
    getUserProfilePhotos: async () => ({ total_count: 0, photos: [] }),
    sendRichMessage: async (chatId, rich, extra, files) => {
      deliveredRich = rich;
      deliveredFiles = files;
      return { message_id: 1001 };
    },
    editMessageRich: async () => ({ message_id: 1002 })
  };

  const dashboard = createDashboardScreen({ app: { db, settings } });
  const groupCtx = {
    tgId: '123456',
    chatId: -100555666,
    isGroup: true,
    chatType: 'supergroup',
    botName: 'Lancy',
    user: { id: 123456, first_name: 'Alex' },
    settings,
    db,
    api: fakeApi,
    sendRichMessage: async (rich, extra, files) => {
      return fakeApi.sendRichMessage(groupCtx.chatId, rich, extra, files);
    },
    editScreen: async (rich, extra, files) => {
      deliveredRich = rich;
      deliveredFiles = files;
      return { message_id: 1003 };
    }
  };

  await dashboard.open(groupCtx, { forceNew: true });
  assert.ok(deliveredRich, 'Group menu rich card delivered');
  const jsonStr = JSON.stringify(deliveredRich);
  assert.match(jsonStr, /attach:\/\/pfp/, 'Hero image is attached in GC');
  assert.ok(deliveredFiles?.pfp?.buffer, 'pfp buffer is present (fallback banner or user pfp)');

  db.close();
});

test('Inline Query: handles @bot query with live music search and returns articles', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let inlineAnswers = null;
  const fakeApi = {
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswers = payload;
      }
      return { ok: true };
    },
    getMe: async () => ({ id: 600, username: 'pappy_inline_bot', first_name: 'PappyBot' })
  };

  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 5, botName: 'PappyBot', isClone: true, ownerId: 12345 }
  });

  // 1. Empty inline query: returns interactive suggestion articles
  await bot.handleUpdate({
    update_id: 401,
    inline_query: {
      id: 'iq_1',
      from: { id: 12345, first_name: 'User1' },
      query: '',
      offset: ''
    }
  });
  assert.ok(inlineAnswers, 'answerInlineQuery called for empty query');
  assert.equal(inlineAnswers.inline_query_id, 'iq_1');
  assert.ok(inlineAnswers.results.length >= 3, '3 suggestion articles returned');
  assert.match(inlineAnswers.results[0].title, /Music/);

  // 2. Music query: "ransom"
  inlineAnswers = null;
  await bot.handleUpdate({
    update_id: 402,
    inline_query: {
      id: 'iq_2',
      from: { id: 12345, first_name: 'User1' },
      query: 'ransom',
      offset: ''
    }
  });
  assert.ok(inlineAnswers, 'answerInlineQuery called for music query');
  assert.equal(inlineAnswers.inline_query_id, 'iq_2');
  assert.ok(inlineAnswers.results.length >= 1, 'Search results returned');
  const firstSong = inlineAnswers.results[0];
  // 3. Media URL query: e.g. direct mp4 or media link
  inlineAnswers = null;
  await bot.handleUpdate({
    update_id: 403,
    inline_query: {
      id: 'iq_3',
      from: { id: 12345, first_name: 'User1' },
      query: 'https://example.com/aesthetic_loop.mp4',
      offset: ''
    }
  });
  assert.ok(inlineAnswers, 'answerInlineQuery called for media URL query');
  assert.equal(inlineAnswers.inline_query_id, 'iq_3');
  assert.ok(inlineAnswers.results.length >= 1, 'Media results returned');
  assert.equal(inlineAnswers.results[0].type, 'video');
  assert.equal(inlineAnswers.results[0].video_url, 'https://example.com/aesthetic_loop.mp4');

  db.close();
});

test('Group Chat Multitask: concurrent /play requests by multiple users deliver separate cards', async () => {
  const { createDownloaderScreen } = await import('../src/telegram/screens/downloader.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('security.publicAccess', true);
  const sm = new StateMachine();

  const sentRichMessages = [];
  const fakeApi = {
    call: async () => ({ ok: true }),
    sendRichMessage: async (chatId, rich) => {
      const msgId = 2000 + sentRichMessages.length;
      sentRichMessages.push({ msgId, chatId, rich });
      return { message_id: msgId };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      sentRichMessages.push({ msgId, chatId, rich });
      return { message_id: msgId };
    },
    sendMessage: async () => ({ message_id: 2999 }),
    sendChatAction: async () => ({ ok: true }),
    getMe: async () => ({ id: 700, username: 'multitask_bot' })
  };

  const fakeMediaDownloader = {
    detectPlatform: () => 'spotify',
    download: async (query) => ({
      platform: 'spotify',
      mediaItems: [],
      audioTrack: {
        buffer: Buffer.from(`audio_for_${query}`),
        title: query,
        performer: 'Artist'
      },
      title: query,
      artist: 'Artist'
    })
  };

  const app = {
    db,
    settings,
    mediaDownloader: fakeMediaDownloader,
    telegram: { api: fakeApi, controller: null }
  };

  const downloader = createDownloaderScreen({ app });
  downloader.registerStateHandlers(sm);

  const bot = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    botContext: { botId: 0, botName: 'Lancy', isClone: false },
    app
  });
  bot.screens.set('downloader', downloader);

  // User 1 requests Song A and User 2 requests Song B concurrently in the same group chat
  const groupChatId = -100888999;
  await Promise.all([
    bot.handleUpdate({
      update_id: 501,
      message: {
        message_id: 101,
        chat: { id: groupChatId, type: 'supergroup' },
        from: { id: 111, first_name: 'Alice' },
        text: '/play Song A'
      }
    }),
    bot.handleUpdate({
      update_id: 502,
      message: {
        message_id: 102,
        chat: { id: groupChatId, type: 'supergroup' },
        from: { id: 222, first_name: 'Bob' },
        text: '/play Song B'
      }
    })
  ]);

  // Both users receive their respective delivered rich cards
  assert.ok(sentRichMessages.length >= 2, 'Delivered cards for both concurrent users');
  const deliveredA = sentRichMessages.some((m) => JSON.stringify(m.rich).includes('Alice') && JSON.stringify(m.rich).includes('Song A'));
  const deliveredB = sentRichMessages.some((m) => JSON.stringify(m.rich).includes('Bob') && JSON.stringify(m.rich).includes('Song B'));
  assert.ok(deliveredA, 'Song A card attributed to Alice');
  assert.ok(deliveredB, 'Song B card attributed to Bob');

  db.close();
});

