import { RichMessageBuilder, rt, block, richButton } from './rich.js';
import { escapeHtml } from '../media/lyrics.js';

/**
 * Build the flagship Bot API 10.3 "What This Bot Can Do (A–Z)" Showcase Card.
 * Designed for 1-click system-wide broadcasting across Users, Groups, Channels, and Clones:
 * clean Bot API 10.3 native heading, generous spacing, native toggleable `details` accordions
 * containing `list` bullets (never an overwhelming wall of slash commands), footer, and CTAs.
 */
export function buildSystemShowcaseCard({
  botName = 'Lancy',
  botUsername = 'pappy_agent',
  includeCta = true,
  extraButtons = []
} = {}) {
  const cleanName = String(botName || 'Lancy').trim();
  const cleanHandle = String(botUsername || 'pappy_agent').replace(/^@/, '').trim();

  const b = new RichMessageBuilder();
  b.bannerHeader([
    `𓆩♡𓆪 ${cleanName.toUpperCase()} · ALL-IN-ONE STUDIO 𓆩♡𓆪`,
    'cinema • music • downloads • stickers • smart broadcasts'
  ], { size: 1 });

  b.paragraph(rt.bold('Everything you need in Telegram — in one fast, aesthetic companion.'));
  b.spacer();
  b.pullquote(
    rt.italic('Tap any category below to expand what we can do — zero clutter, pure power.'),
    rt.text(`@${cleanHandle}`)
  );
  b.spacer();

  b.details('🎬  Cinema, TV Series & Voice Chat AI', [
    block.list([
      rt.concat(rt.bold('HD Movies & Multi-Season Series — '), rt.text('Stream full films & series live in Voice Chat or download clean MP4s.')),
      rt.concat(rt.bold('Synced Subtitles & Multi-Audio — '), rt.text('Switch audio languages, screen-burn captions, and stream quality on the fly.')),
      rt.concat(rt.bold('Self-Aware Lancy VC AI — '), rt.text('Control playback, pick numbered results, search videos & load any episode straight by voice.'))
    ])
  ], false);
  b.spacer();

  b.details('🎵  Music Studio, AI DJ & Recognition', [
    block.list([
      rt.concat(rt.bold('Instant Track & Cover Grabs — '), rt.text('Download high-bitrate tracks with embedded artwork and accurate lyrics.')),
      rt.concat(rt.bold('Live VC DJ & Mood Radio — '), rt.text('Continuous Afrobeats/mood mixes, studio EQ presets, and group voting polls.')),
      rt.concat(rt.bold('Built-in Song Finder — '), rt.text('Reply to any voice note, audio, or clip to identify the track instantly.'))
    ])
  ], false);
  b.spacer();

  b.details('📥  Universal Media & Pinterest Studio', [
    block.list([
      rt.concat(rt.bold('No-Watermark Social Downloads — '), rt.text('Save TikToks, Reels, Shorts, X clips & extracted MP3 soundtracks in seconds.')),
      rt.concat(rt.bold('Aesthetic Pinterest & PFP Slides — '), rt.text('Browse clean HD image & video loop slideshows with zero chat flood.'))
    ])
  ], false);
  b.spacer();

  b.details('✨  Stickers, Custom Emojis & WhatsApp Sync', [
    block.list([
      rt.concat(rt.bold('1-Click Sticker & Emoji Packs — '), rt.text('Turn any photo, video, or pin into Telegram sticker or custom emoji packs.')),
      rt.concat(rt.bold('Smart Custom Emoji Upgrades — '), rt.text('Automatically match & convert standard emojis in text & captions to custom emojis.')),
      rt.concat(rt.bold('WhatsApp Hub — '), rt.text('Convert packs between Telegram & WhatsApp and publish smoothly to channels.'))
    ])
  ], false);
  b.spacer();

  b.details('📡  Broadcast Studio & Personal Bot Clones', [
    block.list([
      rt.concat(rt.bold('Verified Channel & Group Posting — '), rt.text('Send 10-slide albums, audio, rich cards & clickable buttons to verified chats.')),
      rt.concat(rt.bold('60-Second Bot Cloning — '), rt.text('Launch your own branded bot instance with live inline search and audience tools.'))
    ])
  ], false);

  b.divider();
  b.footer(rt.italic(`@${cleanHandle} • Tap below to jump straight in ♡`));

  if (includeCta && cleanHandle) {
    b.buttons([
      richButton.url(`🚀 Open @${cleanHandle}`, `https://t.me/${cleanHandle}`, { style: 'success' }),
      richButton.switchInline('💌 Share Card Inline', 'showcase', { style: 'primary' })
    ]);
  }
  if (Array.isArray(extraButtons) && extraButtons.length) {
    for (const row of extraButtons) {
      if (Array.isArray(row) && row.length) b.buttons(row);
    }
  }

  b.validate();
  return b.toJSON({ useCustomEmojis: true });
}

/**
 * HTML fallback representation of the A–Z Showcase Card (for inline_query InputTextMessageContent
 * or environments without sendRichMessage support).
 */
export function buildShowcaseHtmlFallback({ botName = 'Lancy', botUsername = 'pappy_agent' } = {}) {
  const cleanName = escapeHtml(botName || 'Lancy');
  const cleanHandle = escapeHtml(String(botUsername || 'pappy_agent').replace(/^@/, ''));
  return [
    `<b>𓆩♡𓆪 ${cleanName.toUpperCase()} · ALL-IN-ONE STUDIO 𓆩♡𓆪</b>`,
    `<i>cinema • music • downloads • stickers • smart broadcasts</i>`,
    '',
    '<b>Everything you need in Telegram — in one fast, aesthetic companion.</b>',
    '',
    '<blockquote>🎬 <b>Cinema, TV Series &amp; Voice Chat AI</b>\n• Stream HD movies &amp; multi-season series or download clean MP4s.\n• Synced subtitles, multi-audio &amp; voice-controlled Lancy AI co-host.\n\n🎵 <b>Music Studio, AI DJ &amp; Song Finder</b>\n• Instant studio tracks, artwork, lyrics &amp; voice/clip recognition.\n\n📥 <b>Universal Downloader &amp; Pinterest HD</b>\n• No-watermark TikTok, Reels, YT &amp; X grabs + HD wallpaper slides.\n\n✨ <b>Stickers, Custom Emojis &amp; Cloning</b>\n• Create sticker/custom-emoji packs, sync WhatsApp, post 10-slide rich cards, or clone your own bot in 60s.</blockquote>',
    '',
    `<i>@${cleanHandle} • Tap below to get started ♡</i>`
  ].join('\n');
}
