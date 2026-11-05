import { existsSync, unlinkSync, statSync } from 'node:fs';
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
  constructor({ app, db, voiceClient, cacheDir, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.voice = voiceClient || app?.voiceClient;
    this.cacheDir = cacheDir || join(process.cwd(), 'data/cache/music');
    this.log = log || logger().child({ module: 'cinema:playback-adapter' });
    this.activeSessions = new Map(); // chatId -> sessionState
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
    filePath,
    duration = 0,
    offset = 0.0,
    isChannel = true
  } = {}) {
    const numChat = Number(chatId);
    if (!filePath || !existsSync(filePath)) {
      throw new CinemaPlaybackError('MEDIA_NOT_READY', 'The media file is not prepared for playback.');
    }

    const sessionId = `cinema_${numChat}_${Date.now()}`;
    const playbackId = `pb_${sessionId}`;

    // Record session in database
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    const destinationId = dest?.id || 1;

    this.db.run(
      `INSERT INTO cinema_playback_sessions 
       (destination_id, session_id, media_type, media_id, title, season, episode, playback_state, position_seconds, duration_seconds, started_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?, datetime('now'), 1)
       ON CONFLICT(session_id) DO UPDATE SET
         playback_state = 'PREPARING',
         updated_at = datetime('now')`,
      destinationId, sessionId, mediaType, String(mediaId), title, season, episode, offset, duration
    );

    try {
      this.log.info({ numChat, title, filePath, offset }, 'Starting Cinema stream via VoiceClient');

      // Native PyTgCalls play via VoiceClient
      await this.voice.play(numChat, filePath, {
        isChannel: Boolean(isChannel),
        video: true,
        playbackId,
        durationSeconds: duration,
        bass: false,
        eq: 'off'
      });

      // Update state to PLAYING
      this.db.run(
        `UPDATE cinema_playback_sessions 
         SET playback_state = 'PLAYING', position_seconds = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE session_id = ?`,
        offset, sessionId
      );

      const sessionObj = {
        sessionId,
        playbackId,
        chatId: numChat,
        destinationId,
        mediaType,
        mediaId: String(mediaId),
        title,
        season,
        episode,
        filePath,
        duration,
        position: offset,
        state: 'PLAYING',
        startedAt: Date.now(),
        lastUpdated: Date.now()
      };

      this.activeSessions.set(numChat, sessionObj);
      return sessionObj;
    } catch (err) {
      this.db.run(
        `UPDATE cinema_playback_sessions 
         SET playback_state = 'FAILED', updated_at = datetime('now')
         WHERE session_id = ?`,
        sessionId
      );
      this.log.error({ err: err?.message, numChat, title }, 'Cinema stream start failed');
      throw err;
    }
  }

  async pause(chatId) {
    const numChat = Number(chatId);
    await this.voice.pause(numChat);
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PAUSED', revision = revision + 1, updated_at = datetime('now')
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PLAYING'`,
      numChat
    );
    const active = this.activeSessions.get(numChat);
    if (active) active.state = 'PAUSED';
    return { ok: true, state: 'PAUSED' };
  }

  async resume(chatId) {
    const numChat = Number(chatId);
    await this.voice.resume(numChat);
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PLAYING', revision = revision + 1, updated_at = datetime('now')
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PAUSED'`,
      numChat
    );
    const active = this.activeSessions.get(numChat);
    if (active) active.state = 'PLAYING';
    return { ok: true, state: 'PLAYING' };
  }

  async seek(chatId, seconds) {
    const numChat = Number(chatId);
    const targetSeconds = Math.max(0, parseFloat(seconds));
    await this.voice.seek(numChat, targetSeconds);

    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET position_seconds = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      targetSeconds, numChat
    );

    const active = this.activeSessions.get(numChat);
    if (active) {
      active.position = targetSeconds;
      active.lastUpdated = Date.now();
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
       SET playback_state = 'STOPPED', revision = revision + 1, updated_at = datetime('now')
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      numChat
    );

    this.activeSessions.delete(numChat);
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
