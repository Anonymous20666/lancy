import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { SearchSessions } from '../src/music/search.js';
import { PANEL_ACTIONS } from '../src/music/channelPanels.js';
import { MovieApiClient, normalizeSeasonsList } from '../src/media/movieApi.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { MovieDownloader } from '../src/media/movieDownloader.js';
import { SubtitleService, parseSrt, getCueAt, shiftSrtText } from '../src/media/subtitles.js';
import { MovieStreamResolver } from '../src/media/movieResolver.js';
import { VideoStreamingServer } from '../src/media/streamingServer.js';
import { MediaAiAgent } from '../src/ai/mediaAgent.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { TelegramController } from '../src/telegram/bot.js';
import { decodeCallback, richTextToString } from '../src/telegram/rich.js';

function createMockMovieFixture() {
  const sampleTv = {
    provider_id: '1396',
    type: 'tv',
    title: 'Breaking Bad',
    year: 2008,
    overview: 'A chemistry teacher diagnosed with inoperable lung cancer turns to manufacturing.',
    poster: 'https://image.tmdb.org/t/p/w500/bb.jpg',
    rating: 9.5,
    genres: ['Drama', 'Crime']
  };
  const sampleMovie = {
    provider_id: '27205',
    type: 'movie',
    title: 'Inception',
    year: 2010,
    overview: 'A thief who steals corporate secrets through dream-sharing technology.',
    poster: 'https://image.tmdb.org/t/p/w500/inc.jpg',
    rating: 8.8,
    genres: ['Sci-Fi', 'Action']
  };
  const s1Episodes = Array.from({ length: 10 }, (_, i) => ({
    series_id: '1396',
    season_number: 1,
    episode_number: i + 1,
    title: `S1 Ep ${i + 1}`,
    runtime: 47,
    overview: `Season 1 Episode ${i + 1} plot`,
    still: 'https://image.tmdb.org/t/p/w500/ep.jpg'
  }));
  const s2Episodes = Array.from({ length: 8 }, (_, i) => ({
    series_id: '1396',
    season_number: 2,
    episode_number: i + 1,
    title: `S2 Ep ${i + 1}`,
    runtime: 48
  }));

  const fetchImpl = async (urlStr) => {
    const u = new URL(urlStr);
    const p = u.pathname;
    if (p.endsWith('/search')) {
      return { ok: true, json: async () => ({ query: u.searchParams.get('q'), count: 2, results: [sampleTv, sampleMovie] }) };
    }
    if (p.endsWith('/trending')) {
      return { ok: true, json: async () => ({ results: [sampleMovie, sampleTv] }) };
    }
    if (p.endsWith('/categories')) {
      return { ok: true, json: async () => ({ categories: [{ id: 'hollywood', name: 'Hollywood' }, { id: '28', name: 'Action', genreId: 28 }] }) };
    }
    if (p.endsWith('/browse')) {
      return { ok: true, json: async () => ({ page: 1, results: [sampleMovie] }) };
    }
    if (p.endsWith('/tv/1396')) {
      return {
        ok: true,
        json: async () => ({
          ...sampleTv,
          seasons: [
            { season_number: 0, name: 'Specials', episode_count: 2 },
            { season_number: 2, name: 'Season 2', episode_count: 8 },
            { season_number: 1, name: 'Season 1', episode_count: 10 }
          ]
        })
      };
    }
    if (p.endsWith('/tv/1396/seasons')) {
      return {
        ok: true,
        json: async () => ({
          series_id: '1396',
          title: 'Breaking Bad',
          seasons: [
            { season_number: 0, name: 'Specials', episode_count: 2 },
            { season_number: 1, name: 'Season 1', episode_count: 10 },
            { season_number: 2, name: 'Season 2', episode_count: 8 }
          ]
        })
      };
    }
    if (p.endsWith('/tv/1396/season/1')) {
      return { ok: true, json: async () => ({ series_id: '1396', season_number: 1, episodes: s1Episodes }) };
    }
    if (p.endsWith('/tv/1396/season/2')) {
      return { ok: true, json: async () => ({ series_id: '1396', season_number: 2, episodes: s2Episodes }) };
    }
    if (p.endsWith('/movie/27205')) {
      return { ok: true, json: async () => ({ ...sampleMovie, runtime: 148, imdb_id: 'tt1375666' }) };
    }
    if (p.includes('/playback/')) {
      return {
        ok: true,
        json: async () => ({
          available: true,
          webapp_player_url: `https://pappy-hosting.duckdns.org/media/api/v1/movies/player?id=1396`,
          root_stream: { direct_url: 'https://blocked.example/403.m3u8' }
        })
      };
    }
    return { ok: false, status: 404, text: async () => 'Not found' };
  };

  return { fetchImpl, sampleTv, sampleMovie, s1Episodes, s2Episodes };
}

function buildTestHarness(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const { fetchImpl } = createMockMovieFixture();
  const movieApi = new MovieApiClient({ baseUrl: 'https://example.test/api', fetchImpl });
  const movieSessions = new MovieSessions();
  const subDir = mkdtempSync(join(tmpdir(), 'lancy-subs-'));
  const dummyAudioPath = join(subDir, 'fixture.mp3');
  writeFileSync(dummyAudioPath, 'ID3');
  const subtitles = new SubtitleService({ cacheDir: subDir, fetchImpl: async () => ({ ok: false, status: 404 }) });

  const sentMessages = [];
  const editedMessages = [];
  const callbackAnswers = [];
  let nextMsgId = 100;

  const voiceCalls = { play: [], setSubtitle: [] };
  const voiceClient = {
    play: async (chatId, source, opts = {}) => {
      voiceCalls.play.push({ chatId, source, opts });
      return { ok: true, account_alias: 'acc1' };
    },
    stop: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    setVolume: async (_id, vol) => ({ ok: true, volume: vol }),
    setSubtitle: async (id, subtitlePath) => {
      voiceCalls.setSubtitle.push({ id, subtitlePath });
      return { ok: true };
    },
    getStatus: async () => ({ ok: true, active: false })
  };

  const api = {
    me: { id: 999, username: 'LancyBot' },
    getChat: async (chatId) => ({ id: chatId, type: chatId < 0 ? 'supergroup' : 'private', title: 'Test Chat' }),
    getChatMember: async () => ({ status: 'administrator', can_manage_voice_chats: true, can_post_messages: true, can_edit_messages: true }),
    sendMessage: async (chatId, text, extra = {}) => {
      const m = { message_id: nextMsgId++, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, text, ...extra };
      sentMessages.push(m);
      return m;
    },
    sendRichMessage: async (chatId, rich) => {
      const m = { message_id: nextMsgId++, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, rich };
      sentMessages.push(m);
      return m;
    },
    editMessageRich: async (chatId, messageId, rich) => {
      const m = { message_id: messageId, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, rich };
      editedMessages.push(m);
      return m;
    },
    answerCallbackQuery: async (id, opts = {}) => {
      callbackAnswers.push({ id, ...opts });
      return true;
    },
    deleteMessage: async () => true
  };

  const app = {
    db,
    sm: new StateMachine(),
    settings: { get: (k) => (k === 'general.ownerIds' ? [10] : []) },
    movieApi,
    movieSessions,
    subtitles,
    voiceClient,
    telegram: { api },
    musicLibrary: {
      acquire: async (track) => {
        const filePath = track.filePath || dummyAudioPath;
        return { filePath, source: 'fixture', track: { ...track, filePath }, release: () => {} };
      },
      warm: async () => null
    }
  };

  app.movieResolver = new MovieStreamResolver({
    movieApi,
    subtitles,
    fetchImpl: async () => ({ ok: false, status: 403 }), // simulate 403 on root_stream -> no bypass!
    thenkiri: {
      thenkiriSearch: async (q) => ({
        results: [{ title: /breaking/i.test(q) ? 'Breaking Bad TV Series' : 'Inception (2010) Hollywood Movie', url: 'https://thenkiri.example/item' }]
      }),
      thenkiriDetails: async () => ({
        sources: [
          { title: 'Trailer Only', label: 'Trailer', url: 'https://thenkiri.example/trailer.mp4' },
          { title: 'Breaking Bad S01E01', seasonNumber: 1, episodeNumber: 1, label: 'Download Episode 1', url: 'https://downloadwella.com/bb-s01e01' },
          { title: 'Breaking Bad S01E02', seasonNumber: 1, episodeNumber: 2, label: 'Download Episode 2', url: 'https://downloadwella.com/bb-s01e02' },
          { title: 'Breaking Bad S02E03', seasonNumber: 2, episodeNumber: 3, label: 'Download Episode 3', url: 'https://downloadwella.com/bb-s02e03' },
          { title: 'Inception (2010) Full Movie', label: 'Download Movie', url: 'https://downloadwella.com/inception' }
        ]
      }),
      thenkiriGetLink: async (srcUrl) => ({
        url: `${srcUrl}/direct.mkv`,
        headers: { Referer: 'https://downloadwella.com/' },
        format: 'mkv'
      })
    }
  });

  app.videoServer = {
    registerRemoteStream: ({ url }) => `http://127.0.0.1:3055/movie-proxy/${Buffer.from(url).toString('hex').slice(0, 10)}`
  };

  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: new SearchSessions({ providers: {} }), lyrics: {}, accounts: { sync: async () => {} } });
  app.music = service;
  app.mediaAgent = new MediaAiAgent({ app });
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  screen.registerStateHandlers(app.sm);

  t.after(async () => {
    await screen.cleanup();
    await qm.shutdown();
  });

  const makeCtx = (chatId = -10050, overrides = {}) => ({
    api,
    chatId,
    tgId: 10,
    user: { id: 10, first_name: 'Owner' },
    query: null,
    messageId: null,
    isChannel: overrides.isChannel ?? false,
    ...overrides
  });

  return { app, qm, service, screen, api, sentMessages, editedMessages, callbackAnswers, voiceCalls, makeCtx, subDir };
}

test('MovieApiClient normalizes Season 1..N before Specials (0) & returns search/details', async () => {
  const { fetchImpl } = createMockMovieFixture();
  const api = new MovieApiClient({ baseUrl: 'https://example.test/api', fetchImpl });

  const ordered = normalizeSeasonsList([
    { season_number: 0, name: 'Specials', episode_count: 2 },
    { season_number: 3, name: 'Season 3', episode_count: 13 },
    { season_number: 1, name: 'Season 1', episode_count: 7 }
  ]);
  assert.deepEqual(ordered.map((s) => s.seasonNumber), [1, 3, 0]);

  const search = await api.search('Breaking Bad');
  assert.equal(search.results[0].type, 'tv');
  assert.equal(search.results[0].id, '1396');

  const tv = await api.getTvShow('1396');
  assert.deepEqual(tv.seasons.map((s) => s.seasonNumber), [1, 2, 0]);

  const eps = await api.getTvSeasonEpisodes('1396', 1);
  assert.equal(eps.episodes.length, 10);
});

test('Movie UI opens Season 1 first with Bot API 10.3 checklists, multi-season switches cleanly without losing picks, and all callbacks <= 64B', async (t) => {
  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);

  // 1. Open /movie search -> renders results
  await h.screen.handleCommand(ctx, '/movie', ['Breaking', 'Bad']);
  const searchCard = h.sentMessages.at(-1).rich;
  assert.match(JSON.stringify(searchCard), /Breaking Bad/);

  // Pick Breaking Bad (index 0) -> MUST edit card in-place and show Season 1 first (page 1 of 2, 6 checkboxes)
  const latest = h.app.movieSessions.getLatestForChat(-10050);
  await h.screen.handle({ ...ctx, query: { id: 'q1' }, messageId: latest.messageId }, 'mv', [latest.id, 'pk', '0']);
  assert.equal(latest.view, 'season');
  assert.equal(latest.seasonNumber, 1);

  const s1Card = h.editedMessages.at(-1).rich;
  const checklist = s1Card.blocks.find((b) => b.type === 'list');
  assert.ok(checklist, 'Must use Bot API 10.3 list block with checkboxes');
  assert.equal(checklist.items.length, 6);
  assert.ok(checklist.items.every((it) => it.is_checked === false));
  // Verify zero WebApp / web_app buttons and all callbacks <= 64B
  const allBtns = s1Card.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  for (const btn of allBtns) {
    if (btn.callback_data) assert.ok(Buffer.byteLength(btn.callback_data) <= 64, `Callback > 64B: ${btn.callback_data}`);
    assert.ok(!btn.web_app, 'Must not include web_app button');
    assert.ok(!/WebApp/i.test(richTextToString(btn.text)), 'Must not include WebApp button label');
  }

  // 2. Toggle E1 one-by-one, then Select Page (6 episodes) -> updates checked checkboxes
  await h.screen.handle({ ...ctx, query: { id: 'q2' }, messageId: latest.messageId }, 'mv', [latest.id, 'tg', '1-1']);
  assert.equal(h.editedMessages.at(-1).rich.blocks.find((b) => b.type === 'list').items[0].is_checked, true);
  await h.screen.handle({ ...ctx, query: { id: 'q3' }, messageId: latest.messageId }, 'mv', [latest.id, 'sp', '0']);
  const checkedAfterSp = h.editedMessages.at(-1).rich.blocks.find((b) => b.type === 'list').items.every((it) => it.is_checked === true);
  assert.equal(checkedAfterSp, true);
  assert.equal(h.app.movieSessions.totalSelectedCount(latest), 6);

  // Clear, then Select All in Season 1 (all 10 episodes), verify total = 10
  await h.screen.handle({ ...ctx, query: { id: 'q4' }, messageId: latest.messageId }, 'mv', [latest.id, 'cl', '']);
  assert.equal(h.app.movieSessions.totalSelectedCount(latest), 0);
  await h.screen.handle({ ...ctx, query: { id: 'q5' }, messageId: latest.messageId }, 'mv', [latest.id, 'sa', '1']);
  assert.equal(h.app.movieSessions.totalSelectedCount(latest), 10);

  // 3. Open Season Picker (📚 Seasons), switch to Season 2, pick S2E3 while KEEPING Season 1 selections!
  await h.screen.handle({ ...ctx, query: { id: 'q6' }, messageId: latest.messageId }, 'mv', [latest.id, 'ss', '0']);
  assert.equal(latest.view, 'seasons');
  await h.screen.handle({ ...ctx, query: { id: 'q7' }, messageId: latest.messageId }, 'mv', [latest.id, 'so', '2']);
  assert.equal(latest.seasonNumber, 2);
  await h.screen.handle({ ...ctx, query: { id: 'q8' }, messageId: latest.messageId }, 'mv', [latest.id, 'tg', '2-3']);
  assert.equal(h.app.movieSessions.totalSelectedCount(latest), 11);

  const orderedSelection = h.app.movieSessions.getSelectedEpisodes(latest, latest.episodeCache);
  assert.equal(orderedSelection.length, 11);
  assert.equal(orderedSelection[0].seasonNumber, 1);
  assert.equal(orderedSelection[0].episodeNumber, 1);
  assert.equal(orderedSelection[10].seasonNumber, 2);
  assert.equal(orderedSelection[10].episodeNumber, 3);

  // 4. Verify Private DM Movie Detail has zero WebApp buttons & PANEL_ACTIONS includes movie + Cinema actions
  const dmCtx = h.makeCtx(10, { isChannel: false });
  const dmMs = h.app.movieSessions.create({ chatId: 10, userId: 10, view: 'movie' });
  dmMs.mediaItem = { id: '27205', type: 'movie', title: 'Inception', year: 2010 };
  dmMs.playback = { webappPlayerUrl: 'https://pappy-hosting.duckdns.org/media/api/v1/movies/player?id=27205' };
  const dmMovieCard = h.screen.movieUi.renderMovieDetail(dmCtx, dmMs);
  const dmBtns = dmMovieCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.equal(dmBtns.some((b) => Boolean(b.web_app) || /WebApp/i.test(richTextToString(b.text))), false);
  assert.equal(PANEL_ACTIONS.includes('submode'), true);
  assert.equal(PANEL_ACTIONS.includes('movie'), true);
  assert.equal(PANEL_ACTIONS.includes('mqueue'), true);
  assert.equal(PANEL_ACTIONS.includes('switchdeck'), true);
});

test('MovieStreamResolver enforces zero trailers (returns unavailable when only 403/trailer exists) & resolves direct full stream cleanly', async () => {
  const { fetchImpl } = createMockMovieFixture();
  const movieApi = new MovieApiClient({ baseUrl: 'https://example.test/api', fetchImpl });

  const resolverWithTrailerOnly = new MovieStreamResolver({
    movieApi,
    fetchImpl: async () => ({ ok: false, status: 403 }),
    thenkiri: {
      thenkiriSearch: async () => ({ results: [{ title: 'Inception (2010) Trailer Only', url: 'https://t.example/trailer' }] }),
      thenkiriDetails: async () => ({ sources: [{ label: 'Official Trailer', url: 'https://t.example/trailer.mp4' }] }),
      thenkiriGetLink: async () => null
    }
  });
  const logsFail = [];
  const failRes = await resolverWithTrailerOnly.resolve({ type: 'movie', id: '27205', title: 'Inception', year: 2010, fetchSubtitles: false, onProgress: (m) => logsFail.push(m) });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.track, null);
  assert.equal(failRes.webappUrl, null);
  assert.ok(logsFail.length >= 3, 'Should emit multi-stage live resolution log lines');

  // Test multi-source Archive.org fallback & yt-dlp trailer guard
  const resolverArchive = new MovieStreamResolver({
    movieApi,
    fetchImpl: async (url) => {
      if (String(url).includes('archive.org/advancedsearch')) {
        return {
          ok: true,
          json: async () => ({
            response: {
              docs: [
                { identifier: 'InceptionTrailer', title: 'Inception Trailer' },
                { identifier: 'InceptionFull2010', title: 'Inception (2010) Feature', year: 2010 }
              ]
            }
          })
        };
      }
      if (String(url).includes('archive.org/metadata/InceptionFull2010')) {
        return {
          ok: true,
          json: async () => ({
            metadata: { title: 'Inception (2010)' },
            files: [
              { name: 'inception_trailer.mp4', length: '120', size: String(10e6) },
              { name: 'inception_720p.mp4', length: '8880', size: String(900e6) }
            ]
          })
        };
      }
      if (String(url).includes('archive.org/download/InceptionFull2010/inception_720p.mp4')) {
        return { ok: true, status: 206, headers: { get: () => 'video/mp4' } };
      }
      return { ok: false, status: 403 };
    },
    thenkiri: { thenkiriSearch: async () => ({ results: [] }), thenkiriDetails: async () => ({ sources: [] }), thenkiriGetLink: async () => null }
  });
  const archLogs = [];
  const archRes = await resolverArchive.resolve({ type: 'movie', id: '27205', title: 'Inception', year: 2010, fetchSubtitles: false, onProgress: (m) => archLogs.push(m) });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.source, 'archive_org');
  assert.match(archRes.track.streamUrl, /inception_720p\.mp4/);
  assert.ok(archLogs.some((l) => /\[4\/5\].*(?:Searching|Full-feature stream ready)/i.test(l)));
  const leakedSourceRe = /\b(HolaFlix|TheNkiri|DownloadWella|Internet Archive|WebArchive|DramaFren|OK\.ru|LRCLIB)\b/i;
  assert.equal(archLogs.some((l) => leakedSourceRe.test(l)), false, 'Live logs must never expose upstream source names');
  assert.equal(leakedSourceRe.test(archRes.track.artist || ''), false, 'Movie track metadata must never expose upstream source names');

  // Test yt-dlp full-movie search guard (rejects trailers/shorts, accepts full runtime >= 2100s)
  const resolverYt = new MovieStreamResolver({
    movieApi,
    fetchImpl: async () => ({ ok: false, status: 403 }),
    thenkiri: { thenkiriSearch: async () => ({ results: [] }), thenkiriDetails: async () => ({ sources: [] }), thenkiriGetLink: async () => null },
    ytSearchFn: async () => ([
      { title: 'Inception (2010) Official Trailer', duration: 3000, directStreamUrl: 'https://cdn.example/trailer.mp4' },
      { title: 'Inception (2010) Full Movie Clip', duration: 240, directStreamUrl: 'https://cdn.example/short.mp4' },
      { title: 'Inception (2010) Full Feature Film HD', duration: 8800, directStreamUrl: 'https://cdn.example/full_inception.mp4', qualityLabel: '720p' }
    ])
  });
  const ytRes = await resolverYt.resolve({ type: 'movie', id: '27205', title: 'Inception', year: 2010, fetchSubtitles: false });
  assert.equal(ytRes.ok, true);
  assert.equal(ytRes.track.streamUrl, 'https://cdn.example/full_inception.mp4');
  assert.equal(ytRes.track.durationSeconds, 8800);

  const resolverSuccess = new MovieStreamResolver({
    movieApi,
    fetchImpl: async () => ({ ok: false, status: 403 }),
    thenkiri: {
      thenkiriSearch: async () => ({ results: [{ title: 'Breaking Bad (2008) TV Series', url: 'https://t.example/bb' }] }),
      thenkiriDetails: async () => ({
        sources: [
          { title: 'S01E01', seasonNumber: 1, episodeNumber: 1, label: 'Episode 1', url: 'https://downloadwella.com/bb-s01e01' }
        ]
      }),
      thenkiriGetLink: async () => ({ url: 'https://cdn.example/BrBa.S01E01.mkv', headers: { Referer: 'https://downloadwella.com/' }, format: 'mkv' })
    }
  });
  const okRes = await resolverSuccess.resolve({
    type: 'tv',
    id: '1396',
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: 'Pilot',
    durationSeconds: 3480,
    fetchSubtitles: false
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.track.provider, 'movie');
  assert.equal(okRes.track.streamUrl, 'https://cdn.example/BrBa.S01E01.mkv');
  assert.equal(okRes.track.durationSeconds, 3480);
});

test('SubtitleService parses, binary-searches cues, shifts SRT on seek, and extracts gzipped OpenSubtitles files', async () => {
  const sampleSrt = [
    '1',
    '00:00:10,000 --> 00:00:14,500',
    'Say my name.',
    '',
    '2',
    '00:02:05,000 --> 00:02:09,000',
    'You are Heisenberg.'
  ].join('\n');

  const cues = parseSrt(sampleSrt);
  assert.equal(cues.length, 2);
  assert.equal(getCueAt(cues, 12000)?.text, 'Say my name.');
  assert.equal(getCueAt(cues, 60000), null);

  const shifted = shiftSrtText(sampleSrt, 120);
  const shiftedCues = parseSrt(shifted);
  assert.equal(shiftedCues.length, 1);
  assert.equal(shiftedCues[0].text, 'You are Heisenberg.');
  assert.equal(shiftedCues[0].startMs, 5000);

  const fullSrt = Array.from({ length: 12 }, (_, i) => {
    const startSec = 10 + i * 10;
    const endSec = startSec + 4;
    const fmt = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    return `${i + 1}\n${fmt(startSec)} --> ${fmt(endSec)}\nLine ${i + 1}`;
  }).join('\n\n');
  const dir = mkdtempSync(join(tmpdir(), 'lancy-sub-dl-'));
  const gzBytes = gzipSync(Buffer.from(fullSrt, 'utf8'));
  const subSvc = new SubtitleService({
    cacheDir: dir,
    fetchImpl: async (u) => {
      if (String(u).includes('rest.opensubtitles.org')) {
        return {
          ok: true,
          json: async () => [{
            SubFileName: 'Breaking.Bad.S01E01.srt',
            SubFormat: 'srt',
            SubDownloadLink: 'https://dl.opensubtitles.org/123.srt.gz',
            LanguageName: 'English',
            Score: 10
          }]
        };
      }
      return { ok: true, arrayBuffer: async () => gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength) };
    }
  });
  const res = await subSvc.resolveForMedia({ title: 'Breaking Bad', season: 1, episode: 1 });
  assert.equal(res.found, true);
  assert.equal(res.cues.length, 12);
  assert.equal(subSvc.loadCues(res.filePath).length, 12);
});

test('StreamingServer proxies progressive HTTP Range requests cleanly via /movie-proxy/:token', async (t) => {
  const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const upstream = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : payload.length - 1;
      const chunk = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'video/x-matroska',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': chunk.length
      });
      return res.end(chunk);
    }
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': payload.length });
    return res.end(payload);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const srv = new VideoStreamingServer({ port: 0, cacheDir: mkdtempSync(join(tmpdir(), 'lancy-vc-')), audioCacheDir: mkdtempSync(join(tmpdir(), 'lancy-ac-')) });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    await new Promise((r) => upstream.close(r));
  });

  const proxyUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${upPort}/movie.mkv`, contentType: 'video/x-matroska' });
  const r = await fetch(proxyUrl, { headers: { Range: 'bytes=10-15' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'ABCDEF');
});

test('Music & Cinema queues/cards remain strictly isolated, live loading log streams during UI play, and Cinema queue pagination & live subtitles work cleanly', async (t) => {
  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);

  // Create real .srt subtitle file for live subtitle tick test
  const srtFile = join(h.subDir, 'movie.srt');
  writeFileSync(srtFile, '1\n00:00:05,000 --> 00:00:15,000\nLive subtitle line one!\n');

  const mk = (id, title, extra = {}) => ({ id: `t:${id}`, provider: 'audius', providerId: String(id), title, artist: 'Artist', durationSeconds: 200, ...extra });
  const mkMovie = (id, title, extra = {}) => ({
    id: `mv:${id}`,
    provider: 'movie',
    providerId: String(id),
    title,
    artist: 'Web Cinema · 720p',
    mediaType: 'video',
    streamUrl: `https://cdn.example/${id}.mkv`,
    durationSeconds: 3200,
    capabilities: { stream: true, seek: true, video: true },
    ...extra
  });
  const session = h.qm.getSession(-10050);
  session.prepared = true;

  // 1. Start Music A with C, D in Music Queue -> Play Now on Music B keeps B -> C -> D -> A strictly in Music upcoming
  await h.qm.addMany(-10050, [mk('A', 'Track A'), mk('C', 'Track C'), mk('D', 'Track D')]);
  assert.equal(session.activeDeck, 'music');
  assert.equal(session.currentTrack.title, 'Track A');
  assert.deepEqual(session.upcoming.map((x) => x.title), ['Track C', 'Track D']);

  await h.qm.playImmediateAndContinue(-10050, mk('B', 'Track B'));
  assert.equal(session.currentTrack.title, 'Track B');
  assert.deepEqual(session.upcoming.map((x) => x.title), ['Track C', 'Track D', 'Track A']);

  // 2. Starting Movie M1 switches to isolated Cinema Deck:
  //    - Music Track B stays preserved in Music `s.upcoming` (NOT ported into `movieUpcoming`)
  //    - Cinema Player card NEVER renders Spotify X / Lyrics / Bass / EQ / AI DJ / Music queue!
  await h.qm.addMovies(-10050, [
    mkMovie('m1', 'Inception (2010)', { subtitlePath: srtFile }),
    mkMovie('m2', 'Interstellar (2014)')
  ], { playNow: true });
  assert.equal(session.activeDeck, 'movie');
  assert.equal(session.view, 'cinema');
  assert.equal(session.currentTrack.title, 'Inception (2010)');
  assert.deepEqual(session.movieUpcoming.map((x) => x.title), ['Interstellar (2014)']);
  assert.deepEqual(session.upcoming.map((x) => x.title), ['Track B', 'Track C', 'Track D', 'Track A']);

  await h.service.player(ctx, -10050);
  const cinemaCard = h.screen.renderPlayer(session);
  const cinemaJson = JSON.stringify(cinemaCard);
  assert.match(cinemaJson, /LANCY MUSIC · CINEMA VC/);
  assert.match(cinemaJson, /Lancy Music \(@LancyBot\)/);
  assert.match(cinemaJson, /Inception \(2010\)/);
  assert.doesNotMatch(cinemaJson, /Spotify|Lyrics|Bass|AI DJ|Infinite|WebApp|Web Cinema|HolaFlix|TheNkiri|DownloadWella|Internet Archive|DramaFren/i);
  assert.equal(cinemaCard.blocks.some((b) => b.type === 'table' && b.rows?.some((r) => /Source/i.test(String(r[0])))), false, 'Cinema card must not show a Source row');

  // 3. Subtitle toggling on Cinema Card ('screen' -> 'live') + live cue tick
  assert.equal(session.subtitleMode, 'screen');
  const subBtn = cinemaCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons).find((b) => richTextToString(b.text).includes('Screen Burn') || richTextToString(b.text).includes('Subs'));
  const subDecoded = decodeCallback(subBtn.callback_data);
  await h.screen.handle({ ...ctx, query: { id: 'qsub' }, messageId: session.screenMessageId }, subDecoded.action, subDecoded.args);
  assert.equal(session.subtitleMode, 'live');
  assert.equal(h.voiceCalls.setSubtitle.at(-1)?.subtitlePath, null);

  let emittedCue = null;
  h.qm.once('subtitle_cue', (ev) => { emittedCue = ev; });
  h.app.voiceClient.getStatus = async () => ({
    ok: true,
    active: true,
    info: { playback_id: session.playbackId, status: 'playing', position_seconds: 8, volume: 100 }
  });
  await h.qm.reconcile();
  assert.equal(emittedCue?.cue, 'Live subtitle line one!');
  assert.match(JSON.stringify(h.screen.renderCinemaPlayer(session)), /Live subtitle line one!/);

  // 4. When all movies finish, Cinema goes idle WITHOUT pulling Music tracks from s.upcoming!
  await h.qm.handleStreamEnded(-10050, session.playbackId);
  assert.equal(session.currentTrack.title, 'Interstellar (2014)');
  await h.qm.handleStreamEnded(-10050, session.playbackId);
  assert.equal(session.currentTrack, null);
  assert.equal(session.activeDeck, 'movie');
  assert.equal(session.upcoming.length, 4); // Music queue untouched!

  // 5. Switch deck back to Music -> resumes Track B, C, D, A cleanly!
  await h.qm.switchDeck(-10050, 'music');
  assert.equal(session.activeDeck, 'music');
  assert.equal(session.currentTrack.title, 'Track B');
  await h.qm.handleStreamEnded(-10050, session.playbackId);
  assert.equal(session.currentTrack.title, 'Track C');

  // 6. Verify BOTH Music Queue pagination & Cinema Queue pagination cleanly (12 items -> Page 2 of 3)
  for (let i = 1; i <= 12; i++) h.qm.enqueue(-10050, mk(`p${i}`, `Song ${i}`));
  const qPage1 = h.screen.renderQueue(session, 1);
  assert.match(JSON.stringify(qPage1), /Page 2 of 3/);
  assert.match(JSON.stringify(qPage1), /Song 6/);

  for (let i = 1; i <= 12; i++) h.qm.enqueueMovie(-10050, mkMovie(`e${i}`, `Episode ${i}`));
  const mvPage1 = h.screen.renderMovieQueue(session, 1);
  assert.match(JSON.stringify(mvPage1), /CINEMA QUEUE/);
  assert.match(JSON.stringify(mvPage1), /Page 2\/3/);
  assert.match(JSON.stringify(mvPage1), /Episode 6/);

  // 7. Stream a movie from Movie Detail UI (`mv:pm`) -> emits Live Cinema Log blockquote while loading
  await h.screen.handleCommand(ctx, '/movie', ['Inception']);
  const mvSess = h.app.movieSessions.getLatestForChat(-10050);
  const incIdx = mvSess.results.findIndex((r) => String(r.id) === '27205');
  assert.ok(incIdx >= 0);
  await h.screen.handle({ ...ctx, query: { id: 'qpk' }, messageId: mvSess.messageId }, 'mv', [mvSess.id, 'pk', String(incIdx)]);
  const editsBeforeStream = h.editedMessages.length;
  await h.screen.handle({ ...ctx, query: { id: 'qpm' }, messageId: mvSess.messageId }, 'mv', [mvSess.id, 'pm', '']);
  const streamEdits = h.editedMessages.slice(editsBeforeStream).map((e) => JSON.stringify(e.rich));
  assert.ok(streamEdits.some((json) => json.includes('Live Cinema Log')), 'Loading movie must emit live resolution log updates');
  assert.equal(streamEdits.some((json) => /WebApp/i.test(json)), false, 'Live loading card must have zero WebApp copy/buttons');
  assert.equal(
    streamEdits.some((json) => /\b(HolaFlix|TheNkiri|DownloadWella|Internet Archive|DramaFren|Source locked)\b/i.test(json)),
    false,
    'Live Cinema Log must never expose upstream source names'
  );

  // 8. Verify Music VC Player, Search & Lyrics cards never expose Source / provider names
  await h.qm.switchDeck(-10050, 'music');
  const musicPlayerJson = JSON.stringify(h.screen.renderMusicPlayer(session));
  assert.doesNotMatch(musicPlayerJson, /"Source"|\baudius\b|\byoutube\b/i);
  const searchCardJson = JSON.stringify(h.screen.renderSearch({
    query: 'Test Query',
    mode: 'queue',
    destination: -10050,
    destinationTitle: 'Test',
    id: 'sid',
    revision: 1,
    index: 0,
    pages: [{ provider: 'audius', items: [mk('s1', 'Track One')], nextOffset: null }],
    selected: new Map()
  }));
  assert.doesNotMatch(searchCardJson, /\baudius\b|\byoutube\b/i);
  const lyricsCardJson = JSON.stringify(h.screen.renderLyrics({
    lyrics: { found: true, title: 'Track One', artist: 'Artist', text: 'Lyrics line', source: 'LRCLIB' },
    lyricsPage: 0
  }));
  assert.doesNotMatch(lyricsCardJson, /\bLRCLIB\b/i);
});

test('MediaAiAgent supports multi-turn Movie & Song conversation, triggers movie search/random pick, and concludes cleanly', async (t) => {
  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);

  // Enter interactive AI Chat state
  await h.screen.handleCommand(ctx, '/movieai', []);
  assert.equal(h.app.sm.state(10), States.AI_MEDIA_CHAT);

  // Turn 1: User asks for a movie title -> detects search_movie action and opens Results card
  const promptId = h.sentMessages.at(-1).message_id;
  await h.app.sm.handleMessage(10, { text: 'find movie Inception', reply_to_message: { message_id: promptId, from: { id: 999 } } }, ctx);
  assert.match(JSON.stringify(h.sentMessages.at(-1).rich), /Inception/);

  // Turn 2: Start fresh AI session, ask for random movie -> opens pick directly, then say "done" -> concludes!
  const resRand = await h.app.mediaAgent.chat({ ctx, chatId: -10050, userId: 10, text: 'give me a random thriller movie', defaultDomain: 'movie' });
  assert.equal(resRand.action?.name, 'random_movie');
  assert.equal(resRand.concluded, false);

  const resDone = await h.app.mediaAgent.chat({ ctx, chatId: -10050, userId: 10, text: "that's all thanks, done!" });
  assert.equal(resDone.action?.name, 'conclude');
  assert.equal(resDone.concluded, true);
  assert.equal(h.app.mediaAgent.getHistory(-10050, 10).length, 0);
});

test('DM Channel Panel routes pc -> movie -> mv -> Back to Player & Cinema Queue cleanly with zero WebApp buttons', async (t) => {
  const h = buildTestHarness(t);
  h.api.me = { id: 999, username: 'LancyBot' };
  h.api.getChat = async (id) => ({ id, type: Number(id) === -10011 ? 'channel' : 'private', title: 'Movie Channel' });
  h.api.getChatMember = async () => ({ status: 'administrator', can_post_messages: true });

  const chanSession = h.qm.getSession(-10011);
  chanSession.isChannel = true;
  chanSession.title = 'Movie Channel';

  const dmCtx = h.makeCtx(10, { isChannel: false });
  const panel = await h.app.music.channelPanels.open(dmCtx, chanSession);
  assert.ok(panel?.panelToken);

  // 1. Click Movie Stream on Channel Panel via `pc`
  const movieWire = PANEL_ACTIONS.indexOf('movie').toString(36);
  const pcCtx = { ...dmCtx, messageId: panel.screenMessageId, query: { id: 'q-pc-mv', message: { message_id: panel.screenMessageId, chat: { id: 10 } } } };
  await h.screen.handle(pcCtx, 'pc', [panel.panelToken, movieWire, 'hub', '0']);
  const ms = h.app.movieSessions.getLatestForChat(10);
  assert.ok(ms);
  assert.equal(ms.panelToken, panel.panelToken);
  assert.equal(ms.destination, -10011);

  // Hub Back to Player button must route via `pc` back to Channel Panel player
  const hubRich = h.editedMessages.at(-1).rich;
  const backBtn = hubRich.blocks.filter(b => b.type === 'buttons').flatMap(b => b.buttons)
    .find(b => /Back to Player/.test(richTextToString(b.text)));
  assert.ok(backBtn);
  const backDecoded = decodeCallback(backBtn.callback_data);
  assert.equal(backDecoded.action, 'pc');
  assert.equal(backDecoded.args[0], panel.panelToken);
  assert.equal(PANEL_ACTIONS[parseInt(backDecoded.args[1], 36)], 'player');

  // 2. Navigate Trending -> Open Inception inside DM Channel Panel (must have zero web_app/WebApp buttons)
  await h.screen.handle(pcCtx, 'mv', [ms.id, 'tr', '0']);
  assert.equal(ms.view, 'results');
  const movieIdx = ms.results.findIndex(r => String(r.id) === '27205');
  assert.ok(movieIdx >= 0);
  await h.screen.handle(pcCtx, 'mv', [ms.id, 'pk', String(movieIdx)]);
  assert.equal(ms.view, 'movie');
  const detailRich = h.editedMessages.at(-1).rich;
  const detailBtns = detailRich.blocks.filter(b => b.type === 'buttons').flatMap(b => b.buttons);
  assert.equal(detailBtns.some(b => Boolean(b.web_app) || /WebApp/i.test(richTextToString(b.text))), false);

  // 3. Click Back to Player via `pc` -> returns cleanly to Channel Panel Player
  await h.screen.handle(pcCtx, backDecoded.action, backDecoded.args);
  assert.match(JSON.stringify(h.editedMessages.at(-1).rich), /CHANNEL LIVE BROADCAST/);
});

test('MovieStreamResolver resolves verified TMDB HLS streams & WebVTT subtitleHints while skipping expired 410/DASH routes and hiding all source names', async (t) => {
  const tmpSubDir = mkdtempSync(join(tmpdir(), 'lancy-vtt-sub-'));
  const subSvc = new SubtitleService({
    cacheDir: tmpSubDir,
    fetchImpl: async (url) => {
      if (String(url).includes('english-mentalist.vtt')) {
        const vtt = [
          'WEBVTT',
          '',
          '00:01.000 --> 00:03.500 align:middle',
          'Did you see the smiley face?',
          '',
          '00:05.000 --> 00:07.500',
          'Classic Red John signature.',
          '',
          '00:08.000 --> 00:10.000',
          'Patrick Jane is on the case.',
          '',
          '00:11.000 --> 00:13.000',
          'CBI Sacramento HQ.',
          '',
          '00:14.000 --> 00:16.500',
          'Stay sharp, Lisbon.'
        ].join('\n');
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(vtt, 'utf8') };
      }
      return { ok: false, status: 404 };
    }
  });

  const resolver = new MovieStreamResolver({
    movieApi: null,
    subtitles: subSvc,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('sources=zendaya') && u.includes('id=5920')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            source: { url: 'https://cdn.example/expired.mp4', type: 'mp4' },
            subtitles: [
              { label: 'Arabic', file: 'https://subs.example/ar.vtt', type: 'vtt' },
              { label: 'English', file: 'https://subs.example/english-mentalist.vtt', type: 'vtt' }
            ]
          })
        };
      }
      if (u.includes('sources=sadie') && u.includes('id=5920')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            source: { url: 'https://proxy1.flikhub.net/api?url=https%3A%2F%2Fimg1.cdn.test%2Fhls%2F720%2Findex.m3u8', type: 'hls' },
            subtitles: []
          })
        };
      }
      if (u.includes('sources=scarlet') && u.includes('id=5920')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            source: { url: 'https://cdn.example/manifest.mpd', type: 'dash' }
          })
        };
      }
      if (u === 'https://cdn.example/expired.mp4') {
        return { ok: false, status: 410, headers: { get: () => 'text/plain' } };
      }
      if (u.includes('proxy1.flikhub.net/api?url=')) {
        return {
          ok: true,
          status: 200,
          url: u,
          headers: { get: () => 'application/json' },
          text: async () => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttps://cdn.example/seg_0.jpg\n#EXT-X-ENDLIST\n'
        };
      }
      if (u === 'https://cdn.example/seg_0.jpg') {
        return { ok: true, status: 206, headers: { get: () => 'image/jpeg' } };
      }
      return { ok: false, status: 404 };
    }
  });

  const logs = [];
  const res = await resolver.resolve(
    { type: 'tv', id: '5920', title: 'The Mentalist', year: 2008, season: 1, episode: 1, episodeTitle: 'Pilot' },
    { onProgress: (m) => logs.push(m) }
  );

  assert.equal(res.ok, true);
  assert.equal(res.source, 'movie_tmdb_stream');
  assert.equal(res.track.isHls, true);
  assert.equal(res.track.format, 'hls');
  assert.match(res.track.streamUrl, /proxy1\.flikhub\.net\/api/);
  assert.ok(res.subtitles?.found);
  assert.equal(res.subtitles.cues.length, 5);
  assert.match(res.track.subtitlePath, /\.srt$/);
  const leaked = /\b(Flikhub|Yenime|Sadie|Zendaya|Scarlet|Berlin|Meowtv|Vidnest|Lookmovie|HolaFlix|TheNkiri|DownloadWella|LRCLIB|Cinezo|Vdrk)\b/i;
  assert.equal(logs.some((l) => leaked.test(l)), false, 'Logs must not reveal stream provider names');
  assert.equal(leaked.test(res.track.artist || ''), false, 'Track artist metadata must not reveal stream provider names');
  assert.equal(leaked.test(res.track.subtitleLabel || ''), false, 'Subtitle label must not reveal stream provider names');
});

test('StreamingServer rewrites non-standard HLS playlists and proxies .jpg-masked TS segments cleanly with upstream headers', async (t) => {
  const fakeTsPayload = Buffer.concat([Buffer.from([0x47, 0x40, 0x11, 0x10]), Buffer.from('MPEG_TS_MEDIA_SEGMENT')]);
  let capturedReferer = '';
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api?playlist=1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\n/seg/chunk_0.jpg?tok=abc\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/seg/chunk_0.jpg?tok=abc') {
      capturedReferer = req.headers.referer || '';
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': fakeTsPayload.length });
      res.end(fakeTsPayload);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const srv = new VideoStreamingServer({ port: 0, cacheDir: mkdtempSync(join(tmpdir(), 'lancy-hls-vc-')), audioCacheDir: mkdtempSync(join(tmpdir(), 'lancy-hls-ac-')) });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    await new Promise((r) => upstream.close(r));
  });

  const proxyUrl = srv.registerRemoteStream({
    url: `http://127.0.0.1:${upPort}/api?playlist=1`,
    headers: { Referer: 'https://player.cinezo.live/', Origin: 'https://player.cinezo.live' },
    isHls: true
  });
  const m3u8Res = await fetch(proxyUrl);
  assert.equal(m3u8Res.status, 200);
  assert.match(m3u8Res.headers.get('content-type') || '', /mpegurl/i);
  const body = await m3u8Res.text();
  assert.match(body, /^#EXTM3U/m);
  const segLine = body.split(/\r?\n/).find((l) => /^http:\/\/127\.0\.0\.1:\d+\/movie-proxy\/[a-f0-9]+\.ts$/i.test(l.trim()));
  assert.ok(segLine, `Expected rewritten .ts proxy segment URL, got:\n${body}`);

  const segRes = await fetch(segLine.trim());
  assert.equal(segRes.status, 200);
  assert.equal(segRes.headers.get('content-type'), 'video/mp2t');
  const segBuf = Buffer.from(await segRes.arrayBuffer());
  assert.deepEqual(segBuf, fakeTsPayload);
  assert.equal(capturedReferer, 'https://player.cinezo.live/');
});

test('MovieSessions persists across SQLite restarts, tracks card messages, and selects all seasons & episodes', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const { fetchImpl } = createMockMovieFixture();
  const movieApi = new MovieApiClient({ baseUrl: 'https://example.test/api', fetchImpl });
  const sessions1 = new MovieSessions({ db, ttlMs: 0 });
  const ms = sessions1.create({
    chatId: -10050,
    destination: -10050,
    userId: '10',
    view: 'tv',
    query: 'Breaking Bad'
  });
  ms.item = { id: '1396', type: 'tv', title: 'Breaking Bad', year: 2008 };
  ms.seasons = [
    { seasonNumber: 0, name: 'Specials', episodeCount: 2 },
    { seasonNumber: 1, name: 'Season 1', episodeCount: 10 },
    { seasonNumber: 2, name: 'Season 2', episodeCount: 8 }
  ];
  sessions1.registerMessage(ms, 777, 'search');
  // Simulate >48h old timestamp to confirm zero TTL expiration
  ms.createdAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
  ms.updatedAt = ms.createdAt;

  const s1Res = await movieApi.getTvSeasonEpisodes('1396', 1);
  const s2Res = await movieApi.getTvSeasonEpisodes('1396', 2);
  const selResult = sessions1.selectAllSeasonsAndEpisodes(ms, new Map([
    [1, s1Res.episodes],
    [2, s2Res.episodes]
  ]));
  assert.equal(selResult.selected, true);
  assert.equal(selResult.seasonsCount, 2); // Excludes Season 0 Specials
  assert.equal(selResult.episodesCount, 18); // S1(10) + S2(8)
  assert.equal(sessions1.totalSelectedCount(ms), 18);
  sessions1.persistNow();

  // Recreate MovieSessions backed by same SQLite DB (simulates bot restart)
  const sessions2 = new MovieSessions({ db, ttlMs: 0 });
  const restoredById = sessions2.get(ms.id);
  const restoredByMsg = sessions2.getByMessage(-10050, 777);
  assert.ok(restoredById);
  assert.equal(restoredByMsg?.id, ms.id);
  assert.equal(sessions2.totalSelectedCount(restoredById), 18);
});

test('Cinema Playing Card & Queue show VC/Bot links, compact Download buttons, and auto-replace expired cards', async (t) => {
  const h = buildTestHarness(t);
  const deletedIds = [];
  const baseEdit = h.api.editMessageRich;
  let forceEditFailure = false;
  h.api.deleteMessage = async (chatId, msgId) => {
    deletedIds.push({ chatId, msgId });
    return true;
  };
  h.api.editMessageRich = async (chatId, msgId, rich) => {
    if (forceEditFailure) {
      throw new Error('Bad Request: message to edit not found');
    }
    return baseEdit(chatId, msgId, rich);
  };

  const ctx = { tgId: '10', chatId: -10050, api: h.api, user: { first_name: 'Owner' } };
  await h.qm.addMovies(-10050, [
    { id: 'mv1', provider: 'movie', mediaType: 'video', title: 'Inception (2010)', durationSeconds: 3200, streamUrl: 'https://cdn.example/inc.mp4', filePath: h.dummyAudioPath, resolution: '1080p HD' },
    { id: 'mv2', provider: 'movie', mediaType: 'video', title: 'Interstellar (2014)', durationSeconds: 3600, streamUrl: 'https://cdn.example/int.mp4', filePath: h.dummyAudioPath }
  ], { playNow: true });

  const sess = h.qm.getSession(-10050);
  h.api.getChat = async (chatId) => ({ id: chatId, type: 'supergroup', title: 'Midnight Cinema VC', username: 'midnightcinema' });
  h.api.botUsername = 'Lancy_easy_bot';

  await h.service.player(ctx, -10050);
  const card = h.screen.renderPlayer(sess);
  const cardJson = JSON.stringify(card);
  assert.match(cardJson, /Midnight Cinema VC/);
  assert.match(cardJson, /Lancy Music \(@Lancy_easy_bot\)/);
  assert.match(cardJson, /https:\/\/t\.me\/midnightcinema\?voicechat/);
  assert.match(cardJson, /https:\/\/t\.me\/Lancy_easy_bot/);
  assert.match(cardJson, /downloadnow/);

  const qCard = h.screen.renderMovieQueue(sess, 0);
  const qJson = JSON.stringify(qCard);
  assert.match(qJson, /downloadq/);
  assert.match(qJson, /votequeue/);

  // Simulate expired card (>48h edit rejection) -> auto delete old card + resend fresh card
  const oldMsgId = sess.screenMessageId;
  forceEditFailure = true;
  sess._lastCardReplaceAt = 0;
  await h.qm.updatePlayerView(sess, { forceEdit: true });
  assert.ok(deletedIds.some(d => d.msgId === oldMsgId), 'Expired card should be deleted');
  assert.notEqual(sess.screenMessageId, oldMsgId, 'New card message ID should replace expired ID');

  // Verify de-spam search cleanup deletes prior search card when performing new search
  await h.screen.handleCommand(ctx, '/movie', ['Inception']);
  const firstSearchMsgId = h.sentMessages.at(-1).message_id;
  await h.screen.handleCommand(ctx, '/movie', ['Breaking Bad']);
  assert.ok(deletedIds.some(d => d.msgId === firstSearchMsgId), 'Previous superseded search card should be deleted on new search');
});

test('Viewer Queue Voting, Owner Vote Threshold configuration, and Native Telegram Poll auto-trigger actions', async (t) => {
  const h = buildTestHarness(t);
  h.api.getChatMember = async (_chatId, uid) => ({
    status: Number(uid) === 10 ? 'administrator' : 'member',
    is_member: true
  });
  let sentPoll = null;
  let stoppedPoll = null;
  h.api.sendPoll = async (chatId, question, options, extra) => {
    sentPoll = { chatId, question, options, extra };
    return { message_id: 901, poll: { id: 'poll_vc_1', question, options } };
  };
  h.api.stopPoll = async (chatId, messageId) => {
    stoppedPoll = { chatId, messageId };
    return { id: 'poll_vc_1', is_closed: true };
  };

  await h.qm.addMovies(-10050, [
    { id: 'mv1', provider: 'movie', mediaType: 'video', title: 'Movie One', durationSeconds: 2400, streamUrl: 'https://cdn.example/1.mp4', filePath: h.dummyAudioPath },
    { id: 'mv2', provider: 'movie', mediaType: 'video', title: 'Movie Two', durationSeconds: 2400, streamUrl: 'https://cdn.example/2.mp4', filePath: h.dummyAudioPath },
    { id: 'mv3', provider: 'movie', mediaType: 'video', title: 'Movie Three', durationSeconds: 2400, streamUrl: 'https://cdn.example/3.mp4', filePath: h.dummyAudioPath }
  ], { playNow: true });

  const ownerCtx = { tgId: '10', chatId: -10050, api: h.api, user: { first_name: 'Owner' } };
  const member1Ctx = { tgId: '21', chatId: -10050, api: h.api, user: { first_name: 'Viewer1' } };
  const member2Ctx = { tgId: '22', chatId: -10050, api: h.api, user: { first_name: 'Viewer2' } };

  // Non-admin member cannot change owner vote thresholds
  await assert.rejects(
    h.service.control(member1Ctx, 'setvotethresh', ['queue', '2']),
    e => e.code === 'ADMIN_ONLY'
  );

  // Owner configures Queue Vote Threshold = 2 and Queue Vote Action = top (promote)
  await h.service.control(ownerCtx, 'setvotethresh', ['queue', '2']);
  await h.service.control(ownerCtx, 'setvotethresh', ['mode', 'top']);

  const sess = h.qm.getSession(-10050);
  const thirdEntryId = sess.movieUpcoming[1].entryId;

  // Viewer 1 votes for Movie Three -> 1/2
  await h.service.control(member1Ctx, 'votequeue', [thirdEntryId]);
  assert.equal(sess.movieUpcoming[1].title, 'Movie Three');

  // Viewer 2 votes for Movie Three -> hits 2/2 -> promoted to index 0!
  await h.service.control(member2Ctx, 'votequeue', [thirdEntryId]);
  assert.equal(sess.movieUpcoming[0].title, 'Movie Three');

  // Owner sets skip threshold = 2 and launches native Telegram Poll
  await h.service.control(ownerCtx, 'setvotethresh', ['skip', '2']);
  await h.service.control(ownerCtx, 'launchpoll', ['skip']);
  assert.ok(sentPoll);
  assert.match(sentPoll.options[0], /Movie One/);

  // Dispatch poll_answer updates through TelegramController
  const controller = new TelegramController({
    api: h.api,
    db: h.db,
    settings: h.settings,
    stateMachine: h.app.sm,
    sm: h.app.sm,
    screens: new Map(),
    app: h.app
  });
  h.app.music = h.service;
  await controller.handleUpdate({
    update_id: 501,
    poll_answer: { poll_id: 'poll_vc_1', user: { id: 21, first_name: 'Viewer1' }, option_ids: [0] }
  });
  // Still Movie One after 1/2 votes
  assert.equal(sess.currentTrack.title, 'Movie One');

  await controller.handleUpdate({
    update_id: 502,
    poll_answer: { poll_id: 'poll_vc_1', user: { id: 22, first_name: 'Viewer2' }, option_ids: [0] }
  });
  // Reached 2/2 skip votes -> poll stopped & skipped to promoted Movie Three!
  assert.equal(stoppedPoll?.messageId, 901);
  assert.equal(sess.currentTrack.title, 'Movie Three');
});

test('MovieDownloader delivers single MP4 with spoiler option and paginated Bot API 10.3 album slides', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'lancy-dl-test-'));
  const sampleMp4 = join(workDir, 'episode.mp4');
  writeFileSync(sampleMp4, Buffer.alloc(1024, 0x20));

  const sentVideos = [];
  const sentMediaGroups = [];
  const sentRich = [];
  const api = {
    botUsername: 'Lancy_easy_bot',
    sendVideo: async (chatId, file, extra) => {
      sentVideos.push({ chatId, file, extra });
      return { message_id: 100 + sentVideos.length };
    },
    sendMediaGroup: async (chatId, media, opts, files) => {
      sentMediaGroups.push({ chatId, media, opts, files });
      return [{ message_id: 200 }];
    },
    sendRichMessage: async (chatId, rich, opts, files) => {
      sentRich.push({ chatId, rich, opts, files });
      return { message_id: 300 + sentRich.length };
    },
    editMessageRich: async () => { throw new Error('force fallback send'); },
    deleteMessage: async () => true
  };

  const downloader = new MovieDownloader({ app: { telegram: { api } } });
  const ctx = { chatId: -10088, tgId: '10', api };

  // 1. Single video delivery with spoiler blur + Stream in VC button
  const singleRes = await downloader.sendSingleVideo(
    ctx,
    { id: 'ep1', title: 'Pilot Episode', filePath: sampleMp4, durationSeconds: 2600 },
    { vcCallbackData: 's:mv:play1', spoiler: true }
  );
  assert.equal(singleRes.ok, true);
  assert.equal(sentVideos.length, 1);
  assert.equal(sentVideos[0].extra.supports_streaming, true);
  assert.equal(sentVideos[0].extra.has_spoiler, true);
  assert.equal(sentVideos[0].extra.reply_markup.inline_keyboard[0][0].callback_data, 's:mv:play1');

  // 2. Paginated Bot API 10.3 album slideshow (5 items, pageSize 3 -> 2 pages)
  const ms = {
    dlPage: 0,
    dlManifest: {
      title: 'Breaking Bad S01',
      pageSize: 3,
      items: [1, 2, 3, 4, 5].map(n => ({
        title: `Episode ${n}`,
        season: 1,
        episode: n,
        filePath: sampleMp4,
        durationSeconds: 1800
      }))
    }
  };
  const page0 = await downloader.deliverAlbumSlidePage(ctx, ms, 0, {
    buildNavCallback: (p) => `s:mv:ds:${p}`,
    streamPageCallback: (p) => `s:mv:px:${p}`
  });
  assert.equal(page0.ok, true);
  assert.equal(page0.count, 3);
  const p0Json = JSON.stringify(sentRich.at(-1).rich);
  assert.match(p0Json, /"type":"slideshow"/);
  assert.match(p0Json, /Next \(4–5\) ▶/);

  const page1 = await downloader.deliverAlbumSlidePage(ctx, ms, 1, {
    buildNavCallback: (p) => `s:mv:ds:${p}`
  });
  assert.equal(page1.ok, true);
  assert.equal(page1.count, 2);
  const p1Json = JSON.stringify(sentRich.at(-1).rich);
  assert.match(p1Json, /◀ Prev \(1–3\)/);
});

test('MovieStreamResolver rejects wrong sequels, short-title substrings, Episode-1 fallbacks, short HLS teasers, and Stage-1 subtitle leaks', async (t) => {
  // 1. Sequel mismatch: "John Wick: Chapter 4" (2023) must reject "John Wick (2014)"
  const mkApi = (overrides = {}) => ({
    getPlayback: async () => ({ available: false }),
    ...overrides
  });
  const resolverSequel = new MovieStreamResolver({
    movieApi: mkApi(),
    fetchImpl: async () => ({ ok: false, status: 403 }),
    thenkiri: {
      thenkiriSearch: async () => ({
        results: [{ title: 'John Wick (2014) Full Movie', url: 'https://thenkiri.example/jw1' }]
      }),
      thenkiriDetails: async () => ({
        sources: [{ title: 'John Wick 2014 HD', label: 'Download Movie', url: 'https://downloadwella.com/jw1' }]
      }),
      thenkiriGetLink: async () => ({ url: 'https://cdn.example/jw1.mp4', headers: {}, format: 'mp4' })
    }
  });
  const jw4Res = await resolverSequel.resolve({
    type: 'movie',
    id: '603692',
    title: 'John Wick: Chapter 4',
    year: 2023,
    fetchSubtitles: false
  });
  assert.equal(jw4Res.ok, false);

  // 2. Short-title word boundary: "Us" (2019) must NOT match "Music Movie (2019)"
  const resolverUs = new MovieStreamResolver({
    movieApi: mkApi(),
    fetchImpl: async () => ({ ok: false, status: 403 }),
    thenkiri: {
      thenkiriSearch: async () => ({
        results: [{ title: 'Music Movie (2019) Full HD', url: 'https://thenkiri.example/music' }]
      }),
      thenkiriDetails: async () => ({
        sources: [{ title: 'Music Movie 2019', label: 'Download Movie', url: 'https://downloadwella.com/music' }]
      }),
      thenkiriGetLink: async () => ({ url: 'https://cdn.example/music.mp4', headers: {}, format: 'mp4' })
    }
  });
  const usRes = await resolverUs.resolve({
    type: 'movie',
    id: '458723',
    title: 'Us',
    year: 2019,
    fetchSubtitles: false
  });
  assert.equal(usRes.ok, false);

  // 3. Episode-1 fallback guard + Archive box-set episode matching for S01E05
  const resolverEpGuard = new MovieStreamResolver({
    movieApi: mkApi(),
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes('archive.org/advancedsearch')) {
        return {
          ok: true,
          json: async () => ({
            response: {
              docs: [{ identifier: 'BreakingBadS01Box', title: 'Breaking Bad (2008) Season 1', year: 2008 }]
            }
          })
        };
      }
      if (s.includes('archive.org/metadata/BreakingBadS01Box')) {
        return {
          ok: true,
          json: async () => ({
            metadata: { title: 'Breaking Bad (2008) Season 1' },
            files: [
              { name: 'Breaking.Bad.S01E01.720p.mp4', length: '2800', size: String(500e6) },
              { name: 'Breaking.Bad.S01E05.720p.mp4', length: '2820', size: String(520e6) }
            ]
          })
        };
      }
      if (s.includes('Breaking.Bad.S01E05.720p.mp4')) {
        return { ok: true, status: 206, headers: { get: () => 'video/mp4' } };
      }
      return { ok: false, status: 403 };
    },
    thenkiri: {
      thenkiriSearch: async () => ({
        results: [{ title: 'Breaking Bad (2008) TV Series', url: 'https://thenkiri.example/bb' }]
      }),
      thenkiriDetails: async () => ({
        sources: [
          { title: 'Breaking Bad S01E01', seasonNumber: 1, episodeNumber: 1, label: 'Episode 1', url: 'https://downloadwella.com/bb-e1' },
          { title: 'Breaking Bad S01E02', seasonNumber: 1, episodeNumber: 2, label: 'Episode 2', url: 'https://downloadwella.com/bb-e2' }
        ]
      }),
      thenkiriGetLink: async () => {
        throw new Error('Must never resolve S01E01 when S01E05 was requested');
      }
    }
  });
  const ep5Res = await resolverEpGuard.resolve({
    type: 'tv',
    id: '1396',
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 5,
    durationSeconds: 2800,
    fetchSubtitles: false
  });
  assert.equal(ep5Res.ok, true);
  assert.equal(ep5Res.source, 'archive_org');
  assert.match(ep5Res.track.streamUrl, /S01E05/);

  // 4. Reject short 18s HLS VOD teaser on root_stream & prevent Stage-1 subtitles leaking to Stage-2 encode
  const fakeTs = Buffer.concat([Buffer.from([0x47, 0x40, 0x11, 0x10]), Buffer.alloc(64 * 1024, 1)]);
  const srv = http.createServer((req, res) => {
    if (req.url === '/teaser.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\n/seg1.ts\n#EXTINF:6.0,\n/seg2.ts\n#EXTINF:6.0,\n/seg3.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url?.startsWith('/seg')) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fakeTs.length });
      res.end(fakeTs);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const port = srv.address().port;

  const seenHintSets = [];
  const resolverStageIsolation = new MovieStreamResolver({
    movieApi: {
      getPlayback: async () => ({
        available: true,
        root_stream: { direct_url: `http://127.0.0.1:${port}/teaser.m3u8` },
        subtitles: [{ url: 'https://stage1.example/wrong-route.srt', label: 'English' }]
      })
    },
    subtitles: {
      resolveForMedia: async (args) => {
        seenHintSets.push(args.subtitleHints);
        return null;
      }
    },
    fetchImpl: (url, opts) => (
      String(url).startsWith(`http://127.0.0.1:${port}/`)
        ? fetch(url, opts)
        : Promise.resolve({ ok: false, status: 403 })
    ),
    thenkiri: {
      thenkiriSearch: async () => ({
        results: [{ title: 'Inception (2010) Full Movie', url: 'https://thenkiri.example/inc' }]
      }),
      thenkiriDetails: async () => ({
        sources: [{ title: 'Inception 2010 Full Movie', label: 'Download Movie', url: 'https://downloadwella.com/inc' }]
      }),
      thenkiriGetLink: async () => ({ url: 'https://cdn.example/inc_stage2.mkv', headers: {}, format: 'mkv' })
    }
  });
  const isoRes = await resolverStageIsolation.resolve({
    type: 'movie',
    id: '27205',
    title: 'Inception',
    year: 2010,
    durationSeconds: 7200,
    fetchSubtitles: true
  });
  assert.equal(isoRes.ok, true);
  assert.match(isoRes.track.streamUrl, /inc_stage2\.mkv/);
  assert.equal(seenHintSets.length, 1);
  assert.deepEqual(seenHintSets[0], []);
});

test('MovieUi clears previous TV episodes, selections, playback, and dlManifest when loading another title', async (t) => {
  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);

  await h.screen.handleCommand(ctx, '/movie', ['Breaking', 'Bad']);
  const ms = h.app.movieSessions.getLatestForChat(-10050);
  await h.screen.handle({ ...ctx, query: { id: 'q-bb' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '0']);
  assert.equal(ms.mediaItem.id, '1396');
  await h.screen.handle({ ...ctx, query: { id: 'q-e1' }, messageId: ms.messageId }, 'mv', [ms.id, 'tg', '1-1']);
  await h.screen.handle({ ...ctx, query: { id: 'q-e2' }, messageId: ms.messageId }, 'mv', [ms.id, 'tg', '1-2']);
  assert.equal(h.app.movieSessions.totalSelectedCount(ms), 2);
  ms.playback = { streamUrl: 'https://stale.example/bb.mp4' };
  ms.dlManifest = [{ title: 'Stale EP1' }];
  ms.dlPage = 2;

  // Pick second search result (Inception, movie) into the same session -> zero cross-title bleed
  await h.screen.handle({ ...ctx, query: { id: 'q-inc' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '1']);
  assert.equal(ms.mediaItem.id, '27205');
  assert.equal(ms.view, 'movie');
  assert.equal(ms.seasons.length, 0);
  assert.equal(ms.episodes.length, 0);
  assert.equal(ms.episodeCache.size, 0);
  assert.equal(ms.selectedBySeason.size, 0);
  assert.equal(h.app.movieSessions.totalSelectedCount(ms), 0);
  assert.notEqual(ms.playback?.streamUrl, 'https://stale.example/bb.mp4');
  assert.equal(ms.dlManifest, null);
  assert.equal(ms.dlPage, 0);
});

test('SubtitleService rejects wrong-episode OpenSubtitles candidates, strips promo cues, and scopes cache by stream signature', async () => {
  const subDir = mkdtempSync(join(tmpdir(), 'lancy-sub-reg-'));
  const wrongSrt = '1\n00:00:01,000 --> 00:00:03,000\nWrong E01 line\n';
  const goodSrtWithPromo = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    'Downloaded from YTS.MX - Subtitles by OpenSubtitles.org',
    '',
    ...Array.from({ length: 12 }, (_, idx) => {
      const startSec = 10 + idx * 5;
      const endSec = startSec + 3;
      const line = idx === 0 ? 'Say my name.' : `Dialogue line ${idx + 1}`;
      return `${idx + 2}\n00:00:${String(startSec).padStart(2, '0')},000 --> 00:00:${String(endSec).padStart(2, '0')},000\n${line}\n`;
    })
  ].join('\n');

  let openSubCalls = 0;
  const subSvc = new SubtitleService({
    cacheDir: subDir,
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes('hint-a.srt')) {
        const srtA = Array.from({ length: 6 }, (_, i) => `${i + 1}\n00:00:${String(2 + i * 5).padStart(2, '0')},000 --> 00:00:${String(5 + i * 5).padStart(2, '0')},000\n${i === 0 ? 'Hint Stream A' : `A line ${i + 1}`}\n`).join('\n');
        return { ok: true, arrayBuffer: async () => Buffer.from(srtA, 'utf8') };
      }
      if (s.includes('hint-b.srt')) {
        const srtB = Array.from({ length: 6 }, (_, i) => `${i + 1}\n00:00:${String(2 + i * 5).padStart(2, '0')},000 --> 00:00:${String(5 + i * 5).padStart(2, '0')},000\n${i === 0 ? 'Hint Stream B' : `B line ${i + 1}`}\n`).join('\n');
        return { ok: true, arrayBuffer: async () => Buffer.from(srtB, 'utf8') };
      }
      if (s.includes('rest.opensubtitles.org')) {
        openSubCalls += 1;
        return {
          ok: true,
          json: async () => ([
            {
              IDSubtitleFile: '101',
              MovieName: 'Breaking Bad',
              MovieReleaseName: 'Breaking.Bad.S01E01.720p',
              SeriesSeason: '1',
              SeriesEpisode: '1',
              SubLanguageID: 'eng',
              SubFormat: 'srt',
              SubDownloadsCnt: '999999',
              SubDownloadLink: 'https://dl.opensubtitles.test/wrong.srt.gz'
            },
            {
              IDSubtitleFile: '105',
              MovieName: 'Breaking Bad',
              MovieReleaseName: 'Breaking.Bad.S01E05.720p',
              SeriesSeason: '1',
              SeriesEpisode: '5',
              SubLanguageID: 'eng',
              SubFormat: 'srt',
              SubDownloadsCnt: '1200',
              SubDownloadLink: 'https://dl.opensubtitles.test/e05.srt.gz'
            }
          ])
        };
      }
      if (s.includes('dl.opensubtitles.test/wrong.srt.gz')) {
        return { ok: true, arrayBuffer: async () => gzipSync(Buffer.from(wrongSrt, 'utf8')) };
      }
      if (s.includes('dl.opensubtitles.test/e05.srt.gz')) {
        return { ok: true, arrayBuffer: async () => gzipSync(Buffer.from(goodSrtWithPromo, 'utf8')) };
      }
      return { ok: false, status: 404 };
    }
  });

  // 1. Wrong episode only -> must reject cleanly
  const ep2None = await subSvc.resolveForMedia({
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 2,
    streamUrl: 'https://cdn.example/bb-s01e02.mp4'
  });
  assert.equal(ep2None, null);

  // 2. Exact episode S01E05 picks E05 over higher-download E01 and strips promo cue
  const ep5Sub = await subSvc.resolveForMedia({
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 5,
    streamUrl: 'https://cdn.example/bb-s01e05-encodeA.mp4'
  });
  assert.ok(ep5Sub);
  assert.equal(ep5Sub.cues.length, 12);
  assert.equal(ep5Sub.cues[0].text, 'Say my name.');
  assert.equal(ep5Sub.cues.some((c) => /YTS\.MX|OpenSubtitles/i.test(c.text)), false);

  // 3. Stream signature isolation: Stream A uses Hint A, Stream B (same title) uses Hint B instead of cached Hint A
  const resA = await subSvc.resolveForMedia({
    title: 'Inception',
    year: 2010,
    streamUrl: 'https://cdn.example/inception-encodeA.m3u8',
    subtitleHints: [{ url: 'https://sub.example/hint-a.srt', label: 'English' }]
  });
  const resB = await subSvc.resolveForMedia({
    title: 'Inception',
    year: 2010,
    streamUrl: 'https://cdn.example/inception-encodeB.mp4',
    subtitleHints: [{ url: 'https://sub.example/hint-b.srt', label: 'English' }]
  });
  assert.equal(resA.cues[0].text, 'Hint Stream A');
  assert.equal(resB.cues[0].text, 'Hint Stream B');
  assert.ok(openSubCalls >= 1);
});

test('VideoStreamingServer coalesces concurrent HLS child-segment fetches across mic & camera FFmpeg pipelines', async (t) => {
  const segPayload = Buffer.concat([Buffer.from([0x47, 0x40, 0x11, 0x10]), Buffer.from('COALESCED_SEGMENT_BYTES')]);
  let upstreamSegHits = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\n/seg/0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/seg/0.ts') {
      upstreamSegHits += 1;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': segPayload.length });
        res.end(segPayload);
      }, 35);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const srv = new VideoStreamingServer({ port: 0, cacheDir: mkdtempSync(join(tmpdir(), 'lancy-coal-vc-')), audioCacheDir: mkdtempSync(join(tmpdir(), 'lancy-coal-ac-')) });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    await new Promise((r) => upstream.close(r));
  });

  const proxyUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${upPort}/master.m3u8`, isHls: true });
  const m3u8Text = await (await fetch(proxyUrl)).text();
  const segUrl = m3u8Text.split(/\r?\n/).find((l) => /^http:\/\/127\.0\.0\.1:\d+\/movie-proxy\//i.test(l.trim())).trim();

  // Simultaneous fetches simulating microphone + camera FFmpeg pipelines -> 1 upstream download
  const [r1, r2] = await Promise.all([fetch(segUrl), fetch(segUrl)]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(Buffer.from(await r1.arrayBuffer()), segPayload);
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), segPayload);
  assert.equal(upstreamSegHits, 1);

  // Subsequent read hits bounded in-memory segment cache without another upstream fetch
  const r3 = await fetch(segUrl);
  assert.equal(r3.status, 200);
  assert.deepEqual(Buffer.from(await r3.arrayBuffer()), segPayload);
  assert.equal(upstreamSegHits, 1);
});
