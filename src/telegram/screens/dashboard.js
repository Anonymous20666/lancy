import sharp from 'sharp';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable, statusDot, ACCENT, SPARK } from '../ui.js';
import { formatDateTime, timeAgo } from '../../utils/text.js';
import { getLanguageName } from '../../core/i18n.js';

// In-memory cache for user profile photos: tgId -> { buffer, expiresAt }
const pfpCache = new Map();
const PFP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getFallbackBanner(botName = 'Lancy Bot', userName = '') {
  try {
    const cleanName = String(botName || 'Lancy Bot').replace(/[<>&"']/g, '').trim();
    const cleanUser = String(userName || '').replace(/[<>&"']/g, '').trim();
    const svg = `
      <svg width="800" height="400" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ffb6c1"/>
            <stop offset="50%" stop-color="#dda0dd"/>
            <stop offset="100%" stop-color="#b0e0e6"/>
          </linearGradient>
        </defs>
        <rect width="800" height="400" rx="30" fill="url(#g)"/>
        <text x="50%" y="42%" text-anchor="middle" font-family="sans-serif" font-size="52" font-weight="bold" fill="#ffffff" letter-spacing="3">𓆩♡𓆪 ${cleanName.toUpperCase()} 𓆩♡𓆪</text>
        <text x="50%" y="62%" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#ffffff" opacity="0.95">${cleanUser ? `welcome ${cleanUser} ♡` : 'group companion & music stream ♡'}</text>
      </svg>
    `;
    return await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  } catch {
    return null;
  }
}

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
    const botName = ctx.botName || settings.get('general.botName') || 'Lancy Bot';
    const firstName = ctx.user?.first_name ?? 'bestie';
    const isGroup = Boolean(ctx.isGroup);

    const b = new RichMessageBuilder();
    if (hasPfp) {
      b.photo('attach://pfp');
    }
    b.paragraph(rt.concat(
      rt.bold(banner([
        `𓆩♡𓆪 ${botName.toUpperCase()} 𓆩♡𓆪`,
        isGroup ? 'group media & music companion ♡' : 'your cute little control center ♡'
      ]))
    ));
    b.spacer();
    if (isGroup) {
      b.paragraph(rt.concat(rt.italic(`hello everyone! I'm ${botName} ♡`), rt.text(`\n${formatDateTime(new Date(), tz)}`)));
    } else {
      b.paragraph(rt.concat(rt.italic(`welcome back, ${firstName} ♡`), rt.text(`\n${formatDateTime(new Date(), tz)}`)));
    }
    b.divider();

    // Live status card
    b.heading('𓆩♡𓆪 status overview', 3);
    if (isGroup) {
      b.table(kvTable([
        ['🎵 Music Engine', 'High-Speed MP3 & Lyrics Active'],
        ['📥 Downloader', 'YouTube, TikTok, Spotify & 1000+ sites'],
        ['୨୧ Pinterest', `${stats.searches ?? 0} searches completed`],
        ['₊˚⊹♡ Media cache', `${stats.cacheStats?.entries ?? 0} files cached`]
      ]), { compact: true });
    } else {
      b.table(kvTable([
        ['ʕ•ᴥ•ʔ WhatsApp', `${statusDot(stats.online > 0 ? 'online' : 'offline')} ${stats.online ?? 0}/${stats.sessions?.length ?? 0} sessions online`],
        ['˙ᵕ˙ Sticker packs', `${stats.packs ?? 0} created`],
        ['୨୧ Pinterest', `${stats.searches ?? 0} searches • ${stats.delivered ?? 0} saved`],
        ['૮꒰ ˶• ༝ •˶꒱ა AI assistant', stats.ai?.enabled ? `${statusDot(stats.ai.available ? 'online' : 'offline')} ${stats.ai.provider}` : 'off'],
        ['₊˚⊹♡ Media cache', `${stats.cacheStats?.entries ?? 0} files`]
      ]), { compact: true });
    }
    b.divider();

    // Primary navigation — grouped rows.
    b.heading('୨୧ quick actions', 3);
    if (isGroup) {
      // In groups: WhatsApp and AI are omitted
      b.buttons([
        richButton.callback('🎵 Play Music', encodeCallback('downloader', 'play')),
        richButton.callback('📥 URL Downloader', encodeCallback('downloader', 'open'))
      ]);
      b.buttons([
        richButton.callback('🔍 Pinterest Studio', encodeCallback('pinterest', 'open')),
        richButton.callback('🌐 Language', encodeCallback(id, 'language'))
      ]);
      b.buttons([
        richButton.callback('୨୧ Help & Guide', encodeCallback('help', 'open'))
      ]);
    } else {
      // In private chat: Full dashboard with Clone Bot
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
        richButton.callback('🤖 Clone Bot', encodeCallback('clone', 'open')),
        richButton.callback('⚙ Settings', encodeCallback('settings', 'open'))
      ]);
      b.buttons([
        richButton.callback('🌐 Language', encodeCallback(id, 'language')),
        richButton.callback('୨୧ Help & Guide', encodeCallback('help', 'open'))
      ]);
    }

    b.footer(rt.concat(rt.italic('made with love by '), rt.bold(ctx.botName || settings.get('general.defaultCreatorName') || 'Lancy'), rt.italic(' ♡')));
    b.validate();
    return b.toJSON();
  }

  function renderLanguagePicker(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 CHOOSE LANGUAGE 𓆩♡𓆪',
      'customize your bot language ♡'
    ])));
    b.divider();
    b.quote(rt.concat(
      rt.bold('🌍 Please select your preferred language:\n'),
      rt.text('All bot responses and notifications will be personalized for you ♡')
    ));
    b.divider();

    const langRows = [
      [
        richButton.callback('🇬🇧 English', encodeCallback(id, 'set_lang', 'en'), { style: 'primary' }),
        richButton.callback('🇪🇸 Español', encodeCallback(id, 'set_lang', 'es'), { style: 'primary' })
      ],
      [
        richButton.callback('🇫🇷 Français', encodeCallback(id, 'set_lang', 'fr'), { style: 'primary' }),
        richButton.callback('🇸🇦 العربية', encodeCallback(id, 'set_lang', 'ar'), { style: 'primary' })
      ],
      [
        richButton.callback('🇧🇷 Português', encodeCallback(id, 'set_lang', 'pt'), { style: 'primary' }),
        richButton.callback('🇷🇺 Русский', encodeCallback(id, 'set_lang', 'ru'), { style: 'primary' })
      ],
      [
        richButton.callback('🇮🇩 Bahasa Indonesia', encodeCallback(id, 'set_lang', 'id'), { style: 'primary' }),
        richButton.callback('« Back', encodeCallback(id, 'open'))
      ]
    ];
    for (const row of langRows) {
      b.buttons(row);
    }
    b.footer(rt.italic('Language is saved to your personal profile ♡'));
    b.validate();
    return b.toJSON();
  }

  return {
    id,
    render(ctx, stats = {}, hasPfp = false) {
      return render(ctx, stats, hasPfp);
    },
    async open(ctx, { forceNew = false } = {}) {
      const stats = await gatherStats(ctx);
      let pfpBuffer = await getUserPfp(ctx);
      if (!pfpBuffer) {
        const botName = ctx.botName || 'Lancy Bot';
        const firstName = ctx.user?.first_name ?? '';
        pfpBuffer = await getFallbackBanner(botName, firstName);
      }
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
        return this.open(ctx, { forceNew: fromMedia });
      }
      if (action === 'language') {
        return ctx.editScreen(renderLanguagePicker(ctx));
      }
      if (action === 'set_lang') {
        const langCode = args[0] || 'en';
        const botId = ctx.botId ?? 0;
        try {
          ctx.db.run(
            `INSERT INTO bot_users (bot_id, tg_id, language, last_seen)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(bot_id, tg_id) DO UPDATE SET
               language = excluded.language,
               last_seen = datetime('now')`,
            botId, Number(ctx.tgId), langCode
          );
        } catch {}
        if (ctx.query?.id) {
          const langName = getLanguageName(langCode);
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Language set to ${langName} ♡` }).catch(() => {});
        }
        return this.open(ctx);
      }
    }
  };
}
