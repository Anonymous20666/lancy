/**
 * Builtin provider — a lightweight, offline "AI" that transforms text by
 * style rules. Zero RAM beyond the process, no paid API, always available.
 * It is the default and the fallback so Lancy's AI features always work.
 */

const STYLE_OPENERS = {
  girly: ['heyyy bestie ♡', 'okay so like,', '✨ literally obsessed ✨', 'bestie… ♡'],
  soft: ['a gentle little note ♡', 'softly,', 'here is something sweet ♡', 'quietly ♡'],
  cute: ['aww ♡', 'cutie mode: activated ♡', 'tiny and sweet ♡', 'hehe ♡'],
  elegant: ['With quiet grace,', 'A refined touch:', 'Effortlessly,', 'Consider this:'],
  'gen-z': ['no because', 'it’s giving', 'the way that', 'rent free in my mind'],
  gothic: ['from the shadows,', 'in velvet darkness,', 'a whisper of night,', 'beneath the moon,'],
  anime: ['believe it! ✦', 'the power of friendship!', 'dramatic anime moment:', 'shonen energy:'],
  minimal: ['—', 'note:', '·', 'simply:'],
  premium: ['Presenting,', 'Curated.', 'Refined.', 'The collection:'],
  chaotic: ['absolute chaos ♡', 'unhinged and I love it', 'what is even happening', 'send help (and stickers)']
};

const CLOSERS = {
  girly: ['that’s all from me ♡', 'mwah ♡', 'stay pretty ♡', 'xoxo ♡'],
  soft: ['with love ♡', 'softly yours ♡', 'take care ♡', 'gentle hugs ♡'],
  cute: ['hehe ♡', 'aww bye ♡', 'hug ♡', 'be good ♡'],
  elegant: ['Yours elegantly,', 'With grace,', 'Refined regards,', 'Beautifully yours,'],
  'gen-z': ['that’s the tweet', 'and that’s on period', 'no notes', 'iconic behavior only'],
  gothic: ['forever in shadow,', 'until the night takes me,', 'darkly yours,', 'eternally,'],
  anime: ['believe it! ✦', 'plus ultra! ⚡', 'the power of friendship!', 'to be continued…'],
  minimal: ['—', '·', 'end.', 'fin.'],
  premium: ['— Lancy', 'Curated by Lancy', 'With compliments,', 'Premium regards,'],
  chaotic: ['mwahaha ♡', 'chaos reigns ♡', 'absolute cinema ♡', 'we love a mess ♡']
};

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function titleCaseWords(text) {
  return String(text).split(/\s+/).map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

const TASK_SYSTEM = {
  caption: 'You write short, aesthetic captions for sticker packs. Girly, warm, slightly Gen-Z, never cringe. 2–4 lines max.',
  rewrite: 'You rewrite captions. Keep the meaning, elevate the wording.',
  title: 'You create short, cute pack titles. 2–5 words.',
  description: 'You write aesthetic pack descriptions. 1–3 sentences.',
  name: 'You suggest cute sticker pack names. 2–4 words, no emoji spam.',
  shorten: 'You shorten text while keeping the vibe.',
  elegant: 'You rewrite text to sound more elegant and refined.',
  playful: 'You rewrite text to sound more playful and fun.',
  music_dj: 'You are Lancy X, an energetic Spotify-style AI DJ hosting a live Telegram music video session. Write ONE crisp 14–22 word liner note introducing the exact track and artist given. ONLY reference the provided artist, track, and vibe; never invent biographies, bands, nationalities, or image/policy refusals.',
  music_dj_curate: 'You are Lancy X, a Spotify-style AI DJ music curator aware of current charts and global hits. Output ONLY 4 real "Artist - Song Title" lines matching the vibe and current trends, without numbering or commentary.',
  music_dj_chat: 'You are Lancy X, a conversational Spotify-style AI DJ chatting with listeners in a live Telegram music session. Answer concisely in 1–3 punchy sentences strictly grounded in the provided charts and session state. Never invent fake songs or mention image policies.',
  chat: 'You are Lancy — warm, playful, feminine, confident, helpful, slightly Gen-Z, never robotic, never annoying. You never overuse emojis. You NEVER perform critical actions (publishing, changing security settings) — you only chat and suggest.'
};

export class BuiltinProvider {
  constructor() {
    this.name = 'builtin';
  }

  get available() {
    return true; // always
  }

  async generate({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 400 }) {
    const seed = [...String(text)].reduce((a, c) => a + c.charCodeAt(0), 0);
    const input = String(text ?? '').trim();

    switch (task) {
      case 'caption':
        return this.#caption(input, style, seed, context);
      case 'rewrite':
        return this.#rewrite(input, style, seed, context);
      case 'title':
        return titleCaseWords(input || 'Lancy Pack').slice(0, 60);
      case 'description':
        return this.#description(input, style, seed, context);
      case 'name':
        return titleCaseWords(input || 'Lancy Pack').slice(0, 40);
      case 'shorten':
        return this.#shorten(input);
      case 'elegant':
        return this.#rewrite(input, 'elegant', seed, context);
      case 'playful':
        return this.#rewrite(input, 'chaotic', seed, context);
      case 'music_dj':
        return this.#musicDjIntro(seed, context);
      case 'music_dj_curate':
        return this.#musicDjCurate(context);
      case 'music_dj_chat':
        return this.#musicDjChat(input, seed, context);
      case 'chat':
      default:
        return this.#chat(input, style, seed, context);
    }
  }

  #caption(text, style, seed, context) {
    const query = context.query || text || 'this pack';
    const stickers = context.stickers ?? '—';
    const packs = context.packs ?? '01';
    const opener = pick(STYLE_OPENERS[style] ?? STYLE_OPENERS.girly, seed);
    const closer = pick(CLOSERS[style] ?? CLOSERS.girly, seed + 3);
    return [
      `✦ ${titleCaseWords(query)} ✦`,
      '',
      `╭───────────────╮`,
      `│ ♡ STICKERS • ${stickers}`,
      `│ ▣ PACKS • ${String(packs).padStart(2, '0')}`,
      `╰───────────────╯`,
      '',
      `${opener} a little pack of hand-picked moments, made with love ♡`,
      '',
      `${closer}`
    ].join('\n');
  }

  #rewrite(input, style, seed, context) {
    if (!input) return '';
    const openers = STYLE_OPENERS[style] ?? STYLE_OPENERS.girly;
    const closers = CLOSERS[style] ?? CLOSERS.girly;
    const lines = input.split('\n').filter(Boolean);
    const rewritten = lines.map((line, i) => {
      let out = line;
      if (style === 'elegant') out = out[0].toUpperCase() + out.slice(1);
      if (style === 'playful' || style === 'chaotic') out = out.replace(/\.$/, ' ♡');
      return out;
    });
    return [pick(openers, seed), ...rewritten, pick(closers, seed + 1)].join('\n');
  }

  #description(input, style, seed, context) {
    const query = context.query || input || 'this collection';
    const openers = STYLE_OPENERS[style] ?? STYLE_OPENERS.soft;
    return `${pick(openers, seed)} a curated set of ${titleCaseWords(query)} moments — cute, expressive and ready to send ♡`;
  }

  #shorten(input) {
    const sentences = String(input).split(/(?<=[.!?])\s+/);
    if (sentences.length <= 1) {
      return String(input).split('\n')[0].slice(0, 120);
    }
    return sentences.slice(0, 2).join(' ');
  }

  #musicDjIntro(seed, context) {
    const title = context.nextTrack || 'this track';
    const artist = context.artist || 'featured artist';
    const vibe = context.vibe || 'Spotify Live Mix';
    const scope = context.isChannel ? 'Live broadcast' : 'Up next on deck';
    const bassNote = context.eq && context.eq !== 'off' ? ' Clean sub-bass locked in.' : '';
    const lines = [
      `${scope}: spinning "${title}" by ${artist} — tuned to ${vibe}.${bassNote}`,
      `Transitioning smooth into ${artist} — "${title}" keeps the ${vibe} wave rolling.${bassNote}`,
      `Trending radar locked: "${title}" (${artist}) is up next in ${vibe}.${bassNote}`,
      `Cueing up ${artist}'s "${title}" right now — HD video & studio dynamics.${bassNote}`
    ];
    return pick(lines, seed);
  }

  #musicDjCurate(context) {
    const trending = Array.isArray(context.trending) ? context.trending : [];
    const avoid = new Set((context.avoidArtists || []).map((a) => String(a).toLowerCase()));
    const picks = trending
      .filter((t) => t?.artist && t?.title && !avoid.has(String(t.artist).toLowerCase()))
      .slice(0, 4)
      .map((t) => `${t.artist} - ${t.title}`);
    if (picks.length) return picks.join('\n');
    const vibe = context.vibe || 'Global Trending';
    return `${vibe} trending hits\n${vibe} official music video\n${vibe} popular songs\n${vibe} classics`;
  }

  #musicDjChat(input, seed, context) {
    const trending = Array.isArray(context.trending) ? context.trending : [];
    const topStr = trending.slice(0, 3).map((t) => `${t.artist} – ${t.title}`).join(', ');
    if (/\b(?:trend(?:ing)?|chart(?:s|ing)?|new|latest|hot|popular|top)\b/i.test(input) && topStr) {
      return `Right now the global charts are lighting up with ${topStr}. Tell me if you want me to spin any of these in HD video or lock a fresh vibe!`;
    }
    const now = context.nowPlaying ? `Currently spinning ${context.nowPlaying}. ` : '';
    const replies = [
      `${now}Say what artist, song, or mood you want next — I'll queue the HD music videos and dial in the clean bass.`,
      `${now}Locking in the Spotify X deck. Drop a genre, vibe, or "what's trending" and I'll mix it live.`,
      `${now}You're in the booth with Lancy X! Ask for any track, chill R&B, Afrobeats, or heavy clean bass.`
    ];
    return pick(replies, seed);
  }

  #chat(input, style, seed, context) {
    const trimmed = String(input).trim();
    if (!trimmed) return 'heyyy bestie ♡ tell me what’s on your mind! ✨';
    const replies = [
      'I hear you! What direction are you thinking of taking with that? ♡',
      'Ooh interesting! Tell me more about that bestie ✨',
      'I love where your head is at! What should we explore next? 🌸',
      'Right here with you! Tell me everything ♡',
      'Hehe I feel that! What are we vibing with today? ✨'
    ];
    return pick(replies, seed);
  }
}

export const BUILTIN_SYSTEM_PROMPTS = TASK_SYSTEM;
