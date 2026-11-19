import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_CATEGORIES_2026, getCategoryFamily, getSubgenreById, searchCategories, inferArtistGenreCluster, formatMusicCategoriesCardHtml } from '../src/music/categories.js';
import { QueueManager } from '../src/music/queueManager.js';
import { InfiniteRadio } from '../src/music/radio.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';

test('2026 Music Categories Directory covers all 8 families and 95+ subgenres with smart search', () => {
  assert.equal(MUSIC_CATEGORIES_2026.length, 8);
  const expectedFamilies = ['mainstream', 'band', 'electronic', 'soul', 'african', 'international', 'styles', 'underground'];
  assert.deepEqual(MUSIC_CATEGORIES_2026.map(f => f.id), expectedFamilies);

  const totalSubgenres = MUSIC_CATEGORIES_2026.reduce((sum, f) => sum + f.subgenres.length, 0);
  assert.ok(totalSubgenres >= 95, `Expected at least 95 subgenres, got ${totalSubgenres}`);

  // Verify specific user-requested subgenres across families
  assert.ok(getSubgenreById('amapiano'));
  assert.ok(getSubgenreById('street-pop'));
  assert.ok(getSubgenreById('jersey-club'));
  assert.ok(getSubgenreById('uk-garage'));
  assert.ok(getSubgenreById('afrojuju'));
  assert.ok(getSubgenreById('bongo-flava'));
  assert.ok(getSubgenreById('maskandi'));
  assert.ok(getSubgenreById('regional-mexican'));
  assert.ok(getSubgenreById('video-game-ost'));
  assert.ok(getSubgenreById('drift-phonk'));
  assert.ok(getSubgenreById('sigilkore'));
  assert.ok(getSubgenreById('pluggnb'));
  assert.ok(getSubgenreById('emo-rap'));
  assert.ok(getSubgenreById('witch-house'));

  // Search Categories by name, alias, and artist
  const phonkMatches = searchCategories('phonk');
  assert.ok(phonkMatches.length >= 3);
  assert.ok(phonkMatches.some(m => m.id === 'drift-phonk' || m.id === 'phonk'));

  const naijaMatches = searchCategories('naija street');
  assert.ok(naijaMatches.some(m => m.id === 'street-pop' || m.familyId === 'african'));

  const juiceMatches = searchCategories('Juice WRLD');
  assert.ok(juiceMatches.some(m => m.id === 'emo-rap' || m.id === 'sad-songs'));

  const html = formatMusicCategoriesCardHtml();
  assert.ok(html.includes('MUSIC GENRES &amp; CATEGORIES · 2026'));
  assert.ok(html.includes('Internet & Underground'));
});

test('Smart Infinite Mode infers artist + 2026 genre cluster + similar artists (e.g. Juice WRLD -> Emo Rap cluster)', () => {
  const cluster = inferArtistGenreCluster('Juice WRLD', 'Lucid Dreams', '');
  assert.ok(cluster.primarySubgenre);
  assert.ok(['emo-rap', 'sad-songs', 'freestyle'].includes(cluster.primarySubgenre.id));
  assert.ok(cluster.relatedArtists.includes('XXXTENTACION') || cluster.relatedArtists.includes('Lil Uzi Vert') || cluster.relatedArtists.includes('Trippie Redd'));

  const mockApp = {
    musicProviders: { get: () => ({ enabled: false }) },
    musicQueueManager: { enqueue: () => {} }
  };
  const radio = new InfiniteRadio({ app: mockApp });
  const session = { chatId: -10012345, upcoming: [], history: [] };
  radio.seedFromTrack(session, { title: 'Lucid Dreams', artist: 'Juice WRLD', mediaType: 'audio' });
  assert.equal(session.radio?.enabled, true);
  assert.equal(session.radio?.queries?.[0], 'Juice WRLD');
  assert.ok(session.radio.queries.length >= 3, `Expected artist + similar + genre seeds, got ${JSON.stringify(session.radio.queries)}`);
});

test('Music Deck defaults to RTMP and maintains independent Music vs Movie queues on switchDeck', async () => {
  const settings = new Map();
  const played = [];
  const mockVoice = {
    play: async (chatId, source, opts) => {
      played.push({ chatId, source, opts });
      return { ok: true, position_seconds: opts.startSeconds || 0, account_alias: 'acc1' };
    },
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true })
  };
  const qm = new QueueManager({
    app: {},
    db: {
      getSetting: (k, d) => (settings.has(k) ? settings.get(k) : d),
      setSetting: (k, v) => settings.set(k, v)
    },
    voiceClient: mockVoice,
    pollMs: 0,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  qm.updatePlayerCard = async () => {};

  const chatId = -100998877;
  assert.equal(qm.getDeckStreamMode(chatId, 'music'), 'rtmp');
  assert.equal(qm.getDeckStreamMode(chatId, 'movie'), 'rtmp');

  const s = qm.getSession(chatId);
  assert.equal(s.musicStreamMode, 'rtmp');
  assert.equal(s.movieStreamMode, 'rtmp');

  // Enqueue 2 music tracks and 2 movie tracks
  qm.enqueue(chatId, { id: 'm1', provider: 'music', title: 'All Girls Are The Same', artist: 'Juice WRLD', filePath: '/bin/sh', durationSeconds: 165 });
  qm.enqueue(chatId, { id: 'm2', provider: 'music', title: 'Robbery', artist: 'Juice WRLD', filePath: '/bin/sh', durationSeconds: 240 });
  qm.enqueueMovie(chatId, { id: 'mv1', provider: 'movie', title: 'John Wick: Chapter 4', filePath: '/bin/sh', durationSeconds: 7200 });
  qm.enqueueMovie(chatId, { id: 'mv2', provider: 'movie', title: 'Dune: Part Two', filePath: '/bin/sh', durationSeconds: 9000 });

  assert.equal(s.upcoming.length, 2);
  assert.equal(s.movieUpcoming.length, 2);

  // Start Music Deck
  await qm.playNext(chatId);
  assert.equal(s.activeDeck, 'music');
  assert.equal(s.currentTrack?.title, 'All Girls Are The Same');
  assert.equal(s.upcoming.length, 1);
  assert.equal(s.movieUpcoming.length, 2);
  s.positionSeconds = 72;

  // Flip to Movie Deck -> Music track is snapshotted at 72s and Movie #1 starts; Music queue remains intact
  await qm.switchDeck(chatId, 'movie');
  assert.equal(s.activeDeck, 'movie');
  assert.equal(s.currentTrack?.title, 'John Wick: Chapter 4');
  assert.equal(s.musicCurrentTrack?.title, 'All Girls Are The Same');
  assert.equal(s.musicCurrentTrack?.resumePositionSeconds, 72);
  assert.equal(s.upcoming.length, 2); // All Girls Are The Same (at front with resume 72s) + Robbery
  assert.equal(s.movieUpcoming.length, 1); // Dune: Part Two

  s.positionSeconds = 1840;

  // Flip back to Music Deck -> Movie track is snapshotted at 1840s and Music resumes from 72s
  await qm.switchDeck(chatId, 'music');
  assert.equal(s.activeDeck, 'music');
  assert.equal(s.currentTrack?.title, 'All Girls Are The Same');
  assert.equal(s.positionSeconds, 72);
  assert.equal(s.movieCurrentTrack?.title, 'John Wick: Chapter 4');
  assert.equal(s.movieCurrentTrack?.resumePositionSeconds, 1840);
  assert.equal(s.movieUpcoming.length, 2); // John Wick (saved at 1840s) + Dune: Part Two
});

test('Instant Chat DJ greeting (<50ms) and fast conversational tool loop without blocking on deepReason', async () => {
  let deepCalled = 0;
  let fastCalled = 0;
  const mockApp = {
    ai: {
      deepReason: async () => {
        deepCalled++;
        return { text: 'Slow deep reason', toolCalls: [] };
      },
      chatWithTools: async () => {
        fastCalled++;
        return {
          text: 'Spinning Juice WRLD — Lucid Dreams on RTMP right now!',
          toolCalls: [
            {
              id: 'call_1',
              function: {
                name: 'search_and_play_music',
                arguments: { query: 'Juice WRLD Lucid Dreams', action: 'play_now' }
              }
            }
          ]
        };
      }
    },
    musicProviders: {
      get: () => ({
        search: async () => ({
          items: [
            { id: 'music:jw1', provider: 'music', providerId: 'jw1', title: 'Lucid Dreams', artist: 'Juice WRLD', durationSeconds: 239, sourceBadge: 'Spotify · Studio' }
          ]
        })
      })
    },
    musicQueueManager: {
      sessions: new Map(),
      getSession: () => ({ chatId: -100555, upcoming: [], movieUpcoming: [], radio: { enabled: true, queries: [] } }),
      playImmediateAndContinue: async () => {}
    }
  };

  const agent = new LancyAgent({ app: mockApp });

  const t0 = Date.now();
  const greeting = await agent.generatePersonalizedGreeting(
    { chatId: -100555, tgId: 42, user: { id: 42, first_name: 'Koko' } },
    { chatId: -100555, mode: 'dj', fast: true }
  );
  const elapsedGreetingMs = Date.now() - t0;
  assert.ok(elapsedGreetingMs < 50, `Expected instant greeting <50ms, took ${elapsedGreetingMs}ms`);
  assert.ok(greeting.greetingText.includes('Koko'));

  const turnRes = await agent.handleBotTurn(
    { chatId: -100555, tgId: 42, user: { id: 42, first_name: 'Koko' } },
    'play juice wrld lucid dreams',
    { mode: 'dj' }
  );
  assert.equal(deepCalled, 0, 'Chat DJ turn must not call slow deepReason');
  assert.equal(fastCalled, 1, 'Chat DJ turn must resolve in a single fast chatWithTools step');
  assert.ok(turnRes.reply.includes('Lucid Dreams'));
  assert.equal(turnRes.executed.length, 1);
  assert.equal(turnRes.executed[0].out.title, 'Lucid Dreams');
});

test('/vc Mode Selector, Music Streaming Hub, 2026 Categories Screen, Category Search, and Track Preview Card render cleanly', () => {
  const screen = createMusicScreen({
    app: {
      db: { getSetting: () => null },
      music: { destination: () => -100555 },
      musicQueueManager: { getSession: () => null }
    }
  });

  const modeCard = screen.renderVcModeSelector({
    destinationTitle: 'Lancy Lounge',
    activeDeck: 'music',
    upcoming: [{ title: 'Lucid Dreams' }],
    movieUpcoming: [{ title: 'Dune 2' }],
    radio: { enabled: true, queries: ['Juice WRLD', 'Emo Rap'] }
  });
  const modeStr = JSON.stringify(modeCard);
  assert.ok(modeStr.includes('Music Streaming'));
  assert.ok(modeStr.includes('Movie Streaming'));

  const hubCard = screen.renderMusicStreamingHub({
    destinationTitle: 'Lancy Lounge',
    musicStreamMode: 'rtmp',
    upcoming: [{ title: 'Lucid Dreams' }],
    movieUpcoming: []
  });
  const hubStr = JSON.stringify(hubCard);
  assert.ok(hubStr.includes('Categories (2026)'));
  assert.ok(hubStr.includes('Search Music'));
  assert.ok(hubStr.includes('AI DJ Chat'));
  assert.ok(hubStr.includes('RTMP Studio Default'));

  const catPicker = screen.renderCategoryPicker('queue', null, 0);
  const catStr = JSON.stringify(catPicker);
  assert.ok(catStr.includes('Mainstream & Trending'));
  assert.ok(catStr.includes('Internet & Underground'));
  assert.ok(catStr.includes('Search Categories'));

  const famCard = screen.renderCategoryFamily2026('underground', 'queue', null);
  const famStr = JSON.stringify(famCard);
  assert.ok(famStr.includes('Drift Phonk'));
  assert.ok(famStr.includes('Sigilkore'));
  assert.ok(famStr.includes('Emo Rap'));

  const catSearchCard = screen.renderCategorySearchResults('phonk', searchCategories('phonk'), 'queue');
  assert.ok(JSON.stringify(catSearchCard).includes('Drift Phonk'));

  const previewCard = screen.renderTrackPreviewCard({
    id: 's1',
    revision: 1,
    index: 0,
    mode: 'queue',
    selected: new Map(),
    pages: [{
      items: [{
        id: 'music:1',
        title: 'Lucid Dreams',
        artist: 'Juice WRLD',
        album: 'Goodbye & Good Riddance',
        genre: 'Emo Rap',
        durationSeconds: 239,
        sourceBadge: 'Spotify · Studio',
        previewUrl: 'https://cdns-preview.dzcdn.net/stream/c-123.mp3'
      }]
    }]
  }, 0);
  const prevStr = JSON.stringify(previewCard);
  assert.ok(prevStr.includes('Play Audio (RTMP)'));
  assert.ok(prevStr.includes('Play Music Video (RTMP)'));
  assert.ok(prevStr.includes('Start Infinite Radio'));
  assert.ok(prevStr.includes('Send 30s Audio Clip'));
});

