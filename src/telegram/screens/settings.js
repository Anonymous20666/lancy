import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { DEFAULT_SETTINGS, RESTART_REQUIRED_PATHS, flattenSettings } from '../../config/defaults.js';
import { truncate } from '../../utils/text.js';

/**
 * Settings screen — the COMPLETE configuration system, organized by
 * category. Safe values hot-reload; dangerous values are flagged honestly
 * as requiring a controlled restart.
 */
const CATEGORIES = [
  ['general', '♡ General'],
  ['telegram', '✦ Telegram'],
  ['whatsapp', '♡ WhatsApp'],
  ['pinterest', '✦ Pinterest'],
  ['stickers', '★ Stickers'],
  ['captions', '♡ Captions'],
  ['ai', '✦ AI'],
  ['media', '🖼 Media'],
  ['performance', '⚡ Performance'],
  ['storage', '🗄 Storage'],
  ['security', '🔒 Security'],
  ['logging', '🕘 Logging'],
  ['advanced', '⚙ Advanced']
];

// Editable scalar settings per category (path → label). Secrets are never shown.
const EDITABLE = {
  general: [
    ['general.botName', 'Bot name'],
    ['general.timezone', 'Timezone'],
    ['general.language', 'Language'],
    ['general.defaultStyle', 'Default style'],
    ['general.defaultCreatorName', 'Creator name']
  ],
  telegram: [
    ['telegram.paginationSize', 'Pagination size'],
    ['telegram.progressAnimation', 'Progress animation (true/false)'],
    ['telegram.previewBehavior', 'Preview behavior'],
    ['telegram.messageCleanup', 'Message cleanup (true/false)']
  ],
  whatsapp: [
    ['whatsapp.defaultPackName', 'WA pack name'],
    ['whatsapp.reconnectBehavior', 'Reconnect (auto/manual)'],
    ['whatsapp.pairingTimeoutSeconds', 'Pairing timeout (s)'],
    ['whatsapp.physicalStickerPackLimit', 'Physical pack limit'],
    ['whatsapp.publishingDelayMs', 'Publishing delay (ms)'],
    ['whatsapp.retryCount', 'Retry count'],
    ['whatsapp.channelCacheMinutes', 'Channel cache (min)']
  ],
  pinterest: [
    ['pinterest.defaultMode', 'Default mode'],
    ['pinterest.searchDepth', 'Search depth'],
    ['pinterest.resultCount', 'Result count'],
    ['pinterest.cacheDurationMinutes', 'Cache duration (min)'],
    ['pinterest.maxConcurrentSearches', 'Concurrent searches']
  ],
  stickers: [
    ['stickers.defaultPackName', 'TG pack name'],
    ['stickers.packNameTemplate', 'Pack naming template (3-part)'],
    ['stickers.creatorName', 'Creator name'],
    ['stickers.packEmoji', 'Pack emoji'],
    ['stickers.defaultStickerAmount', 'Default amount (e.g. 60)'],
    ['stickers.telegramFormat', 'Format (static/video)'],
    ['stickers.telegramStickersPerSet', 'TG stickers per set (max 120)']
  ],
  captions: [
    ['captions.defaultTemplate', 'Default template'],
    ['captions.defaultTitle', 'Default title'],
    ['captions.separatorStyle', 'Separator style'],
    ['captions.emojiStyle', 'Emoji style'],
    ['captions.aiAutoCaption', 'AI auto-caption (true/false)'],
    ['captions.previewBeforePublishing', 'Preview before publishing (true/false)']
  ],
  ai: [
    ['ai.enabled', 'Enabled (true/false)'],
    ['ai.style', 'Style'],
    ['ai.personality', 'Personality'],
    ['ai.creativity', 'Creativity (0–1)'],
    ['ai.maxTokens', 'Max tokens'],
    ['ai.timeoutSeconds', 'Timeout (s)'],
    ['ai.chatMode', 'Chat mode (true/false)']
  ],
  media: [
    ['media.maxDownloadBytes', 'Max download (bytes)'],
    ['media.imageFormat', 'Image format'],
    ['media.videoFormat', 'Video format'],
    ['media.compression', 'Compression'],
    ['media.cleanupIntervalMinutes', 'Cleanup interval (min)']
  ],
  performance: [
    ['performance.workerConcurrency', 'Worker concurrency'],
    ['performance.queueConcurrency', 'Queue concurrency'],
    ['performance.pinterestConcurrency', 'Pinterest concurrency'],
    ['performance.whatsappSessionConcurrency', 'WA session concurrency'],
    ['performance.aiConcurrency', 'AI concurrency'],
    ['performance.retryCount', 'Retry count']
  ],
  storage: [
    ['storage.cacheTtlMinutes', 'Cache TTL (min)'],
    ['storage.automaticCleanup', 'Automatic cleanup (true/false)'],
    ['storage.persistentSearchHistory', 'Persistent history (true/false)']
  ],
  security: [
    ['security.sessionCredentialPermissions', 'Credential permissions'],
    ['security.tokenProtection', 'Token protection (true/false)'],
    ['security.sessionIsolation', 'Session isolation (true/false)']
  ],
  logging: [
    ['logging.level', 'Level'],
    ['logging.fileLogs', 'File logs (true/false)'],
    ['logging.consoleLogs', 'Console logs (true/false)'],
    ['logging.auditLogs', 'Audit logs (true/false)'],
    ['logging.retentionDays', 'Retention (days)']
  ],
  advanced: [
    ['advanced.hotReload', 'Hot reload (true/false)'],
    ['advanced.debugMode', 'Debug mode (true/false)'],
    ['advanced.experimentalApis', 'Experimental APIs (true/false)'],
    ['advanced.maintenanceMode', 'Maintenance mode (true/false)']
  ]
};

export function createSettingsScreen({ app }) {
  const id = 'settings';
  const pendingEdits = new Map(); // tgId -> path

  async function editOrSend(ctx, rich) {
    if (typeof ctx?.editScreen === 'function') {
      return ctx.editScreen(rich);
    }
    const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.from?.id ?? ctx?.tgId;
    const messageId = ctx?.message?.message_id ?? ctx?.messageId;
    if (messageId && chatId) {
      try {
        return await app.telegram.api.editMessageRich(chatId, messageId, rich);
      } catch (err) {
        if (!/message is not modified/i.test(err?.message)) {
          return await app.telegram.api.sendRichMessage(chatId, rich);
        }
        return;
      }
    }
    if (chatId) {
      return await app.telegram.api.sendRichMessage(chatId, rich);
    }
  }

  async function openMenu(ctx) {
    await ctx.sm.transition(ctx.tgId, States.SETTINGS, {
      context: {},
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SETTINGS & CONFIG 𓆩♡𓆪',
      'live tuning & custom studio ♡'
    ])));
    b.divider();
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      b.buttons(CATEGORIES.slice(i, i + 2).map(([key, label]) =>
        richButton.callback(label, encodeCallback(id, 'category', key))));
    }
    b.divider();
    if (ctx.settings.needsRestart?.()) {
      b.paragraph(rt.concat(rt.bold('⚠ restart required'), rt.text(' — some changes need a controlled restart to take effect.')));
      b.buttons([richButton.callback('✓ I Restarted', encodeCallback(id, 'restartAck'), { style: 'success' })]);
      b.divider();
    }
    if (ctx.controller?.isOwner?.(ctx.tgId) || (app.settings.get('general.ownerIds') ?? []).map(Number).includes(Number(ctx.tgId))) {
      b.buttons([richButton.callback('👑 Manage Team Admins', encodeCallback(id, 'adminList'), { style: 'primary' })]);
      b.divider();
    }
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('secrets like tokens are never shown here ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function openCategory(ctx, category) {
    const b = new RichMessageBuilder();
    b.heading(`⚙ ${category.toUpperCase()}`, 2);
    if (['performance', 'storage', 'security', 'logging', 'advanced'].includes(category)) {
      b.blockquote('⚠️ Engine & system settings are automatically tuned by Lancy core.');
    }
    b.divider();
    const rows = (EDITABLE[category] ?? []).map(([path, label]) => [
      { text: label, align: 'left', valign: 'middle' },
      { text: rt.bold(formatValue(ctx.settings.get(path))), align: 'left', valign: 'middle' }
    ]);
    if (rows.length) {
      b.table(rows, { compact: true });
      b.divider();
      for (const [path, label] of EDITABLE[category]) {
        const restart = RESTART_REQUIRED_PATHS.has(path) ? ' ⚠' : '';
        b.buttons([richButton.callback(`✎ ${label}${restart}`, encodeCallback(id, 'edit', path))]);
      }
    } else {
      b.paragraph(rt.italic('this category is configured via .env / database ♡'));
    }
    b.divider();
    b.buttons([
      richButton.callback('« Back to Settings', encodeCallback(id, 'open')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askValue(ctx, path) {
    pendingEdits.set(ctx.tgId, path);
    await ctx.sm.transition(ctx.tgId, States.SETTINGS, {
      context: { editPath: path },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('✎ EDIT SETTING', 2);
    b.table(kvTable([
      ['Setting', path],
      ['Current', formatValue(ctx.settings.get(path))]
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('send the new value ♡'));
    if (RESTART_REQUIRED_PATHS.has(path)) {
      b.paragraph(rt.bold('⚠ this change requires a controlled restart to take effect.'));
    }
    if (path === 'stickers.packNameTemplate') {
      b.blockquote(
        '🌸 3-Part Pack Name Format:\n' +
        'Line 1: 🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸\n' +
        'Line 2: (Sticker name)\n' +
        'Line 3: ╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬\n\n' +
        '💡 Tip: Send a custom 3-part template with {{name}} or (Sticker name), or send just a name like "Toji" to change only the middle name!'
      );
    }
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function openAdminList(ctx) {
    const owners = (app.settings.get('general.ownerIds') ?? []).map(Number);
    const adminIds = (app.settings.get('telegram.adminIds') ?? []).map(Number);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 TEAM & ADMINS 𓆩♡𓆪',
      'workspace access & permissions'
    ])));
    b.divider();

    b.heading('👑 GENERAL OWNERS', 3);
    for (const ownerId of owners) {
      const row = app.db.get('SELECT username, first_name, last_name FROM users WHERE tg_id = ?', ownerId);
      const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ') || `Owner ${ownerId}`;
      const handle = row?.username ? `@${row.username}` : '';
      b.paragraph(`• *${name}* ${handle ? `(${handle})` : ''} — \`${ownerId}\``);
    }
    b.divider();

    b.heading('🎀 TEAM ADMINS (ISOLATED WORKSPACES)', 3);
    if (!adminIds.length) {
      b.paragraph(rt.italic('no administrators currently allocated ♡'));
    } else {
      for (const adminId of adminIds) {
        let row = app.db.get('SELECT username, first_name, last_name FROM users WHERE tg_id = ?', adminId);
        if (!row?.first_name) {
          try {
            const chat = await app.telegram.api.getChat(adminId);
            if (chat) {
              row = { first_name: chat.first_name, last_name: chat.last_name, username: chat.username };
              app.db.run(
                'UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE tg_id = ?',
                chat.first_name, chat.last_name, chat.username, adminId
              );
            }
          } catch {}
        }
        const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ') || `Admin ${adminId}`;
        const handle = row?.username ? `@${row.username}` : '';
        b.paragraph(`• *${name}* ${handle ? `(${handle})` : ''} — \`${adminId}\``);
        b.buttons([
          richButton.callback(`🗑 Remove ${truncate(name, 15)}`, encodeCallback(id, 'adminRemove', String(adminId)), { style: 'danger' })
        ]);
      }
    }
    b.divider();
    b.buttons([
      richButton.callback('➕ Allocate New Admin', encodeCallback(id, 'adminAddAsk'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Back to Settings', encodeCallback(id, 'open'))
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function adminAddAsk(ctx) {
    await ctx.sm.transition(ctx.tgId, States.SETTINGS, {
      context: { adminAdd: true },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('➕ ALLOCATE ADMIN', 2);
    b.paragraph(rt.italic('send the Telegram user ID to give admin access (e.g. 8831887192) ♡'));
    b.blockquote('💡 The bot will automatically extract their Telegram name and configure their isolated workspace.');
    b.divider();
    b.buttons([
      richButton.callback('« Cancel', encodeCallback(id, 'adminList'))
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  function parseValue(raw) {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    return v;
  }

  function formatValue(value) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return JSON.stringify(value);
    return truncate(String(value), 60);
  }

  function registerStateHandlers(sm) {
    sm.register(States.SETTINGS, {
      onMessage: async (sctx, message) => {
        const chatId = sctx.chatId;

        // Handle Admin Allocation ID submission
        if (sctx.context?.adminAdd) {
          const targetId = Number(message.text?.trim());
          if (!targetId || isNaN(targetId) || targetId <= 0) {
            return app.telegram.api.sendMessage(chatId, '♡ Invalid Telegram ID. Please provide numeric ID (e.g. 8831887192) ♡');
          }
          let targetChat = null;
          try {
            targetChat = await app.telegram.api.getChat(targetId);
          } catch {}
          const firstName = targetChat?.first_name ?? '';
          const lastName = targetChat?.last_name ?? '';
          const username = targetChat?.username ?? '';
          const name = [firstName, lastName].filter(Boolean).join(' ') || `Admin ${targetId}`;
          const adminIds = [...new Set([...(app.settings.get('telegram.adminIds') ?? []).map(Number), targetId])];
          await app.settings.set('telegram.adminIds', adminIds);
          app.db.run(
            'INSERT INTO users (tg_id, username, first_name, last_name, is_admin, is_allowed) VALUES (?, ?, ?, ?, 1, 1) ON CONFLICT(tg_id) DO UPDATE SET is_admin = 1, is_allowed = 1, username = COALESCE(excluded.username, users.username), first_name = COALESCE(excluded.first_name, users.first_name), last_name = COALESCE(excluded.last_name, users.last_name)',
            targetId, username || null, firstName || null, lastName || null
          );
          await sctx.reset({ reason: 'admin-added' });
          await app.telegram.api.sendMessage(chatId, `✓ Allocated Admin: *${name}* ${username ? `(@${username})` : ''} (\`${targetId}\`) ♡`);
          return openAdminList({ tgId: sctx.tgId, chatId, messageId: null, controller: app.telegram });
        }

        const path = pendingEdits.get(sctx.tgId);
        if (!path || !message.text) return false;
        pendingEdits.delete(sctx.tgId);

        let value = parseValue(message.text);
        if (path === 'stickers.packNameTemplate') {
          // If simple sticker name was sent (e.g. "Toji"), inject into default template
          const text = message.text.trim();
          if (!text.includes('{{') && !text.includes('(') && !text.includes('\n')) {
            value = `🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸\n\n${text}\n\n╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬`;
          }
        }

        let errorMsg = null;
        let result = null;
        try {
          result = app.settings.setForUser ? app.settings.setForUser(Number(sctx.tgId), path, value) : app.settings.set(path, value);
          if (result.hotReloaded) {
            app.applyHotReload?.(path, value);
          }
          app.db.audit(Number(sctx.tgId), 'settings.changed', {
            path,
            value: typeof value === 'string' && /token|key|secret/i.test(path) ? '***' : value
          });
        } catch (error) {
          errorMsg = error.message;
        }

        // Leave SETTINGS state cleanly
        await sctx.reset({ reason: 'edit-done' });

        // Identify category for the back button
        const category = Object.keys(EDITABLE).find((cat) => EDITABLE[cat].some(([p]) => p === path)) || 'general';

        // Render confirmation in-place in the screen message
        const b = new RichMessageBuilder();
        if (errorMsg) {
          b.heading('𓆩♡𓆪 CONFIGURATION ERROR', 2);
          b.blockquote(`ʕ•ᴥ•ʔ ${errorMsg}`);
        } else {
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 SETTING UPDATED 𓆩♡𓆪',
            path
          ])));
          b.divider();
          b.table([
            [
              { text: 'ʕ•ᴥ•ʔ Setting', align: 'left', valign: 'middle' },
              { text: rt.bold(path), align: 'right', valign: 'middle' }
            ],
            [
              { text: '˙ᵕ˙ Value', align: 'left', valign: 'middle' },
              { text: rt.bold(formatValue(value)), align: 'right', valign: 'middle' }
            ],
            [
              { text: '୨୧ Status', align: 'left', valign: 'middle' },
              { text: result?.hotReloaded ? '✦ Applied instantly' : (result?.restartRequired ? '⚠ Needs restart' : '✓ Saved'), align: 'right', valign: 'middle' }
            ]
          ], { compact: true });
          b.divider();
          b.blockquote(result?.hotReloaded
            ? '₊˚⊹♡ setting updated & applied in real-time!\nʕ•ᴥ•ʔ everything is running with your new settings.'
            : '₊˚⊹♡ setting saved!\nʕ•ᴥ•ʔ note: will take full effect after next restart.');
        }
        b.divider();
        b.buttons([
          richButton.callback(`« Back to ${category}`, encodeCallback(id, 'category', category)),
          richButton.callback('⚙ All Settings', encodeCallback(id, 'open'))
        ]);
        b.buttons([
          richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
        ]);
        b.validate();

        const sent = await app.telegram.api.sendRichMessage(chatId, b.toJSON());
        if (sent?.message_id) {
          app.telegram.userScreenMessage?.set(sctx.tgId, { chatId, messageId: sent.message_id });
        }
        return true;
      }
    });
  }

  return {
    id,
    registerStateHandlers,
    async open(ctx) {
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return openMenu(ctx);
        case 'adminList':
          return openAdminList(ctx);
        case 'adminAddAsk':
          return adminAddAsk(ctx);
        case 'adminRemove': {
          const targetId = Number(args[0]);
          if (targetId && (ctx.controller?.isOwner?.(ctx.tgId) || (app.settings.get('general.ownerIds') ?? []).map(Number).includes(Number(ctx.tgId)))) {
            const adminIds = (app.settings.get('telegram.adminIds') ?? []).map(Number).filter((x) => x !== targetId);
            await app.settings.set('telegram.adminIds', adminIds);
            app.db.run('UPDATE users SET is_admin = 0 WHERE tg_id = ?', targetId);
          }
          return openAdminList(ctx);
        }
        case 'category':
          return openCategory(ctx, args[0]);
        case 'edit':
          return askValue(ctx, args[0]);
        case 'restartAck':
          ctx.settings.clearRestartFlags?.();
          return ctx.reply('♡ noted — restart me when you are ready ♡');
        case 'back':
          return ctx.sm.back(ctx.tgId).then(() => openMenu(ctx));
        case 'cancel':
          pendingEdits.delete(ctx.tgId);
          await ctx.sm.cancel(ctx.tgId);
          return openMenu(ctx);
        default:
          return openMenu(ctx);
      }
    }
  };
}
