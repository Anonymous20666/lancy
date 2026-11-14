import { RichMessageBuilder, rt, richButton, encodeCallback } from '../telegram/rich.js';
import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';

const DEFAULT_ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours per (bot, group, baseTitle)
const DM_PACING_MS = 40; // ~25 msgs/sec, well under Telegram's global 30 msgs/sec cap
const cut = (s, n = 80) => [...String(s || '')].slice(0, n).join('');

function isSafeHttpsUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

function isSafeTelegramLink(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && /^(?:t\.me|telegram\.me)$/i.test(u.hostname) && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function normalizeAnnounceTitleKey(title = '') {
  return String(title || '')
    .replace(/\s*[·\-–|:]?\s*\bS\d{1,2}\s*E\d{1,3}\b.*$/i, '')
    .replace(/\s*\((?:19|20)\d{2}\)\s*/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isPermanentDmError(err) {
  const msg = String(err?.message || err?.description || '').toLowerCase();
  const code = Number(err?.code || err?.error_code || err?.status || 0);
  return code === 403
    || code === 400
    || /forbidden|blocked|initiate conversation|deactivated|chat not found|user_is_blocked|bot was blocked|have no rights/i.test(msg);
}

export class CinemaVcAnnouncer {
  constructor({ app, db, queueManager = null, cooldownMs = DEFAULT_ANNOUNCE_COOLDOWN_MS, pacingMs = DM_PACING_MS, log } = {}) {
    this.app = app;
    this.db = db || app?.db || null;
    this.cooldownMs = Number.isFinite(Number(cooldownMs)) ? Number(cooldownMs) : DEFAULT_ANNOUNCE_COOLDOWN_MS;
    this.pacingMs = Number.isFinite(Number(pacingMs)) ? Number(pacingMs) : DM_PACING_MS;
    this.log = log || logger().child({ module: 'cinema-announcer' });
    this.announcedByChat = new Map();
    this.activeJobs = new Set();
    this._tail = Promise.resolve();
    this._boundQm = null;
    if (queueManager) this.attachQueueManager(queueManager);
  }

  attachQueueManager(queueManager) {
    if (!queueManager || this._boundQm === queueManager) return;
    this._boundQm = queueManager;
    queueManager.on('track_start', ({ chatId, track, session }) => {
      void this.onTrackStart({ chatId, track, session }).catch((err) => {
        this.log?.debug?.({ err: err?.message, chatId }, 'cinema VC announcer skipped safely');
      });
    });
  }

  #botIdForSession(session) {
    if (session?.botId !== undefined && session?.botId !== null) {
      return Number(session.botId) || 0;
    }
    const useApi = session?.api;
    if (useApi && this.app?.multiBotManager?.runningBots) {
      for (const [bId, entry] of this.app.multiBotManager.runningBots.entries()) {
        if (entry?.api === useApi) return Number(bId) || 0;
      }
    }
    return Number(this.app?.telegram?.controller?.botContext?.botId || 0);
  }

  #apiForSession(session, botId = 0) {
    if (session?.api) return session.api;
    if (botId > 0 && this.app?.multiBotManager?.getRunningBot) {
      const running = this.app.multiBotManager.getRunningBot(botId);
      if (running?.api) return running.api;
    }
    return this.app?.telegram?.api || null;
  }

  #wasRecentlyAnnounced(botId, chatId, titleKey) {
    if (!titleKey) return false;
    const scopeKey = `${botId}:${Number(chatId)}`;
    const now = Date.now();
    let map = this.announcedByChat.get(scopeKey);
    if (!map && this.db?.getSetting) {
      const persisted = this.db.getSetting(`cinema.announcedTitles.${scopeKey}`, null);
      if (persisted && typeof persisted === 'object') {
        map = new Map(Object.entries(persisted).map(([k, v]) => [k, Number(v) || 0]));
        this.announcedByChat.set(scopeKey, map);
      }
    }
    if (!map) return false;
    for (const [k, ts] of map.entries()) {
      if (now - ts >= this.cooldownMs) map.delete(k);
    }
    const lastTs = map.get(titleKey);
    return Boolean(lastTs && (now - lastTs) < this.cooldownMs);
  }

  #markAnnounced(botId, chatId, titleKey) {
    if (!titleKey) return;
    const scopeKey = `${botId}:${Number(chatId)}`;
    const now = Date.now();
    let map = this.announcedByChat.get(scopeKey);
    if (!map) {
      map = new Map();
      this.announcedByChat.set(scopeKey, map);
    }
    for (const [k, ts] of map.entries()) {
      if (now - ts >= this.cooldownMs) map.delete(k);
    }
    if (map.size >= 25) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(titleKey, now);
    if (this.db?.setSetting) {
      try {
        this.db.setSetting(`cinema.announcedTitles.${scopeKey}`, Object.fromEntries(map.entries()));
      } catch {}
    }
  }

  async resolveGroupInviteLink(chatId, api, session = null) {
    const cid = Number(chatId);
    let chat = null;
    if (typeof api?.getChat === 'function') {
      chat = await api.getChat(cid).catch(() => null);
    }

    const isChannel = Boolean(chat?.type === 'channel' || session?.isChannel);
    const groupTitle = String(chat?.title || session?.destinationTitle || 'Watch Party Group').trim();
    const username = chat?.username || session?.destinationUsername || null;
    const rawCallLink = session?.callInviteLink || (
      isSafeTelegramLink(session?.vcUrl) && (String(session.vcUrl).includes('?voicechat=') || String(session.vcUrl).includes('?livestream='))
        ? session.vcUrl
        : null
    );
    const verifiedCallLink = isSafeTelegramLink(rawCallLink) ? rawCallLink : null;

    if (username) {
      const cleanUser = String(username).replace(/^@/, '');
      const gcLink = `https://t.me/${cleanUser}`;
      return {
        gcLink,
        vcDirectLink: verifiedCallLink || (isChannel ? `${gcLink}?livestream` : `${gcLink}?voicechat`),
        groupTitle,
        username: cleanUser,
        isChannel
      };
    }

    // 1. Existing invite link on chat object, session, or previously cached link in DB
    const existingCandidates = [
      chat?.invite_link,
      session?.groupInviteLink,
      isSafeTelegramLink(session?.vcUrl) && !String(session?.vcUrl).includes('?voicechat') && !String(session?.vcUrl).includes('?livestream') ? session.vcUrl : null,
      this.db?.getSetting?.(`cinema.groupInviteLink.${cid}`, null)
    ];
    for (const cand of existingCandidates) {
      if (isSafeTelegramLink(cand)) {
        if (session) session.groupInviteLink = cand;
        return { gcLink: cand, vcDirectLink: verifiedCallLink, groupTitle, username: null, isChannel };
      }
    }

    // 2. Fallback: generate/export invite link ONLY if bot has permission; failure never stops VC playback
    if (typeof api?.call === 'function') {
      let generated = null;
      try {
        const created = await api.call('createChatInviteLink', { chat_id: cid });
        if (isSafeTelegramLink(created?.invite_link)) generated = created.invite_link;
      } catch {}

      if (!generated) {
        try {
          const exported = await api.call('exportChatInviteLink', { chat_id: cid });
          if (isSafeTelegramLink(exported)) generated = exported;
        } catch {}
      }

      if (generated) {
        if (session) session.groupInviteLink = generated;
        try { this.db?.setSetting?.(`cinema.groupInviteLink.${cid}`, generated); } catch {}
        return { gcLink: generated, vcDirectLink: verifiedCallLink, groupTitle, username: null, isChannel };
      }
    }

    return { gcLink: null, vcDirectLink: verifiedCallLink, groupTitle, username: null, isChannel };
  }

  buildAlertCard({ track, gcLink, vcDirectLink = null, groupTitle = 'Watch Party Group', botUsername = 'Lancy_easy_bot', isChannel = false } = {}) {
    const cleanBot = String(botUsername || 'Lancy_easy_bot').replace(/^@/, '');
    const isTv = Boolean(track?.mediaType === 'video' && (/\bS\d{1,2}\s*E\d{1,3}\b/i.test(track?.title || '') || track?.seriesId || track?.seasonNumber != null));
    const b = new RichMessageBuilder().bannerHeader([
      '🎬 CINEMA VC LIVE NOW',
      `${cut(groupTitle, 44)} · Streaming Together`
    ], { size: 2 });

    const artwork = track?.artwork || track?.poster || track?.backdrop || track?.thumbnailUrl || track?.thumb || null;
    if (isSafeHttpsUrl(artwork)) {
      b.photo(artwork, cut(track?.title || 'Cinema Watch Party', 90));
    }

    b.paragraph(rt.concat(
      rt.bold(`🍿 ${cut(track?.title || 'Movie Night Feature', 110)}`),
      track?.year ? rt.text(` (${track.year})`) : ''
    ));

    const metaRows = [
      ['🎭 Format', isTv ? '📺 TV Series Episode' : '🎬 Full Feature Movie'],
      [isChannel ? '📢 Channel' : '👥 Group Chat', cut(groupTitle, 46)],
      ['🎙️ Status', isChannel ? '🔴 Live Livestream' : '🔴 Live in Voice Chat']
    ];
    if (track?.rating) metaRows.push(['⭐ Rating', `${track.rating}/10`]);
    if (Array.isArray(track?.genres) && track.genres.length) {
      metaRows.push(['🏷 Genres', cut(track.genres.slice(0, 3).join(', '), 44)]);
    }
    if (track?.requester) metaRows.push(['🙋 Started by', cut(track.requester, 32)]);
    b.table(metaRows, { striped: true, bordered: true, compact: true });

    if (track?.overview) {
      b.blockquote(rt.italic(cut(track.overview, 180)));
    }

    b.paragraph(rt.text(isChannel
      ? 'Tap below to join the channel and watch the livestream!'
      : 'Tap below to jump into the group and watch the movie live in Voice Chat!'));

    const actionRow = [
      richButton.url(isChannel ? '📢 Join Channel' : '🍿 Join Group & Watch', gcLink, { style: 'success' })
    ];
    if (vcDirectLink && isSafeTelegramLink(vcDirectLink)) {
      actionRow.push(richButton.url(isChannel ? '📺 Open Livestream' : '🎙️ Open Voice Chat', vcDirectLink, { style: 'primary' }));
    }
    b.buttons(actionRow);

    b.buttons([
      richButton.callback('🔕 Mute Cinema Alerts', encodeCallback('music', 'calert', 'off'))
    ]);

    b.footer(rt.text(`Lancy Cinema Notifications · @${cleanBot}`));
    b.validate();
    return b.toJSON();
  }

  getEligibleUserIds(botId = 0) {
    if (!this.db?.all) return [];
    const rows = this.db.all(
      'SELECT tg_id FROM bot_users WHERE bot_id = ? AND is_banned = 0 AND tg_id > 0 ORDER BY last_seen DESC',
      Number(botId) || 0
    );
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const uid = Number(row?.tg_id);
      if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid)) continue;
      seen.add(uid);
      if (this.db.getUserSetting?.(uid, 'cinema.vcNotifications', true) === false) continue;
      out.push(uid);
    }
    return out;
  }

  async #deliverRichDm(api, userId, richCard, fallbackText) {
    try {
      if (typeof api.sendRichMessage === 'function') {
        await api.sendRichMessage(userId, richCard);
        return { ok: true };
      }
      if (typeof api.sendMessage === 'function') {
        await api.sendMessage(userId, fallbackText, { parse_mode: 'HTML' });
        return { ok: true };
      }
      return { ok: false, skipped: true };
    } catch (err) {
      const retryAfter = Number(err?.parameters?.retry_after || err?.retryAfter || 0);
      if (retryAfter > 0 && retryAfter <= 30) {
        await sleep((retryAfter + 1) * 1000);
        try {
          if (typeof api.sendRichMessage === 'function') {
            await api.sendRichMessage(userId, richCard);
            return { ok: true };
          }
        } catch (retryErr) {
          err = retryErr;
        }
      }
      if (isPermanentDmError(err)) {
        return { ok: false, unreachable: true };
      }
      return { ok: false, error: err?.message || 'DM failed' };
    }
  }

  async onTrackStart({ chatId, track, session } = {}) {
    const cid = Number(chatId);
    if (!Number.isFinite(cid) || cid >= 0) return null;
    if (!track || track.provider !== 'movie') return null;
    if (session?.isChannel) return null;

    if (session?._suppressCinemaAnnounce) {
      session._suppressCinemaAnnounce = false;
      return { skipped: 'suppressed_resume' };
    }

    if (this.app?.settings?.get?.('music.cinemaAnnounceEnabled') === false) {
      return { skipped: 'disabled_globally' };
    }
    if (this.db?.getSetting?.(`cinema.announceGroup.${cid}`, true) === false) {
      return { skipped: 'disabled_for_group' };
    }

    const titleKey = normalizeAnnounceTitleKey(track.title || '');
    if (!titleKey) return { skipped: 'empty_title' };

    const botId = this.#botIdForSession(session);
    if (this.#wasRecentlyAnnounced(botId, cid, titleKey)) {
      return { skipped: 'already_announced' };
    }

    const api = this.#apiForSession(session, botId);
    if (!api) return { skipped: 'no_api' };

    const linkInfo = await this.resolveGroupInviteLink(cid, api, session);
    if (!linkInfo.gcLink) {
      this.log?.debug?.({ chatId: cid, botId }, 'Cinema VC started without accessible group invite link; playback continues normally');
      return { skipped: 'no_invite_link' };
    }

    // Record immediately before async delivery so rapid skips don't double-enqueue this title
    this.#markAnnounced(botId, cid, titleKey);

    const recipientIds = this.getEligibleUserIds(botId);
    if (!recipientIds.length) {
      return { skipped: 'no_recipients', gcLink: linkInfo.gcLink };
    }

    const botUsername = session?.botUsername || api?.botUsername || api?.me?.username || this.app?.telegram?.botUsername || 'Lancy_easy_bot';
    const richCard = this.buildAlertCard({
      track,
      gcLink: linkInfo.gcLink,
      vcDirectLink: linkInfo.vcDirectLink,
      groupTitle: linkInfo.groupTitle,
      botUsername,
      isChannel: Boolean(linkInfo.isChannel)
    });
    const fallbackText = `🎬 <b>CINEMA VC LIVE NOW</b>\n\n🍿 <b>${cut(track.title, 110)}</b>\n👥 Group: <b>${cut(linkInfo.groupTitle, 60)}</b>\n🔗 Join: ${linkInfo.gcLink}`;

    const job = this._tail.then(async () => {
      let sent = 0;
      let failed = 0;
      for (const uid of recipientIds) {
        if (this.app?.musicQueueManager?.closed) break;
        const r = await this.#deliverRichDm(api, uid, richCard, fallbackText);
        if (r.ok) sent++;
        else failed++;
        if (this.pacingMs > 0) await sleep(this.pacingMs);
      }
      this.log?.info?.({ chatId: cid, botId, title: track.title, sent, failed, total: recipientIds.length }, 'cinema VC DM notifications completed');
      return { sent, failed, total: recipientIds.length, gcLink: linkInfo.gcLink };
    });

    this._tail = job.catch(() => {});
    this.activeJobs.add(job);
    void job.finally(() => this.activeJobs.delete(job));
    return job;
  }

  async flush() {
    if (this.activeJobs.size) {
      await Promise.allSettled([...this.activeJobs]);
    }
  }
}
