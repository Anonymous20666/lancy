import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import {
  BUILTIN_TEMPLATES,
  TemplateStore
} from '../src/captions/templates.js';
import {
  FONT_STYLES,
  toSmallCaps,
  toSoftCute,
  toMathScript,
  renderChannelPackCardCaption
} from '../src/captions/engine.js';
import {
  verifyBotCanPostInChannel,
  listVerifiedAdminChannels
} from '../src/telegram/permissions.js';
import { createChannelPostScreen } from '../src/telegram/screens/channelPost.js';
import { StickerPackService } from '../src/stickers/packService.js';

test('Unicode font styles, bloom_crating default card, and TemplateStore persistence work end-to-end', () => {
  assert.ok(BUILTIN_TEMPLATES.bloom_crating);
  assert.ok(BUILTIN_TEMPLATES.angelic_ribbon);
  assert.ok(BUILTIN_TEMPLATES.dark_luxe);
  assert.ok(FONT_STYLES.some((f) => f.id === 'math_bold_italic'));
  assert.ok(FONT_STYLES.some((f) => f.id === 'small_caps'));
  assert.ok(FONT_STYLES.some((f) => f.id === 'script'));

  assert.notEqual(toSmallCaps('Lancy Pack'), 'Lancy Pack');
  assert.notEqual(toSoftCute('Lancy Pack'), 'Lancy Pack');
  assert.notEqual(toMathScript('Lancy Pack'), 'Lancy Pack');

  const rendered = renderChannelPackCardCaption({
    title: 'Crating',
    character: 'Crating',
    count: 69,
    packsCount: 1,
    stickerKind: 'custom_emoji',
    creatorLabel: 'lancy aesthetic',
    templateName: 'bloom_crating',
    fontStyle: 'math_bold_italic'
  });

  assert.ok(rendered.includes('🌸 𝑪𝑹𝑨𝑻𝑰𝑵𝑮 🌸'));
  assert.ok(rendered.includes('𝐄𝐌𝐎𝐉𝐈𝐒'));
  assert.ok(rendered.includes('69'));
  assert.ok(rendered.includes('01'));
  assert.ok(rendered.includes('𝐓𝐀𝐏 • 𝐀𝐃𝐃 • 𝐄𝐍𝐉𝐎𝐘'));

  const db = new Database(':memory:');
  const store = new TemplateStore(db, { userId: 500 });
  store.save('Coquette Vibe', '✨ {{styled_title}} • {{stickers}} ✨', { isDefault: true });
  assert.equal(store.getDefaultName(), 'Coquette Vibe');
  const loaded = store.get('Coquette Vibe');
  assert.equal(loaded, '✨ {{styled_title}} • {{stickers}} ✨');
  assert.equal(store.delete('Coquette Vibe'), true);
  db.close();
});

test('verifyBotCanPostInChannel validates channel type & bot admin posting rights for clones and main bot', async () => {
  const db = new Database(':memory:');
  db.recordTelegramChannel({ channel_id: -100111, title: 'Approved Channel', username: 'approved_ch', can_post: 1, added_by: 99 });
  db.recordBotChannelVerification({ bot_id: 2222, channel_id: -100111, bot_username: 'clone_one_bot', is_admin: 1, can_post: 1 });

  const cloneApiOk = {
    getMe: async () => ({ id: 2222, username: 'clone_one_bot' }),
    getChat: async (c) => ({ id: -100111, type: 'channel', title: 'Approved Channel', username: String(c).replace(/^@/, '') }),
    getChatMember: async () => ({ status: 'administrator', can_post_messages: true })
  };
  const okRes = await verifyBotCanPostInChannel(cloneApiOk, '@approved_ch');
  assert.equal(okRes.ok, true);
  assert.equal(String(okRes.botId), '2222');

  const missingPostApi = {
    getMe: async () => ({ id: 3333, username: 'clone_two_bot' }),
    getChat: async () => ({ id: -100111, type: 'channel', title: 'Approved Channel' }),
    getChatMember: async () => ({ status: 'administrator', can_post_messages: false })
  };
  const noPostRes = await verifyBotCanPostInChannel(missingPostApi, -100111);
  assert.equal(noPostRes.ok, false);
  assert.equal(noPostRes.reason, 'missing_post_permission');

  const notChannelApi = {
    getMe: async () => ({ id: 3333, username: 'clone_two_bot' }),
    getChat: async () => ({ id: -100222, type: 'supergroup', title: 'Some Group' }),
    getChatMember: async () => ({ status: 'administrator', can_post_messages: true })
  };
  const groupRes = await verifyBotCanPostInChannel(notChannelApi, -100222);
  assert.equal(groupRes.ok, false);
  assert.equal(groupRes.reason, 'not_a_channel');

  const list = await listVerifiedAdminChannels({ db, userId: 99, settings: { get: () => [] }, api: cloneApiOk });
  assert.equal(list.length, 1);
  assert.equal(list[0].botVerified, true);
  assert.equal(list[0].botCanPost, true);
  db.close();
});

test('ChannelPost connects multiple channels, filters custom_emoji packs, sends single RichCard with 1280px HD media + inline buttons inside card + verified 2-custom-emoji drop', async () => {
  const sharp = (await import('sharp')).default;
  const { richTextToString } = await import('../src/telegram/rich.js');
  const { extractCustomEmojiIdsFromResponse } = await import('../src/telegram/screens/channelPost.js');

  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine({ db });

  const sentAnimations = [];
  const sentMessages = [];
  const sentStickers = [];
  const fakePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  let msgSeq = 10;
  const fakeApi = {
    botUsername: 'clone_lancy_bot',
    getMe: async () => ({ id: 7070, username: 'clone_lancy_bot' }),
    getChat: async (inp) => {
      const s = String(inp);
      if (s.includes('chan_two') || s === '-100202') {
        return { id: -100202, type: 'channel', title: 'Channel Two', username: 'chan_two' };
      }
      return { id: -100101, type: 'channel', title: 'Channel One', username: 'chan_one' };
    },
    getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
    getStickerSet: async () => ({
      name: 'dream_ce_by_clone_lancy_bot',
      title: 'Dreamy Emoji',
      sticker_type: 'custom_emoji',
      stickers: [
        { file_id: 'ce_s1', emoji: '🌸', is_video: false, custom_emoji_id: '600001' },
        { file_id: 'ce_v1', emoji: '✨', is_video: true, custom_emoji_id: '600002' },
        { file_id: 'ce_s2', emoji: '🦋', is_video: false, custom_emoji_id: '600003' }
      ]
    }),
    getFile: async () => ({ file_path: 'ce/test.png' }),
    downloadFile: async () => fakePng,
    sendAnimation: async (chatId, anim, extra) => {
      sentAnimations.push({ chatId, anim, extra });
      return { message_id: ++msgSeq };
    },
    sendPhoto: async (chatId, photo, extra) => {
      sentMessages.push({ chatId, type: 'photo', photo, extra });
      return { message_id: ++msgSeq };
    },
    sendSticker: async (chatId, sticker) => {
      sentStickers.push({ chatId, sticker });
      return { message_id: ++msgSeq };
    },
    sendMessage: async (chatId, text, extra) => {
      sentMessages.push({ chatId, type: 'text', text, extra });
      return { message_id: ++msgSeq, text };
    },
    sendRichMessage: async (chatId, rich, extra, files) => {
      sentMessages.push({ chatId, type: 'rich', rich, extra, files });
      return { message_id: ++msgSeq, rich_message: rich };
    },
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true
  };

  const packs = new StickerPackService({
    db,
    settings,
    stickerService: {
      botUsername: 'clone_lancy_bot',
      getStickerSet: fakeApi.getStickerSet
    }
  });

  // Insert one custom_emoji pack via SQLite directly matching schema.js (with one missing custom_emoji_id in DB to test hydration)
  const insertPack = db.run(
    `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, source, sticker_type, sticker_kind, link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    1001, 'dream_ce_by_clone_lancy_bot', 'Crating Dreamy Emoji', 'Crating', 2, 'manual', 'custom_emoji', 'custom_emoji', 'https://t.me/addemoji/dream_ce_by_clone_lancy_bot'
  );
  const pId = Number(insertPack.lastInsertRowid);
  db.run(
    `INSERT INTO sticker_items (pack_id, position, file_id, emoji, type, custom_emoji_id, item_format)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    pId, 0, 'ce_s1', '🌸', 'static', null, 'static'
  );
  db.run(
    `INSERT INTO sticker_items (pack_id, position, file_id, emoji, type, custom_emoji_id, item_format)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    pId, 1, 'ce_s2', '🦋', 'static', '600003', 'static'
  );

  const app = { db, settings, sm, packs, telegram: { api: fakeApi }, screens: new Map() };
  const chScreen = createChannelPostScreen({ app });
  chScreen.registerStateHandlers(sm);

  const ctx = { tgId: 1001, chatId: 1001, api: fakeApi, sm, screens: app.screens };

  // Filter for custom_emoji packs & pick it
  await chScreen.handle(ctx, 'filter_kind', ['custom_emoji']);
  await chScreen.handle(ctx, 'pack', [String(pId)]);

  // Batch connect 2 channels at once via state handler
  await chScreen.handle(ctx, 'add_channel');
  assert.equal(sm.state(1001), States.TG_CHANNEL_INPUT);
  const ok = await sm.handleMessage(1001, {
    chat: { id: 1001, type: 'private' },
    from: { id: 1001 },
    text: '@chan_one\n@chan_two'
  }, { api: fakeApi });
  assert.equal(ok, true);

  const verifiedRows = db.getBotChannelVerifications(7070);
  assert.equal(verifiedRows.length, 2);

  // Confirm broadcast to BOTH selected channels
  await chScreen.handle(ctx, 'to_preview');
  await chScreen.handle(ctx, 'post_confirm');

  // Verify DB item missing custom_emoji_id was hydrated from getStickerSet
  const hydratedRow = db.get('SELECT custom_emoji_id FROM sticker_items WHERE pack_id = ? AND file_id = ?', pId, 'ce_s1');
  assert.equal(hydratedRow.custom_emoji_id, '600001');

  // Channel RichMessage calls: 1 unified pack card + 1 custom_emoji drop per channel
  const channelRichPosts = sentMessages.filter(
    (m) => m.type === 'rich' && (m.chatId === -100101 || m.chatId === -100202)
  );
  const cardPosts = channelRichPosts.filter((m) => m.files?.hero_photo);
  assert.equal(cardPosts.length, 2, 'Each channel must receive 1 unified RichMessage card with attached HD photo');

  for (const post of cardPosts) {
    // 1. Verify attached hero photo is 1280x1280 HD JPEG
    const meta = await sharp(post.files.hero_photo.buffer).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 1280);

    // 2. Verify blockquote caption inside card
    const quoteBlock = post.rich.blocks.find((b) => b.type === 'blockquote');
    assert.ok(quoteBlock, 'Card must contain blockquote block');
    const quoteStr = quoteBlock.blocks.map((b) => richTextToString(b.text)).join('\n');
    assert.ok(quoteStr.includes('𝑪𝑹𝑨𝑻𝑰𝑵𝑮'));
    assert.ok(quoteStr.includes('𝐄𝐌𝐎𝐉𝐈𝐒'));

    // 3. Verify buttons are INSIDE the RichMessage card with proper inline colors
    const btnBlocks = post.rich.blocks.filter((b) => b.type === 'buttons');
    assert.equal(btnBlocks.length, 2);
    assert.equal(btnBlocks[0].buttons[0].style, 'success');
    assert.ok(btnBlocks[0].buttons[0].url.includes('t.me/addemoji/dream_ce_by_clone_lancy_bot'));
    assert.equal(btnBlocks[1].buttons[0].style, 'primary');
    assert.equal(btnBlocks[1].buttons[1].style, 'primary');
  }

  // Custom emoji sample drop: 1 RichMessage with 2 custom_emoji nodes per channel (600002 + 600001)
  const dropMsgs = channelRichPosts.filter((m) => !m.files?.hero_photo);
  assert.equal(dropMsgs.length, 2, 'Each channel must receive 1 custom emoji sample drop');
  assert.equal(sentStickers.length, 0, 'Custom emoji pack must never fall back to sendSticker');
  for (const drop of dropMsgs) {
    const ids = extractCustomEmojiIdsFromResponse({ rich_message: drop.rich });
    assert.deepEqual(ids, ['600002', '600001']);
  }

  // Final completion screen in DM must report custom emoji verification
  const dmRich = sentMessages.filter((m) => m.type === 'rich' && m.chatId === 1001);
  const doneCard = dmRich[dmRich.length - 1];
  const doneText = doneCard.rich.blocks.map((b) => richTextToString(b.text)).join('\n');
  assert.ok(doneText.includes('2/2 custom emoji verified'), 'Completion card must confirm 2/2 custom emojis verified');

  // Test AI prompt custom design & custom template save states on channel_post
  await chScreen.handle(ctx, 'ai_prompt');
  assert.equal(sm.state(1001), States.TG_CHANNEL_AI_PROMPT);
  const aiHandled = await sm.handleMessage(1001, { chat: { id: 1001 }, text: 'cyber goth neon aesthetic' }, { api: fakeApi });
  assert.equal(aiHandled, true);

  await chScreen.handle(ctx, 'save_template');
  assert.equal(sm.state(1001), States.TG_CHANNEL_TEMPLATE_NAME);
  const saveHandled = await sm.handleMessage(1001, { chat: { id: 1001 }, text: 'My Neon Design' }, { api: fakeApi });
  assert.equal(saveHandled, true);
  assert.ok(new TemplateStore(db, { userId: 1001 }).get('My Neon Design'));

  db.close();
});

test('sendVerifiedCustomEmojiSamples detects stripped custom_emoji entities, deletes downgraded message, and verifies fallback', async () => {
  const { sendVerifiedCustomEmojiSamples, inspectCustomEmojiDelivery } = await import('../src/telegram/screens/channelPost.js');

  const samples = [
    { emoji: '❄️', custom_emoji_id: '700001' },
    { emoji: '🌸', custom_emoji_id: '700002' }
  ];

  // Case 1: sendRichMessage strips custom_emoji (returns plain text only), HTML fallback preserves entities
  const deleted = [];
  const apiFallbackWorks = {
    sendRichMessage: async () => ({
      message_id: 501,
      rich_message: { blocks: [{ type: 'paragraph', text: '❄️   🌸' }] }
    }),
    deleteMessage: async (chatId, msgId) => {
      deleted.push({ chatId, msgId });
      return true;
    },
    sendMessage: async () => ({
      message_id: 502,
      text: '❄️   🌸',
      entities: [
        { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '700001' },
        { type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: '700002' }
      ]
    })
  };

  const res1 = await sendVerifiedCustomEmojiSamples({
    api: apiFallbackWorks,
    channelId: -100999,
    samples
  });
  assert.equal(deleted.length, 1, 'Should delete the stripped RichMessage');
  assert.equal(deleted[0].msgId, 501);
  assert.equal(res1.customVerified, true);
  assert.equal(res1.verifiedCount, 2);
  assert.equal(res1.transport, 'html_tg_emoji');

  // Case 2: Both transports strip custom_emoji -> reports customVerified: false, status: 'stripped'
  const apiBothStrip = {
    sendRichMessage: async () => ({
      message_id: 601,
      text: '❄️   🌸',
      entities: []
    }),
    deleteMessage: async () => true,
    sendMessage: async () => ({
      message_id: 602,
      text: '❄️   🌸'
    })
  };

  const res2 = await sendVerifiedCustomEmojiSamples({
    api: apiBothStrip,
    channelId: -100999,
    samples
  });
  assert.equal(res2.customVerified, false);
  assert.equal(res2.status, 'stripped');
  assert.equal(res2.verifiedCount, 0);

  // Case 3: inspectCustomEmojiDelivery unit checks
  const checkStripped = inspectCustomEmojiDelivery({ message_id: 1, text: '❄️' }, ['700001']);
  assert.equal(checkStripped.status, 'stripped');
  assert.equal(checkStripped.verified, false);
});

test('sendVerifiedCustomEmojiSamples hydrates live alt emoji via getCustomEmojiStickers and deletes stripped HTML fallback', async () => {
  const { sendVerifiedCustomEmojiSamples } = await import('../src/telegram/screens/channelPost.js');
  const deleted = [];
  const richPayloads = [];
  const htmlMessages = [];

  const mockApi = {
    async getCustomEmojiStickers(ids) {
      assert.deepEqual(ids, ['6039876293477014482', '6037309586661187441']);
      return [
        { custom_emoji_id: '6039876293477014482', emoji: '💊', file_id: 'fresh_f1' },
        { custom_emoji_id: '6037309586661187441', emoji: '🧥', file_id: 'fresh_f2' }
      ];
    },
    async sendRichMessage(_chatId, payload) {
      richPayloads.push(payload);
      // Telegram strips custom_emoji entities in channel
      return { message_id: 901, text: '💊   🧥', entities: [] };
    },
    async sendMessage(_chatId, text, opts) {
      htmlMessages.push({ text, opts });
      // Telegram also strips <tg-emoji> in channel for non-Fragment bot
      return { message_id: 902, text: '💊   🧥', entities: [] };
    },
    async deleteMessage(_chatId, msgId) {
      deleted.push(msgId);
      return true;
    }
  };

  const res = await sendVerifiedCustomEmojiSamples({
    api: mockApi,
    channelId: -1003933828222,
    samples: [
      { custom_emoji_id: '6039876293477014482', emoji: '🤲', file_id: 'stale_f1' },
      { custom_emoji_id: '6037309586661187441', emoji: '🧥', file_id: 'stale_f2' }
    ],
    useRichMessage: true
  });

  assert.equal(richPayloads.length, 1);
  assert.ok(JSON.stringify(richPayloads[0]).includes('💊'), 'Rich sample should use hydrated live alt emoji 💊 rather than stale DB emoji');
  assert.equal(htmlMessages.length, 1);
  assert.ok(htmlMessages[0].text.includes('<tg-emoji emoji-id="6039876293477014482">💊</tg-emoji>'));
  assert.deepEqual(deleted, [901, 902], 'Both stripped rich message and stripped HTML fallback must be deleted');
  assert.equal(res.customVerified, false);
  assert.equal(res.status, 'stripped');
  assert.equal(res.deletedStripped, true);
  assert.equal(res.sentCount, 0);
  assert.deepEqual(res.messageIds, []);
});
