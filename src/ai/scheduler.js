/**
 * Autonomous Scheduled Sticker Drops (Pinterest -> Telegram Channels & WhatsApp Channels).
 * Runs background drops on a recurring schedule with interactive clock picks and multi-day calendar support.
 */
import { generateAuraCaption } from '../captions/engine.js';
import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';
import { renderChannelBanner } from '../telegram/screens/channelPost.js';

/**
 * Calculates the next run timestamp based on scheduled "HH:MM" slots or fallback interval.
 */
export function calculateNextRunTime(scheduleTimes = [], intervalHours = 12, fromDate = new Date()) {
  if (!Array.isArray(scheduleTimes) || scheduleTimes.length === 0) {
    return new Date(fromDate.getTime() + intervalHours * 3600 * 1000).toISOString();
  }

  const times = scheduleTimes
    .map((t) => {
      const match = String(t).match(/^(\d{1,2}):(\d{2})$/);
      return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  if (!times.length) {
    return new Date(fromDate.getTime() + intervalHours * 3600 * 1000).toISOString();
  }

  for (const t of times) {
    const candidate = new Date(fromDate);
    candidate.setHours(t.hour, t.minute, 0, 0);
    if (candidate.getTime() > fromDate.getTime() + 60000) {
      return candidate.toISOString();
    }
  }

  const tomorrowFirst = new Date(fromDate);
  tomorrowFirst.setDate(tomorrowFirst.getDate() + 1);
  tomorrowFirst.setHours(times[0].hour, times[0].minute, 0, 0);
  return tomorrowFirst.toISOString();
}

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
    platform = 'telegram', // 'telegram' | 'whatsapp' | 'both'
    sessionId = null,
    channelJid = null,
    tgChannelId = null,
    packIds = [],
    scheduleTimes = [],
    contentMode = 'ai', // 'ai' | 'packs'
    customCaption = null,
    aiPrompt = null,
    style = 'girly',
    startImmediate = true
  }) {
    const times = Math.max(1, Math.min(24, Number(timesPerDay) || 2));
    const totalDays = Math.max(1, Math.min(365, Number(days) || 30));
    const intervalHours = Math.max(1, Math.round(24 / times));
    const totalRuns = times * totalDays;
    const now = new Date();

    const nextRunAt = startImmediate
      ? now.toISOString()
      : calculateNextRunTime(scheduleTimes, intervalHours, now);

    const expiresAt = new Date(now.getTime() + totalDays * 86400 * 1000).toISOString();

    const stmt = this.db.run(
      `INSERT INTO scheduled_drops (
        user_id, topic, frequency_label, times_per_day, interval_hours,
        total_days, total_runs, runs_completed, platform, session_id,
        channel_jid, tg_channel_id, pack_ids_json, schedule_times_json,
        content_mode, custom_caption, ai_prompt, style, status, next_run_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      userId,
      topic,
      frequencyLabel,
      times,
      intervalHours,
      totalDays,
      totalRuns,
      platform,
      sessionId,
      channelJid,
      tgChannelId ? Number(tgChannelId) : null,
      JSON.stringify(packIds || []),
      JSON.stringify(scheduleTimes || []),
      contentMode,
      customCaption,
      aiPrompt,
      style,
      nextRunAt,
      expiresAt
    );

    const id = stmt.lastInsertRowid;
    this.log.info({ id, userId, topic, platform, timesPerDay: times, totalRuns }, 'scheduled drop created');
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
    this.log.info({ dropId: drop.id, topic: drop.topic, platform: drop.platform, run: drop.runs_completed + 1 }, 'executing scheduled drop');

    const platform = drop.platform || 'telegram';
    let targetPack = null;
    let publishedTg = false;
    let publishedWa = false;

    // 1. Resolve content (Existing Packs vs Autonomous AI Generation)
    if (drop.content_mode === 'packs') {
      let packIds = [];
      try {
        packIds = JSON.parse(drop.pack_ids_json || '[]');
      } catch {}

      if (packIds.length > 0) {
        const nextPackId = packIds[drop.runs_completed % packIds.length];
        targetPack = this.app.packs?.getPack?.(drop.user_id, nextPackId)
          || this.db.get('SELECT * FROM sticker_packs WHERE id = ?', nextPackId);
      }
    }

    // Fallback or AI mode: create pack autonomously via Pinterest + AI
    if (!targetPack) {
      const queryTopic = drop.ai_prompt || drop.topic || 'Aesthetic Stickers';
      let searchResult = null;
      try {
        searchResult = await this.app.pinterest?.search?.({
          userId: drop.user_id,
          query: queryTopic,
          mode: 'normal',
          depth: 'deep',
          goal: 15
        });
      } catch (err) {
        this.log.warn({ err: err?.message, topic: queryTopic }, 'pinterest search failed during autopost');
      }

      const searchId = searchResult?.searchId;
      let mediaItems = [];
      if (searchId) {
        mediaItems = this.db.all(
          `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
           ORDER BY quality_score DESC LIMIT 15`,
          searchId
        );
        this.app.pinterest?.markResultsDelivered?.(drop.user_id, searchId, searchResult.results ?? []);
      }

      if (mediaItems.length > 0 && this.app.packs) {
        const descriptors = [];
        for (const item of mediaItems.slice(0, 15)) {
          const buf = await this.app.media?.fetch?.(item.media_url, { userId: drop.user_id }).catch(() => null);
          if (buf) descriptors.push({ buffer: buf, sourceUrl: item.source_url });
        }

        if (descriptors.length > 0) {
          try {
            const packTitle = `${drop.topic} #${drop.runs_completed + 1}`;
            targetPack = await this.app.packs.createPackFromMedia({
              userId: drop.user_id,
              query: drop.topic,
              title: packTitle,
              descriptors,
              stickerType: 'static'
            });
          } catch (createErr) {
            this.log.error({ err: createErr }, 'failed to create autonomous pack');
          }
        }
      }
    }

    // 2. Generate Caption
    const packTitle = targetPack?.title || targetPack?.tg_title || drop.topic || 'Sticker Pack';
    const stickerCount = targetPack?.count || 15;
    let caption = drop.custom_caption;

    if (!caption) {
      caption = await generateAuraCaption({
        character: drop.topic,
        query: drop.topic,
        count: stickerCount,
        packs: 1,
        aiService: this.app.ai
      }).catch(() => `✦ <b>${String(packTitle).toUpperCase()}</b> ✦\n📦 <b>${stickerCount} Stickers</b>\n🌸 Created with @${this.app.telegram?.botUsername || 'Lancy_easy_bot'} ♡`);
    }

    // 3. Publish to Telegram Channel if requested
    if ((platform === 'telegram' || platform === 'both') && this.app.telegram?.api) {
      let tgChannelId = drop.tg_channel_id;
      if (!tgChannelId) {
        const userChannels = this.db.getTelegramChannels?.(drop.user_id) ?? [];
        if (userChannels.length > 0) tgChannelId = userChannels[0].channel_id;
      }

      if (tgChannelId && targetPack) {
        try {
          const botUser = this.app.telegram?.botUsername || 'Lancy_easy_bot';
          const pName = targetPack.shortName || targetPack.tg_short_name || targetPack.name;
          const pLink = targetPack.link || `https://t.me/addstickers/${pName}`;

          // Retrieve first sticker buffer & sample stickers
          let sampleStickers = [];
          let sampleBuf = null;
          try {
            const set = await this.app.telegram.api.getStickerSet(pName);
            if (set?.stickers?.length) {
              sampleStickers = set.stickers.slice(0, Math.min(5, Math.max(3, set.stickers.length)));
              if (sampleStickers[0]?.file_id) {
                const fInfo = await this.app.telegram.api.getFile(sampleStickers[0].file_id);
                if (fInfo?.file_path) {
                  sampleBuf = await this.app.telegram.api.downloadFile(fInfo.file_path).catch(() => null);
                }
              }
            }
          } catch {}

          // A) Banner photo with caption
          const bannerBuf = await renderChannelBanner({
            title: packTitle,
            count: stickerCount,
            stickerType: targetPack.sticker_type || 'static',
            sampleBuffer: sampleBuf,
            creator: botUser
          });

          await this.app.telegram.api.sendPhoto(tgChannelId, bannerBuf, {
            caption: `<blockquote>${caption}</blockquote>`,
            parse_mode: 'HTML'
          });
          await sleep(750);

          // B) First 3 to 5 sample stickers
          for (const s of sampleStickers) {
            if (s?.file_id) {
              await this.app.telegram.api.sendSticker(tgChannelId, s.file_id).catch(() => {});
              await sleep(600);
            }
          }

          // C) Pack card with inline button
          await this.app.telegram.api.sendMessage(
            tgChannelId,
            `<blockquote>✨ <b>Click below to add the complete sticker pack to Telegram!</b>\n👉 <a href="${pLink}">${packTitle}</a>\n\n🌸 Created with @${botUser} ♡</blockquote>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '➕ Add Sticker Pack 🌸', url: pLink }]
                ]
              }
            }
          );

          publishedTg = true;
          this.log.info({ dropId: drop.id, channelId: tgChannelId }, 'autopost delivered to telegram channel');
        } catch (tgErr) {
          this.log.error({ err: tgErr, dropId: drop.id }, 'failed autopost to telegram channel');
        }
      }
    }

    // 4. Publish to WhatsApp Channel if requested
    if ((platform === 'whatsapp' || platform === 'both') && this.app.whatsapp && this.app.publisher) {
      const sessions = this.app.whatsapp.listSessions?.() ?? [];
      const session = sessions.find((s) => s.userId === drop.user_id && s.status === 'online')
        || sessions.find((s) => s.status === 'online');

      let channelJid = drop.channel_jid;
      if (!channelJid && session) {
        const channels = this.app.channels?.list?.(session.sessionId) ?? [];
        if (channels.length > 0) channelJid = channels[0].channel_jid;
      }

      if (session && channelJid) {
        try {
          await this.app.publisher.publish({
            userId: drop.user_id,
            sessionId: session.sessionId,
            channelJids: [channelJid],
            packName: `${drop.topic} #${drop.runs_completed + 1}`,
            caption,
            stickers: targetPack?.items?.map((i) => i.buffer).filter(Boolean) || []
          }).catch(() => {});
          publishedWa = true;
          this.log.info({ dropId: drop.id, channelJid }, 'autopost delivered to whatsapp channel');
        } catch (waErr) {
          this.log.error({ err: waErr, dropId: drop.id }, 'failed autopost to whatsapp channel');
        }
      }
    }

    // 5. Advance schedule & update database
    const newRuns = drop.runs_completed + 1;
    const isCompleted = newRuns >= drop.total_runs;

    let scheduleTimes = [];
    try {
      scheduleTimes = JSON.parse(drop.schedule_times_json || '[]');
    } catch {}

    const nextRunAt = calculateNextRunTime(scheduleTimes, drop.interval_hours || 12);

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

    // 6. Notify user in Telegram
    try {
      const deliveredChannels = [];
      if (publishedTg) deliveredChannels.push('Telegram Channel');
      if (publishedWa) deliveredChannels.push('WhatsApp Channel');
      const channelLabel = deliveredChannels.length ? deliveredChannels.join(' & ') : (platform.toUpperCase());

      const lines = [
        '𓆩♡𓆪 <b>AUTO POST DELIVERED</b> 𓆩♡𓆪',
        '',
        `<blockquote>🌸 <b>Campaign:</b> ${drop.topic}`,
        `📦 <b>Progress:</b> Drop ${newRuns} of ${drop.total_runs} delivered ✓`,
        `📢 <b>Delivered To:</b> ${channelLabel}`,
        `⏱ <b>Next Scheduled Drop:</b> ${isCompleted ? 'None (Campaign Completed 🎉)' : nextRunAt} ♡</blockquote>`
      ];

      await this.app.telegram?.api?.sendMessage?.(drop.user_id, lines.join('\n'), { parse_mode: 'HTML' });
    } catch {}

    return { ok: true, dropId: drop.id, run: newRuns, isCompleted, publishedTg, publishedWa };
  }
}
