import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { MovieDownloader } from '../src/media/movieDownloader.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { normalizeTrack } from '../src/music/model.js';
import { encodeCallback } from '../src/telegram/rich.js';

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

function makeRecordingApi() {
  let msgSeq = 100;
  const sentRich = [];
  const editedRich = [];
  const sentMessages = [];
  const editedMarkups = [];
  const deleted = [];
  const mediaGroups = [];
  const sentVideos = [];
  const sentPolls = [];
  const stoppedPolls = [];

  const api = {
    botUsername: 'Lancy_easy_bot',
    me: { id: 999, username: 'Lancy_easy_bot', first_name: 'Lancy' },
    async getMe() { return this.me; },
    async getChat(chatId) {
      const id = Number(chatId);
      return id < 0
        ? { id, type: 'channel', title: 'Test Channel', username: 'testchan' }
        : { id, type: 'private', first_name: 'User' };
    },
    async getChatMember() { return { status: 'administrator', can_post_messages: true, user: this.me }; },
    async sendChatAction() { return true; },
    async answerCallbackQuery() { return true; },
    async setMyCommands() { return true; },
    async sendRichMessage(chatId, rich, extra = {}, files = null) {
      const message_id = ++msgSeq;
      sentRich.push({ chatId, message_id, rich, extra, files });
      return {
        message_id,
        chat: { id: chatId },
        video: files ? { file_id: `fid_rich_${message_id}`, duration: 1200 } : undefined
      };
    },
    async editMessageRich(chatId, message_id, rich, extra = {}, files = null) {
      editedRich.push({ chatId, message_id, rich, extra, files });
      return {
        message_id,
        chat: { id: chatId },
        video: files ? { file_id: `fid_rich_edit_${message_id}`, duration: 1200 } : undefined
      };
    },
    async editMessageReplyMarkup(chatId, message_id, reply_markup) {
      editedMarkups.push({ chatId, message_id, reply_markup });
      return { message_id };
    },
    async sendMessage(chatId, text, extra = {}) {
      const message_id = ++msgSeq;
      sentMessages.push({ chatId, message_id, text, extra });
      return { message_id, chat: { id: chatId }, text };
    },
    async deleteMessage(chatId, message_id) {
      deleted.push({ chatId, message_id });
      return true;
    },
    async sendVideo(chatId, media, extra = {}) {
      const message_id = ++msgSeq;
      sentVideos.push({ chatId, message_id, media, extra });
      return { message_id, chat: { id: chatId }, video: { file_id: `fid_vid_${message_id}`, duration: 1500 } };
    },
    async sendMediaGroup(chatId, media, extra = {}) {
      const items = (media || []).map((m, idx) => {
        const message_id = ++msgSeq;
        return { message_id, chat: { id: chatId }, video: { file_id: `fid_grp_${message_id}_${idx}`, duration: 1400 } };
      });
      mediaGroups.push({ chatId, media, items, extra });
      return items;
    },
    async sendPoll(chatId, question, options, extra = {}) {
      const message_id = ++msgSeq;
      const pollId = `poll_${message_id}`;
      sentPolls.push({ chatId, message_id, pollId, question, options, extra });
      return { message_id, chat: { id: chatId }, poll: { id: pollId, is_anonymous: Boolean(extra.is_anonymous) } };
    },
    async stopPoll(chatId, message_id) {
      stoppedPolls.push({ chatId, message_id });
      return { id: `poll_${message_id}`, is_closed: true };
    }
  };

  return {
    api,
    sentRich,
    editedRich,
    sentMessages,
    editedMarkups,
    deleted,
    mediaGroups,
    sentVideos,
    sentPolls,
    stoppedPolls
  };
}

test('DM Dashboard and DM /music home show Download Movies and remove Channel Play / Player', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const rec = makeRecordingApi();
  const app = { db, settings, whatsapp: { listForUser: () => [] } };
  const dashboard = createDashboardScreen({ app });

  const dmCtx = {
    tgId: '500',
    chatId: 500,
    isGroup: false,
    user: { tg_id: 500, name: 'Test User', joined_at: Math.floor(Date.now() / 1000) },
    db,
    settings,
    api: rec.api,
    sendRichMessage: (rich, extra = {}, files = null) => rec.api.sendRichMessage(500, rich, extra, files),
    editScreen: (rich, extra = {}, files = null) => rec.api.editMessageRich(500, rec.sentRich.at(-1)?.message_id || 101, rich, extra, files),
    reply: (text, extra = {}) => rec.api.sendMessage(500, text, extra)
  };
  await dashboard.open(dmCtx, { forceNew: true });
  const dashBtns = collectButtons(rec.sentRich.at(-1).rich);
  assert.ok(dashBtns.some((b) => btnText(b).includes('Download Movies') && b.callback_data === encodeCallback('music', 'moviehub')));
  assert.ok(!dashBtns.some((b) => btnText(b).includes('Channel Play') || b.callback_data === encodeCallback('music', 'channels')));
  assert.ok(!dashBtns.some((b) => b.callback_data === encodeCallback('music', 'openplayer')));

  const sm = new StateMachine();
  const musicApp = {
    db,
    settings,
    sm,
    movieSessions: new MovieSessions({ db }),
    movieApi: { async search() { return { results: [] }; }, async detail() { return null; } },
    musicQueueManager: new QueueManager({ app: { db, settings }, log: { info() {}, warn() {}, error() {}, debug() {} } }),
    voiceClient: { isSetup: () => false }
  };
  musicApp.music = new MusicService({ app: musicApp, search: { resolve: async () => [] }, lyrics: null, accounts: { sync: async () => {} } });
  const musicScreen = createMusicScreen({ app: musicApp });
  t.after(async () => {
    await musicScreen.cleanup();
    await musicApp.music.previews.shutdown();
    await musicApp.musicQueueManager.shutdown();
  });

  const handledHome = await musicScreen.handleCommand({ ...dmCtx, message: { chat: { id: 500, type: 'private' } } }, '/music', []);
  assert.equal(handledHome, true);
  const musicHomeBtns = collectButtons(rec.sentRich.at(-1).rich);
  assert.ok(musicHomeBtns.some((b) => btnText(b).includes('Download Movies') && b.callback_data === encodeCallback('music', 'moviehub')));
  assert.ok(!musicHomeBtns.some((b) => btnText(b).includes('Channel Play')));

  await musicScreen.handleCommand({ ...dmCtx, message: { chat: { id: 500, type: 'private' } } }, '/channel', ['@somechan']);
  const guideCard = rec.sentRich.at(-1).rich;
  assert.match(JSON.stringify(guideCard), /Channel Play has moved inside Channels directly/);
  const guideBtns = collectButtons(guideCard);
  assert.ok(guideBtns.some((b) => b.callback_data === encodeCallback('music', 'moviehub')));
});

test('DM Movie Downloader works without VC auth, shows 1-tap whole-season compact UI, swaps slides cleanly with Keep Slide & file_id cache hit', async t => {
  const db = new Database(':memory:');
  const cacheDir = await mkdtemp(join(tmpdir(), 'lancy-dm-dl-test-'));
  t.after(async () => {
    db.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  const sampleMp4 = join(cacheDir, 'sample.mp4');
  await writeFile(sampleMp4, Buffer.alloc(64 * 1024, 7));

  const settings = new SettingsManager(db, { env: {} });
  const sm = new StateMachine();
  const rec = makeRecordingApi();
  let prepareDownloadCalls = 0;

  const episodesS1 = Array.from({ length: 6 }, (_, i) => ({
    seasonNumber: 1,
    episodeNumber: i + 1,
    title: `Episode ${i + 1}`,
    runtimeMinutes: 45,
    runtimeSeconds: 2700
  }));

  const showItem = {
    id: 'tv-909',
    type: 'tv',
    title: 'Breaking Code',
    year: '2024',
    rating: '9.1',
    genres: ['Drama', 'Thriller'],
    overview: 'A clean test series.',
    seasons: [{ seasonNumber: 1, episodeCount: 6, airDate: '2024-01-01' }]
  };

  const app = {
    db,
    settings,
    sm,
    movieSessions: new MovieSessions({ db }),
    movieApi: {
      async search() { return { results: [showItem] }; },
      async detail() { return showItem; },
      async season(_id, sNum) { return { episodes: sNum === 1 ? episodesS1 : [] }; },
      async pickRandom() { return showItem; },
      async trending() { return { results: [showItem] }; },
      async categories() { return []; }
    },
    music: {
      async authorize() {
        throw new Error('VC authorize MUST NOT run for private DM Movie Downloader!');
      },
      botKey() { return 'main'; },
      destination() { throw new Error('No VC destination in DM'); }
    }
  };
  app.movieDownloader = new MovieDownloader({ app, cacheDir });

  // Large multi-file size forces media_group slide path so we test deleting old un-kept dlMediaMessageIds and preserving dk-kept slide!
  app.movieDownloader.prepareVideoFile = async (desc) => {
    const cached = app.movieDownloader.hasCachedVideo(desc);
    if (cached) {
      return { ok: true, cachedFileId: cached.file_id, filePath: null, filename: 'cached.mp4', title: desc.title, durationSeconds: 2700, sizeBytes: 0, cacheKey: `mv:tv:${desc.id}:${desc.season}:${desc.episode}:50m` };
    }
    prepareDownloadCalls++;
    return {
      ok: true,
      filePath: sampleMp4,
      filename: `S01E0${desc.episode}.mp4`,
      title: `${desc.title} S01E0${desc.episode}`,
      durationSeconds: 2700,
      sizeBytes: 42 * 1024 * 1024,
      cacheKey: `mv:tv:${desc.id}:${desc.season}:${desc.episode}:50m`
    };
  };

  const musicScreen = createMusicScreen({ app });
  t.after(async () => { await musicScreen.cleanup(); });
  const dmCtx = {
    tgId: '500',
    chatId: 500,
    isGroup: false,
    api: rec.api,
    db,
    settings
  };

  await musicScreen.movieUi.openHub(dmCtx);
  const ms = app.movieSessions.getLatestForChat(500);
  assert.ok(ms?.id);

  // Open Movie detail without any VC auth
  ms.mediaItem = { ...showItem, type: 'movie' };
  const movieCard = musicScreen.movieUi.renderMovieDetail(dmCtx, ms);
  const movieBtns = collectButtons(movieCard);
  assert.ok(movieBtns.some((b) => b.callback_data.endsWith(':dm') || b.callback_data.includes(':dm:')));
  assert.ok(!movieBtns.some((b) => b.callback_data.endsWith(':pm') || b.callback_data.endsWith(':qm')));

  ms.results = [showItem];
  await musicScreen.handle({ ...dmCtx, messageId: rec.sentRich.at(-1).message_id }, 'mv', [ms.id, 'op', '0']);
  const tvCard = musicScreen.movieUi.renderTvSeason(dmCtx, ms);
  const tvBtns = collectButtons(tvCard);
  assert.ok(!tvBtns.some((b) => b.callback_data.includes(':pe:') || b.callback_data.includes(':qe:')));
  assert.ok(tvBtns.some((b) => b.callback_data.includes(':dsx:1')));

  // Tap 1-tap Download Season 1 (dsx)
  await musicScreen.handle(
    { ...dmCtx, messageId: rec.sentRich.at(-1).message_id, query: { id: 'q1' } },
    'mv',
    [ms.id, 'dsx', '1']
  );

  // ProgressTracker ran at least 1 rich edit/send for prep before final Slide 1
  assert.ok(rec.sentRich.length >= 2);
  assert.ok(ms.dlMediaMessageIds.length >= 1);
  const slide1CardId = ms.dlMessageId;
  const slide1MediaIds = [...ms.dlMediaMessageIds];
  const slide1CardEntry = rec.sentRich.find((x) => x.message_id === slide1CardId) || rec.editedRich.find((x) => x.message_id === slide1CardId);
  const slide1CardRich = slide1CardEntry?.rich;
  const slide1Btns = collectButtons(slide1CardRich);
  assert.ok(!slide1Btns.some((b) => btnText(b).includes('Stream This Slide')));
  const keepBtn = slide1Btns.find((b) => b.callback_data.includes(':dk:0'));
  assert.ok(keepBtn);

  // Keep Slide 1 permanently
  await musicScreen.handle(
    {
      ...dmCtx,
      messageId: slide1CardId,
      query: { id: 'q2', message: { message_id: slide1CardId, reply_markup: { inline_keyboard: [[keepBtn]] } } }
    },
    'mv',
    [ms.id, 'dk', '0']
  );
  assert.equal(ms.dlKeptPages.includes(0), true);
  assert.ok(rec.editedMarkups.some((m) => m.message_id === slide1CardId && m.reply_markup.inline_keyboard[0][0].text === '✅ Kept in Chat'));

  // Advance to Slide 2 (items 5-6) -> Kept Slide 1 messages MUST NOT be deleted!
  await musicScreen.handle(
    { ...dmCtx, messageId: slide1CardId, query: { id: 'q3', message: { message_id: slide1CardId } } },
    'mv',
    [ms.id, 'dl', '1']
  );
  for (const keptId of [slide1CardId, ...slide1MediaIds]) {
    assert.ok(!rec.deleted.some((d) => d.message_id === keptId), `Kept message ${keptId} must not be deleted`);
  }

  // Navigating back to Slide 1 hits cached_video_tracks file_id cache!
  const callsBeforeRevisit = prepareDownloadCalls;
  await musicScreen.handle(
    { ...dmCtx, messageId: ms.dlMessageId, query: { id: 'q4', message: { message_id: ms.dlMessageId } } },
    'mv',
    [ms.id, 'dl', '0']
  );
  assert.equal(prepareDownloadCalls, callsBeforeRevisit, 'Re-requesting Slide 1 must use cached_video_tracks file_ids');
  // Un-kept Slide 2 media IDs WERE cleaned up when moving away from Slide 2
  assert.ok(rec.deleted.length >= 1);
});

test('Channel Polls post anonymously via update.poll and restart-safe DB persistence promotes winners', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const sm = new StateMachine();
  const rec = makeRecordingApi();
  const calls = [];

  const app = {
    db,
    settings,
    sm,
    voiceClient: {
      isSetup: () => true,
      async setup() { return { status: 'ready' }; },
      async play(chatId, req) { calls.push(['play', chatId, req.title]); return { status: 'playing', positionSeconds: 0 }; },
      async stop(chatId) { calls.push(['stop', chatId]); return {}; },
      async seek() { return {}; }
    }
  };
  app.musicQueueManager = new QueueManager({ app, pollMs: 0, log: { info() {}, warn() {}, error() {}, debug() {} } });
  app.music = new MusicService({ app, search: {}, lyrics: null, accounts: { sync: async () => {} } });
  app.music.authorize = async () => -100777;
  app.musicQueueManager.updatePlayerCard = async (id) => { calls.push(['card', id]); };
  t.after(async () => {
    await app.music.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });

  const chanId = -100777;
  const sess = app.musicQueueManager.getSession(chanId);
  sess.currentTrack = { id: 'm1', entryId: 'cur-1', title: 'Movie One', provider: 'movie', mediaType: 'video', streamUrl: 'https://example.com/1.mp4' };
  sess.status = 'playing';
  sess.activeDeck = 'movie';
  app.musicQueueManager.enqueueMovie(chanId, { id: 'm2', title: 'Movie Two', type: 'movie', durationSeconds: 5200, streamUrl: 'https://example.com/2.mp4', capabilities: { stream: true, download: true, video: true } });
  sess.api = rec.api;
  sess.isChannel = true;
  sess.screenMessageId = 101;
  sess.playerChatId = chanId;
  const origPlayQueued = app.musicQueueManager.playQueuedMovieNow.bind(app.musicQueueManager);
  assert.equal(typeof origPlayQueued, 'function');
  app.musicQueueManager.playQueuedMovieNow = async (_id, entryId) => {
    const idx = sess.movieUpcoming.findIndex((x) => x.entryId === entryId);
    assert.ok(idx >= 0);
    sess.currentTrack = sess.movieUpcoming.splice(idx, 1)[0];
    return sess.currentTrack;
  };

  await app.music.control({ tgId: '100', chatId: chanId, messageId: 101, isChannel: true, channelAdminVerified: true, api: rec.api, query: { id: 'p1' } }, 'launchpoll', []);
  assert.equal(rec.sentPolls.length, 1);
  assert.equal(rec.sentPolls[0].chatId, chanId);
  assert.equal(rec.sentPolls[0].extra.is_anonymous, true);

  const pollId = rec.sentPolls[0].pollId;
  // Simulate bot restart losing in-memory activePolls Map:
  app.music.activePolls.clear();

  const bot = new TelegramController({ api: rec.api, db, settings, sm, screens: new Map(), app });
  await bot.handleUpdate({
    poll: {
      id: pollId,
      is_closed: false,
      options: [
        { text: 'Skip', voter_count: 0 },
        { text: 'Movie Two', voter_count: 2 }
      ]
    }
  });

  assert.equal(rec.stoppedPolls.length, 1);
  assert.equal(app.musicQueueManager.getSession(chanId).currentTrack.title, 'Movie Two');
  assert.equal(db.getSetting(`music.activePoll.${pollId}`, null), null);

  // Also test music queue 'top' promotion via QueueManager.promoteTrack
  app.musicQueueManager.enqueue(chanId, normalizeTrack({ providerId: 's1', title: 'Song 1', artist: 'A', durationSeconds: 180, streamUrl: 'https://example.com/s1.mp3' }, 'fixture'));
  app.musicQueueManager.enqueue(chanId, normalizeTrack({ providerId: 's2', title: 'Song 2', artist: 'B', durationSeconds: 180, streamUrl: 'https://example.com/s2.mp3' }, 'fixture'));
  app.musicQueueManager.enqueue(chanId, normalizeTrack({ providerId: 's3', title: 'Song 3', artist: 'C', durationSeconds: 180, streamUrl: 'https://example.com/s3.mp3' }, 'fixture'));
  const thirdId = sess.upcoming[2].entryId;
  app.musicQueueManager.promoteTrack(chanId, thirdId);
  assert.equal(sess.upcoming[0].title, 'Song 3');
});

test('Channels isolate DM-only commands, inspect can_post_messages, prioritize channel stateKey, and reuse AI/search cards', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const sm = new StateMachine();
  const rec = makeRecordingApi();

  let openedScreens = [];
  const fakeScreen = (name) => ({ async open(ctx) { openedScreens.push({ name, chatId: ctx.chatId }); return { message_id: 999 }; } });
  const app = {
    db,
    settings,
    sm,
    movieSessions: new MovieSessions({ db }),
    movieApi: {
      async search(q) { return { results: [{ id: 'mv1', type: 'movie', title: q }] }; },
      async detail() { return { id: 'mv1', type: 'movie', title: 'Matrix' }; }
    },
    ai: {
      async chat(_id, _text) { return { reply: 'Recommended: The Matrix!', action: null }; }
    },
    music: {
      async authorize() { return -100888; },
      botKey() { return 'main'; },
      destination() { return -100888; }
    },
    musicQueueManager: new QueueManager({ app: { db, settings }, pollMs: 0, log: { info() {}, warn() {}, error() {}, debug() {} } })
  };

  const musicScreen = createMusicScreen({ app });
  musicScreen.registerStateHandlers(sm);
  t.after(async () => {
    await musicScreen.cleanup();
    await app.musicQueueManager.shutdown();
  });
  const screens = new Map([
    ['channel_post', fakeScreen('channel_post')],
    ['autopost', fakeScreen('autopost')],
    ['clone', fakeScreen('clone')],
    ['music', musicScreen]
  ]);
  const bot = new TelegramController({ api: rec.api, db, settings, sm, screens, app });

  // 1. my_chat_member records real can_post_messages=false and cleans up demoted status='member'
  await bot.handleUpdate({
    my_chat_member: {
      chat: { id: -100888, type: 'channel', title: 'Restricted Channel' },
      from: { id: 100, is_bot: false, first_name: 'Owner' },
      new_chat_member: { user: { id: 999, is_bot: true }, status: 'administrator', can_post_messages: false }
    }
  });
  const rowNoPost = db.get('SELECT * FROM tg_channels WHERE channel_id = ?', -100888);
  assert.equal(rowNoPost.can_post, 0);

  await bot.handleUpdate({
    my_chat_member: {
      chat: { id: -100888, type: 'channel', title: 'Restricted Channel' },
      from: { id: 100, is_bot: false, first_name: 'Owner' },
      new_chat_member: { user: { id: 999, is_bot: true }, status: 'member' }
    }
  });
  assert.equal(db.get('SELECT * FROM tg_channels WHERE channel_id = ?', -100888), undefined);

  // 2. DM-only commands posted in channel_post do NOT open DM wizards or DM dashboard
  const chanChat = { id: -100888, type: 'channel', title: 'Cinema Channel' };
  for (const [idx, cmdText] of ['/forcejoin', '/postchannel', '/autopost', '/clone', '/rmbot', '/start'].entries()) {
    await bot.handleUpdate({
      channel_post: { message_id: 200 + idx, chat: chanChat, sender_chat: chanChat, text: cmdText }
    });
  }
  assert.equal(openedScreens.length, 0, 'DM wizard screens must not open inside channels');

  // 3. Channel movie search prompt ('ps') uses rich card and channel_post state priority beats leftover DM tgId state!
  await musicScreen.movieUi.openHub({ tgId: '100', chatId: -100888, isChannel: true, channelAdminVerified: true, api: rec.api });
  const ms = app.movieSessions.getLatestForChat(-100888);
  await musicScreen.movieUi.handleCallback(
    { tgId: '100', chatId: -100888, isChannel: true, channelAdminVerified: true, api: rec.api, query: { id: 'qp' } },
    [ms.id, 'ps']
  );
  assert.equal(sm.state(String(-100888)), States.MUSIC_QUEUE_INPUT);
  await sm.transition('100', States.URL_DOWNLOADER_INPUT, { chatId: 100, context: {} });

  await bot.handleUpdate({
    channel_post: { message_id: 305, chat: chanChat, sender_chat: chanChat, from: { id: 100, is_bot: false, first_name: 'Owner' }, text: 'Inception' }
  });
  assert.equal(sm.state(String(-100888)), States.IDLE, 'Channel search consumed channel_post query safely');
  assert.ok(rec.editedRich.some((e) => e.chatId === -100888) || rec.sentRich.some((s) => s.chatId === -100888));

  // 4. AI turn in channel reuses a rich card instead of raw sendMessage spam
  const rawCountBeforeAi = rec.sentMessages.length;
  await musicScreen.movieUi.handleAiTurn({ tgId: '100', chatId: -100888, isChannel: true, channelAdminVerified: true, api: rec.api }, 'Suggest a sci-fi movie');
  assert.equal(rec.sentMessages.length, rawCountBeforeAi, 'Channel AI reply should use rich card rather than raw text message');
});

test('TelegramAPI.sendPoll sends native array options and Movie Auto-Poll enforces 1 poll per movie, clone votes, and auto-delete', async t => {
  const { TelegramAPI } = await import('../src/telegram/api.js');
  let sentBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    sentBody = JSON.parse(init.body || '{}');
    return {
      ok: true,
      async json() {
        return { ok: true, result: { message_id: 777, poll: { id: 'p_live_1' } } };
      }
    };
  };
  t.after(() => { globalThis.fetch = origFetch; });
  const liveApi = new TelegramAPI('123:ABC');
  await liveApi.sendPoll(-100999, 'Next Movie?', ['Skip', 'Movie 2']);
  assert.ok(Array.isArray(sentBody.options), 'sendPoll must send options as a raw JSON array, not stringified string');
  assert.deepEqual(sentBody.options, [{ text: 'Skip' }, { text: 'Movie 2' }]);

  const db = new Database(':memory:');
  db.migrate();
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const sm = new StateMachine();
  const cloneRec = makeRecordingApi();
  cloneRec.api.me = { id: 8888, username: 'clone_cine_bot', first_name: 'CloneCine' };
  cloneRec.api.botUsername = 'clone_cine_bot';
  const mainRec = makeRecordingApi();
  const plays = [];

  const app = {
    db,
    settings,
    sm,
    telegram: { api: mainRec.api, botUsername: 'Lancy_easy_bot' },
    multiBotManager: {
      runningBots: new Map([[1, { api: cloneRec.api }]])
    },
    voiceClient: {
      isSetup: () => true,
      async setup() { return { ok: true, status: 'ready' }; },
      async play(chatId, src, opts = {}) {
        plays.push({ chatId, src, opts });
        return { ok: true, account_alias: 'acc1', status: 'playing', position_seconds: 0, av_sync: { monitored: true, sync_health: 'locked', skew_ms: 8, syncing: false } };
      },
      async setVolume() { return { ok: true }; },
      async stop() { return { ok: true }; },
      async idle() { return { ok: true }; }
    }
  };
  app.musicQueueManager = new QueueManager({ app, db, voiceClient: app.voiceClient, pollMs: 0, log: { info() {}, warn() {}, error() {}, debug() {} } });
  app.music = new MusicService({ app, search: {}, lyrics: null, accounts: { sync: async () => {} } });
  app.music.authorize = async () => -100555;
  app.musicQueueManager.updatePlayerCard = async () => true;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => {
    await screen.cleanup();
    await app.music.previews.shutdown();
    await app.musicQueueManager.shutdown();
  });

  const groupId = -100555;
  const s = app.musicQueueManager.getSession(groupId);
  s.prepared = true;
  s.api = cloneRec.api;
  s.botId = 1;
  s.playerChatId = groupId;
  s.screenMessageId = 500;

  // Verify Cinema Player shows A/V sync lock + Vote Settings shows Auto-Poll toggle
  assert.equal(app.music.isAutoPollEnabled(groupId), true);
  await app.music.control({ tgId: '100', chatId: groupId, messageId: 500, botId: 1, api: cloneRec.api, query: { id: 'q_vs' } }, 'voteset', []);
  const vsRich = screen.renderVoteSettings(s);
  const vsLabels = collectButtons(vsRich).map(btnText);
  assert.ok(vsLabels.some((t2) => /Auto-Poll · ON/i.test(t2)), 'Vote Settings should display Auto-Poll toggle');

  // Toggle Auto-Poll OFF and verify queuing multiple movies does NOT auto-post a poll
  await app.music.control({ tgId: '100', chatId: groupId, messageId: 500, botId: 1, api: cloneRec.api, query: { id: 'q_off' } }, 'setvotethresh', ['autopoll', 'off']);
  assert.equal(app.music.isAutoPollEnabled(groupId), false);
  await app.musicQueueManager.addMovies(groupId, [
    { id: 'm1', title: 'Movie One', streamUrl: 'https://example.com/1.mp4', durationSeconds: 5000, capabilities: { seek: true, video: true } },
    { id: 'm2', title: 'Movie Two', streamUrl: 'https://example.com/2.mp4', durationSeconds: 5000, capabilities: { seek: true, video: true } },
    { id: 'm3', title: 'Movie Three', streamUrl: 'https://example.com/3.mp4', durationSeconds: 5000, capabilities: { seek: true, video: true } }
  ]);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(cloneRec.sentPolls.length, 0, 'No auto-poll when Auto-Poll is OFF');

  // Turn Auto-Poll back ON via /autopoll command with vote limit 2 & verify Cinema card shows A/V Synced
  const cardTxt = JSON.stringify(screen.renderCinemaPlayer(s));
  assert.match(cardTxt, /A\/V Synced/);

  await app.music.autopollCommand({ tgId: '100', chatId: groupId, botId: 1, api: cloneRec.api }, ['on', '2']);
  assert.equal(app.music.isAutoPollEnabled(groupId), true);
  assert.equal(app.music.getQueueVoteThreshold(groupId), 2);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(cloneRec.sentPolls.length, 1, 'Auto-poll posts once for Movie One when ON with queued movies');
  const firstPoll = cloneRec.sentPolls[0];
  assert.equal(firstPoll.extra.is_anonymous, false);

  // Enqueueing additional movies while Movie One is playing MUST NOT spawn a 2nd poll
  await app.musicQueueManager.addMovies(groupId, [
    { id: 'm4', title: 'Movie Four', streamUrl: 'https://example.com/4.mp4', durationSeconds: 5000, capabilities: { seek: true, video: true } }
  ]);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(cloneRec.sentPolls.length, 1, 'Must stay strictly 1 poll during the same playing movie');

  // Cloned bot receives Viewer 1 poll_answer, survives restart, Viewer 2 completes vote -> winner Movie Three plays AND old poll is DELETED!
  const cloneBot = new TelegramController({
    api: cloneRec.api,
    db,
    settings,
    sm,
    screens: new Map([['music', screen]]),
    app,
    botContext: { botId: 1, isClone: true, botUsername: 'clone_cine_bot' }
  });

  await cloneBot.handleUpdate({ poll_answer: { poll_id: firstPoll.pollId, user: { id: 701 }, option_ids: [2] } });
  assert.equal(cloneRec.deleted.length, 0);
  // Simulate restart clearing in-memory activePolls Map; votesByUser must reload from DB!
  app.music.activePolls.clear();
  await cloneBot.handleUpdate({ poll_answer: { poll_id: firstPoll.pollId, user: { id: 702 }, option_ids: [2] } });

  assert.equal(cloneRec.stoppedPolls.length, 1);
  assert.ok(cloneRec.deleted.some((d) => d.message_id === firstPoll.message_id), 'Decided poll message must be deleted automatically');
  assert.equal(s.currentTrack.title, 'Movie Three');

  // Next movie (Movie Three) automatically gets 1 fresh poll since queue still has upcoming items!
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(cloneRec.sentPolls.length, 2, 'Next playing movie gets its own fresh poll when queue still has items');
  const secondPoll = cloneRec.sentPolls[1];

  // If queue action is Boost to #1 ('top'), deciding poll keeps Movie Three playing, deletes poll, and DOES NOT create another poll until next movie plays!
  db.setSetting(`music.queueVoteAction.${groupId}`, 'top');
  await cloneBot.handleUpdate({ poll_answer: { poll_id: secondPoll.pollId, user: { id: 701 }, option_ids: [1] } });
  await cloneBot.handleUpdate({ poll_answer: { poll_id: secondPoll.pollId, user: { id: 702 }, option_ids: [1] } });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(cloneRec.deleted.some((d) => d.message_id === secondPoll.message_id), true);
  assert.equal(s.currentTrack.title, 'Movie Three');
  assert.equal(cloneRec.sentPolls.length, 2, 'Must NOT create another poll for the same movie once poll is decided');
});
