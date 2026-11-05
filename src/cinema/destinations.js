import { createHmac, randomBytes } from 'node:crypto';
import { logger } from '../core/logger.js';

export class CinemaDestinationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CinemaDestinationError';
    this.code = code;
  }
}

export class CinemaDestinationManager {
  constructor({ app, db, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.log = log || logger().child({ module: 'cinema:destinations' });
    this.tokenSecret = process.env.CINEMA_SECRET || process.env.BOT_TOKEN || 'pappy-cinema-secret-key';
  }

  generateToken(chatId) {
    const salt = randomBytes(8).toString('hex');
    const hash = createHmac('sha256', this.tokenSecret).update(`${chatId}:${salt}`).digest('hex').slice(0, 32);
    return `${chatId}_${salt}_${hash}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('_');
    if (parts.length !== 3) return null;
    const [chatIdStr, salt, hash] = parts;
    const expected = createHmac('sha256', this.tokenSecret).update(`${chatIdStr}:${salt}`).digest('hex').slice(0, 32);
    if (expected !== hash) return null;
    return Number(chatIdStr);
  }

  async verifyBotPermissions(chatId) {
    const api = this.app?.telegram?.api;
    if (!api) throw new CinemaDestinationError('INTERNAL_ERROR', 'Telegram API not initialized.');

    let botId = api.me?.id;
    if (!botId) {
      const me = await api.getMe().catch(() => null);
      botId = me?.id;
    }
    if (!botId) throw new CinemaDestinationError('INTERNAL_ERROR', 'Could not determine bot identity.');

    let chat;
    try {
      chat = await api.getChat(chatId);
    } catch (err) {
      throw new CinemaDestinationError('CHAT_NOT_FOUND', `Could not locate chat "${chatId}". Make sure the bot has been added to it.`);
    }

    const realChatId = Number(chat.id);

    let member;
    try {
      member = await api.getChatMember(realChatId, botId);
    } catch (err) {
      throw new CinemaDestinationError('BOT_NOT_MEMBER', 'Bot is not a member of the selected channel or group.');
    }

    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    if (!isAdmin) {
      throw new CinemaDestinationError('BOT_NOT_ADMIN', 'Promote the bot to Administrator in this chat to manage Cinema streaming.');
    }

    const isChannel = chat.type === 'channel';
    const missing = [];

    if (!member.can_manage_video_chats && !member.can_manage_voice_chats) {
      missing.push('Manage Video Chats (Voice Chat)');
    }

    if (isChannel) {
      if (!member.can_post_messages) missing.push('Post Messages');
      if (!member.can_edit_messages) missing.push('Edit Messages of Others');
    } else {
      if (!member.can_pin_messages) missing.push('Pin Messages');
    }

    const rights = {
      isAdmin: true,
      canManageVideoChats: Boolean(member.can_manage_video_chats || member.can_manage_voice_chats),
      canPostMessages: Boolean(member.can_post_messages),
      canEditMessages: Boolean(member.can_edit_messages),
      canPinMessages: Boolean(member.can_pin_messages)
    };

    return {
      chat,
      member,
      rights,
      missing,
      isValid: missing.length === 0
    };
  }

  async registerDestination(chatIdentifier, registeredByUserId) {
    const verification = await this.verifyBotPermissions(chatIdentifier);
    if (!verification.isValid) {
      throw new CinemaDestinationError(
        'MISSING_PERMISSIONS',
        `Bot is missing required admin rights: ${verification.missing.join(', ')}`
      );
    }

    const chat = verification.chat;
    const numChatId = Number(chat.id);
    const token = this.generateToken(numChatId);
    const tokenHash = createHmac('sha256', this.tokenSecret).update(token).digest('hex');

    this.db.run(
      `INSERT INTO cinema_destinations 
       (chat_id, chat_type, title, username, bot_status, verified_rights_json, token_hash, voting_enabled, settings_json, last_verified_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 1, '{}', CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_type = excluded.chat_type,
         title = excluded.title,
         username = excluded.username,
         bot_status = 'active',
         verified_rights_json = excluded.verified_rights_json,
         token_hash = excluded.token_hash,
         last_verified_at = CURRENT_TIMESTAMP`,
      numChatId,
      chat.type,
      chat.title || 'Untitled Chat',
      chat.username || null,
      JSON.stringify(verification.rights),
      tokenHash
    );

    const dest = this.getDestinationByChatId(numChatId);
    if (dest) {
      this.db.run(
        `INSERT OR IGNORE INTO cinema_authorized_users (destination_id, user_id, role, granted_by)
         VALUES (?, ?, 'owner', ?)`,
        dest.id,
        Number(registeredByUserId),
        Number(registeredByUserId)
      );
    }

    return {
      destination: dest,
      token,
      miniAppUrl: this.getMiniAppUrl(token)
    };
  }

  getMiniAppUrl(token) {
    const base = process.env.CINEMA_APP_URL || 'https://pappysonghttps.duckdns.org/cinema';
    return `${base.replace(/\/+$/, '')}/?dest=${encodeURIComponent(token)}`;
  }

  getDestinationByChatId(chatId) {
    const row = this.db.get('SELECT * FROM cinema_destinations WHERE chat_id = ?', Number(chatId));
    if (!row) return null;
    return this.#formatDestination(row);
  }

  getDestinationById(id) {
    const row = this.db.get('SELECT * FROM cinema_destinations WHERE id = ?', Number(id));
    if (!row) return null;
    return this.#formatDestination(row);
  }

  getAllDestinations() {
    const rows = this.db.all('SELECT * FROM cinema_destinations ORDER BY id DESC');
    return (rows || []).map(r => this.#formatDestination(r));
  }

  getDestinationsForUser(userId) {
    const numUser = Number(userId);
    const rows = this.db.all(
      `SELECT d.*, u.role FROM cinema_destinations d
       INNER JOIN cinema_authorized_users u ON d.id = u.destination_id
       WHERE u.user_id = ? AND u.revoked_at IS NULL
       ORDER BY d.id DESC`,
      numUser
    );
    return (rows || []).map(r => ({
      ...this.#formatDestination(r),
      userRole: r.role
    }));
  }

  #formatDestination(row) {
    return {
      id: row.id,
      chatId: row.chat_id,
      chatType: row.chat_type,
      title: row.title,
      username: row.username,
      botStatus: row.bot_status,
      rights: JSON.parse(row.verified_rights_json || '{}'),
      publicCardMessageId: row.public_card_msg_id,
      tokenHash: row.token_hash,
      votingEnabled: Boolean(row.voting_enabled),
      settings: JSON.parse(row.settings_json || '{}'),
      createdAt: row.created_at,
      lastVerifiedAt: row.last_verified_at
    };
  }

  isAuthorized(chatId, userId) {
    const dest = this.getDestinationByChatId(chatId);
    if (!dest) return false;

    // Check main bot owners
    const ownerIds = (this.app?.settings?.get('general.ownerIds') || []).map(Number);
    if (ownerIds.includes(Number(userId))) return true;

    const row = this.db.get(
      `SELECT role FROM cinema_authorized_users 
       WHERE destination_id = ? AND user_id = ? AND revoked_at IS NULL`,
      dest.id,
      Number(userId)
    );
    return Boolean(row);
  }

  async removeDestination(chatId) {
    const dest = this.getDestinationByChatId(chatId);
    if (!dest) return false;
    this.db.run('DELETE FROM cinema_destinations WHERE id = ?', dest.id);
    return true;
  }

  updatePublicCard(chatId, messageId) {
    this.db.run(
      'UPDATE cinema_destinations SET public_card_msg_id = ? WHERE chat_id = ?',
      messageId ? Number(messageId) : null,
      Number(chatId)
    );
  }

  toggleVoting(chatId, enabled) {
    this.db.run(
      'UPDATE cinema_destinations SET voting_enabled = ? WHERE chat_id = ?',
      enabled ? 1 : 0,
      Number(chatId)
    );
  }
}
