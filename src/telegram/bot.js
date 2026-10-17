import { extname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { LancyError, friendlyTelegramError } from '../core/errors.js';
import { decodeCallback, NOOP_CALLBACK, RichMessageBuilder, rt, richButton, encodeCallback } from './rich.js';
import { banner, kvTable } from './ui.js';
import { States } from '../core/stateMachine.js';
import { sleep, parseDurationToSeconds } from '../utils/time.js';
import { truncate } from '../utils/text.js';
import { recognizeAudio, extractMediaForMusicRecognition } from '../media/recognizer.js';
import { getLyrics, getCachedLyrics, chunkLyrics, escapeHtml, formatBlockquoteLyrics, cleanSongMetadata } from '../media/lyrics.js';
import { t } from '../core/i18n.js';
import { PinterestWebProvider } from '../pinterest/web.js';
import { resolvePendingDownload, checkChatMediaPermissions, formatMediaRestrictedNotice, isPermissionError } from './permissions.js';
import { GameEngine } from '../games/engine.js';
import {
  invalidateForceJoinCache,
  setGlobalForceJoinChannels,
  setCloneForceJoinChannels,
  resolveAndAddForceJoinChannel,
  removeForceJoinChannel,
  checkUserForceJoin,
  buildForceJoinGateRich,
  buildForceJoinManagerRich
} from './forceJoin.js';
import { searchNsfw, NSFW_CATEGORIES } from '../wallpaper/nsfwSearch.js';

const execFileAsync = promisify(execFile);
export const inlineSearchCache = new Map();
export const inlinePinterestCache = new Map();
export const inlineTikTokCache = new Map();
export const inlineMusicCache = new Map();
export const inlineNsfwCache = new Map();
export const inlineUrlCache = new Map();
export const recentInlineSearchResults = new Map();

export function safeInlineQueryString(str, maxLen = 32) {
  if (!str) return '';
  const normalized = String(str).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const clean = normalized.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const codePoints = [...clean.toWellFormed()];
  return codePoints.slice(0, maxLen).join('').trim().toWellFormed();
}

export function safeText(str, maxChars = 50) {
  if (!str) return '';
  const codePoints = [...String(str).toWellFormed()];
  return codePoints.slice(0, maxChars).join('').trim().toWellFormed();
}

import { searchYouTubeFast } from '../media/youtubeSearch.js';
export { searchYouTubeFast };

export async function fetchSearchSuggestions(query) {
  const clean = String(query || '').trim();
  if (!clean || clean.length < 2) return [];
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(clean)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(1200)
    });
    const data = await res.json();
    if (Array.isArray(data?.[1])) {
      return data[1].slice(0, 5).filter(s => typeof s === 'string' && s.trim());
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * TelegramController — the control center.
 *
 * - Long-polls getUpdates (never blocks on media/AI/WhatsApp work).
 * - Owner/admin guard on every update.
 * - Routes callback queries by screen prefix to screen handlers.
 * - Routes text/photos/documents to the user's state machine.
 * - Every failure becomes a friendly message — never a stack trace.
 */
export class TelegramController extends EventEmitter {
  constructor({ api, db, settings, stateMachine, sm = null, screens = new Map(), app = null, botContext = null, log } = {}) {
    super();
    this.api = api;
    this.db = db;
    this.settings = settings;
    this.sm = stateMachine ?? sm ?? null;
    this.screens = screens; // Map<screenId, screenModule>
    this.app = app; // the composed application (services)
    this.botContext = botContext || { botId: 0, botName: 'Lancy', isClone: false };
    this.botName = this.botContext.botName;
    this.mainApi = this.botContext?.mainApi || this.app?.telegram?.api || this.api;
    this.log = log ?? logger().child({ module: 'telegram' });
    this.offset = 0;
    this.running = false;
    this.abort = null;
    this.globalCallbacks = new Map(); // action -> handler (state-agnostic)
    this.userScreenMessage = new Map(); // `${chatId}:${tgId}` or tgId -> { chatId, messageId }
    this.activeUserTasks = new Map(); // tgId -> count of active heavy downloads
    this.mediaDeliveryMessageIds = new Set(); // messageId -> boolean
    this.pendingAudioCaches = new Set(); // query -> boolean
    this.pendingVideoCaches = new Set(); // videoId -> boolean
    this.audioMetadataMap = new Map(); // trackId -> { id, title, artist, album, cover, previewUrl }
    this.gameEngine = new GameEngine({ api: this.api, db: this.db, log: this.log });
    this.#registerForceJoinStateHandler();
  }

  getScreenMsg(chatId, tgId) {
    const compositeKey = `${chatId}:${tgId}`;
    const byChat = this.userScreenMessage.get(compositeKey);
    if (byChat?.messageId) return byChat;
    const byUser = this.userScreenMessage.get(String(tgId));
    if (byUser && String(byUser.chatId) === String(chatId)) return byUser;
    return null;
  }

  setScreenMsg(chatId, tgId, messageId) {
    if (!chatId || !tgId || !messageId) return;
    const entry = { chatId, messageId };
    this.userScreenMessage.set(`${chatId}:${tgId}`, entry);
    this.userScreenMessage.set(String(tgId), entry);
  }

  /**
   * Per-user fairness concurrency guard for heavy media/download requests in busy groups.
   * Allows up to 2 concurrent downloads per individual user while allowing unlimited
   * different group members to run their requests in parallel without blocking each other.
   */
  async acquireUserTaskSlot(tgId, chatId, replyToMessageId = null, isGroup = false) {
    const key = String(tgId || 'anon');
    const current = this.activeUserTasks.get(key) || 0;
    const maxPerUser = 2;
    if (current >= maxPerUser) {
      if (chatId) {
        const notice = await this.api.sendMessage(
          chatId,
          `<blockquote>⏳ <b>Hold on a sec!</b> You already have ${current} active downloads running in parallel.\nPlease wait a few seconds for one to finish before starting another ♡</blockquote>`,
          {
            parse_mode: 'HTML',
            ...(isGroup && replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {})
          }
        ).catch(() => null);
        if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
          setTimeout(() => {
            this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
          }, 8000)?.unref?.();
        }
      }
      return false;
    }
    this.activeUserTasks.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeUserTasks.get(key) || 1) - 1;
      if (next <= 0) this.activeUserTasks.delete(key);
      else this.activeUserTasks.set(key, next);
    };
  }

  getInlineAudioMetadata(trackId) {
    if (!trackId) return null;
    return this.audioMetadataMap.get(String(trackId));
  }

  /** Mark a message as containing delivered media (video, album, audio, stickers). */
  markMediaDeliveryMessage(messageId) {
    if (!messageId) return;
    const numId = Number(messageId);
    this.mediaDeliveryMessageIds.add(numId);
    try {
      this.db.run(
        'INSERT OR IGNORE INTO bot_settings (key, value_json) VALUES (?, ?)',
        `media_deliv_${numId}`, '1'
      );
    } catch {}
  }

  isMediaDeliveryMessageId(messageId) {
    if (!messageId) return false;
    const numId = Number(messageId);
    if (this.mediaDeliveryMessageIds.has(numId)) return true;
    try {
      const row = this.db.get('SELECT key FROM bot_settings WHERE key = ?', `media_deliv_${numId}`);
      if (row) {
        this.mediaDeliveryMessageIds.add(numId);
        return true;
      }
    } catch {}
    return false;
  }

  /** Check if a Telegram message contains delivered media so it is NEVER overwritten by a menu. */
  isMediaDeliveryMessage(msg) {
    if (!msg) return false;
    const msgId = msg.message_id ?? msg.id;
    if (msgId && this.isMediaDeliveryMessageId(msgId)) return true;

    // Any message with inline keyboard containing lyrics, downloader, media actions
    if (msg.reply_markup?.inline_keyboard) {
      const allCb = msg.reply_markup.inline_keyboard.flat().map((b) => b.callback_data || '').join(' ');
      if (/lyrics|from_media|downloader|stickers:open|moreAlbum|prevAlbum|moreVideos|prevVideos|fromSearch|addExistingFromSearch|addToExistingPack|getMedia|pinterest:getMedia/i.test(allCb)) {
        return true;
      }
    }

    // Telegram native media payloads
    if (msg.video || msg.audio || msg.voice || msg.document || msg.media_group_id || msg.animation) {
      return true;
    }

    // Photo messages: if photos are attached, only the dashboard welcome card is non-media
    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const captionOrText = String(msg.caption || msg.text || '');
      if (!/control center|status overview/i.test(captionOrText)) {
        return true;
      }
    }

    // Text or caption indicators of delivered media
    const captionOrText = String(msg.caption || msg.text || '');
    if (/DOWNLOAD|PINTEREST|SEARCH COMPLETED|ALL PICKS VIEWED|WA → TG|WA → TELEGRAM|STICKER PACK|MEDIA DELIVERY|MEDIA ITEMS|DELIVERED MEDIA|AESTHETIC MEDIA DELIVERY|Audio Quality|Sound Track|Soundtrack|Spotify|MP3/i.test(captionOrText)) {
      return true;
    }

    return false;
  }

  /** Register a screen module: { id, render(ctx), handle(ctx, action, args) } */
  registerScreen(screen) {
    this.screens.set(screen.id, screen);
    return this;
  }

  /** Register a state-agnostic callback route (e.g. 'noop'). */
  onAction(action, handler) {
    this.globalCallbacks.set(action, handler);
    return this;
  }

  isAllowed(tgId, { isGroup = false } = {}) {
    const id = Number(tgId);
    if (this.isOwner(id)) return { ok: true, role: 'owner' };
    const adminIds = new Set((this.settings.get('telegram.adminIds') ?? []).map(Number));
    if (adminIds.has(id)) return { ok: true, role: 'admin' };

    // Cloned bots are public for their audience:
    if (this.botContext?.isClone) return { ok: true, role: 'allowed' };

    // In group chats, any member can use public commands & buttons:
    if (isGroup) return { ok: true, role: 'member' };

    // Public platform access if enabled:
    if (this.settings.get('security.publicAccess') === true) {
      return { ok: true, role: 'allowed' };
    }

    const allowed = (this.settings.get('security.allowedUsers') ?? []).map(Number);
    if (allowed.length === 0) return { ok: false, role: 'stranger' };
    if (allowed.includes(id)) return { ok: true, role: 'allowed' };
    return { ok: false, role: 'stranger' };
  }

  isCloneOwner(tgId) {
    const id = Number(tgId);
    if (!this.botContext?.isClone) return false;
    const ownerId = Number(this.botContext.ownerId || this.botContext.ownerTgId || 0);
    return ownerId > 0 && id === ownerId;
  }

  isOwner(tgId) {
    const id = Number(tgId);
    if (this.botContext?.isClone) {
      return this.isCloneOwner(id) || this.isMainOwner(id);
    }
    return this.isMainOwner(id);
  }

  isMainOwner(tgId) {
    const id = Number(tgId);
    return (this.settings.get('general.ownerIds') ?? []).map(Number).includes(id);
  }

  async start() {
    const me = await this.api.getMe();
    this.botUsername = me.username;
    this.supportsInline = Boolean(me.supports_inline_queries);
    if (!this.botContext?.isClone) {
      this.settings.values.telegram.botUsername = me.username;
    }
    this.log.info({ bot: `@${me.username}`, supportsInline: this.supportsInline }, 'telegram connected');
    if (!this.supportsInline) {
      this.log.warn({ bot: `@${me.username}` }, 'Inline mode is disabled in @BotFather. Send /setinline to @BotFather to enable live @bot search in chats.');
    }

    // Register slash commands so typing / displays suggestions
    await this.registerCommands();

    this.abort = new AbortController();
    this.running = true;
    void this.#pollLoop();
    this.emit('ready', me);
    return me;
  }

  async registerCommands() {
    const isClone = Boolean(this.botContext?.isClone);
    const botName = this.botContext?.botName || 'Lancy';

    const groupCommands = [
      { command: 'start', description: `✦ Open ${botName} group companion menu` },
      { command: 'menu', description: `✦ Open ${botName} companion dashboard` },
      { command: 'help', description: '୨୧ Bot commands & feature guide' },
      { command: 'game', description: '🎮 Open 16+ Live Games Arena Hub' },
      { command: 'grid', description: '🔠 Play 8×8 Word Grid (Find 10 Hidden Words)' },
      { command: 'wordgrid', description: '🔠 Play 8×8 Word Grid Challenge' },
      { command: 'pokemon', description: '⚡ Catch wild & Shiny Pokémon in chat' },
      { command: 'pokebattle', description: '⚔️ 1v1 Pokémon Stadium Duel' },
      { command: 'pokedex', description: '📖 View your personal Pokédex & Trainer Passport' },
      { command: 'afro', description: '🔥 Guess the Naija / Afrobeats Hit Song' },
      { command: 'songgame', description: '🎧 Guess the Song (Live 30s Audio Clip)' },
      { command: 'lyricgame', description: '🎤 Finish the Lyrics Challenge' },
      { command: 'anime', description: '🥷 Guess the Popular Anime Character' },
      { command: 'flags', description: '🌍 Guess the Country Flag' },
      { command: 'cars', description: '🏎️ Guess the Car Logo (Supercars & Autos)' },
      { command: 'logos', description: '🏢 Guess the Brand Logo (Fashion & Tech)' },
      { command: 'icons', description: '📱 Guess the App & Gaming Icon' },
      { command: 'trivia', description: '🧠 Live Speed Trivia Battle' },
      { command: 'scramble', description: '🔤 Word Scramble Challenge' },
      { command: 'emoji', description: '🧩 Emoji Puzzle Quiz' },
      { command: 'riddle', description: '🕵️ Riddles & Brain Teasers' },
      { command: 'ttt', description: '❌⭕ 1v1 Tic-Tac-Toe Board Game' },
      { command: 'connect4', description: '🔴🟡 1v1 Connect Four Board Game' },
      { command: 'rps', description: '🪨📄✂️ 1v1 Rock Paper Scissors Duel' },
      { command: 'topleaderboard', description: '🏆 Group trivia & game hall of fame' },
      { command: 'play', description: '🎵 Search, stream & download music / MP3' },
      { command: 'grab', description: '📥 Universal media downloader (TikTok, IG, YT, X)' },
      { command: 'download', description: '📥 Universal media downloader (TikTok, IG, YT)' },
      { command: 'search', description: '🔍 Search Pinterest (HD photos & aesthetic art)' },
      { command: 'music', description: '🎧 Fast music & Spotify track search' },
      { command: 'lyrics', description: '📝 Get lyrics for any song or snippet' },
      { command: 'recognize', description: '🎙️ Shazam / identify song from audio or video' },
      { command: 'pfp', description: '👥 Grab aesthetic matching PFP albums from Pinterest' },
      { command: 'matching', description: '👥 Grab 2-piece & multi-slide matching avatars' },
      { command: 'hidetag', description: '📢 Invisibly mention all group members in one message (admins only)' },
      { command: 'tagall', description: '📢 Tag all group members in one clean message' },
      { command: 'setprefix', description: '⚡ Change command trigger prefix (/ to !, ., etc.)' },
      { command: 'cancel', description: '✕ Cancel current active operation' }
    ];

    const privateCommands = [
      { command: 'start', description: `✦ Open ${botName} aesthetic dashboard` },
      { command: 'menu', description: `✦ Open ${botName} aesthetic dashboard` },
      { command: 'help', description: '୨୧ Complete studio guide' },
      { command: 'game', description: '🎮 Open 16+ Live Games Arena Hub' },
      { command: 'grid', description: '🔠 Play 8×8 Word Grid (Find 10 Hidden Words)' },
      { command: 'pokemon', description: '⚡ Catch wild & Shiny Pokémon' },
      { command: 'pokedex', description: '📖 View your personal Pokédex & Trainer Passport' },
      { command: 'afro', description: '🔥 Guess the Naija / Afrobeats Hit Song' },
      { command: 'songgame', description: '🎧 Guess the Song (Live 30s Audio Clip)' },
      { command: 'anime', description: '🥷 Guess the Popular Anime Character' },
      { command: 'cars', description: '🏎️ Guess the Car Logo (Supercars & Autos)' },
      { command: 'logos', description: '🏢 Guess the Brand Logo (Fashion & Tech)' },
      { command: 'icons', description: '📱 Guess the App & Gaming Icon' },
      { command: 'topleaderboard', description: '🏆 Trivia & game hall of fame' },
      { command: 'play', description: '🎵 Search, stream & download music / MP3' },
      { command: 'grab', description: '📥 Universal media downloader (TikTok, IG, YT, X)' },
      { command: 'download', description: '📥 Universal media downloader (TikTok, IG, YT)' },
      { command: 'search', description: '🔍 Search Pinterest (HD photos & videos)' },
      { command: 'music', description: '🎧 Fast music & Spotify track search' },
      { command: 'lyrics', description: '📝 Get lyrics for any song or snippet' },
      { command: 'recognize', description: '🎙️ Shazam / identify song from audio or video' },
      { command: 'pfp', description: '👥 Grab aesthetic matching PFP albums from Pinterest' },
      { command: 'matching', description: '👥 Grab 2-piece & multi-slide matching avatars' },
      { command: 'stickers', description: '🎀 Telegram sticker pack studio' },
      { command: 'postchannel', description: '📢 Post sticker pack to Telegram channel' },
      { command: 'autopost', description: '📅 Schedule automated sticker drops' },
      { command: 'forcejoin', description: '🔒 Configure Force-Join channels & groups' },
      { command: 'setprefix', description: '⚡ Change command trigger prefix (/ to !, ., etc.)' },
      ...(isClone ? [] : [
        { command: 'whatsapp', description: '📱 WhatsApp publishing & channels' },
        { command: 'ai', description: '🪄 Aesthetic AI assistant' },
        { command: 'clone', description: '🤖 Bring your own bot / clone in 60s' }
      ]),
      { command: 'rmbot', description: '🗑 Remove or delete a cloned bot' },
      { command: 'settings', description: '⚙ Studio configuration' },
      { command: 'admins', description: '👥 Team admins & workspaces' },
      { command: 'cancel', description: '✕ Cancel current active operation' }
    ];

    try {
      await this.api.call('setMyCommands', { commands: privateCommands, scope: { type: 'default' } }).catch(() => {});
      await this.api.call('setMyCommands', { commands: privateCommands, scope: { type: 'all_private_chats' } }).catch(() => {});
      await this.api.call('setMyCommands', { commands: groupCommands, scope: { type: 'all_group_chats' } }).catch(() => {});
      await this.api.call('setMyCommands', { commands: groupCommands, scope: { type: 'all_chat_administrators' } }).catch(() => {});
    } catch (err) {
      this.log.debug({ err: err?.message }, 'could not setMyCommands');
    }
  }

  async stop() {
    this.running = false;
    this.abort?.abort();
  }

  async #pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api.poll({ offset: this.offset, timeout: 30, signal: this.abort.signal });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.#handleUpdate(update).catch((error) => {
            this.log.error({ err: error, updateId: update.update_id }, 'update handling failed');
          });
        }
      } catch (error) {
        if (!this.running || error?.name === 'AbortError') return;
        this.log.error({ err: error }, 'polling failed — retrying in 3s');
        await sleep(3000);
      }
    }
  }

  async handleUpdate(update) {
    return this.#handleUpdate(update);
  }

  async handleInlineQuery(inlineQuery) {
    return this.#handleInlineQuery(inlineQuery);
  }

  async handleChosenInlineResult(chosen) {
    return this.#handleChosenInlineResult(chosen);
  }

  async #handleUpdate(update) {
    this.log.info({
      updateId: update.update_id,
      from: update.message?.from?.id ?? update.callback_query?.from?.id,
      text: update.message?.text,
      data: update.callback_query?.data
    }, 'received update');
    if (update.inline_query) return this.#handleInlineQuery(update.inline_query);
    if (update.chosen_inline_result) {
      this.log.info({ chosen: update.chosen_inline_result }, 'received chosen_inline_result');
      return this.#handleChosenInlineResult(update.chosen_inline_result);
    }
    if (update.chat_member) return this.#handleChatMemberUpdated(update.chat_member);
    if (update.my_chat_member) return this.#handleMyChatMemberUpdated(update.my_chat_member);
    if (update.chat_join_request) return this.#handleChatJoinRequest(update.chat_join_request);
    if (update.callback_query) return this.#handleCallback(update.callback_query);
    if (update.message) return this.#handleMessage(update.message);
    if (update.edited_message) return this.#handleMessage(update.edited_message, { edited: true });
  }

  #handleChatMemberUpdated(chatMember) {
    if (!chatMember?.chat?.id) return;
    const chatId = chatMember.chat.id;
    const newUser = chatMember.new_chat_member?.user;
    const newStatus = chatMember.new_chat_member?.status;

    if (newUser?.id) {
      invalidateForceJoinCache(newUser.id);
    }

    const isGroup = Boolean(chatMember.chat.type === 'group' || chatMember.chat.type === 'supergroup');
    if (!isGroup) return;

    if (chatMember.from && !chatMember.from.is_bot) {
      this.db.recordGroupMember(chatId, chatMember.from);
    }

    if (newUser && !newUser.is_bot) {
      if (['member', 'administrator', 'restricted', 'creator'].includes(newStatus)) {
        this.log.info({ chatId, userId: newUser.id, username: newUser.username, status: newStatus }, 'new/updated group member recorded');
        this.db.recordGroupMember(chatId, newUser);
      } else if (newStatus === 'left' || newStatus === 'kicked') {
        this.log.info({ chatId, userId: newUser.id, status: newStatus }, 'group member left or removed');
        this.db.removeGroupMember(chatId, newUser.id);
      }
    }
  }

  #handleMyChatMemberUpdated(myChatMember) {
    if (!myChatMember?.chat?.id) return;
    const chat = myChatMember.chat;
    const chatId = chat.id;
    const newStatus = myChatMember.new_chat_member?.status;
    const isChannel = chat.type === 'channel';

    if (isChannel) {
      if (['administrator', 'creator'].includes(newStatus)) {
        this.log.info?.({ channelId: chatId, title: chat.title, status: newStatus }, 'bot added or updated as admin in channel');
        this.db.recordTelegramChannel({
          channel_id: chatId,
          title: chat.title || 'Untitled Channel',
          username: chat.username || null,
          can_post: 1,
          added_by: myChatMember.from?.id || null
        });
      } else if (newStatus === 'kicked' || newStatus === 'left') {
        this.log.info?.({ channelId: chatId, status: newStatus }, 'bot removed from channel');
        this.db.removeTelegramChannel(chatId);
      }
    }

    if (myChatMember.from && !myChatMember.from.is_bot) {
      this.db.recordGroupMember(chatId, myChatMember.from);
    }
  }

  #handleChatJoinRequest(joinRequest) {
    if (!joinRequest?.chat?.id) return;
    const chatId = joinRequest.chat.id;
    if (joinRequest.from && !joinRequest.from.is_bot) {
      this.db.recordGroupMember(chatId, joinRequest.from);
    }
  }

  #upsertUser(user) {
    if (!user?.id) return null;
    const botId = this.botContext?.botId ?? 0;
    const existing = this.db.get('SELECT id FROM users WHERE tg_id = ?', user.id);
    const isOwner = this.isOwner(user.id);
    const isAdmin = (this.settings.get('telegram.adminIds') ?? []).map(Number).includes(Number(user.id));
    if (existing) {
      this.db.run(
        `UPDATE users SET username = ?, first_name = ?, last_name = ?, last_seen = datetime('now'),
           is_owner = ?, is_admin = ? WHERE tg_id = ?`,
        user.username ?? null, user.first_name ?? null, user.last_name ?? null,
        isOwner ? 1 : 0, isAdmin ? 1 : 0, user.id
      );
    } else {
      this.db.run(
        `INSERT INTO users (tg_id, username, first_name, last_name, is_owner, is_admin, is_allowed)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null,
        isOwner ? 1 : 0, isAdmin ? 1 : 0
      );
      this.db.audit?.(user.id, 'user.seen', { username: user.username });
    }

    try {
      this.db.run(
        `INSERT INTO bot_users (bot_id, tg_id, username, first_name, last_seen)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(bot_id, tg_id) DO UPDATE SET
           username = excluded.username,
           first_name = excluded.first_name,
           last_seen = datetime('now')`,
        botId, user.id, user.username ?? null, user.first_name ?? null
      );
    } catch {}

    return this.db.get('SELECT * FROM users WHERE tg_id = ?', user.id);
  }

  async #fetchInlineMusicTracks(query) {
    const clean = String(query || '').trim();
    if (!clean) return [];

    // 1. Try Deezer Search API (provides direct MP3 audio stream for Telegram, ~150ms)
    try {
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(clean)}&limit=8`, {
        signal: AbortSignal.timeout(2500)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.data) && data.data.length > 0) {
          const items = data.data
            .filter((r) => r.preview && r.preview.startsWith('http'))
            .map((r, idx) => {
              const min = Math.floor((r.duration || 0) / 60);
              const sec = String((r.duration || 0) % 60).padStart(2, '0');
              const duration = r.duration ? `${min}:${sec}` : '';
              return {
                id: String(r.id || idx),
                title: r.title || clean,
                artist: r.artist?.name || 'Music',
                duration,
                durationSeconds: r.duration || 30,
                thumbnail: r.album?.cover_big || r.album?.cover_medium,
                audioUrl: r.preview || null
              };
            });
          if (items.length > 0) return items;
        }
      }
    } catch {}

    // 2. Try iTunes Search API fallback (~150ms)
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=song&limit=8`, {
        signal: AbortSignal.timeout(2500)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.results) && data.results.length > 0) {
          return data.results.map((r, idx) => {
            const min = Math.floor((r.trackTimeMillis || 0) / 60000);
            const sec = String(Math.floor(((r.trackTimeMillis || 0) % 60000) / 1000)).padStart(2, '0');
            const duration = r.trackTimeMillis ? `${min}:${sec}` : '';
            const durationSeconds = r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30;
            const thumb = r.artworkUrl100?.replace('100x100bb', '600x600bb') || r.artworkUrl100;
            return {
              id: String(r.trackId || idx),
              title: r.trackName || clean,
              artist: r.artistName || 'Music',
              duration,
              durationSeconds,
              thumbnail: thumb,
              audioUrl: r.previewUrl || null
            };
          });
        }
      }
    } catch {}

    // 3. Fallback to yt-dlp search if external catalogs return nothing
    try {
      const searchTarget = `ytsearch5:${clean} song audio`;
      let stdout = '';
      try {
        const res = await execFileAsync('yt-dlp', [
          '--no-warnings',
          '--js-runtimes', 'node:/usr/bin/node',
          '--ignore-errors',
          '--print', '%(id)s ||| %(title)s ||| %(channel)s ||| %(duration_string)s ||| %(thumbnail)s',
          searchTarget
        ], { timeout: 4500 });
        stdout = res.stdout || '';
      } catch (err) {
        stdout = err.stdout || '';
      }

      const lines = stdout.trim().split('\n').filter((l) => l.includes(' ||| '));
      const items = [];
      for (const line of lines) {
        const parts = line.split(' ||| ');
        if (!parts[0]) continue;
        const id = parts[0].trim();
        const rawTitle = (parts[1] || clean).trim();
        const rawChannel = (parts[2] || 'Music').trim();
        const duration = (parts[3] || '').trim();
        const thumbnail = (parts[4] || '').trim();

        const cleaned = cleanSongMetadata(rawTitle, rawChannel);
        items.push({
          id,
          title: cleaned.title || rawTitle,
          artist: cleaned.artist || rawChannel,
          duration,
          thumbnail
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  async #cacheAudioTrack(query, timeoutMs = 2500, videoId = null) {
    const clean = String(query || '').trim();
    if (!clean || clean.length < 2) return null;
    const cleanKey = clean.toLowerCase();

    try {
      const existing = this.db.prepare(
        'SELECT file_id FROM cached_audio_tracks WHERE LOWER(query) = ? LIMIT 1'
      ).get(cleanKey);
      if (existing?.file_id) return existing.file_id;
    } catch {}

    if (this.pendingAudioCaches.has(cleanKey)) {
      const start = Date.now();
      while (this.pendingAudioCaches.has(cleanKey) && (Date.now() - start < timeoutMs)) {
        await sleep(150);
      }
      try {
        const row = this.db.prepare(
          'SELECT file_id FROM cached_audio_tracks WHERE LOWER(query) = ? LIMIT 1'
        ).get(cleanKey);
        if (row?.file_id) return row.file_id;
      } catch {}
      return null;
    }

    this.pendingAudioCaches.add(cleanKey);

    const cachingTask = (async () => {
      try {
        if (!this.app?.mediaDownloader) return null;

        const downloadTarget = videoId ? `https://www.youtube.com/watch?v=${videoId}` : clean;
        const res = await this.app.mediaDownloader.download(downloadTarget);
        if (!res?.audioTrack?.buffer) return null;

        const storageChatId = this.settings?.get('telegram.storageChatId') || this.settings?.get('telegram.storageChannelId');
        if (!storageChatId) {
          return null; // Never upload to owner's personal chat
        }
        const durSec = res.duration ? parseDurationToSeconds(res.duration) : 0;
        if (durSec > 0 && durSec < 45) {
          return null; // Strictly reject preview snippets from being cached
        }
        const sent = await this.api.sendAudio(storageChatId, res.audioTrack.buffer, {
          title: res.title || clean,
          performer: res.artist || res.author || 'Music',
          ...(durSec > 0 ? { duration: durSec } : {}),
          disable_notification: true
        });

        const fileId = sent?.audio?.file_id;
        if (fileId) {
          if (sent.message_id) {
            await this.api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
          }
          const songTitle = res.title || clean;
          const songArtist = res.artist || res.author || null;
          try {
            const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
            this.db.prepare(sql).run(cleanKey, fileId, songTitle, songArtist, durSec);
            if (videoId) {
              this.db.prepare(sql).run(videoId, fileId, songTitle, songArtist, durSec);
            }
            const lowerTitle = (songTitle || '').toLowerCase().trim();
            const lowerArtist = (songArtist || '').toLowerCase().trim();
            if (lowerTitle && lowerTitle !== cleanKey) {
              this.db.prepare(sql).run(lowerTitle, fileId, songTitle, songArtist, durSec);
            }
            if (lowerTitle && lowerArtist) {
              const combo1 = `${lowerTitle} ${lowerArtist}`.trim();
              const combo2 = `${lowerArtist} ${lowerTitle}`.trim();
              if (combo1 !== cleanKey && combo1 !== lowerTitle) {
                this.db.prepare(sql).run(combo1, fileId, songTitle, songArtist, durSec);
              }
              if (combo2 !== cleanKey && combo2 !== lowerTitle && combo2 !== combo1) {
                this.db.prepare(sql).run(combo2, fileId, songTitle, songArtist, durSec);
              }
            }
          } catch {}
          return fileId;
        }
      } catch (err) {
        this.log.debug({ err: err?.message, query: clean }, 'audio caching failed');
      } finally {
        this.pendingAudioCaches.delete(cleanKey);
      }
      return null;
    })();

    try {
      const result = await Promise.race([
        cachingTask,
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
      return result;
    } catch {
      return null;
    }
  }

  #matchCachedAudio(item, allCachedRows) {
    if (!item || !allCachedRows?.length) return null;
    const vid = item.videoId || '';
    const ytTitle = (item.title || '').toLowerCase().trim();
    const ytAuthor = (item.author || '').toLowerCase().trim();
    const cleanYt = ytTitle
      .replace(/\s*[\(\[](official\s*(music\s*video|video|audio|lyric\s*video|hd|4k)?|lyrics|audio|remix)[\)\]]/gi, '')
      .replace(/[\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const fullYt = `${ytTitle} ${ytAuthor} ${cleanYt}`.toLowerCase();

    return allCachedRows.find((r) => {
      if (vid && (r.query === vid || (r.file_id && r.file_id.includes(vid)))) return true;
      const rTitle = (r.title || '').toLowerCase().trim();
      const rArtist = (r.artist || '').toLowerCase().trim();
      const rQuery = (r.query || '').toLowerCase().trim();
      if (!rTitle && !rQuery) return false;

      // Exact query match
      if (rQuery && (rQuery === ytTitle || rQuery === cleanYt)) return true;

      // Both title and artist match
      if (rTitle.length >= 3 && (ytTitle.includes(rTitle) || cleanYt.includes(rTitle))) {
        if (!rArtist || rArtist === 'music' || rArtist === 'artist') return true;
        if (fullYt.includes(rArtist)) return true;
        if (rQuery && rQuery.includes(rArtist) && fullYt.includes(rTitle)) return true;
      }

      // Query words match (at least 2 words)
      if (rQuery.length >= 4) {
        const queryWords = rQuery.split(/\s+/).filter((w) => w.length >= 3);
        if (queryWords.length >= 2 && queryWords.every((w) => fullYt.includes(w))) return true;
      }

      return false;
    }) || null;
  }

  async #cacheVideoTrack(videoId, title = '', query = '', timeoutMs = 25000) {
    if (!videoId) return null;
    const cleanKey = String(videoId).trim();
    if (this.pendingVideoCaches.has(cleanKey)) return null;

    try {
      const row = this.db.prepare(
        'SELECT file_id FROM cached_video_tracks WHERE query = ? OR title = ? LIMIT 1'
      ).get(cleanKey, title);
      if (row?.file_id) return row.file_id;
    } catch {}

    this.pendingVideoCaches.add(cleanKey);

    const cachingTask = (async () => {
      try {
        if (!this.app?.mediaDownloader) return null;
        const targetUrl = `https://www.youtube.com/watch?v=${cleanKey}`;
        const res = await this.app.mediaDownloader.download(targetUrl);
        const videoItem = res?.mediaItems?.find((m) => m.type === 'video');
        let vidBuf = videoItem.buffer;
        try {
          vidBuf = await this.app.mediaDownloader.optimizeVideo(vidBuf) || vidBuf;
        } catch {}

        try {
          writeFileSync(`/data/video_cache/${cleanKey}.mp4`, vidBuf);
        } catch {}

        const storageChatId = this.settings?.get('telegram.storageChatId') || this.settings?.get('telegram.storageChannelId');
        if (!storageChatId) return null;
        const durSec = res.duration ? parseDurationToSeconds(res.duration) : 30;
        const sent = await this.api.sendVideo(storageChatId, vidBuf, {
          caption: `🎬 ${res.title || title || 'Clip'}`,
          ...(durSec > 0 ? { duration: durSec } : {}),
          supports_streaming: true,
          disable_notification: true
        });

        const fileId = sent?.video?.file_id;
        if (fileId) {
          if (sent.message_id) {
            await this.api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
          }
          const vidTitle = res.title || title || 'Clip';
          try {
            const sql = 'INSERT OR REPLACE INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)';
            this.db.prepare(sql).run(cleanKey, fileId, vidTitle, durSec);
          } catch {}
          return fileId;
        }
      } catch (err) {
        this.log.debug({ err: err?.message, videoId: cleanKey }, 'video background caching failed');
      } finally {
        this.pendingVideoCaches.delete(cleanKey);
      }
      return null;
    })();

    try {
      const result = await Promise.race([
        cachingTask,
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
      return result;
    } catch {
      return null;
    }
  }

  async #handleChosenInlineResult(chosen) {
    if (!chosen) return;
    this.log.info({ chosen }, 'processing chosen_inline_result');
    const resultId = chosen.result_id || '';
    const inlineMessageId = chosen.inline_message_id;
    if (!inlineMessageId) return;

    // Handle video chosen results (tt_)
    if (resultId.startsWith('tt_')) {
      const cachedInfo = recentInlineSearchResults.get(resultId);
      const videoId = cachedInfo?.videoId || (resultId.split('_')[1] || '');
      const videoTitle = cachedInfo?.title || chosen.query?.replace(/^(tt|tiktok)\s*/i, '') || 'TikTok HD Clip';
      const videoDuration = cachedInfo?.duration || 'HD Clip';
      const queryTopic = cachedInfo?.query || chosen.query?.replace(/^(tt|tiktok)\s*/i, '') || '';
      const botUser = this.botUsername || 'Lancy_easy_bot';

      let fileId = null;

      // 1. Check SQLite cached_video_tracks
      try {
        const row = this.db.prepare(
          'SELECT file_id, title, duration FROM cached_video_tracks WHERE query = ? LIMIT 1'
        ).get(videoId);
        if (row?.file_id) {
          fileId = row.file_id;
          if (row.title) videoTitle = row.title;
          if (row.duration) videoDuration = `${Math.floor(row.duration / 60)}:${String(row.duration % 60).padStart(2, '0')}`;
        }
      } catch {}

      // 2. Download video if not cached
      if (!fileId && this.app?.mediaDownloader) {
        try {
          const videoTarget = videoId ? `https://www.youtube.com/watch?v=${videoId}` : (queryTopic || videoTitle);
          const res = await this.app.mediaDownloader.download(videoTarget);
          const videoItem = res?.mediaItems?.find((m) => m.type === 'video');
          if (videoItem?.buffer) {
            let vidBuf = videoItem.buffer;
            try {
              vidBuf = await this.app.mediaDownloader.optimizeVideo(vidBuf) || vidBuf;
            } catch {}
            try {
              if (videoId) writeFileSync(`/data/video_cache/${videoId}.mp4`, vidBuf);
            } catch {}
            const storageChatId = this.settings?.get('telegram.storageChatId') || this.settings?.get('telegram.storageChannelId');
            const durSec = res.duration ? parseDurationToSeconds(res.duration) : 30;
            if (storageChatId) {
              const sent = await this.api.sendVideo(storageChatId, vidBuf, {
                caption: `🎬 ${res.title || videoTitle}`,
                ...(durSec > 0 ? { duration: durSec } : {}),
                supports_streaming: true,
                disable_notification: true
              });
              const uploadedFileId = sent?.video?.file_id;
              if (uploadedFileId) {
                fileId = uploadedFileId;
                if (sent.message_id) {
                  await this.api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
                }
                try {
                  const sql = 'INSERT OR REPLACE INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)';
                  if (videoId) this.db.prepare(sql).run(videoId, fileId, videoTitle, durSec);
                } catch {}
              }
            }
          }
        } catch (err) {
          this.log.debug({ err: err?.message, videoId, videoTitle }, 'chosen inline video download failed');
        }
      }

      const directVideoUrl = `https://pappysonghttps.duckdns.org/video/live/${encodeURIComponent(videoId || 'clip')}.mp4`;
      const videoMediaTarget = fileId || directVideoUrl;
      if (videoMediaTarget) {
        try {
          await this.api.editMessageMedia({
            inline_message_id: inlineMessageId,
            media: {
              type: 'video',
              media: videoMediaTarget,
              caption: `🎬 <b>${escapeHtml(videoTitle)}</b>\n<blockquote expandable>⏱ <b>Duration:</b> ${escapeHtml(videoDuration)}\n✨ <i>TikTok &amp; Shorts HD Clip via @${botUser} ♡</i></blockquote>`,
              parse_mode: 'HTML',
              supports_streaming: true
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎙️ Recognize Music / Search Song ♡',
                    switch_inline_query_current_chat: `${safeInlineQueryString(videoTitle, 28) || 'song'} song`,
                    style: 'primary'
                  }
                ],
                [
                  {
                    text: '🎬 Search TikTok Live',
                    switch_inline_query_current_chat: 'tt ',
                    style: 'primary'
                  }
                ]
              ]
            }
          });
          this.log.info({ inlineMessageId, fileId, title: videoTitle }, 'upgraded inline message to full playable video');
        } catch (editErr) {
          this.log.warn({ editErr, inlineMessageId }, 'failed to edit inline message media to video');
        }
      } else {
        try {
          await this.api.editMessageCaption({
            inline_message_id: inlineMessageId,
            caption: `🎬 <b>${escapeHtml(safeText(videoTitle, 60))}</b>\n<blockquote>⚠️ <i>Could not load clip right now. Tap below to search again ♡</i></blockquote>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔍 More "${safeText(queryTopic, 15)}"`,
                    switch_inline_query_current_chat: `tt ${safeInlineQueryString(queryTopic, 25)}`,
                    style: 'primary'
                  }
                ]
              ]
            }
          }).catch(() => {});
        } catch {}
      }
      return;
    }

    // Handle audio chosen results (yt_aud_, fresh_aud_, live_aud_, dz_aud_)
    if (resultId.startsWith('yt_aud_') || resultId.startsWith('fresh_aud_') || resultId.startsWith('live_aud_') || resultId.startsWith('dz_aud_')) {
      const cachedInfo = recentInlineSearchResults.get(resultId);
      const videoId = cachedInfo?.videoId || (resultId.split('_')[2] || '');
      let trackTitle = cachedInfo?.title || chosen.query || 'Music Track';
      let trackArtist = cachedInfo?.artist || 'Music';
      const trackDuration = cachedInfo?.duration || 0;
      const searchQuery = cachedInfo ? `${cachedInfo.title} ${cachedInfo.artist}`.trim() : (chosen.query || '');
      const botUser = this.botUsername || 'Lancy_easy_bot';

      let fileId = null;
      let durSec = typeof trackDuration === 'number' ? trackDuration : parseDurationToSeconds(trackDuration);

      try {
        const directMatch = this.db.prepare(
          'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks WHERE LOWER(query) = ? OR LOWER(title) = ? LIMIT 1'
        ).get(searchQuery.toLowerCase().trim(), trackTitle.toLowerCase().trim());
        if (directMatch?.file_id) {
          fileId = directMatch.file_id;
          if (directMatch.title) trackTitle = directMatch.title;
          if (directMatch.artist) trackArtist = directMatch.artist;
          if (directMatch.duration) durSec = directMatch.duration;
        } else {
          const queryTerms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
          const rows = this.db.prepare(
            'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks ORDER BY id DESC'
          ).all();
          const match = (rows || []).find((row) => {
            if (videoId && (row.query === videoId || row.file_id.includes(videoId))) return true;
            const rowText = `${row.query || ''} ${row.title || ''} ${row.artist || ''}`.toLowerCase();
            return queryTerms.length > 0 && queryTerms.every((term) => rowText.includes(term));
          });
          if (match?.file_id) {
            fileId = match.file_id;
            if (match.title) trackTitle = match.title;
            if (match.artist) trackArtist = match.artist;
            if (match.duration) durSec = match.duration;
          }
        }
      } catch {}

      if (!fileId) {
        try {
          const cachedAudioPath = videoId ? `/data/audio_cache/${videoId}.mp3` : null;
          let audioBuffer = null;
          let resDur = durSec;
          if (cachedAudioPath && existsSync(cachedAudioPath) && statSync(cachedAudioPath).size > 10000) {
            audioBuffer = readFileSync(cachedAudioPath);
          } else if (this.app?.mediaDownloader) {
            const downloadTarget = videoId ? `https://www.youtube.com/watch?v=${videoId}` : searchQuery;
            const res = await this.app.mediaDownloader.download(downloadTarget);
            if (res?.audioTrack?.buffer) {
              audioBuffer = res.audioTrack.buffer;
              if (res.duration) resDur = parseDurationToSeconds(res.duration);
              if (res.title) trackTitle = res.title;
              if (res.artist || res.author) trackArtist = res.artist || res.author;
            }
          }

          if (audioBuffer) {
            const storageChatId = this.settings?.get('telegram.storageChatId') || this.settings?.get('telegram.storageChannelId');
            if (storageChatId) {
              const sent = await this.api.sendAudio(storageChatId, audioBuffer, {
                title: trackTitle,
                performer: trackArtist,
                ...(resDur > 0 ? { duration: resDur } : {}),
                disable_notification: true
              });
              const uploadedFileId = sent?.audio?.file_id;
              if (uploadedFileId) {
                fileId = uploadedFileId;
                durSec = resDur;
                if (sent.message_id) {
                  await this.api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
                }
                try {
                  const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                  if (videoId) this.db.prepare(sql).run(videoId, fileId, trackTitle, trackArtist, durSec);
                  this.db.prepare(sql).run(searchQuery.toLowerCase().trim(), fileId, trackTitle, trackArtist, durSec);
                  if (trackTitle && trackTitle.toLowerCase().trim() !== searchQuery.toLowerCase().trim()) {
                    this.db.prepare(sql).run(trackTitle.toLowerCase().trim(), fileId, trackTitle, trackArtist, durSec);
                  }
                } catch {}
              }
            }
          }
        } catch (err) {
          this.log.debug({ err: err?.message, searchQuery }, 'chosen inline audio download failed');
        }
      }

      const safeArtChosen = trackArtist.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Music';
      const safeTitChosen = trackTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Track';
      const directStreamUrl = `https://pappysonghttps.duckdns.org/audio/live/${encodeURIComponent(videoId || 'track')}/${safeArtChosen}_-_${safeTitChosen}.mp3`;
      const audioMediaTarget = fileId || directStreamUrl;
      if (audioMediaTarget) {
        try {
          const min = Math.floor(durSec / 60);
          const sec = String(durSec % 60).padStart(2, '0');
          const durStr = durSec > 0 ? `${min}:${sec}` : 'HD Audio';
          const lyricsSlug = trackTitle.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);

          let lyricBlock = '';
          try {
            const lyricsRes = await getLyrics(trackTitle, trackArtist).catch(() => null);
            if (lyricsRes?.lyrics) {
              const baseMeta = `🎵 <b>${trackTitle}</b> — <i>${trackArtist}</i>\n<blockquote>⏱ Duration: ${durStr} • 🎧 Quality: 320 kbps HD\n✨ Full Audio (100%) via @${botUser} ♡</blockquote>`;
              const avail = Math.max(0, 950 - baseMeta.length - 40);
              if (lyricsRes.lyrics.length <= avail) {
                lyricBlock = `\n<blockquote expandable>📜 <b>Lyrics:</b>\n\n${escapeHtml(lyricsRes.lyrics)}</blockquote>`;
              }
            }
          } catch {}

          const caption = `🎵 <b>${escapeHtml(trackTitle)}</b> — <i>${escapeHtml(trackArtist)}</i>\n<blockquote>⏱ <b>Duration:</b> ${durStr} • 🎧 <b>Quality:</b> 320 kbps HD\n✨ <i>Full Audio (100%) via @${botUser} ♡</i></blockquote>${lyricBlock}`;
          await this.api.editMessageMedia({
            inline_message_id: inlineMessageId,
            media: {
              type: 'audio',
              media: audioMediaTarget,
              caption,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '📜 Lyrics & Info ♡',
                    url: `https://t.me/${botUser}?start=lyrics_${lyricsSlug}`,
                    style: 'primary'
                  }
                ],
                [
                  {
                    text: '🎵 Search Music Live',
                    switch_inline_query_current_chat: '',
                    style: 'primary'
                  }
                ]
              ]
            }
          });
          this.log.info({ inlineMessageId, fileId, title: trackTitle }, 'upgraded inline message to full audio track');
        } catch (editErr) {
          this.log.warn({ editErr, inlineMessageId }, 'failed to edit inline message media to audio');
        }
      } else {
        try {
          await this.api.editMessageCaption({
            inline_message_id: inlineMessageId,
            caption: `🎵 <b>${escapeHtml(trackTitle)}</b> — <i>${escapeHtml(trackArtist)}</i>\n<blockquote>⚠️ <i>Could not stream track right now. Tap below to search again ♡</i></blockquote>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎵 Search Music Live',
                    switch_inline_query_current_chat: '',
                    style: 'primary'
                  }
                ]
              ]
            }
          }).catch(() => {});
        } catch {}
      }
      return;
    }
  }

  async #fetchInlinePinterestMedia(url, botTag, botName) {
    try {
      const headRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(6500)
      });
      let resolvedUrl = headRes.url;
      const pinIdMatch = resolvedUrl.match(/pin\/(\d+)/);
      const pinId = pinIdMatch ? pinIdMatch[1] : null;
      let html = await headRes.text();

      if (pinId && (resolvedUrl.includes('/sent/') || !html.includes('window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__('))) {
        const cleanUrl = `https://www.pinterest.com/pin/${pinId}/`;
        try {
          const cleanRes = await fetch(cleanUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(6500)
          });
          if (cleanRes.ok) {
            resolvedUrl = cleanUrl;
            html = await cleanRes.text();
          }
        } catch {}
      }

      let title = 'Pinterest Pin';
      const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1];
      if (ogTitle) title = ogTitle.replace(/\s*\|\s*Pinterest.*$/i, '').trim();

      let videoUrl = null;
      const imageUrls = [];

      const relayMarker = 'window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(';
      let searchIdx = 0;
      while ((searchIdx = html.indexOf(relayMarker, searchIdx)) !== -1) {
        const after = html.slice(searchIdx + relayMarker.length);
        const firstComma = after.indexOf(',');
        if (firstComma !== -1) {
          const secondArg = after.slice(firstComma + 1).trim();
          let depth = 0, endIdx = -1;
          for (let i = 0; i < secondArg.length; i++) {
            if (secondArg[i] === '{') depth++;
            else if (secondArg[i] === '}') {
              depth--;
              if (depth === 0) { endIdx = i + 1; break; }
            }
          }
          if (endIdx !== -1) {
            try {
              const parsed = JSON.parse(secondArg.slice(0, endIdx));
              const pin = parsed?.data?.v3GetPinQueryv2?.data || parsed?.data?.pin;
              if (pin) {
                if (pin.title || pin.gridTitle) title = (pin.title || pin.gridTitle).trim();
                if (pin.videos?.videoList) {
                  const vList = pin.videos.videoList;
                  const vBest = vList.v720P?.url || vList.vEXP3?.url || vList.vEXP2?.url || Object.values(vList).find((v) => v?.url && /\.mp4(?:[?&]|$)/i.test(v.url))?.url;
                  if (vBest) videoUrl = vBest;
                }
                if (!videoUrl && Array.isArray(pin.videos?.videoUrls)) {
                  videoUrl = pin.videos.videoUrls.find((u) => /\.mp4(?:[?&]|$)/i.test(u)) || null;
                }
                const carouselSlots = pin.carouselData?.carouselSlots || pin.carousel_data?.carousel_slots;
                if (Array.isArray(carouselSlots) && carouselSlots.length > 0) {
                  for (const slot of carouselSlots) {
                    const img = slot.images_orig?.url
                      || slot.images?.orig?.url
                      || (slot.imageSignature ? `https://i.pinimg.com/originals/${slot.imageSignature.slice(0, 2)}/${slot.imageSignature.slice(2, 4)}/${slot.imageSignature.slice(4, 6)}/${slot.imageSignature}.jpg` : null)
                      || (slot.image_signature ? `https://i.pinimg.com/originals/${slot.image_signature.slice(0, 2)}/${slot.image_signature.slice(2, 4)}/${slot.image_signature.slice(4, 6)}/${slot.image_signature}.jpg` : null)
                      || slot.images_1200x?.url
                      || slot.images?.['1200x']?.url
                      || slot.images_736x?.url
                      || slot.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                  }
                }
                const storyPages = pin.storyPinData?.pages || pin.story_pin_data?.pages;
                if (Array.isArray(storyPages) && storyPages.length > 0) {
                  for (const page of storyPages) {
                    const img = page.image?.images?.originals?.url
                      || page.image?.images?.orig?.url
                      || page.image?.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                    const vid = page.video?.video_list?.V_720P?.url || page.video?.video_list?.V_EXP3?.url;
                    if (vid && !videoUrl) videoUrl = vid;
                  }
                }
                if (!videoUrl && imageUrls.length === 0) {
                  const orig = pin.images_orig?.url || pin.imageLargeUrl || pin.images_736x?.url;
                  if (orig && !imageUrls.includes(orig)) imageUrls.push(orig);
                }
              }
            } catch {}
          }
        }
        searchIdx += relayMarker.length;
      }

      // Fallback regex
      if (!videoUrl) {
        const vMatches = html.match(/https:\/\/(?:v\d+|v)\.pinimg\.com\/videos\/[^\s"'\\]+\.mp4/g);
        if (vMatches?.length) videoUrl = vMatches[0];
      }
      if (!videoUrl && imageUrls.length === 0) {
        const origMatches = html.match(/https:\/\/i\.pinimg\.com\/originals\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.(jpg|png|webp)/g) || [];
        for (const u of new Set(origMatches)) imageUrls.push(u);
        if (imageUrls.length === 0) {
          const medMatches = html.match(/https:\/\/i\.pinimg\.com\/736x\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.(jpg|png|webp)/g) || [];
          if (medMatches.length) imageUrls.push(medMatches[0]);
        }
      }

      const results = [];
      const botUser = this.botUsername || 'bot';
      const safeTitle = truncate(title || 'Pinterest Media', 200);

      if (videoUrl) {
        results.push({
          type: 'video',
          id: 'pin_vid_' + Date.now(),
          video_url: videoUrl,
          mime_type: 'video/mp4',
          thumb_url: imageUrls[0] || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
          title: `🎬 HD Video: ${safeTitle.slice(0, 45)}`,
          description: `Pinterest HD Video ♡`,
          caption: `🎬 <b>${escapeHtml(safeTitle)}</b>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔍 Search More HD Pins ♡',
                  switch_inline_query_current_chat: 'pint ',
                  style: 'primary'
                }
              ],
              [
                {
                  text: '📥 Universal Downloader',
                  url: `https://t.me/${botUser}?start=dl`,
                  style: 'primary'
                }
              ]
            ]
          }
        });
      }

      if (imageUrls.length === 1) {
        results.push({
          type: 'photo',
          id: 'pin_pic_' + Date.now(),
          photo_url: imageUrls[0],
          thumb_url: imageUrls[0],
          title: `📷 ${safeTitle.slice(0, 45)}`,
          description: `Pinterest HD Photo ♡`,
          caption: `📷 <b>${escapeHtml(safeTitle)}</b>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔍 Search More HD Pins ♡',
                  switch_inline_query_current_chat: 'pint ',
                  style: 'primary'
                }
              ],
              [
                {
                  text: '📥 Universal Downloader',
                  url: `https://t.me/${botUser}?start=dl`,
                  style: 'primary'
                }
              ]
            ]
          }
        });
      } else if (imageUrls.length > 1) {
        // Multi-photo album / carousel
        imageUrls.slice(0, 10).forEach((imgUrl, idx) => {
          results.push({
            type: 'photo',
            id: `pin_album_${idx}_${Date.now()}`,
            photo_url: imgUrl,
            thumb_url: imgUrl,
            title: `🖼 ${safeTitle.slice(0, 35)} (${idx + 1}/${imageUrls.length})`,
            description: `Pinterest Album • Slide ${idx + 1} of ${imageUrls.length} ♡`,
            caption: `🖼 <b>${escapeHtml(safeTitle)}</b> [${idx + 1}/${imageUrls.length}]\n✨ <i>Downloaded via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔍 Search More HD Pins ♡',
                    switch_inline_query_current_chat: 'pint ',
                    style: 'primary'
                  }
                ],
                [
                  {
                    text: '📥 Universal Downloader',
                    url: `https://t.me/${botUser}?start=dl`,
                    style: 'primary'
                  }
                ]
              ]
            }
          });
        });
      }

      return results;
    } catch (err) {
      this.log.debug({ err: err?.message }, 'inline pinterest fetch failed');
      return [];
    }
  }

  async #fetchInlinePinterestSearch(queryTopic, offset = 0, userId = null) {
    if (!queryTopic) return { results: [], nextOffset: '' };
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cleanTopic = queryTopic.trim();
      const numOffset = parseInt(offset, 10) || 0;
      const sessionUserKey = userId ? `${userId}_` : '';
      const cacheKey = `pint_${sessionUserKey}${cleanTopic.toLowerCase()}`;
      let cached = inlinePinterestCache.get(cacheKey);

      // On new searches (offset 0), always start fresh live crawler without serving stale cached results
      if (!cached || numOffset === 0 || (Date.now() - cached.timestamp > 30000)) {
        cached = {
          items: [],
          bookmark: null,
          combosTried: 0,
          timestamp: Date.now()
        };
        inlinePinterestCache.set(cacheKey, cached);
        if (inlinePinterestCache.size > 200) {
          const firstKey = inlinePinterestCache.keys().next().value;
          inlinePinterestCache.delete(firstKey);
        }
      }

      // Pre-seed seen pins and media URLs from user's history so previous results are never repeated!
      const seenPins = new Set();
      const seenUrls = new Set();
      if (userId && this.db) {
        try {
          const numUserId = Number(userId);
          const historyRows = this.db.all(
            `SELECT pin_id, media_url FROM user_media_history WHERE user_id = ?
             UNION
             SELECT pin_id, media_url FROM pinterest_media WHERE (user_id = ? OR user_id = ?) AND is_duplicate = 0
             UNION
             SELECT pin_id, source_url as media_url FROM pinterest_media WHERE (user_id = ? OR user_id = ?) AND is_duplicate = 0`,
            numUserId, numUserId, String(userId), numUserId, String(userId)
          );
          for (const row of (historyRows || [])) {
            if (row.pin_id) seenPins.add(row.pin_id);
            if (row.media_url) seenUrls.add(row.media_url);
          }
        } catch {}
      }

      const combos = [
        cleanTopic,
        `${cleanTopic} aesthetic`,
        `${cleanTopic} wallpaper`,
        `${cleanTopic} hd 4k`,
        `${cleanTopic} icon pfp`,
        `${cleanTopic} art`,
        `${cleanTopic} dark aesthetic`,
        `${cleanTopic} photography`,
        `${cleanTopic} edit`,
        `${cleanTopic} ultra hd`
      ];

      const provider = this.app?.pinterest?.provider || new PinterestWebProvider();
      const PAGE_SIZE = 25;

      // On initial search (pool empty), fetch the first 2 query combos in parallel for instant deep results!
      if (cached.items.length === 0 && cached.combosTried === 0) {
        cached.combosTried = 2;
        const [res0, res1] = await Promise.all([
          provider.search({ query: combos[0] }).catch(() => null),
          provider.search({ query: combos[1] }).catch(() => null)
        ]);
        if (res0?.bookmark) cached.bookmark = res0.bookmark;
        const seen = new Set();
        for (const res of [res0, res1]) {
          for (const item of (res?.items || [])) {
            const key = item.mediaUrl || item.pinId;
            if (item.pinId && seenPins.has(item.pinId)) continue;
            if (item.mediaUrl && seenUrls.has(item.mediaUrl)) continue;
            if (key && !seen.has(key)) {
              seen.add(key);
              cached.items.push(item);
            }
          }
        }
      }

      // Ensure we have enough items in the pool for the requested offset + PAGE_SIZE
      while (cached.items.length < (numOffset + PAGE_SIZE) && cached.combosTried < combos.length) {
        let res = null;
        if (cached.bookmark) {
          const bm = cached.bookmark;
          cached.bookmark = null;
          res = await provider.search({ query: cleanTopic, bookmark: bm }).catch(() => null);
        }
        if (!res?.items?.length) {
          const nextTerm = combos[cached.combosTried % combos.length];
          cached.combosTried++;
          res = await provider.search({ query: nextTerm }).catch(() => null);
        }
        if (res?.bookmark) {
          cached.bookmark = res.bookmark;
        }
        if (res?.items?.length) {
          const seen = new Set(cached.items.map((i) => i.mediaUrl || i.pinId));
          for (const item of res.items) {
            const key = item.mediaUrl || item.pinId;
            if (item.pinId && seenPins.has(item.pinId)) continue;
            if (item.mediaUrl && seenUrls.has(item.mediaUrl)) continue;
            if (key && !seen.has(key)) {
              seen.add(key);
              cached.items.push(item);
            }
          }
        } else {
          cached.combosTried++;
        }
      }

      if (cached.items.length === 0) return { results: [], nextOffset: '' };

      const paged = cached.items.slice(numOffset, numOffset + PAGE_SIZE);
      const nextOffset = (numOffset + paged.length < cached.items.length || cached.combosTried < combos.length) && paged.length >= 8
        ? String(numOffset + paged.length)
        : '';

      const results = [];
      for (let idx = 0; idx < paged.length; idx++) {
        const item = paged[idx];
        if (item.type === 'video' && item.mediaUrl) {
          results.push({
            type: 'video',
            id: `pin_vid_${item.pinId || idx}_${offset}_${idx}`,
            video_url: item.mediaUrl,
            mime_type: 'video/mp4',
            thumb_url: item.thumbnailUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            title: `🎬 HD Video: ${safeText(cleanTopic, 35)}`,
            description: `Pinterest HD Video ♡`,
            caption: `🎬 <b>${escapeHtml(safeText(cleanTopic, 50))}</b>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔍 More "${safeText(cleanTopic, 12)}"`,
                    switch_inline_query_current_chat: `pint ${safeInlineQueryString(cleanTopic, 20)}`,
                    style: 'primary'
                  },
                  {
                    text: '🎵 Search Music',
                    switch_inline_query_current_chat: safeInlineQueryString(cleanTopic, 30),
                    style: 'primary'
                  }
                ]
              ]
            }
          });
        } else if (item.mediaUrl) {
          results.push({
            type: 'photo',
            id: `pin_pic_${item.pinId || idx}_${offset}_${idx}`,
            photo_url: item.mediaUrl,
            thumb_url: item.thumbnailUrl || item.mediaUrl,
            title: `📷 ${safeText(cleanTopic, 35)}`,
            description: `HD Aesthetic Photo ♡`,
            caption: `📷 <b>${escapeHtml(safeText(cleanTopic, 50))}</b>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔍 More "${safeText(cleanTopic, 12)}"`,
                    switch_inline_query_current_chat: `pint ${safeInlineQueryString(cleanTopic, 20)}`,
                    style: 'primary'
                  },
                  {
                    text: '🎵 Search Music',
                    switch_inline_query_current_chat: safeInlineQueryString(cleanTopic, 30),
                    style: 'primary'
                  }
                ]
              ]
            }
          });
        }
      }

      return { results, nextOffset };
    } catch (err) {
      this.log?.debug?.({ err: err?.message, queryTopic }, 'inline pinterest search failed');
      return { results: [], nextOffset: '' };
    }
  }

  async #fetchInlineTikTokSearch(queryTopic, offset = 0, userId = null) {
    if (!queryTopic) return { results: [], nextOffset: '' };
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cleanTopic = queryTopic.trim();
      const numOffset = parseInt(offset, 10) || 0;
      const sessionUserKey = userId ? `${userId}_` : '';
      const cacheKey = `tt_pool_${sessionUserKey}${cleanTopic.toLowerCase()}`;
      let cached = inlineTikTokCache.get(cacheKey);

      // Support legacy array format if seeded by test or previous cache
      const legacyKey = `tt_${cleanTopic.toLowerCase()}`;
      const legacyCached = inlineTikTokCache.get(legacyKey);

      if (!cached || !Array.isArray(cached.items) || (numOffset === 0 && (!Array.isArray(legacyCached) || legacyCached.length === 0)) || (Date.now() - cached.timestamp > 30000)) {
        if (Array.isArray(legacyCached) && legacyCached.length > 0) {
          cached = {
            items: legacyCached,
            combosTried: 99,
            timestamp: Date.now()
          };
        } else {
          cached = {
            items: [],
            combosTried: 0,
            timestamp: Date.now()
          };
        }
        inlineTikTokCache.set(cacheKey, cached);
        if (inlineTikTokCache.size > 200) {
          const firstKey = inlineTikTokCache.keys().next().value;
          inlineTikTokCache.delete(firstKey);
        }
      }

      const combos = [
        `${cleanTopic} tiktok`,
        `${cleanTopic} shorts`,
        `${cleanTopic} viral tiktok`,
        `${cleanTopic} trending tiktok`,
        `${cleanTopic} tiktok compilation`,
        `${cleanTopic} tiktok dance`,
        `${cleanTopic} tiktok edit`,
        `${cleanTopic} tiktok funny`,
        `${cleanTopic} tiktok clip`,
        `${cleanTopic} reels`,
        cleanTopic,
        `${cleanTopic} 4k edit`,
        `${cleanTopic} viral shorts`
      ];

      // Expand video items in the pool until offset + 10 is reached or timeout/combos exhausted
      const searchStart = Date.now();
      let comboLoops = 0;
      while (cached.items.length < (numOffset + 10) && cached.combosTried < 25 && comboLoops < 3 && (Date.now() - searchStart < 1800)) {
        comboLoops++;
        const mod = cached.combosTried < combos.length
          ? combos[cached.combosTried]
          : `${cleanTopic} tiktok part ${cached.combosTried - combos.length + 2}`;
        cached.combosTried++;
        const vids = await searchYouTubeFast(mod).catch(() => []);
        if (vids?.length) {
          const seen = new Set(cached.items.map((v) => v.videoId));
          for (const v of vids) {
            if (v?.videoId && !seen.has(v.videoId)) {
              seen.add(v.videoId);
              cached.items.push(v);
            }
          }
        }
        if (cached.items.length >= numOffset + 5) break;
      }

      // Synchronize legacy key for backwards-compatibility with tests checking raw array
      inlineTikTokCache.set(legacyKey, cached.items);

      if (cached.items.length === 0) return { results: [], nextOffset: '' };

      const paged = cached.items.slice(numOffset, numOffset + 10);
      const nextOffset = (numOffset + paged.length < cached.items.length || cached.combosTried < 25) && paged.length > 0
        ? String(numOffset + paged.length)
        : '';

      const results = [];

      for (let idx = 0; idx < paged.length; idx++) {
        const item = paged[idx];
        const title = item.title || cleanTopic;
        const duration = item.duration || 'HD Clip';
        const views = item.views ? `${item.views}` : 'Trending';
        const thumb = item.thumb || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
        const resId = `tt_${item.videoId}_${offset}_${idx}`;

        // Check if video is already cached on Telegram servers by its unique ID
        let cachedVid = null;
        try {
          cachedVid = this.db.prepare(
            'SELECT file_id, title, duration FROM cached_video_tracks WHERE query = ? LIMIT 1'
          ).get(item.videoId);
        } catch {}

        const safeTitle = safeText(title, 50);
        const cleanSwitchSong = safeInlineQueryString(safeTitle, 28);
        const caption = `🎬 <b>${escapeHtml(safeTitle)}</b>\n<blockquote expandable>⏱ <b>Duration:</b> ${duration} • 👁 <b>Views:</b> ${views}\n✨ <i>TikTok &amp; Shorts HD Clip via @${botUser} ♡</i></blockquote>`;

        const keyboard = [
          [
            {
              text: '🎙️ Recognize Music / Search Song ♡',
              switch_inline_query_current_chat: `${cleanSwitchSong || 'song'} song`,
              style: 'primary'
            }
          ],
          [
            {
              text: '🎬 Search TikTok Live',
              switch_inline_query_current_chat: 'tt ',
              style: 'primary'
            }
          ]
        ];

        const videoFileId = item.fileId || item.video_file_id || cachedVid?.file_id;
        if (videoFileId) {
          results.push({
            type: 'video',
            id: `cached_vid_${videoFileId.slice(-8)}_${offset}_${idx}`,
            video_file_id: videoFileId,
            title: `🎬 ${safeTitle}`,
            description: `⏱ ${duration} • 👁 ${views} ♡`,
            caption,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: keyboard
            }
          });
        } else {
          recentInlineSearchResults.set(resId, {
            type: 'video',
            videoId: item.videoId,
            title: safeTitle,
            duration,
            query: cleanTopic
          });
          if (recentInlineSearchResults.size > 500) {
            const firstKey = recentInlineSearchResults.keys().next().value;
            recentInlineSearchResults.delete(firstKey);
          }

          const streamUrl = existsSync(`/data/video_cache/${item.videoId}.mp4`)
            ? `https://pappysonghttps.duckdns.org/video/${item.videoId}.mp4`
            : (item.videoUrl || `https://pappysonghttps.duckdns.org/video/${item.videoId}.mp4`);

          const durSec = parseDurationToSeconds(item.duration) || 30;
          results.push({
            type: 'video',
            id: resId,
            video_url: streamUrl,
            mime_type: 'video/mp4',
            thumbnail_url: thumb,
            title: `🎬 ${safeTitle}`,
            description: `⏱ ${duration} • 👁 ${views} ♡`,
            video_duration: durSec,
            caption,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: keyboard
            }
          });
        }
      }

      // Pre-cache top results in background if not already cached
      for (let i = 0; i < Math.min(paged.length, 2); i++) {
        if (!results[i]?.video_file_id && paged[i]?.videoId) {
          this.#cacheVideoTrack(paged[i].videoId, paged[i].title, cleanTopic).catch(() => {});
        }
      }
      return { results, nextOffset };
    } catch (err) {
      this.log?.debug?.({ err: err?.message, queryTopic }, 'inline tiktok search failed');
      return { results: [], nextOffset: '' };
    }
  }

  async #fetchInlineNsfwSearch(queryTopic, offset = 0, userId = null) {
    if (!queryTopic) return { results: [], nextOffset: '' };
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cleanTopic = String(queryTopic || '').trim();
      const numOffset = parseInt(offset, 10) || 0;
      const page = Math.floor(numOffset / 10);

      // Determine category from query if explicit
      let category = NSFW_CATEGORIES.ALL;
      if (/\b(uncensored|hentai\s*uncensored)\b/i.test(cleanTopic)) {
        category = NSFW_CATEGORIES.HENTAI_UNCENSORED;
      } else if (/\b(ecchi|censored)\b/i.test(cleanTopic)) {
        category = NSFW_CATEGORIES.HENTAI_CENSORED;
      } else if (/\b(video|videos|clip|movie)\b/i.test(cleanTopic)) {
        category = NSFW_CATEGORIES.VIDEOS;
      } else if (/\b(real|4k|baddie|amateur|gonewild|model)\b/i.test(cleanTopic)) {
        category = NSFW_CATEGORIES.REAL_WALLPAPERS;
      } else if (/\b(gif|animated)\b/i.test(cleanTopic)) {
        category = NSFW_CATEGORIES.ANIMATED;
      }

      const searchRes = await searchNsfw({
        query: cleanTopic,
        category,
        page,
        limit: 10
      });

      const items = searchRes.results || [];
      if (!items.length) return { results: [], nextOffset: '' };

      const nextOffset = items.length >= 8 ? String(numOffset + items.length) : '';
      const results = [];

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const resId = `nsfw_${page}_${idx}_${Date.now()}`;
        const title = safeText(item.title || cleanTopic, 45);

        if (item.type === 'video' && item.mediaUrl && /\.mp4(\?|$)/i.test(item.mediaUrl)) {
          results.push({
            type: 'video',
            id: resId,
            video_url: item.mediaUrl,
            mime_type: 'video/mp4',
            thumb_url: item.thumbUrl || item.mediaUrl,
            thumbnail_url: item.thumbUrl || item.mediaUrl,
            title: `🎬 18+ Video: ${title}`,
            description: `${item.source || '18+ Adult Video'} • ${item.duration || 'HD'} ♡`,
            caption: `🎬 <b>${escapeHtml(title)}</b>\n🔞 <i>${escapeHtml(item.source || '18+ Adult Video')}</i>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            has_spoiler: true,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔞 More "${safeText(cleanTopic, 12)}"`,
                    switch_inline_query_current_chat: `nsfw ${safeInlineQueryString(cleanTopic, 20)}`,
                    style: 'primary'
                  },
                  {
                    text: '🎬 18+ Videos',
                    switch_inline_query_current_chat: `nsfw video ${safeInlineQueryString(cleanTopic, 15)}`,
                    style: 'primary'
                  }
                ]
              ]
            }
          });
        } else if (item.mediaUrl) {
          results.push({
            type: 'photo',
            id: resId,
            photo_url: item.mediaUrl,
            thumb_url: item.thumbUrl || item.mediaUrl,
            thumbnail_url: item.thumbUrl || item.mediaUrl,
            title: `🔞 ${title}`,
            description: `${item.source || '18+ HD Wallpaper'} ♡`,
            caption: `🔞 <b>${escapeHtml(title)}</b>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            has_spoiler: true,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔞 More "${safeText(cleanTopic, 12)}"`,
                    switch_inline_query_current_chat: `nsfw ${safeInlineQueryString(cleanTopic, 20)}`,
                    style: 'primary'
                  },
                  {
                    text: '🌸 Hentai Ecchi',
                    switch_inline_query_current_chat: `nsfw ecchi ${safeInlineQueryString(cleanTopic, 15)}`,
                    style: 'primary'
                  }
                ]
              ]
            }
          });
        }
      }

      return { results, nextOffset };
    } catch (err) {
      this.log?.debug?.({ err: err?.message, queryTopic }, 'inline nsfw search failed');
      return { results: [], nextOffset: '' };
    }
  }

  async #fetchInlineMusicSearch(queryTopic, offset = 0) {
    if (!queryTopic) return { results: [], nextOffset: '' };
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cleanTopic = String(queryTopic || '')
        .replace(/^(play|music|song|listen|stream)\s+/i, '')
        .trim() || String(queryTopic || '').trim();
      if (!cleanTopic || cleanTopic.length < 2) return { results: [], nextOffset: '' };

      const cacheKey = `mus_pool_${cleanTopic.toLowerCase()}`;
      let cached = inlineMusicCache.get(cacheKey);

      const legacyKey = `mus_${cleanTopic.toLowerCase()}`;
      const legacyCached = inlineMusicCache.get(legacyKey) || inlineSearchCache.get(legacyKey);

      if (!cached || !Array.isArray(cached.items) || (Date.now() - cached.timestamp > 120000)) {
        if (Array.isArray(legacyCached) && legacyCached.length > 0) {
          cached = {
            items: legacyCached,
            seenKeys: new Set(legacyCached.map((i) => i.fileId || i.id || i.videoId || i.title)),
            timestamp: Date.now()
          };
        } else {
          cached = {
            items: [],
            seenKeys: new Set(),
            timestamp: Date.now()
          };
        }
        inlineMusicCache.set(cacheKey, cached);
        if (inlineMusicCache.size > 200) {
          const firstKey = inlineMusicCache.keys().next().value;
          inlineMusicCache.delete(firstKey);
        }
      }

      // 1. Check SQLite cached_audio_tracks first (0ms latency, permanent full Telegram tracks)
      if (cached.items.length === 0) {
        try {
          const queryTerms = cleanTopic.toLowerCase().split(/\s+/).filter(Boolean);
          const allCached = this.db?.prepare?.(
            'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks ORDER BY id DESC'
          )?.all?.() || [];

          for (const row of allCached) {
            if (!row?.file_id) continue;
            const rowQuery = (row.query || '').toLowerCase().trim();
            const rowTitle = (row.title || '').toLowerCase().trim();
            const rowArtist = (row.artist || '').toLowerCase().trim();
            const cleanLower = cleanTopic.toLowerCase().trim();

            const isExact = rowQuery === cleanLower || rowTitle === cleanLower || `${rowTitle} ${rowArtist}` === cleanLower || `${rowArtist} ${rowTitle}` === cleanLower;
            const rowText = `${rowQuery} ${rowTitle} ${rowArtist}`;
            const termsMatch = queryTerms.length > 0 && queryTerms.every((term) => rowText.includes(term));
            const matchingTermsCount = queryTerms.filter((term) => term.length >= 3 && rowText.includes(term)).length;

            let score = 0;
            if (isExact) score = 100;
            else if (termsMatch) score = 50 + queryTerms.length;
            else if (matchingTermsCount > 0) score = 10 * matchingTermsCount;

            if (score > 0) {
              const normKey = `${rowTitle} ${rowArtist}`.trim();
              if (!cached.seenKeys.has(row.file_id) && (!normKey || !cached.seenKeys.has(normKey))) {
                cached.seenKeys.add(row.file_id);
                if (normKey) cached.seenKeys.add(normKey);
                if (rowTitle) cached.seenKeys.add(rowTitle);
                cached.items.push({
                  source: 'cached',
                  fileId: row.file_id,
                  title: row.title,
                  artist: row.artist || 'Music',
                  duration: row.duration || 0,
                  score
                });
              }
            }
          }
          cached.items.sort((a, b) => (b.score || 0) - (a.score || 0));
          const exactCachedCount = allCached.filter((r) => (r.query || '').toLowerCase().trim() === cleanTopic.toLowerCase().trim()).length;
          if (exactCachedCount >= 25) {
            cached.externalFetched = true;
          }
        } catch {}
      }

      // 2. Fast YouTube InnerTube Wide Live Search (<120ms, NG + US + Official Audio) - Primary Source for 100% Full Audio
      const PAGE_SIZE = 20;
      if (!cached.externalFetched && cached.items.length < (offset + PAGE_SIZE)) {
        cached.externalFetched = true;
        try {
          const ytItems = await searchYouTubeFast(cleanTopic, 'NG', { wide: true }).catch(() => []);

          if (Array.isArray(ytItems) && ytItems.length > 0) {
            for (const yt of ytItems) {
              if (!yt?.videoId || !yt?.title) continue;
              const normTitle = (yt.title || '').toLowerCase().trim();
              const normAuthor = (yt.author || '').toLowerCase().trim();
              const normKey = `${normTitle} ${normAuthor}`.trim();

              if (!cached.seenKeys.has(yt.videoId) && !cached.seenKeys.has(normKey) && !cached.seenKeys.has(normTitle)) {
                // Check if already in SQLite cached_audio_tracks
                let matchingFileId = null;
                let cachedDur = null;
                try {
                  const matchRow = this.db?.prepare?.(
                    'SELECT file_id, duration, title, artist FROM cached_audio_tracks WHERE query = ? OR title = ? OR LOWER(title) = ? OR query = ? LIMIT 1'
                  )?.get?.(yt.videoId, yt.title, normTitle, normKey);
                  if (matchRow?.file_id) {
                    matchingFileId = matchRow.file_id;
                    if (matchRow.duration) cachedDur = matchRow.duration;
                  }
                } catch {}

                if (matchingFileId && cached.seenKeys.has(matchingFileId)) continue;

                cached.seenKeys.add(yt.videoId);
                if (normKey) cached.seenKeys.add(normKey);
                if (normTitle) cached.seenKeys.add(normTitle);
                if (matchingFileId) cached.seenKeys.add(matchingFileId);

                const ytDurSec = cachedDur || parseDurationToSeconds(yt.duration) || 180;
                const safeArt = (yt.author || 'Music').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Music';
                const safeTit = (yt.title || 'Track').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Track';
                const cleanSlug = `${safeArt}_-_${safeTit}.mp3`;
                const streamUrl = existsSync(`/data/audio_cache/${yt.videoId}.mp3`)
                  ? `https://pappysonghttps.duckdns.org/audio/${yt.videoId}.mp3`
                  : `https://pappysonghttps.duckdns.org/audio/live/${yt.videoId}/${cleanSlug}`;

                this.audioMetadataMap?.set(String(yt.videoId), {
                  id: yt.videoId,
                  videoId: yt.videoId,
                  title: yt.title,
                  artist: yt.author || 'Music',
                  duration: ytDurSec,
                  thumb: yt.thumb
                });

                cached.items.push({
                  source: matchingFileId ? 'cached' : 'youtube_audio',
                  id: yt.videoId,
                  videoId: yt.videoId,
                  fileId: matchingFileId,
                  audioUrl: streamUrl,
                  title: yt.title,
                  artist: yt.author || 'Music',
                  duration: ytDurSec,
                  thumb: yt.thumb
                });
              }
            }
          }
        } catch (searchErr) {
          this.log?.debug?.({ err: searchErr?.message, cleanTopic }, 'fast youtube music search error');
        }
      }

      inlineMusicCache.set(legacyKey, cached.items);

      if (cached.items.length === 0) return { results: [], nextOffset: '' };

      const paged = cached.items.slice(offset, offset + PAGE_SIZE);
      const nextOffset = (offset + paged.length < cached.items.length) && paged.length > 0
        ? String(offset + paged.length)
        : '';

      const results = [];
      for (let idx = 0; idx < paged.length; idx++) {
        const item = paged[idx];
        const durSec = typeof item.duration === 'number' ? item.duration : parseDurationToSeconds(item.duration);
        const min = Math.floor(durSec / 60);
        const sec = String(durSec % 60).padStart(2, '0');
        const durStr = durSec > 0 ? `${min}:${sec}` : 'HD Audio';

        const safeTitle = [...String(item.title || 'Music Track')].slice(0, 60).join('').trim();
        const safeArtist = [...String(item.artist || 'Music')].slice(0, 60).join('').trim();
        const lyricsSlug = safeTitle.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);
        const cachedLyr = getCachedLyrics(safeTitle, safeArtist);
        let inlineLyricBlock = '';
        if (cachedLyr?.lyrics) {
          const avail = Math.max(0, 950 - 160);
          if (cachedLyr.lyrics.length <= avail) {
            inlineLyricBlock = `\n<blockquote expandable>📜 <b>Lyrics:</b>\n\n${escapeHtml(cachedLyr.lyrics)}</blockquote>`;
          }
        }

        const caption = `🎵 <b>${escapeHtml(safeTitle)}</b> — <i>${escapeHtml(safeArtist)}</i>\n<blockquote expandable>⏱ <b>Duration:</b> ${durStr} • 🎧 <b>Quality:</b> 320 kbps HD\n✨ <i>Full Audio (100%) via @${botUser} ♡</i></blockquote>${inlineLyricBlock}`;

        const keyboard = [
          [
            {
              text: '📜 Lyrics & Info ♡',
              url: `https://t.me/${botUser}?start=lyrics_${lyricsSlug}`,
              style: 'primary'
            }
          ],
          [
            {
              text: '🎵 Search Music Live',
              switch_inline_query_current_chat: '',
              style: 'primary'
            }
          ]
        ];

        if (item.source === 'youtube_video' && item.videoId) {
          const streamUrl = existsSync(`/data/video_cache/${item.videoId}.mp4`)
            ? `https://pappysonghttps.duckdns.org/video/${item.videoId}.mp4`
            : (item.videoUrl || `https://pappysonghttps.duckdns.org/video/${item.videoId}.mp4`);
          results.push({
            type: 'video',
            id: `yt_vid_${item.videoId}_${offset}_${idx}`,
            video_url: streamUrl,
            mime_type: 'video/mp4',
            thumbnail_url: item.thumb || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
            title: `🎬 ${safeTitle.slice(0, 50)}`,
            description: `⏱ ${item.duration} ♡`,
            caption: `🎬 <b>${escapeHtml(safeTitle)}</b>\n<blockquote expandable>⏱ <b>Duration:</b> ${item.duration}\n✨ <i>Delivered via @${botUser} ♡</i></blockquote>`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
        } else if (item.fileId) {
          results.push({
            type: 'audio',
            id: `cached_aud_${item.fileId.slice(-8)}_${offset}_${idx}`,
            audio_file_id: item.fileId,
            title: safeTitle,
            performer: safeArtist,
            ...(durSec > 0 ? { audio_duration: durSec } : {}),
            caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
        } else if (item.audioUrl || item.videoId || item.id) {
          const videoId = item.videoId || item.id || idx;
          const safeArt = safeArtist.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Music';
          const safeTit = safeTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Track';
          const cleanSlug = `${safeArt}_-_${safeTit}.mp3`;
          const streamUrl = item.audioUrl || (existsSync(`/data/audio_cache/${videoId}.mp3`)
            ? `https://pappysonghttps.duckdns.org/audio/${videoId}.mp3`
            : `https://pappysonghttps.duckdns.org/audio/live/${videoId}/${cleanSlug}`);
          const resId = `yt_aud_${videoId}_${offset}_${idx}`;

          this.audioMetadataMap?.set(String(videoId), {
            id: videoId,
            videoId,
            title: safeTitle,
            artist: safeArtist,
            duration: durSec,
            thumb: item.thumb
          });

          recentInlineSearchResults.set(resId, {
            type: 'audio',
            id: videoId,
            videoId,
            title: safeTitle,
            artist: safeArtist,
            duration: durSec,
            query: cleanTopic
          });
          if (recentInlineSearchResults.size > 500) {
            const firstKey = recentInlineSearchResults.keys().next().value;
            recentInlineSearchResults.delete(firstKey);
          }

          results.push({
            type: 'audio',
            id: resId,
            audio_url: streamUrl,
            title: safeTitle,
            performer: safeArtist,
            ...(durSec > 0 ? { audio_duration: durSec } : {}),
            caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
        }
      }

      return { results, nextOffset };
    } catch (err) {
      this.log?.debug?.({ err: err?.message, queryTopic }, 'inline music search failed');
      return { results: [], nextOffset: '' };
    }
  }

  async #fetchInlineUrlMedia(url, botTag, botName) {
    const cleanUrl = url.trim();

    // 1. Direct media extensions
    if (/\.(jpg|jpeg|png|webp)($|\?)/i.test(cleanUrl)) {
      return [{
        type: 'photo',
        id: 'photo_' + Date.now(),
        photo_url: cleanUrl,
        thumb_url: cleanUrl,
        title: '📷 HD Image Preview',
        caption: `📷 <b>HD Image</b>\n✨ <i>Delivered via @${this.botUsername || 'bot'} ♡</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🔍 Search More Media',
                switch_inline_query_current_chat: '',
                style: 'primary'
              }
            ],
            [
              {
                text: '📥 Universal Downloader',
                url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=dl`,
                style: 'primary'
              }
            ]
          ]
        }
      }];
    }
    if (/\.(mp4|mov|webm)($|\?)/i.test(cleanUrl)) {
      return [{
        type: 'video',
        id: 'vid_' + Date.now(),
        video_url: cleanUrl,
        mime_type: 'video/mp4',
        thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        title: '🎬 HD Video',
        caption: `🎬 <b>HD Video</b>\n✨ <i>Delivered via @${this.botUsername || 'bot'} ♡</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎬 Search More Videos',
                switch_inline_query_current_chat: 'tt ',
                style: 'primary'
              }
            ],
            [
              {
                text: '📥 Universal Downloader',
                url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=dl`,
                style: 'primary'
              }
            ]
          ]
        }
      }];
    }
    if (/\.(mp3|m4a|aac|ogg|wav)($|\?)/i.test(cleanUrl)) {
      return [{
        type: 'audio',
        id: 'aud_' + Date.now(),
        audio_url: cleanUrl,
        title: '🎵 Audio File',
        caption: `🎵 <b>Audio File</b>\n✨ <i>Delivered via @${this.botUsername || 'bot'} ♡</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎵 Search Music Live',
                switch_inline_query_current_chat: '',
                style: 'primary'
              }
            ],
            [
              {
                text: '📥 Universal Downloader',
                url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=dl`,
                style: 'primary'
              }
            ]
          ]
        }
      }];
    }

    // 2. Pinterest (videos, single photos, and photo albums / carousels!)
    if (/pinterest\.com|pin\.it/i.test(cleanUrl)) {
      const pinResults = await this.#fetchInlinePinterestMedia(cleanUrl, botTag, botName);
      if (pinResults?.length > 0) return pinResults;
    }

    // 3. TikTok: Fast watermark-free extraction via TikWM API (~300ms)
    if (/tiktok\.com/i.test(cleanUrl)) {
      try {
        const res = await fetch('https://www.tikwm.com/api/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36'
          },
          body: new URLSearchParams({ url: cleanUrl, hd: '1' }),
          signal: AbortSignal.timeout(4500)
        });
        const json = await res.json().catch(() => null);
        if (json?.code === 0 && json.data) {
          const d = json.data;
          const videoUrl = d.play?.startsWith('http') ? d.play : (d.play ? 'https://www.tikwm.com' + d.play : null);
          const audioUrl = d.music?.startsWith('http') ? d.music : (d.music ? 'https://www.tikwm.com' + d.music : null);
          const rawTitle = d.title || 'TikTok Media';
          const safeTitle = truncate(rawTitle, 200);
          const safeAuthor = truncate(d.author?.nickname || d.author?.unique_id || 'TikTok', 50);
          const title = safeTitle;
          const author = safeAuthor;
          const cover = d.cover?.startsWith('http') ? d.cover : (d.cover ? 'https://www.tikwm.com' + d.cover : undefined);
          const images = Array.isArray(d.images) ? d.images : [];
          const soundTitle = d.music_info?.title || '';
          const soundAuthor = d.music_info?.author || '';
          let musicSearchQuery = '';
          if (soundTitle && !/^original sound/i.test(soundTitle)) {
            musicSearchQuery = `${soundTitle} ${soundAuthor}`.trim();
          } else {
            musicSearchQuery = rawTitle.replace(/#[^\s]+/g, '').trim().slice(0, 50) || 'Soundtrack';
          }
          const botUser = this.botUsername || 'Lancy_easy_bot';
          const cleanSongKey = musicSearchQuery.replace(/\s+/g, '_').slice(0, 32);

          const results = [];

          // If TikTok photo album / carousel (slideshow)
          if (images.length > 0) {
            images.slice(0, 10).forEach((imgUrl, idx) => {
              const fullUrl = imgUrl?.startsWith('http') ? imgUrl : ('https://www.tikwm.com' + imgUrl);
              results.push({
                type: 'photo',
                id: `tt_img_${idx}_${Date.now()}`,
                photo_url: fullUrl,
                thumb_url: fullUrl,
                title: `🖼 ${safeText(safeTitle, 35)} (${idx + 1}/${images.length})`,
                description: `👤 ${safeText(safeAuthor, 30)} • Slide ${idx + 1} of ${images.length} ♡`,
                caption: `🖼 <b>${escapeHtml(safeText(safeTitle, 50))}</b> [${idx + 1}/${images.length}]\n👤 <i>${escapeHtml(safeText(safeAuthor, 30))}</i>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🎙️ Recognize Music / Search Song ♡',
                        switch_inline_query_current_chat: safeInlineQueryString(musicSearchQuery, 32),
                        style: 'primary'
                      }
                    ],
                    [
                      {
                        text: '🎵 Full Song in DM ♡',
                        url: `https://t.me/${botUser}?start=play_${encodeURIComponent(cleanSongKey)}`,
                        style: 'primary'
                      },
                      {
                        text: '🎬 Search TikTok Live',
                        switch_inline_query_current_chat: 'tt ',
                        style: 'primary'
                      }
                    ]
                  ]
                }
              });
            });
          }

          if (videoUrl) {
            results.push({
              type: 'video',
              id: 'tt_vid_' + Date.now(),
              video_url: videoUrl,
              mime_type: 'video/mp4',
              video_duration: d.duration || 30,
              thumb_url: cover || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              title: `🎬 HD Video: ${safeText(safeTitle, 45)}`,
              description: `👤 ${safeText(safeAuthor, 30)} • Direct No-Watermark MP4 ♡`,
              caption: `🎬 <b>${escapeHtml(safeText(safeTitle, 50))}</b>\n👤 <i>${escapeHtml(safeText(safeAuthor, 30))}</i>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎙️ Recognize Music / Search Song ♡',
                      switch_inline_query_current_chat: safeInlineQueryString(musicSearchQuery, 32),
                      style: 'primary'
                    }
                  ],
                  [
                    {
                      text: '🎵 Full Song in DM ♡',
                      url: `https://t.me/${botUser}?start=play_${encodeURIComponent(cleanSongKey)}`,
                      style: 'primary'
                    },
                    {
                      text: '🎬 Search TikTok Live',
                      switch_inline_query_current_chat: 'tt ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            });
          }

          if (audioUrl) {
            const rawAudioTitle = d.music_info?.title || rawTitle.slice(0, 30) || 'Soundtrack';
            const safeAudioTitle = truncate(rawAudioTitle, 80);
            results.push({
              type: 'audio',
              id: 'tt_aud_' + Date.now(),
              audio_url: audioUrl,
              title: safeAudioTitle,
              performer: safeAuthor,
              caption: `🎵 <b>${escapeHtml(safeAudioTitle)}</b>\n👤 <i>${escapeHtml(safeAuthor)}</i>\n✨ <i>Extracted audio via @${botUser} ♡</i>`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎙️ Recognize Music / Search Song ♡',
                      switch_inline_query_current_chat: musicSearchQuery,
                      style: 'primary'
                    }
                  ],
                  [
                    {
                      text: '📜 Lyrics & Info ♡',
                      url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(cleanSongKey)}`,
                      style: 'primary'
                    },
                    {
                      text: '🎵 Full Song in DM ♡',
                      url: `https://t.me/${botUser}?start=play_${encodeURIComponent(cleanSongKey)}`,
                      style: 'primary'
                    }
                  ]
                ]
              }
            });
          }

          if (results.length > 0) return results;
        }
      } catch (err) {
        this.log.debug({ err: err?.message }, 'inline tiktok fetch failed');
      }
    }

    // 4. Fallback action card for other platforms
    return [
      {
        type: 'article',
        id: 'dl_action_' + Date.now(),
        title: `📥 Download Media with ${botName}`,
        description: `Tap to download link in full HD with extracted audio ♡`,
        thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        input_message_content: {
          message_text: `<blockquote>📥 <b>Universal Downloader</b>\nLink: <code>${escapeHtml(cleanUrl)}</code>\n\nTip: Send <code>/grab ${escapeHtml(cleanUrl)}</code> in this chat for full HD media delivery! ♡</blockquote>`,
          parse_mode: 'HTML'
        },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📥 Open in Downloader',
                url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=dl`,
                style: 'primary'
              }
            ]
          ]
        }
      }
    ];
  }

  async #handleInlineQuery(inlineQuery) {
    if (!inlineQuery?.id) return;
    const qId = inlineQuery.id;
    const rawText = String(inlineQuery.query || '').trim();
    const offset = parseInt(inlineQuery.offset || '0', 10) || 0;
    const botName = this.botContext?.botName || 'Lancy';
    const botTag = this.botUsername ? `@${this.botUsername}` : '';
    const tgId = inlineQuery.from?.id;
    const userPrefix = tgId && this.db?.getUserPrefix ? this.db.getUserPrefix(tgId) : '/';
    const activePrefix = userPrefix || '/';

    const getCommandArticles = (prefix = '/') => [
      {
        type: 'article',
        id: `cmd_game_${prefix}`,
        title: `🎮 ${prefix}game`,
        description: 'Open 16+ Live Games Arena Hub (Unlimited & Timed) ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}game`
        }
      },
      {
        type: 'article',
        id: `cmd_grid_${prefix}`,
        title: `🔠 ${prefix}grid`,
        description: 'Play 8×8 Word Grid — Find 10 Hidden Words Live ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}grid`
        }
      },
      {
        type: 'article',
        id: `cmd_pokemon_${prefix}`,
        title: `⚡ ${prefix}pokemon`,
        description: 'Catch Wild & Shiny Pokémon in Chat ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}pokemon`
        }
      },
      {
        type: 'article',
        id: `cmd_pokebattle_${prefix}`,
        title: `⚔️ ${prefix}pokebattle`,
        description: '1v1 Pokémon Stadium Duel ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}pokebattle`
        }
      },
      {
        type: 'article',
        id: `cmd_pokedex_${prefix}`,
        title: `📖 ${prefix}pokedex`,
        description: 'View Your Personal Pokédex & Trainer Passport ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}pokedex`
        }
      },
      {
        type: 'article',
        id: `cmd_afro_${prefix}`,
        title: `🔥 ${prefix}afro`,
        description: 'Guess the Naija / Afrobeats Hit Song ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        input_message_content: {
          message_text: `${prefix}afro`
        }
      },
      {
        type: 'article',
        id: `cmd_songgame_${prefix}`,
        title: `🎧 ${prefix}songgame`,
        description: 'Guess the Song (Live 30s Audio Clip) ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        input_message_content: {
          message_text: `${prefix}songgame`
        }
      },
      {
        type: 'article',
        id: `cmd_lyricgame_${prefix}`,
        title: `🎤 ${prefix}lyricgame`,
        description: 'Finish the Lyrics Challenge ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        input_message_content: {
          message_text: `${prefix}lyricgame`
        }
      },
      {
        type: 'article',
        id: `cmd_anime_${prefix}`,
        title: `🥷 ${prefix}anime`,
        description: 'Guess the Popular Anime Character ♡',
        thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        input_message_content: {
          message_text: `${prefix}anime`
        }
      },
      {
        type: 'article',
        id: `cmd_flags_${prefix}`,
        title: `🌍 ${prefix}flags`,
        description: 'Guess the Country Flag Challenge ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}flags`
        }
      },
      {
        type: 'article',
        id: `cmd_logos_${prefix}`,
        title: `🏎️ ${prefix}logos`,
        description: 'Guess the Car / Brand Logo ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}logos`
        }
      },
      {
        type: 'article',
        id: `cmd_ttt_${prefix}`,
        title: `❌⭕ ${prefix}ttt`,
        description: '1v1 Tic-Tac-Toe Board Game ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}ttt`
        }
      },
      {
        type: 'article',
        id: `cmd_connect4_${prefix}`,
        title: `🔴🟡 ${prefix}connect4`,
        description: '1v1 Connect Four Board Game ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}connect4`
        }
      },
      {
        type: 'article',
        id: `cmd_topleaderboard_${prefix}`,
        title: `🏆 ${prefix}topleaderboard`,
        description: 'Group Trivia & Game Hall of Fame ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150',
        input_message_content: {
          message_text: `${prefix}topleaderboard`
        }
      },
      {
        type: 'article',
        id: `cmd_play_${prefix}`,
        title: `🎵 ${prefix}play <song>`,
        description: 'Stream or download high-speed 320kbps MP3 audio ♡',
        thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        input_message_content: {
          message_text: `${prefix}play `
        }
      },
      {
        type: 'article',
        id: `cmd_grab_${prefix}`,
        title: `📥 ${prefix}grab <link>`,
        description: 'Download HD videos & music from TikTok, IG, YT & X ♡',
        thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        input_message_content: {
          message_text: `${prefix}grab `
        }
      },
      {
        type: 'article',
        id: `cmd_pint_${prefix}`,
        title: `🔍 ${prefix}pint <search>`,
        description: 'Search aesthetic Pinterest photos and wallpapers ♡',
        thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        input_message_content: {
          message_text: `${prefix}pint `
        }
      },
      {
        type: 'article',
        id: `cmd_pfp_${prefix}`,
        title: `👥 ${prefix}pfp <theme>`,
        description: 'Grab 2-piece & multi-slide matching PFP albums from Pinterest ♡',
        thumb_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        input_message_content: {
          message_text: `${prefix}pfp `
        }
      },
      {
        type: 'article',
        id: `cmd_stickers_${prefix}`,
        title: `🎀 ${prefix}stickers`,
        description: 'Create, convert & manage Telegram sticker packs ♡',
        thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        input_message_content: {
          message_text: `${prefix}stickers`
        }
      },
      {
        type: 'article',
        id: `cmd_postchannel_${prefix}`,
        title: `📢 ${prefix}postchannel`,
        description: 'Publish sticker packs with aesthetic previews to Telegram channels ♡',
        thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
        input_message_content: {
          message_text: `${prefix}postchannel`
        }
      },
      {
        type: 'article',
        id: `cmd_autopost_${prefix}`,
        title: `📅 ${prefix}autopost`,
        description: 'Schedule automated sticker drop campaigns across days ♡',
        thumb_url: 'https://images.unsplash.com/photo-1506784365847-bbad939e9335?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1506784365847-bbad939e9335?w=150',
        input_message_content: {
          message_text: `${prefix}autopost`
        }
      },
      {
        type: 'article',
        id: `cmd_menu_${prefix}`,
        title: `✦ ${prefix}menu`,
        description: 'Open Lancy aesthetic dashboard & control center ♡',
        thumb_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        input_message_content: {
          message_text: `${prefix}menu`
        }
      },
      {
        type: 'article',
        id: `cmd_setprefix_${prefix}`,
        title: `⚡ ${prefix}setprefix <prefix>`,
        description: 'Change command prefix trigger symbol or emoji ♡',
        thumb_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        input_message_content: {
          message_text: `${prefix}setprefix `
        }
      },
      {
        type: 'article',
        id: `cmd_nsfw_${prefix}`,
        title: `🔞 ${prefix}nsfw <search>`,
        description: 'Search 18+ adult & uncensored/ecchi hentai wallpapers and videos ♡',
        thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
        input_message_content: {
          message_text: `${prefix}nsfw `
        }
      },
      {
        type: 'article',
        id: `cmd_help_${prefix}`,
        title: `୨୧ ${prefix}help`,
        description: 'Display all commands & studio documentation ♡',
        thumb_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        thumbnail_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        input_message_content: {
          message_text: `${prefix}help`
        }
      }
    ];

    try {
      // 1. If query is empty: provide intuitive entrypoint cards (Shazam style)
      if (!rawText) {
        const defaultResults = [
          {
            type: 'article',
            id: 'hint_play',
            title: '🎵 Music Search 🎵',
            description: 'Enter your search term (e.g. song name, artist, album) ♡',
            thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            input_message_content: {
              message_text: `<blockquote>🎵 <b>${botName} Music Search</b>\nType <code>@${this.botUsername || 'bot'} &lt;song name&gt;</code> in any chat to search and stream songs live! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎵 Search Songs Live',
                    switch_inline_query_current_chat: '',
                    style: 'primary'
                  }
                ]
              ]
            }
          },
          {
            type: 'article',
            id: 'hint_download',
            title: '📥 Universal Downloader 📥',
            description: 'Paste any TikTok, Instagram Reel, YouTube, or Pinterest link ♡',
            thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            input_message_content: {
              message_text: `<blockquote>📥 <b>Universal Downloader</b>\nPaste any video, audio, or photo link to download in HD! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '📥 Open Downloader Menu',
                    url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=dl`,
                    style: 'primary'
                  }
                ]
              ]
            }
          },
          {
            type: 'article',
            id: 'hint_pinterest',
            title: '🔍 Pinterest Search 🔍',
            description: 'Type "pint <topic>" or "search <topic>" to search HD aesthetic photos ♡',
            thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            input_message_content: {
              message_text: `<blockquote>🔍 <b>Pinterest Search</b>\nType <code>@${this.botUsername || 'bot'} pint aesthetic wallpaper</code> to find aesthetic pins! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔍 Search HD Pictures',
                    switch_inline_query_current_chat: 'pint ',
                    style: 'primary'
                  }
                ]
              ]
            }
          },
          {
            type: 'article',
            id: 'hint_pfp',
            title: '👥 Matching PFP Studio 👥',
            description: 'Type "pfp <character>" to find 2-piece & duo matching avatars ♡',
            thumb_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
            input_message_content: {
              message_text: `<blockquote>👥 <b>Matching PFP Studio</b>\nType <code>@${this.botUsername || 'bot'} pfp anime couple</code> to grab matching avatars! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '👥 Search Matching PFPs',
                    switch_inline_query_current_chat: 'pfp ',
                    style: 'primary'
                  }
                ]
              ]
            }
          },
          {
            type: 'article',
            id: 'hint_tiktok',
            title: '🎬 TikTok Search 🎬',
            description: 'Type "tt <topic>" or "tiktok <topic>" to search viral clips ♡',
            thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            input_message_content: {
              message_text: `<blockquote>🎬 <b>${botName} TikTok Search</b>\nType <code>@${this.botUsername || 'bot'} tt &lt;topic&gt;</code> in any chat to find and share trending clips! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎬 Search Trending TikToks',
                    switch_inline_query_current_chat: 'tt ',
                    style: 'primary'
                  }
                ]
              ]
            }
          },
          {
            type: 'article',
            id: 'hint_nsfw',
            title: '🔞 18+ Adult & Hentai Studio 🔞',
            description: 'Type "nsfw <query>" or "18+ <query>" for uncensored wallpapers & adult clips ♡',
            thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            input_message_content: {
              message_text: `<blockquote>🔞 <b>18+ Adult &amp; Hentai Studio</b>\nType <code>@${this.botUsername || 'bot'} nsfw &lt;query&gt;</code> to browse uncensored/ecchi anime wallpapers and adult videos with spoiler protection! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔞 Search 18+ Studio',
                    switch_inline_query_current_chat: 'nsfw ',
                    style: 'primary'
                  }
                ]
              ]
            }
          }
        ];

        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: defaultResults,
          cache_time: 5,
          is_personal: true
        });
        return;
      }

      // Check if user is typing prefix or prefix command (e.g. "@bot 🎀", "@bot 🎀play", "@bot /", "@bot /game")
      const isQueryingPrefix = rawText === activePrefix || rawText === '/'
        || (activePrefix !== '/' && rawText.startsWith(activePrefix))
        || rawText.startsWith('/');

      if (isQueryingPrefix) {
        const currentQueryPrefix = (activePrefix !== '/' && rawText.startsWith(activePrefix)) ? activePrefix : (rawText.startsWith('/') ? '/' : activePrefix);
        const queryClean = rawText.slice(currentQueryPrefix.length).trim().toLowerCase();
        const allCmds = getCommandArticles(currentQueryPrefix);
        const matchedCmds = queryClean
          ? allCmds.filter(c => c.id.replace(`_${currentQueryPrefix}`, '').slice(4).includes(queryClean))
          : allCmds;

        if (matchedCmds.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: matchedCmds,
            cache_time: 5,
            is_personal: true
          });
          return;
        }
      }

      // 2. Check if user pasted a media URL (TikTok, Pinterest, direct media, etc.)
      if (/^https?:\/\//i.test(rawText)) {
        let urlResults = inlineUrlCache.get(rawText);
        if (!urlResults) {
          urlResults = await this.#fetchInlineUrlMedia(rawText, botTag, botName);
          if (urlResults?.length > 0) {
            inlineUrlCache.set(rawText, urlResults);
            if (inlineUrlCache.size > 200) {
              const firstKey = inlineUrlCache.keys().next().value;
              inlineUrlCache.delete(firstKey);
            }
          }
        }
        if (urlResults?.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: urlResults,
            cache_time: 20,
            is_personal: false
          });
          return;
        }
      }

      // 3a. Check if 18+ / NSFW / Hentai search:
      if (/^(nsfw|18\+|hentai|adult|ecchi|r18|porn)(?:\b|\s|$)/i.test(rawText)) {
        const queryTopic = rawText.replace(/^(nsfw|18\+|hentai|adult|ecchi|r18|porn)\s*/i, '').trim();
        if (!queryTopic) {
          const suggestionCards = [
            {
              type: 'article',
              id: 'sug_nsfw_uncensored',
              title: '🔞 Hentai Uncensored Wallpapers',
              description: 'Browse uncensored hentai anime HD art & 4K wallpapers ♡',
              thumb_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
              input_message_content: {
                message_text: `<blockquote>🔞 <b>Uncensored Hentai 4K Wallpapers</b>\nType <code>@${this.botUsername || 'bot'} nsfw uncensored</code> to browse uncensored art! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🔞 Browse Uncensored Hentai',
                      switch_inline_query_current_chat: 'nsfw uncensored ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_nsfw_ecchi',
              title: '🌸 Hentai Censored / Ecchi Art',
              description: 'High-res soft ecchi & aesthetic anime wallpapers ♡',
              thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
              input_message_content: {
                message_text: `<blockquote>🌸 <b>Ecchi &amp; Censored Anime Wallpapers</b>\nType <code>@${this.botUsername || 'bot'} nsfw ecchi</code> to browse soft ecchi art! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🌸 Browse Ecchi Anime',
                      switch_inline_query_current_chat: 'nsfw ecchi ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_nsfw_videos',
              title: '🎬 18+ Videos & Clips (MP4)',
              description: 'Watch & send adult video previews with spoiler blur ♡',
              thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              input_message_content: {
                message_text: `<blockquote>🎬 <b>18+ Adult Video Clips</b>\nType <code>@${this.botUsername || 'bot'} nsfw video</code> to browse adult video previews! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎬 Browse 18+ Videos',
                      switch_inline_query_current_chat: 'nsfw video ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_nsfw_real',
              title: '📸 Real Adult 18+ 4K Wallpapers',
              description: 'Glamour, model, and amateur adult wallpapers in 4K ♡',
              thumb_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
              input_message_content: {
                message_text: `<blockquote>📸 <b>Real Adult 18+ 4K Wallpapers</b>\nType <code>@${this.botUsername || 'bot'} nsfw real</code> to browse glamorous adult wallpapers! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '📸 Browse Real Adult 4K',
                      switch_inline_query_current_chat: 'nsfw real ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_nsfw_anim',
              title: '💋 Animated Hentai Clips',
              description: 'High-speed animated hentai GIFs & clips ♡',
              thumb_url: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=150',
              input_message_content: {
                message_text: `<blockquote>💋 <b>Animated Hentai Clips</b>\nType <code>@${this.botUsername || 'bot'} nsfw animated</code> to browse animated clips! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '💋 Browse Animated Hentai',
                      switch_inline_query_current_chat: 'nsfw animated ',
                      style: 'primary'
                    }
                  ]
                ]
              }
            }
          ];

          let trendingNsfw = [];
          try {
            const trend = await this.#fetchInlineNsfwSearch('genshin', 0, tgId);
            if (trend?.results?.length) trendingNsfw = trend.results.slice(0, 8);
          } catch {}

          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: [...suggestionCards, ...trendingNsfw],
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        const { results: nsfwResults, nextOffset } = await this.#fetchInlineNsfwSearch(queryTopic, offset, tgId);
        if (nsfwResults && nsfwResults.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: nsfwResults,
            next_offset: nextOffset,
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        // Fallback card when 0 results found
        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: [{
            type: 'article',
            id: 'nsfw_none_' + Date.now(),
            title: `🔞 No adult results for "${queryTopic}"`,
            description: 'Try searching for an anime character like "genshin", "naruto", "tifa", or "model" ♡',
            thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            input_message_content: {
              message_text: `<blockquote>🔞 <b>18+ Adult Studio</b>\nCould not find adult media for <code>${escapeHtml(queryTopic)}</code>.\nTry searching in chat with <code>/nsfw ${escapeHtml(queryTopic)}</code> for deep multi-provider extraction! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔞 Try Another 18+ Search',
                    switch_inline_query_current_chat: 'nsfw ',
                    style: 'primary'
                  }
                ]
              ]
            }
          }],
          cache_time: 1,
          is_personal: true
        });
        return;
      }

      // 3. Check if Pinterest / photo search:
      if (/^(pint|pinterest|photo|photos|pic|pics|wallpaper|wallpapers|image|images|art)\b/i.test(rawText)) {
        const queryTopic = rawText.replace(/^(pint|pinterest|photo|photos|pic|pics|wallpaper|wallpapers|image|images|art)\s*/i, '').trim();
        if (!queryTopic) {
          const suggestionCards = [
            {
              type: 'article',
              id: 'sug_pint_dark',
              title: '🖤 Dark Aesthetic & Evil Aura',
              description: 'Browse dark fantasy, moody vibes & evil aura wallpapers ♡',
              thumb_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
              input_message_content: {
                message_text: `<blockquote>🖤 <b>Dark Fantasy &amp; Evil Aura</b>\nType <code>@${this.botUsername || 'bot'} pint evil aura</code> to browse dark aesthetic pins! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🖤 Browse Evil Aura Pins',
                      switch_inline_query_current_chat: 'pint evil aura',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_pint_anime',
              title: '🎨 Anime Aesthetic 4K Wallpapers',
              description: 'High-res anime landscapes, characters & cyberpunk art ♡',
              thumb_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
              input_message_content: {
                message_text: `<blockquote>🎨 <b>Anime Aesthetic 4K</b>\nType <code>@${this.botUsername || 'bot'} pint anime aesthetic</code> to browse HD pins! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎨 Browse Anime Pins',
                      switch_inline_query_current_chat: 'pint anime aesthetic',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_pint_cyber',
              title: '🌌 Cyberpunk & Neon Glow City',
              description: 'Futuristic cities, neon lights & retro wave aesthetic ♡',
              thumb_url: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=150',
              input_message_content: {
                message_text: `<blockquote>🌌 <b>Cyberpunk &amp; Neon City</b>\nType <code>@${this.botUsername || 'bot'} pint cyberpunk neon</code> to browse neon pins! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🌌 Browse Cyberpunk Pins',
                      switch_inline_query_current_chat: 'pint cyberpunk neon',
                      style: 'primary'
                    }
                  ]
                ]
              }
            },
            {
              type: 'article',
              id: 'sug_pint_nature',
              title: '🌿 Nature & Chill Minimalist',
              description: 'Scenic mountains, tranquil forests & aesthetic greens ♡',
              thumb_url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=150',
              input_message_content: {
                message_text: `<blockquote>🌿 <b>Nature &amp; Minimalist Aesthetic</b>\nType <code>@${this.botUsername || 'bot'} pint nature aesthetic</code> to browse green pins! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🌿 Browse Nature Pins',
                      switch_inline_query_current_chat: 'pint nature aesthetic',
                      style: 'primary'
                    }
                  ]
                ]
              }
            }
          ];

          let trendingPhotos = [];
          try {
            const trend = await this.#fetchInlinePinterestSearch('aesthetic wallpaper', 0, tgId);
            if (trend?.results?.length) trendingPhotos = trend.results.slice(0, 10);
          } catch {}

          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: [...suggestionCards, ...trendingPhotos],
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        const { results: pintResults, nextOffset } = await this.#fetchInlinePinterestSearch(queryTopic, offset, tgId);

        if (pintResults && pintResults.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: pintResults,
            next_offset: nextOffset,
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        // Friendly fallback when 0 pins found
        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: [{
            type: 'article',
            id: 'pin_none_' + Date.now(),
            title: `🔍 No pins found for "${queryTopic}"`,
            description: `Try another search term like "aesthetic wallpaper", "cute cat" ♡`,
            thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            input_message_content: {
              message_text: `<blockquote>🔍 <b>Pinterest Search</b>\nCould not find pins for <code>${escapeHtml(queryTopic)}</code>.\nTry sending <code>/search ${escapeHtml(queryTopic)}</code> in chat for deep web extraction! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔍 Try Another Search',
                    switch_inline_query_current_chat: 'pint ',
                    style: 'primary'
                  }
                ]
              ]
            }
          }],
          cache_time: 1,
          is_personal: true
        });
        return;
      }

      // 3b. Check if TikTok search:
      if (/^(tt|tiktok)\b/i.test(rawText)) {
        const queryTopic = rawText.replace(/^(tt|tiktok)\s*/i, '').trim();
        if (!queryTopic) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: [{
              type: 'article',
              id: 'hint_type_tt',
              title: '🎬 Type a topic to search TikTok videos',
              description: `e.g. "${rawText} dance tutorial", "${rawText} funny cats" ♡`,
              thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              input_message_content: {
                message_text: `<blockquote>🎬 <b>${botName} TikTok Search</b>\nType <code>@${this.botUsername || 'bot'} ${rawText} &lt;topic&gt;</code> to browse and send trending clips live! ♡</blockquote>`,
                parse_mode: 'HTML'
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎬 Search Trending TikToks',
                      switch_inline_query_current_chat: `${safeInlineQueryString(rawText, 15)} dance `,
                      style: 'primary'
                    }
                  ]
                ]
              }
            }],
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        const { results: ttResults, nextOffset } = await this.#fetchInlineTikTokSearch(queryTopic, offset, tgId);

        if (ttResults && ttResults.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: ttResults,
            next_offset: nextOffset,
            cache_time: 1,
            is_personal: true
          });
          return;
        }

        // Friendly fallback when 0 videos found
        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: [{
            type: 'article',
            id: 'tt_none_' + Date.now(),
            title: `🎬 No TikTok videos found for "${queryTopic}"`,
            description: `Try another search term or paste a direct TikTok link ♡`,
            thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            input_message_content: {
              message_text: `<blockquote>🎬 <b>TikTok Search</b>\nCould not find clips for <code>${escapeHtml(queryTopic)}</code>.\nTip: Paste any TikTok video link directly in chat to download without watermark! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎬 Try Another TikTok Search',
                    switch_inline_query_current_chat: 'tt ',
                    style: 'primary'
                  }
                ]
              ]
            }
          }],
          cache_time: 1,
          is_personal: true
        });
        return;
      }

      // 4. Music Search (Live):
      const cleanSongQuery = rawText.replace(/^(play|music|song|listen|stream)\s+/i, '').trim() || rawText;
      const { results: musicResults, nextOffset } = await this.#fetchInlineMusicSearch(cleanSongQuery, offset);

      if (musicResults && musicResults.length > 0) {
        const answerPayload = {
          inline_query_id: qId,
          results: musicResults,
          next_offset: nextOffset,
          cache_time: 2,
          is_personal: false
        };

        await this.api.call('answerInlineQuery', {
          ...answerPayload,
          button: {
            text: `🎵 Search in ${botName}`,
            start_parameter: 'music'
          }
        }).catch(async () => {
          await this.api.call('answerInlineQuery', answerPayload).catch(() => {});
        });
        return;
      }

      // 5. Friendly fallback when zero music results found (never fall back to Pinterest photos!)
      if (cleanSongQuery.length >= 2) {
        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: [{
            type: 'article',
            id: 'music_none_' + Date.now(),
            title: `🎵 No music tracks found for "${cleanSongQuery}"`,
            description: `Try another song title or artist name ♡`,
            thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            input_message_content: {
              message_text: `<blockquote>🎵 <b>Music Search</b>\nCould not find songs for <code>${escapeHtml(cleanSongQuery)}</code>.\nTry searching with artist name or title! ♡</blockquote>`,
              parse_mode: 'HTML'
            },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎵 Search Another Song',
                    switch_inline_query_current_chat: '',
                    style: 'primary'
                  }
                ]
              ]
            }
          }],
          cache_time: 2,
          is_personal: false
        });
        return;
      }
    } catch (err) {
      this.log.error({ err: err?.message, qId }, 'answerInlineQuery failed');
    }
  }

  async #handleCallback(query) {
    const user = this.#upsertUser(query.from);
    const chatType = query.message?.chat?.type;
    const isGroup = Boolean(chatType === 'group' || chatType === 'supergroup');
    if (isGroup && query.message?.chat?.id && query.from && !query.from.is_bot) {
      this.db.recordGroupMember(query.message.chat.id, query.from);
    }
    const guard = this.isAllowed(query.from.id, { isGroup });
    if (!guard.ok) {
      await this.api.answerCallbackQuery(query.id, { text: 'This Lancy belongs to someone else ♡', showAlert: true });
      return;
    }
    const tgId = String(query.from.id);
    const data = query.data ?? '';

    try {
      if (data === 'fj_verify' || data.startsWith('fj_')) {
        await this.handleForceJoinCallback(query);
        return;
      }

      // Smart Dual-Tier Force-Join Gate on callbacks in private DM only (never in group chats, owners bypass)
      const isGroupCallback = (query.message?.chat?.type === 'group' || query.message?.chat?.type === 'supergroup') || Number(query.message?.chat?.id) < 0;
      if (!isGroupCallback && !this.isOwner(query.from.id) && !this.isMainOwner(query.from.id)) {
        const allowedByFj = await this.#enforceForceJoin(query.from, query.message?.chat?.id, { query });
        if (!allowedByFj) return;
      }

      if (data.startsWith('game_')) {
        await this.handleGameCallback(query);
        return;
      }
      if (data === NOOP_CALLBACK || data.startsWith('l1:noop')) {
        await this.api.answerCallbackQuery(query.id);
        return;
      }
      const decoded = decodeCallback(data);
      if (!decoded) {
        await this.api.answerCallbackQuery(query.id);
        return;
      }
      const { screen, action, args } = decoded;

      // Pagination actions on media messages should update in-place (browsing album slides)
      const isPagination = Boolean(
        action === 'moreAlbum' ||
        action === 'prevAlbum' ||
        action === 'moreVideos' ||
        action === 'prevVideos' ||
        action === 'moreSlide' ||
        action === 'prevSlide' ||
        action === 'more_slide' ||
        action === 'prev_slide' ||
        action === 'next_slide' ||
        action.startsWith('pfp_') ||
        action.startsWith('nav_') ||
        action.startsWith('page_') ||
        action.includes('nav') ||
        action.includes('slide') ||
        action.includes('page')
      );

      const isFromMedia = !isPagination && Boolean(
        args?.includes('from_media') ||
        (query.message && this.isMediaDeliveryMessage(query.message)) ||
        (query.message?.message_id && this.isMediaDeliveryMessageId(query.message.message_id))
      );
      const ctx = this.#ctx(tgId, query, { forceNew: isFromMedia, fromMedia: isFromMedia, isPagination });

      // State-agnostic global actions.
      if (this.globalCallbacks.has(action)) {
        void this.api.answerCallbackQuery(query.id).catch(() => {});
        await this.globalCallbacks.get(action)(ctx, args);
        return;
      }

      // Screen-routed action.
      const screenModule = this.screens.get(screen);
      if (!screenModule?.handle) {
        await this.api.answerCallbackQuery(query.id, { text: '♡ That screen is not available right now.' });
        return;
      }
      void this.api.answerCallbackQuery(query.id).catch(() => {});
      await screenModule.handle(ctx, action, args);
    } catch (error) {
      this.log.error({ err: error, tgId, data }, 'callback failed');
      await this.api.answerCallbackQuery(query.id, { text: friendly(error), showAlert: true }).catch(() => {});
    }
  }

  async #handleMessage(message, { edited = false } = {}) {
    const user = this.#upsertUser(message.from);
    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
    const tgId = String(message.from?.id);
    const chatId = message.chat.id;

    // In group chats, passively keep group roster up-to-date for /hidetag
    if (isGroup && chatId) {
      if (message.from && !message.from.is_bot) {
        this.db.recordGroupMember(chatId, message.from);
      }
      if (Array.isArray(message.new_chat_members)) {
        for (const newMember of message.new_chat_members) {
          if (!newMember.is_bot) {
            this.db.recordGroupMember(chatId, newMember);
          }
        }
      }
      if (message.new_chat_member && !message.new_chat_member.is_bot) {
        this.db.recordGroupMember(chatId, message.new_chat_member);
      }
      if (message.new_chat_participant && !message.new_chat_participant.is_bot) {
        this.db.recordGroupMember(chatId, message.new_chat_participant);
      }
      if (message.left_chat_member?.id) {
        this.db.removeGroupMember(chatId, message.left_chat_member.id);
      }
      if (message.left_chat_participant?.id) {
        this.db.removeGroupMember(chatId, message.left_chat_participant.id);
      }
      if (message.reply_to_message?.from && !message.reply_to_message.from.is_bot) {
        this.db.recordGroupMember(chatId, message.reply_to_message.from);
      }
      if (message.forward_from && !message.forward_from.is_bot) {
        this.db.recordGroupMember(chatId, message.forward_from);
      }
      if (message.pinned_message?.from && !message.pinned_message.from.is_bot) {
        this.db.recordGroupMember(chatId, message.pinned_message.from);
      }
      const entities = message.entities || message.caption_entities;
      if (Array.isArray(entities)) {
        for (const ent of entities) {
          if (ent?.type === 'text_mention' && ent.user && !ent.user.is_bot) {
            this.db.recordGroupMember(chatId, ent.user);
          }
        }
      }
    }

    const guard = this.isAllowed(message.from?.id, { isGroup });
    if (!guard.ok) return; // silent for strangers in DMs

    // In active game sessions, test incoming group messages for correct trivia answers!
    if (chatId && this.gameEngine?.hasActiveGame(chatId) && (message.text || message.caption)) {
      const answered = await this.gameEngine.handleChatMessage(message);
      if (answered) return;
    }

    // Commands
    const rawText = message.text ?? message.caption ?? '';
    let text = rawText.trim();
    if (/^(rm\s*bot|remove\s*bot|delete\s*bot)(\s+.*)?$/i.test(text)) {
      text = text.replace(/^(rm\s*bot|remove\s*bot|delete\s*bot)/i, '/rmbot');
    }

    const chatPrefix = this.db?.getChatPrefix ? this.db.getChatPrefix(chatId) : (this.settings?.get('telegram.prefix') || '/');
    const userPrefix = this.db?.getUserPrefix ? this.db.getUserPrefix(tgId) : '/';

    // Group chats: the chat's prefix set by admin is the single universal prefix for all group members!
    // Private chats (DM): the user's personal prefix or chat prefix applies.
    const activePrefix = isGroup ? (chatPrefix || '/') : (userPrefix && userPrefix !== '/' ? userPrefix : (chatPrefix || '/'));

    // Check if message is prefix alone (e.g. "🎀") or custom prefix help trigger (e.g. "🎀help", "🎀commands")
    const isPrefixOnly = text === activePrefix || (activePrefix !== '/' && text.startsWith(activePrefix) && text.slice(activePrefix.length).trim() === '');
    const remainder = text.startsWith(activePrefix) ? text.slice(activePrefix.length).trim().toLowerCase() : '';
    const isCustomHelp = activePrefix !== '/' && ['help', 'commands', 'cmds'].includes(remainder);

    if (isPrefixOnly || (isCustomHelp && text.startsWith(activePrefix))) {
      await this.handleCommandSuggestions(message, activePrefix);
      return;
    }

    if (activePrefix !== '/' && text.startsWith(activePrefix)) {
      text = '/' + text.slice(activePrefix.length).trim();
    } else if (activePrefix === '/' && (text.startsWith('!') || text.startsWith('.'))) {
      text = '/' + text.slice(1).trim();
    } else if (isGroup && activePrefix !== '/' && !text.startsWith('/')) {
      // In a group chat where a custom prefix (e.g. 🎀) is set:
      // If someone attempts a command using another prefix (e.g. !play or .game), remind them of the group prefix.
      const knownCommands = [
        'play', 'game', 'quiz', 'trivia', 'grid', 'wordgrid', 'pokemon', 'pokebattle', 'pokedex',
        'afro', 'naija', 'songgame', 'lyricgame', 'anime', 'flags', 'logos', 'cars',
        'scramble', 'emoji', 'riddle', 'ttt', 'tictactoe', 'connect4', 'rps', 'topleaderboard',
        'grab', 'dl', 'download', 'pint', 'stickers', 'menu', 'autopost', 'postchannel',
        'setprefix', 'ai', 'whatsapp', 'hidetag', 'tagall', 'pfp', 'matching', 'matchingpfp', 'couplepfp', 'forcejoin', 'fsub',
        'nsfw', '18+', 'hentai', 'adult', 'ecchi', 'r18', 'porn'
      ];
      const matchPrefixAttempt = text.match(/^([^\w\s]{1,3})([a-z0-9]+)(\s+.*)?$/i);
      if (matchPrefixAttempt) {
        const attemptedCmd = matchPrefixAttempt[2].toLowerCase();
        if (knownCommands.includes(attemptedCmd)) {
          await this.api.sendMessage(
            chatId,
            `<blockquote>💡 In this group, the command prefix is <code>${activePrefix}</code>! Use <code>${activePrefix}${attemptedCmd}</code> to run it ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          return;
        }
      }
    }

    // Smart Dual-Tier Force-Join Gate for private DM actions only (never for group chats, owners bypass)
    if (!isGroup && !this.isOwner(tgId) && !this.isMainOwner(tgId)) {
      const allowedByFj = await this.#enforceForceJoin(message.from, chatId, { message });
      if (!allowedByFj) return;
    }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const parts = cmd.split('@');
      const command = parts[0].toLowerCase();
      const targetBot = parts[1]?.toLowerCase();
      if (targetBot && this.botUsername && targetBot !== this.botUsername.toLowerCase()) {
        return;
      }

      if (command === '/forcejoin' || command === '/fsub' || command === '/forcesub') {
        if (isGroup) {
          const notice = await this.api.sendMessage(
            chatId,
            `<blockquote>🌸 The <b>FORCEJOIN</b> feature is only available in private DM with the bot ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
            setTimeout(() => {
              this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
            }, 10000)?.unref?.();
          }
          return;
        }
        await this.handleForceJoinCommand(message, rest);
        return;
      }

      if (command === '/setprefix' || command === '/prefix') {
        await this.handleSetPrefix(message, rest);
        return;
      }

      if (command === '/postchannel' || command === '/posttochannel' || command === '/drop') {
        const channelPostScreen = this.screens.get('channel_post');
        if (channelPostScreen) {
          const sent = await channelPostScreen.open(this.#ctx(tgId, { message }, { forceNew: true }));
          if (sent?.message_id) {
            this.setScreenMsg(chatId, tgId, sent.message_id);
            this.sm.update(tgId, { screenMessageId: sent.message_id });
            this.db.run('UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?', sent.message_id, Number(tgId));
          }
          return;
        }
      }

      if (command === '/autopost' || command === '/autoposting' || command === '/schedulepost') {
        const autoPostScreen = this.screens.get('autopost');
        if (autoPostScreen) {
          const sent = await autoPostScreen.open(this.#ctx(tgId, { message }, { forceNew: true }));
          if (sent?.message_id) {
            this.setScreenMsg(chatId, tgId, sent.message_id);
            this.sm.update(tgId, { screenMessageId: sent.message_id });
            this.db.run('UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?', sent.message_id, Number(tgId));
          }
          return;
        }
      }

      if (command === '/game' || command === '/quiz' || command === '/guess') {
        await this.handleGameCommand(message, rest);
        return;
      }

      if (command === '/trivia') {
        await this.handleGameCommand(message, ['trivia', ...rest]);
        return;
      }

      if (command === '/grid' || command === '/wordgrid' || command === '/wgrid') {
        await this.handleGameCommand(message, ['wordgrid', ...rest]);
        return;
      }

      if (command === '/pokemon' || command === '/poke' || command === '/pkmn') {
        await this.handleGameCommand(message, ['pokemon', ...rest]);
        return;
      }

      if (command === '/whosthatpokemon' || command === '/pksilhouette') {
        await this.handleGameCommand(message, ['whosthatpokemon', ...rest]);
        return;
      }

      if (command === '/pokebattle' || command === '/pokeduel' || command === '/pkduel') {
        await this.handleGameCommand(message, ['pokebattle', ...rest]);
        return;
      }

      if (command === '/pokedex' || command === '/dex') {
        await this.handleGameCommand(message, ['pokedex', ...rest]);
        return;
      }

      if (command === '/afro' || command === '/naija' || command === '/afrobeats') {
        await this.handleGameCommand(message, ['afro', ...rest]);
        return;
      }

      if (command === '/songgame' || command === '/guesssong' || command === '/beat') {
        await this.handleGameCommand(message, ['song', ...rest]);
        return;
      }

      if (command === '/lyricgame' || command === '/guesslyrics') {
        await this.handleGameCommand(message, ['lyric', ...rest]);
        return;
      }

      if (command === '/anime' || command === '/character' || command === '/characters') {
        await this.handleGameCommand(message, ['characters', ...rest]);
        return;
      }

      if (command === '/flags' || command === '/flag') {
        await this.handleGameCommand(message, ['flags', ...rest]);
        return;
      }

      if (command === '/cars' || command === '/car') {
        await this.handleGameCommand(message, ['cars', ...rest]);
        return;
      }

      if (command === '/logos' || command === '/logo') {
        await this.handleGameCommand(message, ['logos', ...rest]);
        return;
      }

      if (command === '/icons' || command === '/icon') {
        await this.handleGameCommand(message, ['icons', ...rest]);
        return;
      }

      if (command === '/scramble' || command === '/anagram') {
        await this.handleGameCommand(message, ['scramble', ...rest]);
        return;
      }

      if (command === '/emoji' || command === '/emojis') {
        await this.handleGameCommand(message, ['emoji', ...rest]);
        return;
      }

      if (command === '/riddle' || command === '/riddles' || command === '/teaser') {
        await this.handleGameCommand(message, ['riddle', ...rest]);
        return;
      }

      if (command === '/ttt' || command === '/tictactoe' || command === '/xo') {
        await this.handleGameCommand(message, ['ttt', ...rest]);
        return;
      }

      if (command === '/connect4' || command === '/c4') {
        await this.handleGameCommand(message, ['connect4', ...rest]);
        return;
      }

      if (command === '/rps' || command === '/rockpaperscissors') {
        await this.handleGameCommand(message, ['rps', ...rest]);
        return;
      }

      if (command === '/topleaderboard' || command === '/gameleaderboard' || command === '/gtop') {
        await this.handleGameLeaderboard(message);
        return;
      }

      if (command === '/hidetag' || command === '/tagall' || command === '/everyone' || command === '/mentionall') {
        await this.handleHideTag(message, rest, command);
        return;
      }

      if (command === '/reloadcommands' || command === '/reload_commands') {
        const isMain = this.isMainOwner(tgId);
        const isClone = this.isCloneOwner(tgId);
        if (!isMain && !isClone) {
          await this.api.sendMessage(chatId, `<blockquote>✕ Only bot owners or admins can hot-reload commands ♡</blockquote>`, { parse_mode: 'HTML' });
          return;
        }

        let report = '';
        if (this.app?.multiBotManager && isMain) {
          const results = await this.app.multiBotManager.hotReloadAllCommands();
          const succeeded = results.filter((r) => r.success).length;
          report = `🌸 Hot-reloaded command suggestions across <b>${succeeded}</b> / <b>${results.length}</b> bots! ♡`;
        } else {
          await this.registerCommands();
          report = `🌸 Hot-reloaded command suggestions for <b>${this.botContext?.botName || 'Lancy'}</b>! ♡`;
        }

        await this.api.sendMessage(chatId, `<blockquote>${report}</blockquote>`, { parse_mode: 'HTML' });
        return;
      }

      const updateScreenMsg = (sent) => {
        if (sent?.message_id) {
          this.setScreenMsg(chatId, tgId, sent.message_id);
          this.sm.update(tgId, { screenMessageId: sent.message_id });
          if (!this.botContext?.isClone) {
            this.db.run(
              'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
              sent.message_id, Number(tgId)
            );
          }
        }
      };

      if (isGroup && (command === '/whatsapp' || command === '/ai' || command === '/admins' || command === '/settings' || command === '/addadmin' || command === '/deladmin' || command === '/forcejoin' || command === '/fsub' || command === '/forcesub')) {
        const notice = await this.api.sendMessage(
          chatId,
          `<blockquote>🌸 The <b>${command.slice(1).toUpperCase()}</b> feature is only available in private DM with the bot ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
        if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
          setTimeout(() => {
            this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
          }, 10000)?.unref?.();
        }
        return;
      }

      if (command === '/clone') {
        if (isGroup) {
          const notice = await this.api.sendMessage(
            chatId,
            `<blockquote>🤖 To clone your own bot, please open a private DM with the bot and type <code>/clone</code>! ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
            setTimeout(() => {
              this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
            }, 10000)?.unref?.();
          }
          return;
        }
        await this.sm.reset(tgId, { reason: 'command' });
        const cloneScreen = this.screens.get('clone');
        const sent = await cloneScreen?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }

      if (command === '/rmbot' || command === '/rm_bot' || command === '/deletebot' || command === '/removebot' || command === '/delbot') {
        if (isGroup) {
          const notice = await this.api.sendMessage(
            chatId,
            `<blockquote>🤖 To manage or remove your cloned bots, please open a private DM with the bot! ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
            setTimeout(() => {
              this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
            }, 10000)?.unref?.();
          }
          return;
        }

        const cloneScreen = this.screens.get('clone');

        // If invoked inside the cloned bot itself by its owner:
        if (this.botContext?.isClone && Number(tgId) === Number(this.botContext.ownerId)) {
          const cloneId = this.botContext.botId;
          await this.sm.reset(tgId, { reason: 'command' });
          const ctx = this.#ctx(tgId, { message }, { forceNew: true });
          const sent = await cloneScreen?.handle(ctx, 'delete_confirm', [cloneId]);
          updateScreenMsg(sent);
          return;
        }

        const multiBotMgr = this.app?.multiBotManager;
        const targetArg = rest[0]; // e.g. @bot_username or botId
        const userBots = multiBotMgr?.getBotsForOwner(tgId) ?? [];

        if (userBots.length === 0) {
          await this.api.sendMessage(
            chatId,
            `<blockquote>♡ You don't have any active cloned bots to remove ♡\n\nTip: You can clone your own aesthetic bot in 60 seconds using <code>/clone</code>! ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        if (targetArg) {
          const cleanArg = targetArg.replace(/^@/, '').trim().toLowerCase();
          const matched = userBots.find((b) =>
            String(b.id) === cleanArg || b.bot_username?.toLowerCase() === cleanArg
          );

          if (matched) {
            await this.sm.reset(tgId, { reason: 'command' });
            const ctx = this.#ctx(tgId, { message }, { forceNew: true });
            const sent = await cloneScreen?.handle(ctx, 'delete_confirm', [matched.id]);
            updateScreenMsg(sent);
            return;
          } else {
            await this.api.sendMessage(
              chatId,
              `<blockquote>✕ Could not find a cloned bot matching <code>${escapeHtml(targetArg)}</code> owned by you ♡\nTip: Type <code>/rmbot</code> to choose from your active bots! ♡</blockquote>`,
              { parse_mode: 'HTML' }
            );
            return;
          }
        }

        await this.sm.reset(tgId, { reason: 'command' });
        const ctx = this.#ctx(tgId, { message }, { forceNew: true });
        if (userBots.length === 1) {
          const sent = await cloneScreen?.handle(ctx, 'delete_confirm', [userBots[0].id]);
          updateScreenMsg(sent);
        } else {
          const sent = await cloneScreen?.handle(ctx, 'rm_picker', []);
          updateScreenMsg(sent);
        }
        return;
      }

      if (command === '/lang' || command === '/language') {
        const dashboard = this.screens.get('dashboard');
        const sent = await dashboard?.handle?.(this.#ctx(tgId, { message }, { forceNew: true }), 'language', []);
        updateScreenMsg(sent);
        return;
      }

      if (command === '/start' || command === '/menu') {
        const startPayload = rest[0]?.trim();
        if (startPayload && /^play_/i.test(startPayload)) {
          const rawQuery = startPayload.replace(/^play_/i, '').replace(/_/g, ' ').trim();
          let cleanQuery = rawQuery;
          try { cleanQuery = decodeURIComponent(rawQuery); } catch {}
          if (cleanQuery) {
            await this.sm.reset(tgId, { reason: 'start_play' });
            const downloaderScreen = this.screens.get('downloader');
            await downloaderScreen?.executeDownload(this.#ctx(tgId, { message }, { forceNew: true }), cleanQuery);
            return;
          }
        }
        if (startPayload && /^lyrics_/i.test(startPayload)) {
          const rawQuery = startPayload.replace(/^lyrics_/i, '').replace(/_/g, ' ').trim();
          let cleanQuery = rawQuery;
          try { cleanQuery = decodeURIComponent(rawQuery); } catch {}
          if (cleanQuery) {
            await this.sm.reset(tgId, { reason: 'start_lyrics' });
            const downloaderScreen = this.screens.get('downloader');
            await downloaderScreen?.handle(this.#ctx(tgId, { message }, { forceNew: true }), 'lyrics', [cleanQuery]);
            return;
          }
        }
        if (startPayload && /^(?:dl_|grab_)/i.test(startPayload)) {
          const rawPayload = startPayload.replace(/^(?:dl_|grab_)/i, '').trim();
          let targetUrl = resolvePendingDownload(rawPayload, this.db);
          if (!targetUrl) {
            try { targetUrl = decodeURIComponent(rawPayload); } catch { targetUrl = rawPayload; }
          }
          if (targetUrl) {
            await this.sm.reset(tgId, { reason: 'start_dl' });
            const downloaderScreen = this.screens.get('downloader');
            await downloaderScreen?.executeDownload(this.#ctx(tgId, { message }, { forceNew: true }), targetUrl);
            return;
          }
        }
        if (startPayload && /^tt_/i.test(startPayload)) {
          const rawQuery = startPayload.replace(/^tt_/i, '').replace(/_/g, ' ').trim();
          let cleanQuery = rawQuery;
          try { cleanQuery = decodeURIComponent(rawQuery); } catch {}
          if (cleanQuery) {
            await this.sm.reset(tgId, { reason: 'start_tt' });
            const downloaderScreen = this.screens.get('downloader');
            await downloaderScreen?.executeTikTokSearch(this.#ctx(tgId, { message }, { forceNew: true }), cleanQuery);
            return;
          }
        }
        await this.sm.reset(tgId, { reason: 'start' });
        const dashboard = this.screens.get('dashboard');
        const sent = await dashboard?.open(this.#ctx(tgId, { message }, { forceNew: true }), { forceNew: true });
        updateScreenMsg(sent);
        return;
      }
      if (command === '/search' || command === '/pinterest' || command === '/pint') {
        const query = rest.join(' ').trim();
        // If explicit adult search query, route seamlessly to 18+ studio
        if (query && /\b(nsfw|18\+|hentai|porn|uncensored|lewd|r18|ecchi)\b/i.test(query)) {
          await this.sm.reset(tgId, { reason: 'command' });
          const nsfw = this.screens.get('nsfw');
          const ctx = this.#ctx(tgId, { message }, { forceNew: true });
          if (nsfw?.executeSearch) {
            const sent = await nsfw.executeSearch(ctx, query, 'all');
            updateScreenMsg(sent);
            return;
          }
        }
        await this.sm.reset(tgId, { reason: 'command' });
        const pinterest = this.screens.get('pinterest');
        const ctx = this.#ctx(tgId, { message }, { forceNew: true });
        if (query && pinterest?.executeSearch) {
          const sent = await pinterest.executeSearch(ctx, query);
          updateScreenMsg(sent);
        } else {
          const sent = await pinterest?.open(ctx);
          updateScreenMsg(sent);
        }
        return;
      }
      if (command === '/nsfw' || command === '/18+' || command === '/hentai' || command === '/adult' || command === '/ecchi' || command === '/r18' || command === '/porn') {
        const query = rest.join(' ').trim();
        await this.sm.reset(tgId, { reason: 'command' });
        const nsfw = this.screens.get('nsfw');
        const ctx = this.#ctx(tgId, { message }, { forceNew: true });
        if (query && nsfw?.executeSearch) {
          const sent = await nsfw.executeSearch(ctx, query, 'all');
          updateScreenMsg(sent);
        } else {
          const sent = await nsfw?.open(ctx);
          updateScreenMsg(sent);
        }
        return;
      }
      if (command === '/stickers') {
        await this.sm.reset(tgId, { reason: 'command' });
        const stickers = this.screens.get('stickers');
        const sent = await stickers?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/whatsapp') {
        await this.sm.reset(tgId, { reason: 'command' });
        const whatsapp = this.screens.get('whatsapp');
        const sent = await whatsapp?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/download' || command === '/dl' || command === '/grab' || command === '/music' || command === '/song' || command === '/play') {
        const replyMedia = extractMediaForMusicRecognition(message.reply_to_message);
        if (replyMedia && replyMedia.obj?.file_id) {
          const ctx = this.#ctx(tgId, { message });
          await this.handleAudioRecognition(ctx, replyMedia.obj, message.reply_to_message, replyMedia);
          return;
        }

        await this.sm.reset(tgId, { reason: 'command' });
        const downloaderScreen = this.screens.get('downloader');
        const isMusicCommand = command === '/play' || command === '/music' || command === '/song';
        const targetUrl = rest.find((arg) => /^https?:\/\//i.test(arg));
        if (targetUrl) {
          await downloaderScreen?.executeDownload(this.#ctx(tgId, { message }, { forceNew: true }), targetUrl);
        } else if (rest.length > 0 && isMusicCommand) {
          const query = rest.join(' ').trim();
          await downloaderScreen?.executeDownload(this.#ctx(tgId, { message }, { forceNew: true }), query);
        } else if (rest.length > 0 && !isMusicCommand) {
          await this.api.sendMessage(
            chatId,
            `୨୧ Please provide a valid media link starting with http:// or https:// ♡\n` +
            `Tip: To download media, use <code>/grab &lt;link&gt;</code> or <code>/download &lt;link&gt;</code> ♡\n` +
            `Tip: To search & play music, use <code>/play &lt;song name&gt;</code> ♡`,
            { parse_mode: 'HTML' }
          );
        } else {
          if (isMusicCommand) {
            const ctx = this.#ctx(tgId, { message }, { forceNew: true });
            const sent = await downloaderScreen?.handle(ctx, 'play', []);
            updateScreenMsg(sent);
          } else {
            const sent = await downloaderScreen?.open(this.#ctx(tgId, { message }, { forceNew: true }));
            updateScreenMsg(sent);
          }
        }
        return;
      }
      if (command === '/pfp' || command === '/matching' || command === '/matchingpfp' || command === '/couplepfp') {
        await this.sm.reset(tgId, { reason: 'command' });
        const downloaderScreen = this.screens.get('downloader');
        const query = rest.join(' ').trim();
        const ctx = this.#ctx(tgId, { message }, { forceNew: true });
        if (query) {
          const targetUrl = rest.find((arg) => /^https?:\/\//i.test(arg));
          if (targetUrl) {
            await downloaderScreen?.executeDownload(ctx, targetUrl);
          } else {
            await downloaderScreen?.executePfpSearch(ctx, query);
          }
        } else {
          const sent = await downloaderScreen?.handle(ctx, 'pfp_menu', []);
          updateScreenMsg(sent);
        }
        return;
      }
      if (command === '/recognize' || command === '/shazam' || command === '/identify') {
        const replyMedia = extractMediaForMusicRecognition(message.reply_to_message);
        if (replyMedia && replyMedia.obj?.file_id) {
          const ctx = this.#ctx(tgId, { message });
          await this.handleAudioRecognition(ctx, replyMedia.obj, message.reply_to_message, replyMedia);
          return;
        }
        await this.sm.reset(tgId, { reason: 'command' });
        const downloaderScreen = this.screens.get('downloader');
        const ctx = this.#ctx(tgId, { message }, { forceNew: true });
        const sent = await downloaderScreen?.handle(ctx, 'recognize', []);
        updateScreenMsg(sent);
        return;
      }
      if (command === '/lyrics') {
        const query = rest.join(' ').trim();
        if (!query) {
          const downloaderScreen = this.screens.get('downloader');
          if (downloaderScreen?.handle) {
            const ctx = this.#ctx(tgId, { message }, { forceNew: true });
            const sent = await downloaderScreen.handle(ctx, 'searchLyrics', []);
            updateScreenMsg(sent);
            return;
          }
          await this.api.sendMessage(chatId, '♡ Usage: `/lyrics <song title>` or `/lyrics <artist> - <song>` or `/lyrics <lyrics snippet>` ♡');
          return;
        }
        const downloaderScreen = this.screens.get('downloader');
        if (downloaderScreen?.executeLyricsSearch) {
          const ctx = this.#ctx(tgId, { message }, { forceNew: true });
          await downloaderScreen.executeLyricsSearch(ctx, query);
          return;
        }
        const lyricsRes = await getLyrics(query);
        if (lyricsRes.found && lyricsRes.lyrics) {
          const chunks = chunkLyrics(lyricsRes.lyrics, 2400);
          const total = chunks.length;

          for (let i = 0; i < total; i++) {
            const isFirst = i === 0;
            const header = total === 1
              ? `𓆩♡𓆪 <b>SONG LYRICS</b> 𓆩♡𓆪\n🎵 <b>${escapeHtml(lyricsRes.title)}</b>` + (lyricsRes.artist ? ` — <i>${escapeHtml(lyricsRes.artist)}</i>` : '') + ` ♡\n\n`
              : `𓆩♡𓆪 <b>SONG LYRICS (${i + 1}/${total})</b> 𓆩♡𓆪\n🎵 <b>${escapeHtml(lyricsRes.title)}</b>` + (lyricsRes.artist ? ` — <i>${escapeHtml(lyricsRes.artist)}</i>` : '') + ` ♡\n\n`;

            const blockquoteHtml = formatBlockquoteLyrics(chunks[i], { expandable: true });
            const messageHtml = `${header}${blockquoteHtml}`;

            try {
              await this.api.sendMessage(chatId, messageHtml, { parse_mode: 'HTML' });
            } catch {
              try {
                await this.api.sendMessage(chatId, `${header}<blockquote>${escapeHtml(chunks[i])}</blockquote>`, { parse_mode: 'HTML' });
              } catch {
                await this.api.sendMessage(chatId, `${header.replace(/<[^>]+>/g, '')}${chunks[i]}`);
              }
            }

            if (total > 1) await sleep(300);
          }
        } else {
          await this.api.sendMessage(
            chatId,
            `<blockquote>♡ Could not find lyrics for "<b>${escapeHtml(query)}</b>" ♡\nPlease check the spelling or send a longer lyric snippet!</blockquote>`,
            { parse_mode: 'HTML' }
          );
        }
        return;
      }
      if (command === '/settings') {
        await this.sm.reset(tgId, { reason: 'command' });
        const settingsScreen = this.screens.get('settings');
        const sent = await settingsScreen?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/ai') {
        await this.sm.reset(tgId, { reason: 'command' });
        const aiScreen = this.screens.get('ai');
        const sent = await aiScreen?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/cancel') {
        const state = this.sm.state(tgId);
        if (state !== States.IDLE) {
          await this.sm.cancel(tgId);
        }
        const dashboard = this.screens.get('dashboard');
        const sent = await dashboard?.open(this.#ctx(tgId, { message }, { forceNew: true }), { forceNew: true });
        updateScreenMsg(sent);
        return;
      }
      if (command === '/help' || command === '/commands' || command === '/cmds') {
        if (isGroup) {
          await this.handleCommandSuggestions(message, activePrefix);
          return;
        }
        const help = this.screens.get('help');
        const sent = await help?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/addadmin' || command === '/allocateadmin') {
        if (!this.isMainOwner(tgId)) {
          await this.api.sendMessage(chatId, '♡ Only the General Studio Owner can allocate new admins ♡');
          return;
        }
        const targetId = Number(rest[0]);
        if (!targetId || isNaN(targetId) || targetId <= 0) {
          await this.api.sendMessage(chatId, '♡ Usage: `/addadmin <Telegram_ID>`\nExample: `/addadmin 8831887192`');
          return;
        }
        let targetChat = null;
        try {
          targetChat = await this.api.getChat(targetId);
        } catch {}
        const firstName = targetChat?.first_name ?? '';
        const lastName = targetChat?.last_name ?? '';
        const username = targetChat?.username ? `@${targetChat.username}` : '';
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || `User ${targetId}`;

        const adminIds = [...new Set([...(this.settings.get('telegram.adminIds') ?? []).map(Number), targetId])];
        await this.settings.set('telegram.adminIds', adminIds);
        this.db.run(
          'INSERT INTO users (tg_id, username, first_name, last_name, is_admin, is_allowed) VALUES (?, ?, ?, ?, 1, 1) ON CONFLICT(tg_id) DO UPDATE SET is_admin = 1, is_allowed = 1, username = COALESCE(excluded.username, users.username), first_name = COALESCE(excluded.first_name, users.first_name), last_name = COALESCE(excluded.last_name, users.last_name)',
          targetId, targetChat?.username ?? null, firstName || null, lastName || null
        );
        await this.api.sendMessage(
          chatId,
          `𓆩♡𓆪 <b>ADMIN ALLOCATED</b> 𓆩♡𓆪\n<blockquote>👤 <b>Name:</b> ${escapeHtml(fullName)} ${username ? `(${escapeHtml(username)})` : ''}\n🆔 <b>ID:</b> <code>${targetId}</code>\n✓ Admin access enabled with private isolated workspace ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      if (command === '/deladmin' || command === '/removeadmin') {
        if (!this.isMainOwner(tgId)) {
          await this.api.sendMessage(chatId, '<blockquote>♡ Only the General Studio Owner can remove admins ♡</blockquote>', { parse_mode: 'HTML' });
          return;
        }
        const targetId = Number(rest[0]);
        if (!targetId || isNaN(targetId) || targetId <= 0) {
          await this.api.sendMessage(chatId, '<blockquote>♡ Usage: <code>/deladmin &lt;Telegram_ID&gt;</code>\nExample: <code>/deladmin 8831887192</code> ♡</blockquote>', { parse_mode: 'HTML' });
          return;
        }
        const adminIds = (this.settings.get('telegram.adminIds') ?? []).map(Number).filter((id) => id !== targetId);
        await this.settings.set('telegram.adminIds', adminIds);
        this.db.run('UPDATE users SET is_admin = 0 WHERE tg_id = ?', targetId);
        const userRow = this.db.get('SELECT username, first_name, last_name FROM users WHERE tg_id = ?', targetId);
        const name = [userRow?.first_name, userRow?.last_name].filter(Boolean).join(' ') || `User ${targetId}`;
        await this.api.sendMessage(chatId, `<blockquote>✓ Admin <b>${escapeHtml(name)}</b> (<code>${targetId}</code>) removed successfully ♡</blockquote>`, { parse_mode: 'HTML' });
        return;
      }
      if (command === '/admins') {
        if (!this.isMainOwner(tgId) && !(this.settings.get('telegram.adminIds') ?? []).map(Number).includes(Number(tgId))) {
          await this.api.sendMessage(chatId, '<blockquote>♡ Only studio administrators can view the team roster ♡</blockquote>', { parse_mode: 'HTML' });
          return;
        }
        const owners = (this.settings.get('general.ownerIds') ?? []).map(Number);
        const admins = (this.settings.get('telegram.adminIds') ?? []).map(Number);

        const formatUserLabel = (id) => {
          const row = this.db.get('SELECT username, first_name, last_name FROM users WHERE tg_id = ?', id);
          const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ');
          const handle = row?.username ? `@${row.username}` : '';
          const info = [name, handle].filter(Boolean).join(' ');
          return info ? `• <b>${escapeHtml(info)}</b> (<code>${id}</code>)` : `• <code>${id}</code>`;
        };

        const lines = [
          '𓆩♡𓆪 <b>LANCY TEAM ROSTER</b> 𓆩♡𓆪\n',
          '👑 <b>General Owner(s):</b>',
          ...owners.map((id) => `${formatUserLabel(id)} — Studio Owner`),
          '',
          '🎀 <b>Admins (Isolated Workspaces):</b>',
          ...(admins.length ? admins.map((id) => `${formatUserLabel(id)} — Admin Workspace`) : ['• <i>None currently allocated</i>']),
          '',
          '<blockquote>✨ Workspaces are 100% isolated per user ♡</blockquote>'
        ];
        await this.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
        return;
      }
      // Unknown command: silently ignore to keep chat clean
      return;
    }

    // Route to the state machine (flows handle text/photos/documents).
    try {
      const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
      const isPrivate = !isGroup;

      const replyMsgFrom = message.reply_to_message?.from;
      const isReplyToBot = Boolean(
        message.reply_to_message && (
          !replyMsgFrom ||
          replyMsgFrom.is_bot ||
          (this.api.me?.id && replyMsgFrom.id === this.api.me.id) ||
          (this.botUsername && replyMsgFrom.username?.toLowerCase() === this.botUsername.toLowerCase())
        )
      );
      const botUsername = (this.botUsername || this.api.me?.username || 'Lancy_easy_bot').replace(/^@/, '');
      const isTag = Boolean(
        /\blancy\b/i.test(text) ||
        (botUsername && new RegExp(`@?${botUsername}\\b`, 'i').test(text))
      );

      // Check if user uploaded/sent a video, audio file, or voice note for music recognition:
      const recMedia = extractMediaForMusicRecognition(message);
      if (recMedia && recMedia.obj?.file_id) {
        const currentState = this.sm.state(tgId);
        // Only recognize music if user is explicitly in the downloader or music input flow.
        // In group chats: interactive menu inputs REQUIRE replying to the bot or tagging the bot!
        const canListen = isPrivate || isReplyToBot || isTag;
        if (canListen && (currentState === States.URL_DOWNLOADER_INPUT || currentState === States.MUSIC_SEARCH_INPUT)) {
          const ctx = this.#ctx(tgId, { message }, { isGroup, isPrivate, isReplyToBot, isTag });
          await this.handleAudioRecognition(ctx, recMedia.obj, message, recMedia);
          return;
        }
      }

      // In DM (private chat): state inputs work directly without needing to quote or tag!
      // In Group Chat: interactive prompt input requires replying to the bot or tagging @bot
      // to avoid chat conflicts when group members talk with each other.
      const shouldHandleState = isPrivate || isReplyToBot || isTag;
      const ctx = this.#ctx(tgId, { message }, { isGroup, isPrivate, isReplyToBot, isTag });
      const handled = shouldHandleState ? await this.sm.handleMessage(tgId, { ...message, chatId }, ctx) : false;
      if (!handled) {
        if (text) {
          // Check if message is a reply to the bot's prompt cards in group or private chat:
          if (isReplyToBot || isPrivate) {
            const promptText = String(message.reply_to_message?.text || message.reply_to_message?.caption || '');
            if (isReplyToBot && /SEARCH SONG LYRICS|search any song lyrics/i.test(promptText)) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeLyricsSearch) {
                const dlCtx = this.#ctx(tgId, { message }, { forceNew: true });
                await downloaderScreen.executeLyricsSearch(dlCtx, text);
                return;
              }
            }
            if (isReplyToBot && /PLAY & DOWNLOAD MUSIC|how to play & download|Search Music Live|song title & artist/i.test(promptText)) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeDownload) {
                const dlCtx = this.#ctx(tgId, { message }, { forceNew: true });
                await downloaderScreen.executeDownload(dlCtx, text);
                return;
              }
            }
            if (isReplyToBot && /URL DOWNLOADER|valid media link/i.test(promptText)) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeDownload) {
                const dlCtx = this.#ctx(tgId, { message }, { forceNew: true });
                await downloaderScreen.executeDownload(dlCtx, text);
                return;
              }
            }
          }

          // Direct media / social link detection in DM or group:
          const urlMatch = text.match(/https?:\/\/[^\s]+/i);
          if (urlMatch) {
            const url = urlMatch[0];
            const isKnownMedia = /tiktok\.com|instagram\.com|pinterest\.com|pin\.it|youtube\.com|youtu\.be|twitter\.com|x\.com|facebook\.com|fb\.watch|reddit\.com|threads\.net|spotify\.com|capcut\.com|\.(mp4|webm|mov|jpg|jpeg|png|webp|mp3|m4a|wav)(\?|$)/i.test(url);
            if (isKnownMedia) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeDownload) {
                const dlCtx = this.#ctx(tgId, { message });
                await downloaderScreen.executeDownload(dlCtx, url);
                return;
              }
            }
          }

          // AI assistant: ONLY responds in private DM (never in group chat!)
          const enabled = this.settings.getForUser(Number(tgId), 'ai.assistantEnabled', true);
          if (isPrivate && enabled && this.app?.assistant) {
            const replyFrom = message.reply_to_message?.from;
            const isQuote = Boolean(
              message.reply_to_message && (
                !replyFrom ||
                replyFrom.is_bot ||
                (this.api.me?.id && replyFrom.id === this.api.me.id) ||
                (botUsername && replyFrom.username && replyFrom.username.toLowerCase() === botUsername.toLowerCase()) ||
                (replyFrom.id && replyFrom.id !== Number(tgId))
              )
            );
            const shouldReply = isQuote || isTag;
            if (shouldReply) {
              const aiCtx = this.#ctx(tgId, { message });
              await this.app.assistant.handleMessage({ ctx: aiCtx, message, text });
            }
          }
        }
      }
    } catch (error) {
      this.log.error({ err: error, tgId }, 'message handling failed');
      await this.api.sendMessage(chatId, friendly(error)).catch(() => {});
    }
  }

  async handleAudioRecognition(ctx, mediaObj, message, mediaInfo = null) {
    const chatId = ctx.chatId || message?.chat?.id;
    const tgId = ctx.tgId || String(message?.from?.id);
    const resolvedCtx = ctx.api ? ctx : this.#ctx(tgId, { message });

    // Reset pending input state so user is clean
    await this.sm.reset(tgId, { reason: 'audio_recognition_started' }).catch(() => {});

    const info = mediaInfo || extractMediaForMusicRecognition(message) || { label: 'media clip', type: 'audio' };
    const label = info.label || 'audio clip';

    const isForwarded = Boolean(
      message?.forward_date ||
      message?.forward_from ||
      message?.forward_from_chat ||
      message?.forward_sender_name ||
      message?.forward_origin
    );

    // 1. Guard against Telegram Bot API 20MB file limit
    if (mediaObj.file_size && mediaObj.file_size > 20 * 1024 * 1024) {
      await this.api.sendMessage(
        chatId,
        `✕ This ${label} is too large (${(mediaObj.file_size / (1024 * 1024)).toFixed(1)} MB) for Telegram Bot download (20 MB limit) ♡\n` +
        `Tip: Send a shorter clip under 20MB, record a voice note, or search by song name with /play ♡`
      );
      return;
    }

    let progressMsg = null;
    try {
      progressMsg = await this.api.sendMessage(
        chatId,
        isForwarded
          ? `🎧 Forwarded ${label} received! Listening and identifying song… ♡`
          : `🎧 ${label[0].toUpperCase() + label.slice(1)} received! Listening and identifying song… ♡`
      );
    } catch {}

    try {
      const fileInfo = await this.api.getFile(mediaObj.file_id);
      if (!fileInfo?.file_path) {
        if (progressMsg?.message_id) {
          await this.api.editMessageText(chatId, progressMsg.message_id, `✕ Could not retrieve ${label} from Telegram ♡`).catch(() => {});
        }
        return;
      }

      const buffer = await this.api.downloadFile(fileInfo.file_path);
      const ext = extname(fileInfo.file_path || '').replace(/^\./, '') || 'mp3';

      const rawTitle = mediaObj.title || mediaObj.file_name || '';
      const hintTitle = rawTitle && !/\.(mp4|mov|mp3|m4a|oga|ogg|wav)$/i.test(rawTitle) ? rawTitle : '';
      const hintPerformer = mediaObj.performer || '';

      const recResult = await recognizeAudio(buffer, {
        extension: ext,
        hintTitle,
        hintPerformer
      });

      if (recResult?.success && recResult.title) {
        const { title, artist } = recResult;

        const downloaderScreen = this.screens.get('downloader');
        if (downloaderScreen?.executeDownload) {
          const dlCtx = {
            ...resolvedCtx,
            messageId: progressMsg?.message_id,
            initialStage: `Identified: "${title}" by ${artist || 'Unknown'} ♡`
          };
          await downloaderScreen.executeDownload(dlCtx, `${title} ${artist || ''}`.trim());
          return;
        }
      } else {
        const failureMessage = recResult?.reason?.includes('audio track')
          ? `<blockquote>୨୧ No sound or audio track found in this ${label} ♡</blockquote>`
          : `<blockquote>୨୧ Could not recognize the music in this ${label} ♡\n\n` +
            `💡 <b>How Music Recognition Works:</b>\n` +
            `• Recognition matches <b>actual song recordings</b> playing on a speaker, radio, TV, or phone.\n` +
            `• Acoustic engines cannot match acapella voice humming without the original song track playing.\n\n` +
            `✨ <b>Know any words or lyrics?</b> Tap <b>🔍 Search by Lyrics</b> below or type <code>/play &lt;lyrics&gt;</code> to download it directly! ♡</blockquote>`;

        if (progressMsg?.message_id) {
          await this.api.editMessageText(
            chatId,
            progressMsg.message_id,
            failureMessage,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🔍 Search by Lyrics or Title', callback_data: 'l1:downloader:play', style: 'primary' },
                    { text: '« Menu', callback_data: 'l1:dashboard:open', style: 'primary' }
                  ]
                ]
              }
            }
          ).catch(() => {});
          if (typeof this.api.deleteMessage === 'function') {
            setTimeout(() => {
              this.api.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
            }, 15000)?.unref?.();
          }
        }
        await this.sm.reset(tgId, { reason: 'recognition_failed' }).catch(() => {});
      }
    } catch (err) {
      this.log.error({ err }, 'error during audio recognition');
      if (progressMsg?.message_id) {
        await this.api.editMessageText(
          chatId,
          progressMsg.message_id,
          `✕ Could not analyze this ${label}. Please try another snippet or search with /play ♡`
        ).catch(() => {});
      }
      await this.sm.reset(tgId, { reason: 'recognition_error' }).catch(() => {});
    }
  }

  createContext(tgId, source, opts = {}) {
    return this.#ctx(tgId, source, opts);
  }

  #ctx(tgId, source, opts = {}) {
    const isCallback = Boolean(source && (source.data !== undefined || (source.id && source.from)));
    const query = isCallback ? source : (source?.callback_query ?? null);
    const queryMessage = query?.message ?? null;
    const directMessage = !isCallback ? (source?.message ?? (source?.text !== undefined ? source : null)) : null;
    const message = queryMessage ?? directMessage ?? null;
    const chatId = queryMessage?.chat?.id ?? directMessage?.chat?.id ?? source?.chatId ?? Number(tgId);
    const messageId = queryMessage?.message_id ?? directMessage?.message_id ?? null;
    const isPagination = Boolean(opts.isPagination || source?.isPagination);
    const forceNew = !isPagination && Boolean(opts.forceNew || source?.forceNew);
    const fromMedia = !isPagination && Boolean(opts.fromMedia || source?.fromMedia || forceNew);

    const chatType = queryMessage?.chat?.type ?? directMessage?.chat?.type ?? message?.chat?.type ?? 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup' || Number(chatId) < 0;

    let userLang = 'en';
    try {
      const bu = this.db.get('SELECT language FROM bot_users WHERE bot_id = ? AND tg_id = ?', this.botContext?.botId ?? 0, Number(tgId));
      if (bu?.language) userLang = bu.language;
    } catch {}

    return {
      tgId,
      forceNew,
      fromMedia,
      isPagination,
      user: this.db.get('SELECT * FROM users WHERE tg_id = ?', Number(tgId)),
      chatId,
      chatType,
      isGroup,
      bot: this.botContext,
      botName: this.botContext?.botName || 'Lancy',
      botUsername: this.botUsername || this.botContext?.botUsername || 'Lancy_easy_bot',
      botId: this.botContext?.botId ?? 0,
      isClone: Boolean(this.botContext?.isClone),
      lang: userLang,
      t: (key, params) => t(userLang, key, params),
      messageId,
      message,
      query,
      controller: this,
      api: this.api,
      db: this.db,
      settings: {
        get: (path, fallback) => this.settings.getForUser(Number(tgId), path, fallback),
        set: (path, value) => this.settings.setForUser(Number(tgId), path, value),
        getAll: () => this.settings.getAllForUser(Number(tgId)),
        needsRestart: () => this.settings.needsRestart()
      },
      sm: this.sm,
      screens: this.screens,
      reply: (text, extra = {}) => this.api.sendMessage(chatId, text, extra),
      replyRich: (rich, extra = {}, files = null) => this.api.sendRichMessage(chatId, rich, extra, files),
      sendRichMessage: (rich, extra = {}, files = null) => this.api.sendRichMessage(chatId, rich, extra, files),
      editScreen: async (rich, extra = {}, files = null) => {
        const activeScreenMsgId = queryMessage?.message_id ||
          this.getScreenMsg(chatId, tgId)?.messageId ||
          (!isGroup ? (this.sm?.for(tgId)?.screenMessageId || this.sm?.context?.(tgId)?.screenMessageId) : null);

        const isTargetMedia = !isPagination && Boolean(
          (activeScreenMsgId && this.isMediaDeliveryMessageId(activeScreenMsgId)) ||
          (queryMessage && this.isMediaDeliveryMessage(queryMessage)) ||
          (queryMessage?.message_id && this.isMediaDeliveryMessageId(queryMessage.message_id))
        );

        const isMediaDelivery = fromMedia || forceNew || isTargetMedia;

        // If fromMedia, forceNew, navigating away from a delivered media message, or no existing screen message:
        // send a fresh rich message so the user never loses their video, photo, or audio!
        if (isMediaDelivery || !activeScreenMsgId) {
          const sendExtra = (isGroup && directMessage?.message_id && !extra?.reply_to_message_id)
            ? { ...extra, reply_to_message_id: directMessage.message_id, allow_sending_without_reply: true }
            : extra;
          const sent = await this.api.sendRichMessage(chatId, rich, sendExtra, files);
          if (sent?.message_id) {
            this.setScreenMsg(chatId, tgId, sent.message_id);
            this.sm?.update?.(tgId, { screenMessageId: sent.message_id });
            if (!this.botContext?.isClone) {
              this.db.run(
                'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
                sent.message_id, Number(tgId)
              );
            }
          }
          return sent;
        }

        // When we have an active screen message, edit in-place or cleanly replace:
        const targetMsgId = activeScreenMsgId;
        const targetChatId = chatId;

        try {
          const res = await this.api.editMessageRich(targetChatId, targetMsgId, rich, extra, files);
          this.setScreenMsg(targetChatId, tgId, targetMsgId);
          this.sm?.update?.(tgId, { screenMessageId: targetMsgId });
          return res ?? { message_id: targetMsgId };
        } catch (error) {
          const errMsg = String(error?.description ?? error?.message);
          if (/not modified/i.test(errMsg)) {
            return { message_id: targetMsgId };
          }
          const sent = await this.api.sendRichMessage(targetChatId, rich, extra, files);
          if (sent?.message_id) {
            if (targetMsgId && sent.message_id !== targetMsgId) {
              await this.api.call?.('deleteMessage', { chat_id: targetChatId, message_id: targetMsgId })?.catch?.(() => {});
            }
            this.setScreenMsg(targetChatId, tgId, sent.message_id);
            this.sm?.update?.(tgId, { screenMessageId: sent.message_id });
            if (!this.botContext?.isClone) {
              this.db.run(
                'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
                sent.message_id, Number(tgId)
              );
            }
          }
          return sent;
        }
      },
    };
  }

  async handleHideTag(message, rest = [], command = '/hidetag') {
    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
    const chatId = message.chat.id;
    const tgId = String(message.from?.id);

    if (!isGroup) {
      await this.api.sendMessage(
        chatId,
        `<blockquote>📢 This command is only available in group chats! ♡</blockquote>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // 1. Check permissions: caller must be group creator/administrator or bot owner
    let isAuthorized = this.isOwner(tgId);
    if (!isAuthorized) {
      try {
        const member = await this.api.getChatMember(chatId, Number(tgId));
        if (member && (member.status === 'creator' || member.status === 'administrator')) {
          isAuthorized = true;
        }
      } catch (err) {
        this.log.warn({ err, chatId, tgId }, 'getChatMember failed, trying getChatAdministrators fallback');
        try {
          const admins = await this.api.getChatAdministrators(chatId);
          if (Array.isArray(admins) && admins.some((a) => Number(a?.user?.id) === Number(tgId))) {
            isAuthorized = true;
          }
        } catch {}
      }
    }

    if (!isAuthorized) {
      const notice = await this.api.sendMessage(
        chatId,
        `<blockquote>✕ Only group administrators can use this command ♡</blockquote>`,
        { parse_mode: 'HTML', reply_to_message_id: message.message_id }
      );
      if (notice?.message_id && typeof this.api.deleteMessage === 'function') {
        setTimeout(() => {
          this.api.deleteMessage(chatId, notice.message_id).catch(() => {});
        }, 8000)?.unref?.();
      }
      return;
    }

    // Try deleting the trigger command message to keep the chat clean
    if (typeof this.api.deleteMessage === 'function') {
      this.api.deleteMessage(chatId, message.message_id).catch(() => {});
    }

    // 2. Discover members (regular active chat members prioritized first!)
    const userMap = new Map();
    const botId = this.api.me?.id ? Number(this.api.me.id) : null;

    // 2a. Fetch all recorded group members from database first
    try {
      const dbMembers = this.db.getGroupMembers(chatId);
      if (Array.isArray(dbMembers)) {
        for (const m of dbMembers) {
          const uid = Number(m.user_id);
          if (uid && uid !== botId && !userMap.has(uid)) {
            userMap.set(uid, {
              id: uid,
              name: m.first_name || 'Member',
              username: m.username || null
            });
          }
        }
      }
    } catch (err) {
      this.log.warn({ err, chatId }, 'failed to get db members for /hidetag');
    }

    // 2b. Fetch live group administrators
    try {
      const admins = await this.api.getChatAdministrators(chatId);
      if (Array.isArray(admins)) {
        for (const admin of admins) {
          if (admin?.user && !admin.user.is_bot) {
            const uid = Number(admin.user.id);
            if (uid !== botId && !userMap.has(uid)) {
              userMap.set(uid, {
                id: uid,
                name: admin.user.first_name || 'Member',
                username: admin.user.username || null
              });
            }
            this.db.recordGroupMember(chatId, admin.user);
          }
        }
      }
    } catch (err) {
      this.log.warn({ err, chatId }, 'failed to get chat administrators for /hidetag');
    }

    // Also record message.from and replied message's author
    if (message.from && !message.from.is_bot) {
      const uid = Number(message.from.id);
      if (uid !== botId && !userMap.has(uid)) {
        userMap.set(uid, {
          id: uid,
          name: message.from.first_name || 'Member',
          username: message.from.username || null
        });
      }
      this.db.recordGroupMember(chatId, message.from);
    }
    if (message.reply_to_message?.from && !message.reply_to_message.from.is_bot) {
      const repUser = message.reply_to_message.from;
      const repId = Number(repUser.id);
      if (repId !== botId && !userMap.has(repId)) {
        userMap.set(repId, {
          id: repId,
          name: repUser.first_name || 'Member',
          username: repUser.username || null
        });
      }
      this.db.recordGroupMember(chatId, repUser);
    }

    // 3. Determine announcement text and options (ALWAYS invisible by default - NO listing mentions!)
    const isVisible = rest.includes('-v') || rest.includes('--visible');
    const shouldPin = rest.some((arg) => /^(?:pin|--pin|-p)$/i.test(arg));
    const cleanArgs = rest.filter((a) => !/^(?:pin|--pin|-p|-v|--visible)$/i.test(a));
    const customText = cleanArgs.join(' ').trim();

    let bodyText = '';
    if (customText) {
      bodyText = escapeHtml(customText);
    } else if (message.reply_to_message) {
      bodyText = '📢 <b>Attention everyone!</b> ♡';
    } else {
      bodyText = '📢 <b>Attention everyone!</b> ♡';
    }

    // 4. Build single message payload
    // Telegram Bot API allows up to 100 entities and 4096 characters per message.
    // The first batch (up to 80 members) is attached directly to the main message.
    const allMembers = Array.from(userMap.values());
    const mainBatch = allMembers.slice(0, 80);
    const remainingMembers = allMembers.slice(80);
    let finalHtml = '';

    if (isVisible) {
      const visibleTags = mainBatch
        .map((m) => m.username ? `@${m.username}` : `<a href="tg://user?id=${m.id}">${escapeHtml(m.name || 'Member')}</a>`)
        .join(' ');
      finalHtml = bodyText ? `${bodyText}\n\n${visibleTags}` : visibleTags;
    } else {
      const maxChars = 4000;
      let remainingBudget = maxChars - bodyText.length;
      let zeroWidthMentions = '';

      for (const member of mainBatch) {
        // Use Hangul Filler U+3164 for 100% reliable invisible mention across all Telegram clients
        const tag = `<a href="tg://user?id=${member.id}">\u3164</a>`;
        if (tag.length > remainingBudget) break;
        zeroWidthMentions += tag;
        remainingBudget -= tag.length;
      }

      finalHtml = `${bodyText}${zeroWidthMentions}`;
    }

    const sendOptions = {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    };

    if (message.reply_to_message?.message_id) {
      sendOptions.reply_to_message_id = message.reply_to_message.message_id;
    }

    let sent = null;
    try {
      sent = await this.api.sendMessage(chatId, finalHtml, sendOptions);
    } catch (err) {
      this.log.error({ err, chatId }, 'failed to send hidetag message');
      try {
        sent = await this.api.sendMessage(chatId, bodyText, sendOptions);
      } catch (fbErr) {
        this.log.error({ fbErr, chatId }, 'fallback hidetag sendMessage failed');
      }
    }

    // If requested, pin the announcement with notification enabled so ALL members (even 2k+) get alerted
    if (sent?.message_id && shouldPin && typeof this.api.pinChatMessage === 'function') {
      try {
        await this.api.pinChatMessage(chatId, sent.message_id, { disableNotification: false });
      } catch (pinErr) {
        this.log.warn({ pinErr, chatId }, 'failed to pin hidetag message');
      }
    }

    // 5. Large group ghost-tagging: If there are more than 80 members (up to 2k+),
    // silently tag them in quick background batches that auto-delete after delivering pings,
    // leaving ONLY the one single announcement message visible on screen!
    if (remainingMembers.length > 0 && sent?.message_id && !isVisible) {
      const ghostBatches = [];
      for (let i = 0; i < remainingMembers.length; i += 75) {
        ghostBatches.push(remainingMembers.slice(i, i + 75));
      }

      (async () => {
        for (const batch of ghostBatches) {
          try {
            await sleep(2000); // Respect Telegram 20 msg/min group rate limit
            const ghostTags = batch.map((m) => `<a href="tg://user?id=${m.id}">\u3164</a>`).join('');
            const ghostMsg = await this.api.sendMessage(
              chatId,
              `📢 ${ghostTags}`,
              {
                parse_mode: 'HTML',
                reply_to_message_id: sent.message_id,
                link_preview_options: { is_disabled: true }
              }
            );
            if (ghostMsg?.message_id && typeof this.api.deleteMessage === 'function') {
              await sleep(1500);
              await this.api.deleteMessage(chatId, ghostMsg.message_id).catch(() => {});
            }
          } catch (batchErr) {
            this.log.warn({ batchErr, chatId }, 'ghost tag batch failed');
          }
        }
      })().catch(() => {});
    }
  }

  async handleGameCommand(message, rest = []) {
    const chatId = message.chat.id;
    const subCmd = rest[0]?.toLowerCase()?.trim();

    if (subCmd === 'stop' || subCmd === 'end') {
      const res = await this.gameEngine.stopGame(chatId, { user: message.from });
      if (!res.ok) {
        const b = new RichMessageBuilder();
        b.blockquote(res.error);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    if (subCmd === 'skip' || subCmd === 'next') {
      const res = await this.gameEngine.skipRound(chatId, { user: message.from });
      if (!res.ok) {
        const b = new RichMessageBuilder();
        b.blockquote(res.error);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    if (subCmd === 'hint' || subCmd === 'clue') {
      const res = await this.gameEngine.giveHint(chatId, { user: message.from });
      if (!res.ok) {
        const b = new RichMessageBuilder();
        b.blockquote(res.error);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    if (subCmd === 'top' || subCmd === 'leaderboard' || subCmd === 'global' || subCmd === 'streaks') {
      const scope = subCmd === 'global' ? 'global' : subCmd === 'streaks' ? 'streaks' : 'group';
      await this.handleGameLeaderboard(message, scope);
      return;
    }

    if (subCmd === 'pokedex' || subCmd === 'dex') {
      const richDex = this.gameEngine.buildUserPokedexRich(chatId, message.from);
      await this.api.sendRichMessage(chatId, richDex).catch(() => {});
      return;
    }

    if (subCmd === 'maxmiss' || subCmd === 'miss' || subCmd === 'autostop' || subCmd === 'fail') {
      const val = Number(rest[1]);
      if (!Number.isFinite(val) || val < 1 || val > 25) {
        const b = new RichMessageBuilder();
        b.blockquote(`🛑 Current auto-stop limit: ${this.gameEngine.getPreferredMaxMiss(chatId)} unanswered rounds.\nUsage: /game maxmiss <1-25> (default: 5)`);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
        return;
      }
      const updated = this.gameEngine.setPreferredMaxMiss(chatId, val);
      const b = new RichMessageBuilder();
      b.blockquote(`✅ Auto-stop unanswered limit updated to ${updated} missed rounds!`);
      await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      return;
    }

    if (subCmd === 'unlimited' || subCmd === 'inf' || subCmd === 'infinite') {
      this.gameEngine.setPreferredRounds(chatId, 0);
      const richHub = this.gameEngine.buildHubRichMessage(chatId, 'visual');
      await this.api.sendRichMessage(chatId, richHub).catch(() => {});
      return;
    }

    if (subCmd === 'afro' || subCmd === 'naija' || subCmd === 'afrobeats') {
      this.gameEngine.setPreferredMusicCategory(chatId, 'afro');
      const res = await this.gameEngine.startGame(chatId, {
        mode: 'song',
        musicCategory: 'afro',
        startedBy: message.from
      });
      if (!res.ok) {
        const b = new RichMessageBuilder();
        b.blockquote(res.error);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    const directModes = [
      'pokemon', 'poke', 'pkmn', 'pokeworld', 'whosthatpokemon', 'pksilhouette',
      'pokebattle', 'pokeduel', 'pkduel',
      'wordgrid', 'wgrid', 'wordsearch', 'tilegrid', 'picgrid',
      'flags', 'flag', 'cars', 'car', 'logos', 'logo', 'icons', 'icon', 'logomix',
      'characters', 'character', 'anime', 'silhouette', 'whosthat',
      'song', 'music', 'audio', 'beat',
      'grid', 'gridquiz', 'picture', 'pic', 'photo', 'blur',
      'emoji', 'emojis', 'scramble', 'word', 'anagram',
      'riddle', 'riddles', 'teaser', 'trivia', 'quiz', 'poll', 'ai',
      'lyric', 'lyrics', 'quote', 'daily', 'challenge', 'mixed',
      'ttt', 'tictactoe', 'xo', 'connect4', 'c4',
      'rps', 'rockpaperscissors', 'number', 'vault', 'highlow', 'hl'
    ];

    if (subCmd && directModes.includes(subCmd)) {
      const modeAliasMap = {
        car: 'cars',
        cars: 'cars',
        logo: 'logos',
        logos: 'logos',
        icon: 'icons',
        icons: 'icons',
        logomix: 'logomix',
        flag: 'flags',
        flags: 'flags',
        characters: 'anime',
        character: 'anime',
        whosthat: 'anime',
        poke: 'pokemon',
        pkmn: 'pokemon',
        pokeworld: 'pokemon',
        pksilhouette: 'whosthatpokemon',
        pokeduel: 'pokebattle',
        pkduel: 'pokebattle',
        wgrid: 'wordgrid',
        wordsearch: 'wordgrid',
        music: 'song',
        audio: 'song',
        beat: 'song',
        gridquiz: 'grid',
        pic: 'picture',
        photo: 'picture',
        blur: 'picture',
        emojis: 'emoji',
        word: 'scramble',
        anagram: 'scramble',
        riddles: 'riddles',
        riddle: 'riddles',
        teaser: 'riddles',
        quiz: 'trivia',
        poll: 'trivia',
        ai: 'trivia',
        lyric: 'lyrics',
        quote: 'lyrics',
        challenge: 'daily',
        tictactoe: 'ttt',
        xo: 'ttt',
        c4: 'connect4',
        rockpaperscissors: 'rps',
        vault: 'number',
        hl: 'highlow'
      };
      const resolvedMode = modeAliasMap[subCmd] || subCmd;

      const arg1 = String(rest[1] || '').toLowerCase().trim();
      const musicCatMap = {
        afro: 'afro', naija: 'afro', afrobeats: 'afro', ng: 'afro',
        pop: 'pop', global: 'pop',
        rap: 'rap', hiphop: 'rap', rnb: 'rap',
        all: 'all', mix: 'all'
      };
      const musicCatArg = musicCatMap[arg1] || null;
      if (musicCatArg) {
        this.gameEngine.setPreferredMusicCategory(chatId, musicCatArg);
      }
      const roundsArg = musicCatArg ? String(rest[2] || '').toLowerCase().trim() : arg1;
      const rounds = (roundsArg === 'unlimited' || roundsArg === 'inf' || roundsArg === '0')
        ? 0
        : (Number.isFinite(Number(roundsArg)) && Number(roundsArg) > 0 ? Number(roundsArg) : null);
      const arg2Num = Number(musicCatArg ? rest[3] : rest[2]);
      const maxUnanswered = Number.isFinite(arg2Num) && arg2Num >= 1 ? arg2Num : null;
      const difficulty = (!maxUnanswered && !musicCatArg && rest[2]) ? rest[2] : 'ALL';

      const res = await this.gameEngine.startGame(chatId, {
        mode: resolvedMode,
        totalRounds: rounds,
        maxUnanswered,
        difficulty,
        musicCategory: musicCatArg || undefined,
        startedBy: message.from
      });

      if (!res.ok) {
        const b = new RichMessageBuilder();
        b.blockquote(res.error);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    // Default: Open the 100% Bot API 10.3 Rich Message 4-Tab Game Hub!
    const tabMap = { visual: 'visual', mind: 'mind', pvp: 'pvp', board: 'pvp' };
    const initialTab = tabMap[subCmd] || 'visual';
    const richHub = this.gameEngine.buildHubRichMessage(chatId, initialTab);
    if (typeof this.api.sendRichMessage === 'function') {
      await this.api.sendRichMessage(chatId, richHub).catch((err) => {
        this.log.error?.({ err, chatId }, 'failed to send game hub rich message');
      });
    } else if (typeof this.api.sendMessage === 'function') {
      const inlineKeyboard = [];
      for (const block of richHub?.blocks || []) {
        if (block.type === 'buttons' && Array.isArray(block.buttons)) {
          inlineKeyboard.push(
            block.buttons.map((b) => ({
              text: typeof b.text === 'string' ? b.text : (Array.isArray(b.text) ? b.text.map(t => typeof t === 'string' ? t : (t?.text || '')).join('') : String(b.text || '')),
              callback_data: b.callback_data
            }))
          );
        }
      }
      await this.api.sendMessage(chatId, '🎮 *LANCY GAME ARENA*\n\nChoose your game:', {
        reply_markup: { inline_keyboard: inlineKeyboard.length > 0 ? inlineKeyboard : [[{ text: '🎮 Play', callback_data: 'game_start:mixed' }]] }
      }).catch(() => {});
    }
  }

  async handleGameLeaderboard(message, scope = 'group') {
    const chatId = message.chat.id;
    const richLb = this.gameEngine.buildLeaderboardRichMessage(chatId, scope);
    if (typeof this.api.sendRichMessage === 'function') {
      await this.api.sendRichMessage(chatId, richLb).catch((err) => {
        this.log.error?.({ err, chatId }, 'failed to send game leaderboard rich message');
      });
    } else if (typeof this.api.sendMessage === 'function') {
      await this.api.sendMessage(chatId, '🏆 *GAME ARENA LEADERBOARD*\n\nTop Players:', {
        reply_markup: richLb?.reply_markup
      }).catch(() => {});
    }
  }

  async handleGameCallback(query) {
    await this.gameEngine.handleCallback(query);
  }

  // ── Smart Dual-Tier Force-Join System (Main Owner + Cloner) ──

  #registerForceJoinStateHandler() {
    if (!this.sm?.register) return;
    this.sm.register(States.FORCE_JOIN_ADD_INPUT, {
      onMessage: async (sctx, message) => {
        const chatId = message?.chat?.id || sctx.chatId;
        const userId = message?.from?.id || sctx.tgId;
        const scope = String(sctx.context?.scope || sctx.scope || (this.botContext?.isClone ? this.botContext.botId : 'global'));
        const isGlobal = scope === 'global';
        const targetBotId = isGlobal ? 0 : Number(scope);

        // Verify permission
        const mainBotUsername = this.botContext?.mainBotUsername || 'Lancy_easy_bot';
        let targetApi = this.api;
        let targetBotUsername = this.botContext?.botUsername || 'Lancy_easy_bot';

        if (isGlobal) {
          if (!this.isMainOwner(userId)) {
            await this.sm.reset(userId);
            return true;
          }
          targetApi = this.mainApi || this.api;
          targetBotUsername = mainBotUsername;
        } else {
          const botRec = this.db?.get('SELECT * FROM cloned_bots WHERE id = ?', targetBotId);
          if (!botRec || (String(botRec.owner_tg_id) !== String(userId) && !this.isMainOwner(userId))) {
            await this.sm.reset(userId);
            return true;
          }
          if (this.botContext?.isClone && Number(this.botContext?.botId) === targetBotId) {
            targetApi = this.api;
            targetBotUsername = this.botContext.botUsername || botRec.bot_username || 'bot';
          } else {
            const instance = this.multiBotManager?.instances?.get(targetBotId);
            targetApi = instance?.api || this.api;
            targetBotUsername = botRec.bot_username || 'bot';
          }
        }

        const rawText = String(message?.text || message?.caption || '').trim();
        const forwardedChat = message?.forward_origin?.chat || message?.forward_from_chat || null;

        try {
          const { entry } = await resolveAndAddForceJoinChannel({
            db: this.db,
            api: targetApi,
            rawInput: rawText,
            forwardedChat,
            isGlobal,
            botId: targetBotId,
            botUsername: targetBotUsername
          });

          await this.sm.reset(userId);

          const confirmB = new RichMessageBuilder();
          confirmB.blockquote(
            `✅ Added "${entry.title}" (${entry.username ? `@${entry.username}` : entry.id}) to ${
              isGlobal ? 'Global Network Force-Join' : `@${targetBotUsername} Force-Join`
            }!`
          );
          await this.api.sendRichMessage(chatId, confirmB.toJSON()).catch(() => {});

          const panel = buildForceJoinManagerRich({
            db: this.db,
            isGlobal,
            botId: targetBotId,
            botUsername: targetBotUsername,
            mainBotUsername,
            canManageGlobal: this.isMainOwner(userId)
          });
          await this.api.sendRichMessage(chatId, panel).catch(() => {});
        } catch (err) {
          const errB = new RichMessageBuilder();
          errB.blockquote(`⚠️ ${err?.message || 'Failed to add channel.'}\n\nSend another @channel / ID / forwarded message, or tap Cancel below.`);
          errB.buttons([
            richButton.callback('« Back to Force-Join', `fj_open:${scope}`)
          ]);
          await this.api.sendRichMessage(chatId, errB.toJSON()).catch(() => {});
        }
        return true;
      }
    });
  }

  async #enforceForceJoin(fromUser, chatId, { message = null, query = null } = {}) {
    if (!fromUser?.id || !chatId) return true;

    // Force join is STRICTLY for private DM chats only — NEVER for group chats (gc)!
    const chatType = query?.message?.chat?.type ?? message?.chat?.type;
    const isGroup = (chatType === 'group' || chatType === 'supergroup') || Number(chatId) < 0;
    if (isGroup) {
      return true;
    }

    // Never block the Main Owner or the Owner of this Cloned Bot so they can always manage their bot!
    if (this.isOwner(fromUser.id)) return true;

    try {
      const res = await checkUserForceJoin({
        db: this.db,
        mainApi: this.mainApi || this.api,
        botApi: this.api,
        isClone: Boolean(this.botContext?.isClone),
        botId: Number(this.botContext?.botId || 0),
        userId: fromUser.id
      });

      if (res.ok) return true;

      const gateRich = buildForceJoinGateRich({
        botName: this.botName || 'Lancy',
        missing: res.missing
      });

      if (query) {
        await this.api.answerCallbackQuery(query.id, {
          text: '🔒 Please join our required channel(s) first to unlock the bot!',
          show_alert: true
        }).catch(() => {});
      }

      await this.api.sendRichMessage(chatId, gateRich).catch(() => {});
      return false;
    } catch (err) {
      this.log.warn?.({ err, userId: fromUser.id }, 'force join check error (failing open)');
      return true;
    }
  }

  async handleForceJoinCommand(message, rest = []) {
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    if (!chatId || !userId) return;

    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup') || Number(chatId) < 0;
    if (isGroup) {
      await this.api.sendMessage(
        chatId,
        `<blockquote>🌸 The <b>FORCEJOIN</b> feature is only available in private DM with the bot ♡</blockquote>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    const isMain = this.isMainOwner(userId);
    const isCloneBot = Boolean(this.botContext?.isClone);
    const cloneOwnerId = Number(this.botContext?.ownerId || this.botContext?.ownerTgId || 0);
    const isThisCloneOwner = isCloneBot && cloneOwnerId > 0 && cloneOwnerId === Number(userId);

    // Check if user owns any cloned bots even when messaging main bot
    const ownedClones = this.db?.all(
      "SELECT * FROM cloned_bots WHERE owner_tg_id = ? AND status != 'deleted' ORDER BY id DESC",
      String(userId)
    ) || [];

    if (!isMain && !isThisCloneOwner && ownedClones.length === 0) {
      const b = new RichMessageBuilder();
      b.blockquote('🔒 Only the Bot Owner or Cloned Bot Owners can configure Force-Join channels!\nClone your own bot with /clone to set up your own Force-Join channel ♡');
      await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      return;
    }

    const sub = String(rest[0] || '').toLowerCase().trim();
    const isGlobalScope = isMain && (!isCloneBot || sub === 'global' || sub === 'main');
    const targetBotId = isGlobalScope
      ? 0
      : (isCloneBot ? Number(this.botContext.botId) : Number(ownedClones[0]?.id || 0));
    const targetBotUsername = isGlobalScope
      ? (this.botContext?.mainBotUsername || this.botContext?.botUsername || 'Lancy_easy_bot')
      : (isCloneBot ? this.botContext.botUsername : (ownedClones[0]?.bot_username || 'bot'));
    const mainBotUsername = this.botContext?.mainBotUsername || 'Lancy_easy_bot';

    if (sub === 'add' && rest[1]) {
      try {
        const targetApi = isGlobalScope ? (this.mainApi || this.api) : this.api;
        const { entry } = await resolveAndAddForceJoinChannel({
          db: this.db,
          api: targetApi,
          rawInput: rest.slice(1).join(' '),
          isGlobal: isGlobalScope,
          botId: targetBotId,
          botUsername: targetBotUsername
        });
        const b = new RichMessageBuilder();
        b.blockquote(`✅ Added "${entry.title}" to ${isGlobalScope ? 'Global Network' : `@${targetBotUsername}`} Force-Join!`);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      } catch (err) {
        const b = new RichMessageBuilder();
        b.blockquote(`⚠️ ${err?.message || 'Could not add channel.'}`);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
        return;
      }
    } else if ((sub === 'remove' || sub === 'del' || sub === 'delete') && rest[1]) {
      removeForceJoinChannel({
        db: this.db,
        chatIdToRemove: rest[1],
        isGlobal: isGlobalScope,
        botId: targetBotId
      });
    } else if (sub === 'clear') {
      if (isGlobalScope) setGlobalForceJoinChannels(this.db, []);
      else setCloneForceJoinChannels(this.db, targetBotId, []);
    }

    const panel = buildForceJoinManagerRich({
      db: this.db,
      isGlobal: isGlobalScope,
      botId: targetBotId,
      botUsername: targetBotUsername,
      mainBotUsername,
      canManageGlobal: isMain
    });
    await this.api.sendRichMessage(chatId, panel).catch(() => {});
  }

  async handleForceJoinCallback(query) {
    const data = String(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const userId = query.from?.id;
    if (!chatId || !userId) return;

    if (data === 'fj_verify') {
      const res = await checkUserForceJoin({
        db: this.db,
        mainApi: this.mainApi || this.api,
        botApi: this.api,
        isClone: Boolean(this.botContext?.isClone),
        botId: Number(this.botContext?.botId || 0),
        userId,
        bypassCache: true
      });

      if (res.ok) {
        await this.api.answerCallbackQuery(query.id, {
          text: '🎉 Verified! Welcome in — all bot features are now unlocked ♡',
          show_alert: true
        }).catch(() => {});
        if (messageId) {
          await this.api.deleteMessage(chatId, messageId).catch(() => {});
        }
        const b = new RichMessageBuilder();
        b.heading('🎉 VERIFICATION COMPLETE', 1);
        b.paragraph(rt.bold(`Thank you for joining! You now have full access to ${this.botName || 'Lancy'} ♡`));
        b.buttons([
          richButton.callback('🏠 Open Dashboard', 'l1:dashboard:open', { style: 'success' }),
          richButton.callback('🎮 Play Games', 'game_hub:visual', { style: 'primary' })
        ]);
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      } else {
        const missingNames = res.missing.map((c) => c.title).join(', ');
        await this.api.answerCallbackQuery(query.id, {
          text: `❌ You haven't joined: ${missingNames}. Please join first and tap Verify again!`,
          show_alert: true
        }).catch(() => {});
        const gateRich = buildForceJoinGateRich({
          botName: this.botName || 'Lancy',
          missing: res.missing
        });
        if (messageId) {
          await this.api.editMessageRich(chatId, messageId, gateRich).catch(() => {});
        }
      }
      return;
    }

    const parts = data.split(':');
    const action = parts[0];
    const scope = parts[1] || (this.botContext?.isClone ? String(this.botContext.botId) : 'global');
    const isGlobal = scope === 'global';
    const targetBotId = isGlobal ? 0 : Number(scope);
    const mainBotUsername = this.botContext?.mainBotUsername || 'Lancy_easy_bot';

    // Permission check for management callbacks
    let targetBotUsername = this.botContext?.botUsername || 'Lancy_easy_bot';
    if (isGlobal) {
      if (!this.isMainOwner(userId)) {
        await this.api.answerCallbackQuery(query.id, {
          text: '🔒 Only the Main Bot Owner can manage Global Force-Join!',
          show_alert: true
        }).catch(() => {});
        return;
      }
      targetBotUsername = mainBotUsername;
    } else {
      const botRec = this.db?.get('SELECT * FROM cloned_bots WHERE id = ?', targetBotId);
      if (!botRec || (String(botRec.owner_tg_id) !== String(userId) && !this.isMainOwner(userId))) {
        await this.api.answerCallbackQuery(query.id, {
          text: '🔒 Only the owner of this cloned bot can manage its Force-Join channels!',
          show_alert: true
        }).catch(() => {});
        return;
      }
      targetBotUsername = botRec.bot_username || targetBotUsername;
    }

    // Reset state if opening/modifying force join panel
    await this.sm.reset(userId).catch(() => {});

    if (action === 'fj_open') {
      await this.api.answerCallbackQuery(query.id).catch(() => {});
      const panel = buildForceJoinManagerRich({
        db: this.db,
        isGlobal,
        botId: targetBotId,
        botUsername: targetBotUsername,
        mainBotUsername,
        canManageGlobal: this.isMainOwner(userId)
      });
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, panel).catch(async () => {
          await this.api.sendRichMessage(chatId, panel).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, panel).catch(() => {});
      }
      return;
    }

    if (action === 'fj_add') {
      await this.api.answerCallbackQuery(query.id).catch(() => {});
      await this.sm.transition(userId, States.FORCE_JOIN_ADD_INPUT, {
        context: { scope },
        chatId,
        screenMessageId: messageId
      });

      const b = new RichMessageBuilder();
      b.heading(isGlobal ? '➕ ADD GLOBAL FORCE-JOIN CHANNEL' : `➕ ADD CHANNEL FOR @${targetBotUsername.toUpperCase()}`, 2);
      b.blockquote(
        `Step 1: Add @${targetBotUsername} as an Admin in your Channel or Group.\n` +
        `Step 2: Send the channel @username (e.g. @MyChannel), Chat ID (e.g. -100123456789), or forward any message from your channel here!\n` +
        `(Tip: For private channels, you can also send "-100123456789 https://t.me/+InviteLink")`
      );
      b.buttons([
        richButton.callback('✕ Cancel', `fj_open:${scope}`, { style: 'danger' })
      ]);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, b.toJSON()).catch(async () => {
          await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
      }
      return;
    }

    if (action === 'fj_del') {
      const chatIdToRemove = parts.slice(2).join(':');
      removeForceJoinChannel({
        db: this.db,
        chatIdToRemove,
        isGlobal,
        botId: targetBotId
      });
      await this.api.answerCallbackQuery(query.id, { text: '🗑 Channel removed from Force-Join!' }).catch(() => {});
      const panel = buildForceJoinManagerRich({
        db: this.db,
        isGlobal,
        botId: targetBotId,
        botUsername: targetBotUsername,
        mainBotUsername,
        canManageGlobal: this.isMainOwner(userId)
      });
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, panel).catch(() => {});
      }
      return;
    }

    if (action === 'fj_clear') {
      if (isGlobal) setGlobalForceJoinChannels(this.db, []);
      else setCloneForceJoinChannels(this.db, targetBotId, []);
      await this.api.answerCallbackQuery(query.id, { text: '🗑 Cleared all Force-Join channels!' }).catch(() => {});
      const panel = buildForceJoinManagerRich({
        db: this.db,
        isGlobal,
        botId: targetBotId,
        botUsername: targetBotUsername,
        mainBotUsername,
        canManageGlobal: this.isMainOwner(userId)
      });
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, panel).catch(() => {});
      }
      return;
    }
  }

  async handleSetPrefix(message, args = []) {
    const chatId = message.chat?.id;
    if (!chatId) return;
    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
    const tgId = message.from?.id;
    const currentChatPrefix = this.db?.getChatPrefix ? this.db.getChatPrefix(chatId) : (this.settings?.get('telegram.prefix') || '/');
    const currentUserPrefix = this.db?.getUserPrefix ? this.db.getUserPrefix(tgId) : '/';

    if (!args.length) {
      if (isGroup) {
        await this.api.sendMessage(
          chatId,
          `<blockquote>🌸 <b>Group Command Prefix:</b> <code>${currentChatPrefix}</code>\n\n` +
          `Everyone in this group uses: <code>${currentChatPrefix}&lt;command&gt;</code>\n\n` +
          `🎀 <b>To change prefix (Admins):</b>\n` +
          `Send: <code>${currentChatPrefix}setprefix &lt;symbol or emoji&gt;</code>\n\n` +
          `✨ Examples: <code>${currentChatPrefix}setprefix !</code>, <code>${currentChatPrefix}setprefix 🎀</code>, <code>${currentChatPrefix}setprefix ✨</code> ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await this.api.sendMessage(
          chatId,
          `<blockquote>🌸 <b>Your Command Prefix:</b> <code>${currentUserPrefix}</code>\n\n` +
          `🎀 <b>To change prefix:</b>\n` +
          `Send: <code>${currentUserPrefix}setprefix &lt;symbol or emoji&gt;</code>\n\n` +
          `✨ Examples: <code>${currentUserPrefix}setprefix !</code>, <code>${currentUserPrefix}setprefix ✨</code>, <code>${currentUserPrefix}setprefix 🎀</code> ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    const firstArg = args[0].trim().toLowerCase();
    const isPersonalExplicit = firstArg === 'me' || firstArg === 'my' || firstArg === 'user';
    const rawTargetPrefix = isPersonalExplicit ? args[1] : args[0];

    if (!rawTargetPrefix) {
      await this.api.sendMessage(
        chatId,
        `<blockquote>✕ Please provide a symbol or emoji for the prefix (e.g. <code>${currentChatPrefix}setprefix 🎀</code>) ♡</blockquote>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const newPrefix = rawTargetPrefix.trim();
    const segs = [...new Intl.Segmenter().segment(newPrefix)];
    const hasSpace = /\s/.test(newPrefix);
    const isPlainWord = /^[a-zA-Z0-9]+$/.test(newPrefix);

    if (!newPrefix || hasSpace || isPlainWord || segs.length === 0 || segs.length > 3) {
      await this.api.sendMessage(
        chatId,
        `<blockquote>✕ Invalid prefix! Please provide 1 to 3 non-alphanumeric symbols or emojis (e.g. <code>!</code>, <code>.</code>, <code>#</code>, <code>✨</code>, <code>🎀</code>, <code>⚡</code>) ♡</blockquote>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Determine target: personal vs group
    const isSettingPersonal = isPersonalExplicit || !isGroup;

    if (!isSettingPersonal) {
      // Trying to set group-wide prefix
      const isOwner = this.isOwner(tgId);
      let isAdmin = isOwner;
      if (!isAdmin) {
        try {
          const member = await this.api.getChatMember(chatId, tgId);
          isAdmin = member.status === 'administrator' || member.status === 'creator';
        } catch {}
      }
      if (!isAdmin) {
        await this.api.sendMessage(
          chatId,
          `<blockquote>✕ Only group administrators or the bot owner can change the group prefix.\n\n` +
          `💡 <b>Tip:</b> To use a personal prefix for yourself in private chats, message me in DM! ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (this.db?.setChatPrefix) {
        this.db.setChatPrefix(chatId, newPrefix);
      }
      if (args[1]?.toLowerCase() === 'global' && this.isMainOwner(tgId)) {
        this.settings?.set?.('telegram.prefix', newPrefix);
      }

      await this.updateCommandsForChat(chatId, newPrefix);

      await this.api.sendMessage(
        chatId,
        `<blockquote>✨ <b>Group command prefix changed to:</b> <code>${newPrefix}</code>\n\n` +
        `Everyone in this group must now use: <code>${newPrefix}</code>\n` +
        `• <code>${newPrefix}game</code>\n` +
        `• <code>${newPrefix}play &lt;song&gt;</code>\n` +
        `• <code>${newPrefix}grab &lt;link&gt;</code>\n` +
        `• <code>${newPrefix}menu</code>\n` +
        `• <code>${newPrefix}setprefix &lt;char&gt;</code>\n\n` +
        `<i>Type <code>${newPrefix}</code> anytime to view full command suggestions!</i> ♡</blockquote>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Setting personal prefix
    if (this.db?.setUserPrefix) {
      this.db.setUserPrefix(tgId, newPrefix);
    }
    if (!isGroup && this.db?.setChatPrefix) {
      this.db.setChatPrefix(chatId, newPrefix);
    }

    await this.updateCommandsForChat(chatId, newPrefix);

    const groupNotice = isGroup
      ? `\n\n⚠️ <i>Note: In this group chat, the active group prefix is <code>${currentChatPrefix}</code>. Your personal prefix works in private DM!</i>`
      : '';

    await this.api.sendMessage(
      chatId,
      `<blockquote>✨ <b>Personal command prefix changed to:</b> <code>${newPrefix}</code>\n\n` +
      `You can now use commands with your personal prefix in private chat:\n` +
      `• <code>${newPrefix}play &lt;song&gt;</code>\n` +
      `• <code>${newPrefix}game</code>\n` +
      `• <code>${newPrefix}grab &lt;link&gt;</code>\n` +
      `• <code>${newPrefix}menu</code>\n` +
      `• <code>${newPrefix}setprefix &lt;char&gt;</code>${groupNotice}\n\n` +
      `<i>Type <code>${newPrefix}</code> anytime to view full command suggestions!</i> ♡</blockquote>`,
      { parse_mode: 'HTML' }
    );
  }

  async handleCommandSuggestions(message, prefix = '/') {
    const chatId = message.chat?.id;
    if (!chatId) return;
    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
    const scopeLabel = isGroup ? 'Group' : 'Personal';

    const b = new RichMessageBuilder();
    b.heading(`𓆩♡𓆪 COMMAND SUGGESTIONS (${prefix}) 𓆩♡𓆪`, 1);
    b.paragraph(rt.italic('₊˚⊹♡  available studio, group & live game commands  ˙ᵕ˙'));
    b.divider();
    b.table(kvTable([
      [`🎀 ${scopeLabel} Prefix`, prefix],
      [`🎮 ${prefix}game`, '16+ Live Games Hub (Unlimited & Timed)'],
      [`🔠 ${prefix}grid`, '8×8 Word Grid (Find 10 Hidden Words)'],
      [`⚡ ${prefix}pokemon`, 'Catch Wild & Shiny Pokémon in Chat'],
      [`🔥 ${prefix}afro`, 'Guess the Naija / Afrobeats Hit Song'],
      [`🥷 ${prefix}anime`, 'Guess the Popular Anime Character'],
      [`🎵 ${prefix}play <song>`, 'Stream 320k high-speed MP3 audio'],
      [`📥 ${prefix}grab <link>`, 'Download HD videos/music (TT/IG/YT/X)'],
      [`👥 ${prefix}pfp <theme>`, 'Matching PFP albums (duo/couple)'],
      [`🔍 ${prefix}pint <search>`, 'Aesthetic Pinterest HD gallery'],
      [`🎀 ${prefix}stickers`, 'Telegram sticker studio'],
      [`✨ ${prefix}menu`, 'Studio dashboard & settings']
    ]), { compact: true });
    b.expandableBlockquote(
      `🕹️ ALL LIVE GAME SHORTCUTS (Tap to copy or run):\n` +
      `• ${prefix}game — Open 4-Tab Game Arena Hub\n` +
      `• ${prefix}grid / ${prefix}wordgrid — 8×8 Word Grid (Auto-Reposts on Hit)\n` +
      `• ${prefix}pokemon — Catch Wild & Shiny Pokémon\n` +
      `• ${prefix}pokebattle — 1v1 Pokémon Stadium Duel\n` +
      `• ${prefix}pokedex — View Your Pokédex & Trainer Passport\n` +
      `• ${prefix}afro — Guess the Naija / Afrobeats Hit Song\n` +
      `• ${prefix}songgame — Guess the Song (30s Audio Clip)\n` +
      `• ${prefix}lyricgame — Finish the Lyrics Challenge\n` +
      `• ${prefix}anime — Guess the Popular Anime Character\n` +
      `• ${prefix}flags — Guess the Country Flag\n` +
      `• ${prefix}logos — Guess the Car / Brand Logo\n` +
      `• ${prefix}trivia — Live Speed Trivia Battle\n` +
      `• ${prefix}scramble — Word Scramble Challenge\n` +
      `• ${prefix}emoji — Emoji Puzzle Quiz\n` +
      `• ${prefix}riddle — Riddles & Brain Teasers\n` +
      `• ${prefix}ttt / ${prefix}connect4 / ${prefix}rps — 1v1 PvP Duels\n` +
      `• ${prefix}topleaderboard — Group Game Hall of Fame`
    );
    b.divider();
    b.buttons([
      richButton.callback(`🎮 ${prefix}game Hub`, 'game_hub:visual', { style: 'success' }),
      richButton.callback(`🔠 ${prefix}grid`, 'game_start:wordgrid', { style: 'primary' }),
      richButton.callback(`⚡ ${prefix}pokemon`, 'game_start:pokemon', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback(`🔥 ${prefix}afro Song`, 'game_start:song', { style: 'primary' }),
      richButton.switchInlineCurrent(`🎵 ${prefix}play`, `${prefix}play `, { style: 'primary' })
    ]);
    b.buttons([
      richButton.switchInlineCurrent(`📥 ${prefix}grab`, `${prefix}grab `, { style: 'primary' }),
      richButton.switchInlineCurrent(`👥 ${prefix}pfp`, `${prefix}pfp `, { style: 'primary' })
    ]);
    b.buttons([
      richButton.switchInlineCurrent(`🔍 ${prefix}pint`, `${prefix}pint `, { style: 'primary' }),
      richButton.callback(`🎀 ${prefix}menu`, encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.switchInlineCurrent('✨ All Command Suggestions ↗️', `${prefix}`, { style: 'primary' })
    ]);
    if (typeof this.api.sendRichMessage === 'function') {
      return await this.api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
    }
    return await this.api.sendMessage(chatId, 'Command Suggestions').catch(() => {});
  }

  async updateCommandsForChat(chatId, prefix = '/') {
    try {
      if (prefix === '/') {
        await this.api.call('deleteMyCommands', {
          scope: { type: 'chat', chat_id: Number(chatId) }
        }).catch(() => {});
        return;
      }

      const botName = this.botContext?.botName || 'Lancy';
      const commands = [
        { command: 'start', description: `[${prefix}start] Open ${botName} companion menu` },
        { command: 'menu', description: `[${prefix}menu] Open ${botName} dashboard` },
        { command: 'help', description: `[${prefix}help] View command suggestions` },
        { command: 'game', description: `[${prefix}game] 16+ Live Games Arena Hub` },
        { command: 'grid', description: `[${prefix}grid] 8×8 Word Grid Challenge` },
        { command: 'pokemon', description: `[${prefix}pokemon] Catch wild & Shiny Pokémon` },
        { command: 'pokebattle', description: `[${prefix}pokebattle] 1v1 Pokémon Stadium Duel` },
        { command: 'pokedex', description: `[${prefix}pokedex] Personal Pokédex & Passport` },
        { command: 'afro', description: `[${prefix}afro] Guess the Naija / Afrobeats Song` },
        { command: 'songgame', description: `[${prefix}songgame] Guess the Song (Audio Clip)` },
        { command: 'lyricgame', description: `[${prefix}lyricgame] Finish the Lyrics Challenge` },
        { command: 'anime', description: `[${prefix}anime] Guess the Anime Character` },
        { command: 'flags', description: `[${prefix}flags] Guess the Country Flag` },
        { command: 'logos', description: `[${prefix}logos] Guess the Car / Brand Logo` },
        { command: 'ttt', description: `[${prefix}ttt] 1v1 Tic-Tac-Toe Board` },
        { command: 'connect4', description: `[${prefix}connect4] 1v1 Connect Four Board` },
        { command: 'topleaderboard', description: `[${prefix}topleaderboard] Game Hall of Fame` },
        { command: 'play', description: `[${prefix}play] Stream high-speed 320k MP3` },
        { command: 'grab', description: `[${prefix}grab] Download HD video/music` },
        { command: 'pfp', description: `[${prefix}pfp] Matching PFP albums` },
        { command: 'pint', description: `[${prefix}pint] Search aesthetic Pinterest` },
        { command: 'stickers', description: `[${prefix}stickers] Telegram sticker studio` },
        { command: 'postchannel', description: `[${prefix}postchannel] Post pack to channel` },
        { command: 'autopost', description: `[${prefix}autopost] Schedule sticker drops` },
        { command: 'setprefix', description: `[${prefix}setprefix] Change command trigger prefix` },
        { command: 'cancel', description: `[${prefix}cancel] Cancel current active operation` }
      ];
      await this.api.call('setMyCommands', {
        commands,
        scope: { type: 'chat', chat_id: Number(chatId) }
      }).catch(() => {});
    } catch {}
  }

  #chatIdFor(tgId, source) {
    return source?.message?.chat?.id
      ?? source?.callback_query?.message?.chat?.id
      ?? source?.chatId
      ?? Number(tgId);
  }
}

function friendly(error) {
  if (error instanceof LancyError) return error.userMessage;
  const tg = friendlyTelegramError(error);
  if (tg) return tg;
  return '♡ Something went wrong on my side — the details are in my log ♡';
}
