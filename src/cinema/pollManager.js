import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';

export class SynchronizedPollManager {
  constructor({ app, db, queueManager, playbackAdapter, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.queue = queueManager;
    this.playback = playbackAdapter;
    this.log = log || logger().child({ module: 'cinema:poll' });
    this.activePollTimers = new Map(); // pollSessionId -> timeout
    this.pausedPolls = new Map(); // pollSessionId -> remainingMs
  }

  #scheduleTimer(pollSessionId, delayMs) {
    const existing = this.activePollTimers.get(pollSessionId);
    if (existing) clearTimeout(existing);

    const safeDelay = Math.max(1000, Math.round(delayMs));
    const timer = setTimeout(() => {
      this.finalizePoll(pollSessionId).catch(() => {});
    }, safeDelay);
    timer?.unref?.();
    this.activePollTimers.set(pollSessionId, timer);
  }

  async startPoll(chatId, { durationSeconds = null } = {}) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id, voting_enabled FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest || !dest.voting_enabled) return null;

    // Close any previous open poll for this destination
    this.closePollForChat(numChat, 'superseded');

    const currentSession = this.playback.getCurrentSession(numChat);
    const sessionId = currentSession?.sessionId || `adhoc_${Date.now()}`;

    const upcoming = this.queue.getQueue(numChat).slice(0, 10);
    if (upcoming.length === 0) {
      this.log.debug({ numChat }, 'Cannot start poll: Queue is empty');
      return null;
    }

    const pollSessionId = `poll_${randomUUID().slice(0, 12)}`;

    let secondsUntilClose = durationSeconds;
    if (!secondsUntilClose && currentSession?.duration > 0) {
      const remaining = currentSession.duration - (currentSession.position || 0);
      secondsUntilClose = Math.max(30, remaining - 60);
    }
    if (!secondsUntilClose) secondsUntilClose = 300;

    const closesAt = new Date(Date.now() + secondsUntilClose * 1000).toISOString();

    const candidates = upcoming.map((item, idx) => ({
      index: idx + 1,
      queueItemId: item.queue_item_id,
      title: item.title,
      mediaType: item.media_type,
      mediaId: item.media_id,
      season: item.season,
      episode: item.episode,
      poster: item.poster || null
    }));

    this.db.run(
      `INSERT INTO cinema_poll_sessions 
       (destination_id, poll_session_id, playback_session_id, status, opened_at, closes_at, candidates_json)
       VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP, ?, ?)`,
      dest.id, pollSessionId, sessionId, closesAt, JSON.stringify(candidates)
    );

    if (currentSession?.state === 'PAUSED') {
      this.pausedPolls.set(pollSessionId, secondsUntilClose * 1000);
    } else {
      this.#scheduleTimer(pollSessionId, secondsUntilClose * 1000);
    }

    return {
      pollSessionId,
      closesAt,
      secondsUntilClose,
      isPaused: currentSession?.state === 'PAUSED',
      candidates
    };
  }

  pausePollForChat(chatId) {
    const active = this.getActivePoll(chatId);
    if (!active) return;
    const { pollSessionId, closesAt } = active;
    const timer = this.activePollTimers.get(pollSessionId);
    if (timer) {
      clearTimeout(timer);
      this.activePollTimers.delete(pollSessionId);
    }
    const remainingMs = Math.max(5000, new Date(closesAt).getTime() - Date.now());
    this.pausedPolls.set(pollSessionId, remainingMs);
  }

  resumePollForChat(chatId) {
    const active = this.getActivePoll(chatId);
    if (!active) return;
    const { pollSessionId, closesAt } = active;
    const remainingMs = this.pausedPolls.get(pollSessionId) ?? Math.max(5000, new Date(closesAt).getTime() - Date.now());
    this.pausedPolls.delete(pollSessionId);

    const newClosesAt = new Date(Date.now() + remainingMs).toISOString();
    this.db.run('UPDATE cinema_poll_sessions SET closes_at = ? WHERE poll_session_id = ?', newClosesAt, pollSessionId);
    this.#scheduleTimer(pollSessionId, remainingMs);
  }

  recalculatePollOnSeek(chatId, positionSeconds, durationSeconds) {
    const active = this.getActivePoll(chatId);
    if (!active || !durationSeconds || durationSeconds <= 0) return null;

    const { pollSessionId } = active;
    const remainingMediaSec = Math.max(0, durationSeconds - positionSeconds);
    const secondsUntilClose = Math.max(15, remainingMediaSec - 60);
    const remainingMs = secondsUntilClose * 1000;
    const newClosesAt = new Date(Date.now() + remainingMs).toISOString();

    this.db.run('UPDATE cinema_poll_sessions SET closes_at = ? WHERE poll_session_id = ?', newClosesAt, pollSessionId);
    if (this.pausedPolls.has(pollSessionId)) {
      this.pausedPolls.set(pollSessionId, remainingMs);
    } else {
      this.#scheduleTimer(pollSessionId, remainingMs);
    }
    return {
      pollSessionId,
      closesAt: newClosesAt,
      remainingSeconds: secondsUntilClose
    };
  }

  async finalizePollForChat(chatId) {
    const active = this.getActivePoll(chatId);
    if (!active) return null;
    return this.finalizePoll(active.pollSessionId);
  }

  async vote(pollSessionId, userId, queueItemId) {
    const numUser = Number(userId || 0);
    const poll = this.db.get("SELECT * FROM cinema_poll_sessions WHERE poll_session_id = ? AND status = 'open'", pollSessionId);
    if (!poll) return { ok: false, message: 'This poll is already closed.' };

    const candidates = JSON.parse(poll.candidates_json || '[]');
    const isValidCandidate = candidates.some(c => c.queueItemId === queueItemId);
    if (!isValidCandidate) return { ok: false, message: 'Invalid movie candidate.' };

    this.db.run(
      `INSERT INTO cinema_votes (poll_session_id, user_id, queue_item_id, voted_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(poll_session_id, user_id) DO UPDATE SET
         queue_item_id = excluded.queue_item_id,
         voted_at = CURRENT_TIMESTAMP`,
      pollSessionId, numUser, queueItemId
    );

    return {
      ok: true,
      message: 'Vote recorded!',
      poll: this.getPollResults(pollSessionId)
    };
  }

  getActivePoll(chatId) {
    const numChat = Number(chatId);
    const row = this.db.get(
      `SELECT p.* FROM cinema_poll_sessions p
       JOIN cinema_destinations d ON p.destination_id = d.id
       WHERE d.chat_id = ? AND p.status = 'open'
       ORDER BY p.id DESC LIMIT 1`,
      numChat
    );
    if (!row) return null;
    const isPaused = this.pausedPolls.has(row.poll_session_id);
    return {
      pollSessionId: row.poll_session_id,
      playbackSessionId: row.playback_session_id,
      status: row.status,
      openedAt: row.opened_at,
      closesAt: row.closes_at,
      isPaused,
      paused: isPaused,
      pausedRemainingMs: this.pausedPolls.get(row.poll_session_id) || null,
      candidates: JSON.parse(row.candidates_json || '[]')
    };
  }

  getPollResults(pollSessionId) {
    const poll = this.db.get('SELECT * FROM cinema_poll_sessions WHERE poll_session_id = ?', pollSessionId);
    if (!poll) return null;

    const candidates = JSON.parse(poll.candidates_json || '[]');
    const votes = this.db.all(
      `SELECT queue_item_id, COUNT(*) as vote_count 
       FROM cinema_votes WHERE poll_session_id = ? 
       GROUP BY queue_item_id`,
      pollSessionId
    ) || [];

    const voteMap = new Map(votes.map(v => [v.queue_item_id, v.vote_count]));
    const tally = candidates.map(c => ({
      ...c,
      votes: voteMap.get(c.queueItemId) || 0
    })).sort((a, b) => b.votes - a.votes);

    const totalVotes = votes.reduce((sum, v) => sum + v.vote_count, 0);

    return {
      pollSessionId: poll.poll_session_id,
      status: poll.status,
      closesAt: poll.closes_at,
      isPaused: this.pausedPolls.has(poll.poll_session_id),
      pausedRemainingMs: this.pausedPolls.get(poll.poll_session_id) || null,
      totalVotes,
      tally,
      candidates: tally,
      winner: poll.winner_queue_item_id
        ? candidates.find(c => c.queueItemId === poll.winner_queue_item_id)
        : (tally[0]?.votes > 0 ? tally[0] : null)
    };
  }

  async finalizePoll(pollSessionId) {
    const timer = this.activePollTimers.get(pollSessionId);
    if (timer) {
      clearTimeout(timer);
      this.activePollTimers.delete(pollSessionId);
    }
    this.pausedPolls.delete(pollSessionId);

    const poll = this.db.get("SELECT * FROM cinema_poll_sessions WHERE poll_session_id = ? AND status = 'open'", pollSessionId);
    if (!poll) return null;

    const preliminary = this.getPollResults(pollSessionId);
    const winner = preliminary?.winner;

    this.db.run(
      `UPDATE cinema_poll_sessions 
       SET status = 'closed', winner_queue_item_id = ? 
       WHERE poll_session_id = ?`,
      winner?.queueItemId || null, pollSessionId
    );

    if (winner?.queueItemId) {
      const dest = this.db.get('SELECT chat_id FROM cinema_destinations WHERE id = ?', poll.destination_id);
      if (dest?.chat_id) {
        if (typeof this.queue?.moveToTop === 'function') {
          this.queue.moveToTop(dest.chat_id, winner.queueItemId);
        } else {
          this.db.run(
            `UPDATE cinema_queue_items SET position = 1 
             WHERE destination_id = ? AND queue_item_id = ?`,
            poll.destination_id, winner.queueItemId
          );
        }
        this.log.info({ pollSessionId, winnerTitle: winner.title }, 'Poll winner promoted to queue position 1');
      }
    }

    return this.getPollResults(pollSessionId);
  }

  closePollForChat(chatId, reason = 'cancelled') {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return;

    const openPolls = this.db.all("SELECT poll_session_id FROM cinema_poll_sessions WHERE destination_id = ? AND status = 'open'", dest.id) || [];
    for (const p of openPolls) {
      const timer = this.activePollTimers.get(p.poll_session_id);
      if (timer) {
        clearTimeout(timer);
        this.activePollTimers.delete(p.poll_session_id);
      }
      this.pausedPolls.delete(p.poll_session_id);
      this.db.run('UPDATE cinema_poll_sessions SET status = ? WHERE poll_session_id = ?', reason, p.poll_session_id);
    }
  }
}
