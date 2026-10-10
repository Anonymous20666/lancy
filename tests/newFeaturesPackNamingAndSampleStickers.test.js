import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { WhatsAppPublisher, sanitizeWhatsAppPackName } from '../src/whatsapp/publisher.js';
import {
  DEFAULT_PACK_NAME_TEMPLATE,
  extractCleanStickerName,
  formatPackTitle,
  toTelegramPackTitle,
  toWhatsAppPackTitle
} from '../src/stickers/packNaming.js';

test('3-Part Pack Naming: extracts clean name and injects into template', () => {
  assert.equal(extractCleanStickerName('Toji'), 'Toji');
  assert.equal(extractCleanStickerName('(Toji)'), 'Toji');
  assert.equal(extractCleanStickerName('ᥫ᭡ʟᴀɴᴄʏ - Toji stickers'), 'Toji');
  assert.equal(extractCleanStickerName('Toji Collection'), 'Toji');

  const formatted = formatPackTitle('Toji');
  assert.match(formatted, /🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸/);
  assert.match(formatted, /Toji/);
  assert.match(formatted, /╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬/);

  // Custom template with (Sticker name)
  const customTmpl = `Pappy\n\n( Sticker name )\n\nCustom Footer`;
  const customFormatted = formatPackTitle('Toji', customTmpl);
  assert.equal(customFormatted, `Pappy\n\nToji\n\nCustom Footer`);

  // Telegram title is truncated and single-line
  const tgTitle = toTelegramPackTitle(formatted);
  assert.ok(tgTitle.length <= 64);
  assert.ok(!tgTitle.includes('\n'));
  assert.match(tgTitle, /Toji/);
});

test('sanitizeWhatsAppPackName preserves user aesthetic 3-part templates', () => {
  const tmpl = `🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸\n\nToji\n\n╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬`;
  assert.equal(sanitizeWhatsAppPackName(tmpl), tmpl);

  const plainMultline = `First line of plain description\nSecond line`;
  assert.equal(sanitizeWhatsAppPackName(plainMultline, 'FallbackPack'), 'FallbackPack');
});

test('StickerPackService.getStickerBytes auto-heals missing DB rows from Telegram sticker set', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  // Create pack row with count 2, but insert ONLY 1 item into sticker_items
  const packId = db.run(
    `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, sticker_type)
     VALUES (1001, 'test_autoheal_pack_by_bot', 'Test Pack', 'toji', 2, 'static')`
  ).lastInsertRowid;

  db.run(
    `INSERT INTO sticker_items (pack_id, position, file_id, emoji, type)
     VALUES (?, 0, 'file_id_0', '🤍', 'static')`,
    packId
  );

  let downloadedFileId = null;
  const mockStickerService = {
    api: {
      getStickerSet: async (name) => {
        assert.equal(name, 'test_autoheal_pack_by_bot');
        return {
          name,
          stickers: [
            { file_id: 'file_id_0', emoji: '🤍' },
            { file_id: 'file_id_1_from_telegram', emoji: '🌸' }
          ]
        };
      }
    }
  };

  const packService = new StickerPackService({ db, settings, stickerService: mockStickerService });
  const pack = packService.getPack(1001, packId);

  // Sticker 0 (already in DB)
  const bytes0 = await packService.getStickerBytes(pack, 0, {
    download: async (fid) => Buffer.from(`bytes_${fid}`)
  });
  assert.equal(bytes0.toString(), 'bytes_file_id_0');

  // Sticker 1 (MISSING in DB — must auto-heal from mock Telegram getStickerSet!)
  const bytes1 = await packService.getStickerBytes(pack, 1, {
    download: async (fid) => {
      downloadedFileId = fid;
      return Buffer.from(`bytes_${fid}`);
    }
  });
  assert.equal(downloadedFileId, 'file_id_1_from_telegram');
  assert.equal(bytes1.toString(), 'bytes_file_id_1_from_telegram');

  // Verify DB was auto-healed with row for index 1
  const healedRow = db.get('SELECT * FROM sticker_items WHERE pack_id = ? AND position = 1', packId);
  assert.ok(healedRow, 'sticker_items must be auto-healed in DB');
  assert.equal(healedRow.file_id, 'file_id_1_from_telegram');
});

test('WhatsAppPublisher sends preview caption, sample stickers, then packs', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const mockChannels = {
    revalidate: async () => [{ jid: '120363431396805997@newsletter', name: 'Him', canPublish: 'yes' }]
  };
  const publisher = new WhatsAppPublisher({ db, settings, channels: mockChannels });

  const delivered = [];
  const fakeSession = {
    sessionId: 'wa_sess_1',
    isOnline: true,
    sendImage: async (jid, buf, caption) => delivered.push({ type: 'image', jid, caption }),
    sendSticker: async (jid, buf) => delivered.push({ type: 'sticker', jid }),
    sendStickerPack: async (jid, pack) => delivered.push({ type: 'pack', jid, name: pack.name })
  };

  // 1x1 test gif buffer
  const gifBuf = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  const plan = publisher.buildPlan({
    userId: 1001,
    packs: [{
      id: 1,
      title: 'Toji Pack',
      stickerCount: 6,
      stickers: [{ bytes: gifBuf }]
    }],
    sessionId: 'wa_sess_1',
    channelJids: ['120363431396805997@newsletter'],
    caption: '✨ TOJI STICKERS ARE OUT! ✨'
  });

  const results = await publisher.publish({
    plan,
    session: fakeSession,
    getStickerBytes: async (packId, index) => gifBuf
  });

  assert.equal(results.status, 'done');

  // Verify delivery order:
  // 1. Preview image with caption
  assert.equal(delivered[0].type, 'image');
  assert.equal(delivered[0].caption, '✨ TOJI STICKERS ARE OUT! ✨');

  // 2. Sample stickers (default 3 sample stickers)
  const sampleStickers = delivered.filter((d) => d.type === 'sticker');
  assert.equal(sampleStickers.length, 3, 'must drop sample stickers preview before the pack');

  // 3. Full sticker pack
  const packsDelivered = delivered.filter((d) => d.type === 'pack');
  assert.equal(packsDelivered.length, 1);
});
