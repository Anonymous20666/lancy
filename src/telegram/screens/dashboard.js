import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable, statusDot, ACCENT, SPARK } from '../ui.js';
import { formatDateTime, timeAgo } from '../../utils/text.js';

// In-memory cache for user profile photos: tgId -> { buffer, expiresAt }
const pfpCache = new Map();
const PFP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getUserPfp(ctx) {
  const userId = Number(ctx.tgId);
  if (!userId || !ctx.api?.getUserProfilePhotos) return null;

  const cached = pfpCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.buffer;
  }

  try {
    const photosRes = await ctx.api.getUserProfilePhotos(userId, { limit: 1 });
    if (!photosRes || photosRes.total_count === 0 || !photosRes.photos?.[0]?.length) {
      pfpCache.set(userId, { buffer: null, expiresAt: Date.now() + PFP_CACHE_TTL_MS });
      return null;
    }
    const photos = photosRes.photos[0];
    const bestPhoto = photos[photos.length - 1];
    const fileRes = await ctx.api.getFile(bestPhoto.file_id);
    if (!fileRes?.file_path) return null;
    const buffer = await ctx.api.downloadFile(fileRes.file_path);
    pfpCache.set(userId, { buffer, expiresAt: Date.now() + PFP_CACHE_TTL_MS });
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Dashboard — the /start hero. A beautiful Rich Message with live status and
 * the primary navigation. Not a wall of buttons: six sections, grouped.
 */
export function createDashboardScreen({ app }) {
  const id = 'dashboard';

  async function gatherStats(ctx) {
    const { db, settings } = ctx;
    const userId = Number(ctx.tgId);
    const sessions = app.whatsapp?.listForUser(userId) ?? [];
    const online = sessions.filter((s) => s.status === 'online').length;
    const packs = db.get('SELECT COUNT(*) AS c FROM sticker_packs WHERE user_id = ?', userId)?.c ?? 0;
    const searches = db.get('SELECT COUNT(*) AS c FROM pinterest_searches WHERE user_id = ?', userId)?.c ?? 0;
    const delivered = db.get('SELECT COUNT(*) AS c FROM user_media_history WHERE user_id = ?', userId)?.c ?? 0;
    const ai = await app.ai?.status().catch(() => ({ enabled: false, available: false, provider: '—' }));
    const cacheStats = app.media?.cache.stats() ?? { entries: 0, totalBytes: 0 };
    return { sessions, online, packs, searches, delivered, ai, cacheStats };
  }

  function render(ctx, stats, hasPfp = false) {
    const { settings } = ctx;
    const tz = settings.get('general.timezone') ?? 'UTC';
    const botName = settings.get('general.botName') ?? 'Lancy Bot';
    const firstName = ctx.user?.first_name ?? 'bestie';

    const b = new RichMessageBuilder();
    if (hasPfp) {
      b.photo('attach://pfp');
    }
    b.paragraph(rt.concat(
      rt.bold(banner([
        `𓆩♡𓆪 ${botName.toUpperCase()} 𓆩♡𓆪`,
        'your cute little control center ♡'
      ]))
    ));
    b.spacer();
    b.paragraph(rt.concat(rt.italic(`welcome back, ${firstName} ♡`), rt.text(`\n${formatDateTime(new Date(), tz)}`)));
    b.divider();

    // Live status card
    b.heading('𓆩♡𓆪 status overview', 3);
    b.table(kvTable([
      ['ʕ•ᴥ•ʔ WhatsApp', `${statusDot(stats.online > 0 ? 'online' : 'offline')} ${stats.online}/${stats.sessions.length} sessions online`],
      ['˙ᵕ˙ Sticker packs', `${stats.packs} created`],
      ['୨୧ Pinterest', `${stats.searches} searches • ${stats.delivered} saved`],
      ['૮꒰ ˶• ༝ •˶꒱ა AI assistant', stats.ai?.enabled ? `${statusDot(stats.ai.available ? 'online' : 'offline')} ${stats.ai.provider}` : 'off'],
      ['₊˚⊹♡ Media cache', `${stats.cacheStats.entries} files`]
    ]), { compact: true });
    b.divider();

    // Primary navigation — six sections in a 2-column feel via button rows.
    b.heading('୨୧ quick actions', 3);
    b.buttons([
      richButton.callback('🔍 Pinterest Studio', encodeCallback('pinterest', 'open')),
      richButton.callback('🎀 TG Stickers', encodeCallback('stickers', 'open'))
    ]);
    b.buttons([
      richButton.callback('📱 WhatsApp Studio', encodeCallback('whatsapp', 'open')),
      richButton.callback('📥 URL Downloader', encodeCallback('downloader', 'open'))
    ]);
    b.buttons([
      richButton.callback('🎵 Play Music', encodeCallback('downloader', 'play')),
      richButton.callback('🪄 AI Assistant', encodeCallback('ai', 'open'))
    ]);
    b.buttons([
      richButton.callback('⚙ Settings', encodeCallback('settings', 'open')),
      richButton.callback('୨୧ Help & Guide', encodeCallback('help', 'open'))
    ]);

    b.footer(rt.concat(rt.italic('made with love by '), rt.bold(settings.get('general.defaultCreatorName') ?? 'Lancy'), rt.italic(' ♡')));
    b.validate();
    return b.toJSON();
  }

  return {
    id,
    async open(ctx, { forceNew = false } = {}) {
      const stats = await gatherStats(ctx);
      const pfpBuffer = await getUserPfp(ctx);
      const hasPfp = !!pfpBuffer;
      const rich = render(ctx, stats, hasPfp);
      const files = pfpBuffer ? { pfp: { buffer: pfpBuffer, filename: 'pfp.jpg', contentType: 'image/jpeg' } } : null;
      if (forceNew || ctx.forceNew) {
        const sent = await ctx.sendRichMessage(rich, {}, files);
        if (sent?.message_id) {
          ctx.controller?.userScreenMessage?.set(ctx.tgId, { chatId: ctx.chatId, messageId: sent.message_id });
          ctx.sm?.update(ctx.tgId, { screenMessageId: sent.message_id });
        }
        return sent;
      }
      return ctx.editScreen(rich, {}, files);
    },
    async handle(ctx, action, args) {
      if (action === 'open' || action === 'refresh') {
        const queryMsg = ctx.query?.message ?? ctx.message;
        const fromMedia = Boolean(
          args?.includes('from_media') ||
          args?.[0] === 'from_media' ||
          ctx.fromMedia ||
          ctx.forceNew ||
          (queryMsg && ctx.controller?.isMediaDeliveryMessage?.(queryMsg))
        );
        await this.open(ctx, { forceNew: fromMedia });
      }
    }
  };
}
