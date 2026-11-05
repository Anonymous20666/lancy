import { RichMessageBuilder, rt, richButton, encodeCallback } from '../telegram/rich.js';
import { banner } from '../telegram/ui.js';
import { progressBar } from '../utils/text.js';
import { logger } from '../core/logger.js';

export class CinemaCardManager {
  constructor({ app, db, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.log = log || logger().child({ module: 'cinema:card-manager' });
    this.tickerInterval = null;
    this.lastCardUpdates = new Map(); // chatId -> timestamp
  }

  startTicker(intervalMs = 30000) {
    if (this.tickerInterval) clearInterval(this.tickerInterval);
    this.tickerInterval = setInterval(() => {
      this.refreshActiveCards().catch((err) => {
        this.log.debug({ err: err?.message }, 'Error in cinema card refresh ticker');
      });
    }, intervalMs);
    this.tickerInterval.unref?.();
  }

  stopTicker() {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
    }
  }

  async refreshActiveCards() {
    const activeSessions = this.db.all(
      `SELECT s.*, d.chat_id, d.title as dest_title, d.public_card_msg_id
       FROM cinema_playback_sessions s
       INNER JOIN cinema_destinations d ON s.destination_id = d.id
       WHERE s.playback_state IN ('PLAYING', 'PAUSED')`
    );

    for (const session of activeSessions || []) {
      const last = this.lastCardUpdates.get(session.chat_id) || 0;
      if (Date.now() - last >= 20000) {
        await this.postOrUpdateCard(session.chat_id).catch(() => {});
      }
    }
  }

  formatTime(seconds) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  buildNowPlayingCard(dest, session, queue = [], activePoll = null) {
    const b = new RichMessageBuilder();
    const isPlaying = session?.state === 'PLAYING' || session?.playback_state === 'PLAYING';
    const isPaused = session?.state === 'PAUSED' || session?.playback_state === 'PAUSED';

    const statusBadge = isPlaying ? '🟢 LIVE' : (isPaused ? '⏸ PAUSED' : '⚪ IDLE');
    const headerTitle = dest.title || 'Cinema Stream';

    b.paragraph(rt.bold(banner([
      `🎬 PAPPY CINEMA ${statusBadge}`,
      headerTitle
    ])));
    b.divider();

    const token = this.app.cinemaDestinations.generateToken(dest.chatId);
    const appUrl = this.app.cinemaDestinations.getMiniAppUrl(token);
    const isChannel = dest.chatType === 'channel';
    const botUser = this.app?.telegram?.api?.me?.username || 'Lancy_easy_bot';
    const directLink = `https://t.me/${botUser}/cinema?startapp=${encodeURIComponent(token)}`;
    const openBtn = isChannel
      ? { text: rt.text('🍿 Open PAPPY Cinema'), url: directLink, style: 'success' }
      : { text: rt.text('🍿 Open PAPPY Cinema'), web_app: { url: appUrl }, style: 'success' };

    if (!session || (!isPlaying && !isPaused)) {
      b.quote(rt.concat(
        rt.bold('📡 Stream Offline\n\n'),
        rt.text('No active movie or TV episode playing right now.\n'),
        rt.italic('Queue upcoming titles or open the Mini App to start streaming!')
      ));
      b.divider();
      b.buttons([openBtn]);
      b.validate();
      return b.toJSON();
    }

    const title = session.title || 'Untitled Stream';
    const isTv = session.media_type === 'tv' || session.mediaType === 'tv';
    const displayTitle = isTv && session.season != null && session.episode != null
      ? `📺 ${title} — Season ${session.season} • Episode ${session.episode}`
      : `🍿 ${title}`;

    const pos = Number(session.position_seconds ?? session.position ?? 0);
    const dur = Number(session.duration_seconds ?? session.duration ?? 0);
    const remainingSec = Math.max(0, dur - pos);
    const ratio = dur > 0 ? Math.min(1, pos / dur) : 0;
    const progressText = `▶ ${this.formatTime(pos)} / ${this.formatTime(dur)}   ${progressBar(ratio, { width: 10 })}`;

    const metaParts = [];
    if (session.year) metaParts.push(String(session.year));
    if (session.rating) metaParts.push(`★ ${Number(session.rating).toFixed(1)}`);
    if (dur > 0) metaParts.push(`${Math.round(dur / 60)} min`);
    if (Array.isArray(session.genres) && session.genres.length > 0) {
      metaParts.push(session.genres.slice(0, 3).join(', '));
    }

    const nextItem = queue.length > 0 ? queue[0] : null;
    let upNextText = 'End of Queue';
    if (nextItem) {
      upNextText = nextItem.media_type === 'tv' && nextItem.season != null
        ? `${nextItem.title} (S${nextItem.season}E${nextItem.episode})`
        : nextItem.title;
    } else if (isTv && session.season != null && session.episode != null) {
      upNextText = `Auto-play Season ${session.season} Episode ${Number(session.episode) + 1}`;
    }

    const synopsisSnippet = session.overview
      ? `${String(session.overview).slice(0, 140)}${String(session.overview).length > 140 ? '…' : ''}\n\n`
      : '';

    b.quote(rt.concat(
      rt.bold(`${displayTitle}\n`),
      metaParts.length > 0 ? rt.italic(`${metaParts.join(' • ')}\n\n`) : rt.text('\n'),
      synopsisSnippet ? rt.text(synopsisSnippet) : '',
      rt.text(`${progressText}\n`),
      dur > 0 ? rt.text(`⏳ Remaining: ${this.formatTime(remainingSec)}\n\n`) : rt.text('\n'),
      rt.bold('• State: '),
      rt.text(`${isPlaying ? 'Playing in Voice Chat' : 'Paused'}\n`),
      rt.bold('• Up Next: '),
      rt.text(`${upNextText}`)
    ));
    b.divider();

    const mainButtons = [openBtn];

    if (activePoll) {
      mainButtons.push(
        richButton.callback(`🗳 Vote Next (${activePoll.totalVotes} votes)`, encodeCallback('cinema', 'open_poll', dest.chatId), { style: 'primary' })
      );
    }

    b.buttons(mainButtons);
    b.buttons([
      richButton.callback('🔄 Refresh Status', encodeCallback('cinema', 'card_refresh', dest.chatId))
    ]);

    b.validate();
    return b.toJSON();
  }

  async postOrUpdateCard(chatId) {
    const numChat = Number(chatId);
    const api = this.app?.telegram?.api;
    if (!api) return null;

    const dest = this.app.cinemaDestinations.getDestinationByChatId(numChat);
    if (!dest) return null;

    const session = this.app.cinemaPlayback.getCurrentSession(numChat);
    const queue = this.app.cinemaQueue.getQueue(numChat);

    const pollRow = this.db.get(
      `SELECT poll_session_id FROM cinema_poll_sessions 
       WHERE destination_id = ? AND status = 'open' 
       ORDER BY id DESC LIMIT 1`,
      dest.id
    );
    const activePoll = pollRow ? this.app.cinemaPoll.getPollResults(pollRow.poll_session_id) : null;

    const cardPayload = this.buildNowPlayingCard(dest, session, queue, activePoll);
    this.lastCardUpdates.set(numChat, Date.now());

    if (dest.publicCardMessageId) {
      try {
        const edited = await api.editMessageRich(numChat, dest.publicCardMessageId, cardPayload);
        return edited;
      } catch (err) {
        const desc = err?.description || err?.message || '';
        if (/not modified/i.test(desc)) return { message_id: dest.publicCardMessageId };
        this.log.debug({ err: desc, chatId: numChat }, 'Failed to edit public card, sending new message');
      }
    }

    try {
      const sent = await api.sendRichMessage(numChat, cardPayload);
      if (sent?.message_id) {
        this.app.cinemaDestinations.updatePublicCard(numChat, sent.message_id);

        const isChannel = dest.chatType === 'channel';
        const canPin = dest.rights?.canPinMessages || isChannel;
        if (canPin) {
          await api.call('pinChatMessage', {
            chat_id: numChat,
            message_id: sent.message_id,
            disable_notification: true
          }).catch(() => {});
        }
      }
      return sent;
    } catch (sendErr) {
      this.log.warn({ err: sendErr?.message, chatId: numChat }, 'Failed to post public cinema card');
      return null;
    }
  }
}
