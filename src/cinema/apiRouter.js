import { logger } from '../core/logger.js';

export class CinemaApiRouter {
  constructor({ app, log } = {}) {
    this.app = app;
    this.log = log || logger().child({ module: 'cinema:api-router' });
  }

  #resolveDestinationToken(token, initData) {
    let resolvedToken = token;
    let verifiedInit = null;

    if (initData && this.app?.cinemaDestinations?.verifyTelegramInitData) {
      verifiedInit = this.app.cinemaDestinations.verifyTelegramInitData(initData);
      if (verifiedInit?.valid && verifiedInit.startParam && !resolvedToken) {
        resolvedToken = verifiedInit.startParam;
      }
    }

    if (!resolvedToken || resolvedToken === 'default') {
      const def = this.app?.cinemaDestinations?.getDefaultDestination?.();
      if (def) {
        return {
          ok: true,
          chatId: Number(def.chatId),
          destination: def,
          token: this.app.cinemaDestinations.generateToken(def.chatId),
          isDefault: true,
          verifiedInit
        };
      }
      return { ok: false, error: 'NO_DESTINATION', message: 'No active Telegram destination registered yet.' };
    }

    const chatId = this.app.cinemaDestinations.verifyToken(resolvedToken);
    if (!chatId) {
      return { ok: false, error: 'INVALID_DESTINATION_TOKEN', message: 'Destination token expired or invalid.' };
    }

    const dest = this.app.cinemaDestinations.getDestinationByChatId(chatId);
    if (!dest) {
      return { ok: false, error: 'NOT_FOUND', message: 'Destination chat not found.' };
    }

    if (dest.botStatus && dest.botStatus !== 'active') {
      return {
        ok: false,
        error: 'DESTINATION_UNAVAILABLE',
        botStatus: dest.botStatus,
        destination: dest,
        message: `Destination status is ${dest.botStatus}. Re-verify bot administrator & video chat permissions in Telegram.`
      };
    }

    if (verifiedInit?.valid && verifiedInit.user?.id) {
      const authorized = this.app.cinemaDestinations.isAuthorized(chatId, verifiedInit.user.id);
      if (!authorized) {
        return {
          ok: false,
          error: 'FORBIDDEN_USER',
          destination: dest,
          message: 'Your Telegram account is not authorized to control playback for this destination.'
        };
      }
    }

    return {
      ok: true,
      chatId: Number(chatId),
      destination: dest,
      token: resolvedToken,
      verifiedInit
    };
  }

  async handle(req, res, parsedUrl) {
    const log = this.log;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, '');
    const initDataHeader = req.headers['x-telegram-init-data'] || parsedUrl.searchParams.get('initData') || '';

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

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // 0. Health Check
      if (pathname === '/cinema/api/health') {
        const apiHealth = await this.app.movieApi.getHealth().catch((err) => ({ status: 'degraded', error: err?.message }));
        const voiceHealth = await this.app.voiceClient?.checkHealth?.().catch(() => ({ ready: false }));
        return sendJson(200, {
          ok: true,
          movieApi: apiHealth,
          voiceEngine: {
            ready: Boolean(voiceHealth?.ready),
            activeCalls: voiceHealth?.active_calls_count || 0
          },
          serverTime: Date.now()
        });
      }

      // 1. Destination verification & metadata (includes session, queue, and activePoll)
      if (pathname === '/cinema/api/destination') {
        const token = parsedUrl.searchParams.get('dest') || '';
        const auth = this.#resolveDestinationToken(token, initDataHeader);
        if (!auth.ok) {
          const status = auth.error === 'NOT_FOUND' ? 404 : (auth.error === 'FORBIDDEN_USER' ? 403 : 401);
          return sendJson(status, {
            ok: false,
            error: auth.error,
            botStatus: auth.botStatus || null,
            destination: auth.destination || null,
            message: auth.message
          });
        }
        const session = this.app.cinemaPlayback.getCurrentSession(auth.chatId);
        const queue = this.app.cinemaQueue.getQueue(auth.chatId);
        const activePollRow = this.app.cinemaPoll.getActivePoll(auth.chatId);
        const activePoll = activePollRow ? this.app.cinemaPoll.getPollResults(activePollRow.pollSessionId) : null;

        return sendJson(200, {
          ok: true,
          token: auth.token,
          isDefault: Boolean(auth.isDefault),
          destination: {
            ...auth.destination,
            vcActive: Boolean(session && ['PLAYING', 'PAUSED', 'PREPARING'].includes(session.state))
          },
          session: session || null,
          queue,
          activePoll
        });
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

      if (pathname === '/cinema/api/top-rated') {
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const data = await this.app.movieApi.getTopRated({ type, page });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/latest' || pathname === '/cinema/api/latest/movies' || pathname === '/cinema/api/latest/episodes') {
        const type = pathname.endsWith('/episodes')
          ? 'episodes'
          : pathname.endsWith('/movies')
          ? 'movie'
          : (parsedUrl.searchParams.get('type') || 'movie');
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const data = (type === 'tv' || type === 'episodes')
          ? await this.app.movieApi.getLatestEpisodes(page)
          : await this.app.movieApi.getLatestMovies(page);
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/genres') {
        const data = await this.app.movieApi.getGenres();
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/categories') {
        const data = await this.app.movieApi.getCategories();
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/browse') {
        const category = parsedUrl.searchParams.get('category') || undefined;
        const genreId = parsedUrl.searchParams.get('genreId') || undefined;
        const type = parsedUrl.searchParams.get('type') || 'movie';
        const sortBy = parsedUrl.searchParams.get('sortBy') || 'popularity.desc';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const data = await this.app.movieApi.browse({ category, genreId, type, sortBy, page });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/search') {
        const q = parsedUrl.searchParams.get('q') || '';
        const type = parsedUrl.searchParams.get('type') || 'all';
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        if (!q.trim()) return sendJson(200, { ok: true, data: { results: [], page: 1 } });

        if (type === 'all') {
          const [moviesRes, tvRes] = await Promise.all([
            this.app.movieApi.search(q, { type: 'movie', page }).catch(() => ({ results: [] })),
            this.app.movieApi.search(q, { type: 'tv', page }).catch(() => ({ results: [] }))
          ]);
          const mList = Array.isArray(moviesRes?.results) ? moviesRes.results : (Array.isArray(moviesRes) ? moviesRes : []);
          const tList = Array.isArray(tvRes?.results) ? tvRes.results : (Array.isArray(tvRes) ? tvRes : []);
          const combined = [];
          const maxLen = Math.max(mList.length, tList.length);
          for (let i = 0; i < maxLen; i++) {
            if (mList[i]) combined.push({ ...mList[i], type: mList[i].type || 'movie' });
            if (tList[i]) combined.push({ ...tList[i], type: tList[i].type || 'tv' });
          }
          return sendJson(200, { ok: true, data: { results: combined, count: combined.length, page } });
        }

        const data = await this.app.movieApi.search(q, { type, page });
        return sendJson(200, { ok: true, data });
      }

      if (pathname === '/cinema/api/details' || pathname === '/cinema/api/movie' || pathname === '/cinema/api/tv') {
        const type = pathname === '/cinema/api/tv'
          ? 'tv'
          : pathname === '/cinema/api/movie'
          ? 'movie'
          : (parsedUrl.searchParams.get('type') || 'movie');
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

      if (pathname === '/cinema/api/tv/episode') {
        const id = parsedUrl.searchParams.get('id');
        const season = parsedUrl.searchParams.get('season');
        const episode = parsedUrl.searchParams.get('episode');
        if (!id || !season || !episode) return sendJson(400, { ok: false, error: 'MISSING_PARAMS' });
        const data = await this.app.movieApi.getTvEpisode(id, season, episode);
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
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const session = await this.app.cinemaPlayback.play(auth.chatId, {
          mediaType: body.mediaType || 'movie',
          mediaId: body.mediaId,
          title: body.title,
          season: body.season,
          episode: body.episode,
          source: body.source || body.sourceUrl || null,
          offset: parseFloat(body.offset || '0'),
          duration: parseFloat(body.duration || '0'),
          poster: body.poster || null,
          backdrop: body.backdrop || null,
          year: body.year || null,
          rating: body.rating || null,
          genres: body.genres || null,
          overview: body.overview || null,
          isChannel: auth.destination?.chatType === 'channel'
        });
        return sendJson(200, { ok: true, session });
      }

      // Start Community Poll
      if (pathname === '/cinema/api/poll/start' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const durationSeconds = parseInt(body.durationSeconds || '0', 10) || undefined;
        const poll = await this.app.cinemaPoll.startPoll(auth.chatId, { durationSeconds });
        if (!poll) return sendJson(400, { ok: false, message: 'Queue is empty or voting is disabled for this destination.' });

        if (this.app?.cinemaCards?.postOrUpdateCard) {
          this.app.cinemaCards.postOrUpdateCard(auth.chatId).catch(() => {});
        }
        return sendJson(200, { ok: true, poll: this.app.cinemaPoll.getPollResults(poll.pollSessionId) });
      }

      if (pathname === '/cinema/api/poll/close' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const finalized = await this.app.cinemaPoll.finalizePollForChat(auth.chatId);
        if (this.app?.cinemaCards?.postOrUpdateCard) {
          this.app.cinemaCards.postOrUpdateCard(auth.chatId).catch(() => {});
        }
        return sendJson(200, {
          ok: true,
          poll: finalized,
          result: finalized,
          queue: this.app.cinemaQueue.getQueue(auth.chatId)
        });
      }

      if (pathname === '/cinema/api/destination/voting' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const enabled = Boolean(body.enabled);
        this.app.cinemaDestinations.toggleVoting(auth.chatId, enabled);
        if (!enabled) {
          this.app.cinemaPoll.closePollForChat(auth.chatId, 'voting_disabled');
        }
        const updatedDest = this.app.cinemaDestinations.getDestinationByChatId(auth.chatId);
        return sendJson(200, { ok: true, votingEnabled: enabled, destination: updatedDest });
      }

      // 3. Status & Authoritative Playback Clock
      if (pathname === '/cinema/api/status') {
        const token = parsedUrl.searchParams.get('dest') || '';
        const auth = this.#resolveDestinationToken(token, initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const session = this.app.cinemaPlayback.getCurrentSession(auth.chatId);
        const queue = this.app.cinemaQueue.getQueue(auth.chatId);

        const poll = this.app.db.get(
          `SELECT poll_session_id FROM cinema_poll_sessions 
           WHERE destination_id = (SELECT id FROM cinema_destinations WHERE chat_id = ?) AND status = 'open'
           ORDER BY id DESC LIMIT 1`,
          auth.chatId
        );
        const pollData = poll ? this.app.cinemaPoll.getPollResults(poll.poll_session_id) : null;

        return sendJson(200, {
          ok: true,
          chatId: auth.chatId,
          destination: auth.destination,
          session: session || null,
          queue,
          queueCount: queue.length,
          poll: pollData,
          activePoll: pollData,
          serverTime: Date.now()
        });
      }

      // 4. Queue Management
      if (pathname === '/cinema/api/queue') {
        const token = parsedUrl.searchParams.get('dest') || '';
        const auth = this.#resolveDestinationToken(token, initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });
        const items = this.app.cinemaQueue.getQueue(auth.chatId);
        return sendJson(200, { ok: true, queue: items });
      }

      if (pathname === '/cinema/api/queue/add' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        if ((Array.isArray(body.episodes) && body.episodes.length > 0) || body.addSeason) {
          const resSeason = await this.app.cinemaQueue.addSeasonToQueue(auth.chatId, {
            mediaId: body.mediaId,
            title: body.title,
            season: body.season || 1,
            episodes: body.episodes || [],
            poster: body.poster || null,
            backdrop: body.backdrop || null,
            year: body.year || null,
            rating: body.rating || null,
            addedByUserId: body.userId || auth.verifiedInit?.user?.id || 0
          });
          return sendJson(200, { ...resSeason, queue: this.app.cinemaQueue.getQueue(auth.chatId) });
        }

        const resQueue = await this.app.cinemaQueue.addToQueue(auth.chatId, {
          mediaType: body.mediaType || 'movie',
          mediaId: body.mediaId,
          title: body.title,
          season: body.season,
          episode: body.episode,
          poster: body.poster || null,
          backdrop: body.backdrop || null,
          year: body.year || null,
          rating: body.rating || null,
          duration: body.duration || null,
          episodeTitle: body.episodeTitle || null,
          overview: body.overview || null,
          addedByName: body.addedByName || auth.verifiedInit?.user?.first_name || null,
          addedByUserId: body.userId || auth.verifiedInit?.user?.id || 0,
          playNext: Boolean(body.playNext)
        });
        return sendJson(200, { ...resQueue, queue: this.app.cinemaQueue.getQueue(auth.chatId) });
      }

      if (pathname === '/cinema/api/queue/remove' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });
        const ok = this.app.cinemaQueue.removeFromQueue(auth.chatId, body.queueItemId);
        return sendJson(200, { ok, queue: this.app.cinemaQueue.getQueue(auth.chatId) });
      }

      if (pathname === '/cinema/api/queue/move' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });
        const ok = this.app.cinemaQueue.moveQueueItem(auth.chatId, body.queueItemId, body.direction || 'up');
        return sendJson(200, { ok, queue: this.app.cinemaQueue.getQueue(auth.chatId) });
      }

      if (pathname === '/cinema/api/queue/reorder' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });
        const ok = this.app.cinemaQueue.reorderQueue(auth.chatId, body.orderedIds || []);
        return sendJson(200, { ok, queue: this.app.cinemaQueue.getQueue(auth.chatId) });
      }

      if (pathname === '/cinema/api/queue/clear' && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });
        const ok = this.app.cinemaQueue.clearQueue(auth.chatId);
        return sendJson(200, { ok, queue: [] });
      }

      // 5. Remote Control (Seek / Play / Pause / Skip Intro / Volume / Next / Previous)
      if ((pathname === '/cinema/api/remote/control' || pathname === '/cinema/api/control') && req.method === 'POST') {
        const body = await readBody();
        const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
        if (!auth.ok) return sendJson(401, { ok: false, error: auth.error, message: auth.message });

        const chatId = auth.chatId;
        const action = body.action;

        if (action === 'pause') {
          const resPause = await this.app.cinemaPlayback.pause(chatId);
          return sendJson(200, { ok: true, state: 'PAUSED', position: resPause.position, session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        if (action === 'resume' || action === 'play') {
          await this.app.cinemaPlayback.resume(chatId);
          return sendJson(200, { ok: true, state: 'PLAYING', session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        if (action === 'seek') {
          const seconds = parseFloat(body.value ?? body.seconds ?? '0');
          await this.app.cinemaPlayback.seek(chatId, seconds);
          return sendJson(200, { ok: true, position: seconds, session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        if (action === 'seek_delta') {
          const delta = parseFloat(body.value ?? body.delta ?? '10');
          const session = this.app.cinemaPlayback.getCurrentSession(chatId);
          const currentPos = session?.position || 0;
          const target = Math.max(0, currentPos + delta);
          await this.app.cinemaPlayback.seek(chatId, target);
          return sendJson(200, { ok: true, position: target, delta, session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        if (action === 'skip_intro') {
          const session = this.app.cinemaPlayback.getCurrentSession(chatId);
          const currentPos = session?.position || 0;
          const skipSeconds = parseFloat(body.value ?? body.seconds ?? '85');
          const target = currentPos + skipSeconds;
          await this.app.cinemaPlayback.seek(chatId, target);
          return sendJson(200, { ok: true, position: target, skipped: skipSeconds, session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        if (action === 'next') {
          const resNext = await this.app.cinemaPlayback.next(chatId);
          return sendJson(200, { ...resNext, queue: this.app.cinemaQueue.getQueue(chatId) });
        }

        if (action === 'previous') {
          const resPrev = await this.app.cinemaPlayback.previous(chatId);
          return sendJson(200, { ...resPrev, queue: this.app.cinemaQueue.getQueue(chatId) });
        }

        if (action === 'stop') {
          await this.app.cinemaPlayback.stop(chatId);
          return sendJson(200, { ok: true, state: 'STOPPED', session: null });
        }

        if (action === 'volume') {
          const vol = parseInt(body.value ?? body.volume ?? '100', 10);
          await this.app.cinemaPlayback.setVolume(chatId, vol);
          return sendJson(200, { ok: true, volume: vol, session: this.app.cinemaPlayback.getCurrentSession(chatId) });
        }

        return sendJson(400, { ok: false, error: 'INVALID_ACTION' });
      }

      // 6. Community Voting
      if ((pathname === '/cinema/api/vote' || pathname === '/cinema/api/poll/vote') && req.method === 'POST') {
        const body = await readBody();
        let voterId = body.userId;
        if (!voterId) {
          const auth = this.#resolveDestinationToken(body.dest, body.initData || initDataHeader);
          voterId = auth.verifiedInit?.user?.id || Math.floor(Math.random() * 900000 + 100000);
        }
        const resVote = await this.app.cinemaPoll.vote(body.pollSessionId, voterId, body.queueItemId);
        return sendJson(200, resVote);
      }

      return sendJson(404, { ok: false, error: 'NOT_FOUND', path: pathname });
    } catch (err) {
      log.error({ err: err?.message, pathname }, 'Error handling Cinema API request');
      return sendJson(500, { ok: false, error: 'INTERNAL_ERROR', message: err?.message });
    }
  }
}
