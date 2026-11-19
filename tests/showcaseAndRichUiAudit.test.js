import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { MultiBotManager } from '../src/telegram/multiBotManager.js';
import { RichMessageBuilder, richButton, richTextToString } from '../src/telegram/rich.js';
import { JobPlanner } from '../src/core/jobPlanner.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { didEditStripCustomEmojis, hasRichCustomEmoji, normalizeTrack } from '../src/music/model.js';
import { MusicService } from '../src/music/service.js';
import { QueueManager } from '../src/music/queueManager.js';
import {
  MovieDownloader,
  sortDownloadCandidates,
  validateAndPrepareSrt,
  sanitizeDownloadProgress
} from '../src/media/movieDownloader.js';
import {
  buildSystemShowcaseCard,
  buildShowcaseHtmlFallback
} from '../src/telegram/showcaseCard.js';
import {
  CUSTOM_EMOJI_MAP,
  enhanceHtmlWithCustomEmojis,
  extractCustomEmojiEntities,
  getCustomEmojiId,
  setGlobalCustomEmojiLookup
} from '../src/telegram/customEmoji.js';
import { TelegramAPI } from '../src/telegram/api.js';
import { OpenAICompatibleProvider } from '../src/ai/providers/openaiCompatible.js';
import { AIService } from '../src/ai/service.js';
import { createServer } from 'node:http';
import {
  CustomEmojiRegistry,
  NOISY_OR_DARK_UI_SET_NAMES
} from '../src/stickers/customEmojiRegistry.js';
import {
  parseBroadcastButtonLines,
  materializeRichButtonRows,
  deliverBroadcastToTarget,
  summarizeBroadcastItems
} from '../src/telegram/broadcastEngine.js';
import { createBroadcastScreen } from '../src/telegram/screens/broadcast.js';

test('buildSystemShowcaseCard produces valid Bot API 10.3 bannerHeader, toggle details, list bullets, and footer', () => {
  const card = buildSystemShowcaseCard({
    botName: 'Lancy',
    botUsername: 'pappy_agent',
    includeCta: true
  });
  assert.ok(card);
  assert.ok(Array.isArray(card.blocks));
  const blockTypes = card.blocks.map((b) => b.type);
  assert.equal(blockTypes[0], 'heading');
  assert.equal(blockTypes[1], 'paragraph');
  assert.equal(blockTypes[2], 'divider');
  assert.ok(blockTypes.includes('details'), 'must include Bot API 10.3 native details toggle bullets');
  assert.ok(blockTypes.includes('footer'), 'must include footer');

  const detailsBlocks = card.blocks.filter((b) => b.type === 'details');
  assert.ok(detailsBlocks.length >= 4);
  for (const d of detailsBlocks) {
    assert.ok(Array.isArray(d.blocks));
    assert.ok(d.blocks.some((sub) => sub.type === 'list'), 'each toggle should contain native list bullets');
  }

  const fb = buildShowcaseHtmlFallback({ botName: 'Lancy', botUsername: 'pappy_agent' });
  assert.match(fb, /Lancy/i);
  assert.match(fb, /<blockquote>/i);
});

test('rawEmoji option shields selection & action buttons from custom emoji swaps while keeping premium emojis active everywhere else', () => {
  const b = new RichMessageBuilder();
  b.heading('🎬 Episode Test');
  b.buttons([
    richButton.disabled('☑ Pick', { rawEmoji: true }),
    richButton.disabled('⬇ DL', { rawEmoji: true }),
    richButton.callback('🎬 E1', 'ep_1'),
    richButton.callback('▶', 'play_1', { rawEmoji: true }),
    richButton.callback('⬇', 'dl_1', { style: 'success', rawEmoji: true })
  ]);
  const json = b.toJSON({ useCustomEmojis: true });
  // Heading still gets custom emoji
  assert.ok(Array.isArray(json.blocks[0].text), 'Heading must still convert custom emojis');
  const btns = json.blocks[1].buttons;
  assert.equal(btns[0].text, '☑ Pick');
  assert.equal(btns[1].text, '⬇ DL');
  assert.equal(btns[0]._rawEmoji, undefined, 'internal flag must be stripped cleanly');
  assert.ok(Array.isArray(btns[2].text), '🎬 E1 button must still receive premium custom emoji');
  assert.equal(btns[3].text, '▶', 'Play icon must remain crisp native ▶');
  assert.equal(btns[4].text, '⬇', 'Download icon must remain crisp native ⬇');
});

test('enhanceHtmlWithCustomEmojis upgrades prose/captions using global lookup while skipping HTML tags, code, and existing tg-emoji', () => {
  setGlobalCustomEmojiLookup((emoji) => (emoji === '🦔' ? '999900001111' : null));
  try {
    const html = '<b>Drop 🦔 live!</b> <code>🦔 keep_code</code> <tg-emoji emoji-id="12345">🔥</tg-emoji>';
    const upgraded = enhanceHtmlWithCustomEmojis(html);
    assert.match(upgraded, /<tg-emoji emoji-id="999900001111">🦔<\/tg-emoji>/);
    assert.match(upgraded, /<code>🦔 keep_code<\/code>/);
    assert.match(upgraded, /<tg-emoji emoji-id="12345">🔥<\/tg-emoji>/);
  } finally {
    setGlobalCustomEmojiLookup(null);
  }
});

test('parseBroadcastButtonLines parses URL, copy, and inline share buttons into valid richButton rows', () => {
  const parsed = parseBroadcastButtonLines([
    'Join Channel | https://t.me/lancyupdates ; Share | inline:showcase',
    'Copy Promo | copy:LANCY100'
  ].join('\n'));
  assert.equal(parsed.length, 2);
  const richRows = materializeRichButtonRows(parsed);
  assert.equal(richRows[0].length, 2);
  assert.equal(richRows[0][0].url, 'https://t.me/lancyupdates');
  assert.equal(richRows[0][1].switch_inline_query, 'showcase');
  assert.equal(richRows[1][0].copy_text.text, 'LANCY100');
});

test('deliverBroadcastToTarget sends 10-item Bot API 10.3 slideshow with attached buttons & upgraded caption emojis', async () => {
  const richCalls = [];
  const fakeApi = {
    me: { id: 777 },
    sendRichMessage: async (chatId, payload) => {
      richCalls.push({ chatId, payload });
      return { message_id: 501 };
    },
    sendMessage: async () => ({ message_id: 502 })
  };

  const slides = Array.from({ length: 10 }, (_, idx) => ({
    kind: 'photo',
    fileId: `photo_id_${idx + 1}`,
    caption: idx === 0 ? 'Slide 1 🦔 Showcase' : `Slide ${idx + 1}`
  }));

  setGlobalCustomEmojiLookup((emoji) => (emoji === '🦔' ? '999900002222' : null));
  try {
    const btns = parseBroadcastButtonLines('Open Bot | https://t.me/pappy_agent');
    const res = await deliverBroadcastToTarget({
      targetApi: fakeApi,
      targetBotId: '777',
      chatId: -100555666,
      items: slides,
      slideMode: true,
      buttonRows: btns,
      autoCustomEmoji: true
    });
    assert.equal(res.ok, true);
    assert.equal(richCalls.length, 1);
    const blocks = richCalls[0].payload.blocks || [];
    const slideBlock = blocks.find((b) => b.type === 'slideshow');
    assert.ok(slideBlock, 'must send Bot API 10.3 slideshow block');
    assert.equal(slideBlock.blocks.length, 10);
    assert.ok(blocks.some((b) => b.type === 'buttons' && b.buttons?.length === 1), 'must attach buttons block');
    assert.match(JSON.stringify(slideBlock.blocks[0]), /999900002222/);
  } finally {
    setGlobalCustomEmojiLookup(null);
  }

  // Also test showcase item delivery & summary label
  const showcaseItem = { kind: 'showcase', caption: '✨ A-Z Card' };
  assert.match(summarizeBroadcastItems([showcaseItem]), /Showcase Card/i);
  await deliverBroadcastToTarget({
    targetApi: fakeApi,
    targetBotId: '777',
    chatId: -100555666,
    items: [showcaseItem]
  });
  assert.equal(richCalls.length, 2);
});

test('Broadcast screen 1-click System Broadcast ALL sends across Main + Clone DMs, verified Channels & GCs, and blocks non-owners', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1111];

  const nowSec = Math.floor(Date.now() / 1000);
  db.run('INSERT OR REPLACE INTO users (tg_id, username, first_name) VALUES (5001, ?, ?)', 'usera', 'UserA');
  db.run('INSERT OR REPLACE INTO users (tg_id, username, first_name) VALUES (5002, ?, ?)', 'userb', 'UserB');
  db.run(
    "INSERT INTO cloned_bots (id, owner_tg_id, bot_name, bot_username, token, status) VALUES (1, 1111, 'CloneLancy', 'clone_bot', '200:tok', 'active')"
  );
  db.run(
    'INSERT INTO bot_users (bot_id, tg_id, first_name, is_banned, last_seen) VALUES (1, 6001, ?, 0, ?)',
    'CloneUser', nowSec
  );
  db.recordTelegramChannel({ channel_id: -1001, title: 'Main Channel', username: 'main_ch', chat_type: 'channel', can_post: 1, added_by: 1111 });
  db.recordTelegramChannel({ channel_id: -1002, title: 'Clone GC', chat_type: 'supergroup', can_post: 1, added_by: 1111 });

  const sentRich = [];
  const cbAnswers = [];
  const chats = new Map([
    [-1001, { id: -1001, type: 'channel', title: 'Main Channel', username: 'main_ch' }],
    [-1002, { id: -1002, type: 'supergroup', title: 'Clone GC' }]
  ]);
  const mainApi = {
    me: { id: 100, username: 'main_bot', first_name: 'Lancy' },
    getMe: async () => mainApi.me,
    answerCallbackQuery: async (_id, opts) => { cbAnswers.push(opts); },
    getChat: async (cid) => chats.get(Number(cid)),
    getChatMember: async (cid, uid) => (Number(cid) === -1001 && Number(uid) === 100)
      ? { status: 'administrator', can_post_messages: true }
      : { status: 'left' },
    sendRichMessage: async (cid, payload) => {
      sentRich.push({ bot: 'main', cid, payload });
      return { message_id: 1 };
    },
    sendMessage: async () => ({ message_id: 2 })
  };
  const cloneApi = {
    me: { id: 200, username: 'clone_bot', first_name: 'CloneLancy' },
    getMe: async () => cloneApi.me,
    getChat: async (cid) => chats.get(Number(cid)),
    getChatMember: async (_cid, uid) => Number(uid) === 200
      ? { status: 'administrator', can_post_messages: true, can_send_messages: true }
      : { status: 'left' },
    sendRichMessage: async (cid, payload) => {
      sentRich.push({ bot: 'clone', cid, payload });
      return { message_id: 3 };
    },
    sendMessage: async () => ({ message_id: 4 })
  };

  const fakeApp = {
    config: { telegram: { adminIds: [1111] } },
    db,
    settings,
    telegram: {
      api: mainApi,
      botInfo: { id: 100, username: 'main_bot', first_name: 'Lancy' }
    },
    multiBotManager: new MultiBotManager({ app: { telegram: { api: mainApi } }, db, settings }),
    music: {
      owner: (ctx) => Number(ctx.tgId) === 1111,
      superAdmin: (ctx) => Number(ctx.tgId) === 1111
    }
  };
  fakeApp.multiBotManager.runningBots.set(1, { api: cloneApi, controller: { isOwner: (id) => Number(id) === 1111 } });

  const screen = createBroadcastScreen({ app: fakeApp });

  // Non-owner must be blocked on broadcast_all
  let nonOwnerScreen = null;
  await screen.handle(
    {
      tgId: 9999,
      chatId: 9999,
      api: mainApi,
      query: { id: 'cb_non_owner' },
      user: { tg_id: 9999 },
      editScreen: async (r) => { nonOwnerScreen = r; return {}; },
      replyRich: async (r) => { nonOwnerScreen = r; return {}; }
    },
    'broadcast_all',
    []
  );
  assert.match(JSON.stringify(nonOwnerScreen || cbAnswers), /Platform Owner/i);
  assert.equal(sentRich.length, 0);

  // Owner loads showcase card then triggers broadcast_all
  const ownerCtx = {
    tgId: 1111,
    chatId: 1111,
    api: mainApi,
    query: { id: 'cb_owner' },
    user: { tg_id: 1111 },
    editScreen: async () => ({ message_id: 10 }),
    replyRich: async () => ({ message_id: 10 })
  };
  await screen.handle(ownerCtx, 'load_showcase', []);
  const draft = screen.getDraft(1111);
  assert.equal(draft.items[0]?.kind, 'showcase');

  await screen.handle(ownerCtx, 'broadcast_all', []);

  const hitTargets = sentRich.map((r) => `${r.bot}:${r.cid}`);
  assert.ok(hitTargets.includes('main:5001'), 'must send to main DM user 5001');
  assert.ok(hitTargets.includes('main:5002'), 'must send to main DM user 5002');
  assert.ok(hitTargets.includes('clone:6001'), 'must send to clone DM user 6001');
  assert.ok(hitTargets.includes('main:-1001'), 'must send to verified channel -1001');
  assert.ok(hitTargets.includes('clone:-1002'), 'must send to verified group -1002');
  db.close();
});

test('Player card Live indicator (🔴 LIVE), headings, and controls keep animated premium custom emojis active', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const fakeApp = { db, settings, music: { botKey: () => '0' }, musicQueueManager: { getSession: () => null } };
  const musicScreen = createMusicScreen({ app: fakeApp });

  const session = {
    chatId: -1001234,
    destination: -1001234,
    destinationTitle: 'Movie Club',
    status: 'playing',
    activeDeck: 'movie',
    view: 'cinema',
    volume: 100,
    loopMode: 'off',
    subtitleMode: 'screen',
    pinned: false,
    movieUpcoming: [],
    movieHistory: [],
    upcoming: [],
    currentTrack: {
      provider: 'movie',
      title: 'Dune: Part Two',
      mediaType: 'video',
      capabilities: { seek: true }
    }
  };
  const card = musicScreen.renderCinemaPlayer(session);
  // Title heading keeps animated RestrictedEmoji 🎬 custom emoji
  assert.equal(card.blocks[0].text[0]?.custom_emoji_id, '5375464961822695044');
  // Live indicator subtitle preserves animated NewsEmoji 🔴 custom emoji
  const subRaw = JSON.stringify(card.blocks[1]);
  assert.match(subRaw, /5411225014148014586/, 'Live indicator 🔴 must preserve animated custom_emoji');
  // Download & Pin buttons use animated NewsEmoji custom emojis
  const btns = card.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const dlBtn = btns.find((b) => richTextToString(b.text).includes('Download'));
  const pinBtn = btns.find((b) => richTextToString(b.text) === '📌 Pin');
  assert.equal(dlBtn.text[0]?.custom_emoji_id, '5406745015365943482');
  assert.equal(pinBtn.text[0]?.custom_emoji_id, '5397782960512444700');
  db.close();
});

test('CUSTOM_EMOJI_MAP uses verified animated UI packs and CustomEmojiRegistry ranks animated packs deterministically', () => {
  assert.equal(getCustomEmojiId('⬇'), '5406745015365943482');
  assert.equal(getCustomEmojiId('▶'), '5341270334882463507');
  assert.equal(getCustomEmojiId('➕'), '5226945370684140473');
  assert.equal(getCustomEmojiId('✅'), '5771711424711626153');
  assert.equal(getCustomEmojiId('⚡'), '5431449001532594346');
  assert.equal(getCustomEmojiId('🔴'), '5411225014148014586');
  assert.equal(getCustomEmojiId('📦'), '5463172695132745432');
  assert.equal(CUSTOM_EMOJI_MAP['🎞'], '5409178187353566863');
  assert.equal(CUSTOM_EMOJI_MAP['⏭'], '5197194879549085520');
  assert.equal(CUSTOM_EMOJI_MAP['⚪'], '5409037625958872144');
  assert.equal(CUSTOM_EMOJI_MAP['💾'], '5427158655621443938');
  assert.equal(CUSTOM_EMOJI_MAP['🧹'], '4956591954088428445');

  const db = new Database(':memory:');
  const registry = new CustomEmojiRegistry({ db });
  registry.seedBuiltinCatalog();
  registry.upsertCatalogEntries([
    { customEmojiId: '9990001', unicodeEmoji: '🎞', unicodeKey: '🎞', setName: 'StatusPackNew', isAnimated: true, source: 'pack' },
    { customEmojiId: '9990002', unicodeEmoji: '🎞', unicodeKey: '🎞', setName: 'InterfaceElements', isAnimated: false, source: 'pack' },
    { customEmojiId: '9990003', unicodeEmoji: '🎞', unicodeKey: '🎞', setName: 'RestrictedEmoji', isAnimated: true, source: 'pack' }
  ]);
  db.run('UPDATE custom_emoji_catalog SET usage_count = 999 WHERE custom_emoji_id = ?', '9990002');
  const cands = registry.lookupCandidates('🎞', { limit: 5, excludeDarkUiSets: true, preferAnimated: true });
  assert.equal(cands.length, 3);
  assert.ok(!cands.some((c) => c.customEmojiId === '9990001'));
  assert.equal(cands[0].customEmojiId, '9990003', 'Animated UI set must rank ahead of static set deterministically regardless of usage_count');
  assert.equal(cands[1].customEmojiId, '9990002');
  assert.ok(NOISY_OR_DARK_UI_SET_NAMES.has('StatusPackNew'));
  assert.ok(NOISY_OR_DARK_UI_SET_NAMES.has('Emoji_fan37_by_TgEmodziBot'));
  assert.ok(NOISY_OR_DARK_UI_SET_NAMES.has('BlackEmojiGray'));
  assert.ok(NOISY_OR_DARK_UI_SET_NAMES.has('finnik_donut_day_emoji'));
  db.close();
});

test('JobPlanner prioritizes critical lane, coalesces duplicate keys, defers background under stress, and recovers persistent SQLite jobs', async () => {
  const db = new Database(':memory:');
  const planner = new JobPlanner({ db, maxConcurrency: 1 });
  const order = [];

  // Force elevated stress -> shouldDeferBackground false; high stress -> true
  planner._cachedStress = { pressureLevel: 'high', eventLoopLagMs: 120, cpuLoadRatio: 1.25, rssMb: 900, memPct: 40, activeVcCount: 5, concurrencyLimit: 1, sampledAt: Date.now() };
  planner._cachedStressAt = Date.now() + 60000;
  assert.equal(planner.shouldDeferBackground(), true, 'High stress defers non-critical background jobs');

  // Reset to nominal stress for strict priority + dedupe verification
  planner._cachedStress = { pressureLevel: 'nominal', eventLoopLagMs: 4, cpuLoadRatio: 0.2, rssMb: 300, memPct: 10, activeVcCount: 1, concurrencyLimit: 1, sampledAt: Date.now() };
  planner._cachedStressAt = Date.now() + 60000;

  let runs = 0;
  const pHold = planner.schedule('media', async () => {
    await new Promise((r) => setTimeout(r, 25));
    order.push('hold');
  });
  const pBg = planner.schedule('broadcast', { dedupeKey: 'dup1' }, async () => { runs++; order.push('broadcast'); return 'b'; });
  const pDup = planner.schedule('broadcast', { dedupeKey: 'dup1' }, async () => { runs++; order.push('dup'); return 'b2'; });
  const pCrit = planner.schedule('critical', async () => { order.push('critical'); });

  await Promise.all([pHold, pBg, pDup, pCrit]);
  assert.equal(runs, 1, 'identical dedupeKey must coalesce into one execution');
  assert.ok(order.indexOf('critical') < order.indexOf('broadcast'), 'critical lane runs ahead of broadcast');

  // Persistent SQLite crash recovery + execution
  const staleId = db.run(
    "INSERT INTO jobs (type, payload_json, status, attempts, max_attempts) VALUES ('test_task', '{\"n\":42}', 'running', 1, 3)"
  ).lastInsertRowid;
  assert.equal(planner.recoverStaleJobs(), 1, 'stale running SQLite jobs recover cleanly on boot');
  planner.registerHandler('test_task', async (payload) => ({ doubled: payload.n * 2 }));
  const doneCount = await planner.processPersistentDue();
  assert.equal(doneCount, 1);
  const row = db.get('SELECT * FROM jobs WHERE id = ?', staleId);
  assert.equal(row.status, 'done');
  assert.match(row.result_json, /84/);

  await planner.shutdown();
  db.close();
});

test('MovieDownloader rejects silent video-only mirrors, avoids wrong dubs, muxes separate audioUrl, and normalizes AC3 to AAC fast', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'lancy-mdl-smart-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const silentPayload = Buffer.alloc(4096, 0x11);
  const dubAc3Payload = Buffer.alloc(4096, 0x22);
  const cleanAacPayload = Buffer.alloc(4096, 0x33);
  const ffmpegCalls = [];
  const fetchedUrls = [];

  const mockRunner = async (cmd, args = []) => {
    if (cmd === 'ffprobe') {
      const target = String(args[args.length - 1] || '');
      if (target.endsWith('.mp4')) {
        // Discriminate by content/call order via file first byte
        const { readFileSync } = await import('node:fs');
        const firstByte = readFileSync(target)[0];
        if (firstByte === 0x11) {
          return { stdout: JSON.stringify({ format: { duration: '1800' }, streams: [{ codec_type: 'video', codec_name: 'h264', height: 720 }] }) };
        }
        if (firstByte === 0x22) {
          return {
            stdout: JSON.stringify({
              format: { duration: '1800' },
              streams: [
                { codec_type: 'video', codec_name: 'h264', height: 720 },
                { codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'rus', title: 'Russian Dub' }, disposition: { dub: 1 } },
                { codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'eng', title: 'Original English' }, disposition: { original: 1 } }
              ]
            })
          };
        }
        return {
          stdout: JSON.stringify({
            format: { duration: '1800' },
            streams: [
              { codec_type: 'video', codec_name: 'h264', height: 720 },
              { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } }
            ]
          })
        };
      }
    }
    if (cmd === 'ffmpeg') {
      ffmpegCalls.push(args);
      const out = args[args.length - 1];
      writeFileSync(out, cleanAacPayload);
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const mockFetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    const bytes = u.includes('silent') ? silentPayload : (u.includes('multidub') ? dubAc3Payload : cleanAacPayload);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        }
      })
    };
  };

  const dl = new MovieDownloader({
    app: {},
    cacheDir: workDir,
    fetchImpl: mockFetch,
    runner: mockRunner
  });

  // 1. Silent primary fails over cleanly to working fallback mirror with audio
  const r1 = await dl.prepareVideoFile({
    id: 'silent-1',
    title: 'Silent Test',
    originalLanguage: 'en',
    streamUrl: 'https://cdn.example/silent_video_only.mp4',
    audioLanguage: 'en',
    format: 'mp4',
    fallbackStreams: [{ url: 'https://cdn.example/good_audio.mp4', format: 'mp4', audioLanguage: 'en' }]
  }, { quality: '720p', skipCache: true });
  assert.equal(r1.ok, true, r1.reason);
  assert.ok(fetchedUrls.includes('https://cdn.example/silent_video_only.mp4'));
  assert.ok(fetchedUrls.includes('https://cdn.example/good_audio.mp4'));
  r1.cleanup();

  // 2. Dubbed primary is deprioritized behind non-dub fallback OR multi-audio AC3 re-selects ENG + fast AAC remux
  const sorted = sortDownloadCandidates([
    { url: 'https://cdn.example/dub.mp4', audioLanguage: 'ru', audioIsDub: true },
    { url: 'https://cdn.example/orig.mp4', audioLanguage: 'en', audioIsDub: false }
  ], 'en');
  assert.equal(sorted[0].url, 'https://cdn.example/orig.mp4');

  const r2 = await dl.prepareVideoFile({
    id: 'multi-1',
    title: 'Multi Audio AC3',
    originalLanguage: 'en',
    streamUrl: 'https://cdn.example/multidub.mp4',
    format: 'mp4'
  }, { quality: '720p', skipCache: true });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.audioLanguage, 'en');
  assert.equal(r2.audioIsDub, false);
  const fastRemux = ffmpegCalls.find((a) => a.includes('0:a:1') && a.includes('-c:v') && a.includes('copy') && a.includes('aac'));
  assert.ok(fastRemux, 'Must select 0:a:1 (Original EN) and fast stream-copy video while transcoding AC3 -> AAC');
  r2.cleanup();

  // 3. Separate audioUrl muxing uses both inputs & maps 0:v:0 + 1:a:0
  const r3 = await dl.prepareVideoFile({
    id: 'dash-sep-1',
    title: 'Separate DASH Audio',
    originalLanguage: 'en',
    streamUrl: 'https://cdn.example/video_only.mp4',
    audioUrl: 'https://cdn.example/audio_en.m4a',
    format: 'mp4'
  }, { quality: '720p', skipCache: true });
  assert.equal(r3.ok, true, r3.reason);
  const muxCall = ffmpegCalls.find((a) => a.includes('https://cdn.example/audio_en.m4a') && a.includes('1:a:0'));
  assert.ok(muxCall, 'Must pass separate audioUrl input and map 1:a:0');
  r3.cleanup();

  // 4. Subtitle sanity check rejects trailer/mismatched/foreign subs and converts valid VTT -> clean SRT
  const badTrailerSub = join(workDir, 'trailer.srt');
  writeFileSync(badTrailerSub, Array.from({ length: 14 }, (_, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, '0')},000 --> 00:00:${String(i * 3 + 2).padStart(2, '0')},000\nLine ${i + 1}`).join('\n\n'));
  const vBad = validateAndPrepareSrt(badTrailerSub, workDir, { durationSeconds: 5400, expectEnglish: true });
  assert.equal(vBad.ok, false);
  assert.equal(vBad.reason, 'trailer_or_truncated_subs');

  const foreignSub = join(workDir, 'ru.srt');
  writeFileSync(foreignSub, Array.from({ length: 15 }, (_, i) => `${i + 1}\n00:0${Math.floor(i / 2)}:${String((i % 2) * 30).padStart(2, '0')},000 --> 00:0${Math.floor(i / 2)}:${String((i % 2) * 30 + 10).padStart(2, '0')},000\nПривет мир проверка субтитров ${i + 1}`).join('\n\n'));
  const vForeign = validateAndPrepareSrt(foreignSub, workDir, { durationSeconds: 600, expectEnglish: true });
  assert.equal(vForeign.ok, false);
  assert.equal(vForeign.reason, 'non_english_sub_track');

  const goodVtt = join(workDir, 'good.vtt');
  writeFileSync(goodVtt, 'WEBVTT\n\n' + Array.from({ length: 15 }, (_, i) => `00:0${Math.floor(i / 2)}:${String((i % 2) * 30).padStart(2, '0')}.000 --> 00:0${Math.floor(i / 2)}:${String((i % 2) * 30 + 5).padStart(2, '0')}.000\nHello dialogue line ${i + 1}`).join('\n\n'));
  const vGood = validateAndPrepareSrt(goodVtt, workDir, { durationSeconds: 600, expectEnglish: true });
  assert.equal(vGood.ok, true);
  assert.ok(vGood.srtPath.endsWith('.srt'));

  // 5. No spammy resolver tier chatter in download progress
  assert.equal(sanitizeDownloadProgress('🔎 [2/5] Searching HD feature stream index…'), '🔎 Finding best HD mirror with audio…');
  assert.equal(sanitizeDownloadProgress('💬 [Subs] Matching & syncing subtitles…'), '💬 Checking subtitles…');
});

test('renderTvSeason places tiny interleaved footer labels above each button group with zero disabled header buttons', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const fakeApp = {
    db,
    settings,
    music: { botKey: () => '0' },
    movieSessions: { totalSelectedCount: () => 2 }
  };
  const screen = createMusicScreen({ app: fakeApp });
  const ctx = { chatId: -100555, tgId: '42', api: {} };
  const ms = {
    id: 'tv1',
    mediaItem: { id: '55', title: 'Empress', type: 'tv' },
    seasonNumber: 1,
    seasons: [{ seasonNumber: 1, episodeCount: 6 }, { seasonNumber: 2, episodeCount: 6 }],
    episodes: [
      { episodeNumber: 1, title: 'Pilot', runtimeMinutes: 45 },
      { episodeNumber: 2, title: 'Crown', runtimeMinutes: 46 }
    ],
    selectedBySeason: new Map([[1, new Set([1, 2])]]),
    epPage: 0,
    view: 'season'
  };
  const rich = screen.movieUi.renderTvSeason(ctx, ms);
  const footerIndices = rich.blocks
    .map((b, idx) => (b.type === 'footer' ? { idx, text: richTextToString(b.text) } : null))
    .filter(Boolean);
  assert.equal(footerIndices.length, 4, 'Expected 4 interleaved footer section labels');
  assert.match(footerIndices[0].text, /Episode \(E1, E2\)/);
  assert.match(footerIndices[1].text, /Season \(S1, S2\)/);
  assert.match(footerIndices[2].text, /Select All \/ Block Select/);
  assert.match(footerIndices[3].text, /^Download/);
  // Each interleaved footer sits directly before a buttons block
  for (const f of footerIndices) {
    assert.equal(rich.blocks[f.idx + 1]?.type, 'buttons', `Expected buttons directly after footer: ${f.text}`);
  }
  const disabledBtns = rich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons).filter((btn) => btn.disabled);
  assert.equal(disabledBtns.length, 0, 'Must not add dummy disabled header buttons');
  db.close();
});

test('didEditStripCustomEmojis detects stripped custom emojis while ignoring minimal mocks', () => {
  const origRich = {
    blocks: [
      {
        type: 'paragraph',
        text: [{ type: 'custom_emoji', custom_emoji_id: '5372981976804366741', text: '🔴' }, ' LIVE']
      }
    ]
  };
  // Minimal test mock without inspectable payload must return false
  assert.equal(didEditStripCustomEmojis(origRich, { message_id: 8 }), false);
  // Preserved custom_emoji node in returned rich_message must return false
  assert.equal(
    didEditStripCustomEmojis(origRich, {
      message_id: 8,
      rich_message: {
        blocks: [{ type: 'paragraph', text: [{ type: 'custom_emoji', custom_emoji_id: '5372981976804366741', text: '🔴' }, ' LIVE'] }]
      }
    }),
    false
  );
  // Downgraded plain text returned by Telegram Bot API editMessageText bug must return true
  assert.equal(
    didEditStripCustomEmojis(origRich, {
      message_id: 8,
      rich_message: {
        blocks: [{ type: 'paragraph', text: '🔴 LIVE' }]
      }
    }),
    true
  );
});

test('MusicService.player reply-anchors group Player Cards to trigger message', async (t) => {
  const sendCalls = [];
  const voice = {
    play: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };
  const app = { db: null };
  const qm = new QueueManager({ app, voiceClient: voice, pollMs: 0, idleTimeoutMs: 60000 });
  t.after(() => qm.shutdown());
  app.musicQueueManager = qm;
  const api = {
    me: { id: 99, username: 'lancy_test_bot' },
    getChat: async () => ({ id: -100999, type: 'supergroup', title: 'Test Group' }),
    sendRichMessage: async (chatId, rich, extra) => {
      sendCalls.push({ chatId, rich, extra });
      return { message_id: 101 };
    }
  };
  const service = new MusicService({ app, accounts: {} });
  app.music = service;
  app.screens = new Map([['music', createMusicScreen({ app })]]);
  service.authorize = async () => -100999;

  const ctx = {
    tgId: 10,
    chatId: -100999,
    message: { message_id: 777, chat: { id: -100999, type: 'supergroup' } },
    api
  };
  await service.player(ctx, -100999);

  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0].extra?.reply_parameters, {
    message_id: 777,
    allow_sending_without_reply: true
  });
  assert.equal(qm.getSession(-100999).replyAnchorMessageId, 777);
});

test('QueueManager.updatePlayerView self-heals standalone custom-emoji strips and freezes cosmetic ticks if server still strips', async (t) => {
  let nextMsgId = 11;
  const edits = [];
  const sends = [];
  const deletes = [];
  const pins = [];
  const api = {
    me: { id: 99, username: 'lancy_test_bot' },
    editMessageRich: async (chatId, msgId, rich, extra) => {
      edits.push({ chatId, msgId, rich, extra });
      return {
        message_id: msgId,
        rich_message: { blocks: [{ type: 'paragraph', text: 'plain downgraded text' }] }
      };
    },
    sendRichMessage: async (chatId, rich, extra) => {
      const message_id = nextMsgId++;
      sends.push({ message_id, chatId, rich, extra });
      return { message_id };
    },
    deleteMessage: async (chatId, msgId) => {
      deletes.push({ chatId, msgId });
      return true;
    },
    pinChatMessage: async (chatId, msgId, extra) => {
      pins.push({ chatId, msgId, extra });
      return true;
    }
  };
  const voice = {
    play: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true }),
    idle: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };
  const app = { db: null };
  const qm = new QueueManager({ app, voiceClient: voice, pollMs: 0, idleTimeoutMs: 60000 });
  t.after(() => qm.shutdown());
  app.musicQueueManager = qm;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);

  const s = qm.getSession(-100888);
  s.api = api;
  s.playerChatId = -100888;
  s.destinationTitle = 'Group VC';
  s.screenMessageId = 10;
  s.pinned = true;
  s.pinnedMessageId = 10;
  s.status = 'playing';
  s.view = 'player';
  s.currentTrack = normalizeTrack({ providerId: 't1', title: 'Fixture Track', artist: 'Artist', durationSeconds: 200 }, 'fixture');
  s.positionSeconds = 10;
  s._customEmojiReanchoredMsgId = null;

  assert.equal(hasRichCustomEmoji(screen.renderPlayer(s)), true);

  // 1) Indicator move when edit response strips custom_emoji -> stays in-place (zero delete/resend spam) and suppresses future cosmetic ticks
  s.positionSeconds = 30;
  await qm.updatePlayerView(s);
  assert.equal(edits.length, 1);
  assert.equal(sends.length, 0);
  assert.equal(deletes.length, 0);
  assert.equal(s.screenMessageId, 10);
  assert.equal(s._editStripsCustomEmoji, true);

  // 2) Subsequent cosmetic indicator move -> skipped completely (zero edits, zero message spam)
  s.positionSeconds = 75;
  await qm.updatePlayerView(s);
  assert.equal(edits.length, 1);
  assert.equal(sends.length, 0);

  // 3) Real state change (paused + forceEdit) -> edits the existing card in-place without spamming a new message
  s.status = 'paused';
  await qm.updatePlayerView(s, { forceEdit: true });
  assert.equal(edits.length, 2);
  assert.equal(sends.length, 0);
  assert.equal(deletes.length, 0);
  assert.equal(s.screenMessageId, 10);
});

test('TelegramApi sendMessage, editMessageText, sendPhoto, and setMessageReaction automatically apply custom emojis', async () => {
  for (const sym of ['💾', '🧹', '🎞', '⚪', '🟠', '🟡', '◀', '⏹', '🔁', '⏭', '📜', '🔀', '⏮', '⏪', '🪨']) {
    assert.ok(getCustomEmojiId(sym), `Expected custom emoji ID for ${sym}`);
  }

  const plain = 'Hi 🎀 and 🧹!';
  const { entities } = extractCustomEmojiEntities(plain);
  assert.equal(entities.length, 2);
  assert.equal(plain.slice(entities[0].offset, entities[0].offset + entities[0].length), '🎀');
  assert.equal(plain.slice(entities[1].offset, entities[1].offset + entities[1].length), '🧹');

  const calls = [];
  const api = new TelegramAPI({ token: '0:test' });
  api.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'setMessageReaction' && Array.isArray(params.reaction) && params.reaction.some((r) => r.type === 'custom_emoji') && params.message_id === 99) {
      const err = new Error('REACTION_INVALID');
      err.description = 'Bad Request: REACTION_INVALID';
      throw err;
    }
    return { message_id: params.message_id || 1 };
  };

  await api.sendMessage(-1001, '<b>Done ✅</b>', { parse_mode: 'HTML' });
  assert.match(calls[0].params.text, /<tg-emoji emoji-id="5771711424711626153">✅<\/tg-emoji>/);

  await api.editMessageText(-1001, 5, 'Plain update ⚪ 🎞');
  assert.equal(calls[1].params.entities.length, 2);
  assert.equal(calls[1].params.entities[0].custom_emoji_id, CUSTOM_EMOJI_MAP['⚪']);
  assert.equal(calls[1].params.entities[1].custom_emoji_id, CUSTOM_EMOJI_MAP['🎞']);

  await api.sendPhoto(-1001, 'photo_id', { caption: 'Save 💾', parse_mode: 'HTML' });
  assert.match(calls[2].params.caption, /<tg-emoji emoji-id="5427158655621443938">💾<\/tg-emoji>/);

  await api.setMessageReaction(-1001, 12, '🔥');
  assert.deepEqual(calls[3].params.reaction, [{ type: 'custom_emoji', custom_emoji_id: CUSTOM_EMOJI_MAP['🔥'] }]);

  // Standard fallback when Telegram rejects custom_emoji reaction
  await api.setMessageReaction(-1001, 99, '❤️');
  assert.equal(calls[4].params.reaction[0].type, 'custom_emoji');
  assert.deepEqual(calls[5].params.reaction, [{ type: 'emoji', emoji: '❤️' }]);
});

test('Experiential primary (gpt-6.2-astra:free) and backup (gemini-4-neon:free) routing, model guards, and worker failover', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  const settings = new SettingsManager(db, {
    env: { EXPLABS_API_KEY: 'xpl_test_key' }
  });
  assert.equal(settings.get('ai.provider'), 'openai-compatible');
  assert.equal(settings.get('ai.endpoint'), 'https://api.experientiallabs.ai/v1');
  assert.equal(settings.get('ai.model'), 'gpt-6.2-astra:free');
  assert.equal(settings.get('ai.apiKey'), 'xpl_test_key');
  assert.equal(settings.get('ai.backupProvider'), 'openai-compatible');
  assert.equal(settings.get('ai.backupEndpoint'), 'https://api.experientiallabs.ai/v1');
  assert.equal(settings.get('ai.backupModel'), 'gemini-4-neon:free');

  const seenBodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seenBodies.push(body);
    return new Response(JSON.stringify({
      model: body.model,
      choices: [{ message: { role: 'assistant', content: `ok from ${body.model}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const astra = new OpenAICompatibleProvider({ endpoint: 'https://api.experientiallabs.ai/v1', model: 'gpt-6.2-astra:free', apiKey: 'xpl_test_key' });
    const astraRes = await astra.generate({ text: 'hello', maxTokens: 90, returnObject: true });
    assert.equal(astraRes.text, 'ok from gpt-6.2-astra:free');
    assert.equal('temperature' in seenBodies[0], false, 'Astra should omit unsupported temperature parameter');

    const neon = new OpenAICompatibleProvider({ endpoint: 'https://api.experientiallabs.ai/v1', model: 'gemini-4-neon:free', apiKey: 'xpl_test_key' });
    const neonRes = await neon.generate({ text: 'hello', maxTokens: 90, returnObject: true });
    assert.equal(neonRes.text, 'ok from gemini-4-neon:free');
    assert.equal(seenBodies[1].max_tokens, 400, 'Gemini 4 Neon should receive >= 400 max_tokens headroom for reasoning');
  } finally {
    globalThis.fetch = origFetch;
  }

  // Real AI worker primary -> backup failover test via ephemeral localhost HTTP server
  const serverCalls = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      serverCalls.push({ auth: req.headers.authorization, model: body.model, maxTokens: body.max_tokens });
      res.setHeader('content-type', 'application/json');
      if (body.model === 'gpt-6.2-astra:free') {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: 'primary temporarily busy' } }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'Backup Gemini responded cleanly' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;

  const failoverSettings = new SettingsManager(db, {
    env: {
      EXPLABS_API_KEY: 'xpl_failover_key',
      AI_PROVIDER: 'openai-compatible',
      AI_ENDPOINT: `http://127.0.0.1:${port}`,
      AI_MODEL: 'gpt-6.2-astra:free',
      AI_BACKUP_PROVIDER: 'openai-compatible',
      AI_BACKUP_ENDPOINT: `http://127.0.0.1:${port}`,
      AI_BACKUP_MODEL: 'gemini-4-neon:free',
      AI_BACKUP_API_KEY: 'xpl_failover_key'
    }
  });
  const aiService = new AIService({ settings: failoverSettings });
  t.after(() => aiService.stop());
  const out = await aiService.generate({ text: 'test failover', maxTokens: 90, returnObject: true });
  assert.equal(out.provider, 'openai-compatible');
  assert.equal(out.text, 'Backup Gemini responded cleanly');
  assert.deepEqual(serverCalls.map((c) => c.model), ['gpt-6.2-astra:free', 'gemini-4-neon:free']);
  assert.equal(serverCalls[1].maxTokens, 400);
});
