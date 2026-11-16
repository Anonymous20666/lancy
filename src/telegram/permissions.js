import { logger } from '../core/logger.js';

const log = logger().child({ module: 'telegram-permissions' });

// In-memory cache for chat media permissions (`${botKey}:${chatId}` -> { caps, expiresAt })
const permissionsCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const apiCacheIds = new WeakMap();
let nextApiCacheId = 1;

function permissionBotKey(api) {
  if (api?.me?.id) return String(api.me.id);
  const tokenId = typeof api?.token === 'string' ? api.token.split(':')[0] : '';
  if (/^\d+$/.test(tokenId)) return tokenId;
  if (api && typeof api === 'object') {
    let id = apiCacheIds.get(api);
    if (!id) {
      id = `api_${nextApiCacheId++}`;
      apiCacheIds.set(api, id);
    }
    return id;
  }
  return 'default';
}

function permissionCacheKey(api, chatId) {
  return `${permissionBotKey(api)}:${Number(chatId)}`;
}

// Scoped per-API-instance cache for verified channel admins (45s allow cache; fail-closed on errors)
const channelAdminCache = new WeakMap();
const CHANNEL_ADMIN_CACHE_TTL_MS = 45 * 1000;
const SYSTEM_PSEUDO_SENDER_IDS = new Set([136817688, 1087968824, 777000]);

/**
 * Normalize an array or comma-separated string of Telegram user IDs into positive safe integers.
 */
export function parseIdList(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

function resolveSettingsObj(settingsOrApp) {
  if (!settingsOrApp) return null;
  if (typeof settingsOrApp.get === 'function') return settingsOrApp;
  if (typeof settingsOrApp.settings?.get === 'function') return settingsOrApp.settings;
  return null;
}

/**
 * Return the set of configured Bot Owner IDs (OWNER_IDS + general.ownerIds).
 */
export function getBotOwnerIds(settingsOrApp = null) {
  const settings = resolveSettingsObj(settingsOrApp);
  return new Set([
    ...parseIdList(process.env.OWNER_IDS),
    ...parseIdList(settings?.get?.('general.ownerIds'))
  ]);
}

/**
 * Return the set of configured Bot Super Admin IDs (telegram.adminIds, falling back to ADMIN_IDS env).
 */
export function getBotAdminIds(settingsOrApp = null) {
  const settings = resolveSettingsObj(settingsOrApp);
  const fromSettings = settings?.get?.('telegram.adminIds');
  if (Array.isArray(fromSettings)) {
    return new Set(parseIdList(fromSettings));
  }
  return new Set(parseIdList(process.env.ADMIN_IDS));
}

/**
 * Return all Bot Super Admin IDs (Bot Owners + Bot Team Admins).
 */
export function getBotSuperAdminIds(settingsOrApp = null) {
  return new Set([
    ...getBotOwnerIds(settingsOrApp),
    ...getBotAdminIds(settingsOrApp)
  ]);
}

/**
 * True if the user is a Bot Owner (including clone owner if controller provided) or Team Super Admin.
 */
export function isBotSuperAdmin(settingsOrApp, tgId, { controller = null } = {}) {
  const uid = Number(tgId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  if (typeof controller?.isOwner === 'function' && controller.isOwner(uid)) return true;
  if (typeof controller?.isMainOwner === 'function' && controller.isMainOwner(uid)) return true;
  return getBotSuperAdminIds(settingsOrApp).has(uid);
}

/**
 * True if a group chat member record represents a group creator or full-privilege Super Admin.
 * Plain moderators (status === 'administrator' without can_promote_members) return false.
 */
export function isGroupSuperAdminMember(member) {
  if (!member) return false;
  if (member.status === 'creator') return true;
  return member.status === 'administrator' && member.can_promote_members === true;
}

/**
 * True if an incoming group/supergroup message was posted by an Anonymous Group Admin (@GroupAnonymousBot).
 */
export function isAnonymousGroupAdmin(source, chatId) {
  if (!source || source.data !== undefined) return false;
  const msg = source.message || source;
  const type = msg?.chat?.type;
  if (type !== 'group' && type !== 'supergroup') return false;
  if (Number(msg?.from?.id) !== 1087968824) return false;
  return Number(msg?.sender_chat?.id) === Number(chatId);
}

/**
 * Invalidate cached positive channel admin lookups when roles change or bot/member updates arrive.
 */
export function invalidateChannelAdminCache(api, chatId = null, userId = null) {
  const perApi = api ? channelAdminCache.get(api) : null;
  if (!perApi) return;
  if (chatId == null) {
    perApi.clear();
    return;
  }
  const prefix = `${Number(chatId)}:`;
  if (userId != null) {
    perApi.delete(`${prefix}${Number(userId)}`);
    return;
  }
  for (const k of perApi.keys()) {
    if (k.startsWith(prefix)) perApi.delete(k);
  }
}

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
export function recordChatPermissionRestriction(chatId, restrictions = {}, api = null) {
  if (!chatId) return;
  const numId = Number(chatId);
  if (numId > 0) return; // Private chat has full rights

  const key = permissionCacheKey(api, numId);
  const existing = permissionsCache.get(key)?.caps || {
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

  permissionsCache.set(key, {
    caps: updated,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  if (!api) {
    const suffix = `:${numId}`;
    for (const [entryKey, entryVal] of permissionsCache.entries()) {
      if (!entryKey.endsWith(suffix) || entryKey === key) continue;
      permissionsCache.set(entryKey, {
        caps: { ...(entryVal?.caps || existing), ...restrictions, isGroup: true, isAdmin: false },
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }
  }
}

/**
 * Invalidate cached permissions for a chat.
 */
export function invalidateChatPermissions(chatId, api = null) {
  if (!chatId) return;
  const numId = Number(chatId);
  if (api) {
    permissionsCache.delete(permissionCacheKey(api, numId));
    return;
  }
  const suffix = `:${numId}`;
  for (const key of Array.from(permissionsCache.keys())) {
    if (key.endsWith(suffix)) permissionsCache.delete(key);
  }
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

  // Check in-memory cache scoped by bot identity + chat
  const cacheKey = permissionCacheKey(api, numId);
  const cached = permissionsCache.get(cacheKey);
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
      permissionsCache.set(cacheKey, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
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
      permissionsCache.set(cacheKey, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
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

    permissionsCache.set(cacheKey, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
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

/**
 * Determine whether an update represents a genuine anonymous Telegram channel post
 * authored by a channel admin (Telegram omits `from` and sets `sender_chat.id === chat.id`,
 * or omits `sender_chat` on raw `channel_post` updates).
 */
export function isNativeChannelPost(source, { isChannelPost = false } = {}) {
  if (!source || source.data !== undefined) return false; // Never for callback_query
  const msg = source.message || source;
  const chat = msg?.chat;
  if (chat?.type !== 'channel') return false;
  if (msg.from) return false;
  if (msg.is_automatic_forward) return false;
  const rawChannelUpdate = Boolean(isChannelPost || source.channel_post || source.edited_channel_post);
  if (!rawChannelUpdate && msg.sender_chat?.id == null) {
    return false;
  }
  if (rawChannelUpdate && msg.sender_chat?.id == null) {
    return true;
  }
  return Number(msg.sender_chat?.id) === Number(chat.id);
}

/**
 * Strictly verify whether the actor in a Telegram channel event is a verified administrator/creator.
 * Fail-closed on lookup failures, pseudo-bot sender IDs (@Channel_Bot / @GroupAnonymousBot), and non-admins.
 */
export async function verifyChannelAdmin({
  chatId,
  source = null,
  fromUser = null,
  api = null,
  isOwner = null,
  adminIds = null,
  isChannelPost = false
} = {}) {
  const numChatId = Number(chatId);
  if (!Number.isFinite(numChatId)) return false;

  const isCallback = Boolean(source && (source.data !== undefined || (source.id && source.from && !source.chat)));
  if (!isCallback && isNativeChannelPost(source, { isChannelPost })) {
    return true;
  }

  const msg = isCallback ? null : (source?.message || source);
  const actor = fromUser || source?.from || msg?.from || null;
  const uid = Number(actor?.id);
  if (!Number.isFinite(uid) || uid <= 0) return false;
  if (SYSTEM_PSEUDO_SENDER_IDS.has(uid) || actor?.is_bot) return false;

  if (typeof isOwner === 'function' && isOwner(uid)) return true;
  if (adminIds && typeof adminIds.has === 'function' && adminIds.has(uid)) return true;

  if (!api?.getChatMember) return false;

  let perApi = channelAdminCache.get(api);
  if (!perApi) {
    perApi = new Map();
    channelAdminCache.set(api, perApi);
  }
  const cacheKey = `${numChatId}:${uid}`;
  const cached = perApi.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.ok;
  }

  try {
    const member = await api.getChatMember(numChatId, uid);
    const ok = Boolean(member && (member.status === 'creator' || member.status === 'administrator'));
    if (ok) {
      perApi.set(cacheKey, {
        ok: true,
        expiresAt: Date.now() + CHANNEL_ADMIN_CACHE_TTL_MS
      });
    } else {
      // Never cache negative status so newly promoted channel admins gain access immediately.
      perApi.delete(cacheKey);
    }
    return ok;
  } catch (err) {
    log.debug({ err: err?.message, chatId: numChatId, uid }, 'channel admin check failed (fail-closed)');
    return false;
  }
}

/**
 * Verify that the ACTIVE bot (main or clone) is an administrator/creator of a Telegram channel
 * AND has permission to post messages (`can_post_messages !== false`).
 * Also rejects non-channel chats (`chat.type !== 'channel'`).
 */
export async function verifyBotCanPostInChannel(api, chatOrInput) {
  if (!api?.getChat || !api?.getMe || !api?.getChatMember) {
    return { ok: false, reason: 'missing_api', canPost: false };
  }
  const chat = (chatOrInput && typeof chatOrInput === 'object' && chatOrInput.id)
    ? chatOrInput
    : await api.getChat(chatOrInput);
  if (!chat?.id) {
    return { ok: false, reason: 'chat_not_found', canPost: false };
  }
  if (chat.type !== 'channel') {
    return { ok: false, reason: 'not_a_channel', chat, canPost: false };
  }
  const me = api.me || await api.getMe();
  if (!me?.id) {
    return { ok: false, reason: 'bot_identity_unavailable', chat, canPost: false };
  }
  const member = await api.getChatMember(chat.id, me.id);
  const isCreator = member?.status === 'creator';
  const isAdmin = member?.status === 'administrator';
  const canPost = Boolean(isCreator || (isAdmin && member?.can_post_messages !== false));
  if (!isCreator && !isAdmin) {
    return {
      ok: false,
      reason: 'bot_not_admin',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      isAdmin: false,
      canPost: false
    };
  }
  if (!canPost) {
    return {
      ok: false,
      reason: 'missing_post_permission',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      isAdmin: true,
      canPost: false
    };
  }
  return {
    ok: true,
    reason: 'ok',
    botId: String(me.id),
    botUsername: me.username || null,
    chat,
    isAdmin: true,
    canPost: true
  };
}

/**
 * Return all known Telegram channels in `tg_channels` that `userId` is currently verified
 * to administer (any creator/administrator or Bot Super Admin), regardless of who originally added the bot.
 * Optionally attaches live/stored per-bot `botVerified` status when `db` + `api` are provided.
 */
export async function listVerifiedAdminChannels({
  db = null,
  api = null,
  settings = null,
  controller = null,
  userId = null,
  isSuperAdmin = null,
  botId = null
} = {}) {
  const allChannels = db?.getTelegramChannels?.() || [];
  if (!allChannels.length) return [];

  let resolvedBotId = botId ? String(botId) : (api?.me?.id ? String(api.me.id) : null);
  if (!resolvedBotId && api?.getMe) {
    const me = await api.getMe().catch(() => null);
    if (me?.id) {
      resolvedBotId = String(me.id);
      if (!api.me) api.me = me;
    }
  }
  const botLedger = new Map(
    (resolvedBotId && db?.getBotChannelVerifications ? db.getBotChannelVerifications(resolvedBotId) : [])
      .map((row) => [Number(row.channel_id), row])
  );
  const attachBotStatus = (ch) => {
    const entry = botLedger.get(Number(ch.channel_id));
    if (!entry) return { ...ch, botVerified: resolvedBotId ? null : undefined };
    return {
      ...ch,
      botVerified: Boolean(entry.is_admin && entry.can_post),
      botCanPost: Boolean(entry.can_post),
      botUsername: entry.bot_username || api?.me?.username || null
    };
  };

  const uid = Number(userId);
  const superAdmin = isSuperAdmin != null
    ? Boolean(isSuperAdmin)
    : isBotSuperAdmin(settings, uid, { controller });
  if (superAdmin) return allChannels.map(attachBotStatus);

  if (!Number.isSafeInteger(uid) || uid <= 0) return [];
  if (!api?.getChatMember) {
    // Offline fallback only when no Telegram API client exists
    return (db?.getTelegramChannels?.(uid) || []).map(attachBotStatus);
  }

  const adminIds = getBotAdminIds(settings);
  const isOwnerFn = controller ? (id) => controller.isOwner(id) : null;
  const checks = await Promise.all(
    allChannels.map(async (ch) => {
      const ok = await verifyChannelAdmin({
        chatId: ch.channel_id,
        fromUser: { id: uid },
        api,
        isOwner: isOwnerFn,
        adminIds
      });
      return ok ? attachBotStatus(ch) : null;
    })
  );
  return checks.filter(Boolean);
}

/**
 * Verify whether `userId` may select/toggle `channelId` inside channel-management menus.
 * Mirrors `listVerifiedAdminChannels` offline fallback when `api.getChatMember` is unavailable.
 */
export async function canAccessChannelInMenu({
  db = null,
  api = null,
  settings = null,
  controller = null,
  userId = null,
  channelId = null,
  fromUser = null
} = {}) {
  const uid = Number(userId);
  const cid = Number(channelId);
  if (!Number.isSafeInteger(cid)) return false;
  if (isBotSuperAdmin(settings, uid, { controller })) return true;
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  if (!api?.getChatMember) {
    const fallback = db?.getTelegramChannels?.(uid) || [];
    return fallback.some((ch) => Number(ch.channel_id) === cid);
  }
  const adminIds = getBotAdminIds(settings);
  const isOwnerFn = controller ? (id) => controller.isOwner(id) : null;
  return await verifyChannelAdmin({
    chatId: cid,
    fromUser: fromUser || { id: uid },
    api,
    isOwner: isOwnerFn,
    adminIds
  });
}
