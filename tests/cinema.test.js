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
