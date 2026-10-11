import { logger } from '../core/logger.js';

const log = logger().child({ module: 'telegram-permissions' });

// In-memory cache for chat media permissions (chatId -> { caps, expiresAt })
const permissionsCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// In-memory storage for pending deep-link downloads (token -> { url, createdAt })
const pendingDownloads = new Map();
const DL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Register a pending download URL for deep-linking into private DM.
 * Generates an 8-character token safe for Telegram start parameter.
 */
export function registerPendingDownload(url, db = null) {
  if (!url) return '';
  const token = Math.random().toString(36).slice(2, 10);
  const cleanUrl = String(url).trim();
  pendingDownloads.set(token, { url: cleanUrl, createdAt: Date.now() });

  if (db && typeof db.run === 'function') {
    try {
      db.run(
        'INSERT OR REPLACE INTO bot_settings (key, value_json) VALUES (?, ?)',
        `dl_token_${token}`,
        JSON.stringify({ url: cleanUrl, createdAt: Date.now() })
      );
    } catch {}
  }

  // Periodic cleanup of stale tokens
  if (pendingDownloads.size > 1000) {
    const now = Date.now();
    for (const [k, v] of pendingDownloads.entries()) {
      if (now - v.createdAt > DL_TOKEN_TTL_MS) pendingDownloads.delete(k);
    }
  }

  return token;
}

/**
 * Resolve a download token back to its original URL.
 */
export function resolvePendingDownload(token, db = null) {
  if (!token) return null;
  const cleanToken = String(token).trim();

  // 1. In-memory check
  const cached = pendingDownloads.get(cleanToken);
  if (cached?.url) return cached.url;

  // 2. Database check
  if (db) {
    try {
      const row = (db.get || db.prepare?.('SELECT value_json FROM bot_settings WHERE key = ?')?.get)?.call(
        db,
        'SELECT value_json FROM bot_settings WHERE key = ?',
        `dl_token_${cleanToken}`
      );
      if (row?.value_json) {
        const parsed = JSON.parse(row.value_json);
        if (parsed?.url) {
          pendingDownloads.set(cleanToken, parsed);
          return parsed.url;
        }
      }
    } catch {}
  }

  // 3. Base64url fallback if token is an encoded URL
  if (cleanToken.length > 8) {
    try {
      const decoded = Buffer.from(cleanToken, 'base64url').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {}
  }

  return null;
}

/**
 * Checks if an error is a Telegram permission restriction error.
 */
export function isPermissionError(err) {
  if (!err) return false;
  const msg = String(err?.description ?? err?.message ?? '');
  return /not enough rights|CHAT_SEND_MEDIA_FORBIDDEN|CHAT_SEND_PHOTOS_FORBIDDEN|CHAT_SEND_VIDEOS_FORBIDDEN|CHAT_SEND_DOCUMENTS_FORBIDDEN|CHAT_ADMIN_REQUIRED|can't send media in this chat|have no rights to send a message|not allowed to send|forbidden in this chat/i.test(msg);
}

/**
 * Manually update/record chat restrictions when an error is caught.
 */
export function recordChatPermissionRestriction(chatId, restrictions = {}) {
  if (!chatId) return;
  const numId = Number(chatId);
  if (numId > 0) return; // Private chat has full rights

  const existing = permissionsCache.get(numId)?.caps || {
    isGroup: true,
    isAdmin: false,
    canSendMessages: true,
    canSendMedia: false,
    canSendPhotos: false,
    canSendVideos: false,
    canSendAudios: false,
    canSendDocuments: false,
    canSendVoice: false
  };

  const updated = {
    ...existing,
    ...restrictions,
    isGroup: true,
    isAdmin: false
  };

  permissionsCache.set(numId, {
    caps: updated,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

/**
 * Invalidate cached permissions for a chat.
 */
export function invalidateChatPermissions(chatId) {
  if (chatId) permissionsCache.delete(Number(chatId));
}

/**
 * Query and cache Telegram chat media capabilities for the bot.
 *
 * @param {object} api TelegramAPI instance
 * @param {number|string} chatId Target chat ID
 * @returns {Promise<{
 *   isGroup: boolean,
 *   isAdmin: boolean,
 *   canSendMessages: boolean,
 *   canSendMedia: boolean,
 *   canSendPhotos: boolean,
 *   canSendVideos: boolean,
 *   canSendAudios: boolean,
 *   canSendDocuments: boolean,
 *   canSendVoice: boolean
 * }>}
 */
export async function checkChatMediaPermissions(api, chatId) {
  const numId = Number(chatId);

  // Private chats (chatId > 0) always have full media capabilities
  if (numId > 0) {
    return {
      isGroup: false,
      isAdmin: false,
      canSendMessages: true,
      canSendMedia: true,
      canSendPhotos: true,
      canSendVideos: true,
      canSendAudios: true,
      canSendDocuments: true,
      canSendVoice: true
    };
  }

  // Check in-memory cache
  const cached = permissionsCache.get(numId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.caps;
  }

  if (!api) {
    return {
      isGroup: true,
      isAdmin: false,
      canSendMessages: true,
      canSendMedia: true,
      canSendPhotos: true,
      canSendVideos: true,
      canSendAudios: true,
      canSendDocuments: true,
      canSendVoice: true
    };
  }

  try {
    let botId = api.me?.id;
    if (!botId) {
      const me = await api.getMe?.().catch(() => null);
      botId = me?.id;
    }

    const [chat, member] = await Promise.all([
      api.getChat(chatId).catch(() => null),
      botId ? (api.getChatMember ? api.getChatMember(chatId, botId) : api.call('getChatMember', { chat_id: chatId, user_id: botId })).catch(() => null) : null
    ]);

    const status = member?.status;
    const isAdmin = status === 'administrator' || status === 'creator';

    if (isAdmin) {
      const caps = {
        isGroup: true,
        isAdmin: true,
        canSendMessages: true,
        canSendMedia: true,
        canSendPhotos: true,
        canSendVideos: true,
        canSendAudios: true,
        canSendDocuments: true,
        canSendVoice: true
      };
      permissionsCache.set(numId, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
      return caps;
    }

    if (status === 'kicked' || status === 'left') {
      const caps = {
        isGroup: true,
        isAdmin: false,
        canSendMessages: false,
        canSendMedia: false,
        canSendPhotos: false,
        canSendVideos: false,
        canSendAudios: false,
        canSendDocuments: false,
        canSendVoice: false
      };
      permissionsCache.set(numId, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
      return caps;
    }

    const p = status === 'restricted' ? member : (chat?.permissions || {});
    const overallMedia = p.can_send_media_messages !== false;

    const caps = {
      isGroup: true,
      isAdmin: false,
      canSendMessages: p.can_send_messages !== false,
      canSendMedia: overallMedia,
      canSendPhotos: overallMedia && p.can_send_photos !== false,
      canSendVideos: overallMedia && p.can_send_videos !== false,
      canSendAudios: overallMedia && p.can_send_audios !== false,
      canSendDocuments: overallMedia && p.can_send_documents !== false,
      canSendVoice: overallMedia && p.can_send_voice_notes !== false
    };

    permissionsCache.set(numId, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
    return caps;
  } catch (err) {
    log.debug({ err: err?.message, chatId }, 'failed to inspect chat permissions, defaulting to permissive');
    return {
      isGroup: true,
      isAdmin: false,
      canSendMessages: true,
      canSendMedia: true,
      canSendPhotos: true,
      canSendVideos: true,
      canSendAudios: true,
      canSendDocuments: true,
      canSendVoice: true
    };
  }
}

/**
 * Format a clean, helpful message for group chats when media is restricted by admins.
 */
export function formatMediaRestrictedNotice({
  botUsername = 'Lancy_easy_bot',
  url = null,
  mediaType = 'photos or videos',
  actionTitle = 'Get in Private DM'
} = {}) {
  const dlToken = url ? registerPendingDownload(url) : null;
  const dmLink = dlToken
    ? `https://t.me/${botUsername}?start=grab_${dlToken}`
    : `https://t.me/${botUsername}?start=dl`;

  const text =
    `<blockquote>𓆩♡𓆪 <b>MEDIA RESTRICTED IN GROUP</b> 𓆩♡𓆪\n\n` +
    `⚠️ <b>Admin Restriction:</b> This group chat currently restricts non-admin bots from sending ${mediaType} ♡\n\n` +
    `✨ <b>Get Your Media Instantly:</b>\n` +
    `Tap <b>${actionTitle}</b> below to receive the crystal-clear HD media directly in private DM with me!\n\n` +
    `<i>Tip: Promote @${botUsername} to admin or enable media in group settings to download directly here ♡</i></blockquote>`;

  const inlineKeyboard = [
    [
      { text: `📥 ${actionTitle} (Instant)`, url: dmLink },
      { text: '✦ Open Bot', url: `https://t.me/${botUsername}` }
    ]
  ];

  return { text, reply_markup: { inline_keyboard: inlineKeyboard } };
}
