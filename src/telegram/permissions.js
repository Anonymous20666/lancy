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
 * True if the user is a Platform / Main Bot Owner (`general.ownerIds` or controller.isMainOwner).
 * Distinguishes platform-wide owner from per-clone owners.
 */
export function isPlatformOwner(settingsOrApp, tgId, { controller = null } = {}) {
  const uid = Number(tgId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  if (typeof controller?.isMainOwner === 'function' && controller.isMainOwner(uid)) return true;
  if (typeof controller?.isOwner === 'function' && !controller?.botContext?.isClone && controller.isOwner(uid)) {
    return true;
  }
  return getBotOwnerIds(settingsOrApp).has(uid);
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

function isDefinitiveNegativeChatError(err) {
  const msg = String(err?.description || err?.message || '').toLowerCase();
  const code = Number(err?.error_code ?? err?.status ?? 0);
  if (code === 400 || code === 403 || code === 404) {
    return /chat not found|bot was kicked|not a member|forbidden|have no rights|channel_private|kicked|deactivated|chat_id is empty/.test(msg);
  }
  return false;
}

function isLedgerEntryFresh(entry, maxAgeMs = 120_000) {
  if (!entry?.verified_at) return false;
  const raw = String(entry.verified_at).trim();
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return false;
  return (Date.now() - parsed) <= maxAgeMs;
}

/**
 * Verify that the ACTIVE bot (main or clone) can post in a Telegram channel, group, or supergroup.
 * - Channels (`chat.type === 'channel'`): bot must be creator or administrator with `can_post_messages !== false`.
 * - Groups / Supergroups (`chat.type === 'group' | 'supergroup'`, when `allowGroups` is true):
 *   bot must be present (not `left` / `kicked`) and able to send messages.
 */
export async function verifyBotCanPostInTarget(api, chatOrInput, { allowGroups = true, catchErrors = false } = {}) {
  if (!api?.getChat || !api?.getMe || !api?.getChatMember) {
    return { ok: false, reason: 'missing_api', canPost: false, definitive: false };
  }
  let me = api.me;
  try {
    if (!me?.id) {
      me = await api.getMe();
      if (me?.id && !api.me) api.me = me;
    }
  } catch (err) {
    if (!catchErrors) throw err;
    return { ok: false, reason: 'bot_identity_unavailable', canPost: false, definitive: false };
  }
  if (!me?.id) {
    return { ok: false, reason: 'bot_identity_unavailable', canPost: false, definitive: false };
  }

  let chat = null;
  try {
    chat = (chatOrInput && typeof chatOrInput === 'object' && chatOrInput.id)
      ? chatOrInput
      : await api.getChat(chatOrInput);
  } catch (err) {
    if (!catchErrors) throw err;
    return {
      ok: false,
      reason: 'chat_not_found',
      botId: String(me.id),
      botUsername: me.username || null,
      isAdmin: false,
      canPost: false,
      definitive: isDefinitiveNegativeChatError(err)
    };
  }

  if (!chat?.id) {
    return { ok: false, reason: 'chat_not_found', canPost: false, definitive: true };
  }
  const chatType = chat.type;
  const isChannel = chatType === 'channel';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isChannel && !(allowGroups && isGroup)) {
    return {
      ok: false,
      reason: 'not_a_channel',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      chatType,
      isAdmin: false,
      canPost: false,
      definitive: true
    };
  }

  let member = null;
  try {
    member = await api.getChatMember(chat.id, me.id);
  } catch (err) {
    if (!catchErrors) throw err;
    return {
      ok: false,
      reason: isChannel ? 'bot_not_admin' : 'bot_not_in_chat',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      chatType,
      isAdmin: false,
      canPost: false,
      definitive: isDefinitiveNegativeChatError(err)
    };
  }

  const status = member?.status;
  const isCreator = status === 'creator';
  const isAdmin = status === 'administrator';

  if (isChannel) {
    if (!isCreator && !isAdmin) {
      return {
        ok: false,
        reason: 'bot_not_admin',
        botId: String(me.id),
        botUsername: me.username || null,
        chat,
        chatType,
        isAdmin: false,
        canPost: false,
        definitive: true
      };
    }
    const canPost = Boolean(isCreator || (isAdmin && member?.can_post_messages !== false));
    if (!canPost) {
      return {
        ok: false,
        reason: 'missing_post_permission',
        botId: String(me.id),
        botUsername: me.username || null,
        chat,
        chatType,
        isAdmin: true,
        canPost: false,
        definitive: true
      };
    }
    return {
      ok: true,
      reason: 'ok',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      chatType,
      isAdmin: true,
      canPost: true,
      definitive: true
    };
  }

  // Group / supergroup rules
  if (status === 'left' || status === 'kicked' || !status) {
    return {
      ok: false,
      reason: 'bot_not_in_chat',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      chatType,
      isAdmin: false,
      canPost: false,
      definitive: true
    };
  }
  const restrictedCannotSend = status === 'restricted' && member?.can_send_messages === false;
  const memberCannotSend = status === 'member' && chat?.permissions?.can_send_messages === false;
  if (restrictedCannotSend || memberCannotSend) {
    return {
      ok: false,
      reason: 'missing_send_permission',
      botId: String(me.id),
      botUsername: me.username || null,
      chat,
      chatType,
      isAdmin: false,
      canPost: false,
      definitive: true
    };
  }
  return {
    ok: true,
    reason: 'ok',
    botId: String(me.id),
    botUsername: me.username || null,
    chat,
    chatType,
    isAdmin: isCreator || isAdmin,
    canPost: true,
    definitive: true
  };
}

/**
 * Verify that the ACTIVE bot (main or clone) is an administrator/creator of a Telegram channel
 * AND has permission to post messages (`can_post_messages !== false`).
 * Also rejects non-channel chats (`chat.type !== 'channel'`).
 */
export async function verifyBotCanPostInChannel(api, chatOrInput) {
  return verifyBotCanPostInTarget(api, chatOrInput, { allowGroups: false, catchErrors: false });
}

/**
 * Return all known Telegram channels (and optionally groups/supergroups when `includeGroups: true`)
 * where BOTH `userId` is authorized (creator/admin or Bot Super Admin) AND the active bot
 * can actually post (`requireBotCanPost: true`, verified via cached ledger or live Telegram API).
 */
export async function listVerifiedAdminChannels({
  db = null,
  api = null,
  settings = null,
  controller = null,
  userId = null,
  isSuperAdmin = null,
  botId = null,
  includeGroups = false,
  requireBotCanPost = true,
  forceRefresh = false,
  probeKnownGroups = false,
  maxCacheAgeMs = 120_000
} = {}) {
  const uid = Number(userId);
  const superAdmin = isSuperAdmin != null
    ? Boolean(isSuperAdmin)
    : isBotSuperAdmin(settings, uid, { controller });

  let resolvedBotId = botId ? String(botId) : (api?.me?.id ? String(api.me.id) : null);
  if (!resolvedBotId && api?.getMe) {
    const me = await api.getMe().catch(() => null);
    if (me?.id) {
      resolvedBotId = String(me.id);
      if (!api.me) api.me = me;
    }
  }

  // Optionally probe existing known negative group chat IDs (from chat_settings / group_members)
  // so group chats already using the bot appear seamlessly alongside channels.
  if (includeGroups && probeKnownGroups && superAdmin && db?.getKnownGroupChatIds && api?.getChat && api?.getChatMember && resolvedBotId) {
    const existingIds = new Set(
      (db.getTelegramChannels?.(null, { includeGroups: true }) || []).map((r) => Number(r.channel_id))
    );
    const knownGroupIds = db.getKnownGroupChatIds().filter((cid) => !existingIds.has(Number(cid)));
    const batch = knownGroupIds.slice(0, 25);
    await Promise.all(
      batch.map(async (gid) => {
        const res = await verifyBotCanPostInTarget(api, gid, { allowGroups: true, catchErrors: true }).catch(() => null);
        if (res?.ok && res.chat) {
          db.recordTelegramChannel?.({
            channel_id: res.chat.id,
            title: res.chat.title || 'Telegram Group',
            username: res.chat.username || null,
            chat_type: res.chat.type || 'group',
            can_post: 1,
            added_by: uid > 0 ? uid : null
          });
          db.recordBotChannelVerification?.({
            bot_id: res.botId || resolvedBotId,
            channel_id: res.chat.id,
            bot_username: res.botUsername || api?.me?.username || null,
            is_admin: res.isAdmin ? 1 : 0,
            can_post: 1
          });
        }
      })
    );
  }

  const allChannels = db?.getTelegramChannels?.(null, { includeGroups }) || [];
  if (!allChannels.length) return [];

  const botLedger = new Map(
    (resolvedBotId && db?.getBotChannelVerifications ? db.getBotChannelVerifications(resolvedBotId) : [])
      .map((row) => [Number(row.channel_id), row])
  );

  const attachBotStatus = (ch, overrideEntry = null) => {
    const entry = overrideEntry || botLedger.get(Number(ch.channel_id));
    if (!entry) {
      return {
        ...ch,
        chat_type: ch.chat_type || 'channel',
        botVerified: resolvedBotId ? null : undefined,
        botCanPost: ch.can_post !== 0
      };
    }
    return {
      ...ch,
      chat_type: ch.chat_type || 'channel',
      botVerified: Boolean(entry.can_post),
      botCanPost: Boolean(entry.can_post),
      botIsAdmin: Boolean(entry.is_admin),
      botUsername: entry.bot_username || api?.me?.username || null
    };
  };

  const canVerifyBotLive = Boolean(api?.getChat && api?.getChatMember && resolvedBotId);
  const adminIds = getBotAdminIds(settings);
  const isOwnerFn = controller ? (id) => controller.isOwner(id) : null;

  const verifyTargetForBot = async (ch) => {
    let entry = botLedger.get(Number(ch.channel_id)) || null;
    const ledgerFresh = entry && isLedgerEntryFresh(entry, maxCacheAgeMs);

    if (requireBotCanPost) {
      // Offline negative cache still excludes known-unpostable targets unless forcing refresh
      if (!forceRefresh && entry && Number(entry.can_post) === 0) {
        return null;
      }
      if (!forceRefresh && Number(ch.can_post) === 0 && !entry) {
        return null;
      }
      if (canVerifyBotLive && (forceRefresh || !ledgerFresh || Number(ch.can_post) === 0)) {
        const check = await verifyBotCanPostInTarget(api, ch.channel_id, {
          allowGroups: includeGroups,
          catchErrors: true
        }).catch(() => ({ ok: false, definitive: false }));

        if (check?.definitive) {
          const nextEntry = {
            bot_id: check.botId || resolvedBotId,
            channel_id: ch.channel_id,
            bot_username: check.botUsername || api?.me?.username || null,
            is_admin: check.isAdmin ? 1 : 0,
            can_post: check.canPost ? 1 : 0,
            verified_at: new Date().toISOString()
          };
          botLedger.set(Number(ch.channel_id), nextEntry);
          db?.recordBotChannelVerification?.(nextEntry);
          if (check.chat) {
            db?.recordTelegramChannel?.({
              channel_id: check.chat.id,
              title: check.chat.title || ch.title,
              username: check.chat.username || ch.username || null,
              chat_type: check.chat.type || ch.chat_type || 'channel',
              can_post: check.canPost ? 1 : 0,
              added_by: ch.added_by || null
            });
            ch = {
              ...ch,
              title: check.chat.title || ch.title,
              username: check.chat.username ?? ch.username,
              chat_type: check.chat.type || ch.chat_type || 'channel'
            };
          } else if (!check.canPost) {
            db?.markBotChannelUnavailable?.(resolvedBotId, ch.channel_id, { bot_username: api?.me?.username || null });
          }
          entry = nextEntry;
          if (!check.ok) return null;
        } else if (entry && Number(entry.can_post) === 0) {
          return null;
        }
      }
    }

    return attachBotStatus(ch, entry);
  };

  if (superAdmin) {
    const checked = await Promise.all(allChannels.map((ch) => verifyTargetForBot(ch)));
    return checked.filter(Boolean);
  }

  if (!Number.isSafeInteger(uid) || uid <= 0) return [];
  if (!api?.getChatMember) {
    const fallback = (db?.getTelegramChannels?.(uid, { includeGroups }) || [])
      .filter((ch) => !requireBotCanPost || Number(ch.can_post) !== 0);
    return fallback.map((ch) => attachBotStatus(ch));
  }

  const checks = await Promise.all(
    allChannels.map(async (ch) => {
      const userOk = await verifyChannelAdmin({
        chatId: ch.channel_id,
        fromUser: { id: uid },
        api,
        isOwner: isOwnerFn,
        adminIds
      });
      if (!userOk) return null;
      return verifyTargetForBot(ch);
    })
  );
  return checks.filter(Boolean);
}

/**
 * Discover and live-verify ALL Channels + Groups across the Main Bot and Cloned Bots
 * accessible to `userId`.
 * - Platform / Main Owner sees ALL clones + ALL verified channels & GCs across main & every clone.
 * - Clone owners only see their own clone(s) and targets accessible via their clone(s).
 */
export async function listCrossBotVerifiedTargets({
  db = null,
  settings = null,
  controller = null,
  multiBotManager = null,
  mainApi = null,
  userId = null,
  includeGroups = true,
  forceRefresh = false,
  probeKnownGroups = true
} = {}) {
  const uid = Number(userId);
  const platformOwner = isPlatformOwner(settings, uid, { controller });
  const superAdmin = isBotSuperAdmin(settings, uid, { controller });

  const botEntries = [];
  const mainBotId = mainApi?.me?.id ? String(mainApi.me.id) : (await mainApi?.getMe?.().catch(() => null))?.id;
  if (mainApi && mainBotId) {
    botEntries.push({
      botId: String(mainBotId),
      botUsername: mainApi.me?.username || mainApi.botUsername || 'MainBot',
      botName: settings?.get?.('branding.botName') || 'Lancy',
      isMain: true,
      ownerTgId: null,
      api: mainApi,
      status: 'active'
    });
  }

  const cloneRecords = platformOwner
    ? (multiBotManager?.getAllBots?.() || [])
    : (multiBotManager?.getBotsForOwner?.(uid) || []);

  for (const rec of cloneRecords) {
    const running = multiBotManager?.runningBots?.get?.(rec.id);
    const cloneApi = running?.api || null;
    let cloneTgId = cloneApi?.me?.id ? String(cloneApi.me.id) : null;
    if (!cloneTgId && cloneApi?.getMe) {
      const me = await cloneApi.getMe().catch(() => null);
      if (me?.id) {
        cloneTgId = String(me.id);
        if (!cloneApi.me) cloneApi.me = me;
      }
    }
    const resolvedId = cloneTgId || `clone_${rec.id}`;
    botEntries.push({
      botId: resolvedId,
      cloneRowId: rec.id,
      botUsername: rec.bot_username || cloneApi?.me?.username || `clone_${rec.id}`,
      botName: rec.bot_name || rec.bot_username || 'Clone Bot',
      isMain: false,
      ownerTgId: Number(rec.owner_tg_id),
      api: cloneApi,
      controller: running?.controller || null,
      status: rec.status || 'inactive'
    });
  }

  const mergedTargets = new Map();
  await Promise.all(
    botEntries.map(async (bot) => {
      if (!bot.api) return;
      const canUseAllOnBot = platformOwner || (bot.isMain && superAdmin) || (!bot.isMain && Number(bot.ownerTgId) === uid);
      const verified = await listVerifiedAdminChannels({
        db,
        api: bot.api,
        settings,
        controller: bot.controller || controller,
        userId: uid,
        isSuperAdmin: canUseAllOnBot,
        botId: bot.botId,
        includeGroups,
        requireBotCanPost: true,
        forceRefresh,
        probeKnownGroups
      });

      for (const target of verified) {
        const cid = Number(target.channel_id);
        let agg = mergedTargets.get(cid);
        if (!agg) {
          agg = {
            ...target,
            chat_type: target.chat_type || 'channel',
            verifiedBots: []
          };
          mergedTargets.set(cid, agg);
        } else {
          if (target.title && target.title !== 'Untitled Channel') agg.title = target.title;
          if (target.username) agg.username = target.username;
          if (target.chat_type && target.chat_type !== 'channel') agg.chat_type = target.chat_type;
        }
        if (!agg.verifiedBots.some((b) => String(b.botId) === String(bot.botId))) {
          agg.verifiedBots.push({
            botId: bot.botId,
            cloneRowId: bot.cloneRowId ?? null,
            botUsername: bot.botUsername,
            botName: bot.botName,
            isMain: bot.isMain,
            ownerTgId: bot.ownerTgId ?? null,
            api: bot.api
          });
        }
      }
    })
  );

  // Also include clone-ledger entries in case a paused clone previously verified a channel/GC
  // that no active bot currently sees (skipping paused bots so UI shows only currently sendable targets).
  const targets = [...mergedTargets.values()].sort((a, b) => {
    const typeScore = (t) => (t === 'channel' ? 0 : 1);
    const diff = typeScore(a.chat_type) - typeScore(b.chat_type);
    if (diff !== 0) return diff;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  return { bots: botEntries, targets };
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
