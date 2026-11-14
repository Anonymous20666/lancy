import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { verifyChannelAdmin, isNativeChannelPost } from '../src/telegram/permissions.js';
import { DOWNLOAD_QUALITY_PROFILES, estimateDownloadSizeMb } from '../src/media/telegramLimits.js';
import { SubtitleService } from '../src/media/subtitles.js';
import { MovieDownloader } from '../src/media/movieDownloader.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { CinemaVcAnnouncer } from '../src/music/cinemaAnnouncer.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';

function collectButtons(rich) {
  return (rich?.blocks || [])
    .filter((b) => b.type === 'buttons')
    .flatMap((b) => b.buttons || []);
}

function btnText(b) {
  return Array.isArray(b?.text)
    ? b.text.map((s) => (typeof s === 'string' ? s : s?.alternative_text || s?.text || '')).join('')
    : String(b?.text || '');
}

function makeFakeApi({ channelMembers = new Map(), chatType = 'channel', username = 'cinetest' } = {}) {
  let msgSeq = 500;
  const alerts = [];
  const deleted = [];
  const sentMessages = [];
  const sentRich = [];
  const editedRich = [];

  const api = {
    botUsername: 'Lancy_easy_bot',
    me: { id: 999, username: 'Lancy_easy_bot', first_name: 'Lancy' },
    async getMe() { return this.me; },
    async getChat(chatId) {
      const id = Number(chatId);
      if (id > 0) return { id, type: 'private', first_name: 'User' };
      return { id, type: chatType, title: 'Cinema Test', username };
    },
    async getChatMember(chatId, userId) {
      const uid = Number(userId);
      if (uid === 999) return { status: 'administrator', can_post_messages: true, user: this.me };
      const st = channelMembers.get(uid) || 'member';
      return { status: st, user: { id: uid } };
    },
    async answerCallbackQuery(id, opts = {}) {
      alerts.push({ id, ...opts, show_alert: Boolean(opts.show_alert ?? opts.showAlert) });
      return true;
    },
    async deleteMessage(chatId, msgId) {
      deleted.push({ chatId, msgId });
      return true;
    },
    async sendMessage(chatId, text, extra = {}) {
      const message_id = ++msgSeq;
      sentMessages.push({ chatId, message_id, text, extra });
      return { message_id, chat: { id: chatId } };
    },
    async sendRichMessage(chatId, rich, extra = {}, files = null) {
      const message_id = ++msgSeq;
      sentRich.push({ chatId, message_id, rich, extra, files });
      return { message_id, chat: { id: chatId }, video: files ? { file_id: `fid_${message_id}`, duration: 1200 } : undefined };
    },
    async editMessageRich(chatId, message_id, rich, extra = {}, files = null) {
      editedRich.push({ chatId, message_id, rich, extra, files });
      return { message_id, chat: { id: chatId } };
    },
    async sendChatAction() { return true; },
    async sendVideo(chatId, media, extra = {}) {
      const message_id = ++msgSeq;
      return { message_id, chat: { id: chatId }, video: { file_id: `fid_vid_${message_id}`, duration: extra.duration || 1200 } };
    }
  };

  return { api, alerts, deleted, sentMessages, sentRich, editedRich };
}

test('Pillar 1: Channel non-admin callbacks & messages are rejected while channel admin and native channel_post succeed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p1_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const db = new Database(join(dir, 'bot.db'));
  db.migrate();
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: {} });
  const sm = new StateMachine();

  const members = new Map([
    [101, 'administrator'],
    [202, 'member']
  ]);
  const { api, alerts, deleted, sentMessages } = makeFakeApi({ channelMembers: members });

  assert.equal(isNativeChannelPost({ chat: { id: -1001, type: 'channel' }, sender_chat: { id: -1001 } }, { isChannelPost: true }), true);
  assert.equal(isNativeChannelPost({ data: 'x', message: { chat: { id: -1001, type: 'channel' }, sender_chat: { id: -1001 } } }), false);
  assert.equal(await verifyChannelAdmin({ chatId: -1001, fromUser: { id: 202 }, api }), false);
  assert.equal(await verifyChannelAdmin({ chatId: -1001, fromUser: { id: 136817688 }, api }), false);
  assert.equal(await verifyChannelAdmin({ chatId: -1001, fromUser: { id: 101 }, api }), true);

  const app = {
    db,
    settings,
    sm,
    screens: new Map(),
    movieSessions: new MovieSessions({ db }),
    movieApi: {
      async trending() { return { results: [] }; },
      async search() { return { results: [] }; }
    },
    voiceClient: { async setup() { return { ok: true, account_alias: 'a1' }; }, async play() { return { ok: true }; }, async setVolume() { return { ok: true }; }, async stop() { return { ok: true }; } },
    subtitles: null
  };
  app.musicQueueManager = new QueueManager({ app, voiceClient: app.voiceClient, db, pollMs: 0 });
  app.music = new MusicService({ app, accounts: { sync: async () => {} } });
  const musicScreen = createMusicScreen({ app });
  t.after(async () => {
    await musicScreen.cleanup();
    await app.music.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });
  app.screens.set('music', musicScreen);

  const ctrl = new TelegramController({
    app,
    api,
    db,
    settings,
    stateMachine: sm,
    screens: app.screens,
    botContext: { botId: 0, isMain: true, allowedUserIds: new Set(['10']), ownerId: 10, adminIds: new Set() }
  });

  // 1) Non-admin callback on channel movie/player card MUST reject and NEVER delete the card
  const ms = app.movieSessions.create({ chatId: -1001, userId: '101', destination: -1001, view: 'hub' });
  const guestMovieUpdate = {
    callback_query: {
      id: 'cb_guest_mv',
      from: { id: 202, first_name: 'Subscriber' },
      data: `music:mv:${ms.id}:hb`,
      message: { message_id: 777, chat: { id: -1001, type: 'channel' } }
    }
  };
  await ctrl.handleUpdate(guestMovieUpdate);
  assert.ok(alerts.some((a) => a.id === 'cb_guest_mv' && a.show_alert === true));
  assert.equal(deleted.length, 0, 'Stale or active channel card must not be deleted by non-admin');

  // 2) Stale movie card tapped by non-admin in channel must NOT delete message_id 888
  await ctrl.handleUpdate({
    callback_query: {
      id: 'cb_guest_stale',
      from: { id: 202, first_name: 'Subscriber' },
      data: 'music:mv:nonexistent:hb',
      message: { message_id: 888, chat: { id: -1001, type: 'channel' } }
    }
  });
  assert.equal(deleted.filter((d) => d.msgId === 888).length, 0);

  // 3) Non-admin sending a command in channel must be silently ignored
  const beforeMsgs = sentMessages.length;
  await ctrl.handleUpdate({
    channel_post: {
      message_id: 901,
      chat: { id: -1001, type: 'channel' },
      from: { id: 202, first_name: 'Subscriber' },
      text: '/player'
    }
  });
  assert.equal(sentMessages.length, beforeMsgs);

  // 4) Pseudo-ID spoof in channel must also fail closed
  await assert.rejects(
    () => app.music.authorize({ tgId: '1087968824', chatId: -1001, isChannel: true, api, query: { id: 'q' } }, false, -1001),
    /ADMIN_ONLY|administrators/i
  );

  // 5) Real admin & native channel_post pass authorize
  const authAdmin = await app.music.authorize({ tgId: '101', chatId: -1001, isChannel: true, api, query: { id: 'qa' } }, true, -1001);
  assert.equal(authAdmin, -1001);
  const authNative = await app.music.authorize(
    {
      tgId: '-1001',
      chatId: -1001,
      isChannel: true,
      isNativeChannelPost: true,
      api,
      message: { chat: { id: -1001, type: 'channel' }, sender_chat: { id: -1001 }, text: '/player' }
    },
    true,
    -1001
  );
  assert.equal(authNative, -1001);
});

test('Pillar 2: Subtitles parse >12 HLS WebVTT segments, isolate stream caches, prefer embedded tracks, and apply signed sync offsets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p2_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const vttSegments = [];
  for (let i = 0; i < 20; i++) {
    const startMin = String(i).padStart(2, '0');
    const endMin = String(i).padStart(2, '0');
    vttSegments.push(`seg_${i}.vtt`);
  }
  const hlsPlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:60',
    ...vttSegments.flatMap((seg) => ['#EXTINF:60.0,', seg]),
    '#EXT-X-ENDLIST'
  ].join('\n');

  const fetchMock = async (url) => {
    const u = String(url);
    if (u.endsWith('subs.m3u8')) {
      return { ok: true, status: 200, text: async () => hlsPlaylist };
    }
    const m = u.match(/seg_(\d+)\.vtt$/);
    if (m) {
      const idx = Number(m[1]);
      const mm = String(idx).padStart(2, '0');
      return {
        ok: true,
        status: 200,
        text: async () => `WEBVTT\n\n00:${mm}:05.000 --> 00:${mm}:10.000\nSegment cue ${idx}\n`
      };
    }
    if (u.includes('meta-only.srt')) {
      return {
        ok: true,
        status: 200,
        text: async () => Array.from({ length: 12 }, (_, i) => `${i + 1}\n00:${String(i).padStart(2, '0')}:01,000 --> 00:${String(i).padStart(2, '0')}:05,000\nMeta hint line ${i + 1}\n`).join('\n')
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const subs = new SubtitleService({ cacheDir: dir, fetchImpl: fetchMock });

  // Verify >12 HLS WebVTT segments are all fetched (no .slice(0, 12) truncation!)
  const hlsRes = await subs.resolveForMedia({
    title: 'Long Feature Film',
    year: 2024,
    streamUrl: 'https://cdn-one.example/movie_a/master.m3u8',
    durationSeconds: 1200,
    subtitleHints: [{ url: 'https://cdn-one.example/subs.m3u8', language: 'eng', format: 'vtt', tier: 'same_route' }]
  });
  assert.ok(hlsRes?.found);
  assert.equal(hlsRes.cues.length, 20);
  assert.ok(hlsRes.cues[19].text.includes('Segment cue 19'));

  // Stream cache isolation: same title+year on another streamUrl without HLS uses meta-only (different filePath)
  const altRes = await subs.resolveForMedia({
    title: 'Long Feature Film',
    year: 2024,
    streamUrl: 'https://cdn-two.example/release_b/video.mp4',
    subtitleHints: [{ url: 'https://cdn-two.example/meta-only.srt', language: 'eng', format: 'srt', tier: 'meta_match' }]
  });
  assert.ok(altRes?.found);
  assert.notEqual(altRes.filePath, hlsRes.filePath);

  // Embedded track priority + multi-track selection via mocked ffprobe/ffmpeg runner
  const mockRunner = async (bin, args) => {
    if (String(bin).includes('ffprobe')) {
      return {
        stdout: JSON.stringify({
          streams: [
            { index: 2, codec_name: 'subrip', tags: { language: 'eng', title: 'Full English' }, disposition: { default: 1, forced: 0 } }
          ]
        })
      };
    }
    const outArg = args[args.length - 1];
    const srtContent = Array.from({ length: 10 }, (_, i) => `${i + 1}\n00:0${i}:10,000 --> 00:0${i}:15,000\nEmbedded line ${i + 1}\n`).join('\n');
    await writeFile(outArg, srtContent, 'utf8');
    return { stdout: '', stderr: '' };
  };
  const subsEmb = new SubtitleService({ cacheDir: dir, fetchImpl: fetchMock, runner: mockRunner });
  const embRes = await subsEmb.resolveForMedia({
    title: 'Embedded MKV Film',
    year: 2024,
    streamUrl: 'https://cdn-emb.example/film.mkv',
    durationSeconds: 600,
    subtitleHints: [{ url: 'https://cdn-two.example/meta-only.srt', language: 'eng', format: 'srt', tier: 'meta_match' }]
  });
  assert.equal(embRes.source, 'embedded');
  assert.ok(Array.isArray(embRes.tracks) && embRes.tracks.length >= 2);

  // QueueManager signed offset + track switch + live cue sync lookup
  const subDb = new Database(join(dir, 'qm.db'));
  subDb.migrate();
  t.after(() => subDb.close());
  const voiceCalls = [];
  const fakeVoice = {
    async setSubtitle(chatId, subtitlePath, opts = {}) {
      voiceCalls.push({ chatId, subtitlePath, opts });
      return { ok: true };
    }
  };
  const qm = new QueueManager({ app: { db: subDb, subtitles: subsEmb }, voiceClient: fakeVoice, db: subDb, pollMs: 0 });
  t.after(() => { qm.closed = true; });
  const s = qm.getSession(-10099);
  s.connected = true;
  s.subtitleMode = 'screen';
  s.currentTrack = {
    id: 'm1',
    provider: 'movie',
    title: 'Embedded MKV Film',
    subtitlePath: embRes.tracks[0].filePath,
    subtitleTracks: embRes.tracks
  };
  const off1 = await qm.setSubtitleOffset(-10099, -2.0);
  assert.equal(off1, -2);
  assert.equal(voiceCalls.at(-1).opts.subtitleOffset, -2);
  const cycled = await qm.cycleSubtitleTrack(-10099);
  assert.equal(cycled.index, 1);
  assert.equal(s.currentTrack.subtitlePath, embRes.tracks[1].filePath);
});

test('Pillar 3: Live VC / Livestream links use ?livestream in public channels, real bridge link in private, and never fake ?voicechat', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p3_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = new Database(join(dir, 'p3.db'));
  db.migrate();
  t.after(() => db.close());

  const app = { db, screens: new Map() };
  app.musicQueueManager = new QueueManager({ app, voiceClient: {}, db, pollMs: 0 });
  t.after(() => { app.musicQueueManager.closed = true; });
  const service = new MusicService({ app, accounts: { sync: async () => {} } });
  app.music = service;
  const screen = createMusicScreen({ app });
  t.after(async () => {
    await screen.cleanup();
    await service.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });
  app.screens.set('music', screen);

  // Public Channel -> ?livestream & "📺 Join Livestream" button
  const chSess = app.musicQueueManager.getSession(-1007001);
  chSess.activeDeck = 'movie';
  chSess.currentTrack = { id: 'm1', provider: 'movie', mediaType: 'video', title: 'Inception' };
  service.syncSessionIdentity(chSess, null, { id: -1007001, type: 'channel', title: 'Cine Broadcast', username: 'cinechan' });
  assert.equal(chSess.vcUrl, 'https://t.me/cinechan?livestream');
  const chCard = screen.renderCinemaPlayer(chSess);
  const chBtns = collectButtons(chCard);
  assert.ok(chBtns.some((b) => btnText(b).includes('Join Livestream') && b.url === 'https://t.me/cinechan?livestream'));

  // Private Group WITHOUT call invite link -> vcUrl is null (never privateInvite?voicechat), falls back to Open Group
  const privSess = app.musicQueueManager.getSession(-1007002);
  privSess.activeDeck = 'movie';
  privSess.currentTrack = { id: 'm2', provider: 'movie', mediaType: 'video', title: 'Interstellar' };
  service.syncSessionIdentity(privSess, null, { id: -1007002, type: 'supergroup', title: 'Private Watch', invite_link: 'https://t.me/+privGroup123' });
  assert.equal(privSess.vcUrl, null);
  assert.equal(privSess.groupInviteLink, 'https://t.me/+privGroup123');
  const privCard = screen.renderCinemaPlayer(privSess);
  const privBtns = collectButtons(privCard);
  assert.ok(privBtns.some((b) => btnText(b).includes('Open Group') && b.url === 'https://t.me/+privGroup123'));
  assert.ok(!JSON.stringify(privCard).includes('?voicechat'));

  // Private Group WITH real MTProto bridgeInviteLink -> uses real call invite link
  service.syncSessionIdentity(privSess, null, null, { bridgeInviteLink: 'https://t.me/+privGroup123?voicechat=realHash' });
  assert.equal(privSess.vcUrl, 'https://t.me/+privGroup123?voicechat=realHash');

  const announcer = new CinemaVcAnnouncer({ app, db, queueManager: app.musicQueueManager });
  const resolvedPriv = await announcer.resolveGroupInviteLink(-1007003, {
    getChat: async () => ({ id: -1007003, type: 'supergroup', title: 'Hidden Group', invite_link: 'https://t.me/+hidden99' })
  });
  assert.equal(resolvedPriv.gcLink, 'https://t.me/+hidden99');
  assert.equal(resolvedPriv.vcDirectLink, null);
});

test('Pillar 4: Data-aware quality selector estimates MB, isolates 360p/480p/720p caches, downscales tall sources, and renders inline & Cinema pickers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p4_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = new Database(join(dir, 'p4.db'));
  db.migrate();
  t.after(() => db.close());

  const est360 = estimateDownloadSizeMb({ durationSeconds: 5400, quality: '360p', limitBytes: 2000 * 1024 * 1024 });
  const est480 = estimateDownloadSizeMb({ durationSeconds: 5400, quality: '480p', limitBytes: 2000 * 1024 * 1024 });
  const est720 = estimateDownloadSizeMb({ durationSeconds: 5400, quality: '720p', limitBytes: 2000 * 1024 * 1024 });
  assert.ok(est360.estimatedMb < est480.estimatedMb && est480.estimatedMb < est720.estimatedMb);
  assert.equal(DOWNLOAD_QUALITY_PROFILES['360p'].height, 360);

  // Test MovieDownloader quality cache isolation & height downscale
  const srcVideo = join(dir, 'source1080.mp4');
  await writeFile(srcVideo, Buffer.alloc(1024 * 64, 1));
  const ffmpegInvocations = [];
  const mockRunner = async (bin, args) => {
    if (String(bin).includes('ffprobe')) {
      if (args.includes('stream=height')) return { stdout: '1080\n' };
      return { stdout: '3600\n' };
    }
    ffmpegInvocations.push(args);
    const out = args[args.length - 1];
    await writeFile(out, Buffer.alloc(1024 * 16, 2));
    return { stdout: '', stderr: '' };
  };
  const dlApp = {
    db,
    movieResolver: {
      async resolve(item, opts) {
        ffmpegInvocations.push(['resolved_pref', opts.preferredHeight]);
        return {
          ok: true,
          track: {
            id: item.id,
            title: item.title,
            durationSeconds: 3600,
            filePath: srcVideo
          }
        };
      }
    }
  };
  const downloader = new MovieDownloader({ app: dlApp, cacheDir: join(dir, 'dl'), runner: mockRunner });
  const item = { id: 'tmdb-555', type: 'movie', title: 'Sample Cinema' };

  const prep360 = await downloader.prepareVideoFile(item, { quality: '360p' });
  assert.equal(prep360.ok, true);
  assert.equal(prep360.quality, '360p');
  assert.ok(prep360.cacheKey.endsWith(':q360p'));
  assert.ok(ffmpegInvocations.some((a) => a.includes('scale=-2:\'min(360,ih)\'')), 'Must downscale 1080p source when 360p Saver is selected');
  prep360.cleanup();

  // Save file_id in cached_video_tracks for 360p and verify 720p cache does NOT collide
  const apiRec = makeFakeApi();
  db.run(
    'INSERT INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)',
    prep360.cacheKey,
    'fid_360',
    item.title,
    3600
  );
  assert.equal(downloader.hasCachedVideo(item, '360p'), true);
  assert.equal(downloader.hasCachedVideo(item, '720p'), false);

  // Wire UI + Cinema dlq flow
  const app = {
    db,
    settings: new SettingsManager(db, { env: {} }),
    movieDownloader: downloader,
    movieSessions: new MovieSessions({ db }),
    movieApi: { async trending() { return { results: [] }; }, async search() { return { results: [] }; } },
    voiceClient: {}
  };
  app.musicQueueManager = new QueueManager({ app, voiceClient: {}, db, pollMs: 0 });
  app.music = new MusicService({ app, accounts: { sync: async () => {} } });
  app.screens = new Map();
  const screen = createMusicScreen({ app });
  t.after(async () => {
    await screen.cleanup();
    await app.music.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });
  app.screens.set('music', screen);

  const ms = app.movieSessions.create({ chatId: 777, userId: '777', view: 'movie', mediaItem: { ...item, runtimeMinutes: 90 } });
  const dmCtx = { tgId: '777', chatId: 777, isGroup: false, api: apiRec.api, db };
  const detailRich = screen.movieUi.renderMovieDetail(dmCtx, ms);
  const detailBtns = collectButtons(detailRich);
  assert.ok(detailBtns.some((b) => b.callback_data.includes(':ql:360p')));
  assert.ok(detailBtns.some((b) => b.callback_data.includes(':ql:480p')));
  assert.ok(detailBtns.some((b) => b.callback_data.includes(':ql:720p')));

  // Switch quality pill to 360p and verify persistence
  await screen.handle({ ...dmCtx, messageId: 501, query: { id: 'ql1' } }, 'mv', [ms.id, 'ql', '360p']);
  assert.equal(db.getUserSetting(777, 'movie.downloadQuality'), '360p');

  // Cinema deck: tapping downloadnow opens dlq quality picker with MB estimates
  const dlApi = { ...apiRec.api, async getChatMember() { return { status: 'administrator', user: { id: 10 } }; } };
  const gcSess = app.musicQueueManager.getSession(-100888);
  gcSess.activeDeck = 'movie';
  gcSess.view = 'cinema';
  gcSess.screenMessageId = 502;
  gcSess.playerChatId = -100888;
  gcSess.api = dlApi;
  gcSess.currentTrack = { id: 'tmdb-555', provider: 'movie', mediaType: 'video', title: 'Sample Cinema', durationSeconds: 5400 };
  const dlCtx = {
    tgId: '10',
    chatId: -100888,
    messageId: 502,
    isGroup: true,
    api: dlApi,
    query: { id: 'qdl' }
  };
  await app.music.control(dlCtx, 'downloadnow', [String(gcSess.controlRevision || 0)]);
  assert.equal(gcSess.view, 'dlq');
  const dlqCard = screen.renderPlayer(gcSess);
  const dlqBtns = collectButtons(dlqCard);
  assert.ok(dlqBtns.some((b) => b.callback_data.includes('dlq:360p')));
  assert.ok(dlqBtns.some((b) => b.callback_data.includes('dlq:720p')));
  assert.ok(existsSync(srcVideo));
});
