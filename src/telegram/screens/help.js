import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';

/** Help / About — what Lancy is, how the workflow fits together. */
export function createHelpScreen({ app }) {
  const id = 'help';

  function render(ctx) {
    const { settings } = ctx;
    const botName = ctx.botName || 'Lancy Bot';
    const botTag = ctx.bot?.botUsername ? `@${ctx.bot.botUsername}` : '@bot';
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      `𓆩♡𓆪 ${botName.toUpperCase()} GUIDE 𓆩♡𓆪`,
      'your complete aesthetic studio guide ♡'
    ])));
    b.divider();
    b.paragraph(rt.bold('✨ Heads up! Tap the card below to see everything I can do for you ♡'));
    const guideText =
`✨ Welcome to your ultimate aesthetic all-in-one companion! Tap to uncover all superpowers:

🎵 HIGH-SPEED MUSIC & MP3 STREAMING
• Type /play <song> or /music <song> to stream & download high-speed 320k MP3s with official cover art!
• Need the file in your music player? Tap "🎵 Send Audio File" to save the raw audio directly into Telegram.
• Tap "📜 Lyrics" to sing along with synchronized, expandable lyrics cards!
• Heard a fire song in a video or voice note? Just reply or forward it to the bot — our Shazam recognizer identifies it instantly!

📥 UNIVERSAL HD MEDIA DOWNLOADER (/grab or /download)
• Paste ANY link or type /grab <link> from TikTok (no watermark!), Instagram Reels, YouTube Shorts, Twitter/X, Pinterest, or Facebook.
• The bot grabs crystal-clear HD video or photo albums in seconds.
• If the video has a soundtrack or background song, the MP3 audio track is automatically extracted and delivered right alongside it!

🔍 PINTEREST HD AESTHETIC STUDIO (/search or /pint)
• Search millions of aesthetic wallpapers, anime art, fashion, and video loops.
• Choose your style: photos or video loops, depth, and pick your batch size (10 to 150+ picks!).
• Browse through albums with smooth ← Prev / Next → pagination and download your favorites in original quality.

🎀 STICKER STUDIO & WHATSAPP SYNC
• Turn any picture, Pinterest pin, or meme into Telegram sticker packs in one click.
• Seamlessly publish sticker packs to your paired WhatsApp sessions and announcement channels.

📱 LIVE INLINE SEARCH EVERYWHERE
• Type ${botTag} <song name> in ANY chat or group!
• Preview tracks with album art in real-time and drop music directly into any conversation without leaving the chat!
• (Tip: Cloned bots must have /setinline enabled in @BotFather to activate live search in chats)

🤖 BRING YOUR OWN BOT (/clone in 60s)
• Want your own private bot? Send /clone in private DM to launch your branded clone with your own name, multi-language support (7 languages!), and audience broadcasting!

👥 GROUP CHATS & MULTITASKING
• Add the bot to your group chats for shared music drops, media downloads, and Pinterest searches.
• Zero spam: tag ${botTag} or use /play to search, keeping your chats clean and conflict-free!`;

    b.expandableBlockquote(guideText);
    b.divider();

    b.heading('⛧ essential commands', 3);
    b.table([
      [{ text: rt.bold('/start'), align: 'left', valign: 'middle' }, { text: 'Open the aesthetic dashboard', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/play'), align: 'left', valign: 'middle' }, { text: 'Play & download music/MP3', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/grab'), align: 'left', valign: 'middle' }, { text: 'Universal media downloader', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/search'), align: 'left', valign: 'middle' }, { text: 'Pinterest HD aesthetic search', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/lyrics'), align: 'left', valign: 'middle' }, { text: 'Get synchronized lyrics', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/clone'), align: 'left', valign: 'middle' }, { text: 'Bring your own bot (60s)', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/cancel'), align: 'left', valign: 'middle' }, { text: 'Cancel active operation', align: 'left', valign: 'middle' }],
      [{ text: rt.bold('/help'), align: 'left', valign: 'middle' }, { text: 'Open this guide', align: 'left', valign: 'middle' }]
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
