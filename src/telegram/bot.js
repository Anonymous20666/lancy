import { extname } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { LancyError, friendlyTelegramError } from '../core/errors.js';
import { decodeCallback, NOOP_CALLBACK, RichMessageBuilder, rt, richButton, encodeCallback } from './rich.js';
import { banner, kvTable } from './ui.js';
import { States } from '../core/stateMachine.js';
import { sleep } from '../utils/time.js';
import { truncate } from '../utils/text.js';
import { recognizeAudio, extractMediaForMusicRecognition } from '../media/recognizer.js';
import { getLyrics, chunkLyrics, escapeHtml, formatBlockquoteLyrics, cleanSongMetadata } from '../media/lyrics.js';
import { t } from '../core/i18n.js';

const execFileAsync = promisify(execFile);
const inlineSearchCache = new Map();

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
    this.log = log ?? logger().child({ module: 'telegram' });
    this.offset = 0;
    this.running = false;
    this.abort = null;
    this.globalCallbacks = new Map(); // action -> handler (state-agnostic)
    this.userScreenMessage = new Map(); // tgId -> { chatId, messageId }
    this.mediaDeliveryMessageIds = new Set(); // messageId -> boolean
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
      if (/lyrics|from_media|downloader|stickers:open/i.test(allCb)) {
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

  isAllowed(tgId) {
    const id = Number(tgId);
    if (this.isOwner(id)) return { ok: true, role: 'owner' };
    const adminIds = new Set((this.settings.get('telegram.adminIds') ?? []).map(Number));
    if (adminIds.has(id)) return { ok: true, role: 'admin' };

    // Cloned bots are public for their audience:
    if (this.botContext?.isClone) return { ok: true, role: 'allowed' };

    // Public platform access if enabled:
    if (this.settings.get('security.publicAccess') === true) {
      return { ok: true, role: 'allowed' };
    }

    const allowed = (this.settings.get('security.allowedUsers') ?? []).map(Number);
    if (allowed.length === 0) return { ok: false, role: 'stranger' };
    if (allowed.includes(id)) return { ok: true, role: 'allowed' };
    return { ok: false, role: 'stranger' };
  }

  isOwner(tgId) {
    const id = Number(tgId);
    if (this.botContext?.isClone && this.botContext.ownerId) {
      return id === Number(this.botContext.ownerId);
    }
    return (this.settings.get('general.ownerIds') ?? []).map(Number).includes(id);
  }

  async start() {
    const me = await this.api.getMe();
    this.botUsername = me.username;
    this.settings.values.telegram.botUsername = me.username;
    this.log.info({ bot: `@${me.username}` }, 'telegram connected');

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
      { command: 'play', description: '🎵 Search, stream & download music / MP3' },
      { command: 'download', description: '📥 Universal media downloader (TikTok, IG, YT)' },
      { command: 'search', description: '🔍 Search Pinterest (HD photos & aesthetic art)' },
      { command: 'music', description: '🎧 Fast music & Spotify track search' },
      { command: 'lyrics', description: '📝 Get lyrics for any song or snippet' },
      { command: 'recognize', description: '🎙️ Shazam / identify song from audio or video' },
      { command: 'start', description: `✦ Open ${botName} group companion menu` },
      { command: 'help', description: '୨୧ Bot commands & feature guide' },
      { command: 'cancel', description: '✕ Cancel current active operation' }
    ];

    const privateCommands = [
      { command: 'start', description: `✦ Open ${botName} aesthetic dashboard` },
      { command: 'play', description: '🎵 Search, stream & download music / MP3' },
      { command: 'download', description: '📥 Universal media downloader (TikTok, IG, YT)' },
      { command: 'search', description: '🔍 Search Pinterest (HD photos & videos)' },
      { command: 'music', description: '🎧 Fast music & Spotify track search' },
      { command: 'lyrics', description: '📝 Get lyrics for any song or snippet' },
      { command: 'recognize', description: '🎙️ Shazam / identify song from audio or video' },
      { command: 'stickers', description: '🎀 Telegram sticker pack studio' },
      ...(isClone ? [] : [
        { command: 'whatsapp', description: '📱 WhatsApp publishing & channels' },
        { command: 'ai', description: '🪄 Aesthetic AI assistant' },
        { command: 'clone', description: '🤖 Bring your own bot / clone in 60s' }
      ]),
      { command: 'rmbot', description: '🗑 Remove or delete a cloned bot' },
      { command: 'settings', description: '⚙ Studio configuration' },
      { command: 'help', description: '୨୧ Complete studio guide' },
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
      return;
    }
    if (update.callback_query) return this.#handleCallback(update.callback_query);
    if (update.message) return this.#handleMessage(update.message);
    if (update.edited_message) return this.#handleMessage(update.edited_message, { edited: true });
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

    // 1. Try iTunes Search API (fastest, high quality metadata & artwork, ~150ms)
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
            const thumb = r.artworkUrl100?.replace('100x100bb', '600x600bb') || r.artworkUrl100;
            return {
              id: String(r.trackId || idx),
              title: r.trackName || clean,
              artist: r.artistName || 'Music',
              duration,
              thumbnail: thumb
            };
          });
        }
      }
    } catch {}

    // 2. Try Deezer Search API fallback (~150ms)
    try {
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(clean)}&limit=8`, {
        signal: AbortSignal.timeout(2500)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.data) && data.data.length > 0) {
          return data.data.map((r, idx) => {
            const min = Math.floor((r.duration || 0) / 60);
            const sec = String((r.duration || 0) % 60).padStart(2, '0');
            const duration = r.duration ? `${min}:${sec}` : '';
            return {
              id: String(r.id || idx),
              title: r.title || clean,
              artist: r.artist?.name || 'Music',
              duration,
              thumbnail: r.album?.cover_big || r.album?.cover_medium
            };
          });
        }
      }
    } catch {}

    // 3. Fallback to yt-dlp search if external catalogs return nothing
    try {
      const searchTarget = `ytsearch5:${clean} song audio`;
      const { stdout } = await execFileAsync('yt-dlp', [
        '--no-warnings',
        '--js-runtimes', 'node:/usr/bin/node',
        '--print', '%(id)s ||| %(title)s ||| %(channel)s ||| %(duration_string)s ||| %(thumbnail)s',
        searchTarget
      ], { timeout: 4000 });

      const lines = stdout.trim().split('\n').filter(Boolean);
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

  async #handleInlineQuery(inlineQuery) {
    if (!inlineQuery?.id) return;
    const qId = inlineQuery.id;
    const rawText = String(inlineQuery.query || '').trim();
    const botName = this.botContext?.botName || 'Lancy';
    const botTag = this.botUsername ? `@${this.botUsername}` : '';

    try {
      // 1. If query is empty: provide intuitive entrypoint cards
      if (!rawText) {
        const defaultResults = [
          {
            type: 'article',
            id: 'hint_play',
            title: `🎵 ${botName} Live Music Search`,
            description: 'Type any song name, artist, or lyrics to search and stream ♡',
            thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
            input_message_content: {
              message_text: `<blockquote>🎵 <b>${botName} Music</b>\nType <code>/play &lt;song&gt;</code> or type <code>@${this.botUsername || 'bot'} &lt;song&gt;</code> to stream any song instantly! ♡</blockquote>`,
              parse_mode: 'HTML'
            }
          },
          {
            type: 'article',
            id: 'hint_download',
            title: `📥 ${botName} Universal Downloader`,
            description: 'Paste any TikTok, Instagram Reel, YouTube, or Pinterest link ♡',
            thumb_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            input_message_content: {
              message_text: `<blockquote>📥 <b>Universal Downloader</b>\nPaste any video, audio, or photo link to download in HD! ♡</blockquote>`,
              parse_mode: 'HTML'
            }
          },
          {
            type: 'article',
            id: 'hint_pinterest',
            title: `🔍 ${botName} Pinterest Search`,
            description: 'Type "pint <topic>" or "search <topic>" to search HD aesthetic photos ♡',
            thumb_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            thumbnail_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=150',
            input_message_content: {
              message_text: `<blockquote>🔍 <b>Pinterest Search</b>\nType <code>@${this.botUsername || 'bot'} pint aesthetic wallpaper</code> to find aesthetic pins! ♡</blockquote>`,
              parse_mode: 'HTML'
            }
          }
        ];

        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: defaultResults,
          cache_time: 30,
          is_personal: true
        });
        return;
      }

      // 2. Check if Pinterest search:
      if (/^(pint|pinterest|photo|pic|wallpaper)\s+/i.test(rawText)) {
        const queryTopic = rawText.replace(/^(pint|pinterest|photo|pic|wallpaper)\s+/i, '').trim();
        const pintResults = [
          {
            type: 'article',
            id: 'pint_' + Math.random().toString(36).slice(2, 8),
            title: `🔍 Search Pinterest for "${queryTopic}"`,
            description: `Fetch HD aesthetic pictures and videos for "${queryTopic}" ♡`,
            input_message_content: {
              message_text: `/search${botTag} ${queryTopic}`
            }
          }
        ];
        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: pintResults,
          cache_time: 30,
          is_personal: false
        });
        return;
      }

      // 3. Music Search (Live):
      const cleanSongQuery = rawText.replace(/^(play|music|song|listen|stream)\s+/i, '').trim() || rawText;

      let searchItems = inlineSearchCache.get(cleanSongQuery.toLowerCase());
      if (!searchItems) {
        searchItems = await this.#fetchInlineMusicTracks(cleanSongQuery);
        if (searchItems?.length) {
          inlineSearchCache.set(cleanSongQuery.toLowerCase(), searchItems);
          if (inlineSearchCache.size > 200) {
            const firstKey = inlineSearchCache.keys().next().value;
            inlineSearchCache.delete(firstKey);
          }
        }
      }

      const results = (searchItems || []).slice(0, 8).map((item, index) => {
        const title = item.title || cleanSongQuery;
        const artist = item.artist || 'Music';
        const duration = item.duration ? `⏱ ${item.duration}` : '🎵 High-Speed MP3';

        return {
          type: 'article',
          id: `song_${item.id || index}_${Date.now()}`,
          title: `🎵 ${title}`,
          description: `🎧 ${artist} • ${duration} ♡`,
          thumb_url: item.thumbnail || undefined,
          thumbnail_url: item.thumbnail || undefined,
          input_message_content: {
            message_text: `/play${botTag} ${title} ${artist}`.trim()
          }
        };
      });

      if (results.length === 0) {
        results.push({
          type: 'article',
          id: 'manual_' + Date.now(),
          title: `🎵 Play "${cleanSongQuery}"`,
          description: `Download high-speed MP3 audio with cover art & lyrics ♡`,
          thumb_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
          thumbnail_url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
          input_message_content: {
            message_text: `/play${botTag} ${cleanSongQuery}`.trim()
          }
        });
      }

      const answerPayload = {
        inline_query_id: qId,
        results,
        cache_time: 15,
        is_personal: false
      };

      await this.api.call('answerInlineQuery', {
        ...answerPayload,
        button: {
          text: `🎵 Search in ${botName}`,
          start_parameter: 'music'
        }
      }).catch(async () => {
        await this.api.call('answerInlineQuery', answerPayload).catch((err) => {
          this.log.debug({ err: err?.message, qId }, 'answerInlineQuery failed');
        });
      });
    } catch (err) {
      this.log.debug({ err: err?.message, qId }, 'answerInlineQuery failed');
    }
  }

  async #handleCallback(query) {
    const user = this.#upsertUser(query.from);
    const guard = this.isAllowed(query.from.id);
    if (!guard.ok) {
      await this.api.answerCallbackQuery(query.id, { text: 'This Lancy belongs to someone else ♡', showAlert: true });
      return;
    }
    const tgId = String(query.from.id);
    const data = query.data ?? '';

    try {
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

      const isFromMedia = Boolean(
        args?.includes('from_media') ||
        (query.message && this.isMediaDeliveryMessage(query.message)) ||
        (query.message?.message_id && this.isMediaDeliveryMessageId(query.message.message_id))
      );
      const ctx = this.#ctx(tgId, query, { forceNew: isFromMedia, fromMedia: isFromMedia });

      // State-agnostic global actions.
      if (this.globalCallbacks.has(action)) {
        await this.api.answerCallbackQuery(query.id);
        await this.globalCallbacks.get(action)(ctx, args);
        return;
      }

      // Screen-routed action.
      const screenModule = this.screens.get(screen);
      if (!screenModule?.handle) {
        await this.api.answerCallbackQuery(query.id, { text: '♡ That screen is not available right now.' });
        return;
      }
      await this.api.answerCallbackQuery(query.id);
      await screenModule.handle(ctx, action, args);
    } catch (error) {
      this.log.error({ err: error, tgId, data }, 'callback failed');
      await this.api.answerCallbackQuery(query.id, { text: friendly(error), showAlert: true }).catch(() => {});
    }
  }

  async #handleMessage(message, { edited = false } = {}) {
    const user = this.#upsertUser(message.from);
    const guard = this.isAllowed(message.from.id);
    if (!guard.ok) return; // silent for strangers in groups
    const tgId = String(message.from.id);
    const chatId = message.chat.id;

    // Commands
    const rawText = message.text ?? '';
    let text = rawText.trim();
    if (/^(rm\s*bot|remove\s*bot|delete\s*bot)(\s+.*)?$/i.test(text)) {
      text = text.replace(/^(rm\s*bot|remove\s*bot|delete\s*bot)/i, '/rmbot');
    }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const parts = cmd.split('@');
      const command = parts[0].toLowerCase();
      const targetBot = parts[1]?.toLowerCase();
      if (targetBot && this.botUsername && targetBot !== this.botUsername.toLowerCase()) {
        return;
      }

      if (command === '/reloadcommands' || command === '/reload_commands') {
        const isOwner = this.isOwner(tgId);
        if (!isOwner) {
          await this.api.sendMessage(chatId, `<blockquote>✕ Only bot owners or admins can hot-reload commands ♡</blockquote>`, { parse_mode: 'HTML' });
          return;
        }

        let report = '';
        if (this.app?.multiBotManager) {
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
          this.userScreenMessage.set(tgId, { chatId, messageId: sent.message_id });
          this.sm.update(tgId, { screenMessageId: sent.message_id });
          this.db.run(
            'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
            sent.message_id, Number(tgId)
          );
        }
      };

      const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');

      if (isGroup && (command === '/whatsapp' || command === '/ai' || command === '/admins' || command === '/settings' || command === '/addadmin' || command === '/deladmin')) {
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

      if (command === '/start') {
        await this.sm.reset(tgId, { reason: 'start' });
        const dashboard = this.screens.get('dashboard');
        const sent = await dashboard?.open(this.#ctx(tgId, { message }, { forceNew: true }), { forceNew: true });
        updateScreenMsg(sent);
        return;
      }
      if (command === '/search' || command === '/pinterest' || command === '/pint') {
        const query = rest.join(' ').trim();
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
      if (command === '/download' || command === '/dl' || command === '/music' || command === '/song' || command === '/play') {
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
            `Tip: To search & play music, use 🎵 Play Music from the menu or type <code>/play &lt;song name&gt;</code> ♡`,
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
          await this.api.sendMessage(chatId, '♡ Usage: `/lyrics <song title>` or `/lyrics <artist> - <song>` or `/lyrics <lyrics snippet>` ♡');
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
          const errSent = await this.api.sendMessage(
            chatId,
            `<blockquote>♡ Could not find lyrics for "<b>${escapeHtml(query)}</b>" ♡\nPlease check the spelling or send a longer lyric snippet!</blockquote>`,
            { parse_mode: 'HTML' }
          );
          if (errSent?.message_id && typeof this.api.deleteMessage === 'function') {
            setTimeout(() => {
              this.api.deleteMessage(chatId, errSent.message_id).catch(() => {});
            }, 12000)?.unref?.();
          }
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
      if (command === '/help') {
        const help = this.screens.get('help');
        const sent = await help?.open(this.#ctx(tgId, { message }, { forceNew: true }));
        updateScreenMsg(sent);
        return;
      }
      if (command === '/addadmin' || command === '/allocateadmin') {
        if (!this.isOwner(tgId)) {
          await this.api.sendMessage(chatId, '♡ Only the General Owner can allocate new admins ♡');
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
        if (!this.isOwner(tgId)) {
          await this.api.sendMessage(chatId, '<blockquote>♡ Only the General Owner can remove admins ♡</blockquote>', { parse_mode: 'HTML' });
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
        if (!this.isOwner(tgId) && !(this.settings.get('telegram.adminIds') ?? []).map(Number).includes(Number(tgId))) {
          await this.api.sendMessage(chatId, '<blockquote>♡ Only administrators can view the team roster ♡</blockquote>', { parse_mode: 'HTML' });
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
      // Check if user uploaded/sent a video, audio file, or voice note for music recognition:
      const recMedia = extractMediaForMusicRecognition(message);
      if (recMedia && recMedia.obj?.file_id) {
        const currentState = this.sm.state(tgId);
        // Only recognize music if user is explicitly in the downloader or music input flow
        if (currentState === States.URL_DOWNLOADER_INPUT || currentState === States.MUSIC_SEARCH_INPUT) {
          const ctx = this.#ctx(tgId, { message });
          await this.handleAudioRecognition(ctx, recMedia.obj, message, recMedia);
          return;
        }
      }

      const ctx = this.#ctx(tgId, { message });
      const handled = await this.sm.handleMessage(tgId, { ...message, chatId }, ctx);
      if (!handled) {
        if (text) {
          // Check if message is a reply to the bot's prompt cards in group or private chat:
          const replyMsgFrom = message.reply_to_message?.from;
          const isReplyToBot = Boolean(
            message.reply_to_message && (
              !replyMsgFrom ||
              replyMsgFrom.is_bot ||
              (this.api.me?.id && replyMsgFrom.id === this.api.me.id) ||
              (this.botUsername && replyMsgFrom.username?.toLowerCase() === this.botUsername.toLowerCase())
            )
          );
          if (isReplyToBot) {
            const promptText = String(message.reply_to_message.text || message.reply_to_message.caption || '');
            if (/PLAY & DOWNLOAD MUSIC|how to play & download|Search Music Live|song title & artist/i.test(promptText)) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeDownload) {
                const ctx = this.#ctx(tgId, { message }, { forceNew: true });
                await downloaderScreen.executeDownload(ctx, text);
                return;
              }
            }
            if (/URL DOWNLOADER|valid media link/i.test(promptText)) {
              const downloaderScreen = this.screens.get('downloader');
              if (downloaderScreen?.executeDownload) {
                const ctx = this.#ctx(tgId, { message }, { forceNew: true });
                await downloaderScreen.executeDownload(ctx, text);
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
                const ctx = this.#ctx(tgId, { message });
                await downloaderScreen.executeDownload(ctx, url);
                return;
              }
            }
          }

          const enabled = this.settings.getForUser(Number(tgId), 'ai.assistantEnabled', true);
          const isPrivate = message.chat?.type === 'private';
          const botUsername = (this.botUsername || this.api.me?.username || 'Lancy_easy_bot').replace(/^@/, '');
          const botId = this.api.me?.id;
          const replyFrom = message.reply_to_message?.from;
          const isQuote = Boolean(
            message.reply_to_message && (
              !replyFrom ||
              replyFrom.is_bot ||
              (botId && replyFrom.id === botId) ||
              (botUsername && replyFrom.username && replyFrom.username.toLowerCase() === botUsername.toLowerCase()) ||
              (isPrivate && replyFrom.id && replyFrom.id !== Number(tgId))
            )
          );
          const isTag = Boolean(
            /\blancy\b/i.test(text) ||
            new RegExp(`@?${botUsername}\\b`, 'i').test(text)
          );
          // In private chats (DM), AI assistant ONLY replies if the user explicitly quotes her message.
          // In group chats, replies if quoted or tagged.
          const shouldReply = enabled && (isPrivate ? isQuote : (isQuote || isTag));
          if (shouldReply && this.app?.assistant) {
            const ctx = this.#ctx(tgId, { message });
            await this.app.assistant.handleMessage({ ctx, message, text });
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
                    { text: '🔍 Search by Lyrics or Title', callback_data: 'l1:downloader:play' },
                    { text: '« Menu', callback_data: 'l1:dashboard:open' }
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
    const forceNew = Boolean(opts.forceNew || source?.forceNew || opts.fromMedia || source?.fromMedia);
    const fromMedia = Boolean(opts.fromMedia || source?.fromMedia || forceNew);

    const chatType = queryMessage?.chat?.type ?? directMessage?.chat?.type ?? message?.chat?.type ?? 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    let userLang = 'en';
    try {
      const bu = this.db.get('SELECT language FROM bot_users WHERE bot_id = ? AND tg_id = ?', this.botContext?.botId ?? 0, Number(tgId));
      if (bu?.language) userLang = bu.language;
    } catch {}

    return {
      tgId,
      forceNew,
      fromMedia,
      user: this.db.get('SELECT * FROM users WHERE tg_id = ?', Number(tgId)),
      chatId,
      chatType,
      isGroup,
      bot: this.botContext,
      botName: this.botContext?.botName || 'Lancy',
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
        const isMediaDelivery = fromMedia || forceNew ||
          (queryMessage && this.isMediaDeliveryMessage(queryMessage)) ||
          (queryMessage?.message_id && this.isMediaDeliveryMessageId(queryMessage.message_id));

        // If fromMedia, forceNew, or NOT an inline button callback, or the current message contains delivered media:
        // ALWAYS send a fresh rich message so the user never loses their video, photo, or audio!
        if (isMediaDelivery || !queryMessage) {
          const sent = await this.api.sendRichMessage(chatId, rich, extra, files);
          if (sent?.message_id) {
            this.userScreenMessage.set(tgId, { chatId, messageId: sent.message_id });
            this.sm?.update?.(tgId, { screenMessageId: sent.message_id });
            this.db.run(
              'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
              sent.message_id, Number(tgId)
            );
          }
          return sent;
        }

        // When the action was triggered by clicking an inline button on a normal menu:
        const targetMsgId = queryMessage.message_id;
        const targetChatId = chatId;

        try {
          const res = await this.api.editMessageRich(targetChatId, targetMsgId, rich, extra, files);
          this.userScreenMessage.set(tgId, { chatId: targetChatId, messageId: targetMsgId });
          this.sm?.update?.(tgId, { screenMessageId: targetMsgId });
          return res ?? { message_id: targetMsgId };
        } catch (error) {
          const errMsg = String(error?.description ?? error?.message);
          if (/not modified/i.test(errMsg)) {
            return { message_id: targetMsgId };
          }
          const sent = await this.api.sendRichMessage(targetChatId, rich, extra, files);
          if (sent?.message_id) {
            this.userScreenMessage.set(tgId, { chatId: targetChatId, messageId: sent.message_id });
            this.sm?.update?.(tgId, { screenMessageId: sent.message_id });
            this.db.run(
              'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
              sent.message_id, Number(tgId)
            );
          }
          return sent;
        }
      },
    };
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
