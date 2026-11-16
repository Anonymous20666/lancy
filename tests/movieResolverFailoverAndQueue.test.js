import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MovieStreamResolver, scoreTitleMatch } from '../src/media/movieResolver.js';
import { MovieDownloader } from '../src/media/movieDownloader.js';
import { SubtitleService } from '../src/media/subtitles.js';

test('MovieStreamResolver integrates VidBolt + src.master subtitles and blocks split-part / clip / single-word slug mismatches', async (t) => {
  const mkd = mkdtempSync(join(tmpdir(), 'lancy-vidbolt-'));
  t.after(() => rmSync(mkd, { recursive: true, force: true }));

  const vttBody = [
    'WEBVTT',
    '',
    '00:00:10.000 --> 00:00:13.000',
    'VidBolt cue 1',
    '',
    '00:15:00.000 --> 00:15:03.000',
    'VidBolt cue 2',
    '',
    '00:30:00.000 --> 00:30:03.000',
    'VidBolt cue 3',
    '',
    '00:45:00.000 --> 00:45:03.000',
    'VidBolt cue 4',
    '',
    '01:05:00.000 --> 01:05:03.000',
    'VidBolt cue 5',
    '',
    '01:28:00.000 --> 01:28:03.000',
    'VidBolt cue 6',
    ''
  ].join('\n');
  const featureHls = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:1800',
    '#EXTINF:1800.0,',
    'part0.ts',
    '#EXTINF:1800.0,',
    'part1.ts',
    '#EXTINF:1800.0,',
    'part2.ts',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');

  const upstream = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    if (u === '/vb/main.m3u8' || u === '/vb/alt.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(featureHls);
      return;
    }
    if (u === '/vb/sub_en.vtt') {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end(vttBody);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(Buffer.alloc(188));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  t.after(async () => new Promise((r) => upstream.close(r)));

  // Split-part / clip scoring rejections when target lacks Part
  assert.ok(scoreTitleMatch('King Men', 2024, 'King Men Part 1 of 3', {}) < 0);
  assert.ok(scoreTitleMatch('King Men', 2024, 'King Men Official Movie Clip', {}) < 0);
  // Multi-word title with only 1-word overlap must fail strict match; 2+ overlapping words pass
  assert.ok(scoreTitleMatch('The Midnight Rider', 2022, 'The Dark Knight', {}) < 25);

  const subtitles = new SubtitleService({
    cacheDir: mkd,
    fetchImpl: async (url) => {
      if (String(url).startsWith(`http://127.0.0.1:${upPort}`)) return fetch(url);
      return { ok: false, status: 404, text: async () => '' };
    }
  });

  const resolver = new MovieStreamResolver({
    movieApi: {
      getPlaybackInfo: async () => ({ rootStream: null, subtitles: [] }),
      getMovieDetails: async () => ({ id: '81234', title: 'Glass Harbor', year: 2023, runtimeSeconds: 5400, imdbId: 'tt8123400' })
    },
    subtitles,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${upPort}`)) return fetch(u);
      if (u === 'https://vidbolt.xyz/api/resolve?id=81234&type=movie') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            stream: {
              sources: [
                {
                  url: `http://127.0.0.1:${upPort}/vb/main.m3u8`,
                  type: 'hls',
                  quality: '1080p',
                  master: [
                    '#EXTM3U',
                    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="http://127.0.0.1:${upPort}/vb/sub_en.vtt"`,
                    `#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080,SUBTITLES="subs"`,
                    `http://127.0.0.1:${upPort}/vb/main.m3u8`
                  ].join('\n')
                },
                {
                  url: `http://127.0.0.1:${upPort}/vb/alt.m3u8`,
                  type: 'hls',
                  quality: '720p'
                }
              ]
            }
          })
        };
      }
      if (u.includes('vidbolt.xyz')) return { ok: false, status: 404 };
      // Single-word bad slug ("harbor-only") from secondary route with missing/empty meta must be rejected
      if (u.includes('cinezo') || u.includes('proxy')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: {},
            source: { url: 'https://cdn.wrong/harbor-film/clip.m3u8', type: 'hls' }
          })
        };
      }
      return { ok: false, status: 404 };
    }
  });

  const res = await resolver.resolve({
    type: 'movie',
    id: '81234',
    tmdbId: '81234',
    imdbId: 'tt8123400',
    title: 'Glass Harbor',
    year: 2023,
    durationSeconds: 5400,
    fetchSubtitles: true
  });
  assert.equal(res.ok, true);
  assert.equal(res.track.streamUrl, `http://127.0.0.1:${upPort}/vb/main.m3u8`);
  assert.equal(res.subtitles?.found, true, 'Must extract #EXT-X-MEDIA:TYPE=SUBTITLES from VidBolt src.master');
});

test('MovieDownloader fails over across fallbackStreams and excludeUrls re-resolution', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'lancy-mdl-failover-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const validMp4Bytes = Buffer.alloc(4096, 0x41);
  const resolverCalls = [];

  const api = {
    me: { id: 999, username: 'LancyBot' },
    sendVideo: async (_cid, file, extra = {}) => ({ message_id: 901, file, extra }),
    deleteMessage: async () => true
  };
  const resolver = {
    resolve: async (item, opts = {}) => {
      resolverCalls.push({ id: item?.id, ...opts });
      if (item?.id === 'f1') {
        return {
          ok: true,
          track: {
            streamUrl: 'https://dead1.example/a.mp4',
            format: 'mp4',
            durationSeconds: 1800,
            fallbackStreams: [{ url: 'https://fallback2.example/b.mp4', format: 'mp4' }]
          }
        };
      }
      if (Array.isArray(opts?.excludeUrls) && opts.excludeUrls.length > 0) {
        return {
          ok: true,
          track: {
            streamUrl: 'https://mirror3.example/fresh.mp4',
            format: 'mp4',
            durationSeconds: 1800
          }
        };
      }
      return {
        ok: true,
        track: {
          streamUrl: 'https://dead1.example/x.mp4',
          format: 'mp4',
          durationSeconds: 1800,
          fallbackStreams: [{ url: 'https://dead2.example/y.mp4', format: 'mp4' }]
        }
      };
    }
  };

  const fetchMock = async (url) => {
    const u = String(url);
    if (u.includes('dead1.example') || u.includes('dead2.example')) {
      return { ok: false, status: 500, headers: new Map() };
    }
    if (u.includes('mirror3.example') || u.includes('fallback2.example')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(validMp4Bytes.length) : null) },
        body: new ReadableStream({
          start(c) {
            c.enqueue(validMp4Bytes);
            c.close();
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const dl = new MovieDownloader({
    app: { telegram: { api }, movieResolver: resolver },
    fetchImpl: fetchMock,
    cacheDir: workDir,
    runner: async (cmd, args = []) => {
      if (cmd === 'ffmpeg' && args.length) {
        const outTarget = args[args.length - 1];
        if (typeof outTarget === 'string' && outTarget.endsWith('.mp4')) {
          writeFileSync(outTarget, validMp4Bytes);
        }
      }
      return { stdout: '720\n', stderr: '' };
    }
  });

  // 1. Fails over to fallbackStreams[0] when primary dies
  const resFallback = await dl.prepareVideoFile(
    {
      id: 'f1',
      title: 'Mirror Test',
      durationSeconds: 1800,
      streamUrl: 'https://dead1.example/a.mp4',
      format: 'mp4',
      fallbackStreams: [{ url: 'https://fallback2.example/b.mp4', format: 'mp4' }]
    },
    { quality: '720p', onProgress: () => {} }
  );
  assert.equal(resFallback.ok, true, resFallback.reason);

  // 2. When all initial candidates fail, re-resolves with excludeUrls containing failed mirrors
  const resReResolve = await dl.prepareVideoFile(
    {
      id: 'f2',
      title: 'Mirror Exhausted',
      durationSeconds: 1800,
      streamUrl: 'https://dead1.example/x.mp4',
      format: 'mp4',
      fallbackStreams: [{ url: 'https://dead2.example/y.mp4', format: 'mp4' }]
    },
    { quality: '720p', onProgress: () => {} }
  );
  assert.equal(resReResolve.ok, true, resReResolve.reason);
  const reResolveCall = resolverCalls.find((c) => Array.isArray(c.excludeUrls) && c.excludeUrls.length > 0);
  assert.ok(reResolveCall, 'Expected movieResolver.resolve re-resolve call with excludeUrls');
  assert.deepEqual(reResolveCall.excludeUrls, ['https://dead1.example/x.mp4', 'https://dead2.example/y.mp4']);
});

test('QueueManager fails over across fallbackStreams -> excludeUrls, drives 200ms RTMP-delayed live sub timer, and persists non-zero drift', async (t) => {
  const db = new Database(':memory:');
  db.migrate();
  t.after(() => db.close());

  const subDir = mkdtempSync(join(tmpdir(), 'lancy-qm-sync-'));
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const srtPath = join(subDir, 'subs.srt');
  writeFileSync(
    srtPath,
    '1\n00:00:08,500 --> 00:00:12,000\nDelayed RTMP cue line\n\n2\n00:00:25,000 --> 00:00:28,000\nSecond cue\n',
    'utf8'
  );

  const subtitles = new SubtitleService({ cacheDir: subDir, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const resolverCalls = [];
  const playUrls = [];
  const subCalls = [];
  const vcMessages = [];
  let failOnceUrl = 'https://bad-primary.example/v1.m3u8';
  let failSecondUrl = 'https://bad-fallback.example/v2.m3u8';

  const voiceClient = {
    play: async (_id, source) => {
      playUrls.push(source);
      if (source === failOnceUrl || source === failSecondUrl) {
        const err = new Error('Stream unusable');
        err.code = 'MEDIA_INVALID';
        throw err;
      }
      return { ok: true, account_alias: 'acc1', rtmp_pipeline_delay_sec: 1.5 };
    },
    stop: async () => ({ ok: true }),
    setSubtitle: async (id, path, opts = {}) => {
      subCalls.push({ id, path, ...opts });
      return { ok: true };
    },
    sendCallMessage: async (id, text) => {
      vcMessages.push({ id, text });
      return { ok: true };
    },
    getStatus: async () => ({ ok: true, active: false })
  };

  const app = {
    db,
    subtitles,
    movieResolver: {
      resolve: async (_tr, opts = {}) => {
        resolverCalls.push(opts);
        return {
          ok: true,
          track: {
            streamUrl: 'https://fresh-re-resolve.example/v3.m3u8',
            format: 'hls',
            isHls: true,
            durationSeconds: 3600
          }
        };
      }
    }
  };

  const qm = new QueueManager({ app, db, voiceClient, pollMs: 0 });
  t.after(async () => qm.shutdown());

  const chatId = -10099;
  const s = qm.getSession(chatId);
  s.prepared = true;
  s.streamMode = 'rtmp';

  await qm.playImmediateAndContinue(chatId, {
    id: 'mv-failover-1',
    provider: 'movie',
    mediaType: 'video',
    title: 'Failover Feature (2024)',
    streamUrl: failOnceUrl,
    isHls: true,
    durationSeconds: 3600,
    subtitlePath: srtPath,
    subtitleSameRoute: true,
    fallbackStreams: [{ url: failSecondUrl, isHls: true }]
  });

  // 1. Primary -> fallbackStreams[0] (also fails) -> resolver.resolve with both in excludeUrls -> fresh url succeeds
  assert.deepEqual(playUrls, [
    'https://bad-primary.example/v1.m3u8',
    'https://bad-fallback.example/v2.m3u8',
    'https://fresh-re-resolve.example/v3.m3u8'
  ]);
  assert.equal(resolverCalls.length, 1);
  assert.deepEqual(resolverCalls[0].excludeUrls, [
    'https://bad-primary.example/v1.m3u8',
    'https://bad-fallback.example/v2.m3u8'
  ]);
  assert.equal(s.rtmpPipelineDelaySec, 1.5);

  // 2. Non-zero driftRate / driftAnchor persist via setSubtitleMode + pollSync check, and subtitleRenderScreen flags accurately
  s.subtitleDriftRate = 0.0012;
  s.subtitleDriftAnchor = 120.5;
  await qm.setSubtitleMode(chatId, 'vc');
  assert.equal(subCalls.at(-1)?.subtitleRenderScreen, false);
  await qm.setSubtitleOffset(chatId, 0.4, { absolute: true });
  const subKey = `music.suboffset.v2.${createHash('sha1').update(`${s.currentTrack.id}:subs.srt`).digest('hex').slice(0, 16)}`;
  const savedEntry = db.getSetting(subKey, null);
  assert.ok(savedEntry);
  assert.ok(Math.abs((savedEntry.offset || 0) - 0.4) < 0.01);
  assert.equal(savedEntry.driftRate, 0.0012);
  assert.equal(savedEntry.driftAnchor, 120.5);

  // 3. 200ms timer ticks cleanly and accounts for rtmpPipelineDelaySec (1.5s) -> pos=10.5 -> eff=9.0s -> hits cue 1
  s.positionSeconds = 10.5;
  s.positionUpdatedAt = Date.now();
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(s.liveSubCue, 'Delayed RTMP cue line');
  assert.ok(vcMessages.some((m) => m.text.includes('Delayed RTMP cue line')));

  await qm.setSubtitleMode(chatId, 'screen');
  assert.equal(subCalls.at(-1)?.subtitleRenderScreen, true);
});

test('MovieStreamResolver handles CamelCase TV titles, broadcast 30m->21m episode runtimes, two-part episode titles, and neutral Source labels', async (t) => {
  const mkd = mkdtempSync(join(tmpdir(), 'lancy-dino-res-'));
  t.after(() => rmSync(mkd, { recursive: true, force: true }));

  const scoreDino = scoreTitleMatch(
    'Power Rangers DinoThunder',
    2004,
    'Power Rangers - S12E01 - Day of the Dino (1)',
    { isTv: true, season: 1, episode: 1, episodeTitle: 'Day of the Dino, Part 1', alternateTitle: 'Power Rangers', alternateSeason: 12 }
  );
  assert.ok(scoreDino > 0, `Expected positive score for Dino Thunder S12E01, got ${scoreDino}`);
  assert.ok(
    scoreTitleMatch('Power Rangers DinoThunder', 2004, 'Power Rangers DinoThunder - Day of the Dino Part 1', { isTv: true, season: 1, episode: 1, episodeTitle: 'Day of the Dino, Part 1' }) > 0,
    'Legitimate Part 1 episode title should not be rejected as split chunk'
  );
  assert.ok(
    scoreTitleMatch('King Men', 2024, 'King Men Part 1 of 3', {}) < 0,
    'Explicit multi-part upload chunk Part 1 of 3 must still be rejected'
  );

  // Serve Archive.org MP4 + alternate mirror over local HTTP server so HEAD/GET probe succeeds offline
  const fakeMp4Head = Buffer.alloc(1024, 0);
  const srv = http.createServer((req, res) => {
    if (req.url === '/dino-ep1.mp4' || req.url === '/dino-ep1-alt.mp4') {
      const total = 48 * 1024 * 1024;
      if (req.headers.range) {
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes 0-${fakeMp4Head.length - 1}/${total}`,
          'content-length': String(fakeMp4Head.length),
          'accept-ranges': 'bytes'
        });
        return res.end(fakeMp4Head);
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(total),
        'accept-ranges': 'bytes'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(fakeMp4Head);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const mp4Primary = `http://127.0.0.1:${port}/dino-ep1.mp4`;
  const mp4Mirror = `http://127.0.0.1:${port}/dino-ep1-alt.mp4`;

  const resolver = new MovieStreamResolver({
    movieApi: {
      async resolveNumericTmdbInfo() {
        return {
          tmdbId: '2328',
          franchiseTmdbId: '2328',
          franchiseTitle: 'Power Rangers',
          franchiseSeasonNumber: 12,
          franchiseSeasonName: 'Power Rangers Dino Thunder'
        };
      },
      async getPlaybackInfo() {
        return null;
      },
      async search() {
        return { results: [] };
      }
    },
    thenkiri: { enabled: false },
    socialAdapters: { enabled: false },
    enableYtDlp: false,
    ffprobeRunner: async () => ({
      format: { duration: '1287' },
      streams: [{ codec_type: 'audio', tags: { language: 'en' } }]
    }),
    fetchImpl: async (rawUrl, opts = {}) => {
      const url = String(rawUrl);
      const okJson = (body) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() { return body; },
        async text() { return JSON.stringify(body); }
      });
      if (url.includes('archive.org/advancedsearch.php')) {
        return okJson({
          response: {
            docs: [
              { identifier: 'power-rangers-dino-thunder_202209', title: 'Power Rangers Dino Thunder Complete Series' }
            ]
          }
        });
      }
      if (url.includes('archive.org/metadata/power-rangers-dino-thunder_202209')) {
        return okJson({
          files: [
            { name: 'Power Rangers - S12E01 - Day of the Dino (1).mp4', format: 'MPEG4', size: String(48 * 1024 * 1024), length: '1287.08' },
            { name: 'Power Rangers Dino Thunder - S01E01 - Day of the Dino Part 1.mp4', format: 'MPEG4', size: String(42 * 1024 * 1024), length: '1285' }
          ]
        });
      }
      if (url.includes('archive.org/download/power-rangers-dino-thunder_202209/Power%20Rangers%20-%20S12E01')) {
        return fetch(mp4Primary, opts);
      }
      if (url.includes('archive.org/download/power-rangers-dino-thunder_202209/Power%20Rangers%20Dino%20Thunder')) {
        return fetch(mp4Mirror, opts);
      }
      return {
        ok: false,
        status: 404,
        url,
        headers: new Headers({ 'content-type': 'text/plain' }),
        async json() { return {}; },
        async text() { return ''; }
      };
    }
  });

  const logs = [];
  const res = await resolver.resolve({
    type: 'tv',
    id: 'tt0373587',
    imdbId: 'tt0373587',
    title: 'Power Rangers DinoThunder',
    year: 2004,
    season: 1,
    episode: 1,
    episodeTitle: 'Day of the Dino, Part 1',
    durationSeconds: 1800
  }, {
    fetchSubtitles: false,
    onProgress: (line) => logs.push(line)
  });

  assert.equal(res.ok, true, `Expected resolve ok=true, got reason=${res.reason}`);
  assert.equal(res.track.durationSeconds, 1287);
  assert.ok(Array.isArray(res.track.fallbackStreams) && res.track.fallbackStreams.length >= 1, 'Expected mirror kept in fallbackStreams');
  assert.equal(res.track.fallbackStreams[0].label, 'Source 2');
  for (const l of logs) {
    assert.doesNotMatch(l, /cinemeta|tvmaze|holaflix|flikhub|vidbolt|thenkiri|archive\.org/i, `Progress log leaked raw source name: ${l}`);
  }
});
