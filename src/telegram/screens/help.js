import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, ACCENT, SPARK } from '../ui.js';

/** Help / About — what Lancy is, how the workflow fits together. */
export function createHelpScreen({ app }) {
  const id = 'help';

  function render(ctx) {
    const { settings } = ctx;
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} HELP & ABOUT`, 1);
    b.divider();
    b.paragraph(rt.concat(
      rt.bold('✦ Lancy Bot'),
      rt.text(' is your personal control center. Telegram is the brain — WhatsApp is just where the stickers go out ♡')
    ));
    b.spacer();
    b.heading(`${ACCENT} the workflow`, 3);
    b.list([
      'search Pinterest deep & duplicate-free',
      'turn the best media into Telegram sticker packs',
      'preview everything before it ships',
      'publish to WhatsApp sessions & channels with a beautiful caption'
    ]);
    b.spacer();
    b.heading(`${ACCENT} good to know`, 3);
    b.list([
      'every media item is hashed (SHA-256 + perceptual) — you will not see the same image twice',
      'WhatsApp packs split automatically at the physical limit (60)',
      'nothing is ever published without your final POST ♡',
      'WhatsApp credentials stay on the server, isolated per session'
    ]);
    b.spacer();
    b.heading(`${ACCENT} commands`, 3);
    b.table([
      [{ text: rt.bold('/start'), align: 'left', valign: 'middle' }, { text: 'open the dashboard', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/cancel'), align: 'left', valign: 'middle' }, { text: 'cancel the current flow', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/help'), align: 'left', valign: 'middle' }, { text: 'this screen', align: 'left', valign: 'middle' }]
    ], { compact: true });
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic(`version ${app.version ?? '1.0.0'} • made with love ♡`));
    b.validate();
    return b.toJSON();
  }

  return {
    id,
    async open(ctx) {
      const rich = render(ctx);
      if (ctx.messageId && ctx.message) await ctx.editScreen(rich);
      else await ctx.replyRich(rich);
    },
    async handle(ctx, action) {
      if (action === 'open') await this.open(ctx);
      if (action === 'back') await ctx.screens.get('dashboard').open(ctx);
    }
  };
}
