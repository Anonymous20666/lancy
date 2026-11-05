import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { MovieApiClient } from '../src/cinema/movieApi.js';
import { CinemaDestinationManager } from '../src/cinema/destinations.js';
import { CinemaQueueManager } from '../src/cinema/queueManager.js';
import { SynchronizedPollManager } from '../src/cinema/pollManager.js';
import { CinemaPlaybackAdapter } from '../src/cinema/playbackAdapter.js';
import { CinemaApiRouter } from '../src/cinema/apiRouter.js';
import { CinemaCardManager } from '../src/cinema/cardManager.js';
import { CinemaStreamResolver } from '../src/cinema/streamResolver.js';

test('Cinema: MovieApiClient queries live API and caches results', async () => {
  const client = new MovieApiClient();
  const health = await client.getHealth();
  assert.equal(health.status, 'healthy');

  const home = await client.getHome();
  assert.ok(Array.isArray(home.trending_movies));
  assert.ok(home.trending_movies.length > 0);

  // Cached call check
  const homeCached = await client.getHome();
  assert.equal(homeCached, home);
});

test('Cinema: DestinationManager generates and cryptographically verifies destination tokens', async () => {
  const db = new Database(':memory:');

  const mgr = new CinemaDestinationManager({
    app: { settings: { get: () => [] } },
    db
  });

  const chatId = -100192837465;
  const token = mgr.generateToken(chatId);
  assert.ok(typeof token === 'string');
  assert.ok(token.startsWith(String(chatId)));

  const verifiedChatId = mgr.verifyToken(token);
  assert.equal(verifiedChatId, chatId);

  // Corrupted token check
  const badToken = token.slice(0, -4) + 'abcd';
  assert.equal(mgr.verifyToken(badToken), null);
  assert.equal(mgr.verifyToken('invalid_token_format'), null);
});

test('Cinema: QueueManager handles additions, queue priority, and TV episode progression', async () => {
  const db = new Database(':memory:');

  // Insert mock destination
  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash)
    VALUES (-100123456, 'channel', 'Cinema Test Channel', 'token123');
  `);

  const mockApi = {
    getTvEpisode: async (id, s, e) => {
      if (s === 1 && e === 2) return { id: 2, title: 'Episode 2' };
      if (s === 2 && e === 1) return { id: 3, title: 'Season 2 Episode 1' };
      return null;
    }
  };

  const qm = new CinemaQueueManager({ db, api: mockApi });
  const chatId = -100123456;

  // Add Item 1
  const add1 = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: '100',
    title: 'The Dark Knight',
    addedByUserId: 123
  });
  assert.equal(add1.ok, true);

  // Add Item 2
  const add2 = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: '200',
    title: 'Inception',
    addedByUserId: 123
  });
  assert.equal(add2.ok, true);

  let queue = qm.getQueue(chatId);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].title, 'The Dark Knight');
  assert.equal(queue[1].title, 'Inception');

  // Play Next (should jump to Position 1)
  const addNext = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: '300',
    title: 'Interstellar',
    addedByUserId: 123,
    playNext: true
  });
  assert.equal(addNext.ok, true);

  queue = qm.getQueue(chatId);
  assert.equal(queue[0].title, 'Interstellar');
  assert.equal(queue[1].title, 'The Dark Knight');

  // Test TV progression
  const nextEp = await qm.resolveNextEpisode('tv_99', 1, 1);
  assert.deepEqual(nextEp, {
    mediaType: 'tv',
    mediaId: 'tv_99',
    season: 1,
    episode: 2,
    title: 'Episode 2'
  });
});

test('Cinema: SynchronizedPollManager ties deadline to media clock and deterministically promotes winner', async () => {
  const db = new Database(':memory:');

  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash, voting_enabled)
    VALUES (-100999, 'channel', 'Voting Test Channel', 'token999', 1);
  `);

  const mockPlayback = {
    getCurrentSession: () => ({
      sessionId: 'sess_1',
      title: 'Current Movie',
      duration: 7200,
      position: 3600
    })
  };

  const mockQueue = {
    getQueue: () => [
      { queue_item_id: 'q_1', title: 'Candidate A', media_type: 'movie' },
      { queue_item_id: 'q_2', title: 'Candidate B', media_type: 'movie' }
    ]
  };

  const pollMgr = new SynchronizedPollManager({
    db,
    queueManager: mockQueue,
    playbackAdapter: mockPlayback
  });

  const poll = await pollMgr.startPoll(-100999, { durationSeconds: 60 });
  assert.ok(poll);
  assert.equal(poll.candidates.length, 2);

  // Cast Votes
  await pollMgr.vote(poll.pollSessionId, 101, 'q_2');
  await pollMgr.vote(poll.pollSessionId, 102, 'q_2');
  await pollMgr.vote(poll.pollSessionId, 103, 'q_1');

  // User 103 changes vote to q_2
  await pollMgr.vote(poll.pollSessionId, 103, 'q_2');

  const results = pollMgr.getPollResults(poll.pollSessionId);
  assert.equal(results.totalVotes, 3);
  assert.equal(results.winner?.queueItemId, 'q_2');

  // Finalize
  const finalized = await pollMgr.finalizePoll(poll.pollSessionId);
  assert.equal(finalized.status, 'closed');
});

test('Cinema: DestinationManager registers by @handle and verifies permissions without AI collision', async () => {
  const db = new Database(':memory:');

  const mockApp = {
    telegram: {
      api: {
        me: { id: 8859351350 },
        getChat: async (target) => {
          if (target === '@pappygcs' || target === -1002345678) {
            return { id: -1002345678, type: 'channel', title: 'Pappy GCS Official', username: 'pappygcs' };
          }
          throw new Error('Chat not found');
        },
        getChatMember: async (chatId, botId) => {
          return {
            status: 'administrator',
            can_manage_video_chats: true,
            can_post_messages: true,
            can_edit_messages: true
          };
        }
      }
    }
  };

  const dm = new CinemaDestinationManager({ db, app: mockApp });
  const reg = await dm.registerDestination('@pappygcs', 99999);

  assert.ok(reg.destination);
  assert.equal(reg.destination.chatId, -1002345678);
  assert.equal(reg.destination.username, 'pappygcs');
  assert.equal(reg.destination.title, 'Pappy GCS Official');
  assert.ok(reg.token);
  assert.ok(reg.miniAppUrl.includes(reg.token));

  // Verify authorization
  const auth = dm.isAuthorized(-1002345678, 99999);
  assert.equal(auth, true);
});

test('Cinema: CinemaCardManager builds Bot API 10.3 compliant Now Playing card', () => {
  const db = new Database(':memory:');
  const app = {
    cinemaDestinations: {
      generateToken: (cid) => `${cid}_token`,
      getMiniAppUrl: (t) => `https://test.app/cinema/?dest=${t}`
    },
    telegram: { botUsername: 'Lancy_easy_bot' }
  };

  const cardMgr = new CinemaCardManager({ app, db });
  const dest = { chatId: -100123456, title: 'Cinema Supergroup' };
  const session = {
    title: 'Interstellar',
    mediaType: 'movie',
    state: 'PLAYING',
    position: 1800,
    duration: 7200
  };
  const queue = [{ title: 'Inception', media_type: 'movie' }];

  const card = cardMgr.buildNowPlayingCard(dest, session, queue);
  assert.ok(card);
  assert.ok(Array.isArray(card.blocks));
  // Verify Mini App button is present in buttons block
  const buttonBlock = card.blocks.find(b => b.type === 'buttons');
  assert.ok(buttonBlock);
  assert.ok(buttonBlock.buttons[0].web_app?.url);
});

test('Cinema: CinemaPlaybackAdapter streams media and executes TV progression on stream end', async () => {
  const db = new Database(':memory:');
  let playedSource = null;
  let playedOpts = null;

  const mockVoice = {
    play: async (chatId, source, opts) => {
      playedSource = source;
      playedOpts = opts;
      return { ok: true };
    },
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    seek: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };

  const mockApp = {
    db,
    cinemaCards: { postOrUpdateCard: async () => {} },
    movieApi: {
      getPlayback: async () => ({ embed_url: 'https://cdn.streams.test/breaking_bad_s01e02.m3u8' })
    },
    cinemaQueue: {
      getNextItem: async () => null,
      resolveNextEpisode: async (tvId, s, e) => {
        if (s === 1 && e === 1) return { mediaId: tvId, season: 1, episode: 2, title: 'Episode 2' };
        return null;
      },
      removeFromQueue: () => {}
    }
  };

  const adapter = new CinemaPlaybackAdapter({ app: mockApp, db, voiceClient: mockVoice });
  const chatId = -100999888;

  // Insert destination
  db.run("INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash) VALUES (?, 'channel', 'Test Channel', 'thash')", chatId);

  // Play TV Series episode
  const session = await adapter.play(chatId, {
    mediaType: 'tv',
    mediaId: '500',
    title: 'Breaking Bad',
    season: 1,
    episode: 1,
    source: 'https://cdn.streams.test/breaking_bad_s01e01.m3u8',
    duration: 3600
  });

  assert.equal(session.state, 'PLAYING');
  assert.equal(playedSource, 'https://cdn.streams.test/breaking_bad_s01e01.m3u8');
  assert.equal(playedOpts.video, true);
  assert.equal(playedOpts.isChannel, true);

  // Trigger stream end event
  await adapter.handleStreamEnded(chatId, session.playbackId);

  // Verify progression: episode 2 should now be playing!
  const nextSession = adapter.getCurrentSession(chatId);
  assert.ok(nextSession);
  assert.equal(nextSession.episode, 2);
  assert.equal(nextSession.title, 'Episode 2');
});

test('Cinema: CinemaStreamResolver resolves direct media and caches server streams', async () => {
  const mockApp = {
    movieApi: {
      getPlayback: async (id) => ({
        available: true,
        embed_url: `https://player.cinezo.live/embed/movie/${id}`,
        servers: [
          { id: 'cinezo', url: `https://player.cinezo.live/embed/movie/${id}` },
          { id: 'direct_hls', url: `https://cdn.movies.test/${id}/master.m3u8` }
        ]
      })
    }
  };

  const resolver = new CinemaStreamResolver({ app: mockApp, cacheTtlMs: 60000 });

  // 1. Direct media URL pass-through
  const direct = await resolver.resolve({ sourceUrl: 'https://cdn.example.com/stream.m3u8' });
  assert.equal(direct.ok, true);
  assert.equal(direct.streamUrl, 'https://cdn.example.com/stream.m3u8');
  assert.equal(direct.isHls, true);

  // 2. Resolve via movie API
  const resolved = await resolver.resolve({ mediaType: 'movie', mediaId: '100' });
  assert.equal(resolved.ok, true);
  assert.ok(resolved.streamUrl);
  assert.equal(resolved.cached, false);

  // 3. Cache hit on second call
  const cached = await resolver.resolve({ mediaType: 'movie', mediaId: '100' });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.streamUrl, resolved.streamUrl);
});

test('Cinema: Multi-Destination Concurrency maintains strictly isolated sessions, queues, and polls', async () => {
  const db = new Database(':memory:');

  const channelA = -100111222;
  const channelB = -100333444;
  const groupC = -100555666;

  // 1. Register destinations
  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash, voting_enabled)
    VALUES (?, 'channel', 'Channel Alpha', 'token_hash_a', 1),
           (?, 'channel', 'Channel Beta', 'token_hash_b', 1),
           (?, 'supergroup', 'Group Gamma', 'token_hash_c', 0);
  `, channelA, channelB, groupC);

  const stoppedChats = new Set();
  const mockVoice = {
    setup: async () => ({ ok: true }),
    play: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    seek: async () => ({ ok: true }),
    stop: async (c) => { stoppedChats.add(c); return { ok: true }; }
  };

  const mockApp = {
    db,
    settings: { get: () => [] },
    cinemaCards: { postOrUpdateCard: async () => {} }
  };

  const destinations = new CinemaDestinationManager({ app: mockApp, db });
  const playback = new CinemaPlaybackAdapter({ app: mockApp, db, voiceClient: mockVoice });
  const queue = new CinemaQueueManager({ app: mockApp, db, playbackAdapter: playback });
  const poll = new SynchronizedPollManager({ app: mockApp, db, queueManager: queue, playbackAdapter: playback });

  mockApp.cinemaDestinations = destinations;
  mockApp.cinemaPlayback = playback;
  mockApp.cinemaQueue = queue;
  mockApp.cinemaPoll = poll;

  // 2. Start independent streams on Channel A, Channel B, and Group C
  await playback.play(channelA, {
    mediaType: 'movie',
    mediaId: '10',
    title: 'Inception',
    source: 'https://cdn.example.com/inception.m3u8',
    duration: 7200,
    offset: 500
  });

  await playback.play(channelB, {
    mediaType: 'movie',
    mediaId: '20',
    title: 'Interstellar',
    source: 'https://cdn.example.com/interstellar.m3u8',
    duration: 10000,
    offset: 120
  });

  await playback.play(groupC, {
    mediaType: 'tv',
    mediaId: '30',
    title: 'Breaking Bad',
    season: 1,
    episode: 1,
    source: 'https://cdn.example.com/breakingbad.m3u8',
    duration: 3600,
    offset: 30
  });

  // Verify independent session states
  const sessionA = playback.getCurrentSession(channelA);
  const sessionB = playback.getCurrentSession(channelB);
  const sessionC = playback.getCurrentSession(groupC);

  assert.equal(sessionA.title, 'Inception');
  assert.equal(sessionA.position, 500);
  assert.equal(sessionA.state, 'PLAYING');

  assert.equal(sessionB.title, 'Interstellar');
  assert.equal(sessionB.position, 120);
  assert.equal(sessionB.state, 'PLAYING');

  assert.equal(sessionC.title, 'Breaking Bad');
  assert.equal(sessionC.season, 1);
  assert.equal(sessionC.episode, 1);

  // 3. Independent Queues
  await queue.addToQueue(channelA, { mediaType: 'movie', mediaId: '101', title: 'The Matrix', addedByUserId: 1 });
  await queue.addToQueue(channelB, { mediaType: 'movie', mediaId: '201', title: 'Oppenheimer', addedByUserId: 2 });
  await queue.addToQueue(channelB, { mediaType: 'movie', mediaId: '202', title: 'Dunkirk', addedByUserId: 2 });

  const queueA = queue.getQueue(channelA);
  const queueB = queue.getQueue(channelB);
  const queueC = queue.getQueue(groupC);

  assert.equal(queueA.length, 1);
  assert.equal(queueA[0].title, 'The Matrix');

  assert.equal(queueB.length, 2);
  assert.equal(queueB[0].title, 'Oppenheimer');
  assert.equal(queueB[1].title, 'Dunkirk');

  assert.equal(queueC.length, 0);

  // 4. Token isolation check
  const tokenA = destinations.generateToken(channelA);
  const tokenB = destinations.generateToken(channelB);
  assert.notEqual(tokenA, tokenB);
  assert.equal(destinations.verifyToken(tokenA), channelA);
  assert.equal(destinations.verifyToken(tokenB), channelB);

  // 5. Mutate Channel A (pause + seek) -> Channel B and Group C must be completely unchanged
  await playback.pause(channelA);
  await playback.seek(channelA, 900);

  const updatedA = playback.getCurrentSession(channelA);
  const checkB = playback.getCurrentSession(channelB);
  const checkC = playback.getCurrentSession(groupC);

  assert.equal(updatedA.state, 'PAUSED');
  assert.equal(updatedA.position, 900);

  assert.equal(checkB.state, 'PLAYING');
  assert.equal(checkB.position, 120); // completely untouched

  assert.equal(checkC.state, 'PLAYING');
  assert.equal(checkC.position, 30); // completely untouched

  // 6. Synchronized Poll in Channel A only
  await queue.addToQueue(channelA, { mediaType: 'movie', mediaId: '102', title: 'Avatar', addedByUserId: 1 });
  const pollSession = await poll.startPoll(channelA, { durationSeconds: 60 });
  assert.ok(pollSession?.pollSessionId);

  // Active poll exists in Channel A, not in Channel B
  assert.ok(poll.getActivePoll(channelA));
  assert.equal(poll.getActivePoll(channelB), null);

  // Cast vote in Channel A
  const candidateItem = pollSession.candidates[0];
  await poll.vote(pollSession.pollSessionId, 999, candidateItem.queueItemId);
  const tallyA = poll.getPollResults(pollSession.pollSessionId);
  assert.equal(tallyA.totalVotes, 1);
  assert.equal(tallyA.tally[0].votes, 1);

  // 7. Stop Channel A -> Channel B and Group C remain actively playing
  await playback.stop(channelA);
  assert.ok(stoppedChats.has(channelA));
  assert.equal(playback.getCurrentSession(channelA), null);

  assert.equal(playback.getCurrentSession(channelB)?.state, 'PLAYING');
  assert.equal(playback.getCurrentSession(groupC)?.state, 'PLAYING');
});

test('Cinema: Admin Demotion & Bot Removal Invalidation terminates playback and revokes status', async () => {
  const db = new Database(':memory:');
  const chatId = -100777888;

  // Insert active destination
  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, bot_status, token_hash, voting_enabled)
    VALUES (?, 'channel', 'Security Test Channel', 'active', 'tok777', 1);
  `, chatId);

  let stoppedChat = null;
  const mockPlayback = {
    stop: async (c) => { stoppedChat = c; return { ok: true }; }
  };

  const mockApp = {
    db,
    cinemaPlayback: mockPlayback
  };

  const destinations = new CinemaDestinationManager({ app: mockApp, db });

  // 1. Admin demotion: Video chat permission stripped
  const demotionUpdate = {
    chat: { id: chatId, type: 'channel' },
    new_chat_member: {
      status: 'administrator',
      can_manage_video_chats: false,
      can_post_messages: true
    }
  };

  const demoteRes = await destinations.handleChatMemberUpdated(demotionUpdate);
  assert.equal(demoteRes.status, 'restricted');
  assert.equal(stoppedChat, chatId);

  let dest = destinations.getDestinationByChatId(chatId);
  assert.equal(dest.botStatus, 'restricted');

  // 2. Re-granting video chat permissions restores active status
  const restoreUpdate = {
    chat: { id: chatId, type: 'channel' },
    new_chat_member: {
      status: 'administrator',
      can_manage_video_chats: true,
      can_post_messages: true
    }
  };

  const restoreRes = await destinations.handleChatMemberUpdated(restoreUpdate);
  assert.equal(restoreRes.status, 'active');
  dest = destinations.getDestinationByChatId(chatId);
  assert.equal(dest.botStatus, 'active');

  // 3. Bot kicked / removed from channel
  stoppedChat = null;
  const kickUpdate = {
    chat: { id: chatId, type: 'channel' },
    new_chat_member: {
      status: 'kicked'
    }
  };

  const kickRes = await destinations.handleChatMemberUpdated(kickUpdate);
  assert.equal(kickRes.status, 'revoked');
  assert.equal(stoppedChat, chatId);

  dest = destinations.getDestinationByChatId(chatId);
  assert.equal(dest.botStatus, 'revoked');
});

test('Cinema: QueueManager supports moveToTop, reorderQueue, season batching, and rich metadata persistence', async () => {
  const db = new Database(':memory:');
  const chatId = -100444555;
  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash)
    VALUES (?, 'channel', 'Queue Advanced Channel', 'tok444');
  `, chatId);

  const mockApi = {
    getTvSeason: async (tvId, seasonNum) => ({
      series_id: tvId,
      season_number: seasonNum,
      episodes: [
        { episode_number: 1, title: 'Pilot', runtime: 58, thumbnail: 'https://img.test/ep1.jpg' },
        { episode_number: 2, title: 'Cat in the Bag', runtime: 48, thumbnail: 'https://img.test/ep2.jpg' },
        { episode_number: 3, title: 'And the Bag in the River', runtime: 48, thumbnail: 'https://img.test/ep3.jpg' }
      ]
    })
  };

  const qm = new CinemaQueueManager({ db, api: mockApi });
  const r1 = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: 'm1',
    title: 'Dune: Part One',
    poster: 'https://img.test/dune1.jpg',
    year: '2021',
    rating: 8.0,
    duration: 9300
  });
  const r2 = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: 'm2',
    title: 'Dune: Part Two',
    poster: 'https://img.test/dune2.jpg',
    year: '2024',
    rating: 8.5,
    duration: 9960
  });
  const r3 = await qm.addToQueue(chatId, {
    mediaType: 'movie',
    mediaId: 'm3',
    title: 'Blade Runner 2049',
    poster: 'https://img.test/br2049.jpg',
    year: '2017',
    rating: 8.1,
    duration: 9840
  });

  // Verify metadata persisted
  let list = qm.getQueue(chatId);
  assert.equal(list.length, 3);
  assert.equal(list[0].poster, 'https://img.test/dune1.jpg');
  assert.equal(list[0].year, '2021');

  // Move third item to top
  qm.moveToTop(chatId, r3.queueItemId);
  list = qm.getQueue(chatId);
  assert.equal(list[0].queue_item_id, r3.queueItemId);
  assert.equal(list[0].title, 'Blade Runner 2049');

  // Reorder explicitly: [r2, r1, r3]
  qm.reorderQueue(chatId, [r2.queueItemId, r1.queueItemId, r3.queueItemId]);
  list = qm.getQueue(chatId);
  assert.deepEqual(list.map(i => i.queue_item_id), [r2.queueItemId, r1.queueItemId, r3.queueItemId]);

  // Add entire TV season
  const seasonAdd = await qm.addSeasonToQueue(chatId, {
    mediaId: 'tv_bb',
    seriesTitle: 'Breaking Bad',
    season: 1,
    poster: 'https://img.test/bb.jpg'
  });
  assert.equal(seasonAdd.ok, true);
  assert.equal(seasonAdd.addedCount, 3);
  list = qm.getQueue(chatId);
  assert.equal(list.length, 6);
});

test('Cinema: SynchronizedPollManager pauses/resumes with playback and recalculates on seek', async () => {
  const db = new Database(':memory:');
  const chatId = -100888999;
  db.run(`
    INSERT INTO cinema_destinations (chat_id, chat_type, title, token_hash, voting_enabled)
    VALUES (?, 'channel', 'Clock Sync Channel', 'tok888', 1);
  `, chatId);

  const qm = new CinemaQueueManager({ db });
  await qm.addToQueue(chatId, { mediaType: 'movie', mediaId: '1', title: 'Movie Alpha' });
  await qm.addToQueue(chatId, { mediaType: 'movie', mediaId: '2', title: 'Movie Beta' });

  const mockPlayback = {
    getCurrentSession: () => ({
      sessionId: 'sess_sync',
      title: 'Currently Playing',
      state: 'PLAYING',
      duration: 600,
      position: 100
    })
  };

  const pollMgr = new SynchronizedPollManager({
    db,
    queueManager: qm,
    playbackAdapter: mockPlayback
  });

  const poll = await pollMgr.startPoll(chatId, { durationSeconds: 120 });
  assert.ok(poll);

  // Pause playback -> poll should pause
  pollMgr.pausePollForChat(chatId);
  let active = pollMgr.getActivePoll(chatId);
  assert.equal(active.paused, true);

  // Resume playback -> poll should resume
  pollMgr.resumePollForChat(chatId);
  active = pollMgr.getActivePoll(chatId);
  assert.equal(active.paused, false);

  // Seek near the end of media -> poll deadline adjusts
  const recalc = pollMgr.recalculatePollOnSeek(chatId, 520, 600);
  assert.ok(recalc);
  assert.ok(recalc.remainingSeconds <= 55);
});

