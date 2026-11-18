import { RADIO_CATEGORIES } from '../../music/radio.js';
import { PANEL_ACTIONS } from '../../music/channelPanels.js';
import { TemporaryBotMessages } from '../../music/messages.js';
import { audioInput, audioFileId } from '../../music/preview.js';
import { currentLyricWindow } from '../../music/lyrics.js';
import { RichMessageBuilder, block, rt, richButton, encodeCallback, decodeCallback, NOOP_CALLBACK } from '../rich.js';
import { progressBar } from '../../utils/text.js';
import { States } from '../../core/stateMachine.js';
import { durationText, MusicError } from '../../music/model.js';
import { parseScheduleInput, formatClockInTz } from '../../music/movieScheduler.js';
import { STAR_PRODUCTS } from '../../music/starsBilling.js';
import { DOWNLOAD_QUALITY_PROFILES, estimateDownloadSizeMb, uploadLimitBytes } from '../../media/telegramLimits.js';
import { toSansBold } from '../../captions/engine.js';
import { createMovieUi } from './movieUi.js';

const cut = (s, n = 65) => [...String(s || '')].slice(0, n).join('');
const cb = (action, ...args) => encodeCallback('music', action, ...args);
const button = (text, action, ...args) => {
  const last = args.at(-1);
  if (last && typeof last === 'object' && !Array.isArray(last) && ('style' in last)) {
    const opts = args.pop();
    return richButton.callback(text, cb(action, ...args), opts);
  }
  return richButton.callback(text, cb(action, ...args));
};
const card = (title, subtitle, size = 2) => new RichMessageBuilder().bannerHeader([title, subtitle], { size });

const QUICK_GENRES = ['Afrobeats', 'Amapiano', 'Hip hop', 'Trap', 'R&B', 'Pop', 'Lo-fi', 'Drill', 'Gospel', 'Party'];

const STATUS_BADGE = {
  playing: '🔴 LIVE',
  paused: '⏸ PAUSED',
  buffering: '⏳ BUFFERING',
  idle: '⚪ IDLE',
  error: '⚠ ATTENTION',
  stopped: '⏹ STOPPED'
};

export function createMusicScreen({ app }) {
  const id = 'music';
  const finish = b => {
    const window = app.db?.getSetting?.('music.testWindow');
    if (window?.commit && Number.isFinite(window.expiresAt)) {
      const end = new Date(window.expiresAt).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' });
      b.footer(rt.text(Date.now() < window.expiresAt
        ? `Test build ${String(window.commit).slice(0, 7)} · guarded until ${end} Lagos time · not finalized`
        : 'This guarded test window has ended. Open the current /player; do not reuse this selection.'));
    }
    b.validate();
    return b.toJSON();
  };
  const temporary = new TemporaryBotMessages();
  const noticeMsgByChat = new Map();
  const menuMsgByChat = new Map();

  function isChannelCtx(ctx) {
    return Boolean(ctx?.isChannel || ctx?.message?.chat?.type === 'channel' || ctx?.query?.message?.chat?.type === 'channel');
  }

  function chatSlotKey(ctx) {
    return `${app.music?.botKey?.(ctx) || ctx?.api?.me?.id || 'bot'}:${Number(ctx?.chatId)}`;
  }

  function hasMediaAttachment(msg) {
    return Boolean(msg && (msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker));
  }

  async function deleteTriggerMessage(ctx, msg = ctx?.message) {
    if (!isChannelCtx(ctx) || ctx?.query || !msg?.message_id || !ctx?.api?.deleteMessage) return false;
    if (hasMediaAttachment(msg)) return false;
    return ctx.api.deleteMessage(ctx.chatId, msg.message_id).catch(() => false);
  }

  function reusableChannelSlotId(ctx) {
    if (!isChannelCtx(ctx)) return null;
    const key = chatSlotKey(ctx);
    return menuMsgByChat.get(key)?.messageId || noticeMsgByChat.get(key)?.messageId || null;
  }

  async function upsertChatSlot(slotMap, ctx, sendFn, editFn, ttlMs = 300000) {
    const key = chatSlotKey(ctx);
    const existing = slotMap.get(key);
    if (existing?.messageId && editFn) {
      try {
        const edited = await editFn(existing.messageId);
        const msgId = edited?.message_id || existing.messageId;
        temporary.expire(existing.token, ttlMs);
        slotMap.set(key, { messageId: msgId, token: existing.token, api: ctx.api });
        return edited || { message_id: msgId };
      } catch {}
    }
    if (existing?.token) await temporary.remove(existing.token).catch(() => {});
    const sent = await sendFn();
    if (sent?.message_id) {
      const token = temporary.remember(ctx, sent, { ttlMs });
      slotMap.set(key, { messageId: sent.message_id, token, api: ctx.api });
    }
    return sent;
  }

  async function clearChatSlot(slotMap, ctx, keepMessageId = null) {
    const key = chatSlotKey(ctx);
    const existing = slotMap.get(key);
    if (!existing) return;
    slotMap.delete(key);
    if (keepMessageId && existing.messageId === keepMessageId) {
      temporary.keep(existing.token);
      return;
    }
    await temporary.remove(existing.token).catch(() => {});
  }

  async function adoptChannelPlayerResult(ctx, session) {
    if (!isChannelCtx(ctx) || !session?.screenMessageId) return;
    await clearChatSlot(menuMsgByChat, ctx, session.screenMessageId);
    await clearChatSlot(noticeMsgByChat, ctx, session.screenMessageId);
  }

  async function sendOrEditMenu(ctx, rich, { ttlMs = 300000 } = {}) {
    if (ctx?.query && ctx?.messageId && ctx.api?.editMessageRich) {
      return ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
    }
    if (isChannelCtx(ctx)) {
      const key = chatSlotKey(ctx);
      if (!menuMsgByChat.has(key) && noticeMsgByChat.has(key)) {
        const oldNotice = noticeMsgByChat.get(key);
        try {
          const edited = await ctx.api?.editMessageRich?.(ctx.chatId, oldNotice.messageId, rich);
          const msgId = edited?.message_id || oldNotice.messageId;
          temporary.expire(oldNotice.token, ttlMs);
          noticeMsgByChat.delete(key);
          menuMsgByChat.set(key, { messageId: msgId, token: oldNotice.token, api: ctx.api });
          return edited || { message_id: msgId };
        } catch {}
      }
      return upsertChatSlot(
        menuMsgByChat,
        ctx,
        () => ctx.api.sendRichMessage(ctx.chatId, rich),
        msgId => ctx.api?.editMessageRich?.(ctx.chatId, msgId, rich),
        ttlMs
      );
    }
    return ctx.api.sendRichMessage(ctx.chatId, rich);
  }

  function buildNoticeCard(msg) {
    return card('Lancy · Music Notice', 'Action could not complete')
      .blockquote(rt.text(msg))
      .toJSON();
  }

  function buildDjReplyCard(msg, { trending = false } = {}) {
    const clean = String(msg || '').trim();
    if (!clean) return null;
    return finish(
      card('Spotify ✕ DJ', trending ? 'Live Charts & Mixes' : 'Interactive DJ Response')
        .paragraph(rt.text(cut(clean, 2400)))
        .buttons([button('🎙 Ask DJ Again', 'prompt', 'dj', { style: 'primary' }), button('🔍 Search Song', 'prompt', defaultMediaMode({ isChannel: true }))])
    );
  }

  async function deliverChannelDjReply(ctx, slotMap, msg, { trending = false, ttlMs = 120000 } = {}) {
    const clean = String(msg || '').trim();
    if (!clean) return;
    const rich = ctx.api?.sendRichMessage ? buildDjReplyCard(clean, { trending }) : null;
    if (rich && slotMap === menuMsgByChat) {
      const key = chatSlotKey(ctx);
      const sent = await sendOrEditMenu(ctx, rich, { ttlMs });
      if (noticeMsgByChat.get(key)?.messageId !== sent?.message_id) {
        await clearChatSlot(noticeMsgByChat, ctx, sent?.message_id);
      }
      return;
    }
    const sendFn = rich ? () => ctx.api.sendRichMessage(ctx.chatId, rich) : () => ctx.api.sendMessage(ctx.chatId, clean);
    const editFn = async msgId => {
      if (rich && ctx.api?.editMessageRich) {
        try { return await ctx.api.editMessageRich(ctx.chatId, msgId, rich); } catch {}
      }
      if (ctx.api?.editMessageText) {
        return ctx.api.editMessageText(ctx.chatId, msgId, clean);
      }
      throw new Error('NO_EDIT');
    };
    await upsertChatSlot(slotMap, ctx, sendFn, editFn, ttlMs);
  }

  function controls(s, label, action, ...args) {
    let opts;
    const last = args.at(-1);
    if (last && typeof last === 'object' && !Array.isArray(last) && ('style' in last)) {
      opts = args.pop();
    }
    if (s.panelToken) {
      if (['remove', 'playnow', 'mremove', 'mplaynow', 'votequeue', 'downloadq'].includes(action)) args[0] = String(args[0]).replaceAll('-', '').slice(0, 12);
      const argsList = [s.panelToken, PANEL_ACTIONS.indexOf(action).toString(36), ...args, Number(s.controlRevision || 0).toString(36)];
      return opts ? button(label, 'pc', ...argsList, opts) : button(label, 'pc', ...argsList);
    }
    return opts ? button(label, action, ...args, s.controlRevision || 0, opts) : button(label, action, ...args, s.controlRevision || 0);
  }

  function joinCallButton(s) {
    if (s?.vcUrl) {
      return richButton.url(s.isChannel ? '📺 Join Livestream' : '🎙️ Join VC', s.vcUrl, { style: 'success' });
    }
    if (s?.groupInviteLink) {
      return richButton.url(s.isChannel ? '📢 Open Channel' : '🍿 Open Group', s.groupInviteLink, { style: 'primary' });
    }
    return null;
  }

  function defaultMediaMode(sOrPanel = null) {
    let ytEnabled = false;
    try { ytEnabled = Boolean(app.musicProviders?.get?.('youtube')?.enabled); } catch {}
    return ytEnabled ? 'video' : 'queue';
  }

  function resolveGenre(ref, s = null) {
    if (ref === 'custom') {
      const qmSession = (s?.destination || s?.chatId) ? app.musicQueueManager?.getSession?.(s.destination || s.chatId) : null;
      return s?.radioCustom || qmSession?.radioCustom || 'Afrobeats';
    }
    const qMatch = typeof ref === 'string' && ref.match(/^q(\d+)$/);
    if (qMatch && QUICK_GENRES[Number(qMatch[1])]) {
      return QUICK_GENRES[Number(qMatch[1])];
    }
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const idx = Number(ref);
      if (RADIO_CATEGORIES[idx]) return RADIO_CATEGORIES[idx];
      if (QUICK_GENRES[idx]) return QUICK_GENRES[idx];
    }
    return String(ref || 'Afrobeats').trim().slice(0, 120);
  }

  function genreRefFor(genre, isCustom = false) {
    if (isCustom) return 'custom';
    const catIdx = RADIO_CATEGORIES.indexOf(genre);
    if (catIdx >= 0) return String(catIdx);
    const quickIdx = QUICK_GENRES.indexOf(genre);
    if (quickIdx >= 0) return `q${quickIdx}`;
    return genre.length > 18 ? 'custom' : cut(genre, 18);
  }

  function renderDmChannelGuideCard() {
    const b = card(
      '📢 Lancy · Channel Features',
      'Live VC & Polls Run In-Channel · Post Packs from DM'
    );
    b.blockquote(rt.text(
      'Channel Play has moved inside Channels directly so your DM stays clean and clutter-free.\n\n' +
      '• Live Channel VC & Polls: Add Lancy as an admin in your Channel and send /player, /vplay, /addq, /movie, or /aidj inside the Channel.\n' +
      '• Post Media Packs to Channels: Tap 📢 Post to Channel or 📅 Auto Post below.\n' +
      '• Download Movies & TV Series: Tap 🎬 Download Movies below!'
    ));
    b.buttons([
      button('🎬 Download Movies', 'moviehub', { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('📢 Post to Channel', encodeCallback('channel_post', 'open'), { style: 'primary' }),
      richButton.callback('📅 Auto Post', encodeCallback('autopost', 'open'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    return finish(b);
  }

  function buildBoldGuideRichText(title, subtitle, sections = []) {
    const parts = [
      '📖 ',
      rt.bold(toSansBold(title)),
      ...(subtitle ? ['\n', rt.italic(subtitle)] : [])
    ];
    for (const sec of sections) {
      parts.push('\n\n\n', `${sec.icon || '✦'} `, rt.bold(toSansBold(sec.heading)));
      for (const item of sec.items) {
        parts.push('\n\n▸ ');
        item.labels.forEach((lbl, idx) => {
          if (idx > 0) parts.push('  ·  ');
          parts.push(rt.bold(lbl));
        });
        parts.push(`\n   ${item.desc}`);
      }
    }
    return rt.concat(...parts);
  }

  function renderMovieBroadcastCard(status, { notice = null, chatId = null, canGlobal = true } = {}) {
    const cid = Number(chatId);
    const inGroup = Number.isFinite(cid) && cid < 0;
    const globalOn = status?.globalEnabled !== false;
    const groupOn = status?.groupEnabled !== false;
    const b = card(
      '📢 MOVIE BROADCAST · ALL USERS',
      'Watch-Party DM Alerts When Streaming Movies in VC'
    );
    const rows = [
      ['🌐 All Users Broadcast', globalOn ? '🔔 Allowed (ON)' : '🔕 Disallowed (OFF)'],
      ...(inGroup ? [['👥 This Group Broadcast', groupOn ? '🔔 Allowed (ON)' : '🔕 Disallowed (OFF)']] : [])
    ];
    if (status?.eligibleUsersCount != null) {
      rows.push(['📬 Reachable Users', `${status.eligibleUsersCount} active user(s)`]);
    }
    b.table(rows, { striped: true, bordered: true, compact: true });
    if (notice) {
      b.blockquote(rt.text(notice));
    }
    b.expandableBlockquote(buildBoldGuideRichText(
      'MOVIE BROADCAST GUIDE',
      'Tap to view all alert controls ♡',
      [
        {
          icon: '📢',
          heading: 'BROADCAST COMMANDS',
          items: [
            { labels: ['/moviecast allow', '/moviecast on'], desc: 'Broadcast VC movie watch-parties to all bot users.' },
            { labels: ['/moviecast disallow', '/moviecast off'], desc: 'Stop broadcasting movies to users while VC keeps playing.' },
            { labels: ['/moviecast group allow', '/moviecast group disallow'], desc: 'Allow or mute movie alerts only for the current group chat.' },
            { labels: ['/moviebroadcast', '/moviealert', '/cinemaalert'], desc: 'Command aliases that open or toggle this same control panel.' }
          ]
        }
      ]
    ));
    if (canGlobal) {
      b.buttons([
        richButton.callback('🔔 Allow All Users', encodeCallback('music', 'mcast', 'on'), { style: globalOn ? 'success' : 'primary' }),
        richButton.callback('🔕 Disallow All Users', encodeCallback('music', 'mcast', 'off'), { style: globalOn ? 'link' : 'danger' })
      ]);
    }
    if (inGroup) {
      b.buttons([
        richButton.callback('👥 Group: Allow', encodeCallback('music', 'mcast', 'gon'), { style: groupOn ? 'success' : 'link' }),
        richButton.callback('🔕 Group: Off', encodeCallback('music', 'mcast', 'goff'), { style: groupOn ? 'link' : 'danger' })
      ]);
    }
    return finish(b);
  }

  function buildVcInstructionsGuide(s = null, { cinema = false } = {}) {
    const scopeHint = s?.isChannel ? 'CHANNEL LIVESTREAM GUIDE' : 'VOICE CHAT GUIDE';
    if (cinema) {
      return buildBoldGuideRichText(
        `CINEMA ${scopeHint}`,
        'Tap to view all Cinema VC commands & button instructions ♡',
        [
          {
            icon: '🎛',
            heading: 'VOICE CHAT COMMANDS',
            items: [
              { labels: ['/vc', '/player'], desc: 'Prepare assistant in VC and open this live dashboard (or reply /vc to any video file).' },
              { labels: ['/movie <title>', '/movieai <ask>'], desc: 'Search & stream full HD movies or multi-season TV series, or ask Media AI.' },
              { labels: ['/pause', '/resume', '/skip', '/previous'], desc: 'Pause, resume playback, skip forward, or return to the previous title.' },
              { labels: ['/seek <sec>', '/vol <0-200>', '/loop'], desc: 'Jump to an exact second, adjust call volume, or cycle repeat mode.' },
              { labels: ['/rtmp on', '/rtmp off', '/stop', '/leave'], desc: 'Switch locked A/V RTMP vs Interactive VC, or clear queue & leave call.' },
              { labels: ['/vcmsg <text>', '!np', '!queue', '!skip'], desc: 'Chat inside VC or let viewers inspect/skip live directly from call chat.' },
              { labels: ['/vcsudo', '/rmsudo', '/accounts'], desc: 'Approve or revoke VC controllers and manage assistant accounts.' },
              { labels: ['/moviecast allow', '/moviecast disallow'], desc: 'Owner toggle to allow or stop broadcasting VC movies to all bot users.' }
            ]
          },
          {
            icon: '🔘',
            heading: 'PLAYER BUTTONS',
            items: [
              { labels: ['▶ Resume / ⏸ Pause', '-30s / +30s', '⏱ Custom s'], desc: 'Control playback live, nudge playback forward/back, or seek any second.' },
              { labels: ['⏮ Prev / ⏭ Next', '🗳 Queue', '🎬 Movies'], desc: 'Navigate episodes/films, edit or vote on queue items, or browse titles.' },
              { labels: ['💬 Subs', '⏱ Sync'], desc: 'Toggle Screen Burn / Live Chat / VC Chat / Off subtitles and fix timing.' },
              { labels: ['🎞 Quality (1080p/720p/480p)', '🔒 RTMP Live / 🎙 Interactive VC'], desc: 'Adjust stream clarity or switch between locked A/V broadcast and WebRTC.' },
              { labels: ['📡 Source 1/N', '📡 Alt Source'], desc: 'Switch between working stream sources seamlessly without losing your spot.' },
              { labels: ['Vote', '📊 Poll', '⬇ Download'], desc: 'Vote to skip, run a group poll for next movie, or download MP4 to chat.' },
              { labels: ['🎙️ Join VC', '📌 Pin', '🎵 Music Player', '⚙ Options', '⏹ Stop'], desc: 'Open call, pin dashboard, switch deck, adjust VC settings, or end stream.' }
            ]
          }
        ]
      );
    }
    return buildBoldGuideRichText(
      scopeHint,
      'Tap to view all Voice Chat commands & button instructions ♡',
      [
        {
          icon: '🎛',
          heading: 'VOICE CHAT COMMANDS',
          items: [
            { labels: ['/vc', '/player'], desc: 'Prepare assistant in Voice Chat and open this live dashboard card.' },
            { labels: ['/vc <song>', '/addq <song>', '/vidc <song>', '/vplay <song>'], desc: 'Search & queue audio tracks or HD music videos into the live call.' },
            { labels: ['Reply /vc', '/stream'], desc: 'Reply directly to any audio file, voice note, or video in chat to stream it.' },
            { labels: ['/movie <title>', '/movieai <ask>'], desc: 'Search & stream full HD movies or multi-season TV series, or ask AI.' },
            { labels: ['/pause', '/resume', '/skip', '/previous', '/stop', '/leave'], desc: 'Control playback, skip tracks, clear queue, or disconnect assistant.' },
            { labels: ['/seek <sec>', '/vol <0-200>', '/eq <preset>', '/bass', '/loop', '/shuffle'], desc: 'Seek timestamp, set volume, apply Studio EQ or clean bass, and repeat.' },
            { labels: ['/random <mood>', '/aidj', '/dj', '/rtmp on|off'], desc: 'Start infinite mood radio, chat with AI DJ, or toggle locked RTMP mode.' },
            { labels: ['/vcmsg <text>', '/vcsudo', '/rmsudo', '/moviecast allow|disallow'], desc: 'Message inside VC, manage VC permissions, or toggle movie broadcasts.' }
          ]
        },
        {
          icon: '🔘',
          heading: 'PLAYER BUTTONS',
          items: [
            { labels: ['▶ Resume / ⏸ Pause', '⏮ Prev / ⏭ Skip', '-10s / +10s', '⏱ Custom s'], desc: 'Instant transport controls and fast timestamp seeking.' },
            { labels: ['Add tracks', '🎬 Video / vidc', '🎬 Movie Stream'], desc: 'Queue audio tracks, HD music videos, or open Cinema movies/series.' },
            { labels: ['🎙 Chat DJ', '🤖 AI DJ', '♾️ Infinite & Genres'], desc: 'Launch conversational DJ or pick non-stop genre mixes.' },
            { labels: ['🔊 VC volume', '🎛 Bass', 'Lyrics', 'Vote skip'], desc: 'Tune call volume, toggle Bass boost, view synced lyrics, or vote skip.' },
            { labels: ['💬 Subs & ⏱ Sync', '🎞 Quality', '🔒 RTMP / 🎙 VC'], desc: 'Switch video subtitle mode, 1080p/720p/480p tier, or stream engine.' },
            { labels: ['Listen / download', '🎙️ Join VC', '📌 Pin', 'More (⚙)'], desc: 'Download audio/video, jump into call, pin dashboard, or open settings.' }
          ]
        }
      ]
    );
  }

  function renderHome(ctx = null) {
    const isDm = Boolean(ctx && Number(ctx.chatId) > 0 && !isChannelCtx(ctx));
    if (isDm) {
      const b = card('Lancy · movies & music', 'Download HD movies, TV series, music & talk to AI.');
      b.blockquote(rt.text(
        '/movie — search & download full movies or clean TV episode slides\n' +
        '/play — search, listen or download full music tracks\n' +
        '/ai — unified AI Movie & Song assistant\n' +
        '/grab — download HD reels, shorts & audio from links\n\n' +
        '📢 Live Voice Chat & Channel Polls run directly inside Groups/Channels where Lancy is an admin!'
      ));
      b.buttons([
        button('🎬 Download Movies', 'moviehub', { style: 'success' }),
        button('🤖 AI Movie & Song', 'aichat', { style: 'primary' })
      ]);
      b.buttons([
        button('🎵 Play / Download Music', 'prompt', 'download', { style: 'primary' }),
        richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open'))
      ]);
      b.details('⌨ Quick Download Tips', [
        block.paragraph(rt.text('Tap 🎬 Download Movies or use /movie <title> to get direct HD MP4 files and non-spammy paginated series slides (◀ Prev / Next ▶).')),
        block.buttons([richButton.switchInlineCurrent('🔍 Inline Search', '')])
      ], false);
      return finish(b);
    }
    const b = card('Lancy · music & movies', 'Stream studio music, HD videos & full movies.');
    b.blockquote(rt.text('/play — listen here or download\n/addq — search and queue studio audio\n/vplay — queue HD 720p video + audio\n/movie — search & stream full movies & TV seasons\n/ai — unified AI Movie & Song Agent\n/aidj — AI DJ live curation & liner notes\n/player — persistent live control deck'));
    b.buttons([button('Voice chat', 'prompt', 'queue', { style: 'success' }), button('Listen / download', 'prompt', 'download')]);
    b.buttons([button('🎬 Movie Stream', 'moviehub', { style: 'primary' }), button('🤖 AI Movie & Song', 'aichat', { style: 'primary' })]);
    b.buttons([button('Video / vidc', 'prompt', 'video'), button('Open player', 'openplayer', { style: 'success' })]);
    b.buttons([button('Random / Infinite', 'openradio')]);
    b.details('⌨ Commands & Search Tips', [
      block.paragraph(rt.text('Search “title artist” for studio audio or HD video. Movie Stream (/movie) supports multi-season series, episode checklists, and subtitles. Direct channel commands (/vplay, /movie, /addq, /aidj, /random, /player, /skip, /pause, /stop) work inside channels where Lancy is an administrator.')),
      block.paragraph(rt.text('/playlist list · /playlist save <name> · /playlist load <name>')),
      block.buttons([richButton.switchInlineCurrent('🔍 Inline Search', '')])
    ], false);
    return finish(b);
  }

  function trackAudio(b, track, media, vc = false) {
    b.audio(audioInput(track, media), vc ? 'Full track · listen here, independently of the voice chat' : 'Full track · listen in Telegram or save from the audio menu');
  }

  function attachSafeArtworkPhoto(b, artwork, caption = 'Recording artwork') {
    if (!artwork) return false;
    try {
      const u = new URL(artwork);
      if (u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) {
        b.photo(u.href, cut(caption, 90) || 'Recording artwork');
        return true;
      }
    } catch {}
    return false;
  }

  function safeProgressRatio(pos, dur) {
    const p = Math.max(0, Number(pos || 0));
    const d = Number(dur || 0);
    if (!(d > 0)) return 0;
    const raw = Math.max(0, Math.min(1, p / d));
    return p < d ? Math.min(0.99, raw) : raw;
  }

  function recording(b, track, { media = null, lyrics = null, vc = false, positionSeconds = null } = {}) {
    if (media) trackAudio(b, track, media, vc);
    attachSafeArtworkPhoto(b, track.artwork || track.poster || track.backdrop || track.thumbnailUrl || track.thumb, 'Recording artwork');
    b.quote(rt.concat(rt.bold(cut(track.title, 160)), rt.text(`\n${cut(track.artist || 'Artist not supplied', 100)}${track.album ? ` · ${cut(track.album, 60)}` : ''}`)));
    b.table([
      ['Artist', track.artist || 'Not supplied'],
      ['Album', track.album || 'Not supplied'],
      ['Length', durationText(track.durationSeconds)],
      ['Format', track.mediaType === 'video' ? 'HD 720p Video + audio' : 'Studio Audio']
    ], { striped: true, bordered: true, compact: true });
    const fullLyrics = process.env.MUSIC_LYRICS_FULL_TEXT !== 'false';
    const karaoke = vc && lyrics?.syncedLyrics && Number.isFinite(positionSeconds)
      ? currentLyricWindow(lyrics.syncedLyrics, positionSeconds)
      : null;
    const baseText = lyrics?.found
      ? (lyrics.instrumental ? 'Instrumental recording.' : cut(lyrics.text, fullLyrics ? 1800 : 200))
      : (lyrics?.reason || 'No reliable matched lyrics yet. Use Lyrics for a fresh check.');
    const text = karaoke ? `🎤 Live Karaoke:\n${karaoke}\n\n${baseText}` : baseText;
    b.expandableBlockquote(`Lyrics · ${cut(track.title, 70)}\n\n${text}`);
    if (lyrics?.found && !lyrics.instrumental) {
      b.paragraph(rt.italic(fullLyrics ? 'Matched lyrics · open Lyrics for remaining pages.' : 'Matched lyrics excerpt · extended display needs the operator’s display-rights setting.'));
    }
  }

  function renderListen(track, media, { cardToken = null, lyrics = null } = {}) {
    const b = card('Lancy · listen & download', 'Your full recording. No voice chat needed.');
    recording(b, track, { media, lyrics });
    if (cardToken) b.buttons([button('Add to VC queue', 'listenq', cardToken, { style: 'success' })]);
    b.buttons([button('Find another song', 'prompt', 'download'), button('Search for VC', 'prompt', 'queue')]);
    b.details('📋 Copy & Share Track', [
      block.paragraph(rt.italic('Tap the audio to listen; use its menu to save the file. Adding to VC requires verified destination-administrator rights.')),
      block.buttons([
        richButton.copy('📋 Copy Title', `${cut(track.title, 60)}${track.artist ? ` - ${cut(track.artist, 40)}` : ''}`),
        richButton.switchInlineCurrent('🔍 Similar', cut(track.artist || track.title, 28))
      ])
    ], false);
    return finish(b);
  }

  function formatVcQualityShort(s) {
    const q = s.vcQuality || app.musicQueueManager?.getVcQuality?.(s.destination || s.chatId, {
      isMovieTrack: s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie',
      streamMode: s.streamMode || 'interactive'
    }) || ((s.streamMode || ((s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie') ? 'rtmp' : 'interactive')) === 'rtmp' ? 'FHD_1080p' : 'HD_720p');
    if (q === 'SD_480p') return '480p Saver';
    if (q === 'HD_720p') return '720p Smooth';
    return '1080p HD';
  }

  function renderPlayer(s) {
    const badge = STATUS_BADGE[s.status] || s.status;
    const eqPreset = s.eqPreset || (s.bass ? 'bass' : 'off');
    const qShort = formatVcQualityShort(s);
    const streamLabel = s.streamMode === 'rtmp' ? '🔒 RTMP Live' : '🎙 Interactive VC';
    const b = card(
      s.isChannel ? 'Lancy · CHANNEL LIVE BROADCAST' : 'Lancy · Spotify X Player',
      `${s.isChannel ? 'CHANNEL LIVE BROADCAST · Spotify X' : 'Spotify X Voice Chat'} · ${cut(s.destinationTitle || (s.isChannel ? 'Channel' : 'Group'), 36)} · ${badge}`
    );
    if (s.status === 'stopped') {
      b.pullquote(s.lastError ? cut(s.lastError, 220) : 'Playback service stopped. Open the current player after restart to restore your session.', '⏹ Session Stopped');
      b.buttons([
        s.panelToken ? controls(s, 'Open current player', 'player', { style: 'success' }) : button('Open current player', 'openplayer', { style: 'success' }),
        controls(s, s.pinned ? '📍 Pinned' : '📌 Pin', 'pin', { style: s.pinned ? 'link' : 'primary' })
      ]);
      return finish(b);
    }

    const t = s.currentTrack;
    const aiDjActive = Boolean(s.aiDj?.enabled);
    if (!t) {
      b.quote(rt.text(
        s.status === 'buffering'
          ? (s.lastNotice || '⏳ Preparing media stream & connecting to call…')
          : s.status === 'error' && s.upcoming?.length
            ? 'Playback could not start. Your queued recording is retained; use Retry queued track.'
            : s.connected
              ? 'Queue complete. After ten uninterrupted idle minutes the assistant leaves the call and, for groups, the group.'
              : 'No active playback. Use Add tracks for VC, or Listen / download without joining a call.'
      ));
    } else {
      const preview = s.fullPreview?.trackId === t.id ? s.fullPreview : null;
      if (preview?.status === 'ready' && preview.fileId) trackAudio(b, preview.track || t, preview.fileId, true);
      else if (preview?.status === 'pending') b.paragraph(rt.italic('Preparing the full-song audio player… VC playback continues independently.'));
      else if (preview?.status === 'unavailable') b.paragraph(rt.italic(cut(preview.reason, 240)));

      const displayMusicPos = Number.isFinite(s.positionSeconds)
        ? s.positionSeconds
        : (Number.isFinite(s.lastKnownPositionSeconds) ? s.lastKnownPositionSeconds : s.positionSeconds);
      recording(b, t, { lyrics: s.cardLyrics && s.cardLyrics.trackId === t.id ? s.cardLyrics.result : null, vc: true, positionSeconds: displayMusicPos });

      const eqLabel = eqPreset !== 'off' ? ` · ${eqPreset === 'bass' ? 'Clean Bass' : `EQ ${eqPreset}`}` : '';
      b.paragraph(rt.text(`VC · ${durationText(displayMusicPos)} / ${durationText(t.durationSeconds)} · ${t.mediaType === 'video' ? 'HD Video + audio' : 'Audio'}${eqLabel}`));
      if (Number.isFinite(displayMusicPos) && t.durationSeconds) {
        const ratio = safeProgressRatio(displayMusicPos, t.durationSeconds);
        const remSec = Math.max(0, Math.round(Number(t.durationSeconds) - Number(displayMusicPos)));
        b.paragraph(rt.code(`${progressBar(ratio, { width: 12, filled: '█', empty: '░' })}  ${remSec > 0 ? `-${durationText(remSec)}` : 'Done'}`));
      }
      const volText = s.volumeConfirmed === false ? 'unconfirmed' : `${s.volume}%`;
      const subMode = ['screen', 'live', 'vc', 'off'].includes(s.subtitleMode) ? s.subtitleMode : 'screen';
      const hasMovieOrVideo = Boolean(t.mediaType === 'video' || t.provider === 'movie' || t.subtitlePath);
      const subDisplay = subMode === 'screen' ? 'Screen Burn' : subMode === 'live' ? 'Live Cues' : subMode === 'vc' ? 'Burn + VC Chat' : 'Off';
      const metaRows = [
        ['🔊 Volume', `${volText} · 🔁 ${s.loopMode}`],
        ['🎛 Audio EQ', eqPreset === 'bass' ? 'Clean Bass ON' : eqPreset === 'studio' ? 'Studio EQ' : eqPreset],
        ...(hasMovieOrVideo ? [['🎞 Video / Subs', `${qShort} · ${subDisplay}`]] : []),
        ['📡 Stream & Queue', `${streamLabel} · ${s.upcoming?.length || 0} upcoming`],
        ['🤖 AI DJ', aiDjActive ? `ON · ${cut(s.aiDj?.vibe || 'Studio Mix', 26)}` : 'Off']
      ];
      b.table(metaRows, { striped: true, bordered: true, compact: true });
      b.paragraph(rt.text(`VC volume ${volText} · Repeat ${s.loopMode} · ${s.upcoming?.length || 0} queued`));

      if (hasMovieOrVideo && subMode === 'live' && s.liveSubCue) {
        b.quote(rt.text(`💬 ${cut(s.liveSubCue, 240)}`));
      }
      if (aiDjActive && s.aiDj?.introNote) {
        b.pullquote(cut(s.aiDj.introNote, 180), `🤖 AI DJ · ${cut(s.aiDj.vibe || 'Studio Mix', 30)}`);
      } else if (s.upcoming?.[0]) {
        b.pullquote(
          `${cut(s.upcoming[0].title, 68)}${s.prefetched?.entryId === s.upcoming[0].entryId && s.prefetched?.media ? ' · ⚡ Buffered Ready' : ''}`,
          '⏭ Up Next'
        );
      } else {
        b.pullquote(`${badge} · ${cut(t.title, 54)}`, t.mediaType === 'video' ? '🎬 Video VC' : '🎧 Audio VC');
      }
      const isMusicMutedLive = Boolean(s.status === 'error' && s.connected && /Telegram muted|still blocks this account/i.test(String(s.lastError || '')));
      if (['playing', 'paused'].includes(s.status) || isMusicMutedLive) {
        b.buttons(
          isMusicMutedLive
            ? [
                controls(s, '⏮ Previous', 'previous', { style: 'link' }),
                controls(s, '🔊 Unmute', 'resume', { style: 'success' }),
                controls(s, '⏸ Pause', 'pause', { style: 'primary' }),
                controls(s, '⏭ Skip', 'skip', { style: 'link' }),
                controls(s, '⏹ Stop', 'stop', { style: 'danger' })
              ]
            : [
                controls(s, '⏮ Previous', 'previous', { style: 'link' }),
                controls(s, s.status === 'paused' ? 'Resume VC' : 'Pause VC', s.status === 'paused' ? 'resume' : 'pause', { style: s.status === 'paused' ? 'success' : 'primary' }),
                controls(s, '⏭ Skip', 'skip', { style: 'link' }),
                controls(s, '⏹ Stop', 'stop', { style: 'danger' })
              ]
        );
      }
      const extraRow = [];
      const musicSeekStep = Number(s.seekStepSeconds) >= 5 ? Math.round(Number(s.seekStepSeconds)) : 10;
      if (t.capabilities?.seek && Number.isFinite(s.positionSeconds)) {
        extraRow.push(
          controls(s, `−${musicSeekStep} sec`, 'seekby', -musicSeekStep, { style: 'link' }),
          controls(s, `+${musicSeekStep} sec`, 'seekby', musicSeekStep, { style: 'link' }),
          controls(s, '⏱ Custom s', 'seekmenu', { style: 'link' })
        );
      }
      if (hasMovieOrVideo) {
        extraRow.push(controls(s, `💬 Subs · ${subMode === 'screen' ? 'Screen' : subMode === 'live' ? 'Live' : subMode === 'vc' ? 'VC Chat' : 'Off'}`, 'subsync', { style: 'link' }));
        extraRow.push(controls(s, `🎞 ${qShort.split(' ')[0]}`, 'vcquality', { style: s.vcQuality === 'HD_720p' ? 'success' : 'link' }));
      }
      if (['playing', 'paused'].includes(s.status) && !s.isChannel) {
        extraRow.push(controls(s, s.skipVotes?.length ? `Vote skip (${s.skipVotes.length})` : 'Vote skip', 'voteskip', { style: 'link' }));
      }
      if (extraRow.length) b.buttons(extraRow);
    }

    const canResumeIdle = Boolean(
      !t && (
        s.upcoming?.length ||
        ((s.callEnded || s.status === 'error' || (Number(s.lastKnownPositionSeconds) || 0) > 0) && s.history?.length)
      )
    );
    if (canResumeIdle) {
      if (s.status === 'error' && s.upcoming?.length) {
        b.buttons([
          controls(s, '🔄 Retry queued track', 'retry', { style: 'success' }),
          controls(s, '▶ Resume', 'resume', { style: 'primary' }),
          controls(s, '⏹ Stop & clear', 'stop', { style: 'danger' })
        ]);
      } else {
        b.buttons([
          controls(s, '▶ Resume playback', 'resume', { style: 'success' }),
          controls(s, '⏹ Stop & clear', 'stop', { style: 'danger' })
        ]);
      }
    } else if (!t && !s.upcoming?.length && (s.connected || s.prepared || s.status === 'buffering')) {
      b.buttons([controls(s, s.isChannel ? '⏹ Stop & leave call' : '⏹ Stop & leave group', 'stop', { style: 'danger' })]);
    }

    if (s.radio?.enabled) b.paragraph(rt.text(`♾️ Infinite radio · ${s.radio.queries.join(' + ')}`));
    if (s.radio?.notice) b.paragraph(rt.text(cut(s.radio.notice, 220)));
    if (s.panelNotice) b.paragraph(rt.text(cut(s.panelNotice, 240)));
    if (s.lastNotice) b.paragraph(rt.text(cut(s.lastNotice, 350)));
    if (s.lastError) b.paragraph(rt.text(cut(s.lastError, 350)));

    const bassOn = eqPreset === 'bass' || Boolean(s.bass);
    const defaultMode = defaultMediaMode(s);
    b.buttons([
      controls(s, `Queue · ${s.upcoming?.length || 0}`, 'queue', { style: 'link' }),
      controls(s, 'Lyrics', 'lyrics', { style: 'link' }),
      controls(s, 'VC volume', 'volume', { style: 'link' }),
      controls(s, aiDjActive ? '🤖 AI DJ · ON' : '🤖 AI DJ · OFF', 'aidj', { style: aiDjActive ? 'success' : 'link' })
    ]);
    b.buttons([
      s.panelToken ? controls(s, 'Add tracks', 'prompt', defaultMode, { style: 'success' }) : button('Add tracks', 'prompt', defaultMode, { style: 'success' }),
      controls(s, '🎛 Live DJ Desk', 'djdesk', 'open', { style: aiDjActive ? 'success' : 'primary' }),
      s.panelToken ? controls(s, '🎙 Chat DJ', 'prompt', 'dj', { style: 'primary' }) : button('🎙 Chat DJ', 'prompt', 'dj', { style: 'primary' }),
      controls(s, bassOn ? '🎛 Bass · ON' : '🎛 Bass · OFF', 'bass', { style: bassOn ? 'success' : 'link' })
    ]);
    b.buttons([
      controls(s, '🎬 Movie Stream', 'movie', 'hub', { style: 'primary' }),
      s.panelToken ? controls(s, '🎬 Video / vidc', 'prompt', 'video', { style: 'link' }) : button('🎬 Video / vidc', 'prompt', 'video', { style: 'link' }),
      controls(s, '♾️ Infinite & Genres', 'catmenu', defaultMode, { style: 'link' }),
      s.panelToken ? controls(s, 'Listen / download', 'prompt', 'download', { style: 'link' }) : button('Listen / download', 'prompt', 'download', { style: 'link' }),
      controls(s, 'More', 'options', { style: 'link' })
    ]);
    const playerJoinBtn = joinCallButton(s);
    const tailRow = [];
    if (playerJoinBtn) tailRow.push(playerJoinBtn);
    tailRow.push(controls(s, s.pinned ? '📍 Pinned' : '📌 Pin', 'pin', { style: s.pinned ? 'link' : 'primary' }));
    if (s.panelToken) tailRow.push(controls(s, 'My channels', 'channels', { style: 'link' }));
    if (tailRow.length) b.buttons(tailRow);

    const shortcutBtns = [];
    if (t) {
      shortcutBtns.push(richButton.copy('📋 Copy Track', `${cut(t.title, 60)}${t.artist ? ` - ${cut(t.artist, 40)}` : ''}`));
    }
    if (!s.isChannel && !s.panelToken) {
      shortcutBtns.push(richButton.switchInlineCurrent('🔍 Inline Search', t ? cut(t.title, 30) : ''));
    }
    if (shortcutBtns.length) {
      b.details('⌨ Quick Copy & Inline Search', [block.buttons(shortcutBtns)], false);
    }
    b.expandableBlockquote(buildVcInstructionsGuide(s, { cinema: false }));

    return finish(b);
  }

  function renderOptions(s) {
    const eq = s.eqPreset || (s.bass ? 'bass' : 'off');
    const aiDjActive = Boolean(s.aiDj?.enabled);
    const subMode = ['screen', 'live', 'vc', 'off'].includes(s.subtitleMode) ? s.subtitleMode : 'screen';
    const streamMode = s.streamMode === 'rtmp' ? 'rtmp' : 'interactive';
    const qShort = formatVcQualityShort(s);
    const b = card('Lancy · voice-chat settings', 'Changes stay in this dashboard');
    b.table([
      ['Account', s.accountAlias || s.preferredAccount || 'Not connected'],
      ['Repeat', s.loopMode],
      ['Gentle bass', s.bass ? 'on' : 'off'],
      ['Audio EQ', eq],
      ['Subtitles', subMode],
      ['Stream Engine', streamMode === 'rtmp' ? '🔒 RTMP Live (Locked A/V)' : '🎙 Interactive VC (WebRTC)'],
      ['Video Quality', qShort],
      ['AI DJ', aiDjActive ? `ON · ${cut(s.aiDj?.vibe || 'Studio Mix', 28)}` : 'off'],
      ['Video Output', `${qShort} + Studio Canvas`]
    ], { striped: true, bordered: true, compact: true });
    b.buttons([controls(s, `Repeat · ${s.loopMode}`, 'loop'), controls(s, 'Shuffle', 'shuffle'), controls(s, `💬 Subs · ${subMode}`, 'submode'), controls(s, '⏱ Sub Sync', 'subsync')]);
    b.buttons([
      controls(s, s.bass ? 'Bass · on' : 'Bass · off', 'bass', { style: s.bass ? 'success' : 'primary' }),
      controls(s, `EQ · ${eq}`, 'eq'),
      controls(s, streamMode === 'rtmp' ? '🔒 Mode · RTMP Live' : '🎙 Mode · Interactive VC', 'streammode', { style: streamMode === 'rtmp' ? 'success' : 'primary' }),
      controls(s, `🎞 ${qShort}`, 'vcquality', { style: s.vcQuality === 'HD_720p' ? 'success' : 'primary' })
    ]);
    b.buttons([controls(s, aiDjActive ? '🤖 AI DJ · ON' : '🤖 AI DJ · OFF', 'aidj', { style: aiDjActive ? 'success' : 'primary' }), controls(s, '🎬 Movie Stream', 'movie', 'hub', { style: 'primary' }), controls(s, '🗳 Vote Settings', 'voteset', { style: 'primary' }), controls(s, s.pinned ? '📍 Pinned' : '📌 Pin player', 'pin')]);
    b.buttons([controls(s, 'Accounts', 'accounts'), controls(s, 'Retry full preview', 'preview'), controls(s, s.isChannel ? 'Stop & leave call' : 'Stop & leave group', 'stop', { style: 'danger' })]);
    b.buttons([controls(s, 'Back to player', 'player')]);
    b.paragraph(rt.italic('VC settings do not control the audio player above. Bass & EQ apply on next track/seek; RTMP Mode locks audio & video into one broadcast stream. /movie · /seek <seconds> · /rtmp · /eq studio'));
    return finish(b);
  }

  function renderVoteSettings(s) {
    const destId = s.destination || s.chatId;
    const skipNeed = app.music?.getSkipVoteThreshold?.(destId) ?? 2;
    const queueNeed = app.music?.getQueueVoteThreshold?.(destId) ?? 2;
    const voteMode = app.music?.getQueueVoteAction?.(destId) ?? 'playnow';
    const autoPoll = app.music?.isAutoPollEnabled?.(destId) ?? true;
    const b = card('🗳 LANCY MUSIC · VIEWER VOTE DASHBOARD', `${cut(s.destinationTitle || 'Voice Chat', 40)} · Owner & Admin Controls`);
    const rows = [
      ['🤖 Auto-Poll (Movies)', autoPoll ? '✅ ON · 1 poll per movie, deletes when decided' : '⚪ OFF · Manual polls only'],
      ['⏭ Skip Votes Needed', `${skipNeed} viewer vote(s)`],
      ['🗳 Queue Votes Needed', `${queueNeed} viewer vote(s)`],
      ['⚡ Winning Queue Action', voteMode === 'playnow' ? 'Play Immediately' : 'Move to Next (#1)']
    ];
    if (s.activePoll?.pollId) {
      rows.push(['📊 Active Poll', `Live (${Number(s.activePoll.totalVoters || 0)} votes recorded)`]);
    }
    b.table(rows, { striped: true, bordered: true, compact: true });
    if (s.lastError) b.blockquote(rt.text(`⚠ ${cut(s.lastError, 240)}`));
    else if (s.lastNotice) b.blockquote(rt.text(`ℹ️ ${cut(s.lastNotice, 240)}`));
    b.buttons([
      controls(s, autoPoll ? '🤖 Auto-Poll · ON' : '🤖 Auto-Poll · OFF', 'setvotethresh', 'autopoll', autoPoll ? 'off' : 'on', { style: autoPoll ? 'success' : 'primary' })
    ]);
    b.paragraph(rt.bold('⏭ Skip Threshold (votes required to skip):'));
    b.buttons([1, 2, 3, 5, 10].map((n) => controls(s, `${n}v`, 'setvotethresh', 'skip', n, { style: n === skipNeed ? 'success' : 'primary' })));
    b.paragraph(rt.bold('🗳 Queue Vote Threshold (votes required to win):'));
    b.buttons([1, 2, 3, 5, 10].map((n) => controls(s, `${n}v`, 'setvotethresh', 'queue', n, { style: n === queueNeed ? 'success' : 'primary' })));
    b.buttons([
      controls(s, voteMode === 'playnow' ? '✅ Play Immediately' : '▶ Play Immediately', 'setvotethresh', 'mode', 'playnow', { style: voteMode === 'playnow' ? 'success' : 'primary' }),
      controls(s, voteMode === 'top' ? '✅ Boost to #1' : '⬆ Boost to #1', 'setvotethresh', 'mode', 'top', { style: voteMode === 'top' ? 'success' : 'primary' })
    ]);
    b.buttons([
      controls(s, '📊 Launch Telegram Poll', 'launchpoll', { style: 'success' }),
      controls(s, '◀ Back to Player', 'player')
    ]);
    b.paragraph(rt.italic('When Auto-Poll is ON, 1 poll posts automatically per playing movie whenever queue has upcoming items, executes the winner on threshold, and deletes cleanly. /autopoll on|off [votes]'));
    return finish(b);
  }

  function formatSubSyncSummary(s, t) {
    if (!t?.subtitlePath) return { badge: 'None', detail: 'No subtitle track loaded.' };
    const st = s.subtitleSyncStatus || null;
    const status = String(st?.status || '');
    const driftMpm = Number(st?.drift_ms_per_min || (Number(s.subtitleDriftRate || 0) * 60000) || 0);
    const driftTxt = Math.abs(driftMpm) >= 30 ? ` · drift ${driftMpm > 0 ? `+${Math.round(driftMpm)}` : Math.round(driftMpm)}ms/m` : '';
    const resSec = Number(st?.residual_sec || 0);
    if (status === 'auto_normalized') {
      return { badge: `🔧 Auto-Normalized${driftTxt}`, detail: st?.message || `Normalized automatically${driftTxt}` };
    }
    if (status === 'synced') {
      return { badge: `✅ In Sync${driftTxt}`, detail: st?.message || 'Live audio speech matches active subtitles.' };
    }
    if (status === 'desynced' || status === 'drifted') {
      const resStr = Math.abs(resSec) >= 0.3 ? ` (~${resSec > 0 ? `+${resSec.toFixed(1)}` : resSec.toFixed(1)}s)` : '';
      return { badge: `⚠️ Out of Sync${resStr}${driftTxt}`, detail: st?.message || `Subtitle desync detected${resStr}` };
    }
    if (status === 'mismatch') {
      return { badge: '⚠️ Cut Mismatch', detail: st?.message || 'Subtitles appear to be from a different video cut.' };
    }
    if (status === 'manual') {
      return { badge: '🎛 Manual Lock', detail: st?.message || 'Manual subtitle offset lock active.' };
    }
    return { badge: '🔍 Live Monitor On', detail: st?.message || 'Continuously checking live speech vs subtitles.' };
  }

  function renderSubSyncPicker(s) {
    const t = s.currentTrack;
    const subMode = ['screen', 'live', 'vc', 'off'].includes(s.subtitleMode) ? s.subtitleMode : 'screen';
    const offset = Number(s.subtitleSyncOffset || 0) || 0;
    const offsetLabel = `${offset > 0 ? `+${offset}` : offset}s`;
    const tracks = Array.isArray(t?.subtitleTracks) ? t.subtitleTracks : [];
    const curIdx = Math.max(0, Number(s.subtitleTrackIndex || 0));
    const activeTrack = tracks[curIdx] || null;
    const trackLabel = activeTrack?.label || (t?.subtitlePath ? 'Active English Track' : 'No subtitle loaded');
    const sameRoute = Boolean(activeTrack?.sameRoute || ['embedded', 'subtitle_hint'].includes(activeTrack?.source) || t?.subtitleSameRoute);
    const sourceBadge = !t?.subtitlePath
      ? 'None'
      : sameRoute
        ? 'Same-Stream (Lip-Synced)'
        : s.subtitleAutoOffset
          ? `Speech Auto-Aligned (${s.subtitleAutoOffset > 0 ? `+${s.subtitleAutoOffset}` : s.subtitleAutoOffset}s)`
          : s.subtitleAutoVerified
            ? 'Speech-Verified'
            : 'OpenSubtitles / External';
    const syncMeta = formatSubSyncSummary(s, t);
    const b = card('💬 LANCY CINEMA · SUBTITLE & VOICE SYNC', cut(t?.title || s.destinationTitle || 'Voice Chat', 48));
    b.table([
      ['Mode', subMode === 'screen' ? 'Screen Burn (Live Hot-Reload)' : subMode === 'live' ? 'Live Text Cues' : subMode === 'vc' ? 'Screen Burn + VC Chat Cues' : 'Off'],
      ['Source', sourceBadge],
      ['Live Checker', syncMeta.badge],
      ['Voice Offset', offset === 0 ? '0.0s (Default)' : `${offsetLabel} (${offset < 0 ? 'Earlier' : 'Later'})`],
      ['Track', tracks.length ? `${curIdx + 1}/${tracks.length} · ${cut(trackLabel, 28)}` : cut(trackLabel, 32)]
    ], { striped: true, bordered: true, compact: true });
    b.paragraph(rt.italic(`${syncMeta.detail} Updates live in-stream with zero restart. Voices ahead? Tap −0.5s. Subtitles early? Tap +0.5s.`));
    b.buttons([
      controls(s, `${subMode === 'screen' ? '✓ ' : ''}📺 Screen`, 'submode', 'screen', subMode === 'screen' ? { style: 'success' } : { style: 'primary' }),
      controls(s, `${subMode === 'vc' ? '✓ ' : ''}📣 Burn+VC`, 'submode', 'vc', subMode === 'vc' ? { style: 'success' } : { style: 'primary' }),
      controls(s, `${subMode === 'live' ? '✓ ' : ''}💬 Live`, 'submode', 'live', subMode === 'live' ? { style: 'success' } : { style: 'primary' }),
      controls(s, `${subMode === 'off' ? '✓ ' : ''}🔇 Off`, 'submode', 'off', subMode === 'off' ? { style: 'danger' } : null)
    ]);
    b.buttons([
      controls(s, '−2s', 'subsync', -2),
      controls(s, '−0.5s', 'subsync', -0.5, { style: 'primary' }),
      controls(s, '0s', 'subsync', 'reset', offset === 0 ? { style: 'success' } : null),
      controls(s, '+0.5s', 'subsync', 0.5, { style: 'primary' }),
      controls(s, '+2s', 'subsync', 2)
    ]);
    if (tracks.length > 1) {
      const subBtns = tracks.slice(0, 12).map((tr, i) => {
        const rawLbl = String(tr?.label || tr?.language || `Track ${i + 1}`).replace(/\s*subtitles?$/i, '').trim();
        const tag = cut(rawLbl || `Track ${i + 1}`, 14);
        return controls(s, `${i === curIdx ? '✓ ' : ''}${tag}`, 'subtrack', i, i === curIdx ? { style: 'success' } : { style: 'primary' });
      });
      for (let i = 0; i < subBtns.length; i += 3) {
        b.buttons(subBtns.slice(i, i + 3));
      }
    }
    const tail = [];
    if (t?.subtitlePath) {
      tail.push(controls(s, '🔍 Auto-Sync', 'subcheck', { style: 'primary' }));
    }
    if (tracks.length > 1) {
      tail.push(controls(s, `🌐 Next (${curIdx + 1}/${tracks.length})`, 'subtrack', { style: 'primary' }));
    }
    if (Array.isArray(t?.audioVariants) && t.audioVariants.length > 1) {
      tail.push(controls(s, `🔊 Audio (${t.audioVariants.length})`, 'audiolang', { style: 'primary' }));
    }
    tail.push(controls(s, '◀ Back', 'subsync', 'back'));
    b.buttons(tail);
    return finish(b);
  }

  function renderAudioLangPicker(s) {
    const t = s.currentTrack;
    const variants = (app.musicQueueManager?.getAudioVariants?.(t) || (Array.isArray(t?.audioVariants) ? t.audioVariants : []))
      .filter((v) => v?.url);
    const curLang = String(t?.audioLanguage || '').trim().toLowerCase();
    const curPref = String(t?.preferredAudioLang || '').trim().toLowerCase();
    let curIdx = variants.findIndex((v) =>
      v.url === t?.streamUrl && (!v.inManifest || (v.audioLanguage && v.audioLanguage === (curPref || curLang)))
    );
    if (curIdx < 0) curIdx = 0;
    const active = variants[curIdx] || null;
    const activeBadge = active
      ? `${active.audioIsDub ? 'Dubbed' : 'Original'} (${String(active.audioLanguage || 'EN').toUpperCase()}) · ${active.qualityLabel || 'HD'}`
      : (t?.audioLanguage ? `${t.audioIsDub ? 'Dubbed' : 'Original'} (${String(t.audioLanguage).toUpperCase()})` : 'Default');
    const b = card('🔊 LANCY CINEMA · AUDIO LANGUAGE', cut(t?.title || s.destinationTitle || 'Voice Chat', 48));
    b.table([
      ['Active Audio', activeBadge],
      ['Original', t?.originalLanguage ? String(t.originalLanguage).toUpperCase() : 'Auto'],
      ['Available', `${variants.length || 1} track${variants.length === 1 ? '' : 's'}`]
    ], { striped: true, bordered: true, compact: true });
    b.paragraph(rt.italic('Tap any audio language below to hot-reload the live call at your exact timestamp without losing subtitles or queue.'));
    if (variants.length) {
      const langBtns = variants.slice(0, 9).map((v, i) => {
        const code = String(v.audioLanguage || '').toUpperCase();
        const namePart = cut(String(v.label || code || `Audio ${i + 1}`), 12);
        const typeTag = v.audioIsDub ? 'Dub' : 'Orig';
        const qPart = v.qualityLabel ? ` ${v.qualityLabel}` : '';
        return controls(
          s,
          `${i === curIdx ? '✓ ' : ''}${namePart} (${typeTag}${qPart})`,
          'audiolang',
          i,
          i === curIdx ? { style: 'success' } : { style: v.audioIsDub ? 'primary' : 'success' }
        );
      });
      for (let i = 0; i < langBtns.length; i += 2) {
        b.buttons(langBtns.slice(i, i + 2));
      }
    }
    const subTracks = Array.isArray(t?.subtitleTracks) ? t.subtitleTracks : [];
    const navRow = [];
    if (subTracks.length > 0 || t?.subtitlePath) {
      navRow.push(controls(s, `💬 Subs (${subTracks.length || 1})`, 'subsync', { style: 'primary' }));
    }
    navRow.push(controls(s, '◀ Back', 'audiolang', 'back'));
    b.buttons(navRow);
    return finish(b);
  }

  function renderDjDesk(s) {
    const t = s.currentTrack;
    const nextT = s.upcoming?.[0] || null;
    const dj = s.aiDj || {};
    const eq = s.eqPreset || (s.bass ? 'bass' : 'off');
    const pos = Number.isFinite(s.positionSeconds) ? s.positionSeconds : (Number(s.lastKnownPositionSeconds) || 0);
    const dur = Number(t?.durationSeconds || 0);
    const ratio = safeProgressRatio(pos, dur);
    const visualOn = dj.visualDesk !== false;
    const lyricsOn = dj.deskLyrics !== false;
    const remixOn = /\bremix\b/i.test(dj.styleQualifier || '');
    const cfSec = Number(dj.crossfadeSec ?? 4);
    const chapter = dj.chapterTitle || dj.vibe || 'Studio Mix';
    const roster = Array.isArray(dj.artistPlan?.artists) && dj.artistPlan.artists.length
      ? dj.artistPlan.artists.map(a => a.artist).slice(0, 5).join(' → ')
      : (dj.artistPlan?.artist || dj.vibe || 'Dynamic Mix');

    const b = card('🎛 LANCY SPOTIFY AI DJ · LIVE DESK', `${cut(s.destinationTitle || 'Voice Chat', 34)} · Interactive Mixer & Visual Desk`);
    if (t) {
      b.quote(rt.concat(
        rt.bold(`🟢 DECK A (ON AIR): ${cut(t.title, 70)}`),
        rt.text(`\nArtist: ${cut(t.artist || 'Studio Artist', 60)} · ${durationText(pos)} / ${durationText(dur)}`)
      ));
      if (dur > 0) {
        b.paragraph(rt.code(`${progressBar(ratio, { width: 14, filled: '█', empty: '░' })}  Deck A ──${cfSec ? '●' : '│'}── Deck B (${cfSec ? `${cfSec}s xfade` : 'cut'})`));
      }
      const lyr = s.cardLyrics?.trackId === t.id ? s.cardLyrics.result : null;
      if (lyr?.syncedLyrics) {
        const win = currentLyricWindow(lyr.syncedLyrics, pos);
        if (win) b.blockquote(`🎤 Live Desk Lyrics:\n${win}`);
      } else if (s.liveSubCue) {
        b.blockquote(`🎤 Live Desk Lyrics:\n▶ ${cut(s.liveSubCue, 180)}`);
      }
    } else {
      b.quote(rt.text('Deck A is ready — tap Steer DJ or Drop Chapter to start your mix!'));
    }

    const rows = [
      ['📀 Deck B · Up Next', nextT ? `${cut(nextT.title, 34)} — ${cut(nextT.artist || '', 24)}` : 'Auto-Curating Next Cut…'],
      ['🎙 Chapter / Mode', cut(chapter, 46)],
      ['🔁 Rotation Roster', cut(roster, 46)],
      ['📺 Visual DJ Desk', visualOn ? '🟢 Animated 20fps + LRC Lyrics' : '⚪ Off (Video / Audio Only)'],
      ['📜 Screen Lyrics', lyricsOn ? '🟢 Synced LRC Karaoke ON' : '⚪ Off'],
      ['🔀 Remix Focus', remixOn ? '🟢 ON (Remixes prioritized)' : '⚪ Off (Original Cuts)'],
      ['🎚 Crossfade / EQ', `${cfSec ? `${cfSec}s Fade` : 'Clean Cut'} · ${eq === 'bass' ? 'Clean Bass' : eq}`]
    ];
    b.table(rows, { striped: true, bordered: true, compact: true });
    if (dj.introNote) b.pullquote(cut(dj.introNote, 180), '🎙 AI DJ Live Note');
    if (s.lastNotice) b.paragraph(rt.text(cut(s.lastNotice, 220)));

    b.buttons([
      controls(s, '⏮ Prev', 'previous', { style: 'link' }),
      controls(s, s.status === 'paused' ? '▶ Resume' : '⏸ Pause', s.status === 'paused' ? 'resume' : 'pause', { style: s.status === 'paused' ? 'success' : 'primary' }),
      controls(s, '⏭ Next', 'skip', { style: 'link' }),
      controls(s, '⏭ Drop Chapter', 'djdesk', 'chapter', { style: 'success' })
    ]);
    b.buttons([
      controls(s, visualOn ? '📺 Visual Desk · ON' : '📺 Visual Desk · OFF', 'djdesk', 'vdesk', { style: visualOn ? 'success' : 'link' }),
      controls(s, lyricsOn ? '📜 Lyrics · ON' : '📜 Lyrics · OFF', 'djdesk', 'dlyrics', { style: lyricsOn ? 'success' : 'link' }),
      controls(s, remixOn ? '🔀 Remix · ON' : '🔀 Remix · OFF', 'djdesk', 'remix', { style: remixOn ? 'success' : 'link' }),
      controls(s, `🎚 Xfade · ${cfSec ? `${cfSec}s` : 'Off'}`, 'djdesk', 'xfade', { style: 'primary' })
    ]);
    b.buttons([
      controls(s, `🎛 EQ · ${eq}`, 'eq', { style: 'link' }),
      s.panelToken ? controls(s, '🎤 Steer / Request DJ', 'prompt', 'dj', { style: 'primary' }) : button('🎤 Steer / Request DJ', 'prompt', 'dj', { style: 'primary' }),
      controls(s, '🔊 Volume', 'volume', { style: 'link' }),
      controls(s, '◀ Back to Player', 'djdesk', 'back')
    ]);
    return finish(b);
  }

  function renderSeekPicker(s) {
    const t = s.currentTrack;
    const isMovieDeck = s.activeDeck === 'movie' || t?.provider === 'movie';
    const defaultStep = isMovieDeck ? 30 : 10;
    const activeStep = Number(s.seekStepSeconds) >= 5 ? Math.round(Number(s.seekStepSeconds)) : defaultStep;
    const posVal = (typeof s.positionSeconds === 'number' && Number.isFinite(s.positionSeconds))
      ? s.positionSeconds
      : (typeof s.lastKnownPositionSeconds === 'number' && Number.isFinite(s.lastKnownPositionSeconds) ? s.lastKnownPositionSeconds : 0);
    const durVal = Number(t?.durationSeconds || 0);
    const posStr = durVal > 0 ? `${durationText(posVal)} / ${durationText(durVal)}` : durationText(posVal);
    const b = card('⏱ CUSTOM SEEK & SKIP STEP', cut(t?.title || 'Active Stream', 48));
    b.table([
      ['⏱ Position', posStr],
      ['⏩ Skip Button Step', `±${activeStep}s`]
    ], { striped: true, bordered: true, compact: true });
    b.paragraph(rt.italic('Jump backward/forward below, pick your preferred ±Ns step for the main player buttons, or tap ⌨️ Type Custom s / Time (e.g. +45, -20, 90s, 12:30, 1:05:00, or "step 45").'));
    b.buttons([
      controls(s, '⏪ -5m', 'seekby', -300),
      controls(s, '⏪ -1m', 'seekby', -60),
      controls(s, '⏪ -30s', 'seekby', -30),
      controls(s, '⏪ -10s', 'seekby', -10)
    ]);
    b.buttons([
      controls(s, '⏩ +10s', 'seekby', 10),
      controls(s, '⏩ +30s', 'seekby', 30),
      controls(s, '⏩ +1m', 'seekby', 60),
      controls(s, '⏩ +5m', 'seekby', 300)
    ]);
    b.buttons([10, 15, 30, 45].map((st) =>
      controls(s, `${activeStep === st ? '✓ ' : ''}±${st}s`, 'setseekstep', st, activeStep === st ? { style: 'success' } : { style: 'primary' })
    ));
    b.buttons([60, 90, 120, 300].map((st) =>
      controls(
        s,
        `${activeStep === st ? '✓ ' : ''}±${st >= 60 && st % 60 === 0 ? `${st / 60}m` : `${st}s`}`,
        'setseekstep',
        st,
        activeStep === st ? { style: 'success' } : null
      )
    ));
    b.buttons([
      controls(s, '⌨️ Type Custom s / Time', 'prompt', 'seek', { style: 'primary' }),
      controls(s, '◀ Back to Player', 'seekmenu', 'back')
    ]);
    return finish(b);
  }

  function renderCinemaDownloadQuality(s) {
    const target = s.dlqTarget || {
      action: 'downloadnow',
      title: s.currentTrack?.title || 'Movie / Episode',
      durationSeconds: s.currentTrack?.durationSeconds || 0,
      item: s.currentTrack
    };
    const track = target.item || s.currentTrack || {};
    const variants = Array.isArray(track.variants) ? track.variants : null;
    const dur = Number(target.durationSeconds || track.durationSeconds || 5400);
    const limitBytes = app.movieDownloader?.getLimitBytes?.() || uploadLimitBytes();
    const b = card('📦 CHOOSE DOWNLOAD QUALITY', cut(target.title || 'Movie / Episode', 48));
    const rows = ['360p', '480p', '720p'].map((q) => {
      const prof = DOWNLOAD_QUALITY_PROFILES[q];
      const variant = variants?.find((v) => Math.abs((v.height || 0) - prof.height) <= 80);
      const est = estimateDownloadSizeMb({ durationSeconds: dur, quality: q, variantBytes: variant?.sizeBytes || null, limitBytes });
      const cached = app.movieDownloader?.hasCachedVideo?.(track, q) ? '⚡ Instant' : est.text;
      return [prof.label, q === '360p' ? 'Low data saver' : q === '480p' ? 'Balanced crisp' : 'Full HD', cached];
    });
    b.table(rows, { striped: true, bordered: true, compact: true });
    b.paragraph(rt.italic('Choose 360p Saver to save data, 480p Balanced for sharp speed, or 720p HD for top clarity.'));
    const dlButtons = ['360p', '480p', '720p'].map((q) => {
      const prof = DOWNLOAD_QUALITY_PROFILES[q];
      const variant = variants?.find((v) => Math.abs((v.height || 0) - prof.height) <= 80);
      const est = estimateDownloadSizeMb({ durationSeconds: dur, quality: q, variantBytes: variant?.sizeBytes || null, limitBytes });
      const cached = app.movieDownloader?.hasCachedVideo?.(track, q);
      const icon = q === '360p' ? '📱' : q === '480p' ? '🎬' : '💎';
      return controls(s, `${icon} ${q} · ${cached ? '⚡' : est.text}`, 'dlq', q, q === '480p' ? { style: 'success' } : { style: 'primary' });
    });
    b.buttons(dlButtons);
    b.buttons([controls(s, '◀ Cancel', 'dlq', 'back')]);
    return finish(b);
  }

  function renderQueue(s, page = 0) {
    const total = Math.max(1, Math.ceil(s.upcoming.length / 5));
    page = Math.max(0, Math.min(Number(page) || 0, total - 1));
    const b = card('Lancy · queue', `Page ${page + 1} of ${total} · ${s.upcoming.length} upcoming`);
    if (s.currentTrack) b.quote(rt.text(`Now · ${cut(s.currentTrack.title)} · ${durationText(s.currentTrack.durationSeconds)}`));
    const entries = s.upcoming.slice(page * 5, page * 5 + 5);
    if (!entries.length) {
      b.paragraph(rt.text('Nothing queued. Add tracks with /addq, /vplay, or /movie.'));
    } else {
      b.table(
        entries.map((t, i) => [
          `#${page * 5 + i + 1}`,
          cut(t.title, 42),
          `${cut(t.artist || (t.provider === 'movie' ? 'Movie/TV' : 'Artist'), 24)} · ${durationText(t.durationSeconds)}`,
          t.provider === 'movie' ? '🎬 Movie' : t.mediaType === 'video' ? 'HD 720p' : 'Audio'
        ]),
        { striped: true, bordered: true, compact: true }
      );
      entries.forEach((t, i) => {
        b.buttons([
          controls(s, `▶ Play now ${page * 5 + i + 1}`, 'playnow', t.entryId, { style: 'success' }),
          controls(s, `Remove ${page * 5 + i + 1}`, 'remove', t.entryId, { style: 'danger' })
        ]);
      });
      b.paragraph(rt.italic('Tap ▶ Play now to play immediately — the current track stays saved at the end of Queue so your upcoming order continues next.'));
    }
    const row = [];
    if (page > 0) row.push(controls(s, '◀ Previous page', 'qpage', page - 1));
    if (page < total - 1) row.push(controls(s, 'Next page ▶', 'qpage', page + 1));
    if (row.length) b.buttons(row);
    if (total > 2) {
      const jumpRow = [];
      if (page > 1) jumpRow.push(controls(s, '⏮ Page 1', 'qpage', 0));
      if (page >= 10) jumpRow.push(controls(s, '◀◀ -10', 'qpage', Math.max(0, page - 10)));
      if (page + 10 < total) jumpRow.push(controls(s, '+10 ▶▶', 'qpage', Math.min(total - 1, page + 10)));
      if (page < total - 2) jumpRow.push(controls(s, `⏭ Page ${total}`, 'qpage', total - 1));
      if (jumpRow.length) b.buttons(jumpRow);
    }
    b.buttons([
      controls(s, 'Back to player', 'player'),
      ...(s.upcoming.length > 1 ? [controls(s, '🔀 Shuffle', 'shuffle')] : []),
      controls(s, 'Clear upcoming', 'clear', { style: 'danger' })
    ]);
    return finish(b);
  }

  function renderRadio(s) {
    const page = Math.max(0, Math.min(Math.ceil(RADIO_CATEGORIES.length / 8) - 1, s.radioPage || 0));
    const selected = s.radioSelected || [];
    const b = card('Lancy · Random / Infinite', `Choose up to five categories/custom searches · page ${page + 1}/${Math.ceil(RADIO_CATEGORIES.length / 8)}`);
    if (selected.length || s.radioCustom) {
      b.quote(rt.text([...selected.map(i => RADIO_CATEGORIES[i]), s.radioCustom].filter(Boolean).join(' + ')));
    }
    b.list(Array.from({ length: Math.min(8, RADIO_CATEGORIES.length - page * 8) }, (_, offset) => {
      const n = page * 8 + offset;
      const checked = selected.includes(n);
      return {
        has_checkbox: true,
        ...(checked ? { is_checked: true } : {}),
        blocks: [
          block.paragraph(rt.text(RADIO_CATEGORIES[n])),
          block.buttons([{ ...controls(s, checked ? 'Deselect' : 'Select', 'rpick', n), style: checked ? 'success' : 'primary' }])
        ]
      };
    }));
    b.paragraph(rt.italic('Use Select / Deselect to change a native checkbox. Selections stay selected across pages.'));
    const row = [];
    if (page) row.push(controls(s, 'Previous categories', 'rpage', page - 1));
    if ((page + 1) * 8 < RADIO_CATEGORIES.length) row.push(controls(s, 'More categories', 'rpage', page + 1));
    if (row.length) b.buttons(row);
    b.buttons([
      controls(s, '🔥 1-Tap Genres & Submenus', 'catmenu', defaultMediaMode(s)),
      s.panelToken ? controls(s, 'Custom artist / search', 'prompt', 'radio') : button('Custom artist / search', 'prompt', 'radio')
    ]);
    b.buttons([
      controls(s, '▶ Start infinite radio', 'rstart', { style: 'success' }),
      controls(s, '⏹ Turn autoplay off', 'roff', { style: 'danger' })
    ]);
    b.buttons([controls(s, 'Back to player', 'player')]);
    b.paragraph(rt.italic('Bounded rolling queue, no repeats within the recent window. Provider exhaustion or rate limits pause radio instead of looping requests.'));
    return finish(b);
  }

  function renderChannels(ctx, state) {
    const list = app.music.channels.list(ctx);
    state.items = list.slice();
    const pages = Math.max(1, Math.ceil(list.length / 5));
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    const b = card('Lancy · Channel Play', `${state.queueCardToken ? 'Choose where to queue your full recording' : 'Your verified saved channels'} · page ${state.page + 1}/${pages}`);
    if (!list.length) {
      b.quote(rt.text('No saved channels yet. Add Lancy as a channel administrator, then add its link/ID or forward an original channel post — or send /player directly inside the channel.'));
    }
    for (let i = state.page * 5; i < Math.min(list.length, state.page * 5 + 5); i++) {
      b.buttons([
        button(cut(list[i].title, 55), 'ch', state.id, state.revision, 'select', i, { style: 'success' }),
        button('Remove', 'ch', state.id, state.revision, 'delete', i, { style: 'danger' })
      ]);
    }
    const row = [];
    if (state.page) row.push(button('Previous', 'ch', state.id, state.revision, 'page', state.page - 1));
    if (state.page + 1 < pages) row.push(button('Next', 'ch', state.id, state.revision, 'page', state.page + 1));
    if (row.length) b.buttons(row);
    b.buttons([button('➕ Add channel', 'ch', state.id, state.revision, 'add', { style: 'success' })]);
    b.paragraph(rt.italic('Membership and administrator rights are checked again when you use a saved channel. Assistant setup only starts when you request playback/search.'));
    return finish(b);
  }

  async function channels(ctx, queueCardToken = null) {
    const state = app.music.channels.create(ctx);
    state.queueCardToken = queueCardToken;
    const rich = renderChannels(ctx, state);
    if (ctx.messageId && ctx.query) {
      await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
      state.messageId = ctx.messageId;
    } else {
      state.messageId = (await ctx.api.sendRichMessage(ctx.chatId, rich)).message_id;
    }
    return state;
  }

  function renderGenreSubmenu(genre, mode = 'queue', panelToken = null, isCustom = false) {
    const cleanGenre = resolveGenre(genre);
    const refArg = genreRefFor(cleanGenre, isCustom);
    const b = card(`Lancy · ${cut(cleanGenre, 50)}`, 'Infinite non-stop streaming or queueing');
    b.quote(rt.text(`🎵 ${cleanGenre}\nChoose whether to stream non-stop now or add to upcoming queue:`));
    if (panelToken) {
      b.buttons([
        button(`▶ Start Non-stop ${cut(cleanGenre, 12)}`, 'pc', panelToken, PANEL_ACTIONS.indexOf('infinact').toString(36), mode, 'start', refArg, { style: 'success' }),
        button(`➕ Queue ${cut(cleanGenre, 12)}`, 'pc', panelToken, PANEL_ACTIONS.indexOf('infinact').toString(36), mode, 'queue', refArg)
      ]);
      b.buttons([
        button('🔍 Browse Songs', 'pc', panelToken, PANEL_ACTIONS.indexOf('catpick').toString(36), mode, refArg),
        button('🎨 Custom Artist', 'pc', panelToken, PANEL_ACTIONS.indexOf('prompt').toString(36), 'radio')
      ]);
      b.buttons([
        button('« All Genres', 'pc', panelToken, PANEL_ACTIONS.indexOf('catmenu').toString(36), mode),
        button('Back to player', 'pc', panelToken, PANEL_ACTIONS.indexOf('player').toString(36))
      ]);
    } else {
      b.buttons([
        button(`▶ Start Non-stop ${cut(cleanGenre, 12)}`, 'infinact', mode, 'start', refArg, { style: 'success' }),
        button(`➕ Queue ${cut(cleanGenre, 12)}`, 'infinact', mode, 'queue', refArg)
      ]);
      b.buttons([
        button('🔍 Browse Songs', 'catpick', mode, refArg),
        button('🎨 Custom Artist', 'prompt', 'radio')
      ]);
      b.buttons([
        button('« All Genres', 'catmenu', mode),
        button('Back to player', 'openplayer')
      ]);
    }
    b.paragraph(rt.italic('▶ Start Non-stop plays immediately with continuous refill. ➕ Queue adds tracks behind your current song.'));
    return finish(b);
  }

  function renderCategoryPicker(mode = 'queue', panelToken = null, page = 0) {
    const totalPages = 1 + Math.ceil(RADIO_CATEGORIES.length / 10);
    const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
    const b = card(
      'Lancy · Categories & Non-stop',
      mode === 'video' ? `🎬 Real Music Videos · Trending → Old · page ${safePage + 1}/${totalPages}` : `Tap any genre for trending → classic hits · page ${safePage + 1}/${totalPages}`
    );
    b.quote(rt.text(safePage === 0
      ? '🔥 Fast 1-Tap Genres — tap to start non-stop, queue, or search:'
      : `🎛 Catalog Genres (${(safePage - 1) * 10 + 1}–${Math.min(RADIO_CATEGORIES.length, safePage * 10)} of ${RADIO_CATEGORIES.length}):`));
    const list = safePage === 0
      ? QUICK_GENRES
      : RADIO_CATEGORIES.slice((safePage - 1) * 10, safePage * 10);

    for (let i = 0; i < list.length; i += 2) {
      const g1 = list[i];
      const g2 = list[i + 1];
      const ref1 = safePage === 0 ? `q${i}` : String((safePage - 1) * 10 + i);
      const ref2 = g2 ? (safePage === 0 ? `q${i + 1}` : String((safePage - 1) * 10 + i + 1)) : null;
      const row = [];
      if (panelToken) {
        row.push(button(g1, 'pc', panelToken, PANEL_ACTIONS.indexOf('genresub').toString(36), mode, ref1));
        if (g2) row.push(button(g2, 'pc', panelToken, PANEL_ACTIONS.indexOf('genresub').toString(36), mode, ref2));
      } else {
        row.push(button(g1, 'genresub', mode, ref1));
        if (g2) row.push(button(g2, 'genresub', mode, ref2));
      }
      b.buttons(row);
    }

    const navRow = [];
    if (safePage > 0) {
      navRow.push(panelToken
        ? button('◀ Previous', 'pc', panelToken, PANEL_ACTIONS.indexOf('catmenu').toString(36), mode, String(safePage - 1))
        : button('◀ Previous', 'catmenu', mode, String(safePage - 1)));
    }
    if (safePage + 1 < totalPages) {
      navRow.push(panelToken
        ? button(`More Genres (${safePage + 1}/${totalPages}) ▶`, 'pc', panelToken, PANEL_ACTIONS.indexOf('catmenu').toString(36), mode, String(safePage + 1))
        : button(`More Genres (${safePage + 1}/${totalPages}) ▶`, 'catmenu', mode, String(safePage + 1)));
    }
    if (navRow.length) b.buttons(navRow);
    b.buttons([
      panelToken ? button('🎨 Custom Artist / Genre', 'pc', panelToken, PANEL_ACTIONS.indexOf('prompt').toString(36), 'radio') : button('🎨 Custom Artist / Genre', 'prompt', 'radio'),
      panelToken ? button('🔍 Search Specific Title', 'pc', panelToken, PANEL_ACTIONS.indexOf('prompt').toString(36), mode) : button('🔍 Search Specific Title', 'prompt', mode)
    ]);
    const altMode = mode === 'video' ? 'queue' : 'video';
    const modeToggleLabel = mode === 'video' ? '🔊 Switch to Audio Mode' : '🎬 Switch to Real Video';
    b.buttons([
      panelToken ? button(modeToggleLabel, 'pc', panelToken, PANEL_ACTIONS.indexOf('catmenu').toString(36), altMode, String(safePage)) : button(modeToggleLabel, 'catmenu', altMode, String(safePage)),
      panelToken ? button('Back to player', 'pc', panelToken, PANEL_ACTIONS.indexOf('player').toString(36)) : button('Back to player', 'openplayer')
    ]);
    b.paragraph(rt.italic('Categories play trending & popular hits first, then progress into older classics without repeats.'));
    return finish(b);
  }

  function renderVolumePicker(s) {
    const curVol = Number(s.volume ?? 100);
    const b = card('Lancy · volume', `${curVol}% · unity gain is 100%; boost up to 200%`);
    b.buttons([50, 80, 100].map(v => controls(s, `${v}%`, 'setvol', v, { style: v === curVol ? 'success' : 'primary' })));
    b.buttons([125, 150, 200].map(v => controls(s, `${v}%`, 'setvol', v, { style: v === curVol ? 'success' : 'primary' })));
    b.buttons([controls(s, 'Back to player', 'player')]);
    return finish(b);
  }

  function renderSearch(s) {
    const p = s.pages[s.index];
    const b = card(
      s.mode === 'lyrics' ? 'Lancy · lyrics' : s.mode === 'download' ? 'Lancy · download' : 'Lancy · select your tracks',
      `${cut(s.query, 90)} · page ${s.index + 1}${['download', 'lyrics'].includes(s.mode) ? '' : ` · ${cut(s.destinationTitle || s.destination, 55)}`}`
    );
    if (s.processing) {
      b.quote(rt.text(s.mode === 'download' ? 'Preparing your full recording…' : s.mode === 'lyrics' ? 'Finding matched lyrics…' : 'Preparing your selected tracks…'));
      b.paragraph(rt.text('Checking access and resolving media. This can take a little while. There is no need to press again.'));
      if (['queue', 'video'].includes(s.mode)) b.paragraph(rt.italic('Use /stop to cancel pending playback.'));
      return finish(b);
    }
    if (!p.items.length) b.paragraph(rt.text('No new results. Go back or search a different title and artist.'));
    const isVcMode = ['queue', 'video'].includes(s.mode);
    const activeDestSession = isVcMode && s.destination && app?.musicQueueManager?.getSession ? app.musicQueueManager.getSession(s.destination) : null;
    const vcActiveNow = Boolean(activeDestSession?.currentTrack && ['playing', 'paused', 'buffering'].includes(activeDestSession?.status));
    if (isVcMode && (vcActiveNow || s.selected.size > 0)) {
      const radioLabel = activeDestSession?.radio?.enabled && activeDestSession?.radio?.seeds?.length
        ? ` (${cut(activeDestSession.radio.seeds[0]?.title || activeDestSession.radio.seeds[0] || 'Genre Mix', 30)})`
        : '';
      const statusPrefix = vcActiveNow
        ? `🎧 Now Playing: ${cut(activeDestSession.currentTrack.title, 45)}${radioLabel}\n`
        : '';
      b.quote(rt.text(`${statusPrefix}⚡ Play Now plays your choice immediately and resumes the current song/genre mix right after. Add selected queues behind current tracks.`));
    }
    p.items.forEach((t, i) => {
      const selected = s.selected.has(t.id);
      b.list([{
        has_checkbox: true,
        ...(selected ? { is_checked: true } : {}),
        blocks: [
          block.paragraph(rt.bold(cut(t.title, 100))),
          block.paragraph(rt.text(`${cut(t.artist || 'Artist not supplied', 65)} · ${durationText(t.durationSeconds)}`))
        ]
      }]);
      const itemButtons = [{ ...button(selected ? 'Deselect' : 'Select', 'pick', s.id, s.revision, i), style: selected ? 'success' : 'primary' }];
      if (isVcMode) {
        itemButtons.push(button('⚡ Play Now', 'qnow', s.id, s.revision, i, { style: 'success' }));
      }
      b.buttons(itemButtons);
    });
    const row = [];
    if (s.index > 0) row.push(button('Previous', 'spage', s.id, s.revision, s.index - 1));
    if (p.nextOffset != null) row.push(button('Next', 'spage', s.id, s.revision, s.index + 1));
    if (row.length) b.buttons(row);
    if (isVcMode) {
      b.buttons([
        button(`⚡ Play Now · ${s.selected.size}`, 'playnow_s', s.id, s.revision, { style: 'success' }),
        button(`Add selected · ${s.selected.size}`, 'submit', s.id, s.revision, { style: 'primary' }),
        button('Clear', 'sclear', s.id, s.revision, { style: 'danger' })
      ]);
    } else {
      b.buttons([
        button(s.mode === 'lyrics' ? 'Show matched lyrics' : `Download selected · ${s.selected.size}`, 'submit', s.id, s.revision, { style: 'success' }),
        button('Clear', 'sclear', s.id, s.revision, { style: 'danger' })
      ]);
    }
    b.paragraph(rt.italic('Use Select / Deselect to change a native checkbox, or tap ⚡ Play Now to play immediately. Selected tracks stay selected across pages.'));
    return finish(b);
  }

  function renderAccounts(s) {
    const b = card('Lancy · player accounts', 'Owner-approved aliases for this destination');
    for (const a of s.availableAccounts || []) {
      b.paragraph(rt.text(`${a.alias} · ${a.status}`));
      if (a.status === 'available') b.buttons([controls(s, `Use ${a.alias}`, 'selectaccount', a.alias, { style: 'success' })]);
    }
    if (!s.availableAccounts?.length) b.paragraph(rt.text('No accounts approved for this destination.'));
    b.buttons([controls(s, 'Back to player', 'player')]);
    return finish(b);
  }

  function renderLyrics(s) {
    const l = s.lyrics;
    const b = card('Lancy · lyrics', l?.found ? `${cut(l.title)} · ${cut(l.artist, 40)}` : 'Match unavailable');
    if (!l?.found) {
      b.paragraph(rt.text(l?.reason || 'Choose a track first.'));
    } else if (l.instrumental) {
      b.paragraph(rt.text('This recording is marked instrumental.'));
    } else {
      const full = process.env.MUSIC_LYRICS_FULL_TEXT !== 'false';
      const text = full ? l.text : cut(l.text, 200);
      const pages = text.match(/[\s\S]{1,1800}/g) || [''];
      const p = Math.min(s.lyricsPage || 0, pages.length - 1);
      b.quote(rt.text(pages[p]));
      if (!full) b.paragraph(rt.italic('Excerpt · full display is disabled unless the operator has appropriate display rights.'));
      const row = [];
      if (p > 0) row.push(controls(s, 'Previous', 'lypage', p - 1));
      if (p < pages.length - 1) row.push(controls(s, 'Next', 'lypage', p + 1));
      if (row.length) b.buttons(row);
    }
    b.buttons([controls(s, 'Back to player', 'player')]);
    return finish(b);
  }

  function renderStandaloneLyrics(track, result) {
    const b = card('Lancy · matched lyrics', `${cut(track.title, 100)} · ${cut(track.artist || 'Artist not supplied', 70)}`);
    if (!result?.found) {
      b.paragraph(rt.text(result?.reason || 'No reliable lyrics match.'));
    } else if (result.instrumental) {
      b.paragraph(rt.text('This recording is marked instrumental.'));
    } else {
      b.quote(rt.text(cut(result.text, 200)));
      b.paragraph(rt.italic('Synced lyrics excerpt. Full matched lyrics are available in the player only when appropriate display rights are configured.'));
    }
    b.buttons([button('Search another recording', 'prompt', 'lyrics')]);
    return finish(b);
  }

  function renderSessionSetupNotice() {
    const b = card('ASSISTANT ACCOUNT SETUP REQUIRED', 'Owner-managed user sessions');
    b.paragraph(rt.text('A bot token alone is not a playback account. The main owner should run the local terminal session generator, register its alias with /accounts, and approve this destination. Never send login codes or session strings to the bot.'));
    b.buttons([button('Account status', 'refresh_status')]);
    return finish(b);
  }

  function renderAssistantSessionStatus(health) {
    const b = card('STREAMING ENGINE STATUS', health?.ready ? 'Account pool ready' : 'Voice engine not ready');
    b.table([
      ['Mode', health?.mode === 'bot_token' ? 'Bot Direct (unsupported for playback)' : health?.mode === 'assistant_user' ? 'Assistant Userbot (legacy)' : health?.mode || 'offline'],
      ['Active calls', String(health?.active_calls_count || 0)]
    ], { striped: true, bordered: true, compact: true });
    b.paragraph(rt.text('Owner setup: /accounts list. Registration is local-terminal only.'));
    return finish(b);
  }

  async function error(ctx, e) {
    if (e?.silent || (['ADMIN_ONLY', 'PERMISSION_DENIED', 'UNAUTHORIZED_VC'].includes(e?.code) && Number(ctx?.chatId) < 0 && !isChannelCtx(ctx) && app.music?.isVcSudoEnforced?.(Number(ctx.chatId)))) {
      if (ctx?.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id).catch(() => {});
      }
      return null;
    }
    if (e.code === 'REQUEST_PROCESSING') {
      if (ctx.query?.id && ctx.api.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: e.message }).catch(() => {});
      }
      return;
    }
    const msg = e instanceof MusicError ? e.message : (e?.message || 'The music operation could not finish. Check account health or try again later.');
    const isChan = isChannelCtx(ctx);
    let answeredAlert = false;
    if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
      answeredAlert = await ctx.api.answerCallbackQuery(ctx.query.id, {
        text: cut(msg, 195),
        show_alert: isChan || msg.length > 55
      }).then(() => true).catch(() => false);
    }
    if (answeredAlert && ctx.query && !ctx._processingReplacedCard) {
      return null;
    }
    const noticeRich = ctx.api?.sendRichMessage ? buildNoticeCard(msg) : null;
    if (ctx._processingReplacedCard && ctx.messageId && ctx.api?.editMessageRich && noticeRich) {
      try {
        const edited = await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, noticeRich);
        const key = chatSlotKey(ctx);
        const prevMenu = menuMsgByChat.get(key);
        if (prevMenu && prevMenu.messageId === ctx.messageId) menuMsgByChat.delete(key);
        const prevNotice = noticeMsgByChat.get(key);
        if (prevNotice && prevNotice.messageId !== ctx.messageId) await clearChatSlot(noticeMsgByChat, ctx);
        const token = prevMenu?.messageId === ctx.messageId
          ? prevMenu.token
          : (prevNotice?.messageId === ctx.messageId ? prevNotice.token : temporary.remember(ctx, edited?.message_id ? edited : { message_id: ctx.messageId }, { ttlMs: 300000 }));
        temporary.expire(token, 300000);
        noticeMsgByChat.set(key, { messageId: ctx.messageId, token, api: ctx.api });
        return edited || { message_id: ctx.messageId };
      } catch {}
    }
    const sendNotice = async () => {
      if (noticeRich && ctx.api?.sendRichMessage) {
        try { return await ctx.api.sendRichMessage(ctx.chatId, noticeRich); } catch {}
      }
      return ctx.api.sendMessage(ctx.chatId, msg);
    };
    const editNotice = async msgId => {
      if (noticeRich && ctx.api?.editMessageRich) {
        try { return await ctx.api.editMessageRich(ctx.chatId, msgId, noticeRich); } catch {}
      }
      if (ctx.api?.editMessageText) {
        return ctx.api.editMessageText(ctx.chatId, msgId, msg);
      }
      throw new Error('NO_EDIT');
    };
    if (isChan) {
      return upsertChatSlot(noticeMsgByChat, ctx, sendNotice, editNotice, 300000);
    }
    let sent;
    try { sent = await sendNotice(); } catch { sent = await ctx.api.sendMessage(ctx.chatId, msg); }
    temporary.remember(ctx, sent, { ttlMs: 300000 });
    return sent;
  }

  const movieUi = createMovieUi({
    app,
    finish,
    card,
    isChannelCtx,
    reusableChannelSlotId,
    sendOrEditMenu,
    adoptChannelPlayerResult,
    clearChatSlot,
    temporary,
    menuMsgByChat,
    noticeMsgByChat,
    chatSlotKey,
    error
  });

  async function search(ctx, query, mode = 'queue') {
    if (!query) return prompt(ctx, mode);
    const isChan = isChannelCtx(ctx);
    let activePlayerId = ctx.musicPanel?.screenMessageId || null;
    try {
      const dest = app.music?.destination?.(ctx);
      if (dest && app.musicQueueManager?.getSession) {
        activePlayerId = activePlayerId || app.musicQueueManager.getSession(dest)?.screenMessageId || null;
      }
    } catch {}
    const reuseId = (ctx.query && ctx.messageId && ctx.messageId !== activePlayerId)
      ? ctx.messageId
      : (isChan && !ctx.query ? reusableChannelSlotId(ctx) : null);

    let pending = null;
    let temporaryToken = null;
    const key = chatSlotKey(ctx);
    if (reuseId) {
      let editedOk = false;
      const preferRichFirst = Boolean(ctx.api?.editMessageRich && (ctx.query || menuMsgByChat.get(key)?.messageId === reuseId));
      const editTextStatus = () => ctx.api?.editMessageText
        ? ctx.api.editMessageText(ctx.chatId, reuseId, '🔎 Finding your tracks…').then(() => true).catch(() => false)
        : Promise.resolve(false);
      const editRichStatus = () => {
        if (!ctx.api?.editMessageRich) return Promise.resolve(false);
        const pendingCard = card('Lancy · Searching', cut(query, 40)).paragraph(rt.text('🔎 Finding your tracks…')).toJSON();
        return ctx.api.editMessageRich(ctx.chatId, reuseId, pendingCard).then(() => true).catch(() => false);
      };
      editedOk = preferRichFirst ? await editRichStatus() : await editTextStatus();
      if (!editedOk) {
        editedOk = preferRichFirst ? await editTextStatus() : await editRichStatus();
      }
      if (editedOk) {
        pending = { message_id: reuseId };
        const existingSlot = menuMsgByChat.get(key)?.messageId === reuseId
          ? menuMsgByChat.get(key)
          : (noticeMsgByChat.get(key)?.messageId === reuseId ? noticeMsgByChat.get(key) : null);
        temporaryToken = existingSlot?.token || temporary.remember(ctx, pending, { ttlMs: 300000 });
        temporary.expire(temporaryToken, 300000);
      }
    }
    if (!pending) {
      pending = await ctx.api.sendMessage(ctx.chatId, '🔎 Finding your tracks…');
      temporaryToken = temporary.remember(ctx, pending, { ttlMs: 300000 });
    }
    try {
      const s = await app.music.startSearch(ctx, query, mode);
      s.messageId = pending.message_id;
      s.temporaryToken = temporaryToken;
      await ctx.api.editMessageRich(ctx.chatId, s.messageId, renderSearch(s));
      if (isChan) {
        const prevNotice = noticeMsgByChat.get(key);
        if (prevNotice?.messageId === pending.message_id) noticeMsgByChat.delete(key);
        else if (prevNotice) await clearChatSlot(noticeMsgByChat, ctx);
        const prevMenu = menuMsgByChat.get(key);
        if (prevMenu && prevMenu.messageId !== pending.message_id) await clearChatSlot(menuMsgByChat, ctx);
        menuMsgByChat.set(key, { messageId: pending.message_id, token: temporaryToken, api: ctx.api });
      }
      return s;
    } catch (e) {
      const errMsg = e instanceof MusicError ? e.message : 'Search failed. Try a different title and artist.';
      if (isChan) {
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: cut(errMsg, 195), show_alert: true }).catch(() => {});
        }
        const editedErr = ctx.api?.editMessageRich
          ? await ctx.api.editMessageRich(ctx.chatId, pending.message_id, buildNoticeCard(errMsg)).then(() => true).catch(() => false)
          : false;
        if (!editedErr && ctx.api?.editMessageText) {
          await ctx.api.editMessageText(ctx.chatId, pending.message_id, errMsg).catch(() => {});
        }
        const prevMenu = menuMsgByChat.get(key);
        if (prevMenu?.messageId === pending.message_id) menuMsgByChat.delete(key);
        const prevNotice = noticeMsgByChat.get(key);
        if (prevNotice && prevNotice.messageId !== pending.message_id) await clearChatSlot(noticeMsgByChat, ctx);
        temporary.expire(temporaryToken, 300000);
        noticeMsgByChat.set(key, { messageId: pending.message_id, token: temporaryToken, api: ctx.api });
      } else {
        await ctx.api.editMessageText(ctx.chatId, pending.message_id, errMsg);
        temporary.keep(temporaryToken);
        temporary.remember(ctx, pending, { ttlMs: 60000 });
      }
    }
  }

  async function prompt(ctx, mode) {
    if (['queue', 'video'].includes(mode)) {
      app.music.destination?.(ctx);
      await app.music.authorize?.(ctx, true);
    }
    if (mode === 'radio') await app.music.authorize(ctx, true);
    if (mode === 'dj' || mode === 'seek') await app.music.authorize?.(ctx, true, null, { allowDj: true });

    const group = Number(ctx.chatId) < 0;
    const isChan = isChannelCtx(ctx);
    const stateKey = (isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId;
    if (app.sm.state(stateKey) === States.MUSIC_QUEUE_INPUT) await app.sm.reset(stateKey);
    if (stateKey !== ctx.tgId && app.sm.state(ctx.tgId) === States.MUSIC_QUEUE_INPUT) await app.sm.reset(ctx.tgId);

    if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
      await ctx.api.answerCallbackQuery(ctx.query.id, {
        text: mode === 'dj'
          ? '🎙️ Ask the AI DJ anything.'
          : mode === 'seek'
            ? '⏱ Send custom seconds (+45, -20, 90), timestamp (12:30), or "step 45"'
            : 'Send your request in chat.'
      }).catch(() => {});
    }
    const userNum = Number(ctx.tgId);
    const canMentionUser = group && !isChan && Number.isSafeInteger(userNum) && userNum > 0;
    const name = cut(ctx.user?.first_name || 'Music request', 40);

    const text = mode === 'channel'
      ? 'Send a channel link, @name or negative ID, or forward an original channel post. Lancy and you must be channel administrators. /cancel closes setup.'
      : mode === 'radio'
        ? 'Send an artist name or style (e.g. Burna Boy, Drake, Wizkid, Trap sad songs) to stream or queue infinite non-stop music. /cancel closes this input.'
        : mode === 'dj'
          ? `${canMentionUser ? `${name}, ` : ''}Spotify AI DJ Booth — tell me what to play ("trending afrobeats", "something chill"), ask "what's trending?", or say "more bass"${group && !isChan ? ' as a reply to this message' : ' in this chat'}. /cancel closes.`
          : mode === 'seek'
            ? `${canMentionUser ? `${name}, ` : ''}send custom seek seconds or timestamp (e.g. +45, -20, 90s, 12:30, 1:05:00) or "step 45" to customize the ±Ns skip button${group && !isChan ? ' as a reply to this message' : ''}. /cancel closes.`
            : mode === 'movie_search'
              ? `${canMentionUser ? `${name}, ` : ''}send a movie or TV series title (e.g. Inception, The Mentalist, Dune)${group && !isChan ? ' as a reply to this message' : ''}. /cancel closes this search.`
              : `${canMentionUser ? `${name}, ` : ''}send a track title and artist${group && !isChan ? ' as a reply to this message' : ''}. /cancel closes this search.`;

    let sent;
    let temporaryToken;
    let targetSlot = null;
    if (isChan) {
      let activePlayerId = ctx.musicPanel?.screenMessageId || null;
      try {
        const dest = app.music?.destination?.(ctx);
        if (dest && app.musicQueueManager?.getSession) {
          activePlayerId = activePlayerId || app.musicQueueManager.getSession(dest)?.screenMessageId || null;
        }
      } catch {}
      const key = chatSlotKey(ctx);
      targetSlot = activePlayerId ? noticeMsgByChat : menuMsgByChat;
      if (!activePlayerId && !menuMsgByChat.has(key) && noticeMsgByChat.has(key)) {
        const oldNotice = noticeMsgByChat.get(key);
        noticeMsgByChat.delete(key);
        menuMsgByChat.set(key, oldNotice);
      }
      const promptRich = ctx.api?.sendRichMessage
        ? finish(
          card(
            mode === 'dj' ? 'Spotify ✕ DJ' : mode === 'radio' ? 'Lancy · Artist Radio' : 'Lancy · Search Music',
            mode === 'dj' ? 'Interactive DJ Booth' : mode === 'radio' ? 'Custom Artist or Style' : 'Type song title & artist in channel'
          )
            .paragraph(rt.text(text))
            .buttons([button('✕ Cancel', 'cancelprompt', { style: 'danger' })])
        )
        : null;
      const sendPromptFn = async () => {
        if (ctx.query && ctx.messageId && ctx.messageId !== activePlayerId) {
          try {
            if (promptRich && ctx.api?.editMessageRich) {
              const ed = await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, promptRich);
              return ed || { message_id: ctx.messageId };
            }
            if (ctx.api?.editMessageText) {
              const ed = await ctx.api.editMessageText(ctx.chatId, ctx.messageId, text);
              return ed || { message_id: ctx.messageId };
            }
          } catch {}
        }
        return promptRich ? ctx.api.sendRichMessage(ctx.chatId, promptRich) : ctx.api.sendMessage(ctx.chatId, text);
      };
      const editPromptFn = async msgId => {
        if (promptRich && ctx.api?.editMessageRich) return ctx.api.editMessageRich(ctx.chatId, msgId, promptRich);
        if (ctx.api?.editMessageText) return ctx.api.editMessageText(ctx.chatId, msgId, text);
        throw new Error('NO_EDIT');
      };
      sent = await upsertChatSlot(targetSlot, ctx, sendPromptFn, editPromptFn, 120000);
      temporaryToken = targetSlot.get(key)?.token || temporary.remember(ctx, sent, { ttlMs: 120000 });
    } else {
      sent = await ctx.api.sendMessage(ctx.chatId, text, {
        reply_markup: { force_reply: true, selective: true },
        ...(canMentionUser ? { entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: userNum, is_bot: false, first_name: name } }] } : {}),
        ...(ctx.message?.from?.id === userNum ? { reply_to_message_id: ctx.message.message_id } : {})
      });
      temporaryToken = temporary.remember(ctx, sent, { ttlMs: 120000 });
    }
    try {
      await app.sm.transition(stateKey, States.MUSIC_QUEUE_INPUT, {
        chatId: ctx.chatId,
        timeoutMs: 120000,
        context: {
          stateKey,
          mode,
          botKey: app.music.botKey(ctx),
          promptMessageId: sent.message_id,
          temporaryToken,
          panelToken: ctx.musicPanel?.panelToken || null,
          isChannelPrompt: isChan
        }
      });
    } catch (e) {
      if (isChan && targetSlot) await clearChatSlot(targetSlot, ctx);
      else await temporary.remove(temporaryToken);
      throw e;
    }
    return sent;
  }

  async function showAccounts(ctx) {
    const id = await app.music.authorize(ctx, false);
    await app.music.accounts.sync();
    const pool = await app.voiceClient.accounts(id);
    const s = app.musicQueueManager.getSession(id);
    const b = card('Lancy · player accounts', 'Only owner-approved aliases for this destination');
    for (const a of pool.accounts) {
      b.paragraph(rt.text(`${a.alias} · ${a.status}`));
      if (a.status === 'available') b.buttons([controls(s, `Use ${a.alias}`, 'selectaccount', a.alias, { style: 'success' })]);
    }
    if (!pool.accounts.length) b.paragraph(rt.text('No accounts approved. Ask the owner to use /accounts allow.'));
    b.buttons([controls(s, 'Back to player', 'player')]);
    await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, finish(b));
  }

  async function handleInfiniteAction(ctx, args, panelToken = null) {
    const [mode = 'queue', op = 'start', genreRef = 'q0'] = args;
    const panel = panelToken ? await app.music.channelPanels.resolve(ctx, panelToken, { requireMessage: false }) : ctx.musicPanel;
    if (panelToken && ctx.messageId) app.music.channelPanels?.registerMessage?.(panelToken, ctx.messageId);
    const targetCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
    const destination = app.music.destination(targetCtx);
    const s = panel || app.musicQueueManager.getSession(destination);
    const genre = resolveGenre(genreRef, s);
    const isVideo = mode === 'video';
    const procMsg = card(`Lancy · ${cut(genre, 40)}`, op === 'start' ? 'Starting non-stop playback…' : 'Adding to queue…');
    procMsg.quote(rt.text(op === 'start'
      ? `⏳ Starting non-stop ${genre} streaming…\nConnecting assistant to voice chat and resolving tracks…`
      : `⏳ Adding ${genre} tracks to upcoming queue…\nResolving media streams…`));
    procMsg.buttons([button('⏳ Processing…', 'noop')]);
    if (ctx.messageId) await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, finish(procMsg)).catch(() => {});
    s.lastRender = null;
    if (panel) panel.lastRender = null;
    s.lastNotice = op === 'start' ? `⏳ Starting non-stop ${genre} streaming…` : `⏳ Adding ${genre} to queue…`;
    if (s.screenMessageId && !panelToken) void app.musicQueueManager.updatePlayerCard(destination).catch(() => {});

    const isChan = isChannelCtx(ctx);
    const qmSession = app.musicQueueManager?.getSession?.(destination);
    const activePlayerId = panelToken ? s.screenMessageId : qmSession?.screenMessageId;

    try {
      if (op === 'start') {
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `♾️ Streaming non-stop ${cut(genre, 25)}…` }).catch(() => {});
        }
        const generation = app.music.queueGeneration(destination);
        await app.music.authorize(targetCtx, true, destination, { allowDj: true });
        if (typeof app.voiceClient?.setup === 'function') await app.music.prepare(targetCtx, destination);
        app.music.assertQueueGeneration(destination, generation);
        if (isVideo) qmSession.radioVideo = true;
        app.music.radio.configure(qmSession, [genre], { video: isVideo });
        await app.music.radio.refill(qmSession);
        await app.musicQueueManager.ensurePlaying(destination);
        s.view = 'player';
        s.overlayView = null;
        s.overlayAt = 0;
        s.lastRender = null;
        if (panel) { panel.view = 'player'; panel.overlayView = null; panel.overlayAt = 0; panel.lastRender = null; }
        if (qmSession) { qmSession.overlayView = null; qmSession.overlayAt = 0; }
        if (panelToken) await app.music.channelPanels.update(destination, { panelToken });
        else if (!s.screenMessageId && Number(ctx.chatId) < 0) {
          const pCtx = (isChan && ctx.messageId) ? { ...targetCtx, reuseMessageId: ctx.messageId } : targetCtx;
          const playerState = await app.music.player(pCtx, destination);
          if (isChan) await adoptChannelPlayerResult(ctx, playerState);
        } else {
          await app.musicQueueManager.updatePlayerCard(destination);
          if (ctx.messageId && ctx.messageId !== s.screenMessageId) {
            if (isChan) {
              await clearChatSlot(menuMsgByChat, ctx);
              await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
            } else {
              const doneCard = renderPlayer(s);
              await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, doneCard).catch(() => {});
            }
          }
        }
      } else if (op === 'queue') {
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `➕ Queued ${cut(genre, 25)} tracks!` }).catch(() => {});
        }
        const generation = app.music.queueGeneration(destination);
        await app.music.authorize(targetCtx, true, destination, { allowDj: true });
        if (typeof app.voiceClient?.setup === 'function') await app.music.prepare(targetCtx, destination);
        app.music.assertQueueGeneration(destination, generation);
        if (isVideo) qmSession.radioVideo = true;
        app.music.radio.configure(qmSession, [genre], { video: isVideo });
        let searchRes = null;
        try { searchRes = await app.musicProviders.search(genre, { limit: 3, video: isVideo }); } catch { searchRes = null; }
        const tracks = (searchRes?.items || []).slice(0, 3).map(t => ({ ...t, mediaType: isVideo ? 'video' : 'audio', requester: ctx.user?.username || ctx.user?.first_name || 'Member' }));
        if (tracks.length) {
          await app.musicQueueManager.addMany(destination, tracks);
        } else {
          await app.music.radio.refill(qmSession);
        }
        if (!['playing', 'paused', 'buffering'].includes(s.status)) {
          await app.musicQueueManager.ensurePlaying(destination);
        }
        s.view = 'player';
        s.overlayView = null;
        s.overlayAt = 0;
        s.lastRender = null;
        s.lastNotice = `✅ Added ${tracks.length || 'new'} ${genre} tracks to queue.`;
        if (panel) { panel.view = 'player'; panel.overlayView = null; panel.overlayAt = 0; panel.lastRender = null; }
        if (qmSession) { qmSession.overlayView = null; qmSession.overlayAt = 0; }
        if (panelToken) await app.music.channelPanels.update(destination, { panelToken });
        else if (!s.screenMessageId && Number(ctx.chatId) < 0) {
          const pCtx = (isChan && ctx.messageId) ? { ...targetCtx, reuseMessageId: ctx.messageId } : targetCtx;
          const playerState = await app.music.player(pCtx, destination);
          if (isChan) await adoptChannelPlayerResult(ctx, playerState);
        } else {
          await app.musicQueueManager.updatePlayerCard(destination);
          if (ctx.messageId && ctx.messageId !== s.screenMessageId) {
            if (isChan) {
              await clearChatSlot(menuMsgByChat, ctx);
              await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
            } else {
              const doneMsg = card(`Lancy · ${cut(genre, 40)}`, 'Added to upcoming queue');
              doneMsg.quote(rt.text(`✅ Added ${tracks.length || 'new'} ${genre} tracks to the queue!\nUse /q or /player to view upcoming songs.`));
              doneMsg.buttons([button('Open player', 'openplayer', { style: 'success' }), button('« All Genres', 'catmenu', mode)]);
              await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, finish(doneMsg)).catch(() => {});
            }
          }
        }
      }
      if (isChan) await clearChatSlot(noticeMsgByChat, ctx, qmSession?.screenMessageId || null).catch(() => {});
    } catch (e) {
      if (ctx.messageId && ctx.messageId !== activePlayerId) {
        await error({ ...ctx, _processingReplacedCard: true }, e);
        return;
      }
      throw e;
    }
  }

  async function handle(ctx, action, args = []) {
    try {
      if (isChannelCtx(ctx) && Number(ctx.chatId) < 0 && !ctx.channelAdminVerified) {
        await app.music.authorize(ctx, true, Number(ctx.chatId), { allowDj: false });
        ctx = { ...ctx, channelAdminVerified: true };
      }
      if (action === 'mcast') {
        const sub = String(args[0] || '').toLowerCase();
        const isGroupScope = sub === 'gon' || sub === 'goff';
        const enable = sub === 'on' || sub === 'gon';
        const res = await app.music.setMovieBroadcast(ctx, { scope: isGroupScope ? 'group' : 'global', enable, chatId: ctx.chatId });
        const notice = isGroupScope
          ? (enable ? '👥 Movie broadcasts are now ALLOWED for this group.' : '🔕 Movie broadcasts are now DISABLED for this group.')
          : (enable ? '✅ Movie broadcasts to all users are now ALLOWED.' : '🔕 Movie broadcasts to all users are now DISALLOWED.');
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: cut(notice, 90), show_alert: false }).catch(() => {});
        }
        if (ctx.messageId) {
          const canGlobal = Boolean(app.music.owner(ctx) || app.music.superAdmin(ctx));
          const updated = renderMovieBroadcastCard(res, { notice, chatId: ctx.chatId, canGlobal });
          if (ctx.api?.editMessageRich) {
            await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, updated).catch(() => {});
          }
        }
        return true;
      }
      if (action === 'calert') {
        const enable = args[0] === 'on';
        app.db?.setUserSetting?.(Number(ctx.tgId), 'cinema.vcNotifications', enable);
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, {
            text: enable ? '🔔 Cinema VC alerts enabled!' : '🔕 Cinema VC alerts muted.',
            show_alert: false
          }).catch(() => {});
        }
        if (ctx.messageId && ctx.api?.editMessageRich) {
          const prefCard = card(
            enable ? '🔔 CINEMA ALERTS ENABLED' : '🔕 CINEMA ALERTS MUTED',
            enable ? 'You will receive DM alerts when Cinema VCs start' : 'You will no longer receive Cinema VC DM alerts'
          );
          prefCard.paragraph(rt.text(
            enable
              ? 'We will notify you whenever a Cinema Watch Party starts or switches movies in a group chat.'
              : 'Cinema Watch Party DM notifications are turned off for your account. Tap below anytime to re-enable them.'
          ));
          prefCard.buttons([
            enable
              ? richButton.callback('🔕 Mute Cinema Alerts', encodeCallback('music', 'calert', 'off'))
              : richButton.callback('🔔 Re-enable Cinema Alerts', encodeCallback('music', 'calert', 'on'), { style: 'success' })
          ]);
          await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, finish(prefCard)).catch(() => {});
        }
        return true;
      }
      if (action === 'boostmenu') {
        const destId = Number(args[0] || ctx.chatId);
        await app.music.authorize(ctx, true, destId, { allowDj: true });
        const billing = app.starsBilling;
        const gate = billing?.canBroadcastChat?.(destId, { initiatorUserId: ctx.tgId, consumeSingle: false });
        if (gate?.allowed) {
          const s = app.musicQueueManager?.getSession?.(destId);
          if (s?.currentTrack?.provider === 'movie' && app.cinemaAnnouncer) {
            await app.cinemaAnnouncer.onTrackStart({ chatId: destId, track: s.currentTrack, session: s, forceBoost: true, initiatorUserId: ctx.tgId }).catch(() => {});
            await ctx.api?.answerCallbackQuery?.(ctx.query?.id, { text: '📣 Broadcast sent to cinema viewers!', show_alert: true }).catch(() => {});
            return true;
          }
        }
        const pSingle = billing?.getPrice?.('broadcast_single') ?? 25;
        const p24 = billing?.getPrice?.('broadcast_24h') ?? 75;
        const p7d = billing?.getPrice?.('vip_7d') ?? 250;
        const b = card('📣 CINEMA BROADCAST BOOST', 'Promote this group watch party to Lancy viewers');
        b.blockquote('Choose a Telegram Stars (⭐ XTR) pass to broadcast your movie night card with a direct Join Watch Party button.');
        b.buttons([
          richButton.callback(`⭐ ${pSingle} · Single Movie`, encodeCallback('music', 'buystar', String(destId), 'broadcast_single'), { style: 'primary' }),
          richButton.callback(`⭐ ${p24} · 24h Unlimited`, encodeCallback('music', 'buystar', String(destId), 'broadcast_24h'), { style: 'success' })
        ]);
        b.buttons([
          richButton.callback(`👑 ${p7d}⭐ · 7-Day VIP Pass`, encodeCallback('music', 'buystar', String(destId), 'vip_7d'), { style: 'primary' })
        ]);
        await sendOrEditMenu(ctx, finish(b));
        return true;
      }
      if (action === 'buystar') {
        const destId = Number(args[0] || ctx.chatId);
        const kind = String(args[1] || 'broadcast_single');
        await app.music.authorize(ctx, true, destId, { allowDj: true });
        if (!app.starsBilling || !STAR_PRODUCTS[kind]) {
          throw new MusicError('STARS_UNAVAILABLE', 'Telegram Stars billing is unavailable.');
        }
        const chatInfo = await ctx.api?.getChat?.(destId).catch(() => null);
        const targetDm = Number(ctx.chatId) > 0 ? Number(ctx.chatId) : Number(ctx.tgId);
        try {
          await app.starsBilling.sendBroadcastInvoice({
            api: ctx.api,
            invoiceChatId: targetDm,
            targetChatId: destId,
            payerTgId: ctx.tgId,
            productKind: kind,
            botId: Number(ctx.botId || 0),
            meta: { chatTitle: chatInfo?.title || String(destId) }
          });
          await ctx.api?.answerCallbackQuery?.(ctx.query?.id, {
            text: Number(ctx.chatId) < 0 ? '⭐ Stars invoice sent to your DM!' : '⭐ Tap Pay below to complete!'
          }).catch(() => {});
        } catch (err) {
          throw new MusicError('STARS_INVOICE_FAILED', err?.message || 'Open a DM with the bot first so I can send your Stars invoice.');
        }
        return true;
      }
      if (action === 'schboost') {
        const schId = Number(args[0]);
        const row = app.movieScheduler?.getById?.(schId);
        if (!row) throw new MusicError('SCHEDULE_NOT_FOUND', 'That scheduled screening was not found.');
        await app.music.authorize(ctx, true, Number(row.chat_id), { allowDj: true });
        const gate = app.starsBilling?.canBroadcastChat?.(row.chat_id, { initiatorUserId: ctx.tgId, consumeSingle: true });
        if (!gate?.allowed) {
          return await handle(ctx, 'boostmenu', [String(row.chat_id)]);
        }
        app.db?.run?.(`UPDATE scheduled_screenings SET boosted = 1, updated_at = datetime('now') WHERE id = ?`, row.id);
        const updated = app.movieScheduler.getById(row.id);
        if (ctx.messageId && ctx.api?.editMessageRich) {
          await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, app.movieScheduler.buildCountdownCard(updated)).catch(() => {});
        }
        await ctx.api?.answerCallbackQuery?.(ctx.query?.id, { text: '📣 Screening marked for broadcast!' }).catch(() => {});
        return true;
      }
      if (action === 'schcancel') {
        const schId = Number(args[0]);
        const row = app.movieScheduler?.getById?.(schId);
        if (!row) throw new MusicError('SCHEDULE_NOT_FOUND', 'That scheduled screening was already removed.');
        await app.music.authorize(ctx, true, Number(row.chat_id), { allowDj: true });
        await app.movieScheduler.cancelScreening(schId, row.chat_id, ctx.api);
        await ctx.api?.answerCallbackQuery?.(ctx.query?.id, { text: '✖ Scheduled screening cancelled.' }).catch(() => {});
        return true;
      }
      if (action === 'schai') {
        const prev = app.movieScheduler?.aiProposals?.get(args[0]);
        const destId = prev?.chatId || await app.music.authorize(ctx, false, null, { allowDj: true });
        const proposal = await app.movieScheduler.suggestScheduleWithAi({
          chatId: destId,
          userId: ctx.tgId,
          botId: Number(ctx.botId || 0),
          promptText: prev?.promptText || 'tonight'
        });
        if (ctx.messageId && ctx.api?.editMessageRich) {
          await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, app.movieScheduler.buildAiProposalCard(proposal)).catch(() => {});
        }
        return true;
      }
      if (action === 'schaiok') {
        const proposal = app.movieScheduler?.aiProposals?.get(args[0]);
        if (!proposal || proposal.expiresAt < Date.now()) {
          throw new MusicError('SCHEDULE_EXPIRED', 'That AI schedule suggestion expired. Run /schedule ai again.');
        }
        await app.music.authorize(ctx, true, proposal.chatId, { allowDj: true });
        const created = [];
        for (let i = 0; i < proposal.slots.length; i++) {
          const sl = proposal.slots[i];
          const row = await app.movieScheduler.createScreening({
            chatId: proposal.chatId,
            botId: proposal.botId,
            createdBy: ctx.tgId,
            title: sl.title,
            mediaType: sl.mediaType,
            tmdbId: sl.tmdbId,
            season: sl.season,
            episode: sl.episode,
            scheduledAt: sl.scheduledAt,
            aiNote: sl.aiNote,
            api: ctx.api,
            pin: i === 0
          });
          created.push(row);
        }
        app.movieScheduler.aiProposals.delete(args[0]);
        await ctx.api?.answerCallbackQuery?.(ctx.query?.id, { text: `✅ Scheduled ${created.length} AI watch parties!` }).catch(() => {});
        if (ctx.messageId && ctx.api?.deleteMessage) {
          await ctx.api.deleteMessage(ctx.chatId, ctx.messageId).catch(() => {});
        }
        return true;
      }
      if (action === 'dualtile') {
        const destId = await app.music.authorize(ctx, true, null, { allowDj: true });
        const qm = app.musicQueueManager;
        const s = qm?.getSession?.(destId);
        if (!s?.currentTrack || !['playing', 'paused'].includes(s.status)) {
          throw new MusicError('NO_ACTIVE_CALL', 'Start playing a movie in a group Voice Chat first.');
        }
        if (s.isChannel || s.streamMode === 'rtmp') {
          throw new MusicError('INVALID_REQUEST', 'Dual-assistant subtitle tiles work only in group Interactive VCs (channels allow one stream).');
        }
        if (s.secondaryTile) {
          await app.voiceClient.stopSecondaryTile(destId).catch(() => {});
          s.secondaryTile = null;
          s.lastNotice = '👁 Secondary subtitle tile stopped.';
          await qm.updatePlayerCard(destId, { forceEdit: true });
          return true;
        }
        const t = s.currentTrack;
        const secLang = String(app.settings?.get?.('cinema.dualTileDefaultLang') || 'spa').toLowerCase();
        const tracks = Array.isArray(t.subtitleTracks) ? t.subtitleTracks : [];
        let altTrack = tracks.find((tr) => tr?.filePath && tr.filePath !== t.subtitlePath && String(tr.language || '').toLowerCase().startsWith(secLang.slice(0, 2)));
        if (!altTrack) altTrack = tracks.find((tr) => tr?.filePath && tr.filePath !== t.subtitlePath);
        if (!altTrack && app.subtitles?.resolveForMedia) {
          const res = await app.subtitles.resolveForMedia({
            title: t.title,
            year: t.year,
            tmdbId: t.tmdbId || (/^\d+$/.test(String(t.id || '')) ? t.id : null),
            type: t.seasonNumber ? 'tv' : 'movie',
            season: t.seasonNumber,
            episode: t.episodeNumber,
            language: secLang,
            durationSeconds: t.durationSeconds
          }).catch(() => null);
          if (res?.filePath) altTrack = { filePath: res.filePath, language: res.language || secLang, label: res.label || `${secLang.toUpperCase()} Subtitles` };
        }
        if (!altTrack?.filePath) {
          throw new MusicError('NO_ALT_SUBTITLE', `No secondary (${secLang.toUpperCase()}) subtitle track found for this title.`);
        }
        const maxVid = Number(app.settings?.get?.('cinema.maxVideoCallsPerAccount') || 0) || undefined;
        const tileRes = await app.voiceClient.startSecondaryTile(destId, {
          subtitlePath: altTrack.filePath,
          language: altTrack.language || secLang,
          label: altTrack.label || `${secLang.toUpperCase()} Subtitles`,
          subtitleOffset: s.subtitleSyncOffset || 0,
          maxVideoCallsPerAccount: maxVid
        });
        s.secondaryTile = { alias: tileRes.account_alias, language: tileRes.language, label: tileRes.label };
        s.lastNotice = `👁 Dual subtitle tile live (${tileRes.account_alias} · ${tileRes.label})`;
        await qm.updatePlayerCard(destId, { forceEdit: true });
        return true;
      }
      if (action === 'mv') return await movieUi.handleCallback(ctx, args);
      if (action === 'moviehub' || action === 'movie') return await movieUi.openHub(ctx);
      if (action === 'aichat') return await movieUi.startAiChat(ctx, args.join(' '));
      if (action === 'aiclose') {
        const isChan = isChannelCtx(ctx);
        const stateKey = (isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId;
        if (app.sm?.state?.(stateKey) === States.AI_MEDIA_CHAT) await app.sm.reset(stateKey);
        if (stateKey !== ctx.tgId && app.sm?.state?.(ctx.tgId) === States.AI_MEDIA_CHAT) await app.sm.reset(ctx.tgId);
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🚪 AI Agent chat closed.' }).catch(() => {});
        }
        return true;
      }
      if (action === 'channels') {
        if (Number(ctx.chatId) > 0 && !isChannelCtx(ctx)) {
          await sendOrEditMenu(ctx, renderDmChannelGuideCard());
          return true;
        }
        if (isChannelCtx(ctx)) {
          const reuseId = reusableChannelSlotId(ctx);
          const p = await app.music.player(reuseId ? { ...ctx, reuseMessageId: reuseId } : ctx, Number(ctx.chatId));
          await adoptChannelPlayerResult(ctx, p);
          return p;
        }
        return await channels(ctx);
      }
      if (action === 'ch') {
        if (Number(ctx.chatId) > 0 && !isChannelCtx(ctx)) {
          await sendOrEditMenu(ctx, renderDmChannelGuideCard());
          return true;
        }
        return await app.music.channels.lock.run(args[0], async () => {
        const [token, revision, operation, index] = args;
        const state = app.music.channels.resolve(ctx, token, revision);
        if (operation === 'add') return prompt(ctx, 'channel');
        const selected = state.items?.[Number(index)];
        if (operation === 'delete') {
          if (!selected) throw new MusicError('CHANNEL_MENU_EXPIRED', 'That channel is unavailable.');
          await app.music.channels.remove(ctx, selected.id);
        } else if (operation === 'page') {
          state.page = Math.max(0, Number(index) || 0);
        } else if (operation !== 'select') {
          throw new MusicError('CHANNEL_MENU_EXPIRED', 'Open Channel Play again.');
        }
        state.revision++;
        await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderChannels(ctx, state));
        if (operation === 'select') {
          if (!selected) throw new MusicError('CHANNEL_MENU_EXPIRED', 'That channel is unavailable.');
          if (state.queueCardToken) {
            const qtoken = state.queueCardToken;
            await app.music.queueListen(ctx, qtoken, { destination: selected.id, fromCatalog: true });
            state.queueCardToken = null;
          } else {
            await app.music.bind(ctx, String(selected.id));
            await app.music.player({ ...ctx, forceNew: true }, selected.id);
          }
        }
      });
      }
      if (action === 'listenq' || action === 'listennow' || action === 'listenadd') {
        const c = app.music.listenCard(ctx, args[0], { requireMessage: action === 'listenq' });
        if (!c.destination) return channels(ctx, c.token);
        await app.music.authorize(ctx, true, c.destination, { allowDj: true });
        const qm = app.musicQueueManager;
        const activeSess = qm?.getSession?.(c.destination);
        const vcActive = Boolean(activeSess?.currentTrack && ['playing', 'paused', 'buffering'].includes(activeSess?.status));
        if (action === 'listenq' && vcActive && ctx.api?.sendRichMessage) {
          if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎙️ VC is playing — choose Play Now or Queue!' }).catch(() => {});
          }
          const promptCard = card('VOICE CHAT IS PLAYING', `${cut(c.track?.title || 'Selected Track', 60)}`)
            .quote(rt.text(`Now Playing: ${cut(activeSess.currentTrack.title, 50)}\nTap ⚡ Play Immediately to play right now (the current song & genre mix will resume after), or ➕ Add to Queue.`))
            .buttons([
              button('⚡ Play Immediately', 'listennow', c.token, { style: 'success' }),
              button('➕ Add to Queue', 'listenadd', c.token, { style: 'primary' })
            ]);
          return await sendOrEditMenu(ctx, finish(promptCard), { ttlMs: 120000 });
        }
        return await app.music.queueListen(ctx, c.token, { playNow: action === 'listennow', fromCatalog: action !== 'listenq' });
      }
      if (action === 'catmenu') {
        let [mode, page = 0] = args;
        let s = null;
        try {
          const dest = app.music.destination(ctx);
          s = app.musicQueueManager?.getSession?.(dest);
          if (s) {
            s.lastRender = null;
            if (ctx.query && ctx.messageId && ctx.messageId === s.screenMessageId) {
              s.overlayView = 'catmenu';
              s.overlayAt = Date.now();
            }
          }
        } catch {}
        if (!mode) mode = defaultMediaMode(s || { isChannel: isChannelCtx(ctx) });
        const rich = renderCategoryPicker(mode, null, Number(page) || 0);
        if (ctx.query && ctx.messageId) await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
        else await sendOrEditMenu(ctx, rich);
        return;
      }
      if (action === 'genresub') {
        let [mode, genreRef] = args;
        let s = null;
        try {
          const dest = app.music.destination(ctx);
          s = app.musicQueueManager?.getSession?.(dest);
        } catch {}
        if (!mode) mode = defaultMediaMode(s || { isChannel: isChannelCtx(ctx) });
        const genre = resolveGenre(genreRef, s);
        if (s) {
          s.radioCustom = genre;
          s.lastRender = null;
          if (ctx.query && ctx.messageId && ctx.messageId === s.screenMessageId) {
            s.overlayView = 'genresub';
            s.overlayAt = Date.now();
          }
        }
        const rich = renderGenreSubmenu(genre, mode, null, genreRef === 'custom' || genre.length > 18);
        if (ctx.query && ctx.messageId) await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
        else await sendOrEditMenu(ctx, rich);
        return;
      }
      if (action === 'catpick') {
        let [mode, genreRef] = args;
        let s = null;
        try {
          const dest = app.music.destination(ctx);
          s = app.musicQueueManager?.getSession?.(dest);
          if (s && s.overlayView) {
            s.overlayView = null;
            s.overlayAt = 0;
            if (ctx.messageId && ctx.messageId === s.screenMessageId) {
              void app.musicQueueManager?.updatePlayerCard?.(s.chatId).catch(() => {});
            }
          }
        } catch {}
        if (!mode) mode = defaultMediaMode(s || { isChannel: isChannelCtx(ctx) });
        const genre = resolveGenre(genreRef, s);
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Loading ${genre}…` }).catch(() => {});
        }
        return await search(ctx, genre, mode);
      }
      if (action === 'infinact') return await handleInfiniteAction(ctx, args, null);
      if (action === 'openradio') {
        const state = await app.music.player(ctx);
        return await app.music.control({ ...ctx, query: null, messageId: null, musicPanel: state.panelToken ? state : undefined }, 'radio', []);
      }
      if (action === 'pc') {
        const [token, wire, ...controlArgs] = args;
        const command = PANEL_ACTIONS[parseInt(wire, 36)];
        if (!command) throw new MusicError('STALE_PLAYER', 'Open your current channel dashboard.');
        const relaxMessage = ['infinact', 'catmenu', 'genresub', 'catpick', 'prompt', 'channels', 'movie'].includes(command);
        const panel = await app.music.channelPanels.resolve(ctx, token, { requireMessage: !relaxMessage });
        if (ctx.messageId && ['infinact', 'catmenu', 'genresub', 'player', 'movie'].includes(command)) {
          app.music.channelPanels?.registerMessage?.(token, ctx.messageId);
        }
        if (command === 'channels') return await channels(ctx);
        if (command === 'movie') {
          if (panel) {
            panel.overlayView = 'movie';
            panel.overlayAt = Date.now();
            panel.lastRender = null;
          }
          return await movieUi.openHub({ ...ctx, musicPanel: panel });
        }
        if (command === 'prompt') return await prompt({ ...ctx, musicPanel: panel }, controlArgs[0] || 'queue');
        if (command === 'catmenu') {
          let [mode, page = 0] = controlArgs;
          if (!mode) mode = defaultMediaMode(panel);
          if (panel) {
            panel.overlayView = 'catmenu';
            panel.overlayAt = Date.now();
            panel.lastRender = null;
          }
          const qmS = app.musicQueueManager?.getSession?.(panel?.destination);
          if (qmS && ctx.messageId && ctx.messageId === qmS.screenMessageId) {
            qmS.overlayView = 'catmenu';
            qmS.overlayAt = Date.now();
            qmS.lastRender = null;
          }
          const rich = renderCategoryPicker(mode, token, Number(page) || 0);
          if (ctx.query && ctx.messageId) await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
          else await ctx.api.sendRichMessage(ctx.chatId, rich);
          return;
        }
        if (command === 'genresub') {
          let [mode, genreRef] = controlArgs;
          if (!mode) mode = defaultMediaMode(panel);
          const genre = resolveGenre(genreRef, panel);
          if (panel) {
            panel.radioCustom = genre;
            panel.overlayView = 'genresub';
            panel.overlayAt = Date.now();
            panel.lastRender = null;
          }
          const qmS = app.musicQueueManager?.getSession?.(panel?.destination);
          if (qmS) {
            qmS.radioCustom = genre;
            if (ctx.messageId && ctx.messageId === qmS.screenMessageId) {
              qmS.overlayView = 'genresub';
              qmS.overlayAt = Date.now();
              qmS.lastRender = null;
            }
          }
          const rich = renderGenreSubmenu(genre, mode, token, genreRef === 'custom' || genre.length > 18);
          if (ctx.query && ctx.messageId) await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich);
          else await ctx.api.sendRichMessage(ctx.chatId, rich);
          return;
        }
        if (command === 'catpick') {
          let [mode, genreRef] = controlArgs;
          if (!mode) mode = defaultMediaMode(panel);
          const genre = resolveGenre(genreRef, panel);
          const qmS = app.musicQueueManager?.getSession?.(panel?.destination);
          if (panel && panel.overlayView) {
            panel.overlayView = null;
            panel.overlayAt = 0;
          }
          if (qmS && qmS.overlayView) {
            qmS.overlayView = null;
            qmS.overlayAt = 0;
          }
          if (ctx.messageId && (ctx.messageId === panel?.screenMessageId || ctx.messageId === qmS?.screenMessageId)) {
            void app.musicQueueManager?.updatePlayerCard?.(panel?.destination).catch(() => {});
          }
          if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Loading ${genre}…` }).catch(() => {});
          }
          return await search({ ...ctx, musicPanel: panel }, genre, mode);
        }
        if (command === 'infinact') {
          return await handleInfiniteAction({ ...ctx, musicPanel: panel }, controlArgs, token);
        }
        if (command === 'player') {
          if (panel) { panel.overlayView = null; panel.overlayAt = 0; panel.lastRender = null; }
          const qmS = app.musicQueueManager?.getSession?.(panel?.destination);
          if (qmS) { qmS.overlayView = null; qmS.overlayAt = 0; qmS.lastRender = null; }
          if (!controlArgs.length) controlArgs.push(Number(panel?.controlRevision || 0).toString(36));
          const dest = panel?.destination || app.music.destination(ctx);
          if (dest) {
            const s = app.musicQueueManager.getSession(dest);
            if (s.status === 'stopped') { s.status = 'idle'; s.lastError = null; }
          }
        }
        return await app.music.control({ ...ctx, musicPanel: panel }, command, controlArgs);
      }
      if (action === 'cancelprompt') {
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Cancelled.' }).catch(() => {});
        }
        const isChan = isChannelCtx(ctx);
        const stateKey = (isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId;
        if (app.sm?.state?.(stateKey) === States.MUSIC_QUEUE_INPUT) await app.sm.reset(stateKey);
        if (stateKey !== ctx.tgId && app.sm?.state?.(ctx.tgId) === States.MUSIC_QUEUE_INPUT) await app.sm.reset(ctx.tgId);
        if (isChan) {
          let activePlayerId = null;
          try {
            const dest = app.music?.destination?.(ctx);
            activePlayerId = dest ? app.musicQueueManager?.getSession?.(dest)?.screenMessageId || null : null;
          } catch {}
          if (ctx.messageId && ctx.messageId !== activePlayerId) {
            await clearChatSlot(menuMsgByChat, ctx, activePlayerId);
            await clearChatSlot(noticeMsgByChat, ctx, activePlayerId);
            await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
          }
        }
        return true;
      }
      if (action === 'prompt') return await prompt(ctx, args[0] || 'queue');
      if (action === 'openplayer') {
        if (Number(ctx.chatId) > 0 && !isChannelCtx(ctx) && !ctx.musicPanel) {
          let dmDest = null;
          try { dmDest = app.music.destination(ctx); } catch {}
          if (!dmDest) {
            await sendOrEditMenu(ctx, renderDmChannelGuideCard());
            return true;
          }
        }
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Opening player…' }).catch(() => {});
        }
        const dest = app.music.destination(ctx);
        const qmSession = dest ? app.musicQueueManager?.getSession?.(dest) : null;
        if (qmSession?.status === 'stopped') { qmSession.status = 'idle'; qmSession.lastError = null; }
        if (isChannelCtx(ctx) && ctx.messageId) {
          if (qmSession && !qmSession.screenMessageId) {
            const p = await app.music.player({ ...ctx, forceNew: true, reuseMessageId: ctx.messageId });
            await adoptChannelPlayerResult(ctx, p);
            return p;
          }
          const p = await app.music.player(ctx);
          if (qmSession?.screenMessageId && ctx.messageId !== qmSession.screenMessageId) {
            await clearChatSlot(menuMsgByChat, ctx);
            await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
          }
          return p;
        }
        const p = await app.music.player({ ...ctx, forceNew: true });
        if (Number(ctx.chatId) < 0 && ctx.messageId && qmSession?.screenMessageId && ctx.messageId !== qmSession.screenMessageId) {
          await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
        }
        return p;
      }
      if (['pick', 'spage', 'sclear', 'submit', 'playnow_s', 'qnow'].includes(action)) {
        const [token, revision, index] = args;
        let searchCtx = ctx;
        const isChannelInteraction = isChannelCtx(ctx);
        if (isChannelInteraction && Number(ctx.chatId) < 0) {
          await app.music.authorize(ctx, true, Number(ctx.chatId), { allowDj: true });
          searchCtx = { ...ctx, isChannel: true, channelAdminVerified: true };
        }
        let state;
        let promotedToPlayer = false;
        await app.music.search.action(token, revision, searchCtx, async s => {
          state = s;
          if (action === 'spage') await app.music.search.page(s, Number(index));
          if (action === 'pick') {
            const t = s.pages[s.index].items[Number(index)];
            if (!t) throw new MusicError('INVALID_SELECTION', 'That track is unavailable.');
            if (s.selected.has(t.id)) s.selected.delete(t.id);
            else {
              if (['download', 'lyrics'].includes(s.mode)) s.selected.clear();
              if (s.selected.size >= 20) throw new MusicError('SELECTION_LIMIT', 'Select up to 20 tracks per batch.');
              s.selected.set(t.id, t);
            }
          }
          if (action === 'qnow') {
            const t = s.pages[s.index]?.items?.[Number(index)];
            if (!t) throw new MusicError('INVALID_SELECTION', 'That track is unavailable.');
            const rest = [...s.selected.entries()].filter(([k]) => k !== t.id);
            s.selected.clear();
            s.selected.set(t.id, t);
            for (const [k, v] of rest) s.selected.set(k, v);
          }
          if (action === 'sclear') s.selected.clear();
          if (['submit', 'playnow_s', 'qnow'].includes(action)) {
            const isPlayNow = action === 'playnow_s' || action === 'qnow';
            temporary.hold(s.temporaryToken);
            s.processing = { kind: isPlayNow ? 'playnow' : 'submit', startedAt: Date.now() };
            s.expires = Date.now() + (app.music.search.ttlMs || 600000);
            const isChanSubmit = isChannelInteraction && ['queue', 'video'].includes(s.mode);
            const destSession = isChanSubmit && app.musicQueueManager?.getSession ? app.musicQueueManager.getSession(s.destination) : null;
            const canPromoteCard = Boolean(isChanSubmit && destSession && !destSession.screenMessageId && ctx.messageId);
            try {
              await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderSearch(s));
              await app.music.submit(canPromoteCard ? { ...searchCtx, reuseMessageId: ctx.messageId } : searchCtx, s, { playNow: isPlayNow });
              promotedToPlayer = Boolean(canPromoteCard && destSession?.screenMessageId === ctx.messageId);
            } finally {
              s.processing = null;
              if (!s.consumed) {
                s.expires = Date.now() + (app.music.search.ttlMs || 600000);
                await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderSearch(s)).catch(() => {});
              }
              if (promotedToPlayer) {
                temporary.keep(s.temporaryToken);
                await adoptChannelPlayerResult(ctx, destSession);
              } else if (s.consumed && s.mode === 'download') {
                temporary.keep(s.temporaryToken);
              } else if (s.consumed && s.mode !== 'lyrics') {
                await temporary.remove(s.temporaryToken);
                if (isChanSubmit) await clearChatSlot(menuMsgByChat, ctx);
              } else {
                temporary.expire(s.temporaryToken, Math.max(1000, (s.expires || Date.now() + 60000) - Date.now()));
              }
            }
          }
        });
        if (promotedToPlayer) {
          return;
        }
        if (state.consumed && state.mode === 'lyrics') {
          await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderStandaloneLyrics(state.lyricsTrack, state.lyricsResult));
          temporary.keep(state.temporaryToken);
        } else if (state.consumed && state.mode === 'download') {
          temporary.keep(state.temporaryToken);
        } else if (state.consumed) {
          await temporary.remove(state.temporaryToken);
        } else {
          await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderSearch(state));
        }
        return;
      }
      if (action === 'refresh_status') {
        if (!app.music.owner(ctx) || Number(ctx.chatId) < 0) throw new MusicError('OWNER_ONLY', 'Account health is available to the main owner in private chat.');
        const health = await app.voiceClient.checkHealth();
        return ctx.api.editMessageRich(ctx.chatId, ctx.messageId, renderAssistantSessionStatus(health));
      }
      if (action === 'link_assistant') throw new MusicError('TERMINAL_SETUP', 'Telegram login-code collection has been retired. Use the protected local terminal generator.');
      if (action === 'accounts') return await app.music.control(ctx, 'accounts', args);
      if (action === 'volume') return await app.music.control(ctx, 'volume', args);
      await app.music.control(ctx, action, args);
    } catch (e) {
      if (e?.code === 'STALE_PLAYER' && ctx.query && !ctx.noStaleAutoRecover) {
        try {
          const dest = app.music?.destination?.(ctx);
          const qmSession = dest ? app.musicQueueManager?.getSession?.(dest) : null;
          if (qmSession && ctx.messageId && qmSession.screenMessageId !== ctx.messageId) {
            await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
            const fresh = await app.music.player({ ...ctx, forceNew: true }, dest);
            if (isChannelCtx(ctx)) await adoptChannelPlayerResult(ctx, fresh);
            if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
              await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🔄 Refreshed latest player card!' }).catch(() => {});
            }
            return fresh;
          }
        } catch {}
      }
      await error(ctx, e);
    }
  }

  async function handleCommand(ctx, command, args = []) {
    const commands = [
      '/play', '/song', '/music', '/addq', '/vplay', '/stream', '/vc', '/vidc', '/random',
      '/vcplay', '/player', '/pause', '/resume', '/skip', '/voteskip', '/next', '/previous',
      '/stop', '/end', '/leave', '/queue', '/q', '/volume', '/vol', '/loop', '/repeat',
      '/shuffle', '/seek', '/eq', '/bass', '/streammode', '/rtmp', '/vcmsg', '/aidj', '/dj', '/movie', '/movies', '/moviesearch', '/movieai', '/mediaai',
      '/vcsudo', '/rmsudo', '/accounts', '/destination',
      '/moviecast', '/moviebroadcast', '/moviealert', '/cinemaalert', '/movieannounce', '/autopoll', '/votes',
      '/channel', '/session', '/gensession', '/authassistant', '/linkassistant', '/playlist', '/lyrics'
    ];
    if (!commands.includes(command)) return false;
    const isChan = isChannelCtx(ctx);
    if (isChan && Number(ctx.chatId) < 0 && !ctx.channelAdminVerified) {
      try {
        await app.music.authorize(ctx, true, Number(ctx.chatId), { allowDj: false });
        ctx = { ...ctx, channelAdminVerified: true };
      } catch {
        return true;
      }
    }
    const isExplicitNewPlayerCmd = ['/player', '/vc', '/channel', '/destination'].includes(command);
    ctx = { ...ctx, forceNew: isExplicitNewPlayerCmd };
    const triggerCleanup = isChan ? deleteTriggerMessage(ctx) : Promise.resolve(false);
    const channelPlayerCtx = () => {
      const reuseId = isChan ? reusableChannelSlotId(ctx) : null;
      return reuseId ? { ...ctx, reuseMessageId: reuseId } : ctx;
    };
    const djSub = String(args[0] || '').toLowerCase();
    const initialSession = isChan ? app.musicQueueManager?.getSession?.(Number(ctx.chatId)) : null;
    const needsInstantChannelStatus = isChan && !initialSession?.screenMessageId && ctx.api?.sendRichMessage && (
      (command === '/dj' && args.length > 0 && !['add', 'remove', 'list', 'clear'].includes(djSub)) ||
      command === '/aidj' ||
      (command === '/random' && args.length > 0)
    );
    let sentStatus = null;
    try {
      if (needsInstantChannelStatus) {
        sentStatus = await sendOrEditMenu(
          ctx,
          finish(card('Spotify ✕ DJ', 'Processing…').paragraph(rt.text('🎙️ Tuning live mix & charts…'))),
          { ttlMs: 120000 }
        ).catch(() => null);
      }
      if (command === '/vcsudo' || command === '/rmsudo') {
        const msg = command === '/rmsudo'
          ? await app.music.rmsudoCommand(ctx, args)
          : await app.music.vcsudoCommand(ctx, args);
        if (msg) {
          await ctx.api.sendMessage(ctx.chatId, msg, { parse_mode: 'HTML' }).catch(async () => {
            await ctx.api.sendMessage(ctx.chatId, msg.replace(/<[^>]+>/g, '')).catch(() => {});
          });
        }
        return true;
      }
      if (['/moviecast', '/moviebroadcast', '/moviealert', '/cinemaalert', '/movieannounce'].includes(command)) {
        const res = await app.music.movieBroadcastCommand(ctx, args);
        const canGlobal = Boolean(app.music.owner(ctx) || app.music.superAdmin(ctx));
        const notice = res.action === 'set'
          ? (res.scope === 'group'
              ? (res.enabled ? '👥 Movie broadcasts are now ALLOWED for this group.' : '🔕 Movie broadcasts are now DISABLED for this group.')
              : (res.enabled ? '✅ Movies will now broadcast to all eligible bot users when VC streaming starts.' : '🔕 Movie broadcasts to all users are now DISALLOWED. Playback continues quietly.'))
          : null;
        await sendOrEditMenu(ctx, renderMovieBroadcastCard(res, { notice, chatId: ctx.chatId, canGlobal }));
        return true;
      }
      if (command === '/schedule') {
        const destId = await app.music.authorize(ctx, true, null, { allowDj: true });
        if (!app.movieScheduler) {
          await ctx.api.sendMessage(ctx.chatId, '⏰ Movie scheduler service is unavailable.').catch(() => {});
          return true;
        }
        const sub = String(args[0] || '').toLowerCase();
        if (!args.length || sub === 'list') {
          const rows = app.movieScheduler.listByChat(destId);
          const b = card('⏰ SCHEDULED WATCH PARTIES', `${rows.length} upcoming`);
          if (!rows.length) {
            b.blockquote('No movies scheduled yet.\n\nTry:\n• /schedule Bahubali 9pm\n• /schedule Inception in 2h\n• /schedule ai tonight');
          } else {
            const tz = app.movieScheduler.getTimezone();
            b.table(rows.map((r) => [`#${r.id} · ${formatClockInTz(r.scheduled_at, tz)}`, cut(r.title, 42)]), { compact: true, striped: true });
          }
          await sendOrEditMenu(ctx, finish(b));
          return true;
        }
        if (sub === 'cancel' || sub === 'del' || sub === 'rm') {
          const ok = await app.movieScheduler.cancelScreening(Number(args[1]), destId, ctx.api);
          await ctx.api.sendMessage(ctx.chatId, ok ? `✖ Cancelled schedule #${args[1]}.` : `⚠️ Schedule #${args[1] || ''} not found in this chat.`).catch(() => {});
          return true;
        }
        if (sub === 'ai') {
          const proposal = await app.movieScheduler.suggestScheduleWithAi({
            chatId: destId,
            userId: ctx.tgId,
            botId: Number(ctx.botId || 0),
            promptText: args.slice(1).join(' ') || 'tonight'
          });
          await sendOrEditMenu(ctx, app.movieScheduler.buildAiProposalCard(proposal));
          return true;
        }
        const parsed = parseScheduleInput(args.join(' '), { timezone: app.movieScheduler.getTimezone() });
        if (!parsed) {
          await ctx.api.sendMessage(ctx.chatId, '⏰ Use: /schedule <movie title> <time> (e.g. /schedule Bahubali 9pm, /schedule Dune in 2h, or /schedule ai tonight)').catch(() => {});
          return true;
        }
        const meta = await app.movieScheduler.resolveItemMetadata(parsed.title);
        await app.movieScheduler.createScreening({
          chatId: destId,
          botId: Number(ctx.botId || 0),
          createdBy: ctx.tgId,
          title: meta.title,
          mediaType: meta.mediaType,
          tmdbId: meta.tmdbId,
          season: meta.season,
          episode: meta.episode,
          scheduledAt: parsed.scheduledAt,
          repeatRule: parsed.repeatRule,
          api: ctx.api
        });
        return true;
      }
      if (command === '/boost' || command === '/broadcastboost') {
        const destId = await app.music.authorize(ctx, true, null, { allowDj: true });
        await handle(ctx, 'boostmenu', [String(destId)]);
        return true;
      }
      if (command === '/autopoll' || command === '/votes') {
        const destId = await app.music.authorize(ctx, false, null, { allowDj: false });
        if (command === '/votes' || !args.length || String(args[0] || '').toLowerCase() === 'settings') {
          const s = await app.music.player(channelPlayerCtx());
          await adoptChannelPlayerResult(ctx, s);
          await app.music.control({ ...ctx, messageId: null, query: null }, 'voteset', []);
        } else {
          const res = await app.music.autopollCommand(ctx, args);
          const s = app.musicQueueManager?.getSession?.(destId);
          if (!s?.screenMessageId) {
            await ctx.api.sendMessage(ctx.chatId, `🤖 Auto-Poll: ${res.enabled ? 'ON' : 'OFF'} · Vote limit: ${res.queueNeed}v (Skip: ${res.skipNeed}v)`).catch(() => {});
          }
        }
        return true;
      }
      if (command === '/movie' || command === '/movies' || command === '/moviesearch') {
        const movieCtx = isChan ? channelPlayerCtx() : { ...ctx, directMessageId: ctx.directMessageId ?? ctx.message?.message_id ?? null };
        const firstArg = String(args[0] || '').toLowerCase();
        if (['x', 'xv', 'xvideos'].includes(firstArg)) {
          const xvArgs = args.slice(1);
          if (xvArgs.length) await movieUi.openMovieSearch(movieCtx, xvArgs.join(' '), { sourceMode: 'xvideos', originMessageId: movieCtx.directMessageId, forceNewCard: true });
          else await movieUi.openHub(movieCtx, { sourceMode: 'xvideos' });
        } else if (['18', '18+', 'adult', 'full', 'uncut', 'xxx'].includes(firstArg)) {
          const adultArgs = args.slice(1);
          const adultOpts = { sourceMode: 'xvideos', xvSource: 'adult_movies', xvDur: 'movie' };
          if (adultArgs.length) await movieUi.openMovieSearch(movieCtx, adultArgs.join(' '), { ...adultOpts, originMessageId: movieCtx.directMessageId, forceNewCard: true });
          else await movieUi.openHub(movieCtx, adultOpts);
        } else if (args.length) {
          await movieUi.openMovieSearch(movieCtx, args.join(' '), { originMessageId: movieCtx.directMessageId, forceNewCard: true });
        } else {
          await movieUi.openHub(movieCtx);
        }
        return true;
      }
      if (command === '/movieai' || command === '/mediaai') {
        const aiCtx = isChan ? channelPlayerCtx() : ctx;
        await movieUi.startAiChat(aiCtx, args.join(' '));
        return true;
      }
      if (command === '/dj') {
        const result = await app.music.djCommand(isChan ? channelPlayerCtx() : ctx, args);
        const msg = typeof result === 'string' ? result : result?.reply;
        if (isChan) {
          if (result?.kind === 'ai_chat' && result.session?.screenMessageId) {
            await adoptChannelPlayerResult(ctx, result.session);
            if (result.intent?.wantsTrending && !result.added?.length && msg) {
              await deliverChannelDjReply(ctx, noticeMsgByChat, msg, { trending: true, ttlMs: 90000 });
            }
          } else if (msg) {
            await deliverChannelDjReply(ctx, menuMsgByChat, msg, { trending: Boolean(result?.intent?.wantsTrending), ttlMs: 120000 });
          }
        } else if (msg) {
          await ctx.api.sendMessage(ctx.chatId, msg);
        }
        return true;
      }
      if (command === '/aidj') {
        const result = await app.music.aidjCommand(channelPlayerCtx(), args);
        if (isChan) {
          const activeSession = app.musicQueueManager?.getSession?.(Number(ctx.chatId));
          await adoptChannelPlayerResult(ctx, activeSession);
          if (result?.kind === 'ai_chat' && result.reply && !result.added?.length) {
            const consumedStatus = Boolean(sentStatus?.message_id && activeSession?.screenMessageId === sentStatus.message_id);
            if (!consumedStatus || (result.intent?.wantsTrending && activeSession?.screenMessageId)) {
              const targetSlot = activeSession?.screenMessageId ? noticeMsgByChat : menuMsgByChat;
              await deliverChannelDjReply(ctx, targetSlot, result.reply, { trending: Boolean(result.intent?.wantsTrending), ttlMs: 90000 });
            }
          }
        } else if (result?.kind === 'ai_chat' && result.reply) {
          await ctx.api.sendMessage(ctx.chatId, result.reply);
        }
        return true;
      }
      if (['/play', '/song'].includes(command) && !args.length && ctx.controller?.handleAudioRecognition && [ctx.replyTo?.audio, ctx.replyTo?.voice, ctx.replyTo?.video, ctx.replyTo?.video_note].some(Boolean)) {
        await ctx.controller.handleAudioRecognition(ctx, ctx.replyTo);
        return true;
      }
      if (command === '/lyrics') {
        if (args.length) {
          if (app.screens?.get('downloader')?.executeLyricsSearch) {
            await app.screens.get('downloader').executeLyricsSearch(ctx, args.join(' '), { forceNew: true });
            return true;
          }
          await search(ctx, args.join(' '), 'lyrics');
        } else {
          let current = null;
          try { current = app.musicQueueManager.getSession(app.music.destination(ctx)).currentTrack; } catch {}
          if (current) await app.music.control(ctx, 'lyrics', []);
          else await search(ctx, '', 'lyrics');
        }
      } else if (command === '/stream') {
        if (ctx.replyTo) await app.music.streamReply(ctx, ctx.replyTo);
        else if (args.length) await search(ctx, args.join(' '), 'queue');
        else throw new MusicError('REPLY_MEDIA', 'Reply /stream to a song, voice message or video to add it to the VC queue.');
      } else if (command === '/vc' || command === '/vidc') {
        if (ctx.replyTo && [ctx.replyTo.audio, ctx.replyTo.voice, ctx.replyTo.video, ctx.replyTo.video_note, ctx.replyTo.document, audioFileId(ctx.replyTo)].some(Boolean)) {
          await app.music.streamReply(ctx, ctx.replyTo, { video: command === '/vidc' });
        } else if (args.length || command === '/vidc') {
          await search(ctx, args.join(' '), command === '/vidc' ? 'video' : defaultMediaMode(isChan ? { isChannel: true } : null));
        } else {
          await app.music.prepare(ctx);
          const s = await app.music.player(channelPlayerCtx());
          await adoptChannelPlayerResult(ctx, s);
        }
      } else if (command === '/random') {
        const dest = await app.music.authorize(ctx, true);
        if (args[0]?.toLowerCase() === 'movie' || args[0]?.toLowerCase() === 'movies' || args[0]?.toLowerCase() === 'tv') {
          await movieUi.openMovieSearch(isChan ? channelPlayerCtx() : ctx, '', { random: true });
          return true;
        }
        if (args.length) {
          await app.music.prepare(ctx, dest);
          app.music.radio.configure(app.musicQueueManager.getSession(dest), [args.join(' ')]);
          await app.music.radio.refill(app.musicQueueManager.getSession(dest));
          await app.musicQueueManager.ensurePlaying(dest);
          const s = await app.music.player(channelPlayerCtx(), dest);
          await adoptChannelPlayerResult(ctx, s);
        } else {
          const state = await app.music.player(channelPlayerCtx(), dest);
          await adoptChannelPlayerResult(ctx, state);
          await app.music.control({ ...ctx, query: null, messageId: null, musicPanel: state.panelToken ? state : undefined }, 'radio', []);
        }
      } else if (['/play', '/song', '/addq', '/vplay', '/vcplay'].includes(command)) {
        const cmdStateKey = (isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId;
        await app.sm?.reset(cmdStateKey);
        if (cmdStateKey !== ctx.tgId) await app.sm?.reset(ctx.tgId);
        if (['/play', '/song'].includes(command) && args.length && app.screens?.get('downloader')?.executeDownload) {
          await app.screens.get('downloader').executeDownload(ctx, args.join(' '), { forceMusicSearch: true, forceNew: true });
          return true;
        }
        const isVideoCmd = ['/vplay', '/vcplay'].includes(command);
        if (!args.length && isVideoCmd) {
          const rich = renderCategoryPicker('video');
          await sendOrEditMenu(ctx, rich);
          return true;
        }
        await search(ctx, args.join(' '), ['/play', '/song'].includes(command) ? 'download' : isVideoCmd ? 'video' : 'queue');
      } else if (command === '/music') {
        if (args.length) {
          if (app.screens?.get('downloader')?.executeDownload) {
            await app.screens.get('downloader').executeDownload(ctx, args.join(' '), { forceMusicSearch: true, forceNew: true });
            return true;
          }
          await search(ctx, args.join(' '), 'download');
        } else {
          await sendOrEditMenu(ctx, renderHome(ctx));
        }
      } else if (command === '/accounts') {
        const accounts = await app.music.accountCommand(ctx, args);
        await ctx.api.sendMessage(ctx.chatId, accounts.map(a => `${a.alias} · ${a.status} · ${a.activeCalls || 0} active calls\nApproved: ${a.allowed.join(', ') || 'none'}`).join('\n\n') || 'No registered accounts. Generate one locally, then /accounts register <alias>.');
      } else if (['/session', '/gensession', '/authassistant', '/linkassistant'].includes(command)) {
        if (!app.music.owner(ctx) || Number(ctx.chatId) < 0) throw new MusicError('OWNER_ONLY', 'Use /accounts in the main owner private chat.');
        await ctx.api.sendRichMessage(ctx.chatId, renderSessionSetupNotice());
      } else if (command === '/destination' || command === '/channel') {
        if (isChan) {
          const s = await app.music.player(channelPlayerCtx(), Number(ctx.chatId));
          await adoptChannelPlayerResult(ctx, s);
          return true;
        }
        if (Number(ctx.chatId) < 0) {
          await ctx.api.sendMessage(ctx.chatId, `<blockquote>🌸 Channel playback runs directly inside the Channel itself ♡\nMake Lancy an admin in your Channel and send <code>/player</code>, <code>/vplay</code>, <code>/addq</code>, <code>/movie</code>, or <code>/aidj</code> there!</blockquote>`, { parse_mode: 'HTML' }).catch(() => {});
          return true;
        }
        await sendOrEditMenu(ctx, renderDmChannelGuideCard());
        return true;
      } else if (command === '/vcmsg') {
        const destId = await app.music.authorize(ctx);
        const msgText = args.join(' ').trim();
        if (!msgText) {
          await ctx.api.sendMessage(ctx.chatId, '💬 Send in-call VC messages with <code>/vcmsg your message</code>\nViewers inside VC can also use <code>!np</code>, <code>!queue</code>, or <code>!skip</code>.', { parse_mode: 'HTML' });
          return true;
        }
        await app.music.control({ ...ctx, messageId: null, query: null }, 'vcmsg', [msgText]);
        if (!isChan) await ctx.api.sendMessage(ctx.chatId, `💬 Sent to VC chat (${destId}): ${cut(msgText, 120)}`).catch(() => {});
        return true;
      } else if (command === '/playlist') {
        await playlist(ctx, args);
      } else {
        if (command === '/voteskip') {
          await app.music.control({ ...ctx, messageId: null, query: null }, 'voteskip', args);
          return true;
        }
        const action = (!args.length && ['/volume', '/vol'].includes(command))
          ? 'volume'
          : ({ '/next': 'skip', '/q': 'queue', '/end': 'stop', '/vol': 'setvol', '/volume': 'setvol', '/repeat': 'loop', '/vc': 'player', '/rtmp': 'streammode' }[command] || command.slice(1));
        let ctrlArgs = (action === 'queue' && args.length && Number.isFinite(Number(args[0])) && Number(args[0]) >= 1)
          ? [Math.max(0, Math.floor(Number(args[0])) - 1)]
          : args;
        if (action === 'streammode') {
          const arg0 = String(args[0] || '').toLowerCase();
          if (['on', 'rtmp', 'lock', 'locked', 'broadcast'].includes(arg0)) ctrlArgs = ['rtmp'];
          else if (['off', 'vc', 'interactive', 'webrtc', 'mic'].includes(arg0)) ctrlArgs = ['interactive'];
          else if (command === '/rtmp' && !arg0) ctrlArgs = [];
        }
        const controlFirstActions = new Set(['resume', 'pause', 'skip', 'previous', 'seek', 'vcquality']);
        if (!isChan && controlFirstActions.has(action)) {
          const destId = await app.music.authorize(ctx, true, null, { allowDj: true });
          const preSess = app.musicQueueManager?.getSession?.(destId);
          const hadEndedOrMissing = Boolean(!preSess?.screenMessageId || preSess?.callEnded || !preSess?.connected);
          await app.music.control({ ...ctx, messageId: null, query: null }, action, ctrlArgs);
          const postSess = app.musicQueueManager?.getSession?.(destId);
          if (!postSess?.screenMessageId || hadEndedOrMissing) {
            const freshSess = await app.music.player({ ...channelPlayerCtx(), ...(hadEndedOrMissing ? { forceNew: true } : {}) });
            await adoptChannelPlayerResult(ctx, freshSess);
          } else {
            await app.musicQueueManager?.updatePlayerCard?.(destId, { forceEdit: true });
          }
        } else {
          const playerSession = await app.music.player(channelPlayerCtx());
          await adoptChannelPlayerResult(ctx, playerSession);
          ctx = { ...ctx, messageId: null, query: null };
          if (action !== 'player') await app.music.control(ctx, action, ctrlArgs);
        }
      }
    } catch (e) {
      const errCtx = (sentStatus?.message_id && !ctx.messageId)
        ? { ...ctx, messageId: sentStatus.message_id, _processingReplacedCard: true }
        : ctx;
      await error(errCtx, e);
    } finally {
      await triggerCleanup;
    }
    return true;
  }

  async function playlist(ctx, args) {
    const [action = 'list', ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    const key = `music.playlists.${ctx.tgId}`;
    const lists = app.db.getSetting(key, {});
    if (action === 'list') return ctx.api.sendMessage(ctx.chatId, Object.keys(lists).join('\n') || 'No saved playlists. /playlist save <name> saves the current queue.');
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new MusicError('PLAYLIST_NAME', 'Use a playlist name of 1–40 letters, numbers, spaces, underscores or hyphens.');
    if (action === 'save') {
      const destId = await app.music.authorize(ctx);
      const s = app.musicQueueManager.getSession(destId);
      if (Object.keys(lists).length >= 20 && !lists[name]) throw new MusicError('PLAYLIST_LIMIT', 'Keep up to 20 playlists.');
      lists[name] = [s.currentTrack, ...s.upcoming].filter(t => t && ['youtube', 'audius', 'music'].includes(t.provider)).slice(0, 50).map(({ id: tid, provider, providerId, title, artist, album, durationSeconds, artwork, sourceRef, mediaType, capabilities }) => ({ id: tid, provider, providerId, title, artist, album, durationSeconds, artwork, sourceRef, mediaType, capabilities }));
      app.db.setSetting(key, lists);
    } else if (action === 'delete') {
      delete lists[name];
      app.db.setSetting(key, lists);
    } else if (action === 'load') {
      const destId = await app.music.authorize(ctx, true);
      if (!lists[name]?.length) throw new MusicError('PLAYLIST_MISSING', 'That playlist is missing or empty.');
      await app.music.accounts.sync();
      await app.music.prepare?.(ctx, destId);
      await app.musicQueueManager.addMany(destId, lists[name]);
      await app.music.player(ctx, destId);
    } else {
      throw new MusicError('PLAYLIST_ACTION', 'Use /playlist list, save, load or delete.');
    }
    return ctx.api.sendMessage(ctx.chatId, `Playlist ${action} completed · ${name}`);
  }

  function musicText(ctx, value) {
    const text = String(value || '').trim();
    const chatPrefix = app.db?.getChatPrefix?.(ctx.chatId) || '/';
    const userPrefix = app.db?.getUserPrefix?.(ctx.tgId) || '/';
    const prefix = Number(ctx.chatId) < 0 ? chatPrefix : userPrefix !== '/' ? userPrefix : chatPrefix;
    if (prefix !== '/' && text.startsWith(prefix)) return '/' + text.slice(prefix.length).trim();
    if (prefix === '/' && /^[!.]/.test(text)) return '/' + text.slice(1).trim();
    return text;
  }

  async function handlePlayerReply(ctx, message) {
    const isChan = isChannelCtx(ctx);
    const replyMsg = message.reply_to_message;
    if (!message.text || !replyMsg) return false;
    const fromBot = replyMsg.from?.id === ctx.api?.me?.id;
    if (!fromBot && !isChan) return false;
    let source = ctx;
    if (Number(ctx.chatId) > 0) {
      if (!fromBot) return false;
      const record = app.music.channelPanels.replyPanel(ctx, message);
      if (!record) return false;
      try {
        const panel = await app.music.channelPanels.resolve({ ...ctx, messageId: record.screenMessageId }, record.panelToken);
        source = { ...ctx, musicPanel: panel };
      } catch (e) {
        await error(ctx, e);
        return true;
      }
    } else {
      const session = app.musicQueueManager?.sessions?.get(Number(ctx.chatId));
      if (!session || session.screenMessageId !== replyMsg.message_id) return false;
      if (!fromBot && !(isChan && !replyMsg.from)) return false;
    }

    const text = musicText(ctx, message.text);
    const [head, ...rest] = text.split(/\s+/);
    const command = head.split('@')[0].toLowerCase();
    if (head.startsWith('/') && head.includes('@') && head.split('@')[1].toLowerCase() !== ctx.api.me.username?.toLowerCase()) return false;

    let mode = 'queue';
    let query = text;
    if (['/play', '/song'].includes(command) || /^play\s+/i.test(text)) {
      mode = 'download';
      query = command.startsWith('/') ? rest.join(' ') : text.replace(/^play\s+/i, '');
      if (app.screens?.has('downloader') && query.trim()) {
        await app.screens.get('downloader').executeDownload(ctx, query.trim(), { forceMusicSearch: true, forceNew: true });
        return true;
      }
    } else if (['/addq', '/vplay', '/vcplay', '/stream', '/vc', '/vidc'].includes(command)) {
      mode = ['/vplay', '/vcplay', '/vidc'].includes(command) ? 'video' : (command === '/vc' ? defaultMediaMode(source.musicPanel || (isChan ? { isChannel: true } : null)) : 'queue');
      query = rest.join(' ');
    } else if (/^(?:add(?:\s+(?:track|song))?|queue)\s+/i.test(text)) {
      mode = 'queue';
      query = text.replace(/^(?:add(?:\s+(?:track|song))?|queue)\s+/i, '');
    } else if (/^(?:seek\s+|step\s+|[+-]\d+\s*(?:s|sec|m|min)?$|\d{1,2}:\d{2}(?::\d{2})?$)/i.test(text.trim())) {
      try {
        if (isChan) await deleteTriggerMessage(source, message);
        await app.music.customSeekInput(source, text.trim().replace(/^seek\s+/i, ''));
      } catch (e) {
        await error(ctx, e);
      }
      return true;
    } else if (command.startsWith('/')) {
      if (!channelCommands.has(command)) return false;
      try {
        await app.music.authorize(source, true);
        return await handleCommand(source, command, rest);
      } catch (e) {
        await error(ctx, e);
        return true;
      }
    } else if (/\b(?:what(?:'s|s|\s+is|\s+are)|who|how|why|trend|chart|bass|eq|recommend|suggest|vibe|mood|skip|pause|resume|stop|next|shuffle|repeat|loop|hello|hi|hey|dj|thanks|thank\s+you|that'?s\s+all|thats\s+all|perfect|done|sorted|bye|appreciate\s+it)\b|\?$/i.test(text.trim())) {
      try {
        if (isChan) await deleteTriggerMessage(source, message);
        await app.music.authorize(source, true, null, { allowDj: true });
        const pendingKey = app.sm?.get(ctx.tgId) ? ctx.tgId : (Number(ctx.chatId) < 0 ? String(ctx.chatId) : ctx.tgId);
        const pending = app.sm?.get(pendingKey);
        if (pending?.state === States.MUSIC_QUEUE_INPUT && pending.context.botKey === app.music.botKey(ctx) && Number(pending.chatId) === Number(ctx.chatId)) {
          if (isChan) pending.context.reusedInChannel = true;
          await app.sm.reset(pendingKey);
        }
        const reuseId = isChan ? reusableChannelSlotId(source) : null;
        const djCtx = reuseId ? { ...source, reuseMessageId: reuseId } : source;
        const res = await app.music.chatDjCommand(djCtx, text);
        if (isChan) {
          await adoptChannelPlayerResult(source, res?.session);
          if (res?.reply && (!res?.added?.length || !res?.session?.screenMessageId)) {
            const activeSession = app.musicQueueManager?.getSession?.(Number(source.chatId));
            const targetSlot = activeSession?.screenMessageId ? noticeMsgByChat : menuMsgByChat;
            await deliverChannelDjReply(source, targetSlot, res.reply, { trending: Boolean(res?.intent?.wantsTrending), ttlMs: res?.concluded ? 45000 : 120000 });
          }
        } else if (res?.reply) {
          await ctx.api.sendMessage(ctx.chatId, res.reply, {
            ...(message.message_id ? { reply_to_message_id: message.message_id } : {})
          }).catch(() => {});
        }
      } catch (e) {
        await error(ctx, e);
      }
      return true;
    } else {
      mode = isChan ? defaultMediaMode(source.musicPanel || { isChannel: true }) : 'queue';
    }

    try {
      if (mode !== 'download') await app.music.authorize(source, true);
      if (isChan) await deleteTriggerMessage(source, message);
      const pendingKey = app.sm?.get(ctx.tgId) ? ctx.tgId : (isChan && Number(ctx.chatId) < 0 ? String(ctx.chatId) : ctx.tgId);
      const pending = app.sm?.get(pendingKey);
      if (pending?.state === States.MUSIC_QUEUE_INPUT && pending.context.botKey === app.music.botKey(ctx) && Number(pending.chatId) === Number(ctx.chatId)) {
        if (isChan) pending.context.reusedInChannel = true;
        await app.sm.reset(pendingKey);
      }
      await search(source, query, mode);
    } catch (e) {
      await error(ctx, e);
    }
    return true;
  }

  const channelCommands = new Set([
    '/vidc', '/random', '/channel', '/destination', '/player', '/addq', '/vplay', '/vcplay',
    '/vc', '/stream', '/pause', '/resume', '/skip', '/voteskip', '/next', '/previous',
    '/stop', '/end', '/leave', '/queue', '/q', '/volume', '/vol', '/seek', '/eq', '/bass', '/streammode', '/rtmp', '/vcmsg',
    '/aidj', '/dj', '/movie', '/movies', '/moviesearch', '/movieai', '/mediaai',
    '/vcsudo', '/rmsudo', '/moviecast', '/moviebroadcast', '/moviealert', '/cinemaalert', '/movieannounce', '/autopoll', '/votes',
    '/schedule', '/boost', '/broadcastboost',
    '/repeat', '/loop', '/shuffle', '/playlist', '/lyrics', '/play', '/song',
    '/music', '/cancel'
  ]);

  function privateChannelRequest(ctx, source) {
    if (Number(ctx.chatId) <= 0 || Number(ctx.chatId) !== Number(ctx.tgId)) return false;
    if (!source.data && app.music.channelPanels?.replyPanel(ctx, source)) return true;
    if (source.data) {
      const d = decodeCallback(source.data);
      return d?.screen === 'music' && (['pc', 'listenq', 'mv', 'movie', 'moviehub', 'aichat', 'aiclose', 'calert', 'mcast'].includes(d.action) || app.music.destinations?.has(`${app.music.botKey(ctx)}:${ctx.tgId}`));
    }
    const pending = app.sm?.get?.(ctx.tgId);
    if (pending?.state === States.MUSIC_QUEUE_INPUT && pending.context.panelToken && pending.context.botKey === app.music.botKey(ctx) && Number(pending.chatId) === Number(ctx.chatId)) return true;
    if (pending?.state === States.AI_MEDIA_CHAT && pending.context?.panelToken && pending.context.botKey === app.music.botKey(ctx) && Number(pending.chatId) === Number(ctx.chatId)) return true;
    const command = musicText(ctx, source.text).split(/\s+/)[0]?.split('@')[0]?.toLowerCase();
    return Boolean(app.music.destinations?.has(`${app.music.botKey(ctx)}:${ctx.tgId}`) && (channelCommands.has(command) || [States.MUSIC_QUEUE_INPUT, States.AI_MEDIA_CHAT].includes(app.sm?.state(ctx.tgId))));
  }

  async function handlePrivateChannel(ctx, source) {
    if (!privateChannelRequest(ctx, source)) return false;
    if (!source.data && await handlePlayerReply(ctx, source)) return true;
    if (source.data) {
      const d = decodeCallback(source.data);
      if (!['pc', 'channels', 'ch', 'listenq', 'listennow', 'listenadd', 'mv', 'movie', 'moviehub', 'aichat', 'aiclose', 'calert', 'mcast'].includes(d.action)) {
        try {
          const session = ['pick', 'spage', 'sclear', 'submit', 'playnow_s', 'qnow'].includes(d.action) ? app.music.search.get(d.args[0], ctx) : null;
          await app.music.authorize(ctx, true, session && ['queue', 'video'].includes(session.mode) ? session.destination : null);
        } catch (e) {
          await error(ctx, e);
          return true;
        }
      }
      await handle(ctx, d.action, d.args);
      return true;
    }
    const [head, ...args] = musicText(ctx, source.text).split(/\s+/);
    const [command, targetBot] = head.split('@');
    if (targetBot && targetBot.toLowerCase() !== ctx.api.me?.username?.toLowerCase()) return false;
    if (['/channel', '/destination'].includes(command.toLowerCase())) return await handleCommand(ctx, command.toLowerCase(), args);
    const pending = app.sm?.get(ctx.tgId);
    const scopedInput = pending?.state === States.MUSIC_QUEUE_INPUT && pending.context.botKey === app.music.botKey(ctx) && Number(pending.chatId) === Number(ctx.chatId);
    if (scopedInput && command.toLowerCase() === '/cancel') {
      await app.sm.cancel(ctx.tgId);
      return true;
    }
    if (scopedInput && pending.context.mode === 'channel' && !command.startsWith('/')) return app.sm.handleMessage(ctx.tgId, source, ctx);
    // A ForceReply retains its original panel, not the most recently bound DM channel.
    if (scopedInput && pending.context.panelToken && !command.startsWith('/')) return app.sm.handleMessage(ctx.tgId, source, ctx);
    try { await app.music.authorize(ctx, true); } catch { return false; }
    if (channelCommands.has(command.toLowerCase())) return await handleCommand(ctx, command.toLowerCase(), args);
    if (!command.startsWith('/') && app.sm?.state(ctx.tgId) === States.MUSIC_QUEUE_INPUT) return app.sm.handleMessage(ctx.tgId, source, ctx);
    return false;
  }

  function registerStateHandlers(sm) {
    sm.register(States.MUSIC_QUEUE_INPUT, {
      onCleanup: async stateRecord => {
        if (stateRecord?.context?.reusedInChannel) return;
        const tok = stateRecord?.context?.temporaryToken;
        if (!tok) return;
        const promptId = stateRecord.context?.promptMessageId;
        const chanId = stateRecord.chatId;
        const bKey = stateRecord.context?.botKey;
        if (stateRecord.context?.isChannelPrompt && bKey != null && chanId != null) {
          const k = `${bKey}:${Number(chanId)}`;
          if (menuMsgByChat.get(k)?.messageId === promptId) menuMsgByChat.delete(k);
          if (noticeMsgByChat.get(k)?.messageId === promptId) noticeMsgByChat.delete(k);
        }
        await temporary.remove(tok).catch(() => {});
      },
      onMessage: async (ctx, message) => {
        const isChan = Boolean(ctx.isChannel || message.chat?.type === 'channel');
        const record = (isChan && Number(ctx.chatId) < 0 ? sm.get(String(ctx.chatId)) : null) || sm.get(ctx.tgId);
        if (!record?.context || Number(record.chatId) !== Number(ctx.chatId) || record.context.botKey !== app.music.botKey(ctx)) return false;
        const stateKey = record.context.stateKey || ((isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId);
        if (record.context.mode === 'channel') {
          try {
            const value = message.text || message.caption || '';
            const boundId = await app.music.bind({ ...ctx, message }, value);
            await sm.reset(stateKey);
            await channels(ctx);
            return Boolean(boundId) || true;
          } catch (e) {
            await error(ctx, e);
            return true;
          }
        }
        if (!message.text || (Number(ctx.chatId) < 0 && !isChan && message.reply_to_message?.message_id !== record.context.promptMessageId)) return false;
        if (isChan) await deleteTriggerMessage({ ...ctx, query: null, isChannel: true, message });
        const mode = record.context.mode;
        const panelToken = record.context.panelToken;
        try {
          const panel = panelToken ? await app.music.channelPanels.resolve(ctx, panelToken, { requireMessage: false }) : null;
          if (mode === 'radio') {
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
            const scoped = panel ? { ...ctx, musicPanel: panel } : ctx;
            const destId = await app.music.authorize(scoped, true);
            const qmSession = app.musicQueueManager.getSession(destId);
            const state = panel || qmSession;
            const customArtist = String(message.text).trim().slice(0, 120);
            state.radioCustom = customArtist;
            if (qmSession) qmSession.radioCustom = customArtist;
            state.view = 'player';
            const rich = renderGenreSubmenu(customArtist, defaultMediaMode(state), panelToken, true);
            if (panelToken) {
              const sent = await ctx.api.sendRichMessage(ctx.chatId, rich).catch(() => null);
              if (sent) app.music.channelPanels?.registerMessage?.(panelToken, sent.message_id);
            } else if (isChan) {
              await sendOrEditMenu({ ...ctx, query: null, isChannel: true, message }, rich).catch(() => null);
            } else {
              const sent = await ctx.api.sendRichMessage(ctx.chatId, rich).catch(() => null);
              if (sent && qmSession) {
                qmSession.screenMessageId = sent.message_id;
                qmSession.lastRender = null;
              }
            }
          } else if (mode === 'dj') {
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
            const baseCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
            if (isChan) {
              const reuseId = reusableChannelSlotId(ctx);
              const scoped = reuseId ? { ...baseCtx, reuseMessageId: reuseId } : baseCtx;
              const res = await app.music.chatDjCommand(scoped, message.text);
              await adoptChannelPlayerResult(ctx, res?.session);
              if (res?.reply && (!res?.added?.length || !res?.session?.screenMessageId)) {
                const activeSession = app.musicQueueManager?.getSession?.(Number(ctx.chatId));
                const targetSlot = activeSession?.screenMessageId ? noticeMsgByChat : menuMsgByChat;
                await deliverChannelDjReply(ctx, targetSlot, res.reply, { trending: Boolean(res?.intent?.wantsTrending), ttlMs: 120000 });
              }
            } else {
              const res = await app.music.chatDjCommand(baseCtx, message.text);
              if (res?.reply) {
                await ctx.api.sendMessage(ctx.chatId, res.reply, {
                  ...(message.message_id ? { reply_to_message_id: message.message_id } : {})
                }).catch(() => {});
              }
            }
          } else if (mode === 'seek') {
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
            const seekTargetCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
            await app.music.customSeekInput(seekTargetCtx, message.text);
          } else if (mode === 'movie_search') {
            const savedContext = { ...(record.context || {}) };
            if (panel) {
              panel.overlayView = 'movie';
              panel.overlayAt = Date.now();
              panel.lastRender = null;
            }
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
            const searchTargetCtx = panel
              ? { ...ctx, musicPanel: panel }
              : (isChan && savedContext.promptMessageId ? { ...ctx, reuseMessageId: savedContext.promptMessageId } : ctx);
            await movieUi.openMovieSearch(searchTargetCtx, message.text, {
              movieSid: savedContext.movieSid || null,
              sourceMode: savedContext.sourceMode || null,
              promptKind: savedContext.promptKind || null,
              originMessageId: message?.message_id ?? ctx.directMessageId ?? null,
              forceNewCard: Boolean(!isChan && !panel)
            });
          } else {
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
            await search(panel ? { ...ctx, musicPanel: panel } : ctx, message.text, mode);
          }
        } catch (e) {
          await sm.reset(stateKey);
          await error(ctx, e);
        }
        return true;
      }
    });

    sm.register(States.AI_MEDIA_CHAT, {
      onCleanup: async stateRecord => {
        if (stateRecord?.context?.reusedInChannel) return;
        const tok = stateRecord?.context?.temporaryToken;
        if (tok) await temporary.remove(tok).catch(() => {});
      },
      onMessage: async (ctx, message) => {
        const isChan = Boolean(ctx.isChannel || message.chat?.type === 'channel');
        const record = (isChan && Number(ctx.chatId) < 0 ? sm.get(String(ctx.chatId)) : null) || sm.get(ctx.tgId);
        if (!record?.context || Number(record.chatId) !== Number(ctx.chatId) || record.context.botKey !== app.music.botKey(ctx)) return false;
        const stateKey = record.context.stateKey || ((isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId);
        if (!message.text) return false;
        if (Number(ctx.chatId) < 0 && !isChan && record.context.promptMessageId && message.reply_to_message?.message_id !== record.context.promptMessageId) {
          // Allow tagged mentions too when handled via bot.js shouldHandleState, otherwise require reply to prompt/bot
          if (message.reply_to_message?.from?.id !== ctx.api?.me?.id && !new RegExp(`@${(ctx.api?.me?.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message.text)) {
            return false;
          }
        }
        if (isChan) await deleteTriggerMessage({ ...ctx, query: null, isChannel: true, message });
        try {
          const res = await movieUi.handleAiTurn(
            ctx,
            message.text,
            {
              defaultDomain: record.context.defaultDomain || 'auto',
              panelToken: record.context.panelToken || null,
              dest: record.context.destination || null
            }
          );
          if (res?.concluded || res?.action?.tool === 'conclude' || res?.action?.tool === 'search_movie' || res?.action?.tool === 'random_movie') {
            if (isChan) record.context.reusedInChannel = true;
            await sm.reset(stateKey);
          } else {
            record.expiresAt = Date.now() + 300000;
          }
        } catch (e) {
          await sm.reset(stateKey);
          await error(ctx, e);
        }
        return true;
      }
    });

    // Recover persisted legacy login flows safely; never accept or forward their secrets.
    for (const state of [States.ASSISTANT_AUTH_PHONE, States.ASSISTANT_AUTH_CODE, States.ASSISTANT_AUTH_2FA]) {
      sm.register(state, {
        onMessage: async (ctx, message) => {
          if (message.message_id) await ctx.api?.deleteMessage(ctx.chatId, message.message_id).catch(() => {});
          await sm.reset(ctx.tgId);
          await ctx.api?.sendMessage(ctx.chatId, 'Session setup now uses the protected local terminal. Never send login codes or passwords here.');
          return true;
        }
      });
    }
  }

  function renderCinemaPlayer(s) {
    const destId = s.destination || s.chatId;
    const destLabel = cut(s.destinationTitle || (s.isChannel ? 'Channel' : 'Voice Chat'), 42);
    const botUsername = String(s.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot').replace(/^@/, '');
    const badge = STATUS_BADGE[s.status] || '⚪ IDLE';
    const loopSuffix = s.loopMode === 'track' ? ' · 🔁 Repeat One' : s.loopMode === 'queue' ? ' · 🔁 Loop Queue' : '';
    const qShort = formatVcQualityShort({ ...s, activeDeck: 'movie' });
    const b = card(`🎬 LANCY MUSIC · ${s.isChannel ? 'CHANNEL CINEMA VC' : 'CINEMA VC'}`, `${badge} · ${destLabel}${loopSuffix}`);
    const t = s.currentTrack?.provider === 'movie' ? s.currentTrack : null;
    const movieQ = Array.isArray(s.movieUpcoming) ? s.movieUpcoming : [];
    const movieHist = Array.isArray(s.movieHistory) ? s.movieHistory : [];
    const musicQCount = Array.isArray(s.upcoming) ? s.upcoming.length : 0;
    const subMode = ['screen', 'live', 'vc', 'off'].includes(s.subtitleMode) ? s.subtitleMode : 'screen';
    const subText = subMode === 'screen' ? 'Screen Burn' : subMode === 'live' ? 'Live Chat' : subMode === 'vc' ? 'Burn + VC Chat' : 'Off';
    const skipNeed = app.music?.getSkipVoteThreshold?.(destId) ?? 2;
    const skipCount = Array.isArray(s.skipVotes) ? s.skipVotes.length : 0;

    const lastHist = (!t && !movieQ.length && (s.callEnded || (Number(s.lastKnownPositionSeconds) || 0) > 0) && movieHist.length) ? movieHist.at(-1) : null;
    const resumableItem = movieQ[0] || lastHist || null;
    const resumeSec = !t ? Number(resumableItem?.resumePositionSeconds || resumableItem?.startOffsetSeconds || s.lastKnownPositionSeconds || 0) : 0;
    const previewTrack = t || ((s.status === 'buffering' || resumeSec > 0 || movieQ.length > 0) ? resumableItem : null);
    const previewArt = previewTrack?.artwork || previewTrack?.poster || previewTrack?.backdrop || previewTrack?.thumbnailUrl || previewTrack?.thumb || null;
    const suppressGroupAdultArt = Boolean(previewTrack?.isAdult && Number(destId) < 0);
    attachSafeArtworkPhoto(b, suppressGroupAdultArt ? null : previewArt, previewTrack?.title || 'Cinema Artwork');

    const isMutedLive = Boolean(t && s.status === 'error' && s.connected && /Telegram muted|still blocks this account/i.test(String(s.lastError || '')));
    if (t) {
      b.paragraph(rt.bold(`${t.isAdult ? '🔞 ' : ''}${cut(t.title || 'Streaming Movie', 78)}`));
      const dur = Number(t.durationSeconds || t.durationSec || 0);
      const pos = Math.max(0, Number(Number.isFinite(s.positionSeconds) ? s.positionSeconds : (s.lastKnownPositionSeconds || 0)));
      if (dur > 0) {
        const ratio = safeProgressRatio(pos, dur);
        const remSec = Math.max(0, Math.round(dur - pos));
        const remLabel = remSec > 0 ? `  ·  -${durationText(remSec)}` : '  ·  Ending';
        b.paragraph(rt.text(`${progressBar(ratio, { width: 12, filled: '█', empty: '░' })}  ${durationText(pos)} / ${durationText(dur)}${remLabel}`));
      } else {
        b.paragraph(rt.text(`🔴 Live Cinema Stream${pos > 0 ? ` · ${durationText(pos)} elapsed` : ''}`));
      }
      const fallbackFormat = dur > 0 ? `${durationText(dur)} · Cinema` : 'Cinema HD';
      const cleanArtistMeta = t.artist && !/thenkiri|downloadwella|holaflix|archive|dramafren|ok\.ru|yt-dlp|web cinema|source/i.test(t.artist)
        ? t.artist
        : fallbackFormat;
      const vcDisplay = t?.title ? `${cut(t.title, 28)} · ${cut(destLabel, 20)}` : destLabel;
      const subOffset = Number(s.subtitleSyncOffset || 0) || 0;
      const offsetStr = subOffset ? ` (${subOffset > 0 ? `+${subOffset}` : subOffset}s)` : '';
      const subTracks = Array.isArray(t.subtitleTracks) ? t.subtitleTracks : [];
      const curSubTrack = subTracks[Math.max(0, Number(s.subtitleTrackIndex || 0))] || null;
      const sameRouteSub = Boolean(curSubTrack?.sameRoute || ['embedded', 'subtitle_hint'].includes(curSubTrack?.source) || t.subtitleSameRoute);
      const syncTag = !t.subtitlePath
        ? ''
        : sameRouteSub
          ? ' · Same-Stream'
          : s.subtitleAutoOffset
            ? ' · Auto-Aligned'
            : s.subtitleAutoVerified
              ? ' · Verified'
              : ' · External';
      const trackBadge = curSubTrack?.label && subTracks.length > 1
        ? ` · ${cut(curSubTrack.label, 18)} (${Math.max(0, Number(s.subtitleTrackIndex || 0)) + 1}/${subTracks.length})`
        : '';
      const syncStateTag = s.status === 'paused'
        ? ' · ⏸ Paused'
        : isMutedLive
          ? ' · 🔇 Muted in VC'
          : s.avSync?.sync_health === 'stalled'
          ? ' · ⚠️ Resyncing A/V'
          : s.avSync?.syncing
            ? ` · ⏳ Syncing A/V (${Number(s.avSync?.skew_ms || 0) >= 0 ? '+' : ''}${Number(s.avSync?.skew_ms || 0)}ms)`
            : s.avSync?.monitored
              ? ' · ✅ A/V Synced'
              : '';
      const origLangCode = String(t.originalLanguage || '').trim().toUpperCase();
      const actLangCode = String(t.audioLanguage || '').trim().toUpperCase();
      const langMismatch = Boolean(origLangCode && actLangCode && origLangCode !== actLangCode);
      const audioDisplay = t.dubOnlyWarning
        ? (t.dubOnlyWarning === '⚠️ Dub Only Available' && langMismatch ? `⚠️ Dub Only Available (${actLangCode})` : t.dubOnlyWarning)
        : (t.audioIsDub || langMismatch)
          ? `⚠️ Dub Only Available${actLangCode ? ` (${actLangCode})` : ''}`
          : actLangCode
            ? `Original (${actLangCode})`
            : null;
      const liveSyncBadge = t.subtitlePath && s.subtitleSyncStatus?.status
        ? ` · ${formatSubSyncSummary(s, t).badge}`
        : '';
      const metaRows = [
        ['🎬 Now Playing', cut(t.title || 'Movie Stream', 44)],
        ['🎙️ Voice Chat', vcDisplay],
        ['🤖 Bot', `Lancy Music (@${botUsername})`],
        ['🎞 Quality', `${qShort} · ${cut(cleanArtistMeta, 24)}${s.streamMode === 'rtmp' ? ' · 🔒 RTMP Locked A/V' : ' · 🎙 Interactive VC'}${syncStateTag}`],
        ...(audioDisplay ? [['🔊 Audio', audioDisplay]] : []),
        ['💬 Subtitles', `${subText}${trackBadge}${syncTag}${liveSyncBadge}${offsetStr}`],
        ['🎞 Cinema Queue', `${movieQ.length} up next · ⏭ Vote ${skipCount}/${skipNeed}`]
      ];
      if (t.requester) metaRows.push(['🙋 Requested by', cut(t.requester, 32)]);
      b.table(metaRows, { striped: true, bordered: true, compact: true });
      if (subMode === 'live' && s.liveSubCue) {
        b.pullquote(cut(s.liveSubCue, 240), '💬 Live Subtitle');
      } else if (movieQ[0]?.title) {
        b.pullquote(cut(movieQ[0].title, 68), `⏭ Up Next (#1/${movieQ.length})`);
      }
    } else {
      const vcIdleDisplay = (resumeSec > 0 && resumableItem?.title)
        ? `${cut(resumableItem.title, 28)} · ${cut(destLabel, 20)}`
        : destLabel;
      b.table([
        ['🎙️ Voice Chat', vcIdleDisplay],
        ['🤖 Bot', `Lancy Music (@${botUsername})`],
        ['🎞 Quality & Mode', `${qShort} · ${s.streamMode === 'rtmp' ? '🔒 RTMP Locked A/V' : '🎙 Interactive VC'}`],
        ['🎞 Cinema Queue', `${movieQ.length} up next`]
      ], { striped: true, bordered: true, compact: true });
      b.pullquote(
        resumableItem
          ? (resumeSec > 0
              ? `Saved at ${durationText(resumeSec)} · ${cut(resumableItem?.title || 'Current item', 40)}. Tap ▶ Resume to continue where it stopped.`
              : `Cinema deck is ready (${movieQ.length || 1} ready). Tap ▶ Resume to start streaming in Voice Chat.`)
          : 'No movie or episode is currently playing in Cinema VC. Tap 🎬 Movies to search & stream.',
        resumeSec > 0 ? '⏸ Saved Position' : '🍿 Cinema Standby'
      );
    }

    if (s.lastError) b.blockquote(rt.text(`⚠ ${cut(s.lastError, 240)}`));
    else if (s.lastNotice) b.blockquote(rt.text(`ℹ️ ${cut(s.lastNotice, 240)}`));

    const seekStep = Number(s.seekStepSeconds) >= 5 ? Math.round(Number(s.seekStepSeconds)) : 30;
    const stepLabel = seekStep >= 60 && seekStep % 60 === 0 ? `${seekStep / 60}m` : `${seekStep}s`;

    // Row 1: Dedicated Seek & Pause/Resume Row (isolated at top — far away from ⏭ Next & ⏹ Stop to prevent misclicks on rapid tap)
    const row1 = [];
    if (t?.capabilities?.seek) {
      row1.push(controls(s, `-${stepLabel}`, 'seekby', -seekStep, { style: 'link' }));
    }
    if (t || resumableItem) {
      if (isMutedLive) {
        row1.push(
          controls(s, '🔊 Unmute VC', 'resume', { style: 'success' }),
          controls(s, '⏸ Pause', 'pause', { style: 'primary' })
        );
      } else {
        row1.push(controls(s, (s.status === 'paused' || (!t && resumeSec > 0)) ? '▶ Resume' : t ? '⏸ Pause' : '▶ Start Next', (s.status === 'paused' || !t) ? 'resume' : 'pause', { style: (!t || s.status === 'paused') ? 'success' : 'primary' }));
      }
    }
    if (t?.capabilities?.seek) {
      row1.push(controls(s, `+${stepLabel}`, 'seekby', seekStep, { style: 'link' }));
      row1.push(controls(s, '⏱ Custom s', 'seekmenu', { style: 'link' }));
    }
    if (row1.length) b.buttons(row1);

    // Row 2: Track Navigation, Volume & Download
    const row2 = [];
    if (movieHist.length) row2.push(controls(s, '⏮ Prev', 'previous', { style: 'link' }));
    if (movieQ.length) row2.push(controls(s, '⏭ Next', 'skip', { style: 'link' }));
    row2.push(controls(s, `🔊 ${s.volume ?? 100}%`, 'volume', { style: 'link' }));
    if (t) {
      row2.push(controls(s, '⬇ Download', 'downloadnow', { style: 'success' }));
    }
    b.buttons(row2);

    // Row 3: Queue, Movies, Audio Language, Subtitle Sync & Poll
    const row3 = [
      controls(s, `🗳 Queue (${movieQ.length})`, 'mqueue', 0, { style: 'primary' }),
      controls(s, '🎬 Movies', 'movie', { style: 'primary' })
    ];
    if (t) {
      const aVars = Array.isArray(t.audioVariants) ? t.audioVariants : [];
      const aCode = String(t.audioLanguage || t.originalLanguage || '').trim().toUpperCase();
      const aBtnLbl = aVars.length > 1
        ? `🔊 Audio (${aCode || aVars.length})`
        : (aCode ? `🔊 Audio (${aCode})` : '🔊 Audio');
      row3.push(controls(s, aBtnLbl, 'audiolang', { style: aVars.length > 1 ? 'primary' : 'link' }));
      row3.push(controls(s, '⏱ Sync', 'subsync', { style: (Array.isArray(t.subtitleTracks) && t.subtitleTracks.length > 1) ? 'primary' : 'link' }));
    }
    b.buttons(row3);

    // Row 4: SubMode, Anti-Lag Quality Tier, Source Switch & Poll
    const row4 = [
      controls(s, `💬 ${subText}`, 'submode', { style: 'link' }),
      controls(s, `🎞 ${qShort}`, 'vcquality', { style: s.vcQuality === 'HD_720p' ? 'success' : 'primary' })
    ];
    if (t && ['playing', 'paused', 'buffering'].includes(s.status)) {
      const srcPool = Array.isArray(t._sourcePool) && t._sourcePool.length ? t._sourcePool : null;
      const srcPoolIdx = srcPool ? srcPool.findIndex((p) => p?.url && p.url === t.streamUrl) : -1;
      const labelMatch = String(t.sourceLabel || '').match(/Source\s+(\d+)/i);
      const srcTotal = srcPool
        ? srcPool.length
        : ((t.streamUrl ? 1 : 0) + (Array.isArray(t.fallbackStreams) ? t.fallbackStreams.filter((x) => x?.url && x.url !== t.streamUrl).length : 0));
      const srcNum = srcPoolIdx >= 0
        ? (srcPoolIdx + 1)
        : (labelMatch ? Number(labelMatch[1]) : (Number.isInteger(t.activeSourceIndex) ? (t.activeSourceIndex + 1) : 1));
      const srcBtnLabel = srcTotal > 1 ? `📡 Source ${srcNum}/${srcTotal}` : '📡 Alt Source';
      row4.push(controls(s, srcBtnLabel, 'switchsource', { style: 'link' }));
    }
    row4.push(controls(s, s.activePoll ? '📊 Live Poll' : '📊 Poll', 'launchpoll', { style: s.activePoll ? 'success' : 'link' }));
    if (t && ['playing', 'paused'].includes(s.status) && !s.isChannel && s.streamMode !== 'rtmp' && app.settings?.get?.('cinema.dualAssistantSubTilesEnabled') === true) {
      row4.push(controls(s, s.secondaryTile ? '👁 Tile: ON' : '👁 Sub Tile', 'dualtile', { style: s.secondaryTile ? 'success' : 'link' }));
    }
    b.buttons(row4);

    // Row 5: Vote, Loop, Votes Settings, Boost & Options
    const row5 = [];
    if (t && ['playing', 'paused'].includes(s.status) && !s.isChannel) {
      row5.push(controls(s, `⏭ Vote (${skipCount}/${skipNeed})`, 'voteskip', { style: 'link' }));
      if (app.settings?.get?.('cinema.starsEnabled') !== false) {
        row5.push(controls(s, '📣 Boost', 'boostmenu', String(s.chatId), { style: 'link' }));
      }
    }
    row5.push(controls(s, `🔁 ${s.loopMode === 'off' ? 'Loop' : s.loopMode === 'track' ? 'One' : 'All'}`, 'loop', { style: 'link' }));
    row5.push(controls(s, '🗳 Votes', 'voteset', { style: 'link' }));
    row5.push(controls(s, '⚙ Options', 'options', { style: 'link' }));
    b.buttons(row5);

    const identityRow = [];
    const vcBtn = joinCallButton(s);
    if (vcBtn) identityRow.push(vcBtn);
    identityRow.push(richButton.url('🤖 Lancy Music', `https://t.me/${botUsername}`, { style: 'link' }));
    b.buttons(identityRow);

    // Bottom Row: Deck Switch, Stream Engine Toggle, Always-Visible Pin & Stop
    const deckRow = [
      controls(s, `🎵 Music Player${musicQCount ? ` (${musicQCount})` : ''}`, 'switchdeck', 'music', { style: 'link' }),
      controls(s, s.streamMode === 'rtmp' ? '🔒 RTMP Live' : '🎙 Interactive VC', 'streammode', { style: s.streamMode === 'rtmp' ? 'success' : 'primary' }),
      controls(s, s.pinned ? '📍 Pinned' : '📌 Pin', 'pin', { style: s.pinned ? 'link' : 'primary' })
    ];
    if (s.isChannel && s.panelToken) deckRow.push(controls(s, '🔀 Channels', 'channels', { style: 'link' }));
    if (t || s.connected) deckRow.push(controls(s, '⏹ Stop', 'stop', { style: 'danger' }));
    b.buttons(deckRow);
    b.expandableBlockquote(buildVcInstructionsGuide(s, { cinema: true }));

    return finish(b);
  }

  function renderMovieQueue(s, page = 0) {
    const destId = s.destination || s.chatId;
    const movieQ = Array.isArray(s.movieUpcoming) ? s.movieUpcoming : [];
    const totalPages = Math.max(1, Math.ceil(movieQ.length / 5));
    const p = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
    const destLabel = cut(s.destinationTitle || (s.isChannel ? 'Channel' : 'Group'), 42);
    const botUsername = String(s.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot').replace(/^@/, '');
    const queueNeed = app.music?.getQueueVoteThreshold?.(destId) ?? 2;
    const b = card(`LANCY MUSIC · CINEMA QUEUE`, `${destLabel} · ${movieQ.length} up next · Page ${p + 1}/${totalPages}`);
    const t = s.currentTrack?.provider === 'movie' ? s.currentTrack : null;
    b.paragraph(rt.text(t ? `▶ Now Streaming: ${cut(t.title, 65)}` : `⚪ Cinema VC idle · 🤖 @${botUsername}`));
    const slice = movieQ.slice(p * 5, p * 5 + 5);
    if (!slice.length) {
      b.blockquote(rt.text('Cinema queue is empty. Search any movie or TV series and tap ➕ Add to Queue!'));
    } else {
      const lines = slice.map((item, idx) => {
        const n = p * 5 + idx + 1;
        const dur = Number(item.durationSeconds) > 0 ? ` (${durationText(item.durationSeconds)})` : '';
        const vCount = Array.isArray(item.votes) ? item.votes.length : 0;
        return `${n}. ${cut(item.title, 48)}${dur} · 🗳 ${vCount}/${queueNeed}`;
      });
      b.blockquote(rt.text(lines.join('\n')));
      for (let i = 0; i < slice.length; i++) {
        const item = slice[i];
        const n = p * 5 + i + 1;
        const vCount = Array.isArray(item.votes) ? item.votes.length : 0;
        b.buttons([
          controls(s, `▶ #${n}`, 'mplaynow', item.entryId, { style: 'primary' }),
          controls(s, `⬇ #${n}`, 'downloadq', item.entryId, { style: 'success' }),
          controls(s, `🗳 ${vCount}/${queueNeed}`, 'votequeue', item.entryId),
          controls(s, `🗑 #${n}`, 'mremove', item.entryId, { style: 'danger' })
        ]);
      }
    }
    if (totalPages > 1) {
      const pagRow = [];
      if (p > 0) pagRow.push(controls(s, '◀ Prev', 'mqpage', p - 1));
      if (p < totalPages - 1) pagRow.push(controls(s, 'Next ▶', 'mqpage', p + 1));
      if (pagRow.length) b.buttons(pagRow);
      if (totalPages > 2) {
        const jumpRow = [];
        if (p > 1) jumpRow.push(controls(s, '⏮ 1', 'mqpage', 0));
        if (p >= 10) jumpRow.push(controls(s, '◀◀ -10', 'mqpage', Math.max(0, p - 10)));
        if (p + 10 < totalPages) jumpRow.push(controls(s, '+10 ▶▶', 'mqpage', Math.min(totalPages - 1, p + 10)));
        if (p < totalPages - 2) jumpRow.push(controls(s, `⏭ ${totalPages}`, 'mqpage', totalPages - 1));
        if (jumpRow.length) b.buttons(jumpRow);
      }
    }
    if (movieQ.length) {
      const autoPoll = app.music?.isAutoPollEnabled?.(destId) ?? true;
      b.buttons([
        controls(s, s.activePoll ? '📊 Live Poll' : '📊 Viewer Poll', 'launchpoll', { style: s.activePoll ? 'success' : 'primary' }),
        controls(s, autoPoll ? '🤖 Auto-Poll · ON' : '🤖 Auto-Poll · OFF', 'autopoll', autoPoll ? 'off' : 'on', { style: autoPoll ? 'success' : 'link' }),
        controls(s, `⚙ Vote Limit (${queueNeed})`, 'voteset')
      ]);
    }
    const navRow = [
      controls(s, '🎬 Search / Queue', 'movie', { style: 'primary' }),
      ...(movieQ.length ? [controls(s, '🗑 Clear', 'mclear', { style: 'danger' })] : []),
      controls(s, '◀ Cinema', 'player')
    ];
    b.buttons(navRow);
    return finish(b);
  }

  function renderDeckPlayer(s) {
    if (s?.view === 'mqueue') return renderMovieQueue(s, s.page || 0);
    if (s?.view === 'voteset') return renderVoteSettings(s);
    if (s?.view === 'audiolang') return renderAudioLangPicker(s);
    if (s?.view === 'subsync') return renderSubSyncPicker(s);
    if (s?.view === 'seekmenu') return renderSeekPicker(s);
    if (s?.view === 'djdesk') return renderDjDesk(s);
    if (s?.view === 'dlq') return renderCinemaDownloadQuality(s);
    if (s?.activeDeck === 'movie' || s?.view === 'cinema' || (s?.currentTrack?.provider === 'movie' && s?.view !== 'queue')) {
      return renderCinemaPlayer(s);
    }
    return renderPlayer(s);
  }

  return {
    id,
    renderHome,
    renderListen,
    renderOptions,
    renderVoteSettings,
    renderAudioLangPicker,
    renderSubSyncPicker,
    renderSeekPicker,
    renderDjDesk,
    renderCinemaDownloadQuality,
    renderPlayer: renderDeckPlayer,
    renderMusicPlayer: renderPlayer,
    renderCinemaPlayer,
    renderMovieQueue,
    renderQueue: (s, page = 0) => (s?.activeDeck === 'movie' || s?.view === 'mqueue') ? renderMovieQueue(s, page) : renderQueue(s, page),
    renderVolumePicker,
    renderRadio,
    renderCategoryPicker,
    renderGenreSubmenu,
    renderChannels,
    renderSearch,
    renderLyrics,
    renderAccounts,
    renderSessionSetupNotice,
    renderAssistantSessionStatus,
    registerStateHandlers,
    handle,
    handleCommand,
    handlePlayerReply,
    privateChannelRequest,
    handlePrivateChannel,
    search,
    movieUi,
    isBotMessageId(chatId, messageId) {
      const numChat = Number(chatId);
      const numMsg = Number(messageId);
      if (!Number.isFinite(numChat) || !Number.isFinite(numMsg)) return false;
      for (const [key, entry] of menuMsgByChat.entries()) {
        if (key.endsWith(`:${numChat}`) && Number(entry?.messageId) === numMsg) return true;
      }
      for (const [key, entry] of noticeMsgByChat.entries()) {
        if (key.endsWith(`:${numChat}`) && Number(entry?.messageId) === numMsg) return true;
      }
      if (Number(app.musicQueueManager?.getSession?.(numChat)?.screenMessageId) === numMsg) return true;
      return false;
    },
    cleanup: async () => {
      noticeMsgByChat.clear();
      menuMsgByChat.clear();
      await temporary.shutdown();
    },
    async open(ctx) {
      return ctx.api.sendRichMessage(ctx.chatId, renderHome(ctx));
    }
  };
}
