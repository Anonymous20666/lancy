import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { renderChannelBanner, createChannelPostScreen } from '../src/telegram/screens/channelPost.js';
import { richButton, RichMessageBuilder, normalizeButtonStyle, inlineKeyboard } from '../src/telegram/rich.js';

test('Database: chat prefix and tg_channels persistence', () => {
  const db = new Database(':memory:');

  // 1. Chat prefix default and mutation
  assert.equal(db.getChatPrefix(-100123), '/');
  db.setChatPrefix(-100123, '!');
  assert.equal(db.getChatPrefix(-100123), '!');

  db.setChatPrefix(-100123, '.');
  assert.equal(db.getChatPrefix(-100123), '.');

  // 2. Channel persistence
  db.recordTelegramChannel({
    channel_id: -100999888,
    title: 'Aesthetic Stickers Feed',
    username: 'aesthetic_stickers',
    can_post: 1,
    added_by: 501
  });

  const channels = db.getTelegramChannels(501);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].channel_id, -100999888);
  assert.equal(channels[0].title, 'Aesthetic Stickers Feed');
  assert.equal(channels[0].username, 'aesthetic_stickers');
  assert.equal(channels[0].can_post, 1);

  const single = db.getTelegramChannel(-100999888);
  assert.ok(single);
  assert.equal(single.title, 'Aesthetic Stickers Feed');

  // 3. Remove channel
  db.removeTelegramChannel(-100999888);
  assert.equal(db.getTelegramChannels().length, 0);

  db.close();
});

test('ChannelPost: renderChannelBanner produces crisp 1000x560 PNG buffer', async () => {
  // Test standalone banner
  const bannerBuf = await renderChannelBanner({
    title: 'Anime Aesthetic Pack',
    count: 42,
    stickerType: 'static',
    creator: 'Lancy'
  });

  assert.ok(Buffer.isBuffer(bannerBuf));
  assert.ok(bannerBuf.length > 5000);

  const meta = await sharp(bannerBuf).metadata();
  assert.equal(meta.width, 1000);
  assert.equal(meta.height, 560);
  assert.equal(meta.format, 'png');

  // Test banner with sample sticker composition
  const sampleSticker = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 4,
      background: { r: 255, g: 105, b: 180, alpha: 1 }
    }
  }).png().toBuffer();

  const composedBuf = await renderChannelBanner({
    title: 'Neon Cyberpunk',
    count: 50,
    stickerType: 'video',
    sampleBuffer: sampleSticker,
    creator: 'Lancy'
  });

  assert.ok(Buffer.isBuffer(composedBuf));
  const compMeta = await sharp(composedBuf).metadata();
  assert.equal(compMeta.width, 1000);
  assert.equal(compMeta.height, 560);
});

test('TelegramController /setprefix: view, update and dispatch with custom prefix', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const sentMessages = [];
  const chatId = -100777;

  const mockApi = {
    getMe: async () => ({ id: 99999, username: 'lancybot' }),
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: sentMessages.length + 100 };
    },
    getChatMember: async () => ({ status: 'administrator' })
  };

  const app = {
    telegram: { api: mockApi, botUsername: 'lancybot' },
    db,
    settings,
    sm,
    packs: { listPacks: () => ({ packs: [], total: 0 }), getPack: () => null }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    sm,
    app,
    log: console
  });

  // 1. Check default prefix is /
  assert.equal(db.getChatPrefix(chatId), '/');

  // 2. Query /setprefix without args -> views current prefix
  await controller.handleUpdate({
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'group' },
      from: { id: 801, first_name: 'AdminBob' },
      text: '/setprefix'
    }
  });

  assert.ok(sentMessages.length > 0);
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('Current command prefix:</b> <code>/</code>'));

  // 3. Change prefix to !
  await controller.handleUpdate({
    message: {
      message_id: 2,
      chat: { id: chatId, type: 'group' },
      from: { id: 801, first_name: 'AdminBob' },
      text: '/setprefix !'
    }
  });

  assert.equal(db.getChatPrefix(chatId), '!');
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('Command prefix changed to:</b> <code>!</code>'));

  // 4. Send command using the new prefix !setprefix
  await controller.handleUpdate({
    message: {
      message_id: 3,
      chat: { id: chatId, type: 'group' },
      from: { id: 801, first_name: 'AdminBob' },
      text: '!setprefix'
    }
  });

  assert.ok(sentMessages[sentMessages.length - 1].text.includes('Current command prefix:</b> <code>!</code>'));

  // 5. Reset prefix back to / using !setprefix /
  await controller.handleUpdate({
    message: {
      message_id: 4,
      chat: { id: chatId, type: 'group' },
      from: { id: 801, first_name: 'AdminBob' },
      text: '!setprefix /'
    }
  });

  assert.equal(db.getChatPrefix(chatId), '/');

  db.close();
});

test('ChannelPost screen: wizard flow and full publishing execution (pic, sample stickers, pack card)', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const userId = 8881;
  const channelId = -100999000;

  // Insert a mock pack in DB
  db.run(
    `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, sticker_type, link)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, 'cute_cats_by_lancy', 'Cute Cats Collection', 'cute cats', 25, 'static', 'https://t.me/addstickers/cute_cats_by_lancy'
  );
  const createdPack = db.get('SELECT * FROM sticker_packs WHERE user_id = ?', userId);

  // Insert connected channel in DB
  db.recordTelegramChannel({
    channel_id: channelId,
    title: 'Cats Announcement Channel',
    username: 'cats_channel',
    can_post: 1,
    added_by: userId
  });

  const sentPhotos = [];
  const sentStickers = [];
  const sentMessages = [];

  const mockApi = {
    getMe: async () => ({ id: 99999, username: 'lancybot' }),
    getStickerSet: async (name) => ({
      name,
      stickers: [
        { file_id: 'stk_file_1', emoji: '🐱' },
        { file_id: 'stk_file_2', emoji: '🐾' },
        { file_id: 'stk_file_3', emoji: '💖' },
        { file_id: 'stk_file_4', emoji: '✨' }
      ]
    }),
    getFile: async (fid) => ({ file_id: fid, file_path: null }),
    sendPhoto: async (cid, photo, opts) => {
      sentPhotos.push({ cid, photo, opts });
      return { message_id: 1111 };
    },
    sendSticker: async (cid, sticker, opts) => {
      sentStickers.push({ cid, sticker, opts });
      return { message_id: 2222 };
    },
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 3333 };
    },
    editMessageText: async () => true,
    editMessageReplyMarkup: async () => true,
    answerCallbackQuery: async () => true
  };

  const app = {
    telegram: { api: mockApi, botUsername: 'lancybot' },
    db,
    settings,
    sm,
    packs: {
      listPacks: () => ({ packs: [createdPack], total: 1 }),
      getPack: () => createdPack
    }
  };

  const screen = createChannelPostScreen({ app });

  const ctx = {
    tgId: userId,
    chatId: userId,
    messageId: 50,
    screens: new Map([['channel_post', screen]]),
    editScreen: async (rich) => rich
  };

  // 1. Open screen -> Pack Picker
  await screen.open(ctx);

  // 2. Select pack
  await screen.handle(ctx, 'select_pack', [createdPack.id]);

  // 3. Go to channels
  await screen.handle(ctx, 'to_channels');

  // 4. Select channel
  await screen.handle(ctx, 'select_channel', [channelId]);

  // 5. Go to preview
  await screen.handle(ctx, 'to_preview');

  // 6. Confirm publish!
  await screen.handle(ctx, 'post_confirm');

  // Verify Phase 1: Photo sent to channel with caption
  assert.equal(sentPhotos.length, 1);
  assert.equal(sentPhotos[0].cid, channelId);
  assert.ok(sentPhotos[0].opts.caption.includes('Cute Cats Collection'));

  // Verify Phase 2: First 3 to 5 sample stickers sent
  assert.ok(sentStickers.length >= 3);
  assert.equal(sentStickers[0].cid, channelId);
  assert.equal(sentStickers[0].sticker, 'stk_file_1');
  assert.equal(sentStickers[1].sticker, 'stk_file_2');
  assert.equal(sentStickers[2].sticker, 'stk_file_3');

  // Verify Phase 3: Pack installation message with Add button
  const channelFinalMsg = sentMessages.find((m) => m.cid === channelId);
  assert.ok(channelFinalMsg);
  assert.ok(channelFinalMsg.text.toLowerCase().includes('add the complete sticker pack'));
  assert.ok(channelFinalMsg.opts.reply_markup.inline_keyboard[0][0].url.includes('cute_cats_by_lancy'));

  db.close();
});

test('TelegramController #handleMyChatMemberUpdated auto-registers channels when bot is made admin', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const mockApi = {
    getMe: async () => ({ id: 99999, username: 'lancybot' })
  };

  const app = {
    telegram: { api: mockApi, botUsername: 'lancybot' },
    db,
    settings,
    sm
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    sm,
    app,
    log: console
  });

  // Simulate Telegram my_chat_member update when bot is added to channel as administrator
  await controller.handleUpdate({
    my_chat_member: {
      chat: { id: -100445566, title: 'Super Cute News Channel', username: 'supercute_news', type: 'channel' },
      from: { id: 777, first_name: 'AdminAlice' },
      new_chat_member: {
        status: 'administrator',
        user: { id: 99999, is_bot: true, username: 'lancybot' }
      }
    }
  });

  const channels = db.getTelegramChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].channel_id, -100445566);
  assert.equal(channels[0].title, 'Super Cute News Channel');
  assert.equal(channels[0].username, 'supercute_news');

  // Simulate bot removal
  await controller.handleUpdate({
    my_chat_member: {
      chat: { id: -100445566, type: 'channel' },
      from: { id: 777, first_name: 'AdminAlice' },
      new_chat_member: {
        status: 'kicked',
        user: { id: 99999, is_bot: true }
      }
    }
  });

  assert.equal(db.getTelegramChannels().length, 0);

  db.close();
});

test('RichMessage: normalizeButtonStyle ensures only primary, success, or danger styles are emitted', () => {
  assert.equal(normalizeButtonStyle('primary'), 'primary');
  assert.equal(normalizeButtonStyle('success'), 'success');
  assert.equal(normalizeButtonStyle('danger'), 'danger');
  assert.equal(normalizeButtonStyle('secondary'), 'primary');
  assert.equal(normalizeButtonStyle('warn'), 'primary');
  assert.equal(normalizeButtonStyle(null), 'primary');
  assert.equal(normalizeButtonStyle(undefined), 'primary');

  // Verify richButton
  const btn1 = richButton.callback('Test', 'test', { style: 'secondary' });
  assert.equal(btn1.style, 'primary');

  const btn2 = richButton.callback('Test2', 'test2', { style: 'danger' });
  assert.equal(btn2.style, 'danger');

  // Verify RichMessageBuilder.toJSON output
  const b = new RichMessageBuilder();
  b.buttons([
    { text: 'Custom 1', callback_data: 'c1', style: 'secondary' },
    { text: 'Custom 2', callback_data: 'c2', style: 'success' }
  ]);
  const json = b.toJSON();
  const buttonsBlock = json.blocks.find((blk) => blk.type === 'buttons');
  assert.ok(buttonsBlock);
  assert.equal(buttonsBlock.buttons[0].style, 'primary');
  assert.equal(buttonsBlock.buttons[1].style, 'success');

  // Verify inlineKeyboard
  const ik = inlineKeyboard([[
    { text: 'IK 1', callback_data: 'ik1', style: 'secondary' },
    { text: 'IK 2', callback_data: 'ik2', style: 'danger' }
  ]]);
  assert.equal(ik.inline_keyboard[0][0].style, 'primary');
  assert.equal(ik.inline_keyboard[0][1].style, 'danger');
});
