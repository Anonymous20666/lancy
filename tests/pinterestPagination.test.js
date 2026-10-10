import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinterestScreen } from '../src/telegram/screens/pinterest.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { Database } from '../src/core/db.js';
import { TelegramController } from '../src/telegram/bot.js';
import { decodeCallback } from '../src/telegram/rich.js';

test('Pinterest search results pagination: Page 1, Page 2, Page 3 (Prev and Next buttons)', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  // Set up schema for pinterest
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

  // Insert a search with 25 results
  db.run(`INSERT INTO pinterest_searches (id, user_id, query, normalized_query, mode, result_count) VALUES (1, 1001, 'aesthetic vibes', 'aesthetic vibes', 'normal', 25)`);

  for (let i = 1; i <= 25; i++) {
    db.run(
      `INSERT INTO pinterest_media (search_id, user_id, pin_id, media_url, sha256, type, quality_score, is_duplicate, status)
       VALUES (1, 1001, ?, ?, ?, 'photo', ?, 0, 'valid')`,
      `pin_${i}`,
      `https://example.com/pin_${i}.jpg`,
      `sha_${i}`,
      100 - i
    );
  }

  let lastSentRich = null;
  let lastEditedRich = null;

  const mockApi = {
    sendRichMessage: async (chatId, rich, opts, files) => {
      lastSentRich = rich;
      return { message_id: 100 };
    },
    editMessageRich: async (chatId, messageId, rich, opts, files) => {
      lastEditedRich = rich;
      return { message_id: messageId };
    }
  };

  const app = {
    settings,
    telegram: { api: mockApi },
    pinterest: {
      db,
      markResultsDelivered: () => {}
    },
    media: {
      cache: {
        read: (sha) => Buffer.from(`fake-media-${sha}`)
      }
    }
  };

  const screen = createPinterestScreen({ app });

  const ctx = {
    tgId: 1001,
    chatId: 1001,
    messageId: 100,
    api: mockApi,
    sm,
    settings
  };

  // 1. Initial reuse / page 1 (items 1–10)
  await screen.handle(ctx, 'reuse', ['1']);
  assert.ok(lastSentRich || lastEditedRich);
  const page1Rich = lastEditedRich || lastSentRich;

  // Find navigation buttons in page 1
  const allButtonRows1 = page1Rich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const navRow1 = allButtonRows1.find((row) => row.some((t) => /Next|Prev/i.test(t)));
  assert.ok(navRow1, 'Page 1 should have navigation buttons');
  assert.equal(navRow1.length, 1, 'Page 1 should have only 1 navigation button (Next)');
  assert.ok(/Next 10 Picks \(11–20\)/i.test(navRow1[0]), `Page 1 should have Next button to 11–20, got: ${navRow1[0]}`);
  assert.ok(!navRow1.some((t) => /Prev/i.test(t)), 'Page 1 should NOT have Prev button');

  // Verify text indicator
  const page1Text = JSON.stringify(page1Rich);
  assert.ok(page1Text.includes('showing 1–10 of 25 picks'), 'Page 1 should show 1–10 of 25 picks indicator');

  // 2. Navigate to Page 2 (items 11–20) via moreAlbum with offset 10
  lastEditedRich = null;
  await screen.handle(ctx, 'moreAlbum', ['1', '10']);
  const page2Rich = lastEditedRich || lastSentRich;
  assert.ok(page2Rich);

  const allButtonRows2 = page2Rich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const navRow2 = allButtonRows2.find((row) => row.some((t) => /Prev/i.test(t)));
  assert.ok(navRow2, 'Page 2 must have navigation row with Prev button');
  assert.equal(navRow2.length, 2, 'Page 2 should have both Prev and Next buttons side by side');
  assert.ok(/Prev \(1–10\)/i.test(navRow2[0]), `Page 2 Prev button should point to 1–10, got: ${navRow2[0]}`);
  assert.ok(/Next \(21–25\)/i.test(navRow2[1]), `Page 2 Next button should point to 21–25, got: ${navRow2[1]}`);

  const page2Text = JSON.stringify(page2Rich);
  assert.ok(page2Text.includes('showing 11–20 of 25 picks'), 'Page 2 should show 11–20 of 25 picks indicator');

  // 3. Navigate to Page 3 (items 21–25) via moreAlbum with offset 20
  lastEditedRich = null;
  await screen.handle(ctx, 'moreAlbum', ['1', '20']);
  const page3Rich = lastEditedRich || lastSentRich;
  assert.ok(page3Rich);

  const allButtonRows3 = page3Rich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const navRow3 = allButtonRows3.find((row) => row.some((t) => /Prev/i.test(t)));
  assert.ok(navRow3, 'Page 3 must have Prev button');
  assert.equal(navRow3.length, 1, 'Page 3 is the last page, should only have 1 nav button (Prev)');
  assert.ok(/Prev 10 Picks \(11–20\)/i.test(navRow3[0]), `Page 3 Prev button should go back to 11–20, got: ${navRow3[0]}`);
  assert.ok(!navRow3.some((t) => /Next/i.test(t)), 'Page 3 should NOT have Next button');

  const page3Text = JSON.stringify(page3Rich);
  assert.ok(page3Text.includes('showing 21–25 of 25 picks'), 'Page 3 should show 21–25 of 25 picks indicator');

  // 4. Click Prev from Page 3 back to Page 2 (offset 10) via prev_album alias
  lastEditedRich = null;
  await screen.handle(ctx, 'prev_album', ['1', '10']);
  const backToPage2Rich = lastEditedRich || lastSentRich;
  assert.ok(backToPage2Rich);
  const allButtonRowsBack2 = backToPage2Rich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const navRowBack2 = allButtonRowsBack2.find((row) => row.some((t) => /Prev/i.test(t)));
  assert.ok(navRowBack2);
  assert.equal(navRowBack2.length, 2, 'Navigating backwards to Page 2 restores both Prev and Next buttons');
  assert.ok(/Prev \(1–10\)/i.test(navRowBack2[0]));
  assert.ok(/Next \(21–25\)/i.test(navRowBack2[1]));

  // 5. Click Prev from Page 2 back to Page 1 (offset 0)
  lastEditedRich = null;
  await screen.handle(ctx, 'prevAlbum', ['1', '0']);
  const backToPage1Rich = lastEditedRich || lastSentRich;
  assert.ok(backToPage1Rich);
  const allButtonRowsBack1 = backToPage1Rich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const navRowBack1 = allButtonRowsBack1.find((row) => row.some((t) => /Next|Prev/i.test(t)));
  assert.ok(navRowBack1);
  assert.equal(navRowBack1.length, 1, 'Navigating back to Page 1 leaves only Next button');
  // 6. Test all-viewed screen when navigating past the end
  lastEditedRich = null;
  await screen.handle(ctx, 'moreAlbum', ['1', '30']);
  const allViewedRich = lastEditedRich || lastSentRich;
  assert.ok(allViewedRich);
  const allButtonRowsEnd = allViewedRich.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const prevEndBtn = allButtonRowsEnd.flat().find((t) => /Prev/i.test(t));
  assert.ok(prevEndBtn, 'All viewed screen should include ← Prev Picks button');

  db.close();
});

test('Pinterest video search results pagination: Prev and Next buttons for videos', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  db.run(`
    CREATE TABLE IF NOT EXISTS pinterest_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'videos',
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
      type TEXT NOT NULL DEFAULT 'video',
      mime TEXT,
      quality_score REAL NOT NULL DEFAULT 1.0,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'valid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`INSERT INTO pinterest_searches (id, user_id, query, normalized_query, mode, result_count) VALUES (2, 1001, 'anime edits', 'anime edits', 'videos', 15)`);

  for (let i = 1; i <= 15; i++) {
    db.run(
      `INSERT INTO pinterest_media (search_id, user_id, pin_id, media_url, sha256, type, quality_score, is_duplicate, status)
       VALUES (2, 1001, ?, ?, ?, 'video', ?, 0, 'valid')`,
      `pin_v_${i}`,
      `https://example.com/pin_${i}.mp4`,
      `sha_v_${i}`,
      100 - i
    );
  }

  let lastEditedRich = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich) => ({ message_id: 200 }),
    editMessageRich: async (chatId, messageId, rich) => {
      lastEditedRich = rich;
      return { message_id: messageId };
    }
  };

  const app = {
    settings,
    telegram: { api: mockApi },
    pinterest: { db, markResultsDelivered: () => {} },
    media: { cache: { read: (sha) => Buffer.from(`fake-video-${sha}`) } }
  };

  const screen = createPinterestScreen({ app });
  const ctx = { tgId: 1001, chatId: 1001, messageId: 200, api: mockApi, sm, settings };

  // Page 1: 10 videos (1–10)
  await screen.handle(ctx, 'reuse', ['2']);
  const page1 = lastEditedRich;
  assert.ok(page1);
  const rows1 = page1.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const nav1 = rows1.find((r) => r.some((t) => /Next|Prev/i.test(t)));
  assert.ok(nav1);
  assert.equal(nav1.length, 1);
  assert.ok(/Next 5 Videos \(11–15\)/i.test(nav1[0]));

  // Page 2: 5 videos (11–15)
  lastEditedRich = null;
  await screen.handle(ctx, 'moreAlbum', ['2', '10']);
  const page2 = lastEditedRich;
  assert.ok(page2);
  const rows2 = page2.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons.map((btn) => btn.text));
  const nav2 = rows2.find((r) => r.some((t) => /Prev/i.test(t)));
  assert.ok(nav2);
  assert.equal(nav2.length, 1, 'Page 2 of 2 is the last page');
  assert.ok(/Prev 10 Videos \(1–10\)/i.test(nav2[0]));

  db.close();
});

test('Pinterest search card buttons: action buttons include from_media while Next/Prev pagination does not', async () => {
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

  db.run(`INSERT INTO pinterest_searches (id, user_id, query, normalized_query, mode, result_count) VALUES (1, 1001, 'baddie', 'baddie', 'normal', 20)`);
  for (let i = 1; i <= 20; i++) {
    db.run(
      `INSERT INTO pinterest_media (search_id, user_id, pin_id, media_url, sha256, type, quality_score, is_duplicate, status)
       VALUES (1, 1001, ?, ?, ?, 'photo', ?, 0, 'valid')`,
      `pin_${i}`, `https://example.com/p_${i}.jpg`, `sha_${i}`, 100 - i
    );
  }

  let lastSentRich = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich) => {
      lastSentRich = rich;
      return { message_id: 100 };
    },
    editMessageRich: async (chatId, messageId, rich) => {
      lastSentRich = rich;
      return { message_id: messageId };
    }
  };

  const app = {
    settings,
    telegram: { api: mockApi },
    pinterest: { db, markResultsDelivered: () => {} },
    media: { cache: { read: (sha) => Buffer.from(`fake-${sha}`) } }
  };

  const screen = createPinterestScreen({ app });
  const ctx = { tgId: 1001, chatId: 1001, messageId: 100, api: mockApi, sm, settings };

  await screen.handle(ctx, 'reuse', ['1']);
  assert.ok(lastSentRich);

  const buttonBlocks = lastSentRich.blocks.filter((b) => b.type === 'buttons');
  const allButtons = buttonBlocks.flatMap((b) => b.buttons);

  const btnText = (b) => JSON.stringify(b?.text ?? '');

  // 1. Pagination button (Next) must NOT include 'from_media'
  const nextBtn = allButtons.find((btn) => /Next/i.test(btnText(btn)));
  assert.ok(nextBtn, 'Next button must exist');
  const nextDecoded = decodeCallback(nextBtn.callback_data);
  assert.equal(nextDecoded.action, 'moreAlbum');
  assert.equal(nextDecoded.args.includes('from_media'), false, 'Pagination must NOT have from_media so it edits in place');

  // 2. Make Sticker Pack button MUST include 'from_media'
  const stickerBtn = allButtons.find((btn) => /Make Sticker/i.test(btnText(btn)));
  assert.ok(stickerBtn, 'Make Sticker Pack button must exist');
  const stickerDecoded = decodeCallback(stickerBtn.callback_data);
  assert.equal(stickerDecoded.screen, 'stickers');
  assert.equal(stickerDecoded.action, 'fromSearch');
  assert.ok(stickerDecoded.args.includes('from_media'), 'Make Sticker button must have from_media');

  // 3. Add to Existing Pack button MUST include 'from_media'
  const addExistingBtn = allButtons.find((btn) => /Add to Existing Pack/i.test(btnText(btn)));
  assert.ok(addExistingBtn, 'Add to Existing Pack button must exist');
  const addExistingDecoded = decodeCallback(addExistingBtn.callback_data);
  assert.equal(addExistingDecoded.screen, 'stickers');
  assert.equal(addExistingDecoded.action, 'addExistingFromSearch');
  assert.ok(addExistingDecoded.args.includes('from_media'), 'Add to Existing Pack button must have from_media');

  // 4. New Search button MUST include 'from_media'
  const newSearchBtn = allButtons.find((btn) => /New Search/i.test(btnText(btn)));
  assert.ok(newSearchBtn, 'New Search button must exist');
  const newSearchDecoded = decodeCallback(newSearchBtn.callback_data);
  assert.equal(newSearchDecoded.screen, 'pinterest');
  assert.equal(newSearchDecoded.action, 'search');
  assert.ok(newSearchDecoded.args.includes('from_media'), 'New Search button must have from_media');

  // 5. Home button MUST include 'from_media'
  const homeBtn = allButtons.find((btn) => /Home/i.test(btnText(btn)));
  assert.ok(homeBtn, 'Home button must exist');
  const homeDecoded = decodeCallback(homeBtn.callback_data);
  assert.equal(homeDecoded.screen, 'dashboard');
  assert.equal(homeDecoded.action, 'open');
  assert.ok(homeDecoded.args.includes('from_media'), 'Home button must have from_media');

  db.close();
});

test('TelegramController isMediaDeliveryMessage recognizes Pinterest search result messages', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });
  const bot = new TelegramController({ api: {}, db, settings, sm });

  const pintSearchMsg = {
    message_id: 555,
    chat: { id: 1001 },
    reply_markup: {
      inline_keyboard: [
        [{ text: '🖼 Next 10 Picks (11–20) →', callback_data: 'l1:pinterest:moreAlbum:1:10' }],
        [
          { text: '✨ Make Sticker Pack', callback_data: 'l1:stickers:fromSearch:1:from_media' },
          { text: '➕ Add to Existing Pack', callback_data: 'l1:stickers:addExistingFromSearch:1:0:from_media' }
        ],
        [
          { text: '🔍 New Search', callback_data: 'l1:pinterest:search:from_media' },
          { text: '✦ Home', callback_data: 'l1:dashboard:open:from_media' }
        ]
      ]
    }
  };

  assert.equal(bot.isMediaDeliveryMessage(pintSearchMsg), true, 'Must detect Pinterest media message from inline keyboard');

  // Non-media message (e.g. settings or help menu)
  const normalMenuMsg = {
    message_id: 556,
    chat: { id: 1001 },
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Language', callback_data: 'l1:dashboard:language' }],
        [{ text: '✦ Home', callback_data: 'l1:dashboard:open' }]
      ]
    }
  };
  assert.equal(bot.isMediaDeliveryMessage(normalMenuMsg), false, 'Normal menu must not be flagged as media delivery');

  db.close();
});

test('Pinterest search card: Home and Make Sticker send fresh message, Next/Prev edits in place', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const sentRich = [];
  const editedRich = [];
  const mockApi = {
    sendRichMessage: async (chatId, rich) => {
      const msg = { message_id: 999, chat: { id: chatId } };
      sentRich.push({ chatId, rich });
      return msg;
    },
    editMessageRich: async (chatId, msgId, rich) => {
      const msg = { message_id: msgId, chat: { id: chatId } };
      editedRich.push({ chatId, msgId, rich });
      return msg;
    }
  };

  const bot = new TelegramController({ api: mockApi, db, settings, sm });

  const pintCardQuery = {
    id: 'cb_pint',
    from: { id: 1001, username: 'testuser' },
    message: {
      message_id: 700,
      chat: { id: 1001 },
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Next →', callback_data: 'l1:pinterest:moreAlbum:1:10' }],
          [{ text: '✨ Make Sticker Pack', callback_data: 'l1:stickers:fromSearch:1:from_media' }],
          [{ text: '✦ Home', callback_data: 'l1:dashboard:open:from_media' }]
        ]
      }
    }
  };

  // 1. Pagination callback (moreAlbum): MUST edit in place!
  pintCardQuery.data = 'l1:pinterest:moreAlbum:1:10';
  let handledPagination = false;
  bot.registerScreen({
    id: 'pinterest',
    handle: async (ctx, action, args) => {
      assert.equal(action, 'moreAlbum');
      assert.equal(ctx.forceNew, false, 'Pagination must have forceNew = false');
      assert.equal(ctx.fromMedia, false, 'Pagination must have fromMedia = false');
      handledPagination = true;
    }
  });
  await bot['#handleCallback'] ? bot['#handleCallback'](pintCardQuery) : null;

  // 2. Action callback from media (Home): editScreen MUST send a new message
  const ctxMedia = bot.createContext(1001, pintCardQuery, { forceNew: true, fromMedia: true });
  await ctxMedia.editScreen({ blocks: [{ type: 'header', text: 'Dashboard' }] });
  assert.equal(sentRich.length, 1, 'Navigating to Dashboard from media card must send a fresh message');
  assert.equal(editedRich.length, 0, 'Media card 700 must NOT be edited');

  // 3. Normal menu (non-media): editScreen CAN edit in place
  const normalQuery = {
    id: 'cb_normal',
    from: { id: 1001, username: 'testuser' },
    message: { message_id: 800, chat: { id: 1001 }, text: 'Settings menu' }
  };
  const ctxNormal = bot.createContext(1001, normalQuery);
  await ctxNormal.editScreen({ blocks: [{ type: 'header', text: 'Submenu' }] });
  assert.equal(editedRich.length, 1, 'Non-media screen must edit in place');
  assert.equal(editedRich[0].msgId, 800);

  db.close();
});


