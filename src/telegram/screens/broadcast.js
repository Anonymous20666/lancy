import { RichMessageBuilder, rt, block, richButton, encodeCallback } from '../rich.js';
import { kvTable } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { logger } from '../../core/logger.js';
import { escapeHtml } from '../../media/lyrics.js';
import {
  isPlatformOwner,
  isBotSuperAdmin,
  verifyBotCanPostInTarget,
  listCrossBotVerifiedTargets
} from '../permissions.js';
import {
  extractBroadcastItemFromMessage,
  deliverBroadcastToTarget,
  resolveSenderBotForTarget,
  summarizeBroadcastItems,
  parseBroadcastButtonLines,
  safeUtf8,
  safeTruncate
} from '../broadcastEngine.js';

export function createBroadcastScreen({ app }) {
  const id = 'broadcast';
  const log = logger().child({ module: 'screen:broadcast' });

  // Per-user broadcast studio drafts (scoped by numeric tgId string)
  const drafts = new Map();
  // Debounce re-render when an album sends N sequential Telegram updates with same media_group_id
  const composeDebounceTimers = new Map();

  function getDraft(tgId) {
    const key = String(tgId);
    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        senderBotId: 'auto',
        selectedTargetIds: new Set(),
        includeDmUsers: false,
        richCard: false,
        slideMode: false,
        autoCustomEmoji: true,
        buttonRows: [],
        items: [],
        targetPage: 0,
        filterType: 'all', // all | channel | group
        notice: null
      };
      drafts.set(key, draft);
    }
    return draft;
  }

  async function editOrSend(ctx, richJson, extra = {}) {
    if (ctx.fromMedia || ctx.forceNew) {
      return ctx.replyRich(richJson, extra);
    }
    try {
      return await ctx.editScreen(richJson, extra);
    } catch {
      return ctx.replyRich(richJson, extra);
    }
  }

  async function loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh = false } = {}) {
    const mainApi = app.telegram?.api || ctx.api;
    return listCrossBotVerifiedTargets({
      db: app.db,
      settings: app.settings,
      controller: ctx.controller || app.telegram?.controller,
      multiBotManager: app.multiBotManager,
      mainApi,
      userId: Number(tgId),
      includeGroups: true,
      forceRefresh,
      probeKnownGroups: true
    });
  }

  function getDmUserCountForBots(bots = [], senderBotId = 'auto', isOwnerOrSuper = false) {
    if (!app.db || !isOwnerOrSuper) return 0;
    try {
      if (senderBotId && senderBotId !== 'auto') {
        const chosen = bots.find((b) => String(b.botId) === String(senderBotId) || (b.cloneRowId != null && String(b.cloneRowId) === String(senderBotId)));
        if (chosen && !chosen.isMain && chosen.cloneRowId != null) {
          return app.db.get('SELECT COUNT(DISTINCT tg_id) AS c FROM bot_users WHERE bot_id = ?', chosen.cloneRowId)?.c ?? 0;
        }
        if (chosen?.isMain) {
          return app.db.get('SELECT COUNT(DISTINCT tg_id) AS c FROM users WHERE tg_id > 0')?.c ?? 0;
        }
        return 0;
      }
      const cloneIds = bots.filter((b) => !b.isMain && b.cloneRowId != null).map((b) => b.cloneRowId);
      const hasMain = bots.some((b) => b.isMain);
      const seen = new Set();
      if (hasMain) {
        for (const r of app.db.all('SELECT tg_id FROM users WHERE tg_id > 0')) {
          seen.add(Number(r.tg_id));
        }
      }
      for (const cid of cloneIds) {
        for (const r of app.db.all('SELECT tg_id FROM bot_users WHERE bot_id = ? AND tg_id > 0', cid)) {
          seen.add(Number(r.tg_id));
        }
      }
      return seen.size;
    } catch {
      return 0;
    }
  }

  function collectDmRecipientPairs(bots = [], senderBotId = 'auto', isOwnerOrSuper = false) {
    if (!app.db || !isOwnerOrSuper) return [];
    const recipients = new Map(); // tg_id -> { chatId, bot }

    const chosenBots = senderBotId === 'auto'
      ? bots.filter((b) => b.api)
      : bots.filter((b) => b.api && (String(b.botId) === String(senderBotId) || (b.cloneRowId != null && String(b.cloneRowId) === String(senderBotId))));

    // Prefer main bot first, then clones so each DM user is contacted once cleanly
    const ordered = [
      ...chosenBots.filter((b) => b.isMain),
      ...chosenBots.filter((b) => !b.isMain)
    ];

    for (const bot of ordered) {
      const rows = bot.isMain
        ? (app.db.all('SELECT tg_id FROM users WHERE tg_id > 0') || [])
        : (bot.cloneRowId != null ? (app.db.all('SELECT tg_id FROM bot_users WHERE bot_id = ? AND tg_id > 0', bot.cloneRowId) || []) : []);
      for (const row of rows) {
        const uid = Number(row.tg_id);
        if (!Number.isSafeInteger(uid) || uid <= 0) continue;
        if (!recipients.has(uid)) {
          recipients.set(uid, { chatId: uid, bot });
        }
      }
    }
    return [...recipients.values()];
  }

  function filterTargetsBySender(targets, senderBotId) {
    if (!senderBotId || senderBotId === 'auto') return targets;
    return targets.filter((t) =>
      (t.verifiedBots || []).some((b) => String(b.botId) === String(senderBotId))
    );
  }

  function pruneInvalidSelections(draft, verifiedTargets) {
    const validIds = new Set(verifiedTargets.map((t) => Number(t.channel_id)));
    for (const cid of [...draft.selectedTargetIds]) {
      if (!validIds.has(Number(cid))) {
        draft.selectedTargetIds.delete(cid);
      }
    }
  }

  function resolveSenderLabel(bots, senderBotId) {
    if (!senderBotId || senderBotId === 'auto') {
      const cloneCount = bots.filter((b) => !b.isMain && b.api).length;
      const hasMain = bots.some((b) => b.isMain && b.api);
      if (hasMain && cloneCount > 0) return `Auto Cross-Bot (Main + ${cloneCount} Clone${cloneCount > 1 ? 's' : ''})`;
      if (cloneCount > 0) return `Auto (${cloneCount} Clone${cloneCount > 1 ? 's' : ''})`;
      const first = bots[0];
      return first ? `@${first.botUsername || 'MainBot'}` : 'Current Bot';
    }
    const found = bots.find((b) => String(b.botId) === String(senderBotId));
    return found ? `${found.isMain ? '👑' : '🤖'} @${found.botUsername}` : 'Selected Bot';
  }

  async function renderStudio(ctx, { forceRefresh = false, notice = null } = {}) {
    const tgId = String(ctx.tgId);
    const draft = getDraft(tgId);
    if (notice !== undefined && notice !== null) draft.notice = notice;

    const { bots, targets: allVerifiedTargets } = await loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh });
    const filteredTargets = filterTargetsBySender(allVerifiedTargets, draft.senderBotId);
    pruneInvalidSelections(draft, filteredTargets);

    // Ensure senderBotId still exists; otherwise reset to auto
    if (draft.senderBotId !== 'auto' && !bots.some((b) => String(b.botId) === String(draft.senderBotId))) {
      draft.senderBotId = 'auto';
    }

    const chCount = filteredTargets.filter((t) => t.chat_type === 'channel').length;
    const gcCount = filteredTargets.filter((t) => t.chat_type === 'group' || t.chat_type === 'supergroup').length;
    const platformOwner = isPlatformOwner(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller });
    const superAdmin = platformOwner
      || isBotSuperAdmin(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller })
      || bots.some((b) => !b.isMain && Number(b.ownerTgId) === Number(tgId));

    const dmCount = getDmUserCountForBots(bots, draft.senderBotId, superAdmin);
    const selectedTargets = filteredTargets.filter((t) => draft.selectedTargetIds.has(Number(t.channel_id)));
    const draftSummary = summarizeBroadcastItems(draft.items);

    const b = new RichMessageBuilder();
    b.bannerHeader([
      '📡 SMART POST & BROADCAST STUDIO 📡',
      'channels • gcs • clones • 10-slides • buttons • showcase'
    ], { size: 1 });

    if (draft.notice) {
      b.quote(rt.text(draft.notice));
      b.divider();
      draft.notice = null;
    }

    const btnCount = (draft.buttonRows || []).reduce((n, r) => n + r.length, 0);
    const statusRows = [
      ['🤖 Sender Bot', resolveSenderLabel(bots, draft.senderBotId)],
      ['✅ Verified', `${chCount} Channel${chCount === 1 ? '' : 's'} • ${gcCount} Group${gcCount === 1 ? '' : 's'}${superAdmin ? ` • ${dmCount} DM Users` : ''}`],
      ['🎯 Selected', `${selectedTargets.length} Target${selectedTargets.length === 1 ? '' : 's'}${draft.includeDmUsers ? ` + ${dmCount} DM Users` : ''}`],
      ['📦 Content', draftSummary],
      ['🔘 Buttons', btnCount ? `${btnCount} custom button(s)` : 'None (tap Attach Buttons to add)'],
      ['✨ Style', `${draft.richCard ? 'Rich Card' : 'Native'} • ${draft.slideMode ? '10/Slide Card' : 'Album'} • ${draft.autoCustomEmoji ? 'Custom Emojis ON' : 'Standard Emojis'}`]
    ];
    b.table(kvTable(statusRows), { compact: true });
    b.divider();

    if (selectedTargets.length > 0) {
      const previewNames = selectedTargets.slice(0, 5).map((t) => {
        const icon = t.chat_type === 'channel' ? '📢' : '👥';
        const via = resolveSenderBotForTarget(t, draft.senderBotId, bots);
        const viaTag = via ? ` via @${safeUtf8(via.botUsername)}` : '';
        return `${icon} ${safeUtf8(t.title || 'Chat')}${viaTag}`;
      });
      if (selectedTargets.length > 5) previewNames.push(`… +${selectedTargets.length - 5} more`);
      b.details(`🎯 Selected Destinations (${selectedTargets.length})`, [
        block.list(previewNames)
      ], true);
      b.divider();
    } else if (filteredTargets.length === 0) {
      b.pullquote(
        rt.text('Add this bot or any clone as Channel Admin (Post Messages) or into a Group, then tap 🎯 Targets → Add / Re-Verify.'),
        rt.text('No verified chats ready for this sender')
      );
      b.divider();
    }

    b.buttons([
      richButton.callback(`✏️ Compose (${draft.items.length})`, encodeCallback(id, 'compose'), { style: 'primary' }),
      richButton.callback(`🎯 Targets (${selectedTargets.length}/${filteredTargets.length})`, encodeCallback(id, 'targets'), { style: 'primary' })
    ]);

    b.buttons([
      richButton.callback(`🤖 Sender (${bots.length})`, encodeCallback(id, 'pick_bot')),
      richButton.callback(`🔘 Buttons (${btnCount})`, encodeCallback(id, 'attach_buttons'))
    ]);

    b.buttons([
      richButton.callback(draft.richCard ? '✨ Card: ON' : '✨ Card: OFF', encodeCallback(id, 'toggle_rich')),
      richButton.callback(draft.slideMode ? '🎞 10/Slide' : '📦 Album', encodeCallback(id, 'toggle_slides')),
      richButton.callback(draft.autoCustomEmoji ? '🎀 CE: ON' : '🎀 CE: OFF', encodeCallback(id, 'toggle_ce'))
    ]);

    if (platformOwner) {
      const allSystemTotal = filteredTargets.length + dmCount;
      b.buttons([
        richButton.callback('🌟 A–Z Showcase Card', encodeCallback(id, 'load_showcase'), { style: 'primary' }),
        richButton.callback(`⚡ Send ALL (${allSystemTotal})`, encodeCallback(id, 'broadcast_all'), { style: 'success' })
      ]);
    } else {
      b.buttons([
        richButton.callback('🌟 Load A–Z Showcase', encodeCallback(id, 'load_showcase'), { style: 'primary' })
      ]);
    }

    if (draft.items.length > 0) {
      b.buttons([
        richButton.callback('👁 Preview Here', encodeCallback(id, 'preview_self')),
        richButton.switchInline('💌 Share Inline', 'showcase'),
        richButton.callback('🗑 Clear', encodeCallback(id, 'clear_draft'), { style: 'danger' })
      ]);
    }

    const totalDestinations = selectedTargets.length + (draft.includeDmUsers ? dmCount : 0);
    if (draft.items.length > 0 && totalDestinations > 0) {
      b.buttons([
        richButton.callback(`🚀 LAUNCH BROADCAST (${totalDestinations})`, encodeCallback(id, 'launch'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('🔄 Re-Verify Live', encodeCallback(id, 'reverify')),
      richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    b.footer(rt.italic('Clones & Main Bot automatically verify channels/GCs before sending ♡'));
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function renderComposeScreen(ctx, { notice = null } = {}) {
    const tgId = String(ctx.tgId);
    const draft = getDraft(tgId);
    await ctx.sm?.transition?.(tgId, States.BROADCAST_COMPOSE, {
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });

    const b = new RichMessageBuilder();
    b.bannerHeader([
      '✏️ COMPOSE POST OR BROADCAST ✏️',
      'text • media • 10-slide albums • audio • polls • showcase ♡'
    ], { size: 1 });

    if (notice) {
      b.quote(rt.text(notice));
      b.divider();
    }

    b.details('📋 What You Can Send Right Here', [
      block.list([
        rt.text('📝 Text (Bold, Italic, Links, Quotes — standard emojis upgrade to custom!)'),
        rt.text('🖼 Up to 10 Photos / Videos per Slide or Album (with optional captions)'),
        rt.text('🎵 Audio Tracks, Voice Notes, GIFs, Documents, Stickers & Polls')
      ])
    ], true);
    b.paragraph(rt.concat(
      rt.bold('Current Stack: '), rt.text(summarizeBroadcastItems(draft.items))
    ));
    b.divider();

    if (draft.items.length > 0) {
      const stackLines = draft.items.slice(0, 8).map((it, i) => {
        const preview = it.text || it.caption || it.title || it.question || it.filename || '';
        const clipped = preview ? ` — ${safeTruncate(preview.replace(/\s+/g, ' '), 36)}` : '';
        return `${i + 1}. [${it.kind.toUpperCase()}]${clipped}`;
      });
      if (draft.items.length > 8) stackLines.push(`… +${draft.items.length - 8} more item(s)`);
      b.list(stackLines);
      b.divider();
    }

    const row1 = [
      richButton.callback('✅ Done Composing', encodeCallback(id, 'done_compose'), { style: 'success' })
    ];
    if (draft.items.length > 0) {
      row1.push(richButton.callback('↩ Undo Last', encodeCallback(id, 'undo_item')));
    }
    b.buttons(row1);

    if (draft.items.length > 0) {
      b.buttons([
        richButton.callback('👁 Test Preview', encodeCallback(id, 'preview_self')),
        richButton.callback('🗑 Clear All', encodeCallback(id, 'clear_compose'), { style: 'danger' })
      ]);
    }
    b.buttons([
      richButton.callback('« Back to Studio', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function renderTargetsScreen(ctx, { forceRefresh = false, notice = null } = {}) {
    const tgId = String(ctx.tgId);
    const draft = getDraft(tgId);
    const { bots, targets: allVerified } = await loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh });
    const senderFiltered = filterTargetsBySender(allVerified, draft.senderBotId);
    pruneInvalidSelections(draft, senderFiltered);

    const typedTargets = senderFiltered.filter((t) => {
      if (draft.filterType === 'channel') return t.chat_type === 'channel';
      if (draft.filterType === 'group') return t.chat_type === 'group' || t.chat_type === 'supergroup';
      return true;
    });

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(typedTargets.length / pageSize));
    if (draft.targetPage >= totalPages) draft.targetPage = totalPages - 1;
    if (draft.targetPage < 0) draft.targetPage = 0;
    const pageItems = typedTargets.slice(draft.targetPage * pageSize, (draft.targetPage + 1) * pageSize);

    const platformOwner = isPlatformOwner(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller });
    const superAdmin = platformOwner
      || isBotSuperAdmin(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller })
      || bots.some((b) => !b.isMain && Number(b.ownerTgId) === Number(tgId));
    const dmCount = getDmUserCountForBots(bots, draft.senderBotId, superAdmin);

    const b = new RichMessageBuilder();
    b.bannerHeader([
      '🎯 VERIFIED CHANNELS & GROUP CHATS 🎯',
      `sender: ${resolveSenderLabel(bots, draft.senderBotId)}`
    ], { size: 1 });

    if (notice) {
      b.quote(rt.text(notice));
      b.divider();
    }

    b.buttons([
      richButton.callback(draft.filterType === 'all' ? '• All •' : 'All', encodeCallback(id, 'filter', 'all')),
      richButton.callback(draft.filterType === 'channel' ? '• 📢 Channels •' : '📢 Channels', encodeCallback(id, 'filter', 'channel')),
      richButton.callback(draft.filterType === 'group' ? '• 👥 Groups •' : '👥 Groups', encodeCallback(id, 'filter', 'group'))
    ]);

    if (pageItems.length === 0) {
      b.pullquote(
        rt.text('Note: Channels/groups where the bot is removed or lacks posting rights are automatically hidden! ♡'),
        rt.text('No live-verified targets match this filter')
      );
      b.divider();
    } else {
      const infoLines = pageItems.map((t) => {
        const icon = t.chat_type === 'channel' ? '📢' : '👥';
        const botTags = (t.verifiedBots || []).slice(0, 3).map((vb) => `@${safeUtf8(vb.botUsername)}`).join(', ');
        const cleanTitle = safeUtf8(t.title || 'Chat');
        return {
          is_checked: draft.selectedTargetIds.has(Number(t.channel_id)),
          blocks: [block.paragraph(rt.text(`${icon} ${cleanTitle}${t.username ? ` (@${safeUtf8(t.username)})` : ''} • via ${botTags}`))]
        };
      });
      b.list(infoLines);
      b.divider();

      for (const t of pageItems) {
        const checked = draft.selectedTargetIds.has(Number(t.channel_id));
        const icon = t.chat_type === 'channel' ? '📢' : '👥';
        const cleanTitle = safeTruncate(t.title || 'Chat', 26);
        const label = `${checked ? '✅' : '⬜'} ${icon} ${cleanTitle}`;
        b.buttons([
          richButton.callback(label, encodeCallback(id, 'toggle_target', t.channel_id), { style: checked ? 'primary' : undefined })
        ]);
      }

      if (totalPages > 1) {
        const nav = [];
        if (draft.targetPage > 0) nav.push(richButton.callback('◀ Prev', encodeCallback(id, 'tpage', draft.targetPage - 1)));
        nav.push(richButton.callback(`Page ${draft.targetPage + 1}/${totalPages}`, encodeCallback('noop')));
        if (draft.targetPage < totalPages - 1) nav.push(richButton.callback('Next ▶', encodeCallback(id, 'tpage', draft.targetPage + 1)));
        b.buttons(nav);
      }
    }

    if (superAdmin && dmCount > 0) {
      b.buttons([
        richButton.callback(
          `${draft.includeDmUsers ? '✅' : '⬜'} 👤 Include Bot DM Users (${dmCount})`,
          encodeCallback(id, 'toggle_dm_users'),
          { style: draft.includeDmUsers ? 'primary' : undefined }
        )
      ]);
    }

    b.buttons([
      richButton.callback('✅ Select All Shown', encodeCallback(id, 'select_all')),
      richButton.callback('⬜ Deselect All', encodeCallback(id, 'clear_targets'))
    ]);
    b.buttons([
      richButton.callback('➕ Add Channel / GC', encodeCallback(id, 'add_target'), { style: 'primary' }),
      richButton.callback('🔄 Re-Verify Live', encodeCallback(id, 'reverify_targets'))
    ]);
    b.buttons([
      richButton.callback('« Done / Back to Studio', encodeCallback(id, 'open'), { style: 'success' })
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function renderBotPicker(ctx) {
    const tgId = String(ctx.tgId);
    const draft = getDraft(tgId);
    const { bots, targets } = await loadAccessibleBotsAndTargets(ctx, tgId);

    const b = new RichMessageBuilder();
    b.bannerHeader([
      '🤖 SELECT SENDER BOT 🤖',
      'deliver through main bot, any clone, or auto cross-bot ♡'
    ], { size: 2 });

    const activeBots = bots.filter((bot) => bot.api);
    b.quote(rt.concat(
      rt.bold('Choose which bot sends the broadcast:\n'),
      rt.text('• 🌐 Auto Cross-Bot routes each target through its verified bot (Main Bot preferred, or Clone Bot).\n'),
      rt.text('• Choosing a specific Clone Bot broadcasts exclusively through that clone (only showing targets that clone can post to!).')
    ));
    b.divider();

    b.buttons([
      richButton.callback(
        `${draft.senderBotId === 'auto' ? '✅' : '🌐'} Auto Cross-Bot (${targets.length} verified)`,
        encodeCallback(id, 'set_bot', 'auto'),
        { style: draft.senderBotId === 'auto' ? 'primary' : undefined }
      )
    ]);

    for (const bot of activeBots.slice(0, 10)) {
      const targetCount = targets.filter((t) => (t.verifiedBots || []).some((vb) => String(vb.botId) === String(bot.botId))).length;
      const selected = String(draft.senderBotId) === String(bot.botId);
      const badge = bot.isMain ? '👑 Main' : '🤖 Clone';
      b.buttons([
        richButton.callback(
          `${selected ? '✅ ' : ''}${badge} @${bot.botUsername} (${targetCount} targets)`,
          encodeCallback(id, 'set_bot', bot.botId),
          { style: selected ? 'primary' : undefined }
        )
      ]);
    }

    b.buttons([
      richButton.callback('« Back to Studio', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function handleLaunchBroadcast(ctx) {
    const tgId = String(ctx.tgId);
    const draft = getDraft(tgId);
    if (!draft.items.length) {
      return renderStudio(ctx, { notice: '✕ Add content first before launching broadcast!' });
    }

    const { bots, targets: allVerified } = await loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh: true });
    const filteredTargets = filterTargetsBySender(allVerified, draft.senderBotId);
    const selectedTargets = filteredTargets.filter((t) => draft.selectedTargetIds.has(Number(t.channel_id)));

    const platformOwner = isPlatformOwner(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller });
    const superAdmin = platformOwner
      || isBotSuperAdmin(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller })
      || bots.some((b) => !b.isMain && Number(b.ownerTgId) === Number(tgId));

    const dmRecipients = draft.includeDmUsers ? collectDmRecipientPairs(bots, draft.senderBotId, superAdmin) : [];

    if (!selectedTargets.length && !dmRecipients.length) {
      return renderStudio(ctx, { notice: '✕ No verified selected channels, groups, or DM users remain after live verification.' });
    }

    const bufferCache = new Map();
    const channelResults = [];

    const executeDelivery = async () => {
      for (const target of selectedTargets) {
        await app.jobPlanner?.yieldIfStressed?.('broadcast');
        const sender = resolveSenderBotForTarget(target, draft.senderBotId, bots);
        if (!sender?.api) {
          channelResults.push({
            target,
            ok: false,
            error: 'No verified bot available to post in this chat'
          });
          continue;
        }

        // Live pre-flight verification right before sending!
        const liveCheck = await verifyBotCanPostInTarget(sender.api, target.channel_id, {
          allowGroups: target.chat_type !== 'channel',
          catchErrors: true
        });
        if (!liveCheck.ok) {
          if (liveCheck.definitive && sender.botId) {
            app.db?.markBotChannelUnavailable?.(sender.botId, target.channel_id, { bot_username: sender.botUsername });
          }
          channelResults.push({
            target,
            sender,
            ok: false,
            error: liveCheck.reason || 'Bot lacks permission to post'
          });
          continue;
        }

        try {
          await deliverBroadcastToTarget({
            targetApi: sender.api,
            targetBotId: sender.botId,
            chatId: target.channel_id,
            items: draft.items,
            richCard: draft.richCard,
            slideMode: draft.slideMode,
            buttonRows: draft.buttonRows,
            autoCustomEmoji: draft.autoCustomEmoji,
            customEmojiRegistry: app.customEmojiRegistry,
            bufferCache
          });
          channelResults.push({ target, sender, ok: true });
        } catch (err) {
          channelResults.push({
            target,
            sender,
            ok: false,
            error: err?.description || err?.message || 'Delivery failed'
          });
        }
      }

      for (const pair of dmRecipients) {
        await app.jobPlanner?.yieldIfStressed?.('broadcast');
        try {
          await deliverBroadcastToTarget({
            targetApi: pair.bot.api,
            targetBotId: pair.bot.botId,
            chatId: pair.chatId,
            items: draft.items,
            richCard: draft.richCard,
            slideMode: draft.slideMode,
            buttonRows: draft.buttonRows,
            autoCustomEmoji: draft.autoCustomEmoji,
            customEmojiRegistry: app.customEmojiRegistry,
            bufferCache
          });
          dmOk++;
        } catch {
          dmFail++;
        }
      }
    };

    let dmOk = 0;
    let dmFail = 0;
    if (typeof app.jobPlanner?.schedule === 'function') {
      await app.jobPlanner.schedule('broadcast', { dedupeKey: `bcast_${tgId}` }, executeDelivery);
    } else {
      await executeDelivery();
    }

    const chOk = channelResults.filter((r) => r.ok).length;
    const chFail = channelResults.length - chOk;

    const b = new RichMessageBuilder();
    b.bannerHeader([
      (chOk + dmOk) > 0 ? '🎉 BROADCAST DELIVERED! 🎉' : '⚠️ BROADCAST FAILED',
      `${chOk}/${channelResults.length} chats • ${dmOk}/${dmRecipients.length} DM users`
    ], { size: 1 });

    const lines = [
      `📦 Content: ${summarizeBroadcastItems(draft.items)}`,
      `🤖 Mode: ${resolveSenderLabel(bots, draft.senderBotId)}`
    ];
    for (const r of channelResults.slice(0, 12)) {
      const icon = r.target.chat_type === 'channel' ? '📢' : '👥';
      const via = r.sender ? ` (@${safeUtf8(r.sender.botUsername)})` : '';
      const cleanTitle = safeUtf8(r.target.title || 'Chat');
      if (r.ok) {
        lines.push(`• ✅ ${icon} ${cleanTitle}${via}`);
      } else {
        lines.push(`• ✕ ${icon} ${cleanTitle}${via} — ${safeUtf8(r.error)}`);
      }
    }
    if (channelResults.length > 12) {
      lines.push(`… +${channelResults.length - 12} more chat results (${chOk} ok, ${chFail} failed)`);
    }
    if (dmRecipients.length > 0) {
      lines.push(`• 👤 DM Audience: ${dmOk} delivered${dmFail ? `, ${dmFail} blocked/failed` : ''}`);
    }

    b.list(lines);
    b.divider();
    b.buttons([
      richButton.callback('📡 Back to Broadcast Studio', encodeCallback(id, 'open'), { style: 'primary' }),
      richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  return {
    id,
    getDraft: (tgId) => drafts.get(String(tgId)) || null,

    registerStateHandlers(sm) {
      sm.register(States.BROADCAST_COMPOSE, {
        onMessage: async (sctx, message) => {
          const tgId = String(sctx.tgId);
          const api = sctx.api || app.telegram?.api;
          const me = api?.me?.id ? api.me : await api?.getMe?.().catch(() => null);
          const item = extractBroadcastItemFromMessage(message, {
            sourceApi: api,
            sourceBotId: me?.id ?? null
          });
          if (!item) return false;

          const draft = getDraft(tgId);
          draft.items.push(item);

          const targetChatId = message.chat?.id || sctx.chatId || tgId;
          const renderCtx = {
            ...sctx,
            tgId,
            api,
            chatId: targetChatId,
            messageId: sctx.screenMessageId,
            fromMedia: false,
            forceNew: !sctx.screenMessageId,
            editScreen: async (rich) => {
              if (sctx.screenMessageId && api?.editMessageRich) {
                try {
                  return await api.editMessageRich(targetChatId, sctx.screenMessageId, rich);
                } catch {}
              }
              const sent = await api.sendRichMessage(targetChatId, rich);
              if (sent?.message_id) sm.update(tgId, { screenMessageId: sent.message_id });
              return sent;
            },
            replyRich: async (rich) => {
              const sent = await api.sendRichMessage(targetChatId, rich);
              if (sent?.message_id) sm.update(tgId, { screenMessageId: sent.message_id });
              return sent;
            }
          };

          // Coalesce rapid updates belonging to the same Telegram album into one clean screen refresh
          if (item.mediaGroupId) {
            const key = `${tgId}:${item.mediaGroupId}`;
            const existingTimer = composeDebounceTimers.get(key);
            if (existingTimer) clearTimeout(existingTimer);
            const timer = setTimeout(() => {
              composeDebounceTimers.delete(key);
              void renderComposeScreen(renderCtx, {
                notice: `✓ Album captured (${draft.items.length} item(s) stacked)! Send more or tap Done Composing ♡`
              }).catch(() => {});
            }, 450);
            timer.unref?.();
            composeDebounceTimers.set(key, timer);
          } else {
            await renderComposeScreen(renderCtx, {
              notice: `✓ Added [${item.kind.toUpperCase()}] (${draft.items.length} item(s) stacked). Send more or tap Done Composing ♡`
            });
          }
          return true;
        },
        onTimeout: async (sctx) => {
          const api = sctx?.api || app.telegram?.api;
          await api?.sendMessage?.(sctx.chatId, '<blockquote>♡ Broadcast compose timed out — your draft is preserved in /broadcast ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
        }
      });

      sm.register(States.BROADCAST_BUTTONS_INPUT, {
        onMessage: async (sctx, message) => {
          const text = String(message.text || '').trim();
          if (!text || text.startsWith('/cancel')) return false;
          const tgId = String(sctx.tgId);
          const api = sctx.api || app.telegram?.api;
          const draft = getDraft(tgId);
          const targetChatId = message.chat?.id || sctx.chatId || tgId;

          if (/^(?:none|clear|off)$/i.test(text)) {
            draft.buttonRows = [];
            await sm.reset(tgId, { reason: 'broadcast-buttons-cleared' });
            await renderStudio({ ...sctx, tgId, api, chatId: targetChatId, forceNew: true }, { notice: '🗑 Attached buttons cleared.' });
            return true;
          }

          const rows = parseBroadcastButtonLines(text);
          if (!rows.length) {
            await api.sendMessage(
              targetChatId,
              '<blockquote>✕ Could not parse button lines.\n\nUse format:\n<code>Open Channel | https://t.me/channel</code>\n<code>Copy ID | copy:HELLO</code></blockquote>',
              { parse_mode: 'HTML' }
            ).catch(() => {});
            return true;
          }

          draft.buttonRows = rows;
          await sm.reset(tgId, { reason: 'broadcast-buttons-saved' });
          const count = rows.reduce((n, r) => n + r.length, 0);
          await renderStudio(
            {
              ...sctx,
              tgId,
              api,
              chatId: targetChatId,
              forceNew: true,
              editScreen: async (r) => api.sendRichMessage(targetChatId, r),
              replyRich: async (r) => api.sendRichMessage(targetChatId, r)
            },
            { notice: `✓ Attached ${count} custom button(s) to your post!` }
          );
          return true;
        },
        onTimeout: async (sctx) => {
          const api = sctx?.api || app.telegram?.api;
          await api?.sendMessage?.(sctx.chatId, '<blockquote>♡ Button input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
        }
      });

      sm.register(States.BROADCAST_ADD_TARGET, {
        onMessage: async (sctx, message) => {
          const tgId = String(sctx.tgId);
          const api = sctx.api || app.telegram?.api;
          const draft = getDraft(tgId);
          const targetChatId = message.chat?.id || sctx.chatId || tgId;

          const forwardedChat = message.forward_from_chat || message.forward_origin?.chat || null;
          const rawText = (message.text ?? message.caption ?? '').trim();
          const inputs = forwardedChat?.id
            ? [forwardedChat]
            : rawText.split(/[\s,;\n]+/).map((s) => s.trim()).filter(Boolean);

          if (!inputs.length) return false;

          const { bots } = await loadAccessibleBotsAndTargets(sctx, tgId);
          const candidateBots = draft.senderBotId !== 'auto'
            ? bots.filter((b) => String(b.botId) === String(draft.senderBotId))
            : bots.filter((b) => b.api);

          const added = [];
          const rejected = [];

          for (const entry of inputs) {
            const label = typeof entry === 'object' ? (entry.title || entry.id) : String(entry);
            let verifiedAny = false;
            let lastReason = 'Bot is not a member or lacks posting permissions';

            for (const bot of candidateBots) {
              if (!bot.api) continue;
              const check = await verifyBotCanPostInTarget(bot.api, entry, { allowGroups: true, catchErrors: true });
              if (check.ok && check.chat) {
                const callerIsOwnerOrAdmin = isPlatformOwner(app.settings, tgId, { controller: sctx.controller || app.telegram?.controller })
                  || isBotSuperAdmin(app.settings, tgId, { controller: sctx.controller || app.telegram?.controller })
                  || (!bot.isMain && Number(bot.ownerTgId) === Number(tgId));

                if (!callerIsOwnerOrAdmin && check.chat.type === 'channel') {
                  const callerMember = await bot.api.getChatMember(check.chat.id, Number(tgId)).catch(() => null);
                  if (!callerMember || !['creator', 'administrator'].includes(callerMember.status)) {
                    lastReason = 'only channel admins can add this channel';
                    continue;
                  }
                }

                app.db?.recordTelegramChannel?.({
                  channel_id: check.chat.id,
                  title: check.chat.title || label,
                  username: check.chat.username || null,
                  chat_type: check.chat.type || 'channel',
                  can_post: 1,
                  added_by: Number(tgId)
                });
                app.db?.recordBotChannelVerification?.({
                  bot_id: check.botId || bot.botId,
                  channel_id: check.chat.id,
                  bot_username: check.botUsername || bot.botUsername,
                  is_admin: check.isAdmin ? 1 : 0,
                  can_post: 1
                });
                draft.selectedTargetIds.add(Number(check.chat.id));
                const icon = check.chat.type === 'channel' ? '📢' : '👥';
                added.push(`✓ ${icon} <b>${escapeHtml(check.chat.title || label)}</b> (via @${escapeHtml(bot.botUsername)})`);
                verifiedAny = true;
              } else if (check.reason && check.reason !== 'missing_api') {
                lastReason = check.reason;
              }
            }

            if (!verifiedAny) {
              rejected.push(`• <b>${escapeHtml(label)}</b> — ${escapeHtml(lastReason)}`);
            }
          }

          if (!added.length && rejected.length) {
            await api.sendMessage(
              targetChatId,
              `<blockquote>✕ Could not verify target(s):\n${rejected.join('\n')}\n\nMake sure the selected bot is added & permitted to post, or tap Cancel ♡</blockquote>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
            return true;
          }

          await sm.reset(tgId, { reason: 'broadcast-target-added' });
          const summary = [...added, ...rejected].join('\n').replace(/<[^>]+>/g, '');
          await renderTargetsScreen(
            {
              ...sctx,
              tgId,
              api,
              chatId: targetChatId,
              forceNew: true,
              editScreen: async (r) => api.sendRichMessage(targetChatId, r),
              replyRich: async (r) => api.sendRichMessage(targetChatId, r)
            },
            { notice: summary }
          );
          return true;
        },
        onTimeout: async (sctx) => {
          const api = sctx?.api || app.telegram?.api;
          await api?.sendMessage?.(sctx.chatId, '<blockquote>♡ Target input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
        }
      });
    },

    async open(ctx) {
      return renderStudio(ctx, { forceRefresh: true });
    },

    async handle(ctx, action, args) {
      const tgId = String(ctx.tgId);
      const draft = getDraft(tgId);

      switch (action) {
        case 'open':
          await ctx.sm?.reset?.(tgId, { reason: 'broadcast-open' });
          return renderStudio(ctx);

        case 'open_bot': {
          await ctx.sm?.reset?.(tgId, { reason: 'broadcast-open-bot' });
          const arg = args?.[0];
          const { bots } = await loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh: true });
          const found = bots.find((b) => b.cloneRowId != null && String(b.cloneRowId) === String(arg))
            || bots.find((b) => String(b.botId) === String(arg));
          if (found) draft.senderBotId = String(found.botId);
          return renderStudio(ctx);
        }

        case 'reverify':
          return renderStudio(ctx, { forceRefresh: true, notice: '🛡 Re-verified all channels, groups, and clone bots live!' });

        case 'compose':
          return renderComposeScreen(ctx);

        case 'done_compose':
          await ctx.sm?.reset?.(tgId, { reason: 'broadcast-done-compose' });
          return renderStudio(ctx, { notice: draft.items.length ? `✓ Draft ready: ${summarizeBroadcastItems(draft.items)}` : null });

        case 'undo_item':
          draft.items.pop();
          return renderComposeScreen(ctx, { notice: '↩ Removed last item from stack.' });

        case 'clear_compose':
          draft.items = [];
          return renderComposeScreen(ctx, { notice: '🗑 Draft cleared.' });

        case 'clear_draft':
          draft.items = [];
          return renderStudio(ctx, { notice: '🗑 Draft cleared.' });

        case 'toggle_rich':
          draft.richCard = !draft.richCard;
          return renderStudio(ctx);

        case 'toggle_slides':
          draft.slideMode = !draft.slideMode;
          return renderStudio(ctx, { notice: draft.slideMode ? '🎞 Slide Card mode ON (up to 10 items per rich slideshow with buttons)' : '📦 Standard Telegram Album mode ON' });

        case 'toggle_ce':
          draft.autoCustomEmoji = !draft.autoCustomEmoji;
          return renderStudio(ctx, { notice: draft.autoCustomEmoji ? '🎀 Auto Custom Emoji upgrade ON for text & captions!' : 'Standard emojis kept as-is.' });

        case 'load_showcase':
          draft.items = [{
            kind: 'showcase',
            botName: ctx.bot?.botName || app.settings?.get?.('branding.botName') || 'Lancy',
            botUsername: ctx.bot?.botUsername || app.telegram?.botUsername || 'pappy_agent'
          }];
          draft.richCard = true;
          return renderStudio(ctx, { notice: '🌟 Loaded the A–Z Bot Capabilities Showcase Card! Preview it or tap ⚡ Send ALL!' });

        case 'broadcast_all': {
          const platformOwner = isPlatformOwner(app.settings, tgId, { controller: ctx.controller || app.telegram?.controller });
          if (!platformOwner) {
            return renderStudio(ctx, { notice: '🔒 1-Click System-Wide Broadcast is restricted to Platform Owners.' });
          }
          if (!draft.items.length) {
            draft.items = [{
              kind: 'showcase',
              botName: ctx.bot?.botName || app.settings?.get?.('branding.botName') || 'Lancy',
              botUsername: ctx.bot?.botUsername || app.telegram?.botUsername || 'pappy_agent'
            }];
            draft.richCard = true;
          }
          draft.senderBotId = 'auto';
          const { targets } = await loadAccessibleBotsAndTargets(ctx, tgId, { forceRefresh: true });
          for (const t of targets) draft.selectedTargetIds.add(Number(t.channel_id));
          draft.includeDmUsers = true;
          return handleLaunchBroadcast(ctx);
        }

        case 'attach_buttons': {
          await ctx.sm?.transition?.(tgId, States.BROADCAST_BUTTONS_INPUT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.bannerHeader(['🔘 ATTACH CUSTOM BUTTONS 🔘', 'works on text cards, media & 10-slide posts'], { size: 1 });
          b.details('📋 Examples (send 1 line per button row)', [
            block.list([
              rt.code('Watch Now | https://t.me/mychannel'),
              rt.code('Channel | https://t.me/a ; Group | https://t.me/b'),
              rt.code('Copy Code | copy:LANCY2026'),
              rt.code('Share Card | inline:showcase'),
              rt.text('Send "clear" to remove all attached buttons.')
            ])
          ], true);
          b.buttons([richButton.callback('« Cancel', encodeCallback(id, 'open'))]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'preview_self': {
          if (!draft.items.length) {
            return renderStudio(ctx, { notice: '✕ Nothing in draft to preview yet!' });
          }
          const previewApi = ctx.api || app.telegram?.api;
          await deliverBroadcastToTarget({
            targetApi: previewApi,
            chatId: ctx.chatId,
            items: draft.items,
            richCard: draft.richCard,
            slideMode: draft.slideMode,
            buttonRows: draft.buttonRows,
            autoCustomEmoji: draft.autoCustomEmoji,
            customEmojiRegistry: app.customEmojiRegistry,
            headerHtml: draft.items[0]?.kind === 'showcase' ? '' : '<b>👁 BROADCAST PREVIEW</b>',
            bufferCache: new Map()
          });
          return renderStudio({ ...ctx, forceNew: true }, { notice: '👁 Live preview sent above! Ready to broadcast whenever you are ♡' });
        }

        case 'pick_bot':
          return renderBotPicker(ctx);

        case 'set_bot':
          draft.senderBotId = args?.[0] ? String(args[0]) : 'auto';
          return renderStudio(ctx, { notice: `🤖 Sender updated!` });

        case 'targets':
          return renderTargetsScreen(ctx);

        case 'reverify_targets':
          return renderTargetsScreen(ctx, { forceRefresh: true, notice: '🛡 Live permissions refreshed!' });

        case 'filter':
          draft.filterType = ['all', 'channel', 'group'].includes(args?.[0]) ? args[0] : 'all';
          draft.targetPage = 0;
          return renderTargetsScreen(ctx);

        case 'tpage':
          draft.targetPage = Math.max(0, Number(args?.[0] || 0));
          return renderTargetsScreen(ctx);

        case 'toggle_target': {
          const cid = Number(args?.[0]);
          if (draft.selectedTargetIds.has(cid)) draft.selectedTargetIds.delete(cid);
          else draft.selectedTargetIds.add(cid);
          return renderTargetsScreen(ctx);
        }

        case 'toggle_dm_users':
          draft.includeDmUsers = !draft.includeDmUsers;
          return renderTargetsScreen(ctx);

        case 'select_all': {
          const { targets } = await loadAccessibleBotsAndTargets(ctx, tgId);
          const filtered = filterTargetsBySender(targets, draft.senderBotId).filter((t) => {
            if (draft.filterType === 'channel') return t.chat_type === 'channel';
            if (draft.filterType === 'group') return t.chat_type === 'group' || t.chat_type === 'supergroup';
            return true;
          });
          for (const t of filtered) draft.selectedTargetIds.add(Number(t.channel_id));
          return renderTargetsScreen(ctx);
        }

        case 'clear_targets':
          draft.selectedTargetIds.clear();
          draft.includeDmUsers = false;
          return renderTargetsScreen(ctx);

        case 'add_target': {
          await ctx.sm?.transition?.(tgId, States.BROADCAST_ADD_TARGET, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.bannerHeader([
            '➕ ADD CHANNEL OR GROUP CHAT ➕',
            'live bot verification before linking ♡'
          ], { size: 2 });
          b.quote(rt.concat(
            rt.bold('Send any @username, negative chat ID, or forward a post/message from the target Channel or Group!\n\n'),
            rt.text('Example: '), rt.code('@mychannel -1001234567890'), rt.text('\n\n'),
            rt.italic('The selected bot (Main or Clone) must already be in the Group or Admin in the Channel with Post rights! ♡')
          ));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'targets'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'launch':
          return handleLaunchBroadcast(ctx);

        default:
          return renderStudio(ctx);
      }
    }
  };
}
