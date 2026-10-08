import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, ACCENT, SPARK } from '../ui.js';
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
    ['stickers.defaultPackName', 'Default pack name'],
    ['stickers.creatorName', 'Creator name'],
    ['stickers.packEmoji', 'Pack emoji'],
    ['stickers.defaultStickerAmount', 'Default amount'],
    ['stickers.telegramFormat', 'Format (static/video)'],
    ['stickers.telegramStickersPerSet', 'TG stickers per set'],
    ['stickers.whatsappPhysicalPackSize', 'WA physical pack size']
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
    if (ctx.messageId && ctx.message) {
      await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich).catch(async () => {
        await ctx.api.sendRichMessage(ctx.chatId, rich);
      });
    } else {
      await ctx.api.sendRichMessage(ctx.chatId, rich);
    }
  }

  async function openMenu(ctx) {
    await ctx.sm.transition(ctx.tgId, States.SETTINGS, {
      context: {},
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('⚙ SETTINGS', 1);
    b.paragraph(rt.italic('everything is configurable ♡ safe changes apply instantly.'));
    b.divider();
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      b.buttons(CATEGORIES.slice(i, i + 2).map(([key, label]) =>
        richButton.callback(label, encodeCallback(id, 'category', key))));
    }
    b.divider();
    if (ctx.settings.needsRestart?.()) {
      b.paragraph(rt.concat(rt.bold('⚠ restart required'), rt.text(' — some changes need a controlled restart to take effect.')));
      b.buttons([richButton.callback('✓ I Restarted', encodeCallback(id, 'restartAck'))]);
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
    b.buttons(navButtons(id, { home: true }));
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
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
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
        const path = pendingEdits.get(sctx.tgId);
        if (!path || !message.text) return false;
        pendingEdits.delete(sctx.tgId);
        const value = parseValue(message.text);
        try {
          const result = app.settings.set(path, value);
          if (result.hotReloaded) {
            app.applyHotReload?.(path, value);
            await app.telegram.api.sendMessage(sctx.chatId, `♡ ${path} updated — applied instantly ♡`);
          } else if (result.restartRequired) {
            await app.telegram.api.sendMessage(sctx.chatId, `♡ ${path} saved — it needs a controlled restart to take effect ♡`);
          }
          app.db.audit(Number(sctx.tgId), 'settings.changed', { path, value: typeof value === 'string' && /token|key|secret/i.test(path) ? '***' : value });
        } catch (error) {
          await app.telegram.api.sendMessage(sctx.chatId, `♡ ${error.message}`);
        }
        // Edit applied — leave the SETTINGS state cleanly.
        await sctx.reset({ reason: 'edit-done' });
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
