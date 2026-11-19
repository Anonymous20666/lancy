import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/ai/providers/ollama.js';
import { resolveSeekTargetSeconds, LancyToolExecutor } from '../src/ai/lancyTools.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';
import { QueueManager } from '../src/music/queueManager.js';

test('OllamaProvider sends native tools payload and parses tool_calls cleanly', async () => {
  const prevFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'adjust_volume', arguments: { mode: 'set', value: 55 } } }
          ]
        }
      })
    };
  };
  try {
    const provider = new OllamaProvider();
    assert.equal(provider.model, 'qwen2.5:7b');
    assert.ok(provider.timeoutMs >= 20000);
    const out = await provider.generate({
      text: 'set volume to 55',
      tools: [{ type: 'function', function: { name: 'adjust_volume', parameters: { type: 'object', properties: {} } } }]
    });
    assert.equal(capturedBody.model, 'qwen2.5:7b');
    assert.ok(Array.isArray(capturedBody.tools));
    assert.equal(out.toolCalls[0].function.name, 'adjust_volume');
    assert.equal(out.toolCalls[0].function.arguments.value, 55);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveSeekTargetSeconds handles movie middle, quarters, percentages, timestamps, and deltas', () => {
  assert.equal(resolveSeekTargetSeconds('middle', 100, 3600).seconds, 1800);
  assert.equal(resolveSeekTargetSeconds('quarter', 0, 1000).seconds, 250);
  assert.equal(resolveSeekTargetSeconds('75%', 0, 1000).seconds, 750);
  assert.equal(resolveSeekTargetSeconds('+45s', 100, 1000).seconds, 145);
  assert.equal(resolveSeekTargetSeconds('-30s', 100, 1000).seconds, 70);
  assert.equal(resolveSeekTargetSeconds('1:05:10', 0, 7200).seconds, 3910);
  assert.equal(resolveSeekTargetSeconds('middle', 0, 0).error, 'unknown_duration');
});

test('LancyToolExecutor controls A–Z playback, mute/unmute restore, relative middle seek, and sends video to chat', async () => {
  const calls = { vol: [], seek: [], sent: [], skipped: 0, paused: 0, resumed: 0, audioSwitched: [] };
  const session = {
    chatId: -10099,
    connected: true,
    status: 'playing',
    activeDeck: 'movie',
    volume: 100,
    positionSeconds: 120,
    upcoming: [],
    movieUpcoming: [{ entryId: 'm2', title: 'Next Film' }],
    currentTrack: {
      entryId: 'm1',
      title: 'Inception (2010)',
      provider: 'movie',
      mediaKind: 'movie',
      durationSeconds: 3600,
      audioLanguage: 'en',
      streamUrl: 'https://example.com/inception.m3u8'
    }
  };
  const fakeApp = {
    musicQueueManager: {
      sessions: new Map([[-10099, session]]),
      getSession: () => session,
      pause: async () => { calls.paused++; session.status = 'paused'; return true; },
      resume: async () => { calls.resumed++; session.status = 'playing'; return true; },
      skip: async () => { calls.skipped++; },
      previous: async () => {},
      setVolume: async (_id, v) => { calls.vol.push(v); session.volume = v; return v; },
      seek: async (_id, sec) => { calls.seek.push(sec); session.positionSeconds = sec; return true; },
      toggleLoopMode: () => 'track',
      getAudioVariants: () => [{ audioLanguage: 'fr', url: 'https://x/fr' }, { audioLanguage: 'en', url: 'https://x/en' }],
      switchAudioLanguage: async (_id, idx) => { calls.audioSwitched.push(idx); return { ok: true, audioLanguage: 'en' }; }
    },
    movieDownloader: {
      sendSingleVideo: async (_ctx, desc, opts) => {
        calls.sent.push({ title: desc.title, quality: opts.quality });
        return { ok: true };
      }
    },
    telegram: { api: { sendMessage: async () => {} } }
  };

  const exec = new LancyToolExecutor({ app: fakeApp });
  const ctx = { chatId: -10099, telegramChatId: -10099, waitForUpload: true };

  // Lower & mute -> unmute restores non-zero volume
  await exec.execute('adjust_volume', { mode: 'lower', value: 30 }, ctx);
  assert.equal(session.volume, 70);
  await exec.execute('adjust_volume', { mode: 'mute' }, ctx);
  assert.equal(session.volume, 0);
  await exec.execute('adjust_volume', { mode: 'unmute' }, ctx);
  assert.equal(session.volume, 70);

  // Seek to movie middle
  const seekRes = await exec.execute('seek_playback', { target: 'middle' }, ctx);
  assert.equal(seekRes.ok, true);
  assert.equal(seekRes.seekSeconds, 1800);

  // Send active video to chat
  const sendRes = await exec.execute('send_current_video_to_chat', { quality: '720p' }, ctx);
  assert.equal(sendRes.ok, true);
  assert.equal(calls.sent[0].title, 'Inception (2010)');
  assert.equal(calls.sent[0].quality, '720p');

  // Switch audio language to English index
  await exec.execute('tune_cinema_stream', { setting: 'audio_language', value: 'en' }, ctx);
  assert.deepEqual(calls.audioSwitched, [1]);
});

test('LancyAgent "Lancy listen" -> multi-action batch -> clarification -> "Is that all?" -> "yeah" resumes cleanly', async () => {
  const spoken = [];
  const vcMsgs = [];
  const listenCalls = [];
  let toolStep = 0;

  const session = {
    chatId: -100777,
    connected: true,
    status: 'playing',
    activeDeck: 'movie',
    volume: 100,
    positionSeconds: 400,
    upcoming: [],
    movieUpcoming: [{ entryId: 'm2', title: 'King of Boys' }],
    currentTrack: {
      entryId: 'm1',
      title: 'Gangs of Lagos',
      provider: 'movie',
      mediaKind: 'movie',
      durationSeconds: 3000,
      streamUrl: 'https://example.com/gangs.m3u8'
    }
  };

  const fakeApp = {
    db: { getSetting: () => null, setSetting: () => {} },
    voiceClient: {
      speak: async (_id, text) => { spoken.push(text); return { ok: true }; },
      sendCallMessage: async (_id, text) => { vcMsgs.push(text); return { ok: true }; },
      setListenState: async (_id, opts) => { listenCalls.push(opts); return { ok: true }; }
    },
    music: {
      owner: (ctx) => Number(ctx.tgId) === 4242,
      superAdmin: (ctx) => Number(ctx.tgId) === 4242,
      isVcSudo: () => false
    },
    movieDownloader: {
      sendSingleVideo: async () => ({ ok: true })
    },
    telegram: { api: { sendMessage: async () => {} } },
    musicQueueManager: {
      sessions: new Map([[-100777, session]]),
      getSession: () => session,
      setVolume: async (_id, v) => { session.volume = v; return v; },
      seek: async (_id, sec) => { session.positionSeconds = sec; return true; },
      pause: async () => { session.status = 'paused'; return true; },
      resume: async () => { session.status = 'playing'; return true; },
      skip: async () => {}
    },
    ai: {
      chatWithTools: async () => {
        toolStep++;
        if (toolStep === 1) {
          return {
            provider: 'ollama',
            text: '',
            toolCalls: [
              { function: { name: 'adjust_volume', arguments: { mode: 'set', value: 45 } } },
              { function: { name: 'seek_playback', arguments: { target: 'middle' } } },
              { function: { name: 'send_current_video_to_chat', arguments: { quality: '480p' } } }
            ]
          };
        }
        return {
          provider: 'ollama',
          text: 'Volume is 45%, jumped to the middle at 25:00, and sending Gangs of Lagos to chat now. Is that all?',
          toolCalls: []
        };
      }
    }
  };

  const agent = new LancyAgent({ app: fakeApp });

  // 1. Unauthorized viewer trying "Lancy listen" is rejected cleanly
  const unauthRes = await agent.handleVcTurn({
    chatId: -100777,
    userId: 9999,
    text: 'Lancy listen',
    source: 'vc_voice',
    isWake: true,
    isListenCommand: true
  });
  assert.equal(unauthRes.blocked, true);
  assert.equal(session.status, 'playing');

  // 2. Authorized Admin says "Lancy listen" -> pauses playback & listens
  const wakeRes = await agent.handleVcTurn({
    chatId: -100777,
    userId: 4242,
    text: 'Lancy listen',
    source: 'vc_voice',
    isWake: true,
    isListenCommand: true
  });
  assert.equal(wakeRes.mode, 'LISTENING');
  assert.equal(session.status, 'paused');
  assert.equal(listenCalls.at(-1).pause_media, true);

  // 3. Noisy/low-confidence garbled audio does NOT execute tools — asks clarification!
  const unclearRes = await agent.handleVcTurn({
    chatId: -100777,
    userId: 4242,
    text: 'bluh mumble',
    source: 'vc_voice',
    confidence: 0.30,
    lowConfidence: true
  });
  assert.equal(unclearRes.clarification, true);
  assert.match(unclearRes.reply, /didn’t catch that|what did you say/i);
  assert.equal(session.volume, 100);

  // 4. Multi-action natural request executes ALL 3 tools while holding pause & asks "Is that all?"
  const batchRes = await agent.handleVcTurn({
    chatId: -100777,
    userId: 4242,
    text: 'lower the volume to 45, go to the movie middle and send this video to the chat',
    source: 'vc_voice',
    confidence: 0.91,
    lowConfidence: false
  });
  assert.equal(session.volume, 45);
  assert.equal(session.positionSeconds, 1500);
  assert.equal(session.status, 'paused'); // stays paused waiting for "yeah"
  assert.match(batchRes.reply, /anything else|is there more|is that all/i);

  // 5. User says "yeah" -> resumes playback smoothly!
  const doneRes = await agent.handleVcTurn({
    chatId: -100777,
    userId: 4242,
    text: 'yeah',
    source: 'vc_voice',
    confidence: 0.94
  });
  assert.equal(doneRes.mode, 'IDLE');
  assert.equal(session.status, 'playing');
  assert.equal(listenCalls.at(-1).resume_media, true);
  assert.ok(spoken.length >= 4);
  assert.ok(vcMsgs.length >= 4);
});

test('QueueManager.handleVcMessage routes "Lancy ..." text to LancyAgent while preserving !np', async () => {
  const sentVc = [];
  const handledTurns = [];
  const fakeVoice = {
    sendCallMessage: async (_id, text) => { sentVc.push(text); return { ok: true }; }
  };
  const fakeApp = {
    music: { getSkipVoteThreshold: () => 2 },
    lancyAgent: {
      getVcConversation: () => ({ mode: 'IDLE' }),
      handleVcTurn: async (payload) => { handledTurns.push(payload); return { handled: true }; }
    }
  };
  const qm = new QueueManager({ app: fakeApp, voiceClient: fakeVoice, pollMs: 0 });
  const s = qm.getSession(-100888);
  s.connected = true;
  s.status = 'playing';
  s.currentTrack = { title: 'Test Movie', durationSeconds: 1200 };
  s.positionSeconds = 120;

  // Classic !np works as before
  await qm.handleVcMessage({ chat_id: -100888, sender_id: 101, from_admin: false, text: '!np' });
  assert.match(sentVc[0], /Test Movie/);

  // Wait beyond rate-limit gap & address Lancy without !
  s._vcMsgRateBySender.clear();
  s._lastVcMsgAt = 0;
  await qm.handleVcMessage({ chat_id: -100888, sender_id: 4242, sender_name: 'Boss', from_admin: true, text: 'lancy lower the volume to 50' });
  assert.equal(handledTurns.length, 1);
  assert.equal(handledTurns[0].source, 'vc_message');
  assert.equal(handledTurns[0].fromAdmin, true);
});

test('LancyAgent gives non-repetitive self-aware "Lancy listen" replies and human banter on "hi" without robotic "Is that all?"', async () => {
  const generatePrompts = [];
  let toolSchemaCalls = 0;
  const listenUpdates = [];

  const session = {
    chatId: -100999,
    deck: 'music',
    status: 'playing',
    volume: 90,
    muted: false,
    positionSeconds: 83,
    currentTrack: { title: 'Last Last — Burna Boy', artist: 'Burna Boy', durationSeconds: 172 },
    queue: []
  };

  const fakeApp = {
    musicQueueManager: { sessions: new Map([[-100999, session]]), getSession: () => session },
    voiceClient: {
      setListenState: async (_id, payload) => { listenUpdates.push(payload); return { ok: true }; },
      speak: async () => ({ ok: true }),
      sendCallMessage: async () => ({ ok: true })
    },
    ai: {
      generate: async ({ text, context }) => {
        generatePrompts.push({ text, system: context?.system || '' });
        if (/called your name/i.test(text)) {
          return {
            provider: 'ollama',
            text: generatePrompts.length === 1
              ? 'Hold on Pappy, paused Burna Boy right at the chorus — what’s good?'
              : 'Stopped Last Last for a sec Pappy — talk to me!'
          };
        }
        return {
          provider: 'ollama',
          text: 'Hiii Pappy! Chill night vibes here — honestly Burna was hitting smooth, how’s your side going?'
        };
      },
      chatWithTools: async () => {
        toolSchemaCalls += 1;
        return { provider: 'ollama', text: 'Should not use 13 tools on pure "hi"', toolCalls: [] };
      }
    }
  };

  const agent = new LancyAgent({ app: fakeApp });

  const wake1 = await agent.handleVcTurn({
    chatId: -100999, userId: 501, senderName: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾', fromAdmin: true,
    text: 'lancy listen', source: 'vc_voice', isListenCommand: true, isWake: true
  });
  const wake2 = await agent.handleVcTurn({
    chatId: -100999, userId: 501, senderName: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾', fromAdmin: true,
    text: 'lancy listen', source: 'vc_voice', isListenCommand: true, isWake: true
  });

  assert.notEqual(wake1.reply, wake2.reply);
  assert.match(wake1.reply, /Pappy/);
  assert.equal(listenUpdates[0].pause_media, true);

  // Casual greeting "hi" runs humanized banter path, skips 13-tool schema bloat, and NEVER appends ". Is that all?"
  const hiRes = await agent.handleVcTurn({
    chatId: -100999, userId: 501, senderName: '⸸ 𝑷 𝑨 𝑷 𝑷 𝒀 ×͜× 👾', fromAdmin: true,
    text: 'hi', source: 'vc_voice', confidence: 0.95
  });
  assert.equal(toolSchemaCalls, 0);
  assert.match(hiRes.reply, /Pappy/i);
  assert.doesNotMatch(hiRes.reply, /is that all/i);
  assert.doesNotMatch(hiRes.reply, /what do you need/i);
});

test('Strict voice "Lancy listen" gate + live non-pausing VC text desk control + A-Z desk NLU + streaming presets', async () => {
  const { parseDeskIntents } = await import('../src/ai/deskNlu.js');
  const { consumeTokenStream } = await import('../src/ai/providers/streamHelper.js');
  const { AIService } = await import('../src/ai/service.js');

  // 1. Deterministic chained desk NLU checks across all desk domains
  const chain = parseDeskIntents('lower the volume to 55, switch to 480p, loop track, shuffle queue, turn on dj desk, and auto sync subtitles');
  assert.equal(chain.length, 6);
  assert.deepEqual(chain[0], { name: 'adjust_volume', args: { mode: 'set', value: 55 } });
  assert.deepEqual(chain[1], { name: 'tune_cinema_stream', args: { setting: 'quality', value: '480p' } });
  assert.deepEqual(chain[2], { name: 'control_playback', args: { action: 'set_loop', loop_mode: 'track' } });
  assert.deepEqual(chain[3], { name: 'control_playback', args: { action: 'shuffle' } });
  assert.deepEqual(chain[4], { name: 'ai_dj_control', args: { action: 'visual_on' } });
  assert.deepEqual(chain[5], { name: 'tune_cinema_stream', args: { setting: 'auto_sync_subtitles', value: 'auto' } });
  assert.equal(parseDeskIntents('play some sad juice wrld remixes'), null); // open-ended routes to LLM

  // 2. VC voice ignores non-listen idle utterances; VC text "Lancy ..." executes live WITHOUT pausing & replies silently in chat
  const spoken = [];
  const vcMsgs = [];
  const listenCalls = [];
  const callsLog = [];

  const session = {
    chatId: -100555,
    deck: 'movie',
    activeDeck: 'movie',
    status: 'playing',
    volume: 100,
    loopMode: 'off',
    vcQuality: 'HD_720p',
    streamMode: 'interactive',
    upcoming: [{ entryId: 't1', title: 'Burna Boy - City Boys' }, { entryId: 't2', title: 'Rema - Calm Down' }],
    movieUpcoming: [],
    currentTrack: { title: 'Inception', provider: 'movie', durationSeconds: 8880, subtitleTracks: [{ language: 'eng', filePath: '/tmp/a.srt' }, { language: 'spa', filePath: '/tmp/b.srt' }] }
  };

  const fakeApp = {
    voiceClient: {
      speak: async (_id, text, opts) => { spoken.push({ text, opts }); return { ok: true }; },
      sendCallMessage: async (_id, text) => { vcMsgs.push(text); return { ok: true }; },
      setListenState: async (_id, opts) => { listenCalls.push(opts); return { ok: true }; }
    },
    musicQueueManager: {
      sessions: new Map([[-100555, session]]),
      getSession: () => session,
      setVolume: async (_id, v) => { session.volume = v; return v; },
      setVcQuality: async (_id, q) => { session.vcQuality = q; callsLog.push(['quality', q]); return q; },
      setStreamMode: async (_id, m) => { session.streamMode = m; callsLog.push(['stream', m]); return m; },
      checkSubtitleSync: async () => { callsLog.push(['subcheck']); return { ok: true }; },
      shuffle: () => { callsLog.push(['shuffle']); return session.upcoming.length; },
      updatePlayerCard: async () => { callsLog.push(['refresh']); return true; }
    },
    ai: {
      generate: async () => ({ provider: 'ollama', text: 'Hey Pappy! Rolling Inception smoothly right now — hit me with anything.' })
    }
  };

  const agent = new LancyAgent({ app: fakeApp });

  // Idle voice WITHOUT "Lancy listen" -> completely ignored!
  const ignoredVoice = await agent.handleVcTurn({
    chatId: -100555, userId: 42, senderName: 'Pappy', fromAdmin: true,
    text: 'lancy lower volume to 40', source: 'vc_voice', isWake: true, isListenCommand: false
  });
  assert.equal(ignoredVoice.ignored, true);
  assert.equal(session.volume, 100);
  assert.equal(listenCalls.length, 0);

  // VC Text WITHOUT "Lancy" -> ignored cleanly
  const ignoredText = await agent.handleVcTurn({
    chatId: -100555, userId: 42, senderName: 'Pappy', fromAdmin: true,
    text: 'haha nice movie guys', source: 'vc_message'
  });
  assert.equal(ignoredText.handled, false);

  // VC Text WITH "Lancy <desk actions>" -> executes live WITHOUT pausing playback & silent over call audio!
  const textDesk = await agent.handleVcTurn({
    chatId: -100555, userId: 42, senderName: 'Pappy', fromAdmin: true,
    text: 'lancy lower volume to 40, switch to 480p, loop track, and auto sync subtitles', source: 'vc_message'
  });
  assert.equal(textDesk.handled, true);
  assert.equal(textDesk.spoken, false);
  assert.equal(session.status, 'playing'); // NEVER paused!
  assert.equal(session.volume, 40);
  assert.equal(session.vcQuality, 'SD_480p');
  assert.equal(session.loopMode, 'track');
  assert.equal(listenCalls.length, 0);
  assert.equal(spoken.length, 0);
  assert.equal(vcMsgs.length, 1);
  assert.match(vcMsgs[0], /volume set to 40%|quality switched to SD_480p/);

  // 3. Verify stream sentence splitter & AI preset hotkey
  const enc = new TextEncoder();
  const fakeRes = new Response(new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"First sentence here. "}}]}\n'));
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Second sentence arrives cleanly!"}}]}\n'));
      ctrl.enqueue(enc.encode('data: [DONE]\n'));
      ctrl.close();
    }
  }));
  const chunks = [];
  const full = await consumeTokenStream(
    fakeRes,
    (line) => {
      if (!line.startsWith('data:') || line.includes('[DONE]')) return '';
      return JSON.parse(line.slice(5))?.choices?.[0]?.delta?.content || '';
    },
    (s) => chunks.push(s)
  );
  assert.equal(chunks.length, 2);
  assert.match(full, /First sentence here\./);

  const fakeDb = { map: new Map(), setSetting(k, v) { this.map.set(k, v); }, getSetting(k, d) { return this.map.has(k) ? this.map.get(k) : d; } };
  const fakeSettings = { values: {}, get(k) { return this.values[k]; }, load() { this.values = Object.fromEntries(fakeDb.map); } };
  const aiSvc = new AIService({ settings: fakeSettings });
  const gem = aiSvc.applyPreset({ preset: 'gemini', apiKey: 'AIzaTestKey12345' }, fakeDb);
  assert.equal(gem.provider, 'openai-compatible');
  assert.equal(gem.model, 'gemini-2.5-flash');
  assert.equal(fakeDb.getSetting('ai.apiKey'), 'AIzaTestKey12345');
  await aiSvc.stop();
});
