import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoStreamingServer } from '../src/media/streamingServer.js';
import { SubtitleService, parseTtml } from '../src/media/subtitles.js';

test('StreamingServer emits X-Lancy-Audio-Trim-Delta and backs off audio seek past video segment start', async (t) => {
  const upstream = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a720",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="a720"',
        'video.m3u8',
        ''
      ].join('\n'));
      return;
    }
    if (pathname === '/video.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:6.0,',
        'v0.ts',
        '#EXTINF:6.0,',
        'v1.ts',
        '#EXTINF:6.0,',
        'v2.ts',
        '#EXTINF:6.0,',
        'v3.ts',
        '#EXT-X-ENDLIST',
        ''
      ].join('\n'));
      return;
    }
    if (pathname === '/audio.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:10.0,',
        'a0.ts',
        '#EXTINF:5.0,',
        'a1.ts',
        '#EXTINF:5.0,',
        'a2.ts',
        '#EXT-X-ENDLIST',
        ''
      ].join('\n'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(Buffer.alloc(188));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const cacheDir = mkdtempSync(join(tmpdir(), 'lancy-ss-cache-'));
  const audioCacheDir = mkdtempSync(join(tmpdir(), 'lancy-ss-aud-'));
  const srv = new VideoStreamingServer({ port: 0, cacheDir, audioCacheDir });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    await new Promise((r) => upstream.close(r));
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(audioCacheDir, { recursive: true, force: true });
  });

  const proxyUrl = srv.registerRemoteStream({ url: `http://127.0.0.1:${upPort}/master.m3u8`, isHls: true });
  // Seek to 15s: video skips v0+v1 (12.000s), audio splits at 10.000s + 5.000s -> aligned audio skips 10.000s -> trim delta 2.000s
  const masterRes = await fetch(`${proxyUrl}?start=15`);
  assert.equal(masterRes.status, 200);
  assert.equal(masterRes.headers.get('x-lancy-skipped-sec'), '12.000');
  assert.equal(masterRes.headers.get('x-lancy-audio-skipped-sec'), '10.000');
  assert.equal(masterRes.headers.get('x-lancy-audio-trim-delta'), '2.000');

  const masterBody = await masterRes.text();
  const audUri = masterBody.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]+URI="([^"]+)"/)?.[1] || '';
  assert.ok(audUri, 'Master playlist should rewrite separate audio URI with aligned start');
  const audStart = Number(new URL(audUri).searchParams.get('start') || 0);
  assert.ok(audStart > 0 && audStart <= 12.0, `Expected audio start <= 12s, got ${audStart}`);

  const audRes = await fetch(audUri);
  assert.equal(audRes.status, 200);
  assert.equal(audRes.headers.get('x-lancy-skipped-sec'), '10.000');
});

test('parseTtml supports frameRate, frameRateMultiplier, and f frame units accurately', () => {
  const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xml:lang="en" ttp:frameRate="24" ttp:frameRateMultiplier="1000 1001" xmlns:ttp="http://www.w3.org/ns/ttml#parameter">
  <body><div>
    <p begin="240f" dur="48f">Frame units cue</p>
    <p begin="00:01:00:12" end="00:01:02:00">Colon frame cue</p>
  </div></body>
</tt>`;
  const cues = parseTtml(ttml);
  assert.equal(cues.length, 2);
  // 240 / (24 * 1000 / 1001) = 10.01s -> 10010 ms
  assert.equal(cues[0].startMs, 10010);
  assert.equal(cues[0].endMs, 12012);
  assert.equal(cues[0].text, 'Frame units cue');
  // 60s + 12 / (24 * 1000 / 1001) = 60500.49999999999 -> 60500 ms
  assert.equal(cues[1].startMs, 60500);
  assert.equal(cues[1].endMs, 62000);
});

test('SubtitleService shifts segment-local HLS WebVTT without X-TIMESTAMP-MAP, scopes baseTrackKey hints, and scores Stremio candidates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-sub-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const vttSeg0 = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nLine 1\n\n00:00:04.000 --> 00:00:06.000\nLine 2\n\n00:00:07.000 --> 00:00:09.000\nLine 3\n\n00:00:09.200 --> 00:00:09.900\nLine 4\n';
  const vttSeg1 = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSeg2 Line 1\n\n00:00:04.000 --> 00:00:06.000\nSeg2 Line 2\n\n00:00:06.500 --> 00:00:08.500\nSeg2 Line 3\n\n00:00:09.000 --> 00:00:09.800\nSeg2 Line 4\n\n00:00:10.000 --> 00:00:11.000\nSeg2 Line 5\n\n00:00:11.200 --> 00:00:11.900\nSeg2 Line 6\n';
  const subM3u8 = '#EXTM3U\n#EXTINF:10.0,\nseg0.vtt\n#EXTINF:10.0,\nseg1.vtt\n#EXT-X-ENDLIST\n';

  const makeGoodSrt = (tag) => Array.from({ length: 12 }, (_, i) => {
    const s = 10 + i * 100;
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    const es = s + 3;
    const eh = String(Math.floor(es / 3600)).padStart(2, '0');
    const em = String(Math.floor((es % 3600) / 60)).padStart(2, '0');
    const esec = String(es % 60).padStart(2, '0');
    return `${i + 1}\n${h}:${m}:${sec},000 --> ${eh}:${em}:${esec},000\n${tag} cue ${i + 1}\n`;
  }).join('\n');

  const shortSrt = '1\n00:00:01,000 --> 00:00:03,000\nToo short cue 1\n';

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === 'https://cdn.example/subs/master.m3u8') {
      return { ok: true, text: async () => subM3u8 };
    }
    if (u === 'https://cdn.example/subs/seg0.vtt') {
      return { ok: true, text: async () => vttSeg0 };
    }
    if (u === 'https://cdn.example/subs/seg1.vtt') {
      return { ok: true, text: async () => vttSeg1 };
    }
    if (u.startsWith('https://opensubtitles-v3.strem.io/subtitles/series/tt0903747:1:1.json')) {
      return {
        ok: true,
        json: async () => ({
          subtitles: [
            { id: '1', lang: 'eng', MovieReleaseName: 'Show.S01E02.1080p.WEB-DL.srt', url: 'https://subs.strem/wrong_ep.srt', SubDownloadsCnt: 9000 },
            { id: '2', lang: 'eng', MovieReleaseName: 'Show.S01E01.HDCAM.srt', url: 'https://subs.strem/cam.srt', SubDownloadsCnt: 8000 },
            { id: '3', lang: 'eng', MovieReleaseName: 'Show.S01E01.1080p.WEB-DL.srt', url: 'https://subs.strem/webdl.srt', SubEncoding: 'UTF-8', SubDownloadsCnt: 500 },
            { id: '4', lang: 'eng', MovieReleaseName: 'Show.S01E01.short.srt', url: 'https://subs.strem/short.srt', SubDownloadsCnt: 9999 }
          ]
        })
      };
    }
    if (u === 'https://subs.strem/webdl.srt') {
      return { ok: true, arrayBuffer: async () => Buffer.from(makeGoodSrt('WEBDL_MATCH'), 'utf8') };
    }
    if (u === 'https://subs.strem/short.srt') {
      return { ok: true, arrayBuffer: async () => Buffer.from(shortSrt, 'utf8') };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const subs = new SubtitleService({ cacheDir: dir, fetchImpl });

  // 1. HLS WebVTT without X-TIMESTAMP-MAP shifts seg1 cues by +10000ms and registers track cleanly via baseTrackKey
  const hlsRes = await subs.resolveForMedia({
    title: 'Local VTT Film',
    streamUrl: 'https://cdn.example/stream/v1.m3u8',
    durationSeconds: 30,
    subtitleHints: [
      { url: 'https://cdn.example/subs/master.m3u8', language: 'eng', label: 'English HLS', tier: 'same_route' }
    ]
  });
  assert.equal(hlsRes.found, true);
  assert.ok(hlsRes.tracks.length >= 1);
  const seg2Cue = hlsRes.cues.find((c) => c.text === 'Seg2 Line 1');
  assert.ok(seg2Cue, 'Must parse segment 2 cues');
  assert.equal(seg2Cue.startMs, 11000);
  assert.equal(seg2Cue.endMs, 13000);

  // 2. Stremio scoring: rejects S01E02 mismatch, ranks WEB-DL above HDCAM matching releaseHint, verifies duration fit
  const stremioRes = await subs.resolveForMedia({
    type: 'tv',
    title: 'Breaking Bad',
    imdbId: 'tt0903747',
    season: 1,
    episode: 1,
    streamUrl: 'https://cdn.example/stream/ep1_other.mp4',
    releaseHint: 'Breaking.Bad.S01E01.1080p.WEB-DL.x264',
    durationSeconds: 2800
  });
  assert.equal(stremioRes.found, true);
  assert.equal(stremioRes.source, 'opensubtitles');
  assert.match(stremioRes.cues[0].text, /WEBDL_MATCH/);
});
