import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { MovieApiClient } from '../src/cinema/movieApi.js';
import { CinemaDestinationManager } from '../src/cinema/destinations.js';
import { CinemaQueueManager } from '../src/cinema/queueManager.js';
import { SynchronizedPollManager } from '../src/cinema/pollManager.js';
import { CinemaPlaybackAdapter } from '../src/cinema/playbackAdapter.js';
import { CinemaApiRouter } from '../src/cinema/apiRouter.js';

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
