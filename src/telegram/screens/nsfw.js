import { RichMessageBuilder, rt, richButton, encodeCallback, block } from '../rich.js';
import { navButtons, kvTable, banner } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import {
  searchNsfw,
  searchXvideos,
  searchAdultMovies,
  searchPornhub,
  resolveXvideosStream,
  resolvePornhubStream,
  adultCatalog,
  ADULT_CATEGORIES,
  FEATURED_ARTISTS,
  isBlockedNsfwQuery,
  NSFW_CATEGORIES,
  CATEGORY_SUGGESTIONS
} from '../../wallpaper/nsfwSearch.js';
import { truncate } from '../../utils/text.js';
import { checkChatMediaPermissions, formatMediaRestrictedNotice, isBotSuperAdmin, isAnonymousGroupAdmin } from '../permissions.js';
import { optimizePreviewImage } from '../../media/convert.js';
import { editOrSendRichWithFallback } from '../../music/model.js';
import { logger } from '../../core/logger.js';

const log = logger().child({ module: 'nsfw-screen' });

function isChannelCtx(ctx) {
  const type = ctx?.message?.chat?.type ?? ctx?.query?.message?.chat?.type;
  return Boolean(ctx?.isChannel || type === 'channel');
}

function nsfwStateKey(ctx) {
  return (isChannelCtx(ctx) && Number(ctx?.chatId) < 0) ? String(ctx.chatId) : String(ctx?.tgId);
}

/**
 * Infer required Referer header for adult CDNs so HD MP4 streams never return 403.
 */
function buildMediaHeaders(url = '', itemHeaders = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...(itemHeaders || {})
  };
  if (!headers.Referer) {
    if (/eporner\.com/i.test(url)) headers.Referer = 'https://www.eporner.com/';
    else if (/redgifs\.com/i.test(url)) headers.Referer = 'https://www.redgifs.com/';
    else if (/xvideos/i.test(url)) headers.Referer = 'https://www.xvideos.com/';
    else if (/pornhub\.com|phncdn\.com/i.test(url)) headers.Referer = 'https://www.pornhub.com/';
    else if (/yande\.re/i.test(url)) headers.Referer = 'https://yande.re/';
    else if (/konachan\.com/i.test(url)) headers.Referer = 'https://konachan.com/';
  }
  return headers;
}

/**
 * Fetch HD buffers for preview slideshow (1080p/720p full playable MP4 videos with audio & 4K/HD photos).
 */
async function fetchPreviewBuffers(items, max = 4) {
  const previewBlocks = [];
  const mediaFiles = {};
  let idx = 0;

  const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // 16 MB fast upload cap to prevent event loop / multipart lag
  const topItems = (items || []).slice(0, max);

  const promises = topItems.map(async (it) => {
    const isVideo = it.type === 'video';
    // For videos, try full HD video streams in order (videoUrl -> mediaUrl -> fallbackUrls)
    const candidateUrls = isVideo
      ? [...new Set([it.videoUrl, it.mediaUrl, it.media_url, ...(Array.isArray(it.fallbackUrls) ? it.fallbackUrls : [])].filter(Boolean))]
      : [...new Set([it.mediaUrl, it.media_url, it.thumbUrl].filter(Boolean))];

    if (candidateUrls.length === 0) return null;

    for (const targetUrl of candidateUrls) {
      try {
        const res = await fetch(targetUrl, {
          headers: buildMediaHeaders(targetUrl, it.headers),
          signal: AbortSignal.timeout(isVideo ? 16000 : 8500)
        });
        if (!res.ok) continue;

        const contentLength = Number(res.headers?.get?.('content-length') || 0);
        if (isVideo && contentLength > MAX_VIDEO_BYTES && candidateUrls.length > 1) {
          // Stream exceeds 48 MB; step down to next resolution in fallbackUrls (e.g. 720p / 480p)
          try { await res.body?.cancel?.(); } catch {}
          continue;
        }

        const arrayBuf = await res.arrayBuffer();
        const rawBuf = Buffer.from(arrayBuf);
        if (rawBuf.length < 50) continue;
        if (isVideo && rawBuf.length > MAX_VIDEO_BYTES && candidateUrls.length > 1) {
          continue;
        }

        if (isVideo) {
          const isImage = (rawBuf[0] === 0xff && rawBuf[1] === 0xd8) ||
                          (rawBuf[0] === 0x89 && rawBuf[1] === 0x50) ||
                          (rawBuf[0] === 0x47 && rawBuf[1] === 0x49 && rawBuf[2] === 0x46);

          if (isImage) {
            // If this candidate URL was an image, try the next candidate URL before settling for photo
            if (targetUrl !== candidateUrls[candidateUrls.length - 1]) continue;
            const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1600, quality: 90 });
            return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
          }

          // Genuine playable HD MP4 video with audio!
          return { type: 'video', buffer: rawBuf, mime: 'video/mp4' };
        }

        // Crisp 1600px HD optimization for 4K wallpapers
        const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1600, quality: 90 });
        return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
      } catch {
        // Try next candidate URL
      }
    }

    // Final fallback: If all video stream URLs failed, try its preview thumbnail as photo
    if (isVideo && it.thumbUrl && !candidateUrls.includes(it.thumbUrl)) {
      try {
        const tRes = await fetch(it.thumbUrl, {
          headers: buildMediaHeaders(it.thumbUrl, it.headers),
          signal: AbortSignal.timeout(5000)
        });
        if (tRes.ok) {
          const tBuf = Buffer.from(await tRes.arrayBuffer());
          const optBuf = await optimizePreviewImage(tBuf, { maxDimension: 1600, quality: 90 });
          return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
        }
      } catch {}
    }
    return null;
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
  const activeSearches = new Map(); // tgId -> { controller, tracker }
  const adultCinemaSessions = new Map(); // sid -> { sid, mode, category, query, page, apiPage, sort, items, selectedIds, msgId, createdAt }

  function cancelActiveSearch(tgId, chatId = null) {
    if (tgId !== undefined && tgId !== null) {
      const key = String(tgId);
      const entry = activeSearches.get(key);
      if (entry) {
        try { entry.controller?.abort?.(); } catch {}
        try { entry.tracker?.stop?.(); } catch {}
        try { entry.abort?.(); } catch {}
        activeSearches.delete(key);
      }
    }
    if (chatId !== undefined && chatId !== null) {
      ProgressTracker.stopForChat?.(chatId);
    }
  }

  function rememberAdultSession(session) {
    adultCinemaSessions.set(session.sid, session);
    if (adultCinemaSessions.size > 200) {
      const oldestKey = adultCinemaSessions.keys().next().value;
      adultCinemaSessions.delete(oldestKey);
    }
    return session;
  }

  function getAdultSession(sid) {
    return sid ? adultCinemaSessions.get(String(sid)) || null : null;
  }

  async function ensureAdultStreamResolved(item, { probeSize = false } = {}) {
    if (!item) return null;
    const catalog = app.adultCatalog || adultCatalog;
    if (catalog?.resolveStream) {
      await catalog.resolveStream(item, { probeSize }).catch(() => null);
    }
    if (!item.videoUrl && !item.hlsUrl && item.pageUrl && /xvideos\./i.test(item.pageUrl)) {
      const resolved = await resolveXvideosStream(item.pageUrl).catch(() => null);
      if (resolved?.streamUrl) {
        item.videoUrl = resolved.streamUrl;
        item.hlsUrl = resolved.hlsUrl || item.hlsUrl || null;
        item.fallbackUrls = [...new Set([...(resolved.fallbackUrls || []), ...(item.fallbackUrls || [])])];
        item.headers = resolved.headers || item.headers;
        item.streamHeaders = resolved.headers || item.streamHeaders;
      }
      item._fullResolved = true;
    } else if (item.videoUrl || item.mediaUrl) {
      item._fullResolved = true;
    }
    return item;
  }

  function buildAdultTrack(item, mode = 'adult_movies', quality = '720p') {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    const targetH = parseInt(String(quality || '720').replace(/[^\d]/g, ''), 10) || 720;
    let selectedVariantUrl = null;
    if (variants.length) {
      const sorted = [...variants]
        .filter(v => v?.url)
        .sort((a, b) => {
          const ha = parseInt(String(a.quality || '480').replace(/[^\d]/g, ''), 10) || 480;
          const hb = parseInt(String(b.quality || '480').replace(/[^\d]/g, ''), 10) || 480;
          return Math.abs(ha - targetH) - Math.abs(hb - targetH);
        });
      selectedVariantUrl = sorted[0]?.url || null;
    }
    const streamUrl = selectedVariantUrl || item.videoUrl || item.hlsUrl || item.fallbackUrls?.[0] || item.mediaUrl;
    const durSec = Number(item.durationSeconds || item.durationSec) || 0;
    const rawId = String(item.id || `adult_${Date.now()}`).replace(/^(xv|ad):/i, '');
    const namespacedId = (item.sourceKey === 'xvideos' || mode === 'xvideos') ? `xv:${rawId}` : `ad:${rawId}`;
    return {
      id: namespacedId,
      type: item.sourceKey || mode,
      title: item.fullTitle || item.title || (mode === 'pornhub' ? 'Pornhub Stream' : mode === 'xvideos' ? '18+ Stream' : '18+ Feature Film'),
      artist: item.artist || (mode === 'pornhub' ? 'Pornhub' : mode === 'xvideos' ? '18+ Stream' : '18+ Cinema'),
      durationSec: durSec,
      durationSeconds: durSec,
      durationLabel: item.duration || '',
      provider: 'movie',
      mediaType: 'video',
      isAdult: true,
      sourceKey: item.sourceKey || mode,
      epornerId: item.epornerId || null,
      streamUrl,
      videoUrl: streamUrl,
      variants,
      streamHeaders: item.streamHeaders || item.headers || {},
      streamResolvedAt: Date.now(),
      fallbackUrls: item.fallbackUrls || [],
      artwork: item.thumbUrl || item.poster || null,
      thumbnailUrl: item.thumbUrl || null,
      pageUrl: item.pageUrl || null,
      categories: item.categories || [],
      views: item.views || '',
      rating: item.rating || '',
      resolution: quality || item.quality || 'HD',
      capabilities: { seek: true, video: true }
    };
  }

  async function fetchThumbnailSlides(items = []) {
    const previewBlocks = [];
    const mediaFiles = {};
    const fetched = await Promise.all(
      items.slice(0, 5).map(async (it, i) => {
        const url = it.thumbUrl;
        if (!url || !url.startsWith('http')) return null;
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
              ...(it.headers || {})
            },
            signal: AbortSignal.timeout(3000)
          });
          if (!res.ok) return null;
          let buf = Buffer.from(await res.arrayBuffer());
          if (!buf.length || buf.length < 400) return null;
          try {
            buf = await optimizePreviewImage(buf, { maxDimension: 960, quality: 75 });
          } catch {}
          return { i, buf };
        } catch {
          return null;
        }
      })
    );
    for (const r of fetched) {
      if (!r) continue;
      const key = `ac_th_${r.i}.jpg`;
      mediaFiles[key] = { buffer: r.buf, filename: key, contentType: 'image/jpeg' };
      previewBlocks.push(block.photo(`attach://${key}`));
    }
    return { previewBlocks, mediaFiles };
  }

  function isGroupChat(ctx) {
    return Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(ctx.chatId) < 0);
  }

  function isGroupNsfwAllowed(ctx) {
    if (!isGroupChat(ctx)) return true;
    return app.db?.getSetting?.(`nsfw.groupEnabled.${ctx.chatId}`, true) !== false;
  }

  function isAgeGateRequired(ctx) {
    return app.settings?.get?.('nsfw.requireAgeGate') === true && !app.db?.getSetting?.(`nsfw.ageVerified.${ctx.tgId}`, false);
  }

  function renderAgeGate() {
    const b = new RichMessageBuilder();
    b.header('🔞 AGE VERIFICATION REQUIRED', 1);
    b.paragraph('This studio contains explicit 18+ adult and anime content. Confirm that you are at least 18 years old to proceed.');
    b.divider();
    b.buttons([
      richButton.callback('🔞 I am 18+ — Enter Studio', encodeCallback(id, 'confirmAge'), { style: 'success' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderGroupLocked() {
    const b = new RichMessageBuilder();
    b.header('🔒 18+ STUDIO LOCKED IN THIS GROUP', 1);
    b.paragraph('A group administrator has disabled 18+ content in this group chat. You can still use /nsfw in private DM with the bot, or a group admin can re-enable it with /nsfw on.');
    b.divider();
    b.buttons([
      richButton.callback('🔓 Unlock 18+ (Admin Only)', encodeCallback(id, 'toggleGroup'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  async function toggleGroupNsfw(ctx, explicitState = null) {
    const api = ctx.api || app.telegram?.api;
    if (!isGroupChat(ctx)) {
      await api?.sendMessage?.(ctx.chatId, 'ℹ️ Group 18+ lock applies to group chats only.').catch(() => {});
      return false;
    }
    let isAdmin = Boolean(
      (isChannelCtx(ctx) && ctx.channelAdminVerified) ||
      isAnonymousGroupAdmin(ctx.message, ctx.chatId) ||
      isBotSuperAdmin(app, ctx.tgId, { controller: ctx.controller })
    );
    if (!isAdmin && Number(ctx.tgId) > 0) {
      const member = await api?.getChatMember?.(ctx.chatId, Number(ctx.tgId)).catch(() => null);
      isAdmin = ['creator', 'administrator'].includes(member?.status);
    }
    if (!isAdmin) {
      if (ctx.query?.id) await api?.answerCallbackQuery?.(ctx.query.id, { text: 'Only group administrators can change 18+ group settings.', show_alert: true }).catch(() => {});
      else await api?.sendMessage?.(ctx.chatId, '🔒 Only verified group administrators can toggle 18+ access in this group.').catch(() => {});
      return false;
    }
    const current = isGroupNsfwAllowed(ctx);
    const next = explicitState !== null ? Boolean(explicitState) : !current;
    app.db?.setSetting?.(`nsfw.groupEnabled.${ctx.chatId}`, next);
    if (ctx.query?.id) {
      await api?.answerCallbackQuery?.(ctx.query.id, { text: next ? '🔓 18+ Studio enabled in this group.' : '🔒 18+ Studio locked in this group.' }).catch(() => {});
      await editOrSend(ctx, next ? renderMenu(ctx) : renderGroupLocked());
    } else {
      await api?.sendMessage?.(ctx.chatId, next ? '🔓 18+ Studio is now enabled in this group (with auto-spoiler protection).' : '🔒 18+ Studio is now locked in this group.').catch(() => {});
    }
    return next;
  }

  // ── Main Menu ─────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const isGroup = isGroupChat(ctx);
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
      richButton.callback('🎬 18+ Adult Movies (Full Features)', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔥 XVideos Streaming & Download', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' }),
      richButton.callback('🟠 Pornhub Hub', encodeCallback(id, 'sub', 'pornhub'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📂 18+ Categories', encodeCallback(id, 'acCatMenu', 'all', '0'), { style: 'primary' }),
      richButton.callback('🌟 Pornstars & Artists', encodeCallback(id, 'acArtMenu', 'all', '0'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', 'all'), { style: 'primary' }),
      richButton.callback('🔍 Universal 18+ Search', encodeCallback(id, 'searchPrompt', 'all'), { style: 'primary' })
    ]);
    if (isGroup) {
      b.buttons([
        richButton.callback(isGroupNsfwAllowed(ctx) ? '🔒 Lock 18+ in Group (Admin)' : '🔓 Unlock 18+ in Group (Admin)', encodeCallback(id, 'toggleGroup'), { style: 'primary' })
      ]);
    }
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
      richButton.callback('🍿 18+ Adult Movies Studio', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' }),
      richButton.callback('🔥 XVideos Hub', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🟠 Pornhub Hub', encodeCallback(id, 'sub', 'pornhub'), { style: 'primary' }),
      richButton.callback('📂 Categories', encodeCallback(id, 'acCatMenu', 'all', '0'), { style: 'primary' }),
      richButton.callback('🌟 Artists', encodeCallback(id, 'acArtMenu', 'all', '0'), { style: 'primary' })
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
      try {
        const res = await api.editMessageRich(chatId, targetMsgId, rich, {}, files);
        if (res) return res;
      } catch (err) {
        const desc = String(err?.description ?? err?.message ?? '');
        if (/not modified|too many requests|flood/i.test(desc) || err?.errorCode === 429 || err?.code === 'FLOOD_WAIT') {
          return { message_id: targetMsgId };
        }
      }
    }
    const sent = await api.sendRichMessage(chatId, rich, {}, files);
    if (targetMsgId && sent?.message_id && sent.message_id !== targetMsgId) {
      await api.deleteMessage(chatId, targetMsgId).catch(() => {});
    }
    return sent;
  }

  async function openMenu(ctx) {
    cancelActiveSearch(ctx?.tgId, ctx?.chatId);
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
    await editOrSend(ctx, renderMenu(ctx));
  }

  // ── Step 1: Ask Query ─────────────────────────────────────────────────────
  async function askQuery(ctx, category = 'all') {
    cancelActiveSearch(ctx?.tgId, ctx?.chatId);
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id ?? ctx.screenMessageId;
    const tgId = nsfwStateKey(ctx);
    const sm = ctx.sm ?? ctx.machine;
    if (ctx.transition && !isChannelCtx(ctx)) {
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
      [NSFW_CATEGORIES.ADULT_MOVIES]: '18+ Adult Feature Movies',
      [NSFW_CATEGORIES.XVIDEOS_VIDEO]: 'XVideos Streaming & Download',
      [NSFW_CATEGORIES.PORNHUB_VIDEO]: 'Pornhub Streaming & Download',
      all: '18+ Adult & Hentai Studio'
    };

    const categoryExamples = {
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['asian model', 'brunette', 'blonde', 'latina', 'glamour', 'boudoir', 'baddie'],
      [NSFW_CATEGORIES.REAL_CLIPS]: ['asian', 'latina', 'brunette', 'teaser', 'glamour'],
      [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['asian', 'latina', 'blonde', 'baddie', 'brunette'],
      [NSFW_CATEGORIES.ADULT_MOVIES]: ['romantic', 'passionate', 'couples', 'full movie', 'pirates stagnetti', 'erotic thriller', 'femalien', 'machine gunner', 'jesse jane'],
      [NSFW_CATEGORIES.XVIDEOS_VIDEO]: ['trending', 'asian', 'latina', 'brunette', 'blonde', 'amateur'],
      [NSFW_CATEGORIES.PORNHUB_VIDEO]: ['trending', 'asian', 'latina', 'milf', 'lesbian', 'pov', '4k'],
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
    if (isAdultCinemaCategory(category)) {
      return runAdultCinemaSearch(ctx, category, query);
    }
    const isVideo = category.includes('video') || category.includes('clip');
    const tgId = nsfwStateKey(ctx);
    const sm = ctx.sm ?? ctx.machine;
    const replyToMessageId = opts.replyToMessageId ?? null;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;

    if (ctx.transition && !isChannelCtx(ctx)) {
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
      if (ctx.transition && !isChannelCtx(ctx)) {
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
      if (ctx.update && !isChannelCtx(ctx)) {
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
    const tgId = nsfwStateKey(ctx);
    const sm = ctx.sm ?? ctx.machine;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    if (ctx.transition && !isChannelCtx(ctx)) {
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
      stepLabel = 'Searching Eporner 1080p HD, RedGifs 4K, Konachan & Wallhaven...';
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
    if (isAdultCinemaCategory(category)) {
      return runAdultCinemaSearch(ctx, category, query);
    }
    const rawGoal = targetGoal ?? opts.goal ?? 10;
    const isContinuous = rawGoal === 'continuous';
    const goal = isContinuous ? 10 : (Number(rawGoal) > 0 ? Number(rawGoal) : 20);

    const tgId = String(ctx.tgId);
    const userId = Number(ctx.tgId);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(chatId) < 0);
    const replyToId = opts.replyToMessageId || ctx.message?.message_id || null;

    if (isGroup && !isGroupNsfwAllowed(ctx)) {
      return editOrSend(ctx, renderGroupLocked());
    }
    if (isAgeGateRequired(ctx)) {
      return editOrSend(ctx, renderAgeGate());
    }
    if (isBlockedNsfwQuery(query)) {
      const b = new RichMessageBuilder();
      b.header('⚠️ QUERY BLOCKED BY SAFETY FILTER', 1);
      b.paragraph('Your search query contains prohibited terms. Queries involving minors or non-consensual content are strictly blocked.');
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

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

    cancelActiveSearch(tgId, chatId);
    const controller = new AbortController();

    // Reuse existing screen message so it updates in-place with ticking heartbeat timer
    const targetMsgId = ctx.screenMessageId || ctx.query?.message?.message_id || ctx.sm?.context?.(tgId)?.screenMessageId || null;
    const tracker = new ProgressTracker({ api, chatId, messageId: targetMsgId, heartbeatMs: 3500 });
    activeSearches.set(tgId, { controller, tracker });

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
      if (controller.signal.aborted) {
        tracker.stop?.();
        return;
      }

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
                searchDbId, userId, it.videoUrl || it.mediaUrl, it.type, it.width || 1920, it.height || 1080, 95
              );
            }
          }
        }
      } catch (dbErr) {
        log.debug({ err: dbErr?.message }, 'failed to record nsfw search in db');
      }

      // Fetch first 10 items in HD for the slideshow
      const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(items, 10);
      if (controller.signal.aborted) {
        tracker.stop?.();
        return;
      }
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
      if (controller.signal.aborted) {
        tracker.stop?.();
        return;
      }
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
      tracker.stop?.();
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
              searchDbId, searchRow.user_id, it.videoUrl || it.mediaUrl, it.type, it.width || 1920, it.height || 1080, 95
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

  function isAdultCinemaCategory(cat = '') {
    return (
      cat === NSFW_CATEGORIES.XVIDEOS_VIDEO ||
      cat === NSFW_CATEGORIES.PORNHUB_VIDEO ||
      cat === NSFW_CATEGORIES.ADULT_MOVIES ||
      cat === 'adult_all'
    );
  }

  function renderAdultMoviesMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('🎬 18+ ADULT MOVIES STUDIO', 1);
    b.paragraph(rt.italic('full-length 18+ HD feature films — stream in VC, add to queue, or download directly (separate from SFW movies)'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search 18+ Adult Movies', encodeCallback(id, 'cat', NSFW_CATEGORIES.ADULT_MOVIES), { style: 'primary' }),
      richButton.callback('🎲 Random Adult Feature', encodeCallback(id, 'random', NSFW_CATEGORIES.ADULT_MOVIES), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📂 Browse Categories', encodeCallback(id, 'acCatMenu', 'adult_movies', '0'), { style: 'primary' }),
      richButton.callback('🌟 Pornstars & Artists', encodeCallback(id, 'acArtMenu', 'adult_movies', '0'), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('🍿 Popular 18+ Feature Tags & Parodies:'));
    b.buttons([
      richButton.callback('🏴‍☠️ Pirates / Parody', encodeCallback(id, 'amRun', 'pirates stagnetti'), { style: 'primary' }),
      richButton.callback('🔥 Erotic Indie', encodeCallback(id, 'amRun', 'erotic thriller'), { style: 'primary' }),
      richButton.callback('👽 Femalien / Sci-Fi', encodeCallback(id, 'amRun', 'femalien'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎬 Full Storyline', encodeCallback(id, 'amRun', 'full movie'), { style: 'primary' }),
      richButton.callback('❤️ Romantic 18+', encodeCallback(id, 'amRun', 'romantic'), { style: 'primary' }),
      richButton.callback('💑 Couples HD', encodeCallback(id, 'amRun', 'couples'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('🔥 XVideos', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' }),
      richButton.callback('🟠 Pornhub', encodeCallback(id, 'sub', 'pornhub'), { style: 'primary' }),
      richButton.callback('🌐 All 18+ Sources', encodeCallback(id, 'acAllRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderXvideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('🔥 XVIDEOS STREAM & DOWNLOAD', 1);
    b.paragraph(rt.italic('dedicated XVideos hub — browse trending, categories, artists, sort by views/rating, stream in VC, or download HD MP4'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search XVideos', encodeCallback(id, 'cat', NSFW_CATEGORIES.XVIDEOS_VIDEO), { style: 'primary' }),
      richButton.callback('🔥 Trending Now', encodeCallback(id, 'xvRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('📂 Categories (32+)', encodeCallback(id, 'acCatMenu', 'xvideos', '0'), { style: 'primary' }),
      richButton.callback('🌟 Artists / Stars', encodeCallback(id, 'acArtMenu', 'xvideos', '0'), { style: 'primary' }),
      richButton.callback('🎲 Random', encodeCallback(id, 'random', NSFW_CATEGORIES.XVIDEOS_VIDEO), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('✨ Quick XVideos Categories:'));
    b.buttons([
      richButton.callback('🔥 Asian', encodeCallback(id, 'xvRun', 'asian'), { style: 'primary' }),
      richButton.callback('🔥 Latina', encodeCallback(id, 'xvRun', 'latina'), { style: 'primary' }),
      richButton.callback('🔥 Brunette', encodeCallback(id, 'xvRun', 'brunette'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔥 Blonde', encodeCallback(id, 'xvRun', 'blonde'), { style: 'primary' }),
      richButton.callback('🔥 Amateur', encodeCallback(id, 'xvRun', 'amateur'), { style: 'primary' }),
      richButton.callback('🔥 Cosplay', encodeCallback(id, 'xvRun', 'cosplay'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('🟠 Pornhub', encodeCallback(id, 'sub', 'pornhub'), { style: 'primary' }),
      richButton.callback('🎬 18+ Movies', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' }),
      richButton.callback('🌐 All Sources', encodeCallback(id, 'acAllRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('🎬 Open in Movie Dash', encodeCallback('music', 'mv', 'new', 'xv'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderPornhubMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('🟠 PORNHUB STREAM & DOWNLOAD', 1);
    b.paragraph(rt.italic('official Pornhub HD catalog — browse categories, top pornstars, stream in VC, or download 360p/480p/720p MP4'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search Pornhub', encodeCallback(id, 'cat', NSFW_CATEGORIES.PORNHUB_VIDEO), { style: 'primary' }),
      richButton.callback('🔥 Trending Now', encodeCallback(id, 'phRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('📂 Categories (32+)', encodeCallback(id, 'acCatMenu', 'pornhub', '0'), { style: 'primary' }),
      richButton.callback('🌟 Pornstars', encodeCallback(id, 'acArtMenu', 'pornhub', '0'), { style: 'primary' }),
      richButton.callback('🎲 Random', encodeCallback(id, 'random', NSFW_CATEGORIES.PORNHUB_VIDEO), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('🟠 Popular Pornhub Categories:'));
    b.buttons([
      richButton.callback('🟠 Asian', encodeCallback(id, 'phRun', 'asian'), { style: 'primary' }),
      richButton.callback('🟠 Latina', encodeCallback(id, 'phRun', 'latina'), { style: 'primary' }),
      richButton.callback('🟠 MILF', encodeCallback(id, 'phRun', 'milf'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🟠 POV', encodeCallback(id, 'phRun', 'pov'), { style: 'primary' }),
      richButton.callback('🟠 Lesbian', encodeCallback(id, 'phRun', 'lesbian'), { style: 'primary' }),
      richButton.callback('🟠 4K Ultra HD', encodeCallback(id, 'phRun', '4k'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('🔥 XVideos', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' }),
      richButton.callback('🎬 18+ Movies', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' }),
      richButton.callback('🌐 All Sources', encodeCallback(id, 'acAllRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  async function renderAdultCategoriesMenu(ctx, source = 'all', page = 0) {
    const catalog = app.adultCatalog || adultCatalog;
    const PER_PAGE = 12;
    const reqPage = Number(page) || 0;
    const catRes = await Promise.resolve(catalog?.getCategories?.({ page: reqPage, perPage: PER_PAGE })).catch(() => null);
    let safePage = 0;
    let totalPages = 1;
    let totalCats = 0;
    let slice = [];
    if (catRes && !Array.isArray(catRes) && Array.isArray(catRes.items)) {
      slice = catRes.items;
      totalCats = Number(catRes.total) || slice.length;
      totalPages = Math.max(1, Number(catRes.totalPages) || Math.ceil(totalCats / PER_PAGE));
      safePage = Math.max(0, Math.min(Number(catRes.page ?? reqPage) || 0, totalPages - 1));
    } else {
      const allCats = Array.isArray(catRes) ? catRes : ADULT_CATEGORIES;
      totalCats = allCats.length;
      totalPages = Math.max(1, Math.ceil(totalCats / PER_PAGE));
      safePage = Math.max(0, Math.min(reqPage, totalPages - 1));
      slice = allCats.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE);
    }

    const srcLabel = source === 'pornhub' ? '🟠 Pornhub'
      : source === 'xvideos' ? '🔥 XVideos'
      : source === 'adult_movies' ? '🎬 18+ Movies'
      : '🌐 All Sources';

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `📂 18+ CINEMA CATEGORIES · ${srcLabel}`,
      `Page ${safePage + 1}/${totalPages} · ${totalCats} Categories`
    ], { size: 2 });
    b.paragraph(rt.italic('tap any category to browse HD streams & downloads, or switch source below ♡'));

    // Source selector row
    b.buttons([
      richButton.callback(source === 'all' ? '• 🌐 All' : '🌐 All', encodeCallback(id, 'acCatMenu', 'all', String(safePage))),
      richButton.callback(source === 'xvideos' ? '• 🔥 XVideos' : '🔥 XVideos', encodeCallback(id, 'acCatMenu', 'xvideos', String(safePage))),
      richButton.callback(source === 'pornhub' ? '• 🟠 Pornhub' : '🟠 Pornhub', encodeCallback(id, 'acCatMenu', 'pornhub', String(safePage))),
      richButton.callback(source === 'adult_movies' ? '• 🎬 Movies' : '🎬 Movies', encodeCallback(id, 'acCatMenu', 'adult_movies', String(safePage)))
    ]);

    for (let i = 0; i < slice.length; i += 3) {
      const row = slice.slice(i, i + 3).map(cat =>
        richButton.callback(cat.label, encodeCallback(id, 'acCatPick', source, cat.slug), { style: 'primary' })
      );
      b.buttons(row);
    }

    const nav = [];
    if (safePage > 0) {
      nav.push(richButton.callback('◀ Prev', encodeCallback(id, 'acCatMenu', source, String(safePage - 1)), { style: 'primary' }));
    }
    nav.push(richButton.callback(`${safePage + 1}/${totalPages}`, encodeCallback(id, 'noop')));
    if (safePage < totalPages - 1) {
      nav.push(richButton.callback('Next ▶', encodeCallback(id, 'acCatMenu', source, String(safePage + 1)), { style: 'primary' }));
    }
    b.buttons(nav);

    b.buttons([
      richButton.callback('🌟 Artists / Stars', encodeCallback(id, 'acArtMenu', source, '0'), { style: 'primary' }),
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function renderAdultArtistsMenu(ctx, source = 'all', page = 0, filterQuery = '') {
    const catalog = app.adultCatalog || adultCatalog;
    const res = (await Promise.resolve(catalog?.getArtists?.({ query: filterQuery, page: Number(page) || 0, pageSize: 12 })).catch(() => null)) || {
      items: FEATURED_ARTISTS.slice(0, 12),
      total: FEATURED_ARTISTS.length,
      page: 0,
      totalPages: Math.ceil(FEATURED_ARTISTS.length / 12)
    };
    const safePage = res.page || 0;
    const totalPages = res.totalPages || 1;
    const srcLabel = source === 'pornhub' ? '🟠 Pornhub'
      : source === 'xvideos' ? '🔥 XVideos'
      : source === 'adult_movies' ? '🎬 18+ Movies'
      : '🌐 All Sources';

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `🌟 18+ ARTISTS & PORNSTARS · ${srcLabel}`,
      `Page ${safePage + 1}/${totalPages} · ${res.total} Featured & Verified Stars`
    ], { size: 2 });
    b.paragraph(rt.italic('select a pornstar/artist to browse their top HD scenes or search any name ♡'));

    b.buttons([
      richButton.callback(source === 'all' ? '• 🌐 All' : '🌐 All', encodeCallback(id, 'acArtMenu', 'all', String(safePage))),
      richButton.callback(source === 'xvideos' ? '• 🔥 XVideos' : '🔥 XVideos', encodeCallback(id, 'acArtMenu', 'xvideos', String(safePage))),
      richButton.callback(source === 'pornhub' ? '• 🟠 Pornhub' : '🟠 Pornhub', encodeCallback(id, 'acArtMenu', 'pornhub', String(safePage))),
      richButton.callback(source === 'adult_movies' ? '• 🎬 Movies' : '🎬 Movies', encodeCallback(id, 'acArtMenu', 'adult_movies', String(safePage)))
    ]);

    b.buttons([
      richButton.callback('🔍 Search Any Artist / Pornstar Name', encodeCallback(id, 'acArtSrch', source), { style: 'success' })
    ]);

    const stars = res.items || [];
    for (let i = 0; i < stars.length; i += 2) {
      const row = stars.slice(i, i + 2).map((star, idx) => {
        const name = typeof star === 'string' ? star : star.name;
        const absIdx = safePage * 12 + i + idx;
        return richButton.callback(`🌟 ${truncate(name, 20)}`, encodeCallback(id, 'acArtIdx', source, String(absIdx)), { style: 'primary' });
      });
      b.buttons(row);
    }

    const nav = [];
    if (safePage > 0) {
      nav.push(richButton.callback('◀ Prev', encodeCallback(id, 'acArtMenu', source, String(safePage - 1)), { style: 'primary' }));
    }
    nav.push(richButton.callback(`${safePage + 1}/${totalPages}`, encodeCallback(id, 'noop')));
    if (safePage < totalPages - 1) {
      nav.push(richButton.callback('Next ▶', encodeCallback(id, 'acArtMenu', source, String(safePage + 1)), { style: 'primary' }));
    }
    b.buttons(nav);

    b.buttons([
      richButton.callback('📂 Categories', encodeCallback(id, 'acCatMenu', source, '0'), { style: 'primary' }),
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function askArtistSearch(ctx, source = 'all') {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id ?? ctx.screenMessageId;
    const tgId = nsfwStateKey(ctx);
    const sm = ctx.sm ?? ctx.machine;
    if (ctx.transition && !isChannelCtx(ctx)) {
      await ctx.transition(States.NSFW_ARTIST_INPUT, {
        context: { source, screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_ARTIST_INPUT, {
        context: { source, screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const b = new RichMessageBuilder();
    b.header('🌟 SEARCH PORNSTAR / ARTIST', 1);
    b.paragraph(rt.italic('type any pornstar, model, or creator name in chat (e.g. Eva Elfie, Lana Rhoades, Angela White) ♡'));
    b.buttons([
      richButton.callback('« Back to Artists', encodeCallback(id, 'acArtMenu', source, '0'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function upsertAdultScreen(ctx, rich, files = null, session = null) {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);
    const targetMsgId = ctx.query?.message?.message_id || session?.msgId || ctx.messageId || ctx.screenMessageId || ctx.sm?.context?.(ctx.tgId)?.screenMessageId || null;
    try {
      const out = await editOrSendRichWithFallback(api, chatId, targetMsgId, rich, {}, files, { deleteReplaced: true });
      const finalMsgId = out?.sent?.message_id || targetMsgId;
      if (finalMsgId) {
        if (session) session.msgId = finalMsgId;
        app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: finalMsgId });
        ctx.sm?.update?.(ctx.tgId, { screenMessageId: finalMsgId });
      }
      return out?.sent || (finalMsgId ? { message_id: finalMsgId } : null);
    } catch (err) {
      const desc = String(err?.description ?? err?.message ?? '');
      if (targetMsgId && (/not modified|too many requests|flood/i.test(desc) || err?.errorCode === 429 || err?.code === 'FLOOD_WAIT')) {
        if (session) session.msgId = targetMsgId;
        return { message_id: targetMsgId };
      }
      throw err;
    }
  }

  async function fetchMoreForSession(session, targetUiPage = 0) {
    const PER_PAGE = 5;
    const neededCount = (targetUiPage + 1) * PER_PAGE;
    if (neededCount <= session.items.length) return;

    const targetApiPage = Math.max((session.apiPage || 0) + 1, Math.floor((targetUiPage * PER_PAGE) / 15));
    const catalog = app.adultCatalog || adultCatalog;
    let moreResults = [];
    if (session.mode === 'pornhub') {
      const more = await searchPornhub({
        query: session.query,
        page: targetApiPage,
        limit: 15,
        sort: session.sort || 'relevance',
        durationFilter: session.durationFilter || 'all',
        category: session.categoryLabel || '',
        artist: session.artist || ''
      }).catch(() => ({ results: [] }));
      moreResults = more?.results || [];
    } else if (session.mode === 'all') {
      const more = await catalog.search({
        query: session.query,
        source: 'all',
        page: targetApiPage,
        limit: 15,
        sort: session.sort || 'relevance',
        durationFilter: session.durationFilter || 'all',
        category: session.categoryLabel || '',
        artist: session.artist || '',
        lazy: true
      }).catch(() => ({ results: [] }));
      moreResults = more?.results || [];
    } else if (session.mode === 'xvideos') {
      const more = await searchXvideos({
        query: session.query,
        page: targetApiPage,
        limit: 15,
        sort: session.sort || 'relevance',
        durationFilter: session.durationFilter || 'all',
        category: session.categoryLabel || '',
        artist: session.artist || '',
        lazy: true
      }).catch(() => ({ results: [] }));
      moreResults = more?.results || [];
    } else {
      const more = await searchAdultMovies({
        query: session.query,
        page: targetApiPage,
        limit: 15,
        sort: session.sort || 'relevance',
        artist: session.artist || null,
        minMinutes: 15,
        lazy: true
      }).catch(() => ({ results: [] }));
      moreResults = more?.results || [];
    }

    const existingIds = new Set(session.items.map(it => it.id));
    const added = moreResults.filter(it => it?.id && !existingIds.has(it.id));
    if (added.length) {
      session.apiPage = targetApiPage;
      session.items.push(...added);
    }
  }

  async function renderAndShowAdultCinemaPage(ctx, session, uiPage = 0) {
    const isGroup = isGroupChat(ctx);
    const PER_PAGE = 5;
    let safePage = Math.max(0, Number(uiPage) || 0);

    // Lazy-fetch next or jumped backend page when user paginates beyond buffered items
    if (safePage * PER_PAGE >= session.items.length && session.items.length >= 5) {
      await fetchMoreForSession(session, safePage);
    }

    let totalItems = session.items.length;
    let totalPages = Math.max(1, Math.ceil(totalItems / PER_PAGE));
    safePage = Math.min(safePage, Math.max(0, totalPages - 1));
    session.page = safePage;
    session.view = 'list';
    const start = safePage * PER_PAGE;
    const slice = session.items.slice(start, start + PER_PAGE);

    const titlePrefix = session.mode === 'pornhub' ? '🟠 PORNHUB'
      : session.mode === 'xvideos' ? '🔥 XVIDEOS'
      : session.mode === 'all' ? '🌐 18+ ALL SOURCES'
      : '🎬 18+ ADULT MOVIES';

    const filterBadges = [
      `Page ${safePage + 1}/${totalPages}`,
      `${totalItems}+ titles`,
      session.sort && session.sort !== 'relevance' ? `Sort: ${session.sort}` : null,
      session.durationFilter && session.durationFilter !== 'all' ? `Dur: ${session.durationFilter}` : null,
      session.artist ? `Star: ${truncate(session.artist, 14)}` : null
    ].filter(Boolean).join(' · ');

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `${titlePrefix} · "${truncate(session.query || 'trending', 24)}"`,
      filterBadges
    ], { size: 2 });

    const rows = slice.map((item, i) => {
      const absIdx = start + i;
      const checked = session.selectedIds.has(absIdx) ? '☑' : '☐';
      const srcTag = item.sourceKey === 'pornhub' ? '🟠'
        : item.sourceKey === 'xvideos' ? '🔥'
        : item.sourceKey === 'fullxcinema' ? '🎞'
        : item.sourceKey === 'pandamovies' ? '🐼'
        : item.sourceKey === 'xhamster' ? '🐹'
        : item.sourceKey === 'porntrex' ? '🦖'
        : '🎬';
      return [
        `${checked} ${absIdx + 1}.`,
        `${srcTag} ${truncate(item.fullTitle || item.title || '18+ Video', 36)}`,
        String(item.duration || 'HD').slice(0, 12)
      ];
    });
    if (rows.length) {
      b.table(rows, { striped: true, bordered: true, compact: true });
    }

    const selectedCount = session.selectedIds.size;
    if (isGroup) {
      b.paragraph(rt.italic('ℹ️ Group safety active: downloads use spoiler blur · VC streaming requires Admin/DJ · Tap 🎬 #N for Movie Detail & Quality.'));
    } else {
      b.paragraph(rt.italic(`Selected: ${selectedCount} · Tap 🎬 #N for Detail & Quality (360p/480p/720p), ▶ VC, ➕ Q, or ⬇ MP4`));
    }

    // Source Switcher row
    b.buttons([
      richButton.callback(session.mode === 'all' ? '• 🌐 All' : '🌐 All', encodeCallback(id, 'acSrc', session.sid, 'all')),
      richButton.callback(session.mode === 'xvideos' ? '• 🔥 XVideos' : '🔥 XVideos', encodeCallback(id, 'acSrc', session.sid, 'xvideos')),
      richButton.callback(session.mode === 'pornhub' ? '• 🟠 Pornhub' : '🟠 Pornhub', encodeCallback(id, 'acSrc', session.sid, 'pornhub')),
      richButton.callback(session.mode === 'adult_movies' ? '• 🎬 Movies' : '🎬 Movies', encodeCallback(id, 'acSrc', session.sid, 'adult_movies'))
    ]);

    slice.forEach((item, i) => {
      const absIdx = start + i;
      const num = absIdx + 1;
      const mark = session.selectedIds.has(absIdx) ? '☑' : '☐';
      b.buttons([
        richButton.callback(`${mark} #${num}`, encodeCallback(id, 'acTg', session.sid, String(absIdx))),
        richButton.callback(`🎬 #${num}`, encodeCallback(id, 'acDt', session.sid, String(absIdx)), { style: 'primary' }),
        richButton.callback('▶ VC', encodeCallback(id, 'acPl', session.sid, String(absIdx)), { style: 'success' }),
        richButton.callback('➕ Q', encodeCallback(id, 'acQu', session.sid, String(absIdx)), { style: 'primary' }),
        richButton.callback('⬇ MP4', encodeCallback(id, 'acDl', session.sid, String(absIdx)))
      ]);
    });

    b.buttons([
      richButton.callback('☑ Page', encodeCallback(id, 'acAp', session.sid, String(safePage))),
      richButton.callback('⬇ Slide Album', encodeCallback(id, 'acSl', session.sid, '0'), { style: 'primary' }),
      richButton.callback('➕ Queue Sel', encodeCallback(id, 'acQa', session.sid))
    ]);

    // Smart Page Navigation row with Jump button
    const navRow = [];
    if (safePage > 0) {
      navRow.push(richButton.callback('⏮ 1', encodeCallback(id, 'acPg', session.sid, '0')));
      navRow.push(richButton.callback('◀ Prev', encodeCallback(id, 'acPg', session.sid, String(safePage - 1)), { style: 'primary' }));
    }
    navRow.push(richButton.callback(`🔢 ${safePage + 1}/${totalPages} · Jump`, encodeCallback(id, 'acJp', session.sid), { style: 'primary' }));
    if (safePage < totalPages - 1 || totalItems >= 5) {
      navRow.push(richButton.callback('Next ▶', encodeCallback(id, 'acPg', session.sid, String(safePage + 1)), { style: 'primary' }));
      navRow.push(richButton.callback('⏭ +5', encodeCallback(id, 'acPg', session.sid, String(safePage + 5))));
    }
    b.buttons(navRow);

    // Sort & Duration filter row
    const durLabel = session.durationFilter === 'short' ? '⏱ <10m'
      : session.durationFilter === 'medium' ? '⏱ 10-20m'
      : session.durationFilter === 'long' ? '⏱ 20m+'
      : '⏱ All Dur';
    b.buttons([
      richButton.callback(session.sort === 'relevance' ? '• Rel' : '🔍 Rel', encodeCallback(id, 'xvSo', session.sid, 'relevance')),
      richButton.callback(session.sort === 'views' ? '• Views' : '🔥 Views', encodeCallback(id, 'xvSo', session.sid, 'views')),
      richButton.callback(session.sort === 'rating' ? '• Top' : '⭐ Top', encodeCallback(id, 'xvSo', session.sid, 'rating')),
      richButton.callback(durLabel, encodeCallback(id, 'acDur', session.sid))
    ]);

    b.buttons([
      richButton.callback('📂 Categories', encodeCallback(id, 'acCatMenu', session.mode || 'all', '0')),
      richButton.callback('🌟 Artists', encodeCallback(id, 'acArtMenu', session.mode || 'all', '0')),
      richButton.callback('🔍 Search', encodeCallback(id, 'cat', session.category)),
      richButton.callback('« Menu', encodeCallback(id, 'menu'))
    ]);
    b.validate();
    return upsertAdultScreen(ctx, b.toJSON(), null, session);
  }

  async function renderAdultPageJumpModal(ctx, session) {
    const PER_PAGE = 5;
    const totalPages = Math.max(1, Math.ceil((session.items?.length || 5) / PER_PAGE));
    const currentPage = (session.page || 0) + 1;

    // Transition user state to NSFW_PAGE_INPUT so they can also type any page number in chat
    const screenMsgId = session.msgId || ctx.query?.message?.message_id || ctx.screenMessageId;
    const tgId = nsfwStateKey(ctx);
    const sm = ctx.sm ?? ctx.machine;
    if (ctx.transition && !isChannelCtx(ctx)) {
      await ctx.transition(States.NSFW_PAGE_INPUT, {
        context: { sid: session.sid, screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      }).catch(() => {});
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_PAGE_INPUT, {
        context: { sid: session.sid, screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      }).catch(() => {});
    }

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `🔢 JUMP TO PAGE · "${truncate(session.query || 'trending', 22)}"`,
      `Current Page: ${currentPage} · Loaded Pages: ${totalPages}+`
    ], { size: 2 });
    b.paragraph(rt.italic('tap any page number below for instant navigation, or type any page number (e.g. 12) directly in chat ♡'));

    const maxGridPage = Math.max(12, totalPages + 6);
    const startP = Math.max(1, currentPage - 4);
    const pageNums = Array.from({ length: 12 }, (_, i) => startP + i).filter(p => p <= maxGridPage);
    for (let i = 0; i < pageNums.length; i += 4) {
      b.buttons(
        pageNums.slice(i, i + 4).map(p =>
          richButton.callback(
            p === currentPage ? `• Page ${p}` : `Page ${p}`,
            encodeCallback(id, 'acPg', session.sid, String(p - 1)),
            { style: p === currentPage ? 'success' : 'primary' }
          )
        )
      );
    }

    b.buttons([
      richButton.callback('⏮ Page 1', encodeCallback(id, 'acPg', session.sid, '0')),
      richButton.callback('+10 Pages ▶▶', encodeCallback(id, 'acPg', session.sid, String((session.page || 0) + 10)), { style: 'primary' }),
      richButton.callback('+20 Pages ⏭', encodeCallback(id, 'acPg', session.sid, String((session.page || 0) + 20)), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Back to Results', encodeCallback(id, 'acPg', session.sid, String(session.page || 0)), { style: 'primary' })
    ]);
    b.validate();
    return upsertAdultScreen(ctx, b.toJSON(), null, session);
  }

  function formatApproxMb(item, quality = '480p') {
    const variants = Array.isArray(item?.variants) ? item.variants : [];
    const targetH = parseInt(String(quality).replace(/[^\d]/g, ''), 10) || 480;
    const exact = variants.find(v => parseInt(String(v.quality || '').replace(/[^\d]/g, ''), 10) === targetH);
    if (exact?.sizeBytes > 0) {
      return `~${Math.max(1, Math.round(exact.sizeBytes / (1024 * 1024)))}MB`;
    }
    const durSec = Number(item?.durationSeconds || item?.durationSec) || 600;
    const kbps = targetH >= 720 ? 1500 : targetH >= 480 ? 850 : 480;
    const estMb = Math.max(2, Math.round((durSec * kbps) / 8 / 1024));
    return `~${estMb}MB`;
  }

  async function renderAdultDetailCard(ctx, session, idx) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const item = session?.items?.[idx];
    if (!session || !item) return answerCb(ctx, 'Session expired — search again.', true);

    await ensureAdultStreamResolved(item, { probeSize: true });
    session.activeDetailIdx = idx;
    const selectedQuality = session.dlQuality || '480p';

    const srcBadge = item.sourceKey === 'pornhub' ? '🟠 Pornhub'
      : item.sourceKey === 'xvideos' ? '🔥 XVideos'
      : '🎬 18+ Adult Cinema';

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `🔞 ${srcBadge.toUpperCase()} · MOVIE DETAIL`,
      truncate(item.fullTitle || item.title || '18+ Feature Stream', 48)
    ], { size: 2 });

    if (!isGroupChat(ctx) && item.thumbUrl && /^https?:\/\//i.test(item.thumbUrl)) {
      b.photo(item.thumbUrl);
    }

    const metaRows = [
      ['Title', item.fullTitle || item.title || '18+ Stream'],
      ['Source', srcBadge],
      ['Runtime', item.duration || 'HD'],
      ['Artist / Star', item.artist || 'Featured Creator']
    ];
    if (item.views) metaRows.push(['Views', String(item.views)]);
    if (item.rating) metaRows.push(['Rating', String(item.rating)]);
    if (Array.isArray(item.categories) && item.categories.length) {
      metaRows.push(['Categories', item.categories.slice(0, 5).join(', ')]);
    }
    b.table(kvTable(metaRows), { compact: true });

    b.paragraph(rt.italic(`📡 Select download/stream quality below (current: ${selectedQuality}) — VC streaming is restricted to authorized Admins/DJs.`));

    // Quality Selector Pills (360p / 480p / 720p) with approximate data size
    const qualities = ['360p', '480p', '720p'];
    b.buttons(
      qualities.map(q => {
        const isSel = selectedQuality === q;
        const sizeLabel = formatApproxMb(item, q);
        return richButton.callback(
          `${isSel ? '• ' : ''}${q} (${sizeLabel})`,
          encodeCallback(id, 'acQl', session.sid, String(idx), q),
          { style: isSel ? 'success' : 'primary' }
        );
      })
    );

    // Primary Movie Route Actions: Stream in VC, Queue, Download with selected quality
    b.buttons([
      richButton.callback('▶ Stream in VC', encodeCallback(id, 'acPl', session.sid, String(idx)), { style: 'success' }),
      richButton.callback('➕ Queue to VC', encodeCallback(id, 'acQu', session.sid, String(idx)), { style: 'primary' }),
      richButton.callback(`⬇ MP4 (${selectedQuality})`, encodeCallback(id, 'acDl', session.sid, String(idx)), { style: 'primary' })
    ]);

    // Interactive Artist & Category exploration buttons
    const exploreRow = [];
    if (item.artist && !/^(xvideos|pornhub|18\+|unknown)/i.test(item.artist)) {
      exploreRow.push(
        richButton.callback(`🌟 More by ${truncate(item.artist, 16)}`, encodeCallback(id, 'acArtName', session.sid, String(idx)), { style: 'primary' })
      );
    }
    const firstCat = Array.isArray(item.categories) && item.categories[0] ? item.categories[0] : null;
    if (firstCat) {
      const matchedCat = ADULT_CATEGORIES.find(c => c.label.toLowerCase() === String(firstCat).toLowerCase() || c.slug === String(firstCat).toLowerCase());
      if (matchedCat) {
        exploreRow.push(
          richButton.callback(`📂 #${truncate(matchedCat.label, 14)}`, encodeCallback(id, 'acCatPick', session.mode || 'all', matchedCat.slug))
        );
      }
    }
    if (exploreRow.length) b.buttons(exploreRow);

    b.buttons([
      richButton.callback('« Back to Results', encodeCallback(id, 'acPg', session.sid, String(session.page || 0)), { style: 'primary' }),
      richButton.callback('📂 Categories', encodeCallback(id, 'acCatMenu', session.mode || 'all', '0')),
      richButton.callback('🌟 Artists', encodeCallback(id, 'acArtMenu', session.mode || 'all', '0'))
    ]);
    b.validate();
    return upsertAdultScreen(ctx, b.toJSON(), null, session);
  }

  async function runAdultCinemaSearch(ctx, category, query = '', {
    page = 0,
    sort = 'relevance',
    durationFilter = 'all',
    categorySlug = '',
    categoryLabel = '',
    artist = '',
    dlQuality = '480p'
  } = {}) {
    cancelActiveSearch(ctx?.tgId, ctx?.chatId);
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const cleanQ = String(query || artist || categoryLabel || '').trim();
    if (isBlockedNsfwQuery(cleanQ)) {
      const b = new RichMessageBuilder();
      b.header('⚠️ QUERY BLOCKED BY SAFETY FILTER', 1);
      b.paragraph('Your search query contains prohibited terms. Queries involving minors or non-consensual content are strictly blocked.');
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    const mode = category === NSFW_CATEGORIES.PORNHUB_VIDEO ? 'pornhub'
      : category === NSFW_CATEGORIES.XVIDEOS_VIDEO ? 'xvideos'
      : category === 'adult_all' ? 'all'
      : 'adult_movies';
    const modeLabel = mode === 'pornhub' ? '🟠 Pornhub'
      : mode === 'xvideos' ? '🔥 XVideos'
      : mode === 'all' ? '🌐 All 18+ Sources'
      : '🎬 18+ Adult Cinema';
    const isGroup = isGroupChat(ctx);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);

    if (!isGroup && ctx.message?.message_id && app.settings?.get?.('telegram.messageCleanup')) {
      await api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }

    if (ctx.query?.id) {
      await answerCb(ctx, `🔍 Searching ${modeLabel} for "${truncate(cleanQ || 'trending', 24)}"…`);
    }

    let targetMsgId = ctx.query?.message?.message_id || ctx.screenMessageId || ctx.messageId || ctx.sm?.context?.(ctx.tgId)?.screenMessageId || null;
    if (!targetMsgId) {
      const loadingCard = new RichMessageBuilder();
      loadingCard.bannerHeader([
        `${modeLabel.toUpperCase()} · CINEMA CATALOG`,
        `🔍 Searching "${truncate(cleanQ || 'trending', 26)}"…`
      ], { size: 2 });
      loadingCard.paragraph(rt.italic('Fetching playable HD streams, categories & quality options…'));
      loadingCard.validate();
      const sentLoading = await api.sendRichMessage(chatId, loadingCard.toJSON()).catch(() => null);
      if (sentLoading?.message_id) {
        targetMsgId = sentLoading.message_id;
        ctx.screenMessageId = targetMsgId;
      }
    }

    const catalog = app.adultCatalog || adultCatalog;
    let res;
    if (mode === 'pornhub') {
      res = await searchPornhub({
        query: cleanQ,
        page,
        limit: 15,
        sort,
        durationFilter,
        category: categoryLabel,
        artist
      });
    } else if (mode === 'all') {
      res = await catalog.search({
        query: cleanQ,
        source: 'all',
        page,
        limit: 15,
        sort,
        durationFilter,
        category: categoryLabel,
        artist,
        lazy: true
      });
    } else if (mode === 'xvideos') {
      res = await searchXvideos({
        query: cleanQ,
        page,
        limit: 15,
        sort,
        durationFilter,
        category: categoryLabel,
        artist,
        lazy: true
      });
    } else {
      res = await searchAdultMovies({ query: cleanQ, page, limit: 15, artist, minMinutes: 15, lazy: true });
    }

    const items = res?.results || [];
    if (!items.length) {
      const b = new RichMessageBuilder();
      b.heading(
        mode === 'pornhub' ? '🟠 NO PORNHUB RESULTS'
          : mode === 'xvideos' ? '🔥 NO XVIDEOS RESULTS'
          : '🎬 NO 18+ MOVIES FOUND',
        2
      );
      b.paragraph(rt.italic(`nothing matched "${truncate(cleanQ || 'trending', 24)}" — try a different keyword or switch source.`));
      b.buttons([
        richButton.callback('🌐 Search All 18+ Sources', encodeCallback(id, 'acAllRun', cleanQ || 'trending'), { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('🔍 Try Another Search', encodeCallback(id, 'cat', category), { style: 'primary' }),
        richButton.callback('📂 Categories', encodeCallback(id, 'acCatMenu', mode, '0')),
        richButton.callback('« 18+ Menu', encodeCallback(id, 'menu'))
      ]);
      b.validate();
      return upsertAdultScreen(ctx, b.toJSON(), null, targetMsgId ? { msgId: targetMsgId } : null);
    }

    const sid = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    const session = rememberAdultSession({
      sid,
      mode,
      category,
      query: cleanQ || 'trending',
      page: 0,
      apiPage: page,
      sort,
      durationFilter,
      categorySlug,
      categoryLabel,
      artist,
      dlQuality,
      items,
      selectedIds: new Set(),
      msgId: targetMsgId || null,
      chatId,
      createdAt: Date.now()
    });
    if (targetMsgId) ctx.screenMessageId = targetMsgId;
    return renderAndShowAdultCinemaPage(ctx, session, 0);
  }

  async function answerCb(ctx, text = '', alert = false) {
    if (!ctx.query?.id) return;
    const api = ctx.api || app.telegram?.api;
    await api?.answerCallbackQuery?.(ctx.query.id, { text: String(text || '').slice(0, 190), show_alert: alert }).catch(() => {});
  }

  async function handleAdultPlayOrQueue(ctx, sid, idx, { playNow = true } = {}) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    const item = session?.items?.[idx];
    if (!session || !item) return answerCb(ctx, 'Session expired — search again.', true);

    const qm = app.musicQueueManager || app.music?.queue;
    if (!app.music || !qm) return answerCb(ctx, '⚠️ VC cinema player is unavailable right now.', true);

    try {
      const dest = app.music.destination(ctx);
      await app.music.authorize(ctx, true, dest, { allowDj: !isChannelCtx(ctx) });
      await answerCb(ctx, playNow ? '⏳ Loading 18+ stream into VC…' : '⏳ Adding to VC queue…');
      const preSess = qm.getSession(dest);
      if (playNow || !['playing', 'paused', 'buffering'].includes(preSess.status)) {
        preSess.activeDeck = 'movie';
        preSess.streamMode = qm.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
      }
      await app.music.prepare(ctx, dest);
      await ensureAdultStreamResolved(item);
      const track = buildAdultTrack(item, session.mode, session.dlQuality || '720p');
      if (!track.streamUrl) throw new Error('Playable stream URL could not be resolved.');

      await qm.addMovies(dest, [track], { playNow });
      const updated = qm.getSession(dest);
      if (playNow && updated.activeDeck === 'movie') {
        const canMorph = Boolean(session.msgId && !updated.screenMessageId && Number(ctx.chatId) === Number(session.chatId));
        await app.music.player({
          ...ctx,
          ...(canMorph ? { reuseMessageId: session.msgId } : {}),
          forceNew: !canMorph && !updated.screenMessageId
        }, dest).catch(() => null);
      }
      return { ok: true, track };
    } catch (err) {
      await answerCb(ctx, `⚠️ ${err?.message || 'Only authorized Admins/DJs can stream 18+ cinema to VC.'}`, true);
      return { ok: false, error: err?.message };
    }
  }

  async function handleAdultQueueSelected(ctx, sid) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    if (!session?.items?.length) return answerCb(ctx, 'Session expired — search again.', true);

    const qm = app.musicQueueManager || app.music?.queue;
    if (!app.music || !qm) return answerCb(ctx, '⚠️ VC queue is unavailable.', true);

    const indices = session.selectedIds.size
      ? [...session.selectedIds].sort((a, b) => a - b)
      : session.items.slice(session.page * 5, session.page * 5 + 5).map((_, i) => session.page * 5 + i);

    try {
      const dest = app.music.destination(ctx);
      await app.music.authorize(ctx, true, dest, { allowDj: !isChannelCtx(ctx) });
      await answerCb(ctx, `⏳ Queueing ${indices.length} title(s) to VC…`);
      const preSess = qm.getSession(dest);
      if (!['playing', 'paused', 'buffering'].includes(preSess.status)) {
        preSess.activeDeck = 'movie';
        preSess.streamMode = qm.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
      }
      await app.music.prepare(ctx, dest);
      const tracks = [];
      for (const idx of indices) {
        const it = session.items[idx];
        if (!it) continue;
        await ensureAdultStreamResolved(it);
        const tr = buildAdultTrack(it, session.mode, session.dlQuality || '720p');
        if (tr.streamUrl || tr.pageUrl) tracks.push(tr);
      }
      if (!tracks.length) throw new Error('No playable streams resolved.');
      await qm.addMovies(dest, tracks, { playNow: false });
      const s = qm.getSession(dest);
      s.view = 'mqueue';
      await app.music.player({ ...ctx, forceNew: !s.screenMessageId }, dest).catch(() => null);
      return { ok: true, count: tracks.length };
    } catch (err) {
      await answerCb(ctx, `⚠️ ${err?.message || 'Only authorized Admins/DJs can queue 18+ cinema to VC.'}`, true);
      return { ok: false, error: err?.message };
    }
  }

  async function handleAdultDownloadSingle(ctx, sid, idx) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    const item = session?.items?.[idx];
    if (!session || !item) return answerCb(ctx, 'Session expired — search again.', true);
    if (!app.movieDownloader) return answerCb(ctx, '⚠️ Downloader module unavailable.', true);

    const quality = session.dlQuality || '480p';
    await answerCb(ctx, `⬇️ Preparing ${quality} MP4 upload…`);
    try {
      await ensureAdultStreamResolved(item);
      const track = buildAdultTrack(item, session.mode, quality);
      const res = await app.movieDownloader.sendSingleVideo(ctx, track, {
        spoiler: isGroupChat(ctx),
        quality
      });
      if (!res?.ok) {
        await answerCb(ctx, `⚠️ Download failed: ${res?.reason || 'stream unavailable'}`, true);
      }
      return res;
    } catch (err) {
      await answerCb(ctx, `⚠️ ${err?.message || 'Download failed.'}`, true);
      return { ok: false };
    }
  }

  async function handleAdultDownloadSlides(ctx, sid, slidePage = 0) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    if (!session?.items?.length) return answerCb(ctx, 'Session expired — search again.', true);
    if (!app.movieDownloader) return answerCb(ctx, '⚠️ Downloader module unavailable.', true);

    const quality = session.dlQuality || '480p';
    await answerCb(ctx, '🎞 Preparing paginated video slide album…');
    try {
      if (!session.dlManifest || slidePage === 0) {
        const indices = session.selectedIds.size
          ? [...session.selectedIds].sort((a, b) => a - b)
          : session.items.slice(session.page * 5, session.page * 5 + 5).map((_, i) => session.page * 5 + i);
        const tracks = [];
        for (const idx of indices) {
          const it = session.items[idx];
          if (!it) continue;
          await ensureAdultStreamResolved(it);
          const tr = buildAdultTrack(it, session.mode, quality);
          if (tr.streamUrl) tracks.push(tr);
        }
        session.dlManifest = {
          title: `${session.mode === 'pornhub' ? 'Pornhub' : session.mode === 'xvideos' ? 'XVideos' : '18+ Cinema'} · ${session.query}`,
          pageSize: 4,
          items: tracks
        };
      }
      const res = await app.movieDownloader.deliverAlbumSlidePage(ctx, session, slidePage, {
        buildNavCallback: (p) => encodeCallback(id, 'acSl', session.sid, String(p)),
        backCallback: () => encodeCallback(id, 'acPg', session.sid, String(session.page || 0)),
        spoiler: isGroupChat(ctx),
        quality
      });
      if (!res?.ok) {
        await answerCb(ctx, `⚠️ Slide upload failed: ${res?.reason || 'stream unavailable'}`, true);
      }
      return res;
    } catch (err) {
      await answerCb(ctx, `⚠️ ${err?.message || 'Slide album failed.'}`, true);
      return { ok: false };
    }
  }

  function registerStateHandlers(sm) {
    sm.register(States.NSFW_PAGE_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        const pageNum = parseInt(text.replace(/[^\d]/g, ''), 10);
        const sid = sctx.context?.sid;
        const session = getAdultSession(sid);
        if (!isGroupChat(sctx) && message.message_id) {
          await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        await sm.reset(nsfwStateKey(sctx), { reason: 'page_jump' }).catch(() => {});
        if (!session || isNaN(pageNum) || pageNum < 1) {
          return false;
        }
        sctx.screenMessageId = session.msgId || sctx.context?.screenMessageId || sctx.screenMessageId;
        await renderAndShowAdultCinemaPage(sctx, session, pageNum - 1);
        return true;
      }
    });

    sm.register(States.NSFW_ARTIST_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        const source = sctx.context?.source || 'all';
        if (!isGroupChat(sctx) && message.message_id) {
          await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        await sm.reset(nsfwStateKey(sctx), { reason: 'artist_search' }).catch(() => {});
        sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
        const targetCategory = source === 'pornhub' ? NSFW_CATEGORIES.PORNHUB_VIDEO
          : source === 'xvideos' ? NSFW_CATEGORIES.XVIDEOS_VIDEO
          : source === 'adult_movies' ? NSFW_CATEGORIES.ADULT_MOVIES
          : 'adult_all';
        await runAdultCinemaSearch(sctx, targetCategory, text, { artist: text });
        return true;
      }
    });

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
          const botPromptMsgId = message.reply_to_message?.message_id || sctx.screenMessageId || sctx.context?.screenMessageId;
          if (botPromptMsgId) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, botPromptMsgId).catch(() => {});
          }
          const activeCat = sctx.context?.category || 'all';
          if (isAdultCinemaCategory(activeCat)) {
            await sm.reset(nsfwStateKey(sctx), { reason: 'adult_cinema_search' }).catch(() => {});
            await runAdultCinemaSearch(sctx, activeCat, text);
            return true;
          }
          await askCount(sctx, text, activeCat, { replyToMessageId: message.message_id });
        } else {
          if (message.message_id) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
          }
          const activeCat = sctx.context?.category || 'all';
          if (isAdultCinemaCategory(activeCat)) {
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await sm.reset(nsfwStateKey(sctx), { reason: 'adult_cinema_search' }).catch(() => {});
            await runAdultCinemaSearch(sctx, activeCat, text);
            return true;
          }
          await askCount(sctx, text, activeCat);
        }
        return true;
      },
      onTimeout: async (sctx) => {
        await (sctx.api || app.telegram.api).sendMessage(sctx.chatId, '♡ 18+ search timed out — send a new query whenever you are ready.').catch(() => {});
      },
      onCleanup: (sctx) => {
        cancelActiveSearch(sctx?.tgId, sctx?.chatId);
      }
    });
  }

  return {
    id,
    registerStateHandlers,
    toggleGroupNsfw,
    async executeSearch(ctx, query, category = 'all', page = 0) {
      const q = String(query || '').trim().toLowerCase();
      if (q === 'off' || q === 'lock' || q === 'disable') return toggleGroupNsfw(ctx, false);
      if (q === 'on' || q === 'unlock' || q === 'enable') return toggleGroupNsfw(ctx, true);
      if (isAdultCinemaCategory(category)) {
        return runAdultCinemaSearch(ctx, category, query, { page });
      }
      return runSearch(ctx, query, category, 10);
    },
    async executeAdultMoviesSearch(ctx, query = '') {
      return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.ADULT_MOVIES, query);
    },
    async executeXvideosSearch(ctx, query = '') {
      return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.XVIDEOS_VIDEO, query);
    },
    async executePornhubSearch(ctx, query = '') {
      return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.PORNHUB_VIDEO, query);
    },
    async openAdultMovies(ctx) {
      cancelActiveSearch(ctx?.tgId, ctx?.chatId);
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
      if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
      await editOrSend(ctx, renderAdultMoviesMenu(ctx));
    },
    async openXvideosHub(ctx) {
      cancelActiveSearch(ctx?.tgId, ctx?.chatId);
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
      if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
      await editOrSend(ctx, renderXvideosMenu(ctx));
    },
    async openPornhubHub(ctx) {
      cancelActiveSearch(ctx?.tgId, ctx?.chatId);
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
      if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
      await editOrSend(ctx, renderPornhubMenu(ctx));
    },
    async open(ctx) {
      cancelActiveSearch(ctx?.tgId, ctx?.chatId);
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      if (action !== 'noop') {
        cancelActiveSearch(ctx?.tgId, ctx?.chatId);
      }
      switch (action) {
        case 'confirmAge':
          app.db?.setSetting?.(`nsfw.ageVerified.${ctx.tgId}`, true);
          if (ctx.query?.id) await (ctx.api || app.telegram?.api)?.answerCallbackQuery?.(ctx.query.id, { text: '🔞 Age verified!' }).catch(() => {});
          return openMenu(ctx);
        case 'toggleGroup':
          return toggleGroupNsfw(ctx);
        case 'open':
        case 'menu':
          return openMenu(ctx);
        case 'sub': {
          const subCategory = args[0] || '';
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          if (subCategory === 'hentai_wallpapers') {
            return editOrSend(ctx, renderHentaiWallpapersMenu(ctx));
          } else if (subCategory === 'hentai_videos') {
            return editOrSend(ctx, renderHentaiVideosMenu(ctx));
          } else if (subCategory === 'real_wallpapers') {
            return editOrSend(ctx, renderRealWallpapersMenu(ctx));
          } else if (subCategory === 'real_videos') {
            return editOrSend(ctx, renderRealVideosMenu(ctx));
          } else if (subCategory === 'adult_movies') {
            return editOrSend(ctx, renderAdultMoviesMenu(ctx));
          } else if (subCategory === 'xvideos') {
            return editOrSend(ctx, renderXvideosMenu(ctx));
          } else if (subCategory === 'pornhub') {
            return editOrSend(ctx, renderPornhubMenu(ctx));
          }
          return openMenu(ctx);
        }
        case 'cat':
        case 'searchPrompt': {
          const category = args[0] || 'all';
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          return askQuery(ctx, category);
        }
        case 'customCount': {
          const category = args[0] || 'all';
          const query = args[1] || ctx.sm?.context?.(ctx.tgId)?.query || '';
          return askCustomCount(ctx, category, query);
        }
        case 'askCountDirect': {
          const query = args[0] || '';
          const category = args[1] || 'all';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          if (isAdultCinemaCategory(category)) {
            return runAdultCinemaSearch(ctx, category, query);
          }
          return askCount(ctx, query, category);
        }
        case 'xvRun': {
          const q = args[0] || 'trending';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.XVIDEOS_VIDEO, q);
        }
        case 'phRun': {
          const q = args[0] || 'trending';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.PORNHUB_VIDEO, q);
        }
        case 'amRun': {
          const q = args[0] || 'full movie';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.ADULT_MOVIES, q);
        }
        case 'acAllRun': {
          const q = args[0] || 'trending';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, 'adult_all', q);
        }
        case 'acCatMenu': {
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          await answerCb(ctx);
          return renderAdultCategoriesMenu(ctx, args[0] || 'all', Number(args[1]) || 0);
        }
        case 'acCatPick': {
          const [source = 'all', slug = 'trending'] = args;
          const catObj = ADULT_CATEGORIES.find(c => c.slug === slug) || { slug, label: slug, query: slug };
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          const targetCat = source === 'pornhub' ? NSFW_CATEGORIES.PORNHUB_VIDEO
            : source === 'xvideos' ? NSFW_CATEGORIES.XVIDEOS_VIDEO
            : source === 'adult_movies' ? NSFW_CATEGORIES.ADULT_MOVIES
            : 'adult_all';
          return runAdultCinemaSearch(ctx, targetCat, catObj.query, {
            categorySlug: catObj.slug,
            categoryLabel: catObj.query
          });
        }
        case 'acArtMenu': {
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          await answerCb(ctx);
          return renderAdultArtistsMenu(ctx, args[0] || 'all', Number(args[1]) || 0);
        }
        case 'acArtSrch': {
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          await answerCb(ctx);
          return askArtistSearch(ctx, args[0] || 'all');
        }
        case 'acArtIdx': {
          const [source = 'all', idxStr = '0'] = args;
          const star = FEATURED_ARTISTS[Number(idxStr)] || FEATURED_ARTISTS[0];
          const artistName = typeof star === 'string' ? star : star?.name || 'Eva Elfie';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          const targetCat = source === 'pornhub' ? NSFW_CATEGORIES.PORNHUB_VIDEO
            : source === 'xvideos' ? NSFW_CATEGORIES.XVIDEOS_VIDEO
            : source === 'adult_movies' ? NSFW_CATEGORIES.ADULT_MOVIES
            : 'adult_all';
          return runAdultCinemaSearch(ctx, targetCat, artistName, { artist: artistName });
        }
        case 'acArtName': {
          const [sid, idxStr] = args;
          const session = getAdultSession(sid);
          const item = session?.items?.[Number(idxStr)];
          if (!session || !item?.artist) return answerCb(ctx, 'Artist unavailable.', true);
          ctx.screenMessageId = ctx.query?.message?.message_id || session.msgId || ctx.messageId;
          return runAdultCinemaSearch(ctx, session.category, item.artist, { artist: item.artist });
        }
        case 'acSrc': {
          const [sid, newMode] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          ctx.screenMessageId = ctx.query?.message?.message_id || session.msgId || ctx.messageId;
          const targetCat = newMode === 'pornhub' ? NSFW_CATEGORIES.PORNHUB_VIDEO
            : newMode === 'xvideos' ? NSFW_CATEGORIES.XVIDEOS_VIDEO
            : newMode === 'adult_movies' ? NSFW_CATEGORIES.ADULT_MOVIES
            : 'adult_all';
          return runAdultCinemaSearch(ctx, targetCat, session.query, {
            sort: session.sort || 'relevance',
            durationFilter: session.durationFilter || 'all',
            categorySlug: session.categorySlug || '',
            categoryLabel: session.categoryLabel || '',
            artist: session.artist || '',
            dlQuality: session.dlQuality || '480p'
          });
        }
        case 'acDur': {
          const [sid] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          const order = ['all', 'short', 'medium', 'long'];
          const nextDur = order[(order.indexOf(session.durationFilter || 'all') + 1) % order.length];
          ctx.screenMessageId = ctx.query?.message?.message_id || session.msgId || ctx.messageId;
          return runAdultCinemaSearch(ctx, session.category, session.query, {
            sort: session.sort || 'relevance',
            durationFilter: nextDur,
            categorySlug: session.categorySlug || '',
            categoryLabel: session.categoryLabel || '',
            artist: session.artist || '',
            dlQuality: session.dlQuality || '480p'
          });
        }
        case 'xvSo': {
          const [sid, sort] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          ctx.screenMessageId = ctx.query?.message?.message_id || session.msgId || ctx.messageId;
          return runAdultCinemaSearch(ctx, session.category || NSFW_CATEGORIES.XVIDEOS_VIDEO, session.query, {
            sort: sort || 'relevance',
            durationFilter: session.durationFilter || 'all',
            categorySlug: session.categorySlug || '',
            categoryLabel: session.categoryLabel || '',
            artist: session.artist || '',
            dlQuality: session.dlQuality || '480p'
          });
        }
        case 'acJp': {
          const [sid] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          await answerCb(ctx, '🔢 Select a page or type any page number in chat');
          return renderAdultPageJumpModal(ctx, session);
        }
        case 'acDt': {
          const [sid, idxStr] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          await answerCb(ctx, '🎬 Loading 18+ Movie Detail & Quality options…');
          return renderAdultDetailCard(ctx, session, Number(idxStr) || 0);
        }
        case 'acQl': {
          const [sid, idxStr, quality] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          session.dlQuality = quality || '480p';
          await answerCb(ctx, `✅ Quality set to ${session.dlQuality}`);
          return renderAdultDetailCard(ctx, session, Number(idxStr) || 0);
        }
        case 'acPg': {
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          const [sid, pg] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, Number(pg) || 0);
        }
        case 'acTg': {
          const [sid, idxStr] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          const idx = Number(idxStr);
          if (session.selectedIds.has(idx)) session.selectedIds.delete(idx);
          else session.selectedIds.add(idx);
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, session.page);
        }
        case 'acAp': {
          const [sid, pg] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          const page = Number(pg) ?? session.page ?? 0;
          const start = page * 5;
          const end = Math.min(session.items.length, start + 5);
          const allSelected = end > start && Array.from({ length: end - start }, (_, k) => start + k).every(i => session.selectedIds.has(i));
          for (let i = start; i < end; i++) {
            if (allSelected) session.selectedIds.delete(i);
            else session.selectedIds.add(i);
          }
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, page);
        }
        case 'acPl':
          return handleAdultPlayOrQueue(ctx, args[0], Number(args[1]), { playNow: true });
        case 'acQu':
          return handleAdultPlayOrQueue(ctx, args[0], Number(args[1]), { playNow: false });
        case 'acQa':
          return handleAdultQueueSelected(ctx, args[0]);
        case 'acDl':
          return handleAdultDownloadSingle(ctx, args[0], Number(args[1]));
        case 'acSl':
          return handleAdultDownloadSlides(ctx, args[0], Number(args[1]) || 0);
        case 'noop':
          return answerCb(ctx);
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
          if (cat === NSFW_CATEGORIES.ADULT_MOVIES) {
            const pool = CATEGORY_SUGGESTIONS[NSFW_CATEGORIES.ADULT_MOVIES];
            return runAdultCinemaSearch(ctx, cat, pool[Math.floor(Math.random() * pool.length)]);
          }
          if (cat === NSFW_CATEGORIES.XVIDEOS_VIDEO) {
            const pool = CATEGORY_SUGGESTIONS[NSFW_CATEGORIES.XVIDEOS_VIDEO];
            return runAdultCinemaSearch(ctx, cat, pool[Math.floor(Math.random() * pool.length)]);
          }
          if (cat === NSFW_CATEGORIES.PORNHUB_VIDEO) {
            const pool = CATEGORY_SUGGESTIONS[NSFW_CATEGORIES.PORNHUB_VIDEO];
            return runAdultCinemaSearch(ctx, cat, pool[Math.floor(Math.random() * pool.length)]);
          }
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
          cancelActiveSearch(ctx?.tgId, ctx?.chatId);
          await ctx.sm?.cancel?.(ctx.tgId);
          return openMenu(ctx);
        default:
          return openMenu(ctx);
      }
    }
  };
}
