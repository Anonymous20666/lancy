import { RichMessageBuilder, rt, block, richButton, encodeCallback } from '../rich.js';
import { navButtons } from '../ui.js';

/** Help / About — what Lancy is, how the workflow fits together using Bot API 10.3 toggles & lists. */
export function createHelpScreen({ app }) {
  const id = 'help';

  function render(ctx) {
    const botName = ctx.botName || 'Lancy Bot';
    const botTag = ctx.bot?.botUsername ? `@${ctx.bot.botUsername}` : '@bot';
    const b = new RichMessageBuilder();
    b.bannerHeader([
      `𓆩♡𓆪 ${botName.toUpperCase()} GUIDE 𓆩♡𓆪`,
      'your complete aesthetic studio guide'
    ], { size: 1 });
    b.paragraph(rt.bold('Tap any category below to expand clean tips — no clutter ♡'));
    b.spacer();

    b.details('🎬 Cinema, Movies & Voice Chat AI', [
      block.list([
        rt.text('/vc · /player — Prepare assistant in Voice Chat or open the live player deck.'),
        rt.text('/movie <title> · /movieai <ask> — Stream HD movies/multi-season series with synced audio & subtitles.'),
        rt.text('Lancy Voice AI — Say "Lancy listen" in VC (Owner/Sudo) to control decks, search videos, or pick episodes.')
      ])
    ], false);

    b.details('🎵 Music Studio, AI DJ & Recognition', [
      block.list([
        rt.text('/play <title> · /lyrics <title> — Download full audio with artwork & matched lyrics.'),
        rt.text('/addq · /vplay · /random <mood> — Queue live audio, music videos, or continuous radio.'),
        rt.text('Reply /play or /recognize to any audio/video/voice note to identify the song.')
      ])
    ], false);

    b.details('📥 Universal Downloader & Pinterest HD', [
      block.list([
        rt.text('/grab <link> — Save watermark-free TikTok, Reels, Shorts, X & FB videos + MP3 soundtracks.'),
        rt.text('/search <topic> · /pfp <name> — Browse HD Pinterest images, video loops & matching PFP slides.')
      ])
    ], false);

    b.details('✨ Stickers, Custom Emojis & Broadcasts', [
      block.list([
        rt.text('/stickers · /emojipack · /emojisuggest — Create packs & convert standard emojis to custom.'),
        rt.text('/broadcast · /postchannel · /autopost — Post 10-slide cards, buttons & rich updates across channels & GCs.'),
        rt.text(`/clone · ${botTag} <query> — Launch your own branded clone in 60s & use live inline search.`)
      ])
    ], false);

    b.divider();
    b.heading('⛧ essential commands', 3);
    b.table([
      [{ text: rt.bold('/start'), align: 'left', valign: 'middle' }, { text: 'Open the aesthetic dashboard', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/play'), align: 'left', valign: 'middle' }, { text: 'Download a full song in one step', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/vc'), align: 'left', valign: 'middle' }, { text: 'Voice chat: set up, play, or reply-to-stream', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/vidc'), align: 'left', valign: 'middle' }, { text: 'Voice chat with video', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/random'), align: 'left', valign: 'middle' }, { text: 'Infinite mood radio in voice chat', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/addq'), align: 'left', valign: 'middle' }, { text: 'Search and queue live-call audio', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/vplay'), align: 'left', valign: 'middle' }, { text: 'Queue live-call video + audio', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/player'), align: 'left', valign: 'middle' }, { text: 'Open the persistent player', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/moviecast'), align: 'left', valign: 'middle' }, { text: 'Allow/disallow movie broadcasts to all users', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/grab'), align: 'left', valign: 'middle' }, { text: 'Universal media downloader', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/search'), align: 'left', valign: 'middle' }, { text: 'Pinterest HD aesthetic search', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/lyrics'), align: 'left', valign: 'middle' }, { text: 'Matched lyrics for the current track', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/clone'), align: 'left', valign: 'middle' }, { text: 'Bring your own bot (60s)', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/setprefix'), align: 'left', valign: 'middle' }, { text: 'Change prefix trigger (/ to !)', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/postchannel'), align: 'left', valign: 'middle' }, { text: 'Post sticker pack to TG channel', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/autopost'), align: 'left', valign: 'middle' }, { text: 'Schedule multi-day drops (clock & calendar)', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/cancel'), align: 'left', valign: 'middle' }, { text: 'Cancel active operation', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/help'), align: 'left', valign: 'middle' }, { text: 'Open this guide', align: 'left', valign: 'middle' }]
    ], { compact: true });
    b.divider();
    const isGroup = Boolean(ctx.isGroup || (ctx.chatId && Number(ctx.chatId) < 0));
    if (!isGroup) {
      b.buttons([
        richButton.callback('📖 WhatsApp Detailed Guide', encodeCallback('whatsapp', 'help'), { style: 'primary' })
      ]);
    }
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
