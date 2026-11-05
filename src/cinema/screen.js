import { RichMessageBuilder, rt, richButton, encodeCallback } from '../telegram/rich.js';
import { banner, ACCENT, SPARK } from '../telegram/ui.js';
import { States } from '../core/stateMachine.js';
import { logger } from '../core/logger.js';

function makeProgressBar(current, total, width = 10) {
  if (!total || total <= 0) return '🔴 [LIVE STREAM]';
  const progress = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(progress * width);
  const empty = width - filled;
  const pct = Math.round(progress * 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

export function createCinemaScreen({ app }) {
  const id = 'cinema';
  const log = logger().child({ module: 'screen:cinema' });

  function renderMainMenu(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🎬 PAPPY CINEMA • STREAMING HUB',
      'channel-aware movie & tv series streaming'
    ])));
    b.divider();

    const destinations = app.cinemaDestinations.getDestinationsForUser(ctx.tgId);

    if (destinations.length === 0) {
      b.quote(rt.concat(
        rt.bold('✨ Welcome to PAPPY Cinema!\n\n'),
        rt.text('Stream full-length movies, anime, and TV series live into your Telegram channels and group voice chats with synced community voting, auto-episodes, and real-time remote controls.\n\n'),
        rt.italic('To get started, tap "➕ Add Destination" below to connect your Channel or Group.')
      ));
    } else {
      b.quote(rt.bold(`📡 Registered Destinations (${destinations.length}):\n`));
      for (const dest of destinations) {
        const typeIcon = dest.chatType === 'channel' ? '📢' : '👥';
        const session = app.cinemaPlayback.getCurrentSession(dest.chatId);
        const statusText = session
          ? (session.state === 'PLAYING' ? `▶️ Now: ${session.title}` : `⏸️ Paused: ${session.title}`)
          : '⚪ Idle';

        b.paragraph(rt.concat(
          rt.bold(`${typeIcon} ${dest.title}\n`),
          rt.text(`  • Type: ${dest.chatType} | Role: ${dest.userRole}\n`),
          rt.text(`  • Status: ${statusText}\n`)
        ));
      }
    }

    b.divider();
    b.heading('୨୧ destinations & controls', 3);

    // List destination buttons with active playback status indicator
    for (const dest of destinations.slice(0, 5)) {
      const session = app.cinemaPlayback.getCurrentSession(dest.chatId);
      const isPlaying = session?.state === 'PLAYING';
      const isPaused = session?.state === 'PAUSED';
      const statusIcon = isPlaying ? '▶️' : (isPaused ? '⏸️' : '⚙️');
      const streamHint = session ? ` (${session.title.slice(0, 8)})` : '';
      const buttonLabel = `${statusIcon} ${dest.title.slice(0, 14)}${streamHint}`;
      const miniAppUrl = app.cinemaDestinations.getMiniAppUrl(app.cinemaDestinations.generateToken(dest.chatId));
      b.buttons([
        richButton.callback(buttonLabel, encodeCallback(id, 'select', dest.chatId)),
        { text: rt.text('🍿 Open Cinema'), web_app: { url: miniAppUrl }, style: 'success' }
      ]);
    }

    b.buttons([
      richButton.callback('➕ Add Destination', encodeCallback(id, 'add_prompt'), { style: 'primary' }),
      richButton.callback('🔄 Refresh Status', encodeCallback(id, 'refresh_all'))
    ]);

    b.buttons([
      richButton.callback('« Back to Menu', encodeCallback('dashboard', 'open'))
    ]);

    b.footer(rt.italic('PAPPY ×͜× Cinema Engine • High-Fidelity Streaming ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderDestinationDetail(ctx, dest) {
    const b = new RichMessageBuilder();
    const typeIcon = dest.chatType === 'channel' ? '📢' : '👥';

    b.paragraph(rt.bold(banner([
      `🎬 ${dest.title.toUpperCase()}`,
      `managed cinema destination`
    ])));
    b.divider();

    const session = app.cinemaPlayback.getCurrentSession(dest.chatId);
    const rights = dest.rights || {};

    const info = [
      `• Chat ID: ${dest.chatId}`,
      `• Type: ${typeIcon} ${dest.chatType}`,
      `• Admin Rights: ${rights.canManageVideoChats ? '✅ Video Chat' : '❌ Video Chat'}, ${dest.chatType === 'channel' ? (rights.canPostMessages ? '✅ Post' : '❌ Post') : (rights.canPinMessages ? '✅ Pin' : '❌ Pin')}`,
      `• Community Voting: ${dest.votingEnabled ? '🟢 Enabled' : '🔴 Disabled'}`,
      `• Stream Status: ${session ? session.state : 'IDLE'}`
    ];

    if (session) {
      info.push(`• Current Title: 🎬 ${session.title}`);
      if (session.season && session.episode) {
        info.push(`• Episode: S${String(session.season).padStart(2, '0')}E${String(session.episode).padStart(2, '0')}`);
      }
      if (session.duration > 0) {
        const curMin = Math.floor((session.position || 0) / 60);
        const curSec = String(Math.floor((session.position || 0) % 60)).padStart(2, '0');
        const totMin = Math.floor(session.duration / 60);
        const totSec = String(Math.floor(session.duration % 60)).padStart(2, '0');
        info.push(`• Progress: ${makeProgressBar(session.position || 0, session.duration)} (${curMin}:${curSec} / ${totMin}:${totSec})`);
      }
    }

    b.quote(rt.text(info.join('\n')));
    b.divider();

    const miniAppUrl = app.cinemaDestinations.getMiniAppUrl(app.cinemaDestinations.generateToken(dest.chatId));

    b.buttons([
      { text: rt.text('🍿 Open Cinema Mini App'), web_app: { url: miniAppUrl }, style: 'success' }
    ]);

    if (session) {
      b.buttons([
        richButton.callback('🎛️ Live Remote', encodeCallback(id, 'remote', dest.chatId), { style: 'primary' }),
        richButton.callback('📜 View Queue', encodeCallback(id, 'queue', dest.chatId))
      ]);
    } else {
      b.buttons([
        richButton.callback('📜 View Queue', encodeCallback(id, 'queue', dest.chatId))
      ]);
    }

    b.buttons([
      richButton.callback(dest.votingEnabled ? '🗳️ Disable Voting' : '🗳️ Enable Voting', encodeCallback(id, 'toggle_voting', dest.chatId)),
      richButton.callback('🔄 Re-verify', encodeCallback(id, 'reverify', dest.chatId))
    ]);

    b.buttons([
      richButton.callback('❌ Remove Destination', encodeCallback(id, 'remove_confirm', dest.chatId), { style: 'destructive' }),
      richButton.callback('« Back', encodeCallback(id, 'open'))
    ]);

    b.footer(rt.italic('Verified destination security boundary ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderRemoteControl(ctx, dest, session) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🎛️ CINEMA REMOTE CONTROL',
      session.title || 'Live Stream'
    ])));
    b.divider();

    const pos = Math.round(session.position || 0);
    const dur = Math.round(session.duration || 0);
    const posStr = `${Math.floor(pos / 60)}:${String(pos % 60).padStart(2, '0')}`;
    const durStr = dur > 0 ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}` : 'Live';

    b.quote(rt.concat(
      rt.bold(`🎬 ${session.title}\n`),
      session.season && session.episode ? rt.text(`📺 Season ${session.season} • Episode ${session.episode}\n`) : '',
      rt.text(`⏱️ Timeline: ${posStr} / ${durStr} (${session.state})\n`),
      rt.italic('Controls affect the live voice chat stream directly in real-time.')
    ));
    b.divider();

    // Double-tap fast forward / rewind controls
    b.buttons([
      richButton.callback('⏪ -30s', encodeCallback(id, 'seek_delta', dest.chatId, '-30')),
      richButton.callback('◀️ -10s', encodeCallback(id, 'seek_delta', dest.chatId, '-10')),
      session.state === 'PLAYING'
        ? richButton.callback('⏸️ Pause', encodeCallback(id, 'pause', dest.chatId))
        : richButton.callback('▶️ Resume', encodeCallback(id, 'resume', dest.chatId)),
      richButton.callback('+10s ▶️', encodeCallback(id, 'seek_delta', dest.chatId, '10')),
      richButton.callback('+30s ⏩', encodeCallback(id, 'seek_delta', dest.chatId, '30'))
    ]);

    b.buttons([
      richButton.callback('⏭️ Skip Intro (+85s)', encodeCallback(id, 'seek_delta', dest.chatId, '85'), { style: 'primary' }),
      richButton.callback('⏹️ Stop Stream', encodeCallback(id, 'stop', dest.chatId), { style: 'destructive' })
    ]);

    b.buttons([
      richButton.callback('🔄 Refresh Remote', encodeCallback(id, 'remote', dest.chatId)),
      richButton.callback('« Back to Details', encodeCallback(id, 'select', dest.chatId))
    ]);

    b.footer(rt.italic('Authoritative server playback clock ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderQueue(ctx, dest) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '📜 CINEMA PLAYLIST QUEUE',
      dest.title
    ])));
    b.divider();

    const items = app.cinemaQueue.getQueue(dest.chatId);

    if (items.length === 0) {
      b.quote(rt.text('The queue is currently empty.\nBrowse titles in the Cinema Mini App and tap "Add to Queue" to build your lineup.'));
    } else {
      let text = `<b>Upcoming Queue (${items.length}):</b>\n\n`;
      for (const item of items.slice(0, 10)) {
        const epInfo = item.season && item.episode ? ` (S${item.season}E${item.episode})` : '';
        text += `${item.position}. 🎬 <b>${item.title}</b>${epInfo}\n`;
      }
      b.quote(rt.text(text));
    }

    b.divider();
    b.buttons([
      richButton.callback('🗑️ Clear Queue', encodeCallback(id, 'clear_queue', dest.chatId), { style: 'destructive' }),
      richButton.callback('« Back to Details', encodeCallback(id, 'select', dest.chatId))
    ]);

    b.footer(rt.italic('Deterministic queue priority sequence ♡'));
    b.validate();
    return b.toJSON();
  }

  return {
    id,
    async open(ctx) {
      return ctx.editScreen(renderMainMenu(ctx));
    },

    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
        case 'refresh_all':
          return ctx.editScreen(renderMainMenu(ctx));

        case 'add_prompt': {
          await ctx.sm?.transition(ctx.tgId, States.CINEMA_DESTINATION_INPUT);
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '➕ CONNECT DESTINATION',
            'register channel or group'
          ])));
          b.divider();
          b.quote(rt.concat(
            rt.bold('📌 How to connect your Channel or Group:\n\n'),
            rt.text('1. Add @' + (ctx.api?.me?.username || 'Lancy_easy_bot') + ' to your channel or group.\n'),
            rt.text('2. Promote the bot to Administrator with "Manage Video Chats" permission.\n'),
            rt.text('3. Send the public @username, chat invite link, or numeric chat ID below:\n\n'),
            rt.italic('(Send /cancel to return to main menu)')
          ));
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'open'))
          ]);
          b.validate();
          return ctx.editScreen(b.toJSON());
        }

        case 'select': {
          const chatId = Number(args[0]);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          if (!dest) return ctx.editScreen(renderMainMenu(ctx));
          return ctx.editScreen(renderDestinationDetail(ctx, dest));
        }

        case 'remote': {
          const chatId = Number(args[0]);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          if (!dest) return ctx.editScreen(renderMainMenu(ctx));
          const session = app.cinemaPlayback.getCurrentSession(chatId);
          if (!session) {
            await ctx.answerCallback?.('No active stream playing right now.');
            return ctx.editScreen(renderDestinationDetail(ctx, dest));
          }
          return ctx.editScreen(renderRemoteControl(ctx, dest, session));
        }

        case 'seek_delta': {
          const chatId = Number(args[0]);
          const delta = parseFloat(args[1] || '10');
          const session = app.cinemaPlayback.getCurrentSession(chatId);
          if (!session) {
            return ctx.answerCallback?.('No active stream.');
          }
          const target = Math.max(0, (session.position || 0) + delta);
          await app.cinemaPlayback.seek(chatId, target);
          await ctx.answerCallback?.(`Seeked to ${Math.floor(target / 60)}:${String(Math.floor(target % 60)).padStart(2, '0')}`);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          const updatedSession = app.cinemaPlayback.getCurrentSession(chatId);
          return ctx.editScreen(renderRemoteControl(ctx, dest, updatedSession || session));
        }

        case 'pause': {
          const chatId = Number(args[0]);
          await app.cinemaPlayback.pause(chatId);
          await ctx.answerCallback?.('Stream paused.');
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          const session = app.cinemaPlayback.getCurrentSession(chatId);
          return ctx.editScreen(renderRemoteControl(ctx, dest, session));
        }

        case 'resume': {
          const chatId = Number(args[0]);
          await app.cinemaPlayback.resume(chatId);
          await ctx.answerCallback?.('Stream resumed.');
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          const session = app.cinemaPlayback.getCurrentSession(chatId);
          return ctx.editScreen(renderRemoteControl(ctx, dest, session));
        }

        case 'stop': {
          const chatId = Number(args[0]);
          await app.cinemaPlayback.stop(chatId);
          await ctx.answerCallback?.('Stream stopped.');
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          return ctx.editScreen(renderDestinationDetail(ctx, dest));
        }

        case 'toggle_voting': {
          const chatId = Number(args[0]);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          if (dest) {
            const next = !dest.votingEnabled;
            app.cinemaDestinations.toggleVoting(chatId, next);
            await ctx.answerCallback?.(next ? 'Community voting enabled!' : 'Community voting disabled.');
            const updated = app.cinemaDestinations.getDestinationByChatId(chatId);
            return ctx.editScreen(renderDestinationDetail(ctx, updated));
          }
          return ctx.editScreen(renderMainMenu(ctx));
        }

        case 'reverify': {
          const chatId = Number(args[0]);
          try {
            await app.cinemaDestinations.registerDestination(chatId, ctx.tgId);
            await ctx.answerCallback?.('Permissions re-verified and updated!');
          } catch (e) {
            await ctx.answerCallback?.(`Verification warning: ${e.message}`, { showAlert: true });
          }
          const updated = app.cinemaDestinations.getDestinationByChatId(chatId);
          return ctx.editScreen(renderDestinationDetail(ctx, updated));
        }

        case 'queue': {
          const chatId = Number(args[0]);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          if (!dest) return ctx.editScreen(renderMainMenu(ctx));
          return ctx.editScreen(renderQueue(ctx, dest));
        }

        case 'clear_queue': {
          const chatId = Number(args[0]);
          app.cinemaQueue.clearQueue(chatId);
          await ctx.answerCallback?.('Queue cleared.');
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          return ctx.editScreen(renderQueue(ctx, dest));
        }

        case 'remove_confirm': {
          const chatId = Number(args[0]);
          await app.cinemaDestinations.removeDestination(chatId);
          await ctx.answerCallback?.('Destination removed.');
          return ctx.editScreen(renderMainMenu(ctx));
        }

        case 'card_refresh': {
          const chatId = Number(args[0]);
          if (app.cinemaCards?.postOrUpdateCard) {
            await app.cinemaCards.postOrUpdateCard(chatId);
            await ctx.answerCallback?.('Now Playing card refreshed!');
          }
          return;
        }

        case 'open_poll': {
          const chatId = Number(args[0]);
          const dest = app.cinemaDestinations.getDestinationByChatId(chatId);
          if (!dest) return;
          const pollRow = app.db.get(
            `SELECT poll_session_id FROM cinema_poll_sessions 
             WHERE destination_id = ? AND status = 'open' 
             ORDER BY id DESC LIMIT 1`,
            dest.id
          );
          if (!pollRow) {
            await ctx.answerCallback?.('No active community poll in this destination right now.', { showAlert: true });
            return;
          }
          const pollData = app.cinemaPoll.getPollResults(pollRow.poll_session_id);
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '🗳 COMMUNITY CINEMA VOTE',
            dest.title
          ])));
          b.divider();
          b.quote(rt.concat(
            rt.bold('Vote for the Next Movie / Episode to Stream!\n\n'),
            rt.text(`Total Votes: ${pollData.totalVotes}\n\n`),
            ...pollData.candidates.map((c, i) => rt.text(`${i + 1}. ${c.title} — ${c.votes} vote(s)\n`))
          ));
          b.divider();
          for (const cand of pollData.candidates.slice(0, 5)) {
            b.buttons([
              richButton.callback(`Vote: ${cand.title.slice(0, 25)}`, encodeCallback(id, 'cast_vote', pollRow.poll_session_id, cand.queueItemId))
            ]);
          }
          b.buttons([
            richButton.callback('« Back', encodeCallback(id, 'select', dest.chatId))
          ]);
          b.validate();
          return ctx.editScreen(b.toJSON());
        }

        case 'cast_vote': {
          const pollSessionId = args[0];
          const queueItemId = args[1];
          const res = await app.cinemaPoll.vote(pollSessionId, ctx.tgId, queueItemId);
          if (res.ok) {
            await ctx.answerCallback?.('✅ Vote recorded! Result updated in queue.');
          } else {
            await ctx.answerCallback?.(res.message || 'Could not record vote.', { showAlert: true });
          }
          return;
        }

        case 'connect_dest': {
          const rawTarget = args[0] ? decodeURIComponent(args[0]) : '';
          if (!rawTarget) return ctx.editScreen(renderMainMenu(ctx));
          try {
            const res = await app.cinemaDestinations.registerDestination(rawTarget, ctx.tgId);
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(banner([
              '🎉 DESTINATION CONNECTED',
              res.destination.title
            ])));
            b.divider();
            b.quote(rt.concat(
              rt.bold(`✅ ${res.destination.title} is now ACTIVE!\n\n`),
              rt.text(`• Chat Type: ${res.destination.chatType}\n`),
              rt.text(`• Chat ID: ${res.destination.chatId}\n`),
              rt.text(`• Video Chat Control: Verified ✅\n\n`),
              rt.italic('Tap below to open the Cinema Mini App or manage your destination.')
            ));
            b.buttons([
              { text: rt.text('🍿 Open Cinema Mini App'), web_app: { url: res.miniAppUrl }, style: 'success' },
              richButton.callback('⚙️ Destination Settings', encodeCallback(id, 'select', res.destination.chatId))
            ]);
            b.buttons([
              richButton.callback('« Cinema Hub', encodeCallback(id, 'open'))
            ]);
            b.validate();
            return ctx.editScreen(b.toJSON());
          } catch (err) {
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(banner([
              '⚠️ REGISTRATION WARNING',
              'permissions required'
            ])));
            b.divider();
            b.quote(rt.concat(
              rt.bold('Could not activate destination:\n\n'),
              rt.text(`${err.message}\n\n`),
              rt.italic('Please ensure the bot is added as an Administrator with "Manage Video Chats" permission, then try again.')
            ));
            b.buttons([
              richButton.callback('🔄 Try Again', encodeCallback(id, 'connect_dest', encodeURIComponent(rawTarget))),
              richButton.callback('« Back to Cinema', encodeCallback(id, 'open'))
            ]);
            b.validate();
            return ctx.editScreen(b.toJSON());
          }
        }

        default:
          return ctx.editScreen(renderMainMenu(ctx));
      }
    },

    registerStateHandlers(sm) {
      sm.register(States.CINEMA_DESTINATION_INPUT, {
        onMessage: async (sctx, message) => {
          const text = (message.text || message.caption || '').trim();
          const forwardedChat = message.forward_origin?.chat || message.forward_from_chat || null;
          if (!text && !forwardedChat) return false;
          if (text === '/cancel') {
            await sctx.cancel?.();
            if (sctx.editScreen) await sctx.editScreen(renderMainMenu(sctx));
            return true;
          }

          let target = forwardedChat ? (forwardedChat.username ? `@${forwardedChat.username}` : String(forwardedChat.id)) : text;
          if (typeof target === 'string') {
            const linkMatch = target.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|c\/)?([a-zA-Z0-9_+-]+)/i);
            if (linkMatch) {
              target = linkMatch[1].startsWith('+') ? target : `@${linkMatch[1]}`;
            }
          }

          try {
            const res = await app.cinemaDestinations.registerDestination(target, sctx.tgId);
            await sctx.cancel?.();
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(banner([
              '🎉 DESTINATION CONNECTED',
              res.destination.title
            ])));
            b.divider();
            b.quote(rt.concat(
              rt.bold(`✅ ${res.destination.title} is now ACTIVE!\n\n`),
              rt.text(`• Chat Type: ${res.destination.chatType}\n`),
              rt.text(`• Chat ID: ${res.destination.chatId}\n`),
              rt.text(`• Video Chat Control: Verified ✅\n\n`),
              rt.italic('Tap below to open the Cinema Mini App or manage your destination.')
            ));
            b.buttons([
              { text: rt.text('🍿 Open Cinema Mini App'), web_app: { url: res.miniAppUrl }, style: 'success' },
              richButton.callback('⚙️ Destination Settings', encodeCallback(id, 'select', res.destination.chatId))
            ]);
            b.buttons([
              richButton.callback('« Cinema Hub', encodeCallback(id, 'open'))
            ]);
            b.validate();
            if (sctx.replyRich) await sctx.replyRich(b.toJSON());
            else if (sctx.editScreen) await sctx.editScreen(b.toJSON());
            return true;
          } catch (err) {
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(banner([
              '⚠️ REGISTRATION WARNING',
              'permissions required'
            ])));
            b.divider();
            b.quote(rt.concat(
              rt.bold('Could not activate destination:\n\n'),
              rt.text(`${err.message}\n\n`),
              rt.italic('Please ensure the bot is added as an Administrator with "Manage Video Chats" permission, then try again.')
            ));
            b.buttons([
              richButton.callback('🔄 Try Again', encodeCallback(id, 'add_prompt')),
              richButton.callback('« Back to Cinema', encodeCallback(id, 'open'))
            ]);
            b.validate();
            if (sctx.replyRich) await sctx.replyRich(b.toJSON());
            else if (sctx.editScreen) await sctx.editScreen(b.toJSON());
            return true;
          }
        }
      });
    }
  };
}
