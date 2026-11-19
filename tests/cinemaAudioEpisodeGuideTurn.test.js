import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { MovieStreamResolver } from '../src/media/movieResolver.js';
import { VideoStreamingServer } from '../src/media/streamingServer.js';
import { extractSeasonEpisodeHint, parseMovieSearchIntent } from '../src/media/movieQueryParser.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { SearchSessions } from '../src/music/search.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { parseDeskIntents } from '../src/ai/deskNlu.js';
import { LancyToolExecutor } from '../src/ai/lancyTools.js';
import { OllamaProvider } from '../src/ai/providers/ollama.js';

function richTextToString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(richTextToString).join('');
  if (v && typeof v === 'object') return v.alternative_text || v.text || '';
  return '';
}

test('MovieStreamResolver spoken-audio verifier catches mislabeled English dubs on Korean shows', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('proxy1.flikhub.net/tv') || u.includes('proxy3.flikhub.net/tv')) {
      return new Response('', { status: 404 });
    }
    if (u.includes('vidbolt.xyz/api/resolve')) {
      return new Response(JSON.stringify({
        sources: [
          { source: 'vidbolt', language: 'Korean', url: 'https://cdn.fake.test/stream_as_ko/master.m3u8', type: 'hls', quality: '1080p' }
        ]
      }), { status: 200 });
    }
    if (u === 'https://cdn.fake.test/stream_as_ko/master.m3u8') {
      return new Response([
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="https://cdn.fake.test/stream_as_ko/v3.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=1280x720,AUDIO="audio"',
        'https://cdn.fake.test/stream_as_ko/v1.m3u8'
      ].join('\n'), { status: 200 });
    }
    if (u === 'https://cdn.fake.test/stream_as_ko/v1.m3u8') {
      return new Response([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:15',
        ...Array.from({ length: 240 }, (_, i) => `#EXTINF:15.0,\nhttps://cdn.fake.test/stream_as_ko/seg_${i}.m4s`),
        '#EXT-X-ENDLIST'
      ].join('\n'), { status: 200 });
    }
    if (u.startsWith('https://cdn.fake.test/stream_as_ko/seg_')) {
      return new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response('', { status: 404 });
  };

  let verifiedUrl = null;
  const resolver = new MovieStreamResolver({
    movieApi: {
      getPlaybackInfo: async () => null
    },
    fetchImpl,
    thenkiri: { thenkiriSearch: async () => ({ results: [] }) },
    socialAdapters: { catalogSearch: async () => ({ results: [] }) },
    enableYtDlp: false,
    audioLanguageVerifier: async (targetUrl) => {
      verifiedUrl = targetUrl;
      return { ok: true, language: 'en', probability: 0.97, speech_detected: true };
    }
  });

  const res = await resolver.resolve({
    id: 135157,
    tmdbId: 135157,
    type: 'tv',
    title: 'Alchemy of Souls',
    originalLanguage: 'ko',
    season: 2,
    episode: 2,
    durationSeconds: 3600
  }, { fetchSubtitles: false });

  assert.equal(res.ok, true);
  assert.equal(verifiedUrl, 'https://cdn.fake.test/stream_as_ko/v3.m3u8');
  assert.equal(res.track.audioLanguage, 'en');
  assert.equal(res.track.audioIsDub, true);
  assert.equal(res.track.dubOnly, true);
  assert.match(String(res.track.dubOnlyWarning || ''), /Dub Only Available/i);
});

test('extractSeasonEpisodeHint & parseMovieSearchIntent parse S02E02 and Season/Episode formats cleanly', () => {
  assert.deepEqual(extractSeasonEpisodeHint('Alchemy of Souls S02E02'), { title: 'Alchemy of Souls', season: 2, episode: 2 });
  assert.deepEqual(extractSeasonEpisodeHint('Breaking Bad Season 4 Episode 11'), { title: 'Breaking Bad', season: 4, episode: 11 });

  const parsed = parseMovieSearchIntent('play Alchemy of Souls S02E02');
  assert.equal(parsed.kind, 'search');
  assert.equal(parsed.query, 'Alchemy of Souls');
  assert.equal(parsed.season, 2);
  assert.equal(parsed.episode, 2);
});

test('MovieUi supports standalone S02E02 jumping, DM direct MP4 episode downloads, and permanent Hide Guide toggle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-cinema-reg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'test.sqlite'));
  const settings = new SettingsManager(db);
  const edited = [];
  const sent = [];
  const api = {
    me: { id: 1, username: 'pappyishimd_bot' },
    answerCallbackQuery: async () => true,
    getChatMember: async () => ({ status: 'administrator', can_manage_video_chats: true }),
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length + 10 }; },
    sendRichMessage: async (chatId, rich) => { sent.push({ chatId, rich }); return { message_id: sent.length + 10 }; },
    editMessageRich: async (chatId, messageId, rich) => { edited.push({ chatId, messageId, rich }); return { message_id: messageId }; }
  };

  const singleDownloads = [];
  const slideCalls = [];
  const app = {
    db,
    settings,
    musicLibrary: { acquire: async () => ({ filePath: join(dir, 'x.mp3'), release: () => {} }) },
    movieApi: {
      search: async (q) => ({
        results: [{ id: 135157, type: 'tv', title: q, year: 2022, originalLanguage: 'ko' }]
      }),
      getTvShow: async (id) => ({ id, type: 'tv', title: 'Alchemy of Souls', originalLanguage: 'ko' }),
      getTvSeasons: async () => ({
        seasons: [
          { seasonNumber: 1, name: 'Season 1', episodeCount: 20 },
          { seasonNumber: 2, name: 'Season 2', episodeCount: 10 }
        ]
      }),
      getTvSeasonEpisodes: async (_id, sNum) => ({
        episodes: Array.from({ length: 10 }, (_, idx) => ({
          seasonNumber: sNum,
          episodeNumber: idx + 1,
          title: `Episode ${idx + 1}`,
          runtimeMinutes: 75,
          runtimeSeconds: 4500
        }))
      }),
      getPlaybackInfo: async () => null
    },
    movieSessions: new MovieSessions({ db }),
    movieResolver: { resolve: async () => ({ ok: false, reason: 'stub' }) },
    movieDownloader: {
      hasCachedVideo: () => true,
      sendSingleVideo: async (_ctx, desc) => { singleDownloads.push(desc); return { ok: true }; },
      deliverAlbumSlidePage: async (_ctx, ms) => { slideCalls.push(ms.dlManifest); return { ok: true }; }
    }
  };
  const qm = new QueueManager({ app, db, voiceClient: { setup: async () => ({}), play: async () => {}, control: async () => {} }, pollMs: 0 });
  app.musicQueueManager = qm;
  app.music = new MusicService({ app, search: new SearchSessions({ providers: {} }), lyrics: {}, accounts: { sync: async () => {} } });
  const screen = createMusicScreen({ app });
  t.after(async () => { await screen.cleanup(); await qm.shutdown(); });

  // 1) DM search with "Alchemy of Souls S02E02" lands straight on standalone S02E02 card & downloads direct MP4 without Slides
  const dmCtx = { api, chatId: 4242, tgId: 4242, user: { id: 4242, first_name: 'Pappy' } };
  await screen.handleCommand(dmCtx, '/movie', ['Alchemy', 'of', 'Souls', 'S02E02']);
  const dmMs = app.movieSessions.getLatestForChat(4242);
  assert.equal(dmMs.view, 'episode');
  assert.equal(dmMs.seasonNumber, 2);
  assert.equal(dmMs.activeEpisode?.episodeNumber, 2);

  // Toggling E2 and tapping dx (1 episode selected) uploads standalone MP4 directly instead of Album Slides
  await screen.handle({ ...dmCtx, query: { id: 'qtg' }, messageId: dmMs.messageId }, 'mv', [dmMs.id, 'tg', '2-2']);
  await screen.handle({ ...dmCtx, query: { id: 'qdx' }, messageId: dmMs.messageId }, 'mv', [dmMs.id, 'dx', '']);
  assert.equal(singleDownloads.length, 1);
  assert.equal(singleDownloads[0].season, 2);
  assert.equal(singleDownloads[0].episode, 2);
  assert.equal(slideCalls.length, 0);

  // Switch back to Season view and verify standalone Detail/MP4 buttons exist in DM mode
  await screen.handle({ ...dmCtx, query: { id: 'qsv' }, messageId: dmMs.messageId }, 'mv', [dmMs.id, 'sv', '']);
  const seasonJson = JSON.stringify(screen.movieUi.renderTvSeason(dmCtx, dmMs));
  assert.match(seasonJson, /E2 Details/);
  assert.match(seasonJson, /MP4 E2/);

  // 2) Permanent Hide Guide toggle in Cinema VC
  const grpId = -1007771;
  const s = qm.getSession(grpId);
  s.connected = true;
  s.status = 'playing';
  s.activeDeck = 'movie';
  s.screenMessageId = 99;
  s.playerChatId = grpId;
  s.api = api;
  s.currentTrack = {
    id: 'mv:135157:2:2',
    provider: 'movie',
    mediaType: 'video',
    title: 'Alchemy of Souls · S02E02',
    artist: '2022 · S02E02 · 1080p',
    originalLanguage: 'ko',
    audioLanguage: 'en',
    audioIsDub: true,
    dubOnlyWarning: '⚠️ Dub Only Available',
    capabilities: { seek: true }
  };

  const beforeCinemaObj = screen.renderCinemaPlayer(s);
  const beforeCinema = JSON.stringify(beforeCinemaObj);
  assert.match(beforeCinema, /𝗖𝗜𝗡𝗘𝗠𝗔 𝗩𝗢𝗜𝗖𝗘 𝗖𝗛𝗔𝗧 𝗚𝗨𝗜𝗗𝗘/);
  assert.match(beforeCinema, /Hide Guide/);
  const qualityRow = beforeCinemaObj.blocks.find((b) => b.type === 'table')?.cells?.find((r) => /Quality/.test(richTextToString(r[0])));
  assert.doesNotMatch(richTextToString(qualityRow?.[1]), /1080p/);

  await screen.handle({ api, chatId: grpId, tgId: 4242, isAdmin: true, user: { id: 4242 }, query: { id: 'qhg' }, messageId: 99 }, 'toggleguide', ['hide']);
  assert.equal(db.getSetting(`music.hideGuide.${grpId}`, false), true);
  const afterHide = JSON.stringify(screen.renderCinemaPlayer(s));
  assert.doesNotMatch(afterHide, /𝗖𝗜𝗡𝗘𝗠𝗔 𝗩𝗢𝗜𝗖𝗘 𝗖𝗛𝗔𝗧 𝗚𝗨𝗜𝗗𝗘/);
  assert.doesNotMatch(afterHide, /Hide Guide/);

  // Can restore from Options or /vcguide show
  const optsJson = JSON.stringify(screen.renderOptions(s));
  assert.match(optsJson, /Guide · Hidden/);
  await screen.handleCommand({ api, chatId: grpId, tgId: 4242, isAdmin: true, user: { id: 4242 } }, '/vcguide', ['show']);
  assert.equal(db.getSetting(`music.hideGuide.${grpId}`, false), false);
});

test('VideoStreamingServer prefers H.264 over H.265/HEVC for 720p Interactive VC playlists', async (t) => {
  const srv = new VideoStreamingServer({ port: 0 });
  const up = createServer((req, res) => {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="hev1.1.6.L93.90"',
      'https://cdn.example.test/720_h265.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.64001f"',
      'https://cdn.example.test/720_avc.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
      'https://cdn.example.test/1080_avc.m3u8'
    ].join('\n'));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  await srv.start();
  t.after(async () => {
    await srv.stop();
    await new Promise((r) => up.close(r));
  });
  const port = up.address().port;
  const proxyUrl = srv.registerRemoteStream({
    url: `http://127.0.0.1:${port}/master.m3u8`,
    isHls: true,
    maxHeight: 1080,
    videoQuality: 'HD_720p',
    preferH264: true
  });
  const txt = await (await fetch(proxyUrl)).text();
  assert.match(txt, /1280x720/);
  assert.match(txt, /avc1\.64001f/);
  assert.doesNotMatch(txt, /hev1/);
  assert.doesNotMatch(txt, /1920x1080/);
});

test('NLU & AI tools handle hide/show guide, inline S02E02 search, and default to Qwen2.5-7B', async () => {
  const hideStep = parseDeskIntents('hide the vc guide permanently');
  assert.deepEqual(hideStep, [{ name: 'control_playback', args: { action: 'hide_guide' } }]);
  const showStep = parseDeskIntents('show guide');
  assert.deepEqual(showStep, [{ name: 'control_playback', args: { action: 'show_guide' } }]);

  const ollama = new OllamaProvider();
  assert.equal(ollama.model, 'qwen2.5:7b');

  let resolvedDesc = null;
  const exec = new LancyToolExecutor({
    app: {
      movieApi: { search: async (q) => [{ id: 135157, type: 'tv', title: q }] },
      movieResolver: { resolve: async (d) => { resolvedDesc = d; return { track: { title: `${d.title} S02E02` } }; } },
      musicQueueManager: {
        sessions: new Map(),
        getSession: () => ({ upcoming: [], movieUpcoming: [] }),
        addMovies: async () => {}
      }
    }
  });
  const out = await exec.execute('search_movies_series', { query: 'Alchemy of Souls S02E02', action: 'play_now' }, { chatId: -1001 });
  assert.equal(out.ok, true);
  assert.equal(resolvedDesc.season, 2);
  assert.equal(resolvedDesc.episode, 2);
});
