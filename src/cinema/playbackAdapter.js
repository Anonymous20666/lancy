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
    isChannel = true,
    poster = null,
    backdrop = null,
    year = null,
    rating = null,
    genres = null,
    overview = null
  } = {}) {
    const numChat = Number(chatId);

    // If a new movie is manually started, close any previous voting session for this destination
    if (this.app?.cinemaPoll?.closePollForChat) {
      this.app.cinemaPoll.closePollForChat(numChat, 'superseded');
    }

    let resolvedSource = source || filePath;
    let resolvedMeta = {
      poster,
      backdrop,
      year,
      rating,
      genres: Array.isArray(genres) ? genres : (genres ? [genres] : []),
      overview,
      duration: Number(duration || 0),
      trailerUrl: null,
      nextEpisode: null
    };

    // Enrich metadata from Movie API if available and missing
    if (mediaId && this.app?.movieApi && (!resolvedMeta.poster || !resolvedMeta.duration)) {
      try {
        if (mediaType === 'tv' && typeof this.app.movieApi.getTvDetails === 'function') {
          const det = await this.app.movieApi.getTvDetails(mediaId).catch(() => null);
          if (det) {
            resolvedMeta.poster = resolvedMeta.poster || det.poster || det.thumbnail;
            resolvedMeta.backdrop = resolvedMeta.backdrop || det.backdrop;
            resolvedMeta.year = resolvedMeta.year || det.year;
            resolvedMeta.rating = resolvedMeta.rating || det.rating;
            resolvedMeta.genres = resolvedMeta.genres.length ? resolvedMeta.genres : (det.genres || []);
            resolvedMeta.overview = resolvedMeta.overview || det.overview;
            resolvedMeta.trailerUrl = det.trailer || null;
            if (!resolvedMeta.duration && det.runtime) resolvedMeta.duration = Number(det.runtime) * 60;
          }
          if (season != null && episode != null && typeof this.app.movieApi.getTvEpisode === 'function') {
            const epDet = await this.app.movieApi.getTvEpisode(mediaId, season, episode).catch(() => null);
            if (epDet) {
              if (!resolvedMeta.duration && epDet.runtime) resolvedMeta.duration = Number(epDet.runtime) * 60;
              if (epDet.thumbnail) resolvedMeta.backdrop = epDet.thumbnail;
              if (epDet.overview) resolvedMeta.overview = epDet.overview;
              if (epDet.next_episode) resolvedMeta.nextEpisode = epDet.next_episode;
            }
          }
        } else if (typeof this.app.movieApi.getMovieDetails === 'function') {
          const det = await this.app.movieApi.getMovieDetails(mediaId).catch(() => null);
          if (det) {
            resolvedMeta.poster = resolvedMeta.poster || det.poster || det.thumbnail;
            resolvedMeta.backdrop = resolvedMeta.backdrop || det.backdrop;
            resolvedMeta.year = resolvedMeta.year || det.year;
            resolvedMeta.rating = resolvedMeta.rating || det.rating;
            resolvedMeta.genres = resolvedMeta.genres.length ? resolvedMeta.genres : (det.genres || []);
            resolvedMeta.overview = resolvedMeta.overview || det.overview;
            resolvedMeta.trailerUrl = det.trailer || null;
            if (!resolvedMeta.duration && det.runtime) resolvedMeta.duration = Number(det.runtime) * 60;
          }
        }
      } catch {}
    }

    const finalDuration = resolvedMeta.duration > 0 ? resolvedMeta.duration : (mediaType === 'tv' ? 2700 : 6600);

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

    const dest = this.db.get('SELECT id, chat_type FROM cinema_destinations WHERE chat_id = ?', numChat);
    const destinationId = dest?.id || 1;
    const isChannelDest = dest?.chat_type ? dest.chat_type === 'channel' : Boolean(isChannel);

    const isDirect = this.resolver?.isDirectMedia?.(resolvedSource) || /\.(m3u8|mp4|webm|mkv|ts)(\?|$)/i.test(resolvedSource) || (!isHttp && existsSync(resolvedSource));

    // If source is a web embed URL, attempt to resolve a playable local stream file for VC first, or manage session cleanly
    if (!isDirect && isHttp && (resolvedSource.includes('/embed/') || resolvedSource.includes('player.') || resolvedSource.includes('embed') || resolvedSource.includes('/play/'))) {
      let vcStreamStarted = false;
      if (resolver?.resolvePlayableLocalFile && this.voice?.play) {
        const localMediaPath = await resolver.resolvePlayableLocalFile({
          mediaType,
          mediaId,
          title,
          trailerUrl: resolvedMeta.trailerUrl
        }).catch(() => null);

        if (localMediaPath && existsSync(localMediaPath)) {
          try {
            const playOpts = {
              isChannel: isChannelDest,
              video: true,
              playbackId,
              durationSeconds: finalDuration,
              bass: false,
              eq: 'off'
            };
            await this.voice.play(numChat, localMediaPath, playOpts);
            vcStreamStarted = true;
            resolvedSource = localMediaPath;
          } catch (vcErr) {
            this.log.debug({ err: vcErr?.message, numChat }, 'VoiceClient direct play skipped on embed fallback');
          }
        }
      }

      this.db.run(
        `INSERT INTO cinema_playback_sessions 
         (destination_id, session_id, media_type, media_id, title, season, episode, playback_state, position_seconds, duration_seconds, started_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PLAYING', ?, ?, CURRENT_TIMESTAMP, 1)
         ON CONFLICT(session_id) DO UPDATE SET playback_state = 'PLAYING', updated_at = CURRENT_TIMESTAMP`,
        destinationId, sessionId, mediaType, String(mediaId || '0'), title || 'Untitled Stream', season, episode, offset, finalDuration
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
        duration: finalDuration,
        position: offset,
        volume: 100,
        state: 'PLAYING',
        connectionState: vcStreamStarted ? 'STREAMING_VC' : 'CONNECTED',
        isWebEmbed: !vcStreamStarted,
        poster: resolvedMeta.poster,
        backdrop: resolvedMeta.backdrop,
        year: resolvedMeta.year,
        rating: resolvedMeta.rating,
        genres: resolvedMeta.genres,
        overview: resolvedMeta.overview,
        nextEpisode: resolvedMeta.nextEpisode,
        canSeek: true,
        canVolume: true,
        canSkipIntro: mediaType === 'tv' || (resolvedMeta.genres || []).some(g => /anime|animation/i.test(g)),
        skipIntroSeconds: 85,
        startedAt: Date.now(),
        lastUpdated: Date.now()
      };

      this.activeSessions.set(numChat, sessionObj);

      if (this.app?.cinemaCards?.postOrUpdateCard) {
        this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
      }

      this.#triggerNextPreload(numChat, sessionObj);
      return sessionObj;
    }

    this.db.run(
      `INSERT INTO cinema_playback_sessions 
       (destination_id, session_id, media_type, media_id, title, season, episode, playback_state, position_seconds, duration_seconds, started_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?, CURRENT_TIMESTAMP, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         playback_state = 'PREPARING',
         updated_at = CURRENT_TIMESTAMP`,
      destinationId, sessionId, mediaType, String(mediaId || '0'), title || 'Untitled Stream', season, episode, offset, duration || finalDuration
    );

    try {
      this.log.info({ numChat, title, resolvedSource, offset }, 'Starting Cinema stream via VoiceClient');

      const playOpts = {
        isChannel: Boolean(isChannel),
        video: true,
        playbackId,
        durationSeconds: duration || finalDuration,
        bass: false,
        eq: 'off'
      };

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
        duration: duration || finalDuration,
        position: offset,
        volume: 100,
        state: 'PLAYING',
        connectionState: 'STREAMING_VC',
        poster: resolvedMeta.poster,
        backdrop: resolvedMeta.backdrop,
        year: resolvedMeta.year,
        rating: resolvedMeta.rating,
        genres: resolvedMeta.genres,
        overview: resolvedMeta.overview,
        nextEpisode: resolvedMeta.nextEpisode,
        canSeek: true,
        canVolume: true,
        canSkipIntro: mediaType === 'tv' || (resolvedMeta.genres || []).some(g => /anime|animation/i.test(g)),
        skipIntroSeconds: 85,
        startedAt: Date.now(),
        lastUpdated: Date.now()
      };

      this.activeSessions.set(numChat, sessionObj);

      if (this.app?.cinemaCards?.postOrUpdateCard) {
        this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
      }

      this.#triggerNextPreload(numChat, sessionObj);
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

  #triggerNextPreload(chatId, sessionObj) {
    try {
      const resolver = this.resolver || this.app?.cinemaResolver;
      if (!resolver?.preloadNext) return;
      const queue = this.app?.cinemaQueue?.getQueue?.(chatId) || [];
      if (queue.length > 0) {
        resolver.preloadNext({
          mediaType: queue[0].media_type,
          mediaId: queue[0].media_id,
          season: queue[0].season,
          episode: queue[0].episode
        });
      } else if (sessionObj.mediaType === 'tv' && sessionObj.nextEpisode) {
        resolver.preloadNext({
          mediaType: 'tv',
          mediaId: sessionObj.mediaId,
          season: sessionObj.nextEpisode.season_number,
          episode: sessionObj.nextEpisode.episode_number
        });
      }
    } catch {}
  }

  async handleStreamEnded(chatId, playbackId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active || (playbackId && active.playbackId !== playbackId)) {
      return;
    }

    this.log.info({ numChat, playbackId, title: active.title }, 'Cinema stream ended, checking queue and progression');

    // If a poll is open when the movie finishes, finalize it immediately so its winner becomes #1 in queue
    if (this.app?.cinemaPoll?.finalizePollForChat) {
      await this.app.cinemaPoll.finalizePollForChat(numChat).catch(() => {});
    }

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
          poster: nextQueueItem.poster,
          backdrop: nextQueueItem.backdrop,
          year: nextQueueItem.year,
          rating: nextQueueItem.rating,
          isChannel: true
        });
        return;
      } catch (err) {
        this.log.warn({ err: err?.message, numChat }, 'Failed to play next queued cinema item');
      }
    }

    // 2. If current media was TV and queue is empty, check TV progression
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
            poster: active.poster,
            backdrop: active.backdrop,
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

  async next(chatId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active) return { ok: false, message: 'No active session' };
    await this.handleStreamEnded(numChat, active.playbackId);
    return { ok: true, session: this.getCurrentSession(numChat) };
  }

  async previous(chatId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active) return { ok: false, message: 'No active session' };

    const currentPos = this.#computeLivePosition(active);
    if (currentPos > 15 || active.mediaType !== 'tv' || !this.app?.cinemaQueue?.resolvePrevEpisode) {
      await this.seek(numChat, 0);
      return { ok: true, session: this.getCurrentSession(numChat) };
    }

    const prevEp = await this.app.cinemaQueue.resolvePrevEpisode(active.mediaId, active.season, active.episode);
    if (prevEp) {
      const session = await this.play(numChat, {
        mediaType: 'tv',
        mediaId: prevEp.mediaId,
        title: prevEp.title,
        season: prevEp.season,
        episode: prevEp.episode,
        poster: active.poster,
        backdrop: active.backdrop,
        isChannel: true
      });
      return { ok: true, session };
    }

    await this.seek(numChat, 0);
    return { ok: true, session: this.getCurrentSession(numChat) };
  }

  async pause(chatId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active?.isWebEmbed && this.voice?.pause) {
      await this.voice.pause(numChat).catch((err) => {
        if (!active) throw err;
      });
    }

    const frozenPos = active ? this.#computeLivePosition(active) : 0;
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PAUSED', position_seconds = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PLAYING'`,
      frozenPos, numChat
    );
    if (active) {
      active.position = frozenPos;
      active.state = 'PAUSED';
      active.lastUpdated = Date.now();
    }
    if (this.app?.cinemaPoll?.pausePollForChat) {
      this.app.cinemaPoll.pausePollForChat(numChat);
    }
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'PAUSED', position: frozenPos };
  }

  async resume(chatId) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    if (!active?.isWebEmbed && this.voice?.resume) {
      await this.voice.resume(numChat).catch((err) => {
        if (!active) throw err;
      });
    }
    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'PLAYING', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state = 'PAUSED'`,
      numChat
    );
    if (active) {
      active.state = 'PLAYING';
      active.lastUpdated = Date.now();
    }
    if (this.app?.cinemaPoll?.resumePollForChat) {
      this.app.cinemaPoll.resumePollForChat(numChat);
    }
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'PLAYING' };
  }

  async seek(chatId, seconds) {
    const numChat = Number(chatId);
    const active = this.activeSessions.get(numChat);
    const maxDur = active?.duration > 0 ? active.duration : Infinity;
    const targetSeconds = Math.min(maxDur, Math.max(0, parseFloat(seconds)));

    if (!active?.isWebEmbed && this.voice?.seek) {
      await this.voice.seek(numChat, targetSeconds).catch((err) => {
        if (!active) throw err;
      });
    }

    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET position_seconds = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      targetSeconds, numChat
    );

    if (active) {
      active.position = targetSeconds;
      active.lastUpdated = Date.now();
    }
    if (this.app?.cinemaPoll?.recalculatePollOnSeek) {
      this.app.cinemaPoll.recalculatePollOnSeek(numChat, targetSeconds, active?.duration || 0);
    }
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, position: targetSeconds };
  }

  async stop(chatId) {
    const numChat = Number(chatId);
    try {
      await this.voice?.stop?.(numChat);
    } catch {}

    this.db.run(
      `UPDATE cinema_playback_sessions 
       SET playback_state = 'STOPPED', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND playback_state IN ('PLAYING', 'PAUSED')`,
      numChat
    );

    this.activeSessions.delete(numChat);
    if (this.app?.cinemaPoll?.closePollForChat) {
      this.app.cinemaPoll.closePollForChat(numChat, 'stream_stopped');
    }
    if (this.app?.cinemaCards?.postOrUpdateCard) {
      this.app.cinemaCards.postOrUpdateCard(numChat).catch(() => {});
    }
    return { ok: true, state: 'STOPPED' };
  }

  async setVolume(chatId, volume) {
    const numChat = Number(chatId);
    const vol = Math.max(0, Math.min(200, parseInt(volume, 10)));
    const active = this.activeSessions.get(numChat);
    if (!active?.isWebEmbed && this.voice?.setVolume) {
      await this.voice.setVolume(numChat, vol).catch(() => {});
    }
    if (active) active.volume = vol;
    return { ok: true, volume: vol };
  }

  #computeLivePosition(mem) {
    if (!mem) return 0;
    if (mem.state !== 'PLAYING' || !mem.lastUpdated) return mem.position || 0;
    const elapsedMs = Date.now() - mem.lastUpdated;
    // Keep exact position within first 1000ms for deterministic unit test assertions
    if (elapsedMs < 1000) return mem.position || 0;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const nextPos = (mem.position || 0) + elapsedSec;
    return mem.duration > 0 ? Math.min(mem.duration, nextPos) : nextPos;
  }

  getCurrentSession(chatId) {
    const numChat = Number(chatId);
    const mem = this.activeSessions.get(numChat);
    if (mem) {
      const livePos = this.#computeLivePosition(mem);
      return {
        ...mem,
        position: livePos
      };
    }

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
      volume: 100,
      canSeek: true,
      canVolume: true,
      canSkipIntro: row.media_type === 'tv',
      skipIntroSeconds: 85,
      startedAt: row.started_at,
      revision: row.revision
    };
  }
}
