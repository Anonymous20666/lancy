import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { LancyApp } from '../src/app.js';
import { FixtureProvider } from '../src/pinterest/fixtures.js';

/**
 * End-to-end smoke test: boot the REAL LancyApp + TelegramController with a
 * scripted mock Telegram API, drive /start, menu callbacks, a full Pinterest
 * deep search (fixture provider + local media server), the settings screen,
 * and the AI chat — verifying the whole wiring renders valid Rich Messages
 * without a single network call to Telegram/Pinterest/WhatsApp.
 */

const OWNER = 100;
let tmp;
let server;
let baseUrl;
let app;
let sent;       // { chatId, rich } — sendRichMessage calls
let edited;     // editMessageRich calls
let plain;      // sendMessage calls
let scripted;   // updates the mock poll() will deliver
let messageIdCounter = 1000;

function makeUpdateMessage(text) {
  messageIdCounter++;
  return {
    update_id: messageIdCounter,
    message: {
      message_id: messageIdCounter,
      from: { id: OWNER, first_name: 'Lancy', username: 'lancytester' },
      chat: { id: OWNER, type: 'private' },
      text,
      date: Math.floor(Date.now() / 1000)
    }
  };
}

function makeCallbackUpdate(data) {
  messageIdCounter++;
  return {
    update_id: messageIdCounter,
    callback_query: {
      id: `cb-${messageIdCounter}`,
      from: { id: OWNER, first_name: 'Lancy', username: 'lancytester' },
      message: {
        message_id: messageIdCounter,
        chat: { id: OWNER, type: 'private' },
        date: Math.floor(Date.now() / 1000)
      },
      data,
      chat_instance: 'x'
    }
  };
}

function makeMockApi() {
  return {
    botUsername: 'lancytestbot',
    async getMe() { return { id: 1, username: 'lancytestbot', is_bot: true }; },
    async poll() {
      if (scripted.length === 0) {
        await new Promise((r) => setTimeout(r, 20));
        return [];
      }
      return scripted.splice(0, scripted.length);
    },
    async answerCallbackQuery() {},
    async sendMessage(chatId, text) { plain.push({ chatId, text }); return { message_id: ++messageIdCounter }; },
    async sendRichMessage(chatId, rich) { sent.push({ chatId, rich }); return { message_id: ++messageIdCounter }; },
    async editMessageRich(chatId, messageId, rich) { edited.push({ chatId, messageId, rich }); return true; },
    async editMessageText() { return true; },
    async sendChatAction() {},
    async sendPhoto() { return { message_id: ++messageIdCounter }; },
    async sendDocument() { return { message_id: ++messageIdCounter }; },
    async sendSticker() { return { message_id: ++messageIdCounter }; },
    async deleteMessage() { return true; },
    async getFile() { return { file_path: 'x' }; },
    async downloadFile() { return Buffer.alloc(0); },
    async getStickerSet() { throw new Error('not found'); }
  };
}

/** Validate a rich message payload the way the Bot API would (structurally). */
function assertValidRich(rich, label) {
  assert.ok(rich && typeof rich === 'object', `${label}: rich payload is an object`);
  assert.ok(Array.isArray(rich.blocks) && rich.blocks.length > 0, `${label}: has blocks`);
  assert.ok(rich.blocks.length <= 500, `${label}: ≤500 blocks`);
  let chars = 0;
  const walk = (blocks) => {
    for (const b of blocks) {
      chars += JSON.stringify(b).length;
      for (const key of ['blocks', 'items', 'cells', 'summary']) {
        if (Array.isArray(b[key])) walk(b[key]);
      }
      if (b.cells) for (const row of b.cells) walk(row);
      if (b.summary) walk([b.summary]);
      if (b.type === 'buttons') {
        assert.ok(b.buttons.length <= 8, `${label}: ≤8 buttons per row`);
        for (const btn of b.buttons) {
          if (btn.callback_data) assert.ok(Buffer.byteLength(btn.callback_data) <= 64, `${label}: callback ≤64B`);
        }
      }
      if (b.type === 'table') {
        for (const row of b.cells) {
          for (const cell of row) {
            assert.ok(cell.align && cell.valign, `${label}: table cell align+valign required`);
          }
        }
      }
    }
  };
  walk(rich.blocks);
  assert.ok(chars <= 32768 * 2, `${label}: within char budget`);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'lancy-smoke-'));
  // local media server for the fixture provider
  server = createServer(async (req, res) => {
    const m = /\/media\/lancy-demo-(\d+)\.jpg/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    const i = Number(m[1]);
    const svg = `<svg width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b9d"/><stop offset="1" stop-color="#3a0ca3"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><circle cx="300" cy="300" r="150" fill="#ffd166" opacity="0.9"/><rect x="500" y="500" width="300" height="300" fill="#06d6a0" opacity="0.85"/></svg>`;
    const img = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': img.length }).end(img);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  sent = []; edited = []; plain = []; scripted = [];

  app = new LancyApp({ env: { BOT_TOKEN: 'test-token', OWNER_IDS: String(OWNER) }, dataDir: tmp });
  app.setupTelegram();
  // Swap in the mock API (no network) and point the search at local fixtures.
  app.telegram.api = makeMockApi();
  app.telegram.controller.api = app.telegram.api;
  app.telegram.controller.botUsername = 'lancytestbot';
  app.stickerService.api = app.telegram.api;
  const pins = Array.from({ length: 30 }, (_, i) => ({
    pinId: `smoke-${String(i).padStart(4, '0')}`,
    mediaUrl: `${baseUrl}/media/lancy-demo-${i}.jpg`,
    type: 'image', width: 900, height: 900, tags: ['smoke', 'test']
  }));
  app.pinterest.provider = new FixtureProvider({ pins, pageSize: 10 });
  app.settings.set('pinterest.searchDepth', 'quick');
  app.ai.start();
  // Start the real poll loop against the mock API.
  await app.telegram.controller.start();
});

after(async () => {
  await app?.stop().catch(() => {});
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function drive(updates, waitMs = 300) {
  scripted.push(...updates);
  await new Promise((r) => setTimeout(r, waitMs));
}

test('whole product boots and wires together', () => {
  assert.ok(app.screens.size >= 7, 'all screens registered');
  for (const id of ['dashboard', 'pinterest', 'stickers', 'whatsapp', 'ai', 'settings', 'help']) {
    assert.ok(app.screens.has(id), `screen ${id} registered`);
  }
  assert.ok(app.telegram.controller, 'controller wired');
  assert.ok(app.packs && app.stickerService, 'sticker services wired');
});

test('/start renders a valid dashboard Rich Message', async () => {
  await drive([makeUpdateMessage('/start')], 400);
  const dash = [...sent, ...edited].at(-1);
  assert.ok(dash, 'a message was sent/edited');
  assertValidRich(dash.rich, 'dashboard');
  const json = JSON.stringify(dash.rich);
  assert.match(json, /LANCY/i);
});

test('dashboard → pinterest menu → search query → results (full flow)', async () => {
  sent = []; edited = []; plain = [];
  // open pinterest screen via its callback
  await drive([makeCallbackUpdate('l1:pinterest:open')], 300);
  assert.ok(sent.length + edited.length > 0, 'pinterest menu rendered');
  assertValidRich((sent.at(-1) ?? edited.at(-1)).rich, 'pinterest menu');

  // choose "♡ Search" → state PINTEREST_SEARCH
  await drive([makeCallbackUpdate('l1:pinterest:search')], 300);
  assert.equal(app.sm.state(String(OWNER)), 'PINTEREST_SEARCH', 'state machine entered search');

  // send the query as a text message -> prompts for result count
  await drive([makeUpdateMessage('smoke')], 300);
  assert.equal(app.sm.state(String(OWNER)), 'PINTEREST_SEARCH', 'state machine in count selection');

  // choose result count -> runs search into results
  await drive([makeCallbackUpdate('l1:pinterest:runCount:20:normal:smoke')], 10000);
  assert.ok(['IDLE', 'PINTEREST_RESULTS'].includes(app.sm.state(String(OWNER))), 'search completed');
  const all = [...sent, ...edited];
  assert.ok(all.length >= 2, 'progress + results messages exist');
  for (const m of all) assertValidRich(m.rich, 'search flow');
  const joined = JSON.stringify(all.map((m) => m.rich));
  assert.match(joined, /results|found|unique/i);
  // the search was persisted
  const searches = app.db.all('SELECT * FROM pinterest_searches ORDER BY id DESC LIMIT 1');
  assert.equal(searches.length, 1);
  assert.ok(searches[0].result_count >= 0, 'results persisted');
  assert.match(searches[0].normalized_query, /smoke/);
  app.sm.transition(String(OWNER), 'IDLE');
});

test('settings screen renders all 13 categories and edits a setting', async () => {
  sent = []; edited = [];
  await drive([makeCallbackUpdate('l1:settings:open')], 300);
  const menu = (sent.at(-1) ?? edited.at(-1));
  assert.ok(menu, 'settings menu rendered');
  assertValidRich(menu.rich, 'settings menu');
  const json = JSON.stringify(menu.rich);
  for (const cat of ['General', 'Telegram', 'WhatsApp', 'Pinterest', 'Stickers', 'Captions', 'AI', 'Media', 'Performance', 'Storage', 'Security', 'Logging', 'Advanced']) {
    assert.ok(json.includes(cat), `category ${cat} present`);
  }
  // open a category and edit a safe (hot-reloadable) setting
  await drive([makeCallbackUpdate('l1:settings:category:pinterest')], 300);
  await drive([makeCallbackUpdate('l1:settings:edit:pinterest.searchDepth')], 300);
  assert.equal(app.sm.state(String(OWNER)), 'SETTINGS', 'edit flow entered SETTINGS state');
  await drive([makeUpdateMessage('very_deep')], 300);
  assert.equal(app.settings.get('pinterest.searchDepth'), 'very_deep', 'setting applied live');
  assert.equal(app.sm.state(String(OWNER)), 'IDLE');
});

test('restart-required settings are honestly flagged', async () => {
  const result = app.settings.set('storage.database', 'data/other.db');
  assert.equal(result.restartRequired, true);
  assert.equal(result.hotReloaded, false);
  assert.equal(app.settings.needsRestart(), true);
  app.settings.clearRestartFlags();
});

test('AI chat answers through the worker (style picker + message)', async () => {
  sent = []; edited = [];
  await drive([makeCallbackUpdate('l1:ai:open')], 500);
  assert.equal(app.sm.state(String(OWNER)), 'AI_CHAT', 'AI chat state entered');
  await drive([makeUpdateMessage('can you write me a caption for gojo?')], 6000);
  assert.ok(plain.length + sent.length + edited.length > 0, 'AI answered');
  const text = JSON.stringify([...plain, ...sent, ...edited]);
  assert.doesNotMatch(text, /Error|undefined is not|not defined/i);
});

test('WhatsApp screen renders pairing entry without a session', async () => {
  sent = []; edited = [];
  await drive([makeCallbackUpdate('l1:whatsapp:open')], 300);
  const wa = (sent.at(-1) ?? edited.at(-1));
  assert.ok(wa, 'whatsapp screen rendered');
  assertValidRich(wa.rich, 'whatsapp menu');
  assert.match(JSON.stringify(wa.rich), /pair|connect|session/i);
});

test('stickers screen renders with no packs', async () => {
  sent = []; edited = [];
  await drive([makeCallbackUpdate('l1:stickers:open')], 300);
  const st = (sent.at(-1) ?? edited.at(-1));
  assert.ok(st, 'stickers screen rendered');
  assertValidRich(st.rich, 'stickers menu');
});

test('strangers are rejected, owner is allowed', () => {
  const c = app.telegram.controller;
  assert.equal(c.isAllowed(OWNER).ok, true);
  assert.equal(c.isAllowed(999999).ok, false);
});

test('help screen renders', async () => {
  sent = []; edited = [];
  await drive([makeUpdateMessage('/help')], 300);
  const h = (sent.at(-1) ?? edited.at(-1));
  assert.ok(h, 'help rendered');
  assertValidRich(h.rich, 'help');
});

test('/cancel resets the state machine', async () => {
  await drive([makeCallbackUpdate('l1:pinterest:search')], 200);
  assert.equal(app.sm.state(String(OWNER)), 'PINTEREST_SEARCH');
  await drive([makeUpdateMessage('/cancel')], 300);
  assert.equal(app.sm.state(String(OWNER)), 'IDLE');
});
