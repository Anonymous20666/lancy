import { logger } from '../core/logger.js';

export class CinemaApiRouter {
  constructor({ app, log } = {}) {
    this.app = app;
    this.log = log || logger().child({ module: 'cinema:api-router' });
  }

  async handle(req, res, parsedUrl) {
    const log = this.log;

    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, '');

    // Helper: read JSON body
    const readBody = async () => {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({});
          }
        });
      });
    };

    // Helper: JSON response
    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Destination verification & metadata
      if (pathname === '/cinema/api/destination') {
        const token = parsedUrl.searchParams.get('dest');
        const chatId = this.app.cinemaDestinations.verifyToken(token);
        if (!chatId) {
          return sendJson(401, { ok: false, error: 'INVALID_DESTINATION_TOKEN', message: 'Destination token expired or invalid.' });
        }
        const dest = this.app.cinemaDestinations.getDestinationByChatId(chatId);
        if (!dest) {
          return sendJson(404, { ok: false, error: 'NOT_FOUND', message: 'Destination chat not found.' });
        }
        return sendJson(200, { ok: true, destination: dest });
      }

      // 2. Movie API discovery pass-throughs with caching
      if (pathname === '/cinema/api/home') {
        const home = await this.app.movieApi.getHome();
        return sendJson(200, { ok: true, data: home });
      }

      if (pathname === '/cinema/api/trending') {
        const window = parsedUrl.searchParams.get('window') || 'day';
        const type = parsedUrl.searchParams.get('type') || 'all';
        const data = await this.app.movieApi.getTrending({ window, type });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/popular') {
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const data = await this.app.movieApi.getPopular({ type, page });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/latest') {
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const data = type === 'tv'
          ? await this.app.movieApi.getLatestEpisodes(page)
          : await this.app.movieApi.getLatestMovies(page);
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/search') {
        const q = parsedUrl.searchParams.get('q') || '';
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        if (!q.trim()) return sendJson(200, { ok: true, data: [] });
        const data = await this.app.movieApi.search(q, { type, page });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/details') {
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const id = parsedUrl.searchParams.get('id');
        if (!id) return sendJson(400, { ok: false, error: 'MISSING_ID' });
        const data = type === 'tv'
          ? await this.app.movieApi.getTvDetails(id)
          : await this.app.movieApi.getMovieDetails(id);
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/tv/seasons') {
        const id = parsedUrl.searchParams.get('id');
        if (!id) return sendJson(400, { ok: false, error: 'MISSING_ID' });
        const data = await this.app.movieApi.getTvSeasons(id);
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/tv/season') {
        const id = parsedUrl.searchParams.get('id');
        const season = parsedUrl.searchParams.get('season');
        if (!id || !season) return sendJson(400, { ok: false, error: 'MISSING_PARAMS' });
        const data = await this.app.movieApi.getTvSeason(id, season);
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/playback') {
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const id = parsedUrl.searchParams.get('id');
        const season = parsedUrl.searchParams.get('season');
        const episode = parsedUrl.searchParams.get('episode');
        if (!id) return sendJson(400, { ok: false, error: 'MISSING_ID' });
        const data = await this.app.movieApi.getPlayback(id, { type, season, episode });
        return sendJson(200, { ok: true, data });
      }

      // Direct Stream Play
      if (pathname === '/cinema/api/play' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const session = await this.app.cinemaPlayback.play(chatId, {
          mediaType: body.mediaType || 'movie',
          mediaId: body.mediaId,
          title: body.title,
          season: body.season,
          episode: body.episode,
          source: body.source || body.sourceUrl || null,
          offset: parseFloat(body.offset || '0'),
          duration: parseFloat(body.duration || '0'),
          isChannel: true
        });
        return sendJson(200, { ok: true, session });
      }

      // Start Community Poll
      if (pathname === '/cinema/api/poll/start' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const durationSeconds = parseInt(body.durationSeconds || '0', 10) || undefined;
        const poll = await this.app.cinemaPoll.startPoll(chatId, { durationSeconds });
        if (!poll) return sendJson(400, { ok: false, message: 'Queue is empty or poll could not start' });

        if (this.app?.cinemaCards?.postOrUpdateCard) {
          this.app.cinemaCards.postOrUpdateCard(chatId).catch(() => {});
        }
        return sendJson(200, { ok: true, poll });
      }

      // 3. Status & Authoritative Playback Clock
      if (pathname === '/cinema/api/status') {
        const token = parsedUrl.searchParams.get('dest');
        const chatId = this.app.cinemaDestinations.verifyToken(token);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const session = this.app.cinemaPlayback.getCurrentSession(chatId);
        const queue = this.app.cinemaQueue.getQueue(chatId);

        // Get active poll if any
        const poll = this.app.db.get(
          `SELECT poll_session_id FROM cinema_poll_sessions 
           WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND status = 'open'
           ORDER BY id DESC LIMIT 1`,
          chatId
        );
        const pollData = poll ? this.app.cinemaPoll.getPollResults(poll.poll_session_id) : null;

        return sendJson(200, {
          ok: true,
          chatId,
          session: session || null,
          queueCount: queue.length,
          poll: pollData
        });
      }

      // 4. Queue Management
      if (pathname === '/cinema/api/queue') {
        const token = parsedUrl.searchParams.get('dest');
        const chatId = this.app.cinemaDestinations.verifyToken(token);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });
        const items = this.app.cinemaQueue.getQueue(chatId);
        return sendJson(200, { ok: true, queue: items });
      }

      if (pathname === '/cinema/api/queue/add' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const resQueue = await this.app.cinemaQueue.addToQueue(chatId, {
          mediaType: body.mediaType || 'movie',
          mediaId: body.mediaId,
          title: body.title,
          season: body.season,
          episode: body.episode,
          addedByUserId: body.userId || 0,
          playNext: Boolean(body.playNext)
        });
        return sendJson(200, resQueue);
      }

      if (pathname === '/cinema/api/queue/remove' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });
        const ok = this.app.cinemaQueue.removeFromQueue(chatId, body.queueItemId);
        return sendJson(200, { ok });
      }

      // 5. Remote Control (Double Tap / Seek / Play / Pause / Skip Intro / Volume)
      if (pathname === '/cinema/api/remote/control' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const action = body.action; // 'pause' | 'resume' | 'seek' | 'seek_delta' | 'skip_intro' | 'stop' | 'volume'

        if (action === 'pause') {
          await this.app.cinemaPlayback.pause(chatId);
          return sendJson(200, { ok: true, state: 'PAUSED' });
        }

        if (action === 'resume') {
          await this.app.cinemaPlayback.resume(chatId);
          return sendJson(200, { ok: true, state: 'PLAYING' });
        }

        if (action === 'seek') {
          const seconds = parseFloat(body.seconds || '0');
          await this.app.cinemaPlayback.seek(chatId, seconds);
          return sendJson(200, { ok: true, position: seconds });
        }

        // Double-Tap Forward / Rewind: ±10s, ±30s, etc.
        if (action === 'seek_delta') {
          const delta = parseFloat(body.delta || '10');
          const session = this.app.cinemaPlayback.getCurrentSession(chatId);
          const currentPos = session?.position || 0;
          const target = Math.max(0, currentPos + delta);
          await this.app.cinemaPlayback.seek(chatId, target);
          return sendJson(200, { ok: true, position: target, delta });
        }

        if (action === 'skip_intro') {
          const session = this.app.cinemaPlayback.getCurrentSession(chatId);
          const currentPos = session?.position || 0;
          const skipSeconds = parseFloat(body.seconds || '85'); // default 85s anime/tv intro
          const target = currentPos + skipSeconds;
          await this.app.cinemaPlayback.seek(chatId, target);
          return sendJson(200, { ok: true, position: target, skipped: skipSeconds });
        }

        if (action === 'stop') {
          await this.app.cinemaPlayback.stop(chatId);
          return sendJson(200, { ok: true, state: 'STOPPED' });
        }

        if (action === 'volume') {
          const vol = parseInt(body.volume || '100', 10);
          await this.app.cinemaPlayback.setVolume(chatId, vol);
          return sendJson(200, { ok: true, volume: vol });
        }

        return sendJson(400, { ok: false, error: 'INVALID_ACTION' });
      }

      // 6. Community Voting
      if (pathname === '/cinema/api/vote' && req.method === 'POST') {
        const body = await readBody();
        const chatId = this.app.cinemaDestinations.verifyToken(body.dest);
        if (!chatId) return sendJson(401, { ok: false, error: 'UNAUTHORIZED' });

        const resVote = await this.app.cinemaPoll.vote(body.pollSessionId, body.userId || 0, body.queueItemId);
        return sendJson(200, resVote);
      }

      // 404 for unknown cinema API routes
      return sendJson(404, { ok: false, error: 'NOT_FOUND', path: pathname });
    } catch (err) {
      log.error({ err: err?.message, pathname }, 'Error handling Cinema API request');
      return sendJson(500, { ok: false, error: 'INTERNAL_ERROR', message: err?.message });
    }
  }
}
