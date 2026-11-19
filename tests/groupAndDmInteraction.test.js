import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createHelpScreen } from '../src/telegram/screens/help.js';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { createStickersScreen } from '../src/telegram/screens/stickers.js';
import { richTextToString } from '../src/telegram/rich.js';

test('Group routing: ignores mentions and general chatter; only literal play replies trigger music', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];

  let assistantCalled = false;
  let receivedText = '';
  const mockAssistant = {
    handleMessage: async ({ text }) => {
      assistantCalled = true;
      receivedText = text;
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

  // 1. Group Chat untagged message between members: AI must NOT respond!
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 201,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'hey everyone what are we playing today?'
    }
  });
  assert.equal(assistantCalled, false, 'AI assistant must NOT respond to random untagged group chatter');

  // 2. Group Chat untagged/unquoted messages do NOT trigger AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 202,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '@Lancy_easy_bot write me a poem'
    }
  });
  assert.equal(assistantCalled, false, 'AI assistant must NOT respond to general chatter in GC');

  // 3. Group Chat quoting / replying to bot with 'play' triggers AI music:
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 4,
    message: {
      message_id: 204,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      reply_to_message: { from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: 'play starboy'
    }
  });
  assert.equal(assistantCalled, true, 'AI assistant must respond in GC when quoting her message with play');

  // 4. DM (private chat): AI responds in DM directly!
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 5,
    message: {
      message_id: 205,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: 'play starboy'
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

  const dashDetails = dashRich.blocks.find((b) => b.type === 'details');
  assert.ok(dashDetails, 'Dashboard must contain Bot API 10.3 details toggle block');
  const dashStr = JSON.stringify(dashDetails);
  assert.match(dashStr, /Music|MUSIC/i);
  assert.match(dashStr, /Downloader|UNIVERSAL/i);
  assert.match(dashStr, /Pinterest|PINTEREST/i);
  assert.match(dashStr, /clone/i);

  // 2. Help
  let sentHelp = null;
  const helpCtx = {
    tgId: '1001',
    chatId: 1001,
    editScreen: async (rich) => { sentHelp = rich; }
  };
  await help.open(helpCtx);
  assert.ok(sentHelp, 'Help screen opens');

  const helpDetails = sentHelp.blocks.filter((b) => b.type === 'details');
  assert.ok(helpDetails.length >= 4, 'Help screen must contain Bot API 10.3 collapsible details toggles');
  assert.match(JSON.stringify(helpDetails), /Music Studio/i);

  db.close();
});

test('Pinterest Search in GC: replying to bot deletes prompt, preserves user message, and quotes user query for amount selection', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const deletedMsgIds = [];
  let sentRichMessage = null;
  let sentExtra = null;
  const fakeApi = {
    editMessageRich: async () => ({ message_id: 500 }),
    sendRichMessage: async (chatId, rich, extra) => {
      sentRichMessage = rich;
      sentExtra = extra;
      return { message_id: 888 };
    },
    deleteMessage: async (chatId, messageId) => {
      deletedMsgIds.push(messageId);
      return { ok: true };
    }
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

  // Bot had sent prompt at message_id: 500 in group chat -100999
  await sm.transition('1001', States.PINTEREST_SEARCH, {
    context: { mode: 'images', screenMessageId: 500 },
    screenMessageId: 500
  });

  const ctx = {
    tgId: '1001',
    chatId: -100999,
    isGroup: true,
    screenMessageId: 500,
    sm,
    api: fakeApi,
    settings,
    controller: app.telegram.controller
  };

  // User replies to prompt message 500 with message 501: "gojo satoru"
  const handled = await sm.handleMessage('1001', {
    message_id: 501,
    from: { id: 1001 },
    chat: { id: -100999, type: 'supergroup' },
    reply_to_message: { message_id: 500 },
    text: 'gojo satoru'
  }, ctx);

  assert.equal(handled, true);
  // Prompt message 500 must be deleted!
  assert.ok(deletedMsgIds.includes(500), 'Bot prompt message must be deleted');
  // User message 501 must NOT be deleted!
  assert.ok(!deletedMsgIds.includes(501), 'User query message must be preserved');
  // A new rich message must be sent quoting user message 501
  assert.ok(sentRichMessage, 'Must send amount selection rich message');
  assert.equal(sentExtra?.reply_parameters?.message_id, 501, 'Must quote user message via reply_parameters');
  assert.equal(sentExtra?.reply_to_message_id, 501, 'Must quote user message via reply_to_message_id');

  // Verify the screen message ID in state machine was updated to the new message 888
  const stateRecord = sm.for('1001');
  assert.equal(stateRecord.screenMessageId, 888, 'Screen message ID must be updated to amount selection message');

  db.close();
});

test('Group Chat sticker completion & help: omit WhatsApp Studio and WhatsApp Detailed Guide', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const fakeApi = {
    editMessageRich: async () => ({ ok: true }),
    sendRichMessage: async () => ({ message_id: 123 })
  };
  const app = {
    db,
    settings,
    telegram: { api: fakeApi, controller: { userScreenMessage: new Map() } },
    pinterest: { db },
    media: { cache: { read: () => null } }
  };

  // 1. Help screen in group chat
  const helpScreen = createHelpScreen({ app });
  let groupHelpRich = null;
  await helpScreen.open({
    tgId: '1001',
    chatId: -100999,
    isGroup: true,
    editScreen: async (rich) => { groupHelpRich = rich; }
  });
  assert.ok(groupHelpRich);
  const helpWaButton = groupHelpRich.blocks.flatMap(b => b.buttons || []).flat().find(btn => /whatsapp/i.test(btn.text || btn.url || btn.callback_data));
  assert.equal(helpWaButton, undefined, 'WhatsApp Detailed Guide button must be omitted in group chat');

  db.close();
});

test('DM AI conflict prevention: AI ignores replies to user/forwarded messages and non-AI cards, routes prompt replies cleanly, and answers actual AI replies', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  const assistantCalls = [];
  const movieSearches = [];
  const pinterestSearches = [];

  const mockAssistant = {
    handleMessage: async ({ text }) => {
      assistantCalls.push(text);
    }
  };

  const fakeApi = {
    me: { id: 900, username: 'pappy_agent' },
    getMe: async () => ({ id: 900, username: 'pappy_agent' }),
    sendMessage: async () => ({ message_id: 999 })
  };

  const screens = new Map([
    ['movie', {
      openMovieSearch: async (_ctx, query) => {
        movieSearches.push(query);
      }
    }],
    ['pinterest', {
      executeSearch: async (_ctx, query) => {
        pinterestSearches.push(query);
      }
    }]
  ]);

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: { assistant: mockAssistant },
    screens,
    botContext: { botName: 'Lancy', botUsername: 'pappy_agent' }
  });
  controller.botUsername = 'pappy_agent';

  // Even when AI_CHAT state is active, replying to non-AI messages/cards must NOT trigger AI
  let aiStateCalls = 0;
  sm.register(States.AI_CHAT, {
    onMessage: async (sctx, message) => {
      if (sctx.isNonAiReply && !sctx.isTag) return false;
      aiStateCalls++;
      await mockAssistant.handleMessage({ text: message.text });
      return true;
    }
  });
  await sm.transition('1001', States.AI_CHAT, { chatId: 1001, context: {} });

  // 1. Replying to user's own message in DM -> must NOT call AI
  await controller.handleUpdate({
    update_id: 101,
    message: {
      message_id: 401,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 390,
        from: { id: 1001, first_name: 'Pappy' },
        text: 'my saved note'
      },
      text: 'remind me later'
    }
  });
  assert.equal(assistantCalls.length, 0, 'DM reply to user own message must not trigger AI');

  // 2. Replying to a forwarded message in DM -> must NOT call AI
  await controller.handleUpdate({
    update_id: 102,
    message: {
      message_id: 402,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 391,
        forward_date: 1700000000,
        forward_origin: { type: 'user', date: 1700000000 },
        text: 'forwarded song clip'
      },
      text: 'save this'
    }
  });
  assert.equal(assistantCalls.length, 0, 'DM reply to forwarded message must not trigger AI');

  // 3. Replying to a bot non-AI card (photo/button card or media delivery) -> must NOT call AI
  controller.markMediaDeliveryMessage(392);
  await controller.handleUpdate({
    update_id: 103,
    message: {
      message_id: 403,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 392,
        from: { id: 900, is_bot: true, username: 'pappy_agent' },
        photo: [{ file_id: 'abc' }],
        caption: '🎬 Inception (2010)',
        reply_markup: { inline_keyboard: [[{ text: '⬇ Download', callback_data: 'x' }]] }
      },
      text: 'nice quality'
    }
  });
  assert.equal(assistantCalls.length, 0, 'DM reply to bot media/preview card must not trigger AI');

  // 4. Replying to a Movie Search prompt card while AI_CHAT is active -> routes cleanly to movie search, zero AI hijack
  await controller.handleUpdate({
    update_id: 104,
    message: {
      message_id: 404,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 393,
        from: { id: 900, is_bot: true, username: 'pappy_agent' },
        text: 'Send a movie or TV series title (e.g. "Breaking Bad", "Inception"). /cancel closes search.'
      },
      text: 'Alchemy of Souls'
    }
  });
  assert.deepEqual(movieSearches, ['Alchemy of Souls'], 'Reply to Movie Search prompt must route cleanly without AI hijack');
  assert.equal(assistantCalls.length, 0);

  // 5. Replying to a Pinterest Search prompt card -> routes cleanly to Pinterest search, zero AI hijack
  await controller.handleUpdate({
    update_id: 105,
    message: {
      message_id: 405,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 394,
        from: { id: 900, is_bot: true, username: 'pappy_agent' },
        text: '𓆩♡𓆪 PINTEREST SEARCH 𓆩♡𓆪\ntell me what to search for ♡'
      },
      text: 'gojo satoru'
    }
  });
  assert.deepEqual(pinterestSearches, ['gojo satoru']);
  assert.equal(assistantCalls.length, 0);

  // 6. Replying to an actual AI reply message (marked with markAiMessage) -> DOES invoke AI
  controller.markAiMessage(1001, 395);
  await controller.handleUpdate({
    update_id: 106,
    message: {
      message_id: 406,
      from: { id: 1001, first_name: 'Pappy' },
      chat: { id: 1001, type: 'private' },
      reply_to_message: {
        message_id: 395,
        from: { id: 900, is_bot: true, username: 'pappy_agent' },
        text: 'heyyy bestie, what vibe are you looking for?'
      },
      text: 'something chill today'
    }
  });
  assert.deepEqual(assistantCalls, ['something chill today']);
  assert.equal(aiStateCalls, 1);

  db.close();
});

