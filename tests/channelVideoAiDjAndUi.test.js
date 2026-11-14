import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { StudioCanvas } from '../src/music/studioCanvas.js';
import { MediaLibrary } from '../src/music/library.js';
import { VoiceClient } from '../src/music/voiceClient.js';
import { AiDjEngine } from '../src/music/aiDj.js';
import { InfiniteRadio, RADIO_CATEGORIES, rankTracksTrendingToOld } from '../src/music/radio.js';
import { searchYouTubeFast } from '../src/media/youtubeSearch.js';
import { QueueManager } from '../src/music/queueManager.js';
import { PlayMusicProvider } from '../src/music/providers.js';
import { SearchSessions } from '../src/music/search.js';
import { normalizeTrack, MusicError } from '../src/music/model.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { TelegramAPI } from '../src/telegram/api.js';
import { TelegramController } from '../src/telegram/bot.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';

const song = (n, artist = `Artist ${n}`, extra = {}) =>
  normalizeTrack(
    {
      providerId: String(n),
      title: `Track ${n}`,
      artist,
      durationSeconds: 185,
      streamUrl: `https://example.com/${n}.mp3`,
      capabilities: { stream: true, download: true, seek: true, video: Boolean(extra.video) },
      ...extra
    },
    extra.provider || 'fixture'
  );

function memoryDb() {
  const settings = new Map();
  return {
    getSetting: (k, d = null) => (settings.has(k) ? settings.get(k) : d),
    setSetting: (k, v) => settings.set(k, v)
  };
}

test('StudioCanvas generates cached 1280x720 crisp PNG frames with or without artwork', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy-canvas-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const canvas = new StudioCanvas({ cacheDir: dir });
  const artBuf = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 120, g: 40, b: 190 } }
  }).png().toBuffer();

  const fileWithArt = await canvas.renderFrame({
    title: 'City Lights',
    artist: 'Burna Boy',
    album: 'Studio Session',
    durationSeconds: 210,
    provider: 'youtube',
    artworkBuffer: artBuf,
    isChannel: true,
    eqPreset: 'studio',
    djNote: 'Rolling live in Studio HD mix'
  });

  assert.equal(typeof fileWithArt, 'string');
  assert.ok(existsSync(fileWithArt));
  const meta = await sharp(fileWithArt).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);

  // Cache hit returns identical cached path
  const fileWithArt2 = await canvas.renderFrame({
    title: 'City Lights',
    artist: 'Burna Boy',
    album: 'Studio Session',
    durationSeconds: 210,
    provider: 'youtube',
    artworkBuffer: artBuf,
    isChannel: true,
    eqPreset: 'studio',
    djNote: 'Rolling live in Studio HD mix'
  });
  assert.equal(fileWithArt2, fileWithArt);

  // Vinyl fallback without artwork also renders 1280x720 PNG
  const fallbackFile = await canvas.renderFrame({
    title: 'Midnight Echoes',
    artist: 'Tems',
    durationSeconds: 180,
    isChannel: false
  });
  const fbMeta = await sharp(fallbackFile).metadata();
  assert.equal(fbMeta.width, 1280);
  assert.equal(fbMeta.height, 720);
});

test('MediaLibrary uses 720p stream-copy, Lanczos 720p upscale/downscale, and StudioCanvas for audio-only video', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy-lib720-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const commands = [];
  let probeScenario = { streams: [{ codec_type: 'audio' }] };
  const fakeRunner = async (bin, args) => {
    commands.push({ bin, args });
    if (String(bin).includes('ffprobe')) {
      if (args.some(a => String(a).includes('format=duration'))) {
        return { stdout: JSON.stringify({ format: { duration: 180 }, streams: [{ codec_type: 'audio' }, { codec_type: 'video' }] }), stderr: '' };
      }
      return { stdout: JSON.stringify(probeScenario), stderr: '' };
    }
    if (String(bin).includes('ffmpeg')) {
      const outPath = args.at(-1);
      if (outPath && !outPath.endsWith('.emb.jpg')) {
        await writeFile(outPath, Buffer.from('fixture-mp4-data'));
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const providers = {
    get: () => ({
      download: async (track, sourcePath) => {
        await writeFile(sourcePath, Buffer.from('source-audio-bytes'));
        return normalizeTrack({ ...track, durationSeconds: 180 }, 'youtube');
      }
    })
  };

  const library = new MediaLibrary({ root: dir, providers, runner: fakeRunner, ffmpeg: 'ffmpeg' });
  t.after(async () => library.shutdown());

  // 1) Audio-only track acquired in video mode -> encodes with StudioCanvas 1280x720 & loudnorm
  probeScenario = { streams: [{ codec_type: 'audio' }] };
  const audioAsVid = await library.acquire(song(10, 'Wizkid', { provider: 'youtube' }), {
    video: true,
    isChannel: true,
    eqPreset: 'studio',
    djNote: 'Channel Live Mix'
  });
  const canvasFfmpeg = commands.find(c => c.bin === 'ffmpeg' && c.args.includes('-tune') && c.args.includes('stillimage'));
  assert.ok(canvasFfmpeg, 'Expected ffmpeg call using StudioCanvas still image');
  assert.ok(canvasFfmpeg.args.some(a => a.includes('canvas-') && a.endsWith('.png')));
  assert.ok(canvasFfmpeg.args.includes('scale=1280:720:flags=lanczos,format=yuv420p'));
  assert.ok(canvasFfmpeg.args.includes('loudnorm=I=-16:TP=-1.5:LRA=11'));
  audioAsVid.release();

  // 2) <=720p H.264 source -> fast stream copy
  commands.length = 0;
  probeScenario = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }] };
  const hdCopy = await library.acquire(song(11, 'Rema', { provider: 'youtube' }), { video: true });
  const copyCall = commands.find(c => c.bin === 'ffmpeg' && c.args.includes('copy'));
  assert.ok(copyCall, 'Expected -c:v copy for 1280x720 H.264');
  hdCopy.release();

  // 3) >720p (1080p) video source -> clean Lanczos 1280x720 re-encode
  commands.length = 0;
  probeScenario = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }] };
  const hdDownscale = await library.acquire(song(12, 'Ayra Starr', { provider: 'youtube' }), { video: true });
  const transcodeCall = commands.find(c => c.bin === 'ffmpeg' && c.args.includes('libx264'));
  assert.ok(transcodeCall, 'Expected libx264 720p Lanczos transcode for 1080p source');
  assert.ok(transcodeCall.args.some(a => a.includes('scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos')));
  hdDownscale.release();
});

test('VoiceClient.play sends HD_720p video_quality and eq preset', async () => {
  let captured = null;
  const client = new VoiceClient({ app: { musicLibrary: { root: '/tmp' } } });
  client.ensureDaemon = async () => true;
  client.request = async (endpoint, opts) => {
    captured = { endpoint, opts };
    return { ok: true };
  };

  await client.play(-100777, '/tmp/test.mp4', {
    isChannel: true,
    video: true,
    eq: 'studio',
    durationSeconds: 180
  });

  assert.equal(captured.endpoint, '/call/play');
  assert.equal(captured.opts.body.video_quality, 'HD_720p');
  assert.equal(captured.opts.body.eq, 'studio');
  assert.equal(captured.opts.body.is_channel, true);
  assert.equal(captured.opts.body.video, true);
});

test('AiDjEngine persists config, avoids artist repetition, handles builtin vs LLM intros, and drives zero-stall lookahead', async t => {
  const db = memoryDb();
  let aiMode = 'builtin';
  let searchCall = 0;
  const app = {
    db,
    ai: {
      generate: async ({ task }) => {
        if (aiMode === 'external' && task === 'music_dj') {
          return { provider: 'ollama', text: 'Fresh external AI DJ segue — turning up the groove!' };
        }
        return { provider: 'builtin', text: 'omg bestie u totally love this!! ✨💕' };
      }
    },
    musicProviders: {
      search: async (q) => {
        searchCall++;
        return {
          items: [
            song(100 + searchCall, 'Burna Boy'),
            song(200 + searchCall, `Unique Artist ${searchCall}`)
          ],
          nextOffset: 5
        };
      }
    }
  };

  const voice = {
    play: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true })
  };

  const qm = new QueueManager({ app, voiceClient: voice, pollMs: 0 });
  t.after(async () => qm.shutdown());
  app.musicQueueManager = qm;
  const aiDj = new AiDjEngine({ app });
  app.music = { aiDj };

  // Persist toggle + vibe
  const cfg = aiDj.setVibe(-10088, 'Afro Sunset');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.vibe, 'Afro Sunset');
  assert.deepEqual(db.getSetting('music.aidj.-10088'), { enabled: true, vibe: 'Afro Sunset' });

  // Builtin girly output is bypassed for clean deterministic radio DJ line
  const session = qm.getSession(-10088);
  session.currentTrack = song(1, 'Burna Boy');
  const detNote = await aiDj.generateIntroNote(session, song(2, 'Wizkid'), session.currentTrack);
  assert.ok(!detNote.includes('bestie'));
  assert.ok(detNote.includes('Afro Sunset'));

  // External LLM output is used cleanly
  aiMode = 'external';
  const extNote = await aiDj.generateIntroNote(session, song(3, 'Tems'), session.currentTrack);
  assert.equal(extNote, 'Fresh external AI DJ segue — turning up the groove!');

  // Anti-repeat avoids Burna Boy since Burna Boy is currentTrack
  const curated = await aiDj.curateNextTracks(session, { count: 1 });
  assert.equal(curated.length, 1);
  assert.notEqual(curated[0].artist, 'Burna Boy');

  // Playing transitions with < 2 upcoming proactively refill via QueueManager without dropping to idle
  await qm.skip(-10088);
  assert.ok(session.currentTrack);
  assert.ok(session.upcoming.length >= 1, 'Expected proactive lookahead refill when upcoming < 2');
});

test('InfiniteRadio preserves isolated video mode across re-configures', () => {
  const radio = new InfiniteRadio({ app: { musicQueueManager: { closed: false } } });
  const s = { chatId: -1, upcoming: [], history: [] };
  radio.configure(s, ['Afrobeats'], { video: true });
  assert.equal(s.radio.video, true);
  radio.configure(s, ['Jazz'], { video: false });
  assert.equal(s.radio.video, false);
});

test('PlayMusicProvider.search supports real offset pagination via Deezer & iTunes', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('api.deezer.com')) {
      return new Response(JSON.stringify({
        data: Array.from({ length: 12 }, (_, i) => ({
          id: 5000 + i,
          title: `Song ${i}`,
          artist: { name: `Artist ${i}` },
          album: { title: 'Album', cover_xl: 'https://example.org/xl.jpg' },
          duration: 200
        })),
        next: 'https://api.deezer.com/search?index=50'
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };

  const provider = new PlayMusicProvider();
  const page = await provider.search('Afrobeats', { offset: 25, limit: 5 });
  assert.ok(requestedUrls.some(u => u.includes('index=25')));
  assert.ok(requestedUrls.some(u => u.includes('offset=25')));
  assert.equal(page.items.length, 5);
  assert.equal(page.items[0].artwork, 'https://example.org/xl.jpg');
  assert.equal(page.nextOffset, 30);
});

test('TelegramAPI.poll includes channel_post & edited_channel_post, controller routes channel commands & ignores passive channel URLs', async t => {
  let polledParams = null;
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });
  globalThis.fetch = async (_url, init) => {
    polledParams = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  };
  const liveApi = new TelegramAPI({ token: '0:test' });
  await liveApi.poll({ offset: 1, timeout: 1 });
  assert.ok(polledParams.allowed_updates.includes('channel_post'));
  assert.ok(polledParams.allowed_updates.includes('edited_channel_post'));

  // Test TelegramController handling anonymous channel_post commands and skipping passive URLs
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '9001' } });
  const sm = new StateMachine();
  const sent = [];
  const api = {
    me: { id: 99, username: 'lancy_test_bot' },
    getChat: async (id) => ({ id: Number(id), type: 'channel', title: 'Vibe FM' }),
    getChatMember: async (chatId, uid) => ({ status: [99, -10055, 202].includes(Number(uid)) ? 'administrator' : 'member', can_pin_messages: true }),
    sendRichMessage: async (id, rich) => { const m = { message_id: sent.length + 10 }; sent.push({ id, rich }); return m; },
    editMessageRich: async (id, mid, rich) => ({ message_id: mid, rich }),
    sendMessage: async (id, text) => { sent.push({ id, text }); return { message_id: sent.length + 10 }; },
    answerCallbackQuery: async () => true,
    call: async () => true
  };

  let downloadUrlCalled = false;
  let aidjVibeCalled = null;
  const voice = {
    play: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    setup: async () => ({ ok: true, status: 'ready' })
  };

  const app = { settings, db, sm, voiceClient: voice };
  app.musicQueueManager = new QueueManager({ app, voiceClient: voice, pollMs: 0 });
  t.after(async () => app.musicQueueManager.shutdown());
  app.musicProviders = { search: async () => ({ items: [song(50, 'Rema')], nextOffset: null }) };
  app.music = new MusicService({ app, search: new SearchSessions({ providers: app.musicProviders }), accounts: { sync: async () => {} } });
  const origAidj = app.music.aidjCommand.bind(app.music);
  app.music.aidjCommand = async (ctx, args) => {
    aidjVibeCalled = args;
    return origAidj(ctx, args);
  };

  const musicScreen = createMusicScreen({ app });
  musicScreen.registerStateHandlers(sm);
  t.after(async () => { await app.music.previews.shutdown(); await musicScreen.cleanup(); });
  const dlScreen = { handleUrl: async () => { downloadUrlCalled = true; }, executeDownload: async () => {} };
  const screens = new Map([['music', musicScreen], ['downloader', dlScreen]]);
  const controller = new TelegramController({ api, db, settings, sm, screens, app });

  // 1) Passive URL in channel_post must NOT trigger downloader interception
  await controller.handleUpdate({
    channel_post: {
      message_id: 1,
      chat: { id: -10055, type: 'channel', title: 'Vibe FM' },
      sender_chat: { id: -10055, type: 'channel', title: 'Vibe FM' },
      text: 'New drop out now: https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'
    }
  });
  assert.equal(downloadUrlCalled, false);

  // 2) Anonymous /aidj command in channel_post succeeds
  await controller.handleUpdate({
    channel_post: {
      message_id: 2,
      chat: { id: -10055, type: 'channel', title: 'Vibe FM' },
      sender_chat: { id: -10055, type: 'channel', title: 'Vibe FM' },
      text: '/aidj vibe Amapiano Night'
    }
  });
  assert.deepEqual(aidjVibeCalled, ['vibe', 'Amapiano', 'Night']);

  // 3) Verified channel admin (user 202) can operate an anonymous channel_post search card, while non-admin (user 303) fails closed
  const searchSession = app.music.search.create({
    userId: '-10055',
    chatId: -10055,
    botId: '99',
    destination: -10055,
    query: 'Rema',
    mode: 'video',
    isChannel: true
  });
  await app.music.search.page(searchSession, 0);

  const pickedOk = app.music.search.get(searchSession.id, { tgId: '202', chatId: -10055, api, channelAdminVerified: true });
  assert.equal(pickedOk.id, searchSession.id);

  assert.throws(
    () => app.music.search.get(searchSession.id, { tgId: '303', chatId: -10055, api, channelAdminVerified: false }),
    e => e.code === 'SEARCH_OWNER'
  );
});

test('MusicScreen Bot API 10.3 Rich UI elements and full 60-category pagination', () => {
  const screen = createMusicScreen({ app: { db: memoryDb(), settings: { get: () => 'Lancy' } } });

  // Player card contains bannerHeader + striped table + pullquote + progressBar + details(copy_text) + semantic styles
  const playerRich = screen.renderPlayer({
    chatId: -10099,
    status: 'playing',
    isChannel: true,
    destinationTitle: 'Lancy Live FM',
    currentTrack: song(1, 'Burna Boy', { video: true, mediaType: 'video' }),
    upcoming: [song(2, 'Wizkid')],
    positionSeconds: 45,
    volume: 100,
    loopMode: 'off',
    aiDj: { enabled: true, vibe: 'Afro Sunset', introNote: 'Cruising straight into Burna Boy!' },
    eqPreset: 'studio'
  });

  assert.ok(playerRich.blocks.some(b => b.type === 'heading'));
  assert.ok(playerRich.blocks.some(b => b.type === 'table'));
  assert.ok(playerRich.blocks.some(b => b.type === 'pullquote'));
  assert.ok(playerRich.blocks.some(b => b.type === 'details' && JSON.stringify(b).includes('copy_text')));
  assert.ok(playerRich.blocks.some(b => JSON.stringify(b).includes('CHANNEL LIVE BROADCAST')));
  assert.ok(playerRich.blocks.some(b => JSON.stringify(b).includes('"style":"danger"')));

  // Category picker reaches all 60 categories across pages 1..6 (after page 0 quick genres)
  const seenLabels = new Set();
  const totalPages = 1 + Math.ceil(RADIO_CATEGORIES.length / 10);
  for (let p = 1; p < totalPages; p++) {
    const pageRich = screen.renderCategoryPicker('queue', null, p);
    for (const block of pageRich.blocks) {
      if (block.type === 'buttons') {
        for (const btn of block.buttons) seenLabels.add(btn.text);
      }
    }
  }
  for (const cat of RADIO_CATEGORIES) {
    assert.ok(seenLabels.has(cat), `Missing category in picker pagination: ${cat}`);
  }
});

test('Channel anti-spam: deletes command posts, edits notices/menus in-place, uses callback alerts, and promotes card cleanly', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '202' } });
  const sm = new StateMachine();
  const channelId = -1003931725988;

  let nextId = 500;
  const deleted = [];
  const sends = [];
  const edits = [];
  const alerts = [];
  let failPrepare = true;

  const api = {
    me: { id: 99, username: 'Lancy_easy_bot' },
    getMe: async () => ({ id: 99, username: 'Lancy_easy_bot' }),
    getChat: async id => ({ id: Number(id), type: 'channel', title: 'Pappy-test' }),
    getChatMember: async (_c, uid) => Number(uid) === 99
      ? { status: 'administrator', can_post_messages: true, can_edit_messages: true, can_delete_messages: true, can_invite_users: true, can_promote_members: true, can_manage_video_chats: true }
      : { status: 'administrator', can_manage_video_chats: true },
    deleteMessage: async (c, m) => { deleted.push([Number(c), Number(m)]); return true; },
    sendMessage: async (c, text) => { const id = ++nextId; sends.push({ id, chatId: Number(c), text }); return { message_id: id, text }; },
    sendRichMessage: async (c, rich) => { const id = ++nextId; sends.push({ id, chatId: Number(c), rich }); return { message_id: id }; },
    editMessageRich: async (c, m, rich) => { edits.push({ id: Number(m), chatId: Number(c), rich }); return { message_id: Number(m) }; },
    editMessageText: async (c, m, text) => { edits.push({ id: Number(m), chatId: Number(c), text }); return { message_id: Number(m) }; },
    answerCallbackQuery: async (_id, opts) => { alerts.push(opts || {}); return true; },
    call: async () => true
  };

  const providers = {
    search: async q => ({ provider: 'audius', items: [song(1, q, { video: true })], nextOffset: null }),
    get: () => ({ media: async () => ({ track: song(1, 'Burna', { video: true }), url: 'https://example.com/v.mp4' }) })
  };
  const app = {
    db,
    settings,
    sm,
    musicProviders: providers,
    voiceClient: {
      accounts: async () => ({ accounts: [{ alias: 'a1', enabled: true, status: 'available' }] }),
      setup: async (_id, step) => {
        if (failPrepare) throw new MusicError('ACCOUNT_UNAVAILABLE', 'No enabled playback account is approved.');
        return step === 'identity' ? { user_id: 777, account_alias: 'a1' } : { ready: true, created: true };
      },
      play: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: async () => ({ active: true })
    },
    musicQueueManager: null,
    music: null,
    screens: new Map()
  };

  const qm = new QueueManager({ app, library: { acquire: async track => ({ track, filePath: '/tmp/a.mp4', release: async () => {} }) } });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers }), accounts: { sync: async () => [] } });
  app.music = service;
  const musicScreen = createMusicScreen({ app });
  app.screens.set('music', musicScreen);
  t.after(async () => { qm.shutdown(); await musicScreen.cleanup(); });

  // 1) Repeated failed commands in channel delete trigger command post & edit ONE single notice card in-place
  await musicScreen.handleCommand({
    tgId: '-1003931725988',
    chatId: channelId,
    isChannel: true,
    api,
    message: { message_id: 10, chat: { id: channelId, type: 'channel' }, text: '/aidj skip' }
  }, '/aidj', ['skip']);

  await musicScreen.handleCommand({
    tgId: '-1003931725988',
    chatId: channelId,
    isChannel: true,
    api,
    message: { message_id: 11, chat: { id: channelId, type: 'channel' }, text: '/vplay Burna Boy' }
  }, '/vplay', ['Burna', 'Boy']);

  assert.deepEqual(deleted, [[channelId, 10], [channelId, 11]]);
  assert.equal(sends.length, 1, 'Repeated channel command errors must post only ONE notice message');
  const firstNoticeId = sends[0].id;
  assert.ok(edits.filter(e => e.id === firstNoticeId).length >= 1, 'Second failed command must edit the exact same notice card in-place');

  // Media-attached channel posts with captions must NOT be deleted
  await musicScreen.handleCommand({
    tgId: '-1003931725988',
    chatId: channelId,
    isChannel: true,
    api,
    message: { message_id: 12, chat: { id: channelId, type: 'channel' }, caption: '/aidj skip', photo: [{ file_id: 'p1' }] }
  }, '/aidj', ['skip']);
  assert.equal(deleted.some(([, id]) => id === 12), false, 'Channel media posts must not be deleted');

  // 2) /vplay (no args) reuses existing notice slot instead of posting a duplicate card
  await musicScreen.handleCommand({
    tgId: '-1003931725988',
    chatId: channelId,
    isChannel: true,
    api,
    message: { message_id: 13, chat: { id: channelId, type: 'channel' }, text: '/vplay' }
  }, '/vplay', []);
  assert.equal(deleted.some(([, id]) => id === 13), true);
  assert.equal(sends.length, 1, '/vplay no-args should edit the existing slot instead of sending a new card');
  assert.match(JSON.stringify(edits.at(-1).rich), /Afrobeats|Pick a genre/);

  // 3) Failing callback on menu after "⏳ Processing…" uses alert toast AND edits card cleanly into Notice (no spam!)
  const sendCountBeforeCb = sends.length;
  await musicScreen.handle({
    tgId: '202',
    chatId: channelId,
    messageId: firstNoticeId,
    isChannel: true,
    query: { id: 'q-fail', message: { message_id: firstNoticeId, chat: { id: channelId, type: 'channel' } } },
    api
  }, 'infinact', ['video', 'start', 'Afrobeats']);
  assert.equal(sends.length, sendCountBeforeCb, 'Callback error must NOT post a new channel message');
  assert.equal(alerts.some(a => a.show_alert === true && /playback account|missing|undefined/i.test(a.text)), true, 'Callback error must display native alert');
  assert.equal(edits.at(-1).id, firstNoticeId);
  assert.match(JSON.stringify(edits.at(-1).rich), /Action could not complete/);

  // 4) Once voice account is enabled, infinact promotes that exact same card into the single channel Player Card!
  failPrepare = false;
  await musicScreen.handle({
    tgId: '202',
    chatId: channelId,
    messageId: firstNoticeId,
    isChannel: true,
    query: { id: 'q-ok', message: { message_id: firstNoticeId, chat: { id: channelId, type: 'channel' } } },
    api
  }, 'infinact', ['video', 'start', 'Afrobeats']);
  assert.equal(sends.length, sendCountBeforeCb, 'Promoting channel card to Player must edit in-place without sending a second post');
  assert.equal(qm.getSession(channelId).screenMessageId, firstNoticeId);
  assert.match(JSON.stringify(edits.at(-1).rich), /CHANNEL LIVE BROADCAST/);

  // 5) With Player active at firstNoticeId, opening /vplay and tapping another genre cleans up the transient menu card
  await musicScreen.handleCommand({
    tgId: '-1003931725988',
    chatId: channelId,
    isChannel: true,
    api,
    message: { message_id: 14, chat: { id: channelId, type: 'channel' }, text: '/vplay' }
  }, '/vplay', []);
  assert.equal(sends.length, sendCountBeforeCb + 1);
  const menuCardId = sends.at(-1).id;
  await musicScreen.handle({
    tgId: '202',
    chatId: channelId,
    messageId: menuCardId,
    isChannel: true,
    query: { id: 'q-ok2', message: { message_id: menuCardId, chat: { id: channelId, type: 'channel' } } },
    api
  }, 'infinact', ['video', 'start', 'Amapiano']);
  assert.equal(deleted.some(([, id]) => id === menuCardId), true, 'Transient menu card must be deleted after updating the single active Player Card');
});

test('MediaLibrary synthesizes 1280x720 StudioCanvas MP4 for channel audio (/vc) streams while downloading audio-only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy-ch-vc-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const commands = [];
  const downloadCalls = [];
  const fakeRunner = async (bin, args) => {
    commands.push({ bin, args });
    if (String(bin).includes('ffprobe')) {
      return {
        stdout: JSON.stringify({
          format: { duration: 150 },
          streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1280, height: 720 }]
        }),
        stderr: ''
      };
    }
    if (String(bin).includes('ffmpeg')) {
      const outPath = args.at(-1);
      if (outPath && !outPath.endsWith('.emb.jpg')) {
        await writeFile(outPath, Buffer.from('fixture-channel-mp4'));
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const providers = {
    get: () => ({
      download: async (track, sourcePath, opts) => {
        downloadCalls.push(opts);
        await writeFile(sourcePath, Buffer.from('source-audio-bytes'));
        return normalizeTrack({ ...track, durationSeconds: 150 }, 'youtube');
      }
    })
  };

  const library = new MediaLibrary({ root: dir, providers, runner: fakeRunner, ffmpeg: 'ffmpeg' });
  t.after(async () => library.shutdown());

  const media = await library.acquire(song(77, 'Burna Boy', { provider: 'youtube' }), {
    video: false,
    isChannel: true,
    eqPreset: 'bass',
    djNote: 'Channel Audio Canvas'
  });
  assert.equal(downloadCalls[0].video, false, 'Channel /vc audio mode downloads audio source rather than raw video');
  assert.match(media.filePath, /\.mp4$/, 'Channel /vc produces an MP4 container with StudioCanvas video for channel streams');
  assert.equal(media.track.mediaType, 'audio');
  const canvasFfmpeg = commands.find(c => c.bin === 'ffmpeg' && c.args.some(a => String(a).includes('canvas-')));
  assert.ok(canvasFfmpeg, 'Expected StudioCanvas PNG to be muxed into channel /vc MP4');
  media.release();
});

test('InfiniteRadio & searchYouTubeFast deliver trending->old real music videos (no fake cards, no AAC re-encode on H.264+AAC)', async t => {
  // 1) searchYouTubeFast with video:true queries official music video (never official audio) & parses views/age
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestedBodies = [];
  globalThis.fetch = async (_url, opts) => {
    requestedBodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [{
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'oldclassic01',
                        title: { runs: [{ text: 'Classic Throwback (Official Video)' }] },
                        ownerText: { runs: [{ text: 'LegendTV' }] },
                        lengthText: { simpleText: '4:10' },
                        viewCountText: { simpleText: '120,000,000 views' },
                        publishedTimeText: { simpleText: '10 years ago' }
                      }
                    },
                    {
                      videoRenderer: {
                        videoId: 'trendhit001',
                        title: { runs: [{ text: 'Fresh Smash (Official Music Video)' }] },
                        ownerText: { runs: [{ text: 'StarTV' }] },
                        lengthText: { simpleText: '3:30' },
                        viewCountText: { simpleText: '35,000,000 views' },
                        publishedTimeText: { simpleText: '4 months ago' }
                      }
                    }
                  ]
                }
              }]
            }
          }
        }
      }
    }), { status: 200 });
  };

  const ytResults = await searchYouTubeFast('Afrobeats', 'NG', { wide: true, radio: true, video: true });
  assert.ok(requestedBodies.some(b => /official music video/i.test(b.query)));
  assert.ok(requestedBodies.every(b => !/official audio/i.test(b.query)));
  assert.equal(ytResults.find(x => x.videoId === 'trendhit001').viewCount, 35_000_000);
  assert.equal(ytResults.find(x => x.videoId === 'trendhit001').publishedAgeDays, 120);

  // 2) rankTracksTrendingToOld deterministically orders: recent trending -> viral modern -> older classics -> Topic audio
  const unordered = [
    normalizeTrack({ providerId: 'topic1', title: 'Song (Official Audio)', artist: 'Artist - Topic', durationSeconds: 200, viewCount: 50_000_000, publishedAgeDays: 90 }, 'youtube'),
    normalizeTrack({ providerId: 'old1', title: 'Old Anthem (Official Video)', artist: 'OldArtist', durationSeconds: 220, viewCount: 250_000_000, publishedAgeDays: 3650 }, 'youtube'),
    normalizeTrack({ providerId: 'mid1', title: 'Mid Viral Hit (Official Video)', artist: 'MidArtist', durationSeconds: 210, viewCount: 900_000_000, publishedAgeDays: 1460 }, 'youtube'),
    normalizeTrack({ providerId: 'new1', title: 'Trending Banger (Official Music Video)', artist: 'NewArtist', durationSeconds: 195, viewCount: 25_000_000, publishedAgeDays: 150 }, 'youtube'),
    normalizeTrack({ providerId: 'talk1', title: 'Podcast Reacting To Beats', artist: 'Talker', durationSeconds: 300, viewCount: 40_000, publishedAgeDays: 5 }, 'youtube')
  ];
  const ranked = rankTracksTrendingToOld(unordered, { isVideo: true });
  assert.deepEqual(ranked.map(t => t.providerId), ['new1', 'mid1', 'old1', 'topic1', 'talk1']);

  // 3) Channel dashboard catmenu + InfiniteRadio.configure auto-enable real video when YouTube is enabled
  const youtubeStub = { id: 'youtube', enabled: true, search: async () => ({ items: [unordered[3]], nextOffset: null }) };
  const app = {
    settings: { get: () => [] },
    db: memoryDb(),
    sm: new StateMachine(),
    musicProviders: {
      adapters: new Map([['youtube', youtubeStub]]),
      get: id => (id === 'youtube' ? youtubeStub : null),
      search: async () => ({ items: [unordered[3]], nextOffset: null })
    },
    voiceClient: {
      accounts: async () => ({ accounts: [{ alias: 'p1', enabled: true, status: 'available' }] }),
      play: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: async () => ({ active: true })
    }
  };
  const qm = new QueueManager({ app, voiceClient: app.voiceClient, pollMs: 0 });
  t.after(async () => qm.shutdown());
  app.musicQueueManager = qm;
  app.music = new MusicService({ app, accounts: { sync: async () => [] }, lyrics: { get: async () => ({ found: false }) } });
  const screen = createMusicScreen({ app });
  t.after(async () => screen.cleanup());

  const chSession = qm.getSession(-10099);
  chSession.isChannel = true;
  const playerCard = screen.renderPlayer(chSession);
  const catBtn = playerCard.blocks.flatMap(b => b.buttons || []).find(b => b.text.includes('Infinite'));
  assert.ok(catBtn.callback_data.includes(':video:'), `Channel category button must open video mode by default (got ${catBtn.callback_data})`);

  app.music.radio.configure(chSession, ['Afrobeats']);
  assert.equal(chSession.radio.video, true, 'Channel InfiniteRadio must default to real video when YouTube is enabled');
  await app.music.radio.refill(chSession);
  assert.equal(chSession.upcoming[0].mediaType, 'video');

  // 4) MediaLibrary uses -c:v copy AND -c:a copy when 720p H.264 + AAC source is ready
  const dir = await mkdtemp(join(tmpdir(), 'lancy-fastremux-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let remuxArgs = null;
  const lib = new MediaLibrary({
    root: dir,
    providers: {
      get: () => ({
        download: async (track, src) => {
          await writeFile(src, Buffer.from('h264-aac-mp4'));
          return normalizeTrack({ ...track, durationSeconds: 200 }, 'youtube');
        }
      })
    },
    runner: async (bin, args) => {
      if (String(bin).includes('ffprobe')) {
        return {
          stdout: JSON.stringify({
            format: { duration: 200 },
            streams: [
              { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
              { codec_type: 'audio', codec_name: 'aac' }
            ]
          }),
          stderr: ''
        };
      }
      remuxArgs = args;
      await writeFile(args.at(-1), Buffer.from('remuxed-mp4'));
      return { stdout: '', stderr: '' };
    }
  });
  t.after(async () => lib.shutdown());
  const remuxed = await lib.acquire(song(91, 'Wizkid', { provider: 'youtube' }), { video: true, isChannel: true });
  assert.ok(remuxArgs);
  assert.equal(remuxArgs[remuxArgs.indexOf('-c:v') + 1], 'copy');
  assert.equal(remuxArgs[remuxArgs.indexOf('-c:a') + 1], 'copy');
  assert.equal(remuxArgs.includes('-ar'), false, 'Stream-copied AAC must not pass -ar resample flag');
  remuxed.release();
});

test('Spotify-on-TG: live charts, conversational AI DJ chat, group+channel HD video defaults, and Clean Bass EQ', async t => {
  const { getTrendingCharts, clearChartsCache } = await import('../src/music/charts.js');
  const { BuiltinProvider, BUILTIN_SYSTEM_PROMPTS } = await import('../src/ai/providers/builtin.js');
  const { decodeCallback } = await import('../src/telegram/rich.js');

  // 1) Builtin system prompts explicitly define music_dj tasks & never generate image-refusal nonsense
  assert.ok(BUILTIN_SYSTEM_PROMPTS.music_dj.includes('Spotify-style AI DJ'));
  assert.ok(BUILTIN_SYSTEM_PROMPTS.music_dj_curate.includes('Artist - Song'));
  assert.ok(BUILTIN_SYSTEM_PROMPTS.music_dj_chat.includes('Spotify-style AI DJ'));
  const builtin = new BuiltinProvider();
  const sampleCharts = [
    { artist: 'Rema', title: 'Bout U', rank: 1, popularity: 990000, genre: 'Afrobeats', source: 'deezer-global' },
    { artist: 'Asake', title: 'Forgiveness', rank: 2, popularity: 950000, genre: 'Afrobeats', source: 'apple-ng' }
  ];
  const trendChat = await builtin.generate({
    task: 'music_dj_chat',
    text: "what's trending right now?",
    context: { trending: sampleCharts, vibe: 'Afro Sunset' }
  });
  assert.ok(trendChat.includes('Rema') && trendChat.includes('Asake'));

  // 2) Live charts fetcher parses & caches Deezer + Apple RSS without duplicates
  clearChartsCache();
  let fetchCalls = 0;
  const fakeFetcher = async url => {
    fetchCalls++;
    if (url.includes('api.deezer.com')) {
      return { data: [{ title_short: 'Bout U', artist: { name: 'Rema' }, album: { title: 'HEIS' }, duration: 190, rank: 980000, position: 1 }] };
    }
    if (url.includes('/ng/')) {
      return { feed: { results: [{ name: 'Forgiveness', artistName: 'Asake', genres: [{ name: 'Afrobeats' }] }] } };
    }
    return { feed: { results: [{ name: 'Bout U', artistName: 'Rema', genres: [{ name: 'Afrobeats' }] }] } };
  };
  const charts = await getTrendingCharts({ genre: 'Afrobeats', fetcher: fakeFetcher });
  assert.equal(charts.length, 2);
  const callsAfterFirst = fetchCalls;
  await getTrendingCharts({ genre: 'Afrobeats', fetcher: fakeFetcher });
  assert.equal(fetchCalls, callsAfterFirst, 'Charts should be served from TTL cache');

  // 3) Conversational AI DJ chat + group & channel HD video defaults + Clean Bass default
  const youtubeStub = { id: 'youtube', enabled: true, search: async () => ({ items: [song(301, 'Rema', { video: true })], nextOffset: null }) };
  const members = new Map([[10, { status: 'administrator' }], [99, { status: 'administrator', can_manage_video_chats: true }]]);
  const sent = [];
  const api = {
    me: { id: 99, username: 'Lancy_easy_bot' },
    getChat: async id => ({ id, type: id === -10077 ? 'channel' : 'supergroup', title: id === -10077 ? 'ChannelX' : 'GroupX' }),
    getChatMember: async (_id, u) => members.get(Number(u)) || { status: 'member' },
    sendRichMessage: async (_c, rich) => { sent.push({ rich }); return { message_id: 500 + sent.length }; },
    editMessageRich: async (_c, id, rich) => ({ message_id: id, rich }),
    sendMessage: async (_c, text) => { sent.push({ text }); return { message_id: 600 + sent.length }; },
    answerCallbackQuery: async () => {}
  };
  const voice = {
    accounts: async () => ({ accounts: [{ alias: 'p1', enabled: true, status: 'available' }] }),
    play: async () => ({ ok: true, account_alias: 'p1' }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    status: async () => ({ active: true })
  };
  const app = {
    db: memoryDb(),
    sm: new StateMachine(),
    settings: { get: () => [] },
    ai: {
      generate: async ({ task }) => {
        if (task === 'music_dj_chat') return { provider: 'ollama', text: "I'm sorry, but I can't generate that image or video." };
        return { provider: 'builtin', text: 'fallback' };
      }
    },
    musicProviders: {
      adapters: new Map([['youtube', youtubeStub]]),
      get: id => (id === 'youtube' ? youtubeStub : null),
      search: async q => ({
        items: [song(400, q.includes('Asake') ? 'Asake' : 'Rema', { provider: 'youtube', video: true })],
        nextOffset: null
      })
    },
    voiceClient: voice
  };
  const qm = new QueueManager({ app, db: app.db, voiceClient: voice, pollMs: 0 });
  t.after(async () => qm.shutdown());
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers: app.musicProviders }), accounts: { sync: async () => [] }, lyrics: { get: async () => ({ found: false }) } });
  service.aiDj = new AiDjEngine({ app, fetchCharts: async () => sampleCharts });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => screen.cleanup());

  // Clean Bass default on session
  const grpSession = qm.getSession(-20055);
  assert.equal(grpSession.eqPreset, 'bass');
  assert.equal(grpSession.bass, true);

  // Group InfiniteRadio + catmenu also default to real video when YouTube is enabled
  const grpCard = screen.renderPlayer(grpSession);
  const catBtn = grpCard.blocks.flatMap(b => b.buttons || []).find(b => b.text.includes('Infinite'));
  const chatDjBtn = grpCard.blocks.flatMap(b => b.buttons || []).find(b => b.text.includes('Chat DJ'));
  const bassBtn = grpCard.blocks.flatMap(b => b.buttons || []).find(b => b.text.includes('Bass'));
  assert.ok(catBtn.callback_data.includes(':video:'), 'Group dashboard must open real video categories by default');
  assert.ok(chatDjBtn && Buffer.byteLength(chatDjBtn.callback_data) <= 64 && decodeCallback(chatDjBtn.callback_data));
  assert.ok(bassBtn && bassBtn.text.includes('ON') && Buffer.byteLength(bassBtn.callback_data) <= 64);

  service.radio.configure(grpSession, ['Afrobeats']);
  assert.equal(grpSession.radio.video, true, 'Group InfiniteRadio must default to real music video when YouTube is enabled');

  // Even when Ollama emits image-refusal nonsense, chatWithDj discards it and responds in Spotify X DJ persona with charts & queued HD videos!
  const chatRes = await service.djCommand({ tgId: 10, chatId: -20055, api }, ['play', 'afrobeats', 'with', 'studio', 'eq']);
  assert.equal(chatRes.kind, 'ai_chat');
  assert.ok(!chatRes.reply.includes("can't generate that image"), 'Image refusal hallucination must be stripped');
  assert.equal(grpSession.eqPreset, 'studio');
  assert.ok(grpSession.currentTrack?.mediaType === 'video' || grpSession.upcoming.some(t => t.mediaType === 'video'));

  const trendAsk = await service.djCommand({ tgId: 10, chatId: -20055, api }, ["what's", 'trending', 'right', 'now?']);
  assert.ok(trendAsk.reply.includes('Rema') && trendAsk.reply.includes('Asake'));

  // /dj add 20 still manages DJ roles without regressing
  const roleRes = await service.djCommand({ tgId: 10, chatId: -20055, api }, ['add', '20']);
  assert.match(roleRes, /Granted DJ role to user 20/);
});

test('Channel prompt state handoff (Chat DJ & Video Search), direct player replies, AI channel chat, and group strict rules', async t => {
  const { encodeCallback } = await import('../src/telegram/rich.js');
  const { LancyAssistant } = await import('../src/ai/assistant.js');

  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '9001' } });
  const sm = new StateMachine();
  const calls = [];
  let nextMsgId = 500;
  const api = {
    me: { id: 99, username: 'Lancy_easy_bot' },
    getChat: async id => ({
      id: Number(id),
      type: Number(id) === -10077 ? 'channel' : 'supergroup',
      title: Number(id) === -10077 ? 'Channel Vibe' : 'Group Chat'
    }),
    getChatMember: async (_chatId, uid) => ({
      status: [99, -10077, 202].includes(Number(uid)) ? 'administrator' : 'member',
      can_pin_messages: true
    }),
    sendRichMessage: async (chatId, rich) => {
      const msgId = ++nextMsgId;
      calls.push({ op: 'sendRichMessage', chatId, message_id: msgId, rich });
      return { message_id: msgId };
    },
    editMessageRich: async (chatId, message_id, rich) => {
      calls.push({ op: 'editMessageRich', chatId, message_id, rich });
      return { message_id };
    },
    sendMessage: async (chatId, text, extra = {}) => {
      const msgId = ++nextMsgId;
      calls.push({ op: 'sendMessage', chatId, message_id: msgId, text, extra });
      return { message_id: msgId };
    },
    editMessageText: async (chatId, message_id, text) => {
      calls.push({ op: 'editMessageText', chatId, message_id, text });
      return { message_id };
    },
    deleteMessage: async (chatId, message_id) => {
      calls.push({ op: 'deleteMessage', chatId, message_id });
      return true;
    },
    answerCallbackQuery: async (id, extra) => {
      calls.push({ op: 'answerCallbackQuery', id, extra });
      return true;
    },
    call: async () => true
  };

  const voice = {
    play: async () => ({ ok: true, account_alias: 'fixture' }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    status: async () => ({ active: true }),
    accounts: async () => ({ accounts: [{ alias: 'fixture', enabled: true, status: 'available' }] }),
    setup: async () => ({ ok: true, status: 'ready' })
  };
  const youtubeStub = { enabled: true };
  const sampleCharts = {
    source: 'apple-rss+deezer',
    tracks: [{ title: 'Calm Down', artist: 'Rema', genre: 'Afrobeats' }],
    byGenre: { Afrobeats: [{ title: 'Calm Down', artist: 'Rema', genre: 'Afrobeats' }] }
  };

  const app = { settings, db, sm, voiceClient: voice };
  app.ai = {
    generate: async ({ task, prompt }) => {
      if (task === 'music_dj_chat') {
        if (/Listener message:\s*"[^"]*afrobeats/i.test(prompt)) {
          return {
            provider: 'openai',
            text: 'Spinning Rema — Calm Down in HD!'
          };
        }
        return {
          provider: 'openai',
          text: 'Your vibe is warm Afrobeats energy right now!'
        };
      }
      return { provider: 'openai', text: `Lancy AI reply: ${String(prompt).slice(0, 60)}` };
    }
  };
  app.musicQueueManager = new QueueManager({ app, db, voiceClient: voice, pollMs: 0 });
  t.after(async () => app.musicQueueManager.shutdown());
  app.musicProviders = {
    adapters: new Map([['youtube', youtubeStub]]),
    get: id => (id === 'youtube' ? youtubeStub : null),
    search: async q => ({
      items: [song(600, q.includes('Asake') ? 'Asake' : 'Rema', { title: `${q} Official Video`, provider: 'youtube', video: true })],
      nextOffset: null
    })
  };
  app.music = new MusicService({
    app,
    search: new SearchSessions({ providers: app.musicProviders }),
    accounts: { sync: async () => [] },
    lyrics: { get: async () => ({ found: false }) }
  });
  app.music.aiDj = new AiDjEngine({ app, fetchCharts: async () => sampleCharts });
  app.assistant = new LancyAssistant({ app });

  const musicScreen = createMusicScreen({ app });
  musicScreen.registerStateHandlers(sm);
  t.after(async () => {
    await app.music.previews.shutdown();
    await musicScreen.cleanup();
  });
  const screens = new Map([['music', musicScreen]]);
  app.screens = screens;
  const controller = new TelegramController({ api, db, settings, sm, screens, app });

  // (a) Admin user 202 taps "Chat DJ" in channel -> prompt transitions channel stateKey -> anonymous channel_post gets non-trending DJ reply cleanly
  const djPromptData = encodeCallback('music', 'prompt', 'dj', 0);
  await controller.handleUpdate({
    callback_query: {
      id: 'cb-dj-prompt',
      from: { id: 202, first_name: 'Admin' },
      message: {
        message_id: 499,
        chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
        date: 1700000000
      },
      data: djPromptData
    }
  });
  const promptRichCall = calls.find(c => c.chatId === -10077 && c.rich && JSON.stringify(c.rich).includes('Interactive DJ Booth'));
  assert.ok(promptRichCall, 'Channel Chat DJ prompt must render as Rich card with cancel button');
  assert.ok(JSON.stringify(promptRichCall.rich).includes('cancelprompt'));

  const beforeDjCount = calls.length;
  await controller.handleUpdate({
    channel_post: {
      message_id: 700,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      text: "how's my vibe today?"
    }
  });
  const afterDjCalls = calls.slice(beforeDjCount);
  assert.ok(afterDjCalls.some(c => c.op === 'deleteMessage' && c.message_id === 700), 'User prompt trigger post should be deleted in channel');
  const djReplyCall = afterDjCalls.find(c => c.op === 'editMessageRich' && JSON.stringify(c.rich).includes('Spotify ✕ DJ'));
  assert.ok(djReplyCall, 'Non-trending Chat DJ reply must be delivered and reuse the channel prompt slot');
  assert.ok(JSON.stringify(djReplyCall.rich).toLowerCase().includes('afrobeats'), 'DJ reply text must appear on card');

  // Calling prompt('dj') again and requesting "play trending afrobeats" starts playback on Channel Player Card
  await controller.handleUpdate({
    callback_query: {
      id: 'cb-dj-play',
      from: { id: 202, first_name: 'Admin' },
      message: {
        message_id: djReplyCall.message_id,
        chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
        date: 1700000001
      },
      data: djPromptData
    }
  });
  await controller.handleUpdate({
    channel_post: {
      message_id: 701,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      text: 'play trending afrobeats'
    }
  });
  const chanSession = app.musicQueueManager.getSession(-10077);
  assert.ok(chanSession.screenMessageId, 'Playing via channel Chat DJ prompt must establish Player Card');

  // (b) Admin taps "Add tracks" (prompt('video')) on active Player Card -> posts anonymous channel_post "Rema Calm Down" -> renders HD video search results without overwriting Player Card
  const videoPromptData = encodeCallback('music', 'prompt', 'video', 0);
  await controller.handleUpdate({
    callback_query: {
      id: 'cb-video-prompt',
      from: { id: 202, first_name: 'Admin' },
      message: {
        message_id: chanSession.screenMessageId,
        chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
        date: 1700000002
      },
      data: videoPromptData
    }
  });
  const beforeSearchCount = calls.length;
  app.music.rates.clear();
  await controller.handleUpdate({
    channel_post: {
      message_id: 702,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      text: 'Rema Calm Down'
    }
  });
  const searchCalls = calls.slice(beforeSearchCount);
  assert.ok(searchCalls.some(c => c.op === 'editMessageRich' && JSON.stringify(c.rich).includes('Rema Calm Down') && !JSON.stringify(c.rich).includes('Searching')), 'Channel video search prompt must render search results');

  // Replying directly to Channel Player Card (even without reply_to_message.from): conversational question -> DJ chat; song name -> HD video search
  const beforePlayerReplyCount = calls.length;
  app.music.rates.clear();
  await controller.handleUpdate({
    channel_post: {
      message_id: 703,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      reply_to_message: { message_id: chanSession.screenMessageId },
      text: "what's trending?"
    }
  });
  const playerReplyCalls = calls.slice(beforePlayerReplyCount);
  assert.ok(playerReplyCalls.some(c => (c.op === 'editMessageRich' || c.op === 'sendRichMessage') && JSON.stringify(c.rich).includes('Spotify ✕ DJ')), 'Conversational reply to Channel Player Card must route to AI DJ');

  // Song title reply directly to Channel Player Card routes to HD video search
  const beforeSongReplyCount = calls.length;
  app.music.rates.clear();
  await controller.handleUpdate({
    channel_post: {
      message_id: 7031,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      reply_to_message: { message_id: chanSession.screenMessageId },
      text: 'Asake Lonely At The Top'
    }
  });
  const songReplyCalls = calls.slice(beforeSongReplyCount);
  assert.ok(songReplyCalls.some(c => (c.op === 'editMessageRich' || c.op === 'sendRichMessage') && JSON.stringify(c.rich).includes('Asake') && !JSON.stringify(c.rich).includes('Searching')), 'Song reply to Channel Player Card must search in video mode');

  // Tapping cancelprompt resets channel prompt state and deletes prompt card
  await controller.handleUpdate({
    callback_query: {
      id: 'cb-open-cancel-prompt',
      from: { id: 202, first_name: 'Admin' },
      message: {
        message_id: chanSession.screenMessageId,
        chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
        date: 1700000003
      },
      data: encodeCallback('music', 'prompt', 'dj', 0)
    }
  });
  const cancelNoticeCall = [...calls].reverse().find(c => (c.op === 'sendRichMessage' || c.op === 'editMessageRich') && JSON.stringify(c.rich).includes('cancelprompt'));
  assert.ok(cancelNoticeCall, 'Notice prompt card must exist to cancel');
  const beforeCancelCalls = calls.length;
  await controller.handleUpdate({
    callback_query: {
      id: 'cb-cancel-prompt',
      from: { id: 202, first_name: 'Admin' },
      message: {
        message_id: cancelNoticeCall.message_id,
        chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
        date: 1700000004
      },
      data: encodeCallback('music', 'cancelprompt')
    }
  });
  assert.equal(sm.state('-10077'), 'IDLE', 'cancelprompt must reset channel MUSIC_QUEUE_INPUT state');
  assert.ok(calls.slice(beforeCancelCalls).some(c => c.op === 'deleteMessage' && c.message_id === cancelNoticeCall.message_id), 'cancelprompt must delete the temporary prompt card');

  // (c) Direct AI mention & /ai in channel reach LancyAssistant; group strict non-AI & automatic_forward 777000 remain suppressed
  let assistantCalls = [];
  const origAssistantHandle = app.assistant.handleMessage.bind(app.assistant);
  app.assistant.handleMessage = async payload => {
    const { ctx, message, text } = payload || {};
    assistantCalls.push({ chatId: ctx?.chatId, isChannel: ctx?.isChannel, isGroup: ctx?.isGroup, text: text ?? message?.text });
    return origAssistantHandle(payload);
  };

  await controller.handleUpdate({
    channel_post: {
      message_id: 704,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      text: 'hey lancy tell me a joke'
    }
  });
  assert.equal(assistantCalls.length, 1, 'Tagging Lancy in a channel must reach assistant');
  assert.equal(assistantCalls[0].isGroup, false);

  await controller.handleUpdate({
    channel_post: {
      message_id: 705,
      chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      sender_chat: { id: -10077, type: 'channel', title: 'Channel Vibe' },
      text: "/ai what's trending right now"
    }
  });
  assert.equal(assistantCalls.length, 2, '/ai <prompt> in channel must route to assistant');

  // Automatic forward from linked channel discussion user 777000 must be ignored
  const beforeAutoCount = calls.length;
  await controller.handleUpdate({
    message: {
      message_id: 706,
      from: { id: 777000, first_name: 'Telegram' },
      is_automatic_forward: true,
      chat: { id: -20077, type: 'supergroup', title: 'Group Chat' },
      text: 'hey lancy tell me a joke'
    }
  });
  assert.equal(assistantCalls.length, 2, 'is_automatic_forward / 777000 must be ignored');
  assert.equal(calls.length, beforeAutoCount);

  // Strict Group non-AI rule remains intact
  await controller.handleUpdate({
    message: {
      message_id: 707,
      from: { id: 202, first_name: 'Member' },
      chat: { id: -20077, type: 'supergroup', title: 'Group Chat' },
      text: 'hey lancy tell me a joke'
    }
  });
  assert.equal(assistantCalls.length, 2, 'Group general AI mention must remain blocked unless /play song flow');
});

test('QueueManager & MediaLibrary instant-switch skips Preparing flash and duplicate setVolume when tracks are warmed', async t => {
  const voiceCalls = [];
  const cardSnapshots = [];
  let refs = 0;
  const cachedIds = new Set();

  const voice = {
    play: async (chatId, source, opts) => {
      voiceCalls.push({ op: 'play', chatId, source, opts });
      return { ok: true, account_alias: 'acc1' };
    },
    setVolume: async (chatId, volume) => {
      voiceCalls.push({ op: 'setVolume', chatId, volume });
      return { ok: true };
    },
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true })
  };

  const app = {
    musicLibrary: {
      hasReady: (track) => cachedIds.has(track.id),
      warm: async (track) => {
        cachedIds.add(track.id);
        return { track: { ...track, filePath: `/tmp/mock-${track.id}.mp4` }, release() {} };
      },
      acquire: async (track) => {
        cachedIds.add(track.id);
        refs++;
        let released = false;
        return {
          track: { ...track, filePath: `/tmp/mock-${track.id}.mp4` },
          release() {
            if (!released) {
              released = true;
              refs--;
            }
          }
        };
      }
    }
  };

  const qm = new QueueManager({
    app,
    voiceClient: voice,
    pollMs: 0,
    updateCard: async (session) => {
      cardSnapshots.push({
        status: session.status,
        title: session.currentTrack?.title || null,
        notice: session.lastNotice || null
      });
    }
  });
  t.after(async () => qm.shutdown());

  const tracks = [1, 2, 3, 4].map(n => song(n, `Artist ${n}`, { provider: 'youtube', video: true }));
  await qm.addMany(-5501, tracks);
  await new Promise(r => setTimeout(r, 15));

  // Initial track 1 calls setVolume once; tracks 2-4 are already cached/warmed, and only current + next[0] hold active refs
  const initialSetVolCount = voiceCalls.filter(c => c.op === 'setVolume').length;
  assert.equal(initialSetVolCount, 1);
  assert.equal(refs, 2);
  assert.ok(cachedIds.has(tracks[1].id) && cachedIds.has(tracks[2].id) && cachedIds.has(tracks[3].id), 'Expected upcoming 3 tracks to warm ahead of time');

  cardSnapshots.length = 0;
  voiceCalls.length = 0;

  // Skip to pre-warmed track 2: zero "Preparing..." card edit and zero redundant setVolume RPC
  const switched = await qm.skip(-5501);
  assert.equal(switched.providerId, '2');
  assert.ok(cardSnapshots.every(snap => !String(snap.notice || '').includes('Preparing')), 'Ready track switch must not flash Preparing...');
  assert.equal(voiceCalls.filter(c => c.op === 'setVolume').length, 0, 'Unchanged volume during active-call skip must skip redundant setVolume RPC');
  assert.equal(voiceCalls.filter(c => c.op === 'play').length, 1);

  // Explicit playNow to track 4 (already warmed) is also instant without Preparing... flash
  cardSnapshots.length = 0;
  const thirdEntryId = qm.getSession(-5501).upcoming.find(x => x.providerId === '4').entryId;
  const jumped = await qm.playNow(-5501, thirdEntryId);
  assert.equal(jumped.providerId, '4');
  assert.ok(cardSnapshots.every(snap => !String(snap.notice || '').includes('Preparing')));

  await qm.stop(-5501, { leave: true });
  assert.equal(refs, 0);
});

test('InfiniteRadio & AiDjEngine play artist A-to-Z without repeats then seamlessly expand to related category artists', async t => {
  const { getArtistCatalogAndRelated } = await import('../src/music/charts.js');

  // 1. Verify artist catalog + related artist resolution and category guard
  const mockFetcher = async (url) => {
    const u = String(url);
    if (u.includes('search/artist?q=Burna%20Boy')) {
      return { data: [{ id: 123, name: 'Burna Boy', nb_fan: 5000000 }] };
    }
    if (u.includes('/artist/123/top')) {
      return {
        data: [
          { title_short: 'Last Last', artist: { name: 'Burna Boy' }, album: { title: 'Love, Damini' }, rank: 990000, duration: 172 },
          { title_short: 'Ye', artist: { name: 'Burna Boy' }, album: { title: 'Outside' }, rank: 950000, duration: 231 }
        ]
      };
    }
    if (u.includes('/artist/123/related')) {
      return {
        data: [
          { id: 124, name: 'Wizkid', nb_fan: 4000000 },
          { id: 125, name: 'Rema', nb_fan: 3500000 }
        ]
      };
    }
    if (u.includes('itunes.apple.com/search')) {
      return {
        results: [
          { trackName: 'City Boys', artistName: 'Burna Boy', primaryGenreName: 'Afro-fusion', releaseDate: '2023-09-01', trackTimeMillis: 153000 },
          { trackName: 'Ye', artistName: 'Burna Boy', primaryGenreName: 'Afro-fusion', releaseDate: '2018-01-26', trackTimeMillis: 231000 }
        ]
      };
    }
    return {};
  };

  const resolved = await getArtistCatalogAndRelated('Burna Boy', { fetcher: mockFetcher, useCache: false });
  assert.equal(resolved.found, true);
  assert.equal(resolved.artist, 'Burna Boy');
  assert.equal(resolved.genre, 'Afro-fusion');
  assert.deepEqual(resolved.tracks.map(x => x.title), ['Last Last', 'Ye', 'City Boys']);
  assert.deepEqual(resolved.relatedArtists.map(x => x.name), ['Wizkid', 'Rema']);

  const moodSkipped = await getArtistCatalogAndRelated('Afro Sunset', { fetcher: mockFetcher, useCache: false });
  assert.equal(moodSkipped.found, false);

  // 2. InfiniteRadio plays full artist A-to-Z (no duplicate titles) -> related category artists
  const catalogByArtist = {
    'Burna Boy': {
      found: true,
      artist: 'Burna Boy',
      genre: 'Afro-fusion',
      tracks: [
        { title: 'Last Last', artist: 'Burna Boy' },
        { title: 'Ye', artist: 'Burna Boy' },
        { title: 'City Boys', artist: 'Burna Boy' }
      ],
      relatedArtists: [{ name: 'Wizkid', genre: 'Afro-fusion' }, { name: 'Rema', genre: 'Afro-fusion' }]
    },
    Wizkid: {
      found: true,
      artist: 'Wizkid',
      genre: 'Afro-fusion',
      tracks: [{ title: 'Essence', artist: 'Wizkid' }],
      relatedArtists: [{ name: 'Tems', genre: 'Afro-fusion' }]
    },
    Rema: {
      found: true,
      artist: 'Rema',
      genre: 'Afro-fusion',
      tracks: [{ title: 'Calm Down', artist: 'Rema' }],
      relatedArtists: []
    }
  };

  const radioApp = {
    music: {
      artistResolver: async (q) => catalogByArtist[q] || { found: false }
    },
    musicProviders: {
      search: async (q) => {
        const lower = String(q).toLowerCase();
        if (lower.includes('last last')) {
          return {
            items: [
              { ...song(10, 'Burna Boy', { provider: 'youtube' }), title: 'Last Last [Official Music Video]' },
              { ...song(11, 'Burna Boy', { provider: 'youtube' }), title: 'Last Last (Lyrics)' }
            ]
          };
        }
        if (lower.includes('ye')) return { items: [{ ...song(12, 'Burna Boy', { provider: 'youtube' }), title: 'Ye' }] };
        if (lower.includes('city boys')) return { items: [{ ...song(13, 'Burna Boy', { provider: 'youtube' }), title: 'City Boys' }] };
        if (lower.includes('essence') || lower.includes('wizkid')) return { items: [{ ...song(20, 'Wizkid', { provider: 'youtube' }), title: 'Essence' }] };
        if (lower.includes('calm down') || lower.includes('rema')) return { items: [{ ...song(21, 'Rema', { provider: 'youtube' }), title: 'Calm Down' }] };
        return { items: [] };
      }
    }
  };

  const qm = new QueueManager({ app: radioApp, voiceClient: { play: async () => ({ ok: true }), setVolume: async () => ({ ok: true }), stop: async () => ({ ok: true }), idle: async () => ({ ok: true }) }, pollMs: 0 });
  t.after(async () => qm.shutdown());
  radioApp.musicQueueManager = qm;

  const radio = new InfiniteRadio({ app: radioApp });
  const radioSession = qm.getSession(-6601);
  radio.configure(radioSession, ['Burna Boy']);

  // First refill plays Burna Boy A-to-Z songs cleanly without duplicate title
  await radio.refill(radioSession);
  assert.deepEqual(radioSession.upcoming.map(t => t.artist), ['Burna Boy', 'Burna Boy', 'Burna Boy']);
  assert.equal(new Set(radioSession.upcoming.map(t => t.title)).size, 3);

  // Move played Burna Boy songs into history and refill again -> expands smoothly into Wizkid / Rema!
  radioSession.history.push(...radioSession.upcoming.splice(0));
  await radio.refill(radioSession);
  assert.ok(radioSession.upcoming.length >= 1, 'Radio must seamlessly continue with related artists after artist catalog ends');
  assert.ok(['Wizkid', 'Rema'].includes(radioSession.upcoming[0].artist), `Expected related artist, got ${radioSession.upcoming[0].artist}`);
  assert.match(radioSession.radio.notice || '', /Burna Boy/);

  // 3. AiDjEngine with explicit artist vibe keeps playing Burna Boy until exhausted, then pivots to related artists
  const db = memoryDb();
  const djApp = {
    db,
    musicQueueManager: qm,
    music: radioApp.music,
    musicProviders: radioApp.musicProviders
  };
  const aiDj = new AiDjEngine({ app: djApp, fetchCharts: async () => [] });
  const djSession = qm.getSession(-6602);
  aiDj.setVibe(-6602, 'Burna Boy');
  djSession.currentTrack = { ...song(13, 'Burna Boy', { provider: 'youtube' }), title: 'City Boys' };

  // Plays remaining unseen Burna Boy songs (Last Last & Ye), NOT avoiding Burna Boy mid-catalog!
  const firstBatch = await aiDj.curateNextTracks(djSession, { count: 2 });
  assert.equal(firstBatch.length, 2);
  assert.ok(firstBatch.every(t => t.artist === 'Burna Boy'));

  // Exhaust queue and curate again -> switches stage cleanly to related category artists (Wizkid/Rema)
  djSession.history.push(...djSession.upcoming.splice(0));
  const secondBatch = await aiDj.curateNextTracks(djSession, { count: 2 });
  assert.ok(secondBatch.length >= 1);
  assert.ok(secondBatch.every(t => ['Wizkid', 'Rema'].includes(t.artist)), `Expected related artist picks after catalog finish, got ${secondBatch.map(t => t.artist)}`);
});
