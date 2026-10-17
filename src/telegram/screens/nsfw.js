import { RichMessageBuilder, rt, richButton, encodeCallback, block } from '../rich.js';
import { navButtons, kvTable, banner } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { searchNsfw, NSFW_CATEGORIES, CATEGORY_SUGGESTIONS } from '../../wallpaper/nsfwSearch.js';
import { truncate } from '../../utils/text.js';
import { checkChatMediaPermissions, formatMediaRestrictedNotice } from '../permissions.js';
import { optimizePreviewImage } from '../../media/convert.js';
import { logger } from '../../core/logger.js';

const log = logger().child({ module: 'nsfw-screen' });

async function fetchPreviewBuffers(items, max = 3) {
  const previewBlocks = [];
  const mediaFiles = {};
  let idx = 0;

  const topItems = (items || []).slice(0, max);
  const promises = topItems.map(async (it) => {
    if (!it.mediaUrl && !it.thumbUrl) return null;
    const targetUrl = it.thumbUrl || it.mediaUrl;
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(3500)
      });
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const rawBuf = Buffer.from(arrayBuf);
      if (it.type === 'video') {
        return { type: 'video', buffer: rawBuf, mime: 'video/mp4' };
      }
      const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1080, quality: 80 });
      return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
    } catch {
      return null;
    }
  });

  const loaded = await Promise.all(promises);
  for (const item of loaded) {
    if (!item) continue;
    const field = `${item.type}_${idx}`;
    mediaFiles[field] = {
      buffer: item.buffer,
      filename: `${field}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
      contentType: item.mime
    };
    previewBlocks.push({ type: item.type, ref: `attach://${field}` });
    idx++;
  }
  return { previewBlocks, mediaFiles };
}

export function createNsfwScreen({ app }) {
  const id = 'nsfw';
  const activeSearches = new Map(); // tgId -> AbortController

  // ── Main Menu ─────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup');
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 18+ ADULT & HENTAI STUDIO 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ anime hentai, 4K adult wallpapers, aesthetic explicit art & videos ˙ᵕ˙'));
    b.divider();

    b.table(kvTable([
      ['🌸 Hentai Wallpapers', 'Censored / Ecchi & Uncensored 4K'],
      ['🎬 Hentai Videos', 'Animated clips, spicy loops & full videos'],
      ['📸 Adult Wallpapers', '4K glamour, boudoir, sensual models & art'],
      ['🎥 Adult Videos', 'Video clips / previews & full streaming'],
      ['👥 Group Protection', isGroup ? 'Auto-Spoiler Enabled (Masked)' : 'Direct Delivery']
    ]), { compact: true });
    b.divider();

    // Studio Submenu Launchers
    b.buttons([
      richButton.callback('🌸 Hentai Wallpapers', encodeCallback(id, 'sub', 'hentai_wallpapers'), { style: 'primary' }),
      richButton.callback('🎬 Hentai Videos', encodeCallback(id, 'sub', 'hentai_videos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Adult Wallpapers (4K)', encodeCallback(id, 'sub', 'real_wallpapers'), { style: 'primary' }),
      richButton.callback('🎥 Adult Videos', encodeCallback(id, 'sub', 'real_videos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', 'all'), { style: 'primary' }),
      richButton.callback('🔍 Universal 18+ Search', encodeCallback(id, 'searchPrompt', 'all'), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('୨୧ multi-source adult engine • Wallhaven 4K, Yande.re, Nekobot & Spankbang ♡'));
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 1: Hentai Wallpapers ──────────────────────────────────────────
  function renderHentaiWallpapersMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 HENTAI WALLPAPERS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ choose your desired spice level for high-res anime wallpapers ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🌸 Censored / Ecchi (Soft & Aesthetic)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_CENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔞 Uncensored (R-18 Explicit 4K)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Hentai Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.divider();

    // Popular suggestions buttons
    b.paragraph(rt.bold('✨ Trending Anime Characters:'));
    b.buttons([
      richButton.callback('🌸 Tifa', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, 'tifa'), { style: 'primary' }),
      richButton.callback('🌸 Makima', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, 'makima'), { style: 'primary' }),
      richButton.callback('🌸 Genshin', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, 'genshin'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🌸 Tsunade', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, 'tsunade'), { style: 'primary' }),
      richButton.callback('🌸 Yor Forger', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, 'yor_forger'), { style: 'primary' }),
      richButton.callback('🌸 2B', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_UNCENSORED, '2b'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 2: Hentai Videos ──────────────────────────────────────────────
  function renderHentaiVideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 HENTAI VIDEOS & CLIPS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ animated clips, spicy loops, and full streaming anime videos ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('💋 Animated Clips & Loops (GIF/MP4)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Full Hentai Videos & Episodes', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Hentai Video Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.divider();

    // Popular suggestions buttons
    b.paragraph(rt.bold('✨ Popular Video Searches:'));
    b.buttons([
      richButton.callback('🎞 Genshin', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS, 'genshin'), { style: 'primary' }),
      richButton.callback('🎞 Tifa 3D', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS, 'tifa 3d'), { style: 'primary' }),
      richButton.callback('🎞 OverFlow', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS, 'overflow'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('💋 Blowjob Loop', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_CLIPS, 'blowjob'), { style: 'primary' }),
      richButton.callback('💋 Ecchi Dance', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.HENTAI_CLIPS, 'dance'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 3: Real Adult Wallpapers (NO censored wallpaper side!) ────────
  function renderRealWallpapersMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 REAL ADULT 4K WALLPAPERS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ 4K glamour, aesthetic boudoir, sensual models & explicit adult photography ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search 4K Wallpapers', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('🎲 Random 4K Adult Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.divider();

    // Category / Style Suggestions
    b.paragraph(rt.bold('📸 Explore Models & Aesthetic Styles:'));
    b.buttons([
      richButton.callback('📸 Asian Model', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'asian model'), { style: 'primary' }),
      richButton.callback('📸 Latina', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'latina'), { style: 'primary' }),
      richButton.callback('📸 Blonde', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'blonde'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Brunette', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'brunette'), { style: 'primary' }),
      richButton.callback('📸 Glamour', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'glamour'), { style: 'primary' }),
      richButton.callback('📸 Boudoir', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'boudoir'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Baddie', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'baddie'), { style: 'primary' }),
      richButton.callback('📸 Fitness', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'fitness model'), { style: 'primary' }),
      richButton.callback('📸 Aesthetic', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_WALLPAPERS, 'aesthetic model'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 4: Real Adult Videos (Clips + Full Videos) ─────────────────────
  function renderRealVideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 REAL ADULT VIDEOS & CLIPS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ direct playable MP4 previews, video clips, and full streaming videos ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🎬 Video Clips & Previews (Fast MP4)', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Full Adult Videos & Streams', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Spicy Video Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.divider();

    // Popular suggestions buttons
    b.paragraph(rt.bold('✨ Trending Video Categories:'));
    b.buttons([
      richButton.callback('🎬 Asian Clip', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_CLIPS, 'asian'), { style: 'primary' }),
      richButton.callback('🎬 Latina Clip', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_CLIPS, 'latina'), { style: 'primary' }),
      richButton.callback('🎬 Glamour Teaser', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_CLIPS, 'glamour'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Baddie Full', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_FULL_VIDEOS, 'baddie'), { style: 'primary' }),
      richButton.callback('🎞 Brunette Full', encodeCallback(id, 'quickSearch', NSFW_CATEGORIES.REAL_FULL_VIDEOS, 'brunette'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
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
      [NSFW_CATEGORIES.HENTAI_CENSORED]: 'Censored / Ecchi Anime Wallpapers',
      [NSFW_CATEGORIES.HENTAI_UNCENSORED]: 'Uncensored Hentai 4K Wallpapers',
      [NSFW_CATEGORIES.HENTAI_CLIPS]: 'Animated Hentai Clips & Loops',
      [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: 'Hentai Videos & Episodes',
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: 'Real Adult 4K Wallpapers',
      [NSFW_CATEGORIES.REAL_CLIPS]: 'Real Adult Video Clips & Previews',
      [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: 'Full Adult Videos',
      all: '18+ Adult & Hentai Studio'
    };

    const categoryExamples = {
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['asian model', 'brunette', 'blonde', 'latina', 'glamour', 'boudoir', 'baddie'],
      [NSFW_CATEGORIES.REAL_CLIPS]: ['asian', 'latina', 'brunette', 'teaser', 'glamour'],
      [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['asian', 'latina', 'blonde', 'baddie', 'brunette'],
      [NSFW_CATEGORIES.HENTAI_UNCENSORED]: ['tifa', 'tsunade', 'genshin', 'makima', 'yor forger', '2b', 'marin'],
      [NSFW_CATEGORIES.HENTAI_CENSORED]: ['waifu', 'swimsuit', 'lingerie', 'genshin', 'honkai', 'anime girl'],
      [NSFW_CATEGORIES.HENTAI_CLIPS]: ['blowjob', 'fuck', 'anal', 'cum', 'dance'],
      [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: ['genshin', 'tifa 3d', 'overflow', 'naruto', 'cosplay'],
      all: ['tifa', 'asian model', 'genshin', 'blonde', 'waifu', 'latina']
    };

    const examples = categoryExamples[category] || categoryExamples.all;
    const exampleParts = [rt.text('examples: ')];
    examples.forEach((ex, i) => {
      if (i > 0) exampleParts.push(rt.text(', '));
      exampleParts.push(rt.code(ex));
    });

    const b = new RichMessageBuilder();
    b.header(`🔞 SEARCH ${categoryLabels[category]?.toUpperCase() || '18+ STUDIO'}`, 1);
    b.paragraph(rt.italic('send me what you want to search for ♡'));
    b.paragraph(rt.concat(...exampleParts));
    b.divider();

    // Quick suggestion buttons on query prompt
    const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS.all;
    if (suggestions && suggestions.length >= 3) {
      b.paragraph(rt.bold('✨ Quick Pick or Tap Below:'));
      b.buttons(suggestions.slice(0, 3).map(s =>
        richButton.callback(s, encodeCallback(id, 'quickSearch', category, s.replace(/^[^\w]+/, '').trim()), { style: 'primary' })
      ));
    }

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
      b.paragraph(`⏳ Searching Wallhaven 4K, Yande.re, Nekobot & Spankbang… ♡\n˙ᵕ˙ Category: ${category} • Page: ${page + 1}`);
      b.footer(rt.italic('live multi-source deep search in progress ♡'));
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
        b.paragraph(rt.text('try another term, or browse trending spicy picks!'));
        b.divider();
        b.buttons([
          richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category), { style: 'primary' }),
          richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu'), { style: 'primary' })
        ]);
        b.buttons([
          richButton.callback('🔍 Try Another Search', encodeCallback(id, 'cat', category), { style: 'primary' }),
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

      // Fetch preview images so pictures are visibly embedded in the slideshow
      let previewFiles = null;
      try {
        const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(items, 3);
        if (previewBlocks.length > 0) {
          const slideItems = previewBlocks.map((p) => {
            if (p.type === 'video') return block.video(p.ref);
            return block.photo(p.ref);
          });
          b.slideshow(slideItems);
          b.divider();
          if (Object.keys(mediaFiles).length > 0) {
            previewFiles = mediaFiles;
          }
        }
      } catch (e) {
        log.debug({ err: e?.message }, 'could not attach preview buffers');
      }

      // Show top picks metadata table
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
        b.paragraph(rt.italic('🔒 In group chats, media is delivered with spoiler protection. Tap a pick below to send to chat or open in DM ♡'));
      }

      // Quick deliver buttons for top 3 items
      for (let i = 0; i < Math.min(3, items.length); i++) {
        const it = items[i];
        const icon = it.type === 'video' ? '🎬' : '🖼';
        b.buttons([
          richButton.callback(`${icon} View / Send Pick #${i + 1}`, encodeCallback(id, 'sendMedia', String(searchDbId), String(i), isGroup ? '1' : '0'), { style: 'primary' })
        ]);
      }

      // Pagination navigation buttons
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

      // ── Search Suggestions Buttons in Pagination ──────────────────────────
      const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS[searchRes.category] || CATEGORY_SUGGESTIONS.all;
      if (suggestions && suggestions.length >= 3) {
        const randomSuggestions = suggestions
          .filter(s => s.toLowerCase() !== query.toLowerCase())
          .slice(0, 3);
        if (randomSuggestions.length > 0) {
          b.buttons(randomSuggestions.map(s =>
            richButton.callback(s, encodeCallback(id, 'quickSearch', category, s.replace(/^[^\w]+/, '').trim()), { style: 'primary' })
          ));
        }
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

      await tracker.finish(b.toJSON(), previewFiles);

      // Auto-deliver top pick directly into chat for random spicy pick
      if (opts.isRandomPick && items[0]) {
        const top = items[0];
        const caption = `🔞 <b>${top.title || '18+ Spicy Pick'}</b>\n👤 <i>Delivered for ${requesterMention} ♡</i>`;
        try {
          if (top.type === 'video') {
            await api.sendVideo(chatId, top.mediaUrl, {
              caption,
              parse_mode: 'HTML',
              has_spoiler: Boolean(isGroup)
            }).catch(async () => {
              if (previewFiles?.['video_0']?.buffer) {
                await api.sendVideo(chatId, previewFiles['video_0'].buffer, {
                  caption,
                  parse_mode: 'HTML',
                  has_spoiler: Boolean(isGroup)
                });
              }
            });
          } else {
            await api.sendPhoto(chatId, top.mediaUrl, {
              caption,
              parse_mode: 'HTML',
              has_spoiler: Boolean(isGroup)
            }).catch(async () => {
              if (previewFiles?.['photo_0']?.buffer) {
                await api.sendPhoto(chatId, previewFiles['photo_0'].buffer, {
                  caption,
                  parse_mode: 'HTML',
                  has_spoiler: Boolean(isGroup)
                });
              }
            });
          }
        } catch (deliveryErr) {
          log.debug({ err: deliveryErr?.message }, 'direct random pick delivery failed');
        }
      }
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
        // Fallback: fetch buffer and upload directly
        try {
          const res = await fetch(row.media_url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(6000)
          });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            return await api.sendPhoto(chatId, buf, {
              caption,
              parse_mode: 'HTML',
              has_spoiler: Boolean(isGroupChat),
              reply_to_message_id: ctx.query?.message?.message_id
            });
          }
        } catch {}
        await api.sendMessage(chatId, `${caption}\n🔗 <a href="${row.media_url}">Open HD Wallpaper</a>`, {
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
        case 'sub': {
          const subCategory = args[0] || '';
          if (subCategory === 'hentai_wallpapers') {
            return editOrSend(ctx, renderHentaiWallpapersMenu(ctx));
          } else if (subCategory === 'hentai_videos') {
            return editOrSend(ctx, renderHentaiVideosMenu(ctx));
          } else if (subCategory === 'real_wallpapers') {
            return editOrSend(ctx, renderRealWallpapersMenu(ctx));
          } else if (subCategory === 'real_videos') {
            return editOrSend(ctx, renderRealVideosMenu(ctx));
          }
          return openMenu(ctx);
        }
        case 'cat':
          return askQuery(ctx, args[0] || 'all');
        case 'searchPrompt':
          return askQuery(ctx, args[0] || 'all');
        case 'quickSearch': {
          const cat = args[0] || 'all';
          const query = args[1] || '';
          return runSearch(ctx, query, cat, 0);
        }
        case 'random': {
          const cat = args[0] || 'all';
          const randomPools = {
            [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['asian model', 'brunette', 'blonde', 'latina', 'glamour', 'boudoir', 'baddie', 'fitness model'],
            [NSFW_CATEGORIES.REAL_CLIPS]: ['asian clip', 'latina clip', 'teaser', 'glamour preview'],
            [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['asian', 'latina', 'blonde', 'baddie', 'brunette'],
            [NSFW_CATEGORIES.HENTAI_UNCENSORED]: ['tifa', 'tsunade', 'raiden_shogun', 'makima', 'yor_forger', 'marin_kitagawa', '2b', 'yae_miko', 'r34'],
            [NSFW_CATEGORIES.HENTAI_CENSORED]: ['waifu', 'swimsuit', 'lingerie', 'genshin_impact', 'honkai_star_rail', 'anime_girl'],
            [NSFW_CATEGORIES.HENTAI_CLIPS]: ['blowjob', 'fuck', 'anal', 'cum', 'dance'],
            [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: ['genshin hentai', 'tifa 3d', 'overflow', 'naruto hentai'],
            all: ['tifa', 'asian model', 'genshin', 'blonde', 'tsunade', 'brunette', 'latina', 'waifu']
          };
          const pool = randomPools[cat] || randomPools.all;
          const pick = pool[Math.floor(Math.random() * pool.length)];
          return runSearch(ctx, pick, cat, 0, { isRandomPick: true });
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
