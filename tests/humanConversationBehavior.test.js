import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Database } from '../src/core/db.js';
import { HumanBehaviorEngine, PARTICIPATION_POLICIES, RULE_PRIORITY } from '../src/ai/behaviorEngine.js';
import { ConversationalDecisionEngine, DECISION } from '../src/ai/decisionEngine.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';

function createTestAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancy-behavior-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new Database(dbPath);
  db.migrate();
  const settings = new Map([
    ['ai.provider', 'experiential'],
    ['ai.model', 'gpt-6.2-astra:free'],
    ['ai.backupModel', 'gemini-4-neon:free'],
    ['ai.groupChatEnabled', true]
  ]);

  const voiceCalls = [];
  const musicSession = {
    chatId: -100777,
    connected: true,
    status: 'playing',
    activeDeck: 'music',
    volume: 80,
    muted: false,
    loopMode: 'off',
    upcoming: [],
    movieUpcoming: [],
    currentTrack: { id: 't1', entryId: 't1', title: 'Essence', artist: 'Wizkid', durationSeconds: 240, provider: 'youtube' },
    lastMovieSearch: {
      query: 'avatar',
      results: [
        { index: 1, id: 'm1', title: 'Avatar (2009)' },
        { index: 2, id: 'm2', title: 'Avatar: The Way of Water (2022)' }
      ]
    },
    lastVideoSearch: { query: '', results: [] }
  };

  const app = {
    db,
    settings: {
      get: (k, d) => (settings.has(k) ? settings.get(k) : d),
      getForUser: (_u, _k, d) => d
    },
    ai: {
      hasCredentials: () => true,
      getCapabilities: () => ({ primaryModel: 'gpt-6.2-astra:free', backupModel: 'gemini-4-neon:free', realtimeVoiceAvailable: true }),
      chatWithTools: async ({ messages }) => {
        const last = messages.at(-1)?.content || '';
        return { content: `Got it on "${String(last).slice(0, 40)}".`, toolCalls: [], rawMessage: {} };
      },
      deepReason: async ({ messages }) => {
        const last = messages.at(-1)?.content || '';
        return { content: `Thoughtful reply on "${String(last).slice(0, 40)}".`, toolCalls: [], rawMessage: {} };
      }
    },
    musicQueueManager: {
      sessions: new Map([[-100777, musicSession]]),
      getSession: (cid) => (Number(cid) === -100777 ? musicSession : null)
    },
    voiceClient: {
      bargeIn: async (cid) => { voiceCalls.push({ fn: 'bargeIn', cid }); return { ok: true }; },
      pushLiveContext: async (cid, summary) => { voiceCalls.push({ fn: 'pushLiveContext', cid, summary }); return { ok: true }; },
      getParticipants: async () => ({
        participants: [
          { user_id: 201, display_name: 'John' },
          { user_id: 202, display_name: 'Sarah' }
        ]
      })
    },
    music: {
      owner: (ctx) => Number(ctx?.tgId ?? ctx?.user?.id) === 101,
      superAdmin: () => false,
      isVcSudo: (_ctx, _cid) => false
    },
    telegram: { botUsername: 'LancyTestBot', sendMessage: async () => ({ message_id: 99 }) }
  };

  const agent = new LancyAgent({ app });
  return { agent, db, app, voiceCalls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Listening Intelligence: hesitation pause, self-correction, overlap, person-to-person, rhetorical, repetition & stop speaking', async () => {
  const { agent, cleanup } = createTestAgent();
  try {
    const decision = new ConversationalDecisionEngine();
    const participants = [{ user_id: 201, display_name: 'John' }, { user_id: 202, display_name: 'Sarah' }];

    // 1. Mid-sentence hesitation pause -> wait instead of interrupting
    const pauseA = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice',
      text: 'Wait let me think um...', conversationMode: 'LISTENING', participants
    });
    assert.equal(pauseA.listening.shouldWaitForFinish, true);
    assert.equal(decision.decide({ text: pauseA.listening.cleanText, surface: 'vc_voice', behaviorAnalysis: pauseA }).action, DECISION.CONTINUE_LISTENING);

    // 2. Mid-sentence self-correction
    const corrA = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice',
      text: 'Lancy play Burna Boy actually wait no play Asake', isDirectlyAddressed: true, conversationMode: 'LISTENING'
    });
    assert.equal(corrA.listening.hasSelfCorrection, true);
    assert.match(corrA.listening.effectiveText, /^play Asake$/i);

    // 3. Simultaneous speakers while IDLE -> stay silent
    const simA = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice',
      text: 'Wait did you see that', simultaneousSpeakers: ['John', 'Sarah'], conversationMode: 'IDLE', participants
    });
    assert.equal(simA.participation.speak, false);
    assert.equal(decision.decide({ text: simA.listening.cleanText, surface: 'vc_voice', behaviorAnalysis: simA }).action, DECISION.SILENT_OTHER_SPEAKER);

    // 4. Addressing another human participant -> stay silent
    const p2p = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 202, senderName: 'Sarah', surface: 'vc_voice',
      text: 'John, did you already send that link?', conversationMode: 'IDLE', participants
    });
    assert.equal(p2p.listening.target, 'person_to_person');
    assert.equal(p2p.listening.addressedParticipant, 'John');
    assert.equal(p2p.participation.speak, false);

    // 5. Rhetorical statement in group -> stay silent
    const rhet = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'group_text',
      text: 'Can you believe this traffic today?', conversationMode: 'IDLE', participants
    });
    assert.equal(rhet.listening.target, 'rhetorical');
    assert.equal(rhet.participation.speak, false);

    // 6. Repetition detection
    agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice',
      text: 'Lancy what song is playing right now?', isDirectlyAddressed: true
    });
    const rep = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice',
      text: 'Lancy what song is playing right now?', isDirectlyAddressed: true
    });
    assert.equal(rep.listening.isRepetition, true);

    // 7. Priority #2: Stop speaking cancels speech cleanly
    const stopRes = await agent.handleVcTurn({
      chatId: -100777, userId: 101, senderName: 'Owner', fromAdmin: true,
      text: 'Lancy stop talking', source: 'vc_message'
    });
    assert.equal(stopRes.cancelledSpeech, true);
  } finally {
    cleanup();
  }
});

test('Social Intelligence: celebration, bad news, frustration, disagreement, playful humor & serious transition safety', () => {
  const engine = new HumanBehaviorEngine();
  const key = 'vc:-100888';

  const joy = engine.analyzeTurn({
    chatId: -100888, userId: 10, senderName: 'Ada', surface: 'group_text', sessionKey: key,
    text: 'Guys I just got the job!!', isDirectlyAddressed: true
  });
  assert.equal(joy.social.signal, 'joy_celebration');
  assert.equal(joy.social.tone, 'warm_celebratory');
  assert.equal(joy.social.allowHumor, true);

  const play = engine.analyzeTurn({
    chatId: -100888, userId: 11, senderName: 'Tunde', surface: 'group_text', sessionKey: key,
    text: 'Haha cope harder bro lmao', isDirectlyAddressed: false
  });
  assert.equal(play.social.allowTeasing, true);

  // Playful -> Serious transition must immediately forbid humor
  const badNews = engine.analyzeTurn({
    chatId: -100888, userId: 12, senderName: 'Chidi', surface: 'group_text', sessionKey: key,
    text: 'Sorry guys, bad news, my uncle passed away this morning.', isDirectlyAddressed: false
  });
  assert.equal(badNews.social.signal, 'sadness_bad_news');
  assert.equal(badNews.social.isSeriousContext, true);
  assert.equal(badNews.social.shiftedToSerious, true);
  assert.equal(badNews.social.allowHumor, false);
  assert.equal(badNews.social.allowTeasing, false);
  assert.equal(badNews.participation.speak, false); // never interrupt serious human thread with proactive banter

  const frust = engine.analyzeTurn({
    chatId: -100888, userId: 12, senderName: 'Chidi', surface: 'dm_text', sessionKey: 'dm:12',
    text: 'Ugh this is so frustrating, nothing works!'
  });
  assert.equal(frust.social.signal, 'frustration');
  assert.equal(frust.social.allowHumor, false);
  assert.equal(frust.social.tone, 'tactful_supportive');

  const disagree = engine.analyzeTurn({
    chatId: -100888, userId: 11, senderName: 'Tunde', surface: 'dm_text', sessionKey: 'dm:11',
    text: 'Nah I disagree with that take'
  });
  assert.equal(disagree.social.signal, 'disagreement');
  assert.equal(disagree.social.tone, 'grounded_respectful');
});

test('Conversation State, Topic Branching, Cross-Surface References, Expression & Pending Proposal Confirmation', async () => {
  const { agent, cleanup } = createTestAgent();
  try {
    // User speaks in live VC (cross-surface sync) about tech, then switches to movies
    await agent.syncLiveBehavioralTurn({
      chatId: -100777, userId: 201, senderName: 'John',
      inputText: 'I just bought a new Lenovo Legion laptop for coding.',
      outputText: 'Nice pickup, which GPU configuration did you get?'
    });
    await agent.syncLiveBehavioralTurn({
      chatId: -100777, userId: 202, senderName: 'Sarah',
      inputText: 'Actually pause coding talk, what Avatar movie was that?',
      outputText: 'Avatar: The Way of Water is the second option.'
    });

    // Cross-surface recall from group text asks what John said in VC + returns to earlier topic
    const res = await agent.behavior.analyzeTurn({
      chatId: -100777, userId: 202, senderName: 'Sarah', surface: 'group_text', sessionKey: 'bot:-100777',
      text: 'Wait go back to that topic, what did John say earlier?', isDirectlyAddressed: true,
      snapshot: agent.app.musicQueueManager.getSession(-100777)
    });
    assert.ok(res.resolvedReferences.some((r) => r.kind === 'speaker_recall' && r.speaker === 'John' && /Lenovo Legion/i.test(r.statement)));
    assert.ok(res.resolvedReferences.some((r) => r.kind === 'topic_return'));

    // Numbered media option resolution: "the second option"
    const optRef = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 101, senderName: 'Owner', surface: 'group_text', sessionKey: 'vc:-100777',
      text: 'Play the second option', isDirectlyAddressed: true,
      snapshot: agent.app.musicQueueManager.getSession(-100777)
    });
    assert.ok(optRef.resolvedReferences.some((r) => r.kind === 'search_option' && r.index === 2 && /Way of Water/i.test(r.title)));

    // Pending proposal confirmation + cancellation
    agent.behavior.recordOutcome({
      sessionKey: 'vc:-100777', chatId: -100777, surface: 'vc_voice',
      reply: 'Want me to switch over to Asake right now?'
    });
    const confirm = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 101, senderName: 'Owner', surface: 'vc_voice', sessionKey: 'vc:-100777',
      text: "Yeah let's go with it", conversationMode: 'AWAITING_FOLLOWUP'
    });
    assert.equal(confirm.intent.type, 'confirmation');
    assert.ok(confirm.resolvedReferences.some((r) => r.kind === 'proposal_confirmed'));

    const cancel = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 101, senderName: 'Owner', surface: 'vc_voice', sessionKey: 'vc:-100777',
      text: "Actually, don't", conversationMode: 'AWAITING_FOLLOWUP'
    });
    assert.equal(cancel.intent.type, 'cancellation');

    // Simple acknowledgement uses concise ack expression & avoids repeating prior assistant openers
    agent.behavior.recordOutcome({ sessionKey: 'dm:555', chatId: 555, surface: 'dm_text', reply: 'Say less, checking now.' });
    const ackTurn = agent.behavior.analyzeTurn({
      chatId: 555, userId: 555, senderName: 'Ali', surface: 'dm_text', sessionKey: 'dm:555',
      text: 'yeah', conversationMode: 'AWAITING_FOLLOWUP'
    });
    assert.equal(ackTurn.expression.lengthMode, 'ack');
    assert.ok(ackTurn.expression.avoidRepetitions.includes('Say less'));
  } finally {
    cleanup();
  }
});

test('Group Participation Policies, Ignored Question Rescue, Action Gates, Memory Isolation & <10ms Behavioral Latency', async () => {
  const { agent, db, cleanup } = createTestAgent();
  try {
    // 1. Passive & reactive stay quiet on unaddressed chatter; balanced answers ignored question
    agent.behavior.setParticipationPolicy(-100777, PARTICIPATION_POLICIES.PASSIVE);
    const obsPassive = await agent.observeGroupMessage({ chatId: -100777, userId: 201, senderName: 'John', text: 'This song is becoming boring tbh' });
    assert.equal(obsPassive.proactiveReply, null);

    // 2. Balanced mode rescues a participant question ignored across >=2 unrelated turns
    agent.behavior.setParticipationPolicy(-100777, PARTICIPATION_POLICIES.BALANCED);
    agent.behavior.analyzeTurn({ chatId: -100777, userId: 201, senderName: 'John', surface: 'group_text', sessionKey: 'vc:-100777', text: 'Wait who produced this beat?' });
    agent.behavior.analyzeTurn({ chatId: -100777, userId: 202, senderName: 'Sarah', surface: 'group_text', sessionKey: 'vc:-100777', text: 'Bro check the kitchen first' });
    const rescued = agent.behavior.analyzeTurn({ chatId: -100777, userId: 203, senderName: 'Mike', surface: 'group_text', sessionKey: 'vc:-100777', text: 'Did you bring water' });
    assert.equal(rescued.participation.speak, true);
    assert.equal(rescued.participation.priority, RULE_PRIORITY.UNRESOLVED_QUESTION);

    // 3. Ambiguous dissatisfaction asks before blindly executing
    const complaint = agent.behavior.analyzeTurn({
      chatId: -100777, userId: 101, senderName: 'Owner', surface: 'vc_voice', sessionKey: 'vc:-100777',
      text: 'This music is getting boring', isDirectlyAddressed: true
    });
    assert.equal(complaint.intent.type, 'complaint_feedback');
    assert.equal(complaint.intent.shouldAskFirst, true);

    // 4. Private DM memory isolation & forgetting
    agent.memory.rememberUserFact(201, 'private_note', 'Worried about rent Friday', { category: 'personal_secret', source: 'explicit' });
    const groupPrompt = agent.memory.formatPromptContext({ sessionKey: 'vc:-100777', chatId: -100777, userId: 201, surface: 'vc', includeUserPrivate: false });
    assert.equal(groupPrompt.includes('rent Friday'), false);
    const dmPrompt = agent.memory.formatPromptContext({ sessionKey: 'dm:201', chatId: 201, userId: 201, surface: 'dm_text', includeUserPrivate: true });
    assert.equal(dmPrompt.includes('rent Friday'), true);
    assert.equal(agent.memory.forgetUserMemories(201, 'rent') >= 1, true);

    // Unauthorized speaker blocked from live control tool
    const denied = await agent.executeLiveToolCall({ chatId: -100777, callId: 'c1', name: 'control_playback', args: { action: 'skip' }, userId: 999 });
    assert.equal(denied.status, 'permission_denied');

    // 5. Measured behavioral analysis speed (<10ms per turn)
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      agent.behavior.analyzeTurn({
        chatId: -100777, userId: 201, senderName: 'John', surface: 'vc_voice', sessionKey: 'vc:-100777',
        text: 'Play something energetic after this track if Sarah agrees', isDirectlyAddressed: true
      });
    }
    const avgMs = (performance.now() - t0) / 20;
    assert.ok(avgMs < 10, `Expected analyzeTurn avg < 10ms, got ${avgMs.toFixed(2)}ms`);
    db.close?.();
  } finally {
    cleanup();
  }
});
