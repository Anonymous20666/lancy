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


