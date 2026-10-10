import { RichMessageBuilder, rt, richButton, encodeCallback, block } from '../rich.js';
import { navButtons, kvTable, ACCENT, SPARK, banner } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { SEARCH_MODES } from '../../pinterest/search.js';
import { truncate } from '../../utils/text.js';

/**
 * Pinterest screen + deep search flow.
 *
 * Menu → Search → (query) → ONE live progress Rich Message → results with
 * previews → "Make Sticker Pack" hands off to the stickers flow.
 *
 * Callback routing: the TelegramController routes by screen prefix to this
 * module; text input is routed by the state machine (PINTEREST_SEARCH).
 */
export function createPinterestScreen({ app }) {
  const id = 'pinterest';
  const activeSearches = new Map(); // tgId -> AbortController

  // ── Menu ────────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 PINTEREST STUDIO 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ deep, duplicate-free searches ♡ ˙ᵕ˙'));
    b.divider();
    b.buttons([
      richButton.callback('🔍 Search Pinterest', encodeCallback(id, 'search'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🖼 Images Only', encodeCallback(id, 'mode', 'images'), { style: 'primary' }),
      richButton.callback('🎬 Videos Only', encodeCallback(id, 'mode', 'videos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🕘 Search History', encodeCallback(id, 'history'), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic(`depth: ${ctx.settings.get('pinterest.searchDepth')} • duplicates are always filtered ♡`));
    b.validate();
    return b.toJSON();
  }

  async function editOrSend(ctx, rich, files = null) {
    if (ctx.editScreen) return ctx.editScreen(rich, {}, files);
    const tgId = String(ctx.tgId);
    const chatId = ctx.chatId ?? Number(tgId);
    const sm = ctx.sm ?? ctx.machine;
    const targetMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    const api = ctx.api || app.telegram.api;
    if (targetMsgId) {
      const res = await api.editMessageRich(chatId, targetMsgId, rich, {}, files).catch(() => null);
      if (res) return res;
    }
    return api.sendRichMessage(chatId, rich, {}, files);
  }

  async function openMenu(ctx) {
    await editOrSend(ctx, renderMenu(ctx));
  }

  // ── Search flow ─────────────────────────────────────────────────────────
  async function askQuery(ctx, mode) {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id;
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
      context: { mode, screenMessageId: screenMsgId },
      chatId: ctx.chatId,
      screenMessageId: screenMsgId
    });
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 PINTEREST SEARCH 𓆩♡𓆪', 1);
    b.paragraph(rt.italic(`₊˚⊹♡ mode: ${mode} • depth: ${ctx.settings.get('pinterest.searchDepth')} ˙ᵕ˙`));
    b.divider();
    b.paragraph(rt.italic('tell me what to search for ♡'));
    b.paragraph(rt.concat(rt.text('example: '), rt.code('gojo satoru')));
    b.divider();
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();
    const sent = await editOrSend(ctx, b.toJSON());
    if (sent?.message_id) {
      ctx.sm.update(ctx.tgId, { screenMessageId: sent.message_id });
    }
  }

  async function askCount(ctx, query, mode = 'normal') {
    const isVideo = mode === 'videos';
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    if (ctx.transition) {
      await ctx.transition(States.PINTEREST_SEARCH, {
        context: { mode, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.PINTEREST_SEARCH, {
        context: { mode, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const b = new RichMessageBuilder();
    b.heading(isVideo ? '🎬 VIDEO RESULT COUNT' : '✨ SEARCH RESULT COUNT', 2);
    b.paragraph(rt.italic(`how many aesthetic picks should I find for "${truncate(query, 24)}"? ♡`));
    b.divider();
    b.table(kvTable([
      ['Query', truncate(query, 24)],
      ['Mode', mode],
      ['Depth', app.settings?.get('pinterest.searchDepth') ?? 'deep']
    ]), { compact: true });
    b.divider();

    if (isVideo) {
      b.buttons([
        richButton.callback('5', encodeCallback(id, 'runCount', '5', mode, query), { style: 'primary' }),
        richButton.callback('10', encodeCallback(id, 'runCount', '10', mode, query), { style: 'primary' }),
        richButton.callback('15', encodeCallback(id, 'runCount', '15', mode, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', mode, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🎬 More Videos (+10)', encodeCallback(id, 'runCount', '30', mode, query), { style: 'primary' })
      ]);
    } else {
      b.buttons([
        richButton.callback('10', encodeCallback(id, 'runCount', '10', mode, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', mode, query), { style: 'primary' }),
        richButton.callback('30', encodeCallback(id, 'runCount', '30', mode, query), { style: 'primary' }),
        richButton.callback('50', encodeCallback(id, 'runCount', '50', mode, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('60', encodeCallback(id, 'runCount', '60', mode, query), { style: 'primary' }),
        richButton.callback('80', encodeCallback(id, 'runCount', '80', mode, query), { style: 'primary' }),
        richButton.callback('100', encodeCallback(id, 'runCount', '100', mode, query), { style: 'primary' }),
        richButton.callback('120', encodeCallback(id, 'runCount', '120', mode, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('130 (+10)', encodeCallback(id, 'runCount', '130', mode, query), { style: 'primary' }),
        richButton.callback('140 (+20)', encodeCallback(id, 'runCount', '140', mode, query), { style: 'primary' }),
        richButton.callback('150 (+30)', encodeCallback(id, 'runCount', '150', mode, query), { style: 'primary' })
      ]);
    }
    b.buttons([
      richButton.callback('✎ Custom Count', encodeCallback(id, 'customCount', mode, query), { style: 'primary' }),
      richButton.callback('« Back', encodeCallback(id, 'mode', mode), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.validate();
    const sent = await editOrSend(ctx, b.toJSON());
    if (sent?.message_id) {
      if (ctx.update) {
        ctx.update({ screenMessageId: sent.message_id });
      } else if (sm) {
        sm.update(tgId, { screenMessageId: sent.message_id });
      }
    }
  }

  async function askCustomCount(ctx, query, mode = 'normal') {
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    if (ctx.transition) {
      await ctx.transition(States.PINTEREST_SEARCH, {
        context: { mode, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.PINTEREST_SEARCH, {
        context: { mode, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }
    const b = new RichMessageBuilder();
    b.heading('✎ CUSTOM RESULT COUNT', 2);
    b.paragraph(rt.italic(`send me the number of results you want for "${truncate(query, 24)}" (e.g. 50, 100, 120) ♡`));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function runSearch(sctx, query, targetGoal = null) {
    const mode = sctx.context.mode ?? 'normal';
    const depth = app.settings.get('pinterest.searchDepth') ?? 'deep';
    const rawGoal = targetGoal ?? sctx.context.goal ?? null;
    const goal = mode === 'videos' ? Math.min(20, Math.max(1, Number(rawGoal) || 20)) : (Number(rawGoal) > 0 ? Number(rawGoal) : 60);
    const userId = Number(sctx.tgId);
    const api = sctx.api || app.telegram.api;
    const chatId = sctx.chatId;

    // Delete user input message to keep chat totally clean & un-spammy
    if (sctx.message?.message_id && app.settings.get('telegram.messageCleanup')) {
      await api.deleteMessage(chatId, sctx.message.message_id).catch(() => {});
    }

    // Reuse existing screen message so it updates in-place with ticking heartbeat timer
    const tracker = new ProgressTracker({ api, chatId, messageId: sctx.screenMessageId, heartbeatMs: 2000 });
    await tracker.live((state, { elapsedMs }) => progressRich({ ...state, elapsedMs }), {
      stage: 'searching', mode, depth, query, goal
    });

    const controller = new AbortController();
    activeSearches.set(sctx.tgId, controller);

    try {
      const result = await app.queues.add('pinterest', {
        type: 'pinterest-search',
        userId,
        payload: { query, mode, depth, goal },
        run: async (job, qctx) => app.pinterest.search({
          userId,
          query,
          mode,
          depth,
          goal,
          signal: AbortSignal.any([controller.signal, qctx.signal].filter(Boolean)),
          onProgress: (p) => {
            tracker.set({ stage: p.stage ?? 'searching', mode, depth, query, goal, ...p });
          }
        })
      }, { attempts: 2 });

      await sctx.transition(States.PINTEREST_RESULTS, {
        context: {
          searchId: result.searchId,
          query,
          mode,
          depth,
          goal,
          stats: result.stats,
          screenMessageId: tracker.messageId
        },
        chatId
      });

      // Record results in user history so subsequent searches never repeat them!
      app.pinterest.markResultsDelivered(userId, result.searchId, result.results);

      // Top unique HD picks (both images and videos!)
      const topMedia = app.pinterest.db.all(
        `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
         ORDER BY quality_score DESC LIMIT 10`,
        result.searchId
      );
      const totalMediaRow = app.pinterest.db.get(
        `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
        result.searchId
      );
      const totalMedia = totalMediaRow?.count ?? topMedia.length;

      const mediaFiles = {};
      const previewBlocks = [];
      let idx = 0;
      for (const p of topMedia) {
        if (!p.sha256) continue;
        const buffer = app.media.cache.read(p.sha256);
        if (buffer) {
          if (p.type === 'video') {
            const field = `video_${idx}`;
            mediaFiles[field] = { buffer, filename: `${field}.mp4`, contentType: p.mime ?? 'video/mp4' };
            previewBlocks.push({ type: 'video', ref: `attach://${field}` });
          } else {
            const field = `photo_${idx}`;
            mediaFiles[field] = { buffer, filename: `${field}.jpg`, contentType: p.mime ?? 'image/jpeg' };
            previewBlocks.push({ type: 'photo', ref: `attach://${field}` });
          }
          idx++;
          if (idx >= 10) break; // Telegram slideshow max items
        }
      }

      result.mode = mode;
      const rich = resultsRich(result, previewBlocks.length, totalMedia, previewBlocks, 0);
      try {
        await tracker.finish(rich, files);
      } catch (finishErr) {
        if (/PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED/i.test(finishErr?.message)) {
          await tracker.finish(rich, null);
        } else {
          throw finishErr;
        }
      }
      if (tracker.messageId) {
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram.userScreenMessage?.set(sctx.tgId, { chatId, messageId: tracker.messageId });
        sctx.update({ screenMessageId: tracker.messageId });
      }
    } catch (error) {
      await tracker.finish(errorRich(error));
      if (error?.name === 'AbortError' || /cancelled/i.test(String(error?.message))) {
        await sctx.reset({ reason: 'cancelled' });
        await openMenu({ api, chatId, messageId: null, message: null, sm: sctx.machine, tgId: sctx.tgId, settings: app.settings }).catch(() => {});
      }
    } finally {
      activeSearches.delete(sctx.tgId);
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────
  async function showResults(ctx) {
    const { searchId, query, mode, stats, screenMessageId } = ctx.sm.context(ctx.tgId);
    const rows = app.pinterest.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC LIMIT 60`,
      searchId
    );
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} RESULTS`, 1);
    b.table(kvTable([
      ['Query', query],
      ['Mode', mode],
      ['Unique results', String(rows.length)],
      ['Duplicates removed', String(stats?.duplicatesFound ?? 0)],
      ['Pages searched', String(stats?.pagesFetched ?? 0)]
    ]), { compact: true });
    b.divider();

    // Preview up to 6 results as photo or video blocks (attach:// uploads).
    const previews = rows.slice(0, 6).filter((r) => r.sha256);
    const files = {};
    let i = 0;
    for (const p of previews) {
      const buffer = app.media.cache.read(p.sha256);
      if (buffer) {
        const name = `preview_${i++}`;
        if (p.type === 'video') {
          files[name] = { buffer, filename: `${name}.mp4`, contentType: p.mime ?? 'video/mp4' };
          b.video(`attach://${name}`);
        } else {
          files[name] = { buffer, filename: `${name}.jpg`, contentType: p.mime ?? 'image/jpeg' };
          b.photo(`attach://${name}`);
        }
      }
    }
    if (i > 0) b.divider();

    b.heading(`${ACCENT} top picks`, 3);
    b.table(rows.slice(0, 8).map((r, idx) => [
      { text: `#${idx + 1}`, align: 'left', valign: 'middle' },
      { text: r.type === 'video' ? '🎬' : '🖼', align: 'left', valign: 'middle' },
      { text: truncate(r.media_url, 40), align: 'left', valign: 'middle' },
      { text: r.width && r.height ? `${r.width}×${r.height}` : '—', align: 'right', valign: 'middle' }
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('✦ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', searchId), { style: 'primary' }),
      richButton.callback('🕘 New Search', encodeCallback(id, 'search'))
    ]);
    b.buttons(navButtons(id, { home: true, cancel: true }));
    b.footer(rt.italic('every result is unique — SHA-256 + perceptual hashing ♡'));
    b.validate();

    const rich = b.toJSON();
    const chatId = ctx.chatId;
    if (screenMessageId) {
      await ctx.api.editMessageRich(chatId, screenMessageId, rich, {}, files).catch(async (error) => {
        if (/not modified|not found/i.test(String(error?.description ?? error?.message))) return;
        await ctx.api.sendRichMessage(chatId, rich, {}, files);
      });
    } else if (ctx.messageId && ctx.message) {
      await ctx.editScreen(rich, files);
    } else {
      await ctx.api.sendRichMessage(chatId, rich, {}, files);
    }
  }

  // ── History ─────────────────────────────────────────────────────────────
  async function showHistory(ctx, page = 0, keyword = '') {
    const pageSize = 5;
    const offset = page * pageSize;
    const trimmed = (keyword ?? '').trim();
    let rows, total;

    if (trimmed) {
      rows = app.pinterest.db.all(
        'SELECT * FROM pinterest_searches WHERE user_id = ? AND (query LIKE ? OR normalized_query LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?',
        Number(ctx.tgId), `%${trimmed}%`, `%${trimmed}%`, pageSize, offset
      );
      const totalRow = app.pinterest.db.get(
        'SELECT COUNT(*) as c FROM pinterest_searches WHERE user_id = ? AND (query LIKE ? OR normalized_query LIKE ?)',
        Number(ctx.tgId), `%${trimmed}%`, `%${trimmed}%`
      );
      total = totalRow?.c ?? 0;
    } else {
      rows = app.pinterest.db.all(
        'SELECT * FROM pinterest_searches WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        Number(ctx.tgId), pageSize, offset
      );
      const totalRow = app.pinterest.db.get(
        'SELECT COUNT(*) as c FROM pinterest_searches WHERE user_id = ?',
        Number(ctx.tgId)
      );
      total = totalRow?.c ?? 0;
    }
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const b = new RichMessageBuilder();
    b.heading(trimmed ? `🕘 SEARCH HISTORY ("${truncate(trimmed, 18)}")` : '🕘 SEARCH HISTORY', 2);
    b.paragraph(rt.italic(trimmed
      ? `found ${total} search${total === 1 ? '' : 'es'} matching "${truncate(trimmed, 20)}" • page ${page + 1}/${totalPages}`
      : `${total} search${total === 1 ? '' : 'es'} in history • page ${page + 1}/${totalPages}`
    ));
    b.divider();
    if (!rows.length) {
      b.paragraph(rt.italic(trimmed ? `no searches found matching "${trimmed}" ♡` : 'no searches yet ♡'));
    } else {
      b.table(rows.map((r) => [
        { text: truncate(r.query, 18), align: 'left', valign: 'middle' },
        { text: r.mode, align: 'left', valign: 'middle' },
        { text: String(r.result_count), align: 'right', valign: 'middle' },
        { text: r.created_at.slice(0, 10), align: 'right', valign: 'middle' }
      ]), { compact: true });
      b.spacer();
      b.paragraph(rt.italic('tap a search to run it again:'));
      for (const r of rows) {
        b.buttons([richButton.callback(`🔍 ${truncate(r.query, 24)} (${r.result_count})`, encodeCallback(id, 'reuse', r.id), { style: 'primary' })]);
      }
    }
    b.divider();

    if (trimmed) {
      b.buttons([
        richButton.callback('🔎 Search Another', encodeCallback(id, 'searchHistoryPrompt'), { style: 'primary' }),
        richButton.callback('✕ Clear Search', encodeCallback(id, 'history'), { style: 'primary' })
      ]);
    } else {
      b.buttons([
        richButton.callback('🔎 Search History', encodeCallback(id, 'searchHistoryPrompt'), { style: 'primary' })
      ]);
      if (rows.length > 0) {
        b.buttons([
          richButton.callback('🧹 Clear History', encodeCallback(id, 'clearHistoryConfirm'), { style: 'danger' })
        ]);
      }
    }

    const navRow = [];
    if (page > 0) navRow.push(richButton.callback('← Prev', encodeCallback(id, 'historyPage', String(page - 1), trimmed), { style: 'primary' }));
    navRow.push(richButton.callback(`${page + 1} / ${totalPages}`, encodeCallback(id, 'noop'), { style: 'primary' }));
    if (page < totalPages - 1) navRow.push(richButton.callback('Next →', encodeCallback(id, 'historyPage', String(page + 1), trimmed), { style: 'primary' }));
    if (navRow.length) b.buttons(navRow);
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askHistorySearchQuery(ctx) {
    const tgId = String(ctx.tgId);
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? ctx.sm?.for(tgId)?.screenMessageId;
    await ctx.sm.transition(tgId, States.PINTEREST_SEARCH, {
      context: { stage: 'historySearch', screenMessageId: screenMsgId },
      chatId: ctx.chatId,
      screenMessageId: screenMsgId
    });
    const b = new RichMessageBuilder();
    b.heading('🔎 SEARCH YOUR HISTORY', 2);
    b.paragraph(rt.italic('send me the keyword or query you are looking for in your history ♡'));
    b.paragraph(rt.text('example: '), rt.code('anime'), rt.text(' or '), rt.code('baddie'));
    b.divider();
    b.buttons([
      richButton.callback('« Back to History', encodeCallback(id, 'history'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function reuseSearch(ctx, searchId) {
    const row = app.pinterest.db.get(
      'SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?',
      Number(searchId), Number(ctx.tgId)
    );
    if (!row) {
      const b = new RichMessageBuilder();
      b.heading('🕘 SEARCH EXPIRED', 2);
      b.paragraph(rt.italic('that search record is no longer available ♡'));
      b.divider();
      b.buttons([
        richButton.callback('🔍 New Search', encodeCallback(id, 'search'), { style: 'primary' }),
        richButton.callback('« Back to History', encodeCallback(id, 'history'), { style: 'primary' })
      ]);
      b.validate();
      await editOrSend(ctx, b.toJSON());
      return;
    }
    const mediaRows = app.pinterest.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC`,
      row.id
    );
    const totalMedia = mediaRows.length;

    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId;
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_RESULTS, {
      context: {
        searchId: row.id,
        query: row.query,
        mode: row.mode,
        depth: row.depth,
        stats: { duplicatesFound: row.duplicates_found ?? 0 },
        screenMessageId: screenMsgId
      },
      chatId: ctx.chatId
    });

    const previewBlocks = [];
    const mediaFiles = {};
    let idx = 0;

    for (const p of mediaRows.slice(0, 10)) {
      if (!p.sha256) continue;
      const buffer = app.media.cache.read(p.sha256);
      if (buffer) {
        if (p.type === 'video') {
          const field = `video_${idx}`;
          mediaFiles[field] = { buffer, filename: `${field}.mp4`, contentType: p.mime ?? 'video/mp4' };
          previewBlocks.push({ type: 'video', ref: `attach://${field}` });
        } else {
          const field = `photo_${idx}`;
          mediaFiles[field] = { buffer, filename: `${field}.jpg`, contentType: p.mime ?? 'image/jpeg' };
          previewBlocks.push({ type: 'photo', ref: `attach://${field}` });
        }
        idx++;
      }
    }

    const resultStub = {
      searchId: row.id,
      query: row.query,
      mode: row.mode,
      results: { length: totalMedia },
      stats: { duplicatesFound: row.duplicates_found ?? 0 }
    };

    const rich = resultsRich(resultStub, Math.min(10, totalMedia), totalMedia, previewBlocks, 0);
    const files = previewBlocks.length > 0 ? mediaFiles : null;
    await editOrSend(ctx, rich, files);
  }

  async function showMoreAlbum(ctx, searchId, offset = 0) {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId;
    const numOffset = Math.max(0, Number(offset) || 0);

    const nextMedia = app.pinterest.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC LIMIT 10 OFFSET ?`,
      searchId, numOffset
    );

    const totalMediaRow = app.pinterest.db.get(
      `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
      searchId
    );
    const totalMedia = totalMediaRow?.count ?? 0;

    const searchRow = app.pinterest.db.get(
      'SELECT * FROM pinterest_searches WHERE id = ?',
      searchId
    );

    if (!nextMedia.length) {
      const isVideo = searchRow?.mode === 'videos';
      const b = new RichMessageBuilder();
      b.heading(isVideo ? '🎬 ALL VIDEOS VIEWED' : '🖼 ALL PICKS VIEWED', 2);
      b.paragraph(rt.italic(isVideo
        ? 'all aesthetic video picks in this search have already been browsed ♡'
        : 'all aesthetic picks in this search have already been browsed ♡'
      ));
      b.divider();
      const endButtons = [];
      if (numOffset > 0) {
        const prevOffset = Math.max(0, numOffset - 10);
        endButtons.push(richButton.callback('← Prev Picks', encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset)), { style: 'primary' }));
      }
      endButtons.push(richButton.callback('« Back to Results', encodeCallback(id, 'reuse', String(searchId), 'from_media'), { style: 'primary' }));
      b.buttons(endButtons);
      b.buttons([
        richButton.callback('🔍 New Search', encodeCallback(id, 'search', 'from_media'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { home: true, fromMedia: true }));
      b.validate();
      await editOrSend(ctx, b.toJSON());
      return;
    }

    const mediaFiles = {};
    const previewBlocks = [];
    let idx = 0;
    for (const p of nextMedia) {
      if (!p.sha256) continue;
      const buffer = app.media.cache.read(p.sha256);
      if (buffer) {
        if (p.type === 'video') {
          const field = `video_${idx}`;
          mediaFiles[field] = { buffer, filename: `${field}.mp4`, contentType: p.mime ?? 'video/mp4' };
          previewBlocks.push({ type: 'video', ref: `attach://${field}` });
        } else {
          const field = `photo_${idx}`;
          mediaFiles[field] = { buffer, filename: `${field}.jpg`, contentType: p.mime ?? 'image/jpeg' };
          previewBlocks.push({ type: 'photo', ref: `attach://${field}` });
        }
        idx++;
      }
    }

    const nextOffset = numOffset + nextMedia.length;
    const resultStub = {
      searchId,
      query: searchRow?.query ?? '',
      mode: searchRow?.mode ?? 'normal',
      results: { length: totalMedia },
      stats: { duplicatesFound: searchRow?.duplicates_found ?? 0 }
    };

    // In-place update with new slideshow in the SAME message!
    const rich = resultsRich(resultStub, nextOffset, totalMedia, previewBlocks, numOffset);
    const files = previewBlocks.length > 0 ? mediaFiles : null;
    const screenMsgId = ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId;
    if (screenMsgId) {
      await api.editMessageRich(chatId, screenMsgId, rich, {}, files).catch(async () => {
        const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
        if (cardMsg?.message_id) {
          app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
          app.telegram.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
          ctx.sm?.update(ctx.tgId, { screenMessageId: cardMsg.message_id });
        }
      });
    } else {
      const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
      if (cardMsg?.message_id) {
        app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
        app.telegram.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
        ctx.sm?.update(ctx.tgId, { screenMessageId: cardMsg.message_id });
      }
    }
  }

  async function showMoreVideos(ctx, searchId, offset = 10) {
    return showMoreAlbum(ctx, searchId, offset);
  }

  // ── State machine handlers ──────────────────────────────────────────────
  function registerStateHandlers(sm) {
    sm.register(States.PINTEREST_SEARCH, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        if (message.message_id) {
          await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        if (sctx.context.stage === 'historySearch') {
          await showHistory(sctx, 0, text);
          return true;
        }
        if (sctx.context.stage === 'count') {
          const parsed = parseInt(text, 10);
          if (!isNaN(parsed) && parsed > 0) {
            await runSearch(sctx, sctx.context.query, parsed);
            return true;
          }
        }
        await askCount(sctx, text, sctx.context.mode || 'normal');
        return true;
      },
      onTimeout: async (sctx) => {
        await (sctx.api || app.telegram.api).sendMessage(sctx.chatId, '♡ search timed out — send a new query whenever you are ready.').catch(() => {});
      },
      onCleanup: (sctx) => {
        activeSearches.get(sctx.tgId)?.abort();
        activeSearches.delete(sctx.tgId);
      }
    });
  }

  async function showClearHistoryConfirm(ctx) {
    const b = new RichMessageBuilder();
    b.heading('🧹 CLEAR SEARCH HISTORY', 2);
    b.paragraph(rt.bold('Are you sure you want to clear your search & media history?'));
    b.paragraph(rt.italic('This will remove all your previous searches and media history records ♡'));
    b.divider();
    b.buttons([
      richButton.callback('⚠️ Yes, Clear History', encodeCallback(id, 'clearHistoryDo'), { style: 'danger' }),
      richButton.callback('« Cancel', encodeCallback(id, 'history'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function handleClearHistoryDo(ctx) {
    const userId = Number(ctx.tgId);
    const searches = app.pinterest.db.all('SELECT id FROM pinterest_searches WHERE user_id = ?', userId);
    for (const s of searches) {
      app.pinterest.db.run('DELETE FROM pinterest_media WHERE search_id = ?', s.id);
    }
    app.pinterest.db.run('DELETE FROM pinterest_searches WHERE user_id = ?', userId);
    app.db.run('DELETE FROM user_media_history WHERE user_id = ?', userId);

    const b = new RichMessageBuilder();
    b.heading('✓ HISTORY CLEARED', 2);
    b.paragraph(rt.italic('Your search and media history has been successfully purged ♡'));
    b.divider();
    b.buttons([
      richButton.callback('« Back to Pinterest', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  return {
    id,
    registerStateHandlers,
    async executeSearch(ctx, query, count = 5) {
      await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
        context: { query, mode: 'normal', goal: count, stage: 'count' }
      });
      const sctx = ctx.sm.ctxFor(ctx.tgId);
      sctx.messageId = ctx.messageId;
      sctx.screenMessageId = ctx.messageId;
      return runSearch(sctx, query, count);
    },
    async open(ctx) {
      await ctx.sm.reset(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return this.open(ctx);
        case 'search':
          return askQuery(ctx, 'normal');
        case 'mode': {
          const mode = args[0] ?? 'normal';
          if (!SEARCH_MODES.includes(mode)) return;
          return askQuery(ctx, mode);
        }
        case 'count':
        case 'runCount': {
          const count = Number(args[0]);
          const mode = args[1] || 'normal';
          const query = args[2] || '';
          const sctx = ctx.sm.ctxFor(ctx.tgId);
          const clickedMsgId = ctx.query?.message?.message_id;
          if (clickedMsgId) {
            sctx.screenMessageId = clickedMsgId;
            sctx.update({ mode, query, goal: count, screenMessageId: clickedMsgId });
            ctx.controller?.userScreenMessage?.set(ctx.tgId, { chatId: ctx.chatId, messageId: clickedMsgId });
          } else {
            sctx.update({ mode, query, goal: count });
          }
          return runSearch(sctx, query, count);
        }
        case 'customCount': {
          const mode = args[0] || 'normal';
          const query = args[1] || '';
          return askCustomCount(ctx, query, mode);
        }
        case 'results':
          return showResults(ctx);
        case 'history':
          return showHistory(ctx, 0, '');
        case 'historyPage': {
          const page = Number(args[0]) || 0;
          const filter = args[1] || '';
          return showHistory(ctx, page, filter);
        }
        case 'searchHistoryPrompt':
          return askHistorySearchQuery(ctx);
        case 'clearHistoryConfirm':
          return showClearHistoryConfirm(ctx);
        case 'clearHistoryDo':
          return handleClearHistoryDo(ctx);
        case 'reuse':
          return reuseSearch(ctx, args[0]);
        case 'more_album':
        case 'moreAlbum':
        case 'prev_album':
        case 'prevAlbum': {
          const searchId = Number(args[0]);
          const offset = Number(args[1] ?? 0);
          return showMoreAlbum(ctx, searchId, offset);
        }
        case 'moreVideos':
        case 'prevVideos': {
          const searchId = Number(args[0]);
          const offset = Number(args[1] ?? 5);
          return showMoreVideos(ctx, searchId, offset);
        }
        case 'back':
        case 'cancel':
          activeSearches.get(ctx.tgId)?.abort();
          await ctx.sm.cancel(ctx.tgId);
          return openMenu(ctx);
        case 'noop':
          return;
        default:
          return openMenu(ctx);
      }
    }
  };
}

// ── Progress / results / error renderers ────────────────────────────────────

function progressRich({ stage, mode, depth, query, goal = 60, ...p }) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold(banner([
    '𓆩♡𓆪 SEARCHING PINTEREST 𓆩♡𓆪',
    `"${truncate(query ?? '', 24)}"`
  ])));
  b.divider();
  b.table([
    [
      { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
      { text: rt.bold(truncate(query ?? '', 28)), align: 'right', valign: 'middle' }
    ],
    [
      { text: '˙ᵕ˙ Mode', align: 'left', valign: 'middle' },
      { text: rt.bold(mode === 'normal' ? 'Normal (HD+Video)' : (mode ?? 'normal')), align: 'right', valign: 'middle' }
    ],
    [
      { text: '୨୧ Target', align: 'left', valign: 'middle' },
      { text: rt.bold(`${goal} picks`), align: 'right', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();

  // Dynamic elapsed timer + ETA for responsive, lively feedback
  const elapsedSec = Math.floor((p.elapsedMs ?? 0) / 1000);
  const totalWaitSec = Math.max(mode === 'videos' ? 20 : 12, Math.round(goal * (mode === 'videos' ? 4.5 : 0.35)));
  const countdownSec = Math.max(0, totalWaitSec - elapsedSec);
  const waitDurationText = totalWaitSec >= 60 ? `Wait ~${Math.ceil(totalWaitSec / 60)}min` : `Wait ${totalWaitSec}s`;
  const countdownText = countdownSec > 0 ? `${countdownSec}s remaining` : 'finishing up...';
  const timeHeader = `⏳ ${waitDurationText} • ⏱ Countdown: ${countdownText} (elapsed ${String(elapsedSec).padStart(2, '0')}s)`;

  let stepLabel = 'Connecting to Pinterest...';
  if (stage === 'searching') {
    stepLabel = `Collected ${p.collected ?? 0} candidates (page ${p.pagesFetched ?? 1})`;
  } else if (stage === 'validating') {
    stepLabel = `Validating HD streams (${p.valid ?? 0}/${goal} picks)`;
  } else if (stage === 'done') {
    stepLabel = `Ready! Found ${p.results ?? 0} aesthetic picks`;
  }

  // Mini-wide compact clean log (never extended blockquotes)
  const miniLog = `${timeHeader}\n˙ᵕ˙ ${stepLabel} ♡`;
  b.paragraph(miniLog);
  b.footer(rt.italic('୨୧ live updates in-place • no waiting in the dark ˙ᵕ˙'));
  b.validate();
  return b.toJSON();
}

function resultsRich(result, currentOffset = 10, totalImages = 0, previewAttachments = [], startOffset = null) {
  const b = new RichMessageBuilder();
  const count = Array.isArray(result.results) ? result.results.length : (result.results?.length ?? totalImages);
  const total = Math.max(Number(totalImages) || 0, Number(count) || 0);
  b.paragraph(rt.bold(banner([
    '𓆩♡𓆪 SEARCH COMPLETED 𓆩♡𓆪',
    `found: ${count} aesthetic picks`
  ])));
  b.divider();

  // If preview attachments provided, embed the scrollable slideshow directly into this message!
  if (previewAttachments && previewAttachments.length >= 1) {
    const slideItems = previewAttachments.map((item) => {
      if (typeof item === 'string') return block.photo(item);
      if (item.type === 'video') return block.video(item.ref);
      return block.photo(item.ref ?? item);
    });
    b.slideshow(slideItems);
    b.divider();
  }
  b.table([
    [
      { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
      { text: rt.bold(truncate(result.query, 24)), align: 'right', valign: 'middle' }
    ],
    [
      { text: '˙ᵕ˙ Unique results', align: 'left', valign: 'middle' },
      { text: rt.bold(String(count)), align: 'right', valign: 'middle' }
    ],
    [
      { text: '୨୧ Twins removed', align: 'left', valign: 'middle' },
      { text: rt.bold(String(result.stats?.duplicatesFound ?? 0)), align: 'right', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();

  const previewCount = previewAttachments?.length ?? 0;
  const start = startOffset !== null && startOffset !== undefined
    ? Math.max(0, Number(startOffset) || 0)
    : Math.max(0, currentOffset - (previewCount || 10));
  const end = Math.min(total, start + (previewCount || Math.min(10, total - start)));

  if (total > 0 && end > 0) {
    b.paragraph(rt.concat(
      rt.bold('₊˚⊹♡ scroll slideshow above to browse aesthetic picks!'),
      rt.text(`\nʕ•ᴥ•ʔ showing ${start + 1}–${end} of ${total} picks ♡`)
    ));
  } else {
    b.paragraph(rt.concat(
      rt.bold('₊˚⊹♡ scroll slideshow above to browse aesthetic picks!'),
      rt.text('\nʕ•ᴥ•ʔ tap below to create a sticker pack or search again.')
    ));
  }

  const isVideo = result.mode === 'videos';
  const hasPrev = start > 0;
  const hasNext = total > currentOffset;

  const prevOffset = Math.max(0, start - 10);
  const prevBatchSize = start - prevOffset;
  const nextOffset = currentOffset;
  const nextBatchSize = Math.min(10, total - nextOffset);

  if (hasPrev && hasNext) {
    const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
    const nextRange = `(${nextOffset + 1}–${nextOffset + nextBatchSize})`;
    const prevLabel = isVideo ? `← Prev ${prevRange}` : `← Prev ${prevRange}`;
    const nextLabel = isVideo ? `Next ${nextRange} →` : `Next ${nextRange} →`;
    b.buttons([
      richButton.callback(prevLabel, encodeCallback('pinterest', 'moreAlbum', String(result.searchId), String(prevOffset)), { style: 'primary' }),
      richButton.callback(nextLabel, encodeCallback('pinterest', 'moreAlbum', String(result.searchId), String(nextOffset)), { style: 'primary' })
    ]);
  } else if (hasNext) {
    const nextRange = `(${nextOffset + 1}–${nextOffset + nextBatchSize})`;
    const nextLabel = isVideo
      ? `🎬 Next ${nextBatchSize} Videos ${nextRange} →`
      : `🖼 Next ${nextBatchSize} Picks ${nextRange} →`;
    b.buttons([
      richButton.callback(nextLabel, encodeCallback('pinterest', 'moreAlbum', String(result.searchId), String(nextOffset)), { style: 'primary' })
    ]);
  } else if (hasPrev) {
    const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
    const prevLabel = isVideo
      ? `← 🎬 Prev ${prevBatchSize} Videos ${prevRange}`
      : `← 🖼 Prev ${prevBatchSize} Picks ${prevRange}`;
    b.buttons([
      richButton.callback(prevLabel, encodeCallback('pinterest', 'moreAlbum', String(result.searchId), String(prevOffset)), { style: 'primary' })
    ]);
  }

  b.buttons([
    richButton.callback('✨ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', String(result.searchId), 'from_media'), { style: 'primary' }),
    richButton.callback('➕ Add to Existing Pack', encodeCallback('stickers', 'addExistingFromSearch', String(result.searchId), '0', 'from_media'), { style: 'primary' })
  ]);
  b.buttons([
    richButton.callback('🔍 New Search', encodeCallback('pinterest', 'search', 'from_media'), { style: 'primary' }),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
  ]);
  b.validate();
  return b.toJSON();
}

function errorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('𓆩♡𓆪 SEARCH FAILED', 2);
  b.paragraph(rt.bold(`ʕ•ᴥ•ʔ ${String(error?.userMessage ?? error?.message ?? 'something went wrong')}`));
  b.divider();
  b.buttons([
    richButton.callback('↺ Try Again', encodeCallback('pinterest', 'search', 'from_media'), { style: 'primary' }),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
  ]);
  b.validate();
  return b.toJSON();
}
