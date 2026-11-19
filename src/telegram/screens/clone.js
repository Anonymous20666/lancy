import { RichMessageBuilder, rt, block, richButton, encodeCallback } from '../rich.js';
import { kvTable, statusDot } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { logger } from '../../core/logger.js';
import { escapeHtml } from '../../media/lyrics.js';

export function createCloneScreen({ app }) {
  const id = 'clone';
  const log = logger().child({ module: 'screen:clone' });

  function renderWelcomeCard(ctx) {
    const b = new RichMessageBuilder();
    b.bannerHeader([
      '𓆩♡𓆪 BRING YOUR OWN BOT 𓆩♡𓆪',
      'clone your own aesthetic bot in 60 seconds'
    ], { size: 1 });

    b.details('୨୧ What Is Included in Your Clone Bot', [
      block.list([
        rt.concat(rt.bold('🌸 Custom Branding — '), rt.text('Replaces "Lancy" with your own bot name & identity.')),
        rt.concat(rt.bold('🎵 Cinema, Music & Downloader — '), rt.text('Full Voice Chat, HD downloads, Pinterest & games included.')),
        rt.concat(rt.bold('📡 Channels, GCs & Broadcasts — '), rt.text('Knows its channels & groups and sends 10-slide rich broadcasts.')),
        rt.concat(rt.bold('🌍 Multi-Language Audience — '), rt.text('7 built-in languages + Force-Join channel locks.'))
      ])
    ], true);
    b.divider();

    b.buttons([
      richButton.callback('✨ Start Cloning', encodeCallback(id, 'start'), { style: 'primary' }),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    b.footer(rt.italic('Powered by Lancy Multi-Bot Engine ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderBotsList(ctx, bots) {
    const b = new RichMessageBuilder();
    b.bannerHeader([
      '𓆩♡𓆪 YOUR CLONED BOTS 𓆩♡𓆪',
      'manage your personal bot empire'
    ], { size: 1 });

    b.heading('୨୧ active bot instances', 3);
    const rows = bots.map((bot) => {
      const isOnline = bot.status === 'active';
      const userCount = app.db.get('SELECT COUNT(*) AS c FROM bot_users WHERE bot_id = ?', bot.id)?.c ?? 0;
      return [
        `@${bot.bot_username}`,
        `${statusDot(isOnline ? 'online' : 'offline')} ${bot.bot_name} • ${userCount} users`
      ];
    });
    b.table(kvTable(rows), { compact: true });
    b.divider();

    // Buttons for each bot: Manage & Remove
    for (const bot of bots.slice(0, 6)) {
      b.buttons([
        richButton.callback(`⚙ Manage @${bot.bot_username}`, encodeCallback(id, 'manage', bot.id), { style: 'primary' }),
        richButton.callback(`🗑 Remove`, encodeCallback(id, 'delete_confirm', bot.id), { style: 'danger' })
      ]);
    }

    b.buttons([
      richButton.callback('✨ Clone Another Bot', encodeCallback(id, 'start'), { style: 'primary' }),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    b.footer(rt.italic('Delivered with aesthetic love ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderRmPicker(ctx, bots) {
    const b = new RichMessageBuilder();
    b.bannerHeader([
      '🗑 REMOVE A CLONED BOT 🗑',
      'select which bot to delete ♡'
    ], { size: 2 });
    b.quote(rt.concat(
      rt.bold('Choose which bot you want to remove:\n\n'),
      rt.text('Its polling process will stop immediately and its token will be removed.')
    ));
    b.divider();
    for (const bot of bots) {
      b.buttons([
        richButton.callback(`🗑 Delete @${bot.bot_username}`, encodeCallback(id, 'delete_confirm', bot.id), { style: 'danger' })
      ]);
    }
    b.buttons([
      richButton.callback('« Cancel', encodeCallback(id, 'open'))
    ]);
    b.footer(rt.italic('This action stops the bot permanently ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderNamePrompt() {
    const b = new RichMessageBuilder();
    b.bannerHeader([
      '𓆩♡𓆪 STEP 1: NAME YOUR BOT 𓆩♡𓆪',
      'choose your custom bot identity ♡'
    ], { size: 2 });
    b.quote(rt.concat(
      rt.bold('🌸 What name would you like your bot to have?\n\n'),
      rt.text('Instead of "Lancy", this name will appear in greetings, banners, and delivery cards!\n'),
      rt.italic('Examples: Aria, Nova, Sam Music, Bella Studio\n\n'),
      rt.bold('👇 Type and send your desired bot name in chat now:')
    ));
    b.divider();
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'))
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderTokenPrompt(botName) {
    const b = new RichMessageBuilder();
    b.bannerHeader([
      '𓆩♡𓆪 STEP 2: GET BOT TOKEN 𓆩♡𓆪',
      `connect @BotFather for ${botName} ♡`
    ], { size: 2 });

    b.heading('୨୧ follow these quick steps in @BotFather:', 3);
    b.quote(rt.concat(
      rt.text('1. Open Telegram\'s official '), rt.bold('@BotFather'), rt.text('\n'),
      rt.text('2. Send '), rt.code('/newbot'), rt.text(' to create your bot name & username\n'),
      rt.text('3. Copy the HTTP API token (e.g. '), rt.code('123456789:ABCdefGHI...'), rt.text(')\n\n'),
      rt.bold('⚡ Enable Live @bot Search (Shazam Style):\n'),
      rt.text('4. Send '), rt.code('/setinline'), rt.text(' to @BotFather → select your bot → enter placeholder: '), rt.code('Search music, videos...'), rt.text('\n\n'),
      rt.bold('👇 Paste and send your bot token here:')
    ));
    b.divider();

    b.buttons([
      richButton.url('🤖 Open @BotFather', 'https://t.me/BotFather'),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'))
    ]);
    b.footer(rt.italic('Your token is secured and never shared ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderManageScreen(ctx, botRecord) {
    const isOnline = botRecord.status === 'active';
    const userCount = app.db.get('SELECT COUNT(*) AS c FROM bot_users WHERE bot_id = ?', botRecord.id)?.c ?? 0;
    const runningBot = app.multiBotManager?.runningBots.get(botRecord.id);
    const supportsInline = runningBot?.controller?.supportsInline ?? false;
    let fjCount = 0;
    try {
      const row = app.db.get('SELECT value_json FROM bot_settings WHERE key = ?', `force_join.clone_${botRecord.id}`);
      if (row?.value_json) fjCount = (JSON.parse(row.value_json) || []).length;
    } catch {}

    const b = new RichMessageBuilder();
    b.bannerHeader([
      `𓆩♡𓆪 MANAGE @${botRecord.bot_username.toUpperCase()} 𓆩♡𓆪`,
      `${botRecord.bot_name} control panel`
    ], { size: 1 });

    b.table(kvTable([
      ['🏷 Bot Name', botRecord.bot_name],
      ['🤖 Username', `@${botRecord.bot_username}`],
      ['⚡ Status', `${statusDot(isOnline ? 'online' : 'offline')} ${botRecord.status.toUpperCase()}`],
      ['🔒 Force-Join', fjCount > 0 ? `✓ ${fjCount} Channel(s) Active` : 'Off (Tap below to add)'],
      ['🔍 Live Search', supportsInline ? '✓ Enabled' : '⚠️ Disabled (needs /setinline)'],
      ['👥 Total Users', `${userCount} active users`],
      ['📅 Created', botRecord.created_at?.slice(0, 10) || 'Recently']
    ]), { compact: true });
    b.divider();

    if (!supportsInline) {
      b.details('💡 How to Enable Live @bot Search', [
        block.paragraph(rt.concat(
          rt.text('Send '), rt.code('/setinline'), rt.text(' to @BotFather for '), rt.code(`@${botRecord.bot_username}`), rt.text(' and set placeholder: '), rt.code('Search music...')
        )),
        block.buttons([richButton.copy('📋 Copy /setinline', '/setinline')])
      ], false);
      b.divider();
    }

    b.buttons([
      richButton.url(`🚀 Open @${botRecord.bot_username}`, `https://t.me/${botRecord.bot_username}`),
      richButton.callback('📢 Broadcast Message', encodeCallback(id, 'broadcast', botRecord.id), { style: 'primary' })
    ]);

    b.buttons([
      richButton.callback('🔒 Force-Join Channels', `fj_open:${botRecord.id}`, { style: 'success' })
    ]);

    const toggleText = isOnline ? '⏸ Pause Bot' : '▶ Resume Bot';
    const toggleAction = isOnline ? 'pause' : 'resume';
    b.buttons([
      richButton.callback(toggleText, encodeCallback(id, toggleAction, botRecord.id)),
      richButton.callback('🗑 Delete Bot', encodeCallback(id, 'delete_confirm', botRecord.id))
    ]);

    b.buttons([
      richButton.callback('« Cloned Bots', encodeCallback(id, 'open')),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  function canManageBot(ctx, botRecord) {
    if (!botRecord) return false;
    if (Number(botRecord.owner_tg_id) === Number(ctx.tgId)) return true;
    const ownerIds = (app.settings?.get?.('general.ownerIds') ?? []).map(Number);
    return ownerIds.includes(Number(ctx.tgId)) || Boolean(ctx.controller?.isMainOwner?.(ctx.tgId));
  }

  return {
    id,
    async open(ctx) {
      const bots = app.multiBotManager?.getAccessibleBots?.(ctx.tgId, { controller: ctx.controller })
        ?? app.multiBotManager?.getBotsForOwner(ctx.tgId)
        ?? [];
      if (bots.length === 0) {
        return ctx.editScreen(renderWelcomeCard(ctx));
      }
      return ctx.editScreen(renderBotsList(ctx, bots));
    },

    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return this.open(ctx);

        case 'start':
          await ctx.sm?.transition(ctx.tgId, States.CLONE_BOT_NAME_INPUT);
          if (ctx.fromMedia || ctx.forceNew) return ctx.replyRich(renderNamePrompt());
          return ctx.editScreen(renderNamePrompt());

        case 'manage': {
          const botId = Number(args[0]);
          const botRecord = app.multiBotManager?.getBotById(botId);
          if (!canManageBot(ctx, botRecord)) return this.open(ctx);
          return ctx.editScreen(renderManageScreen(ctx, botRecord));
        }

        case 'pause': {
          const botId = Number(args[0]);
          const botRecordCheck = app.multiBotManager?.getBotById(botId);
          if (!canManageBot(ctx, botRecordCheck)) return this.open(ctx);
          await app.multiBotManager?.pauseBot(botId);
          const botRecord = app.multiBotManager?.getBotById(botId);
          return ctx.editScreen(renderManageScreen(ctx, botRecord));
        }

        case 'resume': {
          const botId = Number(args[0]);
          const botRecordCheck = app.multiBotManager?.getBotById(botId);
          if (!canManageBot(ctx, botRecordCheck)) return this.open(ctx);
          await app.multiBotManager?.resumeBot(botId);
          const botRecord = app.multiBotManager?.getBotById(botId);
          return ctx.editScreen(renderManageScreen(ctx, botRecord));
        }

        case 'rm_picker': {
          const bots = app.multiBotManager?.getAccessibleBots?.(ctx.tgId, { controller: ctx.controller })
            ?? app.multiBotManager?.getBotsForOwner(ctx.tgId)
            ?? [];
          if (bots.length === 0) return this.open(ctx);
          if (bots.length === 1) return this.handle(ctx, 'delete_confirm', [bots[0].id]);
          if (ctx.fromMedia || ctx.forceNew) return ctx.replyRich(renderRmPicker(ctx, bots));
          return ctx.editScreen(renderRmPicker(ctx, bots));
        }

        case 'delete_confirm':
        case 'rm_confirm': {
          const botId = Number(args[0]);
          const botRecord = app.multiBotManager?.getBotById(botId);
          if (!botRecord) return this.open(ctx);

          const b = new RichMessageBuilder();
          b.bannerHeader([
            '⚠️ CONFIRM DELETE BOT ⚠️',
            `delete @${botRecord.bot_username} permanently?`
          ], { size: 2 });
          b.quote(rt.concat(
            rt.text('Are you sure you want to stop and delete '),
            rt.bold(`@${botRecord.bot_username}`),
            rt.text('? This action cannot be undone.')
          ));
          b.divider();
          b.buttons([
            richButton.callback('🗑 Yes, Delete', encodeCallback(id, 'delete', botId), { style: 'danger' }),
            richButton.callback('« Cancel', encodeCallback(id, 'open'))
          ]);
          b.validate();
          if (ctx.fromMedia || ctx.forceNew) return ctx.replyRich(b.toJSON());
          return ctx.editScreen(b.toJSON());
        }

        case 'delete':
        case 'rm': {
          const botId = Number(args[0]);
          const botRecord = app.multiBotManager?.getBotById(botId);
          await app.multiBotManager?.deleteBot(botId, ctx.tgId);
          if (ctx.query?.id) {
            await ctx.api?.answerCallbackQuery(ctx.query.id, {
              text: botRecord?.bot_username ? `✓ Deleted @${botRecord.bot_username} ♡` : '✓ Bot deleted ♡',
              showAlert: true
            }).catch(() => {});
          }
          return this.open(ctx);
        }

        case 'broadcast': {
          const botId = Number(args[0]);
          const botRecord = app.multiBotManager?.getBotById(botId);
          if (!canManageBot(ctx, botRecord)) return this.open(ctx);

          const broadcastScreen = app.screens?.get?.('broadcast');
          if (broadcastScreen?.handle) {
            return broadcastScreen.handle(ctx, 'open_bot', [botId]);
          }

          await ctx.sm?.transition(ctx.tgId, States.CLONE_BOT_BROADCAST_INPUT, {
            context: { botId, botUsername: botRecord.bot_username }
          });

          const b = new RichMessageBuilder();
          b.bannerHeader([
            '📢 BROADCAST TO BOT USERS',
            `sending message via @${botRecord.bot_username} ♡`
          ], { size: 2 });
          b.quote(rt.concat(
            rt.bold('👇 Send text, photo, video, audio, document, sticker, or poll to broadcast:\n\n'),
            rt.text('It will be delivered to all active users who started your bot ♡')
          ));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'manage', botId))
          ]);
          b.validate();
          return ctx.editScreen(b.toJSON());
        }

        case 'cancel':
          await ctx.sm?.reset(ctx.tgId, { reason: 'cancelled' });
          return this.open(ctx);

        default:
          return this.open(ctx);
      }
    },

    registerStateHandlers(sm) {
      // 1. Name input handler
      sm.register(States.CLONE_BOT_NAME_INPUT, {
        timeoutMs: 10 * 60 * 1000,
        async onMessage(ctx, message) {
          const rawName = String(message.text || '').trim();
          if (!rawName || rawName.startsWith('/')) return false;

          const cleanName = rawName.slice(0, 32);
          await sm.transition(ctx.tgId, States.CLONE_BOT_TOKEN_INPUT, {
            context: { botName: cleanName }
          });
          const chatId = ctx.chatId || message.chat?.id;
          const api = app.telegram?.api;
          if (api?.sendRichMessage) {
            await api.sendRichMessage(chatId, renderTokenPrompt(cleanName)).catch(() => {});
          }
          return true;
        }
      });

      // 2. Token input handler
      sm.register(States.CLONE_BOT_TOKEN_INPUT, {
        timeoutMs: 15 * 60 * 1000,
        async onMessage(ctx, message) {
          const text = String(message.text || '').trim();
          if (!text || text.startsWith('/cancel')) return false;

          const api = app.telegram?.api;
          const chatId = ctx.chatId || message.chat?.id;

          // Scrub the token message from chat for privacy
          if (message.message_id && typeof api?.deleteMessage === 'function') {
            api.deleteMessage(chatId, message.message_id).catch(() => {});
          }

          const botName = ctx.context?.botName || sm.context(ctx.tgId)?.botName || 'Custom Bot';

          const progressMsg = await api?.sendMessage?.(
            chatId,
            '⏳ <i>Connecting to Telegram and validating token… ♡</i>',
            { parse_mode: 'HTML' }
          ).catch(() => null);

          try {
            const botRecord = await app.multiBotManager.registerAndStartBot({
              ownerTgId: ctx.tgId,
              token: text,
              botName
            });

            await sm.reset(ctx.tgId, { reason: 'bot_cloned' });

            if (progressMsg?.message_id && typeof api?.deleteMessage === 'function') {
              await api.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
            }

            const b = new RichMessageBuilder();
            b.bannerHeader([
              '🎉 YOUR BOT IS NOW LIVE! 🎉',
              `@${botRecord.bot_username} is running ♡`
            ], { size: 2 });
            b.quote(rt.concat(
              rt.text('✨ '), rt.bold('Congratulations!'), rt.text(' Your bot '), rt.bold(`@${botRecord.bot_username}`), rt.text(' has been successfully cloned and launched!\n\n'),
              rt.text('• 🏷 '), rt.bold('Brand Name: '), rt.text(`${botRecord.bot_name}\n`),
              rt.text('• 🚀 '), rt.bold('Status: '), rt.text('Online & Polling\n'),
              rt.text('• 🎵 '), rt.bold('Features: '), rt.text('Music, Downloader, Pinterest, Group Chat & Multi-Language\n\n'),
              rt.bold('⚡ Enable Live @bot Search (Shazam Style):\n'),
              rt.text('To search music in any chat by typing '), rt.code(`@${botRecord.bot_username}`),
              rt.text(', send '), rt.code('/setinline'), rt.text(` to @BotFather, select `), rt.code(`@${botRecord.bot_username}`),
              rt.text(' and enter placeholder: '), rt.code('Search music...'), rt.text('\n\n'),
              rt.italic('Tap the button below to start your new bot! ♡')
            ));
            b.divider();
            b.buttons([
              richButton.url(`🚀 Open @${botRecord.bot_username}`, `https://t.me/${botRecord.bot_username}`),
              richButton.callback('⚙ Manage Bot', encodeCallback(id, 'manage', botRecord.id), { style: 'primary' })
            ]);
            b.buttons([
              richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
            ]);
            b.footer(rt.italic('Powered with love by Lancy Multi-Bot Engine ♡'));
            b.validate();
            if (api?.sendRichMessage) {
              await api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
            }
            return true;
          } catch (err) {
            log.warn({ err: err.message }, 'token validation failed');
            if (progressMsg?.message_id && typeof api?.deleteMessage === 'function') {
              await api.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
            }

            const errSent = await api?.sendMessage?.(
              chatId,
              `<blockquote>✕ <b>Could not launch bot:</b> ${escapeHtml(err.message)}\n\nPlease verify your token from @BotFather and try pasting it again ♡</blockquote>`,
              { parse_mode: 'HTML' }
            );
            if (errSent?.message_id && typeof api?.deleteMessage === 'function') {
              setTimeout(() => {
                api.deleteMessage(chatId, errSent.message_id).catch(() => {});
              }, 12000)?.unref?.();
            }
            return true;
          }
        }
      });

      // 3. Broadcast input handler (supports text, media, audio, stickers, docs, polls)
      sm.register(States.CLONE_BOT_BROADCAST_INPUT, {
        timeoutMs: 10 * 60 * 1000,
        async onMessage(ctx, message) {
          const rawText = String(message.text || '').trim();
          if (rawText.startsWith('/cancel')) return false;
          const hasContent = Boolean(rawText || message.caption || message.photo || message.video || message.animation || message.audio || message.voice || message.document || message.sticker || message.poll);
          if (!hasContent) return false;

          const api = ctx.api || app.telegram?.api;
          const chatId = ctx.chatId || message.chat?.id;

          const botId = ctx.context?.botId || sm.context(ctx.tgId)?.botId;
          if (!botId) return false;

          const statusMsg = await api?.sendMessage?.(
            chatId,
            '⏳ <i>Delivering broadcast to your bot users… ♡</i>',
            { parse_mode: 'HTML' }
          ).catch(() => null);

          try {
            const payload = rawText && !message.photo && !message.video && !message.audio && !message.voice && !message.document && !message.animation && !message.sticker && !message.poll && !message.entities?.length
              ? rawText
              : message;
            const res = await app.multiBotManager.broadcast(botId, ctx.tgId, payload, { sourceApi: api });
            await sm.reset(ctx.tgId, { reason: 'broadcast_done' });

            if (statusMsg?.message_id && typeof api?.deleteMessage === 'function') {
              await api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            }

            const b = new RichMessageBuilder();
            b.bannerHeader([
              '📢 BROADCAST COMPLETED',
              'messages delivered successfully ♡'
            ], { size: 2 });
            b.table(kvTable([
              ['✅ Sent Successfully', `${res.sentCount} users`],
              ['✕ Failed / Blocked', `${res.failedCount} users`],
              ['👥 Total Audience', `${res.total} users`]
            ]), { compact: true });
            b.divider();
            b.buttons([
              richButton.callback('⚙ Manage Bot', encodeCallback(id, 'manage', botId), { style: 'primary' }),
              richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
            ]);
            b.validate();
            if (api?.sendRichMessage) {
              await api.sendRichMessage(chatId, b.toJSON()).catch(() => {});
            }
            return true;
          } catch (err) {
            log.error({ err }, 'broadcast execution error');
            if (statusMsg?.message_id && typeof api?.deleteMessage === 'function') {
              await api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            }
            await api?.sendMessage?.(chatId, `<blockquote>✕ Failed to broadcast: ${escapeHtml(err.message)}</blockquote>`, { parse_mode: 'HTML' });
            return true;
          }
        }
      });
    }
  };
}
