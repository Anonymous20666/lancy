import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAdultMovieQuery,
  scoreAdultTitleMatch,
  unpackPacker,
  extractEmbedStream,
  searchFullXCinema,
  resolveFullXCinemaStream,
  searchPandaMovies,
  resolvePandaMoviesStream,
  searchXHamster,
  resolveXHamsterStream,
  searchPornTrex,
  resolvePornTrexStream
} from '../src/media/adultFeatureSources.js';
import { AdultCatalog } from '../src/media/adultCatalog.js';
import { MovieApiClient } from '../src/media/movieApi.js';
import { MovieStreamResolver, scoreTitleMatch } from '../src/media/movieResolver.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { MovieSessions } from '../src/media/movieSessions.js';
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

test('normalizeAdultMovieQuery repairs parody typos, strips filler phrases, and keeps years', () => {
  const q1 = normalizeAdultMovieQuery('pirate of the Caribbean stegenneti n so on sex movies by porn Stars');
  assert.match(q1.primaryQuery, /pirates/i);
  assert.match(q1.primaryQuery, /stagnetti/i);
  assert.equal(q1.preferFullFeatures, true);
  assert.ok(q1.fallbackQueries.some((x) => /Pirates Stagnetti/i.test(x)));

  const q2 = normalizeAdultMovieQuery('Femalion: Cosmic Crush (2020)');
  assert.match(q2.primaryQuery, /femalien/i);
  assert.equal(q2.year, 2020);
});

test('unpackPacker & extractEmbedStream unpack Dean Edwards p,a,c,k,e,d MixDrop & decode StreamTape robotlink without eval', async () => {
  const packedHtml = `<script>eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0.1="//2.3.4/v/5.6";',7,7,'MDCore|wurl|cdn|mixdrop|co|movie720|mp4'.split('|'),0,{}))</script>`;
  const unpacked = unpackPacker(packedHtml);
  assert.equal(unpacked, 'MDCore.wurl="//cdn.mixdrop.co/v/movie720.mp4";');

  const mixRes = await extractEmbedStream('https://mixdrop.ag/e/abc123', {
    fetchImpl: async (u) => {
      if (u === 'https://mixdrop.ag/e/abc123') return { ok: true, text: async () => packedHtml };
      return { ok: false, status: 404, text: async () => '' };
    }
  });
  assert.equal(mixRes.streamUrl, 'https://cdn.mixdrop.co/v/movie720.mp4');
  assert.equal(mixRes.isHls, false);

  const stHtml = `<script>document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=' + ('xyztoken=12345&expires=999'.substring(3)) + '&stream=1';</script>`;
  const stRes = await extractEmbedStream('https://streamtape.com/e/demo', {
    fetchImpl: async (u) => {
      if (u === 'https://streamtape.com/e/demo') return { ok: true, text: async () => stHtml };
      return { ok: true, status: 302, headers: new Headers({ location: 'https://cdn.tapecontent.net/final/movie.mp4' }) };
    }
  });
  assert.equal(stRes.streamUrl, 'https://cdn.tapecontent.net/final/movie.mp4');
  assert.equal(stRes.isHls, false);
});

test('Adult feature providers (FullXCinema, PandaMovies, xHamster, PornTrex) prefer direct MP4 over HLS', async () => {
  const packedMix = `eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0.1="//cdn.mixdrop.ag/v/sorrowbay.6";',7,7,'MDCore|wurl|cdn|mixdrop|ag|sorrowbay|mp4'.split('|'),0,{}))`;
  const fakeB64 = Buffer.from(encodeURIComponent(`<video><source src="https://cdn.freevidco.com/Deadly%20Pickup.mp4" type="video/mp4"/></video>`), 'utf8').toString('base64');

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://fullxcinema.com/wp-json/wp/v2/posts')) {
      return {
        ok: true,
        headers: new Headers({ 'x-wp-totalpages': '2' }),
        json: async () => [{
          id: 501,
          link: 'https://fullxcinema.com/2023/01/deadly-pickup-2016/',
          title: { rendered: 'Deadly Pickup (2016)' },
          _embedded: { 'wp:featuredmedia': [{ source_url: 'https://fullxcinema.com/thumb.jpg' }] }
        }]
      };
    }
    if (u === 'https://fullxcinema.com/2023/01/deadly-pickup-2016/') {
      return {
        ok: true,
        text: async () => `<iframe src="https://fullxcinema.com/wp-content/plugins/clean-tube-player/player-x.php?q=${encodeURIComponent(fakeB64)}"></iframe>`
      };
    }
    if (u.startsWith('https://pandamovies.org/wp-json/wp/v2/cast')) {
      return { ok: true, json: async () => [{ id: 31286, name: 'Jesse Jane', slug: 'jesse-jane', count: 99 }] };
    }
    if (u.startsWith('https://pandamovies.org/wp-json/wp/v2/posts')) {
      return {
        ok: true,
        headers: new Headers({ 'x-wp-totalpages': '4' }),
        json: async () => [{
          id: 901,
          link: 'https://pandamovies.org/watch-sorrow-bay-2022',
          title: { rendered: 'Sorrow Bay (2022)' },
          _embedded: {
            'wp:featuredmedia': [{ source_url: 'https://pandamovies.org/sb.jpg' }],
            'wp:term': [[{ taxonomy: 'cast', name: 'Jesse Jane' }, { taxonomy: 'studios', name: 'Lust Cinema' }]]
          }
        }]
      };
    }
    if (u === 'https://pandamovies.org/watch-sorrow-bay-2022') {
      const payload = JSON.stringify([
        { l: 'LuluStream', u: 'https://luluvdo.com/e/hls1' },
        { l: 'MixDrop', u: 'https://mixdrop.ag/e/direct1' }
      ]).replace(/"/g, '&quot;');
      return { ok: true, text: async () => `<div data-sources="${payload}"></div>` };
    }
    if (u === 'https://luluvdo.com/e/hls1') {
      return { ok: true, text: async () => `https://cdn.lulu.com/master.m3u8` };
    }
    if (u === 'https://mixdrop.ag/e/direct1') {
      return { ok: true, text: async () => `<script>${packedMix}</script>` };
    }
    if (u.startsWith('https://xhamster.com/search/')) {
      const init = {
        searchResult: {
          videoThumbProps: [{
            id: 'xhf5lGY',
            title: 'Deadly Pickup Full Length Cut',
            duration: 2460,
            pageURL: 'https://xhamster.com/videos/deadly-pickup-xhf5lGY',
            thumbURL: 'https://img.xhcdn.com/dp.jpg',
            isHD: true
          }]
        }
      };
      return { ok: true, text: async () => `<script>window.initials = ${JSON.stringify(init)};</script>` };
    }
    if (u.startsWith('https://www.porntrex.com/search/')) {
      return {
        ok: true,
        text: async () => `<div class="video-item"><a href="https://www.porntrex.com/video/12345/casey-true-story" title="Casey: A True Story (2021)"><img data-src="https://pt.example/c.jpg"/></a><div class="duration">48:10</div></div>`
      };
    }
    if (u === 'https://www.porntrex.com/video/12345/casey-true-story') {
      return {
        ok: true,
        text: async () => `flashvars = { video_url: 'https://pt.cdn/480.mp4', video_alt_url: 'https://pt.cdn/720.mp4', video_alt_url2: 'https://pt.cdn/1080.mp4' };`
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const fxcSearch = await searchFullXCinema({ query: 'Deadly Pickup', fetchImpl: mockFetch });
  assert.equal(fxcSearch.results.length, 1);
  const fxcStream = await resolveFullXCinemaStream(fxcSearch.results[0].pageUrl, { fetchImpl: mockFetch });
  assert.equal(fxcStream.streamUrl, 'https://cdn.freevidco.com/Deadly%20Pickup.mp4');
  assert.equal(fxcStream.isHls, false);

  const pmSearch = await searchPandaMovies({ query: 'Sorrow Bay', artist: 'Jesse Jane', fetchImpl: mockFetch });
  assert.equal(pmSearch.results.length, 1);
  const pmStream = await resolvePandaMoviesStream(pmSearch.results[0].pageUrl, { fetchImpl: mockFetch });
  assert.equal(pmStream.streamUrl, 'https://cdn.mixdrop.ag/v/sorrowbay.mp4');
  assert.equal(pmStream.isHls, false);

  const xhSearch = await searchXHamster({ query: 'Deadly Pickup', minMinutes: 20, fetchImpl: mockFetch });
  assert.equal(xhSearch.results.length, 1);
  assert.equal(xhSearch.results[0].durationSeconds, 2460);

  const ptSearch = await searchPornTrex({ query: 'Casey A True Story', fetchImpl: mockFetch });
  assert.equal(ptSearch.results.length, 1);
  const ptStream = await resolvePornTrexStream(ptSearch.results[0].pageUrl, { fetchImpl: mockFetch });
  assert.equal(ptStream.streamUrl, 'https://pt.cdn/720.mp4');

  const catalog = new AdultCatalog({ fetchImpl: mockFetch });
  const resolvedMatch = await catalog.resolveFeatureMatch({ title: 'Sorrow Bay', year: 2022 });
  assert.equal(resolvedMatch.url, 'https://cdn.mixdrop.ag/v/sorrowbay.mp4');
  assert.equal(resolvedMatch.isHls, false);
});

test('MovieApiClient.search recovers adult:true TMDB movies via Wikidata when includeAdultFallback=true and hides them when false', async () => {
  const api = new MovieApiClient({ baseUrl: 'http://127.0.0.1:9' });
  const calls = [];
  api.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('http://127.0.0.1:9/search')) {
      return { ok: true, json: async () => ({ provider: 'holaflix', query: 'stagnetti', count: 0, results: [] }) };
    }
    if (u.startsWith('https://www.wikidata.org/w/api.php?action=wbsearchentities')) {
      return { ok: true, json: async () => ({ search: [{ id: 'Q1572655', label: "Pirates II: Stagnetti's Revenge" }] }) };
    }
    if (u.startsWith('https://www.wikidata.org/w/api.php?action=wbgetentities')) {
      return {
        ok: true,
        json: async () => ({
          entities: {
            Q1572655: {
              labels: { en: { value: "Pirates II: Stagnetti's Revenge" } },
              claims: {
                P4947: [{ mainsnak: { datavalue: { value: '14312' } } }],
                P577: [{ mainsnak: { datavalue: { value: { time: '+2008-09-26T00:00:00Z' } } } }]
              }
            }
          }
        })
      };
    }
    if (u.startsWith('http://127.0.0.1:9/movie/14312')) {
      return {
        ok: true,
        json: async () => ({
          id: '14312',
          type: 'movie',
          title: "Pirates II: Stagnetti's Revenge",
          release_date: '2008-09-26',
          runtime: 140
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // Locked group must NOT call Wikidata adult fallback
  const lockedRes = await api.search('pirate of the Caribbean stegenneti', { includeAdultFallback: false });
  assert.equal(lockedRes.results.length, 0);
  assert.equal(calls.some((u) => u.includes('wikidata.org')), false);

  // DM / NSFW-allowed group recovers TMDB 14312
  const dmRes = await api.search('pirate of the Caribbean stegenneti', { includeAdultFallback: true });
  assert.equal(dmRes.results.length, 1);
  assert.equal(dmRes.results[0].id, '14312');
  assert.equal(dmRes.results[0].isAdultHint, true);
});

test('MovieStreamResolver accepts parody films, avoids description trailer false-positives, supports TV cuts & gates Step 5.5 on allowAdultFeatures', async () => {
  const movieApi = {
    getMovie: async () => null,
    getPlaybackInfo: async () => ({ sources: [] }),
    search: async () => ({ results: [] })
  };
  let featureCalls = 0;
  const adultCatalog = {
    resolveFeatureMatch: async ({ title }) => {
      featureCalls++;
      return {
        url: 'https://cdn.freevidco.com/Deadly%20Pickup.mp4',
        headers: {},
        format: 'mp4',
        isHls: false,
        durationSeconds: 4860,
        qualityLabel: '720p MP4',
        source: 'adult_fullxcinema',
        title
      };
    }
  };

  const ytSearchResults = [
    {
      title: "Pirates II: Stagnetti's Revenge (2008) Full Parody Movie",
      webpage_url: 'https://www.youtube.com/watch?v=pirate1',
      url: 'https://www.youtube.com/watch?v=pirate1',
      duration: 2450,
      directStreamUrl: 'https://rr1.googlevideo.com/videoplayback?pirate=1'
    },
    {
      title: 'Deadly Pickup (2016) Full Movie TV Cut',
      webpage_url: 'https://www.youtube.com/watch?v=dp46',
      url: 'https://www.youtube.com/watch?v=dp46',
      duration: 2760,
      directStreamUrl: 'https://rr1.googlevideo.com/videoplayback?dp=46'
    },
    {
      title: 'Deadly Pickup (2016) Extended Cut',
      webpage_url: 'https://www.youtube.com/watch?v=dp68',
      url: 'https://www.youtube.com/watch?v=dp68',
      duration: 4100,
      directStreamUrl: 'https://rr1.googlevideo.com/videoplayback?dp=68'
    }
  ];

  const resolver = new MovieStreamResolver({
    movieApi,
    adultCatalog,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
    enableWebFallback: false,
    enableYtDlp: true,
    ytSearchFn: async () => ytSearchResults
  });

  // Parody title is NOT rejected by TRAILER_RE
  const parodyRes = await resolver.resolve({
    type: 'movie',
    title: "Pirates II: Stagnetti's Revenge",
    year: 2008,
    fetchSubtitles: false
  });
  assert.equal(parodyRes.ok, true);
  assert.equal(parodyRes.track.streamUrl, 'https://rr1.googlevideo.com/videoplayback?pirate=1');

  // Strict >= 0.78x duration gate rejects 56% half-movie TV cut (46m vs 81m) and selects >= 0.78x full cut (68m)
  const dpRes = await resolver.resolve({
    type: 'movie',
    title: 'Deadly Pickup',
    year: 2016,
    durationSeconds: 4860,
    fetchSubtitles: false
  });
  assert.equal(dpRes.ok, true);
  assert.equal(dpRes.track.streamUrl, 'https://rr1.googlevideo.com/videoplayback?dp=68');

  // Group locked (allowAdultFeatures=false) vs DM (allowAdultFeatures=true) on Sorrow Bay
  const lockedAdult = new MovieStreamResolver({
    movieApi,
    adultCatalog,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
    enableWebFallback: false,
    enableYtDlp: false
  });
  const lockedTry = await lockedAdult.resolve({ type: 'movie', title: 'Sorrow Bay', year: 2022, fetchSubtitles: false }, { allowAdultFeatures: false });
  assert.equal(lockedTry.ok, false);
  assert.equal(featureCalls, 0);

  const allowedTry = await lockedAdult.resolve({ type: 'movie', title: 'Sorrow Bay', year: 2022, fetchSubtitles: false }, { allowAdultFeatures: true });
  assert.equal(allowedTry.ok, true);
  assert.equal(featureCalls, 1);
  assert.equal(allowedTry.track.streamUrl, 'https://cdn.freevidco.com/Deadly%20Pickup.mp4');
});

test('MovieUI /movie results show 18+ Features bridge in DM and strictly hide/lock it in NSFW-locked groups', async (t) => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '100' } });
  const sm = new StateMachine();
  const sent = [];
  const searchIncludeFlags = [];
  const adultCatalog = new AdultCatalog({
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '', json: async () => [] })
  });
  const qm = new QueueManager({
    app: { db, settings, adultCatalog },
    voiceClient: {
      isSetup: () => true,
      async setup() { return { ok: true, connected: true, active: true, user_id: 888 }; },
      async play() { return { ok: true }; },
      async status() { return { status: 'idle' }; },
      async stop() { return { ok: true }; }
    },
    log: { info() {}, warn() {}, error() {}, debug() {} }
  });

  const app = {
    db,
    settings,
    sm,
    musicSessions: { purgeExpired: () => 0, flush: () => {} },
    movieSessions: new MovieSessions({ db }),
    movieApi: {
      search: async (q, opts) => {
        searchIncludeFlags.push(opts?.includeAdultFallback);
        return { query: q, count: 0, results: [] };
      },
      trending: async () => ({ results: [] })
    },
    adultCatalog,
    musicQueueManager: qm,
    voiceClient: qm.voiceClient
  };
  app.music = new MusicService({ app, search: { resolve: async () => [] }, lyrics: null, accounts: { sync: async () => {} } });

  const api = {
    botUsername: 'LancyBot',
    me: { id: 777, username: 'LancyBot' },
    getMe: async () => ({ id: 777, username: 'LancyBot' }),
    getChat: async (cid) => (Number(cid) < 0 ? { id: cid, type: 'supergroup', title: 'GC' } : { id: cid, type: 'private' }),
    getChatMember: async (_cid, uid) => (
      [200, 777, 888].includes(Number(uid))
        ? { status: 'administrator', can_manage_video_chats: true }
        : { status: 'member' }
    ),
    sendChatAction: async () => true,
    sendMessage: async (chatId, text) => ({ message_id: sent.length + 100, chat: { id: chatId }, text }),
    deleteMessage: async () => true,
    sendRichMessage: async (chatId, rich) => {
      const m = { message_id: sent.length + 10, chatId, rich };
      sent.push(m);
      return m;
    },
    editMessageRich: async (chatId, messageId, rich) => {
      sent.push({ message_id: messageId, chatId, rich, edited: true });
      return { message_id: messageId };
    },
    answerCallbackQuery: async () => ({ ok: true })
  };

  const screen = createMusicScreen({ app });
  screen.registerStateHandlers(sm);
  t.after(async () => {
    await screen.cleanup();
    await app.music.previews.shutdown();
    await qm.shutdown();
    db.close();
  });

  // Locked group chat: no 18+ bridge button, includeAdultFallback=false
  await screen.handleCommand({
    tgId: '200',
    chatId: -10099,
    isGroup: true,
    user: { tg_id: 200, first_name: 'Member' },
    api,
    sm,
    message: { chat: { id: -10099, type: 'supergroup' } }
  }, '/movie', ['Sorrow', 'Bay']);

  const gcRich = sent.at(-1).rich;
  assert.equal(searchIncludeFlags.at(-1), false);
  assert.ok(collectButtons(gcRich).some((b) => btnText(b).includes('🔞 XVideos / 18+')));

  // DM chat: 18+ Features & Stars bridge present, includeAdultFallback=true
  await screen.handleCommand({
    tgId: '500',
    chatId: 500,
    isGroup: false,
    user: { tg_id: 500, first_name: 'DM' },
    api,
    sm,
    message: { chat: { id: 500, type: 'private' } }
  }, '/movie', ['Sorrow', 'Bay']);

  const dmRich = sent.at(-1).rich;
  assert.equal(searchIncludeFlags.at(-1), true);
  assert.ok(collectButtons(dmRich).some((b) => btnText(b).includes('🔞 XVideos / 18+')));
});

test('Title scoring & MovieApiClient trailing-year parsing handle indie releases, pipe cast suffixes, and xHamster headers', async () => {
  assert.ok(scoreTitleMatch('Giantess Battle Attack!', 2022, 'Giantess Battle Attack | Full Movie | Ivy Smith | Kira Noir | Lauren Nicole Smith') >= 40);
  assert.ok(scoreTitleMatch('The Three Musketeers', null, 'Barbie and the Three Musketeers | Full Movie') < 24);

  const exactIllicit = scoreAdultTitleMatch('Illicit Desires 2018', 'Illicit Desire (2018) English 480p WEB-DL x264');
  const noisyIllicit = scoreAdultTitleMatch('Illicit Desires 2018', "Stepmother's shooting incident – glamorous girlfriend forgoes social gathering to cater to her boyfriend's illicit desires.");
  assert.ok(exactIllicit >= 80 && exactIllicit > noisyIllicit);
  assert.ok(scoreAdultTitleMatch('Giantess Battle Attack', 'Giantess The Battle For Zantor') < 50);

  const api = new MovieApiClient({ baseUrl: 'http://127.0.0.1:9' });
  const searchUrls = [];
  api.fetch = async (u) => {
    const url = String(u);
    searchUrls.push(url);
    return {
      ok: true,
      json: async () => ({
        provider: 'holaflix',
        results: url.includes('year=2018') ? [] : [{ id: 571346, media_type: 'movie', title: 'American Kamasutra', release_date: '2018-06-01' }]
      })
    };
  };
  const sRes = await api.search('American Kamasutra 2018', { includeAdultFallback: false });
  assert.ok(searchUrls.some((u) => u.includes('q=American+Kamasutra') && u.includes('year=2018')));
  assert.equal(sRes.results[0]?.id, '571346');

  const xh = await resolveXHamsterStream('https://xhamster.com/videos/illicit-desire-123', {
    ytExtractFn: async () => ({
      duration: 4893,
      http_headers: { Referer: 'https://xhamster.com/', 'Sec-Fetch-Mode': 'navigate', 'User-Agent': 'UA' },
      formats: [
        { height: 720, ext: 'mp4', protocol: 'https', vcodec: 'h264', acodec: 'aac', url: 'https://video-h.xhcdn.com/720p.mp4' },
        { height: 720, ext: 'mp4', protocol: 'm3u8_native', vcodec: 'h264', acodec: 'aac', url: 'https://video-nss-h.xhcdn.com/720p.m3u8' }
      ]
    })
  });
  assert.equal(xh?.headers?.['Sec-Fetch-Mode'], undefined);
  assert.equal(xh?.hlsUrl, 'https://video-nss-h.xhcdn.com/720p.m3u8');
});
