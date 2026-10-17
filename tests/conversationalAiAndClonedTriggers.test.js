import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { LancyAssistant } from '../src/ai/assistant.js';

function makeMockApp(db) {
  return {
    db,
    settings: new SettingsManager(db),
    telegram: {
      api: {
        sendMessage: async () => ({ message_id: 101 }),
        sendRichMessage: async () => ({ message_id: 102 }),
        getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' })
      },
      screens: new Map(),
      botName: 'Lancy',
      botUsername: 'Lancy_easy_bot'
    },
    screens: new Map(),
    ai: {
      generate: async ({ text }) => {
        if (/favorite|recommend|waifu/i.test(text)) {
          return 'Tifa is my absolute favorite! ♡ [ACTION: search_nsfw query="tifa" category="hentai_uncensored"]';
        }
        if (/nsfw|hentai/i.test(text)) {
          return 'Here is some spicy art! ♡ [ACTION: search_nsfw query="tifa" category="hentai_uncensored"]';
        }
        if (/random.*video/i.test(text)) {
          return 'Dropping a random clip! ♡ [ACTION: search_nsfw category="hentai_clips" random="true"]';
        }
        if (/play|song/i.test(text)) {
          return 'Pulling that song! ♡ [ACTION: search_music query="Starboy"]';
        }
        return 'heyy! what are we vibing with today? ♡';
      }
    }
  };
}

test('Conversational AI: Group Chat invocation via bot name ("lancy ..."), tag, and quotes', async () => {
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

  // 1. Untagged conversation between group members does NOT trigger AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 201,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'Good morning guys what are we doing today?'
    }
  });
  assert.equal(assistantCalled, false, 'Untagged message between members must NOT trigger AI');

  // 2. Calling "lancy play starboy" in Group Chat triggers AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 202,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'lancy play starboy'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "lancy play starboy" in GC must trigger AI');
  assert.equal(receivedText, 'lancy play starboy');

  // 3. Calling "lancy search nsfw" in Group Chat triggers AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 3,
    message: {
      message_id: 203,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'lancy search nsfw'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "lancy search nsfw" in GC must trigger AI');

  // 4. Calling "lancy nsfw video random" in Group Chat triggers AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 4,
    message: {
      message_id: 204,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: 'lancy nsfw video random'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "lancy nsfw video random" in GC must trigger AI');

  // 5. Quoting the bot in Group Chat triggers AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 5,
    message: {
      message_id: 205,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      reply_to_message: { from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: 'can you give me another one?'
    }
  });
  assert.equal(assistantCalled, true, 'Quoting the bot in GC must trigger AI');

  // 6. Tagging @Lancy_easy_bot in Group Chat triggers AI
  assistantCalled = false;
  await controller.handleUpdate({
    update_id: 6,
    message: {
      message_id: 206,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '@Lancy_easy_bot find me naruto wallpapers'
    }
  });
  assert.equal(assistantCalled, true, 'Tagging the bot in GC must trigger AI');

  db.close();
});

test('Conversational AI: Cloned Bot triggers with its custom bot name (e.g. "Rina")', async () => {
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
    getMe: async () => ({ id: 500, username: 'RinaBot' }),
    sendMessage: async () => ({ message_id: 501 })
  };

  // Cloned bot with name "Rina"
  const cloneController = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: new StateMachine(),
    app: { assistant: mockAssistant },
    screens: new Map(),
    botContext: { botId: 2, botName: 'Rina', botUsername: 'RinaBot', isClone: true }
  });
  cloneController.botUsername = 'RinaBot';

  // 1. Untagged conversation does not trigger
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 1,
    message: {
      message_id: 301,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: 'who is online right now'
    }
  });
  assert.equal(assistantCalled, false);

  // 2. Calling "rina play starboy" triggers Rina's AI
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 2,
    message: {
      message_id: 302,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: 'rina play starboy'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "rina play starboy" must trigger cloned bot');

  // 3. Calling "rina search nsfw" triggers Rina's AI
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 3,
    message: {
      message_id: 303,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: 'rina search nsfw'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "rina search nsfw" must trigger cloned bot');

  // 4. Calling "rina nsfw video random" triggers Rina's AI
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 4,
    message: {
      message_id: 304,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: 'rina nsfw video random'
    }
  });
  assert.equal(assistantCalled, true, 'Calling "rina nsfw video random" must trigger cloned bot');

  // 5. Universal "lancy" name trigger also triggers clone as fallback
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 5,
    message: {
      message_id: 305,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: 'lancy play starboy'
    }
  });
  assert.equal(assistantCalled, true, 'Universal "lancy" call must also trigger cloned bot');

  // 6. Tagging @RinaBot triggers clone
  assistantCalled = false;
  await cloneController.handleUpdate({
    update_id: 6,
    message: {
      message_id: 306,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100999, type: 'supergroup' },
      text: '@RinaBot how are you'
    }
  });
  assert.equal(assistantCalled, true, 'Tagging @RinaBot must trigger cloned bot');

  db.close();
});

test('LancyAssistant: NSFW intent triggers nsfwScreen.executeSearch, handle random, and open', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);

  let nsfwExecuted = null;
  let nsfwRandomCalled = null;
  let nsfwOpened = false;

  const mockNsfwScreen = {
    executeSearch: async (ctx, query, category) => {
      nsfwExecuted = { query, category, forceNew: ctx.forceNew };
      return { message_id: 901 };
    },
    handle: async (ctx, action, args) => {
      if (action === 'random') {
        nsfwRandomCalled = { category: args[0], forceNew: ctx.forceNew };
        return { message_id: 902 };
      }
    },
    open: async (ctx) => {
      nsfwOpened = true;
      return { message_id: 903 };
    }
  };

  app.telegram.screens.set('nsfw', mockNsfwScreen);
  const assistant = new LancyAssistant({ app });

  // 1. "lancy search hentai tifa" -> executes search for "tifa" under hentai_uncensored
  nsfwExecuted = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy', botUsername: 'Lancy_easy_bot' },
    message: { message_id: 1, text: 'lancy search hentai tifa' },
    text: 'lancy search hentai tifa'
  });
  assert.ok(nsfwExecuted, 'nsfwScreen.executeSearch must be triggered');
  assert.equal(nsfwExecuted.query, 'tifa');
  assert.equal(nsfwExecuted.category, 'hentai_uncensored');
  assert.equal(nsfwExecuted.forceNew, true);

  // 2. "lancy nsfw video random" -> triggers random video handler
  nsfwRandomCalled = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy', botUsername: 'Lancy_easy_bot' },
    message: { message_id: 2, text: 'lancy nsfw video random' },
    text: 'lancy nsfw video random'
  });
  assert.ok(nsfwRandomCalled, 'nsfwScreen.handle("random") must be triggered for random video');
  assert.equal(nsfwRandomCalled.category, 'hentai_clips');
  assert.equal(nsfwRandomCalled.forceNew, true);

  // 3. "rina nsfw random" on clone bot -> triggers random pick
  nsfwRandomCalled = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Rina', botUsername: 'RinaBot' },
    message: { message_id: 3, text: 'rina nsfw random' },
    text: 'rina nsfw random'
  });
  assert.ok(nsfwRandomCalled, 'nsfwScreen.handle("random") must be triggered for cloned bot');
  assert.equal(nsfwRandomCalled.category, 'all');

  // 4. "lancy search nsfw" without character -> executes top picks
  nsfwExecuted = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy', botUsername: 'Lancy_easy_bot' },
    message: { message_id: 4, text: 'lancy search nsfw' },
    text: 'lancy search nsfw'
  });
  assert.ok(nsfwExecuted, 'nsfwScreen.executeSearch must be triggered for search nsfw');
  assert.equal(nsfwExecuted.query, 'waifu');

  // 5. "open nsfw" -> opens menu
  nsfwOpened = false;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy', botUsername: 'Lancy_easy_bot' },
    message: { message_id: 5, text: 'open nsfw' },
    text: 'open nsfw'
  });
  assert.equal(nsfwOpened, true, 'nsfwScreen.open must be called on "open nsfw"');

  db.close();
});

test('LancyAssistant: Music intent handles "play sososo song", "play starboy", and cleans trailing/leading song keywords', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);

  let downloadedQuery = null;
  let dlForceNew = false;
  let playPromptOpened = false;

  const mockDownloader = {
    executeDownload: async (ctx, query) => {
      downloadedQuery = query;
      dlForceNew = ctx.forceNew;
      return { message_id: 701 };
    },
    handle: async (ctx, action) => {
      if (action === 'play') {
        playPromptOpened = true;
        return { message_id: 702 };
      }
    }
  };

  app.telegram.screens.set('downloader', mockDownloader);
  const assistant = new LancyAssistant({ app });

  // 1. "lancy play sososo song" -> strips "song" and downloads "sososo"
  downloadedQuery = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy' },
    message: { message_id: 1, text: 'lancy play sososo song' },
    text: 'lancy play sososo song'
  });
  assert.equal(downloadedQuery, 'sososo');
  assert.equal(dlForceNew, true);

  // 2. "rina play starboy" on clone bot -> downloads "starboy"
  downloadedQuery = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Rina', botUsername: 'RinaBot' },
    message: { message_id: 2, text: 'rina play starboy' },
    text: 'rina play starboy'
  });
  assert.equal(downloadedQuery, 'starboy');
  assert.equal(dlForceNew, true);

  // 3. "stream die with a smile" -> downloads "die with a smile"
  downloadedQuery = null;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy' },
    message: { message_id: 3, text: 'stream die with a smile' },
    text: 'stream die with a smile'
  });
  assert.equal(downloadedQuery, 'die with a smile');

  // 4. "lancy play" without song title -> opens interactive music search prompt
  playPromptOpened = false;
  await assistant.handleMessage({
    ctx: { tgId: '1001', chatId: 1001, botName: 'Lancy' },
    message: { message_id: 4, text: 'lancy play' },
    text: 'lancy play'
  });
  assert.equal(playPromptOpened, true, 'Calling "play" without query should open music search prompt');

  db.close();
});

test('LancyAssistant: LLM action tags [ACTION: search_nsfw ...] trigger nsfwScreen', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);

  let nsfwExecuted = null;
  let nsfwRandom = null;
  const mockNsfwScreen = {
    executeSearch: async (ctx, query, category) => {
      nsfwExecuted = { query, category };
    },
    handle: async (ctx, action, args) => {
      if (action === 'random') {
        nsfwRandom = { category: args[0] };
      }
    }
  };

  app.telegram.screens.set('nsfw', mockNsfwScreen);
  const assistant = new LancyAssistant({ app });

  let repliedText = '';
  const sctx = {
    tgId: '1001',
    chatId: 1001,
    botName: 'Lancy',
    reply: async (t) => { repliedText = t; }
  };

  // Conversational message triggering action tag from mock AI
  await assistant.handleMessage({
    ctx: sctx,
    message: { message_id: 1, text: 'tell me about your favorite waifu' },
    text: 'tell me about your favorite waifu'
  });

  assert.ok(nsfwExecuted, 'Action tag search_nsfw should execute nsfwScreen.executeSearch');
  assert.equal(nsfwExecuted.query, 'tifa');
  assert.equal(nsfwExecuted.category, 'hentai_uncensored');
  assert.ok(!repliedText.includes('[ACTION:'), 'Action tag should be stripped from visible reply');

  db.close();
});
