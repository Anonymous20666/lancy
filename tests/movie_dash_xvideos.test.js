import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { MovieDownloader } from '../src/media/movieDownloader.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { AdultCatalog } from '../src/media/adultCatalog.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { decodeCallback } from '../src/telegram/rich.js';

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

function assertAllCallbacksFit64(rich, label = 'card') {
  for (const b of collectButtons(rich)) {
    if (b?.callback_data) {
      const bytes = Buffer.byteLength(String(b.callback_data), 'utf8');
      assert.ok(bytes <= 64, `${label} button "${btnText(b)}" exceeds 64 bytes (${bytes}): ${b.callback_data}`);
    }
  }
}

function createHarness() {
  const db = new Database(':memory:');
  const baseSettings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const extraOverrides = new Map();
  const settings = new Proxy(baseSettings, {
    get(target, prop) {
      if (prop === 'get') {
        return (k, ...rest) => (extraOverrides.has(k) ? extraOverrides.get(k) : target.get(k, ...rest));
      }
      if (prop === 'set') {
        return (k, v) => (k === 'nsfw.requireAgeGate' ? extraOverrides.set(k, v) : target.set(k, v));
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
  const sm = new StateMachine();

  const searchCalls = [];
  const resolveCalls = [];
  const downloadedSingles = [];
  const downloadedSlides = [];
  const sentRich = [];
  const editedRich = [];
  const allRich = [];
  const alerts = [];
  let msgSeq = 1000;

  const sampleItems = Array.from({ length: 15 }, (_, i) => ({
    id: `99${i + 1}`,
    title: `XVideos Feature #${i + 1}`,
    duration: `${8 + i}:30`,
    durationSeconds: (8 + i) * 60 + 30,
    thumbUrl: `https://img.example.com/thumb_${i + 1}.jpg`,
    pageUrl: `https://www.xvideos.com/video.xv${i + 1}/sample_${i + 1}`,
    artist: `Creator ${i + 1}`,
    sourceKey: 'xvideos',
    category: 'xvideos'
  }));

  const adultCatalog = {
    isBlockedAdultText: (q) => /\b(underage|minor|loli)\b/i.test(String(q || '')),
    getCategories: ({ page = 0, perPage = 12 } = {}) => new AdultCatalog({ fetchImpl: async () => ({ ok: false }) }).getCategories({ page, perPage }),
    async getArtists({ page = 0, perPage = 12 } = {}) {
      const all = Array.from({ length: 24 }, (_, i) => ({
        name: `Star Model ${i + 1}`,
        xvSlug: `star-model-${i + 1}`,
        xvType: 'pornstars'
      }));
      return {
        items: all.slice(page * perPage, (page + 1) * perPage),
        page,
        totalPages: 2,
        total: all.length
      };
    },
    async searchXvideos(opts) {
      searchCalls.push(opts);
      return {
        results: sampleItems,
        page: opts.page || 0,
        totalPages: 5,
        total: 75,
        category: 'xvideos'
      };
    },
    async resolveStream(itemOrUrl, { preferredHeight = 720 } = {}) {
      resolveCalls.push({ itemOrUrl, preferredHeight });
      const base = typeof itemOrUrl === 'string' ? itemOrUrl : (itemOrUrl.pageUrl || 'https://www.xvideos.com/video.xv1/sample_1');
      const variants = [
        { quality: '360p', height: 360, url: `${base}/360.mp4`, sizeBytes: 18 * 1024 * 1024, isHls: false },
        { quality: '480p', height: 480, url: `${base}/480.mp4`, sizeBytes: 34 * 1024 * 1024, isHls: false },
        { quality: '720p', height: 720, url: `${base}/720.mp4`, sizeBytes: 72 * 1024 * 1024, isHls: false }
      ];
      const pick = variants.find((v) => v.height === preferredHeight) || variants[1];
      return {
        ok: true,
        title: typeof itemOrUrl === 'object' ? itemOrUrl.title : 'Direct URL Video',
        fullTitle: typeof itemOrUrl === 'object' ? itemOrUrl.title : 'Direct URL Video',
        artist: 'Verified Star',
        durationSeconds: 620,
        thumbUrl: 'https://img.example.com/resolved.jpg',
        streamUrl: pick.url,
        variants,
        headers: { Referer: 'https://www.xvideos.com/' },
        isHls: false
      };
    }
  };

  const api = {
    botUsername: 'Lancy_test_bot',
    async getMe() { return { id: 777, username: 'Lancy_test_bot' }; },
    async getChat(cid) {
      return Number(cid) < 0 ? { id: cid, type: 'supergroup', title: 'Group Cinema' } : { id: cid, type: 'private', first_name: 'DM' };
    },
    async getChatMember(cid, uid) {
      if ([100, 200, 777, 888].includes(Number(uid))) {
        return { status: 'administrator', can_invite_users: true, can_promote_members: true, can_manage_video_chats: true };
      }
      return { status: 'member' };
    },
    async answerCallbackQuery(id, opts = {}) {
      alerts.push({ id, ...opts });
      return true;
    },
    async sendChatAction() { return true; },
    async sendMessage(chatId, text, extra = {}) {
      return { message_id: ++msgSeq, chat: { id: chatId }, text, extra };
    },
    async deleteMessage() { return true; },
    async sendRichMessage(chatId, rich, extra = {}) {
      const message_id = ++msgSeq;
      const rec = { chatId, message_id, rich, extra };
      sentRich.push(rec);
      allRich.push(rec);
      return { message_id, chat: { id: chatId } };
    },
    async editMessageRich(chatId, message_id, rich, extra = {}) {
      const rec = { chatId, message_id, rich, extra };
      editedRich.push(rec);
      allRich.push(rec);
      return { message_id, chat: { id: chatId } };
    }
  };

  const movieSessions = new MovieSessions({ db });
  const movieDownloader = {
    hasCachedVideo: () => false,
    async sendSingleVideo(ctx, track, opts) {
      downloadedSingles.push({ chatId: ctx.chatId, track, opts });
      return { ok: true };
    },
    async deliverAlbumSlidePage(ctx, ms, page, opts) {
      downloadedSlides.push({ chatId: ctx.chatId, page, manifest: ms.dlManifest, opts });
      return { ok: true };
    }
  };
  const voiceClient = {
    isSetup: () => true,
    async setup() { return { ok: true, connected: true, active: true, user_id: 888, account_alias: 'acc1' }; },
    async play(chatId, source, opts) { return { ok: true, playback_id: 'pb_xv_1', chatId, source, opts }; },
    async status() { return { status: 'playing', position_seconds: 12 }; },
    async stop() { return { ok: true }; }
  };
  const qm = new QueueManager({
    app: { db, settings, adultCatalog },
    voiceClient,
    log: { info() {}, warn() {}, error() {}, debug() {} }
  });
  const app = {
    db,
    settings,
    sm,
    adultCatalog,
    movieSessions,
    movieDownloader,
    musicQueueManager: qm,
    voiceClient,
    movieApi: { async search() { return { results: [] }; }, async trending() { return { results: [] }; } }
  };
  app.music = new MusicService({ app, search: { resolve: async () => [] }, lyrics: null, accounts: { sync: async () => {} } });
  const musicScreen = createMusicScreen({ app });
  musicScreen.registerStateHandlers(sm);
  app.screens = new Map([['music', musicScreen]]);

  const latestCard = () => allRich.at(-1);
  const click = async (userId, chatId, rich, matchFn) => {
    const btn = collectButtons(rich).find(matchFn);
    assert.ok(btn, `Expected button matching predicate in card`);
    const decoded = decodeCallback(btn.callback_data);
    assert.equal(decoded.screen, 'music');
    await musicScreen.handle({
      tgId: String(userId),
      chatId,
      isGroup: Number(chatId) < 0,
      user: { tg_id: Number(userId), first_name: `U${userId}` },
      api,
      sm,
      messageId: latestCard().message_id,
      query: { id: `q_${++msgSeq}`, from: { id: Number(userId) }, message: { message_id: latestCard().message_id } }
    }, decoded.action, decoded.args);
    return latestCard().rich;
  };

  return {
    db,
    settings,
    sm,
    api,
    app,
    qm,
    movieSessions,
    musicScreen,
    searchCalls,
    resolveCalls,
    downloadedSingles,
    downloadedSlides,
    sentRich,
    editedRich,
    alerts,
    latestCard,
    click
  };
}

test('MovieSessions persists XVideos state across restart including xvSelected Set & panelToken', () => {
  const db = new Database(':memory:');
  const s1 = new MovieSessions({ db });
  const ms = s1.create({ chatId: 500, userId: 500, destination: -10077, panelToken: 'tok_xv', sourceMode: 'xvideos' });
  ms.xvMode = 'category';
  ms.xvCat = 'asian';
  ms.xvSort = 'views';
  ms.xvDur = 'medium';
  ms.xvQuality = '720p';
  ms.xvSelected.add(0);
  ms.xvSelected.add(3);
  ms.xvResults = [{ id: '991', title: 'Sample' }];
  s1.persistNow();

  const s2 = new MovieSessions({ db });
  const restored = s2.get(ms.id);
  assert.ok(restored);
  assert.equal(restored.sourceMode, 'xvideos');
  assert.equal(restored.xvMode, 'category');
  assert.equal(restored.xvCat, 'asian');
  assert.equal(restored.xvSort, 'views');
  assert.equal(restored.xvDur, 'medium');
  assert.equal(restored.xvQuality, '720p');
  assert.equal(restored.panelToken, 'tok_xv');
  assert.equal(restored.destination, -10077);
  assert.equal(restored.xvSelected instanceof Set, true);
  assert.deepEqual([...restored.xvSelected], [0, 3]);
  db.close();
});

test('Movie Dash XVideos (DM): Hub toggle, Trending, Categories, Artists, filters, multi-select slides, 720p download & Age Gate', async (t) => {
  const h = createHarness();
  t.after(async () => {
    await h.musicScreen.cleanup();
    await h.app.music.previews.shutdown();
    await h.qm.shutdown();
    h.db.close();
  });

  // Enable age gate and verify enforcement before verification
  h.settings.set('nsfw.requireAgeGate', true);

  const dmCtx = {
    tgId: '500',
    chatId: 500,
    isGroup: false,
    user: { tg_id: 500, first_name: 'DMUser' },
    api: h.api,
    sm: h.sm,
    message: { chat: { id: 500, type: 'private' } }
  };

  await h.musicScreen.handleCommand(dmCtx, '/movie', []);
  let rich = h.latestCard().rich;
  assertAllCallbacksFit64(rich, 'DM Movie Hub');
  assert.ok(collectButtons(rich).some((b) => btnText(b).includes('XVideos Mode')));

  // Switch to XVideos mode -> blocked by Age Gate -> confirm 18+
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('XVideos Mode'));
  assert.match(JSON.stringify(rich), /Age Verification Required/i);
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('18+'));
  assertAllCallbacksFit64(rich, 'DM XVideos Hub');
  assert.match(JSON.stringify(rich), /XVideos Studio/);

  // Trending -> Sort Views -> Duration 3-10m -> Page 2
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Trending Now'));
  assertAllCallbacksFit64(rich, 'XVideos Trending Results');
  assert.equal(h.searchCalls.at(-1).sort, 'relevance');

  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Views'));
  assert.equal(h.searchCalls.at(-1).sort, 'views');

  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('3-10m'));
  assert.equal(h.searchCalls.at(-1).durationFilter, 'medium');

  // Check #1 & #2 -> download slides in DM (spoiler must be false in DM!)
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('#1'));
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('#2'));
  assertAllCallbacksFit64(rich, 'XVideos Selected Results');
  await h.click(500, 500, rich, (b) => btnText(b).includes('Slides (2)'));
  assert.equal(h.downloadedSlides.length, 1);
  assert.equal(h.downloadedSlides[0].manifest.items.length, 2);
  assert.equal(h.downloadedSlides[0].opts.spoiler, false);

  // Return to results -> Open Detail #1 -> choose 720p -> download single MP4
  rich = h.latestCard().rich;
  rich = await h.click(500, 500, rich, (b) => b.callback_data?.includes(':xo:0'));
  assertAllCallbacksFit64(rich, 'XVideos Detail DM');
  assert.ok(rich.blocks.some((b) => b.type === 'photo'), 'DM detail card may attach preview photo');

  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('720p'));
  assert.match(JSON.stringify(rich), /Download 720p MP4/);

  await h.click(500, 500, rich, (b) => btnText(b).includes('Download 720p MP4'));
  assert.equal(h.downloadedSingles.length, 1);
  assert.equal(h.downloadedSingles[0].track.id, 'xv:991');
  assert.equal(h.downloadedSingles[0].opts.quality, '720p');
  assert.equal(h.downloadedSingles[0].opts.spoiler, false);

  // Browse Categories -> Page 2 -> Asian & Artists -> Star #1
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Hub'));
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Categories'));
  assertAllCallbacksFit64(rich, 'XVideos Categories');
  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Next'));
  rich = await h.click(500, 500, rich, (b) => b.callback_data?.includes(':xcc:'));
  assert.ok(h.searchCalls.at(-1).category);

  rich = await h.click(500, 500, rich, (b) => btnText(b).includes('Artists'));
  assertAllCallbacksFit64(rich, 'XVideos Artists');
  rich = await h.click(500, 500, rich, (b) => b.callback_data?.includes(':xac:'));
  assert.ok(h.searchCalls.at(-1).artist);
});

test('Movie Dash XVideos (Group): opt-in lock, admin toggle, artwork hidden, RTMP/VC switch & VC streaming', async (t) => {
  const h = createHarness();
  t.after(async () => {
    await h.musicScreen.cleanup();
    await h.app.music.previews.shutdown();
    await h.qm.shutdown();
    h.db.close();
  });

  const gcId = -100500;
  // Admin opens /movie in group -> XVideos is locked by default until unlocked
  await h.musicScreen.handleCommand({
    tgId: '200',
    chatId: gcId,
    isGroup: true,
    user: { tg_id: 200, first_name: 'Admin' },
    api: h.api,
    sm: h.sm,
    message: { chat: { id: gcId, type: 'supergroup' } }
  }, '/movie', []);

  let rich = h.latestCard().rich;
  assert.ok(collectButtons(rich).some((b) => btnText(b).includes('Unlock XVideos (Admin)')));

  // Non-admin user (999) attempting to unlock receives alert & stays locked
  await h.click(999, gcId, rich, (b) => btnText(b).includes('Unlock XVideos'));
  assert.ok(h.alerts.some((a) => a.show_alert === true && /administrators/i.test(a.text || '')));
  assert.equal(h.db.getSetting(`nsfw.groupEnabled.${gcId}`, false), false);

  // Group Admin (200) unlocks -> now XVideos Mode is visible
  rich = await h.click(200, gcId, rich, (b) => btnText(b).includes('Unlock XVideos'));
  assert.equal(h.db.getSetting(`nsfw.groupEnabled.${gcId}`, false), true);
  rich = await h.click(200, gcId, rich, (b) => btnText(b).includes('XVideos Mode'));

  // Toggle VC Stream Engine: default RTMP -> Interactive VC -> RTMP
  rich = await h.click(200, gcId, rich, (b) => btnText(b).includes('RTMP Live'));
  assert.equal(h.qm.getDeckStreamMode(gcId, 'movie'), 'interactive');
  rich = await h.click(200, gcId, rich, (b) => btnText(b).includes('Interactive VC'));
  assert.equal(h.qm.getDeckStreamMode(gcId, 'movie'), 'rtmp');

  // Search prompt flow -> type query -> renders XVideos results on same session
  await h.click(200, gcId, rich, (b) => btnText(b).includes('Search XVideos'));
  const stRec = h.sm.get('200');
  assert.equal(stRec.context.sourceMode, 'xvideos');
  const handledSearch = await h.sm.handleMessage('200', {
    text: 'tokyo nights',
    chat: { id: gcId, type: 'supergroup' },
    reply_to_message: { message_id: stRec.context.promptMessageId }
  }, {
    tgId: '200',
    chatId: gcId,
    isGroup: true,
    user: { tg_id: 200, first_name: 'Admin' },
    api: h.api,
    sm: h.sm
  });
  assert.equal(handledSearch, true);
  assert.equal(h.searchCalls.at(-1).query, 'tokyo nights');

  // Detail in Group MUST NOT attach unblurred adult photo; Download uses spoiler: true
  rich = await h.click(200, gcId, h.latestCard().rich, (b) => b.callback_data?.includes(':xo:0'));
  assert.equal(rich.blocks.some((b) => b.type === 'photo'), false, 'Group XVideos detail card must suppress adult photo');
  await h.click(200, gcId, rich, (b) => btnText(b).includes('Download'));
  assert.equal(h.downloadedSingles.at(-1).opts.spoiler, true);

  // Play in VC -> active session plays xv:991, Player card in group hides adult photo & prefixes 18+
  rich = await h.click(200, gcId, h.latestCard().rich, (b) => btnText(b).includes('Play in VC'));
  const qSess = h.qm.getSession(gcId);
  assert.ok(qSess.currentTrack);
  assert.equal(qSess.currentTrack.providerId, 'xv:991');
  assert.equal(qSess.currentTrack.isAdult, true);
  assert.equal(rich.blocks.some((b) => b.type === 'photo'), false, 'Group Cinema Player must suppress adult artwork photo');
  assert.match(JSON.stringify(rich), /🔞/);
});

test('MovieDownloader namespaces adult cache keys separately from TMDB & QueueManager re-resolves stale CDN URLs', async (t) => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  t.after(() => db.close());

  const dl = new MovieDownloader({ app: { db, settings }, fetchImpl: async () => ({ ok: false }) });
  const tmdbItem = { id: 991, title: 'TMDB Movie' };
  const xvItem = { id: '991', isAdult: true, sourceKey: 'xvideos', title: 'XVideos Clip', streamUrl: 'https://cdn.example/v.mp4' };

  // Directly store separate file_ids for both keys via DB & confirm lookup never collides
  const tier = dl.getLimitBytes() >= 500 * 1024 * 1024 ? '2g' : '50m';
  db.run('INSERT INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)', `mv:movie:991:0:0:${tier}:q720p`, 'fid_tmdb_991', 'TMDB Movie', 6000);
  db.run('INSERT INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)', `mv:xvideos:991:0:0:${tier}:q720p`, 'fid_xv_991', 'XVideos Clip', 600);
  assert.equal(dl.hasCachedVideo(tmdbItem, '720p'), true);
  assert.equal(dl.hasCachedVideo(xvItem, '720p'), true);

  const sentIds = [];
  const res = await dl.sendSingleVideo({
    chatId: 500,
    tgId: '500',
    api: {
      async sendVideo(_c, media) { sentIds.push(media); return { message_id: 1 }; },
      async sendRichMessage() { return { message_id: 2 }; }
    }
  }, xvItem, { quality: '720p' });
  assert.equal(res.ok, true);
  assert.equal(sentIds[0], 'fid_xv_991', 'Adult cache lookup must NEVER collide with TMDB numeric ID 991');

  // QueueManager stale CDN re-resolution (>90 mins old)
  let reResolvedCount = 0;
  const voiceCalls = [];
  const qm = new QueueManager({
    app: {
      db,
      settings,
      adultCatalog: {
        async resolveStream(track) {
          reResolvedCount++;
          assert.equal(track.providerId, 'xv:stale');
          return { streamUrl: 'https://cdn.example/fresh_signed.mp4', headers: { Referer: 'https://www.xvideos.com/' }, isHls: false };
        }
      }
    },
    voiceClient: {
      isSetup: () => true,
      async setup() { return { ok: true, connected: true }; },
      async play(_cid, src) { voiceCalls.push(src); return { ok: true, playback_id: 'pb_fresh' }; },
      async status() { return { status: 'playing', position_seconds: 0 }; },
      async stop() { return { ok: true }; }
    },
    log: { info() {}, warn() {}, error() {}, debug() {} }
  });
  t.after(() => qm.shutdown());

  await qm.addMovies(501, [{
    id: 'xv:stale',
    type: 'xvideos',
    title: 'Expired Session Track',
    provider: 'movie',
    mediaType: 'video',
    isAdult: true,
    pageUrl: 'https://www.xvideos.com/video.stale/demo',
    streamUrl: 'https://cdn.example/expired_token.mp4',
    streamResolvedAt: Date.now() - 2 * 60 * 60 * 1000 // 2h ago (> 90m)
  }], { playNow: true });

  assert.equal(reResolvedCount, 1);
  assert.equal(voiceCalls[0], 'https://cdn.example/fresh_signed.mp4');
});
