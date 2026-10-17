import { RichMessageBuilder, rt, richButton } from './rich.js';
import { banner, kvTable, WINGS } from './ui.js';

const GLOBAL_FJ_KEY = 'force_join.global_channels';
const CLONE_FJ_PREFIX = 'force_join.clone_';

// Shared in-memory cache across main bot + all cloned bots in the same process:
// key: `${botId}:${userId}` -> timestamp (ms) until which verification is valid
const verifiedUsersCache = new Map();
const VERIFIED_TTL_MS = 90 * 1000;

export function invalidateForceJoinCache(userId = null) {
  if (!userId) {
    verifiedUsersCache.clear();
    return;
  }
  const suffix = `:${Number(userId)}`;
  for (const key of verifiedUsersCache.keys()) {
    if (key.endsWith(suffix)) {
      verifiedUsersCache.delete(key);
    }
  }
}

export function getGlobalForceJoinChannels(db) {
  if (!db) return [];
  try {
    const row = db.get('SELECT value_json FROM bot_settings WHERE key = ?', GLOBAL_FJ_KEY);
    if (!row?.value_json) return [];
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setGlobalForceJoinChannels(db, channels = []) {
  if (!db) return;
  db.run(
    `INSERT INTO bot_settings (key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
    GLOBAL_FJ_KEY,
    JSON.stringify(channels)
  );
  invalidateForceJoinCache();
}

export function getCloneForceJoinChannels(db, botId) {
  if (!db || !botId) return [];
  try {
    const row = db.get('SELECT value_json FROM bot_settings WHERE key = ?', `${CLONE_FJ_PREFIX}${Number(botId)}`);
    if (!row?.value_json) return [];
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setCloneForceJoinChannels(db, botId, channels = []) {
  if (!db || !botId) return;
  db.run(
    `INSERT INTO bot_settings (key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
    `${CLONE_FJ_PREFIX}${Number(botId)}`,
    JSON.stringify(channels)
  );
  invalidateForceJoinCache();
}

/**
 * Parses user input (@channel, https://t.me/channel, -100123456789, or forwarded message)
 * and resolves chat metadata + invite link using the target bot API (`mainApi` for Global, `cloneApi` for Clone).
 */
export async function resolveAndAddForceJoinChannel({
  db,
  api,
  rawInput = '',
  forwardedChat = null,
  isGlobal = false,
  botId = 0,
  botUsername = 'bot'
}) {
  let targetChatIdOrUsername = null;
  let explicitInviteLink = null;

  if (forwardedChat?.id) {
    targetChatIdOrUsername = forwardedChat.id;
  } else {
    const tokens = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      if (/^https?:\/\/t\.me\/(\+|joinchat\/)/i.test(tok)) {
        explicitInviteLink = tok;
      } else if (/^https?:\/\/t\.me\/([a-zA-Z0-9_]{4,})/i.test(tok)) {
        const m = tok.match(/^https?:\/\/t\.me\/([a-zA-Z0-9_]{4,})/i);
        if (m?.[1]) targetChatIdOrUsername = `@${m[1]}`;
      } else if (tok.startsWith('@')) {
        targetChatIdOrUsername = tok;
      } else if (/^-?\d{6,}$/.test(tok)) {
        targetChatIdOrUsername = tok.startsWith('-100') || tok.startsWith('-') ? Number(tok) : Number(`-100${tok}`);
      } else if (/^[a-zA-Z0-9_]{5,}$/.test(tok) && !targetChatIdOrUsername) {
        targetChatIdOrUsername = `@${tok}`;
      }
    }
  }

  if (!targetChatIdOrUsername) {
    throw new Error(
      `Please provide a valid channel/group @username (e.g. @MyChannel), Chat ID (e.g. -100123456789), or forward a message from the channel! Make sure @${botUsername} is an admin in that channel/group.`
    );
  }

  let chat = null;
  try {
    chat = await api.getChat(targetChatIdOrUsername);
  } catch (err) {
    throw new Error(
      `Could not access "${targetChatIdOrUsername}" via @${botUsername}. Please add @${botUsername} as an Admin in that channel or group first!`
    );
  }

  if (!chat?.id) {
    throw new Error(`Could not resolve chat details for "${targetChatIdOrUsername}".`);
  }

  // Verify the bot itself is a member/admin in the target chat so getChatMember will work
  try {
    const me = api.me || (await api.getMe());
    if (me?.id) {
      const botMember = await api.getChatMember(chat.id, me.id);
      if (!botMember || ['left', 'kicked'].includes(botMember.status)) {
        throw new Error(`@${botUsername} is not a member/admin of "${chat.title || targetChatIdOrUsername}" yet.`);
      }
    }
  } catch (err) {
    if (/not a member|chat not found|forbidden/i.test(err?.message || '')) {
      throw new Error(
        `@${botUsername} must be added as an Admin in "${chat.title || targetChatIdOrUsername}" so it can verify members!`
      );
    }
  }

  let inviteLink = explicitInviteLink || (chat.username ? `https://t.me/${chat.username}` : chat.invite_link || null);
  if (!inviteLink) {
    try {
      const created = await api.call('createChatInviteLink', { chat_id: chat.id });
      if (created?.invite_link) inviteLink = created.invite_link;
    } catch {
      try {
        const exported = await api.call('exportChatInviteLink', { chat_id: chat.id });
        if (typeof exported === 'string' && exported.startsWith('http')) inviteLink = exported;
      } catch {}
    }
  }

  if (!inviteLink) {
    throw new Error(
      `This private channel/group has no public @username and @${botUsername} doesn't have "Invite Users via Link" permission. Either grant Invite Link permission or send: \`${chat.id} https://t.me/+YourInviteLink\``
    );
  }

  const entry = {
    id: chat.id,
    title: String(chat.title || chat.username || 'Community Channel').slice(0, 48),
    username: chat.username || null,
    inviteLink,
    addedAt: new Date().toISOString()
  };

  const currentList = isGlobal
    ? getGlobalForceJoinChannels(db)
    : getCloneForceJoinChannels(db, botId);

  const filtered = currentList.filter((c) => String(c.id) !== String(chat.id));
  filtered.push(entry);

  if (isGlobal) {
    setGlobalForceJoinChannels(db, filtered);
  } else {
    setCloneForceJoinChannels(db, botId, filtered);
  }

  return { entry, total: filtered.length };
}

export function removeForceJoinChannel({ db, chatIdToRemove, isGlobal = false, botId = 0 }) {
  const currentList = isGlobal
    ? getGlobalForceJoinChannels(db)
    : getCloneForceJoinChannels(db, botId);

  const nextList = currentList.filter(
    (c) => String(c.id) !== String(chatIdToRemove) &&
           String(c.username || '').toLowerCase() !== String(chatIdToRemove).replace(/^@/, '').toLowerCase()
  );

  if (isGlobal) {
    setGlobalForceJoinChannels(db, nextList);
  } else {
    setCloneForceJoinChannels(db, botId, nextList);
  }
  return nextList;
}

/**
 * Checks whether `status` from getChatMember counts as a joined member.
 */
function isJoinedMemberStatus(member) {
  if (!member || !member.status) return false;
  const st = member.status;
  if (st === 'creator' || st === 'administrator' || st === 'member') return true;
  if (st === 'restricted' && member.is_member !== false) return true;
  return false;
}

/**
 * Smart Dual-Tier Force-Join Verification:
 * 1. Global Force-Join channels (set by Main Owner) are ALWAYS verified using `mainApi` (@Lancy_easy_bot),
 *    because cloned bots are not inside the Main Owner's channels/groups!
 * 2. Cloner Force-Join channels (set by the Cloner for their cloned bot) are verified using `botApi` (the cloned bot's own API)!
 */
export async function checkUserForceJoin({
  db,
  mainApi,
  botApi,
  isClone = false,
  botId = 0,
  userId,
  bypassCache = false
}) {
  const uid = Number(userId);
  if (!uid || !db) return { ok: true, missing: [] };

  const globalChannels = getGlobalForceJoinChannels(db);
  const cloneChannels = isClone && botId ? getCloneForceJoinChannels(db, botId) : [];

  if (globalChannels.length === 0 && cloneChannels.length === 0) {
    return { ok: true, missing: [] };
  }

  const cacheKey = `${isClone ? botId : 0}:${uid}`;
  if (!bypassCache) {
    const exp = verifiedUsersCache.get(cacheKey);
    if (exp && exp > Date.now()) {
      return { ok: true, missing: [] };
    }
  }

  const missing = [];
  const primaryApi = mainApi || botApi;

  // Tier 1: Verify Main Owner's Global Channels using Main Lancy Bot (`primaryApi`)!
  for (const ch of globalChannels) {
    if (!ch?.id || !primaryApi?.getChatMember) continue;
    try {
      const member = await primaryApi.getChatMember(ch.id, uid);
      if (!isJoinedMemberStatus(member)) {
        missing.push({ ...ch, tier: 'main' });
      }
    } catch (err) {
      // If bot was removed from channel or chat not found, fail-open for that channel so users aren't locked out
      const msg = String(err?.description || err?.message || '');
      if (/user not found/i.test(msg)) {
        missing.push({ ...ch, tier: 'main' });
      }
    }
  }

  // Tier 2: Verify Cloner's Own Channels using the Cloned Bot's API (`botApi`)!
  const seenIds = new Set(globalChannels.map((c) => String(c.id)));
  for (const ch of cloneChannels) {
    if (!ch?.id || seenIds.has(String(ch.id)) || !botApi?.getChatMember) continue;
    try {
      const member = await botApi.getChatMember(ch.id, uid);
      if (!isJoinedMemberStatus(member)) {
        missing.push({ ...ch, tier: 'clone' });
      }
    } catch (err) {
      const msg = String(err?.description || err?.message || '');
      if (/user not found/i.test(msg)) {
        missing.push({ ...ch, tier: 'clone' });
      }
    }
  }

  if (missing.length === 0) {
    verifiedUsersCache.set(cacheKey, Date.now() + VERIFIED_TTL_MS);
    return { ok: true, missing: [] };
  }

  verifiedUsersCache.delete(cacheKey);
  return { ok: false, missing };
}

/**
 * Builds the 100% Bot API 10.3 Rich Message Force-Join Gate shown to unverified users.
 */
export function buildForceJoinGateRich({ botName = 'Lancy', missing = [] }) {
  const b = new RichMessageBuilder();
  b.heading(`${WINGS} 🔒 MEMBERSHIP REQUIRED ${WINGS}`, 1);
  b.paragraph(rt.bold(`Welcome to ${botName}! Please join our official community channel(s) below to unlock all features ♡`));
  b.divider();

  const rows = missing.map((ch, i) => [
    `📢 Channel #${i + 1}`,
    `${ch.title}${ch.username ? ` (@${ch.username})` : ''}`
  ]);
  b.table(kvTable(rows), { compact: true });
  b.divider();

  for (const ch of missing) {
    if (ch.inviteLink) {
      b.buttons([
        richButton.url(`➕ Join ${ch.title}`, ch.inviteLink)
      ]);
    }
  }

  b.buttons([
    richButton.callback('✅ I Have Joined • Verify Now', 'fj_verify', { style: 'success' })
  ]);
  b.footer(rt.italic('Instant verification powered by Lancy Smart Force-Join ♡'));

  b.validate();
  return b.toJSON();
}

/**
 * Builds the 100% Bot API 10.3 Rich Message Force-Join Management Panel
 * for either the Main Bot Owner (Global Force-Join) or a Cloner (Cloned Bot Force-Join).
 */
export function buildForceJoinManagerRich({
  db,
  isGlobal = false,
  botId = 0,
  botUsername = 'Lancy_easy_bot',
  mainBotUsername = 'Lancy_easy_bot',
  canManageGlobal = false
}) {
  const globalList = getGlobalForceJoinChannels(db);
  const cloneList = !isGlobal && botId ? getCloneForceJoinChannels(db, botId) : [];
  const activeList = isGlobal ? globalList : cloneList;

  const b = new RichMessageBuilder();
  b.paragraph(rt.bold(banner([
    isGlobal ? '𓆩♡𓆪 GLOBAL FORCE-JOIN (MAIN + CLONES) 𓆩♡𓆪' : `𓆩♡𓆪 FORCE-JOIN • @${botUsername.toUpperCase()} 𓆩♡𓆪`,
    isGlobal
      ? `verified across all bots by @${mainBotUsername} ♡`
      : `require users to join your channel before using @${botUsername} ♡`
  ])));
  b.divider();

  if (isGlobal) {
    b.blockquote(
      `👑 SMART NETWORK FORCE-JOIN:\n` +
      `• Channels added here apply to @${mainBotUsername} AND every cloned bot!\n` +
      `• Because cloned bots are not inside your channel/group, membership is smartly verified through @${mainBotUsername} automatically!\n` +
      `• Make sure @${mainBotUsername} is an Admin in any channel/group you add here.`
    );
  } else {
    b.blockquote(
      `🤖 CLONER SMART FORCE-JOIN:\n` +
      `• Add your own Telegram channel or group below so users must join it to use @${botUsername}!\n` +
      `• Make sure YOUR bot (@${botUsername}) is added as an Admin in your channel/group.\n` +
      (globalList.length > 0
        ? `• 🌐 Note: ${globalList.length} Main Network channel(s) are also verified automatically via @${mainBotUsername}.`
        : `• Users will tap "➕ Join" and "✅ Verify Now" to unlock your bot!`)
    );
  }
  b.divider();

  b.heading(isGlobal ? '🌐 ACTIVE GLOBAL CHANNELS / GROUPS' : `📢 @${botUsername.toUpperCase()} FORCE-JOIN CHANNELS`, 2);

  if (activeList.length === 0) {
    b.paragraph(rt.italic('No force-join channels configured yet! Tap "➕ Add Channel / Group" below to add one ♡'));
  } else {
    const tableRows = activeList.map((ch, idx) => [
      `#${idx + 1} • ${ch.title}`,
      ch.username ? `@${ch.username}` : String(ch.id)
    ]);
    b.table(kvTable(tableRows), { compact: true });

    for (const ch of activeList) {
      const targetScope = isGlobal ? 'global' : String(botId);
      b.buttons([
        richButton.url(`🔗 ${ch.title.slice(0, 20)}`, ch.inviteLink),
        richButton.callback(`🗑 Remove`, `fj_del:${targetScope}:${ch.id}`, { style: 'danger' })
      ]);
    }
  }

  b.divider();
  const targetScope = isGlobal ? 'global' : String(botId);
  b.buttons([
    richButton.callback('➕ Add Channel / Group', `fj_add:${targetScope}`, { style: 'success' }),
    ...(activeList.length > 0
      ? [richButton.callback('🗑 Clear All', `fj_clear:${targetScope}`, { style: 'danger' })]
      : [])
  ]);

  if (canManageGlobal && botId > 0) {
    b.buttons([
      richButton.callback(
        isGlobal ? `🤖 Switch to @${botUsername} Force-Join` : '👑 Manage Global Force-Join (All Bots)',
        isGlobal ? `fj_open:${botId}` : 'fj_open:global',
        { style: 'primary' }
      )
    ]);
  }

  if (!isGlobal && botId > 0) {
    b.buttons([
      richButton.callback('« Back to Manage Bot', `l1:clone:manage:${botId}`),
      richButton.callback('« Dashboard', 'l1:dashboard:open')
    ]);
  } else {
    b.buttons([
      richButton.callback('« Settings', 'l1:settings:open'),
      richButton.callback('« Dashboard', 'l1:dashboard:open')
    ]);
  }

  b.validate();
  return b.toJSON();
}
