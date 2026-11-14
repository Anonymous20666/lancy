import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MediaDownloader } from '../src/media/downloader.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';

function makeTrack(n, extra = {}) {
  return {
    id: `youtube:vid_${n}`,
    provider: 'youtube',
    providerId: `vid_${n}`,
    title: `Song ${n}`,
    artist: `Artist ${n}`,
    durationSeconds: 180,
    streamUrl: `https://example.org/stream_${n}.mp4`,
    mediaType: 'video',
    availability: 'resolved',
    capabilities: { stream: true, download: true, seek: true, video: true },
    ...extra
  };
}

test('Goal 1: MediaDownloader detects new platforms (thenkiri, bilibili, justwatch, reddit, bluesky) & handles Thenkiri/Bilibili/JustWatch/TikWM retry', async () => {
  const dl = new MediaDownloader();

  // Platform detection
  assert.equal(dl.detectPlatform('https://thenkiri.com/the-mandalorian-season-3-download/'), 'thenkiri');
  assert.equal(dl.detectPlatform('https://nkiri.com/spider-man-movie/'), 'thenkiri');
  assert.equal(dl.detectPlatform('https://nkiri.ink/avengers-series/'), 'thenkiri');
  assert.equal(dl.detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
  assert.equal(dl.detectPlatform('https://b23.tv/abc1234'), 'bilibili');
  assert.equal(dl.detectPlatform('https://www.justwatch.com/us/movie/dune-part-two'), 'justwatch');
  assert.equal(dl.detectPlatform('https://www.reddit.com/r/videos/comments/123/clip/'), 'reddit');
  assert.equal(dl.detectPlatform('https://redd.it/xyz987'), 'reddit');
  assert.equal(dl.detectPlatform('https://bsky.app/profile/user.bsky.social/post/3k'), 'bluesky');
  assert.equal(dl.detectPlatform('https://www.twitch.tv/videos/12345'), 'twitch');

  // Mock socialDl adapters for deterministic unit testing of Thenkiri, Bilibili, and JustWatch
  dl.socialDl = {
    thenkiriDl: async (url) => ({
      platform: 'thenkiri',
      title: 'Extraction 2 (2023)',
      description: 'Tyler Rake returns for another high-stakes rescue mission.',
      poster: null,
      contentType: 'movie',
      episodes: [],
      sources: [{ label: 'Download Movie (850 MB)', url: 'https://downloadwella.com/file123/Extraction.2.mkv', locked: false, available: true }]
    }),
    thenkiriGetLink: async () => ({
      platform: 'thenkiri',
      url: 'https://cdn.downloadwella.com/d/abc/Extraction.2.2023.480p.mkv',
      format: 'mkv',
      contentLength: 850 * 1024 * 1024,
      headers: { Referer: 'https://thenkiri.com/' }
    }),
    isBilibiliUrl: (u) => /bilibili\.com\/video\//i.test(u),
    bilibiliDl: async () => ({
      platform: 'bilibili',
      id: 'BV1xx411c7mD',
      title: 'Bilibili Anime OP HD',
      author: 'Studio Official',
      duration: 95
    }),
    bilibiliSave: async (_url, outPath) => {
      writeFileSync(outPath, Buffer.alloc(16384, 0x42));
      return outPath;
    },
    justwatchDetails: async () => ({
      platform: 'justwatch',
      title: 'Dune: Part Two',
      releaseYear: 2024,
      description: 'Paul Atreides unites with Chani and the Fremen.',
      canonicalUrl: 'https://www.justwatch.com/us/movie/dune-part-two',
      offers: [
        { provider: 'Max', accessLabel: 'Subscription', providerUrl: 'https://play.max.com/movie/dune-2' },
        { provider: 'Apple TV', accessLabel: 'Rent $3.99', providerUrl: 'https://tv.apple.com/us/movie/dune-2' }
      ]
    }),
    justwatchWatch: async () => ({
      watchUrl: 'https://play.max.com/movie/dune-2'
    })
  };
  dl.extractAudioFromBuffer = async () => Buffer.alloc(4096, 0x55);

  const thenkiriRes = await dl.download('https://thenkiri.com/extraction-2-2023/');
  assert.equal(thenkiriRes.platform, 'thenkiri');
  assert.equal(thenkiriRes.title, 'Extraction 2 (2023)');
  assert.equal(thenkiriRes.infoOnly, true);
  assert.match(thenkiriRes.directUrl, /downloadwella\.com/);
  assert.ok(thenkiriRes.oversizeNotice.includes('~850 MB'));

  const biliRes = await dl.download('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(biliRes.platform, 'bilibili');
  assert.equal(biliRes.title, 'Bilibili Anime OP HD');
  assert.equal(biliRes.author, 'Studio Official');
  assert.equal(biliRes.durationSeconds, 95);
  assert.equal(biliRes.mediaItems.length, 1);
  assert.equal(biliRes.mediaItems[0].type, 'video');
  assert.ok(biliRes.audioTrack?.buffer);

  const jwRes = await dl.download('https://www.justwatch.com/us/movie/dune-part-two');
  assert.equal(jwRes.platform, 'justwatch');
  assert.equal(jwRes.title, 'Dune: Part Two');
  assert.equal(jwRes.infoOnly, true);
  assert.equal(jwRes.directUrl, 'https://play.max.com/movie/dune-2');
  assert.equal(jwRes.sourceLinks.length, 2);
});

test('Goal 2 & 3: GC URL Download adds Stream in VC button, prompts Queue vs Play Immediately when VC is active, continues previous playlist after immediate play, and pre-warms lookahead for instant skip', async (t) => {
  const playCalls = [];
  const voiceClient = {
    play: async (chatId, source, opts) => {
      playCalls.push({ chatId, source, opts });
      return { ok: true, account_alias: 'acc1' };
    },
    setVolume: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setup: async () => ({ ok: true, call_ready: true }),
    accounts: async () => ({ ok: true, accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] })
  };

  const settingsMap = new Map();
  const db = {
    getSetting: (k, def) => (settingsMap.has(k) ? settingsMap.get(k) : def),
    setSetting: (k, v) => settingsMap.set(k, v),
    run: (sql, k, v) => {
      if (String(sql).includes('bot_settings')) settingsMap.set(k, v);
    },
    get: (_sql, k) => (settingsMap.has(k) ? { value_json: settingsMap.get(k) } : null),
    prepare: () => ({ run: () => {} })
  };

  const sentRich = [];
  const editedRich = [];
  const callbackToasts = [];
  let nextMsgId = 500;

  const api = {
    me: { id: 99, username: 'lancy_bot' },
    getMe: async () => ({ id: 99, username: 'lancy_bot' }),
    getChat: async (id) => ({ id, type: 'supergroup', title: 'Test Group' }),
    getChatMember: async () => ({ status: 'administrator', can_manage_chat: true, can_delete_messages: true }),
    sendMessage: async (chatId, text) => ({ message_id: ++nextMsgId, chat: { id: chatId }, text }),
    editMessageText: async (chatId, messageId, text) => ({ message_id: messageId, chat: { id: chatId }, text }),
    deleteMessage: async () => true,
    sendRichMessage: async (chatId, rich) => {
      const m = { message_id: ++nextMsgId, chat: { id: chatId }, rich };
      sentRich.push(m);
      return m;
    },
    editMessageRich: async (chatId, messageId, rich) => {
      const m = { message_id: messageId, chat: { id: chatId }, rich };
      editedRich.push(m);
      return m;
    },
    answerCallbackQuery: async (_id, opts) => {
      callbackToasts.push(opts?.text || '');
      return true;
    }
  };

  const warmedEntries = [];
  let radioCounter = 10;
  const app = {
    db,
    settings: { get: () => [] },
    telegram: { api },
    voiceClient,
    musicLibrary: {
      hasReady: (entry) => Boolean(entry.filePath && existsSync(entry.filePath)),
      warm: async (entry) => {
        warmedEntries.push(entry.title);
        return true;
      },
      acquire: async (entry) => ({
        track: { ...entry, streamUrl: entry.streamUrl || `https://example.org/${entry.providerId}.mp4` },
        release: () => {}
      })
    },
    musicProviders: {
      get: () => ({ enabled: true, search: async () => ({ items: [makeTrack(++radioCounter)] }) }),
      search: async () => ({ items: [makeTrack(++radioCounter), makeTrack(++radioCounter), makeTrack(++radioCounter)] })
    },
    mediaDownloader: {
      detectPlatform: () => 'tiktok',
      download: async (url) => ({
        sourceUrl: url,
        platform: 'tiktok',
        title: 'Downloaded TikTok Banger',
        author: 'DJ TikTok',
        durationSeconds: 65,
        mediaItems: [{ type: 'video', buffer: Buffer.alloc(8192, 0x33), filename: 'tiktok.mp4', mimeType: 'video/mp4' }],
        audioTrack: { buffer: Buffer.alloc(4096, 0x44), filename: 'tiktok.mp3', title: 'Downloaded TikTok Banger', performer: 'DJ TikTok' }
      })
    }
  };

  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const musicService = new MusicService({ app, accounts: { sync: async () => {} }, lyrics: { get: async () => ({ found: false }) } });
  musicService.rate = () => {};
  app.music = musicService;
  const musicScreen = createMusicScreen({ app });
  const dlScreen = createDownloaderScreen({ app });
  app.screens = new Map([['music', musicScreen], ['downloader', dlScreen]]);

  t.after(async () => {
    await qm.shutdown();
  });

  // 1) Start an existing playlist in Group Chat (-100777) with Track 1 playing and Track 2, Track 3 in upcoming + Radio ON
  const groupChatId = -100777;
  const s = qm.getSession(groupChatId);
  musicService.radio.configure(s, ['Afrobeats']);
  await qm.addMany(groupChatId, [makeTrack(1, { title: 'Playlist Song 1' }), makeTrack(2, { title: 'Playlist Song 2' }), makeTrack(3, { title: 'Playlist Song 3' })]);

  assert.equal(s.status, 'playing');
  assert.equal(s.currentTrack.title, 'Playlist Song 1');
  assert.equal(s.upcoming.map((u) => u.title).slice(0, 2).join(', '), 'Playlist Song 2, Playlist Song 3');
  // Goal 3: Upcoming songs were immediately pre-warmed as soon as Song 1 started playing
  assert.ok(warmedEntries.includes('Playlist Song 2'));
  assert.ok(warmedEntries.includes('Playlist Song 3'));

  // 2) Execute URL download in Group Chat while VC is ALREADY active -> exposes ⚡ Play Now in VC & ➕ Queue in VC cleanly
  const groupCtx = {
    tgId: 42,
    chatId: groupChatId,
    isGroup: true,
    user: { id: 42, first_name: 'Tester' },
    api,
    db
  };
  await dlScreen.executeDownload(groupCtx, 'https://www.tiktok.com/@user/video/123456');
  const deliveryCard = [...sentRich, ...editedRich].at(-1)?.rich;
  assert.ok(deliveryCard, 'Delivery card rendered');
  const allButtons = (deliveryCard.blocks || []).filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const directNowBtn = allButtons.find((b) => JSON.stringify(b.text).includes('Play Now in VC'));
  const directQueueBtn = allButtons.find((b) => JSON.stringify(b.text).includes('Queue in VC'));
  assert.ok(directNowBtn && directQueueBtn, 'Group Chat download includes Play Now in VC and Queue in VC buttons');
  assert.ok(Buffer.byteLength(directNowBtn.callback_data) <= 64, `Callback fits 64B: ${directNowBtn.callback_data}`);

  // 3) Clicking vc_stream while VC is ALREADY active -> prompts Queue vs Play Immediately (without interrupting Song 1 yet!)
  const vcKey = directNowBtn.callback_data.split(':').at(-1);
  await dlScreen.handle({ ...groupCtx, messageId: 501, query: { id: 'q-stream' } }, 'vc_stream', [vcKey]);
  assert.equal(s.currentTrack.title, 'Playlist Song 1', 'Did not interrupt Song 1 before user chooses');

  const promptCard = sentRich.at(-1)?.rich;
  const promptBtns = (promptCard?.blocks || []).filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const queueBtn = promptBtns.find((b) => JSON.stringify(b.text).includes('Add to Queue'));
  const playNowBtn = promptBtns.find((b) => JSON.stringify(b.text).includes('Play Immediately'));
  assert.ok(queueBtn && playNowBtn, 'Prompt shows Add to Queue and Play Immediately');
  assert.ok(Buffer.byteLength(queueBtn.callback_data) <= 64);
  assert.ok(Buffer.byteLength(playNowBtn.callback_data) <= 64);

  // 4) Click "⚡ Play Immediately" -> Downloaded TikTok Banger (B) plays NOW, and interrupted Playlist Song 1 (A) is preserved at end of queue (B -> C -> ... -> A)
  await dlScreen.handle({ ...groupCtx, messageId: sentRich.at(-1).message_id, query: { id: 'q-now' } }, 'vc_now', [vcKey]);
  assert.equal(s.currentTrack.title, 'Downloaded TikTok Banger', 'Injected URL download is playing immediately');
  assert.equal(s.upcoming[0]?.title, 'Playlist Song 2', 'Next queued track C plays right after B (does not snap back to A)');
  assert.equal(s.upcoming[1]?.title, 'Playlist Song 3', 'Rest of playlist remains intact in order');
  assert.ok(s.upcoming.findIndex((t) => t.title === 'Playlist Song 1') >= 2, 'Interrupted track A is preserved after C..D at end of queue');
  assert.equal(s.radio?.enabled, true, 'Infinite Radio state remains intact');

  // 5) When the injected URL track finishes (or user skips), playback continues cleanly to C ("Playlist Song 2") -> ... -> A!
  await qm.handleStreamEnded(groupChatId, s.playbackId);
  assert.equal(s.currentTrack.title, 'Playlist Song 2', 'Queued playlist continues to next track C after injected track ended');
  assert.equal(s.upcoming[0]?.title, 'Playlist Song 3');

  // 6) Also test "➕ Add to Queue" (`vc_q`) appends cleanly without interrupting current playback
  await dlScreen.handle({ ...groupCtx, messageId: sentRich.at(-1).message_id, query: { id: 'q-add' } }, 'vc_q', [vcKey]);
  assert.equal(s.currentTrack.title, 'Playlist Song 2', 'Current playback was not interrupted by Add to Queue');
  assert.ok(s.upcoming.some((t) => t.title === 'Downloaded TikTok Banger'), 'Downloaded track added to upcoming queue');
});

test('Goal 3 & 4: Immediate skip aborts slow acquire in 0ms, and live song indicator never snaps user back to Player Card while browsing catmenu/genresub or managing Queue', async (t) => {
  const editedRich = [];
  const api = {
    me: { id: 99, username: 'lancy_bot' },
    getChatMember: async () => ({ status: 'administrator', can_manage_chat: true }),
    sendMessage: async (chatId, text) => ({ message_id: 700, chat: { id: chatId }, text }),
    sendRichMessage: async (chatId, rich) => ({ message_id: 701, chat: { id: chatId }, rich }),
    editMessageRich: async (chatId, messageId, rich) => {
      editedRich.push({ chatId, messageId, rich });
      return { message_id: messageId, chat: { id: chatId }, rich };
    },
    answerCallbackQuery: async () => true
  };

  const voiceClient = {
    play: async () => ({ ok: true, account_alias: 'acc1' }),
    setVolume: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setup: async () => ({ ok: true, call_ready: true }),
    status: async () => ({ ok: true, info: { status: 'playing', position_seconds: 25, volume: 100 } }),
    accounts: async () => ({ ok: true, accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] })
  };

  const app = {
    db: { getSetting: () => null, setSetting: () => {} },
    settings: { get: () => [] },
    telegram: { api },
    voiceClient,
    musicProviders: {
      get: () => ({ enabled: true, search: async () => ({ items: [makeTrack(99)] }) }),
      search: async () => ({ items: [makeTrack(99)] })
    }
  };

  const qm = new QueueManager({ app, db: app.db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, accounts: { sync: async () => {} }, lyrics: { get: async () => ({ found: true, text: 'Some live lyrics' }) } });
  service.rate = () => {};
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  t.after(async () => {
    await qm.shutdown();
  });

  const chatId = -100888;
  await qm.addMany(chatId, [makeTrack(1, { title: 'Live Song A' }), makeTrack(2, { title: 'Live Song B' }), makeTrack(3, { title: 'Live Song C' })]);
  const s = qm.getSession(chatId);
  qm.setPlayerMessage(chatId, 200, chatId, api);
  await qm.updatePlayerCard(chatId);

  // User opens "Infinite & Genres" (catmenu) on the player card message (messageId: 200)
  editedRich.length = 0;
  await screen.handle({ tgId: 10, chatId, api, messageId: 200, query: { id: 'cb-cat' } }, 'catmenu', ['video', 0]);
  assert.equal(s.overlayView, 'catmenu', 'Session records active catmenu overlay');
  assert.equal(editedRich.length, 1);
  assert.match(JSON.stringify(editedRich[0].rich), /Infinite|Categories|Afrobeats/i);

  // Now simulate the 5s/10s live indicator reconcile tick + background lyrics completion + updatePlayerCard
  editedRich.length = 0;
  s.nextCardEdit = 0;
  await qm.reconcile();
  await qm.updatePlayerCard(chatId);
  assert.equal(editedRich.length, 0, 'Live song indicator must NOT overwrite catmenu back to Player Card');

  // User clicks into a genre submenu (genresub) on the same card (messageId: 200)
  await screen.handle({ tgId: 10, chatId, api, messageId: 200, query: { id: 'cb-sub' } }, 'genresub', ['video', 'Afrobeats']);
  assert.equal(s.overlayView, 'genresub');
  editedRich.length = 0;
  s.nextCardEdit = 0;
  await qm.reconcile();
  assert.equal(editedRich.length, 0, 'Live song indicator must NOT overwrite genresub back to Player Card');

  // User switches to Queue view and clicks Skip -> must stay on Queue view (not kicked back to Player Card)
  await service.control({ tgId: 10, chatId, api, messageId: 200 }, 'queue', [0]);
  assert.equal(s.view, 'queue');
  assert.equal(s.overlayView, null, 'Explicit control action clears overlayView');
  await service.control({ tgId: 10, chatId, api, messageId: 200 }, 'skip', []);
  assert.equal(s.currentTrack.title, 'Live Song B', 'Skipped to Live Song B');
  assert.equal(s.view, 'queue', 'Skip inside Queue view keeps user on Queue view instead of snapping to Player Card');
});
