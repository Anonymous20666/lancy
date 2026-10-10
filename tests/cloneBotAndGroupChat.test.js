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

