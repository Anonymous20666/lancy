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

🎵 MUSIC · DOWNLOADS & LIVE CALLS
• /play <title artist> — finds the song and sends the full audio file with cover, details and lyrics. One step, no menu.
• /lyrics <title artist> — matched lyrics only.
• Reply /play to a voice note, audio or video to recognise the song.

🎧 VOICE CHAT DJ (groups — admins control playback)
• /vc — sets up the voice chat. The assistant joins, gets call rights and starts or reuses the call automatically when Lancy is an admin with Invite users, Add admins and Manage video chats.
• /vc <title artist> or /addq — search and queue audio. /vidc or /vplay — queue real video with sound.
• Reply /vc, /vidc or /stream to any song, voice note or video in the chat to play it live.
• /random <mood> — infinite radio from a mood or genre (up to 5 mixed).
• /player — one live dashboard: pause, skip, previous, seek ±10s, volume, repeat, shuffle, queue, lyrics. It updates in place instead of sending new messages.
• /stop — clears the queue and the assistant leaves right away. After 10 idle minutes it leaves on its own.
• Channels: /channel @name in DM gives you a private remote for a channel livestream.

📏 LIMITS YOU SHOULD KNOW
• Telegram only lets bots upload up to 50 MB. Bigger videos are compressed to fit when they'd still be watchable. If not, Lancy tells you why instead of failing silently.

📥 UNIVERSAL HD MEDIA DOWNLOADER & TIKTOK SEARCH (/grab, /download)
• Paste ANY link or type /grab <link> from TikTok (no watermark!), Instagram Reels, YouTube Shorts, Twitter/X, Pinterest, or Facebook.
• 🎬 TikTok Search: Type ${botTag} tt <topic> in any chat or tap "🎬 TikTok Search" in the Downloader menu to find viral clips!
• The bot grabs crystal-clear HD video or photo albums in seconds.
• If the video has a soundtrack or background song, the MP3 audio track is automatically extracted and delivered right alongside it!

🔍 PINTEREST HD AESTHETIC STUDIO (/search or /pint)
• Search millions of aesthetic wallpapers, anime art, fashion, and video loops.
• Choose your style: photos or video loops, depth, and pick your batch size (10 to 150+ picks!).
• Browse through albums with smooth ← Prev / Next → pagination and download your favorites in original quality.

🎀 STICKER STUDIO & WHATSAPP HUB (DM vs CHANNELS)
• Telegram Sticker Studio: Create packs from images, Pinterest pins, or imports in 1 click.
• In WhatsApp DM (Private chat):
  - .ping: Response latency & health check.
  - .menu: Complete WhatsApp command list.
  - .prefix <char>: Custom trigger symbol (e.g. .prefix !).
  - .s / .sticker: Turn any photo into a WhatsApp sticker.
  - .convert / .cv: Convert WhatsApp stickers or packs into Telegram format!
  - .tg <link>: Convert Telegram sticker pack link into WhatsApp format.
• In WhatsApp Channels (@newsletter):
  - Dedicated broadcasting outlet! Commands stay off in channels to eliminate spam.
  - Telegram control center: Select sticker packs, generate AI Aura captions, pick target channels, and publish with live real-time progress!
  - Auto pack splitting: Packs with >60 stickers are split into Part 1, Part 2 automatically.

📱 LIVE INLINE SEARCH EVERYWHERE
• Type ${botTag} <song name> in ANY chat to discover tracks and open their download search.
• Type ${botTag} pint <topic> in ANY chat to share HD aesthetic photos!
• Type ${botTag} tt <topic> in ANY chat to find trending TikTok clips!
• (Tip: Cloned bots must have /setinline enabled in @BotFather to activate live search in chats)

🤖 BRING YOUR OWN BOT (/clone in 60s)
• Want your own private bot? Send /clone in private DM to launch your branded clone with your own name, multi-language support (7 languages!), and audience broadcasting!

👥 GROUP CHATS & MULTITASKING
• Add the bot to your group chats for shared music drops, media downloads, and Pinterest searches.
• Groups have no AI conversation. Use commands, or reply to this bot with plain "play <title artist>" for download search.`;

    b.expandableBlockquote(guideText);
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
