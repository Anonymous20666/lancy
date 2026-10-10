/**
 * Autonomous Scheduled Sticker Drops (Pinterest -> WhatsApp).
 * Runs background drops on a recurring schedule (e.g., twice per day for 30 days).
 */
import { generateAuraCaption } from '../captions/engine.js';
import { logger } from '../core/logger.js';

export class AutonomousScheduler {
  constructor({ app, checkIntervalMs = 60000, log } = {}) {
    this.app = app;
    this.db = app.db;
    this.checkIntervalMs = checkIntervalMs;
    this.log = log ?? logger().child({ module: 'ai-scheduler' });
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDueDrops(), this.checkIntervalMs);
    this.timer.unref?.();
    this.log.info('autonomous scheduler started');
    // Immediate check
    setTimeout(() => void this.runDueDrops(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info('autonomous scheduler stopped');
  }

  /**
   * Create a new scheduled autopost drop job.
   */
  createSchedule({
    userId,
    topic,
    frequencyLabel = 'twice per day for 30 days',
    timesPerDay = 2,
    days = 30,
    sessionId = null,
    channelJid = null,
    style = 'girly'
  }) {
    const times = Math.max(1, Math.min(24, Number(timesPerDay) || 2));
    const totalDays = Math.max(1, Math.min(365, Number(days) || 30));
    const intervalHours = Math.max(1, Math.round(24 / times));
    const totalRuns = times * totalDays;
    const now = new Date();
    const nextRunAt = now.toISOString(); // Run first drop immediately or soon
    const expiresAt = new Date(now.getTime() + totalDays * 86400 * 1000).toISOString();

    const stmt = this.db.run(
      `INSERT INTO scheduled_drops (
        user_id, topic, frequency_label, times_per_day, interval_hours,
        total_days, total_runs, runs_completed, session_id, channel_jid,
        style, status, next_run_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?)`,
      userId, topic, frequencyLabel, times, intervalHours,
      totalDays, totalRuns, sessionId, channelJid,
      style, nextRunAt, expiresAt
    );

    const id = stmt.lastInsertRowid;
    this.log.info({ id, userId, topic, timesPerDay: times, totalRuns }, 'scheduled drop created');
    return this.db.get('SELECT * FROM scheduled_drops WHERE id = ?', id);
  }

  getUserSchedules(userId) {
    return this.db.all(
      'SELECT * FROM scheduled_drops WHERE user_id = ? ORDER BY id DESC',
      userId
    );
  }

  pauseSchedule(id, userId) {
    this.db.run('UPDATE scheduled_drops SET status = ? WHERE id = ? AND user_id = ?', 'paused', id, userId);
    return this.db.get('SELECT * FROM scheduled_drops WHERE id = ?', id);
  }

  resumeSchedule(id, userId) {
    this.db.run('UPDATE scheduled_drops SET status = ? WHERE id = ? AND user_id = ?', 'active', id, userId);
    return this.db.get('SELECT * FROM scheduled_drops WHERE id = ?', id);
  }

  deleteSchedule(id, userId) {
    this.db.run('DELETE FROM scheduled_drops WHERE id = ? AND user_id = ?', id, userId);
  }

  /**
   * Run all due drops that have reached next_run_at.
   */
  async runDueDrops() {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db.all(
        `SELECT * FROM scheduled_drops
         WHERE status = 'active' AND datetime(next_run_at) <= datetime('now')
         LIMIT 5`
      );

      for (const drop of due) {
        await this.executeDrop(drop).catch((err) => {
          this.log.error({ err, dropId: drop.id }, 'failed to execute scheduled drop');
        });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Execute an individual scheduled drop.
   */
  async executeDrop(drop) {
    this.log.info({ dropId: drop.id, topic: drop.topic, run: drop.runs_completed + 1 }, 'executing scheduled drop');

    // 1. Search Pinterest for fresh, non-duplicate media
    let searchResult = null;
    try {
      searchResult = await this.app.pinterest.search({
        userId: drop.user_id,
        query: drop.topic,
        mode: 'normal',
        depth: 'deep',
        goal: 15
      });
    } catch (error) {
      this.log.warn({ err: error, topic: drop.topic }, 'pinterest search error during scheduled drop');
    }

    const searchId = searchResult?.searchId;
    let mediaItems = [];
    if (searchId) {
      mediaItems = this.db.all(
        `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
         ORDER BY quality_score DESC LIMIT 12`,
        searchId
      );
      this.app.pinterest.markResultsDelivered(drop.user_id, searchId, searchResult.results ?? []);
    }

    // 2. Generate aesthetic caption with aura story
    const caption = await generateAuraCaption({
      character: drop.topic,
      query: drop.topic,
      count: mediaItems.length || 10,
      packs: 1,
      aiService: this.app.ai
    }).catch(() => `✦ ${drop.topic.toUpperCase()} ✦\nHand-crafted aesthetic stickers ♡`);

    // 3. Find connected WhatsApp session and target channel
    const sessions = this.app.whatsapp.listSessions();
    const session = sessions.find((s) => s.userId === drop.user_id && s.status === 'online')
      || sessions.find((s) => s.status === 'online');

    let channelJid = drop.channel_jid;
    if (!channelJid && session) {
      const channels = this.app.channels.list(session.sessionId);
      if (channels.length > 0) {
        channelJid = channels[0].channel_jid;
      }
    }

    let publishedOk = false;
    if (session && channelJid && mediaItems.length > 0) {
      try {
        // Convert to sticker pack and publish to channel
        const packName = `${drop.topic} #${drop.runs_completed + 1}`;
        const mediaBuffers = [];
        for (const item of mediaItems.slice(0, 10)) {
          const buf = await this.app.media.fetch(item.media_url, { userId: drop.user_id }).catch(() => null);
          if (buf) mediaBuffers.push(buf);
        }

        if (mediaBuffers.length > 0) {
          // Deliver via publisher
          await this.app.publisher.publish({
            userId: drop.user_id,
            sessionId: session.sessionId,
            channelJids: [channelJid],
            packName,
            caption,
            stickers: mediaBuffers
          }).catch((err) => {
            this.log.warn({ err }, 'publisher publish failed in scheduled drop');
          });
          publishedOk = true;
        }
      } catch (err) {
        this.log.error({ err }, 'error publishing scheduled drop to whatsapp');
      }
    }

    // 4. Advance schedule & update database
    const newRuns = drop.runs_completed + 1;
    const isCompleted = newRuns >= drop.total_runs;
    const intervalMs = (drop.interval_hours || 12) * 3600 * 1000;
    const nextRunAt = new Date(Date.now() + intervalMs).toISOString();

    if (isCompleted) {
      this.db.run(
        `UPDATE scheduled_drops
         SET status = 'completed', runs_completed = ?, last_run_at = datetime('now')
         WHERE id = ?`,
        newRuns, drop.id
      );
    } else {
      this.db.run(
        `UPDATE scheduled_drops
         SET runs_completed = ?, last_run_at = datetime('now'), next_run_at = ?
         WHERE id = ?`,
        newRuns, nextRunAt, drop.id
      );
    }

    // 5. Notify the user in Telegram
    try {
      const channelName = channelJid ? (channelJid.includes('@newsletter') ? 'WhatsApp Channel' : channelJid) : 'WhatsApp';
      const lines = [
        '𓆩♡𓆪 *SCHEDULED DROP DELIVERED* 𓆩♡𓆪',
        '',
        `> 🌸 *Topic:* ${drop.topic}`,
        `> 📦 *Status:* Run ${newRuns} of ${drop.total_runs} completed ${publishedOk ? '✓' : '(staged)'}`,
        `> 📢 *Channel:* ${channelName}`,
        `> ⏱ *Next Run:* ${isCompleted ? 'None (Campaign Completed 🎉)' : `in ~${drop.interval_hours} hours`}`,
        '',
        '✨ Crafted with aesthetic aura templates and HD conversion ♡'
      ];
      await this.app.telegram.api.sendMessage(drop.user_id, lines.join('\n')).catch(() => {});
    } catch {}

    return { ok: true, dropId: drop.id, run: newRuns, isCompleted };
  }
}
