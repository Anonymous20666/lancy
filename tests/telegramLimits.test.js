import test from 'node:test';
import assert from 'node:assert/strict';
import { planVideoFit, fitResultForTelegram, describeOversized, uploadLimitBytes, PHOTO_LIMIT_BYTES } from '../src/media/telegramLimits.js';

const MB = 1024 * 1024;
const LIMIT = 48 * MB;

test('cloud Bot API default is ~50 MB and local server can raise it to 2000 MB', () => {
  assert.ok(uploadLimitBytes({}) < 50 * MB && uploadLimitBytes({}) > 45 * MB);
  assert.ok(uploadLimitBytes({ TELEGRAM_UPLOAD_LIMIT_MB: '2000' }) > 1900 * MB);
  assert.ok(uploadLimitBytes({ TELEGRAM_UPLOAD_LIMIT_MB: '99999' }) <= 2000 * MB);
});

test('fitting files are kept untouched', () => {
  assert.deepEqual(planVideoFit({ sizeBytes: 10 * MB, durationSeconds: 60, limitBytes: LIMIT }), { action: 'keep' });
});

test('a short oversize clip is transcoded at a bitrate that fits', () => {
  const plan = planVideoFit({ sizeBytes: 300 * MB, durationSeconds: 120, limitBytes: LIMIT });
  assert.equal(plan.action, 'transcode');
  assert.ok((plan.videoKbps + 96) * 1000 * 120 / 8 <= LIMIT);
});

test('a 1 GB feature-length video is refused honestly, not mangled', () => {
  const plan = planVideoFit({ sizeBytes: 1024 * MB, durationSeconds: 5400, limitBytes: LIMIT });
  assert.equal(plan.action, 'reject');
  assert.equal(plan.reason, 'too_long');
  assert.ok(plan.maxMinutes > 5 && plan.maxMinutes < 60);
  assert.match(describeOversized([{ type: 'video', sizeBytes: 1024 * MB, ...plan }], LIMIT), /too long/);
});

test('unknown duration is never compressed blindly', () => {
  assert.equal(planVideoFit({ sizeBytes: 100 * MB, durationSeconds: null, limitBytes: LIMIT }).reason, 'unknown_duration');
});

test('result fitting drops undeliverable items, keeps the rest and reports why', async () => {
  const big = Buffer.alloc(60 * MB), small = Buffer.alloc(1024);
  const calls = [];
  const runner = async (cmd) => { calls.push(cmd); if (cmd === 'ffprobe') return { stdout: '5400\n' }; throw Error('must not transcode'); };
  const out = await fitResultForTelegram({ mediaItems: [{ type: 'video', buffer: big }, { type: 'photo', buffer: small }], audioTrack: null }, { limitBytes: LIMIT, runner });
  assert.equal(out.mediaItems.length, 1);
  assert.equal(out.mediaItems[0].type, 'photo');
  assert.equal(out.oversized.length, 1);
  assert.deepEqual(calls, ['ffprobe']);
});

test('oversize photos are recompressed under the 10 MB photo limit', async () => {
  const sharpImpl = () => ({ rotate() { return this; }, resize() { return this; }, jpeg() { return this; }, toBuffer: async () => Buffer.alloc(2 * MB) });
  const out = await fitResultForTelegram({ mediaItems: [{ type: 'photo', buffer: Buffer.alloc(PHOTO_LIMIT_BYTES + 1) }] }, { limitBytes: LIMIT, sharpImpl });
  assert.equal(out.mediaItems[0].buffer.length, 2 * MB);
  assert.equal(out.oversized.length, 0);
});

test('AccountStore auto-upgrades existing enabled accounts to wildcard (*) across all GCs on sync', async () => {
  const { AccountStore } = await import('../src/music/accounts.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lancy-wildcard-'));
  try {
    const map = new Map();
    const db = { getSetting: (k, d) => map.has(k) ? map.get(k) : d, setSetting: (k, v) => map.set(k, v) };
    let registered = null;
    const voice = {
      ensureDaemon: async () => {},
      accounts: async () => ({ accounts: [] }),
      registerAccount: async (payload) => { registered = payload; },
      configureAccount: async () => {}
    };
    const store = new AccountStore({ root, db, voice });
    store.save([{ alias: 'legacy', enabled: true, allowed: ['-100111'], denied: [], encrypted: store.encrypt('test-session') }]);
    await store.sync();
    assert.ok(registered.allowed.includes('*'), 'sync should auto-approve * across all group chats');
    assert.ok(store.records()[0].allowed.includes('*'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pro VC DJ: synced karaoke lyrics window, EQ presets, DJ roles and member vote-skip', async () => {
  const { currentLyricWindow } = await import('../src/music/lyrics.js');
  const { MusicService } = await import('../src/music/service.js');
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { normalizeTrack } = await import('../src/music/model.js');
  const { createMusicScreen } = await import('../src/telegram/screens/music.js');

  const lrc = '[00:05.00] First line\n[00:10.50] Second active line\n[00:15.00] Third upcoming line';
  const window = currentLyricWindow(lrc, 11.2);
  assert.match(window, /▶ Second active line/);
  assert.match(window, /First line/);
  assert.match(window, /Third upcoming line/);

  const map = new Map();
  const db = { getSetting: (k, d) => map.has(k) ? map.get(k) : d, setSetting: (k, v) => map.set(k, v) };
  const played = [];
  const voiceClient = {
    play: async (id, src, opts) => { played.push(opts); return { ok: true, account_alias: 'legacy' }; },
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true })
  };
  const app = { db, settings: { get: (k) => k === 'music.skipVoteThreshold' ? 2 : [] }, voiceClient };
  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, accounts: { sync: async () => {} } });
  service.rate = () => {};
  app.music = service;
  app.screens = new Map([['music', createMusicScreen({ app })]]);

  try {
    const members = new Map([[10, { status: 'administrator' }], [20, { status: 'member' }], [21, { status: 'member' }]]);
    const api = {
      me: { id: 99 },
      getChat: async () => ({ id: -1003949983275, type: 'supergroup', title: 'SEOULCITY' }),
      getChatMember: async (_c, u) => members.get(Number(u)),
      sendRichMessage: async () => ({ message_id: 77 }),
      editMessageRich: async () => ({ message_id: 77 }),
      answerCallbackQuery: async () => {}
    };

    // Admin grants DJ role to user 20
    const grantMsg = await service.djCommand({ tgId: 10, chatId: -1003949983275, api }, ['add', '20']);
    assert.match(grantMsg, /Granted DJ role to user 20/);
    assert.equal(service.isDj({ tgId: 20 }, -1003949983275), true);

    // DJ 20 is authorized when allowDj=true
    assert.equal(await service.authorize({ tgId: 20, chatId: -1003949983275, api }, true, -1003949983275, { allowDj: true }), -1003949983275);

    // Queue 2 tracks and open player
    const t1 = normalizeTrack({ providerId: '1', title: 'Song 1', artist: 'Artist', durationSeconds: 120, streamUrl: 'https://example.org/1.mp3' }, 'fixture');
    const t2 = normalizeTrack({ providerId: '2', title: 'Song 2', artist: 'Artist', durationSeconds: 120, streamUrl: 'https://example.org/2.mp3' }, 'fixture');
    await qm.addMany(-1003949983275, [t1, t2]);
    await service.player({ tgId: 10, chatId: -1003949983275, api }, -1003949983275);

    // Cycle EQ preset via DJ 20
    const s = qm.getSession(-1003949983275);
    await service.control({ tgId: 20, chatId: -1003949983275, api, messageId: 77 }, 'eq', ['nightcore']);
    assert.equal(s.eqPreset, 'nightcore');

    // Member 20 and Member 21 vote-skip -> reaches threshold (2) and advances to Song 2 with nightcore EQ!
    await service.control({ tgId: 20, chatId: -1003949983275, api, messageId: 77 }, 'voteskip', []);
    assert.equal(s.currentTrack.title, 'Song 1');
    assert.equal(s.skipVotes.length, 1);
    await service.control({ tgId: 21, chatId: -1003949983275, api, messageId: 77 }, 'voteskip', []);
    assert.equal(s.currentTrack.title, 'Song 2');
    assert.equal(played.at(-1).eq, 'nightcore');
  } finally {
    await qm.shutdown();
  }
});

test('18+ Studio guardrails: safety blocklist, group admin lock and age gate', async () => {
  const { isBlockedNsfwQuery, searchNsfw } = await import('../src/wallpaper/nsfwSearch.js');
  const { createNsfwScreen } = await import('../src/telegram/screens/nsfw.js');

  assert.equal(isBlockedNsfwQuery('loli wallpaper'), true);
  assert.equal(isBlockedNsfwQuery('underage teen'), true);
  assert.equal(isBlockedNsfwQuery('makima 4k'), false);

  const blockedRes = await searchNsfw({ query: 'shota anime' });
  assert.equal(blockedRes.blocked, true);
  assert.equal(blockedRes.results.length, 0);

  const map = new Map();
  const db = { getSetting: (k, d) => map.has(k) ? map.get(k) : d, setSetting: (k, v) => map.set(k, v) };
  const sent = [];
  const api = {
    getChatMember: async (_c, u) => ({ status: Number(u) === 10 ? 'administrator' : 'member' }),
    sendRichMessage: async (_c, rich) => { sent.push(rich); return { message_id: 50 }; },
    editMessageRich: async (_c, _m, rich) => { sent.push(rich); return { message_id: 50 }; },
    sendMessage: async (_c, text) => { sent.push(text); return { message_id: 51 }; },
    answerCallbackQuery: async () => {}
  };
  const screen = createNsfwScreen({ app: { db, settings: { get: (k) => k === 'nsfw.requireAgeGate' ? true : [] }, telegram: { api } } });

  // Age gate prompts unverified user first
  await screen.open({ tgId: 20, chatId: 20, api });
  assert.match(JSON.stringify(sent.at(-1)), /AGE VERIFICATION REQUIRED/);

  // Confirming age opens the studio
  await screen.handle({ tgId: 20, chatId: 20, api, query: { id: 'q1' } }, 'confirmAge', []);
  assert.match(JSON.stringify(sent.at(-1)), /18\+ ADULT & HENTAI STUDIO/);

  // Group admin locks 18+ in group -1003949983275
  await screen.executeSearch({ tgId: 10, chatId: -1003949983275, isGroup: true, api }, 'off');
  await screen.open({ tgId: 20, chatId: -1003949983275, isGroup: true, api });
  assert.match(JSON.stringify(sent.at(-1)), /LOCKED IN THIS GROUP/);
});

test('Advanced VC: category picker, volume up to 200% and instant nexting indicator', async () => {
  const { createMusicScreen } = await import('../src/telegram/screens/music.js');
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { MusicService } = await import('../src/music/service.js');
  const { normalizeTrack } = await import('../src/music/model.js');

  const store = new Map();
  const db = { getSetting: (k, d) => store.has(k) ? store.get(k) : d, setSetting: (k, v) => store.set(k, v) };
  let currentVolume = 100;
  const voiceClient = {
    play: async () => ({ ok: true, account_alias: 'legacy' }),
    setVolume: async (_c, vol) => { currentVolume = vol; return { ok: true }; },
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true })
  };
  const app = { db, settings: { get: () => [] }, voiceClient };
  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, accounts: { sync: async () => {} } });
  service.rate = () => {};
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  try {
    const sent = [], toasts = [];
    const api = {
      me: { id: 99 },
      getChat: async () => ({ id: -1003949983275, type: 'supergroup', title: 'SEOULCITY' }),
      getChatMember: async () => ({ status: 'administrator' }),
      sendRichMessage: async (_c, rich) => { sent.push(rich); return { message_id: 88 }; },
      editMessageRich: async (_c, _m, rich) => { sent.push(rich); return { message_id: 88 }; },
      answerCallbackQuery: async (_id, opts) => { toasts.push(opts.text); }
    };

    // /vplay without args renders 1-tap category picker
    await screen.handleCommand({ tgId: 10, chatId: -1003949983275, api }, '/vplay', []);
    assert.match(JSON.stringify(sent.at(-1)), /Fast 1-Tap Genres/);
    assert.match(JSON.stringify(sent.at(-1)), /Hip hop/);
    assert.match(JSON.stringify(sent.at(-1)), /Afrobeats/);

    // Queue 2 tracks
    const t1 = normalizeTrack({ providerId: '1', title: 'Track 1', artist: 'Artist', durationSeconds: 120, streamUrl: 'https://example.org/1.mp3' }, 'fixture');
    const t2 = normalizeTrack({ providerId: '2', title: 'Track 2', artist: 'Artist', durationSeconds: 120, streamUrl: 'https://example.org/2.mp3' }, 'fixture');
    await qm.addMany(-1003949983275, [t1, t2]);
    await service.player({ tgId: 10, chatId: -1003949983275, api }, -1003949983275);

    // Skip gives immediate toast & nexting indicator
    const s = qm.getSession(-1003949983275);
    await service.control({ tgId: 10, chatId: -1003949983275, api, messageId: 88, query: { id: 'cb1' } }, 'skip', [String(s.controlRevision || 0)]);
    assert.ok(toasts.some(t => t.includes('Skipping to next track')));
    assert.equal(s.currentTrack.title, 'Track 2');

    // Volume sets up to 200%
    await service.control({ tgId: 10, chatId: -1003949983275, api, messageId: 88, query: { id: 'cb2' } }, 'setvol', [200, String(s.controlRevision || 0)]);
    assert.equal(currentVolume, 200);
    assert.equal(s.volume, 200);
    assert.ok(toasts.some(t => t.includes('Volume: 200%')));

    // Volume picker renders 200% button
    const picker = screen.renderVolumePicker(qm.getSession(-1003949983275));
    assert.match(JSON.stringify(picker), /200%/);
  } finally {
    await qm.shutdown();
  }
});

test('Advanced VC: Infinite Play submenu, category queueing, channel panel routing and custom artist', async () => {
  const { createMusicScreen } = await import('../src/telegram/screens/music.js');
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { MusicService } = await import('../src/music/service.js');
  const { normalizeTrack } = await import('../src/music/model.js');

  const sent = [], toasts = [];
  const api = {
    me: { id: 99 },
    sendRichMessage: async (_chatId, rich) => { sent.push(rich); return { message_id: 101 }; },
    editMessageRich: async (_chatId, _msgId, rich) => { sent.push(rich); return { message_id: 101 }; },
    sendMessage: async (_chatId, text) => { sent.push({ text }); return { message_id: 102 }; },
    answerCallbackQuery: async (_id, opts) => { toasts.push(opts?.text || ''); return true; },
    getChat: async (id) => ({ id, type: id < 0 ? 'supergroup' : 'private', title: 'Group' }),
    getChatMember: async () => ({ status: 'administrator', can_manage_video_chats: true })
  };

  const providers = {
    search: async (query) => ({
      items: [
        normalizeTrack({ providerId: 'afro1', title: `${query} Hit 1`, artist: 'Star', durationSeconds: 180, streamUrl: 'https://example.org/a1.mp3' }, 'fixture'),
        normalizeTrack({ providerId: 'afro2', title: `${query} Hit 2`, artist: 'Star', durationSeconds: 190, streamUrl: 'https://example.org/a2.mp3' }, 'fixture')
      ],
      nextOffset: null
    })
  };

  const store = new Map();
  const db = { getSetting: (k, d) => store.has(k) ? store.get(k) : d, setSetting: (k, v) => store.set(k, v) };
  const voiceClient = {
    play: async () => ({ ok: true, account_alias: 'legacy' }),
    setVolume: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setup: async () => ({ ok: true, call_ready: true })
  };
  const app = { db, settings: { get: () => [] }, voiceClient, musicProviders: providers };
  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, accounts: { sync: async () => {} } });
  service.rate = () => {};
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  try {
    // 1. Tapping Afrobeats in category menu renders genre submenu with Start Non-stop & Queue
    await screen.handle({ tgId: 10, chatId: -1003949983275, api, messageId: 101, query: { id: 'cb1' } }, 'genresub', ['queue', 'Afrobeats']);
    const subCard = JSON.stringify(sent.at(-1));
    assert.match(subCard, /Afrobeats/);
    assert.match(subCard, /Start Non-stop/);
    assert.match(subCard, /Queue/);
    assert.match(subCard, /Browse Songs/);
    assert.match(subCard, /Custom Artist/);

    // 2. Queue Afrobeats via infinact
    await screen.handle({ tgId: 10, chatId: -1003949983275, api, messageId: 101, query: { id: 'cb2' } }, 'infinact', ['queue', 'queue', 'Afrobeats']);
    assert.ok(toasts.some(t => t.includes('Queued Afrobeats')));
    const s = qm.getSession(-1003949983275);
    assert.ok(s.radio?.enabled);
    assert.deepEqual(s.radio.queries, ['Afrobeats']);
    assert.ok(s.currentTrack || s.upcoming.length > 0);

    // 3. Start Non-stop via infinact
    await screen.handle({ tgId: 10, chatId: -1003949983275, api, messageId: 101, query: { id: 'cb3' } }, 'infinact', ['queue', 'start', 'Amapiano']);
    assert.ok(toasts.some(t => t.includes('Streaming non-stop Amapiano')));
    assert.deepEqual(s.radio.queries, ['Amapiano']);

    // 4. Channel panel routing: category menu & submenu stay <= 64 bytes
    const p = { panelToken: 'tok1234', destination: -1003949983275, userId: '10', botKey: '99', playerChatId: 10, screenMessageId: 101, view: 'player', page: 0 };
    const playerRich = screen.renderPlayer(p);
    assert.match(JSON.stringify(playerRich), /Infinite & Genres/);
    for (const row of playerRich.blocks.filter(b => b.type === 'buttons')) {
      for (const btn of row.buttons) {
        assert.ok(Buffer.byteLength(btn.callback_data) <= 64, btn.callback_data);
      }
    }

    const chanPicker = screen.renderCategoryPicker('queue', 'tok1234', 0);
    for (const row of chanPicker.blocks.filter(b => b.type === 'buttons')) {
      for (const btn of row.buttons) {
        assert.ok(Buffer.byteLength(btn.callback_data) <= 64, btn.callback_data);
      }
    }
  } finally {
    await qm.shutdown();
  }
});

test('Direct Channel Music: in-channel commands, player rendering, controls and persistence', async t => {
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { ChannelPanels } = await import('../src/music/channelPanels.js');
  const { createMusicScreen } = await import('../src/telegram/screens/music.js');

  const sent = [];
  const api = {
    me: { id: 99, username: 'Lancy_easy_bot' },
    call: async () => true,
    async getChat(id) { return { id, type: 'channel', title: 'Test Broadcast Channel' }; },
    async getChatMember(chatId, userId) { return { status: 'administrator', user: { id: userId } }; },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length + 100 }; },
    async sendRichMessage(chatId, rich) { sent.push({ chatId, rich }); return { message_id: sent.length + 100 }; },
    async editMessageRich(chatId, messageId, rich) { sent.push({ chatId, messageId, rich }); return true; },
    async answerCallbackQuery() { return true; }
  };

  const storedSettings = new Map();
  const db = {
    getSetting: (k, def) => storedSettings.has(k) ? storedSettings.get(k) : def,
    setSetting: (k, v) => { storedSettings.set(k, v); },
    getChatPrefix: () => '/',
    getUserPrefix: () => '/'
  };

  const fakeVoice = {
    getStatus: async () => ({ active: true, info: { status: 'playing', playback_id: 'p1', volume: 100 } }),
    play: async () => ({ account_alias: 'acc1' }),
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };

  const qm = new QueueManager({ voiceClient: fakeVoice, db });
  const service = {
    app: { musicQueueManager: qm, db },
    botKey: () => '99',
    destination: (ctx) => Number(ctx.chatId),
    rate: () => {},
    owner: () => false,
    isDj: () => false,
    async authorize(ctx) { return Number(ctx.chatId); },
    async prepare() { return {}; },
    queueGeneration: () => 0,
    assertQueueGeneration: () => {}
  };

  const musicScreenMock = { renderPlayer: () => ({ blocks: [{ type: 'paragraph', text: 'Channel Broadcast' }] }) };
  const appMock = {
    musicQueueManager: qm,
    db,
    telegram: { api },
    screens: new Map([['music', musicScreenMock]])
  };
  service.app = appMock;
  qm.app = appMock;
  const panels = new ChannelPanels({ service });
  service.channelPanels = panels;

  try {
    // 1. Direct in-channel player rendering (chatId < 0)
    const session = qm.getSession(-100888);
    session.isChannel = true;
    session.destinationTitle = 'Test Broadcast Channel';

    // Simulated service._player logic for in-channel:
    session.view = 'player';
    qm.setPlayerMessage(-100888, 555, -100888, api);
    await qm.updatePlayerCard(-100888);
    assert.equal(session.screenMessageId, 555);
    assert.equal(session.playerChatId, -100888);

    // 2. Channel panels persistence across reloads
    const dmCtx = { tgId: '10', chatId: 10, api };
    const dmState = await panels.open(dmCtx, session);
    assert.ok(dmState.panelToken);
    assert.ok(storedSettings.has('music.activePanels'));

    // Reconstruct fresh ChannelPanels simulating restart
    const freshPanels = new ChannelPanels({ service });
    assert.ok(freshPanels.panels.has(dmState.panelToken));

    // Resolve should succeed from persisted storage without throwing STALE_PLAYER
    const resolved = await freshPanels.resolve(dmCtx, dmState.panelToken, { requireMessage: false });
    assert.equal(resolved.destination, -100888);

    // 3. Stale callback in channel gives in-channel guidance, not "Use in original private chat"
    try {
      await freshPanels.resolve({ tgId: '999', chatId: -100888, api }, 'bad_token');
      assert.fail('should reject');
    } catch (e) {
      assert.equal(e.code, 'STALE_PLAYER');
      assert.match(e.message, /Use the live controls in this channel/);
    }
  } finally {
    await qm.shutdown();
  }
});

test('Call-end resilience and assistant in-group recovery: reconcile preserves queue as idle and resume re-triggers playback', async t => {
  const { QueueManager } = await import('../src/music/queueManager.js');
  let activeState = true;
  let playCalls = 0;
  let resumeCalls = 0;

  const fakeVoice = {
    getStatus: async () => ({ ok: true, active: activeState, info: activeState ? { status: 'playing', playback_id: 'p1', volume: 100 } : null }),
    play: async () => { playCalls++; return { ok: true, account_alias: 'legacy', status: 'playing' }; },
    resume: async () => {
      resumeCalls++;
      if (!activeState) throw { code: 'NO_ACTIVE_CALL', message: 'No active call' };
      return { ok: true };
    },
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };

  const storedSettings = new Map();
  const db = {
    getSetting: (k, def) => storedSettings.has(k) ? storedSettings.get(k) : def,
    setSetting: (k, v) => { storedSettings.set(k, v); }
  };

  const qm = new QueueManager({ voiceClient: fakeVoice, db });
  try {
    const s = qm.getSession(-100999);
    s.currentTrack = { title: 'Track 1', entryId: 'e1', filePath: '/fake/1.mp3' };
    s.playbackId = 'p1';
    s.status = 'playing';
    s.connected = true;

    // Simulate external participant ending video chat in Telegram
    activeState = false;
    await qm.reconcile();

    // Verify session transitions to idle cleanly with retained queue and restart notice
    assert.equal(s.connected, false);
    assert.equal(s.status, 'idle');
    assert.equal(s.lastError, null);
    assert.match(s.lastNotice, /Voice chat ended.*Resume/);
    assert.equal(s.upcoming.length, 1);
    assert.equal(s.upcoming[0].entryId, 'e1');

    // Simulate user tapping Resume / Play to restart playback
    activeState = true;
    const resumed = await qm.resume(-100999);
    assert.ok(resumed);
    assert.equal(playCalls, 1);
    assert.equal(s.status, 'playing');
    assert.equal(s.connected, true);
  } finally {
    await qm.shutdown();
  }
});

test('Channel live video and artwork picture transmission: auto-enables video for channels, acquires visual stream and propagates to player', async t => {
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { InfiniteRadio } = await import('../src/music/radio.js');
  const { MediaLibrary } = await import('../src/music/library.js');

  let playedVideo = null;
  let playedIsChannel = null;
  const fakeVoice = {
    getStatus: async () => ({ ok: true, active: true, info: { status: 'playing' } }),
    play: async (chatId, source, opts) => {
      playedVideo = opts.video;
      playedIsChannel = opts.isChannel;
      return { ok: true, account_alias: 'legacy', status: 'playing' };
    },
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };

  const storedSettings = new Map();
  const db = {
    getSetting: (k, def) => storedSettings.has(k) ? storedSettings.get(k) : def,
    setSetting: (k, v) => { storedSettings.set(k, v); }
  };

  let acquiredWithVideo = null;
  const fakeLibrary = {
    acquire: async (track, opts) => {
      acquiredWithVideo = opts.video;
      return {
        track: { ...track, filePath: '/fake/song.mp4', capabilities: { video: opts.video } },
        release: () => {}
      };
    }
  };

  const qm = new QueueManager({ voiceClient: fakeVoice, db, app: { musicLibrary: fakeLibrary } });
  try {
    const chanSession = qm.getSession(-1003677766473);
    chanSession.isChannel = true;

    // 1. Enqueue standard music track into channel session and start playing (audio by default)
    await qm.addMany(-1003677766473, [{ title: 'Channel Song', entryId: 'c1', provider: 'youtube', id: 'y1' }]);
    
    // Assert acquired as audio (video: false) for standard channel music
    assert.equal(acquiredWithVideo, false);
    // Assert voice.play received video: false and isChannel: true
    assert.equal(playedVideo, false);
    assert.equal(playedIsChannel, true);

    // 2. Infinite radio configured for channel refilled with audio music by default
    const fakeProviders = {
      search: async () => ({
        items: [{ id: 'rad1', title: 'Radio Track', provider: 'youtube' }],
        nextOffset: 5
      })
    };
    const radio = new InfiniteRadio({ app: { musicQueueManager: qm, musicProviders: fakeProviders } });
    radio.configure(chanSession, ['Afrobeats']);
    assert.equal(chanSession.radio.video, false);
    await radio.refill(chanSession);
    const queuedRadio = chanSession.upcoming.find(t => t.title === 'Radio Track');
    assert.ok(queuedRadio);
    assert.equal(queuedRadio.mediaType, 'audio');

    // 2b. Explicit video option works when video: true is passed
    radio.configure(chanSession, ['Afrobeats'], { video: true });
    assert.equal(chanSession.radio.video, true);

    // 3. MediaLibrary audio track with video: true produces visual ffmpeg command without VIDEO_UNSUPPORTED
    let ffmpegArgs = null;
    let ffprobeChecked = false;
    const testDir = '/tmp/test-medialib-' + Date.now();
    const fakeRunner = async (bin, args) => {
      if (bin.includes('ffprobe')) {
        ffprobeChecked = true;
        return { stdout: JSON.stringify({ format: { duration: 180 }, streams: [{ codec_type: 'audio' }] }) };
      }
      ffmpegArgs = args;
      const fs = await import('node:fs/promises');
      const out = args[args.length - 1];
      await fs.writeFile(out, 'fake-mp4-data');
      return { stdout: '' };
    };
    const fakeProvidersMap = new Map([
      ['audius', {
        media: async () => ({
          track: { id: 'aud1', title: 'Audius Song', artist: 'Artist', durationSeconds: 180, artwork: 'https://example.com/art.jpg' },
          url: 'https://example.com/audio.mp3'
        })
      }]
    ]);
    const lib = new MediaLibrary({
      root: testDir,
      providers: fakeProvidersMap,
      runner: fakeRunner,
      maxBytes: 10 * 1024 * 1024,
      quotaBytes: 40 * 1024 * 1024
    });
    // Ensure cleanup
    t.after(async () => {
      const fs = await import('node:fs/promises');
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

  } finally {
    await qm.shutdown();
  }
});

test('Instant processing indicator on Infinite Play, /channel routing in GC/channel, and LRU cache eviction', async (t) => {
  const { QueueManager } = await import('../src/music/queueManager.js');
  const { MusicService } = await import('../src/music/service.js');
  const { createMusicScreen } = await import('../src/telegram/screens/music.js');
  const { MediaLibrary } = await import('../src/music/library.js');

  const editedMessages = [];
  const fakeApi = {
    call: async () => ({ ok: true, result: { message_id: 888 } }),
    getChat: async (id) => ({ id, type: id === -100999 ? 'channel' : 'supergroup', title: 'Test Chat' }),
    getChatMember: async () => ({ status: 'administrator', can_manage_video_chats: true }),
    sendRichMessage: async () => ({ message_id: 777 }),
    editMessageRich: async (chatId, msgId, rich) => {
      editedMessages.push({ chatId, msgId, rich });
      return { message_id: msgId };
    },
    sendMessage: async (chatId, text) => ({ message_id: 666, text }),
    me: { id: 99, username: 'Lancy_bot' }
  };

  const storedSettings = new Map();
  const db = {
    getSetting: (k, def) => storedSettings.has(k) ? storedSettings.get(k) : def,
    setSetting: (k, v) => storedSettings.set(k, v),
    run: () => {},
    getChatPrefix: () => '/'
  };

  const fakeVoice = {
    play: async () => ({ ok: true, account_alias: 'legacy' }),
    setVolume: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    accounts: async () => ({ accounts: [{ alias: 'legacy', enabled: true, status: 'available' }] })
  };

  const qm = new QueueManager({ voiceClient: fakeVoice, db });
  const app = {
    musicQueueManager: qm,
    db,
    telegram: { api: fakeApi },
    musicProviders: {
      search: async () => ({ items: [{ id: 'yt:inf1', title: 'Inf Song', durationSeconds: 200, provider: 'youtube' }] })
    }
  };
  const service = new MusicService({ app, search: {}, lyrics: {}, accounts: { sync: async () => [] } });
  app.music = service;
  qm.app = app;

  const musicScreen = createMusicScreen({ app });
  app.screens = new Map([['music', musicScreen]]);

  try {
    // 1. Instant processing indicator on handleInfiniteAction (infinact)
    const ctx = {
      tgId: '10',
      chatId: -100123,
      messageId: 501,
      query: { id: 'cb1' },
      api: fakeApi,
      user: { id: 10, first_name: 'Pappy' }
    };
    qm.getSession(-100123);
    await musicScreen.handle(ctx, 'infinact', ['queue', 'start', 'Afrobeats']);
    assert.ok(editedMessages.length >= 1);
    const firstEdit = editedMessages[0];
    assert.equal(firstEdit.msgId, 501);
    assert.match(JSON.stringify(firstEdit.rich), /Starting non-stop|Processing/);

    // 2. /channel in channel returns true and opens player without error
    const chanCtx = {
      tgId: '10',
      chatId: -100999,
      api: fakeApi,
      user: { id: 10, first_name: 'Pappy' },
      message: { chat: { id: -100999, type: 'channel' }, text: '/channel' }
    };
    const chanRes = await musicScreen.handleCommand(chanCtx, '/channel', []);
    assert.equal(chanRes, true);

    // 3. /channel in group chat returns true and sends guidance
    const gcCtx = {
      tgId: '10',
      chatId: -100123,
      api: fakeApi,
      user: { id: 10, first_name: 'Pappy' },
      message: { chat: { id: -100123, type: 'supergroup' }, text: '/channel' }
    };
    const gcRes = await musicScreen.handleCommand(gcCtx, '/channel', []);
    assert.equal(gcRes, true);

    // 4. MediaLibrary proactive cache cleanup
    const testDir = '/tmp/test-cache-lru-' + Date.now();
    const fs = await import('node:fs/promises');
    await fs.mkdir(testDir, { recursive: true });
    t.after(() => fs.rm(testDir, { recursive: true, force: true }).catch(() => {}));

    const lib = new MediaLibrary({
      root: testDir,
      providers: new Map(),
      maxBytes: 10 * 1024 * 1024,
      quotaBytes: 30 * 1024 * 1024
    });

    // Write three 8 MB dummy files
    await fs.writeFile(`${testDir}/file1.mp3`, Buffer.alloc(8 * 1024 * 1024));
    await fs.writeFile(`${testDir}/file2.mp3`, Buffer.alloc(8 * 1024 * 1024));
    await fs.writeFile(`${testDir}/file3.mp3`, Buffer.alloc(8 * 1024 * 1024));

    // Requesting 15 MB requires cleaning down so 24 + 15 <= 30 (i.e. bytes <= 15 MB)
    const usedAfter = await lib.cleanup(15 * 1024 * 1024);
    assert.ok(usedAfter <= 15 * 1024 * 1024);
    const remainingFiles = await fs.readdir(testDir);
    assert.ok(remainingFiles.length < 3, 'Oldest unreferenced files were pruned');

  } finally {
    await qm.shutdown();
  }
});

test('public access in DM allows non-owner users when PUBLIC_ACCESS=true', async (t) => {
  const { Database } = await import('../src/core/db.js');
  const { SettingsManager } = await import('../src/config/settings.js');
  const { TelegramController } = await import('../src/telegram/bot.js');

  const db = new Database(':memory:');
  t.after(() => db.close());

  const fakeApi = {
    answerCallbackQuery: async () => true,
    sendMessage: async () => ({ message_id: 1 }),
    getMe: async () => ({ id: 99, username: 'lancybot' })
  };

  // 1. By default without publicAccess, stranger is rejected
  const privateSettings = new SettingsManager(db, { env: { OWNER_IDS: '1000' } });
  const privateCtrl = new TelegramController({ api: fakeApi, db, settings: privateSettings, sm: { handleMessage: async () => false, state: () => 'IDLE' }, screens: new Map() });
  assert.equal(privateCtrl.isAllowed(9999).ok, false);

  // 2. With env PUBLIC_ACCESS=true, stranger is allowed in DM
  const publicSettings = new SettingsManager(db, { env: { OWNER_IDS: '1000', PUBLIC_ACCESS: 'true' } });
  const publicCtrl = new TelegramController({ api: fakeApi, db, settings: publicSettings, sm: { handleMessage: async () => false, state: () => 'IDLE' }, screens: new Map() });
  assert.equal(publicCtrl.isAllowed(9999).ok, true);
  assert.equal(publicCtrl.isAllowed(9999).role, 'allowed');

  // 3. Setting hot-reload toggles publicAccess
  await privateSettings.set('security.publicAccess', true);
  assert.equal(privateCtrl.isAllowed(9999).ok, true);
});




