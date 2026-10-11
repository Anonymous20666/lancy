import { extname } from 'node:path';
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
import { getLyrics, chunkLyrics, escapeHtml, formatBlockquoteLyrics, cleanSongMetadata } from '../media/lyrics.js';
import { t } from '../core/i18n.js';
import { PinterestWebProvider } from '../pinterest/web.js';

const execFileAsync = promisify(execFile);
const inlineSearchCache = new Map();
const inlinePinterestCache = new Map();
const inlineTikTokCache = new Map();
const inlineUrlCache = new Map();
const recentInlineSearchResults = new Map();

export async function searchYouTubeFast(query) {
  const clean = String(query || '').trim();
  if (!clean) return [];
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US'
          }
        },
        query: clean
      }),
      signal: AbortSignal.timeout(2200)
    });
    const data = await res.json();
    const videos = [];
    const seen = new Set();

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.videoId && (node.title || node.headline)) {
        let vid = String(node.videoId).replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
        if (vid.length === 11 && !seen.has(vid)) {
          seen.add(vid);
          const title = node.title?.runs?.[0]?.text || node.title?.simpleText || node.headline?.simpleText || '';
          const duration = node.lengthText?.simpleText || 'HD';
          const views = node.viewCountText?.simpleText || node.shortViewCountText?.simpleText || '';
          const author = node.ownerText?.runs?.[0]?.text || node.shortBylineText?.runs?.[0]?.text || 'Music';
          const thumb = node.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          if (title) {
            videos.push({ videoId: vid, title, duration, views, author, thumb });
          }
        }
      }
      if (node.shortsLockupViewModel) {
        const vm = node.shortsLockupViewModel;
        let vid = String(vm.entityId || '').replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
        if (!vid && vm.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId) {
          vid = vm.onTap.innertubeCommand.reelWatchEndpoint.videoId;
        }
        if (vid && vid.length === 11 && !seen.has(vid)) {
          seen.add(vid);
          const title = vm.overlayMetadata?.primaryText?.content || '';
          const views = vm.overlayMetadata?.secondaryText?.content || '';
          const thumb = vm.thumbnail?.sources?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          if (title) {
            videos.push({ videoId: vid, title, duration: 'Short', views, author: 'Shorts', thumb });
          }
        }
      }
      for (const k of Object.keys(node)) {
        walk(node[k]);
      }
    }

    walk(data);
    if (videos.length > 0) return videos;
  } catch {}

  try {
    const { yts } = await import('btch-downloader');
    const res = await yts(clean);
    const vids = res?.result?.videos || res?.result?.all || [];
    return vids.map(v => ({
      videoId: v.videoId || (v.url ? v.url.split('v=')[1] : ''),
      title: v.title || clean,
      duration: v.timestamp || v.duration?.timestamp || 'HD',
      views: v.views ? String(v.views) : '',
      author: v.author?.name || 'Music',
      thumb: v.thumbnail || v.image || ''
    })).filter(v => Boolean(v.videoId));
  } catch {
    return [];
  }
}

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
    this.log = log ?? logger().child({ module: 'telegram' });
    this.offset = 0;
    this.running = false;
    this.abort = null;
    this.globalCallbacks = new Map(); // action -> handler (state-agnostic)
    this.userScreenMessage = new Map(); // tgId -> { chatId, messageId }
    this.mediaDeliveryMessageIds = new Set(); // messageId -> boolean
    this.pendingAudioCaches = new Set(); // query -> boolean
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
    this.supportsInline = Boolean(me.supports_inline_queries);
    this.settings.values.telegram.botUsername = me.username;
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
      { command: 'play', description: '🎵 Search, stream & download music / MP3' },
      { command: 'grab', description: '📥 Universal media downloader (TikTok, IG, YT, X)' },
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
      { command: 'grab', description: '📥 Universal media downloader (TikTok, IG, YT, X)' },
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
      return this.#handleChosenInlineResult(update.chosen_inline_result);
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

  async #cacheAudioTrack(query, timeoutMs = 2500) {
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

        const res = await this.app.mediaDownloader.download(clean);
        if (!res?.audioTrack?.buffer) return null;

        const ownerId = (this.settings?.get('telegram.ownerIds') || [])[0] || 8380969639;
        const durSec = res.duration ? parseDurationToSeconds(res.duration) : 0;
        const sent = await this.api.sendAudio(ownerId, res.audioTrack.buffer, {
          title: res.title || clean,
          performer: res.artist || res.author || 'Music',
          ...(durSec > 0 ? { duration: durSec } : {}),
          disable_notification: true
        });

        const fileId = sent?.audio?.file_id;
        if (fileId) {
          if (sent.message_id) {
            await this.api.call('deleteMessage', { chat_id: ownerId, message_id: sent.message_id }).catch(() => {});
          }
          const songTitle = res.title || clean;
          const songArtist = res.artist || res.author || null;
          try {
            const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
            this.db.prepare(sql).run(cleanKey, fileId, songTitle, songArtist, durSec);
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

  async #handleChosenInlineResult(chosen) {
    if (!chosen) return;
    this.log.info({ chosen }, 'processing chosen_inline_result');
    const resultId = chosen.result_id || '';
    const inlineMessageId = chosen.inline_message_id;
    if (!inlineMessageId) return;

    if (!resultId.startsWith('fresh_aud_')) return;

    const cachedInfo = recentInlineSearchResults.get(resultId);
    const searchQuery = cachedInfo ? `${cachedInfo.title} ${cachedInfo.artist}`.trim() : (chosen.query || '');
    if (!searchQuery) return;

    let fileId = null;
    let trackTitle = cachedInfo?.title || chosen.query;
    let trackArtist = cachedInfo?.artist || 'Music';
    let trackDuration = cachedInfo?.duration || 0;

    try {
      const queryTerms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = this.db.prepare(
        'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks ORDER BY id DESC LIMIT 50'
      ).all();
      const match = (rows || []).find((row) => {
        const rowText = `${row.query || ''} ${row.title || ''} ${row.artist || ''}`.toLowerCase();
        return queryTerms.every((term) => rowText.includes(term));
      });
      if (match?.file_id) {
        fileId = match.file_id;
        trackTitle = match.title;
        trackArtist = match.artist || trackArtist;
        trackDuration = match.duration || trackDuration;
      }
    } catch {}

    if (!fileId && this.app?.mediaDownloader) {
      try {
        const res = await this.app.mediaDownloader.download(searchQuery);
        if (res?.audioTrack?.buffer) {
          const ownerId = (this.settings?.get('telegram.ownerIds') || [])[0] || 8380969639;
          const durSec = res.duration ? parseDurationToSeconds(res.duration) : trackDuration;
          const sent = await this.api.sendAudio(ownerId, res.audioTrack.buffer, {
            title: res.title || trackTitle,
            performer: res.artist || res.author || trackArtist,
            ...(durSec > 0 ? { duration: durSec } : {}),
            disable_notification: true
          });
          const uploadedFileId = sent?.audio?.file_id;
          if (uploadedFileId) {
            fileId = uploadedFileId;
            trackTitle = res.title || trackTitle;
            trackArtist = res.artist || res.author || trackArtist;
            trackDuration = durSec;
            if (sent.message_id) {
              await this.api.call('deleteMessage', { chat_id: ownerId, message_id: sent.message_id }).catch(() => {});
            }
            try {
              const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
              this.db.prepare(sql).run(searchQuery.toLowerCase().trim(), fileId, trackTitle, trackArtist, trackDuration);
              if (trackTitle && trackTitle.toLowerCase().trim() !== searchQuery.toLowerCase().trim()) {
                this.db.prepare(sql).run(trackTitle.toLowerCase().trim(), fileId, trackTitle, trackArtist, trackDuration);
              }
            } catch {}
          }
        }
      } catch (err) {
        this.log.debug({ err, searchQuery }, 'chosen inline result download failed');
      }
    }

    if (fileId) {
      try {
        await this.api.editMessageMedia({
          inline_message_id: inlineMessageId,
          media: {
            type: 'audio',
            media: fileId,
            caption: `🎵 <b>${escapeHtml(trackTitle)}</b> — <i>${escapeHtml(trackArtist)}</i>\n✨ <i>Full Audio via @${this.botUsername || 'Lancy_easy_bot'} ♡</i>`,
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✨ 📥 Full MP3 & Lyrics ♡',
                  url: `https://t.me/${this.botUsername || 'Lancy_easy_bot'}?start=play_${encodeURIComponent(trackTitle.replace(/\s+/g, '_')).slice(0, 32)}`,
                  style: 'primary'
                }
              ]
            ]
          }
        });
        this.log.info({ inlineMessageId, fileId, title: trackTitle }, 'upgraded inline message to full audio track');
      } catch (editErr) {
        this.log.warn({ editErr, inlineMessageId }, 'failed to edit inline message media');
      }
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
                if (pin.carouselData?.carouselSlots?.length) {
                  for (const slot of pin.carouselData.carouselSlots) {
                    const img = slot.images_orig?.url
                      || (slot.imageSignature ? `https://i.pinimg.com/originals/${slot.imageSignature.slice(0, 2)}/${slot.imageSignature.slice(2, 4)}/${slot.imageSignature.slice(4, 6)}/${slot.imageSignature}.jpg` : null)
                      || slot.images_1200x?.url
                      || slot.images_736x?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                  }
                }
                if (pin.storyPinData?.pages?.length) {
                  for (const page of pin.storyPinData.pages) {
                    const img = page.image?.images?.originals?.url || page.image?.images?.['736x']?.url;
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

      if (videoUrl) {
        results.push({
          type: 'video',
          id: 'pin_vid_' + Date.now(),
          video_url: videoUrl,
          mime_type: 'video/mp4',
          thumb_url: imageUrls[0] || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
          title: `🎬 HD Video: ${title.slice(0, 45)}`,
          description: `Pinterest HD Video ♡`,
          caption: `🎬 <b>${escapeHtml(title)}</b>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📌 View on Pinterest',
                  url: resolvedUrl || url,
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
          title: `📷 ${title.slice(0, 45)}`,
          description: `Pinterest HD Photo ♡`,
          caption: `📷 <b>${escapeHtml(title)}</b>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📌 View on Pinterest',
                  url: resolvedUrl || url,
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
            title: `🖼 ${title.slice(0, 35)} (${idx + 1}/${imageUrls.length})`,
            description: `Pinterest Album • Slide ${idx + 1} of ${imageUrls.length} ♡`,
            caption: `🖼 <b>${escapeHtml(title)}</b> [${idx + 1}/${imageUrls.length}]\n✨ <i>Downloaded via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '📌 View on Pinterest',
                    url: resolvedUrl || url,
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

  async #fetchInlinePinterestSearch(queryTopic, offset = 0) {
    if (!queryTopic) return { results: [], nextOffset: '' };
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cleanTopic = queryTopic.trim();
      const cacheKey = `pint_${cleanTopic.toLowerCase()}`;
      let cached = inlinePinterestCache.get(cacheKey);

      if (!cached || (Date.now() - cached.timestamp > 180000)) {
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

      const combos = [
        cleanTopic,
        `${cleanTopic} aesthetic`,
        `${cleanTopic} wallpaper`,
        `${cleanTopic} art`,
        `${cleanTopic} dark`,
        `${cleanTopic} hd 4k`,
        `${cleanTopic} photography`
      ];

      const provider = this.app?.pinterest?.provider || new PinterestWebProvider();

      // Ensure we have enough items in the pool for the requested offset + 15
      while (cached.items.length < (offset + 15) && cached.combosTried < combos.length) {
        let res = null;
        if (cached.bookmark && cached.combosTried === 0) {
          res = await provider.search({ query: cleanTopic, bookmark: cached.bookmark }).catch(() => null);
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

      const paged = cached.items.slice(offset, offset + 15);
      const nextOffset = (offset + paged.length < cached.items.length || cached.combosTried < combos.length) && paged.length >= 8
        ? String(offset + paged.length)
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
            title: `🎬 HD Video: ${cleanTopic.slice(0, 35)}`,
            description: `Pinterest HD Video ♡`,
            caption: `🎬 <b>${escapeHtml(cleanTopic)}</b>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔍 More "${cleanTopic.slice(0, 12)}"`,
                    switch_inline_query_current_chat: `pint ${cleanTopic}`,
                    style: 'primary'
                  },
                  {
                    text: '🎵 Search Music',
                    switch_inline_query_current_chat: cleanTopic,
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
            title: `📷 ${cleanTopic.slice(0, 35)}`,
            description: `HD Aesthetic Photo ♡`,
            caption: `📷 <b>${escapeHtml(cleanTopic)}</b>\n✨ <i>Found via @${botUser} ♡</i>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🔍 More "${cleanTopic.slice(0, 12)}"`,
                    switch_inline_query_current_chat: `pint ${cleanTopic}`,
                    style: 'primary'
                  },
                  {
                    text: '🎵 Search Music',
                    switch_inline_query_current_chat: cleanTopic,
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

  async #fetchInlineTikTokSearch(queryTopic, offset = 0) {
    if (!queryTopic) return [];
    try {
      const botUser = this.botUsername || 'Lancy_easy_bot';
      const cacheKey = `tt_${queryTopic.toLowerCase()}`;
      let cachedVids = inlineTikTokCache.get(cacheKey);

      if (!cachedVids || offset >= cachedVids.length) {
        const modifiers = [
          'tiktok',
          'tiktok shorts',
          'tiktok viral',
          'tiktok trending',
          'tiktok compilation',
          'tiktok dance',
          'tiktok edit',
          'tiktok funny'
        ];
        const pageIdx = Math.floor(offset / 10);
        const mod = modifiers[pageIdx % modifiers.length];
        const vids = await searchYouTubeFast(`${queryTopic} ${mod}`);
        if (vids.length > 0) {
          if (!cachedVids) cachedVids = [];
          const seen = new Set(cachedVids.map((v) => v.videoId));
          for (const v of vids) {
            if (!seen.has(v.videoId)) {
              seen.add(v.videoId);
              cachedVids.push(v);
            }
          }
          inlineTikTokCache.set(cacheKey, cachedVids);
          if (inlineTikTokCache.size > 200) {
            const firstKey = inlineTikTokCache.keys().next().value;
            inlineTikTokCache.delete(firstKey);
          }
        }
      }

      if (!cachedVids || cachedVids.length === 0) return [];

      const paged = cachedVids.slice(offset, offset + 10);
      const results = [];

      for (let idx = 0; idx < paged.length; idx++) {
        const item = paged[idx];
        const title = item.title || queryTopic;
        const duration = item.duration || 'HD Clip';
        const views = item.views ? `${item.views}` : 'Trending';
        const thumb = item.thumb || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
        const videoUrl = `https://www.youtube.com/watch?v=${item.videoId}`;

        results.push({
          type: 'video',
          id: `tt_${item.videoId}_${offset}_${idx}`,
          video_url: videoUrl,
          mime_type: 'text/html',
          thumbnail_url: thumb,
          thumb_url: thumb,
          title: `🎬 ${title.slice(0, 50)}`,
          description: `⏱ ${duration} • 👁 ${views} ♡`,
          caption: `🎬 <b>${escapeHtml(title)}</b>\n<blockquote>⏱ <b>Duration:</b> ${duration} • 👁 <b>Views:</b> ${views}\n✨ <i>TikTok &amp; Shorts HD Clip via @${botUser} ♡</i></blockquote>`,
          parse_mode: 'HTML',
          input_message_content: {
            message_text: `🎬 <b>${escapeHtml(title)}</b>\n<blockquote>⏱ <b>Duration:</b> ${duration} • 👁 <b>Views:</b> ${views}\n✨ <i>TikTok &amp; Shorts HD Clip via @${botUser} ♡</i></blockquote>\n${videoUrl}`,
            parse_mode: 'HTML'
          },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎙️ Recognize Music / Search Song ♡',
                  switch_inline_query_current_chat: `${title.slice(0, 30)} song`,
                  style: 'primary'
                }
              ],
              [
                {
                  text: `🔍 More "${queryTopic.slice(0, 15)}"`,
                  switch_inline_query_current_chat: `tt ${queryTopic}`,
                  style: 'primary'
                },
                {
                  text: '▶️ Watch Clip ♡',
                  url: videoUrl,
                  style: 'primary'
                }
              ]
            ]
          }
        });
      }
      return results;
    } catch (err) {
      this.log?.debug?.({ err: err?.message, queryTopic }, 'inline tiktok search failed');
      return [];
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
                text: '📷 Open HD Image',
                url: cleanUrl,
                style: 'primary'
              }
            ],
            [
              {
                text: '🔍 Search More Media',
                switch_inline_query_current_chat: '',
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
                text: '▶️ Watch Video ♡',
                url: cleanUrl,
                style: 'primary'
              }
            ],
            [
              {
                text: '🎬 Search More Videos',
                switch_inline_query_current_chat: 'tt ',
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
                text: '▶️ Listen Audio ♡',
                url: cleanUrl,
                style: 'primary'
              }
            ],
            [
              {
                text: '🎵 Search More Songs',
                switch_inline_query_current_chat: '',
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
          const title = d.title || 'TikTok Media';
          const author = d.author?.nickname || d.author?.unique_id || 'TikTok';
          const cover = d.cover?.startsWith('http') ? d.cover : (d.cover ? 'https://www.tikwm.com' + d.cover : undefined);
          const images = Array.isArray(d.images) ? d.images : [];
          const soundTitle = d.music_info?.title || '';
          const soundAuthor = d.music_info?.author || '';
          let musicSearchQuery = '';
          if (soundTitle && !/^original sound/i.test(soundTitle)) {
            musicSearchQuery = `${soundTitle} ${soundAuthor}`.trim();
          } else {
            musicSearchQuery = title.replace(/#[^\s]+/g, '').trim() || 'Soundtrack';
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
                title: `🖼 ${title.slice(0, 35)} (${idx + 1}/${images.length})`,
                description: `👤 ${author} • Slide ${idx + 1} of ${images.length} ♡`,
                caption: `🖼 <b>${escapeHtml(title)}</b> [${idx + 1}/${images.length}]\n👤 <i>${escapeHtml(author)}</i>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
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
              thumb_url: cover || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
              title: `🎬 HD Video: ${title.slice(0, 45)}`,
              description: `👤 ${author} • Direct No-Watermark MP4 ♡`,
              caption: `🎬 <b>${escapeHtml(title)}</b>\n👤 <i>${escapeHtml(author)}</i>\n✨ <i>Downloaded via @${botUser} ♡</i>`,
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
            results.push({
              type: 'audio',
              id: 'tt_aud_' + Date.now(),
              audio_url: audioUrl,
              title: d.music_info?.title || title.slice(0, 30) || 'Soundtrack',
              performer: d.music_info?.author || author,
              caption: `🎵 <b>${escapeHtml(d.music_info?.title || title)}</b>\n👤 <i>${escapeHtml(d.music_info?.author || author)}</i>\n✨ <i>Extracted audio via @${botUser} ♡</i>`,
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
          }
        ];

        await this.api.call('answerInlineQuery', {
          inline_query_id: qId,
          results: defaultResults,
          cache_time: 10,
          is_personal: false
        });
        return;
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
            const trend = await this.#fetchInlinePinterestSearch('aesthetic wallpaper', 0);
            if (trend?.results?.length) trendingPhotos = trend.results.slice(0, 10);
          } catch {}

          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: [...suggestionCards, ...trendingPhotos],
            cache_time: 15,
            is_personal: false
          });
          return;
        }

        const { results: pintResults, nextOffset } = await this.#fetchInlinePinterestSearch(queryTopic, offset);

        if (pintResults && pintResults.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: pintResults,
            next_offset: nextOffset,
            cache_time: 15,
            is_personal: false
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
          cache_time: 15,
          is_personal: false
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
                      switch_inline_query_current_chat: `${rawText} dance `,
                      style: 'primary'
                    }
                  ]
                ]
              }
            }],
            cache_time: 10,
            is_personal: false
          });
          return;
        }

        const cacheKey = `${queryTopic.toLowerCase()}_off_${offset}`;
        let ttResults = inlineTikTokCache.get(cacheKey);
        if (!ttResults) {
          ttResults = await this.#fetchInlineTikTokSearch(queryTopic, offset);
          if (ttResults?.length) {
            inlineTikTokCache.set(cacheKey, ttResults);
            if (inlineTikTokCache.size > 200) {
              const firstKey = inlineTikTokCache.keys().next().value;
              inlineTikTokCache.delete(firstKey);
            }
          }
        }

        if (ttResults && ttResults.length > 0) {
          const nextOffset = ttResults.length >= 8 ? String(offset + ttResults.length) : '';
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: ttResults,
            next_offset: nextOffset,
            cache_time: 20,
            is_personal: false
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
          cache_time: 15,
          is_personal: false
        });
        return;
      }

      // 4. Music Search (Live):
      const cleanSongQuery = rawText.replace(/^(play|music|song|listen|stream)\s+/i, '').trim() || rawText;

      // Check SQLite cached audio tracks for instant full audio playback
      const queryTerms = cleanSongQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const lookupCached = () => {
        try {
          const rows = this.db.prepare(
            'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks ORDER BY id DESC LIMIT 200'
          ).all();
          const seen = new Set();
          const matches = [];

          for (const row of rows || []) {
            if (!row?.file_id) continue;
            const normKey = `${(row.title || '').toLowerCase().trim()} ${(row.artist || '').toLowerCase().trim()}`.trim();
            if (seen.has(row.file_id) || (normKey && seen.has(normKey))) continue;

            const rowQuery = (row.query || '').toLowerCase().trim();
            const rowTitle = (row.title || '').toLowerCase().trim();
            const rowArtist = (row.artist || '').toLowerCase().trim();
            const cleanLower = cleanSongQuery.toLowerCase().trim();

            const isExact = rowQuery === cleanLower || rowTitle === cleanLower || `${rowTitle} ${rowArtist}` === cleanLower || `${rowArtist} ${rowTitle}` === cleanLower;
            const rowText = `${rowQuery} ${rowTitle} ${rowArtist}`;
            const termsMatch = queryTerms.length > 0 && queryTerms.every((term) => rowText.includes(term));

            if (isExact || termsMatch) {
              seen.add(row.file_id);
              if (normKey) seen.add(normKey);
              matches.push({ ...row, isExact });
            }
          }

          matches.sort((a, b) => (b.isExact ? 1 : 0) - (a.isExact ? 1 : 0));
          return matches.slice(0, 50);
        } catch {
          return [];
        }
      };

      const cachedAudioRows = lookupCached();

      const cachedResults = (cachedAudioRows || []).map((row, idx) => {
        const durSec = row.duration || 0;
        const min = Math.floor(durSec / 60);
        const sec = String(durSec % 60).padStart(2, '0');
        const durStr = durSec > 0 ? `${min}:${sec}` : 'HD Audio';
        const botUser = this.botUsername || 'Lancy_easy_bot';

        return {
          type: 'audio',
          id: `cached_aud_${row.file_id.slice(-8)}_${idx}`,
          audio_file_id: row.file_id,
          title: row.title,
          performer: row.artist || 'Music',
          ...(durSec > 0 ? { audio_duration: durSec } : {}),
          caption: `🎵 <b>${escapeHtml(row.title)}</b> — <i>${escapeHtml(row.artist || 'Music')}</i>\n<blockquote>⏱ <b>Duration:</b> ${durStr} • 🎧 <b>Quality:</b> 320 kbps HD\n✨ <i>Full Audio (100%) via @${botUser} ♡</i></blockquote>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📜 Lyrics & Info ♡',
                  url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(row.title.replace(/\s+/g, '_')).slice(0, 32)}`,
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
        };
      });

      let results = [];
      let nextOffset = '';

      if (cachedResults.length >= 10) {
        const pagedAudioResults = cachedResults.slice(offset, offset + 10);
        const nextAudioOffset = (offset + pagedAudioResults.length < cachedResults.length)
          ? String(offset + pagedAudioResults.length)
          : '';
        results = pagedAudioResults;
        nextOffset = nextAudioOffset;
      } else {
        const combinedMusicResults = [];
        const seenTitles = new Set();

        // 1. Add matching cached native audio tracks first (they drop native full MP3!)
        for (const row of cachedResults) {
          seenTitles.add((row.title || '').toLowerCase().trim());
          combinedMusicResults.push(row);
        }

        // 2. Fetch online YouTube tracks when query has at least 2 chars so users ALWAYS get a full list of 10+ results!
        if (cleanSongQuery.length >= 2) {
          this.#cacheAudioTrack(cleanSongQuery, 0).catch(() => {});

          const cacheKey = `mus_${cleanSongQuery.toLowerCase()}`;
          let onlineVideos = inlineSearchCache.get(cacheKey);

          if (!onlineVideos || (offset + 10) >= onlineVideos.length) {
            const searchTerms = [
              cleanSongQuery,
              `${cleanSongQuery} audio`,
              `${cleanSongQuery} music`,
              `${cleanSongQuery} song`,
              `${cleanSongQuery} official audio`
            ];
            const pageIdx = Math.floor(offset / 10);
            const term = searchTerms[pageIdx % searchTerms.length];
            const vids = await searchYouTubeFast(term);
            if (vids.length > 0) {
              if (!onlineVideos) onlineVideos = [];
              const seenVids = new Set(onlineVideos.map((v) => v.videoId));
              for (const v of vids) {
                if (!seenVids.has(v.videoId)) {
                  seenVids.add(v.videoId);
                  onlineVideos.push(v);
                }
              }
              inlineSearchCache.set(cacheKey, onlineVideos);
              if (inlineSearchCache.size > 200) {
                const firstKey = inlineSearchCache.keys().next().value;
                inlineSearchCache.delete(firstKey);
              }
            }
          }

          if (onlineVideos && onlineVideos.length > 0) {
            const botUser = this.botUsername || 'Lancy_easy_bot';

            for (let idx = 0; idx < onlineVideos.length; idx++) {
              const item = onlineVideos[idx];
              const titleLower = (item.title || '').toLowerCase().trim();
              if (seenTitles.has(titleLower)) continue;

              // Check if duplicate of any cached track
              const isDupe = cachedAudioRows.some((c) => {
                const cTitle = (c.title || '').toLowerCase().trim();
                const cArtist = (c.artist || '').toLowerCase().trim();
                const vidFull = `${titleLower} ${(item.author || '').toLowerCase()}`;
                if (cTitle && titleLower.includes(cTitle)) {
                  if (!cArtist || vidFull.includes(cArtist)) return true;
                }
                return false;
              });
              if (isDupe) continue;

              seenTitles.add(titleLower);

              const title = item.title || cleanSongQuery;
              const duration = item.duration || 'HD Track';
              const artist = item.author || 'Music';
              const thumb = item.thumb || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
              const videoUrl = `https://www.youtube.com/watch?v=${item.videoId}`;

              combinedMusicResults.push({
                type: 'video',
                id: `yt_aud_${item.videoId}_${offset}_${idx}`,
                video_url: videoUrl,
                mime_type: 'text/html',
                thumbnail_url: thumb,
                thumb_url: thumb,
                title: `🎵 ${title.slice(0, 50)}`,
                description: `⏱ ${duration} • 👤 ${artist} ♡`,
                caption: `🎵 <b>${escapeHtml(title)}</b>\n<blockquote>⏱ <b>Duration:</b> ${duration} • 👤 <b>Artist:</b> ${escapeHtml(artist)}\n✨ <i>Playable Track via @${botUser} ♡</i></blockquote>`,
                parse_mode: 'HTML',
                input_message_content: {
                  message_text: `🎵 <b>${escapeHtml(title)}</b>\n<blockquote>⏱ <b>Duration:</b> ${duration} • 👤 <b>Artist:</b> ${escapeHtml(artist)}\n✨ <i>Playable Track via @${botUser} ♡</i></blockquote>\n${videoUrl}`,
                  parse_mode: 'HTML'
                },
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '▶️ Stream / Watch Now ♡',
                        url: videoUrl,
                        style: 'primary'
                      }
                    ],
                    [
                      {
                        text: '📜 Lyrics & Info ♡',
                        url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(title.replace(/\s+/g, '_')).slice(0, 32)}`,
                        style: 'primary'
                      },
                      {
                        text: '🎵 Search Music Live',
                        switch_inline_query_current_chat: '',
                        style: 'primary'
                      }
                    ]
                  ]
                }
              });
            }
          }
        }

        if (combinedMusicResults.length > 0) {
          const pagedResults = combinedMusicResults.slice(offset, offset + 10);
          nextOffset = (offset + pagedResults.length < combinedMusicResults.length) || combinedMusicResults.length >= 8
            ? String(offset + pagedResults.length)
            : '';
          results = pagedResults;
        }
      }

      // 5. If no music results and query is generic, fall back to Pinterest pictures
      if (results.length === 0 && cleanSongQuery.length >= 2) {
        const { results: pintFallback, nextOffset: nextFallbackOffset } = await this.#fetchInlinePinterestSearch(cleanSongQuery, offset);
        if (pintFallback && pintFallback.length > 0) {
          await this.api.call('answerInlineQuery', {
            inline_query_id: qId,
            results: pintFallback,
            next_offset: nextFallbackOffset,
            cache_time: 30,
            is_personal: false
          });
          return;
        }
      }

      const answerPayload = {
        inline_query_id: qId,
        results,
        next_offset: nextOffset,
        cache_time: results[0]?.type === 'audio' ? 30 : 2,
        is_personal: false
      };

      await this.api.call('answerInlineQuery', {
        ...answerPayload,
        button: {
          text: `🎵 Search in ${botName}`,
          start_parameter: 'music'
        }
      }).catch(async (err) => {
        this.log.error({ err: err?.message, qId }, 'answerInlineQuery with button failed, retrying without button');
        await this.api.call('answerInlineQuery', answerPayload).catch((retryErr) => {
          this.log.error({ err: retryErr?.message, qId }, 'answerInlineQuery failed completely');
        });
      });
    } catch (err) {
      this.log.error({ err: err?.message, qId }, 'answerInlineQuery failed');
    }
  }

  async #handleCallback(query) {
    const user = this.#upsertUser(query.from);
    const chatType = query.message?.chat?.type;
    const isGroup = Boolean(chatType === 'group' || chatType === 'supergroup');
    const guard = this.isAllowed(query.from.id, { isGroup });
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

      // Pagination actions on media messages should update in-place (browsing album slides)
      const isPagination = Boolean(
        action === 'moreAlbum' ||
        action === 'prevAlbum' ||
        action === 'moreVideos' ||
        action === 'prevVideos'
      );

      const isFromMedia = !isPagination && Boolean(
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
    const isGroup = Boolean(message.chat?.type === 'group' || message.chat?.type === 'supergroup');
    const guard = this.isAllowed(message.from.id, { isGroup });
    if (!guard.ok) return; // silent for strangers in DMs
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
        if (startPayload && /^dl_/i.test(startPayload)) {
          const rawQuery = startPayload.replace(/^dl_/i, '').replace(/_/g, ' ').trim();
          let cleanQuery = rawQuery;
          try { cleanQuery = decodeURIComponent(rawQuery); } catch {}
          if (cleanQuery) {
            await this.sm.reset(tgId, { reason: 'start_dl' });
            const downloaderScreen = this.screens.get('downloader');
            await downloaderScreen?.executeDownload(this.#ctx(tgId, { message }, { forceNew: true }), cleanQuery);
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

      // In DM (private chat): state inputs work directly without needing to quote or tag!
      // In Group Chat: interactive prompt input requires replying to the bot or tagging @bot
      // to avoid chat conflicts when group members talk with each other.
      const shouldHandleState = isPrivate || isReplyToBot || isTag;
      const ctx = this.#ctx(tgId, { message });
      const handled = shouldHandleState ? await this.sm.handleMessage(tgId, { ...message, chatId }, ctx) : false;
      if (!handled) {
        if (text) {
          // Check if message is a reply to the bot's prompt cards in group or private chat:
          if (isReplyToBot || isPrivate) {
            const promptText = String(message.reply_to_message?.text || message.reply_to_message?.caption || '');
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
        const activeScreenMsgId = queryMessage?.message_id ||
          this.userScreenMessage.get(tgId)?.messageId ||
          this.sm?.for(tgId)?.screenMessageId ||
          this.sm?.context?.(tgId)?.screenMessageId;

        const isTargetMedia = Boolean(activeScreenMsgId && this.isMediaDeliveryMessageId(activeScreenMsgId));

        const isMediaDelivery = fromMedia || forceNew || isTargetMedia ||
          (queryMessage && this.isMediaDeliveryMessage(queryMessage)) ||
          (queryMessage?.message_id && this.isMediaDeliveryMessageId(queryMessage.message_id));

        // If fromMedia, forceNew, the current message contains delivered media, or no existing screen message:
        // send a fresh rich message so the user never loses their video, photo, or audio!
        if (isMediaDelivery || !activeScreenMsgId) {
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

        // When we have an active screen message (either from callback query or prior prompt):
        const targetMsgId = activeScreenMsgId;
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
