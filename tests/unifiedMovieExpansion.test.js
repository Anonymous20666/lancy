import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { MovieApiClient } from '../src/media/movieApi.js';
import { MovieStreamResolver } from '../src/media/movieResolver.js';
import { SubtitleService } from '../src/media/subtitles.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import {
  RichMessageBuilder,
  inlineKeyboard,
  ikButton,
  richButton,
  rt,
  decodeCallback,
  richTextToString,
  normalizeButtonStyle
} from '../src/telegram/rich.js';

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

test('Bot API 10.3 RichMessageBuilder preserves link callback buttons while inlineKeyboard maps link -> primary', () => {
  assert.equal(normalizeButtonStyle('link'), 'link');
  assert.equal(normalizeButtonStyle('link', { allowLink: false }), 'primary');

  const rich = new RichMessageBuilder()
    .heading('Test Header', 1)
    .heading('1. 🎬 Test Movie', 3)
    .pullquote(rt.italic('Action-packed classic.'), rt.text('Movie · 1999 · ⭐ 8.7'))
    .divider()
    .buttons([
      richButton.callback('⚡ Play Now', 'music:mv:1:pmi:0', { style: 'success' }),
      richButton.callback('ℹ️', 'music:mv:1:pk:0', { style: 'link' })
    ])
    .footer('Lancy Cinema')
    .toJSON();

  const btns = collectButtons(rich);
  assert.equal(btns[0].style, 'success');
  assert.equal(btns[1].style, 'link');
  assert.equal(rich.blocks.some((b) => b.type === 'pullquote' && richTextToString(b.credit).includes('Movie · 1999')), true);
  assert.equal(rich.blocks.some((b) => b.type === 'footer'), true);

  const ik = inlineKeyboard([[
    ikButton('Play', 'a', { style: 'success' }),
    ikButton('Details', 'b', { style: 'link' })
  ]]);
  assert.equal(ik.inline_keyboard[0][0].style, 'success');
  assert.equal(ik.inline_keyboard[0][1].style, 'primary');
});

test('MovieApiClient expands catalog across Cinemeta, IMDb, TVMaze, YTS, WordPress & Archive and hydrates external IDs', async () => {
  const seenUrls = [];
  const fetchImpl = async (urlStr) => {
    const u = String(urlStr);
    seenUrls.push(u);
    if (u.startsWith('https://holaflix.test/search')) {
      return {
        ok: true,
        json: async () => ({
          results: [{
            id: '603',
            type: 'movie',
            title: 'The Matrix',
            year: 1999,
            overview: '',
            poster: null
          }]
        })
      };
    }
    if (u.startsWith('https://v3-cinemeta.strem.io/catalog/movie/search=') || u.startsWith('https://v3-cinemeta.strem.io/catalog/movie/top/search=')) {
      return {
        ok: true,
        json: async () => ({
          metas: [{
            id: 'tt0133093',
            imdb_id: 'tt0133093',
            name: 'The Matrix',
            year: '1999',
            poster: 'https://img.test/matrix.jpg',
            description: 'Neo awakens to simulated reality.',
            genres: ['Action', 'Sci-Fi'],
            imdbRating: '8.7'
          }]
        })
      };
    }
    if (u.startsWith('https://v3-cinemeta.strem.io/catalog/series/')) {
      return { ok: true, json: async () => ({ metas: [] }) };
    }
    if (u === 'https://v3-cinemeta.strem.io/meta/movie/tt0133093.json') {
      return {
        ok: true,
        json: async () => ({
          meta: {
            id: 'tt0133093',
            imdb_id: 'tt0133093',
            name: 'The Matrix',
            releaseInfo: '1999',
            runtime: '136 min',
            description: 'Full Cinemeta Matrix overview.',
            genres: ['Action', 'Sci-Fi'],
            imdbRating: '8.7',
            poster: 'https://img.test/matrix.jpg'
          }
        })
      };
    }
    if (u.startsWith('https://v3.sg.media-imdb.com/suggestion/')) {
      return {
        ok: true,
        json: async () => ({
          d: [{ id: 'tt0234215', l: 'The Matrix Reloaded', y: 2003, qid: 'movie', s: 'Keanu Reeves' }]
        })
      };
    }
    if (u.startsWith('https://movies-api.accel.li/api/v2/list_movies.json')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            movies: [{
              id: 777,
              imdb_code: 'tt0133093',
              title_english: 'The Matrix',
              year: 1999,
              rating: 8.7,
              runtime: 136,
              large_cover_image: 'https://yts.test/matrix.jpg'
            }]
          }
        })
      };
    }
    if (u.startsWith('https://api.tvmaze.com/search/shows')) {
      return {
        ok: true,
        json: async () => [{
          show: {
            id: 82,
            name: 'Matrix Chronology',
            premiered: '2020-01-01',
            genres: ['Sci-Fi'],
            rating: { average: 8.1 },
            runtime: 45,
            summary: '<p>Series summary</p>',
            externals: {}
          }
        }]
      };
    }
    if (u === 'https://api.tvmaze.com/shows/82?embed=episodes') {
      return {
        ok: true,
        json: async () => ({
          id: 82,
          name: 'Matrix Chronology',
          premiered: '2020-01-01',
          genres: ['Sci-Fi'],
          rating: { average: 8.1 },
          runtime: 45,
          summary: '<p>Full show summary</p>',
          _embedded: {
            episodes: [
              { season: 1, number: 1, name: 'Pilot Protocol', airdate: '2020-01-01', runtime: 46, summary: '<p>Ep 1</p>' },
              { season: 1, number: 2, name: 'Zion Signal', airdate: '2020-01-08', runtime: 44, summary: '<p>Ep 2</p>' }
            ]
          }
        })
      };
    }
    if (u.startsWith('https://thenkiri.com/wp-json/wp/v2/posts')) {
      return {
        ok: true,
        json: async () => [{
          id: 505,
          title: { rendered: 'Matrix Revolutions (2003) (DOWNLOAD MOVIE)' },
          link: 'https://thenkiri.com/matrix-revolutions/',
          excerpt: { rendered: '<p>Zion defends against sentinel swarm.</p>' },
          content: { rendered: '<a href="https://downloadwella.com/matrix3.mkv">Download</a>' }
        }]
      };
    }
    if (u.startsWith('https://nkiri.ink/wp-json/wp/v2/posts')) {
      return { ok: true, json: async () => [] };
    }
    if (u.startsWith('https://archive.org/advancedsearch.php')) {
      return {
        ok: true,
        json: async () => ({
          response: {
            docs: [{
              identifier: 'NightOfTheLivingDead1968',
              title: 'Night of the Living Dead',
              year: '1968',
              description: 'Public domain horror classic.'
            }]
          }
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const api = new MovieApiClient({ baseUrl: 'https://holaflix.test', fetchImpl });
  const search = await api.search('The Matrix');
  assert.ok(search.results.length >= 4, 'Expected merged primary + Cinemeta + IMDb + TVMaze + WordPress results');

  // Primary HolaFlix hit should be enriched with Cinemeta IMDb ID & poster/overview instead of duplicated
  const primaryMatrix = search.results.find((r) => String(r.id) === '603');
  assert.ok(primaryMatrix);
  assert.equal(primaryMatrix.imdbId, 'tt0133093');
  assert.equal(primaryMatrix.poster, 'https://img.test/matrix.jpg');
  assert.match(primaryMatrix.overview, /Neo awakens/);

  // WordPress direct downloadUrl should be captured and title cleaned
  const wpEntry = search.results.find((r) => r.id === 'wp:thenkiri:505');
  assert.ok(wpEntry);
  assert.equal(wpEntry.title, 'Matrix Revolutions (2003)');
  assert.deepEqual(wpEntry.downloadUrls, ['https://downloadwella.com/matrix3.mkv']);

  // External ID hydration
  const cinMovie = await api.getMovie('tt0133093');
  assert.equal(cinMovie.title, 'The Matrix');
  assert.equal(cinMovie.runtimeMinutes, 136);

  const tvShow = await api.getTvShow('tvmaze:82');
  assert.equal(tvShow.title, 'Matrix Chronology');
  const tvEps = await api.getTvSeasonEpisodes('tvmaze:82', 1);
  assert.equal(tvEps.episodes.length, 2);
  assert.equal(tvEps.episodes[0].title, 'Pilot Protocol');

  const wpPlayback = await api.getPlaybackInfo('movie', 'wp:thenkiri:505');
  assert.equal(wpPlayback.available, true);

  // Sparse classic query triggers Internet Archive fallback
  const classic = await api.search('Night of the Living Dead 1968');
  const archHit = classic.results.find((r) => r.id === 'archive:NightOfTheLivingDead1968');
  assert.ok(archHit);
  assert.ok(seenUrls.some((u) => u.includes('archive.org/advancedsearch.php')));
});

test('MovieStreamResolver resolves IMDb tt-ID via jennifer -> Punkflix, Archive MP4, PeerTube, socialAdapters & DownloadWella while rejecting trailers', async (t) => {
  const subDir = mkdtempSync(join(tmpdir(), 'lancy-exp-subs-'));
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const subtitles = new SubtitleService({ cacheDir: subDir, fetchImpl: async () => ({ ok: false, status: 404 }) });

  // 1. IMDb tt-ID discovery via jennifer Wave A -> Punkflix -> subtitle hints
  const fetchedRoutes = [];
  const imdbResolver = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ available: false, servers: [] }) },
    subtitles,
    enableWebFallback: false,
    fetchImpl: async (urlStr) => {
      const u = String(urlStr);
      fetchedRoutes.push(u);
      if (u.includes('jennifer') && u.includes('id=tt0903747')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: { id: 1396, title: 'Breaking Bad' },
            sources: []
          })
        };
      }
      if (u === 'https://punkflix.net/tv/1396/1/1.json') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            streams: [{
              url: 'https://cdn.example.test/bb-s01e01-720p.mp4',
              quality: '720p',
              subtitles: [{ url: 'https://subs.example.test/bb-en.vtt', lang: 'en', label: 'English' }]
            }]
          })
        };
      }
      if (u === 'https://cdn.example.test/bb-s01e01-720p.mp4') {
        return {
          ok: true,
          status: 206,
          url: u,
          headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '650000000' })
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });

  const imdbPlay = await imdbResolver.resolve({
    type: 'tv',
    id: 'tt0903747',
    imdbId: 'tt0903747',
    title: 'Breaking Bad',
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: 'Pilot'
  });
  assert.equal(imdbPlay.ok, true);
  assert.equal(imdbPlay.track.streamUrl, 'https://cdn.example.test/bb-s01e01-720p.mp4');
  assert.ok(fetchedRoutes.some((u) => u.includes('jennifer')));
  assert.ok(fetchedRoutes.some((u) => u === 'https://punkflix.net/tv/1396/1/1.json'));

  // 2. Step 1.5 direct downloadUrls (WordPress index) & sanitized thenkiriDetails attributes
  const wpResolver = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ available: false, servers: [] }) },
    subtitles,
    enableWebFallback: false,
    fetchImpl: async (urlStr) => {
      const u = String(urlStr);
      if (u === 'https://downloadwella.com/wp-direct-item') {
        return {
          ok: true,
          status: 200,
          url: 'https://cdn.downloadwella.com/files/matrix_1080p.mkv',
          headers: new Headers({ 'content-type': 'video/x-matroska', 'content-length': '900000000' }),
          text: async () => '<a href="https://cdn.downloadwella.com/files/matrix_1080p.mkv">Download</a>'
        };
      }
      if (u === 'https://cdn.downloadwella.com/files/matrix_1080p.mkv') {
        return {
          ok: true,
          status: 200,
          url: u,
          headers: new Headers({ 'content-type': 'video/x-matroska', 'content-length': '900000000' })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
    thenkiri: {
      thenkiriSearch: async () => ({ results: [{ title: 'Some Indie Film (2024)', url: 'https://thenkiri.example/indie' }] }),
      thenkiriDetails: async () => ({
        sources: [{
          title: 'Some Indie Film',
          label: '<span class="elementor-button-text">Download Movie</span>',
          url: 'https://downloadwella.com/wp-direct-item'
        }]
      }),
      thenkiriGetLink: async () => ({ url: 'https://cdn.downloadwella.com/files/matrix_1080p.mkv', format: 'mkv' })
    }
  });
  const dlPlay = await wpResolver.resolve({
    type: 'movie',
    id: 'wp:thenkiri:505',
    title: 'Matrix Revolutions',
    year: 2003,
    downloadUrls: ['https://downloadwella.com/wp-direct-item']
  });
  assert.equal(dlPlay.ok, true);
  assert.equal(dlPlay.track.streamUrl, 'https://cdn.downloadwella.com/files/matrix_1080p.mkv');

  const sanitizePlay = await wpResolver.resolve({
    type: 'movie',
    id: '90001',
    title: 'Some Indie Film',
    year: 2024
  });
  assert.equal(sanitizePlay.ok, true);
  assert.equal(sanitizePlay.track.streamUrl, 'https://cdn.downloadwella.com/files/matrix_1080p.mkv');

  // 3. PeerTube (SepiaSearch) resolves full-length MP4 & rejects trailers + short clips, while ok.ru rejects trailer hits
  const openWebResolver = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ available: false, servers: [] }) },
    subtitles,
    enableYtDlp: true,
    enableWebFallback: true,
    thenkiri: { thenkiriSearch: async () => ({ results: [] }), thenkiriDetails: async () => ({ sources: [] }), thenkiriGetLink: async () => null },
    socialAdapters: {
      catalogSearch: async (prov) => (prov === 'dramafren' ? { results: [] } : { results: [] }),
      dramafrenDl: async () => null,
      anydramaDl: async () => null,
      justwatchWatch: async () => null
    },
    fetchImpl: async (urlStr) => {
      const u = String(urlStr);
      if (u.startsWith('https://archive.org/advancedsearch.php')) {
        return { ok: true, json: async () => ({ response: { docs: [] } }) };
      }
      if (u.startsWith('https://sepiasearch.org/api/v1/search/videos')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { uuid: 'trailer-1', name: 'Charade 1963 Official Trailer', duration: 120, url: 'https://peertube.example/w/trailer-1' },
              { uuid: 'short-2', name: 'Charade (1963) Scene Clip', duration: 300, url: 'https://peertube.example/w/short-2' },
              { uuid: 'full-3', name: 'Charade (1963)', duration: 6780, url: 'https://peertube.example/w/full-3' }
            ]
          })
        };
      }
      if (u === 'https://peertube.example/api/v1/videos/full-3') {
        return {
          ok: true,
          json: async () => ({
            duration: 6780,
            files: [{
              resolution: { id: 720, label: '720p' },
              size: 850000000,
              fileUrl: 'https://peertube.example/static/webseed/charade-720p.mp4'
            }]
          })
        };
      }
      if (u === 'https://peertube.example/static/webseed/charade-720p.mp4') {
        return {
          ok: true,
          status: 206,
          url: u,
          headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '850000000' })
        };
      }
      if (u.startsWith('https://m.ok.ru/')) {
        return {
          ok: true,
          text: async () => '<a href="/video/11223344">Charade Official Trailer</a>'
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });
  const peerPlay = await openWebResolver.resolve({
    type: 'movie',
    id: '4808',
    title: 'Charade',
    year: 1963
  });
  assert.equal(peerPlay.ok, true);
  assert.equal(peerPlay.track.streamUrl, 'https://peertube.example/static/webseed/charade-720p.mp4');

  // 4. Archive fast-path resolves direct feature MP4 & skips teaser < minDuration
  const archiveResolver = new MovieStreamResolver({
    movieApi: { getPlaybackInfo: async () => ({ available: false, servers: [] }) },
    subtitles,
    enableWebFallback: true,
    thenkiri: { thenkiriSearch: async () => ({ results: [] }), thenkiriDetails: async () => ({ sources: [] }), thenkiriGetLink: async () => null },
    fetchImpl: async (urlStr) => {
      const u = String(urlStr);
      if (u === 'https://archive.org/metadata/NightOfTheLivingDead1968') {
        return {
          ok: true,
          json: async () => ({
            metadata: { title: 'Night of the Living Dead (1968)' },
            files: [
              { name: 'trailer.mp4', length: '95', size: '12000000' },
              { name: 'Night_of_the_Living_Dead_512kb.mp4', length: '5760', size: '420000000' }
            ]
          })
        };
      }
      if (u.startsWith('https://archive.org/download/NightOfTheLivingDead1968/Night_of_the_Living_Dead_512kb.mp4')) {
        return {
          ok: true,
          status: 206,
          url: u,
          headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '420000000' })
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  });
  const archPlay = await archiveResolver.resolve({
    type: 'movie',
    id: 'archive:NightOfTheLivingDead1968',
    title: 'Night of the Living Dead',
    year: 1968
  });
  assert.equal(archPlay.ok, true);
  assert.match(archPlay.track.streamUrl, /Night_of_the_Living_Dead_512kb\.mp4/);
});

test('MovieUI unified /movie search, Bot API 10.3 Rich Card inline Play/Queue/Download, GC reply-tag, locked xfu ephemeral notice & Cancel cleanup', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const subDir = mkdtempSync(join(tmpdir(), 'lancy-ui-exp-'));
  const dummyFile = join(subDir, 'sample.mp4');
  writeFileSync(dummyFile, 'MP4DATA');
  t.after(() => rmSync(subDir, { recursive: true, force: true }));

  const settings = new SettingsManager(db, { env: { OWNER_IDS: '10' } });
  const sm = new StateMachine();
  const movieSessions = new MovieSessions({ db });
  const includeAdultCalls = [];
  const adultSearchCalls = [];
  const sentRich = [];
  const editedRich = [];
  const deletedMessages = [];
  const ephemeralSent = [];
  const ephemeralDeleted = [];
  const callbackAlerts = [];
  const voicePlays = [];
  const downloadedSingles = [];
  let msgSeq = 500;

  const movieApi = {
    async search(query, opts = {}) {
      includeAdultCalls.push(Boolean(opts.includeAdultFallback));
      return {
        results: [
          {
            id: '27205',
            type: 'movie',
            title: 'Inception',
            year: 2010,
            overview: 'A thief who steals corporate secrets through dream-sharing.',
            poster: 'https://img.test/inc.jpg',
            rating: 8.8,
            genres: ['Sci-Fi']
          },
          {
            id: '1396',
            type: 'tv',
            title: 'Breaking Bad',
            year: 2008,
            overview: 'Chemistry teacher becomes kingpin.',
            poster: 'https://img.test/bb.jpg',
            rating: 9.5,
            genres: ['Drama']
          },
          {
            id: '603',
            type: 'movie',
            title: 'The Matrix',
            year: 1999,
            overview: 'Hacker discovers simulated world.',
            poster: 'https://img.test/mat.jpg',
            rating: 8.7,
            genres: ['Action']
          },
          {
            id: '157336',
            type: 'movie',
            title: 'Interstellar',
            year: 2014,
            overview: 'Explorers travel through a wormhole in space.',
            poster: 'https://img.test/int.jpg',
            rating: 8.7,
            genres: ['Sci-Fi']
          },
          {
            id: '155',
            type: 'movie',
            title: 'The Dark Knight',
            year: 2008,
            overview: 'Batman faces the Joker in Gotham.',
            poster: 'https://img.test/tdk.jpg',
            rating: 9.0,
            genres: ['Action']
          }
        ]
      };
    },
    async getMovie(id) {
      return { id: String(id), type: 'movie', title: 'Inception', year: 2010, poster: 'https://img.test/inc.jpg' };
    },
    async getTvShow(id) {
      return { id: String(id), type: 'tv', title: 'Breaking Bad', year: 2008, poster: 'https://img.test/bb.jpg', totalSeasons: 1, totalEpisodes: 1 };
    },
    async getTvSeasons() {
      return { seriesId: '1396', title: 'Breaking Bad', totalSeasons: 1, seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 1 }] };
    },
    async getTvSeasonEpisodes() {
      return { seriesId: '1396', seasonNumber: 1, episodes: [{ episodeNumber: 1, seasonNumber: 1, title: 'Pilot', runtimeMinutes: 48, runtimeSeconds: 2880 }] };
    },
    async getPlaybackInfo() {
      return { available: false, servers: [] };
    }
  };

  const adultItems = [{
    id: 'xv900',
    title: 'Pirates II: Stagnetti Revenge',
    duration: '1:58:00',
    durationSeconds: 7080,
    thumbUrl: 'https://cdn.example/pirates.jpg',
    pageUrl: 'https://www.xvideos.com/video.xv900/pirates',
    artist: 'Jesse Jane',
    sourceKey: 'xvideos',
    sourceName: 'XVideos',
    year: 2008
  }];

  const adultCatalog = {
    isBlockedAdultText: () => false,
    async search(opts) {
      adultSearchCalls.push(opts);
      return { results: adultItems, page: opts.page || 0, totalPages: 1 };
    },
    async searchXvideos(opts) {
      adultSearchCalls.push({ source: 'xvideos', ...opts });
      return { results: adultItems, page: opts.page || 0, totalPages: 1 };
    },
    async resolveStream(item) {
      return {
        streamUrl: 'https://cdn.example/pirates_720p.mp4',
        fullTitle: item.title,
        durationSeconds: item.durationSeconds,
        qualityLabel: '720p',
        variants: [{ height: 720, url: 'https://cdn.example/pirates_720p.mp4' }]
      };
    }
  };

  const api = {
    me: { id: 999, username: 'LancyBot' },
    async getChat(chatId) {
      return { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', title: 'Movie GC' };
    },
    async getChatMember(chatId, userId) {
      if (Number(userId) === 202) return { status: 'member' };
      return { status: 'administrator', can_manage_voice_chats: true };
    },
    async sendRichMessage(chatId, rich, extra = {}) {
      const m = { message_id: ++msgSeq, chat: { id: chatId }, rich, extra };
      sentRich.push(m);
      return m;
    },
    async editMessageRich(chatId, messageId, rich) {
      const m = { message_id: messageId, chat: { id: chatId }, rich };
      editedRich.push(m);
      return m;
    },
    async sendEphemeralRichNotice(chatId, params, rich) {
      const m = { ephemeral_message_id: ++msgSeq, chat_id: chatId, params, rich };
      ephemeralSent.push(m);
      return m;
    },
    async deleteEphemeralMessage(chatId, receiverUserId, ephemeralMessageId) {
      ephemeralDeleted.push({ chatId, receiverUserId, ephemeralMessageId });
      return true;
    },
    async deleteMessage(chatId, messageId) {
      deletedMessages.push({ chatId, messageId });
      return true;
    },
    async answerCallbackQuery(id, opts = {}) {
      callbackAlerts.push({ id, ...opts });
      return true;
    },
    async sendMessage(chatId, text, extra = {}) {
      return { message_id: ++msgSeq, chat: { id: chatId }, text, extra };
    }
  };

  const voiceClient = {
    async accounts() { return { accounts: [{ alias: 'acc1', enabled: true, status: 'available' }] }; },
    async play(chatId, source, opts = {}) {
      voicePlays.push({ chatId, source, opts });
      return { ok: true, account_alias: 'acc1' };
    },
    async stop() { return { ok: true }; },
    async getStatus() { return { ok: true, active: false }; },
    async setSubtitle() { return { ok: true }; }
  };

  const app = {
    db,
    sm,
    settings,
    movieApi,
    movieSessions,
    adultCatalog,
    voiceClient,
    telegram: { api },
    subtitles: new SubtitleService({ cacheDir: subDir }),
    movieResolver: {
      async resolve(desc) {
        return {
          ok: true,
          track: {
            id: `mv:${desc.id}`,
            provider: 'movie',
            title: `${desc.title}${desc.season ? ` · S01E01` : ''}`,
            artist: 'Feature Film · 720p',
            durationSeconds: 5400,
            mediaType: 'video',
            streamUrl: `https://cdn.example/${desc.id}.mp4`,
            filePath: dummyFile,
            capabilities: { video: true }
          },
          subtitles: null
        };
      }
    },
    movieDownloader: {
      hasCachedVideo: () => false,
      async sendSingleVideo(ctx, desc, opts = {}) {
        downloadedSingles.push({ chatId: ctx.chatId, desc, opts });
        return { ok: true };
      }
    },
    videoServer: {
      registerRemoteStream: ({ url }) => `http://127.0.0.1:3099/proxy?u=${encodeURIComponent(url)}`
    },
    musicLibrary: {
      async acquire(track) {
        return { filePath: dummyFile, track: { ...track, filePath: dummyFile }, release: () => {} };
      }
    }
  };

  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  app.musicQueueManager = qm;
  app.music = new MusicService({ app, search: { create: () => null }, lyrics: {}, accounts: { sync: async () => {} } });
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  screen.registerStateHandlers(sm);
  t.after(async () => {
    await screen.cleanup();
    await qm.shutdown();
  });

  // 1. Locked GC `/movie inception` opened by DJ user 202 (non-admin): replies directly to trigger message, hides adult search merge, but shows 🔞 XVideos / 18+ button
  const gcId = -100999;
  db.setSetting(`music.djs.${gcId}`, ['202']);
  const msGc = await screen.movieUi.openMovieSearch({
    api,
    chatId: gcId,
    tgId: '202',
    isGroup: true,
    user: { tg_id: 202, first_name: 'Member' },
    message: { message_id: 77 }
  }, 'inception', { originMessageId: 77, forceNewCard: true });

  assert.equal(includeAdultCalls.at(-1), false);
  assert.equal(adultSearchCalls.length, 0);
  const firstGcSent = sentRich.at(-1);
  assert.deepEqual(firstGcSent.extra?.reply_parameters, { message_id: 77, allow_sending_without_reply: true });
  const gcBtns = collectButtons(firstGcSent.rich);
  const xfuBtn = gcBtns.find((b) => btnText(b).includes('🔞 XVideos / 18+'));
  assert.ok(xfuBtn);

  // 2. Pagination (`More ⏩`) edits the SAME GC card in-place instead of sending a new card
  const sentBeforePage = sentRich.length;
  const moreBtn = gcBtns.find((b) => btnText(b).includes('More'));
  const moreDec = decodeCallback(moreBtn.callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '202',
    isGroup: true,
    user: { tg_id: 202 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_more', from: { id: 202 }, message: { message_id: firstGcSent.message_id } }
  }, moreDec.action, moreDec.args);
  assert.equal(sentRich.length, sentBeforePage);
  assert.ok(editedRich.length >= 1);
  assert.match(JSON.stringify(editedRich.at(-1).rich), /The Dark Knight/);

  // 3. Non-admin tapping 🔞 XVideos / 18+ in locked GC gets Bot API 10.3 ephemeral notice & keeps group locked
  const xfuDec = decodeCallback(xfuBtn.callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '202',
    receiverUserId: 202,
    isGroup: true,
    user: { tg_id: 202 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_nonadmin_xfu', from: { id: 202 }, message: { message_id: firstGcSent.message_id } }
  }, xfuDec.action, xfuDec.args);
  assert.equal(ephemeralSent.length, 1);
  assert.equal(ephemeralSent[0].params.receiverUserId, 202);
  assert.equal(Boolean(db.getSetting(`nsfw.groupEnabled.${gcId}`)), false);

  // 4. Per-item ⚡ Play Now (Movie #1) & ➕ Queue (TV #2) directly from the Search Card
  // Navigate back to Page 1 first
  const prevBtn = collectButtons(editedRich.at(-1).rich).find((b) => btnText(b).includes('Prev'));
  const prevDec = decodeCallback(prevBtn.callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_prev', from: { id: 10 }, message: { message_id: firstGcSent.message_id } }
  }, prevDec.action, prevDec.args);

  const page1Btns = collectButtons(editedRich.at(-1).rich);
  const playItem0 = page1Btns.find((b) => decodeCallback(b.callback_data)?.args?.[1] === 'pmi');
  const queueItem1 = page1Btns.filter((b) => decodeCallback(b.callback_data)?.args?.[1] === 'qmi')[1];
  const pmiDec = decodeCallback(playItem0.callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_pmi', from: { id: 10 }, message: { message_id: firstGcSent.message_id } }
  }, pmiDec.action, pmiDec.args);
  assert.equal(voicePlays.length, 1);

  const qmiDec = decodeCallback(queueItem1.callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_qmi', from: { id: 10 }, message: { message_id: firstGcSent.message_id } }
  }, qmiDec.action, qmiDec.args);
  const qSession = qm.getSession(gcId);
  assert.equal(qSession.movieUpcoming.length, 1);
  assert.match(qSession.movieUpcoming[0].title, /Breaking Bad · S01E01/);

  // 5. Group admin (tgId 303, not OWNER_IDS, age-verified) 1-tap unlocks XVideos via xfu button and searches active query
  db.setSetting('nsfw.ageVerified.303', true);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '303',
    isGroup: true,
    user: { tg_id: 303 },
    messageId: firstGcSent.message_id,
    query: { id: 'q_admin_xfu', from: { id: 303 }, message: { message_id: firstGcSent.message_id } }
  }, xfuDec.action, xfuDec.args);
  assert.equal(db.getSetting(`nsfw.groupEnabled.${gcId}`), true);
  assert.ok(adultSearchCalls.some((c) => c.source === 'all'));

  // 6. Launch a separate /movie search while VC Playing Card (firstGcSent) is active, then tap Cancel (xca) to delete only the new search card + prompt + ephemeral notice
  const msCancel = await screen.movieUi.openMovieSearch({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    message: { message_id: 88 }
  }, 'matrix', { originMessageId: 88, forceNewCard: true });
  const cancelCard = sentRich.at(-1);
  assert.notEqual(cancelCard.message_id, firstGcSent.message_id);
  msCancel.promptMessageId = 444;
  msCancel.ephemeralMessageId = 555;
  msCancel.receiverUserId = 202;
  const xcaDec = decodeCallback(collectButtons(cancelCard.rich).find((b) => decodeCallback(b.callback_data)?.args?.[1] === 'xca').callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '202',
    receiverUserId: 202,
    isGroup: true,
    user: { tg_id: 202 },
    messageId: cancelCard.message_id,
    query: { id: 'q_cancel', from: { id: 202 }, message: { message_id: cancelCard.message_id } }
  }, xcaDec.action, xcaDec.args);
  assert.ok(deletedMessages.some((d) => d.messageId === cancelCard.message_id));
  assert.ok(deletedMessages.some((d) => d.messageId === 444));
  assert.ok(ephemeralDeleted.some((d) => d.ephemeralMessageId === 555));
  assert.equal(deletedMessages.some((d) => d.messageId === firstGcSent.message_id), false);

  // 7. DM unified search merges normal movies + 18+ features when allowed and age-verified
  const dmId = 88088;
  db.setSetting(`nsfw.ageVerified.${dmId}`, true);
  db.setSetting('nsfw.ageVerified.10', true);
  const msDm = await screen.movieUi.openMovieSearch({
    api,
    chatId: dmId,
    tgId: String(dmId),
    isGroup: false,
    user: { tg_id: dmId },
    message: { message_id: 91 }
  }, 'pirates stagnetti', { originMessageId: 91, forceNewCard: true });
  assert.equal(includeAdultCalls.at(-1), true);
  assert.ok(msDm.results.some((r) => r.isAdultCatalogItem && /Pirates II/i.test(r.title)));
  assert.ok(msDm.results.some((r) => !r.isAdultCatalogItem && /Inception/i.test(r.title)));

  // 8. GC unlocked unified search + per-item dmi download forwards spoiler=true for adult item & normal dmi download
  const msGcUnlocked = await screen.movieUi.openMovieSearch({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    message: { message_id: 105 }
  }, 'pirates', { originMessageId: 105, forceNewCard: true });
  const unlockedCard = sentRich.at(-1);
  const dmiButtons = collectButtons(unlockedCard.rich).filter((b) => decodeCallback(b.callback_data)?.args?.[1] === 'dmi');
  assert.ok(dmiButtons.length >= 2);
  const adultIdx = msGcUnlocked.results.slice(0, 3).findIndex((r) => r.isAdultCatalogItem);
  const normalIdx = msGcUnlocked.results.slice(0, 3).findIndex((r) => !r.isAdultCatalogItem);
  assert.ok(adultIdx >= 0 && normalIdx >= 0);

  const normalDmiDec = decodeCallback(dmiButtons[normalIdx].callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    messageId: unlockedCard.message_id,
    query: { id: 'q_dmi_norm', from: { id: 10 }, message: { message_id: unlockedCard.message_id } }
  }, normalDmiDec.action, normalDmiDec.args);

  const adultDmiDec = decodeCallback(dmiButtons[adultIdx].callback_data);
  await screen.handle({
    api,
    chatId: gcId,
    tgId: '10',
    isGroup: true,
    user: { tg_id: 10 },
    messageId: unlockedCard.message_id,
    query: { id: 'q_dmi_adult', from: { id: 10 }, message: { message_id: unlockedCard.message_id } }
  }, adultDmiDec.action, adultDmiDec.args);

  assert.equal(downloadedSingles.length, 2);
  assert.equal(downloadedSingles[0].opts.spoiler, false);
  assert.equal(downloadedSingles[1].opts.spoiler, true);
});
