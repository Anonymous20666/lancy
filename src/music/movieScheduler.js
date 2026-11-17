import { randomBytes } from 'node:crypto';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../telegram/rich.js';
import { logger } from '../core/logger.js';

const cut = (s, n = 80) => [...String(s || '')].slice(0, n).join('');

export function formatCountdown(msRemaining) {
  const ms = Math.max(0, Number(msRemaining) || 0);
  if (ms < 60_000) return '< 1m';
  const totalMin = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 && days === 0) parts.push(`${mins}m`);
  return parts.join(' ') || '1m';
}

export function countdownStepKey(msRemaining) {
  const ms = Math.max(0, Number(msRemaining) || 0);
  const mins = Math.ceil(ms / 60_000);
  if (mins <= 1) return 'now';
  if (mins <= 30) return `m:${Math.ceil(mins / 2) * 2}`;
  if (mins <= 120) return `m:${Math.ceil(mins / 10) * 10}`;
  return `m:${Math.ceil(mins / 30) * 30}`;
}

function getTimezoneOffsetMs(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(date);
    const map = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const tzWallUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour === 24 ? 0 : map.hour, map.minute, map.second);
    return tzWallUtc - date.getTime();
  } catch {
    return 0;
  }
}

export function formatClockInTz(epochMs, timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(new Date(epochMs)) + ` (${timeZone || 'UTC'})`;
  } catch {
    return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

/**
 * Parse natural /schedule commands like:
 * - "Bahubali 9pm" / "Bahubali at 21:30"
 * - "Inception in 2h" / "Inception in 45m" / "Inception in 1h30m"
 * - "Demon Slayer S01E02 tomorrow 8pm daily"
 */
export function parseScheduleInput(rawInput, { nowMs = Date.now(), timezone = 'UTC' } = {}) {
  let text = String(rawInput || '').trim();
  if (!text) return null;

  let repeatRule = null;
  const repMatch = text.match(/\b(daily|weekly)\s*$/i);
  if (repMatch) {
    repeatRule = repMatch[1].toLowerCase();
    text = text.slice(0, repMatch.index).trim();
  }

  // Relative offset: "in 2h", "in 45m", "in 1h30m"
  const relMatch = text.match(/\b(?:in)\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?\s*$/i);
  if (relMatch && (relMatch[1] || relMatch[2])) {
    const hrs = Number(relMatch[1] || 0);
    const mins = Number(relMatch[2] || 0);
    const deltaMs = (hrs * 60 + mins) * 60_000;
    const title = text.slice(0, relMatch.index).replace(/\s+(?:at|on)\s*$/i, '').trim();
    if (title && deltaMs >= 60_000) {
      return { title, scheduledAt: nowMs + deltaMs, repeatRule };
    }
  }

  // Clock time: "[tomorrow|tonight|today] [at] HH[:MM] [am|pm]"
  const timeMatch = text.match(/\b(?:(tomorrow|tonight|today)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
  if (timeMatch) {
    const dayHint = String(timeMatch[1] || '').toLowerCase();
    let hour = Number(timeMatch[2]);
    const minute = Number(timeMatch[3] || 0);
    const ampm = String(timeMatch[4] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    else if (ampm === 'am' && hour === 12) hour = 0;

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && (ampm || timeMatch[3] !== undefined || dayHint || /\bat\b/i.test(text))) {
      const title = text.slice(0, timeMatch.index).replace(/\s+(?:at|on)\s*$/i, '').trim();
      if (title) {
        const now = new Date(nowMs);
        const offsetMs = getTimezoneOffsetMs(timezone, now);
        const wallNow = new Date(nowMs + offsetMs);
        let targetUtc = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate(), hour, minute, 0, 0) - offsetMs;
        if (dayHint === 'tomorrow') {
          targetUtc += 24 * 3600_000;
        } else if (targetUtc <= nowMs + 60_000) {
          targetUtc += 24 * 3600_000;
        }
        return { title, scheduledAt: targetUtc, repeatRule };
      }
    }
  }

  return null;
}

export class MovieScheduleService {
  constructor({ app, db, settings, checkIntervalMs = 30_000, log } = {}) {
    this.app = app;
    this.db = db || app?.db || null;
    this.settings = settings || app?.settings || null;
    this.checkIntervalMs = Math.max(5_000, Number(checkIntervalMs) || 30_000);
    this.log = log || logger().child({ module: 'movie-scheduler' });
    this.timer = null;
    this.ticking = false;
    this.aiProposals = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log.warn({ err: err?.message }, 'movie scheduler tick failed'));
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTimezone() {
    return this.settings?.get?.('general.timezone') || 'UTC';
  }

  getRepinHours() {
    const val = Number(this.settings?.get?.('cinema.scheduleRepinHours'));
    return Number.isFinite(val) && val >= 0 ? val : 1;
  }

  getPrewarmMs() {
    const val = Number(this.settings?.get?.('cinema.schedulePrewarmMinutes'));
    return (Number.isFinite(val) && val >= 1 ? val : 3) * 60_000;
  }

  isSilentPin() {
    return this.settings?.get?.('cinema.scheduleSilentPin') !== false;
  }

  #resolveApiForRow(row) {
    const botId = Number(row?.bot_id || 0);
    if (botId > 0 && this.app?.multiBotManager?.getRunningBot) {
      const bot = this.app.multiBotManager.getRunningBot(botId);
      if (bot?.api) return bot.api;
    }
    return this.app?.telegram?.api || null;
  }

  async resolveItemMetadata(rawTitle) {
    const clean = String(rawTitle || '').trim();
    const seMatch = clean.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
    const season = seMatch ? Number(seMatch[1]) : null;
    const episode = seMatch ? Number(seMatch[2]) : null;
    const searchQuery = seMatch ? clean.replace(seMatch[0], '').trim() : clean;
    if (!this.app?.movieApi?.search) {
      return {
        title: clean,
        mediaType: season && episode ? 'tv' : 'movie',
        tmdbId: null,
        season,
        episode
      };
    }
    try {
      const wantType = season && episode ? 'tv' : 'multi';
      const res = await this.app.movieApi.search(searchQuery, { type: wantType, limit: 5 });
      const top = res?.items?.[0];
      if (top) {
        const isTv = top.type === 'tv' || Boolean(season && episode);
        const dispTitle = isTv && season && episode
          ? `${top.title} · S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
          : (top.year ? `${top.title} (${top.year})` : top.title);
        return {
          title: dispTitle,
          mediaType: isTv ? 'tv' : 'movie',
          tmdbId: String(top.tmdbId || top.id || '').trim() || null,
          season: isTv ? (season || 1) : null,
          episode: isTv ? (episode || 1) : null
        };
      }
    } catch {}
    return {
      title: clean,
      mediaType: season && episode ? 'tv' : 'movie',
      tmdbId: null,
      season,
      episode
    };
  }

  buildCountdownCard(row, { nowMs = Date.now(), liveVcUrl = null } = {}) {
    const isLive = row.status === 'live';
    const msLeft = Math.max(0, Number(row.scheduled_at) - nowMs);
    const countdown = formatCountdown(msLeft);
    const tz = row.timezone || this.getTimezone();
    const repinHours = Number(row.repin_interval_hours ?? this.getRepinHours());
    const b = new RichMessageBuilder().bannerHeader([
      isLive ? '🔴 WATCH PARTY LIVE NOW' : '⏰ SCHEDULED MOVIE NIGHT',
      isLive ? 'Streaming in Voice Chat' : `Starts in ${countdown}`
    ], { size: 2 });

    b.paragraph(rt.bold(`🎬 ${cut(row.title, 110)}`));

    const rows = [
      ['🕒 Showtime', formatClockInTz(row.scheduled_at, tz)],
      [isLive ? '🎙 Status' : '⏳ Countdown', isLive ? '🔴 Live Now' : countdown]
    ];
    if (row.repeat_rule) rows.push(['🔁 Repeat', row.repeat_rule === 'daily' ? 'Every Day' : 'Every Week']);
    if (!isLive && repinHours > 0) rows.push(['📌 Auto Re-Pin', `Every ${repinHours}h`]);
    if (row.boosted) rows.push(['⭐ Broadcast', 'Boosted Watch Party']);
    b.table(rows, { striped: true, bordered: true, compact: true });

    if (row.ai_note) {
      b.blockquote(rt.italic(cut(row.ai_note, 200)));
    }

    if (isLive && liveVcUrl) {
      b.buttons([richButton.url('🎙 Join Voice Chat', liveVcUrl, { style: 'success' })]);
    } else if (!isLive) {
      b.buttons([
        richButton.callback('📣 Boost Broadcast', encodeCallback('music', 'schboost', String(row.id)), { style: 'primary' }),
        richButton.callback('✖ Cancel', encodeCallback('music', 'schcancel', String(row.id)), { style: 'danger' })
      ]);
    }

    b.footer(rt.text(`Schedule #${row.id}${repinHours > 0 && !isLive ? ' · Refreshes & re-pins automatically' : ''}`));
    b.validate();
    return b.toJSON();
  }

  async createScreening({
    chatId,
    botId = 0,
    createdBy,
    title,
    mediaType = 'movie',
    tmdbId = null,
    season = null,
    episode = null,
    scheduledAt,
    aiNote = null,
    repeatRule = null,
    api = null,
    pin = true
  } = {}) {
    if (!this.db?.run) throw new Error('Database unavailable');
    const cid = Number(chatId);
    const tz = this.getTimezone();
    const repinHours = this.getRepinHours();
    const step = countdownStepKey(Number(scheduledAt) - Date.now());
    const info = this.db.run(
      `INSERT INTO scheduled_screenings
       (chat_id, bot_id, created_by, title, media_type, tmdb_id, season, episode, scheduled_at, timezone, repin_interval_hours, last_pinned_at, last_countdown_step, ai_note, repeat_rule, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
      cid,
      Number(botId) || 0,
      Number(createdBy) || 0,
      String(title || '').trim(),
      String(mediaType || 'movie'),
      tmdbId ? String(tmdbId) : null,
      season != null ? Number(season) : null,
      episode != null ? Number(episode) : null,
      Number(scheduledAt),
      tz,
      repinHours,
      Date.now(),
      step,
      aiNote ? String(aiNote).slice(0, 240) : null,
      repeatRule || null
    );
    const row = this.db.get('SELECT * FROM scheduled_screenings WHERE id = ?', Number(info.lastInsertRowid));
    const useApi = api || this.#resolveApiForRow(row);
    if (useApi && typeof useApi.sendRichMessage === 'function') {
      const sent = await useApi.sendRichMessage(cid, this.buildCountdownCard(row)).catch(() => null);
      if (sent?.message_id) {
        this.db.run(
          `UPDATE scheduled_screenings SET countdown_msg_id = ?, last_pinned_at = ? WHERE id = ?`,
          sent.message_id,
          Date.now(),
          row.id
        );
        if (pin && typeof useApi.pinChatMessage === 'function') {
          await useApi.pinChatMessage(cid, sent.message_id, { disableNotification: this.isSilentPin() });
        }
        return this.db.get('SELECT * FROM scheduled_screenings WHERE id = ?', row.id);
      }
    }
    return row;
  }

  listByChat(chatId, { status = 'scheduled' } = {}) {
    if (!this.db?.all) return [];
    return this.db.all(
      `SELECT * FROM scheduled_screenings WHERE chat_id = ? AND status = ? ORDER BY scheduled_at ASC LIMIT 20`,
      Number(chatId),
      status
    );
  }

  getById(id) {
    return this.db?.get?.('SELECT * FROM scheduled_screenings WHERE id = ?', Number(id)) || null;
  }

  async cancelScreening(id, chatId = null, api = null) {
    const row = this.getById(id);
    if (!row) return false;
    if (chatId != null && Number(row.chat_id) !== Number(chatId)) return false;
    this.db.run(`UPDATE scheduled_screenings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, row.id);
    const useApi = api || this.#resolveApiForRow(row);
    if (row.countdown_msg_id && useApi) {
      await useApi.unpinChatMessage?.(row.chat_id, row.countdown_msg_id).catch?.(() => {});
      await useApi.deleteMessage?.(row.chat_id, row.countdown_msg_id).catch?.(() => {});
    }
    return true;
  }

  async tick(nowMs = Date.now()) {
    if (this.ticking || !this.db?.all) return;
    this.ticking = true;
    try {
      const rows = this.db.all(
        `SELECT * FROM scheduled_screenings WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 50`
      );
      const prewarmMs = this.getPrewarmMs();
      for (const row of rows) {
        const msLeft = Number(row.scheduled_at) - nowMs;
        if (msLeft <= 0) {
          await this._triggerDueScreening(row);
          continue;
        }
        if (msLeft <= prewarmMs && !row.prewarmed_json) {
          await this._prewarmScreening(row);
        }
        await this._refreshCountdownOrRepin(row, nowMs);
      }
    } finally {
      this.ticking = false;
    }
  }

  async _refreshCountdownOrRepin(row, nowMs = Date.now()) {
    const api = this.#resolveApiForRow(row);
    if (!api) return false;
    const repinHours = Number(row.repin_interval_hours ?? this.getRepinHours());
    const repinMs = repinHours > 0 ? repinHours * 3600_000 : 0;
    const needsRepin = Boolean(repinMs > 0 && (nowMs - Number(row.last_pinned_at || 0)) >= repinMs);
    const step = countdownStepKey(Number(row.scheduled_at) - nowMs);
    const card = this.buildCountdownCard(row, { nowMs });

    if (needsRepin) {
      if (row.countdown_msg_id) {
        await api.unpinChatMessage?.(row.chat_id, row.countdown_msg_id).catch?.(() => {});
        await api.deleteMessage?.(row.chat_id, row.countdown_msg_id).catch?.(() => {});
      }
      const sent = await api.sendRichMessage?.(row.chat_id, card).catch(() => null);
      if (sent?.message_id) {
        await api.pinChatMessage?.(row.chat_id, sent.message_id, { disableNotification: this.isSilentPin() });
        this.db.run(
          `UPDATE scheduled_screenings SET countdown_msg_id = ?, last_pinned_at = ?, last_countdown_step = ?, updated_at = datetime('now') WHERE id = ?`,
          sent.message_id,
          nowMs,
          step,
          row.id
        );
        return 'repinned';
      }
      return false;
    }

    if (row.countdown_msg_id && step !== row.last_countdown_step && typeof api.editMessageRich === 'function') {
      await api.editMessageRich(row.chat_id, row.countdown_msg_id, card).catch(() => null);
      this.db.run(
        `UPDATE scheduled_screenings SET last_countdown_step = ?, updated_at = datetime('now') WHERE id = ?`,
        step,
        row.id
      );
      return 'edited';
    }
    return false;
  }

  async _prewarmScreening(row) {
    if (!this.app?.movieResolver?.resolve) return null;
    try {
      const item = {
        id: row.tmdb_id || row.title,
        tmdbId: row.tmdb_id || undefined,
        type: row.media_type === 'tv' ? 'tv' : 'movie',
        title: row.title,
        ...(row.season != null ? { season: row.season } : {}),
        ...(row.episode != null ? { episode: row.episode } : {})
      };
      const res = await this.app.movieResolver.resolve(item, { fetchSubtitles: true }).catch(() => null);
      if (res?.ok && res.track?.streamUrl) {
        const payload = JSON.stringify({ track: res.track, prewarmedAt: Date.now() });
        this.db.run(
          `UPDATE scheduled_screenings SET prewarmed_json = ?, updated_at = datetime('now') WHERE id = ?`,
          payload,
          row.id
        );
        return res.track;
      }
    } catch (err) {
      this.log.debug({ err: err?.message, id: row.id }, 'prewarm skipped');
    }
    return null;
  }

  async _triggerDueScreening(row) {
    const claimed = this.db.run(
      `UPDATE scheduled_screenings SET status = 'live', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'`,
      row.id
    );
    if (!claimed?.changes) return false;

    const api = this.#resolveApiForRow(row);
    const music = this.app?.music;
    const qm = this.app?.musicQueueManager;
    try {
      let track = null;
      if (row.prewarmed_json) {
        try {
          const parsed = JSON.parse(row.prewarmed_json);
          if (parsed?.track?.streamUrl && Date.now() - Number(parsed.prewarmedAt || 0) < 25 * 60_000) {
            track = parsed.track;
          }
        } catch {}
      }
      if (!track && this.app?.movieResolver?.resolve) {
        const item = {
          id: row.tmdb_id || row.title,
          tmdbId: row.tmdb_id || undefined,
          type: row.media_type === 'tv' ? 'tv' : 'movie',
          title: row.title,
          ...(row.season != null ? { season: row.season } : {}),
          ...(row.episode != null ? { episode: row.episode } : {})
        };
        const resolved = await this.app.movieResolver.resolve(item, { fetchSubtitles: true });
        if (resolved?.ok && resolved.track) track = resolved.track;
      }
      if (!track) throw new Error(`Could not resolve stream for "${row.title}"`);

      track.requester = track.requester || 'Movie Scheduler';
      track.requesterId = Number(row.created_by) || null;

      if (music?.setup?.prepare && api) {
        const fakeCtx = {
          tgId: Number(row.created_by) || 0,
          chatId: Number(row.chat_id),
          botId: Number(row.bot_id) || 0,
          api
        };
        await music.setup.prepare(fakeCtx, Number(row.chat_id));
      }
      if (!qm) throw new Error('Music queue manager unavailable');
      const s = qm.getSession(Number(row.chat_id));
      if (api) s.api = api;
      s.botId = Number(row.bot_id) || s.botId || 0;
      if (typeof qm.playImmediateAndContinue === 'function') {
        await qm.playImmediateAndContinue(Number(row.chat_id), track);
      } else {
        await qm.addMany(Number(row.chat_id), [track]);
      }

      const liveRow = { ...row, status: 'live' };
      if (api && row.countdown_msg_id && typeof api.editMessageRich === 'function') {
        await api.editMessageRich(row.chat_id, row.countdown_msg_id, this.buildCountdownCard(liveRow, { liveVcUrl: s.vcUrl })).catch(() => {});
      }
      if (row.boosted && this.app?.cinemaAnnouncer) {
        void this.app.cinemaAnnouncer.onTrackStart({
          chatId: Number(row.chat_id),
          track,
          session: s,
          forceBoost: true,
          initiatorUserId: row.created_by
        }).catch(() => {});
      }

      if (row.repeat_rule === 'daily' || row.repeat_rule === 'weekly') {
        const nextMs = Number(row.scheduled_at) + (row.repeat_rule === 'daily' ? 24 : 168) * 3600_000;
        await this.createScreening({
          chatId: row.chat_id,
          botId: row.bot_id,
          createdBy: row.created_by,
          title: row.title,
          mediaType: row.media_type,
          tmdbId: row.tmdb_id,
          season: row.season,
          episode: row.episode,
          scheduledAt: nextMs,
          aiNote: row.ai_note,
          repeatRule: row.repeat_rule,
          api,
          pin: false
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      this.db.run(
        `UPDATE scheduled_screenings SET status = 'failed', error_text = ?, updated_at = datetime('now') WHERE id = ?`,
        String(err?.message || 'Start failed').slice(0, 300),
        row.id
      );
      this.log.warn({ err: err?.message, id: row.id, chatId: row.chat_id }, 'scheduled movie failed to auto-start');
      await api?.sendMessage?.(
        row.chat_id,
        `⚠️ Scheduled screening <b>${cut(row.title, 80)}</b> could not auto-start: ${cut(err?.message || 'Check assistant/VC permissions', 180)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return false;
    }
  }

  /**
   * AI Curator: propose 3 movie/episode screening slots using trending catalog + AIService.
   */
  async suggestScheduleWithAi({ chatId, userId, botId = 0, promptText = 'tonight' } = {}) {
    const tz = this.getTimezone();
    let candidates = [];
    if (this.app?.movieApi?.trending) {
      const tr = await this.app.movieApi.trending({ window: 'day', type: 'all' }).catch(() => null);
      candidates = (tr?.items || []).slice(0, 12).map((m) => ({
        title: m.title,
        year: m.year || null,
        type: m.type === 'tv' ? 'tv' : 'movie',
        tmdbId: String(m.tmdbId || m.id || ''),
        rating: m.rating || null
      }));
    }
    const qm = this.app?.musicQueueManager;
    const recentHistory = (qm?.getSession?.(Number(chatId))?.movieHistory || [])
      .slice(-5)
      .map((t) => t.title);

    const now = Date.now();
    const baseEvening = (() => {
      const d = new Date(now + 3600_000);
      d.setUTCMinutes(0, 0, 0);
      return d.getTime();
    })();
    const defaultSlots = [
      baseEvening,
      baseEvening + 2 * 3600_000,
      baseEvening + 4 * 3600_000
    ];

    let slots = [];
    if (this.settings?.get?.('cinema.aiScheduleEnabled') !== false && this.app?.ai?.generate && candidates.length) {
      try {
        const prompt = [
          `Pick 3 distinct titles for a group movie night matching: "${String(promptText || 'tonight').slice(0, 120)}".`,
          recentHistory.length ? `Already watched recently (avoid): ${recentHistory.join(', ')}.` : '',
          `Catalog choices: ${candidates.map((c, i) => `${i + 1}. ${c.title} (${c.year || ''}, ${c.type})`).join('; ')}.`,
          `Respond strictly as JSON array of 3 objects: [{"index":1,"offsetHours":1,"note":"short hype tagline"}]`
        ].filter(Boolean).join('\n');
        const res = await this.app.ai.generate({ task: 'chat', text: prompt, maxTokens: 320 });
        const jsonMatch = String(res?.text || '').match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            for (let i = 0; i < Math.min(3, parsed.length); i++) {
              const p = parsed[i];
              const cand = candidates[(Number(p?.index || (i + 1)) - 1)] || candidates[i];
              if (!cand) continue;
              const offsetH = Math.max(1, Math.min(48, Number(p?.offsetHours) || ((i * 2) + 1)));
              slots.push({
                title: cand.year ? `${cand.title} (${cand.year})` : cand.title,
                mediaType: cand.type,
                tmdbId: cand.tmdbId || null,
                season: cand.type === 'tv' ? 1 : null,
                episode: cand.type === 'tv' ? 1 : null,
                scheduledAt: now + offsetH * 3600_000,
                aiNote: String(p?.note || `Curated pick for ${promptText}`).slice(0, 180)
              });
            }
          }
        }
      } catch (err) {
        this.log.debug({ err: err?.message }, 'AI schedule prompt fell back to deterministic picks');
      }
    }

    if (slots.length < 3) {
      const fallbackTitles = candidates.length
        ? candidates
        : [
            { title: 'Inception', year: 2010, type: 'movie', tmdbId: '27205' },
            { title: 'Interstellar', year: 2014, type: 'movie', tmdbId: '157336' },
            { title: 'Spider-Man: Into the Spider-Verse', year: 2018, type: 'movie', tmdbId: '324857' }
          ];
      slots = fallbackTitles.slice(0, 3).map((c, idx) => ({
        title: c.year ? `${c.title} (${c.year})` : c.title,
        mediaType: c.type || 'movie',
        tmdbId: c.tmdbId || null,
        season: c.type === 'tv' ? 1 : null,
        episode: c.type === 'tv' ? 1 : null,
        scheduledAt: defaultSlots[idx],
        aiNote: `🤖 AI Watch Party Pick #${idx + 1} (${promptText || 'Tonight'})`
      }));
    }

    const token = randomBytes(5).toString('base64url');
    const proposal = {
      token,
      chatId: Number(chatId),
      userId: Number(userId),
      botId: Number(botId) || 0,
      promptText,
      timezone: tz,
      slots,
      expiresAt: Date.now() + 30 * 60_000
    };
    this.aiProposals.set(token, proposal);
    for (const [k, v] of this.aiProposals) {
      if (v.expiresAt < Date.now()) this.aiProposals.delete(k);
    }
    return proposal;
  }

  buildAiProposalCard(proposal) {
    const b = new RichMessageBuilder().bannerHeader([
      '🤖 AI WATCH PARTY LINEUP',
      `Vibe: ${cut(proposal.promptText || 'Tonight', 40)}`
    ], { size: 2 });
    const rows = proposal.slots.map((s, idx) => [
      `#${idx + 1} ${formatClockInTz(s.scheduledAt, proposal.timezone)}`,
      cut(s.title, 44)
    ]);
    b.table(rows, { striped: true, bordered: true, compact: true });
    if (proposal.slots[0]?.aiNote) {
      b.blockquote(rt.italic(cut(proposal.slots[0].aiNote, 180)));
    }
    b.buttons([
      richButton.callback('✅ Approve All (3)', encodeCallback('music', 'schaiok', proposal.token), { style: 'success' }),
      richButton.callback('🎲 Re-Pick', encodeCallback('music', 'schai', `${proposal.token}`), { style: 'primary' })
    ]);
    b.footer(rt.text(`Hourly re-pin & auto-start enabled · ${proposal.timezone}`));
    b.validate();
    return b.toJSON();
  }
}
