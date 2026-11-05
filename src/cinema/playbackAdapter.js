import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

export class CinemaPlaybackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CinemaPlaybackError';
    this.code = code;
  }
}

export class CinemaPlaybackAdapter {
  constructor({ app, db, voiceClient, streamResolver, cacheDir, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.voice = voiceClient || app?.voiceClient;
    this.resolver = streamResolver || app?.cinemaResolver;
    this.cacheDir = cacheDir || join(process.cwd(), 'data/cache/music');
    this.log = log || logger().child({ module: 'cinema:playback-adapter' });
    this.activeSessions = new Map(); // chatId -> sessionState
    this.eventAbort = null;
  }

  startEventListener() {
    if (!this.voice?.waitEvent || this.eventAbort) return;
    this.eventAbort = new AbortController();
    const loop = async () => {
      while (!this.eventAbort?.signal?.aborted) {
        try {
          const result = await this.voice.waitEvent(this.eventAbort.signal);
          for (const event of result?.events || []) {
            if (event.status === 'ended' && String(event.playback_id || '').startsWith('pb_cinema_')) {
              await this.handleStreamEnded(event.chat_id, event.playback_id).catch(() => {});
            }
          }
        } catch (err) {
          if (this.eventAbort?.signal?.aborted) break;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    };
    loop().catch(() => {});
  }

  stopEventListener() {
    if (this.eventAbort) {
      this.eventAbort.abort();
      this.eventAbort = null;
    }
  }

  async probeMedia(filePath) {
    if (!existsSync(filePath)) {
      throw new CinemaPlaybackError('FILE_NOT_FOUND', 'Media file does not exist on disk.');
    }

    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height',
        '-of', 'json',
        filePath
      ]);

      const data = JSON.parse(stdout);
      const format = data.format || {};
      const streams = data.streams || [];

      const hasVideo = streams.some(s => s.codec_type === 'video');
      const hasAudio = streams.some(s => s.codec_type === 'audio');
      const duration = parseFloat(format.duration || 0);

      return {
        valid: hasVideo && hasAudio,
        hasVideo,
        hasAudio,
        duration,
        streams
      };
    } catch (err) {
      this.log.warn({ err: err?.message, filePath }, 'ffprobe failed on cinema media');
      throw new CinemaPlaybackError('PROBE_FAILED', 'Could not probe video container stream.');
    }
  }

  async play(chatId, {
    mediaType = 'movie',
    mediaId,
    title,
    season = null,
    episode = null,
    source = null,
    filePath = null,
    duration = 0,
    offset = 0.0,
    isChannel = true
  } = {}) {
    const numChat = Number(chatId);
    let resolvedSource = source || filePath;

    // Use CinemaStreamResolver if available
    const resolver = this.resolver || this.app?.cinemaResolver;
    if (!resolvedSource && resolver) {
      try {
        const res = await resolver.resolve({
          mediaType,
          mediaId,
          season,
          episode,
          sourceUrl: source
        });
        if (res?.streamUrl) {
          resolvedSource = res.streamUrl;
        }
      } catch (err) {
        this.log.warn({ err: err?.message, mediaId }, 'Stream resolver error');
      }
    }

    // Direct fallback to Movie API if resolver didn't provide
    if (!resolvedSource && mediaId && this.app?.movieApi) {
      try {
        const pb = await this.app.movieApi.getPlayback(mediaId, { type: mediaType, season, episode });
        if (pb?.embed_url) {
          resolvedSource = pb.embed_url;
        } else if (pb?.servers?.[0]?.url) {
          resolvedSource = pb.servers[0].url;
        } else if (pb?.viewing_url) {
          resolvedSource = pb.viewing_url;
        }
      } catch (err) {
        this.log.warn({ err: err?.message, mediaId }, 'Could not resolve playback URL from Movie API');
      }
    }

    if (!resolvedSource) {
      throw new CinemaPlaybackError('MEDIA_NOT_READY', 'The media source is not available for playback.');
    }

    const isHttp = /^https?:\/\//i.test(resolvedSource);
    if (!isHttp && !existsSync(resolvedSource)) {
      throw new CinemaPlaybackError('FILE_NOT_FOUND', 'Local media file not found on disk.');
    }

    const sessionId = `cinema_${numChat}_${Date.now()}`;
    const playbackId = `pb_${sessionId}`;

    // Record session in database
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    const destinationId = dest?.id || 1;

    this.db.run(
      `INSERT INTO cinema_playback_sessions 
       (destination_id, session_id, media_type, media_id, title, season, episode, playback_state, position_seconds, duration_seconds, started_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?, CURRENT_TIMESTAMP, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         playback_state = 'PREPARING',
         updated_at = CURRENT_TIMESTAMP`,
      destinationId, sessionId, mediaType, String(mediaId || '0'), title || 'Untitled Stream', season, episode, offset, duration
    );

    try {
      this.log.info({ numChat, title, resolvedSource, offset }, 'Starting Cinema stream via VoiceClient');

      const playOpts = {
        isChannel: Boolean(isChannel),
        video: true,
        playbackId,
        durationSeconds: duration,
        bass: false,
        eq: 'off'
      };

      // Native PyTgCalls play via VoiceClient with auto-creation of voice chat
      try {
        await this.voice.play(numChat, resolvedSource, playOpts);
      } catch (playErr) {
        if (['NO_ACTIVE_CALL', 'CALL_FAILED'].includes(playErr?.code) && typeof this.voice?.setup === 'function') {
          await this.voice.setup(numChat, 'start', { create: true }).catch(() => null);
          await this.voice.play(numChat, resolvedSource, playOpts);
        } else {
          throw playErr;
        }
      }

      // Update state to PLAYING
      this.db.run(
        `UPDATE cinema_playback_sessions 
         SET playback_state = 'PLAYING', position_seconds = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`,
        offset, sessionId
      );

      const sessionObj = {
        sessionId,
        playbackId,
        chatId: numChat,
        destinationId,
        mediaType,
        mediaId: String(mediaId || '0'),
        title: title || 'Untitled Stream',
        season,
        episode,
        source: resolvedSource,
        duration,
        position: offset,
        state: 'PLAYING',
        startedAt: Date.now(),
        lastUpdated: Date.now()
      };

      this.activeSessions.set(numChat, sessionObj);

      // Post / Update Public Now-Playing Card in Channel
      if (this.app?.cinemaCards?.postOrUpdateCard) {
        this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
      }

      return sessionObj;
    } catch (err) {
      this.db.run(
        `UPDATE cinema_playback_sessions 
         SET playback_state = 'FAILED', updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`,
        sessionId
      );
      this.log.error({ err: err?.message, numChat, title }, 'Cinema stream start failed');
      throw err;
    }
  }

  async handleStreamEnded(chatId, playbackId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active || (playbackId && active.playbackId !== playbackId)) {
      return;
    }

    this.log.info({ numChat, playbackId, title: active.title }, 'Cinema stream ended, checking queue and progression');

    // Mark current session completed
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'COMPLETED', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`,
      active.sessionId
    );
    this.activeSessions.delete(numChat);

    // 1. Check if queue has a queued item
    const nextQueueItem = this.app?.cinemaQueue ? await this.app.cinemaQueue.getNextItem(numChat) : null;
    if (nextQueueItem) {
      this.app.cinemaQueue.removeFromQueue(numChat, nextQueueItem.queue_item_id);
      try {
        await this.play(numChat, {
          mediaType: nextQueueItem.media_type,
          mediaId: nextQueueItem.media_id,
          title: nextQueueItem.title,
          season: nextQueueItem.season,
          episode: nextQueueItem.episode,
          isChannel: true
        });
        return;
      } catch (err) {
        this.log.warn({ err: err?.message, numChat }, 'Failed to play next queued cinema item');
      }
    }

    // 2. If current media was TV and queue is empty, check TV progression:
    if (active.mediaType === 'tv' && active.season != null && active.episode != null && this.app?.cinemaQueue) {
      const nextEp = await this.app.cinemaQueue.resolveNextEpisode(active.mediaId, active.season, active.episode);
      if (nextEp) {
        try {
          this.log.info({ numChat, nextEp }, 'Auto-progressing to next TV episode');
          await this.play(numChat, {
            mediaType: 'tv',
            mediaId: nextEp.mediaId,
            title: nextEp.title,
            season: nextEp.season,
            episode: nextEp.episode,
            isChannel: true
          });
          return;
        } catch (err) {
          this.log.warn({ err: err?.message, numChat }, 'Failed auto TV episode progression');
        }
      }
    }

    // 3. Queue empty and no more episodes — stream concluded
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
  }

  async pause(chatId) {
    const numChat = Number(chatId);
    await this.voice.pause(numChat);
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PAUSED', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PLAYING'`,
      numChat
    );
    const active = this.activeSessions.get(numChat);
    if (active) active.state = 'PAUSED';
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'PAUSED' };
  }

  async resume(chatId) {
    const numChat = Number(chatId);
    await this.voice.resume(numChat);
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PLAYING', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PAUSED'`,
      numChat
    );
    const active = this.activeSessions.get(numChat);
    if (active) active.state = 'PLAYING';
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'PLAYING' };
  }

  async seek(chatId, seconds) {
    const numChat = Number(chatId);
    const targetSeconds = Math.max(0, parseFloat(seconds));
    await this.voice.seek(numChat, targetSeconds);

    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET position_seconds = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      targetSeconds, numChat
    );

    const active = this.activeSessions.get(numChat);
    if (active) {
      active.position = targetSeconds;
      active.lastUpdated = Date.now();
    }
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, position: targetSeconds };
  }

  async stop(chatId) {
    const numChat = Number(chatId);
    try {
      await this.voice.stop(numChat);
    } catch {}

    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'STOPPED', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      numChat
    );

    this.activeSessions.delete(numChat);
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'STOPPED' };
  }

  async setVolume(chatId, volume) {
    const numChat = Number(chatId);
    const vol = Math.max(0, Math.min(200, parseInt(volume, 10)));
    await this.voice.setVolume(numChat, vol);
    return { ok: true, volume: vol };
  }

  getCurrentSession(chatId) {
    const numChat = Number(chatId);
    const mem = this.activeSessions.get(numChat);
    if (mem) return mem;

    const row = this.db.get(
      `SELECT s.*, d.chat_id FROM cinema_playback_sessions s
       INNER JOIN cinema_destinations d ON s.destination_id = d.id
       WHERE d.chat_id = ? AND s.playback_state IN ('PLAYING', 'PAUSED', 'PREPARING')
       ORDER BY s.id DESC LIMIT 1`,
      numChat
    );

    if (!row) return null;
    return {
      sessionId: row.session_id,
      chatId: row.chat_id,
      mediaType: row.media_type,
      mediaId: row.media_id,
      title: row.title,
      season: row.season,
      episode: row.episode,
      state: row.playback_state,
      position: row.position_seconds,
      duration: row.duration_seconds,
      startedAt: row.started_at,
      revision: row.revision
    };
  }
}
