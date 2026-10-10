import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';

/** Help / About — what Lancy is, how the workflow fits together. */
export function createHelpScreen({ app }) {
  const id = 'help';

  function render(ctx) {
    const { settings } = ctx;
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 HELP & ABOUT 𓆩♡𓆪',
      'your complete aesthetic studio ♡'
    ])));
    b.divider();
    b.paragraph(rt.concat(
      rt.bold('✦ Lancy Bot'),
      rt.text(' is your personal control center. Telegram is the brain — WhatsApp is where your packs shine ♡')
    ));
    b.spacer();
    b.heading('୨୧ the workflow', 3);
    b.list([
      'ʕ•ᴥ•ʔ search Pinterest deep & duplicate-free',
      '˙ᵕ˙ turn the best aesthetic picks into TG sticker packs',
      '૮꒰ ˶• ༝ •˶꒱ა preview HD albums before anything ships',
      '₊˚⊹♡ publish to WhatsApp sessions & channels with custom captions'
    ]);
    b.spacer();
    b.heading('𓆩♡𓆪 good to know', 3);
    b.list([
      'ʕ•ᴥ•ʔ every media item is hashed (SHA-256 + pHash) — no twin images',
      '˙ᵕ˙ WhatsApp packs split automatically at the physical limit (60)',
      '୨୧ nothing is ever published without your final POST approval ♡',
      '₊˚⊹♡ credentials stay encrypted on your server, isolated per session'
    ]);
    b.spacer();
    b.heading('⛧ commands', 3);
    b.table([
      [{ text: rt.bold('/start'), align: 'left', valign: 'middle' }, { text: 'open the dashboard', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/cancel'), align: 'left', valign: 'middle' }, { text: 'cancel current flow', align: 'left', valign: 'middle' }],
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
      await ctx.editScreen(rich);
    },
    async handle(ctx, action) {
      if (action === 'open') await this.open(ctx);
      if (action === 'back') await ctx.screens.get('dashboard').open(ctx);
    }
  };
}
