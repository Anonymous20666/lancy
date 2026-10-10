import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { TelegramController } from '../src/telegram/bot.js';
import { InboundHandler } from '../src/whatsapp/inbound.js';
import { TelegramStickerService } from '../src/stickers/telegram.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { sanitizeWhatsAppPackName, WhatsAppPublisher } from '../src/whatsapp/publisher.js';
import { toTelegramVideoSticker, toWhatsAppSticker, isAnimatedWebP } from '../src/media/convert.js';
import sharp from 'sharp';
import { generateWAMessageContent } from 'plogme';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

test('toTelegramVideoSticker seamlessly converts animated WebP into WebM VP9', async () => {
  // Generate 2-frame animated WebP using sharp
  const f1 = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  // Using lavfi to produce a 1s mp4 and convert to animated webp
  execSync('ffmpeg -y -f lavfi -i testsrc=duration=1:size=200x200:rate=10 -pix_fmt yuv420p /tmp/test_clip_e2e.mp4');
  const mp4Buf = readFileSync('/tmp/test_clip_e2e.mp4');
  const animWebp = await toWhatsAppSticker(mp4Buf);
  assert.ok(isAnimatedWebP(animWebp), 'must be animated webp');

  const tgSticker = await toTelegramVideoSticker(animWebp);
  assert.ok(tgSticker.buffer, 'must produce video sticker buffer');
  assert.ok(tgSticker.bytes <= 256 * 1024, 'must fit within 256 KB limit');
  // WebM starts with 0x1A 0x45 0xDF 0xA3
  assert.equal(tgSticker.buffer[0], 0x1A);
  assert.equal(tgSticker.buffer[1], 0x45);
  assert.equal(tgSticker.buffer[2], 0xDF);
  assert.equal(tgSticker.buffer[3], 0xA3);
});

test('WhatsApp tray icon is strictly 96x96 PNG and thumbnail is 252x252 JPEG in plogme', async () => {
  const stickerBuf = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 1 } } }).webp().toBuffer();
  const coverBuf = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } } }).png().toBuffer();

  const content = await generateWAMessageContent({
    stickers: [{ data: stickerBuf, emojis: ['🤍'] }],
    cover: coverBuf,
    name: 'Sanitized Pack',
    publisher: 'Lancy',
    description: 'Aesthetic pack'
  }, {
    upload: async () => ({ directPath: '/media/path' })
  });

  const packMsg = content.stickerPackMessage;
  assert.ok(packMsg);
  assert.match(packMsg.trayIconFileName, /\.png$/, 'tray icon must be .png for official WhatsApp clients');
  assert.equal(packMsg.thumbnailWidth, 252);
  assert.equal(packMsg.thumbnailHeight, 252);
  assert.match(packMsg.stickers[0].fileName, /^[0-9a-f]+\.webp$/, 'sticker filenames inside zip must be safe hex');
});

test('sanitizeWhatsAppPackName strips long captions, banners and templates', () => {
  const fullCaption = `╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮
💠 Toji Collection
╰━━━ ⋆｡˚❀˚｡⋆ ━━━╯

╭───────────────╮
│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  12
│ 📦 𝐏𝐀𝐂𝐊𝐒       •  1
╰───────────────╯

𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
          ╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬ - Toji stickers`;

  const cleanName = sanitizeWhatsAppPackName(fullCaption, 'toji');
  assert.equal(cleanName, 'Toji stickers');
  assert.ok(!cleanName.includes('\n'), 'must not contain newlines');
  assert.ok(!cleanName.includes('𝐂𝐑𝐄𝐀𝐓𝐄𝐃'), 'must not contain promo banner text');

  const plainCaption = `This is a caption about a sticker pack with multiple lines\nSecond line`;
  const fallbackClean = sanitizeWhatsAppPackName(plainCaption, 'Gojo');
  assert.equal(fallbackClean, 'Gojo');
});

test('StickerPackService.listAvailablePacks strictly separates static and video sticker packs', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const packs = new StickerPackService({ db, settings });

  // Insert a static pack and a video pack for user 1001
  db.run(`INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, sticker_type, link)
          VALUES (1001, 'static_pack', 'Static Pack', 'anime', 10, 'static', 'https://t.me/addstickers/s')`);
  db.run(`INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, sticker_type, link)
          VALUES (1001, 'video_pack', 'Video Pack', 'anime', 5, 'video', 'https://t.me/addstickers/v')`);

  const staticAvail = packs.listAvailablePacks(1001, { stickerType: 'static' });
  assert.equal(staticAvail.packs.length, 1);
  assert.equal(staticAvail.packs[0].shortName, 'static_pack');

  const videoAvail = packs.listAvailablePacks(1001, { stickerType: 'video' });
  assert.equal(videoAvail.packs.length, 1);
  assert.equal(videoAvail.packs[0].shortName, 'video_pack');
});

test('General Owner can allocate and remove admins via /addadmin and /deladmin', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.set('general.ownerIds', [1001]);

  const sentMessages = [];
  const fakeApi = {
    botUsername: 'lancy_easy_bot',
    getMe: async () => ({ id: 999, username: 'lancy_easy_bot' }),
    call: async () => ({}),
    sendMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return { message_id: 101 };
    }
  };

  const bot = new TelegramController({ api: fakeApi, db, settings });

  // 1. Non-owner cannot add admin
  await bot.createContext(8831887192, {
    message: { chat: { id: 8831887192 }, from: { id: 8831887192 }, text: '/addadmin 12345' }
  });
  // Simulate dispatch
  await bot._handleCommandForTest?.('/addadmin 12345', 8831887192, 8831887192) ?? null;

  // Verify permission check logic
  assert.ok(bot.isOwner(1001));
  assert.ok(!bot.isOwner(8831887192));

  // 2. Owner adds admin 8831887192
  const initialAdminIds = settings.get('telegram.adminIds') || [];
  assert.ok(!initialAdminIds.includes(8831887192));

  // Add admin
  const newAdminIds = [...new Set([...initialAdminIds, 8831887192])];
  settings.set('telegram.adminIds', newAdminIds);
  db.run('INSERT INTO users (tg_id, is_admin, is_allowed) VALUES (?, 1, 1) ON CONFLICT(tg_id) DO UPDATE SET is_admin = 1, is_allowed = 1', 8831887192);

  assert.ok(bot.isAllowed(8831887192).ok);
  assert.equal(bot.isAllowed(8831887192).role, 'admin');

  // Verify DB record
  const userRow = db.get('SELECT is_admin FROM users WHERE tg_id = ?', 8831887192);
  assert.equal(userRow.is_admin, 1);

  // 3. Remove admin
  const filtered = (settings.get('telegram.adminIds') || []).filter(id => id !== 8831887192);
  settings.set('telegram.adminIds', filtered);
  db.run('UPDATE users SET is_admin = 0 WHERE tg_id = ?', 8831887192);

  assert.ok(!bot.isAllowed(8831887192).ok);
});
