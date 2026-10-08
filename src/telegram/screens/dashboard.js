import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable, statusDot, ACCENT, SPARK } from '../ui.js';
import { formatDateTime, timeAgo } from '../../utils/text.js';

/**
 * Dashboard — the /start hero. A beautiful Rich Message with live status and
 * the primary navigation. Not a wall of buttons: six sections, grouped.
 */
export function createDashboardScreen({ app }) {
  const id = 'dashboard';

  async function gatherStats(ctx) {
    const { db, settings } = ctx;
    const userId = Number(ctx.tgId);
    const sessions = app.whatsapp?.listForUser(userId) ?? [];
    const online = sessions.filter((s) => s.status === 'online').length;
    const packs = db.get('SELECT COUNT(*) AS c FROM sticker_packs WHERE user_id = ?', userId)?.c ?? 0;
    const searches = db.get('SELECT COUNT(*) AS c FROM pinterest_searches WHERE user_id = ?', userId)?.c ?? 0;
    const delivered = db.get('SELECT COUNT(*) AS c FROM user_media_history WHERE user_id = ?', userId)?.c ?? 0;
    const ai = await app.ai?.status().catch(() => ({ enabled: false, available: false, provider: '—' }));
    const cacheStats = app.media?.cache.stats() ?? { entries: 0, totalBytes: 0 };
    return { sessions, online, packs, searches, delivered, ai, cacheStats };
  }

  function render(ctx, stats) {
    const { settings } = ctx;
    const tz = settings.get('general.timezone') ?? 'UTC';
    const botName = settings.get('general.botName') ?? 'Lancy Bot';
    const firstName = ctx.user?.first_name ?? 'bestie';

    const b = new RichMessageBuilder();
    b.paragraph(rt.concat(
      rt.bold(banner([
        `${SPARK} ${botName.toUpperCase()} ${SPARK}`,
        'your cute little control center ♡'
      ]))
    ));
    b.spacer();
    b.paragraph(rt.concat(rt.italic(`welcome back, ${firstName} ♡`), rt.text(`\n${formatDateTime(new Date(), tz)}`)));
    b.divider();

    // Live status card
    b.heading(`${ACCENT} right now`, 3);
    b.table(kvTable([
      ['WhatsApp', `${statusDot(stats.online > 0 ? 'online' : 'offline')} ${stats.online}/${stats.sessions.length} sessions online`],
      ['Sticker packs', `${stats.packs} created`],
      ['Pinterest', `${stats.searches} searches • ${stats.delivered} saved`],
      ['AI assistant', stats.ai?.enabled ? `${statusDot(stats.ai.available ? 'online' : 'offline')} ${stats.ai.provider}` : 'off'],
      ['Media cache', `${stats.cacheStats.entries} files`]
    ]), { compact: true });
    b.divider();

    // Primary navigation — six sections in a 2-column feel via button rows.
    b.heading(`${ACCENT} control center`, 3);
    b.buttons([
      richButton.callback('♡ Pinterest', encodeCallback('pinterest', 'open')),
      richButton.callback('✦ TG Stickers', encodeCallback('stickers', 'open'))
    ]);
    b.buttons([
      richButton.callback('♡ WhatsApp', encodeCallback('whatsapp', 'open')),
      richButton.callback('✦ AI Assistant', encodeCallback('ai', 'open'))
    ]);
    b.buttons([
      richButton.callback('⚙ Settings', encodeCallback('settings', 'open')),
      richButton.callback('? Help', encodeCallback('help', 'open'))
    ]);

    b.footer(rt.concat(rt.italic('made with love by '), rt.bold(settings.get('general.defaultCreatorName') ?? 'Lancy'), rt.italic(' ♡')));
    b.validate();
    return b.toJSON();
  }

  return {
    id,
    async open(ctx) {
      const stats = await gatherStats(ctx);
      const rich = render(ctx, stats);
      if (ctx.messageId && ctx.message) {
        await ctx.editScreen(rich);
      } else {
        await ctx.replyRich(rich);
      }
    },
    async handle(ctx, action, args) {
      if (action === 'open' || action === 'refresh') {
        await this.open(ctx);
      }
    }
  };
}
