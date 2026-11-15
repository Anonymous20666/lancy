import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { VideoStreamingServer } from '../src/media/streamingServer.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { CallSetup } from '../src/music/setup.js';
import { VoiceClient } from '../src/music/voiceClient.js';
import { PANEL_ACTIONS } from '../src/music/channelPanels.js';
import { SubtitleService } from '../src/media/subtitles.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { richTextToString } from '../src/telegram/rich.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-rtmp-prefetch-'));
  const db = new Database(join(dir, 'lancy.sqlite'));
  return { dir, db, cleanup: () => { db.close?.(); rmSync(dir, { recursive: true, force: true }); } };
}

test('VideoStreamingServer prefetches next HLS segments into RAM cache ahead of FFmpeg reads', async () => {
  const { dir, cleanup } = tempDb();
  const hits = new Map();
  const segBodies = new Map([
    ['/seg0.ts', Buffer.from('SEG0_DATA_' + 'A'.repeat(1024))],
    ['/seg1.ts', Buffer.from('SEG1_DATA_' + 'B'.repeat(1024))],
    ['/seg2.ts', Buffer.from('SEG2_DATA_' + 'C'.repeat(1024))],
    ['/seg3.ts', Buffer.from('SEG3_DATA_' + 'D'.repeat(1024))]
  ]);

  const upstream = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    hits.set(path, (hits.get(path) || 0) + 1);
    if (path === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.0,',
        '/seg0.ts',
        '#EXTINF:6.0,',
        '/seg1.ts',
        '#EXTINF:6.0,',
        '/seg2.ts',
        '#EXTINF:6.0,',
        '/seg3.ts',
        '#EXT-X-ENDLIST'
      ].join('\n'));
      return;
    }
    const body = segBodies.get(path);
    if (body) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = upstream.address().port;
  const server = new VideoStreamingServer({ port: 0, cacheDir: dir, audioCacheDir: dir });
  await server.start();

  try {
    const proxyUrl = server.registerRemoteStream({
      url: `http://127.0.0.1:${upPort}/master.m3u8`,
      isHls: true,
      contentType: 'application/vnd.apple.mpegurl'
    });
    assert.ok(proxyUrl);

    const plsRes = await fetch(proxyUrl);
    assert.equal(plsRes.status, 200);
    const plsText = await plsRes.text();
    const segUrls = plsText.split(/\r?\n/).filter((l) => l.startsWith('http://'));
    assert.equal(segUrls.length, 4);

    // Fetch segment 0: should immediately trigger background look-ahead for seg1 and seg2
    const s0 = await fetch(segUrls[0]);
    assert.equal(s0.status, 200);
    assert.deepEqual(Buffer.from(await s0.arrayBuffer()), segBodies.get('/seg0.ts'));

    // Wait briefly for background lookahead fetches to settle
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(hits.get('/seg0.ts'), 1);
    assert.equal(hits.get('/seg1.ts'), 1, 'seg1 should already be prefetched from upstream');
    assert.equal(hits.get('/seg2.ts'), 1, 'seg2 should already be prefetched from upstream');
    assert.equal(hits.get('/seg3.ts') || 0, 0, 'seg3 should not be eagerly fetched beyond lookahead=2');

    // Reading seg1 and seg2 through the proxy should hit RAM cache with ZERO new upstream requests
    const s1 = await fetch(segUrls[1]);
    assert.deepEqual(Buffer.from(await s1.arrayBuffer()), segBodies.get('/seg1.ts'));
    await new Promise((r) => setTimeout(r, 80));
    const s2 = await fetch(segUrls[2]);
    assert.deepEqual(Buffer.from(await s2.arrayBuffer()), segBodies.get('/seg2.ts'));

    assert.equal(hits.get('/seg1.ts'), 1, 'seg1 read served directly from look-ahead RAM cache');
    assert.equal(hits.get('/seg2.ts'), 1, 'seg2 read served directly from look-ahead RAM cache');
  } finally {
    await server.stop();
    await new Promise((resolve) => upstream.close(resolve));
    cleanup();
  }
});

test('Node streamMode persists per chat, forwards stream_mode=rtmp on setup/play, and live-switches active call', async () => {
  const { dir, db, cleanup } = tempDb();
  const sampleFile = join(dir, 'movie.mp4');
  writeFileSync(sampleFile, 'dummy');

  const setupCalls = [];
  const playCalls = [];
  const callMsgs = [];
  let pausedCalled = false;

  const voice = {
    accounts: async () => ({ ok: true, accounts: [{ alias: 'main', enabled: true, status: 'available', allowed: [-1001] }] }),
    sendCallMessage: async (id, text) => {
      callMsgs.push({ id, text });
      return { ok: true, sent: true, message_ids: [callMsgs.length] };
    },
    configure: async () => ({ ok: true }),
    setup: async (id, stage, opts = {}) => {
      setupCalls.push({ id, stage, opts });
      if (stage === 'identity') return { ok: true, account_alias: 'main', user_id: 9001 };
      if (stage === 'start') {
        return {
          ok: true,
          account_alias: 'main',
          call_ready: true,
          created: true,
          call_invite_link: 'https://t.me/+rtmpTest',
          stream_mode: opts.stream_mode || 'interactive'
        };
      }
      return { ok: true };
    },
    play: async (id, url, opts) => {
      playCalls.push({ id, url, opts });
      return { ok: true, account_alias: 'main', status: 'playing', call_invite_link: 'https://t.me/+rtmpTest' };
    },
    pause: async () => { pausedCalled = true; return { ok: true }; },
    setVolume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    getStatus: async () => ({ ok: true, active: true, info: { status: 'playing' } })
  };

  const api = {
    me: { id: 777, username: 'lancybot' },
    getChat: async (id) => ({ id, type: 'supergroup', title: 'Test Cinema' }),
    getChatMember: async (_id, uid) => ({ status: uid === 555 ? 'creator' : 'administrator', can_manage_video_chats: true, can_invite_users: true, can_promote_members: true }),
    sendRichMessage: async () => ({ message_id: 42 }),
    editMessageRich: async () => ({ message_id: 42 }),
    answerCallbackQuery: async () => true
  };

  const app = {
    db,
    sm: new StateMachine(),
    telegram: { api, botUsername: 'lancybot' },
    settings: { get: () => false },
    voiceClient: voice,
    screens: new Map(),
    musicLibrary: {
      acquire: async (t) => ({ track: { ...t, filePath: sampleFile }, filePath: sampleFile, release: () => {} }),
      prepare: async (t) => ({ track: { ...t, filePath: sampleFile }, filePath: sampleFile, release: () => {} })
    }
  };
  const qm = new QueueManager({ app, voiceClient: voice, db, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, accounts: { sync: async () => {} } });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens.set('music', screen);

  try {
    assert.ok(PANEL_ACTIONS.includes('streammode'), 'streammode must be included in compact channel PANEL_ACTIONS');
    assert.equal(typeof VoiceClient.prototype.play, 'function');

    const ctx = {
      chatId: -1001,
      tgId: 555,
      chatType: 'supergroup',
      user: { first_name: 'Owner' },
      api,
      replyTo: null
    };

    await service.prepare(ctx, -1001);

    // 1) Normal music tracks keep default interactive mode until /rtmp on is triggered
    await qm.addMany(-1001, [{
      id: 'song1',
      provider: 'youtube',
      title: 'Test Track',
      mediaType: 'audio',
      durationSeconds: 300,
      filePath: sampleFile,
      capabilities: { seek: true }
    }]);

    assert.equal(playCalls.length, 1);
    assert.equal(playCalls[0].opts.streamMode, 'interactive', 'default music mode is explicit interactive');

    const s = qm.getSession(-1001);
    s.positionSeconds = 185;
    s.lastKnownPositionSeconds = 185;

    // Trigger /rtmp on command live while playing at 185s
    const handled = await screen.handleCommand({ ...ctx, messageId: 10 }, '/rtmp', ['on']);
    assert.equal(handled, true);

    assert.equal(s.streamMode, 'rtmp');
    assert.equal(db.getSetting('music.streamMode.-1001', null), 'rtmp');
    assert.equal(db.getSetting('music.streamMode.music.-1001', null), 'rtmp');

    const switchSetup = setupCalls.find((c) => c.stage === 'start' && c.opts.force_switch === true);
    assert.ok(switchSetup, 'live toggle must recreate GroupCall with force_switch=true');
    assert.equal(switchSetup.opts.stream_mode, 'rtmp');

    assert.equal(playCalls.length, 2, 'live toggle must restart current track cleanly in RTMP mode');
    assert.equal(playCalls[1].opts.streamMode, 'rtmp');
    assert.equal(playCalls[1].opts.startSeconds, 185, 'live toggle must resume from saved playback second');

    // Options card displays RTMP Stream Engine
    const optsRich = screen.renderOptions(s);
    assert.ok(JSON.stringify(optsRich).includes('RTMP Live'), 'Options card must display RTMP stream engine');

    // 2) Movies default to RTMP + FHD_1080p even if music deck on the chat was saved as interactive,
    //    while still allowing sticky per-deck switching back to interactive VC
    const regCalls = [];
    qm.app.videoServer = {
      registerRemoteStream: (opts) => {
        regCalls.push(opts);
        return 'http://127.0.0.1:9999/proxied.m3u8';
      }
    };
    db.setSetting('music.streamMode.-1002', 'interactive');
    await service.prepare({ ...ctx, chatId: -1002 }, -1002);
    await qm.addMovies(-1002, [{
      id: 'mov1',
      provider: 'movie',
      title: 'Mako S01E01',
      mediaType: 'video',
      durationSeconds: 1400,
      filePath: sampleFile,
      capabilities: { seek: true }
    }]);
    const moviePlay = playCalls[playCalls.length - 1];
    assert.equal(moviePlay.id, -1002);
    assert.equal(moviePlay.opts.streamMode, 'rtmp', 'movies must auto-start in RTMP mode without /rtmp');
    assert.equal(moviePlay.opts.videoQuality, 'FHD_1080p', 'movies must request Good HD (FHD_1080p)');

    const movSess = qm.getSession(-1002);
    assert.equal(movSess.streamMode, 'rtmp');
    assert.equal(qm.getDeckStreamMode(-1002, 'movie'), 'rtmp');
    assert.equal(qm.getDeckStreamMode(-1002, 'music'), 'interactive');
    const cinemaRich = screen.renderCinemaPlayer(movSess);
    assert.ok(JSON.stringify(cinemaRich).includes('RTMP Locked A/V'), 'Cinema player card must show RTMP Locked A/V badge');

    // Toggle movie deck to Interactive VC and ensure sticky preference persists across tracks & deck switches
    const toggledMode = await qm.setStreamMode(-1002, 'interactive');
    assert.equal(toggledMode, 'interactive');
    assert.equal(movSess.streamMode, 'interactive');
    assert.equal(db.getSetting('music.streamMode.movie.-1002', null), 'interactive');
    const cinemaInteractiveRich = screen.renderCinemaPlayer(movSess);
    assert.ok(JSON.stringify(cinemaInteractiveRich).includes('Interactive VC'), 'Cinema card must show Interactive VC after toggle');

    // Queue remote movie (tests 1080p remote cap, sticky movie mode, and VC chat !np/!queue/!skip + /vcmsg)
    await qm.addMovies(-1002, [{
      id: 'mov2',
      provider: 'movie',
      title: 'Mako S01E02',
      mediaType: 'video',
      durationSeconds: 1420,
      streamUrl: 'https://cdn.example.com/mov2.m3u8',
      capabilities: { seek: true }
    }]);

    movSess._lastVcMsgAt = 0;
    await qm.handleVcMessage({ type: 'vc_message', chat_id: -1002, sender_id: 501, sender_name: 'Viewer1', from_admin: false, text: '!np' });
    const countAfterNp = callMsgs.length;
    assert.ok(callMsgs[countAfterNp - 1]?.text.includes('Mako S01E01'), '!np must reply with current movie title');

    // Per-sender rate limit must suppress immediate repeat from same sender
    await qm.handleVcMessage({ type: 'vc_message', chat_id: -1002, sender_id: 501, sender_name: 'Viewer1', from_admin: false, text: '!np' });
    assert.equal(callMsgs.length, countAfterNp, 'rapid repeat VC chat command from same sender must be rate-limited');

    movSess._lastVcMsgAt = 0;
    await qm.handleVcMessage({ type: 'vc_message', chat_id: -1002, sender_id: 502, sender_name: 'Viewer2', from_admin: false, text: '!queue' });
    assert.ok(callMsgs[callMsgs.length - 1]?.text.includes('Mako S01E02'), '!queue must list upcoming movie');

    // /vcmsg command & panel action routing
    assert.ok(PANEL_ACTIONS.includes('vcmsg'), 'PANEL_ACTIONS must include vcmsg');
    const vcCmdHandled = await screen.handleCommand({ ...ctx, chatId: -1002, messageId: 11 }, '/vcmsg', ['Hello', 'cinema']);
    assert.equal(vcCmdHandled, true);
    assert.deepEqual(callMsgs[callMsgs.length - 1], { id: -1002, text: 'Hello cinema' });

    // !skip vote accumulation -> threshold skip advances to mov2 keeping sticky movie 'interactive' + 1080p remote cap
    movSess._lastVcMsgAt = 0;
    movSess._vcMsgRateBySender.clear();
    await qm.handleVcMessage({ type: 'vc_message', chat_id: -1002, sender_id: 601, sender_name: 'Voter1', from_admin: false, text: '!skip' });
    assert.equal(movSess.currentTrack?.id, 'movie:mov1', 'single !skip vote should not skip below threshold');
    movSess._lastVcMsgAt = 0;
    await qm.handleVcMessage({ type: 'vc_message', chat_id: -1002, sender_id: 602, sender_name: 'Voter2', from_admin: false, text: '!skip' });
    assert.equal(movSess.currentTrack?.id, 'movie:mov2', 'reaching !skip threshold must advance to mov2');
    assert.equal(playCalls[playCalls.length - 1].opts.streamMode, 'interactive', 'movie deck must keep sticky interactive preference');
    assert.equal(regCalls.length, 1, 'remote movie track must register with videoServer');
    assert.equal(regCalls[regCalls.length - 1]?.maxHeight, 1080, 'remote movie stream must request maxHeight 1080');

    // Switch to music deck (keeps interactive, caps remote music video at 720p), then back to movie (stays interactive)
    await qm.switchDeck(-1002, 'music');
    assert.equal(movSess.streamMode, 'interactive');
    await qm.addMany(-1002, [{
      id: 'mus-remote',
      provider: 'direct',
      title: 'Remote MV',
      mediaType: 'video',
      durationSeconds: 200,
      streamUrl: 'https://cdn.example.com/mv.mp4',
      capabilities: { seek: true }
    }]);
    assert.equal(regCalls.length, 2, 'remote music video track must register with videoServer');
    assert.equal(regCalls[regCalls.length - 1]?.maxHeight, 720, 'interactive remote music video must request maxHeight 720');
    await qm.switchDeck(-1002, 'movie');
    assert.equal(movSess.streamMode, 'interactive', 'switching back to movie deck must retain sticky interactive mode');

    assert.equal(pausedCalled, false);
  } finally {
    await screen.cleanup?.();
    await service.previews?.shutdown?.();
    await qm.shutdown();
    cleanup();
  }
});

test('SubtitleService resolves IMDb via Cinemeta + Stremio opensubtitles-v3 when rest.opensubtitles.org 503s and dedupes cues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-sub-stremio-'));
  const sampleSrt = [
    '1', '00:00:01,000 --> 00:00:03,000', 'Hello world', '',
    '2', '00:00:03,050 --> 00:00:05,000', 'Hello world', '',
    ...Array.from({ length: 12 }, (_, i) => `${i + 3}\n00:00:${String(10 + i * 3).padStart(2, '0')},000 --> 00:00:${String(12 + i * 3).padStart(2, '0')},000\nLine ${i + 3}\n`)
  ].join('\n');

  const fetchMock = async (url) => {
    const u = String(url);
    if (u.startsWith('https://v3-cinemeta.strem.io/catalog/movie/')) {
      return new Response(JSON.stringify({ metas: [{ imdb_id: 'tt1375666', name: 'Inception', releaseInfo: '2010' }] }), { status: 200 });
    }
    if (u === 'https://opensubtitles-v3.strem.io/subtitles/movie/tt1375666.json') {
      return new Response(JSON.stringify({ subtitles: [{ lang: 'eng', url: 'https://subs5.strem.io/test.srt', SubEncoding: 'UTF-8' }] }), { status: 200 });
    }
    if (u === 'https://subs5.strem.io/test.srt') {
      return new Response(sampleSrt, { status: 200 });
    }
    if (u.includes('rest.opensubtitles.org')) {
      return new Response('503 Cloudflare', { status: 503 });
    }
    return new Response('', { status: 404 });
  };

  try {
    const svc = new SubtitleService({ cacheDir: dir, fetchImpl: fetchMock });
    const res = await svc.resolveForMedia({ title: 'Inception', year: 2010, language: 'eng' });
    assert.equal(res.found, true);
    assert.equal(res.source, 'opensubtitles');
    assert.equal(res.cues.length, 13, 'back-to-back duplicate cue must merge into 13 cues');
    assert.equal(res.cues[0].endMs, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VideoStreamingServer prefers original audio over DEFAULT dub in HLS master & preserves MPD subtitle MIME/audio lang', async (t) => {
  const { dir, cleanup } = tempDb();
  const upstream = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/master_anime.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end([
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English Dub",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="aud_en.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,AUTOSELECT=NO,URI="aud_ja.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="aud"',
        'vid_1080.m3u8'
      ].join('\n'));
      return;
    }
    if (path === '/vid_1080.m3u8' || path === '/aud_ja.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\ns0.ts\n#EXTINF:6.0,\ns1.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (path === '/dash_anime.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end(`<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT0H5M0S">
  <Period>
    <AdaptationSet contentType="video"><Representation id="v1080" height="1080" bandwidth="3000000"><BaseURL>vid_1080.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="audio" lang="en" label="English Dub"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="dub"/><Representation id="aen" bandwidth="128000"><BaseURL>aud_en.m4a</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="audio" lang="ja" label="Japanese"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="aja" bandwidth="128000"><BaseURL>aud_ja.m4a</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="text" lang="en" mimeType="text/vtt"><Representation id="ten" bandwidth="1000"><BaseURL>subs/en.vtt</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="text" lang="en" mimeType="application/ttml+xml"><Representation id="t_ttml" bandwidth="1000"><BaseURL>subs/en.ttml</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`);
      return;
    }
    if (path.endsWith('.vtt')) {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSub line\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const uPort = upstream.address().port;

  const srv = new VideoStreamingServer({ port: 0, host: '127.0.0.1', cacheDir: dir, audioCacheDir: dir });
  await srv.start();
  t.after(async () => { await srv.stop(); });
  t.after(cleanup);

  const hlsProxy = srv.registerRemoteStream({
    url: `http://127.0.0.1:${uPort}/master_anime.m3u8`,
    isHls: true,
    maxHeight: 1080,
    preferredAudioLang: 'ja'
  });
  const hlsBody = await (await fetch(hlsProxy)).text();
  assert.ok(!hlsBody.includes('English Dub'), 'Rewritten HLS master must drop English Dub when Japanese original is present');
  assert.ok(hlsBody.includes('NAME="Japanese"') && hlsBody.includes('DEFAULT=YES'), 'Japanese original track must be kept and promoted to DEFAULT=YES');

  const dashProxy = srv.registerRemoteStream({
    url: `http://127.0.0.1:${uPort}/dash_anime.mpd`,
    isDash: true,
    maxHeight: 1080,
    preferredAudioLang: 'ja'
  });
  const mpdBody = await (await fetch(dashProxy)).text();
  assert.ok(!mpdBody.includes('lang="en" label="English Dub"'), 'Rewritten MPD must drop dub audio AdaptationSet');
  assert.ok(mpdBody.includes('lang="ja"'), 'Rewritten MPD must keep Japanese original audio AdaptationSet');
  const vttProxyUrl = mpdBody.match(/(http:\/\/127\.0\.0\.1:\d+\/movie-proxy\/[a-f0-9]+\.vtt)/)?.[1];
  const ttmlProxyUrl = mpdBody.match(/(http:\/\/127\.0\.0\.1:\d+\/movie-proxy\/[a-f0-9]+\.ttml)/)?.[1];
  assert.ok(!/<AdaptationSet\b[^>]*contentType="text"[\s\S]*?\.mp4<\/BaseURL>/i.test(mpdBody), 'MPD text AdaptationSet must never force .mp4 extension');
  assert.ok(vttProxyUrl, 'MPD WebVTT BaseURL must preserve .vtt extension instead of forcing .mp4');
  assert.ok(ttmlProxyUrl, 'MPD TTML BaseURL must preserve .ttml extension');
  const vttFetch = await fetch(vttProxyUrl);
  assert.match(String(vttFetch.headers.get('content-type') || ''), /text\/vtt/i);
});

test('VoiceClient.stopDaemon aborts in-flight ensureDaemon cleanly without spawning an orphan daemon', async () => {
  const client = new VoiceClient({ app: { musicLibrary: { root: tmpdir() } }, port: 39991 });
  client.checkHealth = async () => {
    await new Promise((r) => setTimeout(r, 40));
    const err = new Error('down');
    err.code = 'BRIDGE_UNAVAILABLE';
    throw err;
  };
  const startPromise = client.ensureDaemon();
  await client.stopDaemon();
  await assert.rejects(startPromise, (err) => err?.code === 'SHUTTING_DOWN');
  assert.equal(client.process, null);
});
