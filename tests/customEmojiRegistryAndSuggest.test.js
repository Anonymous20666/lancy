import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import {
  CustomEmojiRegistry,
  normalizeEmojiKey,
  extractUnicodeEmojis,
  isPureStandardEmojiOnly,
  extractCustomEmojiInputsFromMessage,
  resolveEmojiMetadataChunked,
  chunkFormattedLines
} from '../src/stickers/customEmojiRegistry.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { CustomEmojiPackService } from '../src/stickers/customEmojiPackService.js';
import { createCustomEmojiStudioScreen } from '../src/telegram/screens/customEmojiStudio.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { TelegramController } from '../src/telegram/bot.js';
import { richButton, decodeCallback } from '../src/telegram/rich.js';

function createFakeStickerService() {
  return {
    botUsername: 'test_lancy_bot',
    buildShortName: (q, uid, tag) => `${tag}_${uid}_by_test_lancy_bot`,
    getStickerSet: async (name) => ({ name, title: name, sticker_type: 'custom_emoji', stickers: [] }),
    createNewStickerSet: async () => true,
    addStickerToSet: async () => true,
    deleteStickerFromSet: async () => true,
    deleteStickerSet: async () => true,
    setStickerSetTitle: async () => true
  };
}

test('Unicode grapheme parser preserves ZWJ sequences and excludes custom_emoji entity ranges', () => {
  assert.equal(normalizeEmojiKey('❤️'), normalizeEmojiKey('❤'));

  const text = '🤨\n❤️‍🩹\n😡\n🔥';
  // Mark 🔥 (last 2 UTF-16 units) as an existing custom_emoji entity
  const fireOffset = text.indexOf('🔥');
  const extracted = extractUnicodeEmojis(text, [{ offset: fireOffset, length: 2 }]);
  assert.deepEqual(
    extracted.map((e) => e.emoji),
    ['🤨', '❤️‍🩹', '😡']
  );

  // Deduplication keeps first seen order
  const deduped = extractUnicodeEmojis('❤️ ❤️‍🩹 ❤ 😡 ❤️‍🩹');
  assert.deepEqual(deduped.map((e) => e.emoji), ['❤️', '❤️‍🩹', '😡']);
});

test('isPureStandardEmojiOnly rejects normal sentences, commands, and custom_emoji messages', () => {
  assert.equal(isPureStandardEmojiOnly('🤨\n❤️‍🩹\n😡'), true);
  assert.equal(isPureStandardEmojiOnly('  🔥   🥰  '), true);
  assert.equal(isPureStandardEmojiOnly('hello 🔥'), false);
  assert.equal(isPureStandardEmojiOnly('/emojisuggest 🔥'), false);
  assert.equal(isPureStandardEmojiOnly('123 🔥'), false);
  assert.equal(isPureStandardEmojiOnly('🔥', [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '51234' }]), false);
});

test('extractCustomEmojiInputsFromMessage & resolveEmojiMetadataChunked handle entities, stickers, pack links & >200 IDs', async () => {
  const { customEmojis, packLinks } = extractCustomEmojiInputsFromMessage({
    text: 'Check ✨ and 🔥 from https://t.me/addemoji/cute_pack_by_bot',
    entities: [
      { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '530001' },
      { type: 'custom_emoji', offset: 13, length: 2, custom_emoji_id: '530002' }
    ],
    caption: 'More at t.me/addstickers/cat_pack',
    sticker: {
      file_id: 'stk_ce_1',
      emoji: '🦋',
      set_name: 'butterfly_pack',
      custom_emoji_id: '530003',
      type: 'custom_emoji'
    }
  });

  assert.equal(customEmojis.length, 3);
  assert.deepEqual(customEmojis.map((c) => c.customEmojiId), ['530001', '530002', '530003']);
  assert.deepEqual(packLinks, ['cute_pack_by_bot', 'cat_pack']);

  const batchSizes = [];
  const fakeApi = {
    getCustomEmojiStickers: async (ids) => {
      batchSizes.push(ids.length);
      return ids.map((id) => ({ custom_emoji_id: id, file_id: `file_${id}`, emoji: '✨' }));
    }
  };
  const manyIds = Array.from({ length: 250 }, (_, i) => `900${i}`);
  const resolved = await resolveEmojiMetadataChunked(fakeApi, manyIds);
  assert.deepEqual(batchSizes, [200, 50]);
  assert.equal(resolved.size, 250);
  assert.equal(resolved.get('900249')?.file_id, 'file_900249');
});

test('CustomEmojiRegistry seeds builtins, ranks extracted IDs above builtins, and chunks long suggestion lists', () => {
  const db = new Database(':memory:');
  const registry = new CustomEmojiRegistry({ db });
  const seeded = registry.seedBuiltinCatalog();
  assert.ok(seeded > 0);

  registry.upsertCatalogEntries([
    { customEmojiId: '777001', unicodeEmoji: '🤨', setName: 'pack_a', source: 'extracted' },
    { customEmojiId: '777002', unicodeEmoji: '🤨', setName: 'pack_b', source: 'extracted' },
    { customEmojiId: '777003', unicodeEmoji: '❤️‍🩹', setName: 'pack_b', source: 'user' }
  ]);

  const eyebrows = registry.lookupCandidates('🤨');
  assert.ok(eyebrows.length >= 2);
  assert.equal(eyebrows[0].source, 'extracted');

  const mending = registry.lookupCandidates('❤️‍🩹');
  assert.equal(mending[0].customEmojiId, '777003');

  const lines = Array.from({ length: 120 }, (_, i) => ({
    text: `🤨 — <tg-emoji emoji-id="777${i}">🤨</tg-emoji>`,
    entities: 1
  }));
  const chunks = chunkFormattedLines(lines, { maxEntities: 80, maxChars: 6500 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 80);
  assert.equal(chunks[1].length, 40);
  const compactChunks = chunkFormattedLines(lines, { maxEntities: 80, maxChars: 3500 });
  assert.ok(compactChunks.length >= 2 && compactChunks.every((c) => c.length <= 80));
  db.close();
});

test('CustomEmojiStudio ID extraction, Suggestion + Remix (including no-new-variant resend), and Get IDs flow', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });
  const registry = new CustomEmojiRegistry({ db });
  registry.seedBuiltinCatalog();

  // Seed 2 variants for 🤨, 1 variant for 😡
  registry.upsertCatalogEntries([
    { customEmojiId: '880001', unicodeEmoji: '🤨', setName: 'v1_pack', source: 'extracted' },
    { customEmojiId: '880002', unicodeEmoji: '🤨', setName: 'v2_pack', source: 'extracted' },
    { customEmojiId: '880099', unicodeEmoji: '😡', setName: 'angry_only', source: 'extracted' }
  ]);

  const sentMessages = [];
  const editedMessages = [];
  const answeredCallbacks = [];

  const fakeApi = {
    botUsername: 'test_lancy_bot',
    getCustomEmojiStickers: async (ids) =>
      ids.map((id) => ({
        custom_emoji_id: id,
        file_id: `dl_${id}`,
        emoji: id === '991122' ? '🥺' : '✨',
        set_name: 'harvest_pack',
        is_video: id === '991122',
        is_animated: false
      })),
    getStickerSet: async (name) => ({
      name,
      title: 'Harvest Pack',
      sticker_type: 'custom_emoji',
      stickers: [
        { file_id: 'stk_h1', emoji: '🦋', custom_emoji_id: '991133', is_video: true }
      ]
    }),
    sendMessage: async (chatId, text, opts = {}) => {
      const msg = { message_id: 500 + sentMessages.length, chatId, text, opts };
      sentMessages.push(msg);
      return msg;
    },
    editMessageText: async (chatId, messageId, text, opts = {}) => {
      const ed = { chatId, messageId, text, opts };
      editedMessages.push(ed);
      return { message_id: messageId };
    },
    sendRichMessage: async (chatId, rich) => {
      const msg = { message_id: 700 + sentMessages.length, chatId, rich };
      sentMessages.push(msg);
      return msg;
    },
    answerCallbackQuery: async (qid, opts = {}) => {
      answeredCallbacks.push({ qid, ...opts });
      return true;
    },
    sendChatAction: async () => true
  };

  const packs = new StickerPackService({
    db,
    settings,
    stickerService: createFakeStickerService(),
    customEmojiRegistry: registry
  });
  const ceService = new CustomEmojiPackService({
    api: fakeApi,
    db,
    settings,
    stickerService: createFakeStickerService(),
    packService: packs,
    customEmojiRegistry: registry
  });
  const app = {
    db,
    settings,
    sm,
    packs,
    customEmojiPacks: ceService,
    customEmojiRegistry: registry,
    telegram: { api: fakeApi },
    screens: new Map()
  };

  const studio = createCustomEmojiStudioScreen({ app });
  app.screens.set(studio.id, studio);
  studio.registerStateHandlers(sm);

  // 1. /emojiid with inline custom emoji + pack link -> indexes both into system catalog & shows IDs in one message
  const ctx = { tgId: 1001, chatId: 1001, api: fakeApi, sm, screens: app.screens };
  await studio.handleCommand(ctx, [], {
    idMode: true,
    replyMessage: {
      text: 'Look 🥺 t.me/addemoji/harvest_pack',
      entities: [{ type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: '991122' }]
    }
  });

  const idCard = sentMessages.find((m) => typeof m.text === 'string' && m.text.includes('CUSTOM EMOJI IDs'));
  assert.ok(idCard);
  assert.ok(idCard.text.includes('991122'));
  assert.ok(idCard.text.includes('991133'));
  assert.ok(registry.lookupCandidates('🥺').some((c) => c.customEmojiId === '991122'));
  assert.ok(registry.lookupCandidates('🦋').some((c) => c.customEmojiId === '991133'));

  // 2. Suggest for 🤨 (2 variants) -> Remix edits card cleanly to 2nd variant!
  sentMessages.length = 0;
  await studio.handleCommand(ctx, ['🤨'], { suggestMode: true });
  const sugMsg1 = sentMessages.find((m) => m.text?.includes('CUSTOM EMOJI SUGGESTIONS'));
  assert.ok(sugMsg1);
  const firstIdMatch = sugMsg1.text.match(/emoji-id="(\d+)"/);
  assert.ok(firstIdMatch);
  const rmxBtn = sugMsg1.opts.reply_markup.inline_keyboard[0][0];
  const rmxParsed = decodeCallback(rmxBtn.callback_data);
  assert.equal(rmxParsed.action, 'sug_rmx');

  await studio.handle(
    { ...ctx, messageId: sugMsg1.message_id, query: { id: 'q1' } },
    'sug_rmx',
    rmxParsed.args
  );
  assert.equal(editedMessages.length, 1);
  const secondIdMatch = editedMessages[0].text.match(/emoji-id="(\d+)"/);
  assert.notEqual(secondIdMatch[1], firstIdMatch[1], 'Remix must cycle to another indexed variant');

  // 3. Get IDs button on suggestion
  const idBtn = sugMsg1.opts.reply_markup.inline_keyboard[0][1];
  const idParsed = decodeCallback(idBtn.callback_data);
  assert.equal(idParsed.action, 'sug_id');
  await studio.handle({ ...ctx, query: { id: 'q2' } }, 'sug_id', idParsed.args);
  const devIdsMsg = sentMessages.find((m) => m.text?.includes('SUGGESTION EMOJI IDs'));
  assert.ok(devIdsMsg);
  assert.ok(devIdsMsg.text.includes(secondIdMatch[1]));

  // 4. Single-variant emoji 😡 -> Remix must NOT fail with edit unchanged; it resends old custom emoji + tells user no new variant found!
  const prevSentCount = sentMessages.length;
  await studio.handleCommand(ctx, ['😡'], { suggestMode: true });
  const angryMsg = sentMessages[sentMessages.length - 1];
  const angryRmx = decodeCallback(angryMsg.opts.reply_markup.inline_keyboard[0][0].callback_data);
  await studio.handle(
    { ...ctx, messageId: angryMsg.message_id, query: { id: 'q3' } },
    'sug_rmx',
    angryRmx.args
  );
  assert.ok(sentMessages.length > prevSentCount + 1);
  const resendMsg = sentMessages[sentMessages.length - 1];
  assert.ok(resendMsg.text.toLowerCase().includes('no new custom emoji variant found'));
  assert.ok(resendMsg.text.includes('880099'));

  db.close();
});

test('GC Dashboard includes Emoji Studio & Bot routes /emojiid, /emojisuggest, and pure-emoji DM auto-suggest', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine({ db });
  const registry = new CustomEmojiRegistry({ db });
  registry.seedBuiltinCatalog();
  registry.upsertCatalogEntries([{ customEmojiId: '551100', unicodeEmoji: '🤨', source: 'extracted' }]);

  const calls = [];
  const fakeApi = {
    getMe: async () => ({ id: 90, username: 'Lancy_easy_bot' }),
    call: async (method, payload) => { calls.push({ method, payload }); return true; },
    sendMessage: async (chatId, text, opts = {}) => { calls.push({ method: 'sendMessage', chatId, text, opts }); return { message_id: 300 }; },
    sendRichMessage: async (chatId, rich) => { calls.push({ method: 'sendRichMessage', chatId, rich }); return { message_id: 301 }; },
    editMessageText: async () => ({ message_id: 301 }),
    sendChatAction: async () => true
  };

  let aiCalled = false;
  const app = {
    db,
    settings,
    sm,
    customEmojiRegistry: registry,
    assistant: { handleMessage: async () => { aiCalled = true; } },
    packs: new StickerPackService({ db, settings, stickerService: createFakeStickerService(), customEmojiRegistry: registry }),
    telegram: { api: fakeApi },
    screens: new Map()
  };
  app.customEmojiPacks = new CustomEmojiPackService({
    api: fakeApi,
    db,
    settings,
    stickerService: createFakeStickerService(),
    packService: app.packs,
    customEmojiRegistry: registry
  });

  const dashboard = createDashboardScreen({ app });
  const studio = createCustomEmojiStudioScreen({ app });
  app.screens.set(dashboard.id, dashboard);
  app.screens.set(studio.id, studio);
  studio.registerStateHandlers(sm);

  // GC /menu includes Custom Emojis, TG Stickers, Get Emoji ID, Emoji Suggest
  const gcOut = await dashboard.open({
    tgId: 1001,
    chatId: -100777,
    isGroup: true,
    db,
    settings,
    api: fakeApi,
    sm,
    screens: app.screens,
    editScreen: (r) => r
  });
  const gcSerialized = JSON.stringify(gcOut);
  assert.ok(gcSerialized.includes('Custom Emojis'));
  assert.ok(gcSerialized.includes('TG Stickers'));
  assert.ok(gcSerialized.includes('Get Emoji ID'));
  assert.ok(gcSerialized.includes('Emoji Suggest'));

  // Bot controller routing: pure emoji DM triggers studio suggestions instead of AI
  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app,
    screens: app.screens,
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  await controller.registerCommands();
  const groupReg = calls.find((c) => c.method === 'setMyCommands' && c.payload?.scope?.type === 'all_group_chats');
  assert.ok(groupReg);
  const gcCmdNames = groupReg.payload.commands.map((c) => c.command);
  for (const needed of ['stickers', 'emojipack', 'emoji2media', 'emojiid', 'emojisuggest', 'postchannel']) {
    assert.ok(gcCmdNames.includes(needed), `GC command list missing /${needed}`);
  }

  aiCalled = false;
  await controller.handleUpdate({
    update_id: 10,
    message: {
      message_id: 11,
      from: { id: 1001, first_name: 'Ana' },
      chat: { id: 1001, type: 'private' },
      text: '🤨'
    }
  });
  assert.equal(aiCalled, false, 'Pure standard emoji in idle DM should route to Emoji Suggester, not AI chat');
  const autoSug = calls.find((c) => c.method === 'sendMessage' && c.text?.includes('551100'));
  assert.ok(autoSug, 'Pure standard emoji DM should emit custom emoji suggestion with ID 551100');

  db.close();
});
