import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_CATEGORIES_2026, getCategoryFamily, getSubgenreById, searchCategories, inferArtistGenreCluster, formatMusicCategoriesCardHtml } from '../src/music/categories.js';
import { QueueManager } from '../src/music/queueManager.js';
import { InfiniteRadio } from '../src/music/radio.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { enhanceRichText } from '../src/telegram/customEmoji.js';
import { TelegramAPI } from '../src/telegram/api.js';
import { TelegramController } from '../src/telegram/bot.js';
import { States } from '../src/core/stateMachine.js';

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

test('DM AI avoids VC confusion, treats "okay" after song offer as MP3 download, and opens DM menu/help screens', async () => {
  const downloaded = [];
  const openedMenus = [];
  const vcPlayed = [];

  const mockApp = {
    ai: {
      chatWithTools: async ({ system, messages }) => {
        // Verify DM system prompt explicitly tells AI NOT to confuse DM with VC and lists DM menus
        assert.ok(system.includes('NEVER for private DM'));
        assert.ok(system.includes('DM STUDIO & FULL MENU KNOWLEDGE'));
        const lastUser = messages.at(-1)?.content || '';
        if (/help|menu/i.test(lastUser)) {
          return {
            text: 'Opening the full Help & Guide right now!',
            toolCalls: [{ id: 'tc_help', function: { name: 'open_dm_menu', arguments: { screen: 'help' } } }]
          };
        }
        return {
          text: 'Downloading Rema — Calm Down straight to your DM!',
          toolCalls: [{ id: 'tc_dl', function: { name: 'search_and_play_music', arguments: { query: 'Rema Calm Down', action: 'play_now' } } }]
        };
      }
    },
    screens: new Map([
      ['downloader', {
        executeDownload: async (_ctx, query) => {
          downloaded.push(query);
          return { ok: true };
        }
      }],
      ['help', {
        open: async () => {
          openedMenus.push('help');
        }
      }]
    ]),
    musicProviders: {
      get: () => ({
        search: async (q) => ({
          items: [
            { id: 'music:rema1', provider: 'music', providerId: 'rema1', title: 'Calm Down', artist: 'Rema', durationSeconds: 239, sourceBadge: 'Deezer · Studio' }
          ]
        })
      })
    },
    musicQueueManager: {
      sessions: new Map(),
      getSession: () => ({ chatId: 7778165287, upcoming: [], movieUpcoming: [] }),
      playImmediateAndContinue: async (cid, track) => {
        vcPlayed.push({ cid, track });
      }
    }
  };

  const agent = new LancyAgent({ app: mockApp });
  const dmCtx = { chatId: 7778165287, tgId: 7778165287, user: { id: 7778165287, first_name: 'Koko' } };

  // 1. Direct music request in DM -> downloads MP3 to DM, never calls VC playImmediateAndContinue, no VC card
  const dmRes = await agent.handleBotTurn(dmCtx, 'play rema calm down', { mode: 'companion', surface: 'dm_text' });
  assert.equal(vcPlayed.length, 0, 'DM must never start VC playback');
  assert.equal(downloaded.length, 1);
  assert.ok(downloaded[0].includes('Calm Down'));
  assert.equal(dmRes.card, null, 'DM download must not post redundant VC DJ card');

  // 2. User says "okay" after a song was discussed/offered in DM -> automatically downloads MP3 to DM
  const conv = agent.getBotConversation(7778165287, 7778165287);
  conv.history.push({ role: 'assistant', content: 'Want me to download "Tyla - Water" to your DM?' });
  const okRes = await agent.handleBotTurn(dmCtx, 'okay', { mode: 'companion', surface: 'dm_text' });
  assert.equal(vcPlayed.length, 0);
  assert.equal(downloaded.length, 2);
  assert.ok(okRes.reply.toLowerCase().includes('downloading'));

  // 3. User asks for help / DM menu -> opens Help & Guide screen cleanly
  const helpRes = await agent.handleBotTurn(dmCtx, 'show me help and dm menu', { mode: 'companion', surface: 'dm_text' });
  assert.deepEqual(openedMenus, ['help']);
  assert.equal(helpRes.card, null);

  // 4. VC deck controls in DM are rejected cleanly with non-VC explanation
  const ctrlOut = await agent.executor.execute('control_playback', { action: 'pause' }, { chatId: 7778165287, surface: 'dm_text' });
  assert.equal(ctrlOut.ok, false);
  assert.equal(ctrlOut.error, 'vc_not_available_in_dm');
});

test('InfiniteRadio cold-start resolves 2026 subgenre to signature artist fast without multi-round delay', async () => {
  const searchedQueries = [];
  const session = { chatId: -100777888, upcoming: [], history: [], streamMode: 'rtmp' };
  const mockApp = {
    musicProviders: {
      search: async (q) => {
        searchedQueries.push(q);
        return {
          items: [
            { id: 'music:afro1', provider: 'music', providerId: 'afro1', title: 'Water', artist: 'Tyla', durationSeconds: 200, sourceBadge: 'Deezer' },
            { id: 'music:afro2', provider: 'music', providerId: 'afro2', title: 'Push 2 Start', artist: 'Tyla', durationSeconds: 185, sourceBadge: 'Deezer' }
          ]
        };
      },
      get: () => ({ enabled: false })
    },
    musicQueueManager: {
      closed: false,
      enqueue: (cid, item) => { session.upcoming.push(item); }
    }
  };
  const radio = new InfiniteRadio({ app: mockApp });
  radio.configure(session, ['Afro-pop'], { video: false });
  assert.equal(session.radio.video, false);
  await radio.refill(session);
  assert.equal(searchedQueries.length, 1, 'Cold-start 2026 subgenre should resolve in 1 fast search call');
  assert.notEqual(searchedQueries[0], 'Afro-pop', 'Should map Afro-pop to curated Afro-pop artist instead of literal genre name');
  assert.ok(session.upcoming.length >= 1);
  assert.equal(session.upcoming[0].mediaType, 'audio');
});

test('enhanceRichText preserves combining grapheme clusters and TelegramAPI recovers custom emojis surgically', async () => {
  // Combining enclosing marks after ♥︎ must not be split into custom_emoji + orphan combining mark, while standalone 🌷 converts
  const pfpLine = enhanceRichText('╬♥︎⃝🌷 studio');
  assert.ok(Array.isArray(pfpLine));
  assert.equal(pfpLine.some((tok) => tok && tok.type === 'custom_emoji' && tok.alternative_text === '♥︎'), false);
  assert.equal(pfpLine.some((tok) => tok && tok.type === 'custom_emoji' && tok.alternative_text === '🌷'), true);

  // If Telegram rejects button custom emojis with RICH_MESSAGE_EMOJI_INVALID, tier 1 strips ONLY buttons and preserves body custom emojis
  const api = new TelegramAPI('123456:TESTTOKEN', { log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } });
  const sentPayloads = [];
  api.call = async (method, params) => {
    sentPayloads.push(params.rich_message);
    const hasButtonCustomEmoji = (params.rich_message?.blocks || [])
      .filter((b) => b.type === 'buttons')
      .some((b) => JSON.stringify(b).includes('"custom_emoji"'));
    if (hasButtonCustomEmoji) {
      const err = new Error('Bad Request: RICH_MESSAGE_EMOJI_INVALID');
      err.description = 'Bad Request: RICH_MESSAGE_EMOJI_INVALID';
      throw err;
    }
    return { message_id: 99, rich_message: params.rich_message };
  };
  const payload = {
    blocks: [
      { type: 'heading', text: [{ type: 'custom_emoji', alternative_text: '🎧', custom_emoji_id: '5354899958329784877' }, ' Player'], size: 1 },
      { type: 'buttons', buttons: [{ text: [{ type: 'custom_emoji', alternative_text: '⏮', custom_emoji_id: '5375401426371514977' }, ' Prev'], callback_data: 'x', style: 'primary' }] }
    ]
  };
  const out = await api.sendRichMessage(-100123, payload);
  assert.equal(out.message_id, 99);
  assert.equal(sentPayloads.length, 2);
  assert.equal(out.rich_message.blocks[0].text[0].type, 'custom_emoji', 'Heading custom_emoji must survive button fallback');
  assert.equal(out.rich_message.blocks[1].buttons[0].text, '⏮ Prev', 'Button custom_emoji cleanly downgraded to text');
});

test('TelegramController skips stale replayed messages while accepting fresh/dateless updates and expires un-replied AI_MEDIA_CHAT group follow-ups', async () => {
  const handledTexts = [];
  const fakeApi = {
    me: { id: 999999, username: 'Lancy_easy_bot' },
    sendMessage: async () => ({ message_id: 1 })
  };
  const fakeSm = {
    get: () => null,
    state: () => null,
    states: new Map(),
    set: () => {},
    reset: async () => {}
  };
  let dbLookups = 0;
  const ctrl = new TelegramController({
    api: fakeApi,
    db: {
      get: () => { dbLookups += 1; return null; },
      run: () => {},
      all: () => []
    },
    settings: { get: (k) => (String(k).includes('public') || String(k).includes('enabled') ? false : []) },
    stateMachine: fakeSm,
    app: {
      ai: {
        chat: async (_ctx, text) => { handledTexts.push(text); }
      }
    }
  });
  const staleSec = Math.floor(Date.now() / 1000) - 600;
  await ctrl.handleUpdate({
    update_id: 1001,
    message: {
      message_id: 10,
      date: staleSec,
      chat: { id: 555, type: 'private' },
      from: { id: 555, username: 'tester', first_name: 'Tester' },
      text: '/help'
    }
  });
  assert.equal(dbLookups, 0, 'Stale replayed message (>90s) must be dropped before running #upsertUser or commands');

  const freshSec = Math.floor(Date.now() / 1000) - 5;
  await ctrl.handleUpdate({
    update_id: 1002,
    message: {
      message_id: 11,
      date: freshSec,
      chat: { id: 555, type: 'private' },
      from: { id: 555, username: 'tester', first_name: 'Tester' },
      text: '/help'
    }
  });
  assert.ok(dbLookups >= 1, 'Fresh message must reach #upsertUser and run normally');

  // Verify AI_MEDIA_CHAT group un-replied follow-up respects createdAt expiry (120s)
  const aiTurnCalls = [];
  const stateRecords = new Map([
    ['42', {
      state: States.AI_MEDIA_CHAT,
      tgId: '42',
      chatId: -100777,
      expiresAt: Date.now() + 300000,
      context: {
        stateKey: '42',
        botKey: 'main',
        createdAt: Date.now() - 180000,
        lastTurnAt: Date.now() - 180000,
        promptMessageId: 77,
        replyableMessageIds: [77]
      }
    }]
  ]);
  const testSm = {
    handlers: new Map(),
    register(st, def) { this.handlers.set(st, def); },
    get(k) { return stateRecords.get(String(k)) || null; },
    reset: async (k) => { stateRecords.delete(String(k)); }
  };
  const scr = createMusicScreen({
    app: {
      music: { botKey: () => 'main', destination: () => -100777, authorize: async () => -100777 },
      musicQueueManager: { getSession: () => null },
      movieUi: {
        handleAiTurn: async (_ctx, text) => { aiTurnCalls.push(text); return {}; }
      }
    }
  });
  scr.registerStateHandlers(testSm);
  const aiHandler = testSm.handlers.get(States.AI_MEDIA_CHAT);
  const captured = await aiHandler.onMessage(
    { tgId: '42', chatId: -100777, isChannel: false, api: { me: { id: 999 } } },
    { message_id: 88, chat: { id: -100777, type: 'supergroup' }, text: 'random group banter' }
  );
  assert.equal(captured, false, 'Expired (>120s) AI_MEDIA_CHAT un-replied group message must not hijack random banter');
  assert.equal(aiTurnCalls.length, 0);
});


