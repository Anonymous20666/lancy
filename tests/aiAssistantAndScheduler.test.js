import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { LancyAssistant } from '../src/ai/assistant.js';
import { AutonomousScheduler } from '../src/ai/scheduler.js';
import { WebBrowser } from '../src/ai/browse.js';

function makeMockApp(db) {
  return {
    db,
    settings: {
      get: (key) => 'girly',
      getForUser: (userId, key, fallback) => fallback
    },
    ai: {
      generate: async ({ text }) => ({ text: `♡ As Lancy: ${text} ♡`, provider: 'mock' })
    },
    pinterest: {
      search: async () => ({ searchId: 1, results: [] }),
      markResultsDelivered: () => {}
    },
    whatsapp: {
      listSessions: () => [{ userId: 1001, sessionId: 'sess_1', status: 'online' }]
    },
    channels: {
      list: () => [{ channel_jid: '1203634@newsletter', name: 'Test Channel' }]
    },
    publisher: {
      publish: async () => ({ ok: true })
    },
    media: {
      fetch: async () => Buffer.from('fake-image')
    },
    telegram: {
      api: {
        sendMessage: async () => ({ message_id: 999 }),
        sendChatAction: async () => true
      }
    }
  };
}

test('WebBrowser search and Wikipedia integration', async () => {
  const browser = new WebBrowser();
  // Wikipedia summary lookup
  const summary = await browser.getWikipediaSummary('Jujutsu Kaisen');
  assert.ok(summary);
  assert.match(summary.title, /Jujutsu Kaisen/i);
  assert.ok(summary.snippet.length > 0);
});

test('LancyAssistant conversation memory is strictly isolated per user', () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  const assistant = new LancyAssistant({ app });

  assistant.saveMessage(1001, 'user', 'Hey Lancy for Admin 1');
  assistant.saveMessage(1001, 'assistant', 'Hello Admin 1 ♡');

  assistant.saveMessage(2002, 'user', 'Hey Lancy for Admin 2');
  assistant.saveMessage(2002, 'assistant', 'Hello Admin 2 ♡');

  const hist1 = assistant.getHistory(1001);
  const hist2 = assistant.getHistory(2002);

  assert.equal(hist1.length, 2);
  assert.equal(hist1[0].content, 'Hey Lancy for Admin 1');

  assert.equal(hist2.length, 2);
  assert.equal(hist2[0].content, 'Hey Lancy for Admin 2');

  // Clearing history for user 1001 does not affect user 2002
  assistant.clearHistory(1001);
  assert.equal(assistant.getHistory(1001).length, 0);
  assert.equal(assistant.getHistory(2002).length, 2);

  db.close();
});

test('AutonomousScheduler creates, pauses, resumes and deletes schedules', () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  const scheduler = new AutonomousScheduler({ app });

  const sched = scheduler.createSchedule({
    userId: 1001,
    topic: 'Aura Farming Stickers',
    frequencyLabel: 'twice per day for 30 days',
    timesPerDay: 2,
    days: 30
  });

  assert.ok(sched.id);
  assert.equal(sched.topic, 'Aura Farming Stickers');
  assert.equal(sched.times_per_day, 2);
  assert.equal(sched.interval_hours, 12);
  assert.equal(sched.total_runs, 60);
  assert.equal(sched.runs_completed, 0);
  assert.equal(sched.status, 'active');

  // Pause
  const paused = scheduler.pauseSchedule(sched.id, 1001);
  assert.equal(paused.status, 'paused');

  // Resume
  const resumed = scheduler.resumeSchedule(sched.id, 1001);
  assert.equal(resumed.status, 'active');

  // List
  const list = scheduler.getUserSchedules(1001);
  assert.equal(list.length, 1);

  // Delete
  scheduler.deleteSchedule(sched.id, 1001);
  const emptyList = scheduler.getUserSchedules(1001);
  assert.equal(emptyList.length, 0);

  db.close();
});

test('LancyAssistant conversational schedule intent creates scheduled drop', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  app.scheduler = new AutonomousScheduler({ app });
  const assistant = new LancyAssistant({ app });

  let repliedText = '';
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    reply: async (txt) => { repliedText = txt; },
    api: app.telegram.api
  };

  await assistant.handleMessage({
    ctx,
    text: 'lancy post random aura farming stickers twice per day for 30 days'
  });

  assert.match(repliedText, /SCHEDULE LOCKED IN/);
  assert.match(repliedText, /2× daily for 30 days/);

  const schedules = app.scheduler.getUserSchedules(1001);
  assert.equal(schedules.length, 1);
  assert.match(schedules[0].topic, /aura farming/i);
  assert.equal(schedules[0].times_per_day, 2);
  assert.equal(schedules[0].total_runs, 60);

  db.close();
});

test('LancyAssistant handles drop navigation (next / don’t like this)', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  const assistant = new LancyAssistant({ app });

  // Seed a search
  db.run("INSERT INTO pinterest_searches (user_id, query, normalized_query) VALUES (1001, 'toji', 'toji')");

  let moreAlbumCalled = false;
  let repliedText = '';
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    reply: async (txt) => { repliedText = txt; },
    api: app.telegram.api,
    screens: new Map([
      ['pinterest', {
        handle: async (c, action) => {
          if (action === 'more_album') moreAlbumCalled = true;
        }
      }]
    ])
  };

  await assistant.handleMessage({
    ctx,
    text: 'I don’t like this one, give me next'
  });

  assert.ok(moreAlbumCalled);
  assert.match(repliedText, /Showing you the next batch/i);

  db.close();
});

test('LancyAssistant quotes the user message back on Telegram when replying', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  const assistant = new LancyAssistant({ app });

  let sentExtra = null;
  let sentText = '';
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    messageId: 42,
    message: { message_id: 42, text: 'Hey' },
    reply: async (txt, extra) => {
      sentText = txt;
      sentExtra = extra;
    },
    api: app.telegram.api
  };

  await assistant.handleMessage({
    ctx,
    message: { message_id: 42, text: 'Hey' },
    text: 'Hey'
  });

  assert.ok(sentText.length > 0);
  assert.ok(sentExtra);
  assert.equal(sentExtra.reply_parameters?.message_id, 42);
  assert.equal(sentExtra.reply_parameters?.allow_sending_without_reply, true);

  db.close();
});

test('LancyAssistant does not force @mention and naturally addresses user by name', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  app.ai = {
    generate: async ({ context }) => {
      // Verify prompt instructs never to use @mentions or offer coffee
      assert.match(context.system, /NEVER use @mentions/);
      assert.match(context.system, /NEVER offer physical food, coffee/);
      return { text: 'heyy Pappy! how are you today? ♡' };
    }
  };
  const assistant = new LancyAssistant({ app });

  let sentText = '';
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    user: { first_name: 'Pappy', username: 'holypappy' },
    reply: async (txt) => { sentText = txt; },
    api: app.telegram.api
  };

  await assistant.handleMessage({ ctx, text: 'Hey' });

  assert.ok(!sentText.includes('@holypappy'), 'should not contain @username tag');
  assert.match(sentText, /Pappy/);
  assert.match(sentText, /♡/);

  db.close();
});

test('LancyAssistant conversational "Send the pic" triggers search and resolves character from prior turns', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  const assistant = new LancyAssistant({ app });

  let searchTriggered = false;
  let searchArgs = null;
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    user: { first_name: 'Pappy' },
    sm: { transition: async () => {} },
    screens: new Map([
      ['pinterest', {
        handle: async (c, action, args) => {
          if (action === 'runCount') {
            searchTriggered = true;
            searchArgs = args;
          }
        }
      }]
    ]),
    reply: async () => {},
    api: app.telegram.api
  };

  // Turn 1 & 2 in memory: discussing Sung Jinwoo
  assistant.saveMessage(1001, 'user', 'Any latest anime mc');
  assistant.saveMessage(1001, 'assistant', 'Sung Jinwoo from Solo Leveling has the craziest aura! Want to see?');

  // Turn 3: User says "Send the pic"
  await assistant.handleMessage({ ctx, text: 'Send the pic' });

  assert.ok(searchTriggered, 'should trigger Pinterest search for "Send the pic"');
  assert.equal(searchArgs[2], 'Sung Jinwoo', 'should resolve character to Sung Jinwoo');

  db.close();
});

test('LancyAssistant parses [ACTION: search_images query="..."] from LLM generation and triggers search', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);
  app.ai = {
    generate: async () => ({
      text: 'Here is Gojo! His domain expansion is unreal ♡ [ACTION: search_images query="Gojo Satoru"]'
    })
  };
  const assistant = new LancyAssistant({ app });

  let searchTriggered = false;
  let searchArgs = null;
  let sentText = '';
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    user: { first_name: 'Pappy' },
    sm: { transition: async () => {} },
    screens: new Map([
      ['pinterest', {
        handle: async (c, action, args) => {
          if (action === 'runCount') {
            searchTriggered = true;
            searchArgs = args;
          }
        }
      }]
    ]),
    reply: async (txt) => { sentText = txt; },
    api: app.telegram.api
  };

  await assistant.handleMessage({ ctx, text: 'Who has the best eyes in anime?' });

  assert.ok(!sentText.includes('[ACTION:'), 'action tag must be stripped from user-facing text');
  assert.match(sentText, /Here is Gojo/);
  assert.ok(searchTriggered, 'action tag must trigger search');
  assert.equal(searchArgs[2], 'Gojo Satoru');

  db.close();
});

test('Telegram bot only invokes AI assistant when message quotes the bot (in private) or tags/quotes (in group)', async () => {
  const db = new Database(':memory:');
  const app = makeMockApp(db);

  function shouldTriggerAI(message, text, isPrivate = true, botUsername = 'Lancy_easy_bot', botId = 999) {
    const cleanBotName = botUsername.replace(/^@/, '');
    const replyFrom = message.reply_to_message?.from;
    const isQuote = Boolean(
      message.reply_to_message && (
        !replyFrom ||
        replyFrom.is_bot ||
        (botId && replyFrom.id === botId) ||
        (cleanBotName && replyFrom.username && replyFrom.username.toLowerCase() === cleanBotName.toLowerCase())
      )
    );
    const isTag = Boolean(
      /\blancy\b/i.test(text) ||
      new RegExp(`@?${cleanBotName}\\b`, 'i').test(text)
    );
    return isPrivate ? isQuote : (isQuote || isTag);
  }

  // 1. In private chat: Regular messages without quote -> must NOT trigger AI
  assert.equal(shouldTriggerAI({}, 'Hey', true), false);
  assert.equal(shouldTriggerAI({}, 'M good', true), false);
  assert.equal(shouldTriggerAI({}, 'What are you doing?', true), false);
  assert.equal(shouldTriggerAI({}, 'hey lancy', true), false, 'In private chat, unquoted text must not trigger AI');

  // 2. In private chat: Quoting the bot message -> triggers AI
  const quoteMsg = {
    reply_to_message: { from: { id: 999, is_bot: true, username: 'Lancy_easy_bot' } }
  };
  assert.equal(shouldTriggerAI(quoteMsg, 'M good', true), true);
  assert.equal(shouldTriggerAI(quoteMsg, 'Send the pic', true), true);

  // 3. In group chat: Tagging the bot -> triggers AI
  assert.equal(shouldTriggerAI({}, 'hey lancy', false), true);
  assert.equal(shouldTriggerAI({}, '@Lancy_easy_bot what is solo leveling?', false), true);
  assert.equal(shouldTriggerAI({}, 'Hey everyone', false), false);

  db.close();
});

test('LancyAssistant direct music play intent ("Play me juice wrld") safely resolves downloader and triggers download', async () => {
  const db = new Database(':memory:');
  let downloadedQuery = null;
  const mockDownloader = {
    executeDownload: async (ctx, query) => {
      downloadedQuery = query;
    }
  };

  const app = makeMockApp(db);
  app.telegram.screens = new Map([['downloader', mockDownloader]]);

  const assistant = new LancyAssistant({ app });

  let repliedText = null;
  const sctx = {
    tgId: '1001',
    chatId: 1001,
    reply: async (text) => { repliedText = text; }
  };

  await assistant.handleMessage({
    ctx: sctx,
    message: { message_id: 1, text: 'Play me juice wrld' },
    text: 'Play me juice wrld'
  });

  assert.equal(downloadedQuery, 'juice wrld', 'should clean leading "me" and download "juice wrld"');
  assert.ok(repliedText, 'should send confirmation reply');
  assert.match(repliedText, /Pulling "juice wrld"/);

  db.close();
});

test('LancyAssistant: systemPrompt includes complete end-to-end bot knowledge', async () => {
  const db = new Database(':memory:');
  let capturedSystemPrompt = null;
  const app = {
    db,
    settings: { get: () => 'girly', getForUser: () => 'girly' },
    ai: {
      generate: async ({ prompt, system, context }) => {
        capturedSystemPrompt = context?.system || system;
        return { text: 'Everything is in my knowledge bestie! ♡' };
      }
    },
    telegram: {
      screens: new Map(),
      api: { sendMessage: async () => ({ message_id: 1 }) }
    }
  };

  const assistant = new LancyAssistant({ app });
  const sctx = {
    tgId: '1001',
    chatId: 1001,
    reply: async () => {}
  };

  await assistant.handleMessage({
    ctx: sctx,
    message: { message_id: 1, text: 'What can you do on WhatsApp and how does the bot work?' },
    text: 'What can you do on WhatsApp and how does the bot work?'
  });

  assert.ok(capturedSystemPrompt, 'systemPrompt should be captured');
  assert.match(capturedSystemPrompt, /<bot_knowledge>/i);
  // Commands check
  assert.match(capturedSystemPrompt, /\/start/);
  assert.match(capturedSystemPrompt, /\/play/);
  assert.match(capturedSystemPrompt, /\/grab/);
  assert.match(capturedSystemPrompt, /\/search/);
  assert.match(capturedSystemPrompt, /\/stickers/);
  assert.match(capturedSystemPrompt, /\/whatsapp/);
  assert.match(capturedSystemPrompt, /\/clone/);
  assert.match(capturedSystemPrompt, /\/help/);
  // Screen buttons check
  assert.match(capturedSystemPrompt, /Pinterest Studio/);
  assert.match(capturedSystemPrompt, /TikTok Search/);
  assert.match(capturedSystemPrompt, /Send Audio File/);
  assert.match(capturedSystemPrompt, /Sticker Posting/);
  // WhatsApp DM vs Channel check
  assert.match(capturedSystemPrompt, /\.ping/);
  assert.match(capturedSystemPrompt, /\.menu/);
  assert.match(capturedSystemPrompt, /\.prefix/);
  assert.match(capturedSystemPrompt, /\.s|\.sticker/);
  assert.match(capturedSystemPrompt, /\.convert|\.cv/);
  assert.match(capturedSystemPrompt, /\.tg/);
  assert.match(capturedSystemPrompt, /@newsletter/);
  // TikTok inline search check
  assert.match(capturedSystemPrompt, /tt <query>/);

  db.close();
});

