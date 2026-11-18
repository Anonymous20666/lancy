import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { isNonMusicOrNews } from '../src/media/youtubeSearch.js';
import { PlayMusicProvider, YouTubeProvider } from '../src/music/providers.js';
import { parseMultiArtistPrompt, getMultiArtistCatalogAndRelated } from '../src/music/charts.js';
import { AiDjEngine } from '../src/music/aiDj.js';
import { buildLrcSubtitleText } from '../src/music/lyrics.js';
import { SubtitleService } from '../src/media/subtitles.js';
import { StudioCanvas } from '../src/music/studioCanvas.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { normalizeTrack } from '../src/music/model.js';

function memoryDb() {
  const settings = new Map();
  return {
    getSetting: (k, d = null) => (settings.has(k) ? settings.get(k) : d),
    setSetting: (k, v) => settings.set(k, v)
  };
}

test('isNonMusicOrNews & YouTube/PlayMusic providers reject hip-hop news, court updates, reactions, interviews, and type beats', async () => {
  assert.equal(isNonMusicOrNews('YNW Melly Murder Trial Verdict Court Update', 'Law&Crime Network', 'YNW Melly'), true);
  assert.equal(isNonMusicOrNews('King Von Full Documentary 1 Hour', 'Trap Lore Ross', 'King Von'), true);
  assert.equal(isNonMusicOrNews('DJ Akademiks reacts to Juice WRLD leaked call', 'Akademiks TV', 'Juice WRLD'), true);
  assert.equal(isNonMusicOrNews('XXXTENTACION Sad Remix Type Beat', 'BeatMaker', 'XXXTENTACION remix'), true);
  assert.equal(isNonMusicOrNews('Juice WRLD - Lucid Dreams (Remix)', 'Juice WRLD', 'Juice WRLD remix'), false);
  assert.equal(isNonMusicOrNews('King Von - Took Her To The O (Official Remix)', 'King Von', 'King Von remix'), false);

  const yt = new YouTubeProvider({
    enabled: true,
    runner: async () => ({
      stdout: JSON.stringify({
        entries: [
          { id: 'aaaaaaaaaaa', title: 'YNW Melly Trial Update Today', uploader: 'Say Cheese', duration: 240, view_count: 900000 },
          { id: 'bbbbbbbbbbb', title: 'YNW Melly - Murder On My Mind (Remix)', artist: 'YNW Melly', duration: 210, view_count: 1500000 }
        ]
      })
    })
  });
  const ytRes = await yt.search('YNW Melly remix', { limit: 5 });
  assert.equal(ytRes.items.length, 1);
  assert.equal(ytRes.items[0].providerId, 'bbbbbbbbbbb');

  // Ensure PlayMusicProvider filters out podcast/interview titles even when returned by upstream
  const pm = new PlayMusicProvider();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('api.deezer.com')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: '101', title: 'King Von Interview Podcast Episode', artist: { name: 'VladTV' }, duration: 220, rank: 900 },
            { id: '102', title: 'Crazy Story (Remix)', artist: { name: 'King Von' }, duration: 195, rank: 990000 }
          ]
        })
      };
    }
    return { ok: true, json: async () => ({ results: [] }) };
  };
  try {
    const pmRes = await pm.search('King Von remix', { limit: 5 });
    assert.equal(pmRes.items.length, 1);
    assert.equal(pmRes.items[0].title, 'Crazy Story (Remix)');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('parseMultiArtistPrompt & AiDjEngine rotate multi-artist remixes 1-by-1 and pivot to related artists cleanly', async () => {
  const prompt = 'Remix juice wrld songs and xxxtentaction plus ynw MELLY and King von';
  const parsed = parseMultiArtistPrompt(prompt);
  assert.equal(parsed.styleQualifier, 'remix');
  assert.equal(parsed.sequenceOneByOne, true);
  assert.deepEqual(
    parsed.artists.map(a => a.toLowerCase()),
    ['juice wrld', 'xxxtentaction', 'ynw melly', 'king von']
  );

  const catalogByArtist = {
    'juice wrld': {
      found: true,
      artist: 'Juice WRLD',
      genre: 'Hip Hop',
      tracks: [{ artist: 'Juice WRLD', title: 'Lucid Dreams' }],
      relatedArtists: [{ name: 'Polo G', genre: 'Hip Hop' }, { name: 'The Kid LAROI', genre: 'Hip Hop' }]
    },
    xxxtentaction: {
      found: true,
      artist: 'XXXTENTACION',
      genre: 'Hip Hop',
      tracks: [{ artist: 'XXXTENTACION', title: 'SAD!' }],
      relatedArtists: [{ name: 'Ski Mask the Slump God', genre: 'Hip Hop' }]
    },
    'ynw melly': {
      found: true,
      artist: 'YNW Melly',
      genre: 'Hip Hop',
      tracks: [{ artist: 'YNW Melly', title: 'Mixed Personalities' }],
      relatedArtists: [{ name: 'YNW BSlime', genre: 'Hip Hop' }]
    },
    'king von': {
      found: true,
      artist: 'King Von',
      genre: 'Hip Hop',
      tracks: [{ artist: 'King Von', title: 'Crazy Story' }],
      relatedArtists: [{ name: 'Lil Durk', genre: 'Hip Hop' }]
    }
  };

  const mockResolver = async (q) => catalogByArtist[String(q || '').toLowerCase()] || { found: false, artist: '', tracks: [], relatedArtists: [] };
  const multi = await getMultiArtistCatalogAndRelated(parsed.artists, { resolver: mockResolver });
  assert.equal(multi.found, true);
  assert.equal(multi.artists.length, 4);
  assert.ok(multi.relatedArtists.some(r => r.name === 'Polo G'));

  const db = memoryDb();
  const mockProviders = {
    get: () => ({ enabled: false }),
    search: async (query) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('juice wrld')) {
        return {
          items: [
            normalizeTrack({ providerId: 'jw-news', title: 'Juice WRLD Documentary Murder Trial News', artist: 'CNN', durationSeconds: 200 }, 'fixture'),
            normalizeTrack({ providerId: 'jw-orig', title: 'Lucid Dreams', artist: 'Juice WRLD', durationSeconds: 239, viewCount: 500000 }, 'fixture'),
            normalizeTrack({ providerId: 'jw-rmx', title: 'Lucid Dreams (Lil Uzi Vert Remix)', artist: 'Juice WRLD', durationSeconds: 245, viewCount: 900000 }, 'fixture')
          ]
        };
      }
      if (q.includes('xxxtentac')) {
        return {
          items: [
            normalizeTrack({ providerId: 'x-rmx', title: 'SAD! (Official Club Remix)', artist: 'XXXTENTACION', durationSeconds: 185, viewCount: 700000 }, 'fixture')
          ]
        };
      }
      if (q.includes('ynw melly')) {
        return {
          items: [
            normalizeTrack({ providerId: 'ynw-news', title: 'YNW Melly Court Hearing Verdict Today', artist: 'Law&Crime', durationSeconds: 300 }, 'fixture'),
            normalizeTrack({ providerId: 'ynw-rmx', title: 'Suicidal (Juice WRLD Remix)', artist: 'YNW Melly', durationSeconds: 215, viewCount: 850000 }, 'fixture')
          ]
        };
      }
      if (q.includes('king von')) {
        return {
          items: [
            normalizeTrack({ providerId: 'kv-rmx', title: 'Took Her To The O (Remix)', artist: 'King Von', durationSeconds: 198, viewCount: 800000 }, 'fixture')
          ]
        };
      }
      if (q.includes('polo g')) {
        return {
          items: [
            normalizeTrack({ providerId: 'pg-rmx', title: 'Rapstar (Remix)', artist: 'Polo G', durationSeconds: 175, viewCount: 600000 }, 'fixture')
          ]
        };
      }
      return { items: [] };
    }
  };

  const session = {
    chatId: -100123456,
    upcoming: [],
    history: [],
    currentTrack: null,
    status: 'idle'
  };
  const qm = {
    closed: false,
    sessions: new Map([[session.chatId, session]]),
    getSession: () => session,
    enqueue: (_id, track, { top = false } = {}) => {
      const entry = { ...track, entryId: `e-${track.providerId}` };
      if (top) session.upcoming.unshift(entry);
      else session.upcoming.push(entry);
      return { track: entry };
    },
    updatePlayerCard: async () => true,
    ensurePlaying: async () => true
  };

  const dj = new AiDjEngine({
    app: { db, musicProviders: mockProviders, musicQueueManager: qm },
    fetchCharts: async () => [],
    artistResolver: mockResolver
  });

  const chatRes = await dj.chatWithDj(session, prompt, { apply: true });
  assert.equal(chatRes.added.length, 4);
  // Strict 1-by-1 order: Juice WRLD -> XXXTENTACION -> YNW Melly -> King Von, with remixes selected & ZERO news!
  assert.deepEqual(chatRes.added.map(t => t.artist), ['Juice WRLD', 'XXXTENTACION', 'YNW Melly', 'King Von']);
  assert.ok(chatRes.added.every(t => /remix/i.test(t.title)));
  assert.ok(!chatRes.added.some(t => /trial|documentary|court|cnn|law&crime/i.test(`${t.title} ${t.artist}`)));

  // Drop Next Chapter transitions smoothly into Related Artists!
  const chap = await dj.dropNextChapter(session);
  assert.equal(chap.stage, 'related');
  assert.ok(chap.added.some(t => t.artist === 'Polo G'));

  // Behavioral skip signal: two rapid early skips downrank/ban an artist
  dj.recordSignal(session, 'skip_early', { track: { artist: 'King Von' }, playedSeconds: 8 });
  dj.recordSignal(session, 'skip_early', { track: { artist: 'King Von' }, playedSeconds: 11 });
  assert.ok(session.aiDj.bannedArtists.includes('kingvon'));
});

test('LRC synced lyrics generator, SubtitleService LRC parser, StudioCanvas Visual DJ Desk, and Telegram DJ Desk controls work end-to-end', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy-djdesk-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const syncedLrc = buildLrcSubtitleText({
    found: true,
    syncedLyrics: '[00:10.50]First line playing\n[00:15.00]Second line chorus'
  }, 180);
  assert.ok(syncedLrc.includes('[00:10.50]First line playing'));

  const plainFallbackLrc = buildLrcSubtitleText({
    found: true,
    text: 'Line one\nLine two\nLine three'
  }, 120);
  assert.equal((plainFallbackLrc.match(/\[\d{2}:\d{2}\.\d{2}\]/g) || []).length, 3);

  const lrcFile = join(dir, 'track.lrc');
  await writeFile(lrcFile, '[offset:500]\n[00:05.00]Line alpha\n[00:10.00]Line beta\n', 'utf8');
  const subs = new SubtitleService();
  const cues = subs.loadCues(lrcFile);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 5500);
  assert.equal(cues[0].text, 'Line alpha');

  const canvas = new StudioCanvas({ cacheDir: dir });
  const deskPath = await canvas.renderFrame({
    title: 'Lucid Dreams (Remix)',
    artist: 'Juice WRLD',
    album: 'GBGR',
    durationSeconds: 245,
    provider: 'music',
    eqPreset: 'bass',
    djNote: 'Spinning 1-by-1 Remixes',
    visualDesk: true,
    nextTitle: 'SAD! (Remix)',
    nextArtist: 'XXXTENTACION',
    chapterTitle: 'Ch. 1 · REMIX 1-by-1',
    crossfadeSec: 4
  });
  assert.ok(existsSync(deskPath));
  const meta = await sharp(deskPath).metadata();
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);

  // Wire MusicService + MusicScreen renderDjDesk
  const db = memoryDb();
  const voiceCalls = [];
  const fakeVoice = {
    setSubtitle: async (...args) => { voiceCalls.push(args); return { ok: true }; },
    setVolume: async () => ({ ok: true })
  };
  const qm = new QueueManager({ app: { db }, voiceClient: fakeVoice, db, pollMs: 0 });
  t.after(() => qm.shutdown());

  const app = {
    db,
    voiceClient: fakeVoice,
    musicQueueManager: qm,
    musicProviders: { get: () => ({ enabled: false }), search: async () => ({ items: [] }) }
  };
  const service = new MusicService({ app, search: {}, lyrics: {}, accounts: {} });
  app.music = service;
  app.music.aiDj.fetchChartsFn = async () => [];
  app.music.aiDj.artistResolverFn = async () => ({ found: false, artist: '', tracks: [], relatedArtists: [] });

  const s = qm.getSession(-100777);
  s.connected = true;
  s.status = 'playing';
  s.screenMessageId = 50;
  s.positionSeconds = 12;
  s.currentTrack = normalizeTrack({
    providerId: 't1',
    title: 'Lucid Dreams (Remix)',
    artist: 'Juice WRLD',
    durationSeconds: 240
  }, 'music');
  s.currentTrack.subtitlePath = lrcFile;
  s.cardLyrics = {
    trackId: s.currentTrack.id,
    status: 'ready',
    result: { found: true, syncedLyrics: '[00:05.00]Line alpha\n[00:10.00]Line beta' }
  };

  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  const ctx = {
    chatId: -100777,
    tgId: 1,
    isAdmin: true,
    controller: { isAdmin: () => true },
    api: {
      getChatMember: async () => ({ status: 'administrator' }),
      answerCallbackQuery: async () => true,
      editMessageRich: async () => ({ message_id: 50 }),
      editMessageText: async () => ({ message_id: 50 })
    },
    query: { id: 'q1', message: { message_id: 50, chat: { type: 'supergroup' } } }
  };

  await service.control(ctx, 'djdesk', ['open', String(s.controlRevision || 0)]);
  assert.equal(s.view, 'djdesk');

  await service.control(ctx, 'djdesk', ['dlyrics', String(s.controlRevision || 0)]);
  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0][2].subtitleRenderScreen, false);

  await service.control(ctx, 'djdesk', ['xfade', String(s.controlRevision || 0)]);
  assert.equal(s.aiDj.crossfadeSec, 8);

  const deskCard = screen.renderPlayer(s);
  const serialized = JSON.stringify(deskCard);
  assert.ok(serialized.includes('Drop Chapter'));
  assert.ok(serialized.includes('Visual Desk'));
  assert.ok(serialized.includes('Lyrics'));
  assert.ok(serialized.includes('Remix'));
  assert.ok(serialized.includes('DECK A (ON AIR)'));
  assert.ok(serialized.includes('Line beta'));
});
