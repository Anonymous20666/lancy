import { RichMessageBuilder, rt, richButton, encodeCallback, block } from '../rich.js';
import { navButtons, kvTable, ACCENT, SPARK, banner } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { searchNsfw, NSFW_CATEGORIES } from '../../wallpaper/nsfwSearch.js';
import { truncate } from '../../utils/text.js';
import { checkChatMediaPermissions, formatMediaRestrictedNotice } from '../permissions.js';

export function createNsfwScreen({ app }) {
  const id = 'nsfw';
  const activeSearches = new Map(); // tgId -> AbortController

  function renderMenu(ctx) {
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup');
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 18+ ADULT & HENTAI STUDIO 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ uncensored & ecchi anime, 4K adult wallpapers & live clips ˙ᵕ˙'));
    b.divider();

    b.table(kvTable([
      ['🔞 Uncensored Anime', 'Hentai 4K & character art'],
      ['🌸 Censored / Ecchi', 'High-res soft & aesthetic art'],
      ['🎬 18+ Videos', 'Direct MP4 previews & trailers'],
      ['📸 Real Adult 18+', '4K glamorous & model wallpapers'],
      ['👥 Group Protection', isGroup ? 'Auto-Spoiler Enabled (Masked)' : 'Direct Delivery']
    ]), { compact: true });
    b.divider();

    b.buttons([
      richButton.callback('🔞 Hentai Uncensored', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Hentai Censored / Ecchi', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_CENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎬 18+ Videos (MP4)', encodeCallback(id, 'cat', NSFW_CATEGORIES.VIDEOS), { style: 'primary' }),
      richButton.callback('📸 Real Adult 4K Wallpapers', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('💋 Animated Hentai Clips', encodeCallback(id, 'cat', NSFW_CATEGORIES.ANIMATED), { style: 'primary' }),
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', 'all'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔍 Search by Keyword', encodeCallback(id, 'searchPrompt', 'all'), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('୨୧ group safe: explicit content in groups is masked with spoilers ♡'));
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
    const sent = await api.sendRichMessage(chatId, rich, {}, files);
    if (targetMsgId && sent?.message_id && sent.message_id !== targetMsgId) {
      await api.deleteMessage(chatId, targetMsgId).catch(() => {});
    }
    return sent;
  }

  async function openMenu(ctx) {
    await editOrSend(ctx, renderMenu(ctx));
  }

  async function askQuery(ctx, category = 'all') {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id;
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const categoryLabels = {
      [NSFW_CATEGORIES.HENTAI_UNCENSORED]: 'Uncensored Hentai',
      [NSFW_CATEGORIES.HENTAI_CENSORED]: 'Censored / Ecchi Anime',
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: 'Real Adult 4K Wallpapers',
      [NSFW_CATEGORIES.VIDEOS]: '18+ Videos & Clips',
      [NSFW_CATEGORIES.ANIMATED]: 'Animated Hentai GIFs',
      all: '18+ Adult & Hentai'
    };

    const b = new RichMessageBuilder();
    b.header(`🔞 SEARCH ${categoryLabels[category]?.toUpperCase() || '18+ STUDIO'}`, 1);
    b.paragraph(rt.italic('send me what you want to search for ♡'));
    b.paragraph(rt.concat(
      rt.text('examples: '),
      rt.code('naruto'),
      rt.text(', '),
      rt.code('genshin'),
      rt.text(', '),
      rt.code('tifa'),
      rt.text(', '),
      rt.code('asian model'),
      rt.text(', '),
      rt.code('blonde')
    ));
    b.divider();
    b.buttons([
      richButton.callback('🎲 Random Pick Instead', encodeCallback(id, 'random', category), { style: 'primary' })
    ]);
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();

    const sent = await editOrSend(ctx, b.toJSON());
    if (sent?.message_id && sm) {
      sm.update(tgId, { screenMessageId: sent.message_id });
    }
  }

  async function runSearch(ctx, query = '', category = 'all', page = 0, opts = {}) {
    const tgId = String(ctx.tgId);
    const userId = Number(ctx.tgId);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(chatId) < 0);
    const replyToId = opts.replyToMessageId || ctx.message?.message_id || null;

    // Check media permissions in groups
    if (isGroup && api) {
      const caps = await checkChatMediaPermissions(api, chatId);
      if (!caps.canSendPhotos && !caps.canSendVideos) {
        const botUser = app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url: null,
          mediaType: '18+ media',
          actionTitle: 'Search in Private DM'
        });
        await api.sendMessage(chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        return;
      }
    }

    // Fairness concurrency slot guard in group chats
    let releaseSlot = null;
    if (ctx.controller?.acquireUserTaskSlot) {
      releaseSlot = await ctx.controller.acquireUserTaskSlot(tgId, chatId, replyToId, isGroup);
      if (!releaseSlot) return; // rate limit notice sent
    }

    const controller = new AbortController();
    activeSearches.set(tgId, controller);

    const tracker = new ProgressTracker({ api, chatId, messageId: ctx.screenMessageId, heartbeatMs: 2000 });
    const cleanDisplayQ = query ? `"${truncate(query, 24)}"` : 'Spicy Top Picks';

    await tracker.live((state) => {
      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '🔞 SEARCHING 18+ STUDIO',
        cleanDisplayQ
      ])));
      b.divider();
      b.paragraph(`⏳ Searching across adult providers… ♡\n˙ᵕ˙ Category: ${category} • Page: ${page + 1}`);
      b.footer(rt.italic('live deep search in progress ♡'));
      b.validate();
      return b.toJSON();
    }, { stage: 'searching' });

    try {
      const searchRes = await searchNsfw({
        query,
        category,
        page,
        limit: 10,
        signal: controller.signal
      });

      const items = searchRes.results || [];

      if (!items.length) {
        const b = new RichMessageBuilder();
        b.heading('🔞 NO RESULTS FOUND', 2);
        b.paragraph(rt.italic(`could not find any adult results for "${truncate(query, 24)}" ♡`));
        b.paragraph(rt.text('try another anime character, or browse trending spicy picks!'));
        b.divider();
        b.buttons([
          richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', 'all'), { style: 'primary' }),
          richButton.callback('🔞 Hentai Uncensored', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
        ]);
        b.buttons([
          richButton.callback('🔍 Try Another Search', encodeCallback(id, 'searchPrompt', category), { style: 'primary' }),
          richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
        ]);
        b.validate();
        await tracker.finish(b.toJSON());
        return;
      }

      // Record in DB for no-duplicate history and sticker pack creation
      let searchDbId = Date.now();
      try {
        if (app.pinterest?.db) {
          const ins = app.pinterest.db.run(
            'INSERT INTO pinterest_searches (user_id, query, normalized_query, mode, depth, result_count) VALUES (?, ?, ?, ?, ?, ?)',
            userId, query || 'nsfw spicy', (query || 'nsfw').toLowerCase(), 'nsfw', 'deep', items.length
          );
          if (ins?.lastInsertRowid) {
            searchDbId = Number(ins.lastInsertRowid);
            for (const it of items) {
              app.pinterest.db.run(
                `INSERT INTO pinterest_media (search_id, user_id, media_url, type, width, height, quality_score, status, is_duplicate)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', 0)`,
                searchDbId, userId, it.mediaUrl, it.type, it.width || 1280, it.height || 720, 95
              );
            }
          }
        }
      } catch (dbErr) {
        log.debug({ err: dbErr?.message }, 'failed to record nsfw search in db');
      }

      // Build Result Rich Message
      const b = new RichMessageBuilder();
      const requesterMention = ctx.user?.first_name || (tgId ? `User ${tgId}` : 'Bestie');
      const headerTitle = query ? `🔞 18+ RESULTS: "${truncate(query, 20)}"` : '🔞 18+ SPICY PICKS';

      b.paragraph(rt.bold(banner([
        headerTitle,
        `found ${items.length} HD picks • page ${page + 1}`
      ])));
      b.divider();

      // Show top picks list
      b.table([
        [
          { text: '👤 Requester', align: 'left', valign: 'middle' },
          { text: rt.bold(truncate(requesterMention, 20)), align: 'right', valign: 'middle' }
        ],
        [
          { text: '🔞 Category', align: 'left', valign: 'middle' },
          { text: rt.bold(searchRes.category || category), align: 'right', valign: 'middle' }
        ],
        [
          { text: '✨ Page', align: 'left', valign: 'middle' },
          { text: rt.bold(`Page ${page + 1}`), align: 'right', valign: 'middle' }
        ]
      ], { compact: true });
      b.divider();

      // List of results with source & type
      b.table(items.slice(0, 6).map((it, idx) => [
        { text: `#${idx + 1}`, align: 'left', valign: 'middle' },
        { text: it.type === 'video' ? '🎬' : '🔞', align: 'left', valign: 'middle' },
        { text: truncate(it.title, 32), align: 'left', valign: 'middle' },
        { text: it.duration || (it.width ? `${it.width}p` : 'HD'), align: 'right', valign: 'middle' }
      ]), { compact: true });
      b.divider();

      // Download / Media links notice
      if (isGroup) {
        b.paragraph(rt.italic('🔒 In group chats, media can be sent with spoiler protection. Tap a pick below to send to chat or open in DM ♡'));
      }

      // Interactive Action Buttons
      // Quick deliver buttons for top 3 items
      for (let i = 0; i < Math.min(3, items.length); i++) {
        const it = items[i];
        const icon = it.type === 'video' ? '🎬' : '🖼';
        b.buttons([
          richButton.callback(`${icon} View Pick #${i + 1}`, encodeCallback(id, 'sendMedia', String(searchDbId), String(i), isGroup ? '1' : '0'), { style: 'primary' })
        ]);
      }

      // Pagination buttons
      const navRow = [];
      if (page > 0) {
        navRow.push(richButton.callback('← Prev Picks', encodeCallback(id, 'page', String(page - 1), category, query, tgId), { style: 'primary' }));
      }
      if (items.length >= 8) {
        navRow.push(richButton.callback('Next Picks →', encodeCallback(id, 'page', String(page + 1), category, query, tgId), { style: 'primary' }));
      }
      if (navRow.length > 0) {
        b.buttons(navRow);
      }

      b.buttons([
        richButton.callback('✨ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', String(searchDbId)), { style: 'primary' }),
        richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
        richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
      ]);
      b.footer(rt.italic('୨୧ 18+ adult studio • multi-source HD delivery ♡'));
      b.validate();

      await tracker.finish(b.toJSON());
    } catch (err) {
      log.error({ err: err?.message, query }, 'nsfw search failed');
      const b = new RichMessageBuilder();
      b.heading('🔞 SEARCH FAILED', 2);
      b.paragraph(rt.bold(`something went wrong: ${err?.message || 'timeout'}`));
      b.divider();
      b.buttons([
        richButton.callback('↺ Try Again', encodeCallback(id, 'cat', category), { style: 'primary' }),
        richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
    } finally {
      activeSearches.delete(tgId);
      releaseSlot?.();
    }
  }

  async function sendSpecificMedia(ctx, searchDbId, itemIndex, isGroupChat = false) {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId;
    const idx = parseInt(itemIndex, 10) || 0;
    const userId = ctx.tgId;

    let row = null;
    if (app.pinterest?.db) {
      const rows = app.pinterest.db.all(
        'SELECT * FROM pinterest_media WHERE search_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?',
        Number(searchDbId), idx
      );
      row = rows?.[0];
    }

    if (!row?.media_url) {
      if (ctx.query?.id) {
        await api.answerCallbackQuery(ctx.query.id, { text: 'Media expired or not found ♡', show_alert: true }).catch(() => {});
      }
      return;
    }

    const clicker = ctx.query?.from?.first_name || 'Bestie';
    if (ctx.query?.id) {
      await api.answerCallbackQuery(ctx.query.id, { text: `Delivering pick #${idx + 1} for ${clicker} ♡` }).catch(() => {});
    }

    const caption = `🔞 <b>18+ Media Pick #${idx + 1}</b>\n👤 <i>Requested by ${clicker} ♡</i>`;

    if (row.type === 'video' && /\.mp4(\?|$)/i.test(row.media_url)) {
      await api.sendVideo(chatId, row.media_url, {
        caption,
        parse_mode: 'HTML',
        has_spoiler: Boolean(isGroupChat),
        reply_to_message_id: ctx.query?.message?.message_id
      }).catch(async () => {
        // Fallback to sending link
        await api.sendMessage(chatId, `${caption}\n🔗 <a href="${row.media_url}">Watch Video Stream</a>`, {
          parse_mode: 'HTML',
          reply_to_message_id: ctx.query?.message?.message_id
        }).catch(() => {});
      });
    } else {
      await api.sendPhoto(chatId, row.media_url, {
        caption,
        parse_mode: 'HTML',
        has_spoiler: Boolean(isGroupChat),
        reply_to_message_id: ctx.query?.message?.message_id
      }).catch(async () => {
        // Fallback to document
        await api.sendDocument(chatId, row.media_url, {
          caption,
          parse_mode: 'HTML',
          reply_to_message_id: ctx.query?.message?.message_id
        }).catch(() => {});
      });
    }
  }

  function registerStateHandlers(sm) {
    sm.register(States.NSFW_SEARCH_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;

        const isGroup = Boolean(sctx.isGroup || message.chat?.type === 'group' || message.chat?.type === 'supergroup' || (sctx.chatId && Number(sctx.chatId) < 0));

        if (isGroup) {
          const botPromptMsgId = message.reply_to_message?.message_id || sctx.screenMessageId || sctx.context?.screenMessageId;
          if (botPromptMsgId) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, botPromptMsgId).catch(() => {});
          }
          await runSearch(sctx, text, sctx.context?.category || 'all', 0, { replyToMessageId: message.message_id });
        } else {
          if (message.message_id) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
          }
          await runSearch(sctx, text, sctx.context?.category || 'all', 0);
        }
        return true;
      },
      onTimeout: async (sctx) => {
        await (sctx.api || app.telegram.api).sendMessage(sctx.chatId, '♡ 18+ search timed out — send a new query whenever you are ready.').catch(() => {});
      },
      onCleanup: (sctx) => {
        activeSearches.get(sctx.tgId)?.abort();
        activeSearches.delete(sctx.tgId);
      }
    });
  }

  return {
    id,
    registerStateHandlers,
    async executeSearch(ctx, query, category = 'all', page = 0) {
      return runSearch(ctx, query, category, page);
    },
    async open(ctx) {
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
        case 'menu':
          return openMenu(ctx);
        case 'cat':
          return askQuery(ctx, args[0] || 'all');
        case 'searchPrompt':
          return askQuery(ctx, args[0] || 'all');
        case 'random': {
          const cat = args[0] || 'all';
          const randomTags = ['genshin', 'naruto', 'one_piece', 'tsunade', 'tifa', 'honkai', 'chainsaw_man', 'bleach', 'waifu', 'baddie'];
          const pick = randomTags[Math.floor(Math.random() * randomTags.length)];
          return runSearch(ctx, pick, cat, 0);
        }
        case 'page': {
          const targetPage = parseInt(args[0], 10) || 0;
          const cat = args[1] || 'all';
          const query = args[2] || '';
          const originalUserId = args[3] || '';
          const clickerId = String(ctx.tgId || '');
          const clickerName = ctx.query?.from?.first_name || 'User';

          // Multi-user group acknowledgement
          if (ctx.query?.id) {
            if (originalUserId && originalUserId !== clickerId) {
              await ctx.api.answerCallbackQuery(ctx.query.id, {
                text: `👤 ${clickerName} browsing page ${targetPage + 1} ♡`,
                show_alert: false
              }).catch(() => {});
            } else {
              await ctx.api.answerCallbackQuery(ctx.query.id, {
                text: `Page ${targetPage + 1} ♡`
              }).catch(() => {});
            }
          }
          return runSearch(ctx, query, cat, targetPage);
        }
        case 'sendMedia': {
          const searchDbId = args[0];
          const itemIndex = args[1];
          const isGroupChat = args[2] === '1';
          return sendSpecificMedia(ctx, searchDbId, itemIndex, isGroupChat);
        }
        case 'back':
        case 'cancel':
          activeSearches.get(ctx.tgId)?.abort();
          await ctx.sm?.cancel?.(ctx.tgId);
          return openMenu(ctx);
        default:
          return openMenu(ctx);
      }
    }
  };
}
