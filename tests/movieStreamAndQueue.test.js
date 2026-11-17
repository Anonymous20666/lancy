import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { MovieDownloader, selectOriginalAudioMapArgs } from '../src/media/movieDownloader.js';
import { SubtitleService, parseSrt, getCueAt, shiftSrtText } from '../src/media/subtitles.js';
import { MovieStreamResolver, scoreTitleMatch, isDubbedCandidateText } from '../src/media/movieResolver.js';
import { VideoStreamingServer, isDubAudioLabel } from '../src/media/streamingServer.js';
import { MediaAiAgent } from '../src/ai/mediaAgent.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { TelegramController } from '../src/telegram/bot.js';
import { decodeCallback, richTextToString } from '../src/telegram/rich.js';
import { CinemaVcAnnouncer, normalizeAnnounceTitleKey } from '../src/music/cinemaAnnouncer.js';

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
    setSubtitle: async (id, subtitlePath, opts = {}) => {
      voiceCalls.setSubtitle.push({ id, subtitlePath, ...opts, opts });
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

  // Pick Breaking Bad (index 0) -> photo-less search card upgrades to poster TV season card and shows Season 1 first (page 1 of 2, 6 checkboxes)
  const latest = h.app.movieSessions.getLatestForChat(-10050);
  await h.screen.handle({ ...ctx, query: { id: 'q1' }, messageId: latest.messageId }, 'mv', [latest.id, 'pk', '0']);
  assert.equal(latest.view, 'season');
  assert.equal(latest.seasonNumber, 1);

  const s1Card = h.sentMessages.at(-1).rich;
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
  assert.equal(h.voiceCalls.setSubtitle.at(-1)?.subtitlePath, srtFile);
  assert.equal(h.voiceCalls.setSubtitle.at(-1)?.subtitleRenderScreen, false);

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

test('Conversational genre requests route to browse instead of literal "me Romance movies" search while preserving exact movie titles', async (t) => {
  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);
  const searchCalls = [];
  const browseCalls = [];
  h.app.movieApi.search = async (q) => {
    searchCalls.push(q);
    return { results: [{ id: '99', type: 'movie', title: q, year: 2016 }] };
  };
  h.app.movieApi.browse = async (opts) => {
    browseCalls.push(opts);
    return { results: [{ id: '597', type: 'movie', title: 'Titanic', year: 1997 }] };
  };

  for (const phrase of ['give me Romance movies', 'find me Romance movies', 'me Romance movies']) {
    const aiRes = await h.app.mediaAgent.chat({ ctx, chatId: -10050, userId: 10, text: phrase, defaultDomain: 'movie' });
    assert.equal(aiRes.action?.name, 'browse_category');
    assert.equal(aiRes.action?.category, 'romance');
    await h.screen.movieUi.openMovieSearch(ctx, phrase);
  }
  assert.equal(browseCalls.length, 3);
  assert.equal(searchCalls.length, 0);

  await h.screen.handleCommand(ctx, '/movie', ['give', 'me', 'Romance', 'movies']);
  assert.equal(browseCalls.length, 4);
  assert.equal(searchCalls.length, 0);

  await h.screen.movieUi.openMovieSearch(ctx, 'Me Before You');
  await h.screen.movieUi.openMovieSearch(ctx, 'True Romance');
  assert.deepEqual(searchCalls, ['Me Before You', 'True Romance']);
});

test('Categories and browse survive primary API ECONNRESET via defaults/Cinemeta, and player preserves preview image across text->photo transition', async (t) => {
  const api = new MovieApiClient({
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes('pappy-hosting')) {
        const err = new Error('fetch failed');
        err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw err;
      }
      if (s.includes('cinemeta-catalogs.strem.io')) {
        return {
          ok: true,
          json: async () => ({
            metas: [
              { imdb_id: 'tt0120338', name: 'Titanic', releaseInfo: '1997', poster: 'https://image.tmdb.org/t/p/w500/titanic.jpg', imdbRating: '7.9' }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });
  const cats = await api.categories();
  assert.ok(cats.length >= 16);
  assert.ok(cats.some((c) => c.id === 'romance'));
  const rom = await api.browse({ category: 'romance', page: 1, limit: 10 });
  assert.equal(rom.results.length, 1);
  assert.equal(rom.results[0].title, 'Titanic');

  const h = buildTestHarness(t);
  const ctx = h.makeCtx(-10050);
  const resolver = new MovieStreamResolver({
    movieApi: {
      getPlaybackInfo: async () => ({ rootStream: { direct_url: 'https://cdn.example.com/titanic.mp4', format: 'mp4' } })
    },
    ytdlpEnabled: false,
    enableWebFallback: true,
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'video/mp4'], ['content-length', '500000000']]), url: 'https://cdn.example.com/titanic.mp4' })
  });
  const resolved = await resolver.resolve({
    id: '597',
    type: 'movie',
    title: 'Titanic',
    year: 1997,
    poster: 'https://image.tmdb.org/t/p/w500/titanic.jpg'
  });
  assert.equal(resolved.track.artwork, 'https://image.tmdb.org/t/p/w500/titanic.jpg');

  // Verify queueManager replaces text-only card (lastRenderHasPhoto=false) with sendRichMessage instead of stripping photo on editMessageRich failure
  const sentPayloads = [];
  const deletedIds = [];
  const s = h.qm.getSession(-10050);
  s.connected = true;
  s.status = 'playing';
  s.activeDeck = 'movie';
  s.view = 'cinema';
  s.screenMessageId = 700;
  s.playerChatId = -10050;
  s.lastRenderHasPhoto = false;
  s.currentTrack = resolved.track;
  s.api = {
    editMessageRich: async (_cid, _mid, rich) => {
      if (rich?.blocks?.some((b) => b.type === 'photo')) {
        throw Object.assign(new Error('Telegram editMessageText: Bad Request: wrong type of the web page content'), { description: 'Bad Request: wrong type of the web page content' });
      }
      return { message_id: s.screenMessageId };
    },
    sendRichMessage: async (_cid, rich) => {
      sentPayloads.push(rich);
      return { message_id: 701 };
    },
    deleteMessage: async (_cid, mid) => { deletedIds.push(mid); }
  };
  await h.qm.updatePlayerView(s, { forceEdit: true });
  assert.equal(s.screenMessageId, 701);
  assert.equal(s.lastRenderHasPhoto, true);
  assert.ok(deletedIds.includes(700));
  assert.ok(sentPayloads[0]?.blocks?.some((b) => b.type === 'photo' && b.photo?.media === 'https://image.tmdb.org/t/p/w500/titanic.jpg'));

  // Subsequent progress ticks must edit in-place and NEVER spam extra sendRichMessage cards even if remote edit fails
  s.positionSeconds = 120;
  await h.qm.updatePlayerView(s, { forceEdit: true });
  s.positionSeconds = 150;
  await h.qm.updatePlayerView(s, { forceEdit: true });
  assert.equal(sentPayloads.length, 1, 'Must never spam multiple player cards on subsequent edits');
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

test('Cinema Play Card attaches poster preview, avoids premature 100% live indicator, and cleans up stale live-log card on fallback', async (t) => {
  const h = buildTestHarness(t);
  const deletedIds = [];
  const origDelete = h.api.deleteMessage;
  const origEdit = h.api.editMessageRich;
  let rejectReuseEdit = false;
  h.api.deleteMessage = async (chatId, msgId) => {
    deletedIds.push({ chatId, msgId });
    return origDelete(chatId, msgId);
  };
  h.api.editMessageRich = async (chatId, msgId, rich) => {
    if (rejectReuseEdit) throw new Error('Bad Request: message cannot be edited with media');
    return origEdit(chatId, msgId, rich);
  };

  const session = {
    chatId: -10077,
    destination: -10077,
    destinationTitle: 'Cinema Lounge',
    isChannel: false,
    activeDeck: 'movie',
    status: 'playing',
    positionSeconds: 5,
    currentTrack: {
      id: 'movie:27205:0:0',
      provider: 'movie',
      title: 'Inception (2010)',
      artwork: 'https://image.tmdb.org/t/p/w780/inception.jpg',
      durationSeconds: 3600,
      mediaType: 'video'
    },
    movieUpcoming: [],
    movieHistory: [],
    upcoming: [],
    subtitleMode: 'screen',
    skipVotes: []
  };

  // 1. Live indicator at 5s / 3600s must show 0% (never 100%), and poster photo must be attached
  const startCard = h.screen.renderCinemaPlayer(session);
  const startPhoto = startCard.blocks.find((b) => b.type === 'photo');
  assert.equal(startPhoto?.photo?.media, 'https://image.tmdb.org/t/p/w780/inception.jpg');
  const startText = JSON.stringify(startCard);
  assert.match(startText, /[░█]+\s+0%\s+0:05 \/ 1:00:00/);
  assert.doesNotMatch(startText, /[░█]+\s+100%/);

  // 2. Halfway (1800s / 3600s) -> 50%, near-end (3595s / 3600s) -> capped at 99%, exact end -> 100%
  session.positionSeconds = 1800;
  assert.match(JSON.stringify(h.screen.renderCinemaPlayer(session)), /[░█]+\s+50%\s+30:00 \/ 1:00:00/);
  session.positionSeconds = 3595;
  const nearEndText = JSON.stringify(h.screen.renderCinemaPlayer(session));
  assert.match(nearEndText, /[░█]+\s+99%\s+59:55 \/ 1:00:00/);
  assert.doesNotMatch(nearEndText, /[░█]+\s+100%/);
  session.positionSeconds = 3600;
  assert.match(JSON.stringify(h.screen.renderCinemaPlayer(session)), /[░█]+\s+100%\s+1:00:00 \/ 1:00:00/);

  // 3. Music Play Card live indicator also never rounds prematurely to 100% while pos < dur
  const musicCard = h.screen.renderMusicPlayer({
    ...session,
    activeDeck: 'music',
    currentTrack: { id: 'yt:1', provider: 'youtube', title: 'Test Song', durationSeconds: 200, mediaType: 'audio' },
    positionSeconds: 199
  });
  assert.match(JSON.stringify(musicCard), /[░█]+\s+99%/);
  assert.doesNotMatch(JSON.stringify(musicCard), /[░█]+\s+100%/);

  // 4. Buffering state falls back to queued movie's artwork thumbnail/poster
  const bufferingCard = h.screen.renderCinemaPlayer({
    ...session,
    status: 'buffering',
    currentTrack: null,
    movieUpcoming: [{ title: 'Next Film', thumbnailUrl: 'https://cdn.example.org/thumb.jpg' }]
  });
  assert.equal(bufferingCard.blocks.find((b) => b.type === 'photo')?.photo?.media, 'https://cdn.example.org/thumb.jpg');

  // 5. Morphing from Live Cinema Log (`reuseMessageId`) preserves poster in Play Card & cleans up stale log card if edit fails
  const ctx = h.makeCtx(-10077);
  h.qm.getSession(-10077).prepared = true;
  h.service.prepare = async (_c, dest) => ({ destination: dest });
  await h.screen.handleCommand(ctx, '/movie', ['Inception']);
  const mvSess = h.app.movieSessions.getLatestForChat(-10077);
  const incIdx = mvSess.results.findIndex((r) => String(r.id) === '27205');
  await h.screen.handle({ ...ctx, query: { id: 'qpk-img' }, messageId: mvSess.messageId }, 'mv', [mvSess.id, 'pk', String(incIdx)]);
  await h.screen.handle({ ...ctx, query: { id: 'qpm-img' }, messageId: mvSess.messageId }, 'mv', [mvSess.id, 'pm', '']);
  const morphedEdit = h.editedMessages.at(-1);
  assert.match(JSON.stringify(morphedEdit?.rich), /CINEMA VC/, 'Live Cinema Log must morph into Cinema Play Card');
  assert.ok(morphedEdit?.rich?.blocks?.some((b) => b.type === 'photo'), 'Cinema Play Card morphed from Live Log must include poster photo block');
  assert.doesNotMatch(JSON.stringify(morphedEdit?.rich), /[░█]+\s+100%/);

  // Also verify fallback cleanup when reuseMessageId edit fails
  const liveSess = h.qm.getSession(-10077);
  liveSess.screenMessageId = null;
  rejectReuseEdit = true;
  const liveMsgId = 777;
  await h.service.player({ ...ctx, reuseMessageId: liveMsgId }, -10077);
  assert.ok(deletedIds.some((d) => d.msgId === liveMsgId), 'Stale live-log message must be deleted if reuse edit falls back to sendRichMessage');
  assert.ok(h.sentMessages.at(-1)?.rich?.blocks?.some((b) => b.type === 'photo'), 'Fallback Play Card must attach poster photo block');
});

test('Restart auto-resume restores active movie playback from saved second, preserves queues, and auto-pins Play Card', async (t) => {
  const h = buildTestHarness(t);
  const pinnedCalls = [];
  h.api.pinChatMessage = async (chatId, msgId, opts) => {
    pinnedCalls.push({ chatId, msgId, opts });
    return true;
  };
  h.api.call = async (method, params = {}) => {
    if (method === 'pinChatMessage') {
      pinnedCalls.push({ chatId: params.chat_id, msgId: params.message_id, opts: { disable_notification: params.disable_notification } });
      return true;
    }
    return { ok: true };
  };
  h.api.getChat = async (id) => ({ id, type: 'supergroup', title: 'Midnight Cinema VC' });
  const ctx = h.makeCtx(-100999);

  // Idle dashboard open in group must never pin automatically
  await h.service.player(ctx, -100999);
  assert.equal(pinnedCalls.length, 0);

  // Start playing movie #1 and queue movie #2, then advance progress and shut down
  await h.qm.addMany(-100999, [
    {
      provider: 'movie',
      providerId: '27205:0:0',
      title: 'Inception (2010)',
      mediaType: 'video',
      streamUrl: 'https://cdn.example.org/inception.mp4',
      durationSeconds: 3600,
      artwork: 'https://image.tmdb.org/t/p/w780/inception.jpg'
    },
    {
      provider: 'movie',
      providerId: '157336:0:0',
      title: 'Interstellar (2014)',
      mediaType: 'video',
      streamUrl: 'https://cdn.example.org/interstellar.mp4',
      durationSeconds: 4200
    }
  ]);

  const s1 = h.qm.getSession(-100999);
  assert.equal(pinnedCalls.length, 1, 'Active Play Card must be auto-pinned in group');
  assert.equal(pinnedCalls[0].opts?.disable_notification, true);
  assert.equal(h.voiceCalls.play.at(-1)?.opts?.vcTitle, 'Inception (2010)');
  s1.positionSeconds = 742;
  await h.qm.shutdown();

  const saved = h.app.db.getSetting('music.activePlaybackSnapshots', {});
  assert.ok(saved['-100999']);
  assert.equal(saved['-100999'].positionSeconds, 742);
  assert.equal(saved['-100999'].currentTrack.title, 'Inception (2010)');
  assert.equal(saved['-100999'].movieUpcoming.length, 1);

  // Simulate fresh bot startup sharing the same DB & voice client
  const restartedVoiceCalls = [];
  const restartedVoice = {
    play: async (_id, _url, opts) => { restartedVoiceCalls.push({ op: 'play', ...opts }); return { ok: true, account_alias: 'one' }; },
    pause: async () => { restartedVoiceCalls.push({ op: 'pause' }); return { ok: true }; },
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    setup: async () => ({ ok: true }),
    seek: async (_id, secs) => ({ ok: true, position_seconds: secs }),
    getStatus: async () => ({ ok: true, active: false })
  };
  const restartedApp = { ...h.app };
  const qm2 = new QueueManager({ app: restartedApp, voiceClient: restartedVoice, db: h.app.db, pollMs: 0 });
  restartedApp.musicQueueManager = qm2;
  t.after(async () => qm2.shutdown());

  const restoredChats = await qm2.restoreActiveSessions({ api: h.api });
  assert.deepEqual(restoredChats, [-100999]);
  assert.equal(restartedVoiceCalls[0].op, 'play');
  assert.equal(restartedVoiceCalls[0].startSeconds, 742);
  assert.equal(restartedVoiceCalls[0].vcTitle, 'Inception (2010)');
  const s2 = qm2.getSession(-100999);
  assert.equal(s2.currentTrack.title, 'Inception (2010)');
  assert.equal(s2.positionSeconds, 742);
  assert.equal(s2.movieUpcoming.length, 1);
  assert.equal(s2.movieUpcoming[0].title, 'Interstellar (2014)');
  assert.equal(s2.pinned, true);

  // Explicit /stop clears persisted snapshot so stopped sessions do not auto-resume later
  await qm2.stop(-100999);
  assert.equal(h.app.db.getSetting('music.activePlaybackSnapshots', {})['-100999'], undefined);
});

test('Forward (+30s), Reverse (-30s), Next, Prev work rapidly without expiry errors and auto-replace 48h cards', async (t) => {
  const h = buildTestHarness(t);
  const pinnedCalls = [];
  h.api.pinChatMessage = async (chatId, msgId, opts) => {
    pinnedCalls.push({ chatId, msgId, opts });
    return true;
  };
  h.api.call = async (method, params = {}) => {
    if (method === 'pinChatMessage') {
      pinnedCalls.push({ chatId: params.chat_id, msgId: params.message_id, opts: { disable_notification: params.disable_notification } });
      return true;
    }
    return { ok: true };
  };
  h.api.getChat = async (id) => ({ id, type: 'supergroup', title: 'Cinema Room' });

  const voiceSeekCalls = [];
  const origSeek = h.app.voiceClient?.seek;
  void origSeek;

  await h.qm.addMany(-100888, [
    {
      provider: 'movie',
      providerId: 'm1:0:0',
      title: 'Movie One',
      mediaType: 'video',
      streamUrl: 'https://cdn.example.org/m1.mp4',
      capabilities: { seek: true, video: true } // durationSeconds intentionally omitted
    },
    {
      provider: 'movie',
      providerId: 'm2:0:0',
      title: 'Movie Two',
      mediaType: 'video',
      streamUrl: 'https://cdn.example.org/m2.mp4',
      durationSeconds: 300,
      capabilities: { seek: true, video: true }
    },
    {
      provider: 'movie',
      providerId: 'm3:0:0',
      title: 'Movie Three',
      mediaType: 'video',
      streamUrl: 'https://cdn.example.org/m3.mp4',
      durationSeconds: 300,
      capabilities: { seek: true, video: true }
    }
  ]);

  // Override voice.seek to verify numeric return + unknown duration seek works cleanly
  h.qm.voice.seek = async (_id, secs) => {
    voiceSeekCalls.push(secs);
    return { ok: true, position_seconds: secs };
  };

  const s = h.qm.getSession(-100888);
  const ctx = h.makeCtx(-100888);
  await h.service.player(ctx, -100888);
  const liveMsgId = s.screenMessageId;
  const staleRev = String(s.controlRevision || 0);

  // Simulate transient null clock before first status poll
  s.positionSeconds = null;

  // Rapidly tap +30s twice and -30s once with the older controlRevision on the live card
  await h.service.control({ ...ctx, query: { id: 'q1' }, messageId: liveMsgId }, 'seekby', ['30', staleRev]);
  await h.service.control({ ...ctx, query: { id: 'q2' }, messageId: liveMsgId }, 'seekby', ['30', staleRev]);
  await h.service.control({ ...ctx, query: { id: 'q3' }, messageId: liveMsgId }, 'seekby', ['-30', staleRev]);

  assert.deepEqual(voiceSeekCalls, [30, 60, 30]);
  assert.equal(s.positionSeconds, 30);

  // VC Name row reflects currently playing movie title alongside chat label
  const cinemaCard = h.screen.renderCinemaPlayer(s);
  assert.match(JSON.stringify(cinemaCard), /Movie One · Cinema Room/);

  // Next -> Next -> Prev -> Prev walks history backwards cleanly without STALE_PLAYER/SLOW_DOWN
  await h.service.control({ ...ctx, query: { id: 'q4' }, messageId: liveMsgId }, 'skip', [staleRev]);
  assert.equal(s.currentTrack.title, 'Movie Two');
  await h.service.control({ ...ctx, query: { id: 'q5' }, messageId: liveMsgId }, 'skip', [staleRev]);
  assert.equal(s.currentTrack.title, 'Movie Three');
  await h.service.control({ ...ctx, query: { id: 'q6' }, messageId: liveMsgId }, 'previous', [staleRev]);
  assert.equal(s.currentTrack.title, 'Movie Two');
  await h.service.control({ ...ctx, query: { id: 'q7' }, messageId: liveMsgId }, 'previous', [staleRev]);
  assert.equal(s.currentTrack.title, 'Movie One');

  // Destructive actions with wrong revision still throw STALE_PLAYER
  await assert.rejects(
    h.service.control({ ...ctx, query: { id: 'q8' }, messageId: liveMsgId }, 'mclear', ['999999']),
    (e) => e.code === 'STALE_PLAYER'
  );

  // 48h MESSAGE_EDIT_TIME_EXPIRED on card update automatically replaces & pins new card
  const origEdit = h.api.editMessageRich;
  h.api.editMessageRich = async () => {
    const err = new Error('Bad Request: MESSAGE_EDIT_TIME_EXPIRED');
    err.description = 'Bad Request: MESSAGE_EDIT_TIME_EXPIRED';
    throw err;
  };
  await h.qm.updatePlayerCard(-100888, { forceEdit: true });
  h.api.editMessageRich = origEdit;
  assert.notEqual(s.screenMessageId, liveMsgId);
  assert.ok(pinnedCalls.some((p) => p.msgId === s.screenMessageId));
});

test('Call-end resume preserves exact movie position across idle, paused/playing races, setup vc_title, and bot restart', async (t) => {
  const h = buildTestHarness(t);
  let callActive = true;
  let lastEndedPos = null;
  let livePos = 1845;
  const setupCalls = [];

  h.app.voiceClient.accounts = async () => ({ accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] });
  h.app.voiceClient.setup = async (id, stage, opts = {}) => {
    setupCalls.push({ id, stage, ...opts });
    if (stage === 'identity') return { ok: true, account_alias: 'acc1', user_id: 555 };
    if (stage === 'start') {
      callActive = true;
      return { ok: true, account_alias: 'acc1', call_ready: true, created: true };
    }
    return { ok: true, account_alias: 'acc1' };
  };
  const origPlay = h.app.voiceClient.play;
  h.app.voiceClient.play = async (id, source, opts = {}) => {
    callActive = true;
    return origPlay(id, source, opts);
  };
  h.app.voiceClient.resume = async () => {
    if (!callActive) {
      const err = new Error('No active call');
      err.code = 'NO_ACTIVE_CALL';
      throw err;
    }
    return { ok: true };
  };
  h.app.voiceClient.getStatus = async () => {
    const sess = h.qm.getSession(-100777);
    return callActive
      ? { ok: true, active: true, info: { status: 'playing', playback_id: sess.playbackId, position_seconds: livePos, volume: 100 } }
      : { ok: true, active: false, last_position_seconds: lastEndedPos };
  };

  await h.qm.addMovies(-100777, [{
    provider: 'movie',
    providerId: 'mov-call-end:0:0',
    title: 'Edge of Tomorrow',
    streamUrl: 'https://cdn.example.com/edge.m3u8',
    artwork: 'https://image.tmdb.org/t/p/w500/edge.jpg',
    mediaType: 'video',
    durationSeconds: 6780,
    capabilities: { seek: true, video: true }
  }], { playNow: true });

  const s = h.qm.getSession(-100777);
  const ctx = h.makeCtx(-100777);
  await h.service.player(ctx, -100777);
  const liveMsgId = s.screenMessageId;
  assert.equal(s.status, 'playing');

  // Poll picks up 1845s (30:45), then call drops even while local positionSeconds was temporarily nulled
  await h.qm.reconcile();
  assert.equal(s.positionSeconds, 1845);
  assert.equal(s.lastKnownPositionSeconds, 1845);
  s.positionSeconds = null;

  // 1. Call ends (!r.active) -> retains movie at index 0 with 1845s and renders Saved Card + Poster
  callActive = false;
  lastEndedPos = 1845;
  await h.qm.reconcile();
  assert.equal(s.connected, false);
  assert.equal(s.status, 'idle');
  assert.equal(s.currentTrack, null);
  assert.equal(s.movieUpcoming.length, 1);
  assert.equal(s.movieUpcoming[0].resumePositionSeconds, 1845);
  assert.match(s.lastNotice, /Voice chat ended.*30:45.*Resume/);

  const endedCard = h.screen.renderCinemaPlayer(s);
  assert.equal(endedCard.blocks.find((b) => b.type === 'photo')?.photo?.media, 'https://image.tmdb.org/t/p/w500/edge.jpg');
  assert.match(JSON.stringify(endedCard), /Saved at 30:45/);
  assert.match(JSON.stringify(endedCard), /▶ Resume/);

  // 2. Bot restarts while call-ended -> restores idle resumable queue & 1845s without auto-creating closed VC
  const playCountBeforeBoot = h.voiceCalls.play.length;
  const { QueueManager } = await import('../src/music/queueManager.js');
  const qmBoot = new QueueManager({ app: { ...h.app }, voiceClient: h.app.voiceClient, db: h.app.db, pollMs: 0 });
  t.after(() => qmBoot.shutdown());
  await qmBoot.restoreActiveSessions({ api: h.api });
  assert.equal(h.voiceCalls.play.length, playCountBeforeBoot);
  const sBoot = qmBoot.getSession(-100777);
  assert.equal(sBoot.status, 'idle');
  assert.equal(sBoot.callEnded, true);
  assert.equal(sBoot.movieUpcoming[0].resumePositionSeconds, 1845);
  assert.equal(sBoot.screenMessageId, liveMsgId);

  // 3. Tapping ▶ Resume via MusicService prepares VC with vc_title = movie title and resumes at 1845s
  setupCalls.length = 0;
  await h.service.control({ ...ctx, query: { id: 'q-res' }, messageId: liveMsgId }, 'resume', [String(s.controlRevision || 0)]);
  const startSetup = setupCalls.find((c) => c.stage === 'start');
  assert.equal(startSetup?.vc_title, 'Edge of Tomorrow');
  assert.equal(h.voiceCalls.play.at(-1).opts.startSeconds, 1845);
  assert.equal(s.status, 'playing');

  // 4. Race A: User pauses, call ends silently in Telegram, user immediately taps Resume before poll
  await h.qm.pause(-100777);
  s.positionSeconds = 2110;
  s.lastKnownPositionSeconds = 2110;
  callActive = false;
  lastEndedPos = 2110;
  const pausedResumed = await h.qm.resume(-100777);
  assert.ok(pausedResumed);
  assert.equal(h.voiceCalls.play.at(-1).opts.startSeconds, 2110);
  assert.equal(s.currentTrack.title, 'Edge of Tomorrow');

  // 5. Race B: Status is still locally 'playing', call ends in Telegram, user runs /resume before poll
  livePos = 2590;
  await h.qm.reconcile();
  callActive = false;
  lastEndedPos = 2590;
  const raceResumed = await h.qm.resume(-100777);
  assert.ok(raceResumed);
  assert.equal(h.voiceCalls.play.at(-1).opts.startSeconds, 2590);
  assert.equal(s.currentTrack.title, 'Edge of Tomorrow');
});

test('Active Playing Card search stays isolated in Groups/Channels and sets overlayView in DM Channel Panels', async (t) => {
  const h = buildTestHarness(t);
  const groupCtx = h.makeCtx(-10050, { isChannel: false });
  const session = h.qm.getSession(-10050);
  session.prepared = true;

  // 1. Start playing a movie in Group so active Playing Card exists at playerMsgId
  await h.qm.addMovies(-10050, [{
    id: 'movie:27205',
    provider: 'movie',
    title: 'Inception (2010)',
    mediaType: 'video',
    streamUrl: 'https://cdn.example/inception.mkv',
    durationSeconds: 7200,
    capabilities: { stream: true, seek: true, video: true }
  }], { playNow: true });
  await h.service.player(groupCtx, -10050);

  const playerMsgId = session.screenMessageId;
  assert.ok(playerMsgId);
  assert.equal(session.status, 'playing');

  // 2. User taps Movies button right on the active Playing Card -> opens a separate Search Card, leaving Playing Card intact
  const editedBeforeSearch = h.editedMessages.filter((e) => Number(e.message_id) === Number(playerMsgId)).length;
  await h.screen.handle({ ...groupCtx, query: { id: 'q-open-hub' }, messageId: playerMsgId }, 'moviehub', []);
  const hubSent = h.sentMessages.at(-1);
  assert.ok(hubSent?.message_id && hubSent.message_id !== playerMsgId, 'Movie hub must open as a separate card while playing');
  assert.match(JSON.stringify(hubSent.rich), /Movie & Series Stream/);
  const editedAfterHub = h.editedMessages.filter((e) => Number(e.message_id) === Number(playerMsgId)).length;
  assert.equal(editedAfterHub, editedBeforeSearch, 'Active Playing Card must not be overwritten by Movie Hub');

  // 3. Running reconcile / updatePlayerCard must not overwrite the separate Movie Hub card
  const searchMs = h.app.movieSessions.getLatestForChat(-10050);
  assert.equal(searchMs.messageId, hubSent.message_id);
  const editsToSearchBefore = h.editedMessages.filter((e) => Number(e.message_id) === Number(searchMs.messageId)).length;
  await h.qm.updatePlayerCard(-10050, { forceEdit: true });
  const editsToSearchAfter = h.editedMessages.filter((e) => Number(e.message_id) === Number(searchMs.messageId)).length;
  assert.equal(editsToSearchAfter, editsToSearchBefore, 'Reconcile must not overwrite Movie Search card back to Player Card');

  // 4. DM Channel Panel: opening movie sets overlayView='movie' so ChannelPanels.update() never snaps panel back mid-search
  h.api.me = { id: 999, username: 'LancyBot' };
  h.api.getChat = async (id) => ({ id, type: Number(id) === -10011 ? 'channel' : 'private', title: 'Movie Channel' });
  h.api.getChatMember = async () => ({ status: 'administrator', can_post_messages: true });
  const chanSession = h.qm.getSession(-10011);
  chanSession.isChannel = true;
  chanSession.title = 'Movie Channel';
  const dmCtx = h.makeCtx(10, { isChannel: false });
  const panel = await h.app.music.channelPanels.open(dmCtx, chanSession);
  const movieWire = PANEL_ACTIONS.indexOf('movie').toString(36);
  const pcCtx = { ...dmCtx, messageId: panel.screenMessageId, query: { id: 'q-dm-mv', message: { message_id: panel.screenMessageId, chat: { id: 10 } } } };

  await h.screen.handle(pcCtx, 'pc', [panel.panelToken, movieWire, 'hub', '0']);
  assert.equal(panel.overlayView, 'movie');
  const editsBeforePanelTick = h.editedMessages.length;
  await h.qm.updatePlayerCard(-10011);
  assert.equal(h.editedMessages.length, editsBeforePanelTick, 'Reconcile must not snap DM panel back while overlayView is active');
});

test('MovieStreamResolver handles punkflix Referer + master HLS audio/VTT subs, rejects preview clips, supports Zendaya DASH, and reports future releaseDates', async () => {
  const tmpSubDir = mkdtempSync(join(tmpdir(), 'lancy-mv-res-'));
  const srv = new VideoStreamingServer({ port: 0, cacheDir: tmpSubDir, audioCacheDir: tmpSubDir });
  await srv.start();

  try {
    // 1. Master HLS with #EXT-X-MEDIA AUDIO + punkflix.net JSON signed VTT + cinezo Referer enforcement
    const subSvc = new SubtitleService({
      cacheDir: tmpSubDir,
      fetchImpl: async (url, opts) => {
        if (String(url).includes('3125aa.vtt')) {
          assert.equal(opts?.headers?.Referer, 'https://player.cinezo.live/');
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => Buffer.from('WEBVTT\n\n00:01.000 --> 00:03.000\nLine one\n\n00:04.000 --> 00:06.000\nLine two\n\n00:07.000 --> 00:09.000\nLine three\n\n00:10.000 --> 00:12.000\nLine four\n\n00:13.000 --> 00:15.000\nLine five\n', 'utf8')
          };
        }
        return { ok: false, status: 404 };
      }
    });

    const mockApi = {
      getPlaybackInfo: async () => ({
        rootStream: {
          hls_url: 'https://media.punkflix.net/s/abc123/index.m3u8',
          duration_ms: 7200_000,
          quality: { resolution: '1920x1080' }
        },
        subtitles: ['English']
      }),
      getMovie: async () => ({ id: '1003596', title: 'Avengers: Doomsday', releaseDate: '2026-12-16' })
    };

    const resolverMaster = new MovieStreamResolver({
      movieApi: mockApi,
      subtitles: subSvc,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async (url, opts) => {
        const u = String(url);
        if (u === 'https://media.punkflix.net/s/abc123/index.m3u8') {
          if (opts?.headers?.Referer !== 'https://player.cinezo.live/') return { ok: false, status: 403, headers: { get: () => 'text/plain' } };
          return {
            ok: true,
            status: 200,
            url: u,
            headers: { get: () => 'application/vnd.apple.mpegurl' },
            text: async () => [
              '#EXTM3U',
              '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="aud_en.m3u8"',
              '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",URI="broken_sub.m3u8"',
              '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud",SUBTITLES="sub"',
              'vid_1080.m3u8'
            ].join('\n')
          };
        }
        if (u === 'https://media.punkflix.net/s/abc123/vid_1080.m3u8') {
          return {
            ok: true,
            status: 200,
            url: u,
            headers: { get: () => 'application/vnd.apple.mpegurl' },
            text: async () => '#EXTM3U\n#EXTINF:3600.0,\nseg0.m4s\n#EXTINF:3600.0,\nseg1.m4s\n#EXT-X-ENDLIST\n'
          };
        }
        if (u === 'https://media.punkflix.net/s/abc123/seg0.m4s') {
          return { ok: true, status: 206, headers: { get: () => 'video/mp4' } };
        }
        if (u === 'https://punkflix.net/movie/27205.json') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subtitles: [{ lang: 'en', url: 'https://media.punkflix.net/subs/3125aa.vtt?k=sig' }]
            })
          };
        }
        return { ok: false, status: 404 };
      }
    });

    const masterRes = await resolverMaster.resolve({ type: 'movie', id: '27205', title: 'Inception', year: 2010, durationSeconds: 7200 });
    assert.equal(masterRes.ok, true);
    assert.equal(masterRes.source, 'movie_api_root');
    assert.equal(masterRes.track.streamUrl, 'https://media.punkflix.net/s/abc123/index.m3u8', 'Must keep master URL with #EXT-X-MEDIA AUDIO tracks intact');
    assert.equal(masterRes.track.streamHeaders.Referer, 'https://player.cinezo.live/');
    assert.ok(masterRes.subtitles?.found && masterRes.subtitles.cues.length === 5);

    // 2. Rejects index_preview & <480s VOD previews for feature runtime, while resolving valid Zendaya DASH .mpd over Sadie AND proxying <BaseURL>
    const upstreamMpd = http.createServer((req, res) => {
      if (req.headers.referer !== 'https://player.cinezo.live/') {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (req.url === '/heartland.mpd') {
        res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
        res.end(`<?xml version="1.0"?><MPD mediaPresentationDuration="PT1H53M58S"><BaseURL>http://127.0.0.1:${upstreamPort}/seg/</BaseURL><Period><AdaptationSet><Representation id="0" width="1920" height="1080"><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`);
        return;
      }
      if (req.url === '/seg/init-0.m4s') {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/4' });
        res.end(Buffer.from('INIT'));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => upstreamMpd.listen(0, '127.0.0.1', r));
    const upstreamPort = upstreamMpd.address().port;

    try {
      const resolverDash = new MovieStreamResolver({
        movieApi: null,
        subtitles: null,
        enableYtDlp: false,
        enableWebFallback: false,
        fetchImpl: async (url, opts) => {
          const u = String(url);
          if (u.startsWith(`http://127.0.0.1:${upstreamPort}`)) return fetch(u, opts);
          if (u.includes('sources=sadie')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                source: { url: 'https://cdn.example/720/index_preview_new_266.m3u8', type: 'hls' }
              })
            };
          }
          if (u.includes('sources=zendaya')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                source: { url: `http://127.0.0.1:${upstreamPort}/heartland.mpd`, type: 'dash' }
              })
            };
          }
          return { ok: false, status: 404 };
        }
      });

      const dashRes = await resolverDash.resolve({ type: 'movie', id: '1543469', title: 'Heartland', year: 2026, durationSeconds: 6800, fetchSubtitles: false });
      assert.equal(dashRes.ok, true);
      assert.equal(dashRes.track.isDash, true);
      assert.equal(dashRes.track.format, 'dash');
      assert.match(dashRes.track.qualityLabel || dashRes.track.artist, /1080p/);

      const proxiedMpdUrl = srv.registerRemoteStream({
        url: dashRes.track.streamUrl,
        headers: dashRes.track.streamHeaders,
        isDash: true,
        contentType: 'application/dash+xml'
      });
      assert.match(proxiedMpdUrl, /\.mpd$/);
      const mpdXml = await fetch(proxiedMpdUrl).then((r) => r.text());
      const rewrittenBase = mpdXml.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
      assert.match(rewrittenBase || '', /\/movie-proxy-base\/[a-f0-9]+\//);
      const proxiedInit = await fetch(`${rewrittenBase}init-0.m4s`);
      assert.equal(proxiedInit.status, 200);
      assert.equal(await proxiedInit.text(), 'INIT');
    } finally {
      await new Promise((r) => upstreamMpd.close(r));
    }

    // 3. Unreleased future release reports clear release date notice instead of generic failure
    const futureResolver = new MovieStreamResolver({
      movieApi: mockApi,
      subtitles: null,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async () => ({ ok: false, status: 404 })
    });
    const unreleasedRes = await futureResolver.resolve({ type: 'movie', id: '1003596', title: 'Avengers: Doomsday', releaseDate: '2026-12-16', fetchSubtitles: false });
    assert.equal(unreleasedRes.ok, false);
    assert.match(unreleasedRes.reason, /2026-12-16/);
  } finally {
    await srv.stop();
    rmSync(tmpSubDir, { recursive: true, force: true });
  }
});

test('MovieApiClient.trending filters unreleased future films and merges fresh movie/tv results cleanly', async () => {
  let dayAllHits = 0;
  const api = new MovieApiClient({
    baseUrl: 'https://example.test/api',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/trending?window=day&type=all')) {
        dayAllHits++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { provider_id: '1003596', type: 'movie', title: 'Avengers: Doomsday', release_date: '2099-12-16' },
              { provider_id: '27205', type: 'movie', title: 'Inception', release_date: '2010-07-16' }
            ]
          })
        };
      }
      if (u.includes('/trending?window=day&type=tv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { provider_id: '5920', type: 'tv', title: 'The Mentalist', release_date: '2008-09-23' },
              { provider_id: '27205', type: 'movie', title: 'Inception', release_date: '2010-07-16' }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  const t1 = await api.trending({ window: 'day', type: 'all', page: 1 });
  assert.equal(t1.results.some((r) => r.id === '1003596'), false, 'Upcoming future release must be excluded from Trending');
  assert.deepEqual(t1.results.map((r) => r.id), ['27205', '5920']);
  assert.equal(dayAllHits, 1);

  await api.trending({ window: 'day', type: 'all', page: 1, forceRefresh: true });
  assert.equal(dayAllHits, 2, 'forceRefresh must bypass Trending TTL cache');
});

test('CinemaVcAnnouncer notifies scoped bot_users with existing/fallback links, ignores non-admin linkless GCs & replays/resumes, and handles calert mute', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-cinema-announce-'));
  const db = new Database(join(dir, 'test.sqlite'));
  db.migrate();
  try {
    // Main bot users (bot_id = 0): active (1001, 1002), banned (1003), muted (1004)
    db.run('INSERT INTO bot_users (bot_id, tg_id, username, first_name, is_banned) VALUES (?, ?, ?, ?, ?)', 0, 1001, 'alice', 'Alice', 0);
    db.run('INSERT INTO bot_users (bot_id, tg_id, username, first_name, is_banned) VALUES (?, ?, ?, ?, ?)', 0, 1002, 'bob', 'Bob', 0);
    db.run('INSERT INTO bot_users (bot_id, tg_id, username, first_name, is_banned) VALUES (?, ?, ?, ?, ?)', 0, 1003, 'banned', 'Banned', 1);
    db.run('INSERT INTO bot_users (bot_id, tg_id, username, first_name, is_banned) VALUES (?, ?, ?, ?, ?)', 0, 1004, 'muted', 'Muted', 0);
    db.setUserSetting(1004, 'cinema.vcNotifications', false);
    // Cloned bot user (bot_id = 7)
    db.run('INSERT INTO bot_users (bot_id, tg_id, username, first_name, is_banned) VALUES (?, ?, ?, ?, ?)', 7, 2001, 'cloneuser', 'Clone', 0);

    const mainDms = [];
    const cloneDms = [];
    const apiCallLog = [];

    const mainApi = {
      me: { id: 999, username: 'LancyMainBot' },
      getChat: async (cid) => {
        if (cid === -1001) return { id: cid, type: 'supergroup', title: 'Movie Night Lounge', username: 'movienightlounge' };
        if (cid === -1002) return { id: cid, type: 'supergroup', title: 'VIP Existing Link', invite_link: 'https://t.me/+ExistingLink777' };
        if (cid === -1003) return { id: cid, type: 'supergroup', title: 'Private Admin GC' };
        if (cid === -1004) return { id: cid, type: 'supergroup', title: 'Restricted Member GC' };
        return { id: cid, type: 'supergroup', title: 'Unknown GC' };
      },
      call: async (method, params) => {
        apiCallLog.push({ method, chatId: params?.chat_id });
        if (method === 'createChatInviteLink' && params?.chat_id === -1003) {
          return { invite_link: 'https://t.me/+GeneratedFallback99' };
        }
        if (params?.chat_id === -1004) {
          const err = new Error('Bad Request: not enough rights to manage invite links');
          err.error_code = 400;
          throw err;
        }
        throw new Error('unexpected call');
      },
      sendRichMessage: async (uid, rich) => {
        mainDms.push({ uid, rich });
        return { message_id: mainDms.length };
      },
      answerCallbackQuery: async () => true
    };

    const cloneApi = {
      me: { id: 777, username: 'CloneCinemaBot' },
      getChat: async (cid) => ({ id: cid, type: 'supergroup', title: 'Clone Cinema', username: 'clonecinema' }),
      sendRichMessage: async (uid, rich) => {
        cloneDms.push({ uid, rich });
        return { message_id: cloneDms.length };
      }
    };

    const app = {
      db,
      settings: { get: (k) => (k === 'music.cinemaAnnounceEnabled' ? true : undefined) },
      telegram: { api: mainApi, botUsername: 'LancyMainBot' },
      musicQueueManager: { closed: false }
    };
    const announcer = new CinemaVcAnnouncer({ app, db, cooldownMs: 3600_000, pacingMs: 0 });

    const barbieTrack = {
      provider: 'movie',
      title: 'Barbie and the Three Musketeers (2009)',
      mediaType: 'video',
      year: 2009,
      rating: 7.4,
      genres: ['Animation', 'Family'],
      artwork: 'https://image.tmdb.org/t/p/w500/barbie.jpg',
      overview: 'Corinne heads to Paris to pursue her dream of becoming a Musketeer.'
    };

    // 1. Public group -> sends rich DMs to 1001 & 1002 only
    await announcer.onTrackStart({ chatId: -1001, track: barbieTrack, session: { botId: 0, api: mainApi } });
    await announcer.flush();
    assert.deepEqual(mainDms.map((d) => d.uid).sort((a, b) => a - b), [1001, 1002], 'Must deliver only to non-banned, non-muted users of bot_id=0');
    const dmJson = JSON.stringify(mainDms[0].rich);
    assert.match(dmJson, /Barbie and the Three Musketeers \(2009\)/);
    assert.match(dmJson, /Movie Night Lounge/);
    assert.match(dmJson, /https:\/\/t\.me\/movienightlounge/);
    assert.match(dmJson, /https:\/\/t\.me\/movienightlounge\?voicechat/);
    assert.match(dmJson, /calert/);

    // 2. Replaying the same movie in the same group must NOT resend DMs
    const replayRes = await announcer.onTrackStart({ chatId: -1001, track: barbieTrack, session: { botId: 0, api: mainApi } });
    assert.equal(replayRes.skipped, 'already_announced');
    assert.equal(mainDms.length, 2);

    // 3. Different title triggers notification, and next episode of SAME TV show does NOT re-notify
    assert.equal(normalizeAnnounceTitleKey('Breaking Bad · S01E01 — Pilot'), 'breaking bad');
    assert.equal(normalizeAnnounceTitleKey('Breaking Bad · S02E05 — Breakage'), 'breaking bad');
    await announcer.onTrackStart({
      chatId: -1001,
      track: { provider: 'movie', title: 'Breaking Bad · S01E01 — Pilot', mediaType: 'video', seriesId: '1396', seasonNumber: 1 },
      session: { botId: 0, api: mainApi }
    });
    await announcer.flush();
    assert.equal(mainDms.length, 4, 'Switching to a new title must announce once');

    const ep2Res = await announcer.onTrackStart({
      chatId: -1001,
      track: { provider: 'movie', title: 'Breaking Bad · S01E02 — Cat\'s in the Bag', mediaType: 'video', seriesId: '1396', seasonNumber: 1 },
      session: { botId: 0, api: mainApi }
    });
    assert.equal(ep2Res.skipped, 'already_announced', 'Subsequent TV episode of same show must not spam DMs');
    assert.equal(mainDms.length, 4);

    // 4. Restart / Call-end auto-resume is suppressed
    const resumeSess = { botId: 0, api: mainApi, _suppressCinemaAnnounce: true };
    const supRes = await announcer.onTrackStart({ chatId: -1001, track: { provider: 'movie', title: 'Inception (2010)', mediaType: 'video' }, session: resumeSess });
    assert.equal(supRes.skipped, 'suppressed_resume');
    assert.equal(resumeSess._suppressCinemaAnnounce, false);
    assert.equal(mainDms.length, 4);

    // 5. Private GC with existing chat.invite_link reuses existing link without calling createChatInviteLink
    const callsBeforeExisting = apiCallLog.length;
    await announcer.onTrackStart({ chatId: -1002, track: barbieTrack, session: { botId: 0, api: mainApi } });
    await announcer.flush();
    assert.equal(apiCallLog.length, callsBeforeExisting, 'Existing invite_link must be reused directly');
    assert.equal(mainDms.length, 6);
    assert.match(JSON.stringify(mainDms[4].rich), /ExistingLink777/);

    // 6. Private GC without invite_link falls back to createChatInviteLink
    await announcer.onTrackStart({ chatId: -1003, track: barbieTrack, session: { botId: 0, api: mainApi } });
    await announcer.flush();
    assert.equal(mainDms.length, 8);
    assert.match(JSON.stringify(mainDms[6].rich), /GeneratedFallback99/);

    // 7. Private GC WITHOUT admin invite permissions fails link resolution silently & NEVER interrupts VC
    const noPermRes = await announcer.onTrackStart({ chatId: -1004, track: barbieTrack, session: { botId: 0, api: mainApi } });
    assert.equal(noPermRes.skipped, 'no_invite_link');
    assert.equal(mainDms.length, 8);

    // 8. Cloned bot only notifies its own bot_id users
    await announcer.onTrackStart({ chatId: -1005, track: barbieTrack, session: { botId: 7, api: cloneApi, botUsername: 'CloneCinemaBot' } });
    await announcer.flush();
    assert.deepEqual(cloneDms.map((d) => d.uid), [2001]);

    // 9. calert mute/unmute button toggles per-user preference cleanly via music screen
    const h = buildTestHarness(t);
    const muteCtx = h.makeCtx(1001, {
      tgId: 1001,
      user: { id: 1001, first_name: 'Alice' },
      messageId: 50,
      query: { id: 'cb_mute' }
    });
    await h.screen.handle(muteCtx, 'calert', ['off']);
    assert.equal(h.app.db.getUserSetting(1001, 'cinema.vcNotifications', true), false);
    assert.match(h.callbackAnswers[0]?.text || '', /muted/i);
    assert.match(JSON.stringify(h.editedMessages[0]?.rich || {}), /Re-enable Cinema Alerts/);

    await h.screen.handle(muteCtx, 'calert', ['on']);
    assert.equal(h.app.db.getUserSetting(1001, 'cinema.vcNotifications', true), true);
    assert.match(h.callbackAnswers[1]?.text || '', /enabled/i);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('movieUi.renderResults displays full untruncated movie names & details in card body and clean numbered buttons only', async (t) => {
  const h = buildTestHarness(t);
  const ms = h.app.movieSessions.create({ chatId: -777, userId: 10, view: 'results' });
  ms.query = 'Barbie Musketeers';
  ms.results = [
    {
      id: '23566',
      type: 'movie',
      title: 'Barbie and the Three Musketeers — Extended Anniversary Collector Showcase Edition',
      year: 2009,
      rating: 7.4,
      genres: ['Animation', 'Family'],
      overview: 'Corinne leaves her countryside home for Paris hoping to become a royal Musketeer.'
    },
    {
      id: '1396',
      type: 'tv',
      title: 'Breaking Bad',
      year: 2008,
      rating: 9.5,
      genres: ['Drama', 'Crime'],
      overview: 'A chemistry teacher enters a dangerous criminal underworld.'
    },
    {
      id: '27205',
      type: 'movie',
      title: 'Inception',
      year: 2010,
      rating: 8.8,
      genres: ['Sci-Fi', 'Action'],
      overview: 'A skilled thief enters shared dreams to plant an idea.'
    },
    {
      id: '122',
      type: 'movie',
      title: 'The Lord of the Rings: The Return of the King',
      year: 2003,
      rating: 8.5,
      genres: ['Adventure', 'Fantasy'],
      overview: 'Aragorn assumes the throne as Sauron attacks Minas Tirith.'
    },
    {
      id: '94605',
      type: 'tv',
      title: 'Arcane',
      year: 2021,
      rating: 8.7,
      genres: ['Animation', 'Action'],
      overview: 'Sisters fight on opposite sides of a war between Piltover and Zaun.'
    }
  ];

  const card = h.screen.movieUi.renderResults(h.makeCtx(-777), ms);
  const extractBlocksText = (blk) => {
    if (!blk) return '';
    if (Array.isArray(blk)) return blk.map(extractBlocksText).join('\n');
    if (blk.type === 'blockquote' || blk.type === 'details') return extractBlocksText(blk.blocks);
    const parts = [];
    if (blk.text) parts.push(richTextToString(blk.text));
    if (blk.credit) parts.push(richTextToString(blk.credit));
    return parts.join('\n');
  };
  const bodyText = extractBlocksText(card.blocks.filter((b) => b.type !== 'buttons'));
  assert.match(bodyText, /Barbie and the Three Musketeers — Extended Anniversary Collector Showcase Edition/);
  assert.match(bodyText, /2009 · ⭐ 7\.4 · Animation, Family/);
  assert.match(bodyText, /Corinne leaves her countryside home for Paris/);
  assert.match(bodyText, /Breaking Bad/);
  assert.match(bodyText, /Inception/);
  assert.match(bodyText, /The Lord of the Rings: The Return of the King/);

  ms.resultPage = 1;
  const page2Card = h.screen.movieUi.renderResults(h.makeCtx(-777), ms);
  const page2Text = extractBlocksText(page2Card.blocks.filter((b) => b.type !== 'buttons'));
  assert.match(page2Text, /Arcane/);
  ms.resultPage = 0;

  const flatButtons = card.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const byOp = (op) => flatButtons.filter((b) => {
    const dec = decodeCallback(b.callback_data || '');
    return dec?.action === 'mv' && dec?.args?.[1] === op;
  });
  assert.equal(byOp('pmi').length, 4);
  assert.equal(byOp('qmi').length, 4);
  assert.equal(byOp('dmi').length, 4);
  assert.deepEqual(
    byOp('pk').map((b) => richTextToString(b.text)),
    ['ℹ️', '📺 Episodes', 'ℹ️', 'ℹ️'],
    'Bot API 10.3 Rich Results card uses compact Play/Queue/Download + link Info / primary Episodes buttons per item (4 per page)'
  );
  assert.deepEqual(byOp('pk').map((b) => b.style), ['link', 'primary', 'link', 'link']);
  assert.ok(byOp('rp').some((b) => richTextToString(b.text).includes('More')));
  assert.ok(byOp('ps').length >= 1);
  assert.ok(byOp('xfu').length >= 1);
  assert.ok(byOp('xca').length >= 1);
  for (const btn of flatButtons) {
    assert.doesNotMatch(richTextToString(btn.text), /Barbie|Musketeers|Inception|Breaking|Rings|Arcane/i);
  }
});

test('MovieStreamResolver enforces strict exact-movie matching against wrong movies, data.meta mismatches, bad slugs, and game playthroughs', async () => {
  // 1. Score guard checks
  assert.ok(scoreTitleMatch('Barbie and the Three Musketeers', 2009, 'Barbie and the Three Musketeers (2009) 1080p 5.1 x264') >= 50);
  assert.ok(scoreTitleMatch('Barbie and the Three Musketeers', 2009, 'The Three Musketeers (2011)') < 0);
  assert.ok(scoreTitleMatch('Barbie and the Three Musketeers', 2009, 'Barbie (2023)') < 0);
  assert.ok(scoreTitleMatch('Barbie and the Three Musketeers', 2009, 'Barbie in a Mermaid Tale (2010)') < 0);

  // 2. Reject wrong meta.id / meta.title, wrong base64 t-token slug, and game playthroughs; play ONLY exact verified match
  const badSlugToken = Buffer.from(JSON.stringify({ r: { slug: 'the-three-musketeers-2011-xyz12345' } })).toString('base64');
  let ytExtractCalled = false;
  const resolverStrict = new MovieStreamResolver({
    movieApi: {
      getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }),
      getMovie: async () => ({
        id: '23566',
        type: 'movie',
        title: 'Barbie and the Three Musketeers',
        year: 2009,
        releaseDate: '2009-09-15',
        imdbId: 'tt1484922',
        runtimeSeconds: 4860
      })
    },
    subtitles: null,
    enableYtDlp: true,
    enableWebFallback: true,
    thenkiri: {
      thenkiriSearch: async () => ({ results: [{ title: 'The Three Musketeers (2011)', url: 'https://t.example/wrong' }] }),
      thenkiriDetails: async () => ({ sources: [] }),
      thenkiriGetLink: async () => null
    },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('proxy1.flikhub.net') && u.includes('sources=berlin')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: { id: 12345, title: 'The Three Musketeers', release_date: '2011-10-14' },
            source: { url: 'https://cdn.example/wrong-musketeers-2011.mp4', type: 'mp4' }
          })
        };
      }
      if (u.includes('sources=zendaya')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            source: { url: `https://cdn.example/stream?t=${encodeURIComponent(badSlugToken)}`, type: 'mp4' }
          })
        };
      }
      if (u.includes('api.dailymotion.com/videos')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            list: [
              { id: 'dm1', title: 'Barbie and the Three Musketeers The Game Full Walkthrough PS2', duration: 4860, url: 'https://dailymotion.com/video/dm1' },
              { id: 'dm2', title: 'The Three Musketeers Full Movie 2011', duration: 4860, url: 'https://dailymotion.com/video/dm2' }
            ]
          })
        };
      }
      if (u.includes('archive.org/advancedsearch')) {
        return {
          ok: true,
          json: async () => ({
            response: {
              docs: [
                { identifier: 'WrongMusketeers', title: 'The Three Musketeers', year: 2011 },
                { identifier: 'Barbie3M2009', title: 'Barbie and the Three Musketeers', year: 2009 }
              ]
            }
          })
        };
      }
      if (u.includes('archive.org/metadata/Barbie3M2009')) {
        return {
          ok: true,
          json: async () => ({
            metadata: { title: 'Barbie and the Three Musketeers (2009)' },
            files: [{ name: 'barbie_three_musketeers_2009_720p.mp4', length: '4860', size: String(700e6) }]
          })
        };
      }
      if (u.includes('archive.org/download/Barbie3M2009/barbie_three_musketeers_2009_720p.mp4')) {
        return { ok: true, status: 206, headers: { get: () => 'video/mp4' } };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
    ytSearchFn: async () => {
      ytExtractCalled = true;
      return [
        { title: 'Barbie and the Three Musketeers Full Game Gameplay', duration: 4860, directStreamUrl: 'https://cdn.example/game.mp4' }
      ];
    }
  });

  const barbieRes = await resolverStrict.resolve({ type: 'movie', id: '23566', title: 'Barbie and the Three Musketeers', fetchSubtitles: false });
  assert.equal(barbieRes.ok, true);
  assert.match(barbieRes.track.streamUrl, /Barbie3M2009\/barbie_three_musketeers_2009_720p\.mp4/);
  assert.equal(barbieRes.track.title, 'Barbie and the Three Musketeers (2009)');

  // When NO verified movie source exists, must fail cleanly instead of returning a wrong film or game video
  const resolverFail = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }) },
    subtitles: null,
    enableYtDlp: true,
    enableWebFallback: true,
    thenkiri: { thenkiriSearch: async () => ({ results: [{ title: 'Barbie (2023)', url: 'https://t.example/b23' }] }), thenkiriDetails: async () => ({ sources: [] }), thenkiriGetLink: async () => null },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    ytSearchFn: async () => [
      { title: 'Barbie and the Three Musketeers The Game Full Walkthrough', duration: 4860, directStreamUrl: 'https://cdn.example/game.mp4' },
      { title: 'The Three Musketeers (2011) Full Movie', duration: 6600, directStreamUrl: 'https://cdn.example/wrong.mp4' }
    ]
  });
  const strictFail = await resolverFail.resolve({ type: 'movie', id: '23566', title: 'Barbie and the Three Musketeers', year: 2009, durationSeconds: 4860, fetchSubtitles: false });
  assert.equal(strictFail.ok, false, 'Must never substitute another movie or game walkthrough');

  // Movies literally titled with "Game" (e.g. The Game (1997)) must still resolve properly
  const resolverLiteralGame = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }) },
    subtitles: null,
    enableYtDlp: true,
    enableWebFallback: false,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    ytSearchFn: async () => [
      { title: 'The Game (1997) Full Feature Movie HD', duration: 7740, directStreamUrl: 'https://cdn.example/the-game-1997.mp4' }
    ]
  });
  const gameFilmRes = await resolverLiteralGame.resolve({ type: 'movie', id: '2649', title: 'The Game', year: 1997, durationSeconds: 7740, fetchSubtitles: false });
  assert.equal(gameFilmRes.ok, true);
  assert.equal(gameFilmRes.track.streamUrl, 'https://cdn.example/the-game-1997.mp4');
  assert.equal(ytExtractCalled, false);
});

test('MovieStreamResolver avoids per-host 429 bursts, handles 429 backoff cleanly, and resolves TV episodes without episodeTitle', async () => {
  const upstreamSrv = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/got_s1e1.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end('<?xml version="1.0"?><MPD mediaPresentationDuration="PT1H1M37S"><BaseURL>http://127.0.0.1:' + upstreamSrv.address().port + '/seg/</BaseURL><Period><AdaptationSet><Representation id="0" width="1920" height="1080"><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>');
      return;
    }
    if (pathname === '/seg/init-0.m4s') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/4' });
      res.end(Buffer.from('INIT'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
  const upPort = upstreamSrv.address().port;

  try {
    const slugS1 = Buffer.from(JSON.stringify({ r: { se: 1, ep: 1, slug: 'game-of-thrones-AQP5Q48Qsq2' } })).toString('base64');
    const slugS4 = Buffer.from(JSON.stringify({ r: { se: 4, ep: 9, slug: 'game-of-thrones-AQP5Q48Qsq2' } })).toString('base64');
    const hostCounts = new Map();
    let flikhub3Hits = 0;

    const resolver = new MovieStreamResolver({
      movieApi: { getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }) },
      subtitles: null,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${upPort}`)) return fetch(u, opts);
        const parsed = new URL(u);
        const host = parsed.host;
        hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
        if (host === 'proxy1.flikhub.net' || host === 'proxy.yenime.net' || host === 'punkflix.net') {
          return { ok: false, status: 429, headers: { get: () => '1' }, json: async () => ({}) };
        }
        if (host === 'proxy3.flikhub.net') {
          flikhub3Hits++;
          const isS4 = parsed.searchParams.get('season') === '4';
          return {
            ok: true,
            status: 200,
            json: async () => ({
              meta: isS4
                ? { id: 63102, name: 'The Watchers on the Wall', season_number: 4, episode_number: 9, air_date: '2014-06-08' }
                : { id: 63056, name: 'Winter Is Coming', season_number: 1, episode_number: 1, air_date: '2011-04-17' },
              source: {
                source: 'zendaya',
                type: 'dash',
                url: `http://127.0.0.1:${upPort}/got_s1e1.mpd?t=${encodeURIComponent(isS4 ? slugS4 : slugS1)}`
              }
            })
          };
        }
        return { ok: false, status: 404 };
      }
    });

    const res = await resolver.resolve({
      type: 'tv',
      id: '1399',
      title: 'Game of Thrones',
      season: 1,
      episode: 1,
      year: 2011,
      durationSeconds: 3697,
      fetchSubtitles: false
    });
    assert.equal(res.ok, true);
    assert.equal(res.track.isDash, true);
    assert.equal(res.track.format, 'dash');
    assert.ok(flikhub3Hits >= 1);
    assert.equal(hostCounts.get('proxy1.flikhub.net'), 1, 'Wave A must send at most 1 request per host without bursting 7 simultaneous calls');
    assert.equal(hostCounts.get('proxy.yenime.net'), 1);

    const resS4 = await resolver.resolve({
      type: 'tv',
      id: '1399',
      title: 'Game of Thrones',
      season: 4,
      episode: 9,
      year: 2011,
      durationSeconds: 3060,
      fetchSubtitles: false
    });
    assert.equal(resS4.ok, true, 'Later seasons airing years after show premiere must still pass episode metadata checks');
    assert.equal(resS4.track.isDash, true);
  } finally {
    await new Promise((r) => upstreamSrv.close(r));
  }
});

test('HLS proxy slices fMP4 #EXT-X-MAP segments on ?start=seek, coalesces rapid +30s click spam, supports custom skip step & anti-misclick layout', async (t) => {
  const { createServer } = await import('node:http');
  const { VideoStreamingServer } = await import('../src/media/streamingServer.js');
  const { parseSeekInput } = await import('../src/music/service.js');
  const { CommandJobProcessor } = await import('../src/core/commandProcessor.js');

  // 1. Test parseSeekInput across relative, absolute, timestamp, and step modes
  assert.deepEqual(parseSeekInput('+45', 100, 3600), { kind: 'relative', delta: 45, targetSeconds: 145 });
  assert.deepEqual(parseSeekInput('-30s', 100, 3600), { kind: 'relative', delta: -30, targetSeconds: 70 });
  assert.deepEqual(parseSeekInput('+2m', 100, 3600), { kind: 'relative', delta: 120, targetSeconds: 220 });
  assert.deepEqual(parseSeekInput('12:30', 100, 3600), { kind: 'absolute', targetSeconds: 750 });
  assert.deepEqual(parseSeekInput('1:05:00', 100, 7200), { kind: 'absolute', targetSeconds: 3900 });
  assert.deepEqual(parseSeekInput('90s', 100, 3600), { kind: 'absolute', targetSeconds: 90 });
  assert.deepEqual(parseSeekInput('step 45s', 100, 3600), { kind: 'step', seconds: 45 });
  assert.deepEqual(parseSeekInput('set 2m', 100, 3600), { kind: 'step', seconds: 120 });

  // 2. Test VideoStreamingServer HLS fMP4 #EXT-X-MAP playlist slicing on ?start=25
  const upstreamHls = createServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,AUDIO="aud"',
        'video.m3u8'
      ].join('\n'));
      return;
    }
    if (req.url === '/video.m3u8' || req.url === '/audio.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:10.000,',
        'seg0.m4s',
        '#EXTINF:10.000,',
        'seg1.m4s',
        '#EXTINF:10.000,',
        'seg2.m4s',
        '#EXTINF:10.000,',
        'seg3.m4s',
        '#EXT-X-ENDLIST'
      ].join('\n'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstreamHls.listen(0, '127.0.0.1', r));
  const hlsPort = upstreamHls.address().port;

  const streamSrv = new VideoStreamingServer({ port: 0, cacheDir: '/tmp' });
  await streamSrv.start();
  try {
    const proxyUrl = streamSrv.registerRemoteStream({
      url: `http://127.0.0.1:${hlsPort}/master.m3u8`,
      isHls: true
    });
    assert.match(proxyUrl, /\.m3u8$/);

    const masterRes = await fetch(`${proxyUrl}?start=25`);
    const masterText = await masterRes.text();
    assert.match(masterText, /\.m3u8\?start=25\.000/);

    const childMatch = masterText.match(/http:\/\/127\.0\.0\.1:\d+\/movie-proxy\/[a-f0-9]+\.m3u8\?start=25\.000/);
    assert.ok(childMatch, 'Master playlist must propagate ?start=25.000 to child renditions');

    const childRes = await fetch(childMatch[0]);
    const childText = await childRes.text();
    assert.match(childText, /#EXT-X-MAP:URI="http:\/\/127\.0\.0\.1:\d+\/movie-proxy\/[a-f0-9]+\.mp4"/);
    assert.match(childText, /#EXT-X-MEDIA-SEQUENCE:2/);
    const segMatches = [...childText.matchAll(/#EXTINF:10\.000,/g)];
    assert.equal(segMatches.length, 2, 'First 2 segments (20s) should be sliced out, leaving seg2 & seg3');
  } finally {
    await streamSrv.stop();
    await new Promise((r) => upstreamHls.close(r));
  }

  // 3. Test rapid click-spam coalescing on +30s, null-clock preservation, custom step & anti-misclick layout
  const h = buildTestHarness(t);
  await h.qm.addMovies(-100999, [
    {
      id: 'mv-mentalist',
      provider: 'movie',
      title: 'The Mentalist · S01E18',
      durationSeconds: 2566,
      streamUrl: 'https://example.com/mentalist.m3u8',
      isHls: true,
      mediaType: 'video',
      capabilities: { seek: true, video: true }
    },
    {
      id: 'mv-next',
      provider: 'movie',
      title: 'The Mentalist · S01E19',
      durationSeconds: 2566,
      streamUrl: 'https://example.com/mentalist19.m3u8',
      isHls: true,
      mediaType: 'video',
      capabilities: { seek: true, video: true }
    }
  ]);

  const seekTargets = [];
  h.qm.voice.seek = async (_id, secs) => {
    await new Promise((r) => setTimeout(r, 25));
    seekTargets.push(secs);
    return { ok: true, position_seconds: secs };
  };

  const s = h.qm.getSession(-100999);
  const ctx = h.makeCtx(-100999);
  await h.service.player(ctx, -100999);
  const liveMsgId = s.screenMessageId;
  const rev = String(s.controlRevision || 0);

  const btnLabel = (b) => Array.isArray(b.text)
    ? b.text.map((x) => (typeof x === 'string' ? x : (x.alternative_text || ''))).join('')
    : String(b.text || '');

  // Verify anti-misclick layout: Row 1 has -30s, Pause, +30s, Custom s; Stop is on the bottom row
  const initialCard = h.screen.renderCinemaPlayer(s);
  const btnBlocks = initialCard.blocks.filter((b) => b.type === 'buttons');
  const row1Texts = btnBlocks[0].buttons.map(btnLabel);
  assert.deepEqual(row1Texts, ['-30s', '⏸ Pause', '+30s', '⏱ Custom s']);
  assert.ok(!row1Texts.some((txt) => /Stop|Next/i.test(txt)), 'Row 1 must not contain Stop or Next near +30s');
  const lastRowTexts = btnBlocks[btnBlocks.length - 1].buttons.map(btnLabel);
  assert.ok(lastRowTexts.some((txt) => /Stop/i.test(txt)), 'Stop must be isolated on the bottom row');

  // Simulate playback at 600s where positionSeconds momentarily becomes null
  s.positionSeconds = null;
  s.lastKnownPositionSeconds = 600;
  s.positionUpdatedAt = Date.now();

  // Enable 60ms coalescing window and fire 4 rapid +30s clicks concurrently through CommandJobProcessor
  h.service.seekCoalesceMs = 60;
  const proc = new CommandJobProcessor({ callbackDedupMs: 650 });
  await Promise.all([1, 2, 3, 4].map((n) =>
    proc.runCallback(
      { chatId: -100999, tgId: ctx.tgId, messageId: liveMsgId, screen: 'music', action: 'seekby', args: ['30', rev] },
      () => h.service.control({ ...ctx, query: { id: `burst-${n}` }, messageId: liveMsgId }, 'seekby', ['30', rev])
    )
  ));

  assert.deepEqual(seekTargets, [720], '4 rapid +30s clicks from 600s (even with null positionSeconds) must coalesce into a single seek to 720s');
  assert.equal(s.positionSeconds, 720);

  // Set custom skip step to 45s via setseekstep and verify Row 1 buttons update to -45s / +45s
  await h.service.control({ ...ctx, query: { id: 'step-45' }, messageId: liveMsgId }, 'setseekstep', ['45', rev]);
  assert.equal(s.seekStepSeconds, 45);
  const updatedCard = h.screen.renderCinemaPlayer(s);
  const updatedRow1 = updatedCard.blocks.filter((b) => b.type === 'buttons')[0].buttons.map(btnLabel);
  assert.deepEqual(updatedRow1, ['-45s', '⏸ Pause', '+45s', '⏱ Custom s']);

  // Custom seek via chat input ("15:00") jumps to 900s
  await h.service.customSeekInput(ctx, '15:00');
  assert.equal(s.positionSeconds, 900);
});

test('StreamingServer prunes MPD to <=720p and aligns HLS master separate audio seek boundaries', async () => {
  const upstream = http.createServer((req, res) => {
    const u = req.url || '/';
    if (u === '/manifest.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end([
        '<?xml version="1.0" encoding="utf-8"?>',
        '<MPD type="static">',
        '  <Period id="0">',
        '    <AdaptationSet id="0" contentType="video">',
        '      <Representation id="0" mimeType="video/mp4" codecs="hev1.1.6.L120.90" bandwidth="1055531" width="1920" height="1080"><SegmentTemplate media="chunk-$RepresentationID$-$Number$.m4s"/></Representation>',
        '      <Representation id="1" mimeType="video/mp4" codecs="hev1.1.6.L93.90" bandwidth="589219" width="1280" height="720"><SegmentTemplate media="chunk-$RepresentationID$-$Number$.m4s"/></Representation>',
        '      <Representation id="2" mimeType="video/mp4" codecs="hev1.1.6.L90.90" bandwidth="353171" width="854" height="480"><SegmentTemplate media="chunk-$RepresentationID$-$Number$.m4s"/></Representation>',
        '    </AdaptationSet>',
        '    <AdaptationSet id="1" contentType="audio">',
        '      <Representation id="3" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000"><SegmentTemplate media="chunk-$RepresentationID$-$Number$.m4s"/></Representation>',
        '    </AdaptationSet>',
        '  </Period>',
        '</MPD>'
      ].join('\n'));
      return;
    }
    if (u === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a720",NAME="Original",DEFAULT=YES,URI="audio.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1080",NAME="Original",DEFAULT=YES,URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="a1080"',
        'v1080.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="a720"',
        'v720.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,AUDIO="a720"',
        'v480.m3u8'
      ].join('\n'));
      return;
    }
    if (u === '/v720.m3u8') {
      // Video segments: 9.0s + 9.0s (=18.0s skipped at seek=20.0s, leaving seg 2 starting at 18.0s!)
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MAP:URI="vinit.mp4"',
        '#EXTINF:9.000,', 'v0.m4s',
        '#EXTINF:9.000,', 'v1.m4s',
        '#EXTINF:9.000,', 'v2.m4s',
        '#EXT-X-ENDLIST'
      ].join('\n'));
      return;
    }
    if (u === '/audio.m3u8') {
      // Audio segments: 6s * 4 -> seeking naively to 20s skips 3 segs (18s), wait at seek=17s -> video skips 9s, naive audio would skip 12s (>9s)!
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MAP:URI="ainit.mp4"',
        '#EXTINF:6.000,', 'a0.m4s',
        '#EXTINF:6.000,', 'a1.m4s',
        '#EXTINF:6.000,', 'a2.m4s',
        '#EXTINF:6.000,', 'a3.m4s',
        '#EXT-X-ENDLIST'
      ].join('\n'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = upstream.address().port;
  const srv = new VideoStreamingServer({ port: 0, cacheDir: '/tmp' });
  await srv.start();

  try {
    // 1. MPD single-representation pruning <=720p
    const mpdUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${port}/manifest.mpd`, isDash: true });
    const mpdBody = await (await fetch(mpdUrl)).text();
    assert.ok(!mpdBody.includes('<Representation id="0"'), '1080p HEVC representation should be pruned');
    assert.ok(mpdBody.includes('<Representation id="1"'), '720p representation should be selected');
    assert.ok(!mpdBody.includes('<Representation id="2"'), '480p representation should be pruned');
    assert.ok(mpdBody.includes('<Representation id="3"'), 'Audio representation must be kept');

    // 2. HLS master variant pruning + aligned audio seek (seek=17.0s -> vSkipped=9.0s -> audio must get start<=8.92s, NOT 17.0s!)
    const hlsUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${port}/master.m3u8`, isHls: true });
    const hlsMaster = await (await fetch(`${hlsUrl}?start=17`)).text();
    assert.ok(!hlsMaster.includes('1920x1080'), '1080p HLS variant must be pruned');
    assert.ok(!hlsMaster.includes('854x480'), '480p HLS variant must be pruned');
    assert.ok(hlsMaster.includes('1280x720'), '720p HLS variant must be kept');
    assert.ok(!hlsMaster.includes('GROUP-ID="a1080"'), 'Unused audio group for pruned 1080p variant must be dropped');

    const audioUri = hlsMaster.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]+URI="([^"]+)"/)?.[1] || '';
    assert.ok(audioUri, 'Rewritten audio media playlist URI must exist');
    const audioStartParam = Number(new URL(audioUri).searchParams.get('start') || 0);
    assert.ok(audioStartParam > 0 && audioStartParam <= 9.0, `Audio seek (${audioStartParam}s) must align <= video segment start (9.0s), not 17.0s`);

    const audioChildText = await (await fetch(audioUri)).text();
    assert.match(audioChildText, /#EXT-X-MEDIA-SEQUENCE:1/, 'Audio should skip only 1 segment (6.0s <= 9.0s video start), not 2 segments (12.0s)');
  } finally {
    await srv.stop();
    await new Promise((r) => upstream.close(r));
  }
});

test('MovieStreamResolver resolves TV episodes with alternate regional slug via verified episode metadata or MPD ProgramInformation Title, and MovieUi avoids duplicate failure log lines', async (t) => {
  const upstreamSrv = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/mako_good.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end('<?xml version="1.0"?><MPD mediaPresentationDuration="PT24M26.5S"><BaseURL>http://127.0.0.1:' + upstreamSrv.address().port + '/seg/</BaseURL><ProgramInformation><Title>Outcasts</Title></ProgramInformation><Period><AdaptationSet contentType="video"><Representation id="0" width="1280" height="720"><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>');
      return;
    }
    if (pathname === '/mako_wrong.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end('<?xml version="1.0"?><MPD mediaPresentationDuration="PT24M26.5S"><BaseURL>http://127.0.0.1:' + upstreamSrv.address().port + '/seg/</BaseURL><ProgramInformation><Title>Completely Different Pilot</Title></ProgramInformation><Period><AdaptationSet contentType="video"><Representation id="0" width="1280" height="720"><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>');
      return;
    }
    if (pathname === '/seg/init-0.m4s') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/4' });
      res.end(Buffer.from('INIT'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
  const upPort = upstreamSrv.address().port;

  try {
    const altSlugToken = Buffer.from(JSON.stringify({ r: { se: 1, ep: 1, slug: 'mako-mermaids-wabnto8voq7' } })).toString('base64');

    // 1. Proxy returns verified TMDB episode meta + alternate regional title slug -> must resolve cleanly even without caller passing episodeTitle
    const resolverWithMeta = new MovieStreamResolver({
      movieApi: {
        getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }),
        getTvSeasonEpisodes: async () => ({
          seriesId: '42025',
          seasonNumber: 1,
          episodes: [{ episodeNumber: 1, title: 'Outcasts', runtimeSeconds: 1440 }]
        })
      },
      subtitles: null,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${upPort}`)) return fetch(u, opts);
        if (u.includes('proxy1.flikhub.net')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              meta: { id: 878009, name: 'Outcasts', season_number: 1, episode_number: 1, air_date: '2013-07-26', runtime: 24 },
              source: { source: 'zendaya', type: 'dash', url: `http://127.0.0.1:${upPort}/mako_good.mpd?t=${encodeURIComponent(altSlugToken)}` }
            })
          };
        }
        return { ok: false, status: 404 };
      }
    });
    const resMeta = await resolverWithMeta.resolve({
      type: 'tv',
      id: '42025',
      title: 'Mako: Island of Secrets',
      season: 1,
      episode: 1,
      year: 2013,
      fetchSubtitles: false
    });
    assert.equal(resMeta.ok, true);
    assert.equal(resMeta.track.title, 'Mako: Island of Secrets · S01E01 — Outcasts');
    assert.equal(resMeta.track.isDash, true);

    // 2. Proxy omits data.meta, alternate slug present -> verified via MPD <ProgramInformation><Title> against episodeTitle
    const resolverMpdTitleOnly = new MovieStreamResolver({
      movieApi: { getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }) },
      subtitles: null,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${upPort}`)) return fetch(u, opts);
        if (u.includes('proxy.yenime.net')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              source: { source: 'zendaya', type: 'dash', url: `http://127.0.0.1:${upPort}/mako_good.mpd?t=${encodeURIComponent(altSlugToken)}` }
            })
          };
        }
        return { ok: false, status: 404 };
      }
    });
    const resMpd = await resolverMpdTitleOnly.resolve({
      type: 'tv',
      id: '42025',
      title: 'Mako: Island of Secrets',
      episodeTitle: 'Outcasts',
      season: 1,
      episode: 1,
      year: 2013,
      durationSeconds: 1440,
      fetchSubtitles: false
    });
    assert.equal(resMpd.ok, true);
    assert.equal(resMpd.track.isDash, true);

    // 3. Proxy omits data.meta AND MPD <ProgramInformation><Title> mismatches episodeTitle -> must reject strictly!
    const resolverWrongMpdTitle = new MovieStreamResolver({
      movieApi: { getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }) },
      subtitles: null,
      enableYtDlp: false,
      enableWebFallback: false,
      fetchImpl: async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${upPort}`)) return fetch(u, opts);
        if (u.includes('proxy.yenime.net')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              source: { source: 'zendaya', type: 'dash', url: `http://127.0.0.1:${upPort}/mako_wrong.mpd?t=${encodeURIComponent(altSlugToken)}` }
            })
          };
        }
        return { ok: false, status: 404 };
      }
    });
    const resWrong = await resolverWrongMpdTitle.resolve({
      type: 'tv',
      id: '42025',
      title: 'Mako: Island of Secrets',
      episodeTitle: 'Outcasts',
      season: 1,
      episode: 1,
      year: 2013,
      durationSeconds: 1440,
      fetchSubtitles: false
    });
    assert.equal(resWrong.ok, false, 'Mismatched MPD ProgramInformation Title without meta must be rejected');

    // 4. MovieUi renders failure line at most once (no duplicate log line and no duplicate notice below Live Cinema Log)
    const h = buildTestHarness(t);
    h.app.movieResolver.resolve = async (_desc, opts = {}) => {
      opts.onProgress?.('⏳ [1/5] Checking primary HD stream route…');
      opts.onProgress?.('❌ No playable full-length feature stream found for this title.');
      return { ok: false, track: null, reason: 'No playable non-trailer full stream found for this title.' };
    };
    const ctx = h.makeCtx(-10055);
    await h.screen.handleCommand(ctx, '/movie', ['Breaking', 'Bad']);
    const ms = h.app.movieSessions.getLatestForChat(-10055);
    await h.screen.handle({ ...ctx, query: { id: 'q-tv-pk' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '0']);
    await h.screen.handle({ ...ctx, query: { id: 'q-tv-pe' }, messageId: ms.messageId }, 'mv', [ms.id, 'pe', '1-1']);
    const errLogCount = (ms.logLines || []).filter((l) => l.includes('❌')).length;
    assert.equal(errLogCount, 1, `Expected exactly 1 error line in logLines, got ${JSON.stringify(ms.logLines)}`);
    const rendered = h.screen.movieUi.renderTvSeason(ctx, ms);
    const renderedJson = JSON.stringify(rendered);
    const occurrences = renderedJson.split('No playable full-length feature stream found for this title.').length - 1;
    assert.equal(occurrences, 1, 'Failure message must render only once in Live Cinema Log without duplicating in ms.notice');
  } finally {
    await new Promise((r) => upstreamSrv.close(r));
  }
});

test('MovieStreamResolver enforces Original Audio (skips English Dub for non-English originals) and warns only on true Dub-Only fallback', async (t) => {
  const mkd = mkdtempSync(join(tmpdir(), 'lancy-orig-aud-'));
  t.after(() => rmSync(mkd, { recursive: true, force: true }));

  const sampleVtt = 'WEBVTT\n\n' + Array.from({ length: 6 }, (_, i) => `00:00:${String(10 + i * 5).padStart(2, '0')}.000 --> 00:00:${String(13 + i * 5).padStart(2, '0')}.000\nSub line ${i}\n`).join('\n');
  const upstream = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/dub.m3u8' || p === '/orig.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2400\n#EXTINF:2400.0,\nseg0.ts\n#EXTINF:2400.0,\nseg0.ts\n#EXTINF:2400.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (p === '/seg0.ts') {
      res.writeHead(206, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(1024));
      return;
    }
    if (p === '/en.vtt') {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end(sampleVtt);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const port = upstream.address().port;

  // Case 1: Wave A returns English Dub first AND Japanese Original second (or on Wave B) -> picks Japanese Original!
  const resolverOrig = new MovieStreamResolver({
    movieApi: {
      getMovie: async () => ({ id: '635302', title: 'Demon Slayer', year: 2020, originalLanguage: 'ja', runtimeSeconds: 7000 }),
      getPlaybackInfo: async () => ({ rootStream: null, originalLanguage: 'ja', subtitles: [] })
    },
    subtitles: new SubtitleService({ cacheDir: mkd, fetchImpl: async (u) => fetch(u) }),
    enableYtDlp: false,
    enableWebFallback: false,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${port}`)) return fetch(u, opts);
      if (u.includes('punkflix.net/movie/635302.json')) {
        return new Response(JSON.stringify({
          title: 'Demon Slayer',
          sources: [
            { source: 'dubsrv', label: 'English Dub', lang: 'en', dub: true, hls: `http://127.0.0.1:${port}/dub.m3u8` },
            { source: 'origsrv', label: 'Japanese Original', lang: 'ja', isOriginal: true, hls: `http://127.0.0.1:${port}/orig.m3u8`, subtitles: [{ lang: 'en', url: `http://127.0.0.1:${port}/en.vtt` }] }
          ]
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }
  });
  const resOrig = await resolverOrig.resolve({ type: 'movie', id: '635302', title: 'Demon Slayer', year: 2020, originalLanguage: 'ja' });
  assert.equal(resOrig.ok, true);
  assert.equal(resOrig.track.streamUrl, `http://127.0.0.1:${port}/orig.m3u8`);
  assert.equal(resOrig.track.audioLanguage, 'ja');
  assert.equal(resOrig.track.audioIsDub, false);
  assert.equal(resOrig.track.dubOnlyWarning, null);

  // Case 2: Only English Dub exists everywhere -> falls back cleanly with ⚠️ Dub Only Available warning
  const resolverDubOnly = new MovieStreamResolver({
    movieApi: {
      getMovie: async () => ({ id: '635302', title: 'Demon Slayer', year: 2020, originalLanguage: 'ja', runtimeSeconds: 7000 }),
      getPlaybackInfo: async () => ({ rootStream: null, originalLanguage: 'ja', subtitles: [] })
    },
    subtitles: null,
    enableYtDlp: false,
    enableWebFallback: false,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${port}`)) return fetch(u, opts);
      if (u.includes('punkflix.net/movie/635302.json')) {
        return new Response(JSON.stringify({
          title: 'Demon Slayer',
          source: { label: 'English Dub', lang: 'en', dub: true, hls: `http://127.0.0.1:${port}/dub.m3u8` }
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }
  });
  const resDub = await resolverDubOnly.resolve({ type: 'movie', id: '635302', title: 'Demon Slayer', year: 2020, originalLanguage: 'ja', fetchSubtitles: false });
  assert.equal(resDub.ok, true);
  assert.equal(resDub.track.streamUrl, `http://127.0.0.1:${port}/dub.m3u8`);
  assert.equal(resDub.track.audioIsDub, true);
  assert.equal(resDub.track.dubOnlyWarning, '⚠️ Dub Only Available');
});


test('Player card pin button, broken remote poster fallback, and restart card recovery for active + ended sessions', async (t) => {
  const h = buildTestHarness(t);
  const pinnedCalls = [];
  h.api.getChatMember = async () => ({ status: 'administrator', can_manage_voice_chats: true, can_post_messages: true, can_edit_messages: true, can_pin_messages: true });
  h.api.pinChatMessage = async (chatId, msgId, opts) => {
    pinnedCalls.push({ chatId, msgId, opts });
    return true;
  };
  h.api.call = async (method, params = {}) => {
    if (method === 'pinChatMessage') {
      pinnedCalls.push({ chatId: params.chat_id, msgId: params.message_id, opts: { disable_notification: params.disable_notification } });
      return true;
    }
    return { ok: true };
  };
  h.api.getChat = async (id) => ({ id, type: 'supergroup', title: 'Cinema Pin Group' });

  // 1. Music & Cinema cards always render visible Pin button (switching to 📍 Pinned once pinned)
  await h.qm.addMany(-10055, [{
    provider: 'movie',
    providerId: '27205:0:0',
    title: 'Inception (2010)',
    mediaType: 'video',
    streamUrl: 'https://cdn.example.org/inc.mp4',
    durationSeconds: 3600,
    artwork: 'https://broken.example.invalid/poster.jpg',
    capabilities: { seek: true, video: true }
  }]);
  const s = h.qm.getSession(-10055);
  const ctx = h.makeCtx(-10055);
  const unpinnedCard = h.screen.renderPlayer({ ...s, pinned: false, currentTrack: { provider: 'youtube', title: 'Track', artist: 'Artist', mediaType: 'audio', durationSeconds: 180, capabilities: {} } });
  const unpinnedBtns = unpinnedCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.ok(unpinnedBtns.some((b) => b.text === '📌 Pin' && decodeCallback(b.callback_data)?.action === 'pin'));

  const pinnedCard = h.screen.renderPlayer({ ...s, pinned: true, currentTrack: { provider: 'youtube', title: 'Track', artist: 'Artist', mediaType: 'audio', durationSeconds: 180, capabilities: {} } });
  const pinnedBtns = pinnedCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.ok(pinnedBtns.some((b) => b.text === '📍 Pinned' && decodeCallback(b.callback_data)?.action === 'pin'));

  // 2. Broken remote artwork triggers stripRemotePhotoBlocks fallback instead of silently dropping Player Card
  let failRemotePhotos = true;
  const origSendRich = h.api.sendRichMessage;
  const origEditRich = h.api.editMessageRich;
  h.api.sendRichMessage = async (chatId, rich) => {
    if (failRemotePhotos && rich?.blocks?.some((b) => b.type === 'photo' && /^https?:\/\//i.test(String(b.photo?.media || b.photo?.url || b.url || b.media || '')))) {
      const e = new Error('Bad Request: wrong file identifier/HTTP URL specified');
      e.description = e.message;
      throw e;
    }
    return origSendRich(chatId, rich);
  };
  h.api.editMessageRich = async (chatId, msgId, rich) => {
    if (failRemotePhotos && rich?.blocks?.some((b) => b.type === 'photo' && /^https?:\/\//i.test(String(b.photo?.media || b.photo?.url || b.url || b.media || '')))) {
      const e = new Error('Bad Request: wrong type of the web page content');
      e.description = e.message;
      throw e;
    }
    return origEditRich(chatId, msgId, rich);
  };

  s.screenMessageId = null;
  await h.service.player(ctx, -10055);
  assert.ok(s.screenMessageId, 'Player card must fall back without remote photo block instead of failing');
  await h.service.control({ ...ctx, query: { id: 'q-pin-1' }, messageId: s.screenMessageId }, 'pin', []);
  assert.equal(s.pinned, true);
  assert.equal(s.pinnedMessageId, s.screenMessageId);
  failRemotePhotos = false;

  // 3. Restart recovery restores Player Cards for BOTH active restored sessions and callEnded sessions
  s.positionSeconds = 300;
  await h.qm.shutdown();
  const qm2 = new QueueManager({ app: { ...h.app }, db: h.app.db, voiceClient: h.qm.voice, pollMs: 0 });
  h.app.musicQueueManager = qm2;
  t.after(() => qm2.shutdown());

  // Also test a persisted callEnded snapshot in another group
  const snaps = h.app.db.getSetting('music.activePlaybackSnapshots', {});
  snaps['-10056'] = {
    ...snaps['-10055'],
    chatId: -10056,
    destination: -10056,
    callEnded: true,
    status: 'paused',
    screenMessageId: null,
    playerChatId: -10056
  };
  h.app.db.setSetting('music.activePlaybackSnapshots', snaps);

  const sentBeforeRestore = h.sentMessages.length;
  const restored = await qm2.restoreActiveSessions({ api: h.api });
  assert.ok(restored.includes(-10055));
  assert.ok(qm2.getSession(-10055).screenMessageId, 'Active restored session must ensure visible Player Card');
  assert.ok(qm2.getSession(-10056).screenMessageId, 'callEnded restored session must still establish Player Card');
  assert.ok(h.sentMessages.length > sentBeforeRestore);
});

test('Resume recovers from expired movie URLs, dead paused calls, stopped sessions, and /resume establishes card', async (t) => {
  const h = buildTestHarness(t);
  let resolveCount = 0;
  h.app.movieResolver = {
    async resolve(desc) {
      resolveCount += 1;
      return {
        ok: true,
        track: {
          provider: 'movie',
          providerId: desc.providerId || '27205:0:0',
          title: 'Inception (2010)',
          mediaType: 'video',
          streamUrl: `https://cdn.example.org/fresh-${resolveCount}.mp4`,
          durationSeconds: 3600,
          capabilities: { seek: true, video: true }
        },
        subtitles: null
      };
    }
  };

  await h.qm.addMany(-10066, [{
    provider: 'movie',
    providerId: '27205:0:0',
    title: 'Inception (2010)',
    mediaType: 'video',
    streamUrl: 'https://cdn.example.org/stale-0.mp4',
    streamResolvedAt: Date.now() - 60 * 60 * 1000,
    durationSeconds: 3600,
    capabilities: { seek: true, video: true }
  }]);
  const s = h.qm.getSession(-10066);
  s.status = 'paused';
  s.positionSeconds = 615;
  s.lastKnownPositionSeconds = 615;

  // Simulate voice.resume failing with MEDIA_INVALID -> must re-resolve URL & rebuild stream at 615s
  h.qm.voice.getStatus = async () => ({ ok: true, active: true, paused: true });
  h.qm.voice.resume = async () => {
    const e = new Error('MEDIA_INVALID');
    e.code = 'MEDIA_INVALID';
    throw e;
  };
  await h.qm.resume(-10066);
  assert.equal(s.status, 'playing');
  assert.ok(resolveCount >= 1, 'MEDIA_INVALID resume failure must re-resolve movie stream');
  assert.equal(h.voiceCalls.play.at(-1).opts.startSeconds, 615);

  // Dead paused call (getStatus active: false) with stale stream also rebuilds cleanly
  s.status = 'paused';
  s.positionSeconds = 700;
  s.lastKnownPositionSeconds = 700;
  s.currentTrack.streamResolvedAt = Date.now() - 60 * 60 * 1000;
  h.qm.voice.getStatus = async () => ({ ok: true, active: false });
  await h.qm.resume(-10066);
  assert.equal(s.status, 'playing');
  assert.ok(resolveCount >= 2, 'Dead paused call with aged stream must refresh movie stream');
  assert.equal(h.voiceCalls.play.at(-1).opts.startSeconds, 700);

  // Stopped session recovers via /resume command and creates Player Card if missing
  s.status = 'stopped';
  s.screenMessageId = null;
  s.movieHistory = [s.currentTrack];
  s.currentTrack = null;
  s.callEnded = true;
  const ctx = h.makeCtx(-10066, { directMessageId: 888 });
  await h.screen.handleCommand(ctx, '/resume', []);
  assert.equal(s.status, 'playing');
  assert.ok(s.screenMessageId, '/resume command must establish Player Card when missing');
});

test('vcquality control cycles 1080p -> 720p -> 480p -> 1080p, persists quality, and passes videoQuality to voice.play', async (t) => {
  const h = buildTestHarness(t);
  await h.qm.addMany(-10077, [{
    provider: 'movie',
    providerId: '27205:0:0',
    title: 'Inception (2010)',
    mediaType: 'video',
    streamUrl: 'https://cdn.example.org/inc.mp4',
    durationSeconds: 3600,
    capabilities: { seek: true, video: true }
  }]);
  const s = h.qm.getSession(-10077);
  const ctx = h.makeCtx(-10077);
  await h.service.player(ctx, -10077);
  assert.equal(h.qm.getVcQuality(-10077, { isMovieTrack: true }), 'FHD_1080p');

  await h.service.control({ ...ctx, query: { id: 'q-vcq-1' }, messageId: s.screenMessageId }, 'vcquality', []);
  assert.equal(s.vcQuality, 'HD_720p');
  assert.equal(h.app.db.getSetting('music.vcQuality.-10077'), 'HD_720p');
  assert.equal(h.voiceCalls.play.at(-1).opts.videoQuality, 'HD_720p');
  assert.match(JSON.stringify(h.screen.renderCinemaPlayer(s)), /720p Smooth/);

  await h.service.control({ ...ctx, query: { id: 'q-vcq-2' }, messageId: s.screenMessageId }, 'vcquality', []);
  assert.equal(s.vcQuality, 'SD_480p');
  assert.equal(h.app.db.getSetting('music.vcQuality.-10077'), 'SD_480p');
  assert.equal(h.voiceCalls.play.at(-1).opts.videoQuality, 'SD_480p');
  assert.match(JSON.stringify(h.screen.renderCinemaPlayer(s)), /480p Saver/);

  await h.service.control({ ...ctx, query: { id: 'q-vcq-3' }, messageId: s.screenMessageId }, 'vcquality', []);
  assert.equal(s.vcQuality, 'FHD_1080p');
  assert.equal(h.app.db.getSetting('music.vcQuality.-10077'), 'FHD_1080p');
  assert.equal(h.voiceCalls.play.at(-1).opts.videoQuality, 'FHD_1080p');
});

test('Zero-Wrong-Movie, Zero-Clips/Trailers & Original-Audio protections across title scoring, resolver, downloader & UI', async (t) => {
  // 1. Title matching: block TV episodes & clips on movie queries, handle diacritics & codec specs cleanly
  assert.ok(scoreTitleMatch('Fallout', 2024, 'Fallout Season 1 Episode 1', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Fallout', 2024, 'Fallout S01E01 1080p', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Fallout', 2024, 'Fallout TV Show 2024', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Fallout', 2024, 'Fallout S01E01 1080p', { isTv: true, season: 1, episode: 1 }) >= 24);
  assert.ok(scoreTitleMatch('Amélie', 2001, 'Amelie 2001 1080p BluRay', { isTv: false }) >= 24);
  assert.ok(scoreTitleMatch('Inception', 2010, 'Inception 2010 DD 5 1 8bit 60fps 1080p', { isTv: false }) >= 24);
  assert.ok(scoreTitleMatch('Inception', 2010, 'Inception Opening Scene Clip', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Inception', 2010, 'Inception Part 1 of 2 Full Movie', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Inception', 2010, 'Inception Official Teasers and Clips', { isTv: false }) < 0);
  assert.ok(scoreTitleMatch('Breakdown', 1997, 'Breakdown 1997 Full Movie HD', { isTv: false }) >= 24);
  assert.ok(scoreTitleMatch('Breakdown', 1997, 'Breakdown 1997 Official Trailer', { isTv: false }) < 0);

  // 2. Dub detection covers regional dub tags & preserves subtitles / dual audio
  assert.equal(isDubAudioLabel('TrueFrench VFF Audio'), true);
  assert.equal(isDubAudioLabel('Espanol Latino'), true);
  assert.equal(isDubAudioLabel('Dublado PT-BR'), true);
  assert.equal(isDubAudioLabel('Original Japanese'), false);
  assert.equal(isDubbedCandidateText('Spirited Away (2001) English Dub 1080p', { preferredAudioLang: 'ja', targetTitle: 'Spirited Away' }), true);
  assert.equal(isDubbedCandidateText('Inception (2010) Hindi Audio 720p', { preferredAudioLang: 'en', targetTitle: 'Inception' }), true);
  assert.equal(isDubbedCandidateText('Parasite (2019) English Subbed 1080p', { preferredAudioLang: 'ko', targetTitle: 'Parasite' }), false);
  assert.equal(isDubbedCandidateText('Spirited Away Dual Audio Japanese English', { preferredAudioLang: 'ja', targetTitle: 'Spirited Away' }), false);

  // 3. Step 1 dub defers cleanly so Steps 2-5 can deliver original audio (and rejects conflicting t= slugs & short ffprobe MP4s)
  const upstream = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/dub.m3u8' || p === '/trailer.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      const segDur = p === '/trailer.m3u8' ? '60.0' : '2400.0';
      const count = p === '/trailer.m3u8' ? 2 : 3;
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2400\n' + Array.from({ length: count }, () => `#EXTINF:${segDur},\nseg0.ts`).join('\n') + '\n#EXT-X-ENDLIST\n');
      return;
    }
    if (p === '/seg0.ts') {
      res.writeHead(206, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(1024));
      return;
    }
    if (p === '/short_clip.mp4' || p === '/full_orig.mp4') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/900000000' });
      res.end(Buffer.alloc(1024));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const port = upstream.address().port;

  const badSlugCrow1994 = Buffer.from(JSON.stringify({ r: { slug: 'the-crow-1994-abc123' } })).toString('base64');
  const resolverChain = new MovieStreamResolver({
    movieApi: {
      getMovie: async () => ({ id: '129', title: 'Spirited Away', year: 2001, originalLanguage: 'ja', runtimeSeconds: 7500 }),
      getPlaybackInfo: async () => ({ rootStream: null, originalLanguage: 'ja', subtitles: [] })
    },
    subtitles: null,
    enableYtDlp: true,
    enableWebFallback: true,
    thenkiri: {
      thenkiriSearch: async () => ({
        results: [
          { title: 'Spirited Away (2001) Hindi Dubbed', url: 'https://tk.example/dub' },
          { title: 'Spirited Away (2001)', url: 'https://tk.example/orig' }
        ]
      }),
      thenkiriDetails: async (url) => ({
        sources: url.endsWith('/orig')
          ? [{ label: 'Download Movie 1080p', url: `http://127.0.0.1:${port}/full_orig.mp4` }]
          : [{ label: 'Download Hindi Dub', url: `http://127.0.0.1:${port}/short_clip.mp4` }]
      }),
      thenkiriGetLink: async (u) => ({ url: u, format: 'mp4' })
    },
    ffprobeRunner: async (url) => {
      if (String(url).includes('short_clip.mp4')) {
        return { format: { duration: '95.0' }, streams: [{ codec_type: 'audio', tags: { language: 'hi' } }] };
      }
      return { format: { duration: '7500.0' }, streams: [{ codec_type: 'audio', tags: { language: 'jpn' }, disposition: { original: 1 } }] };
    },
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${port}`)) return fetch(u, opts);
      if (u.includes('punkflix.net/movie/129.json')) {
        return new Response(JSON.stringify({
          title: 'Spirited Away',
          source: { label: 'English Dub', lang: 'en', dub: true, hls: `http://127.0.0.1:${port}/dub.m3u8` }
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }
  });
  const origWin = await resolverChain.resolve({ type: 'movie', id: '129', title: 'Spirited Away', year: 2001, originalLanguage: 'ja', durationSeconds: 7500, fetchSubtitles: false });
  assert.equal(origWin.ok, true);
  assert.equal(origWin.track.streamUrl, `http://127.0.0.1:${port}/full_orig.mp4`, 'Must not stop on Step 1 dub when Step 2 has Japanese Original');
  assert.equal(origWin.track.audioIsDub, false);
  assert.equal(origWin.track.audioLanguage, 'ja');

  // Verify conflicting year slug in t= token AND 95s MP4 container are both rejected
  const resolverBadSlugAndShortMp4 = new MovieStreamResolver({
    movieApi: null,
    subtitles: null,
    enableYtDlp: false,
    enableWebFallback: false,
    ffprobeRunner: async () => ({ format: { duration: '95.0' }, streams: [{ codec_type: 'audio', tags: { language: 'en' } }] }),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${port}`)) return fetch(u, opts);
      if (u.includes('proxy1.flikhub.net')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: { id: 401123, title: 'The Crow', release_date: '2024-08-23' },
            sources: [
              { source: 'zendaya', url: `http://127.0.0.1:${port}/dub.m3u8?t=${encodeURIComponent(badSlugCrow1994)}`, type: 'hls' },
              { source: 'berlin', url: `http://127.0.0.1:${port}/short_clip.mp4`, type: 'mp4' }
            ]
          })
        };
      }
      return { ok: false, status: 404 };
    }
  });
  const crowBlocked = await resolverBadSlugAndShortMp4.resolve({ type: 'movie', id: '401123', title: 'The Crow', year: 2024, durationSeconds: 6600, fetchSubtitles: false });
  assert.equal(crowBlocked.ok, false, 'Conflicting year t= slug and 95s MP4 trailer must both be rejected');

  // 4. MovieDownloader selectOriginalAudioMapArgs chooses original language audio stream over default dub
  const mapArgs = await selectOriginalAudioMapArgs('https://cdn.example/dual.mkv', async () => ({
    stdout: JSON.stringify({
      streams: [
        { codec_type: 'audio', tags: { language: 'eng', title: 'English Dub' }, disposition: { default: 1 } },
        { codec_type: 'audio', tags: { language: 'jpn', title: 'Japanese' }, disposition: { original: 1 } }
      ]
    })
  }), { preferredAudioLang: 'ja' });
  assert.deepEqual(mapArgs, ['-map', '0:v:0', '-map', '0:a:1']);

  // 5. MovieApiClient Cinemeta language propagation & WordPress/Archive trailer filtering
  const apiLangClient = new MovieApiClient({
    baseUrl: 'https://example.test/api',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('v3-cinemeta.strem.io/meta/movie/tt0245429.json')) {
        return { ok: true, json: async () => ({ meta: { id: 'tt0245429', name: 'Spirited Away', releaseInfo: '2001', runtime: '125 min', language: 'Japanese' } }) };
      }
      if (u.includes('archive.org/advancedsearch.php')) {
        return {
          ok: true,
          json: async () => ({
            response: {
              docs: [
                { identifier: 'clip_id', title: 'Inception Official Trailer Clip', year: '2010', runtime: '2 min' },
                { identifier: 'full_id', title: 'Inception Full Film', year: '2010', runtime: '148 min' }
              ]
            }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  const cmMovie = await apiLangClient.getMovie('tt0245429');
  assert.equal(cmMovie.originalLanguage, 'Japanese');

  // 6. MovieUi enrichTrack preserves string dubOnlyWarning (instead of coercing Boolean(true))
  const h = buildTestHarness(t);
  h.app.voiceClient.accounts = async () => ({ accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] });
  h.app.movieResolver.resolve = async () => ({
    ok: true,
    track: {
      id: 'mv:129:0:0',
      provider: 'movie',
      title: 'Spirited Away (2001)',
      artist: '2001 · Feature Film · 1080p',
      mediaType: 'video',
      streamUrl: `http://127.0.0.1:${port}/dub.m3u8`,
      durationSeconds: 7200,
      audioLanguage: 'en',
      audioIsDub: true,
      dubOnly: true,
      dubOnlyWarning: '⚠️ Dub Only Available',
      capabilities: { seek: true, video: true }
    },
    subtitles: null
  });
  const ctxGc = h.makeCtx(-10088);
  await h.screen.movieUi.openMovieSearch(ctxGc, 'Inception');
  const sessState = h.app.movieSessions.getLatestForChat(-10088);
  sessState.results = [{ id: '129', type: 'movie', title: 'Spirited Away', year: 2001, originalLanguage: 'ja' }];
  await h.screen.handle({ ...ctxGc, query: { id: 'q-dub-ui' }, messageId: sessState.messageId }, 'mv', [sessState.id, 'pmi', '0']);
  const vcSess = h.qm.getSession(-10088);
  const playedTrack = vcSess.movieCurrentTrack || vcSess.currentTrack;
  assert.equal(playedTrack?.dubOnlyWarning, '⚠️ Dub Only Available');
});

test('/moviecast allow/disallow gates global & group movie DM broadcasts and /vc renders expandable blockquote VC & button instructions', async (t) => {
  const h = buildTestHarness(t);
  h.app.voiceClient.accounts = async () => ({ accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] });

  // Use a writable settings wrapper backed by SettingsManager / SQLite just like app.js
  let globalSetting = true;
  h.app.settings = {
    get: (k) => (k === 'general.ownerIds' ? [10] : k === 'music.cinemaAnnounceEnabled' ? globalSetting : undefined),
    set: (k, v) => { if (k === 'music.cinemaAnnounceEnabled') globalSetting = Boolean(v); }
  };

  h.app.db.run(
    'INSERT OR REPLACE INTO bot_users (bot_id, tg_id, username, first_name, is_banned, last_seen) VALUES (?, ?, ?, ?, 0, ?)',
    0, 2001, 'viewer1', 'ViewerOne', Math.floor(Date.now() / 1000)
  );
  const dmAlerts = [];
  const announceApi = {
    async getChat(cid) { return { id: Number(cid), title: 'Movie Night GC', type: 'supergroup', invite_link: 'https://t.me/+MovieGcLink' }; },
    async sendRichMessage(uid, rich) { dmAlerts.push({ uid, rich }); return { message_id: dmAlerts.length + 1 }; }
  };
  const announcer = new CinemaVcAnnouncer({ app: h.app, db: h.app.db, cooldownMs: 0, pacingMs: 0 });
  h.app.cinemaAnnouncer = announcer;

  // 1. Non-owner cannot disallow/allow global movie broadcast
  const randomUserCtx = h.makeCtx(-10050, { tgId: 999, user: { id: 999, first_name: 'Member' } });
  await h.screen.handleCommand(randomUserCtx, '/moviecast', ['disallow']);
  assert.equal(announcer.isGlobalEnabled(), true, 'Non-owner must not change global broadcast setting');
  assert.match(JSON.stringify(h.sentMessages.at(-1)), /Owner/i);

  // 2. Owner runs /moviecast (status card) & /moviecast disallow -> announcer skips globally
  const ownerDmCtx = h.makeCtx(10, { tgId: 10, user: { id: 10, first_name: 'Owner' } });
  await h.screen.handleCommand(ownerDmCtx, '/moviecast', []);
  const statusCard = h.sentMessages.at(-1).rich;
  assert.match(JSON.stringify(statusCard), /Allowed \(ON\)/);
  assert.ok(statusCard.blocks.some((bl) => bl.type === 'expandable_blockquote'), 'Broadcast control card should have expandable usage guide');

  await h.screen.handleCommand(ownerDmCtx, '/moviecast', ['disallow']);
  assert.equal(announcer.isGlobalEnabled(), false);
  assert.equal(globalSetting, false);
  const skippedGlobal = await announcer.onTrackStart({
    chatId: -10050,
    track: { provider: 'movie', title: 'Inception (2010)', mediaType: 'video' },
    session: { botId: 0, api: announceApi }
  });
  assert.equal(skippedGlobal?.skipped, 'disabled_globally');
  assert.equal(dmAlerts.length, 0);

  // 3. Re-enable via 1-tap callback mcast:on (or /moviebroadcast allow) -> movie broadcasts resume to all users
  const cbCtx = h.makeCtx(10, {
    tgId: 10,
    user: { id: 10, first_name: 'Owner' },
    query: { id: 'cb_mcast_on' },
    messageId: h.sentMessages.at(-1).message_id
  });
  await h.screen.handle(cbCtx, 'mcast', ['on']);
  assert.equal(announcer.isGlobalEnabled(), true);
  assert.equal(globalSetting, true);

  await announcer.onTrackStart({
    chatId: -10050,
    track: { provider: 'movie', title: 'Inception (2010)', mediaType: 'video' },
    session: { botId: 0, api: announceApi }
  });
  await announcer.flush();
  assert.equal(dmAlerts.length, 1, 'Enabled broadcast should notify active users');
  assert.equal(dmAlerts[0].uid, 2001);

  // 4. Per-group toggle (/moviecast group disallow -> /moviecast group allow)
  const gcOwnerCtx = h.makeCtx(-10050);
  await h.screen.handleCommand(gcOwnerCtx, '/moviecast', ['group', 'disallow']);
  assert.equal(announcer.isGroupEnabled(-10050), false);
  const skippedGroup = await announcer.onTrackStart({
    chatId: -10050,
    track: { provider: 'movie', title: 'Interstellar (2014)', mediaType: 'video' },
    session: { botId: 0, api: announceApi }
  });
  assert.equal(skippedGroup?.skipped, 'disabled_for_group');
  await h.screen.handleCommand(gcOwnerCtx, '/moviecast', ['group', 'allow']);
  assert.equal(announcer.isGroupEnabled(-10050), true);

  // 5. /vc command opens player card with expandable_blockquote covering all VC commands & button instructions in bold font & clean spacing
  const msgsBeforeVc = h.sentMessages.length;
  await h.screen.handleCommand(gcOwnerCtx, '/vc', []);
  const vcCard = h.sentMessages[msgsBeforeVc]?.rich || h.editedMessages.at(-1)?.rich;
  assert.ok(vcCard && Array.isArray(vcCard.blocks), '/vc must render a Rich player card');
  const vcExpandable = vcCard.blocks.find((bl) => bl.type === 'expandable_blockquote');
  assert.ok(vcExpandable, '/vc player card must contain an expandable_blockquote guide block');
  assert.ok(Array.isArray(vcExpandable.text) && vcExpandable.text.some((node) => node?.type === 'bold'), 'Guide must use RichText bold formatting');
  const vcGuideStr = richTextToString(vcExpandable.text);
  assert.match(vcGuideStr, /\/vc/);
  assert.match(vcGuideStr, /\/moviecast/);
  assert.match(vcGuideStr, /𝗣𝗟𝗔𝗬𝗘𝗥 𝗕𝗨𝗧𝗧𝗢𝗡𝗦|PLAYER BUTTONS/i);
  assert.match(vcGuideStr, /Join VC/i);

  // 6. Cinema deck /vc (/player) card ALSO contains the bold spaced expandable_blockquote VC & button instructions without Music leaks
  const vcSess = h.qm.getSession(-10050);
  vcSess.activeDeck = 'movie';
  vcSess.view = 'cinema';
  const cinemaCard = h.screen.renderPlayer(vcSess);
  const cinemaExpandable = cinemaCard.blocks.find((bl) => bl.type === 'expandable_blockquote');
  assert.ok(cinemaExpandable, 'Cinema /vc player card must also contain an expandable_blockquote guide block');
  assert.ok(Array.isArray(cinemaExpandable.text) && cinemaExpandable.text.some((node) => node?.type === 'bold'), 'Cinema guide must use RichText bold formatting');
  const cinemaGuideStr = richTextToString(cinemaExpandable.text);
  assert.match(cinemaGuideStr, /RTMP Live/);
  assert.match(cinemaGuideStr, /Source 1\/N|Alt Source/i);
  assert.match(cinemaGuideStr, /\/vcmsg/);
  assert.doesNotMatch(cinemaGuideStr, /Spotify|Lyrics|Bass|AI DJ|Infinite/i);
});

test('restoreActiveSessions prioritizes playing streams over paused ones and defaults allow multi-GC on 1 assistant', async (t) => {
  const h = buildTestHarness(t);
  const playOrder = [];
  const origPlay = h.qm.voice.play.bind(h.qm.voice);
  h.qm.voice.play = async (chatId, source, opts = {}) => {
    playOrder.push({ chatId, opts });
    return origPlay(chatId, source, opts);
  };

  const nowTs = Date.now();
  h.app.db.setSetting('music.activePlaybackSnapshots', {
    '-10011': {
      chatId: -10011,
      activeDeck: 'movie',
      paused: true,
      status: 'paused',
      positionSeconds: 850,
      savedAt: nowTs - 1000,
      currentTrack: { id: 'm1', title: 'Paused Movie', provider: 'movie', mediaType: 'video', streamUrl: 'https://cdn.example/1.mp4', capabilities: { seek: true, video: true } }
    },
    '-10022': {
      chatId: -10022,
      activeDeck: 'movie',
      paused: false,
      status: 'playing',
      positionSeconds: 420,
      savedAt: nowTs - 5000,
      currentTrack: { id: 'm2', title: 'Live Playing Movie', provider: 'movie', mediaType: 'video', streamUrl: 'https://cdn.example/2.mp4', capabilities: { seek: true, video: true } }
    }
  });

  await h.qm.shutdown();
  const qm2 = new QueueManager({ app: { ...h.app }, db: h.app.db, voiceClient: h.qm.voice, pollMs: 0 });
  h.app.musicQueueManager = qm2;
  t.after(() => qm2.shutdown());
  const restored = await qm2.restoreActiveSessions({ api: h.api });
  assert.deepEqual(restored, [-10022, -10011], 'Playing streams must restore before paused ones');
  assert.equal(playOrder[0].chatId, -10022);
  const { DEFAULT_SETTINGS: cfgDefaults } = await import('../src/config/defaults.js');
  assert.equal(cfgDefaults.cinema.maxVideoCallsPerAccount, 0, 'Default maxVideoCallsPerAccount must be 0 (Auto) so 1 assistant resumes all GCs');
});

test('Cinemeta/Wikidata fallbacks preserve originalLanguage + TMDB ID on API outage, and mismatched audio language is flagged as dubbed', async (t) => {
  // 1. Wikidata P345->P4983 still resolves on transient network error, while HTTP 404 still rejects deleted TMDB IDs
  const apiNet = new MovieApiClient({
    baseUrl: 'https://primary.invalid',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('wikidata.org') && u.includes('haswbstatement%3AP345%3Dtt0892700')) {
        return { ok: true, json: async () => ({ query: { search: [{ title: 'Q420' }] } }) };
      }
      if (u.includes('wikidata.org') && u.includes('haswbstatement%3AP345%3Dtt9999999')) {
        return { ok: true, json: async () => ({ query: { search: [{ title: 'Q404' }] } }) };
      }
      if (u.includes('wikidata.org') && u.includes('wbgetentities') && u.includes('Q420')) {
        return { ok: true, json: async () => ({ entities: { Q420: { claims: { P4983: [{ mainsnak: { datavalue: { value: '7869' } } }] } } } }) };
      }
      if (u.includes('wikidata.org') && u.includes('wbgetentities') && u.includes('Q404')) {
        return { ok: true, json: async () => ({ entities: { Q404: { claims: { P4983: [{ mainsnak: { datavalue: { value: '139440' } } }] } } } }) };
      }
      if (u.includes('primary.invalid/tv/139440')) {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      if (u.includes('primary.invalid/tv/7869')) {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (u.includes('v3-cinemeta.strem.io/meta/series/tt0892700.json')) {
        return {
          ok: true,
          json: async () => ({
            meta: {
              id: 'tt0892700',
              name: 'The Penguins of Madagascar',
              country: 'United States, New Zealand',
              moviedb_id: 7869,
              videos: [{ season: 1, episode: 1, title: 'Gone in a Flash' }]
            }
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  const tvMeta = await apiNet.getTvShow('tt0892700');
  assert.equal(tvMeta?.tmdbId, '7869');
  assert.equal(tvMeta?.originalLanguage, 'English');

  const deletedCheck = await apiNet.resolveNumericTmdbInfo({ id: 'tt9999999', imdbId: 'tt9999999', type: 'tv' });
  assert.equal(deletedCheck?.tmdbId, null, 'Deleted TMDB IDs (HTTP 404) must still be skipped');

  // 2. MovieStreamResolver inherits opts.language -> effectiveOriginalLanguage and renderCinemaPlayer never labels mismatched language Original
  const resolver = new MovieStreamResolver({
    movieApi: null,
    subtitles: null,
    fetchImpl: async () => ({ ok: false, status: 404 }),
    enableWebFallback: false,
    enableYtDlp: true,
    ytSearchFn: async (q) => {
      if (String(q).includes('Hindi Dub')) return [];
      return [
        { title: 'The Penguins of Madagascar | Full Episode | Gone In A Flash (Hindi)', duration: 635, directStreamUrl: 'https://cdn.example/penguins_hi.mp4', qualityLabel: '720p' },
        ...(String(q).includes('English full episode')
          ? [{ title: 'The Penguins of Madagascar | Gone In A Flash | English', duration: 635, directStreamUrl: 'https://cdn.example/penguins_en.mp4', qualityLabel: '720p' }]
          : [])
      ];
    }
  });
  const enPick = await resolver.resolve({
    type: 'tv',
    id: 'tt0892700',
    title: 'The Penguins of Madagascar',
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: 'Gone in a Flash',
    durationSeconds: 720,
    language: 'English',
    fetchSubtitles: false
  });
  assert.equal(enPick.ok, true);
  assert.equal(enPick.track.originalLanguage, 'en');
  assert.equal(enPick.track.streamUrl, 'https://cdn.example/penguins_en.mp4');
  assert.equal(enPick.track.audioIsDub, false);

  // 3. renderCinemaPlayer never renders "Original (HI)" when track originalLanguage is "en" and audioLanguage is "hi"
  const h = buildTestHarness(t);
  const card = h.screen.renderCinemaPlayer({
    chatId: -10077,
    activeDeck: 'movie',
    status: 'playing',
    positionSeconds: 45,
    currentTrack: {
      id: 'tv:tt0892700:1:1',
      provider: 'movie',
      title: 'The Penguins of Madagascar · S01E01 — Gone in a Flash',
      artist: '2008 · S01E01 · 720p',
      mediaType: 'video',
      durationSeconds: 635,
      originalLanguage: 'en',
      audioLanguage: 'hi',
      audioIsDub: false,
      capabilities: { seek: true, video: true }
    },
    movieQueue: []
  });
  const cardText = JSON.stringify(card);
  assert.equal(cardText.includes('Original (HI)'), false, 'Mismatched audio language must never be labeled Original (HI)');
  assert.match(cardText, /Dub Only Available \(HI\)/);
});

test('VidBolt candidate parser preserves source.language (skips 1080p French/Pt-Br for English) and Interactive VC defaults to HD_720p smooth', async (t) => {
  const { normalizeLangCode } = await import('../src/media/streamingServer.js');
  assert.equal(normalizeLangCode('Brazilian Portuguese'), 'pt');
  assert.equal(normalizeLangCode('French'), 'fr');

  const masterM3u8 = '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:1250.0,\nhttps://cdn.example/seg1.ts\n#EXT-X-ENDLIST\n';
  const srtBody = '1\n00:00:01,000 --> 00:00:04,000\nNicely done, Maurice.\n\n2\n00:00:05,000 --> 00:00:09,000\nNow peel me a grape.\n\n3\n00:00:10,000 --> 00:00:14,000\nOperation popcorn.\n\n4\n00:00:15,000 --> 00:00:19,000\nCute and cuddly.\n\n5\n00:00:20,000 --> 00:00:24,000\nMove it.\n';
  const subDir = mkdtempSync(join(tmpdir(), 'lancy-vb-subs-'));
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const vbFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://vidbolt.xyz/api/resolve')) {
      return {
        ok: true,
        json: async () => ({
          stream: {
            sources: [
              { url: 'https://cdn.example/fr_1080.m3u8', kind: 'hls', quality: '1080p', language: 'French' },
              { url: 'https://cdn.example/pt_720.m3u8', kind: 'hls', quality: '720p', language: 'Brazilian Portuguese' },
              { url: 'https://cdn.example/en_480.m3u8', kind: 'hls', quality: '480p', language: 'English' }
            ],
            subtitles: [
              { url: 'https://cdn.example/fr.srt', label: 'Français', lang: 'Français' },
              { url: 'https://cdn.example/en_vb.srt', label: 'English', lang: 'English' }
            ]
          }
        })
      };
    }
    if (u.startsWith('https://cdn.example/') && u.endsWith('.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
        text: async () => masterM3u8
      };
    }
    if (u.startsWith('https://cdn.example/seg1.ts')) {
      return { ok: true, status: 206, headers: new Headers({ 'content-type': 'video/mp2t' }), arrayBuffer: async () => new ArrayBuffer(64) };
    }
    if (u === 'https://cdn.example/en_vb.srt' || u === 'https://cdn.example/fr.srt') {
      return { ok: true, status: 200, text: async () => srtBody };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const subs = new SubtitleService({ cacheDir: subDir, fetchImpl: vbFetch });
  const resolver = new MovieStreamResolver({
    movieApi: null,
    subtitles: subs,
    enableWebFallback: false,
    enableYtDlp: false,
    fetchImpl: vbFetch
  });

  const picked = await resolver.resolve({
    type: 'tv',
    id: '7869',
    tmdbId: '7869',
    title: 'The Penguins of Madagascar',
    year: 2008,
    season: 1,
    episode: 1,
    originalLanguage: 'English',
    fetchSubtitles: true
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.track.streamUrl, 'https://cdn.example/en_480.m3u8');
  assert.equal(picked.track.audioLanguage, 'en');
  assert.equal(picked.track.audioIsDub, false);
  assert.equal(picked.track.subtitleSameRoute, true, 'VidBolt stream.subtitles must be attached as Same-Stream subtitles');
  assert.equal(picked.track.subtitleCuesCount, 5);
  assert.ok(Array.isArray(picked.track.audioVariants) && picked.track.audioVariants.length >= 3, 'audioVariants must expose Original + alternate language dubs');
  assert.ok(picked.track.audioVariants.some((v) => v.audioLanguage === 'fr' && v.audioIsDub === true));
  assert.ok(Array.isArray(picked.track.subtitleTracks) && picked.track.subtitleTracks.length >= 2, 'subtitleTracks must retain all distinct languages');

  const apiZh = new MovieApiClient({
    baseUrl: 'https://primary.invalid',
    fetchImpl: async (url) => {
      if (String(url).includes('v3-cinemeta.strem.io/meta/series/tt12953630.json')) {
        return {
          ok: true,
          json: async () => ({
            meta: { id: 'tt12953630', name: 'Fog Hill of Five Elements', country: 'China', moviedb_id: 102788, videos: [{ season: 1, episode: 1 }] }
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });
  const fogShow = await apiZh.getTvShow('tt12953630');
  assert.equal(fogShow?.originalLanguage, 'Chinese');

  const h = buildTestHarness(t);
  h.app.db.setSetting('music.streamMode.-10091.movie', 'interactive');
  assert.equal(h.qm.getVcQuality(-10091, { isMovieTrack: true, streamMode: 'interactive' }), 'HD_720p');
  assert.equal(h.qm.getVcQuality(-10091, { isMovieTrack: true, streamMode: 'rtmp' }), 'FHD_1080p');

  // Hot-reload Audio Language + Direct Subtitle Language selection
  const setSubCalls = [];
  h.app.voiceClient.setSubtitle = async (cid, filePath, opts) => {
    setSubCalls.push({ cid, filePath, opts });
    return { ok: true };
  };
  const enTrack = {
    ...picked.track,
    subtitlePath: picked.track.subtitleTracks[0].filePath,
    subtitleLabel: picked.track.subtitleTracks[0].label,
    subtitleTracks: picked.track.subtitleTracks,
    audioVariants: picked.track.audioVariants.map((v) => ({ ...v, unprobed: false }))
  };
  const ctxLang = h.makeCtx(-10091);
  await h.qm.addMany(-10091, [enTrack]);
  await h.service.player(ctxLang, -10091);
  const sLang = h.qm.getSession(-10091);
  sLang.positionSeconds = 180;
  sLang.lastKnownPositionSeconds = 180;

  await h.service.control({ ...ctxLang, query: { id: 'q-al-open' }, messageId: sLang.screenMessageId }, 'audiolang', []);
  assert.equal(sLang.view, 'audiolang');
  const alCard = h.screen.renderPlayer(sLang);
  const pickerText = JSON.stringify(alCard);
  assert.match(pickerText, /English \(Orig/);
  assert.match(pickerText, /French \(Dub/);

  const frBtn = alCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons).find((b) => richTextToString(b.text).includes('French (Dub'));
  assert.ok(frBtn, 'Must render clickable French audio language button');
  const frDecoded = decodeCallback(frBtn.callback_data);
  await h.service.control({ ...ctxLang, query: { id: 'q-al-pick' }, messageId: sLang.screenMessageId }, frDecoded.action, frDecoded.args);
  assert.equal(sLang.view, 'cinema');
  assert.equal(sLang.currentTrack.audioLanguage, 'fr');
  assert.equal(sLang.currentTrack.audioIsDub, true);
  assert.equal(Math.round(h.voiceCalls.play.at(-1).opts.startSeconds), 180, 'Audio language switch must hot-reload at current timestamp');

  // Open Sub Sync picker and hot-reload directly onto Français track (idx 1) without restarting call
  const playCountBeforeSub = h.voiceCalls.play.length;
  await h.service.control({ ...ctxLang, query: { id: 'q-sub-open' }, messageId: sLang.screenMessageId }, 'subsync', [String(sLang.controlRevision)]);
  const subCard = h.screen.renderPlayer(sLang);
  const subPickerText = JSON.stringify(subCard);
  assert.match(subPickerText, /Français/);
  const frSubIdx = sLang.currentTrack.subtitleTracks.findIndex((tr) => /français/i.test(tr.label));
  assert.ok(frSubIdx >= 0);
  const frSubBtn = subCard.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons).find((b) => richTextToString(b.text).includes('Français'));
  assert.ok(frSubBtn, 'Must render clickable Français subtitle button');
  const frSubDecoded = decodeCallback(frSubBtn.callback_data);
  await h.service.control({ ...ctxLang, query: { id: 'q-sub-pick' }, messageId: sLang.screenMessageId }, frSubDecoded.action, frSubDecoded.args);
  assert.equal(sLang.subtitleTrackIndex, frSubIdx);
  assert.equal(h.voiceCalls.play.length, playCountBeforeSub, 'Subtitle language switch must hot-reload via setSubtitle without restarting stream');
  assert.equal(setSubCalls.at(-1)?.filePath, sLang.currentTrack.subtitleTracks[frSubIdx].filePath);
});
