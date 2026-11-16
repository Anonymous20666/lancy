import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { PANEL_ACTIONS } from '../src/music/channelPanels.js';
import { SearchSessions } from '../src/music/search.js';
import { normalizeTrack } from '../src/music/model.js';
import { MovieApiClient, normalizeSeasonsList } from '../src/media/movieApi.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { SubtitleService } from '../src/media/subtitles.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';

test('Season 0 Specials preserved across normalizeSeasonsList, MovieSessions SQLite reload, and getTvSeasonEpisodes', async (t) => {
  const seasons = normalizeSeasonsList([
    { season_number: 0, name: 'Specials', episode_count: 3 },
    { season_number: 1, name: 'Season 1', episode_count: 6 }
  ]);
  assert.deepEqual(seasons.map((s) => s.seasonNumber), [1, 0]);
  assert.equal(seasons[1].name, 'Specials');

  const db = new Database(':memory:');
  db.migrate();
  t.after(() => db.close());

  const sessions = new MovieSessions({ db });
  const ms = sessions.create({ chatId: -10077, query: 'Doctor Who' });
  ms.seasonNumber = 0;
  ms.seasonName = 'Specials';
  ms.episodeCache.set(0, [{ seriesId: '57243', seasonNumber: 0, episodeNumber: 1, title: 'The Christmas Invasion' }]);
  sessions.toggleEpisode(ms, 0, 1);
  sessions.persistNow();

  const reloaded = new MovieSessions({ db });
  const ms2 = reloaded.getLatestForChat(-10077);
  assert.ok(ms2);
  assert.equal(ms2.seasonNumber, 0, 'Season 0 must remain 0 after SQLite reload rather than resetting to 1');
  assert.equal(ms2.selectedBySeason.get(0)?.has(1), true);
  assert.equal(ms2.episodeCache.get(0)?.[0]?.title, 'The Christmas Invasion');

  const requestedPaths = [];
  const api = new MovieApiClient({
    baseUrl: 'https://example.test/api',
    fetchImpl: async (url) => {
      const reqPath = new URL(String(url)).pathname;
      requestedPaths.push(reqPath);
      if (reqPath.endsWith('/tv/57243/season/0')) {
        return {
          ok: true,
          json: async () => ({
            series_id: '57243',
            season_number: 0,
            episodes: [{ series_id: '57243', season_number: 0, episode_number: 1, title: 'Special Ep', runtime: 60 }]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });
  const s0 = await api.getTvSeasonEpisodes('57243', 0);
  assert.ok(requestedPaths.some((p) => p.endsWith('/tv/57243/season/0')));
  assert.equal(s0.seasonNumber, 0);
  assert.equal(s0.episodes[0].title, 'Special Ep');
});

test('MovieApiClient unions Cinemeta + TVMaze seasons, probes Seasons 1..4 when manifest omitted, and keeps remakes distinct by year', async () => {
  const api = new MovieApiClient({
    baseUrl: 'https://example.test/api',
    fetchImpl: async (url) => {
      const u = String(url);
      // 1. Search remakes + union target
      if (u.includes('/search?q=Dune')) {
        return {
          ok: true,
          json: async () => ({
            provider: 'holaflix',
            results: [
              { provider_id: '841', type: 'movie', title: 'Dune', year: 1984 },
              { provider_id: '438631', type: 'movie', title: 'Dune', year: 2021 }
            ]
          })
        };
      }
      if (u.includes('v3-cinemeta.strem.io/catalog/movie/top/search=Dune')) {
        return {
          ok: true,
          json: async () => ({
            metas: [
              { id: 'tt1160419', name: 'Dune', releaseInfo: '2021', imdbRating: '8.0', poster: 'https://img.example/dune21.jpg' }
            ]
          })
        };
      }
      if (u.includes('v3-cinemeta.strem.io/catalog/tv/') || u.includes('v3-cinemeta.strem.io/catalog/movie/')) {
        return { ok: true, json: async () => ({ metas: [] }) };
      }
      // 2. Union Cinemeta + TVMaze seasons on TV 555
      if (u.endsWith('/tv/555/seasons')) {
        return { ok: true, json: async () => ({ series_id: '555', title: 'Machine Gunner', seasons: [{ season_number: 1, name: 'Season 1', episode_count: 6 }] }) };
      }
      if (u.endsWith('/tv/555')) {
        return { ok: true, json: async () => ({ provider_id: '555', type: 'tv', title: 'Machine Gunner', imdb_id: 'tt5555555' }) };
      }
      if (u.includes('v3-cinemeta.strem.io/meta/series/tt5555555.json')) {
        return {
          ok: true,
          json: async () => ({
            meta: {
              imdb_id: 'tt5555555',
              name: 'Machine Gunner',
              videos: [
                { season: 1, episode: 1, title: 'E1' },
                { season: 2, episode: 1, title: 'E2' },
                { season: 3, episode: 1, title: 'E3' }
              ]
            }
          })
        };
      }
      if (u.includes('api.tvmaze.com/lookup/shows?imdb=tt5555555')) {
        return { ok: true, json: async () => ({ id: 88 }) };
      }
      if (u.includes('api.tvmaze.com/shows/88?embed=episodes')) {
        return {
          ok: true,
          json: async () => ({
            id: 88,
            name: 'Machine Gunner',
            _embedded: {
              episodes: [
                { season: 0, number: 1, name: 'OVA' },
                { season: 4, number: 1, name: 'S4 Ep1' }
              ]
            }
          })
        };
      }
      // 3. 1..4 season probe on TV 777 when seasons endpoint returns 404
      if (u.endsWith('/tv/777/seasons') || u.endsWith('/tv/777')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      if (u.endsWith('/tv/777/season/1')) return { ok: true, json: async () => ({ episodes: [{ episode_number: 1, title: 'S1E1' }] }) };
      if (u.endsWith('/tv/777/season/2')) return { ok: true, json: async () => ({ episodes: [{ episode_number: 1, title: 'S2E1' }] }) };
      if (u.endsWith('/tv/777/season/3')) return { ok: true, json: async () => ({ episodes: [{ episode_number: 1, title: 'S3E1' }] }) };
      if (u.endsWith('/tv/777/season/4')) return { ok: false, status: 404, text: async () => '' };
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  // Remake year-dedupe: both Dune (1984) and Dune (2021) remain distinct, while Cinemeta merges onto 2021
  const duneSearch = await api.search('Dune', { type: 'movie' });
  const dunes = duneSearch.results.filter((r) => /^Dune$/i.test(r.title));
  assert.equal(dunes.length, 2, 'Remakes from 1984 and 2021 must remain distinct');
  const d1984 = dunes.find((r) => r.year === 1984);
  const d2021 = dunes.find((r) => r.year === 2021);
  assert.ok(d1984 && d2021);
  assert.equal(d2021.imdbId, 'tt1160419');

  // Union Cinemeta + TVMaze + primary seasons
  const unioned = await api.getTvSeasons('555');
  assert.deepEqual(unioned.seasons.map((s) => s.seasonNumber), [1, 2, 3, 4, 0]);

  // Bounded 1..4 season probe when upstream season manifest is omitted
  const probed = await api.getTvSeasons('777');
  assert.deepEqual(probed.seasons.map((s) => s.seasonNumber), [1, 2, 3]);
});

test('MovieUi dsx fetches Season 0 & Season 2 via getTvSeasonEpisodes, upsertCard handles media-kind & remote-photo fallback, and enrichTrack/normalizeTrack retain TV/lang IDs', async (t) => {
  const db = new Database(':memory:');
  db.migrate();
  t.after(() => db.close());

  const seasonEpCalls = [];
  const sentRich = [];
  const editedRich = [];
  let failNextRemotePhotoSend = false;

  const movieApi = new MovieApiClient({
    baseUrl: 'https://example.test/api',
    fetchImpl: async (url) => {
      const p = new URL(String(url)).pathname;
      if (p.endsWith('/search')) {
        return {
          ok: true,
          json: async () => ({
            results: [{
              provider_id: '9999',
              tmdb_id: '9999',
              imdb_id: 'tt9999999',
              type: 'tv',
              title: 'Machine Gunner',
              original_title: 'マシンガンナー',
              original_language: 'ja',
              year: 2024,
              poster: 'https://img.example/mg.jpg'
            }]
          })
        };
      }
      if (p.endsWith('/tv/9999/seasons')) {
        return {
          ok: true,
          json: async () => ({
            series_id: '9999',
            title: 'Machine Gunner',
            seasons: [
              { season_number: 1, name: 'Season 1', episode_count: 1 },
              { season_number: 2, name: 'Season 2', episode_count: 2 },
              { season_number: 0, name: 'Specials', episode_count: 1 }
            ]
          })
        };
      }
      if (p.endsWith('/tv/9999')) {
        return {
          ok: true,
          json: async () => ({
            provider_id: '9999',
            tmdb_id: '9999',
            imdb_id: 'tt9999999',
            type: 'tv',
            title: 'Machine Gunner',
            original_title: 'マシンガンナー',
            original_language: 'ja',
            year: 2024,
            poster: 'https://img.example/mg.jpg'
          })
        };
      }
      const seM = p.match(/\/tv\/9999\/season\/(\d+)$/);
      if (seM) {
        const sn = Number(seM[1]);
        seasonEpCalls.push(sn);
        return {
          ok: true,
          json: async () => ({
            series_id: '9999',
            season_number: sn,
            episodes: [
              {
                series_id: '9999',
                season_number: sn,
                episode_number: sn === 2 ? 3 : 1,
                title: `S${sn} Feature Ep`,
                air_date: '2024-05-01',
                runtime: 45
              }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  const subDir = mkdtempSync(join(tmpdir(), 'lancy-ui-ep-'));
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const dummyAudio = join(subDir, 'fx.mp3');
  writeFileSync(dummyAudio, 'ID3');
  const subtitles = new SubtitleService({ cacheDir: subDir, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const movieSessions = new MovieSessions({ db });

  let nextId = 500;
  const api = {
    me: { id: 999, username: 'LancyBot' },
    getChat: async (cid) => ({ id: cid, type: 'supergroup', title: 'Cinema GC' }),
    getChatMember: async () => ({ status: 'administrator', can_manage_voice_chats: true }),
    sendRichMessage: async (_cid, rich) => {
      const hasPhotoBlock = Boolean(rich?.photo || (Array.isArray(rich?.blocks) && rich.blocks.some((bl) => bl?.type === 'photo')));
      if (failNextRemotePhotoSend && hasPhotoBlock) {
        failNextRemotePhotoSend = false;
        throw new Error('Bad Request: failed to get http url content');
      }
      const m = { message_id: nextId++, rich };
      sentRich.push(m);
      return m;
    },
    editMessageRich: async (_cid, messageId, rich) => {
      const m = { message_id: messageId, rich };
      editedRich.push(m);
      return m;
    },
    deleteMessage: async () => true,
    answerCallbackQuery: async () => true
  };

  const voicePlayCalls = [];
  const voiceClient = {
    play: async (chatId, source, opts = {}) => { voicePlayCalls.push({ chatId, source, opts }); return { ok: true, account_alias: 'acc1' }; },
    stop: async () => ({ ok: true }),
    setSubtitle: async () => ({ ok: true }),
    accounts: async () => ({ accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] }),
    getStatus: async () => ({ ok: true, active: false })
  };

  const dlManifests = [];
  const app = {
    db,
    config: { ownerIds: [10] },
    sm: new StateMachine({ db }),
    movieApi,
    movieSessions,
    subtitles,
    voiceClient,
    telegram: { api },
    musicLibrary: { acquire: async (track) => ({ filePath: track.filePath || dummyAudio, track, release: () => {} }) },
    movieResolver: {
      resolve: async (desc) => ({
        ok: true,
        track: {
          id: `mv:${desc.id}:${desc.season}:${desc.episode}`,
          provider: 'movie',
          mediaType: 'video',
          mediaKind: 'tv',
          tmdbId: desc.tmdbId,
          imdbId: desc.imdbId,
          title: `${desc.title} · S0${desc.season}E0${desc.episode}`,
          streamUrl: 'https://cdn.example/s2e3.m3u8',
          isHls: true,
          durationSeconds: 2700,
          originalTitle: desc.originalTitle,
          originalLanguage: desc.originalLanguage,
          audioLanguage: 'ja'
        }
      })
    },
    movieDownloader: {
      resolveSelected: async (items) => {
        dlManifests.push(items);
        return items.map((x) => ({ ...x, ok: true }));
      }
    }
  };
  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  app.music = new MusicService({ app, search: new SearchSessions({ providers: {} }), lyrics: {}, accounts: { sync: async () => {} } });
  const screen = createMusicScreen({ app });
  t.after(async () => { await screen.cleanup(); await qm.shutdown(); });

  const ctx = { api, chatId: -10066, tgId: 10, user: { id: 10, first_name: 'Owner' }, query: null, messageId: null };
  await screen.handleCommand(ctx, '/movie', ['Machine', 'Gunner']);
  const ms = movieSessions.getLatestForChat(-10066);

  // Open TV show (Season 1)
  await screen.handle({ ...ctx, query: { id: 'q1' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '0']);

  // dsx for Season 2 (not cached yet -> calls getTvSeasonEpisodes(id, 2))
  ms.episodeCache.delete(2);
  await screen.handle({ ...ctx, query: { id: 'q-dsx2' }, messageId: ms.messageId }, 'mv', [ms.id, 'dsx', '2']);
  assert.ok(seasonEpCalls.includes(2), 'dsx must call getTvSeasonEpisodes for target Season 2');
  assert.equal(ms.dlManifest?.items?.[0]?.season, 2);

  // dsx for Season 0 Specials
  ms.episodeCache.delete(0);
  await screen.handle({ ...ctx, query: { id: 'q-dsx0' }, messageId: ms.messageId }, 'mv', [ms.id, 'dsx', '0']);
  assert.ok(seasonEpCalls.includes(0), 'dsx must support Season 0 Specials');
  assert.equal(ms.dlManifest?.items?.[0]?.season, 0);

  // upsertCard: changing photo null -> photo via hub -> pk triggers fresh sendRichMessage because !sameMediaKind
  await screen.handle({ ...ctx, query: { id: 'q-hub' }, messageId: ms.messageId }, 'mv', [ms.id, 'hb']);
  assert.equal(ms.messageHasPhoto, false);
  const sentBefore = sentRich.length;
  await screen.handle({ ...ctx, query: { id: 'q-pk2' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '0']);
  assert.equal(sentRich.length, sentBefore + 1, 'Changing from photo-less to photo card must send a fresh message');
  assert.equal(ms.messageHasPhoto, true);

  // upsertCard: remote-photo failure strips photo and retries sendRichMessage cleanly
  failNextRemotePhotoSend = true;
  ms.messageHasPhoto = false;
  await screen.handle({ ...ctx, query: { id: 'q-pk3' }, messageId: ms.messageId }, 'mv', [ms.id, 'pk', '0']);
  assert.equal(ms.messageHasPhoto, false);
  const lastSentRich = sentRich.at(-1)?.rich;
  assert.equal(Boolean(lastSentRich?.photo || lastSentRich?.blocks?.some?.((bl) => bl?.type === 'photo')), false);

  // Play S02E03 -> enrichTrack + normalizeTrack preserve TV & language IDs
  await screen.handle({ ...ctx, query: { id: 'q-s2' }, messageId: ms.messageId }, 'mv', [ms.id, 'so', '2']);
  await screen.handle({ ...ctx, query: { id: 'q-pe' }, messageId: ms.messageId }, 'mv', [ms.id, 'pe', '2-3']);
  const cur = qm.getSession(-10066).currentTrack;
  assert.equal(cur.mediaKind, 'tv');
  assert.equal(cur.tmdbId, '9999');
  assert.equal(cur.imdbId, 'tt9999999');
  assert.equal(cur.seriesId, '9999');
  assert.equal(cur.season, 2);
  assert.equal(cur.seasonNumber, 2);
  assert.equal(cur.episode, 3);
  assert.equal(cur.episodeNumber, 3);
  assert.equal(cur.episodeTitle, 'S2 Feature Ep');
  assert.equal(cur.originalLanguage, 'ja');
  assert.equal(cur.preferredAudioLang, 'ja');

  const nt = normalizeTrack({
    id: 'tv:9999:2:3',
    provider: 'movie',
    title: 'Machine Gunner',
    mediaKind: 'tv',
    tmdbId: '9999',
    imdbId: 'tt9999999',
    seriesId: '9999',
    season: 2,
    seasonNumber: 2,
    episode: 3,
    episodeNumber: 3,
    episodeTitle: 'S2 Feature Ep',
    originalLanguage: 'ja',
    releaseDate: '2024-05-01'
  });
  assert.equal(nt.seasonNumber, 2);
  assert.equal(nt.episodeNumber, 3);
  assert.equal(nt.originalLanguage, 'ja');
  assert.equal(nt.imdbId, 'tt9999999');
  assert.equal(nt.releaseDate, '2024-05-01');
});

test('MovieApiClient consolidates series compilation dupes, resolves franchise Season 12 episodes, and UI/Player hide raw source names & switch sources cleanly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-dino-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'test.sqlite'));
  db.migrate();
  t.after(() => db.close());

  const apiCalls = [];
  const api = new MovieApiClient({
    fetchImpl: async (rawUrl) => {
      const url = String(rawUrl);
      apiCalls.push(url);
      const okJson = (body) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() { return body; },
        async text() { return JSON.stringify(body); }
      });
      if (url.includes('/search?') && url.includes('q=')) {
        const u = new URL(url);
        const q = String(u.searchParams.get('q') || '').toLowerCase();
        const typeParam = String(u.searchParams.get('type') || '').toLowerCase();
        if (typeParam === 'tv' && q.includes('power rangers')) {
          return okJson({
            results: [
              { id: 2328, media_type: 'tv', name: 'Power Rangers', first_air_date: '1993-08-28', vote_average: 6.9 }
            ]
          });
        }
        return okJson({
          results: [
            { id: 812130, media_type: 'movie', title: 'Power Rangers Dino Thunder: Day of the Dino', release_date: '2004-02-14', vote_average: 6.7 },
            { id: 812131, media_type: 'movie', title: 'Power Rangers DinoThunder: White Thunder', release_date: '2004-06-15', vote_average: 6.5 }
          ]
        });
      }
      if (url.endsWith('/tv/2328/seasons')) {
        return okJson({
          seasons: [
            { season_number: 1, name: 'Mighty Morphin (Season 1)', episode_count: 60, air_date: '1993-08-28' },
            { season_number: 12, name: 'Power Rangers Dino Thunder', episode_count: 38, air_date: '2004-02-14' }
          ]
        });
      }
      if (url.endsWith('/tv/2328')) {
        return okJson({
          id: 2328,
          name: 'Power Rangers',
          first_air_date: '1993-08-28',
          seasons: [
            { season_number: 1, name: 'Mighty Morphin (Season 1)', episode_count: 60, air_date: '1993-08-28' },
            { season_number: 12, name: 'Power Rangers Dino Thunder', episode_count: 38, air_date: '2004-02-14' }
          ]
        });
      }
      if (url.endsWith('/tv/2328/season/12')) {
        return okJson({
          id: '2328-s12',
          season_number: 12,
          name: 'Power Rangers Dino Thunder',
          episodes: Array.from({ length: 38 }, (_, i) => ({
            episode_number: i + 1,
            name: i === 0 ? 'Day of the Dino (1)' : `Episode ${i + 1}`,
            air_date: '2004-02-14',
            runtime: 22
          }))
        });
      }
      if (url.includes('/playback/2328?') && url.includes('type=tv') && url.includes('season=12') && url.includes('episode=1')) {
        return okJson({
          root_stream: { hls_url: 'https://cdn.example/dino/s12e01.m3u8', direct_url: 'https://cdn.example/dino/s12e01.mp4', language: 'en' },
          servers: [{ id: 'cinezo', url: 'https://embed.example/dino/s12e01' }]
        });
      }
      if (url.includes('v3-cinemeta.strem.io/catalog/')) {
        return okJson({
          metas: [
            { id: 'tt0373587', type: 'series', name: 'Power Rangers DinoThunder', releaseInfo: '2004–2005', imdbRating: '6.8', videos: Array.from({ length: 17 }, (_, i) => ({ season: 1, episode: i + 1, title: `Ep ${i + 1}` })) },
            { id: 'tt0373587', type: 'series', name: 'Power Rangers DinoThunder', releaseInfo: '' }
          ]
        });
      }
      if (url.includes('v3-cinemeta.strem.io/meta/series/tt0373587.json')) {
        return okJson({
          meta: {
            id: 'tt0373587',
            imdb_id: 'tt0373587',
            type: 'series',
            name: 'Power Rangers DinoThunder',
            releaseInfo: '2004–2005',
            year: 2004,
            videos: Array.from({ length: 17 }, (_, i) => ({ season: 1, episode: i + 1, title: i === 0 ? 'Day of the Dino, Part 1' : `Episode ${i + 1}` }))
          }
        });
      }
      if (url.includes('api.tvmaze.com')) return okJson([]);
      if (url.includes('wikidata.org')) return okJson({ results: { bindings: [] } });
      return okJson({});
    }
  });

  const searchRes = await api.search('power rangers dino thunder');
  const topTv = searchRes.results.filter((r) => r.type === 'tv' && /dino\s*thunder/i.test(r.title));
  assert.equal(topTv.length, 1, 'Canonical TV series should appear once without undated ghost duplicate');
  assert.equal(topTv[0].year, 2004);
  const foldedMovies = searchRes.results.filter((r) => r.type === 'movie' && /day of the dino|white thunder/i.test(r.title));
  assert.equal(foldedMovies.length, 0, 'Same-year episode-arc compilation TV-movies should fold behind parent TV series');

  const detail = await api.getTvShow('tt0373587');
  assert.equal(detail.franchiseTmdbId, '2328');
  assert.equal(detail.franchiseSeasonNumber, 12);
  assert.equal(detail.totalEpisodes, 38);

  const s1 = await api.getTvSeasonEpisodes('tt0373587', 1);
  assert.equal(s1.episodes.length, 38, 'Should merge all 38 episodes from franchise Season 12 rather than truncating at 17');
  assert.equal(s1.episodes[0].title, 'Day of the Dino (1)');

  const pb = await api.getPlaybackInfo('tv', 'tt0373587', { season: 1, episode: 1 });
  assert.equal(pb.rootStream?.hls_url, 'https://cdn.example/dino/s12e01.m3u8');
  assert.equal(pb.tmdbId, '2328');
  assert.equal(pb.franchiseSeasonNumber, 12);
  assert.ok(apiCalls.some((u) => u.includes('/playback/2328?') && u.includes('type=tv') && u.includes('season=12') && u.includes('episode=1')));

  // Verify MovieUi renderResults & Cinema Player hide raw source names and support switchsource
  const voiceCalls = [];
  const voiceClient = {
    async setup(_chatId, _action, opts) { return { ok: true, call_invite_link: 'https://t.me/+cinema', vcTitle: opts?.vc_title }; },
    async play(chatId, source, opts) { voiceCalls.push({ chatId, source, opts }); return { ok: true, status: 'playing', durationSeconds: 1287, account_alias: 'acc1' }; },
    async pause() { return { ok: true }; },
    async resume() { return { ok: true }; },
    async seek() { return { ok: true }; },
    async status() { return { ok: true, active: false }; },
    async getStatus() { return { ok: true, active: false }; },
    async accounts() { return { accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] }; },
    async setSubtitle() { return { ok: true }; },
    async stop() { return { ok: true }; }
  };
  const sentMsgs = [];
  const editedMsgs = [];
  let nextUiMsgId = 100;
  const botApi = {
    me: { id: 999, username: 'LancyBot' },
    async sendMessage(chatId, text, extra) {
      const m = { message_id: nextUiMsgId++, chat: { id: chatId }, text, extra };
      sentMsgs.push(m);
      return m;
    },
    async editMessageText(chatId, msgId, text, extra) {
      const m = { message_id: msgId, chat: { id: chatId }, text, extra };
      editedMsgs.push(m);
      return m;
    },
    async sendRichMessage(chatId, rich) {
      const m = { message_id: nextUiMsgId++, chat: { id: chatId }, rich };
      sentMsgs.push(m);
      return m;
    },
    async editMessageRich(chatId, msgId, rich) {
      const m = { message_id: msgId, chat: { id: chatId }, rich };
      editedMsgs.push(m);
      return m;
    },
    async deleteMessage() { return true; },
    async answerCallbackQuery() { return true; },
    async getChat() { return { id: -10077, title: 'Cinema Room', type: 'supergroup' }; },
    async getChatMember() { return { status: 'administrator', can_manage_voice_chats: true }; }
  };

  const movieSessions = new MovieSessions({ db });
  const app = {
    db,
    botUsername: 'LancyBot',
    sm: new StateMachine({ db }),
    movieApi: api,
    subtitles: new SubtitleService({ cacheDir: dir, fetchImpl: async () => ({ ok: false, status: 404 }) }),
    telegram: { api: botApi },
    voiceClient,
    musicLibrary: { acquire: async (track) => ({ filePath: track.streamUrl || 'dummy.mp4', track, release: () => {} }) },
    movieResolver: {
      async resolve(track, opts = {}) {
        const excluded = new Set(opts.excludeUrls || []);
        if (!excluded.has('https://src1.example/dino.mp4') && excluded.size === 0) {
          return {
            ok: true,
            track: {
              id: 'tv:tt0373587:1:1',
              provider: 'movie',
              mediaType: 'video',
              title: 'Power Rangers DinoThunder · S01E01',
              streamUrl: 'https://src1.example/dino.mp4',
              sourceLabel: 'Source 1',
              durationSeconds: 1287,
              fallbackStreams: [{ url: 'https://src2.example/dino.m3u8', isHls: true, label: 'Source 2' }]
            }
          };
        }
        return {
          ok: true,
          track: {
            id: 'tv:tt0373587:1:1',
            provider: 'movie',
            mediaType: 'video',
            title: 'Power Rangers DinoThunder · S01E01',
            streamUrl: 'https://src3.example/dino-alt.mp4',
            sourceLabel: 'Source 3',
            durationSeconds: 1287
          }
        };
      }
    },
    movieSessions,
    searchSessions: new SearchSessions({ providers: {} }),
    config: { ownerIds: [10], adminIds: [10] }
  };
  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  app.music = new MusicService({
    app,
    search: new SearchSessions({ providers: {} }),
    lyrics: {},
    accounts: { sync: async () => {} }
  });
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  screen.registerStateHandlers?.(app.sm);
  t.after(async () => { await screen.cleanup(); await qm.shutdown(); });

  const ctx = { api: botApi, chatId: -10077, tgId: 10, user: { id: 10, first_name: 'Owner' }, query: null, messageId: null };
  await screen.handleCommand(ctx, '/movie', ['power', 'rangers', 'dino', 'thunder']);
  const cardPayload = JSON.stringify(sentMsgs.at(-1));
  assert.match(cardPayload, /Power Rangers DinoThunder/, 'Search card should show canonical DinoThunder series');
  assert.doesNotMatch(cardPayload, /cinemeta|tvmaze|holaflix|flikhub|vidbolt|thenkiri|archive_org/i, 'Search card must never show raw source names');

  assert.ok(PANEL_ACTIONS.includes('switchsource'), 'switchsource must be registered at end of PANEL_ACTIONS');

  // Switch Source cycles Source 1 -> Source 2 -> Source 1 preserving playback position
  const sess = qm.getSession(-10077);
  sess.prepared = true;
  sess.streamMode = 'rtmp';
  await qm.playImmediateAndContinue(-10077, {
    id: 'tv:tt0373587:1:1',
    provider: 'movie',
    mediaType: 'video',
    title: 'Power Rangers DinoThunder · S01E01',
    streamUrl: 'https://src1.example/dino.mp4',
    sourceLabel: 'Source 1',
    durationSeconds: 1287,
    fallbackStreams: [{ url: 'https://src2.example/dino.m3u8', isHls: true, label: 'Source 2' }]
  });
  await screen.handleCommand(ctx, '/player', []);
  sess.positionSeconds = 321;
  sess.positionUpdatedAt = Date.now();

  await app.music.control(ctx, 'switchsource', []);
  assert.equal(sess.currentTrack.streamUrl, 'https://src2.example/dino.m3u8');
  assert.equal(sess.currentTrack.sourceLabel, 'Source 2');
  assert.equal(voiceCalls.at(-1)?.opts?.startSeconds, 321);
  assert.doesNotMatch(sess.lastNotice, /cinemeta|tvmaze|holaflix|flikhub|vidbolt|thenkiri|archive/i);

  const playerSerialized = JSON.stringify(screen.renderCinemaPlayer(sess));
  assert.match(playerSerialized, /Source 2\/2/);
  assert.doesNotMatch(playerSerialized, /cinemeta|tvmaze|holaflix|flikhub|vidbolt|thenkiri|archive_org/i);

  // Cycle back to Source 1
  await app.music.control(ctx, 'switchsource', []);
  assert.equal(sess.currentTrack.streamUrl, 'https://src1.example/dino.mp4');
  assert.equal(sess.currentTrack.sourceLabel, 'Source 1');
  assert.match(JSON.stringify(screen.renderCinemaPlayer(sess)), /Source 1\/2/);
});
