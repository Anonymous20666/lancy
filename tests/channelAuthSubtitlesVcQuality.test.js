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
import { SubtitleService, parseSrt, parseTtml, parseAss, parseAnySubtitleText, getCueAt, mapMediaSecToSubMs } from '../src/media/subtitles.js';
import { extractDashSubtitleHints } from '../src/media/movieResolver.js';
import { VideoStreamingServer } from '../src/media/streamingServer.js';
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

test('Pillar 2b: DASH text AdaptationSet, >500 HLS VTT, X-TIMESTAMP-MAP, X-Lancy-Skipped-Sec & per-track offset isolation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p2b_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1. DASH MPD text AdaptationSet extraction produces same_route subtitle hint
  const mpdXml = `<?xml version="1.0"?>
  <MPD mediaPresentationDuration="PT1H30M">
    <Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Representation id="v1" height="720"><BaseURL>v/init.mp4</BaseURL></Representation>
      </AdaptationSet>
      <AdaptationSet contentType="text" lang="en" label="English CC">
        <Representation id="s1" mimeType="text/vtt"><BaseURL>subs/eng.vtt</BaseURL></Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const dashHints = extractDashSubtitleHints(mpdXml, 'https://cdn.example/stream/manifest.mpd', { Referer: 'https://cdn.example/' });
  assert.equal(dashHints.length, 1);
  assert.equal(dashHints[0].url, 'https://cdn.example/stream/subs/eng.vtt');
  assert.equal(dashHints[0].tier, 'same_route');

  // 2. SubtitleService: >500 HLS VTT segments, X-TIMESTAMP-MAP normalization, promo filtering, sameRoute metadata
  const segCount = 520;
  const hlsPlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    ...Array.from({ length: segCount }, (_, i) => `#EXTINF:4.000,\nseg_${i}.vtt`),
    '#EXT-X-ENDLIST'
  ].join('\n');

  const extSrtWithPromo = [
    '1\n00:00:01,000 --> 00:00:03,000\nWatch free on getray.app',
    ...Array.from({ length: 6 }, (_, k) => `${k + 2}\n00:00:${String(4 + k * 4).padStart(2, '0')},000 --> 00:00:${String(6 + k * 4).padStart(2, '0')},000\nReal movie dialogue line ${k + 1}`)
  ].join('\n\n');

  const fetchMock = async (url) => {
    const s = String(url);
    if (s.endsWith('/subs_520.m3u8')) {
      return { ok: true, status: 200, text: async () => hlsPlaylist };
    }
    const m = s.match(/seg_(\d+)\.vtt$/);
    if (m) {
      const i = Number(m[1]);
      // Segment 519 uses X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:01:00:00.000 while cue timestamp is shifted accordingly
      const vttBody = i === 519
        ? 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:01:00:00.000\n\n01:34:36.000 --> 01:34:39.000\nSegment 519 normalized cue\n'
        : `WEBVTT\n\n00:${String(Math.floor((i * 4) / 60)).padStart(2, '0')}:${String((i * 4) % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i * 4 + 2) / 60)).padStart(2, '0')}:${String((i * 4 + 2) % 60).padStart(2, '0')}.000\nLine ${i}\n`;
      return { ok: true, status: 200, text: async () => vttBody };
    }
    if (s.includes('ext_promo.srt')) {
      return { ok: true, status: 200, text: async () => extSrtWithPromo };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const subs = new SubtitleService({ cacheDir: dir, fetchImpl: fetchMock });
  const hlsBig = await subs.resolveForMedia({
    title: 'Long VTT Series',
    year: 2024,
    streamUrl: 'https://cdn.example/s520/master.m3u8',
    subtitleHints: [{ url: 'https://cdn.example/s520/subs_520.m3u8', language: 'eng', format: 'vtt', tier: 'same_route' }]
  });
  assert.ok(hlsBig?.found);
  assert.equal(hlsBig.sameRoute, true);
  assert.equal(hlsBig.cues.length, 520);
  const lastCue = hlsBig.cues[hlsBig.cues.length - 1];
  assert.ok(lastCue.text.includes('Segment 519 normalized cue'));
  // Normalized by -3600s from 01:34:36 -> ~34m36s (2076s)
  assert.ok(Math.abs(lastCue.startMs - 2076000) <= 500, `Expected normalized ~2076000ms, got ${lastCue.startMs}`);

  const extRes = await subs.resolveForMedia({
    title: 'External Promo Filter Film',
    year: 2024,
    streamUrl: 'https://cdn.example/ext/video.mp4',
    subtitleHints: [{ url: 'https://cdn.example/ext_promo.srt', language: 'eng', format: 'srt', tier: 'meta_match' }]
  });
  assert.ok(extRes?.found);
  assert.equal(extRes.sameRoute, false);
  assert.ok(!extRes.cues.some((c) => /getray\.app/i.test(c.text)));

  // 3. Per-track subtitleSyncOffset isolation across tracks and subtitle files
  const db = new Database(join(dir, 'subiso.db'));
  db.migrate();
  t.after(() => db.close());
  const voiceCalls = [];
  const fakeVoice = {
    async play(chatId, url, opts = {}) {
      voiceCalls.push({ op: 'play', chatId, opts });
      return { ok: true, account_alias: 'a1' };
    },
    async setSubtitle(chatId, path, opts = {}) {
      voiceCalls.push({ op: 'subtitle', chatId, path, opts });
      return { ok: true };
    },
    async setVolume() { return { ok: true }; }
  };
  const qm = new QueueManager({ app: { db, subtitles: subs }, voiceClient: fakeVoice, db, pollMs: 0 });
  t.after(() => { qm.closed = true; });
  const s = qm.getSession(-10077);
  s.connected = true;
  s.subtitleMode = 'screen';
  s.currentTrack = {
    id: 'movie:A',
    provider: 'movie',
    mediaType: 'video',
    title: 'Film A',
    subtitlePath: hlsBig.filePath,
    subtitleTracks: [
      { filePath: hlsBig.filePath, label: 'Same Route', source: 'subtitle_hint', sameRoute: true },
      { filePath: extRes.filePath, label: 'External', source: 'opensubtitles', sameRoute: false }
    ]
  };
  await qm.setSubtitleOffset(-10077, 3.5);
  assert.equal(s.subtitleSyncOffset, 3.5);
  assert.equal(db.getSetting('music.suboffset.-10077', null), null);
  // Cycling to track 1 resets offset to track 1's own saved offset (0) instead of leaking 3.5
  await qm.cycleSubtitleTrack(-10077);
  assert.equal(s.subtitleSyncOffset, 0);
  // Cycling back to track 0 restores track 0's saved 3.5
  await qm.cycleSubtitleTrack(-10077);
  assert.equal(s.subtitleSyncOffset, 3.5);

  // 4. StreamingServer emits X-Lancy-Skipped-Sec header on ?start= HLS seek
  const srv = new VideoStreamingServer({ port: 0, cacheDir: dir, audioCacheDir: dir });
  await srv.start();
  t.after(async () => { await srv.stop(); });
  const mediaPlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000,\nseg0.ts',
    '#EXTINF:6.000,\nseg1.ts',
    '#EXTINF:6.000,\nseg2.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const http = await import('node:http');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(mediaPlaylist);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const uPort = upstream.address().port;
  const proxyUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${uPort}/index.m3u8`, isHls: true });
  const seekRes = await fetch(`${proxyUrl}?start=10`);
  assert.equal(seekRes.status, 200);
  assert.equal(Number(seekRes.headers.get('x-lancy-skipped-sec')), 6);
});

test('Pillar 2c: Overlapping/long cues in getCueAt, split-audio HLS X-Lancy-Audio-Skipped-Sec, cached headers & MPEGTS VTT sync', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_p2c_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1. Overlapping cues where a long background cue spans past >0 dialogue cues
  const cues = parseSrt([
    '1',
    '00:00:10,000 --> 00:00:40,000',
    '[Tense music]',
    '',
    '2',
    '00:00:12,000 --> 00:00:14,000',
    'First speaker',
    '',
    '3',
    '00:00:20,000 --> 00:00:22,000',
    'Second speaker'
  ].join('\n'));
  const at17 = getCueAt(cues, 17000);
  assert.ok(at17 && at17.text.includes('[Tense music]'), 'Long cue must still match between short cues');
  const at13 = getCueAt(cues, 13000);
  assert.ok(at13 && at13.text.includes('[Tense music]') && at13.text.includes('First speaker'), 'Overlapping cues must merge text');

  // 2. Split-audio HLS proxy (6s video segs vs 5s audio segs): master emits both skipped headers and cached child preserves X-Lancy-Skipped-Sec
  const http = await import('node:http');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="a1"',
        'video.m3u8'
      ].join('\n'));
      return;
    }
    if (req.url === '/video.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nv0.ts\n#EXTINF:6,\nv1.ts\n#EXTINF:6,\nv2.ts\n#EXTINF:6,\nv3.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/audio.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\na0.ts\n#EXTINF:5,\na1.ts\n#EXTINF:5,\na2.ts\n#EXTINF:5,\na3.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/subs_mts.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:10,\ns0.vtt\n#EXTINF:10,\ns1.vtt\n#EXTINF:10,\ns2.vtt\n#EXTINF:10,\ns3.vtt\n#EXTINF:10,\ns4.vtt\n#EXT-X-ENDLIST\n');
      return;
    }
    const sm = req.url.match(/^\/s(\d+)\.vtt$/);
    if (sm) {
      const idx = Number(sm[1]);
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end(`WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${900000 * (idx + 1)},LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:03.000\nSeg ${idx} line\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const uPort = upstream.address().port;

  const srv = new VideoStreamingServer({ port: 0, host: '127.0.0.1', cacheDir: dir, audioCacheDir: dir });
  await srv.start();
  t.after(async () => { await srv.stop(); });
  const masterProxy = srv.registerRemoteStream({ url: `http://127.0.0.1:${uPort}/master.m3u8`, isHls: true });
  const masterRes = await fetch(`${masterProxy}?start=14.000`);
  assert.equal(masterRes.status, 200);
  assert.equal(Number(masterRes.headers.get('x-lancy-skipped-sec')), 12);
  assert.equal(Number(masterRes.headers.get('x-lancy-audio-skipped-sec')), 10);
  const masterBody = await masterRes.text();
  const vidUrl = masterBody.split('\n').find((l) => !l.startsWith('#') && l.includes('.m3u8'));
  assert.ok(vidUrl);
  const v1 = await fetch(vidUrl);
  assert.equal(Number(v1.headers.get('x-lancy-skipped-sec')), 12);
  await v1.text();
  const v2 = await fetch(vidUrl);
  assert.equal(Number(v2.headers.get('x-lancy-skipped-sec')), 12, 'Cached child playlist must keep X-Lancy-Skipped-Sec');

  // 3. HLS VTT incremental MPEGTS offset tracking across 5 segments
  const subs = new SubtitleService({ cacheDir: dir, fetchImpl: fetch });
  const vttRes = await subs.resolveForMedia({
    title: 'Split HLS MTS Film',
    streamUrl: `http://127.0.0.1:${uPort}/master.m3u8`,
    subtitleHints: [{ url: `http://127.0.0.1:${uPort}/subs_mts.m3u8`, language: 'eng', format: 'vtt', tier: 'same_route' }]
  });
  assert.ok(vttRes?.found);
  assert.equal(vttRes.cues.length, 5);
  assert.equal(vttRes.cues[0].startMs, 1000);
  assert.equal(vttRes.cues[4].startMs, 41000);
});

test('Subtitle Verifier parses TTML/ASS/single-newline VTT, recovers HLS origin when seg0 is empty, and harvests all source tracks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy-sub-verifier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. TTML (including tickRate & dur), ASS, and single-newline VTT parsers
  const ttmlCues = parseTtml(`<?xml version="1.0"?><tt ttp:tickRate="10000000"><body><div>
    <p begin="10000000t" end="35000000t">Tick cue<br/>line two</p>
    <p begin="00:00:05.000" dur="2.5s">Dur &amp; entity</p>
  </div></body></tt>`);
  assert.equal(ttmlCues.length, 2);
  assert.equal(ttmlCues[0].startMs, 1000);
  assert.equal(ttmlCues[0].text, 'Tick cue\nline two');
  assert.equal(ttmlCues[1].endMs, 7500);

  const assCues = parseAss(`[Script Info]\nTitle: Anime\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\an8\\pos(640,50)}Clean\\Nline!\nDialogue: 0,0:00:05.00,0:00:06.00,Signs,,0,0,0,,{\\p1}m 0 0 l 10 10\n`);
  assert.equal(assCues.length, 1);
  assert.equal(assCues[0].text, 'Clean\nline!');

  const compactVtt = parseSrt('WEBVTT\n00:00:01.000 --> 00:00:03.000\nLine one\n00:00:04.000 --> 00:00:06.000\nLine two\n');
  assert.equal(compactVtt.length, 2);
  assert.equal(compactVtt[1].startMs, 4000);

  // 2. DASH Period + multiple Representation + TTML + Forced + SDH hint extraction
  const dashXml = `<?xml version="1.0"?>
  <MPD><Period><BaseURL>https://cdn.example/base/</BaseURL>
    <AdaptationSet contentType="text" lang="en" mimeType="application/ttml+xml">
      <Representation id="en_clean"><BaseURL>subs/en_dialogue.ttml</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" lang="en" label="English [SDH]">
      <Role value="caption"/>
      <Representation id="en_sdh" mimeType="text/vtt"><SegmentTemplate media="$RepresentationID$.vtt"/></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" lang="ja" label="Japanese">
      <Representation id="ja_clean"><BaseURL>subs/ja.srt</BaseURL></Representation>
    </AdaptationSet>
  </Period></MPD>`;
  const dashSubs = extractDashSubtitleHints(dashXml, 'https://cdn.example/manifest.mpd', {});
  assert.equal(dashSubs.length, 3);
  assert.equal(dashSubs[0].type, 'ttml');
  assert.equal(dashSubs[1].url, 'https://cdn.example/base/en_sdh.vtt');
  assert.match(dashSubs[1].label, /SDH/);

  // 3. HLS VTT where segment 0 has X-TIMESTAMP-MAP but 0 cues, plus ALL source tracks harvested without OpenSubtitles call
  let openSubsCalls = 0;
  const fetchMock = async (url) => {
    const u = String(url);
    if (u.includes('opensubtitles')) {
      openSubsCalls++;
      return new Response('[]', { status: 200 });
    }
    if (u === 'https://src.example/subs.m3u8') {
      return new Response('#EXTM3U\n#EXTINF:10,\nseg0.vtt\n#EXTINF:10,\nseg1.vtt\n#EXTINF:10,\nseg2.vtt\n#EXT-X-ENDLIST\n', { status: 200 });
    }
    if (u === 'https://src.example/seg0.vtt') {
      return new Response('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n', { status: 200 });
    }
    if (u === 'https://src.example/seg1.vtt') {
      return new Response('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:00.000\n\n00:00:02.000 --> 00:00:04.000\nSeg1 A\n00:00:05.000 --> 00:00:07.000\nSeg1 B\n00:00:08.000 --> 00:00:09.000\nSeg1 C\n', { status: 200 });
    }
    if (u === 'https://src.example/seg2.vtt') {
      return new Response('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:2700000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:03.000\nSeg2 D\n00:00:04.000 --> 00:00:06.000\nSeg2 E\n', { status: 200 });
    }
    if (u === 'https://src.example/en_sdh.ttml') {
      const body = `<?xml version="1.0"?><tt><body><div>${Array.from({ length: 6 }, (_, i) => `<p begin="00:00:0${i + 1}.000" end="00:00:0${i + 1}.800">[door opens] ${i}</p>`).join('')}</div></body></tt>`;
      return new Response(body, { status: 200 });
    }
    if (u === 'https://src.example/ja.ass') {
      const ev = Array.from({ length: 6 }, (_, i) => `Dialogue: 0,0:00:0${i + 1}.00,0:00:0${i + 1}.80,Default,,0,0,0,,Line ${i}`).join('\n');
      return new Response(`[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev}\n`, { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  const verifierSubs = new SubtitleService({ cacheDir: dir, fetchImpl: fetchMock });
  const multiRes = await verifierSubs.resolveForMedia({
    title: 'Demon Slayer Test',
    streamUrl: 'https://src.example/master.m3u8',
    subtitleHints: [
      { url: 'https://src.example/en_sdh.ttml', language: 'English', label: 'English (SDH)', type: 'ttml', tier: 'same_route' },
      { url: 'https://src.example/subs.m3u8', language: 'English', label: 'English Subtitles', type: 'hls_vtt', tier: 'same_route' },
      { url: 'https://src.example/ja.ass', language: 'Japanese', label: 'Japanese Subtitles', type: 'ass', tier: 'same_route' }
    ]
  });
  assert.ok(multiRes?.found);
  assert.equal(openSubsCalls, 0, 'Must not query OpenSubtitles when verified clean same-route dialogue exists');
  assert.equal(multiRes.label, 'English Subtitles', 'Clean English dialogue must beat English (SDH)');
  assert.equal(multiRes.tracks.length, 3, 'Must harvest ALL 3 source subtitle tracks into tracks[]');
  assert.equal(multiRes.cues[0].startMs, 12000, 'Seg1 cue after empty seg0 must land at exact 12000ms (10s seg1 + 2s local)');
  assert.equal(multiRes.cues[3].startMs, 21000, 'Seg2 cue must land at exact 21000ms');
});

test('Live Subtitle Sync Checker + Normalizer: drift mapping, subcheck action & UI badges', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_subchk_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const db = new Database(join(dir, 'subchk.db'));
  db.migrate();
  t.after(() => db.close());

  // 1. Exact shared transform: media=120s, offset=+2s, drift=0.001s/s from anchor=20s => sub = 117.9s
  assert.equal(mapMediaSecToSubMs(120, { offsetSec: 2.0, driftRate: 0.001, driftAnchorSec: 20.0 }), 117900);

  const srtPath = join(dir, 'movie.srt');
  await writeFile(srtPath, '1\n00:00:05,000 --> 00:00:08,000\nLine one\n\n2\n00:00:10,000 --> 00:00:13,000\nLine two\n', 'utf8');

  let checkCalls = 0;
  const mockVoice = {
    async checkSubtitleSync(chatId, opts) {
      checkCalls++;
      assert.equal(chatId, -100777);
      assert.equal(opts.autoFix, true);
      return {
        ok: true,
        subtitle_offset: 2.2,
        auto_subtitle_offset: 2.2,
        sub_drift_sec_per_sec: 0.0015,
        sub_drift_anchor_sec: 45.0,
        subtitle_sync: {
          status: 'auto_normalized',
          applied_offset_sec: 2.2,
          residual_sec: 0,
          drift_ms_per_min: 90,
          auto_normalized: true,
          message: 'Auto-normalized subtitles (+2.2s, +90ms/min)'
        }
      };
    }
  };

  const apiRec = makeFakeApi();
  const adminApi = { ...apiRec.api, async getChatMember() { return { status: 'administrator', user: { id: 10 } }; } };
  const app = {
    db,
    settings: new SettingsManager(db, { env: {} }),
    subtitles: new SubtitleService({ cacheDir: dir }),
    voiceClient: mockVoice
  };
  app.musicQueueManager = new QueueManager({ app, voiceClient: mockVoice, db, pollMs: 0 });
  app.music = new MusicService({ app, accounts: { sync: async () => {} } });
  const screen = createMusicScreen({ app });
  t.after(async () => {
    await screen.cleanup();
    await app.music.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });

  const s = app.musicQueueManager.getSession(-100777);
  s.connected = true;
  s.status = 'playing';
  s.activeDeck = 'movie';
  s.view = 'subsync';
  s.screenMessageId = 601;
  s.playerChatId = -100777;
  s.api = adminApi;
  s.currentTrack = {
    id: 'tmdb-subchk',
    provider: 'movie',
    mediaType: 'video',
    title: 'Sync Checker Movie',
    subtitlePath: srtPath,
    subtitleTracks: [{ label: 'English', filePath: srtPath, format: 'srt' }]
  };

  const beforeCard = JSON.stringify(screen.renderSubSyncPicker(s));
  assert.match(beforeCard, /Check & Auto-Fix Sync/);

  const ctx = {
    tgId: '10',
    chatId: -100777,
    messageId: 601,
    isGroup: true,
    api: adminApi,
    query: { id: 'qsubchk' }
  };
  await app.music.control(ctx, 'subcheck', [String(s.controlRevision || 0)]);

  assert.equal(checkCalls, 1);
  assert.equal(s.subtitleSyncOffset, 2.2);
  assert.equal(s.subtitleDriftRate, 0.0015);
  assert.equal(s.subtitleSyncStatus?.status, 'auto_normalized');

  const afterPickerText = JSON.stringify(screen.renderSubSyncPicker(s));
  assert.match(afterPickerText, /Auto-Normalized/);
  assert.match(afterPickerText, /drift \+90ms\/m/);

  s.view = 'cinema';
  const cinemaText = JSON.stringify(screen.renderCinemaPlayer(s));
  assert.match(cinemaText, /Auto-Normalized/);
});
