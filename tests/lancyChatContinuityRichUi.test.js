import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';
import {
  normalizeDisplayName,
  buildTelegramMention,
  getTimeOfDayContext,
  UserTasteStore
} from '../src/ai/userProfile.js';
import { encodeCallback } from '../src/telegram/rich.js';

test('normalizeDisplayName cleans Unicode calligraphy/symbols and builds native Telegram mention', () => {
  assert.equal(normalizeDisplayName('⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾'), 'Pappy');
  assert.equal(normalizeDisplayName('✨ Alex Rivera 🖤'), 'Alex');
  const mention = buildTelegramMention({ tgId: 5551, user: { id: 5551, first_name: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾' } });
  assert.equal(mention.text, 'Pappy');
  assert.equal(mention.rich.type, 'url');
  assert.equal(mention.rich.url, 'tg://user?id=5551');
  assert.match(mention.html, /tg:\/\/user\?id=5551/);
});

test('getTimeOfDayContext accurately distinguishes morning, afternoon, evening, and late night in WAT', () => {
  // Africa/Lagos is UTC+1
  assert.equal(getTimeOfDayContext('Africa/Lagos', new Date('2026-11-18T08:00:00Z')).period, 'morning');     // 09:00 WAT
  assert.equal(getTimeOfDayContext('Africa/Lagos', new Date('2026-11-18T13:30:00Z')).period, 'afternoon');   // 14:30 WAT
  assert.equal(getTimeOfDayContext('Africa/Lagos', new Date('2026-11-18T18:30:00Z')).period, 'evening');     // 19:30 WAT
  assert.equal(getTimeOfDayContext('Africa/Lagos', new Date('2026-11-18T23:30:00Z')).period, 'late_night');  // 00:30 WAT
});

test('UserTasteStore persists user music and movie preferences across sessions', () => {
  const db = new Database(':memory:');
  const taste = new UserTasteStore({ db });
  taste.recordPreference({ userId: 5551, chatId: -10077, displayName: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾', artist: 'Ayo Maff', genre: 'Afrobeats' });
  taste.recordPreference({ userId: 5551, chatId: -10077, artist: 'Ayra Starr' });
  taste.recordPreference({ userId: 5551, chatId: -10077, artist: 'Ayo Maff', movieTitle: 'Inception (2010)' });

  const profile = taste.getProfile(5551, -10077);
  assert.equal(profile.displayName, 'Pappy');
  assert.equal(profile.topArtists[0], 'Ayo Maff');
  assert.ok(profile.topArtists.includes('Ayra Starr'));
  assert.ok(profile.recentMovies.includes('Inception (2010)'));
  assert.match(taste.formatPromptSummary(5551, -10077), /Ayo Maff/);
});

test('Chat DJ stays continuously interactive: tags Pappy with Rich Card, handles "I\'ll want ayo maff", launches poll without closing, and shows typing indicator', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  let nextMsgId = 900;
  const apiCalls = [];
  const chatActions = [];
  const pollsSent = [];
  const playedTracks = [];

  const api = {
    me: { id: 100, username: 'Lancy_easy_bot' },
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    answerCallbackQuery: async () => ({ ok: true }),
    sendChatAction: async (chatId, action) => {
      chatActions.push({ chatId, action });
      return true;
    },
    sendRichMessage: async (chatId, rich) => {
      const message_id = ++nextMsgId;
      apiCalls.push({ op: 'sendRichMessage', chatId, message_id, rich });
      return { message_id, chat: { id: chatId } };
    },
    sendMessage: async (chatId, text, opts = {}) => {
      const message_id = ++nextMsgId;
      apiCalls.push({ op: 'sendMessage', chatId, message_id, text, opts });
      return { message_id, chat: { id: chatId }, text };
    },
    sendPoll: async (chatId, question, options, opts = {}) => {
      const message_id = ++nextMsgId;
      pollsSent.push({ chatId, message_id, question, options, opts });
      return { message_id, poll: { id: `poll_${message_id}`, question } };
    },
    getChatMember: async () => ({ status: 'administrator' }),
    getChat: async (id) => ({ id, type: 'supergroup', title: 'Lemonade Domain' })
  };

  const session = {
    chatId: -100777,
    connected: true,
    status: 'playing',
    activeDeck: 'music',
    volume: 100,
    upcoming: [],
    movieUpcoming: [],
    currentTrack: { title: 'Water', artist: 'Tems', durationSeconds: 200 }
  };

  let aiStep = 0;
  const app = {
    db,
    settings,
    sm,
    telegram: { api, botUsername: 'Lancy_easy_bot', botName: 'Lancy' },
    musicProviders: {
      get: () => ({
        search: async (q) => [{ id: 'tr1', title: `${q} - Dealer`, artist: 'Ayo Maff', durationSeconds: 185 }]
      })
    },
    musicQueueManager: {
      sessions: new Map([[-100777, session]]),
      getSession: () => session,
      playImmediateAndContinue: async (_id, track) => {
        playedTracks.push(track);
        session.currentTrack = track;
        return { track };
      },
      addMany: async (_id, tracks) => {
        playedTracks.push(...tracks);
      }
    },
    music: {
      botKey: () => 'default',
      destination: () => -100777,
      authorize: async () => -100777,
      player: async () => {},
      aiDj: { chatWithDj: async () => ({ reply: 'Vibing!', added: [] }) }
    },
    ai: {
      generate: async () => ({ provider: 'builtin', text: '' }),
      chatWithTools: async ({ messages }) => {
        aiStep++;
        const lastMsg = messages.at(-1);
        if (lastMsg?.role === 'tool') {
          const parsed = (() => { try { return JSON.parse(lastMsg.content); } catch { return {}; } })();
          if (parsed.cardKind === 'poll') {
            return { provider: 'ollama', text: 'Dropped that poll in chat for you, Pappy! Anything else you want queued meanwhile?', toolCalls: [] };
          }
          return { provider: 'ollama', text: `Spinning ${parsed.title || 'that'} for you now, Pappy! What next?`, toolCalls: [] };
        }
        const lastUser = lastMsg?.content || '';
        if (aiStep === 1 && /afro/i.test(lastUser)) {
          return { provider: 'ollama', text: 'Ooh Tems & Joeboy are fire! Want me to drop some GIVĒON or Ayo Maff next?', toolCalls: [] };
        }
        if (/ayo\s+maff/i.test(lastUser)) {
          return {
            provider: 'ollama',
            text: '',
            toolCalls: [{ function: { name: 'search_and_play_music', arguments: { query: 'Ayo Maff', action: 'play_now' } } }]
          };
        }
        if (/poll/i.test(lastUser)) {
          return {
            provider: 'ollama',
            text: '',
            toolCalls: [{ function: { name: 'create_decision_poll', arguments: { question: 'Who next after Ayo Maff?', options: ['Ayra Starr', 'Tems', 'GIVĒON'] } } }]
          };
        }
        return {
          provider: 'ollama',
          text: 'Dropped that right into the chat! What are we feeling next, Pappy?',
          toolCalls: []
        };
      }
    }
  };

  app.lancyAgent = new LancyAgent({ app });
  const screens = new Map();
  const musicScreen = createMusicScreen({ app });
  screens.set('music', musicScreen);
  const controller = new TelegramController({ api, db, settings, sm, screens, app });
  musicScreen.registerStateHandlers(sm);

  const pappyUser = { id: 5551, first_name: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾' };

  // Step 1: User clicks Chat DJ -> sends personalized Rich Card tagging Pappy + keeps state open
  await controller.handleUpdate({
    callback_query: {
      id: 'cb1',
      from: pappyUser,
      message: { message_id: 500, chat: { id: -100777, type: 'supergroup', title: 'Lemonade Domain' }, date: 1700000000 },
      data: encodeCallback('music', 'prompt', 'dj', 0)
    }
  });
  const opener = apiCalls.find(c => c.op === 'sendRichMessage');
  assert.ok(opener, 'Chat DJ opener must send a Rich UI card');
  const openerJson = JSON.stringify(opener.rich);
  assert.ok(openerJson.includes('Pappy') && openerJson.includes('tg://user?id=5551'), 'Must tag Pappy cleanly with Telegram mention');
  assert.ok(chatActions.some(a => a.action === 'typing'), 'Must trigger typing indicator');
  assert.equal(sm.state('5551'), States.MUSIC_QUEUE_INPUT);

  // Step 2: Turn 1 (Afrobeats remark) -> reply sent AND state stays OPEN
  await controller.handleUpdate({
    message: {
      message_id: 7001,
      from: pappyUser,
      chat: { id: -100777, type: 'supergroup' },
      reply_to_message: { message_id: opener.message_id, from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: "Nigeria's Afro beats are hot with Tems at #2"
    }
  });
  const turn1Card = apiCalls.at(-1);
  assert.equal(turn1Card.op, 'sendRichMessage');
  assert.equal(sm.state('5551'), States.MUSIC_QUEUE_INPUT, 'Conversation MUST continue after Turn 1!');

  // Step 3: Turn 2 ("I'll want ayo maff") replying to Turn 1's card -> plays Ayo Maff, saves taste, stays OPEN!
  await controller.handleUpdate({
    message: {
      message_id: 7002,
      from: pappyUser,
      chat: { id: -100777, type: 'supergroup' },
      reply_to_message: { message_id: turn1Card.message_id, from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: "I'll want ayo maff"
    }
  });
  assert.equal(playedTracks.length, 1);
  assert.equal(playedTracks[0].artist, 'Ayo Maff');
  assert.ok(app.lancyAgent.taste.getProfile(5551, -100777).topArtists.includes('Ayo Maff'));
  assert.equal(sm.state('5551'), States.MUSIC_QUEUE_INPUT, 'Conversation MUST stay open after playing Ayo Maff!');

  const turn2Card = apiCalls.at(-1);

  // Step 4: Turn 3 ("drop a poll") -> fires sendPoll AND conversation STILL stays open!
  await controller.handleUpdate({
    message: {
      message_id: 7003,
      from: pappyUser,
      chat: { id: -100777, type: 'supergroup' },
      reply_to_message: { message_id: turn2Card.message_id, from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: 'drop a poll for who next'
    }
  });
  assert.equal(pollsSent.length, 1);
  assert.deepEqual(pollsSent[0].options, ['Ayra Starr', 'Tems', 'GIVĒON']);
  assert.equal(sm.state('5551'), States.MUSIC_QUEUE_INPUT, 'Conversation MUST continue even after creating a poll!');

  // Step 5: User says "done" -> closes cleanly
  await controller.handleUpdate({
    message: {
      message_id: 7004,
      from: pappyUser,
      chat: { id: -100777, type: 'supergroup' },
      reply_to_message: { message_id: apiCalls.at(-1).message_id, from: { id: 100, is_bot: true, username: 'Lancy_easy_bot' } },
      text: 'done'
    }
  });
  assert.notEqual(sm.state('5551'), States.MUSIC_QUEUE_INPUT);
});
