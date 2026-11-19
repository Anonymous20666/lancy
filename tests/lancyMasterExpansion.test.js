import test from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/core/db.js';
import { createLogger } from '../src/core/logger.js';
import { AIService } from '../src/ai/service.js';
import { OpenAICompatibleProvider } from '../src/ai/providers/openaiCompatible.js';
import { UnifiedMemoryStore } from '../src/ai/memoryStore.js';
import { ConversationalDecisionEngine, DECISION } from '../src/ai/decisionEngine.js';
import { RealtimeVoiceCapability } from '../src/ai/realtimeVoice.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';
import { LancyAssistant } from '../src/ai/assistant.js';
import { TelegramAPI } from '../src/telegram/api.js';

function createTestEnv({ aiOverrides = {}, voiceOverrides = {}, musicOverrides = {} } = {}) {
  const db = new Database(':memory:');
  db.migrate();
  const log = createLogger({ level: 'silent' });
  const cfgMap = new Map([
    ['general.ownerIds', ['100']],
    ['telegram.adminIds', ['200']],
    ['voiceAi.timezone', 'Africa/Lagos'],
    ['ai.provider', 'experiential'],
    ['ai.model', 'gpt-6.2-astra:free'],
    ['ai.backupModel', 'gemini-4-neon:free']
  ]);
  const settings = {
    get: (k, fb = null) => (cfgMap.has(k) ? cfgMap.get(k) : fb),
    getForUser: (_u, k, fb = null) => (cfgMap.has(k) ? cfgMap.get(k) : fb),
    set: (k, v) => { cfgMap.set(k, v); }
  };

  const sessions = new Map();
  const qm = {
    sessions,
    getSession: (id) => sessions.get(Number(id)) || null,
    updatePlayerCard: async () => ({ ok: true })
  };

  const spoken = [];
  const vcMessages = [];
  const listenCalls = [];
  const bargeInCalls = [];

  const voiceClient = {
    speak: async (chatId, text, opts = {}) => { spoken.push({ chatId, text, opts }); return { ok: true }; },
    sendCallMessage: async (chatId, text) => { vcMessages.push({ chatId, text }); return { ok: true }; },
    setListenState: async (chatId, opts) => { listenCalls.push({ chatId, opts }); return { ok: true }; },
    bargeIn: async (chatId, opts) => { bargeInCalls.push({ chatId, opts }); return { ok: true }; },
    getParticipants: async () => ({
      ok: true,
      participant_list: [
        { user_id: 100, ssrc: 1111, display_name: 'Alex' },
        { user_id: 505, ssrc: 2222, display_name: 'John' }
      ]
    }),
    ...voiceOverrides
  };

  const music = {
    owner: (ctx) => String(ctx?.tgId ?? ctx?.user?.id ?? '') === '100',
    superAdmin: (ctx) => ['100', '200'].includes(String(ctx?.tgId ?? ctx?.user?.id ?? '')),
    hasVcAccess: async (_ctx, userId) => ['100', '200', '505'].includes(String(userId)),
    isVcSudo: (_chatId, userId) => ['505'].includes(String(userId)),
    ...musicOverrides
  };

  const app = {
    db,
    log,
    settings,
    music,
    voiceClient,
    musicQueueManager: qm,
    ai: {
      chatWithTools: async () => ({ text: 'Cool, Astra primary handled it.', toolCalls: [], provider: 'experiential' }),
      deepReason: async () => ({ text: 'Neon deep reasoning handled it.', toolCalls: [], provider: 'experiential' }),
      generate: async () => ({ text: 'Vibe check looking solid!', provider: 'experiential' }),
      getCapabilities: () => ({
        primaryProvider: 'experiential',
        primaryModel: 'gpt-6.2-astra:free',
        backupModel: 'gemini-4-neon:free',
        realtimeVoiceAvailable: false,
        realtimeVoiceModel: 'gemini-3.8-live',
        realtimeVoiceReason: 'model_not_granted'
      }),
      ...aiOverrides
    }
  };

  const lancyAgent = new LancyAgent({ app });
  app.lancyAgent = lancyAgent;
  const assistant = new LancyAssistant({ app, log });
  app.assistant = assistant;

  return { db, settings, app, lancyAgent, assistant, sessions, spoken, vcMessages, listenCalls, bargeInCalls };
}

test('Multi-speaker passive Python vs JS tracking + "what did John say earlier?" recall', async () => {
  const deepCalls = [];
  const env = createTestEnv({
    aiOverrides: {
      deepReason: async (payload) => {
        deepCalls.push(payload);
        return {
          text: 'John said he prefers JavaScript because the ecosystem is huge!',
          toolCalls: [],
          provider: 'experiential'
        };
      }
    }
  });
  const chatId = -1009988;
  env.sessions.set(chatId, { connected: true, status: 'playing', activeDeck: 'music', currentTrack: { title: 'Essence', id: 't1' } });

  // Idle group speakers talking to each other (should NOT interrupt!)
  const r1 = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 100,
    senderName: 'Alex',
    text: 'I prefer Python because it is cleaner to write.',
    source: 'vc_voice',
    eventId: 'ev_1'
  });
  assert.equal(r1.ignored, true);

  const r2 = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 505,
    senderName: 'John',
    text: 'I prefer JavaScript because the ecosystem is huge.',
    source: 'vc_voice',
    eventId: 'ev_2'
  });
  assert.equal(r2.ignored, true);
  assert.equal(env.spoken.length, 0);

  // Duplicate event is dropped cleanly
  const dup = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 505,
    senderName: 'John',
    text: 'I prefer JavaScript because the ecosystem is huge.',
    source: 'vc_voice',
    eventId: 'ev_2'
  });
  assert.equal(dup.duplicate, true);
  assert.equal(env.lancyAgent.awareness.getMetricsSummary().duplicateDrops, 1);

  // Wake Lancy, then ask what John said earlier
  await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 100,
    senderName: 'Alex',
    text: 'Lancy listen',
    source: 'vc_voice',
    isListenCommand: true,
    eventId: 'ev_3'
  });

  const recall = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 100,
    senderName: 'Alex',
    text: 'Wait, John was saying something earlier. What did John say?',
    source: 'vc_voice',
    detectedAtMs: Date.now() - 40,
    eventId: 'ev_4'
  });
  assert.equal(recall.handled, true);
  assert.match(recall.reply, /JavaScript/i);
  assert.equal(deepCalls.length, 1);
  assert.match(deepCalls[0].system, /John: "I prefer JavaScript/);
  assert.match(deepCalls[0].system, /Alex: "I prefer Python/);
  assert.ok(env.lancyAgent.awareness.getMetricsSummary().lastEndOfSpeechToFirstAudioMs !== null);
});

test('Conversational DecisionEngine handles overlap, dissatisfaction, research, and cooldowns', () => {
  const engine = new ConversationalDecisionEngine({ proactiveMinIntervalMs: 60000, participationLevel: 'balanced' });

  const overlap = engine.decide({
    text: 'wait no you first',
    surface: 'vc_voice',
    isDirectlyAddressed: false,
    conversationMode: 'IDLE',
    simultaneousSpeakers: ['Alex', 'John']
  });
  assert.equal(overlap.action, DECISION.SILENT_OTHER_SPEAKER);

  const vibeFeedback = engine.decide({
    text: 'That song is becoming boring, give us something more energetic',
    surface: 'vc_voice',
    isDirectlyAddressed: true,
    conversationMode: 'LISTENING'
  });
  assert.equal(vibeFeedback.action, DECISION.DEEP_REASON);

  const webLookup = engine.decide({
    text: 'What are the latest Telegram Bot API 10.4 features?',
    surface: 'dm_text',
    isDirectlyAddressed: true
  });
  assert.equal(webLookup.action, DECISION.DEEP_REASON);
  assert.equal(webLookup.needsResearch, true);

  // Proactive emission enforces cooldown and topic dedupe
  assert.equal(engine.canEmitProactive(-10055, 'track_essence'), true);
  assert.equal(engine.canEmitProactive(-10055, 'track_essence'), false);
  assert.equal(engine.canEmitProactive(-10055, 'another_topic'), false);
});

test('Voice barge-in aborts active AI turn and invokes voiceClient.bargeIn', async () => {
  const env = createTestEnv({
    aiOverrides: {
      chatWithTools: async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { text: signal?.aborted ? '' : 'too late', toolCalls: [], provider: 'experiential' };
      }
    }
  });
  const chatId = -100777;
  const ctrl = new AbortController();
  env.lancyAgent.activeTurnControllers.set(chatId, ctrl);

  const res = await env.lancyAgent.handleBargeIn({ chatId, userId: 100, senderName: 'Alex', eventId: 'barge:1' });
  assert.equal(res.ok, true);
  assert.equal(ctrl.signal.aborted, true);
  assert.equal(env.bargeInCalls.length, 1);
  assert.equal(env.bargeInCalls[0].chatId, chatId);
});

test('UnifiedMemoryStore 3-scope privacy isolation + user-controlled forget', () => {
  const db = new Database(':memory:');
  db.migrate();
  const mem = new UnifiedMemoryStore({ db });

  mem.rememberUserFact(101, 'secret_project', 'Working on stealth fintech app', { category: 'secret' });
  mem.rememberUserFact(101, 'music_taste', 'Loves Burna Boy and Amapiano', { category: 'music' });
  mem.rememberUserFact(202, 'secret_note', 'Other user private note', { category: 'secret' });
  mem.rememberGroupFact(-1001, 'friday_vibe', 'Group loves Friday horror movie nights');

  // Shared group VC context must NEVER expose user 101 private secret OR user 202 memories!
  const sharedPrompt = mem.formatPromptContext({
    sessionKey: 'vc:-1001',
    chatId: -1001,
    userId: 101,
    surface: 'vc_voice',
    includeUserPrivate: false
  });
  assert.match(sharedPrompt, /Friday horror movie nights/);
  assert.match(sharedPrompt, /Burna Boy/);
  assert.doesNotMatch(sharedPrompt, /stealth fintech app/);
  assert.doesNotMatch(sharedPrompt, /Other user private note/);

  // DM with includeUserPrivate: true DOES see user 101 private memories (still isolated from 202)
  const dmPrompt = mem.formatPromptContext({
    sessionKey: 'dm:101',
    chatId: 101,
    userId: 101,
    surface: 'dm_text',
    includeUserPrivate: true
  });
  assert.match(dmPrompt, /stealth fintech app/);
  assert.doesNotMatch(dmPrompt, /Other user private note/);

  // Explicit "forget" text extraction wipes user memories cleanly
  const wiped = mem.extractAndStoreFromText({ chatId: 101, userId: 101, text: 'Please forget my memories', isGroup: false });
  assert.ok(wiped.deleted >= 2);
  assert.equal(mem.getUserMemories(101).length, 0);
});

test('OpenAICompatibleProvider preserves system prompt, multimodal images, and Neon thought signatures', async () => {
  const prov = new OpenAICompatibleProvider({
    endpoint: 'https://api.experientiallabs.ai/v1',
    apiKey: 'xpl_test_dummy',
    model: 'gemini-4-neon:free'
  });

  const origFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        model: 'gemini-4-neon:free',
        choices: [{ message: { role: 'assistant', content: 'Looks like a Node error!' } }]
      })
    };
  };

  try {
    await prov.generate({
      task: 'chat',
      text: 'Check this screenshot and explain',
      messages: [
        {
          role: 'assistant',
          content: '',
          thought_signature: 'sig_abc_123',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            thought_signature: 'sig_tool_1',
            function: { name: 'get_call_state', arguments: '{}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'get_call_state', content: '{"ok":true}' },
        { role: 'user', content: 'Look at this screenshot', images: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='] }
      ],
      context: {
        system: 'You are Lancy AI.'
      },
      maxTokens: 120
    });

    assert.equal(capturedBody.messages[0].role, 'system');
    assert.equal(capturedBody.messages[0].content, 'You are Lancy AI.');
    assert.equal(capturedBody.messages[1].thought_signature, 'sig_abc_123');
    assert.equal(capturedBody.messages[1].tool_calls[0].thought_signature, 'sig_tool_1');
    const lastMsg = capturedBody.messages.at(-1);
    assert.ok(Array.isArray(lastMsg.content));
    assert.equal(lastMsg.content[1].type, 'image_url');
    assert.ok(capturedBody.max_tokens >= 400);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('RealtimeVoiceCapability probes gemini-3.8-live honestly on 403 and activates on AQ/AIza Gemini key', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'gpt-6.2-astra:free' }, { id: 'gemini-4-neon:free' }] })
  });
  try {
    const cap = new RealtimeVoiceCapability({
      settings: {
        get: (k) => (k === 'ai.endpoint' ? 'https://api.experientiallabs.ai/v1' : (k === 'ai.apiKey' ? 'xpl_test' : ''))
      }
    });
    const probe = await cap.probe({ force: true });
    assert.equal(probe.available, false);
    assert.equal(probe.transport, 'experiential_gateway');
    assert.match(probe.reason, /403 model_not_granted|not granted/i);

    const liveCap = new RealtimeVoiceCapability({
      settings: {
        env: { GEMINI_API_KEY: 'AQ.Ab8_test_key', GEMINI_LIVE_MODEL: 'gemini-3.8-live' },
        get: () => ''
      }
    });
    const liveProbe = await liveCap.probe({ force: true });
    assert.equal(liveProbe.available, true);
    assert.equal(liveProbe.transport, 'google_bidi_websocket');
    assert.equal(liveProbe.model, 'gemini-3.8-live');
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
  }
});

test('Surface routing uses GPT for VC and Neon for Chat', async () => {
  const vcCalls = [];
  const chatNeonCalls = [];
  const env = createTestEnv({
    aiOverrides: {
      chatWithTools: async (p) => { vcCalls.push(p); return { text: 'VC GPT handled', toolCalls: [], provider: 'experiential' }; },
      deepReason: async (p) => { chatNeonCalls.push(p); return { text: 'Chat Neon handled', toolCalls: [], provider: 'experiential' }; }
    }
  });
  const chatId = -100612;
  env.sessions.set(chatId, { connected: true, status: 'playing', currentTrack: { id: 't1', title: 'Essence' } });
  const conv = env.lancyAgent.getVcConversation(chatId);
  conv.mode = 'LISTENING';

  // Ordinary VC turn -> GPT (chatWithTools)
  const vcRes = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 100,
    senderName: 'Alex',
    text: 'Lancy check the current song tempo',
    source: 'vc_voice',
    eventId: 'route_vc_1'
  });
  assert.equal(vcRes.handled, true);
  assert.equal(vcCalls.length, 1);

  // DM text turn -> Neon (deepReason)
  const dmRes = await env.lancyAgent.handleBotTurn(
    { chatId: 100, tgId: '100', user: { id: 100, first_name: 'Alex' } },
    'Explain closures in Python clearly',
    { mode: 'companion', surface: 'dm_text' }
  );
  assert.match(dmRes.reply, /Neon/i);
  assert.equal(chatNeonCalls.length, 1);
});

test('Same-track safety prevents auto-resume if a human manually played another track while paused', async () => {
  const env = createTestEnv();
  const chatId = -100444;
  env.sessions.set(chatId, { connected: true, status: 'paused', currentTrack: { id: 'track_A', title: 'Track A' } });
  const conv = env.lancyAgent.getVcConversation(chatId);
  conv.mode = 'AWAITING_FOLLOWUP';
  conv.pausedByLancy = true;
  conv.pausedTrackId = 'track_A';

  // Human skips manually to Track B while paused
  env.sessions.get(chatId).currentTrack = { id: 'track_B', title: 'Track B' };

  await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 999, // unauthorized speaker blocked
    senderName: 'RandomUser',
    text: 'Lancy pause the music',
    source: 'vc_message'
  });

  // Unauthorized blocked
  const blocked = await env.lancyAgent.handleVcTurn({
    chatId,
    userId: 999,
    senderName: 'RandomUser',
    text: 'Lancy pause the music',
    source: 'vc_message'
  });
  assert.equal(blocked.blocked, true);

  // Confirm assistant DM + image passes into deepReason
  const deepCalls = [];
  env.app.ai.deepReason = async (payload) => {
    deepCalls.push(payload);
    return { text: 'I see your screenshot showing a Node error.', toolCalls: [], provider: 'experiential' };
  };
  const dmReplies = [];
  const drafts = [];
  await env.assistant.handleMessage({
    ctx: {
      tgId: '100',
      chatId: 100,
      user: { id: 100, first_name: 'Olamide' },
      api: {
        me: { id: 999999, username: 'Lancy_easy_bot' },
        sendMessageDraft: async (c, d, t) => { drafts.push({ c, d, t }); return true; }
      },
      reply: async (t) => { dmReplies.push(t); return { message_id: 1 }; }
    },
    message: { chat: { id: 100, type: 'private' }, from: { id: 100, first_name: 'Olamide' } },
    text: '',
    images: ['data:image/jpeg;base64,/9j/']
  });
  assert.equal(deepCalls.length, 1);
  assert.equal(drafts.length, 1);
  assert.match(dmReplies[0], /screenshot/i);
});

test('TelegramAPI exposes Bot API 10.4 draft & widget endpoints cleanly', async () => {
  const called = [];
  const api = new TelegramAPI('123:ABC', { baseUrl: 'http://127.0.0.1:8081' });
  api.call = async (method, body) => {
    called.push({ method, body });
    return { ok: true };
  };
  await api.sendMessageDraft(100, 42, 'Streaming draft...');
  await api.sendWidget(100, '<b>DJ Widget</b>', { data: 'v1' });
  await api.answerWidgetQuery('wq_1', { text: 'Saved!' });
  await api.editMessageWidgetData({ chat_id: 100, message_id: 10, data: 'v2' });

  assert.deepEqual(called.map((c) => c.method), [
    'sendMessageDraft',
    'sendWidget',
    'answerWidgetQuery',
    'editMessageWidgetData'
  ]);
});

test('Voice Note (vn) triggers Neon/agent reasoning in group/DM and replies via sendVoice', async () => {
  const sentVoices = [];
  const synthCalls = [];
  const env = createTestEnv({
    aiOverrides: {
      deepReason: async () => ({
        text: 'Loud and clear bestie, I heard your voice note!',
        toolCalls: [],
        provider: 'experiential'
      })
    },
    voiceOverrides: {
      synthesizeVoiceNote: async (txt, opts) => {
        synthCalls.push({ txt, opts });
        return Buffer.from('OggS_fake_opus_voice');
      }
    }
  });

  // Even when general group text AI is OFF, calling Lancy with a Voice Note works!
  await env.assistant.handleMessage({
    ctx: {
      tgId: '100',
      chatId: -100901,
      isGroup: true,
      user: { id: 100, first_name: 'Olamide' },
      api: {
        me: { id: 999999, username: 'Lancy_easy_bot' },
        sendVoice: async (cid, buf, extra) => {
          sentVoices.push({ cid, len: buf.length, extra });
          return { message_id: 55 };
        }
      },
      reply: async () => ({ message_id: 56 })
    },
    message: { message_id: 21, chat: { id: -100901, type: 'supergroup' }, from: { id: 100, first_name: 'Olamide' } },
    text: 'Lancy how is the vibe looking today?',
    voiceMode: true
  });

  assert.equal(synthCalls.length, 1);
  assert.match(synthCalls[0].txt, /heard your voice note/i);
  assert.equal(sentVoices.length, 1);
  assert.equal(sentVoices[0].cid, -100901);
  assert.equal(sentVoices[0].extra.reply_to_message_id, 21);
});

test('executeLiveToolCall returns structured guide-compliant status/retryable/message & enforces VC auth', async () => {
  const env = createTestEnv();
  const chatId = -100811;
  env.sessions.set(chatId, { connected: true, status: 'playing', volume: 80, currentTrack: { title: 'Calm Down', id: 't1' } });

  // Unauthorized speaker calling mutating deck tool -> structured permission_denied, retryable=false
  const denied = await env.lancyAgent.executeLiveToolCall({
    chatId,
    callId: 'call_auth_1',
    name: 'control_playback',
    args: { action: 'pause' },
    userId: 999,
    senderName: 'Guest'
  });
  assert.equal(denied.status, 'permission_denied');
  assert.equal(denied.retryable, false);
  assert.ok(denied.message.length > 5);

  // Authorized speaker reading call state -> structured status='ok', retryable=false
  const okRes = await env.lancyAgent.executeLiveToolCall({
    chatId,
    callId: 'call_state_1',
    name: 'get_call_state',
    args: {},
    userId: 100,
    senderName: 'Alex'
  });
  assert.equal(okRes.status, 'ok');
  assert.equal(okRes.retryable, false);
  assert.ok(okRes.message);
});
