import { randomBytes } from 'node:crypto';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { AlbumCollector } from '../../stickers/albumCollector.js';
import { toHdMediaFromEmoji } from '../../stickers/emojiConverter.js';
import { extractTelegramPackName } from '../../stickers/packNaming.js';
import { cleanTgTitle } from '../../stickers/limits.js';
import {
  CustomEmojiRegistry,
  extractCustomEmojiInputsFromMessage,
  extractUnicodeEmojis,
  resolveEmojiMetadataChunked,
  chunkFormattedLines
} from '../../stickers/customEmojiRegistry.js';

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MAX_TRAY_ITEMS = 200;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const EXPORT_FORMATS = ['png_doc', 'photo', 'mp4', 'gif'];
const EXPORT_FORMAT_LABELS = {
  png_doc: '📄 HD PNG (1024px Lossless)',
  photo: '🖼 HD Photo (JPG)',
  mp4: '🎬 HD Video (MP4) / PNG',
  gif: '🎞 Transparent HD GIF / PNG'
};

/**
 * Custom Emoji Studio (`cemoji`) — create, extend, merge, clone, rename,
 * extract/suggest Custom Emoji IDs, and HD reverse-export Telegram Custom Emoji packs.
 */
export function createCustomEmojiStudioScreen({ app, packService: injectedPackService, customEmojiService: injectedService } = {}) {
  const id = 'cemoji';
  const packService = injectedPackService || app.packs;
  const ceService = injectedService || app.customEmojiPacks;
  const registry = app.customEmojiRegistry || (app.db ? new CustomEmojiRegistry({ db: app.db }) : null);

  // Per-user interactive workspaces
  const trays = new Map();       // tgId -> { mode: 'create'|'add', packId?, title?, items: [] }
  const cloneDrafts = new Map(); // tgId -> { shortName, setTitle, count, stickerType, targetKind, customTitle }
  const textPrompts = new Map(); // tgId -> { kind, packId?, returnTo? }
  const idBatches = new Map();   // token -> { items, createdAt } (LRU capped at 100)
  const suggestSessions = new Map(); // token -> { tgId, chatId, items, createdAt } (LRU capped at 150)
  const albumCollector = new AlbumCollector({ settleMs: 750, maxWaitMs: 4000, maxItems: 20 });

  function putLru(map, key, val, limit = 120) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  function makeToken() {
    return randomBytes(4).toString('hex');
  }

  function appendTrayUnique(tray, newItems = []) {
    if (!tray || !Array.isArray(newItems)) return { added: 0, skipped: 0 };
    const seen = new Set(
      tray.items.map((it) => it.customEmojiId || it.fileUniqueId || it.fileId).filter(Boolean)
    );
    let added = 0;
    let skipped = 0;
    for (const item of newItems) {
      if (tray.items.length >= MAX_TRAY_ITEMS) break;
      const key = item.customEmojiId || item.fileUniqueId || item.fileId;
      if (key && seen.has(key)) {
        skipped += 1;
        continue;
      }
      if (key) seen.add(key);
      tray.items.push(item);
      added += 1;
    }
    return { added, skipped };
  }

  function getApi(ctx) {
    return ctx?.api || app.telegram?.api;
  }

  function isOwner(ctx) {
    const uid = Number(ctx?.tgId);
    const ownerIds = (app.settings?.get?.('general.ownerIds') ?? []).map(Number);
    return ownerIds.includes(uid) || Boolean(ctx?.controller?.isMainOwner?.(uid));
  }

  async function renderOrSend(ctx, rich) {
    if (typeof ctx?.editScreen === 'function') {
      return ctx.editScreen(rich);
    }
    const api = getApi(ctx);
    const chatId = ctx?.chatId ?? ctx?.tgId;
    return api?.sendRichMessage?.(chatId, rich);
  }

  function getExportPrefs(tgId) {
    return {
      format: app.settings?.getForUser?.(tgId, 'customEmoji.hdExportFormat') || 'png_doc',
      size: Number(app.settings?.getForUser?.(tgId, 'customEmoji.hdExportSize') || 1024)
    };
  }

  // ── Input extraction & download helpers ──────────────────────────────

  function detectDocumentMediaKind(doc) {
    const mime = String(doc?.mime_type || '').toLowerCase();
    const fname = String(doc?.file_name || '').toLowerCase();
    if (mime.includes('tgsticker') || fname.endsWith('.tgs')) {
      return { kind: 'file', isVideo: false, isAnimated: true, sourceTag: 'tgs' };
    }
    if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(fname)) {
      return { kind: 'file', isVideo: true, isAnimated: false, sourceTag: 'video' };
    }
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(fname)) {
      const isGif = mime === 'image/gif' || fname.endsWith('.gif');
      return { kind: 'file', isVideo: isGif, isAnimated: false, sourceTag: isGif ? 'gif' : 'image' };
    }
    return null;
  }

  async function extractInputsFromMessage(message, api) {
    const out = [];
    if (!message) return out;

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const best = message.photo[message.photo.length - 1];
      out.push({ kind: 'file', fileId: best.file_id, fileSize: best.file_size || 0, isVideo: false, isAnimated: false, sourceTag: 'photo' });
    }
    if (message.video?.file_id) {
      out.push({ kind: 'file', fileId: message.video.file_id, fileSize: message.video.file_size || 0, isVideo: true, isAnimated: false, sourceTag: 'video' });
    }
    if (message.video_note?.file_id) {
      out.push({ kind: 'file', fileId: message.video_note.file_id, fileSize: message.video_note.file_size || 0, isVideo: true, isAnimated: false, sourceTag: 'video' });
    }
    if (message.animation?.file_id) {
      out.push({ kind: 'file', fileId: message.animation.file_id, fileSize: message.animation.file_size || 0, isVideo: true, isAnimated: false, sourceTag: 'gif' });
    }
    if (message.document?.file_id) {
      const det = detectDocumentMediaKind(message.document);
      if (det) {
        out.push({ ...det, fileId: message.document.file_id, fileSize: message.document.file_size || 0 });
      }
    }
    if (message.sticker?.file_id) {
      const st = message.sticker;
      out.push({
        kind: 'file',
        fileId: st.file_id,
        fileUniqueId: st.file_unique_id || null,
        customEmojiId: st.custom_emoji_id || null,
        fileSize: st.file_size || 0,
        isVideo: Boolean(st.is_video),
        isAnimated: Boolean(st.is_animated),
        emoji: st.emoji ? [st.emoji] : ['✨'],
        setName: st.set_name || null,
        sourceTag: st.is_animated ? 'tgs' : (st.is_video ? 'video_sticker' : 'sticker')
      });
      if (st.custom_emoji_id) {
        registry?.upsertCatalogEntries?.([{
          customEmojiId: st.custom_emoji_id,
          unicodeEmoji: st.emoji || '✨',
          setName: st.set_name || null,
          fileId: st.file_id,
          isVideo: Boolean(st.is_video),
          isAnimated: Boolean(st.is_animated),
          source: 'discovered'
        }]);
      }
    }

    // Inline premium / custom emojis embedded inside message text or caption
    const entities = [
      ...(Array.isArray(message.entities) ? message.entities : []),
      ...(Array.isArray(message.caption_entities) ? message.caption_entities : [])
    ];
    const emojiIds = [...new Set(
      entities.filter((e) => e?.type === 'custom_emoji' && e.custom_emoji_id).map((e) => String(e.custom_emoji_id))
    )];
    if (emojiIds.length && api?.getCustomEmojiStickers) {
      try {
        const resolvedMap = await resolveEmojiMetadataChunked(api, emojiIds);
        const toIndex = [];
        for (const ceId of emojiIds) {
          const st = resolvedMap.get(ceId);
          if (!st) continue;
          out.push({
            kind: 'file',
            fileId: st.file_id,
            fileUniqueId: st.file_unique_id || null,
            customEmojiId: st.custom_emoji_id || ceId,
            fileSize: st.file_size || 0,
            isVideo: Boolean(st.is_video),
            isAnimated: Boolean(st.is_animated),
            emoji: st.emoji ? [st.emoji] : ['✨'],
            setName: st.set_name || null,
            sourceTag: 'custom_emoji'
          });
          toIndex.push({
            customEmojiId: st.custom_emoji_id || ceId,
            unicodeEmoji: st.emoji || '✨',
            setName: st.set_name || null,
            fileId: st.file_id,
            isVideo: Boolean(st.is_video),
            isAnimated: Boolean(st.is_animated),
            source: 'discovered'
          });
        }
        if (toIndex.length) registry?.upsertCatalogEntries?.(toIndex);
      } catch {}
    }

    return out;
  }

  async function downloadInputEntry(entry, api) {
    if (entry.buffer) return entry;
    if (entry.fileSize && entry.fileSize > MAX_DOWNLOAD_BYTES) {
      throw new Error(`File too large (${(entry.fileSize / 1024 / 1024).toFixed(1)} MB > 25 MB limit)`);
    }
    const f = await api.getFile(entry.fileId);
    const buf = await api.downloadFile(f.file_path);
    return {
      ...entry,
      buffer: buf
    };
  }

  async function downloadPackDescriptors(shortName, api, limit = MAX_TRAY_ITEMS) {
    const set = await api.getStickerSet(shortName);
    if (!set?.stickers?.length) return { set, items: [] };
    const slice = set.stickers.slice(0, limit);
    const items = [];
    for (let i = 0; i < slice.length; i += 6) {
      const batch = slice.slice(i, i + 6);
      const settled = await Promise.allSettled(
        batch.map(async (st) => {
          const f = await api.getFile(st.file_id);
          const buf = await api.downloadFile(f.file_path);
          return {
            kind: 'file',
            fileId: st.file_id,
            customEmojiId: st.custom_emoji_id || null,
            buffer: buf,
            emoji: st.emoji ? [st.emoji] : ['✨'],
            isVideo: Boolean(st.is_video),
            isAnimated: Boolean(st.is_animated),
            sourceTag: set.sticker_type === 'custom_emoji' ? 'custom_emoji' : 'sticker'
          };
        })
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value?.buffer) items.push(r.value);
      }
    }
    return { set, items };
  }

  // ── Screens ──────────────────────────────────────────────────────────

  async function openHub(ctx) {
    const cfg = ceService.getPackNameConfig(ctx.tgId);
    const { total } = packService.listPacks(ctx.tgId, { limit: 1, offset: 0, stickerKind: 'custom_emoji' });
    const stats = registry?.getStats?.() || { totalIds: 0, distinctEmojis: 0 };

    await ctx.sm.transition(ctx.tgId, States.IDLE, { chatId: ctx.chatId });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '✨ CUSTOM EMOJI STUDIO ✨',
      'premium emoji packs, ids & hd converter'
    ])));
    b.divider();
    b.table(kvTable([
      ['📦 My Emoji Packs', String(total)],
      ['🏷 Active Pack Title', cfg.effective],
      ['🆔 Indexed IDs', `${stats.totalIds} IDs (${stats.distinctEmojis} emojis)`],
      ['✨ Quality Mode', cfg.autoEnhance ? 'HD Crisp + Alpha Preserve' : 'Standard']
    ]), { compact: true });
    b.divider();
    b.blockquote(
      'Send photos, .mp4 videos, GIFs, albums, Telegram stickers, or inline custom emojis to build 100×100 packs — extract custom emoji IDs, suggest custom variants for normal emojis, or post packs to channels!'
    );
    b.divider();
    b.buttons([
      richButton.callback('✨ New Emoji Pack', encodeCallback(id, 'new'), { style: 'success' }),
      richButton.callback('➕ Add to Pack', encodeCallback(id, 'add_list', '0'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🆔 Get Emoji ID', encodeCallback(id, 'emoji_id'), { style: 'primary' }),
      richButton.callback('🪄 Suggest Emojis', encodeCallback(id, 'suggest_open'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback(`📦 My Emoji Packs (${total})`, encodeCallback(id, 'packs', '0')),
      richButton.callback('🔀 Merge Packs', encodeCallback(id, 'merge_tgt', '0'))
    ]);
    b.buttons([
      richButton.callback('🔄 Clone & Rename Pack', encodeCallback(id, 'clone')),
      richButton.callback('🖼 Emoji → HD Media', encodeCallback(id, 'rev'))
    ]);
    b.buttons([
      richButton.callback('⚙ Pack Name & HD Settings', encodeCallback(id, 'cfg')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function startNewPackTray(ctx, { packTitle = null } = {}) {
    const title = ceService.resolveEffectivePackName(ctx.tgId, packTitle);
    const tray = {
      mode: 'create',
      packId: null,
      title,
      items: []
    };
    trays.set(ctx.tgId, tray);
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_COLLECT, {
      context: { mode: 'create' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    return renderTray(ctx, tray);
  }

  async function startAddToPackTray(ctx, packId) {
    const pack = packService.getPack(ctx.tgId, Number(packId));
    if (!pack) return openHub(ctx);
    const tray = {
      mode: 'add',
      packId: pack.id,
      title: pack.title,
      shortName: pack.shortName,
      currentCount: pack.count,
      items: []
    };
    trays.set(ctx.tgId, tray);
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_COLLECT, {
      context: { mode: 'add', packId: pack.id },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    return renderTray(ctx, tray);
  }

  async function renderTray(ctx, tray) {
    const counts = { static: 0, video: 0, animated: 0 };
    for (const it of tray.items) {
      if (it.isAnimated) counts.animated++;
      else if (it.isVideo) counts.video++;
      else counts.static++;
    }

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      tray.mode === 'add' ? '➕ ADD CUSTOM EMOJIS' : '✨ CUSTOM EMOJI TRAY',
      cleanTgTitle(tray.title)
    ])));
    b.divider();
    b.table(kvTable([
      ['🏷 Target Title', cleanTgTitle(tray.title)],
      ...(tray.mode === 'add' ? [['📊 Current Slots', `${tray.currentCount}/200`]] : []),
      ['📦 Staged Items', `${tray.items.length} (🖼 ${counts.static} • 🎬 ${counts.video} • ✨ ${counts.animated})`]
    ]), { compact: true });
    b.divider();
    b.blockquote(
      tray.items.length === 0
        ? 'Drop media now! Supports:\n• Photos, PNG/JPG/WebP\n• MP4 / MOV / WebM / GIF clips\n• Albums (all slides grouped cleanly!)\n• Regular Stickers or Inline Custom Emojis\n• Pack links (t.me/addstickers/... or t.me/addemoji/...)'
        : `Ready to convert & publish ${tray.items.length} item(s). Send more anytime or tap Build below!`
    );
    b.divider();
    if (tray.items.length > 0) {
      b.buttons([
        richButton.callback(
          tray.mode === 'add' ? `🚀 Add All (${tray.items.length})` : `🚀 Build Emoji Pack (${tray.items.length})`,
          encodeCallback(id, 'tray_go'),
          { style: 'success' }
        )
      ]);
    }
    b.buttons([
      ...(tray.mode === 'create' ? [richButton.callback('✏️ Set Pack Name', encodeCallback(id, 'tray_name'))] : []),
      richButton.callback('🗑 Clear Tray', encodeCallback(id, 'tray_clr')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function executeTrayBuild(ctx) {
    const tray = trays.get(ctx.tgId);
    if (!tray?.items?.length) return openHub(ctx);
    const api = getApi(ctx);

    await ctx.sm.reset(ctx.tgId, { reason: 'building' });
    const itemsToBuild = [...tray.items];
    trays.delete(ctx.tgId);

    const tracker = new ProgressTracker({
      api,
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      action: 'upload_photo'
    });

    await tracker.live((st) => {
      const pb = new RichMessageBuilder();
      pb.heading('✨ BUILDING CUSTOM EMOJI PACK', 3);
      pb.blockquote(`${st.stageLabel || 'Converting media with HD clarity...'}\nProgress: ${st.done || 0} / ${st.total || itemsToBuild.length}`);
      return pb.toJSON();
    }, { stageLabel: 'Downloading uploaded media...', done: 0, total: itemsToBuild.length });

    try {
      const downloaded = new Array(itemsToBuild.length).fill(null);
      let dlDone = 0;
      let cursor = 0;
      const dlWorkers = Math.min(8, Math.max(1, itemsToBuild.length));
      await Promise.all(
        Array.from({ length: dlWorkers }, async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= itemsToBuild.length) break;
            try {
              downloaded[idx] = await downloadInputEntry(itemsToBuild[idx], api);
            } catch {}
            dlDone++;
            tracker.set({ stageLabel: 'Downloading uploaded media...', done: dlDone, total: itemsToBuild.length });
          }
        })
      );
      const validDownloaded = downloaded.filter(Boolean);
      if (!validDownloaded.length) {
        throw new Error('Could not download any staged media items.');
      }

      let result;
      const onProgress = (info) => {
        const label = info.stage === 'converting'
          ? 'HD encoding 100×100 custom emojis...'
          : info.stage === 'creating'
            ? 'Creating custom emoji set on Telegram...'
            : 'Uploading emojis to set...';
        tracker.set({ stageLabel: label, done: info.done || 0, total: info.total || validDownloaded.length });
      };

      if (tray.mode === 'add' && tray.packId) {
        result = await ceService.addItemsToPack({
          userId: ctx.tgId,
          packId: tray.packId,
          descriptors: validDownloaded,
          onProgress
        });
      } else {
        result = await ceService.createCustomEmojiPack({
          userId: ctx.tgId,
          title: tray.title,
          descriptors: validDownloaded,
          query: tray.title,
          source: 'manual',
          onProgress
        });
      }

      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '✅ CUSTOM EMOJI PACK READY',
        cleanTgTitle(result.title)
      ])));
      b.divider();
      b.table(kvTable([
        ['🏷 Pack Title', result.title],
        ['✨ Emojis', String(result.count)],
        ['🔗 Install Link', result.link || `https://t.me/addemoji/${result.name}`]
      ]), { compact: true });
      if (result.splitPack || result.extraPacks?.length) {
        const extras = result.extraPacks || [result.splitPack];
        b.blockquote(`📚 Split across ${1 + extras.length} packs (Telegram cap 200/set):\n` + extras.map((e) => `• ${e.title}: ${e.link}`).join('\n'));
      }
      b.divider();
      b.buttons([
        richButton.url('✨ Add Custom Emojis', result.link || `https://t.me/addemoji/${result.name}`, { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('📦 Pack Details', encodeCallback(id, 'pack', String(result.packId))),
        richButton.callback('✨ Studio Home', encodeCallback(id, 'open'))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
    } catch (err) {
      const eb = new RichMessageBuilder();
      eb.heading('✕ Emoji Pack Build Failed', 3);
      eb.blockquote(err?.message || 'Unexpected error converting items.');
      eb.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
      eb.validate();
      await tracker.finish(eb.toJSON());
    }
  }

  // ── My Emoji Packs & Pack Details ────────────────────────────────────

  async function renderPackList(ctx, pageStr = '0', mode = 'packs') {
    const page = Math.max(0, Number(pageStr) || 0);
    const limit = 6;
    const { packs, total } = packService.listPacks(ctx.tgId, {
      limit,
      offset: page * limit,
      stickerKind: 'custom_emoji'
    });

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      mode === 'add_list' ? '➕ PICK PACK TO ADD TO' : '📦 MY CUSTOM EMOJI PACKS',
      `${total} pack(s)`
    ])));
    b.divider();
    if (!packs.length) {
      b.blockquote('You have no Custom Emoji packs yet. Tap ✨ New Emoji Pack or 🔄 Clone & Rename Pack!');
    } else {
      for (const p of packs) {
        const op = mode === 'add_list' ? 'tray_add' : 'pack';
        b.buttons([
          richButton.callback(`✨ ${p.title} (${p.count}/200)`, encodeCallback(id, op, String(p.id)))
        ]);
      }
      const nav = [];
      if (page > 0) nav.push(richButton.callback('◀ Prev', encodeCallback(id, mode, String(page - 1))));
      if ((page + 1) * limit < total) nav.push(richButton.callback('Next ▶', encodeCallback(id, mode, String(page + 1))));
      if (nav.length) b.buttons(nav);
    }
    b.buttons([
      richButton.callback('✨ New Pack', encodeCallback(id, 'new'), { style: 'success' }),
      richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function renderPackDetail(ctx, packIdStr) {
    const pack = packService.getPack(ctx.tgId, Number(packIdStr));
    if (!pack) return renderPackList(ctx, '0', 'packs');

    const link = pack.link || `https://t.me/addemoji/${pack.shortName}`;
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '✨ CUSTOM EMOJI PACK',
      pack.title
    ])));
    b.divider();
    b.table(kvTable([
      ['🏷 Title', pack.title],
      ['🔢 Emojis', `${pack.count} / 200`],
      ['🎭 Format', pack.stickerType || 'mixed'],
      ['🔗 Short Name', pack.shortName]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.url('✨ Open in Telegram', link, { style: 'success' }),
      richButton.callback('📢 Post to Channel', encodeCallback(id, 'post_ch', String(pack.id)), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('➕ Add Emojis', encodeCallback(id, 'tray_add', String(pack.id)), { style: 'primary' }),
      richButton.callback('✏️ Rename Title', encodeCallback(id, 'ren', String(pack.id)))
    ]);
    b.buttons([
      richButton.callback('🔀 Merge Into This', encodeCallback(id, 'merge_src', String(pack.id), '0')),
      richButton.callback('🖼 Export HD Media', encodeCallback(id, 'exp_pack', String(pack.id)))
    ]);
    b.buttons([
      richButton.callback('🏷 To 512px Stickers', encodeCallback(id, 'to_reg', String(pack.id))),
      richButton.callback('🗑 Remove Item', encodeCallback(id, 'del_item', String(pack.id)))
    ]);
    b.buttons([
      richButton.callback('🔄 Sync', encodeCallback(id, 'sync', String(pack.id))),
      richButton.callback('🗑 Delete Pack', encodeCallback(id, 'del_ask', String(pack.id)), { style: 'danger' })
    ]);
    b.buttons([
      richButton.callback('📦 Back to Packs', encodeCallback(id, 'packs', '0')),
      richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  // ── Merge Packs Flow ─────────────────────────────────────────────────

  async function renderMergeTargetPicker(ctx, pageStr = '0') {
    const page = Math.max(0, Number(pageStr) || 0);
    const limit = 6;
    const { packs, total } = packService.listPacks(ctx.tgId, {
      limit,
      offset: page * limit,
      stickerKind: 'custom_emoji'
    });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🔀 MERGE EMOJI PACKS (1/2)',
      'select target pack to receive items'
    ])));
    b.divider();
    if (!packs.length) {
      b.blockquote('Create or clone at least one Custom Emoji pack first!');
    } else {
      for (const p of packs) {
        b.buttons([richButton.callback(`📥 Into: ${p.title} (${p.count}/200)`, encodeCallback(id, 'merge_src', String(p.id), '0'))]);
      }
      const nav = [];
      if (page > 0) nav.push(richButton.callback('◀ Prev', encodeCallback(id, 'merge_tgt', String(page - 1))));
      if ((page + 1) * limit < total) nav.push(richButton.callback('Next ▶', encodeCallback(id, 'merge_tgt', String(page + 1))));
      if (nav.length) b.buttons(nav);
    }
    b.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function renderMergeSourcePicker(ctx, targetIdStr, pageStr = '0') {
    const targetId = Number(targetIdStr);
    const target = packService.getPack(ctx.tgId, targetId);
    if (!target) return renderMergeTargetPicker(ctx, '0');

    const page = Math.max(0, Number(pageStr) || 0);
    const limit = 6;
    const { packs, total } = packService.listPacks(ctx.tgId, {
      limit: 100,
      offset: 0,
      stickerKind: 'all'
    });
    const candidates = packs.filter((p) => p.id !== targetId);
    const slice = candidates.slice(page * limit, (page + 1) * limit);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🔀 MERGE PACKS (2/2)',
      `into: ${target.title}`
    ])));
    b.divider();
    b.blockquote('Pick ANY pack (Custom Emoji or Regular Sticker) to merge into target. Duplicates are skipped automatically and items convert to 100×100 HD!');
    b.divider();
    if (!slice.length) {
      b.blockquote('No other packs available to merge from.');
    } else {
      for (const p of slice) {
        const badge = p.stickerKind === 'custom_emoji' ? '✨' : '🏷';
        b.buttons([richButton.callback(`${badge} ${p.title} (${p.count})`, encodeCallback(id, 'merge_ask', String(targetId), String(p.id)))]);
      }
      const nav = [];
      if (page > 0) nav.push(richButton.callback('◀ Prev', encodeCallback(id, 'merge_src', String(targetId), String(page - 1))));
      if ((page + 1) * limit < candidates.length && total > 0) nav.push(richButton.callback('Next ▶', encodeCallback(id, 'merge_src', String(targetId), String(page + 1))));
      if (nav.length) b.buttons(nav);
    }
    b.buttons([richButton.callback('◀ Back', encodeCallback(id, 'merge_tgt', '0'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function renderMergeConfirm(ctx, targetIdStr, sourceIdStr) {
    const target = packService.getPack(ctx.tgId, Number(targetIdStr));
    const source = packService.getPack(ctx.tgId, Number(sourceIdStr));
    if (!target || !source) return openHub(ctx);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🔀 CONFIRM PACK MERGE',
      `${source.title} → ${target.title}`
    ])));
    b.divider();
    b.table(kvTable([
      ['📥 Target Pack', `${target.title} (${target.count}/200)`],
      ['📤 Source Pack', `${source.title} (${source.count})`],
      ['✨ Auto-Handling', 'Deduplicate + Overflow split at 200']
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('🔀 Merge (Keep Source)', encodeCallback(id, 'merge_go', String(target.id), String(source.id), 'keep'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('🔀 Merge & Delete Source', encodeCallback(id, 'merge_go', String(target.id), String(source.id), 'del'), { style: 'danger' })
    ]);
    b.buttons([
      richButton.callback('◀ Back', encodeCallback(id, 'merge_src', String(target.id), '0'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function executeMerge(ctx, targetIdStr, sourceIdStr, mode = 'keep') {
    const api = getApi(ctx);
    const tracker = new ProgressTracker({ api, chatId: ctx.chatId, messageId: ctx.messageId, action: 'upload_photo' });
    await tracker.live((st) => {
      const pb = new RichMessageBuilder();
      pb.heading('🔀 MERGING PACKS...', 3);
      pb.blockquote(`${st.label || 'Preparing merge...'}\nProgress: ${st.done || 0} / ${st.total || 0}`);
      return pb.toJSON();
    }, { label: 'Downloading source pack items...', done: 0, total: 1 });

    try {
      const res = await ceService.mergePacks({
        userId: ctx.tgId,
        targetPackId: Number(targetIdStr),
        sourcePackId: Number(sourceIdStr),
        deleteSource: mode === 'del',
        onProgress: (info) => {
          tracker.set({ label: `Stage: ${info.stage || 'processing'}...`, done: info.done || 0, total: info.total || 1 });
        }
      });

      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '✅ MERGE COMPLETE',
        res.title
      ])));
      b.divider();
      b.table(kvTable([
        ['📥 Target Pack', `${res.title} (${res.count}/200)`],
        ['➕ Added New', String(res.added)],
        ['♻️ Dupes Skipped', String(res.skippedDupes || 0)],
        ['🗑 Source', res.sourceDeleted ? 'Deleted' : 'Kept']
      ]), { compact: true });
      b.divider();
      b.buttons([
        richButton.url('✨ Open Merged Pack', res.link, { style: 'success' }),
        richButton.callback('📦 Pack Details', encodeCallback(id, 'pack', String(res.packId)))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
    } catch (err) {
      const eb = new RichMessageBuilder();
      eb.heading('✕ Merge Failed', 3);
      eb.blockquote(err?.message || 'Could not merge those packs.');
      eb.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
      eb.validate();
      await tracker.finish(eb.toJSON());
    }
  }

  // ── Clone & Rename Flow ──────────────────────────────────────────────

  async function startClonePrompt(ctx) {
    textPrompts.set(ctx.tgId, { kind: 'clone_source' });
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_INPUT, {
      context: { kind: 'clone_source' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🔄 CLONE & RENAME PACK',
      'convert anyone’s pack to yours'
    ])));
    b.divider();
    b.blockquote(
      'Send ANY of these:\n' +
      '• A pack link (t.me/addstickers/... or t.me/addemoji/...)\n' +
      '• Forward/send ANY single sticker from that pack\n' +
      '• Send ANY inline custom emoji from the target pack!'
    );
    b.buttons([richButton.callback('✕ Cancel', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function renderClonePreview(ctx, draft) {
    const defaultTitle = ceService.resolveEffectivePackName(ctx.tgId, draft.customTitle, { fallbackQuery: draft.setTitle });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🔄 READY TO CLONE PACK',
      draft.setTitle
    ])));
    b.divider();
    b.table(kvTable([
      ['📦 Source Pack', `${draft.setTitle} (${draft.count} items)`],
      ['🎭 Source Kind', draft.stickerType],
      ['🏷 Your New Title', defaultTitle]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('✏️ Customize New Name', encodeCallback(id, 'clone_ren'))
    ]);
    b.buttons([
      richButton.callback('✨ Clone as Custom Emojis', encodeCallback(id, 'clone_go', 'custom_emoji'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('🏷 Clone as 512px Stickers', encodeCallback(id, 'clone_go', 'regular'), { style: 'primary' })
    ]);
    b.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function executeClone(ctx, targetKind = 'custom_emoji') {
    const draft = cloneDrafts.get(ctx.tgId);
    if (!draft?.shortName) return openHub(ctx);
    cloneDrafts.delete(ctx.tgId);
    await ctx.sm.reset(ctx.tgId, { reason: 'cloning' });

    const api = getApi(ctx);
    const tracker = new ProgressTracker({ api, chatId: ctx.chatId, messageId: ctx.messageId, action: 'upload_photo' });
    await tracker.live((st) => {
      const pb = new RichMessageBuilder();
      pb.heading('🔄 CLONING & RE-PACKING...', 3);
      pb.blockquote(`${st.label || 'Cloning pack...'}\nProgress: ${st.done || 0} / ${st.total || draft.count}`);
      return pb.toJSON();
    }, { label: 'Downloading pack...', done: 0, total: draft.count });

    try {
      const res = await ceService.cloneAndRenamePack({
        userId: ctx.tgId,
        shortName: draft.shortName,
        targetTitle: draft.customTitle || ceService.resolveEffectivePackName(ctx.tgId, null, { fallbackQuery: draft.setTitle }),
        targetKind,
        onProgress: (info) => tracker.set({ label: `Stage: ${info.stage || 'cloning'}...`, done: info.done || 0, total: info.total || draft.count })
      });
      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '✅ PACK CLONED',
        res.title
      ])));
      b.divider();
      b.table(kvTable([
        ['🏷 New Title', res.title],
        ['🔢 Items', String(res.count)],
        ['🔗 Install', res.link]
      ]), { compact: true });
      b.divider();
      b.buttons([
        richButton.url(targetKind === 'regular' ? '🏷 Open Sticker Pack' : '✨ Open Custom Emojis', res.link, { style: 'success' }),
        richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
    } catch (err) {
      const eb = new RichMessageBuilder();
      eb.heading('✕ Clone Failed', 3);
      eb.blockquote(err?.message || 'Could not clone that pack.');
      eb.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
      eb.validate();
      await tracker.finish(eb.toJSON());
    }
  }

  // ── Reverse HD Export Flow (Emoji / Sticker -> HD Media) ─────────────

  async function openReverseMenu(ctx) {
    const prefs = getExportPrefs(ctx.tgId);
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_REVERSE, {
      context: { format: prefs.format, size: prefs.size },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🖼 EMOJI / STICKER → HD MEDIA',
      'xbr + lanczos + sharpening enhancer'
    ])));
    b.divider();
    b.table(kvTable([
      ['📦 Output Mode', EXPORT_FORMAT_LABELS[prefs.format] || prefs.format],
      ['📐 HD Scale', `${prefs.size}×${prefs.size}`]
    ]), { compact: true });
    b.divider();
    b.blockquote(
      'Send ANY of these to enhance & export in crisp HD:\n' +
      '• One or multiple inline custom emojis in a message (✨🔥🥹)\n' +
      '• Any sticker (static WebP, video WebM, .tgs)\n' +
      '• A photo/sticker album\n' +
      '• A pack link (exports the pack in HD!)'
    );
    b.divider();
    b.buttons([
      richButton.callback(`🔄 Output: ${prefs.format.toUpperCase()}`, encodeCallback(id, 'tg_fmt', 'rev')),
      richButton.callback(`📐 Size: ${prefs.size}px`, encodeCallback(id, 'tg_sz', 'rev'))
    ]);
    b.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function deliverHdMediaBatch(ctx, items, { title = 'HD Export' } = {}) {
    const api = getApi(ctx);
    const prefs = getExportPrefs(ctx.tgId);
    const configuredFfmpeg = app.settings?.get?.('media.ffmpegPath') ?? '';

    const tracker = new ProgressTracker({ api, chatId: ctx.chatId, action: 'upload_document' });
    await tracker.live((st) => {
      const pb = new RichMessageBuilder();
      pb.heading('✨ HD ENHANCEMENT & EXPORT', 3);
      pb.blockquote(`${title}\nUpscaling with edge-sharpening & noise cleanup (${st.done || 0}/${st.total || items.length})...`);
      return pb.toJSON();
    }, { done: 0, total: items.length });

    try {
      const results = new Array(items.length).fill(null);
      let done = 0;
      let cursor = 0;
      const hdWorkers = Math.min(6, Math.max(1, items.length));
      await Promise.all(
        Array.from({ length: hdWorkers }, async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= items.length) break;
            const raw = await downloadInputEntry(items[idx], api);
            const origBuf = raw.sourceSha256 ? app.media?.cache?.read?.(raw.sourceSha256) : null;
            const out = await toHdMediaFromEmoji(raw.buffer, {
              outputFormat: prefs.format,
              targetSize: prefs.size,
              originalSourceBuffer: origBuf,
              configuredFfmpeg
            });
            results[idx] = { ...out, emoji: raw.emoji?.[0] || '✨' };
            done++;
            tracker.set({ done, total: items.length });
          }
        })
      );
      const validResults = results.filter(Boolean);

      const docs = validResults.filter((r) => r.mediaKind === 'document');
      const photos = validResults.filter((r) => r.mediaKind === 'photo');
      const videos = validResults.filter((r) => r.mediaKind === 'video');
      const gifs = validResults.filter((r) => r.mediaKind === 'animation');

      // Deliver documents/photos in clean album chunks <=10
      const sendGroupChunks = async (arr, type) => {
        for (let i = 0; i < arr.length; i += 10) {
          const chunk = arr.slice(i, i + 10);
          if (chunk.length === 1) {
            const single = chunk[0];
            if (type === 'photo') await api.sendPhoto(ctx.chatId, single.buffer, { filename: single.filename, contentType: 'image/jpeg' });
            else if (type === 'video') await api.sendVideo(ctx.chatId, single.buffer, { filename: single.filename, width: single.width, height: single.height });
            else if (type === 'animation') await api.sendAnimation(ctx.chatId, single.buffer, { filename: single.filename });
            else await api.sendDocument(ctx.chatId, single.buffer, { filename: single.filename, contentType: single.filename.endsWith('.tgs') ? 'application/x-tgsticker' : 'image/png', disable_content_type_detection: false });
          } else if (type === 'animation') {
            for (const g of chunk) await api.sendAnimation(ctx.chatId, g.buffer, { filename: g.filename });
          } else {
            const files = {};
            const media = chunk.map((it, idx) => {
              const key = `f_${idx}`;
              files[key] = { buffer: it.buffer, filename: `${idx + 1}_${it.filename}` };
              return { type, media: `attach://${key}`, ...(type === 'video' ? { width: it.width, height: it.height } : {}) };
            });
            await api.sendMediaGroup(ctx.chatId, media, {}, files);
          }
        }
      };

      if (docs.length) await sendGroupChunks(docs, 'document');
      if (photos.length) await sendGroupChunks(photos, 'photo');
      if (videos.length) await sendGroupChunks(videos, 'video');
      if (gifs.length) await sendGroupChunks(gifs, 'animation');

      const fb = new RichMessageBuilder();
      fb.heading(`✅ Exported ${results.length} HD Media File(s)`, 3);
      fb.blockquote(`${title} • Resolution: up to ${prefs.size}px`);
      fb.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
      fb.validate();
      await tracker.finish(fb.toJSON());
    } catch (err) {
      const eb = new RichMessageBuilder();
      eb.heading('✕ HD Export Failed', 3);
      eb.blockquote(err?.message || 'Failed to upscale items.');
      eb.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
      eb.validate();
      await tracker.finish(eb.toJSON());
    }
  }

  // ── Pack Name & HD Settings Screen ───────────────────────────────────

  async function renderSettingsScreen(ctx) {
    const cfg = ceService.getPackNameConfig(ctx.tgId);
    const owner = isOwner(ctx);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '⚙ CUSTOM EMOJI SETTINGS',
      'pack names & hd enhancer'
    ])));
    b.divider();
    b.table(kvTable([
      ['👑 Bot Global Default', cfg.globalDefault || '(auto template)'],
      ['👤 Your Personal Default', cfg.userOverride ?? '(using bot default)'],
      ['🏷 Active Pack Title', cfg.effective],
      ['✨ Auto HD Sharpen', cfg.autoEnhance ? 'ON ✓' : 'OFF'],
      ['📐 Smart Margin Trim', cfg.smartBorderTrim ? 'ON ✓' : 'OFF'],
      ['🖼 Reverse HD Format', `${cfg.hdExportFormat} (${cfg.hdExportSize}px)`]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('✏️ Set My Default Name', encodeCallback(id, 'cfg_usr'), { style: 'primary' }),
      ...(cfg.userOverride !== null ? [richButton.callback('🔄 Reset to Bot Default', encodeCallback(id, 'cfg_rst'))] : [])
    ]);
    if (owner) {
      b.buttons([
        richButton.callback('👑 Set Bot Global Default', encodeCallback(id, 'cfg_glb'), { style: 'success' })
      ]);
    }
    b.buttons([
      richButton.callback(`✨ HD Sharpen: ${cfg.autoEnhance ? 'ON' : 'OFF'}`, encodeCallback(id, 'tg_enh')),
      richButton.callback(`📐 Smart Trim: ${cfg.smartBorderTrim ? 'ON' : 'OFF'}`, encodeCallback(id, 'tg_trim'))
    ]);
    b.buttons([
      richButton.callback(`🔄 Export: ${cfg.hdExportFormat.toUpperCase()}`, encodeCallback(id, 'tg_fmt', 'cfg')),
      richButton.callback(`📐 Size: ${cfg.hdExportSize}px`, encodeCallback(id, 'tg_sz', 'cfg'))
    ]);
    b.buttons([richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  // ── Smart Custom Emoji ID Extractor & System Catalog ─────────────────

  function groupHint(ctx) {
    return Number(ctx?.chatId) < 0
      ? '\n💡 In group chats, reply directly to this message so the bot reads your emojis cleanly.'
      : '';
  }

  function toInlineKeyboard(rows = []) {
    return {
      inline_keyboard: rows
        .filter((row) => Array.isArray(row) && row.length > 0)
        .map((row) =>
          row.map((btn) => {
            const item = { text: String(btn.text || '') };
            if (btn.callback_data) item.callback_data = btn.callback_data;
            if (btn.url) item.url = btn.url;
            if (btn.style) item.style = btn.style;
            return item;
          })
        )
    };
  }

  async function openEmojiIdPrompt(ctx) {
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_ID_INPUT, {
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const stats = registry?.getStats?.() || { totalIds: 0, distinctEmojis: 0 };
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🆔 SMART EMOJI ID EXTRACTOR',
      `${stats.totalIds} custom IDs indexed across ${stats.distinctEmojis} emojis`
    ])));
    b.divider();
    b.blockquote(
      'Send or forward ANY message in one shot:\n' +
      '• One or multiple inline custom emojis in text/caption\n' +
      '• A Telegram custom-emoji sticker\n' +
      '• A pack link (t.me/addemoji/... or t.me/addstickers/...)\n' +
      '• Or send normal emojis (e.g. 🤨 ❤️‍🩹 😡) to preview matching system custom emojis!' +
      groupHint(ctx)
    );
    b.divider();
    b.buttons([
      richButton.callback('🪄 Suggest Emojis', encodeCallback(id, 'suggest_open'), { style: 'primary' }),
      richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function collectCustomEmojiEntriesFromMessage(message, api, tgId) {
    const { customEmojis, packLinks } = extractCustomEmojiInputsFromMessage(message);
    const byId = new Map();

    for (const ce of customEmojis) {
      byId.set(ce.customEmojiId, {
        customEmojiId: ce.customEmojiId,
        unicodeEmoji: ce.emoji || '✨',
        setName: ce.setName || null,
        fileId: ce.fileId || null,
        isVideo: Boolean(ce.isVideo),
        isAnimated: Boolean(ce.isAnimated)
      });
    }

    // Hydrate unresolved entity IDs in chunks of 200
    const missingIds = [...byId.values()]
      .filter((e) => !e.fileId || !e.setName)
      .map((e) => e.customEmojiId);
    if (missingIds.length && api?.getCustomEmojiStickers) {
      const resolvedMap = await resolveEmojiMetadataChunked(api, missingIds);
      for (const [ceId, st] of resolvedMap) {
        const prev = byId.get(ceId) || { customEmojiId: ceId };
        byId.set(ceId, {
          customEmojiId: ceId,
          unicodeEmoji: st.emoji || prev.unicodeEmoji || '✨',
          setName: st.set_name || prev.setName || null,
          fileId: st.file_id || prev.fileId || null,
          isVideo: Boolean(st.is_video ?? prev.isVideo),
          isAnimated: Boolean(st.is_animated ?? prev.isAnimated)
        });
      }
    }

    // Pull full custom_emoji packs when user sends t.me/addemoji/... or addstickers/...
    for (const shortName of packLinks.slice(0, 3)) {
      try {
        const set = await api?.getStickerSet?.(shortName);
        if (!set?.stickers?.length) continue;
        registry?.registerPackSet?.(set, { userId: tgId, source: 'extracted' });
        for (const st of set.stickers) {
          if (!st?.custom_emoji_id) continue;
          const ceId = String(st.custom_emoji_id);
          byId.set(ceId, {
            customEmojiId: ceId,
            unicodeEmoji: st.emoji || '✨',
            setName: set.name || st.set_name || shortName,
            fileId: st.file_id || null,
            isVideo: Boolean(st.is_video),
            isAnimated: Boolean(st.is_animated)
          });
        }
      } catch {}
    }

    return [...byId.values()];
  }

  async function processEmojiIdMessage(ctx, message, { fallbackToSuggest = true } = {}) {
    const api = getApi(ctx);
    const chatId = ctx.chatId ?? message?.chat?.id ?? ctx.tgId;
    if (!message || !api?.sendMessage) return false;

    const entries = await collectCustomEmojiEntriesFromMessage(message, api, ctx.tgId);

    if (entries.length > 0) {
      registry?.upsertCatalogEntries?.(
        entries.map((e) => ({
          ...e,
          source: 'extracted',
          addedBy: ctx.tgId
        }))
      );

      const tok = makeToken();
      putLru(idBatches, tok, { tgId: ctx.tgId, entries, createdAt: Date.now() }, 100);

      const formattedLines = entries.map((e, idx) => {
        const safeId = escapeHtml(e.customEmojiId);
        const safeEmoji = escapeHtml(e.unicodeEmoji || '✨');
        const kindBadge = e.isAnimated ? ' ✨TGS' : (e.isVideo ? ' 🎬VID' : '');
        const packBadge = e.setName ? ` • <i>@${escapeHtml(e.setName)}</i>` : '';
        return {
          text: `${idx + 1}. <tg-emoji emoji-id="${safeId}">${safeEmoji}</tg-emoji> <code>${safeId}</code>${kindBadge}${packBadge}`,
          entities: 1
        };
      });

      const chunks = chunkFormattedLines(formattedLines, { maxEntities: 80, maxChars: 3300 });
      const rawMap = Object.fromEntries(entries.slice(0, 60).map((e) => [e.unicodeEmoji || '✨', e.customEmojiId]));
      const jsonSnippet = `<blockquote expandable><b>💻 Dev JSON Map${entries.length > 60 ? ' (first 60)' : ''}:</b>\n<code>${escapeHtml(JSON.stringify(rawMap, null, 2))}</code></blockquote>`;

      for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;
        const header = isFirst
          ? `🆔 <b>CUSTOM EMOJI IDs (${entries.length})</b>\n<i>✅ Saved to system catalog — ready for conflict-free conversion or code</i>\n\n`
          : `🆔 <b>CUSTOM EMOJI IDs (Part ${i + 1}/${chunks.length})</b>\n\n`;
        const footer = isLast ? `\n\n${jsonSnippet}` : '';
        const html = `${header}${chunks[i].map((l) => l.text).join('\n')}${footer}`;

        await api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          ...(isLast
            ? {
                reply_markup: toInlineKeyboard([
                  [
                    richButton.callback(`✨ Add All to Pack (${entries.length})`, encodeCallback(id, 'id_to_tray', tok), { style: 'success' }),
                    richButton.callback('🖼 Export All HD', encodeCallback(id, 'id_to_hd', tok), { style: 'primary' })
                  ],
                  [
                    richButton.callback('🆔 Extract More', encodeCallback(id, 'emoji_id')),
                    richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
                  ]
                ])
              }
            : {})
        });
      }
      return true;
    }

    const rawText = String(message.text || message.caption || '').trim();
    const { customEmojis } = extractCustomEmojiInputsFromMessage(message);
    if (fallbackToSuggest && rawText && !customEmojis.length) {
      const unicodeList = extractUnicodeEmojis(rawText, []);
      if (unicodeList.length > 0) {
        return suggestFromMessage(ctx, message, { sourceHint: 'id_fallback' });
      }
    }

    await api.sendMessage(
      chatId,
      `<blockquote>ℹ️ No Telegram custom emoji IDs or <code>t.me/addemoji/...</code> links found in that message.\nSend custom emojis directly, forward a custom-emoji sticker, or send normal Unicode emojis like 🤨 ❤️‍🩹 😡!</blockquote>`,
      {
        parse_mode: 'HTML',
        reply_markup: toInlineKeyboard([
          [
            richButton.callback('🪄 Suggest Emojis', encodeCallback(id, 'suggest_open')),
            richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
          ]
        ])
      }
    );
    return true;
  }

  async function transferIdBatchToTray(ctx, token, { mode = 'tray' } = {}) {
    const batch = idBatches.get(token);
    const api = getApi(ctx);
    if (!batch?.entries?.length) {
      await ctx.api?.answerCallbackQuery?.(ctx.query?.id, {
        text: 'That extracted batch expired — send the custom emojis again!',
        showAlert: true
      })?.catch?.(() => {});
      return openEmojiIdPrompt(ctx);
    }

    // Resolve any entries missing a fileId before downloading/converting
    const unresolved = batch.entries.filter((e) => !e.fileId).map((e) => e.customEmojiId);
    const hydrated = unresolved.length && api?.getCustomEmojiStickers
      ? await resolveEmojiMetadataChunked(api, unresolved)
      : new Map();

    const trayItems = [];
    for (const entry of batch.entries) {
      const st = hydrated.get(entry.customEmojiId);
      const fileId = entry.fileId || st?.file_id;
      if (!fileId) continue;
      trayItems.push({
        kind: 'file',
        fileId,
        fileUniqueId: st?.file_unique_id || null,
        customEmojiId: entry.customEmojiId,
        isVideo: Boolean(entry.isVideo || st?.is_video),
        isAnimated: Boolean(entry.isAnimated || st?.is_animated),
        emoji: [entry.unicodeEmoji || st?.emoji || '✨'],
        setName: entry.setName || st?.set_name || null,
        sourceTag: 'custom_emoji'
      });
    }

    if (!trayItems.length) {
      await api?.sendMessage?.(
        ctx.chatId,
        '<blockquote>✕ Could not download backing files for those custom emoji IDs.</blockquote>',
        { parse_mode: 'HTML' }
      );
      return openHub(ctx);
    }

    if (mode === 'hd') {
      return deliverHdMediaBatch(ctx, trayItems, { title: `HD Export (${trayItems.length} Custom Emojis)` });
    }

    let tray = trays.get(ctx.tgId);
    if (!tray) {
      tray = {
        mode: 'create',
        packId: null,
        title: ceService.resolveEffectivePackName(ctx.tgId),
        items: []
      };
      trays.set(ctx.tgId, tray);
    }
    appendTrayUnique(tray, trayItems);
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_COLLECT, {
      context: { mode: tray.mode, packId: tray.packId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    return renderTray(ctx, tray);
  }

  // ── Standard Unicode -> Custom Emoji Suggestion + Remix Engine ───────

  async function openSuggestPrompt(ctx) {
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_SUGGEST_INPUT, {
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const stats = registry?.getStats?.() || { totalIds: 0, distinctEmojis: 0 };
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🪄 CUSTOM EMOJI SUGGESTER',
      `${stats.totalIds} custom variants ready across ${stats.distinctEmojis} emojis`
    ])));
    b.divider();
    b.blockquote(
      'Send ANY normal Unicode emojis (one line or stacked), for example:\n\n' +
      '🤨\n❤️‍🩹\n😡\n\n' +
      'I will match each one cleanly to an indexed custom emoji from the system — with 🎲 Remix to cycle variants & 🆔 Get IDs for devs!' +
      groupHint(ctx)
    );
    b.divider();
    b.buttons([
      richButton.callback('🆔 Get Emoji ID', encodeCallback(id, 'emoji_id'), { style: 'primary' }),
      richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  function renderSuggestChunkHtml(items, { remixNotice = null } = {}) {
    const matchedCount = items.filter((it) => it.candidates.length > 0).length;
    const lines = items.map((it) => {
      if (!it.candidates.length) {
        return `${escapeHtml(it.emoji)} — <i>no custom emoji indexed yet</i>`;
      }
      const cand = it.candidates[it.index % it.candidates.length];
      const safeId = escapeHtml(cand.customEmojiId);
      const safeGlyph = escapeHtml(cand.unicodeEmoji || it.emoji);
      const countNote = it.candidates.length > 1
        ? ` <i>(${(it.index % it.candidates.length) + 1}/${it.candidates.length})</i>`
        : '';
      return `${escapeHtml(it.emoji)} — <tg-emoji emoji-id="${safeId}">${safeGlyph}</tg-emoji>${countNote}`;
    });

    const noticeHtml = remixNotice ? `<blockquote>ℹ️ ${escapeHtml(remixNotice)}</blockquote>\n` : '';
    const header = `🪄 <b>CUSTOM EMOJI SUGGESTIONS (${matchedCount}/${items.length})</b>\n`;
    const footer = matchedCount < items.length
      ? '\n\n<i>💡 Tip: Index more packs via 🆔 Get Emoji ID or /emojipack to unlock missing emojis!</i>'
      : '';
    return `${noticeHtml}${header}\n${lines.join('\n')}${footer}`;
  }

  async function suggestFromMessage(ctx, message, { silentIfEmpty = false } = {}) {
    const api = getApi(ctx);
    const chatId = ctx.chatId ?? message?.chat?.id ?? ctx.tgId;
    if (!message || !api?.sendMessage) return false;

    const rawText = String(message.text || message.caption || '');
    const customRanges = [
      ...(Array.isArray(message.entities) ? message.entities : []),
      ...(Array.isArray(message.caption_entities) ? message.caption_entities : [])
    ]
      .filter((e) => e?.type === 'custom_emoji')
      .map((e) => ({ offset: e.offset, length: e.length }));

    const unicodeList = extractUnicodeEmojis(rawText, customRanges);
    if (!unicodeList.length) {
      if (!silentIfEmpty) {
        await api.sendMessage(
          chatId,
          '<blockquote>ℹ️ Send normal Unicode emojis like 🤨 ❤️‍🩹 😡 to see matching custom emojis from the system!</blockquote>',
          { parse_mode: 'HTML' }
        );
      }
      return false;
    }

    const sessionItems = unicodeList.map((u) => {
      const candidates = registry?.lookupCandidates?.(u.emoji, { limit: 40 }) || [];
      if (candidates[0]?.customEmojiId) {
        registry?.recordUsage?.(candidates[0].customEmojiId);
      }
      return {
        emoji: u.emoji,
        key: u.key,
        candidates,
        index: 0
      };
    });

    // Respect Telegram's custom_emoji entity cap & character ceiling per message
    const chunkItemsList = [];
    let current = [];
    let currentEntities = 0;
    let currentChars = 220;

    for (const item of sessionItems) {
      const addEnt = item.candidates.length > 0 ? 1 : 0;
      const estChars = 75 + item.emoji.length;
      if (current.length > 0 && (currentEntities + addEnt > 80 || currentChars + estChars > 3500)) {
        chunkItemsList.push(current);
        current = [];
        currentEntities = 0;
        currentChars = 220;
      }
      current.push(item);
      currentEntities += addEnt;
      currentChars += estChars;
    }
    if (current.length) chunkItemsList.push(current);

    for (let i = 0; i < chunkItemsList.length; i++) {
      const chunkItems = chunkItemsList[i];
      const tok = makeToken();
      putLru(suggestSessions, tok, {
        tgId: ctx.tgId,
        chatId,
        items: chunkItems,
        createdAt: Date.now()
      }, 150);

      const partTag = chunkItemsList.length > 1 ? `<i>Part ${i + 1}/${chunkItemsList.length}</i>\n` : '';
      const html = `${partTag}${renderSuggestChunkHtml(chunkItems)}`;
      await api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: toInlineKeyboard([
          [
            richButton.callback('🎲 Remix', encodeCallback(id, 'sug_rmx', tok), { style: 'primary' }),
            richButton.callback('🆔 Get IDs', encodeCallback(id, 'sug_id', tok), { style: 'success' })
          ],
          [
            richButton.callback('✨ Emoji Studio', encodeCallback(id, 'open')),
            richButton.callback('🆔 Extract Emoji IDs', encodeCallback(id, 'emoji_id'))
          ]
        ])
      });
    }
    return true;
  }

  async function handleSuggestRemix(ctx, token) {
    const api = getApi(ctx);
    const session = suggestSessions.get(token);
    if (!session?.items?.length) {
      await api?.answerCallbackQuery?.(ctx.query?.id, {
        text: 'Suggestion session expired — send your emojis again!',
        showAlert: true
      })?.catch?.(() => {});
      return openSuggestPrompt(ctx);
    }

    let changed = 0;
    for (const item of session.items) {
      if (item.candidates.length > 1) {
        item.index = (item.index + 1) % item.candidates.length;
        const picked = item.candidates[item.index];
        if (picked?.customEmojiId) registry?.recordUsage?.(picked.customEmojiId);
        changed += 1;
      }
    }

    const markup = toInlineKeyboard([
      [
        richButton.callback('🎲 Remix', encodeCallback(id, 'sug_rmx', token), { style: 'primary' }),
        richButton.callback('🆔 Get IDs', encodeCallback(id, 'sug_id', token), { style: 'success' })
      ],
      [
        richButton.callback('✨ Emoji Studio', encodeCallback(id, 'open')),
        richButton.callback('🆔 Extract Emoji IDs', encodeCallback(id, 'emoji_id'))
      ]
    ]);

    if (changed > 0) {
      const html = renderSuggestChunkHtml(session.items);
      await api?.answerCallbackQuery?.(ctx.query?.id, {
        text: `🎲 Remixed ${changed} emoji${changed > 1 ? 's' : ''}!`
      })?.catch?.(() => {});
      if (ctx.messageId && api?.editMessageText) {
        await api.editMessageText(ctx.chatId, ctx.messageId, html, {
          parse_mode: 'HTML',
          reply_markup: markup
        }).catch(async () => {
          await api.sendMessage(ctx.chatId, html, { parse_mode: 'HTML', reply_markup: markup });
        });
      } else {
        await api.sendMessage(ctx.chatId, html, { parse_mode: 'HTML', reply_markup: markup });
      }
      return true;
    }

    // No alternative variant available -> resend old custom emoji(s) & explicitly tell user
    await api?.answerCallbackQuery?.(ctx.query?.id, {
      text: 'No new custom emoji variant found — resending current suggestion(s).'
    })?.catch?.(() => {});
    const resendHtml = renderSuggestChunkHtml(session.items, {
      remixNotice: 'No new custom emoji variant found in the system — resending previous suggestion(s).'
    });
    await api.sendMessage(ctx.chatId, resendHtml, {
      parse_mode: 'HTML',
      reply_markup: markup
    });
    return true;
  }

  async function handleSuggestGetIds(ctx, token) {
    const api = getApi(ctx);
    const session = suggestSessions.get(token);
    if (!session?.items?.length) {
      await api?.answerCallbackQuery?.(ctx.query?.id, {
        text: 'Suggestion session expired — send your emojis again!',
        showAlert: true
      })?.catch?.(() => {});
      return openSuggestPrompt(ctx);
    }

    const activeEntries = [];
    for (const item of session.items) {
      if (!item.candidates.length) continue;
      const cand = item.candidates[item.index % item.candidates.length];
      if (!cand?.customEmojiId) continue;
      activeEntries.push({
        customEmojiId: cand.customEmojiId,
        unicodeEmoji: item.emoji,
        setName: cand.setName || null,
        fileId: cand.fileId || null,
        isVideo: Boolean(cand.isVideo),
        isAnimated: Boolean(cand.isAnimated)
      });
    }

    if (!activeEntries.length) {
      await api?.answerCallbackQuery?.(ctx.query?.id, {
        text: 'No indexed custom IDs in this batch yet.',
        showAlert: true
      })?.catch?.(() => {});
      return true;
    }

    const batchTok = makeToken();
    putLru(idBatches, batchTok, { tgId: ctx.tgId, entries: activeEntries, createdAt: Date.now() }, 100);

    const lines = activeEntries.map((e) => {
      const safeId = escapeHtml(e.customEmojiId);
      const safeGlyph = escapeHtml(e.unicodeEmoji);
      const setTag = e.setName ? ` • <i>@${escapeHtml(e.setName)}</i>` : '';
      return `${safeGlyph} <tg-emoji emoji-id="${safeId}">${safeGlyph}</tg-emoji> → <code>${safeId}</code>${setTag}`;
    });

    const jsonMap = Object.fromEntries(activeEntries.map((e) => [e.unicodeEmoji, e.customEmojiId]));
    const htmlTags = activeEntries
      .map((e) => `<tg-emoji emoji-id="${e.customEmojiId}">${e.unicodeEmoji}</tg-emoji>`)
      .join('\n');

    const devBlock =
      `<blockquote expandable><b>💻 Dev JSON &amp; HTML Tags:</b>\n` +
      `<code>${escapeHtml(JSON.stringify(jsonMap, null, 2))}</code>\n\n` +
      `<code>${escapeHtml(htmlTags)}</code></blockquote>`;

    const html = `🆔 <b>SUGGESTION EMOJI IDs (${activeEntries.length})</b>\n\n${lines.join('\n')}\n\n${devBlock}`;
    await api?.answerCallbackQuery?.(ctx.query?.id)?.catch?.(() => {});
    await api.sendMessage(ctx.chatId, html, {
      parse_mode: 'HTML',
      reply_markup: toInlineKeyboard([
        [
          richButton.callback(`✨ Add to Pack Tray`, encodeCallback(id, 'id_to_tray', batchTok), { style: 'success' }),
          richButton.callback('🎲 Remix Suggestions', encodeCallback(id, 'sug_rmx', token), { style: 'primary' })
        ],
        [
          richButton.callback('◀ Studio Home', encodeCallback(id, 'open'))
        ]
      ])
    });
    return true;
  }

  // ── State Machine Message Handlers ───────────────────────────────────

  function registerStateHandlers(sm) {
    sm.register(States.CUSTOM_EMOJI_COLLECT, {
      onMessage: async (sctx, rawMessage) => {
        const message = rawMessage?.message || rawMessage;
        if (!message) return false;
        const msgChatId = message.chat?.id ?? message.chatId ?? sctx.chatId;
        const api = getApi({ api: app.telegram?.api, ...sctx });
        const tray = trays.get(sctx.tgId);
        if (!tray) return false;

        // Pack link pasted inside Staging Tray -> unpack all stickers into tray conflict-free
        const text = String(message.text || message.caption || '').trim();
        const linkPack = text && !text.startsWith('/') ? extractTelegramPackName(text) : null;
        if (linkPack && !message.sticker && !message.photo && !message.video) {
          await api?.sendChatAction?.(msgChatId, 'typing');
          const fetched = await downloadPackDescriptors(linkPack, api, MAX_TRAY_ITEMS - tray.items.length).catch(() => null);
          if (fetched?.items?.length) {
            appendTrayUnique(tray, fetched.items);
            await renderTray({ tgId: sctx.tgId, chatId: msgChatId, api, editScreen: (r) => api.sendRichMessage(msgChatId, r) }, tray);
            return true;
          }
        }

        const handleSingleOrAlbum = async (msgs) => {
          const added = [];
          for (const m of msgs) {
            const extracted = await extractInputsFromMessage(m, api);
            added.push(...extracted);
          }
          if (!added.length) return false;
          appendTrayUnique(tray, added);
          await renderTray({ tgId: sctx.tgId, chatId: msgChatId, api, editScreen: (r) => api.sendRichMessage(msgChatId, r) }, tray);
          return true;
        };

        if (message.media_group_id) {
          albumCollector.push({
            chatId: msgChatId,
            userId: sctx.tgId,
            mediaGroupId: message.media_group_id,
            message,
            onFlush: handleSingleOrAlbum
          });
          return true;
        }

        return handleSingleOrAlbum([message]);
      },
      onCleanup: async (sctx) => {
        trays.delete(sctx.tgId);
      },
      onTimeout: async (sctx) => {
        trays.delete(sctx.tgId);
      }
    });

    sm.register(States.CUSTOM_EMOJI_REVERSE, {
      onMessage: async (sctx, rawMessage) => {
        const message = rawMessage?.message || rawMessage;
        if (!message) return false;
        const msgChatId = message.chat?.id ?? message.chatId ?? sctx.chatId;
        const api = getApi({ api: app.telegram?.api, ...sctx });
        const text = String(message.text || message.caption || '').trim();
        const linkPack = text && !text.startsWith('/') ? extractTelegramPackName(text) : null;

        const runExport = async (msgs) => {
          const batch = [];
          for (const m of msgs) {
            const ext = await extractInputsFromMessage(m, api);
            batch.push(...ext);
          }
          if (!batch.length) return false;
          await deliverHdMediaBatch({ tgId: sctx.tgId, chatId: msgChatId, api }, batch, { title: 'Custom Emoji / Sticker HD Export' });
          return true;
        };

        if (linkPack && !message.sticker && !message.photo && !message.video) {
          const fetched = await downloadPackDescriptors(linkPack, api, 50).catch(() => null);
          if (fetched?.items?.length) {
            await deliverHdMediaBatch(
              { tgId: sctx.tgId, chatId: msgChatId, api },
              fetched.items,
              { title: fetched.set?.title || linkPack }
            );
            return true;
          }
        }

        if (message.media_group_id) {
          albumCollector.push({
            chatId: msgChatId,
            userId: sctx.tgId,
            mediaGroupId: message.media_group_id,
            message,
            onFlush: runExport
          });
          return true;
        }

        return runExport([message]);
      },
      onCleanup: async () => {},
      onTimeout: async () => {}
    });

    sm.register(States.CUSTOM_EMOJI_ID_INPUT, {
      onMessage: async (sctx, rawMessage) => {
        const message = rawMessage?.message || rawMessage;
        if (!message) return false;
        const msgChatId = message.chat?.id ?? message.chatId ?? sctx.chatId;
        const api = getApi({ api: app.telegram?.api, ...sctx });
        return processEmojiIdMessage({ tgId: sctx.tgId, chatId: msgChatId, api, sm }, message, { fallbackToSuggest: true });
      },
      onCleanup: async () => {},
      onTimeout: async () => {}
    });

    sm.register(States.CUSTOM_EMOJI_SUGGEST_INPUT, {
      onMessage: async (sctx, rawMessage) => {
        const message = rawMessage?.message || rawMessage;
        if (!message) return false;
        const msgChatId = message.chat?.id ?? message.chatId ?? sctx.chatId;
        const api = getApi({ api: app.telegram?.api, ...sctx });
        return suggestFromMessage({ tgId: sctx.tgId, chatId: msgChatId, api, sm }, message, { silentIfEmpty: false });
      },
      onCleanup: async () => {},
      onTimeout: async () => {}
    });

    sm.register(States.CUSTOM_EMOJI_INPUT, {
      onMessage: async (sctx, rawMessage) => {
        const message = rawMessage?.message || rawMessage;
        if (!message) return false;
        const msgChatId = message.chat?.id ?? message.chatId ?? sctx.chatId;
        const api = getApi({ api: app.telegram?.api, ...sctx });
        const prompt = textPrompts.get(sctx.tgId);
        if (!prompt) return false;
        const text = String(message.text || message.caption || '').trim();
        const fakeCtx = {
          tgId: sctx.tgId,
          chatId: msgChatId,
          api,
          sm,
          editScreen: (r) => api.sendRichMessage(msgChatId, r)
        };

        if (prompt.kind === 'clone_source') {
          let shortName = extractTelegramPackName(text) || message.sticker?.set_name || null;
          if (!shortName) {
            const ext = await extractInputsFromMessage(message, api);
            shortName = ext.find((e) => e.setName)?.setName || null;
          }
          if (!shortName) {
            await api.sendMessage(msgChatId, '<blockquote>✕ Could not find a pack link, sticker, or custom emoji pack from that message.</blockquote>', { parse_mode: 'HTML' });
            return true;
          }
          const srcSet = await api.getStickerSet(shortName).catch(() => null);
          if (!srcSet?.stickers?.length) {
            await api.sendMessage(msgChatId, '<blockquote>✕ That Telegram pack could not be loaded.</blockquote>', { parse_mode: 'HTML' });
            return true;
          }
          textPrompts.delete(sctx.tgId);
          const draft = {
            shortName,
            setTitle: srcSet.title || shortName,
            count: srcSet.stickers.length,
            stickerType: srcSet.sticker_type || 'regular',
            customTitle: null
          };
          cloneDrafts.set(sctx.tgId, draft);
          await renderClonePreview(fakeCtx, draft);
          return true;
        }

        if (prompt.kind === 'clone_rename') {
          const draft = cloneDrafts.get(sctx.tgId);
          textPrompts.delete(sctx.tgId);
          if (draft && text) draft.customTitle = cleanTgTitle(text);
          if (draft) await renderClonePreview(fakeCtx, draft);
          return true;
        }

        if (prompt.kind === 'tray_title') {
          textPrompts.delete(sctx.tgId);
          const tray = trays.get(sctx.tgId);
          if (tray && text) {
            tray.title = cleanTgTitle(text);
            await sm.transition(sctx.tgId, States.CUSTOM_EMOJI_COLLECT, { chatId: msgChatId });
            await renderTray(fakeCtx, tray);
          }
          return true;
        }

        if (prompt.kind === 'rename_pack' && prompt.packId) {
          textPrompts.delete(sctx.tgId);
          if (!text) return true;
          await ceService.renamePackTitle({ userId: sctx.tgId, packId: prompt.packId, newTitle: text });
          await sm.reset(sctx.tgId, { reason: 'renamed' });
          await renderPackDetail(fakeCtx, String(prompt.packId));
          return true;
        }

        if (prompt.kind === 'cfg_user_name') {
          textPrompts.delete(sctx.tgId);
          if (text) app.settings?.setForUser?.(sctx.tgId, 'customEmoji.defaultPackName', cleanTgTitle(text));
          await sm.reset(sctx.tgId, { reason: 'cfg' });
          await renderSettingsScreen(fakeCtx);
          return true;
        }

        if (prompt.kind === 'cfg_global_name') {
          textPrompts.delete(sctx.tgId);
          if (text) app.settings?.set?.('customEmoji.defaultPackName', cleanTgTitle(text));
          await sm.reset(sctx.tgId, { reason: 'cfg' });
          await renderSettingsScreen(fakeCtx);
          return true;
        }

        if (prompt.kind === 'del_item' && prompt.packId) {
          const pack = packService.getPack(sctx.tgId, prompt.packId);
          if (!pack) {
            textPrompts.delete(sctx.tgId);
            return true;
          }
          let targetFileId = message.sticker?.file_id || null;
          if (!targetFileId) {
            const ext = await extractInputsFromMessage(message, api);
            targetFileId = ext[0]?.fileId || null;
          }
          if (!targetFileId && /^\d+$/.test(text)) {
            const idx = Math.max(0, Number(text) - 1);
            const set = await api.getStickerSet(pack.shortName).catch(() => null);
            targetFileId = set?.stickers?.[idx]?.file_id || null;
          }
          if (!targetFileId) {
            await api.sendMessage(msgChatId, '<blockquote>✕ Forward an item from that pack or send its #number (e.g. 3).</blockquote>', { parse_mode: 'HTML' });
            return true;
          }
          textPrompts.delete(sctx.tgId);
          await ceService.deletePackItem({ userId: sctx.tgId, packId: pack.id, fileId: targetFileId });
          await sm.reset(sctx.tgId, { reason: 'item-deleted' });
          await renderPackDetail(fakeCtx, String(pack.id));
          return true;
        }

        return false;
      },
      onCleanup: async (sctx) => {
        textPrompts.delete(sctx.tgId);
      },
      onTimeout: async (sctx) => {
        textPrompts.delete(sctx.tgId);
      }
    });
  }

  // ── Command & Reply Shortcuts ────────────────────────────────────────

  async function handleCommand(ctx, args = [], { reverseMode = false, idMode = false, suggestMode = false, replyMessage = null } = {}) {
    const api = getApi(ctx);
    const argText = args.join(' ').trim();

    if (idMode) {
      if (replyMessage) {
        return processEmojiIdMessage(ctx, replyMessage, { fallbackToSuggest: true });
      }
      if (argText) {
        const inlineMsg = ctx.message
          ? { ...ctx.message }
          : { text: argText, chat: { id: ctx.chatId } };
        return processEmojiIdMessage(ctx, inlineMsg, { fallbackToSuggest: true });
      }
      return openEmojiIdPrompt(ctx);
    }

    if (suggestMode) {
      if (replyMessage) {
        return suggestFromMessage(ctx, replyMessage, { silentIfEmpty: false });
      }
      if (argText) {
        const inlineMsg = {
          text: argText,
          chat: ctx.message?.chat || { id: ctx.chatId }
        };
        return suggestFromMessage(ctx, inlineMsg, { silentIfEmpty: false });
      }
      return openSuggestPrompt(ctx);
    }

    if (replyMessage) {
      const items = await extractInputsFromMessage(replyMessage, api);
      if (items.length > 0) {
        if (reverseMode) {
          return deliverHdMediaBatch(ctx, items, { title: 'HD Export from Reply' });
        }
        const tray = {
          mode: 'create',
          packId: null,
          title: ceService.resolveEffectivePackName(ctx.tgId, argText || null),
          items: []
        };
        appendTrayUnique(tray, items);
        trays.set(ctx.tgId, tray);
        await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_COLLECT, { chatId: ctx.chatId });
        return renderTray(ctx, tray);
      }
      const replyLink = extractTelegramPackName(String(replyMessage.text || replyMessage.caption || ''));
      if (replyLink) {
        return handlePackArg(ctx, replyLink, { reverseMode });
      }
    }

    if (argText) {
      const linkPack = extractTelegramPackName(argText);
      if (linkPack) return handlePackArg(ctx, linkPack, { reverseMode });
      if (reverseMode) return openReverseMenu(ctx);
      return startNewPackTray(ctx, { packTitle: argText });
    }

    if (reverseMode) return openReverseMenu(ctx);
    return openHub(ctx);
  }

  async function handlePackArg(ctx, shortName, { reverseMode = false } = {}) {
    const api = getApi(ctx);
    if (reverseMode) {
      const fetched = await downloadPackDescriptors(shortName, api, 50);
      if (!fetched?.items?.length) return openReverseMenu(ctx);
      return deliverHdMediaBatch(ctx, fetched.items, { title: fetched.set?.title || shortName });
    }
    const srcSet = await api.getStickerSet(shortName).catch(() => null);
    if (!srcSet?.stickers?.length) return startClonePrompt(ctx);
    const draft = {
      shortName,
      setTitle: srcSet.title || shortName,
      count: srcSet.stickers.length,
      stickerType: srcSet.sticker_type || 'regular',
      customTitle: null
    };
    cloneDrafts.set(ctx.tgId, draft);
    return renderClonePreview(ctx, draft);
  }

  // ── Callback Dispatcher ──────────────────────────────────────────────

  async function promptInput(ctx, kind, heading, body, extra = {}) {
    textPrompts.set(ctx.tgId, { kind, ...extra });
    await ctx.sm.transition(ctx.tgId, States.CUSTOM_EMOJI_INPUT, {
      context: { kind, ...extra },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading(heading, 3);
    b.blockquote(body);
    b.buttons([richButton.callback('✕ Cancel', encodeCallback(id, 'open'))]);
    b.validate();
    return renderOrSend(ctx, b.toJSON());
  }

  async function handle(ctx, action, args = []) {
    const api = getApi(ctx);
    switch (action) {
      case 'open':
      case 'home':
        trays.delete(ctx.tgId);
        textPrompts.delete(ctx.tgId);
        return openHub(ctx);
      case 'new':
        return startNewPackTray(ctx);
      case 'tray_add':
        return startAddToPackTray(ctx, args[0]);
      case 'tray_name':
        return promptInput(ctx, 'tray_title', '✏️ CUSTOM EMOJI PACK TITLE', 'Send the pack name (up to 64 chars) you want to use:');
      case 'tray_clr': {
        const tray = trays.get(ctx.tgId);
        if (tray) tray.items = [];
        return tray ? renderTray(ctx, tray) : openHub(ctx);
      }
      case 'tray_go':
        return executeTrayBuild(ctx);
      case 'add_list':
        return renderPackList(ctx, args[0] || '0', 'add_list');
      case 'packs':
        return renderPackList(ctx, args[0] || '0', 'packs');
      case 'pack':
        return renderPackDetail(ctx, args[0]);
      case 'ren':
        return promptInput(ctx, 'rename_pack', '✏️ RENAME EMOJI PACK', 'Send the new pack title (1–64 chars):', { packId: Number(args[0]) });
      case 'del_item':
        return promptInput(
          ctx,
          'del_item',
          '🗑 REMOVE AN EMOJI',
          'Forward/send the exact sticker/emoji from this pack to remove, OR send its #number (e.g. 3):',
          { packId: Number(args[0]) }
        );
      case 'sync': {
        const pack = packService.getPack(ctx.tgId, Number(args[0]));
        if (pack) await packService.syncPackStickersFromTelegram(pack);
        return renderPackDetail(ctx, args[0]);
      }
      case 'del_ask': {
        const pack = packService.getPack(ctx.tgId, Number(args[0]));
        if (!pack) return renderPackList(ctx, '0', 'packs');
        const b = new RichMessageBuilder();
        b.heading('🗑 DELETE EMOJI PACK?', 3);
        b.blockquote(`Delete "${pack.title}" (${pack.count} emojis) from Telegram & your library?`);
        b.buttons([
          richButton.callback('🗑 Yes, Delete', encodeCallback(id, 'del_go', String(pack.id)), { style: 'danger' }),
          richButton.callback('◀ Back', encodeCallback(id, 'pack', String(pack.id)))
        ]);
        b.validate();
        return renderOrSend(ctx, b.toJSON());
      }
      case 'del_go':
        await packService.deletePack(ctx.tgId, Number(args[0]));
        return renderPackList(ctx, '0', 'packs');
      case 'exp_pack': {
        const pack = packService.getPack(ctx.tgId, Number(args[0]));
        if (!pack) return renderPackList(ctx, '0', 'packs');
        const fetched = await downloadPackDescriptors(pack.shortName, api, 50);
        if (!fetched.items.length) return renderPackDetail(ctx, args[0]);
        return deliverHdMediaBatch(ctx, fetched.items, { title: pack.title });
      }
      case 'to_reg': {
        const pack = packService.getPack(ctx.tgId, Number(args[0]));
        if (!pack) return renderPackList(ctx, '0', 'packs');
        const tracker = new ProgressTracker({ api, chatId: ctx.chatId, messageId: ctx.messageId, action: 'upload_photo' });
        await tracker.live((st) => {
          const pb = new RichMessageBuilder();
          pb.heading('🏷 CONVERTING → 512px STICKER PACK', 3);
          pb.blockquote(`Upscaling emojis to 512px stickers (${st.done || 0}/${st.total || pack.count})...`);
          return pb.toJSON();
        }, { done: 0, total: pack.count });
        try {
          const res = await ceService.cloneAndRenamePack({
            userId: ctx.tgId,
            shortName: pack.shortName,
            targetTitle: cleanTgTitle(`${pack.title} Stickers`),
            targetKind: 'regular',
            onProgress: (info) => tracker.set({ done: info.done || 0, total: info.total || pack.count })
          });
          const rb = new RichMessageBuilder();
          rb.paragraph(rt.bold(banner(['✅ STICKER PACK READY', res.title])));
          rb.buttons([
            richButton.url('🏷 Open Sticker Pack', res.link, { style: 'success' }),
            richButton.callback('◀ Back', encodeCallback(id, 'pack', String(pack.id)))
          ]);
          rb.validate();
          await tracker.finish(rb.toJSON());
        } catch (err) {
          const eb = new RichMessageBuilder();
          eb.heading('✕ Conversion Failed', 3);
          eb.blockquote(err?.message || 'Could not convert to regular stickers.');
          eb.buttons([richButton.callback('◀ Back', encodeCallback(id, 'pack', String(pack.id)))]);
          eb.validate();
          await tracker.finish(eb.toJSON());
        }
        return;
      }
      case 'merge_tgt':
        return renderMergeTargetPicker(ctx, args[0] || '0');
      case 'merge_src':
        return renderMergeSourcePicker(ctx, args[0], args[1] || '0');
      case 'merge_ask':
        return renderMergeConfirm(ctx, args[0], args[1]);
      case 'merge_go':
        return executeMerge(ctx, args[0], args[1], args[2] || 'keep');
      case 'clone':
        return startClonePrompt(ctx);
      case 'clone_ren':
        return promptInput(ctx, 'clone_rename', '✏️ NEW CLONED PACK TITLE', 'Send the custom pack title you want for this cloned pack:');
      case 'clone_go':
        return executeClone(ctx, args[0] || 'custom_emoji');
      case 'rev':
        return openReverseMenu(ctx);
      case 'cfg':
        return renderSettingsScreen(ctx);
      case 'cfg_usr':
        return promptInput(ctx, 'cfg_user_name', '✏️ YOUR DEFAULT EMOJI PACK NAME', 'Send your personal default Custom Emoji pack name (other users keep the bot default):');
      case 'cfg_glb':
        if (!isOwner(ctx)) return renderSettingsScreen(ctx);
        return promptInput(ctx, 'cfg_global_name', '👑 BOT GLOBAL DEFAULT PACK NAME', 'Send the global default Custom Emoji pack name used across the bot:');
      case 'cfg_rst':
        app.settings?.resetForUser?.(ctx.tgId, 'customEmoji.defaultPackName');
        return renderSettingsScreen(ctx);
      case 'tg_enh': {
        const cur = app.settings?.getForUser?.(ctx.tgId, 'customEmoji.autoEnhance') ?? true;
        app.settings?.setForUser?.(ctx.tgId, 'customEmoji.autoEnhance', !cur);
        return renderSettingsScreen(ctx);
      }
      case 'tg_trim': {
        const cur = app.settings?.getForUser?.(ctx.tgId, 'customEmoji.smartBorderTrim') ?? true;
        app.settings?.setForUser?.(ctx.tgId, 'customEmoji.smartBorderTrim', !cur);
        return renderSettingsScreen(ctx);
      }
      case 'tg_fmt': {
        const cur = app.settings?.getForUser?.(ctx.tgId, 'customEmoji.hdExportFormat') || 'png_doc';
        const next = EXPORT_FORMATS[(EXPORT_FORMATS.indexOf(cur) + 1) % EXPORT_FORMATS.length];
        app.settings?.setForUser?.(ctx.tgId, 'customEmoji.hdExportFormat', next);
        return args[0] === 'rev' ? openReverseMenu(ctx) : renderSettingsScreen(ctx);
      }
      case 'emoji_id':
        return openEmojiIdPrompt(ctx);
      case 'suggest_open':
        return openSuggestPrompt(ctx);
      case 'id_to_tray':
        return transferIdBatchToTray(ctx, args[0], { mode: 'tray' });
      case 'id_to_hd':
        return transferIdBatchToTray(ctx, args[0], { mode: 'hd' });
      case 'sug_rmx':
        return handleSuggestRemix(ctx, args[0]);
      case 'sug_id':
        return handleSuggestGetIds(ctx, args[0]);
      case 'post_ch': {
        const pack = packService.getPack(ctx.tgId, Number(args[0]));
        const chPost = ctx.screens?.get?.('channel_post') || app.screens?.get?.('channel_post');
        if (pack && chPost?.openWithPack) {
          return chPost.openWithPack(ctx, pack);
        }
        return renderPackDetail(ctx, args[0]);
      }
      case 'tg_sz': {
        const sizes = [512, 720, 1024];
        const cur = Number(app.settings?.getForUser?.(ctx.tgId, 'customEmoji.hdExportSize') || 1024);
        const next = sizes[(sizes.indexOf(cur) + 1) % sizes.length];
        app.settings?.setForUser?.(ctx.tgId, 'customEmoji.hdExportSize', next);
        return args[0] === 'rev' ? openReverseMenu(ctx) : renderSettingsScreen(ctx);
      }
      default:
        return openHub(ctx);
    }
  }

  return {
    id,
    open: openHub,
    handle,
    handleCommand,
    registerStateHandlers,
    suggestFromMessage,
    processEmojiIdMessage,
    hasPendingAlbum(chatId, userId, mediaGroupId) {
      return albumCollector.has({ chatId, userId, mediaGroupId });
    },
    cleanup() {
      albumCollector.clearAll();
    }
  };
}
