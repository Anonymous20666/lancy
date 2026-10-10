import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, packCard, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { resolveLimits } from '../../stickers/limits.js';
import { LancyError } from '../../core/errors.js';
import { formatDateTime, truncate } from '../../utils/text.js';
import { sha256Hex } from '../../utils/hash.js';
import { extractTelegramPackName } from '../../stickers/packNaming.js';

/**
 * TG Stickers screen + pack creation flows.
 *
 *   TG Stickers → Pinterest → Sticker → count → source → deep search →
 *   live conversion/creation progress → completion card
 *
 *   TG Stickers → Add Sticker (manual) → count → collect images →
 *   partial-collection handling → convert → completion card
 *
 *   My Packs → paginated cards → Add Stickers / Open / Details
 */
export function createStickersScreen({ app }) {
  const id = 'stickers';
    const manualCollectors = new Map(); // tgId -> { wanted, collected: [{fileId, sha256}], messageIds: [] }

  // ── Menu ────────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 TG STICKERS 𓆩♡𓆪',
      'turn aesthetic media into sticker packs ♡'
    ])));
    b.divider();
    b.buttons([
      richButton.callback('✦ Pinterest → Sticker', encodeCallback(id, 'p2s'), { style: 'primary' }),
      richButton.callback('🖼 Manual Image Selection', encodeCallback(id, 'manual'))
    ]);
    b.buttons([
      richButton.callback('📥 Adopt / Clone TG Pack', encodeCallback(id, 'clonePack'), { style: 'primary' }),
      richButton.callback('➕ Add to Existing Pack', encodeCallback(id, 'addExisting'))
    ]);
    b.buttons([
      richButton.callback('📚 My Packs', encodeCallback(id, 'packs'))
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    const limits = resolveLimits(ctx.settings, 'static');
    b.footer(rt.italic(`telegram packs hold up to ${limits.perSet} stickers ♡`));
    b.validate();
    return b.toJSON();
  }

  async function editOrSend(ctx, rich, files = null) {
    if (typeof ctx?.editScreen === 'function') {
      return ctx.editScreen(rich, {}, files);
    }
    const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.from?.id ?? ctx?.tgId;
    const messageId = ctx?.message?.message_id ?? ctx?.messageId ?? ctx?.sm?.context?.(ctx?.tgId)?.screenMessageId;
    if (messageId && chatId) {
      try {
        return await app.telegram.api.editMessageRich(chatId, messageId, rich, {}, files);
      } catch (err) {
        if (!/message is not modified/i.test(err?.message)) {
          return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
        }
        return;
      }
    }
    if (chatId) {
      return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
    }
  }

  async function openMenu(ctx) {
    await editOrSend(ctx, renderMenu(ctx));
  }

  // ── Pinterest → Sticker ─────────────────────────────────────────────────
  async function startPinterestToSticker(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PINTEREST → STICKER 𓆩♡𓆪',
      'smart media pack creation ♡'
    ])));
    b.divider();
    b.paragraph(rt.italic('choose what type of stickers to create:'));
    b.buttons([
      richButton.callback('🖼 Images Only', encodeCallback(id, 'p2sMode', 'images'), { style: 'primary' }),
      richButton.callback('🎬 Videos Only', encodeCallback(id, 'p2sMode', 'videos'), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: true, home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askP2SCount(ctx, mode = 'normal') {
    const isVideo = mode === 'videos';
    const b = new RichMessageBuilder();
    b.heading(isVideo ? '🎬 VIDEO STICKER AMOUNT' : '✨ STICKER PACK AMOUNT', 2);
    b.paragraph(rt.italic(`how many stickers should your ${mode} pack have? ♡`));
    b.divider();
    b.table(kvTable([
      ['Media type', mode],
      ['Set capacity', isVideo ? '50 per video set' : '120 per static set'],
      ['Default', String(isVideo ? 15 : (ctx.settings.get('stickers.defaultStickerAmount') ?? 60))]
    ]), { compact: true });
    b.divider();

    if (isVideo) {
      b.buttons([
        richButton.callback('5', encodeCallback(id, 'p2sCount', 5, mode)),
        richButton.callback('10', encodeCallback(id, 'p2sCount', 10, mode)),
        richButton.callback('15', encodeCallback(id, 'p2sCount', 15, mode)),
        richButton.callback('20', encodeCallback(id, 'p2sCount', 20, mode))
      ]);
    } else {
      b.buttons([
        richButton.callback('10', encodeCallback(id, 'p2sCount', 10, mode)),
        richButton.callback('20', encodeCallback(id, 'p2sCount', 20, mode)),
        richButton.callback('30', encodeCallback(id, 'p2sCount', 30, mode)),
        richButton.callback('50', encodeCallback(id, 'p2sCount', 50, mode))
      ]);
      b.buttons([
        richButton.callback('60', encodeCallback(id, 'p2sCount', 60, mode)),
        richButton.callback('80', encodeCallback(id, 'p2sCount', 80, mode)),
        richButton.callback('100', encodeCallback(id, 'p2sCount', 100, mode)),
        richButton.callback('120', encodeCallback(id, 'p2sCount', 120, mode))
      ]);
      b.buttons([
        richButton.callback('130 (+10)', encodeCallback(id, 'p2sCount', 130, mode)),
        richButton.callback('140 (+20)', encodeCallback(id, 'p2sCount', 140, mode)),
        richButton.callback('150 (+30)', encodeCallback(id, 'p2sCount', 150, mode))
      ]);
    }
    b.buttons([
      richButton.callback('✎ Custom Amount', encodeCallback(id, 'p2sCustom', mode)),
      richButton.callback('« Back', encodeCallback(id, 'p2s'))
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askQueryForPack(ctx, count, mode = 'normal') {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id;
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
      context: { flow: 'p2s', count, mode, packFlow: true, screenMessageId: screenMsgId },
      chatId: ctx.chatId,
      screenMessageId: screenMsgId
    });
    const b = new RichMessageBuilder();
    b.heading('✦ SEARCH PINTEREST FOR PACK', 2);
    b.table(kvTable([
      ['Target count', `${count} stickers`],
      ['Media type', mode]
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('what should I search on Pinterest? ♡'));
    b.paragraph(rt.concat(rt.text('example: '), rt.code('gojo satoru')));
    b.divider();
    b.buttons([
      richButton.callback('« Back', encodeCallback(id, 'p2sMode', mode)),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  /**
   * Create or update pack directly from previously fetched search media,
   * detecting which images the user kept on their screen (skipping deleted ones).
   */
  async function makePackFromSearchMedia(ctx, searchId) {
    const userId = Number(ctx.tgId);
    const api = app.telegram.api;
    const chatId = ctx.chatId;
    const settings = app.settings;

    try {
      const searchRow = app.pinterest.db.get(
        'SELECT * FROM pinterest_searches WHERE id = ?',
        searchId
      );
      if (!searchRow) {
        const b = new RichMessageBuilder();
        b.heading('🎀 SEARCH EXPIRED', 2);
        b.paragraph(rt.italic('that search is no longer available — please run a new search ♡'));
        b.divider();
        b.buttons([
          richButton.callback('🔍 Search Pinterest', encodeCallback('pinterest', 'search'), { style: 'primary' }),
          richButton.callback('« Back to Stickers', encodeCallback(id, 'open'), { style: 'primary' })
        ]);
        b.validate();
        await editOrSend(ctx, b.toJSON());
        return;
      }
      const query = searchRow.query ?? 'stickers';

      // Check media in database for this search
      const allMediaRows = app.pinterest.db.all(
        `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
         ORDER BY quality_score DESC`,
        searchId
      );

      if (!allMediaRows.length) {
        const b = new RichMessageBuilder();
        b.heading('🎀 NO MEDIA FOUND', 2);
        b.paragraph(rt.italic('no valid media found for that search — try searching again ♡'));
        b.divider();
        b.buttons([
          richButton.callback('🔍 Search Pinterest', encodeCallback('pinterest', 'search'), { style: 'primary' }),
          richButton.callback('« Back to Stickers', encodeCallback(id, 'open'), { style: 'primary' })
        ]);
        b.validate();
        await editOrSend(ctx, b.toJSON());
        return;
      }

      // Check whether this search was for video stickers or image stickers
      const isVideoSearch = searchRow.mode === 'videos' || allMediaRows.every((r) => r.type === 'video');
      const stickerType = isVideoSearch ? 'video' : 'static';
      const mediaRows = isVideoSearch
        ? allMediaRows.filter((r) => r.type === 'video')
        : allMediaRows.filter((r) => r.type !== 'video');

      const usableRows = mediaRows.length > 0 ? mediaRows : allMediaRows;

      // Check which sent preview photos are still on the user's screen!
      // If the user deleted specific photos from their chat, exclude them!
      const activeMedia = [];
      for (const row of usableRows) {
        if (row.tg_message_id) {
          let isAlive = true;
          try {
            await api.call('editMessageReplyMarkup', {
              chat_id: chatId,
              message_id: row.tg_message_id,
              reply_markup: { inline_keyboard: [] }
            });
          } catch (err) {
            if (/message to edit not found/i.test(String(err?.message))) {
              isAlive = false; // User deleted this photo from their chat!
            }
          }
          if (isAlive) {
            activeMedia.push(row);
          }
        } else {
          activeMedia.push(row);
        }
      }

      const targetMedia = activeMedia.length > 0 ? activeMedia : usableRows;
      const count = targetMedia.length;

      // DO NOT reuse existing screen message (which is the Pinterest search results media)
      // Send a fresh progress tracker message so the user's search photos stay intact!
      const tracker = new ProgressTracker({ api, chatId, messageId: null, heartbeatMs: 2000 });
      await tracker.live((state, { elapsedMs }) => packProgressRich({ ...state, elapsedMs }), {
        stage: 'downloading', count, query, mode: isVideoSearch ? 'videos' : 'normal', total: count, done: 0
      });

      try {
        // Load buffers for targetMedia
        const descriptors = [];
        let idx = 0;
        for (const row of targetMedia) {
          let buffer = app.media.cache.read(row.sha256);
          if (!buffer) {
            buffer = await app.media.download(row.media_url, { signal: undefined }).catch(() => null);
          }
          if (buffer) {
            descriptors.push({
              pinId: row.pin_id ?? `p-${row.id}`,
              mediaUrl: row.media_url,
              type: row.type ?? (stickerType === 'video' ? 'video' : 'image'),
              sha256: row.sha256,
              phash: row.phash,
              mime: row.mime,
              width: row.width,
              height: row.height,
              size: row.size,
              buffer
            });
          }
          idx++;
          tracker.set({ stage: 'downloading', count, query, mode: isVideoSearch ? 'videos' : 'normal', done: idx, total: count });
        }

        if (!descriptors.length) {
          throw new LancyError('♡ No usable media found on your screen — please run a new search ♡', { code: 'NO_PHOTOS' });
        }

        // Always create a fresh pack for this search; auto-splits into Part 1 & Part 2 if count > 120 (or > 50 for video)
        const result = await app.packs.createPackFromMedia({
          userId,
          query,
          descriptors,
          stickerType,
          onProgress: (info) => {
            if (info.stage === 'converting') {
              tracker.set({ stage: 'converting', count: descriptors.length, query, mode: isVideoSearch ? 'videos' : 'normal', done: info.done, total: info.total });
            } else if (info.stage === 'creating') {
              tracker.set({ stage: 'creating', count: descriptors.length, query, mode: isVideoSearch ? 'videos' : 'normal', done: 0, total: descriptors.length });
            } else if (info.stage === 'adding') {
              tracker.set({ stage: 'adding', count: descriptors.length, query, mode: isVideoSearch ? 'videos' : 'normal', done: info.done, total: info.total });
            }
          }
        });

        app.pinterest.markResultsDelivered(userId, searchId, descriptors);
        app.db.audit(userId, 'pack.created', { packId: result.packId, query, count: result.count });

        await ctx.sm.transition(ctx.tgId, States.IDLE, { context: {}, chatId, pushHistory: false });
        await tracker.finish(completionRich(settings, result, {
          duplicates: 0,
          query,
          extraPacks: result.extraPacks ?? []
        }));
      } catch (error) {
        await tracker.finish(packErrorRich(error));
        await ctx.sm.reset(ctx.tgId, { reason: 'pack-failed' });
      }
    } catch (outerError) {
      const b = new RichMessageBuilder();
      b.heading('🎀 PACK CREATION FAILED', 2);
      b.paragraph(rt.italic(`♡ Could not create pack: ${outerError?.message ?? 'error'} ♡`));
      b.divider();
      b.buttons([richButton.callback('« Back to Stickers', encodeCallback(id, 'open'), { style: 'primary' })]);
      b.validate();
      await editOrSend(ctx, b.toJSON()).catch(() => {});
    }
  }

  /**
   * The pack creation pipeline: deep search → dedupe → convert →
   * createNewStickerSet → addStickerToSet → DB. ONE live progress message.
   */
  async function createPackFromSearch(sctx, query) {
    const rawCount = Number(sctx.context?.count) || 60;
    const mode = sctx.context?.mode ?? 'normal';
    const isVideo = mode === 'videos';
    const count = isVideo ? Math.min(20, Math.max(1, rawCount)) : Math.max(1, Math.min(150, rawCount));
    const userId = Number(sctx.tgId);
    const api = app.telegram.api;
    const chatId = sctx.chatId;
    const settings = app.settings;

    const tracker = new ProgressTracker({ api, chatId, heartbeatMs: 2000 });
    await tracker.live((state, { elapsedMs }) => packProgressRich({ ...state, elapsedMs }), {
      stage: 'searching', count, query, mode
    });

    try {
      // 1. Deep search (deduped, ranked).
      const search = await app.queues.add('pinterest', {
        type: 'pinterest-search',
        userId,
        payload: { query, count, mode },
        run: async (job, qctx) => app.pinterest.search({
          userId, query, mode, depth: settings.get('pinterest.searchDepth') ?? 'deep',
          goal: count,
          signal: qctx.signal,
          onProgress: (p) => tracker.set({ stage: p.stage ?? 'searching', count, query, mode, ...p })
        })
      }, { attempts: 2 });

      const unique = search.results.slice(0, count);
      if (unique.length === 0) {
        throw new LancyError('♡ I could not find any usable media for that search.', { code: 'NO_RESULTS' });
      }

      // 2. Convert + create with live progress.
      await sctx.transition(States.PACK_CREATION, {
        context: { ...sctx.context, searchId: search.searchId, packQuery: query, mode },
        chatId
      });

      const stickerType = isVideo ? 'video' : 'static';

      const result = await app.queues.add('stickers', {
        type: 'create-pack',
        userId,
        payload: { query, count: unique.length, stickerType },
        run: async (job, qctx) => {
          // Progress: converting → creating → adding.
          const onProgress = (info) => {
            if (info.stage === 'converting') {
              tracker.set({ stage: 'converting', count, query, mode, done: info.done, total: info.total, found: search.results.length, unique: unique.length });
            } else if (info.stage === 'creating') {
              tracker.set({ stage: 'creating', count, query, mode, found: search.results.length, unique: unique.length });
            } else if (info.stage === 'adding') {
              tracker.set({ stage: 'adding', count, query, mode, done: info.done, total: info.total, found: search.results.length, unique: unique.length });
            }
          };
          const pack = await app.packs.createPackFromMedia({
            userId,
            query,
            descriptors: unique,
            stickerType,
            onProgress
          });
          return pack;
        }
      }, { attempts: 1, signal: undefined });

      // 3. Mark delivered (no-duplicate guarantee) + persist.
      app.pinterest.markResultsDelivered(userId, search.searchId, unique);
      app.db.audit(userId, 'pack.created', { packId: result.packId, query, count: result.count });

      await sctx.transition(States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(completionRich(settings, result, { duplicates: search.stats.duplicatesFound, query, extraPacks: result.extraPacks }));
    } catch (error) {
      await tracker.finish(packErrorRich(error));
      await sctx.reset({ reason: 'pack-failed' });
    }
  }

  // ── Manual image selection ──────────────────────────────────────────────
  async function startManual(ctx) {
    const b = new RichMessageBuilder();
    b.heading('🖼 MANUAL IMAGE SELECTION', 1);
    b.paragraph(rt.italic('how many stickers do you want? ♡'));
    b.divider();
    const limits = resolveLimits(ctx.settings, 'static');
    for (let i = 0; i < [10, 20, 30, 50, 100, 120].filter((n) => n <= limits.perSet).length; i += 3) {
      const row = [10, 20, 30, 50, 100, 120].filter((n) => n <= limits.perSet).slice(i, i + 3);
      b.buttons(row.map((n) => richButton.callback(String(n), encodeCallback(id, 'manualCount', n))));
    }
    b.buttons([richButton.callback('✎ Custom', encodeCallback(id, 'manualCustom'))]);
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function beginCollection(ctx, count) {
    const collector = { wanted: count, collected: [], messageIds: [], counterMessageId: null };
    manualCollectors.set(ctx.tgId, collector);
    await ctx.sm.transition(ctx.tgId, States.MANUAL_STICKER_COLLECTION, {
      context: { wanted: count, collected: [] },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SEND YOUR IMAGES 𓆩♡𓆪',
      `needed: ${count} photos`
    ])));
    b.divider();
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Needed', align: 'left', valign: 'middle' },
        { text: rt.bold(String(count)), align: 'right', valign: 'middle' }
      ],
      [
        { text: '˙ᵕ˙ Collected', align: 'left', valign: 'middle' },
        { text: rt.bold('0'), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();
    b.paragraph(rt.bold(`₊˚⊹♡ send me ${count} images bestie!`), rt.text('\n૮꒰ ˶• ༝ •˶꒱ა I will wait — take your time ♡'));
    b.buttons([
      richButton.callback('✓ Convert What I Sent', encodeCallback(id, 'manualConvert'), { style: 'success' }),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    const sent = await editOrSend(ctx, b.toJSON());
    if (sent?.message_id) {
      collector.counterMessageId = sent.message_id;
      ctx.sm.update(ctx.tgId, { screenMessageId: sent.message_id });
    }
  }

  async function onManualPhoto(sctx, message) {
    const collector = manualCollectors.get(sctx.tgId);
    if (!collector) return false;
    const photo = message.photo?.[message.photo.length - 1];
    const fileId = photo?.file_id ?? message.document?.file_id;
    if (!fileId) return false;

    // Delete user photo message if messageCleanup is enabled to keep chat tidy
    if (message.message_id && app.settings.get('telegram.messageCleanup')) {
      await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
    }

    if (collector.collected.length >= collector.wanted) {
      return true;
    }
    collector.collected.push({ fileId, messageId: message.message_id });
    collector.messageIds.push(message.message_id);
    sctx.update({ collectedCount: collector.collected.length });

    if (collector.collected.length >= collector.wanted) {
      await convertManual(sctx);
      return true;
    }

    // In-place aesthetic gothic counter update — NO SPAM!
    const remaining = collector.wanted - collector.collected.length;
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 COLLECTING IMAGES 𓆩♡𓆪',
      `progress: ${collector.collected.length} / ${collector.wanted}`
    ])));
    b.divider();
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Collected', align: 'left', valign: 'middle' },
        { text: rt.bold(`${collector.collected.length} / ${collector.wanted}`), align: 'right', valign: 'middle' }
      ],
      [
        { text: '˙ᵕ˙ Needed', align: 'left', valign: 'middle' },
        { text: rt.bold(`${remaining} more`), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();
    b.paragraph(rt.bold(`˙ᵕ˙ Send ${remaining} more ${remaining === 1 ? 'image' : 'images'} or tap convert below!`), rt.text('\n૮꒰ ˶• ༝ •˶꒱ა waiting for your drops ♡'));
    b.buttons([
      richButton.callback('✓ Convert What I Sent', encodeCallback(id, 'manualConvert'), { style: 'success' }),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();

    const targetMsgId = collector.counterMessageId ?? sctx.screenMessageId;
    if (targetMsgId) {
      await app.telegram.api.editMessageRich(sctx.chatId, targetMsgId, b.toJSON()).catch(async (err) => {
        if (/not modified/i.test(String(err?.message))) return;
        const sent = await app.telegram.api.sendRichMessage(sctx.chatId, b.toJSON()).catch(() => {});
        if (sent?.message_id) {
          collector.counterMessageId = sent.message_id;
          sctx.update({ screenMessageId: sent.message_id });
        }
      });
    } else {
      const sent = await app.telegram.api.sendRichMessage(sctx.chatId, b.toJSON()).catch(() => {});
      if (sent?.message_id) {
        collector.counterMessageId = sent.message_id;
        sctx.update({ screenMessageId: sent.message_id });
      }
    }
    return true;
  }

  async function convertManual(sctx) {
    const collector = manualCollectors.get(sctx.tgId);
    if (!collector || collector.collected.length === 0) return;
    const userId = Number(sctx.tgId);
    const api = app.telegram.api;
    const chatId = sctx.chatId;

    const tracker = new ProgressTracker({ api, chatId, messageId: collector.counterMessageId ?? sctx.screenMessageId });
    await tracker.start(packProgressRich({ stage: 'converting', count: collector.collected.length, query: 'manual selection' }));

    try {
      // Download each image, validate, dedupe, convert.
      const descriptors = [];
      for (let i = 0; i < collector.collected.length; i++) {
        const { fileId } = collector.collected[i];
        const buffer = await app.stickerService.downloadSticker(fileId);
        const descriptor = await app.media.process({
          url: null, pinId: `manual-${userId}-${i}`, mediaUrl: `tgfile://${fileId}`, typeHint: 'image'
        }, { userId }).catch(async () => {
          // process() downloads from URL; for Telegram files we validate directly.
          const { validateMedia } = await import('../../media/validate.js');
          const { probeImage, hashBundle } = await import('../../media/convert.js');
          const validation = await validateMedia(buffer, { expectedType: 'image', probe: probeImage });
          const { sha256, phash } = await hashBundle(buffer);
          const verdict = app.media.dedup.check(userId, { sha256, phash, mediaUrl: `tgfile://${fileId}` });
          app.media.cache.store(buffer, { mime: validation.mime, width: validation.width, height: validation.height, type: 'image' });
          return {
            pinId: `manual-${userId}-${i}`,
            mediaUrl: `tgfile://${fileId}`,
            type: 'image',
            sha256, phash,
            mime: validation.mime,
            width: validation.width,
            height: validation.height,
            size: validation.size,
            duplicate: verdict.duplicate,
            buffer
          };
        });
        if (!descriptor.duplicate) descriptors.push(descriptor);
        await tracker.update(packProgressRich({ stage: 'converting', count: collector.collected.length, query: 'manual selection', done: i + 1, total: collector.collected.length }));
      }

      if (descriptors.length === 0) {
        throw new LancyError('♡ All of those images were ones I already gave you — send different ones ♡', { code: 'ALL_DUPES' });
      }

      const result = await app.queues.add('stickers', {
        type: 'create-pack',
        userId,
        payload: { source: 'manual', count: descriptors.length },
        run: async (job, qctx) => app.packs.createPackFromMedia({
          userId,
          query: 'manual selection',
          descriptors,
          stickerType: 'static',
          onProgress: (info) => {
            if (info.stage === 'converting') tracker.update(packProgressRich({ stage: 'converting', count: descriptors.length, query: 'manual selection', done: info.done, total: info.total }));
            else if (info.stage === 'adding') tracker.update(packProgressRich({ stage: 'adding', count: descriptors.length, query: 'manual selection', done: info.done, total: info.total }));
          }
        })
      }, { attempts: 1 });

      app.db.audit(userId, 'pack.created', { packId: result.packId, source: 'manual', count: result.count });
      await sctx.transition(States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(completionRich(app.settings, result, { duplicates: collector.collected.length - descriptors.length, query: 'manual selection' }));
    } catch (error) {
      await tracker.finish(packErrorRich(error));
      await sctx.reset({ reason: 'manual-failed' });
    } finally {
      // Clean up temporary collection state.
      manualCollectors.delete(sctx.tgId);
    }
  }

  // ── My Packs ─────────────────────────────────────────────────────────────
  async function showPacks(ctx, page = 0, keyword = '') {
    const pageSize = ctx.settings.get('telegram.paginationSize') ?? 5;
    const trimmed = (keyword ?? '').trim();
    const { packs, total } = app.packs.listPacks(Number(ctx.tgId), { limit: pageSize, offset: page * pageSize, query: trimmed });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const b = new RichMessageBuilder();
    b.heading(trimmed ? `📚 MY PACKS ("${truncate(trimmed, 18)}")` : '📚 MY PACKS', 1);
    b.paragraph(rt.italic(trimmed
      ? `found ${total} pack${total === 1 ? '' : 's'} matching "${truncate(trimmed, 20)}" • page ${page + 1}/${totalPages}`
      : `${total} pack${total === 1 ? '' : 's'} in library • page ${page + 1}/${totalPages}`
    ));
    b.divider();
    if (!packs.length) {
      b.paragraph(rt.italic(trimmed ? `no packs found matching "${trimmed}" ♡` : 'no packs yet ♡ make one from Pinterest or your own images.'));
    }
    for (const pack of packs) {
      const card = packCard(pack, { timeZone: ctx.settings.get('general.timezone') });
      b.raw(card.blocks);
      b.buttons([
        richButton.callback('➕ Add Stickers', encodeCallback(id, 'packAdd', pack.id), { style: 'primary' }),
        richButton.url('♡ Open', pack.link, { style: 'primary' }),
        richButton.callback('ℹ Details', encodeCallback(id, 'packDetails', pack.id), { style: 'primary' })
      ]);
      b.divider();
    }
    if (trimmed) {
      b.buttons([
        richButton.callback('🔎 Search Another', encodeCallback(id, 'searchPacksPrompt'), { style: 'primary' }),
        richButton.callback('✕ Clear Search', encodeCallback(id, 'packs'), { style: 'primary' })
      ]);
    } else {
      b.buttons([
        richButton.callback('🔎 Search Packs', encodeCallback(id, 'searchPacksPrompt'), { style: 'primary' })
      ]);
      if (packs.length > 0) {
        b.buttons([
          richButton.callback('🧹 Clear All Packs', encodeCallback(id, 'clearAllPacksConfirm'), { style: 'danger' })
        ]);
      }
    }
    const navRow = [];
    if (page > 0) navRow.push(richButton.callback('← Prev', encodeCallback(id, 'packsPage', String(page - 1), trimmed), { style: 'primary' }));
    navRow.push(richButton.callback(`${page + 1} / ${totalPages}`, encodeCallback(id, 'noop'), { style: 'primary' }));
    if (page < totalPages - 1) navRow.push(richButton.callback('Next →', encodeCallback(id, 'packsPage', String(page + 1), trimmed), { style: 'primary' }));
    if (navRow.length) b.buttons(navRow);
    b.buttons(navButtons(id, { home: true, back: false }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askPackSearchQuery(ctx) {
    const tgId = String(ctx.tgId);
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? ctx.sm?.for(tgId)?.screenMessageId;
    await ctx.sm.transition(tgId, States.STICKER_COUNT_SELECTION, {
      context: { stage: 'packSearch', screenMessageId: screenMsgId },
      chatId: ctx.chatId,
      screenMessageId: screenMsgId
    });
    const b = new RichMessageBuilder();
    b.heading('🔎 SEARCH YOUR PACKS', 2);
    b.paragraph(rt.italic('send me the pack name or keyword you are looking for ♡'));
    b.paragraph(rt.text('example: '), rt.code('anime'), rt.text(' or '), rt.code('baddie'));
    b.divider();
    b.buttons([
      richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function showPackDetails(ctx, packId) {
    const pack = app.packs.getPack(Number(ctx.tgId), Number(packId));
    if (!pack) {
      const b = new RichMessageBuilder();
      b.heading('📚 PACK NOT FOUND', 2);
      b.paragraph(rt.italic('that sticker pack is no longer in your library ♡'));
      b.divider();
      b.buttons([richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })]);
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} PACK DETAILS`, 2);
    b.table(kvTable([
      ['Name', pack.title],
      ['Short name', pack.shortName],
      ['Created', formatDateTime(new Date(pack.createdAt), ctx.settings.get('general.timezone'))],
      ['Modified', formatDateTime(new Date(pack.modifiedAt), ctx.settings.get('general.timezone'))],
      ['Search', pack.query ?? '—'],
      ['Stickers', String(pack.count)],
      ['Type', pack.stickerType],
      ['Source', pack.source],
      ['Link', pack.link]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('➕ Add Stickers', encodeCallback(id, 'packAdd', pack.id), { style: 'primary' }),
      richButton.url('♡ Open Pack', pack.link, { style: 'primary' }),
      richButton.callback('🗑 Delete Pack', encodeCallback(id, 'packDeleteConfirm', String(pack.id)), { style: 'danger' })
    ]);
    b.buttons([
      richButton.callback('← Back', encodeCallback(id, 'packs'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── State machine handlers ──────────────────────────────────────────────
  function registerStateHandlers(sm) {
    // Pinterest → Sticker: query input reuses PINTEREST_SEARCH, but the
    // completion is routed back here via the packFlow flag.
    sm.register(States.PINTEREST_SEARCH, {
      onMessage: async (sctx, message) => {
        if (!sctx.context.packFlow) return false; // pinterest screen owns it
        const query = (message.text ?? '').trim();
        if (!query) return false;
        await createPackFromSearch(sctx, query);
        return true;
      }
    });

    sm.register(States.STICKER_COUNT_SELECTION, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (message.message_id) {
          await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        if (sctx.context?.stage === 'packSearch') {
          return showPacks(sctx, 0, text);
        }
        const parsed = parseInt(text, 10);
        if (isNaN(parsed) || parsed <= 0) {
          await app.telegram.api.sendMessage(sctx.chatId, '♡ Please send a valid number of stickers (e.g. 20, 60, 120) ♡').catch(() => {});
          return true;
        }
        const count = Math.max(1, Math.min(150, parsed));
        const flow = sctx.context?.flow;
        const mode = sctx.context?.mode || 'normal';
        if (flow === 'manual') {
          return beginCollection(sctx, count);
        }
        return askQueryForPack(sctx, count, mode);
      }
    });

    sm.register(States.MANUAL_STICKER_COLLECTION, {
      onMessage: async (sctx, message) => {
        if (message.photo || (message.document?.mime_type?.startsWith('image/'))) {
          return onManualPhoto(sctx, message);
        }
        if (message.text) {
          await app.telegram.api.sendMessage(sctx.chatId, '♡ Send me images — or press "Convert These" / "Cancel" ♡').catch(() => {});
          return true;
        }
        return false;
      },
      onTimeout: async (sctx) => {
        manualCollectors.delete(sctx.tgId);
        await app.telegram.api.sendMessage(sctx.chatId, '♡ image collection timed out — your images were cleared ♡').catch(() => {});
      },
      onCleanup: (sctx) => {
        manualCollectors.delete(sctx.tgId);
      }
    });

    sm.register(States.STICKER_PACK_CLONE, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (message.message_id) {
          await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        if (!text) return false;
        return handleClonePackMessage(sctx, text);
      }
    });
  }

  // ── Pack Clone & Deletion Helpers ───────────────────────────────────────────
  async function startClonePack(ctx) {
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? ctx.sm?.context?.(ctx.tgId)?.screenMessageId;
    await ctx.sm.transition(ctx.tgId, States.STICKER_PACK_CLONE, {
      context: { step: 'link', screenMessageId: screenMsgId },
      chatId: ctx.chatId,
      screenMessageId: screenMsgId
    });
    const b = new RichMessageBuilder();
    b.heading('📥 ADOPT / CLONE TG PACK', 2);
    b.paragraph(rt.bold('Adopt any Telegram sticker pack into Lancy! ♡'));
    b.paragraph(rt.italic('Send me the link or short name of any public Telegram sticker set:\nexample: https://t.me/addstickers/animestickers'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function handleClonePackMessage(sctx, text) {
    if (sctx.context?.step === 'confirm' || sctx.context?.step === 'title') {
      await sctx.update({
        customTitle: text,
        step: 'confirm'
      });
      return showClonePackConfirm(sctx);
    }

    const packName = extractTelegramPackName(text);

    if (!packName) {
      await app.telegram.api.sendMessage(sctx.chatId, '♡ Please send a valid Telegram sticker pack link or name (e.g. `https://t.me/addstickers/pack_name`)').catch(() => {});
      return true;
    }

    const set = await app.telegram.api.getStickerSet(packName).catch(() => null);
    if (!set || !Array.isArray(set.stickers) || set.stickers.length === 0) {
      await app.telegram.api.sendMessage(sctx.chatId, `✕ Could not find Telegram sticker set "${packName}". Please make sure the link is correct and public ♡`).catch(() => {});
      return true;
    }

    const isVideo = set.stickers.some((s) => s.is_video || s.type === 'video');
    const isAnimated = set.stickers.some((s) => s.is_animated || s.type === 'animated');
    const detectedType = isVideo ? 'video' : 'static';

    const defaultTitle = `ᥫ᭡ʟᴀɴᴄʏ - ${truncate(set.title || packName, 26)}`;
    await sctx.update({
      step: 'confirm',
      sourcePackName: packName,
      sourceTitle: set.title || packName,
      stickerCount: set.stickers.length,
      stickerType: detectedType,
      isAnimated,
      customTitle: defaultTitle
    });

    return showClonePackConfirm(sctx);
  }

  async function showClonePackConfirm(sctx) {
    const ctx_data = (app.telegram?.sm?.context ? app.telegram.sm.context(sctx.tgId) : null) || sctx.context || {};
    const b = new RichMessageBuilder();
    b.heading('📥 CLONE PACK CONFIRMATION', 2);
    b.table(kvTable([
      ['Source Pack', ctx_data.sourceTitle || ctx_data.sourcePackName || '—'],
      ['Stickers Found', String(ctx_data.stickerCount ?? 0)],
      ['Type', ctx_data.stickerType === 'video' ? 'Video' : 'Static'],
      ['New Pack Name', ctx_data.customTitle || '—']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('tap "Clone Now" or reply with a custom pack title to change it ♡'));
    b.buttons([
      richButton.callback('✨ Clone Pack Now', encodeCallback(id, 'clonePackDo'), { style: 'primary' }),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    await editOrSend(sctx, b.toJSON());
    return true;
  }

  async function handleClonePackExecute(ctx) {
    const sctx = ctx.sm.ctxFor(ctx.tgId);
    const ctxData = ctx.sm.context(ctx.tgId) || sctx?.context || {};
    const { sourcePackName, sourceTitle, customTitle, stickerType } = ctxData;

    if (!sourcePackName) {
      return ctx.reply('♡ Clone session expired. Please try again ♡');
    }

    const tracker = new ProgressTracker({
      api: app.telegram.api,
      chatId: ctx.chatId,
      messageId: ctx.screenMessageId ?? ctxData.screenMessageId
    });

    await tracker.start(packProgressRich({ stage: 'searching', count: ctxData.stickerCount, query: sourceTitle }));

    try {
      const set = await app.telegram.api.getStickerSet(sourcePackName);
      if (!set?.stickers?.length) throw new Error('Sticker set is empty');

      const isVideo = set.stickers.some((s) => s.is_video || s.type === 'video');
      const isAnimated = set.stickers.some((s) => s.is_animated || s.type === 'animated');

      const descriptors = [];
      for (let i = 0; i < set.stickers.length; i++) {
        const st = set.stickers[i];
        let fileId = st.file_id;
        // For animated .tgs (Lottie), use the static WebP thumbnail so it converts cleanly
        if (st.is_animated && (st.thumbnail || st.thumb)) {
          fileId = (st.thumbnail || st.thumb).file_id;
        }
        const file = await app.telegram.api.getFile(fileId);
        const buffer = await app.telegram.api.downloadFile(file.file_path);
        descriptors.push({
          buffer,
          emoji: st.emoji ? [st.emoji] : ['🤍'],
          isVideo: !st.is_animated && (st.is_video || isVideo),
          type: (!st.is_animated && (st.is_video || isVideo)) ? 'video' : 'image',
          sha256: sha256Hex(buffer)
        });
        if (i % 5 === 0 || i === set.stickers.length - 1) {
          await tracker.update(packProgressRich({
            stage: 'validating',
            done: i + 1,
            total: set.stickers.length,
            query: sourceTitle
          })).catch(() => {});
        }
      }

      await tracker.update(packProgressRich({ stage: 'converting', count: descriptors.length, query: customTitle }));

      const created = await app.packs.createPackFromMedia({
        userId: Number(ctx.tgId),
        query: 'cloned',
        title: customTitle,
        descriptors,
        stickerType: stickerType ?? 'static',
        onProgress: (p) => tracker.update(packProgressRich({
          stage: p.stage ?? 'converting',
          done: p.done,
          total: p.total,
          query: customTitle
        })).catch(() => {})
      });

      await ctx.sm.cancel(ctx.tgId).catch(() => {});

      const b = new RichMessageBuilder();
      b.heading('✨ PACK CLONED & ADOPTED! ♡', 1);
      b.divider();
      b.paragraph(rt.bold(`✓ Pack "${created.title || customTitle}" is ready on Telegram with ${descriptors.length} stickers!`));
      b.table(kvTable([
        ['Pack Title', created.title || customTitle],
        ['Short Name', created.name],
        ['Total Stickers', String(descriptors.length)],
        ['Status', 'Saved in library & ready for WA Channels ✓']
      ]), { compact: true });
      b.divider();
      b.buttons([
        richButton.url('🔗 Open Sticker Pack', created.link || `https://t.me/addstickers/${created.name}`),
        richButton.callback('📚 My Packs', encodeCallback(id, 'packs'))
      ]);
      b.buttons(navButtons(id, { home: true }));
      b.validate();
      await tracker.finish(b.toJSON());
    } catch (err) {
      await tracker.fail(err.message || String(err));
    }
  }

  async function showPackDeleteConfirm(ctx, packId) {
    const pack = app.packs.getPack(Number(ctx.tgId), Number(packId));
    if (!pack) return showPacks(ctx, 0);

    const b = new RichMessageBuilder();
    b.heading('🗑 DELETE STICKER PACK', 2);
    b.paragraph(rt.bold(`Are you sure you want to delete "${pack.title}"?`));
    b.paragraph(rt.italic('This will remove it from your bot library and WhatsApp posting options ♡'));
    b.divider();
    b.buttons([
      richButton.callback('⚠️ Yes, Delete Pack', encodeCallback(id, 'packDeleteDo', String(pack.id)), { style: 'danger' }),
      richButton.callback('« Cancel', encodeCallback(id, 'packDetails', String(pack.id)), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function handlePackDeleteDo(ctx, packId) {
    await app.packs.deletePack(Number(ctx.tgId), Number(packId));
    const b = new RichMessageBuilder();
    b.heading('✓ PACK DELETED', 2);
    b.paragraph(rt.italic('The sticker pack has been successfully removed ♡'));
    b.divider();
    b.buttons([
      richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function showClearAllPacksConfirm(ctx) {
    const b = new RichMessageBuilder();
    b.heading('🧹 CLEAR ALL PACKS', 2);
    b.paragraph(rt.bold('Are you sure you want to remove ALL your sticker packs?'));
    b.paragraph(rt.italic('This will remove all packs from your library and post list ♡'));
    b.divider();
    b.buttons([
      richButton.callback('⚠️ Yes, Clear All Packs', encodeCallback(id, 'clearAllPacksDo'), { style: 'danger' }),
      richButton.callback('« Cancel', encodeCallback(id, 'packs'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function handleClearAllPacksDo(ctx) {
    const count = await app.packs.clearAllPacks(Number(ctx.tgId));
    const b = new RichMessageBuilder();
    b.heading('✓ ALL PACKS CLEARED', 2);
    b.paragraph(rt.italic(`Removed ${count} sticker pack${count === 1 ? '' : 's'} from your library ♡`));
    b.divider();
    b.buttons([
      richButton.callback('« Back to Stickers', encodeCallback(id, 'menu'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  return {
    id,
    registerStateHandlers,
    async open(ctx) {
      await ctx.sm.reset(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return this.open(ctx);
        case 'p2s':
          return startPinterestToSticker(ctx);
        case 'p2sMode':
          return askP2SCount(ctx, args[0]);
        case 'p2sCount':
          return askQueryForPack(ctx, Number(args[0]), args[1] || 'normal');
        case 'p2sCustom':
          return askCustomCount(ctx, 'p2s', args[0] || 'normal');
        case 'p2sSource': {
          const count = ctx.sm.context(ctx.tgId).count;
          if (args[0] === 'search') return askQueryForPack(ctx, count);
          if (args[0] === 'recent' && args[1]) {
            const row = app.pinterest.db.get('SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?', Number(args[1]), Number(ctx.tgId));
            if (!row) {
              const b = new RichMessageBuilder();
              b.heading('🎀 SEARCH EXPIRED', 2);
              b.paragraph(rt.italic('that search is no longer available — please run a new search ♡'));
              b.divider();
              b.buttons([richButton.callback('« Back to Stickers', encodeCallback(id, 'open'), { style: 'primary' })]);
              b.validate();
              return editOrSend(ctx, b.toJSON());
            }
            await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
              context: { flow: 'p2s', count, mode: row.mode, packFlow: true },
              chatId: ctx.chatId,
              screenMessageId: ctx.messageId
            });
            return createPackFromSearch(ctx.sm.ctxFor(ctx.tgId), row.query);
          }
          return askSource(ctx, count);
        }
        case 'manual':
          return startManual(ctx);
        case 'manualCount':
          return beginCollection(ctx, Number(args[0]));
        case 'manualCustom':
          return askCustomCount(ctx, 'manual');
        case 'manualConvert': {
          const sctx = ctx.sm.ctxFor(ctx.tgId);
          if (ctx.sm.state(ctx.tgId) !== States.MANUAL_STICKER_COLLECTION) return;
          return convertManual(sctx);
        }
        case 'packs':
          return showPacks(ctx, 0, '');
        case 'packsPage':
          return showPacks(ctx, Number(args[0]), args[1] || '');
        case 'searchPacksPrompt':
          return askPackSearchQuery(ctx);
        case 'packDetails':
          return showPackDetails(ctx, args[0]);
        case 'packAdd':
          return askPackAddMethod(ctx, Number(args[0]));
        case 'packAddChoose':
          return askPackAddMethod(ctx, Number(args[0]));
        case 'packAddSearch': {
          const packId = Number(args[0]);
          const pack = app.packs.getPack(Number(ctx.tgId), packId);
          const room = Math.max(0, 120 - (pack?.count ?? 0));
          return askQueryForPack(ctx, room || 20, pack?.stickerType === 'video' ? 'videos' : 'normal');
        }
        case 'addExisting':
          return startAddExisting(ctx, 0);
        case 'addExistingPage':
          return startAddExisting(ctx, Number(args[0]));
        case 'addExistingFromSearch':
          return showAddExistingFromSearch(ctx, Number(args[0]), Number(args[1]) || 0);
        case 'addToExistingPack':
          return addSearchMediaToPack(ctx, Number(args[0]), Number(args[1]));
        case 'getMedia':
          return deliverSourceMedia(ctx, Number(args[0]));
        case 'fromSearch': {
          const searchId = Number(args[0]);
          return makePackFromSearchMedia(ctx, searchId);
        }
        case 'waAddChoose':
          return showWaAddChoose(ctx, args[0], Number(args[1]) || 1);
        case 'waAddPick':
          return handleWaAddPick(ctx, args[0], args[1]);
        case 'waCreateNew':
          return handleWaCreateNew(ctx, args[0]);
        case 'waDismiss':
          return handleWaDismiss(ctx, args[0]);
        case 'clonePack':
          return startClonePack(ctx);
        case 'clonePackDo':
          return handleClonePackExecute(ctx);
        case 'packDeleteConfirm':
          return showPackDeleteConfirm(ctx, args[0]);
        case 'packDeleteDo':
          return handlePackDeleteDo(ctx, args[0]);
        case 'clearAllPacksConfirm':
          return showClearAllPacksConfirm(ctx);
        case 'clearAllPacksDo':
          return handleClearAllPacksDo(ctx);
        case 'back':
          return ctx.sm.back(ctx.tgId).then(() => openMenu(ctx));
        case 'cancel':
          await ctx.sm.cancel(ctx.tgId);
          return openMenu(ctx);
        case 'noop':
          return;
        default:
          return openMenu(ctx);
      }
    }
  };

  async function askCustomCount(ctx, flow, mode = 'normal') {
    await ctx.sm.transition(ctx.tgId, States.STICKER_COUNT_SELECTION, {
      context: { flow, mode, stage: 'custom' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('✎ CUSTOM AMOUNT', 2);
    b.paragraph(rt.italic('send me the exact number of stickers (e.g. 50, 100, 120) ♡'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function startAddExisting(ctx, page = 0) {
    const pageSize = 5;
    const { packs, total } = app.packs.listAvailablePacks(Number(ctx.tgId), { limit: pageSize, offset: page * pageSize });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 ADD TO EXISTING PACK 𓆩♡𓆪',
      'select an open pack below ♡'
    ])));
    b.divider();

    if (!packs.length) {
      b.paragraph(rt.bold('ʕ•ᴥ•ʔ All your existing packs are at max capacity (120 stickers)!'), rt.text('\n˙ᵕ˙ Please create a new sticker pack instead.'));
      b.buttons([
        richButton.callback('✨ Create New Pack', encodeCallback(id, 'p2s'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { back: true, home: true }));
    } else {
      b.paragraph(rt.italic(`select a pack to add stickers to (${total} total • page ${page + 1}/${totalPages}):`));
      for (const p of packs) {
        const limits = resolveLimits(ctx.settings, p.stickerType);
        const typeBadge = p.stickerType === 'video' ? '🎬' : '🖼';
        b.buttons([
          richButton.callback(`🎀 ${truncate(p.title, 20)} [${typeBadge}] (${p.count}/${limits.perSet})`, encodeCallback(id, 'packAddChoose', String(p.id)), { style: 'primary' })
        ]);
      }
      const navRow = [];
      if (page > 0) navRow.push(richButton.callback('← Prev', encodeCallback(id, 'addExistingPage', String(page - 1)), { style: 'primary' }));
      navRow.push(richButton.callback(`${page + 1} / ${totalPages}`, encodeCallback(id, 'noop'), { style: 'primary' }));
      if (page < totalPages - 1) navRow.push(richButton.callback('Next →', encodeCallback(id, 'addExistingPage', String(page + 1)), { style: 'primary' }));
      if (navRow.length) b.buttons(navRow);
      b.buttons(navButtons(id, { back: true, home: true }));
    }
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askPackAddMethod(ctx, packId) {
    const pack = app.packs.getPack(Number(ctx.tgId), Number(packId));
    if (!pack) {
      const b = new RichMessageBuilder();
      b.heading('📚 PACK NOT FOUND', 2);
      b.paragraph(rt.italic('that sticker pack is no longer in your library ♡'));
      b.divider();
      b.buttons([richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })]);
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }
    const limits = resolveLimits(ctx.settings, pack.stickerType);
    const room = Math.max(0, limits.perSet - pack.count);

    const b = new RichMessageBuilder();
    b.heading(`➕ ADD TO "${truncate(pack.title, 24)}"`, 2);
    b.table(kvTable([
      ['Current stickers', `${pack.count} / ${limits.perSet}`],
      ['Space available', `${room} stickers`],
      ['Type', pack.stickerType]
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('how would you like to add stickers?'));
    b.buttons([
      richButton.callback('🔍 Search Pinterest', encodeCallback(id, 'packAddSearch', String(packId)), { style: 'primary' }),
      richButton.callback('🖼 Send Manually', encodeCallback(id, 'manual'), { style: 'primary' })
    ]);
    b.divider();
    b.buttons([richButton.callback('« Back', encodeCallback(id, 'addExisting'), { style: 'primary' })]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function showAddExistingFromSearch(ctx, searchId, page = 0) {
    const pageSize = 5;
    const { packs, total } = app.packs.listAvailablePacks(Number(ctx.tgId), { limit: pageSize, offset: page * pageSize });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 ADD TO EXISTING PACK 𓆩♡𓆪',
      'select an open pack below ♡'
    ])));
    b.divider();

    if (!packs.length) {
      b.paragraph(rt.bold('ʕ•ᴥ•ʔ All your existing packs are at max capacity (120 stickers)!'), rt.text('\n˙ᵕ˙ Please create a new sticker pack instead.'));
      b.buttons([
        richButton.callback('✨ Create New Pack', encodeCallback(id, 'fromSearch', String(searchId)), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('« Back to Results', encodeCallback('pinterest', 'reuse', String(searchId), 'from_media'), { style: 'primary' })
      ]);
    } else {
      b.paragraph(rt.italic(`packs with space available (${total} total • page ${page + 1}/${totalPages}):`));
      for (const p of packs) {
        const limits = resolveLimits(ctx.settings, p.stickerType);
        b.buttons([
          richButton.callback(`🎀 ${truncate(p.title, 24)} (${p.count}/${limits.perSet})`, encodeCallback(id, 'addToExistingPack', String(p.id), String(searchId)), { style: 'primary' })
        ]);
      }
      const navRow = [];
      if (page > 0) navRow.push(richButton.callback('← Prev', encodeCallback(id, 'addExistingFromSearch', String(searchId), String(page - 1)), { style: 'primary' }));
      navRow.push(richButton.callback(`${page + 1} / ${totalPages}`, encodeCallback(id, 'noop'), { style: 'primary' }));
      if (page < totalPages - 1) navRow.push(richButton.callback('Next →', encodeCallback(id, 'addExistingFromSearch', String(searchId), String(page + 1)), { style: 'primary' }));
      if (navRow.length) b.buttons(navRow);
      b.buttons([
        richButton.callback('« Back to Results', encodeCallback('pinterest', 'reuse', String(searchId), 'from_media'), { style: 'primary' })
      ]);
    }
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function addSearchMediaToPack(ctx, packId, searchId) {
    const userId = Number(ctx.tgId);
    const api = app.telegram.api;
    const chatId = ctx.chatId;
    const settings = app.settings;

    const pack = app.packs.getPack(userId, packId);
    if (!pack) {
      const b = new RichMessageBuilder();
      b.heading('📚 PACK NOT FOUND', 2);
      b.paragraph(rt.italic('that sticker pack is no longer in your library ♡'));
      b.divider();
      b.buttons([richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })]);
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    const searchRow = app.pinterest.db.get('SELECT * FROM pinterest_searches WHERE id = ?', searchId);
    const query = searchRow?.query ?? pack.query ?? 'stickers';

    const allMediaRows = app.pinterest.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0 ORDER BY quality_score DESC`,
      searchId
    );
    if (!allMediaRows.length) {
      const b = new RichMessageBuilder();
      b.heading('🎀 NO MEDIA FOUND', 2);
      b.paragraph(rt.italic('no valid media found in that search — try searching again ♡'));
      b.divider();
      b.buttons([richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })]);
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    const isFromMedia = Boolean(
      ctx.fromMedia || ctx.forceNew ||
      (ctx.query?.message && app.telegram?.controller?.isMediaDeliveryMessage?.(ctx.query.message)) ||
      (ctx.messageId && app.telegram?.controller?.isMediaDeliveryMessageId?.(ctx.messageId))
    );
    const targetMsgId = isFromMedia ? null : (ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId);
    const tracker = new ProgressTracker({ api, chatId, messageId: targetMsgId, heartbeatMs: 2000 });
    const isVideo = pack.stickerType === 'video';
    await tracker.live((state, { elapsedMs }) => packProgressRich({ ...state, elapsedMs }), {
      stage: 'downloading', count: allMediaRows.length, query, mode: isVideo ? 'videos' : 'normal', total: allMediaRows.length, done: 0
    });

    try {
      const descriptors = [];
      let idx = 0;
      for (const row of allMediaRows) {
        let buffer = app.media.cache.read(row.sha256);
        if (!buffer) {
          buffer = await app.media.download(row.media_url).catch(() => null);
        }
        if (buffer) {
          descriptors.push({
            pinId: row.pin_id ?? `p-${row.id}`,
            mediaUrl: row.media_url,
            type: row.type ?? (pack.stickerType === 'video' ? 'video' : 'image'),
            sha256: row.sha256,
            phash: row.phash,
            mime: row.mime,
            width: row.width,
            height: row.height,
            size: row.size,
            buffer
          });
        }
        idx++;
        tracker.set({ stage: 'downloading', count: allMediaRows.length, query, mode: isVideo ? 'videos' : 'normal', done: idx, total: allMediaRows.length });
      }

      const result = await app.packs.addToPack({
        userId,
        packId,
        descriptors,
        stickerType: pack.stickerType,
        onProgress: (info) => {
          if (info.stage === 'converting') {
            tracker.set({ stage: 'converting', count: descriptors.length, query, mode: isVideo ? 'videos' : 'normal', done: info.done, total: info.total });
          } else if (info.stage === 'adding') {
            tracker.set({ stage: 'adding', count: descriptors.length, query, mode: isVideo ? 'videos' : 'normal', done: info.done, total: info.total });
          }
        }
      });

      result.title = pack.title;
      result.name = pack.shortName;
      result.link = pack.link;
      result.packId = pack.id;
      result.count = (pack.count ?? 0) + (result.added ?? 0);

      const extraPacks = result.splitPack ? (result.splitPack.allPacks ?? [result.splitPack]) : (result.extraPacks ?? []);

      app.pinterest.markResultsDelivered(userId, searchId, descriptors);
      app.db.audit(userId, 'pack.updated', { packId, count: result.count, split: Boolean(result.splitPack) });

      await ctx.sm.transition(ctx.tgId, States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(completionRich(settings, result, { duplicates: 0, query, extraPacks }));
    } catch (error) {
      await tracker.finish(packErrorRich(error));
      await ctx.sm.reset({ reason: 'add-failed' });
    }
  }

  async function deliverSourceMedia(ctx, packId) {
    const items = app.db.all(
      'SELECT sha256, type FROM sticker_items WHERE pack_id = ? AND sha256 IS NOT NULL LIMIT 10',
      Number(packId)
    );
    if (!items.length) {
      const b = new RichMessageBuilder();
      b.heading('📥 SOURCE MEDIA EXPIRED', 2);
      b.paragraph(rt.italic('source media for this pack is no longer cached locally ♡'));
      b.divider();
      b.buttons([richButton.callback('« Back to Packs', encodeCallback(id, 'packs'), { style: 'primary' })]);
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }
    const mediaGroup = [];
    const files = {};
    let idx = 0;
    for (const it of items) {
      const buffer = app.media.cache.read(it.sha256);
      if (buffer) {
        const field = `media_${idx}`;
        if (it.type === 'video') {
          files[field] = { buffer, filename: `${field}.mp4`, contentType: 'video/mp4' };
          mediaGroup.push({ type: 'video', media: `attach://${field}`, caption: idx === 0 ? '🎬 Source Video Media ♡' : undefined });
        } else {
          files[field] = { buffer, filename: `${field}.jpg`, contentType: 'image/jpeg' };
          mediaGroup.push({ type: 'photo', media: `attach://${field}`, caption: idx === 0 ? '🖼 Source Image Media ♡' : undefined });
        }
        idx++;
      }
    }
    if (mediaGroup.length > 0) {
      await app.telegram.api.sendMediaGroup(ctx.chatId, mediaGroup, {}, files).catch(() => {});
    }
  }

  async function showWaAddChoose(ctx, token, page = 1) {
    const imp = app.inboundHandler?.getImport(token);
    if (!imp) return ctx.reply('♡ That imported sticker has expired or was already processed ♡');

    const pageSize = 5;
    const pageNum = Math.max(1, Number(page) || 1);
    const offset = (pageNum - 1) * pageSize;
    let { packs, total } = app.packs.listAvailablePacks(Number(ctx.tgId), { stickerType: imp.sticker_type, limit: pageSize, offset });
    if (!packs.length && total === 0) {
      const allRes = app.packs.listAvailablePacks(Number(ctx.tgId), { stickerType: null, limit: pageSize, offset });
      packs = allRes.packs;
      total = allRes.total;
    }
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 ADD IMPORTED STICKER 𓆩♡𓆪',
      'select a pack to add to ♡'
    ])));
    b.divider();

    if (!packs.length && total === 0) {
      b.paragraph(rt.bold('All your existing packs are at max capacity!'), rt.text('\nPlease create a new sticker pack instead.'));
      b.buttons([
        richButton.callback('✨ Create New Pack', encodeCallback(id, 'waCreateNew', token), { style: 'primary' })
      ]);
    } else {
      b.paragraph(rt.italic(`select a pack for these ${imp.count} sticker(s) (Page ${pageNum}/${totalPages}):`));
      for (const p of packs) {
        const limits = resolveLimits(ctx.settings, p.stickerType);
        const typeIcon = p.stickerType === 'video' ? '🎬' : '🖼';
        b.buttons([
          richButton.callback(`🎀 ${truncate(p.title, 20)} [${typeIcon}] (${p.count}/${limits.perSet})`, encodeCallback(id, 'waAddPick', token, String(p.id)), { style: 'primary' })
        ]);
      }

      // Pagination controls if more than 1 page
      if (totalPages > 1) {
        const nav = [];
        if (pageNum > 1) {
          nav.push(richButton.callback('« Prev', encodeCallback(id, 'waAddChoose', token, String(pageNum - 1))));
        }
        nav.push(richButton.callback(`• ${pageNum}/${totalPages} •`, encodeCallback(id, 'noop')));
        if (pageNum < totalPages) {
          nav.push(richButton.callback('Next »', encodeCallback(id, 'waAddChoose', token, String(pageNum + 1))));
        }
        b.buttons(nav);
      }
    }
    b.buttons([
      richButton.callback('✨ Create New Pack Instead', encodeCallback(id, 'waCreateNew', token)),
      richButton.callback('✕ Dismiss', encodeCallback(id, 'waDismiss', token), { style: 'danger' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function handleWaAddPick(ctx, token, packId) {
    const imp = app.inboundHandler?.getImport(token);
    if (!imp) return ctx.reply('♡ That import record has expired or was already processed ♡');
    const pack = app.packs.getPack(Number(ctx.tgId), Number(packId));
    if (!pack) return ctx.reply('♡ Target pack not found.');

    const impType = imp.sticker_type === 'video' ? 'video' : 'static';
    const packType = pack.stickerType === 'video' ? 'video' : 'static';

    const descriptors = [];
    const ffmpegPath = ctx.settings?.get('media.ffmpegPath') ?? '';
    for (const item of imp.items) {
      let buf = Buffer.from(item.bufferBase64, 'base64');
      let isVid = packType === 'video';
      if (impType !== packType) {
        try {
          if (packType === 'video') {
            const res = await toTelegramVideoSticker(buf, { configuredFfmpeg: ffmpegPath });
            buf = res.buffer;
            isVid = true;
          } else {
            const res = await toTelegramStaticSticker(buf, { configuredFfmpeg: ffmpegPath });
            buf = res.buffer;
            isVid = false;
          }
        } catch {}
      }
      descriptors.push({
        buffer: buf,
        emoji: (item.emojis?.length ? item.emojis : ['🤍']).map((e) => (e === '♡' ? '🤍' : e)),
        isVideo: isVid,
        type: isVid ? 'video' : 'image',
        sha256: sha256Hex(buf)
      });
    }

    const userId = Number(ctx.tgId);
    const screenMsgId = ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId;
    const tracker = new ProgressTracker({
      api: app.telegram.api,
      chatId: ctx.chatId,
      messageId: screenMsgId,
      heartbeatMs: 2000
    });

    const isVideo = imp.sticker_type === 'video';
    await tracker.live((state, { elapsedMs }) => packProgressRich({ ...state, elapsedMs }), {
      stage: 'adding',
      count: descriptors.length,
      query: pack.title,
      mode: isVideo ? 'videos' : 'normal',
      total: descriptors.length,
      done: 0
    });

    try {
      const result = await app.packs.addToPack({
        userId,
        packId: Number(packId),
        descriptors,
        stickerType: imp.sticker_type,
        onProgress: (p) => tracker.set({
          stage: p.stage ?? 'adding',
          done: p.done ?? 0,
          total: p.total ?? descriptors.length
        })
      });
      app.inboundHandler?.deleteImport(token);

      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '𓆩♡𓆪 STICKERS ADDED! 𓆩♡𓆪',
        `"${pack.title}"`
      ])));
      b.divider();
      b.paragraph(rt.bold(`✓ Successfully added ${descriptors.length} sticker(s) to "${pack.title}"!`));
      b.divider();
      b.table([
        [
          { text: 'ʕ•ᴥ•ʔ Pack name', align: 'left', valign: 'middle' },
          { text: rt.bold(pack.title), align: 'right', valign: 'middle' }
        ],
        [
          { text: '˙ᵕ˙ Total stickers', align: 'left', valign: 'middle' },
          { text: rt.bold(String(result.count)), align: 'right', valign: 'middle' }
        ]
      ], { compact: true });
      b.divider();
      b.buttons([
        richButton.url('🔗 Open Sticker Pack', `https://t.me/addstickers/${pack.shortName}`, { style: 'primary' }),
        richButton.callback('✦ My Packs', encodeCallback(id, 'packs'))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
    } catch (err) {
      await tracker.finish(packErrorRich(err));
    }
  }

  async function handleWaCreateNew(ctx, token) {
    const imp = app.inboundHandler?.getImport(token);
    if (!imp) return ctx.reply('♡ That import record has expired or was already processed ♡');

    const descriptors = imp.items.map((item) => ({
      buffer: Buffer.from(item.bufferBase64, 'base64'),
      emoji: (item.emojis?.length ? item.emojis : ['🤍']).map((e) => (e === '♡' ? '🤍' : e)),
      isVideo: item.stickerType === 'video',
      type: item.stickerType === 'video' ? 'video' : 'image',
      sha256: sha256Hex(Buffer.from(item.bufferBase64, 'base64'))
    }));

    const userId = Number(ctx.tgId);
    const screenMsgId = ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId;
    const tracker = new ProgressTracker({
      api: app.telegram.api,
      chatId: ctx.chatId,
      messageId: screenMsgId,
      heartbeatMs: 2000
    });

    const isVideo = imp.sticker_type === 'video';
    await tracker.live((state, { elapsedMs }) => packProgressRich({ ...state, elapsedMs }), {
      stage: 'converting',
      count: descriptors.length,
      query: 'WA Import',
      mode: isVideo ? 'videos' : 'normal',
      total: descriptors.length,
      done: 0
    });

    try {
      const defaultTitle = app.settings?.getForUser?.(userId, 'stickers.defaultPackName') ?? 'ᥫ᭡ʟᴀɴᴄʏ';
      const created = await app.packs.createPackFromMedia({
        userId,
        query: 'wa_import',
        title: `${defaultTitle} - WA Import`,
        descriptors,
        stickerType: imp.sticker_type,
        onProgress: (p) => tracker.set({
          stage: p.stage ?? 'converting',
          done: p.done ?? 0,
          total: p.total ?? descriptors.length
        })
      });
      app.inboundHandler?.deleteImport(token);

      await tracker.finish(completionRich(app.settings, created, { query: 'WA Import' }));
    } catch (err) {
      await tracker.finish(packErrorRich(err));
    }
  }

  async function handleWaDismiss(ctx, token) {
    app.inboundHandler?.deleteImport(token);
    await ctx.reply('✓ Import dismissed ♡');
  }
}

// ── Shared renderers ─────────────────────────────────────────────────────────

const STAGE_LINES = {
  searching: '♡ Searching Pinterest…',
  validating: '♡ Picking the HD versions…',
  converting: '♡ Turning them into stickers…',
  creating: '♡ Giving your pack some personality…',
  adding: '♡ Almost ready, pretty ♡'
};

export function packProgressRich({ stage, count, query, mode = 'normal', done = 0, total = 0, found = 0, unique = 0, elapsedMs = 0 }) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold(banner([
    '𓆩♡𓆪 MAKING YOUR STICKER PACK 𓆩♡𓆪',
    `"${truncate(query ?? '', 24)}"`
  ])));
  b.divider();
  b.table([
    [
      { text: 'ʕ•ᴥ•ʔ Search', align: 'left', valign: 'middle' },
      { text: rt.bold(query ?? 'stickers'), align: 'right', valign: 'middle' }
    ],
    [
      { text: '˙ᵕ˙ Target', align: 'left', valign: 'middle' },
      { text: rt.bold(`${count} stickers`), align: 'right', valign: 'middle' }
    ],
    [
      { text: '୨୧ Progress', align: 'left', valign: 'middle' },
      { text: rt.bold(`${done}/${total || count}`), align: 'right', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();

  const isVideo = mode === 'videos' || mode === 'video';
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const totalWaitSec = Math.max(isVideo ? 25 : 15, Math.round(count * (isVideo ? 3.0 : 0.6)));
  const countdownSec = Math.max(0, totalWaitSec - elapsedSec);
  const waitDurationText = totalWaitSec >= 60 ? `Wait ~${Math.ceil(totalWaitSec / 60)}min` : `Wait ${totalWaitSec}s`;
  const countdownText = countdownSec > 0 ? `${countdownSec}s remaining` : 'finishing up...';
  const timeHeader = `⏳ ${waitDurationText} • ⏱ Countdown: ${countdownText} (elapsed ${String(elapsedSec).padStart(2, '0')}s)`;

  const ratio = (total > 0 && done > 0) ? Math.min(1, done / total) : (stage === 'searching' ? 0.25 : stage === 'creating' ? 0.85 : 0.5);
  const bar = `${'█'.repeat(Math.round(ratio * 10))}${'░'.repeat(10 - Math.round(ratio * 10))} ${Math.round(ratio * 100)}%`;

  let stepLabel = 'Processing stickers...';
  if (stage === 'searching') {
    stepLabel = `Fetching HD media (${done || 0}/${count})`;
  } else if (stage === 'downloading') {
    stepLabel = `Downloading source media (${done || 0}/${count})`;
  } else if (stage === 'converting') {
    stepLabel = isVideo
      ? `Compressing WebM video stickers (${done}/${total || count})`
      : `Rendering stickers (${done}/${total || count})`;
  } else if (stage === 'adding' || stage === 'creating') {
    stepLabel = `Telegram pack sync (${done}/${total || count})`;
  } else {
    stepLabel = `Finalizing pack (${done}/${total || count})`;
  }

  // Mini-wide clean callout in blockquote with timer and bar
  const miniLog = `${timeHeader}\n[${bar}]\n• ˙ᵕ˙ ${stepLabel} ♡`;
  b.blockquote(miniLog);
  b.footer(rt.italic('୨୧ live updates in-place • no waiting in the dark ˙ᵕ˙'));
  b.validate();
  return b.toJSON();
}

function completionRich(settings, pack, { duplicates = 0, query = '', extraPacks = [] } = {}) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold(banner([
    '𓆩♡𓆪 STICKER PACK READY 𓆩♡𓆪',
    `"${pack.title}"`
  ])));
  b.divider();
  b.table([
    [
      { text: 'ʕ•ᴥ•ʔ Pack name', align: 'left', valign: 'middle' },
      { text: rt.bold(pack.title), align: 'right', valign: 'middle' }
    ],
    [
      { text: '˙ᵕ˙ Stickers', align: 'left', valign: 'middle' },
      { text: rt.bold(String(pack.count)), align: 'right', valign: 'middle' }
    ],
    [
      { text: '୨୧ Search', align: 'left', valign: 'middle' },
      { text: query || 'manual selection', align: 'right', valign: 'middle' }
    ],
    [
      { text: '✦ Twins skipped', align: 'left', valign: 'middle' },
      { text: String(duplicates), align: 'right', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();

  if (extraPacks && extraPacks.length > 0) {
    b.paragraph(rt.bold('📦 Additional split pack created:'));
    for (const ep of extraPacks) {
      b.paragraph(rt.concat(rt.bold(`• ${ep.title}: `), rt.text(`${ep.count} stickers `), rt.url('[Link]', ep.link)));
    }
    b.divider();
  }

  b.paragraph(rt.bold('₊˚⊹♡ your aesthetic pack is ready on Telegram!'), rt.text('\nʕ•ᴥ•ʔ tap below to open it in Telegram, get source media, or publish to WhatsApp!'));

  const linkButtons = [];
  if (pack.link) linkButtons.push(richButton.url(extraPacks?.length > 0 ? '🔗 Open Pack 01' : '🔗 Open Pack', pack.link, { style: 'primary' }));
  if (extraPacks && extraPacks.length > 0) {
    extraPacks.forEach((ep, i) => {
      if (ep.link) {
        linkButtons.push(richButton.url(`🔗 Open Pack ${String(i + 2).padStart(2, '0')}`, ep.link, { style: 'primary' }));
      }
    });
  }
  if (linkButtons.length > 0) b.buttons(linkButtons);

  b.buttons([
    richButton.callback('📥 Get Source Media', encodeCallback('stickers', 'getMedia', String(pack.packId ?? pack.id)), { style: 'primary' }),
    richButton.callback('📱 WhatsApp Studio', encodeCallback('whatsapp', 'publishPack', String(pack.packId ?? pack.id)), { style: 'primary' })
  ]);
  b.buttons([
    richButton.callback('✨ Create Another', encodeCallback('stickers', 'p2s'), { style: 'primary' }),
    richButton.callback('✓ Done', encodeCallback('dashboard', 'open'), { style: 'success' })
  ]);
  b.footer(rt.italic(`୨୧ pack id: ${pack.shortName ?? pack.name ?? ''}`));
  b.validate();
  return b.toJSON();
}

function packErrorRich(error) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold(banner([
    '𓆩♡𓆪 PACK CREATION FAILED 𓆩♡𓆪',
    'something went wrong ♡'
  ])));
  b.divider();
  b.paragraph(rt.bold(`ʕ•ᴥ•ʔ ${String(error?.userMessage ?? error?.message ?? 'something went wrong')}`));
  b.divider();
  b.buttons([
    richButton.callback('♡ Try Again', encodeCallback('stickers', 'p2s'), { style: 'primary' }),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
  ]);
  b.validate();
  return b.toJSON();
}
