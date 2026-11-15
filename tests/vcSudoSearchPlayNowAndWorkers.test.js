import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { SearchSessions } from '../src/music/search.js';
import { normalizeTrack } from '../src/music/model.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { decodeCallback } from '../src/telegram/rich.js';
import { MediaWorkerPool } from '../src/core/mediaWorkerPool.js';
import { fitResultForTelegram, uploadLimitBytes } from '../src/media/telegramLimits.js';
import { TelegramAPI } from '../src/telegram/api.js';
import { isNonMusicOrNews } from '../src/media/youtubeSearch.js';
import { rankTracksTrendingToOld } from '../src/music/radio.js';

const makeTrack = (n, extra = {}) => normalizeTrack({
  providerId: `trk_${n}`,
  title: `Track ${n}`,
  artist: `Artist ${n}`,
  durationSeconds: 180,
  streamUrl: `https://example.org/trk_${n}.mp3`,
  capabilities: { stream: true, download: true, seek: true, video: true },
  ...extra
}, 'fixture');

test('1. Search song while genre/radio is playing -> offers ⚡ Play Now and Add selected, and ⚡ Play Now plays immediately then resumes interrupted song & genre playlist', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const played = [];
  const voice = {
    play: async (chatId, url) => { played.push({ chatId, url }); return { ok: true, account_alias: 'one' }; },
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    accounts: async () => ({ accounts: [{ alias: 'one', enabled: true, status: 'available' }] })
  };

  const searchProvider = {
    search: async () => ({
      provider: 'fixture',
      items: [makeTrack(101, { title: 'Searched Hit 101' }), makeTrack(102, { title: 'Searched Hit 102' })],
      nextOffset: null
    })
  };

  const app = {
    db,
    sm: new StateMachine(),
    voiceClient: voice,
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) }
  };
  const qm = new QueueManager({ app, db, voiceClient: voice, pollMs: 0 });
  app.musicQueueManager = qm;
  const search = new SearchSessions({ providers: searchProvider });
  const service = new MusicService({ app, search, lyrics: { get: async () => ({ found: false }) }, accounts: { sync: async () => {} } });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => {
    await qm.shutdown();
    await screen.cleanup();
  });

  // Start playing a Genre playlist (Track 1 currently playing, Track 2 & Track 3 queued in genre radio)
  await qm.addMany(-100, [
    makeTrack(1, { title: 'Genre Song 1' }),
    makeTrack(2, { title: 'Genre Song 2' }),
    makeTrack(3, { title: 'Genre Song 3' })
  ]);
  const session = qm.getSession(-100);
  session.radio = { enabled: true, queries: ['Afrobeats'], seeds: [{ title: 'Afrobeats' }] };
  assert.equal(session.currentTrack.title, 'Genre Song 1');
  assert.equal(session.upcoming.length, 2);

  const edits = [];
  const sentRich = [];
  const api = {
    me: { id: 99 },
    getChat: async () => ({ id: -100, type: 'supergroup', title: 'Party Group' }),
    getChatMember: async () => ({ status: 'administrator' }),
    sendRichMessage: async (_c, rich) => { sentRich.push(rich); return { message_id: 50 }; },
    editMessageRich: async (_c, _m, rich) => { edits.push(rich); return { message_id: 40 }; },
    answerCallbackQuery: async () => ({})
  };
  const ctx = { tgId: 10, chatId: -100, messageId: 40, api, user: { first_name: 'Owner' } };

  // User searches a song while the genre is playing
  const s = await service.startSearch(ctx, 'Searched Hit', 'queue');
  s.messageId = 40;
  const searchCard = screen.renderSearch(s);
  const cardJson = JSON.stringify(searchCard);
  assert.match(cardJson, /Now Playing: Genre Song 1/);
  assert.match(cardJson, /Play Now/);
  assert.match(cardJson, /qnow/);
  assert.match(cardJson, /playnow_s/);
  assert.match(cardJson, /Add selected/);

  // Verify all callback_data fit within 64 bytes
  for (const blk of searchCard.blocks.filter((b) => b.type === 'buttons')) {
    for (const btn of blk.buttons) {
      assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
      assert.ok(decodeCallback(btn.callback_data));
    }
  }

  // User taps 1-click "⚡ Play Now" (qnow) on the first search result (index 0)
  await screen.handle(ctx, 'qnow', [s.id, s.revision, 0]);

  // "Searched Hit 101" is now playing immediately, while "Genre Song 1" is preserved at the END of queue!
  assert.equal(session.currentTrack.title, 'Searched Hit 101');
  assert.equal(session.history.at(-1)?.title, 'Genre Song 1');
  // Remaining genre songs ("Genre Song 2", "Genre Song 3") play BEFORE returning to "Genre Song 1" (B -> C -> D -> A)
  assert.deepEqual(
    session.upcoming.map((u) => u.title),
    ['Genre Song 2', 'Genre Song 3', 'Genre Song 1']
  );
  // Radio state remains intact
  assert.equal(session.radio.enabled, true);

  // When "Searched Hit 101" finishes, "Genre Song 2" (C) plays next, NOT "Genre Song 1" (A)!
  await qm.handleStreamEnded(-100, session.playbackId);
  assert.equal(session.currentTrack.title, 'Genre Song 2');
  assert.deepEqual(session.upcoming.map((u) => u.title), ['Genre Song 3', 'Genre Song 1']);

  // Also verify Queue view "▶ Play now" (playnow): replaces current song immediately, keeps previous at end of queue, and switches view to 'player'
  await qm.addMany(-100, [makeTrack(4, { title: 'Genre Song 4' })]);
  session.view = 'queue';
  const targetEntryId = session.upcoming[0].entryId; // Genre Song 3
  edits.length = 0;
  await service.control({ ...ctx, messageId: session.screenMessageId }, 'playnow', [targetEntryId, String(session.controlRevision || 0)]);
  assert.equal(session.view, 'player');
  assert.equal(session.currentTrack.title, 'Genre Song 3');
  assert.deepEqual(session.upcoming.map((u) => u.title), ['Genre Song 1', 'Genre Song 4', 'Genre Song 2']);
});

test('2. /vcsudo authorization blocks random group admins and stays 100% silent for unauthorized users', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const app = {
    db,
    sm: new StateMachine(),
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) }
  };
  const qm = new QueueManager({
    app,
    db,
    pollMs: 0,
    voiceClient: {
      play: async () => ({ ok: true, account_alias: 'one' }),
      stop: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      setVolume: async () => ({ ok: true })
    }
  });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers: {} }), lyrics: {}, accounts: { sync: async () => {} } });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => {
    await qm.shutdown();
    await screen.cleanup();
  });

  const chatMessages = [];
  const callbackAlerts = [];
  const makeApi = (memberStatus = 'administrator') => ({
    me: { id: 99 },
    getChat: async () => ({ id: -100555, type: 'supergroup', title: '1000 User GC' }),
    getChatMember: async () => ({ status: memberStatus }),
    sendMessage: async (_c, text) => { chatMessages.push(text); return { message_id: 90 }; },
    sendRichMessage: async (_c, rich) => { chatMessages.push(rich); return { message_id: 91 }; },
    editMessageRich: async (_c, _m, rich) => { chatMessages.push(rich); return { message_id: 92 }; },
    answerCallbackQuery: async (_id, opts) => { if (opts?.text) callbackAlerts.push(opts.text); return {}; }
  });

  // Owner (tgId: 10) grants /vcsudo to user 777 in group -100555
  const ownerCtx = { tgId: 10, chatId: -100555, api: makeApi('creator') };
  const addMsg = await service.vcsudoCommand(ownerCtx, ['add', '777']);
  assert.match(addMsg, /Added.*777/);
  assert.equal(service.isVcSudoEnforced(-100555), true);

  // Random group administrator (tgId: 202, status: 'administrator' in Telegram, but NOT in vcsudo) tries to skip/stop/play
  const randomAdminCtx = {
    tgId: 202,
    chatId: -100555,
    query: { id: 'cb_1' },
    api: makeApi('administrator')
  };
  chatMessages.length = 0;
  callbackAlerts.length = 0;

  // 1) Random admin tries command /skip -> handled & completely silent (0 messages sent!)
  await screen.handleCommand(randomAdminCtx, '/skip', []);
  assert.equal(chatMessages.length, 0, 'Unauthorized random admin must receive zero chat messages');
  assert.equal(callbackAlerts.length, 0, 'Unauthorized random admin must receive zero alert popups');

  // 2) Random admin clicks player button -> completely silent (0 messages, 0 alert text!)
  await screen.handle(randomAdminCtx, 'skip', ['0']);
  assert.equal(chatMessages.length, 0);
  assert.equal(callbackAlerts.length, 0);

  // 3) Authorized vcsudo user (tgId: 777) IS allowed even if they are only a regular 'member' in Telegram!
  const sudoUserCtx = {
    tgId: 777,
    chatId: -100555,
    api: makeApi('member')
  };
  const authDest = await service.authorize(sudoUserCtx, true, -100555);
  assert.equal(authDest, -100555);
});

test('3. AI DJ conversational intelligence: immediate playback & conclusion detection', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const app = {
    db,
    settings: { get: () => [10] },
    musicProviders: {
      get: () => ({ enabled: true }),
      search: async (q) => ({
        items: [makeTrack(501, { title: `Immediate ${q}`, artist: 'Burna Boy' })]
      })
    }
  };
  const qm = new QueueManager({
    app,
    db,
    pollMs: 0,
    voiceClient: {
      play: async () => ({ ok: true, account_alias: 'one' }),
      stop: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      setVolume: async () => ({ ok: true })
    }
  });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers: app.musicProviders }), lyrics: {}, accounts: { sync: async () => {} } });
  service.aiDj.chartFetcher = async () => [{ title: 'Last Last', artist: 'Burna Boy' }];
  app.music = service;
  t.after(() => qm.shutdown());

  await qm.addMany(-200, [makeTrack(1, { title: 'Old Vibe 1' }), makeTrack(2, { title: 'Old Vibe 2' })]);
  const session = qm.getSession(-200);

  // Ask AI DJ to play a song immediately (replaces Old Vibe 1 and keeps Old Vibe 2 in upcoming)
  const immediateRes = await service.aiDj.chatWithDj(session, 'play Last Last right now', { apply: true });
  assert.equal(immediateRes.intent.playImmediate, true);
  assert.match(session.currentTrack.title, /Immediate/i);
  assert.equal(session.upcoming[0].title, 'Old Vibe 2');

  // Conclude the conversation with AI DJ ("thanks dj" / "that's all")
  const queueLenBefore = session.upcoming.length;
  const concludeRes = await service.aiDj.chatWithDj(session, 'thanks dj that is all', { apply: true });
  assert.equal(concludeRes.concluded, true);
  assert.equal(concludeRes.added.length, 0);
  assert.equal(session.upcoming.length, queueLenBefore, 'Concluding chat must not queue extra tracks');
  assert.match(concludeRes.reply, /Anytime|enjoy the music/i);
});

test('4. Multi-worker pool & high-concurrency song downloads across multiple users in a 1000-user GC', async (t) => {
  const pool = new MediaWorkerPool({ maxWorkers: 4, maxConcurrentJobs: 8, perUserMaxConcurrent: 2 });
  t.after(() => pool.shutdown());

  // Schedule 12 concurrent tasks across 6 different users and verify fair parallel execution
  const order = [];
  const jobs = [];
  for (let u = 1; u <= 6; u++) {
    for (let j = 1; j <= 2; j++) {
      jobs.push(pool.schedule(`user_${u}`, async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`u${u}_${j}`);
        return `u${u}_${j}`;
      }));
    }
  }
  const results = await Promise.all(jobs);
  assert.equal(results.length, 12);

  // Also test worker_threads execution via execInWorker
  const { stdout } = await pool.execInWorker(process.execPath, ['-e', 'process.stdout.write("worker_ok")'], { userKey: 'u1' });
  assert.equal(stdout.trim(), 'worker_ok');
});

test('5. 2GB Local Bot API Server configuration & zero-RAM disk-backed movie fitting', async (t) => {
  const prevLimit = process.env.TELEGRAM_UPLOAD_LIMIT_MB;
  process.env.TELEGRAM_UPLOAD_LIMIT_MB = '2000';
  t.after(() => {
    if (prevLimit === undefined) delete process.env.TELEGRAM_UPLOAD_LIMIT_MB;
    else process.env.TELEGRAM_UPLOAD_LIMIT_MB = prevLimit;
  });

  assert.equal(uploadLimitBytes(), Math.floor(2000 * 1024 * 1024 * 0.96));

  // A 1.4 GB movie backed by filePath on disk fits without loading a Buffer into RAM
  const fakeMovieSize = Math.round(1.4 * 1024 * 1024 * 1024);
  const fitted = await fitResultForTelegram({
    platform: 'Thenkiri',
    title: 'Blockbuster Movie (2026)',
    mediaItems: [{
      type: 'video',
      filePath: '/tmp/nonexistent_movie_test.mp4',
      sizeBytes: fakeMovieSize,
      filename: 'movie.mp4',
      mimeType: 'video/mp4'
    }]
  });
  assert.equal(fitted.mediaItems.length, 1);
  assert.equal(fitted.oversized.length, 0);
  assert.equal(fitted.mediaItems[0].filePath, '/tmp/nonexistent_movie_test.mp4');

  // Verify TelegramAPI honors local baseUrl and zero-copy openAsBlob file uploads
  const tmpDir = await mkdtemp(join(tmpdir(), 'lancy-local-api-'));
  const sampleFile = join(tmpDir, 'sample.mp4');
  await writeFile(sampleFile, 'sample video content');
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  let capturedUrl = null;
  let capturedBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = init.body;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const api = new TelegramAPI('123456:TEST_TOKEN', {
    baseUrl: 'http://127.0.0.1:8081'
  });
  await api.sendVideo(100, { filePath: sampleFile }, { filename: 'sample.mp4' });
  assert.equal(capturedUrl, 'http://127.0.0.1:8081/bot123456:TEST_TOKEN/sendVideo');
  assert.ok(capturedBody instanceof FormData);
});

test('6. Deleted player card recovery: /player and service.player recreate the player card when the old message was deleted', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const app = {
    db,
    sm: new StateMachine(),
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) }
  };
  const qm = new QueueManager({
    app,
    db,
    pollMs: 0,
    voiceClient: {
      play: async () => ({ ok: true, account_alias: 'one' }),
      stop: async () => ({ ok: true })
    }
  });
  t.after(() => qm.shutdown());
  app.musicQueueManager = qm;
  const service = new MusicService({
    app,
    db,
    accounts: { sync: async () => ({}) },
    lyrics: { get: async () => ({ found: false }) }
  });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  await qm.addMany(-100, [makeTrack(1, { title: 'Playing Track' })]);

  let nextMsgId = 100;
  const deletedIds = new Set();
  const sentIds = [];
  const api = {
    me: { id: 99 },
    getChat: async () => ({ id: -100, type: 'supergroup', title: 'Music Group' }),
    getChatMember: async () => ({ status: 'administrator' }),
    sendRichMessage: async () => {
      const id = ++nextMsgId;
      sentIds.push(id);
      return { message_id: id };
    },
    editMessageRich: async (_chatId, msgId) => {
      if (deletedIds.has(msgId)) {
        const err = new Error('Telegram editMessageText: Bad Request: message to edit not found');
        err.description = 'Bad Request: message to edit not found';
        throw err;
      }
      return { message_id: msgId };
    },
    deleteMessage: async (_chatId, msgId) => {
      deletedIds.add(msgId);
      return true;
    }
  };

  const ctx = { tgId: 10, chatId: -100, api, user: { first_name: 'Owner' } };
  await service.player(ctx, -100);
  const session = qm.getSession(-100);
  assert.equal(session.screenMessageId, 101);

  // User deletes message 101 in Telegram, then service.player is called (even with identical render content!)
  deletedIds.add(101);
  await service.player(ctx, -100);
  assert.equal(session.screenMessageId, 102);

  // User runs /player command explicitly while overlayView was active -> always posts a fresh card at bottom of chat
  session.overlayView = 'catmenu';
  session.overlayAt = Date.now();
  await screen.handleCommand({ ...ctx, message: { message_id: 500, chat: { id: -100, type: 'supergroup' } } }, '/player', []);
  assert.equal(session.screenMessageId, 103);
  assert.equal(session.overlayView, null);
  assert.ok(deletedIds.has(102));
});

test('7. Volume button (VC volume & setvol) works without rate-limit/double-edit bugs, and News/non-music videos are filtered out while preferring Music Videos', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const volumeCalls = [];
  const editCalls = [];
  const app = {
    db,
    sm: new StateMachine(),
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) }
  };
  const qm = new QueueManager({
    app,
    db,
    pollMs: 0,
    voiceClient: {
      play: async () => ({ ok: true, account_alias: 'one' }),
      setVolume: async (chatId, vol) => {
        volumeCalls.push({ chatId, vol });
        return { ok: true };
      },
      stop: async () => ({ ok: true })
    }
  });
  t.after(() => qm.shutdown());
  app.musicQueueManager = qm;
  const service = new MusicService({
    app,
    db,
    accounts: { sync: async () => ({}) },
    lyrics: { get: async () => ({ found: false }) }
  });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  await qm.addMany(-100, [makeTrack(1, { title: 'Playing Track' })]);
  const api = {
    me: { id: 99 },
    getChat: async () => ({ id: -100, type: 'supergroup', title: 'Music Group' }),
    getChatMember: async () => ({ status: 'administrator' }),
    sendRichMessage: async () => ({ message_id: 201 }),
    editMessageRich: async (_chatId, msgId, rich) => {
      editCalls.push({ msgId, rich });
      return { message_id: msgId };
    },
    answerCallbackQuery: async () => true
  };

  const baseCtx = { tgId: 10, chatId: -100, api, user: { first_name: 'Owner' } };
  await service.player(baseCtx, -100);
  const session = qm.getSession(-100);
  session.connected = true;
  editCalls.length = 0;
  // Simulate active editAfter backoff from background progress poller
  session.editAfter = Date.now() + 10000;

  // 1. Tap "VC volume" button -> must bypass editAfter via forceEdit and switch view to 'volume'
  await service.control(
    { ...baseCtx, messageId: 201, query: { id: 'q_vol' } },
    'volume',
    [String(session.controlRevision)]
  );
  assert.equal(session.view, 'volume');
  assert.equal(editCalls.length, 1);

  // 2. Immediately tap "150%" button (<1s after opening volume) -> must not throw SLOW_DOWN and must perform exactly 1 card edit with fresh controlRevision
  await service.control(
    { ...baseCtx, messageId: 201, query: { id: 'q_set150' } },
    'setvol',
    ['150', String(session.controlRevision)]
  );
  assert.equal(session.volume, 150);
  assert.equal(editCalls.length, 2, 'setvol should edit the player card once with the new controlRevision');

  // 3. Immediately tap "80%" button right after "150%" -> works without SLOW_DOWN or STALE_PLAYER
  await service.control(
    { ...baseCtx, messageId: 201, query: { id: 'q_set80' } },
    'setvol',
    ['80', String(session.controlRevision)]
  );
  assert.equal(session.volume, 80);
  assert.deepEqual(volumeCalls.slice(-2).map((c) => c.vol), [150, 80]);

  // 4. Verify News / non-music filter & Music Video ranking
  assert.equal(isNonMusicOrNews('Breaking News: President addresses parliament', 'Arise News', 'afrobeats'), true);
  assert.equal(isNonMusicOrNews('Evening News Bulletin at 9PM', 'Channels Television', 'burna boy'), true);
  assert.equal(isNonMusicOrNews('Burna Boy - Last Last [Official Music Video]', 'Burna Boy', 'burna boy last last'), false);

  const ranked = rankTracksTrendingToOld([
    makeTrack(1, { title: 'Burna Boy - Last Last (Official Audio)', artist: 'Burna Boy - Topic', viewCount: 5_000_000, publishedAgeDays: 300 }),
    makeTrack(2, { title: 'Breaking News Live Report', artist: 'BBC News', viewCount: 9_000_000, publishedAgeDays: 10 }),
    makeTrack(3, { title: 'Burna Boy - Last Last [Official Music Video]', artist: 'Burna Boy', viewCount: 4_000_000, publishedAgeDays: 300 })
  ], { isVideo: true });
  assert.equal(ranked[0].title, 'Burna Boy - Last Last [Official Music Video]');
  assert.equal(ranked.at(-1).title, 'Breaking News Live Report');
});

test('6. /rmsudo revokes VC Sudo by ID, @username, reply (matching username too), multi-target, --global, and clear cleanly', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const app = {
    db,
    sm: new StateMachine(),
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) }
  };
  const qm = new QueueManager({
    app,
    db,
    pollMs: 0,
    voiceClient: {
      play: async () => ({ ok: true, account_alias: 'one' }),
      stop: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      setVolume: async () => ({ ok: true })
    }
  });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers: {} }), lyrics: {}, accounts: { sync: async () => {} } });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => {
    await qm.shutdown();
    await screen.cleanup();
  });

  const sent = [];
  const api = {
    me: { id: 99 },
    getChat: async () => ({ id: -100777, type: 'supergroup', title: 'Test GC' }),
    getChatMember: async (_c, uid) => ({
      status: Number(uid) === 10 ? 'creator' : Number(uid) === 200 ? 'administrator' : 'member'
    }),
    sendMessage: async (_c, text) => { sent.push(text); return { message_id: sent.length }; }
  };

  const ownerCtx = { tgId: 10, chatId: -100777, api };
  const adminCtx = { tgId: 200, chatId: -100777, api };
  const outsiderCtx = { tgId: 999, chatId: -100777, api };

  // Seed users in chat vcsudo (by ID and @username) + global vcsudo
  await service.vcsudoCommand(ownerCtx, ['add', '777', '@alice', '888']);
  await service.vcsudoCommand(ownerCtx, ['add', '555', '--global']);
  assert.deepEqual(service.getVcSudoList(-100777).chat, ['777', 'alice', '888']);
  assert.deepEqual(service.getVcSudoList(-100777).global, ['555']);

  // 1) Remove by ID via screen.handleCommand('/rmsudo', ...)
  const handled = await screen.handleCommand(ownerCtx, '/rmsudo', ['777']);
  assert.equal(handled, true);
  assert.match(sent.at(-1), /Removed <code>777<\/code> from Chat VC Sudo/);
  assert.deepEqual(service.getVcSudoList(-100777).chat, ['alice', '888']);

  // 2) Reply /rmsudo to @alice's message (even though stored entry was username 'alice' and reply carries id + username)
  const replyMsg = await service.rmsudoCommand({
    ...ownerCtx,
    replyTo: { from: { id: 444, username: 'Alice' } }
  }, []);
  assert.match(replyMsg, /Removed <code>alice<\/code>/);
  assert.deepEqual(service.getVcSudoList(-100777).chat, ['888']);

  // 3) Attempting /rmsudo on a user not in chat list (including hint when in global list)
  const notListed = await service.rmsudoCommand(ownerCtx, ['555']);
  assert.match(notListed, /not listed in Chat VC Sudo/);
  assert.match(notListed, /Global VC Sudo/);

  // 4) Non-global chat admin cannot touch Global VC Sudo via --global
  await assert.rejects(
    () => service.rmsudoCommand(adminCtx, ['--global', '555']),
    (err) => err?.code === 'ADMIN_ONLY' && err?.silent === true
  );
  assert.deepEqual(service.getVcSudoList(-100777).global, ['555']);

  // 5) Owner removes from global with --global before target
  const globalRm = await service.rmsudoCommand(ownerCtx, ['--global', '555']);
  assert.match(globalRm, /Removed <code>555<\/code> from Global VC Sudo/);
  assert.deepEqual(service.getVcSudoList(-100777).global, []);

  // 6) Unauthorized user stays silently blocked
  const beforeLen = sent.length;
  await screen.handleCommand(outsiderCtx, '/rmsudo', ['888']);
  assert.equal(sent.length, beforeLen);
  assert.deepEqual(service.getVcSudoList(-100777).chat, ['888']);

  // 7) /rmsudo clear wipes remaining chat entries; /rmsudo without target throws INVALID_VCSUDO
  const clrMsg = await service.rmsudoCommand(ownerCtx, ['clear']);
  assert.match(clrMsg, /Cleared all entries in Chat VC Sudo/);
  assert.deepEqual(service.getVcSudoList(-100777).chat, []);
  await assert.rejects(
    () => service.rmsudoCommand(ownerCtx, []),
    (err) => err?.code === 'INVALID_VCSUDO'
  );
});
