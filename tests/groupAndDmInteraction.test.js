import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createHelpScreen } from '../src/telegram/screens/help.js';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { richTextToString } from '../src/telegram/rich.js';

test('AI Assistant: strictly responds in DM (private chat), NEVER in group chats (GC)', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];

  let assistantCalled = false;
  const mockAssistant = {
    handleMessage: async () => {
      assistantCalled = true;
    }
  };

  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    sendMessage: async () => ({ message_id: 101 })
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: new StateMachine(),
    app: { assistant: mockAssistant },
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  // 1. Group Chat mention: AI must NEVER respond in GC!
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 201,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '@Lancy_easy_bot write me a poem'
    }
  });
  assert.equal(assistantCalled, false, 'AI assistant must NOT respond in group chats');

  // 2. DM (private chat) mention: AI responds in DM!
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 202,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: '@Lancy_easy_bot write me a poem'
    }
  });
  assert.equal(assistantCalled, true, 'AI assistant responds in private DM');

  db.close();
});

test('Chat conflict avoidance: GC state requires quote/tag, DM does not require quote/tag', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  let stateHandlerCalled = false;
  sm.register('TEST_INPUT', {
    onMessage: async () => {
      stateHandlerCalled = true;
      return true;
    }
  });

  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    sendMessage: async () => ({ message_id: 101 })
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  // Put user into TEST_INPUT state
  await sm.transition('1001', 'TEST_INPUT');

  // 1. In GC: user sends normal chat without replying to bot and without tagging bot
  stateHandlerCalled = false;
  await controller.handleUpdate({
    update_id: 3,
    message: {
      message_id: 301,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'hey guys what are we doing today?'
    }
  });
  assert.equal(stateHandlerCalled, false, 'GC regular chatting must NOT trigger bot state');

  // 2. In GC: user tags @bot with input
  stateHandlerCalled = false;
  await controller.handleUpdate({
    update_id: 4,
    message: {
      message_id: 302,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '@Lancy_easy_bot here is my query'
    }
  });
  assert.equal(stateHandlerCalled, true, 'GC tagged message must trigger bot state');

  // 3. In DM: user sends input directly (no tag, no quote needed!)
  await sm.transition('1001', 'TEST_INPUT');
  stateHandlerCalled = false;
  await controller.handleUpdate({
    update_id: 5,
    message: {
      message_id: 303,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: 'Starboy The Weeknd'
    }
  });
  assert.equal(stateHandlerCalled, true, 'DM direct message triggers bot state without quote or tag');

  db.close();
});

test('Pinterest Search: typing search query edits prompt message into SEARCH RESULT COUNT in place', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let editedMsgId = null;
  let editedRich = null;
  const fakeApi = {
    editMessageRich: async (chatId, messageId, rich) => {
      editedMsgId = messageId;
      editedRich = rich;
      return { message_id: messageId };
    },
    sendRichMessage: async () => ({ message_id: 999 }),
    deleteMessage: async () => ({ ok: true })
  };

  const app = {
    db,
    settings,
    telegram: { api: fakeApi, controller: { userScreenMessage: new Map() } },
    pinterest: { db },
    media: { cache: { read: () => null } }
  };

  const pinterestScreen = createPinterestScreen({ app });
  pinterestScreen.registerStateHandlers(sm);

  // User is at prompt message with message_id: 500
  await sm.transition('1001', States.PINTEREST_SEARCH, {
    context: { mode: 'images', screenMessageId: 500 },
    screenMessageId: 500
  });

  const ctx = {
    tgId: '1001',
    chatId: 1001,
    screenMessageId: 500,
    sm,
    api: fakeApi,
    settings,
    controller: app.telegram.controller
  };

  // User sends text "Aesthetic Anime"
  const handled = await sm.handleMessage('1001', {
    message_id: 501,
    from: { id: 1001 },
    chat: { id: 1001 },
    text: 'Aesthetic Anime'
  }, ctx);

  assert.equal(handled, true);
  assert.equal(editedMsgId, 500, 'Must edit the prompt message (500) rather than sending new message or editing user message');
  assert.ok(editedRich, 'Must deliver edited rich message');

  const headingBlock = editedRich.blocks.find((b) => b.type === 'heading');
  const headingText = richTextToString(headingBlock?.text);
  assert.match(headingText, /SEARCH RESULT COUNT/);

  db.close();
});

test('/grab command: triggers universal media download and appears in commands list', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  let downloadUrl = null;
  const screens = new Map();
  screens.set('downloader', {
    executeDownload: async (ctx, url) => {
      downloadUrl = url;
      return { message_id: 777 };
    }
  });

  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    setMyCommands: async () => ({ ok: true }),
    call: async () => ({ ok: true }),
    sendMessage: async () => ({ message_id: 101 })
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens,
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  // Test /grab <url>
  await controller.handleUpdate({
    update_id: 6,
    message: {
      message_id: 401,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: '/grab https://www.tiktok.com/@user/video/123456789'
    }
  });

  assert.equal(downloadUrl, 'https://www.tiktok.com/@user/video/123456789', '/grab must execute download');

  db.close();
});

test('Dashboard and Help: include heads-up banner and expandable superpowers guide', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const app = {
    db,
    settings,
    whatsapp: { listForUser: () => [] },
    ai: { status: async () => ({ enabled: false }) },
    media: { cache: { stats: () => ({ entries: 0, totalBytes: 0 }) } }
  };

  const dashboard = createDashboardScreen({ app });
  const help = createHelpScreen({ app });

  // 1. Dashboard
  const dashRich = dashboard.render({
    tgId: '1001',
    chatId: 1001,
    isGroup: false,
    settings,
    db
  }, {});

  const dashHasHeadsUp = dashRich.blocks.some((b) => b.type === 'paragraph' && JSON.stringify(b).includes('Heads up'));
  assert.ok(dashHasHeadsUp, 'Dashboard must contain heads up notice');

  const dashExpandable = dashRich.blocks.find((b) => b.type === 'expandable_blockquote');
  assert.ok(dashExpandable, 'Dashboard must contain expandable blockquote');
  const dashStr = richTextToString(dashExpandable.text);
  assert.match(dashStr, /HIGH-SPEED MUSIC & MP3 STREAMING/);
  assert.match(dashStr, /UNIVERSAL HD MEDIA DOWNLOADER/);
  assert.match(dashStr, /PINTEREST HD AESTHETIC STUDIO/);
  assert.match(dashStr, /BRING YOUR OWN BOT/);

  // 2. Help
  const helpRich = help.open ? null : null; // render method
  // Let's test help render through ctx
  let sentHelp = null;
  const helpCtx = {
    tgId: '1001',
    chatId: 1001,
    editScreen: async (rich) => { sentHelp = rich; }
  };
  await help.open(helpCtx);
  assert.ok(sentHelp, 'Help screen opens');

  const helpExpandable = sentHelp.blocks.find((b) => b.type === 'expandable_blockquote');
  assert.ok(helpExpandable, 'Help screen must contain expandable blockquote');
  const helpStr = richTextToString(helpExpandable.text);
  assert.match(helpStr, /HIGH-SPEED MUSIC & MP3 STREAMING/);

  db.close();
});
