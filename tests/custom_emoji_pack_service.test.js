import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { AlbumCollector } from '../src/stickers/albumCollector.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { CustomEmojiPackService } from '../src/stickers/customEmojiPackService.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { createCustomEmojiStudioScreen } from '../src/telegram/screens/customEmojiStudio.js';

function createEmojiApiMock() {
  const sets = new Map();
  const fileBuffers = new Map();
  let fidSeq = 1;
  let ceIdSeq = 1000;

  return {
    botUsername: 'Lancy_test_bot',
    sets,
    fileBuffers,
    calls: [],
    async getMe() { return { id: 777, username: this.botUsername }; },
    async createNewStickerSet({ userId, name, title, stickers, stickerType }) {
      this.calls.push({ op: 'createNewStickerSet', userId, name, title, count: stickers.length, stickerType });
      const items = (stickers || []).map((st) => {
        const fid = `fid_${++fidSeq}`;
        const ceid = stickerType === 'custom_emoji' ? `5000${++ceIdSeq}` : undefined;
        fileBuffers.set(fid, Buffer.isBuffer(st.sticker) ? st.sticker : st.sticker?.buffer);
        return {
          file_id: fid,
          file_unique_id: `uniq_${fid}`,
          custom_emoji_id: ceid,
          emoji: st.emoji_list?.[0] || '✨',
          is_video: st.format === 'video',
          is_animated: st.format === 'animated',
          type: stickerType || 'regular'
        };
      });
      sets.set(name, { name, title, sticker_type: stickerType || 'regular', stickers: items });
      return true;
    },
    async addStickerToSet({ userId, name, sticker }) {
      this.calls.push({ op: 'addStickerToSet', userId, name, format: sticker.format });
      const s = sets.get(name);
      if (!s) throw new Error(`Set ${name} not found`);
      const fid = `fid_${++fidSeq}`;
      const ceid = s.sticker_type === 'custom_emoji' ? `5000${++ceIdSeq}` : undefined;
      fileBuffers.set(fid, Buffer.isBuffer(sticker.sticker) ? sticker.sticker : sticker.sticker?.buffer);
      s.stickers.push({
        file_id: fid,
        file_unique_id: `uniq_${fid}`,
        custom_emoji_id: ceid,
        emoji: sticker.emoji_list?.[0] || '✨',
        is_video: sticker.format === 'video',
        is_animated: sticker.format === 'animated',
        type: s.sticker_type
      });
      return true;
    },
    async getStickerSet(name) {
      const s = sets.get(name);
      if (!s) throw new Error(`Stickerset ${name} not found`);
      return s;
    },
    async setStickerSetTitle({ name, title }) {
      this.calls.push({ op: 'setStickerSetTitle', name, title });
      const s = sets.get(name);
      if (!s) throw new Error(`Set ${name} not found`);
      s.title = title;
      return true;
    },
    async getFile(fileId) {
      return { file_id: fileId, file_path: fileId };
    },
    async deleteStickerSet(name) {
      sets.delete(name);
      return true;
    },
    async deleteStickerFromSet(fileId) {
      this.calls.push({ op: 'deleteStickerFromSet', fileId });
      for (const s of sets.values()) {
        const idx = s.stickers.findIndex((st) => st.file_id === fileId);
        if (idx >= 0) {
          s.stickers.splice(idx, 1);
          return true;
        }
      }
      return false;
    },
    async downloadFile(fileId) {
      const b = fileBuffers.get(fileId);
      if (!b) throw new Error(`File ${fileId} not found`);
      return b;
    }
  };
}

async function makeSquarePng(r = 255, g = 80, b = 100) {
  return sharp({
    create: { width: 128, height: 128, channels: 4, background: { r, g, b, alpha: 1 } }
  }).png().toBuffer();
}

test('AlbumCollector: debounces grouped slides cleanly in arrival order', async () => {
  const collector = new AlbumCollector({ settleMs: 60, maxWaitMs: 400, maxItems: 10 });
  const batches = [];
  const base = { chatId: -1001, userId: 42, mediaGroupId: 'alb_1', onFlush: (msgs) => batches.push(msgs) };

  collector.push({ ...base, message: { message_id: 10, caption: 'My Album Pack' } });
  collector.push({ ...base, message: { message_id: 11 } });
  assert.equal(collector.has({ chatId: -1001, userId: 42, mediaGroupId: 'alb_1' }), true);
  collector.push({ ...base, message: { message_id: 12 } });

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((m) => m.message_id), [10, 11, 12]);
  assert.equal(collector.has({ chatId: -1001, userId: 42, mediaGroupId: 'alb_1' }), false);
});

test('CustomEmojiPackService: Owner global vs per-user isolated pack name settings & resetForUser', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];

  const api = createEmojiApiMock();
  const packService = new StickerPackService({ db, api, settings });
  const ceService = new CustomEmojiPackService({ db, api, settings, packService });

  // Owner global default propagates to all users who have not customized their own
  settings.setForUser(1001, 'customEmoji.defaultPackName', 'Lancy VIP Emojis');
  assert.equal(ceService.resolveEffectivePackName(1001), 'Lancy VIP Emojis');
  assert.equal(ceService.resolveEffectivePackName(2002), 'Lancy VIP Emojis');
  assert.equal(ceService.resolveEffectivePackName(3003), 'Lancy VIP Emojis');

  // Regular user Alice (2002) sets her own isolated default pack name
  settings.setForUser(2002, 'customEmoji.defaultPackName', 'Alice Cute Emojis');
  assert.equal(ceService.resolveEffectivePackName(2002), 'Alice Cute Emojis');
  // Owner & Bob (3003) remain untouched!
  assert.equal(ceService.resolveEffectivePackName(1001), 'Lancy VIP Emojis');
  assert.equal(ceService.resolveEffectivePackName(3003), 'Lancy VIP Emojis');

  // Alice resets -> inherits global default again
  settings.resetForUser(2002, 'customEmoji.defaultPackName');
  assert.equal(ceService.resolveEffectivePackName(2002), 'Lancy VIP Emojis');
});

test('CustomEmojiPackService: create, auto-split >200, add, merge, clone & rename, live title rename, delete, /stickers isolation', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  settings.values.telegram.stickerAddDelayMs = 0;

  db.run('INSERT OR IGNORE INTO users (tg_id, username, first_name) VALUES (?, ?, ?)', 2002, 'alice', 'Alice');
  const api = createEmojiApiMock();
  const packService = new StickerPackService({ db, settings, stickerService: { api } });
  const ceService = new CustomEmojiPackService({ db, api, settings, packService });

  const pngA = await makeSquarePng(250, 40, 40);
  const pngB = await makeSquarePng(40, 200, 250);
  const pngC = await makeSquarePng(90, 240, 100);
  const pngD = await makeSquarePng(240, 220, 30);

  // 1. Create custom_emoji pack from images -> DB isolation from /stickers (regular)
  const created = await ceService.createCustomEmojiPack({
    userId: 2002,
    title: 'Alice Pack',
    descriptors: [
      { buffer: pngA, emoji: ['🔥'] },
      { buffer: pngB, emoji: ['💎'] }
    ]
  });
  assert.equal(created.allPacks.length, 1);
  assert.match(created.allPacks[0].link, /^https:\/\/t\.me\/addemoji\//);
  assert.equal(created.allPacks[0].stickerKind, 'custom_emoji');

  const regularOnly = packService.listPacks(2002);
  assert.equal(regularOnly.packs.length, 0, '/stickers list must stay isolated from custom_emoji packs');
  const emojiOnly = packService.listPacks(2002, { stickerKind: 'custom_emoji' });
  assert.equal(emojiOnly.packs.length, 1);
  assert.equal(emojiOnly.packs[0].count, 2);

  // 2. Add another item to existing pack
  const addRes = await ceService.addItemsToPack({
    userId: 2002,
    packId: emojiOnly.packs[0].id,
    descriptors: [{ buffer: pngC, emoji: ['🌸'] }]
  });
  assert.equal(addRes.added, 1);
  assert.equal(packService.getPack(2002, emojiOnly.packs[0].id).count, 3);

  // 3. Merge another pack into target pack (even a Regular sticker set!), deleting source
  const regWebp = await sharp(pngD).resize(512, 512).webp({ lossless: true }).toBuffer();
  const srcShort = 'other_reg_pack_by_Lancy_test_bot';
  await api.createNewStickerSet({
    userId: 9999,
    name: srcShort,
    title: 'Friend Stickers',
    stickerType: 'regular',
    stickers: [{ sticker: { buffer: regWebp }, format: 'static', emoji_list: ['😎'] }]
  });
  const mergeSrcRow = db.run(
    `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, source, sticker_type, sticker_kind, link)
     VALUES (?, ?, ?, ?, ?, 'manual', 'static', 'regular', ?)`,
    2002, srcShort, 'Friend Stickers', 'friend', 1, `https://t.me/addstickers/${srcShort}`
  );
  const srcPackId = Number(mergeSrcRow.lastInsertRowid);
  const mergeRes = await ceService.mergePacks({
    userId: 2002,
    targetPackId: emojiOnly.packs[0].id,
    sourcePackId: srcPackId,
    deleteSource: true
  });
  assert.equal(mergeRes.added, 1);
  assert.equal(packService.getPack(2002, srcPackId), null, 'deleted source pack after merge');
  assert.equal(packService.getPack(2002, emojiOnly.packs[0].id).count, 4);

  // 4. Clone & Rename someone else's public pack (including lossless .tgs pack!)
  const tgsBuf = gzipSync(Buffer.from(JSON.stringify({ v: '5.5.2', fr: 60, ip: 0, op: 60, w: 512, h: 512, layers: [] })));
  await api.createNewStickerSet({
    userId: 8888,
    name: 'stranger_tgs_by_other',
    title: 'Stranger Animated Pack',
    stickerType: 'custom_emoji',
    stickers: [{ sticker: { buffer: tgsBuf }, format: 'animated', emoji_list: ['✨'] }]
  });
  const cloned = await ceService.cloneAndRenamePack({
    userId: 2002,
    shortName: 'https://t.me/addemoji/stranger_tgs_by_other',
    targetTitle: 'Alice Rebranded TGS',
    targetKind: 'custom_emoji'
  });
  assert.equal(cloned.allPacks[0].title, 'Alice Rebranded TGS');
  assert.equal(cloned.allPacks[0].stickerType, 'animated');
  const clonedApiSet = await api.getStickerSet(cloned.allPacks[0].name);
  assert.equal(clonedApiSet.stickers[0].is_animated, true);

  // 5. Rename Pack Title & Delete Item
  await ceService.renamePackTitle({ userId: 2002, packId: emojiOnly.packs[0].id, newTitle: 'Alice Renamed Pack' });
  assert.equal(packService.getPack(2002, emojiOnly.packs[0].id).title, 'Alice Renamed Pack');
  assert.equal((await api.getStickerSet(emojiOnly.packs[0].shortName)).title, 'Alice Renamed Pack');

  const itemsBeforeDel = db.all('SELECT * FROM sticker_items WHERE pack_id = ? ORDER BY position ASC', emojiOnly.packs[0].id);
  const delRes = await ceService.deletePackItem({ userId: 2002, packId: emojiOnly.packs[0].id, fileId: itemsBeforeDel[0].file_id });
  assert.equal(delRes.count, 3);

  // 6. Auto-split >200 pre-converted assets into Part 01 (200) and Part 02 (2)
  const preAsset = await sharp(pngA).resize(100, 100).webp({ quality: 80 }).toBuffer();
  const manyAssets = Array.from({ length: 202 }, (_, i) => ({
    _emojiAsset: true,
    buffer: preAsset,
    format: 'static',
    emoji: ['✨'],
    sha256: `sha_${i}`,
    phash: `ph_${i}`
  }));
  const splitRes = await ceService.createCustomEmojiPack({
    userId: 2002,
    title: 'Mega Pack',
    descriptors: manyAssets
  });
  assert.equal(splitRes.allPacks.length, 2);
  assert.equal(splitRes.allPacks[0].count, 200);
  assert.equal(splitRes.allPacks[1].count, 2);
  assert.equal(splitRes.allPacks[1].title, 'Mega Pack 02');
});

test('CustomEmojiStudioScreen: StateMachine onMessage handles cfg_usr, collect media & reverse HD export', async (t) => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  settings.values.telegram.stickerAddDelayMs = 0;
  db.run('INSERT OR IGNORE INTO users (tg_id, username, first_name) VALUES (?, ?, ?)', 8380, 'pappy', 'Pappy');

  const baseApi = createEmojiApiMock();
  const png = await makeSquarePng(120, 60, 210);
  baseApi.fileBuffers.set('fid_photo_1', png);
  const sentRich = [];
  const sentDocs = [];
  const api = {
    ...baseApi,
    async sendChatAction() { return true; },
    async deleteMessage() { return true; },
    async sendRichMessage(chatId, rich) {
      sentRich.push({ chatId, rich });
      return { message_id: sentRich.length + 10, chat: { id: chatId } };
    },
    async editMessageRich(chatId, message_id, rich) {
      sentRich.push({ chatId, message_id, rich });
      return { message_id, chat: { id: chatId } };
    },
    async sendDocument(chatId, buffer, opts) {
      sentDocs.push({ chatId, buffer, opts });
      return { message_id: 90 };
    }
  };

  const sm = new StateMachine();
  const packService = new StickerPackService({ db, settings, stickerService: { api } });
  const ceService = new CustomEmojiPackService({ db, api, settings, packService });
  const studio = createCustomEmojiStudioScreen({
    app: { settings, packs: packService, customEmojiPacks: ceService, telegram: { api } },
    packService,
    customEmojiService: ceService
  });
  studio.registerStateHandlers(sm);
  t.after(() => {
    studio.cleanup();
    db.close();
  });

  const ctx = {
    tgId: '8380',
    chatId: 8380,
    api,
    sm,
    messageId: 1,
    editScreen: (r) => api.editMessageRich(8380, 1, r)
  };

  // 1. Trigger cfg_usr -> send Unicode pack name -> verify StateMachine passes message directly (no undefined.text error)
  await studio.handle(ctx, 'cfg_usr');
  const unicodeName = '✞⃝🌸xɪᴛᴛʟᴇ ʟᴀɴᴄʏ⏤͟͟͞͞🌸✞ . @aesthetic_lancy_world';
  const cfgHandled = await sm.handleMessage('8380', { text: unicodeName, chat: { id: 8380, type: 'private' } }, ctx);
  assert.equal(cfgHandled, true);
  assert.equal(ceService.resolveEffectivePackName('8380'), unicodeName);

  // 2. Start new pack tray -> drop a photo -> verify collected & tray updated with 1 item
  await studio.handle(ctx, 'new');
  const collectHandled = await sm.handleMessage('8380', {
    chat: { id: 8380, type: 'private' },
    photo: [{ file_id: 'fid_photo_1', file_size: png.length }]
  }, ctx);
  assert.equal(collectHandled, true);
  assert.match(JSON.stringify(sentRich.at(-1).rich), /Build Emoji Pack \(1\)/);

  // 3. Reverse HD export -> send photo -> verify upscaled HD PNG document sent
  await studio.handle(ctx, 'rev');
  const revHandled = await sm.handleMessage('8380', {
    chat: { id: 8380, type: 'private' },
    photo: [{ file_id: 'fid_photo_1', file_size: png.length }]
  }, ctx);
  assert.equal(revHandled, true);
  assert.equal(sentDocs.length, 1);
  assert.ok(sentDocs[0].buffer.length > 0);
});

test('CustomEmojiPackService: batch createNewStickerSet upload & automatic 1-by-1 fallback', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  settings.values.telegram.stickerAddDelayMs = 0;

  const api = createEmojiApiMock();
  const packService = new StickerPackService({ db, settings, stickerService: { api } });
  const ceService = new CustomEmojiPackService({ db, api, settings, packService });
  const pngA = await makeSquarePng(100, 120, 220);
  const preAsset = await sharp(pngA).resize(100, 100).webp({ quality: 80 }).toBuffer();

  const makeAssets = (count, prefix) => Array.from({ length: count }, (_, i) => ({
    _emojiAsset: true,
    buffer: preAsset,
    format: 'static',
    emoji: ['✨'],
    sha256: `${prefix}_sha_${i}`,
    phash: `${prefix}_ph_${i}`
  }));

  // 1. Batched initial createNewStickerSet sends up to 25 items in 1 API call (0 addStickerToSet calls)
  api.calls.length = 0;
  const batchRes = await ceService.createCustomEmojiPack({
    userId: 3001,
    title: 'Fast Batch Pack',
    descriptors: makeAssets(6, 'batch')
  });
  assert.equal(batchRes.allPacks[0].count, 6);
  const createCalls = api.calls.filter((c) => c.op === 'createNewStickerSet');
  const addCalls = api.calls.filter((c) => c.op === 'addStickerToSet');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].count, 6);
  assert.equal(addCalls.length, 0);

  // 2. Fallback: if multi-sticker createNewStickerSet fails, falls back cleanly to 1 + addStickerToSet loop
  const origCreate = api.createNewStickerSet.bind(api);
  api.createNewStickerSet = async (params) => {
    if (params.stickers.length > 1) {
      throw new Error('Bad Request: STICKERS_TOO_MUCH_FOR_CREATE');
    }
    return origCreate(params);
  };
  api.calls.length = 0;
  const fallbackRes = await ceService.createCustomEmojiPack({
    userId: 3002,
    title: 'Fallback Pack',
    descriptors: makeAssets(5, 'fb')
  });
  assert.equal(fallbackRes.allPacks[0].count, 5);
  const fbCreates = api.calls.filter((c) => c.op === 'createNewStickerSet');
  const fbAdds = api.calls.filter((c) => c.op === 'addStickerToSet');
  assert.equal(fbCreates.length, 1);
  assert.equal(fbCreates[0].count, 1);
  assert.equal(fbAdds.length, 4);
  db.close();
});
