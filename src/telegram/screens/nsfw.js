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

/**
 * Fetch HD buffers for preview slideshow (1080p+ quality, no 150px thumbnails).
 */
async function fetchPreviewBuffers(items, max = 10) {
  const previewBlocks = [];
  const mediaFiles = {};
  let idx = 0;

  const topItems = (items || []).slice(0, max);
  const promises = topItems.map(async (it) => {
    const isVideo = it.type === 'video';
    // For videos, ALWAYS fetch genuine playable video stream (data-pvv / td.mp4 / direct mp4)
    // NEVER prioritize thumbUrl over video stream!
    const targetUrl = isVideo
      ? (it.videoUrl || it.mediaUrl || it.media_url)
      : (it.thumbUrl || it.media_url || it.mediaUrl);
    if (!targetUrl) return null;
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(7000)
      });
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const rawBuf = Buffer.from(arrayBuf);
      if (rawBuf.length < 50) return null;

      if (isVideo) {
        // Inspect magic bytes:
        // JPEG starts with 0xFF 0xD8
        // PNG starts with 0x89 0x50 0x4E 0x47
        // GIF starts with GIF8
        const isImage = (rawBuf[0] === 0xff && rawBuf[1] === 0xd8) ||
                        (rawBuf[0] === 0x89 && rawBuf[1] === 0x50) ||
                        (rawBuf[0] === 0x47 && rawBuf[1] === 0x49 && rawBuf[2] === 0x46);

        if (isImage) {
          // If server returned an image instead of a video, deliver it as photo
          // so Telegram mobile player never fails with "App was unable to play this video"
          const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1280, quality: 88 });
          return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
        }

        // Genuine playable MP4 video!
        return { type: 'video', buffer: rawBuf, mime: 'video/mp4' };
      }

      // Crisp 1280px HD optimization for photos
      const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1280, quality: 88 });
      return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
    } catch {
      // Fallback: If video download timed out or failed, try its preview thumbnail as photo
      if (isVideo && it.thumbUrl && it.thumbUrl !== targetUrl) {
        try {
          const tRes = await fetch(it.thumbUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(4000)
          });
          if (tRes.ok) {
            const tBuf = Buffer.from(await tRes.arrayBuffer());
            const optBuf = await optimizePreviewImage(tBuf, { maxDimension: 1280, quality: 88 });
            return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
          }
        } catch {}
      }
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

    b.paragraph(rt.bold('✨ Trending Anime Characters:'));
    b.buttons([
      richButton.callback('🌸 Tifa', encodeCallback(id, 'askCountDirect', 'tifa', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Makima', encodeCallback(id, 'askCountDirect', 'makima', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Genshin', encodeCallback(id, 'askCountDirect', 'genshin', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🌸 Tsunade', encodeCallback(id, 'askCountDirect', 'tsunade', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Yor Forger', encodeCallback(id, 'askCountDirect', 'yor_forger', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 2B', encodeCallback(id, 'askCountDirect', '2b', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
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

    b.paragraph(rt.bold('✨ Popular Video Searches:'));
    b.buttons([
      richButton.callback('🎞 Genshin', encodeCallback(id, 'askCountDirect', 'genshin', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 Tifa 3D', encodeCallback(id, 'askCountDirect', 'tifa 3d', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 OverFlow', encodeCallback(id, 'askCountDirect', 'overflow', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('💋 Blowjob Loop', encodeCallback(id, 'askCountDirect', 'blowjob', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' }),
      richButton.callback('💋 Ecchi Dance', encodeCallback(id, 'askCountDirect', 'dance', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' })
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

    b.paragraph(rt.bold('📸 Explore Models & Aesthetic Styles:'));
    b.buttons([
      richButton.callback('📸 Asian Model', encodeCallback(id, 'askCountDirect', 'asian model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Latina', encodeCallback(id, 'askCountDirect', 'latina', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Blonde', encodeCallback(id, 'askCountDirect', 'blonde', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Brunette', encodeCallback(id, 'askCountDirect', 'brunette', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Glamour', encodeCallback(id, 'askCountDirect', 'glamour', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Boudoir', encodeCallback(id, 'askCountDirect', 'boudoir', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Baddie', encodeCallback(id, 'askCountDirect', 'baddie', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Fitness', encodeCallback(id, 'askCountDirect', 'fitness model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Aesthetic', encodeCallback(id, 'askCountDirect', 'aesthetic model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
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

    b.paragraph(rt.bold('✨ Trending Video Categories:'));
    b.buttons([
      richButton.callback('🎬 Asian Clip', encodeCallback(id, 'askCountDirect', 'asian', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' }),
      richButton.callback('🎬 Latina Clip', encodeCallback(id, 'askCountDirect', 'latina', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' }),
      richButton.callback('🎬 Glamour Teaser', encodeCallback(id, 'askCountDirect', 'glamour', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Baddie Full', encodeCallback(id, 'askCountDirect', 'baddie', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 Brunette Full', encodeCallback(id, 'askCountDirect', 'brunette', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' })
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

  // ── Step 1: Ask Query ─────────────────────────────────────────────────────
  async function askQuery(ctx, category = 'all') {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id ?? ctx.screenMessageId;
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, stage: 'query', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, stage: 'query', screenMessageId: screenMsgId },
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
    b.paragraph(rt.italic('tell me what to search for ♡'));
    b.paragraph(rt.concat(...exampleParts));
    b.divider();

    // Quick suggestion buttons on query prompt
    const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS.all;
    if (suggestions && suggestions.length >= 3) {
      b.paragraph(rt.bold('✨ Quick Pick or Tap Below:'));
      b.buttons(suggestions.slice(0, 3).map(s =>
        richButton.callback(s, encodeCallback(id, 'askCountDirect', s.replace(/^[^\w]+/, '').trim(), category), { style: 'primary' })
      ));
    }

    b.buttons([
      richButton.callback('🎲 Random Pick Instead', encodeCallback(id, 'random', category), { style: 'primary' })
    ]);
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();

    const sent = await editOrSend(ctx, b.toJSON());
    const effectiveMsgId = sent?.message_id || screenMsgId;
    if (effectiveMsgId) {
      ctx.messageId = effectiveMsgId;
      ctx.screenMessageId = effectiveMsgId;
      if (ctx.update) {
        ctx.update({ category, stage: 'query', screenMessageId: effectiveMsgId });
      } else if (sm) {
        sm.update(tgId, { category, stage: 'query', screenMessageId: effectiveMsgId });
      }
      ctx.controller?.userScreenMessage?.set(tgId, { chatId: ctx.chatId, messageId: effectiveMsgId });
      app.telegram?.controller?.userScreenMessage?.set(tgId, { chatId: ctx.chatId, messageId: effectiveMsgId });
    }
  }

  // ── Step 2: Ask Count Selection (Exact Pinterest UX) ──────────────────────
  async function askCount(ctx, query, category = 'all', opts = {}) {
    const isVideo = category.includes('video') || category.includes('clip');
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const replyToMessageId = opts.replyToMessageId ?? null;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;

    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const b = new RichMessageBuilder();
    b.heading(isVideo ? '🎬 VIDEO RESULT COUNT' : '✨ 18+ RESULT COUNT', 2);
    b.paragraph(rt.italic(`how many aesthetic picks should I find for "${truncate(query, 24)}"? ♡`));
    b.divider();
    b.table(kvTable([
      ['Query', truncate(query, 24)],
      ['Category', category],
      ['Quality', '4K / HD Quality Guaranteed']
    ]), { compact: true });
    b.divider();

    if (isVideo) {
      b.buttons([
        richButton.callback('5', encodeCallback(id, 'runCount', '5', category, query), { style: 'primary' }),
        richButton.callback('10', encodeCallback(id, 'runCount', '10', category, query), { style: 'primary' }),
        richButton.callback('15', encodeCallback(id, 'runCount', '15', category, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', category, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🎬 More Videos (+10)', encodeCallback(id, 'runCount', '30', category, query), { style: 'primary' })
      ]);
    } else {
      b.buttons([
        richButton.callback('10', encodeCallback(id, 'runCount', '10', category, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', category, query), { style: 'primary' }),
        richButton.callback('30', encodeCallback(id, 'runCount', '30', category, query), { style: 'primary' }),
        richButton.callback('50', encodeCallback(id, 'runCount', '50', category, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('60', encodeCallback(id, 'runCount', '60', category, query), { style: 'primary' }),
        richButton.callback('80', encodeCallback(id, 'runCount', '80', category, query), { style: 'primary' }),
        richButton.callback('100', encodeCallback(id, 'runCount', '100', category, query), { style: 'primary' })
      ]);
    }
    b.buttons([
      richButton.callback('♾️ Continuous Exploration', encodeCallback(id, 'runCount', 'continuous', category, query), { style: 'primary' }),
      richButton.callback('✎ Custom Count', encodeCallback(id, 'customCount', category, query), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Back', encodeCallback(id, 'cat', category), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.validate();

    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    let sent;
    if (replyToMessageId) {
      sent = await api.sendRichMessage(chatId, b.toJSON(), {
        reply_parameters: { message_id: replyToMessageId },
        reply_to_message_id: replyToMessageId
      });
    } else {
      sent = await editOrSend(ctx, b.toJSON());
    }

    const effectiveMsgId = sent?.message_id || screenMsgId;
    if (effectiveMsgId) {
      ctx.messageId = effectiveMsgId;
      ctx.screenMessageId = effectiveMsgId;
      if (ctx.transition) {
        await ctx.transition(States.NSFW_SEARCH_INPUT, {
          context: { category, query, stage: 'count', screenMessageId: effectiveMsgId },
          chatId,
          screenMessageId: effectiveMsgId
        });
      } else if (sm) {
        await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
          context: { category, query, stage: 'count', screenMessageId: effectiveMsgId },
          chatId,
          screenMessageId: effectiveMsgId
        });
      }
      if (ctx.update) {
        ctx.update({ category, query, stage: 'count', screenMessageId: effectiveMsgId });
      } else if (sm) {
        sm.update(tgId, { category, query, stage: 'count', screenMessageId: effectiveMsgId });
      }
      ctx.controller?.userScreenMessage?.set(tgId, { chatId, messageId: effectiveMsgId });
      app.telegram?.controller?.userScreenMessage?.set(tgId, { chatId, messageId: effectiveMsgId });
      ctx.db?.run?.(
        'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
        effectiveMsgId, Number(tgId)
      );
    }
  }

  async function askCustomCount(ctx, category = 'all', query = '') {
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }
    const b = new RichMessageBuilder();
    b.heading('✎ CUSTOM RESULT COUNT', 2);
    b.paragraph(rt.italic(`send me the number of 18+ results you want for "${truncate(query, 24)}" (e.g. 50, 80, 100) ♡`));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Step 3: Render Clean Pinterest-Style Results ─────────────────────────
  function renderResultsRich({ searchId, query, category, isContinuous, requestedGoal, totalImages, previewAttachments = [], startOffset = 0, currentOffset = 10 }) {
    const b = new RichMessageBuilder();
    const total = Math.max(Number(totalImages) || 0, previewAttachments.length);

    const bannerLines = isContinuous
      ? ['𓆩♡𓆪 CONTINUOUS SEARCH 𓆩♡𓆪', 'infinite exploration • duplicate-free spicy picks ˙ᵕ˙']
      : ['𓆩♡𓆪 18+ SEARCH COMPLETED 𓆩♡𓆪', `found: ${total} HD picks`];
    b.paragraph(rt.bold(banner(bannerLines)));
    b.divider();

    // The slideshow AT THE TOP IS the result! (Scrollable 10 HD slides)
    if (previewAttachments && previewAttachments.length >= 1) {
      const slideItems = previewAttachments.map((item) => {
        if (typeof item === 'string') return block.photo(item);
        if (item.type === 'video') return block.video(item.ref);
        return block.photo(item.ref ?? item);
      });
      b.slideshow(slideItems);
      b.divider();
    }

    // Clean, short metadata table (NO raw filenames/tags dump table!)
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
        { text: rt.bold(truncate(query || 'Spicy Top Picks', 24)), align: 'right', valign: 'middle' }
      ],
      [
        { text: isContinuous ? '˙ᵕ˙ Mode' : '˙ᵕ˙ Results', align: 'left', valign: 'middle' },
        { text: rt.bold(isContinuous ? 'Continuous Exploration ♾️' : `${total} HD Picks`), align: 'right', valign: 'middle' }
      ],
      [
        { text: '🔞 Category', align: 'left', valign: 'middle' },
        { text: rt.bold(category), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();

    const previewCount = previewAttachments.length;
    const start = Math.max(0, Number(startOffset) || 0);
    const end = Math.min(total, start + (previewCount || 10));

    b.paragraph(rt.concat(
      rt.bold('₊˚⊹♡ scroll slideshow above to browse HD picks!'),
      rt.text(`\nʕ•ᴥ•ʔ showing ${start + 1}–${end} of ${total} picks ♡`)
    ));

    // In-place pagination buttons
    const hasPrev = start > 0;
    const hasNext = isContinuous ? (total > currentOffset || total >= 10) : (total > currentOffset);

    const prevOffset = Math.max(0, start - 10);
    const prevBatchSize = start - prevOffset;
    const nextOffset = currentOffset;
    const nextBatchSize = Math.min(10, total - nextOffset);

    if (hasPrev && hasNext) {
      const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
      const nextRange = isContinuous ? '(Explore More) →' : `(${nextOffset + 1}–${nextOffset + nextBatchSize}) →`;
      const prevLabel = `← Prev ${prevRange}`;
      const nextLabel = isContinuous ? '♾️ Next Picks (Explore More) →' : `Next ${nextRange}`;
      b.buttons([
        richButton.callback(prevLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' }),
        richButton.callback(nextLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(nextOffset), category), { style: 'primary' })
      ]);
    } else if (hasNext) {
      const nextRange = isContinuous ? '(Explore More) →' : `(${nextOffset + 1}–${nextOffset + nextBatchSize}) →`;
      const nextLabel = isContinuous ? '♾️ Next Picks (Explore More) →' : `🖼 Next ${nextBatchSize} Picks ${nextRange}`;
      b.buttons([
        richButton.callback(nextLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(nextOffset), category), { style: 'primary' })
      ]);
    } else if (hasPrev) {
      const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
      b.buttons([
        richButton.callback(`← 🖼 Prev ${prevBatchSize} Picks ${prevRange}`, encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' })
      ]);
    }

    // Smart search suggestion buttons in pagination (tagged from_media)
    const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS.all;
    if (suggestions && suggestions.length >= 3) {
      const filtered = suggestions.filter(s => s.toLowerCase() !== (query || '').toLowerCase()).slice(0, 3);
      if (filtered.length > 0) {
        b.buttons(filtered.map(s =>
          richButton.callback(s, encodeCallback(id, 'askCountDirect', s.replace(/^[^\w]+/, '').trim(), category, 'from_media'), { style: 'primary' })
        ));
      }
    }

    // Action buttons (tagged with from_media so navigating away never overwrites media results!)
    b.buttons([
      richButton.callback('✨ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', String(searchId), 'from_media'), { style: 'primary' }),
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category, 'from_media'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
    ]);
    b.footer(rt.italic('୨୧ 18+ adult studio • multi-source HD delivery ♡'));
    b.validate();
    return b.toJSON();
  }

  function progressRich({ stage, category = 'all', query, goal = 20, elapsedMs = 0, ...p }) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SEARCHING 18+ STUDIO 𓆩♡𓆪',
      `"${truncate(query || 'Spicy Top Picks', 24)}"`
    ])));
    b.divider();
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
        { text: rt.bold(truncate(query || 'Spicy Top Picks', 28)), align: 'right', valign: 'middle' }
      ],
      [
        { text: '🔞 Category', align: 'left', valign: 'middle' },
        { text: rt.bold(category), align: 'right', valign: 'middle' }
      ],
      [
        { text: '୨୧ Target', align: 'left', valign: 'middle' },
        { text: rt.bold(typeof goal === 'string' ? goal : `${goal} picks`), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();

    // Dynamic elapsed timer + ETA for responsive, lively feedback
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const numericGoal = typeof goal === 'number' ? goal : 20;
    const isVideo = category.includes('video') || category.includes('clip');
    const totalWaitSec = Math.max(isVideo ? 18 : 10, Math.round(numericGoal * (isVideo ? 3.5 : 0.3)));
    const countdownSec = Math.max(0, totalWaitSec - elapsedSec);
    const waitDurationText = totalWaitSec >= 60 ? `Wait ~${Math.ceil(totalWaitSec / 60)}min` : `Wait ${totalWaitSec}s`;
    const countdownText = countdownSec > 0 ? `${countdownSec}s remaining` : 'finishing up...';
    const timeHeader = `⏳ ${waitDurationText} • ⏱ Countdown: ${countdownText} (elapsed ${String(elapsedSec).padStart(2, '0')}s)`;

    let stepLabel = 'Connecting to sources...';
    if (stage === 'searching') {
      stepLabel = `Searching Wallhaven 4K, Yande.re, Nekobot & Spankbang...`;
    } else if (stage === 'validating') {
      stepLabel = `Validating HD streams (${p.valid ?? 0}/${numericGoal} picks)`;
    } else if (stage === 'done') {
      stepLabel = `Ready! Found ${p.results ?? 0} aesthetic picks`;
    }

    const miniLog = `${timeHeader}\n˙ᵕ˙ ${stepLabel} ♡`;
    b.paragraph(miniLog);
    b.footer(rt.italic('୨୧ live updates in-place • no waiting in the dark ˙ᵕ˙'));
    b.validate();
    return b.toJSON();
  }

  // ── Step 4: Run Search with Chosen Goal / Count ───────────────────────────
  async function runSearch(ctx, query = '', category = 'all', targetGoal = 10, opts = {}) {
    const rawGoal = targetGoal ?? opts.goal ?? 10;
    const isContinuous = rawGoal === 'continuous';
    const goal = isContinuous ? 10 : (Number(rawGoal) > 0 ? Number(rawGoal) : 20);

    const tgId = String(ctx.tgId);
    const userId = Number(ctx.tgId);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(chatId) < 0);
    const replyToId = opts.replyToMessageId || ctx.message?.message_id || null;

    // Delete user input message to keep chat totally clean & un-spammy in DM
    if (!isGroup && ctx.message?.message_id && app.settings?.get?.('telegram.messageCleanup')) {
      await api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }

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

    let releaseSlot = null;
    if (ctx.controller?.acquireUserTaskSlot) {
      releaseSlot = await ctx.controller.acquireUserTaskSlot(tgId, chatId, replyToId, isGroup);
      if (!releaseSlot) return;
    }

    const controller = new AbortController();
    activeSearches.set(tgId, controller);

    // Reuse existing screen message so it updates in-place with ticking heartbeat timer
    const targetMsgId = ctx.screenMessageId || ctx.query?.message?.message_id || ctx.sm?.context?.(tgId)?.screenMessageId || null;
    const tracker = new ProgressTracker({ api, chatId, messageId: targetMsgId, heartbeatMs: 2000 });

    await tracker.live((state, { elapsedMs }) => progressRich({
      ...state,
      elapsedMs,
      category,
      query,
      goal: isContinuous ? 'Continuous ♾️' : `${goal} picks`
    }), {
      stage: 'searching', category, query, goal: isContinuous ? 'Continuous ♾️' : `${goal} picks`
    });

    try {
      const searchRes = await searchNsfw({
        query,
        category,
        page: 0,
        limit: Math.min(goal, 50),
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
          richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category, 'from_media'), { style: 'primary' }),
          richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' })
        ]);
        b.buttons([
          richButton.callback('🔍 Try Another Search', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' }),
          richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
        ]);
        b.validate();
        await tracker.finish(b.toJSON());
        return { message_id: tracker.messageId };
      }

      // Record in DB for sticker pack creation & pagination
      let searchDbId = Date.now();
      try {
        if (app.pinterest?.db) {
          const ins = app.pinterest.db.run(
            'INSERT INTO pinterest_searches (user_id, query, normalized_query, mode, depth, result_count) VALUES (?, ?, ?, ?, ?, ?)',
            userId, query || 'nsfw spicy', (query || 'nsfw').toLowerCase(), 'nsfw', isContinuous ? 'continuous' : 'deep', items.length
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

      // Fetch first 10 items in HD for the slideshow
      const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(items, 10);
      const rich = renderResultsRich({
        searchId: searchDbId,
        query,
        category: searchRes.category || category,
        isContinuous,
        requestedGoal: goal,
        totalImages: items.length,
        previewAttachments: previewBlocks,
        startOffset: 0,
        currentOffset: Math.min(10, items.length)
      });

      const files = previewBlocks.length > 0 ? mediaFiles : null;
      await tracker.finish(rich, files);

      if (tracker.messageId) {
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram?.userScreenMessage?.set?.(tgId, { chatId, messageId: tracker.messageId });
        ctx.sm?.update?.(tgId, { screenMessageId: tracker.messageId });
        return { message_id: tracker.messageId };
      }
    } catch (err) {
      log.error({ err: err?.message, query }, 'nsfw search failed');
      const b = new RichMessageBuilder();
      b.heading('🔞 SEARCH FAILED', 2);
      b.paragraph(rt.bold(`something went wrong: ${err?.message || 'timeout'}`));
      b.divider();
      b.buttons([
        richButton.callback('↺ Try Again', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' }),
        richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
      return { message_id: tracker.messageId };
    } finally {
      activeSearches.delete(tgId);
      releaseSlot?.();
    }
  }

  // ── Step 5: In-Place Pagination Album Swapping ────────────────────────────
  async function showMoreAlbum(ctx, searchId, offset = 0, category = 'all') {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);
    const numOffset = Math.max(0, Number(offset) || 0);
    const searchDbId = Number(searchId);

    let nextMedia = app.pinterest?.db?.all?.(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC, id ASC LIMIT 10 OFFSET ?`,
      searchDbId, numOffset
    ) || [];

    let totalMediaRow = app.pinterest?.db?.get?.(
      `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
      searchDbId
    );
    let totalMedia = totalMediaRow?.count ?? 0;

    const searchRow = app.pinterest?.db?.get?.(
      'SELECT * FROM pinterest_searches WHERE id = ?',
      searchDbId
    );

    const isContinuous = searchRow?.depth === 'continuous';
    if (!nextMedia.length && isContinuous && searchRow?.query) {
      try {
        const expansion = await searchNsfw({
          query: searchRow.query,
          category,
          page: Math.floor(numOffset / 10),
          limit: 10
        });
        if (expansion?.results?.length) {
          for (const it of expansion.results) {
            app.pinterest.db.run(
              `INSERT INTO pinterest_media (search_id, user_id, media_url, type, width, height, quality_score, status, is_duplicate)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', 0)`,
              searchDbId, searchRow.user_id, it.mediaUrl, it.type, it.width || 1280, it.height || 720, 95
            );
          }
          nextMedia = app.pinterest.db.all(
            `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
             ORDER BY quality_score DESC, id ASC LIMIT 10 OFFSET ?`,
            searchDbId, numOffset
          );
          totalMediaRow = app.pinterest.db.get(
            `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
            searchDbId
          );
          totalMedia = totalMediaRow?.count ?? 0;
        }
      } catch {}
    }

    if (!nextMedia.length) {
      const b = new RichMessageBuilder();
      b.heading('🖼 ALL PICKS VIEWED', 2);
      b.paragraph(rt.italic('all spicy picks in this search have already been browsed ♡'));
      b.divider();
      const endButtons = [];
      if (numOffset > 0) {
        const prevOffset = Math.max(0, numOffset - 10);
        endButtons.push(richButton.callback('← Prev Picks', encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' }));
      }
      endButtons.push(richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' }));
      b.buttons(endButtons);
      b.buttons([
        richButton.callback('🔍 New Search', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { home: true, fromMedia: true }));
      b.validate();
      await editOrSend(ctx, b.toJSON());
      return;
    }

    // Download next 10 HD slides
    const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(nextMedia, 10);
    const nextOffset = numOffset + nextMedia.length;
    const rich = renderResultsRich({
      searchId: searchDbId,
      query: searchRow?.query || '',
      category,
      isContinuous,
      requestedGoal: searchRow?.result_count,
      totalImages: totalMedia,
      previewAttachments: previewBlocks,
      startOffset: numOffset,
      currentOffset: nextOffset
    });
    const files = previewBlocks.length > 0 ? mediaFiles : null;

    // Pinterest clean replacement pattern:
    const targetMsgId = ctx.query?.message?.message_id || ctx.messageId || ctx.screenMessageId || ctx.sm?.context?.(ctx.tgId)?.screenMessageId;
    if (targetMsgId) {
      try {
        await api.editMessageRich(chatId, targetMsgId, rich, {}, files);
        return { message_id: targetMsgId };
      } catch (err) {
        const errMsg = String(err?.description ?? err?.message);
        if (/not modified/i.test(errMsg)) return { message_id: targetMsgId };
        // Edit in-place failed (e.g. Telegram Bot API rejects editing media attachments in-place)
        // Clean replacement: send the new card and delete the old card so only ONE message exists!
        const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
        if (cardMsg?.message_id) {
          if (targetMsgId && cardMsg.message_id !== targetMsgId) {
            await api.deleteMessage(chatId, targetMsgId).catch(() => {});
          }
          app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
          app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
          ctx.sm?.update?.(ctx.tgId, { screenMessageId: cardMsg.message_id });
        }
        return cardMsg;
      }
    } else {
      const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
      if (cardMsg?.message_id) {
        app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
        app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
        ctx.sm?.update?.(ctx.tgId, { screenMessageId: cardMsg.message_id });
      }
      return cardMsg;
    }
  }

  function registerStateHandlers(sm) {
    sm.register(States.NSFW_SEARCH_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;

        const isGroup = Boolean(sctx.isGroup || message.chat?.type === 'group' || message.chat?.type === 'supergroup' || (sctx.chatId && Number(sctx.chatId) < 0));

        if (sctx.context?.stage === 'count') {
          const effectiveQuery = sctx.context?.query || sctx.query;
          const effectiveCategory = sctx.context?.category || 'all';
          if (/\b(continuous|infinite|explore|unlimited)\b/i.test(text)) {
            if (!isGroup && message.message_id) {
              await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
            }
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await runSearch(sctx, effectiveQuery, effectiveCategory, 'continuous');
            return true;
          }
          const parsed = parseInt(text, 10);
          if (!isNaN(parsed) && parsed > 0) {
            const capped = Math.min(200, parsed);
            if (!isGroup && message.message_id) {
              await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
            }
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await runSearch(sctx, effectiveQuery, effectiveCategory, capped);
            return true;
          }
        }

        if (isGroup) {
          // In group chat: delete bot's prompt message so outdated message higher up in GC is removed
          const botPromptMsgId = message.reply_to_message?.message_id || sctx.screenMessageId || sctx.context?.screenMessageId;
          if (botPromptMsgId) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, botPromptMsgId).catch(() => {});
          }
          // Do NOT delete the user's message; quote it for the amount selection card
          await askCount(sctx, text, sctx.context?.category || 'all', { replyToMessageId: message.message_id });
        } else {
          // In private chat: delete user's message to maintain clean in-place screen
          if (message.message_id) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
          }
          await askCount(sctx, text, sctx.context?.category || 'all');
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
      return runSearch(ctx, query, category, 10);
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
        case 'customCount': {
          const category = args[0] || 'all';
          const query = args[1] || ctx.sm?.context?.(ctx.tgId)?.query || '';
          return askCustomCount(ctx, category, query);
        }
        case 'askCountDirect': {
          const query = args[0] || '';
          const category = args[1] || 'all';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return askCount(ctx, query, category);
        }
        case 'runCount': {
          const goal = args[0] || '10';
          const category = args[1] || 'all';
          const query = args[2] || ctx.sm?.context?.(ctx.tgId)?.query || '';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runSearch(ctx, query, category, goal);
        }
        case 'moreAlbum': {
          const searchId = args[0];
          const offset = parseInt(args[1], 10) || 0;
          const category = args[2] || 'all';
          const clickerName = ctx.query?.from?.first_name || 'User';
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, {
              text: `👤 ${clickerName} browsing picks ${offset + 1}–${offset + 10} ♡`
            }).catch(() => {});
          }
          return showMoreAlbum(ctx, searchId, offset, category);
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
          return runSearch(ctx, pick, cat, 10);
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
