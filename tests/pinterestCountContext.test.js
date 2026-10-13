import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { Database } from '../src/core/db.js';

test('Pinterest count selection retrieves query from sctx.context and runs search without EMPTY_QUERY error', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'normal',
      depth TEXT NOT NULL DEFAULT 'deep',
      result_count INTEGER NOT NULL DEFAULT 0,
      duplicates_found INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      pin_id TEXT,
      media_url TEXT NOT NULL,
      sha256 TEXT,
      type TEXT NOT NULL DEFAULT 'photo',
      mime TEXT,
      quality_score REAL NOT NULL DEFAULT 1.0,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'valid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  let searchedQuery = null;
  let searchedGoal = null;
  let searchedMode = null;

  const mockApp = {
    settings,
    telegram: {
      api: {
        sendRichMessage: async () => ({ message_id: 100 }),
        editMessageRich: async () => ({ message_id: 100 }),
        deleteMessage: async () => true,
        sendMessage: async () => ({ message_id: 101 })
      },
      markMediaDeliveryMessage: () => {},
      userScreenMessage: new Map()
    },
    queues: {
      add: async (name, job) => {
        return job.run(job, { signal: new AbortController().signal });
      }
    },
    pinterest: {
      db,
      search: async (opts) => {
        searchedQuery = opts.query;
        searchedGoal = opts.goal;
        searchedMode = opts.mode;
        return {
          searchId: 1,
          results: [],
          stats: { total: 0 }
        };
      },
      markResultsDelivered: () => {}
    },
    media: {
      cache: {
        read: () => null
      }
    }
  };

  const screen = createPinterestScreen({ app: mockApp });

  // Simulate user in States.PINTEREST_SEARCH waiting for count selection
  const tgId = 12345;
  await sm.transition(tgId, States.PINTEREST_SEARCH, {
    context: { mode: 'normal', query: 'lofi anime aesthetic', stage: 'count', screenMessageId: 100 },
    chatId: tgId,
    screenMessageId: 100
  });

  // Verify sctx has query both directly and in sctx.context
  const sctx = sm.ctxFor(tgId);
  assert.equal(sctx.context.query, 'lofi anime aesthetic');
  assert.equal(sctx.query, 'lofi anime aesthetic');

  // Now simulate user tapping '10' button: action 'runCount', args: ['10', 'normal'] (args[2] is undefined)
  const ctx = {
    tgId,
    chatId: tgId,
    messageId: 100,
    sm,
    api: mockApp.telegram.api,
    query: { message: { message_id: 100 } },
    controller: mockApp.telegram
  };

  await screen.handle(ctx, 'runCount', ['10', 'normal']);

  // Assert search was triggered with the correct query and goal
  assert.equal(searchedQuery, 'lofi anime aesthetic');
  assert.equal(searchedGoal, 10);
  assert.equal(searchedMode, 'normal');
});

test('Pinterest count selection falls back to user history if state context is lost', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'normal',
      depth TEXT NOT NULL DEFAULT 'deep',
      result_count INTEGER NOT NULL DEFAULT 0,
      duplicates_found INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      pin_id TEXT,
      media_url TEXT NOT NULL,
      sha256 TEXT,
      type TEXT NOT NULL DEFAULT 'photo',
      mime TEXT,
      quality_score REAL NOT NULL DEFAULT 1.0,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'valid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Insert a previous search in DB for user
  const tgId = 99999;
  db.run(
    `INSERT INTO pinterest_searches (user_id, query, normalized_query, mode) VALUES (?, ?, ?, ?)`,
    tgId, 'sunset ocean vibes', 'sunset ocean vibes', 'normal'
  );

  let searchedQuery = null;
  const mockApp = {
    settings,
    telegram: {
      api: {
        sendRichMessage: async () => ({ message_id: 200 }),
        editMessageRich: async () => ({ message_id: 200 }),
        deleteMessage: async () => true,
        sendMessage: async () => ({ message_id: 201 })
      },
      markMediaDeliveryMessage: () => {},
      userScreenMessage: new Map()
    },
    queues: {
      add: async (name, job) => {
        return job.run(job, { signal: new AbortController().signal });
      }
    },
    pinterest: {
      db,
      search: async (opts) => {
        searchedQuery = opts.query;
        return {
          searchId: 2,
          results: [],
          stats: { total: 0 }
        };
      },
      markResultsDelivered: () => {}
    },
    media: {
      cache: {
        read: () => null
      }
    }
  };

  const screen = createPinterestScreen({ app: mockApp });

  // User has empty state (e.g. state machine expired)
  const ctx = {
    tgId,
    chatId: tgId,
    messageId: 200,
    sm,
    api: mockApp.telegram.api,
    query: { message: { message_id: 200 } },
    controller: mockApp.telegram
  };

  await screen.handle(ctx, 'runCount', ['20', 'normal']);

  // Assert fallback recovered query from DB
  assert.equal(searchedQuery, 'sunset ocean vibes');
});
