/**
 * Caption engine — template-driven, variable-driven, never hard-coded.
 *
 * Supported variables:
 *   {{title}} {{query}} {{stickers}} {{packs}} {{creator}} {{date}}
 *   {{pack_name}} {{source}} {{telegram_link}} {{session_name}}
 *   {{pack_01_count}} … (per physical pack, when relevant)
 *
 * Unknown variables render as empty — we never leak "{{undefined}}".
 */
import { formatDate } from '../utils/text.js';
import { BUILTIN_TEMPLATES } from './templates.js';

export function toMathBold(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D400 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D41A + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7CE + (code - 48));
    return char;
  });
}

export function toMathBoldItalic(text) {
  return String(text).replace(/[A-Za-z]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D468 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D482 + (code - 97));
    return char;
  });
}

export function toSansBold(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
    return char;
  });
}

const SMALL_CAPS_MAP = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
  k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ',
  u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ'
};

export function toSmallCaps(text) {
  return String(text).replace(/[A-Za-z]/g, (c) => SMALL_CAPS_MAP[c.toLowerCase()] || c);
}

const SOFT_CUTE_MAP = {
  a: 'ᥲ', b: 'ᑲ', c: 'ᥴ', d: 'ძ', e: 'ᥱ', f: '𝖿', g: 'g', h: 'һ', i: 'і', j: 'ȷ',
  k: 'k', l: 'ᥣ', m: 'm', n: 'ᥒ', o: '᥆', p: '⍴', q: 'q', r: 'r', s: 's', t: '𝗍',
  u: 'ᥙ', v: '᥎', w: 'ᥕ', x: 'x', y: 'ᥡ', z: 'z'
};

export function toSoftCute(text) {
  return String(text).replace(/[A-Za-z]/g, (c) => SOFT_CUTE_MAP[c.toLowerCase()] || c);
}

const SCRIPT_CAPS_EXCEPTIONS = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ' };
const SCRIPT_LOWER_EXCEPTIONS = { e: 'ℯ', g: 'ℊ', o: 'ℴ' };
export function toMathScript(text) {
  return String(text).replace(/[A-Za-z]/g, (char) => {
    if (SCRIPT_CAPS_EXCEPTIONS[char]) return SCRIPT_CAPS_EXCEPTIONS[char];
    if (SCRIPT_LOWER_EXCEPTIONS[char]) return SCRIPT_LOWER_EXCEPTIONS[char];
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D49C + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D4B6 + (code - 97));
    return char;
  });
}

const FRAKTUR_CAPS_EXCEPTIONS = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
export function toMathFraktur(text) {
  return String(text).replace(/[A-Za-z]/g, (char) => {
    if (FRAKTUR_CAPS_EXCEPTIONS[char]) return FRAKTUR_CAPS_EXCEPTIONS[char];
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D504 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D51E + (code - 97));
    return char;
  });
}

export function toMathMonospace(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D670 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D68A + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7F6 + (code - 48));
    return char;
  });
}

export function toFullwidth(text) {
  return String(text).replace(/[!-~]/g, (char) => String.fromCodePoint(char.charCodeAt(0) + 0xFEE0));
}

export const FONT_STYLES = [
  { id: 'math_bold_italic', label: '𝑪𝑹𝑨𝑻𝑰𝑵𝑮 Serif Italic' },
  { id: 'math_bold', label: '𝐂𝐑𝐀𝐓𝐈𝐍𝐆 Serif Bold' },
  { id: 'sans_bold', label: '𝗖𝗥𝗔𝗧𝗜𝗡𝗚 Sans Bold' },
  { id: 'small_caps', label: 'ᴄʀᴀᴛɪɴɢ SmallCaps' },
  { id: 'script', label: '𝒞𝓇𝒶𝓉𝒾𝓃𝑔 Script' },
  { id: 'fraktur', label: 'ℭ𝔯𝔞𝔱𝔦𝔫𝔤 Gothic' },
  { id: 'monospace', label: '𝙲𝚁𝙰𝚃𝙸𝙽𝙶 Mono' },
  { id: 'fullwidth', label: 'ＣＲＡＴＩＮＧ Wide' },
  { id: 'normal', label: 'Normal Clean' }
];

export function applyFontTransform(text, fontId = 'math_bold_italic') {
  const s = String(text ?? '');
  switch (fontId) {
    case 'math_bold': return toMathBold(s);
    case 'sans_bold': return toSansBold(s);
    case 'small_caps': return toSmallCaps(s);
    case 'soft_cute': return toSoftCute(s);
    case 'script': return toMathScript(s);
    case 'fraktur': return toMathFraktur(s);
    case 'monospace': return toMathMonospace(s);
    case 'fullwidth': return toFullwidth(s);
    case 'normal': return s;
    case 'math_bold_italic':
    default:
      return toMathBoldItalic(s);
  }
}

export const CAPTION_VARIABLES = [
  'title', 'query', 'stickers', 'packs', 'creator', 'date',
  'pack_name', 'source', 'telegram_link', 'session_name', 'cta', 'footer',
  'headline', 'description', 'styled_title', 'styled_character',
  'kind_label', 'vibes', 'tagline', 'tagline_styled', 'footer_smallcaps'
];

export class CaptionEngine {
  constructor({ settings, templates } = {}) {
    this.settings = settings;
    this.templates = templates;
  }

  /**
   * Render a template with variables.
   * @param {string} templateText
   * @param {object} vars
   */
  render(templateText, vars = {}) {
    if (!templateText) return '';
    const context = this.#buildContext(vars);
    return String(templateText).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const value = context[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  #buildContext(vars) {
    const now = new Date();
    const tz = this.settings?.get('general.timezone') ?? 'UTC';
    const packs = Number(vars.packs ?? 1);
    const rawTitle = vars.title ?? this.settings?.get('captions.defaultTitle') ?? '{{query}}';

    // Clean character/theme name (e.g. "Toji" or "CORTIS")
    const characterCandidate = vars.character || vars.query || (typeof rawTitle === 'string' && !rawTitle.includes('{{') ? rawTitle : '') || 'Stickers';
    const cleanCharacter = String(characterCandidate)
      .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
      .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
      .trim() || 'Stickers';

    const headline = vars.headline ?? `${cleanCharacter.toUpperCase()} 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓!`;
    const defaultDescription = 'A fresh pack filled with cool reactions,\nfunny moments, moods & everyday vibes. 🫶🏼💫';
    const description = vars.description ?? defaultDescription;
    const defaultFooter = '╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝐊𝐄𝗥s⃟❥🌸⃟╬';
    const footer = vars.footer ?? this.settings?.get('captions.creatorFooter') ?? defaultFooter;
    const styled_title = vars.styled_title
      ?? applyFontTransform(cleanCharacter.toUpperCase(), vars.fontStyle || 'math_bold');
    const styled_character = vars.styled_character
      ?? applyFontTransform(cleanCharacter.toUpperCase(), vars.fontStyle || 'math_bold_italic');
    const isCustomEmoji = vars.stickerKind === 'custom_emoji' || /emoji/i.test(String(vars.kindLabel || ''));
    const kind_label = vars.kind_label ?? applyFontTransform(isCustomEmoji ? 'EMOJIS' : 'STICKERS', vars.labelFontStyle || 'math_bold');
    const vibes = vars.vibes ?? '100%';
    const rawTagline = vars.tagline ?? (isCustomEmoji
      ? 'cute emojis, big vibes & a touch of magic'
      : 'cute stickers, big vibes & a touch of magic');
    const tagline_styled = vars.tagline_styled ?? toSoftCute(rawTagline);
    const rawCreatorLabel = String(vars.footerCreator || 'lancy aesthetic').replace(/[^\p{L}\p{N}\s._-]/gu, '').trim() || 'lancy aesthetic';
    const footer_smallcaps = vars.footer_smallcaps ?? toSmallCaps(rawCreatorLabel);

    const context = {
      title: rawTitle,
      character: cleanCharacter,
      styled_title,
      styled_character,
      kind_label,
      vibes,
      tagline: rawTagline,
      tagline_styled,
      footer_smallcaps,
      query: vars.query ?? '',
      stickers: vars.stickers ?? 0,
      packs: String(packs).padStart(2, '0'),
      creator: vars.creator ?? this.settings?.get('general.defaultCreatorName') ?? 'Lancy',
      date: vars.date ?? formatDate(now, tz),
      pack_name: vars.packName ?? vars.pack_name ?? '',
      source: vars.source ?? 'Pinterest',
      telegram_link: vars.telegramLink ?? vars.telegram_link ?? '',
      session_name: vars.sessionName ?? vars.session_name ?? '',
      cta: vars.cta ?? this.settings?.get('captions.cta') ?? '𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 • 𝐔𝐒𝐄 • 𝐄𝐍𝐉𝐎𝐘',
      footer,
      headline,
      description
    };
    // Resolve variables inside the title template (single pass, no recursion).
    if (typeof context.title === 'string' && context.title.includes('{{')) {
      context.title = context.title.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
        const v = context[key];
        return v === undefined || v === null ? '' : String(v);
      });
    }
    // Per-pack counts: {{pack_01_count}} etc.
    if (Array.isArray(vars.packSizes)) {
      vars.packSizes.forEach((count, i) => {
        context[`pack_${String(i + 1).padStart(2, '0')}_count`] = count;
      });
    }
    return context;
  }

  /**
   * Generate an aesthetic aura caption + custom template matching character vibe.
   */
  async generateAuraCaption({ character = '', query = '', stickers = 0, packs = 1, aiService = null, preferredStyle = null } = {}) {
    const clean = String(character || query || 'Stickers')
      .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
      .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
      .trim() || 'Stickers';

    const lower = clean.toLowerCase();
    const isDarkBadass = /toji|sukuna|gojo|geto|megumi|zoro|levi|eren|guts|itachi|madara|killer|shadow|blade|demon|badass|reaper|jujutsu/i.test(lower);
    const isSoftCute = /cortis|cat|kitty|kuromi|sanrio|pink|blossom|flower|sweet|cute|love|pastel|kpop|idol|kawaii|anya/i.test(lower);
    const isCyber = /cyber|neon|matrix|robot|tech|future|glitch|vaporwave/i.test(lower);

    let templateKey = preferredStyle || 'aesthetic';

    let headline = `${toMathBold(clean.toUpperCase())} 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓!`;
    let description = 'A fresh pack filled with cool reactions,\nfunny moments, moods & everyday vibes. 🫶🏼💫';

    if (/tanjiro|kamado|demon\s*slayer|kimetsu/i.test(lower)) {
      headline = '𝐓𝐀𝐍𝐉𝐈𝐑𝐎 𝐊𝐀𝐌𝐀𝐃𝐎 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓!';
      description = 'A fresh demon-slayer pack filled with funny\nreactions, emotional moments, battles & vibes. ⚔️🔥';
    } else if (isDarkBadass) {
      if (/toji/i.test(lower)) {
        headline = '𝐓𝐇𝐄 𝐒𝐎𝐑𝐂𝐄𝐑𝐄𝐑 𝐊𝐈𝐋𝐋𝐄𝐑 𝐇𝐀𝐒 𝐋𝐀𝐍𝐃𝐄𝐃';
        description = 'Zero cursed energy, pure heavenly restriction & lethal instinct.\nRuthless smirks, cold stares, and peak menace moods. 🗡️🩸';
      } else if (/sukuna/i.test(lower)) {
        headline = '𝐓𝐇𝐄 𝐊𝐈𝐍𝐆 𝐎𝐅 𝐂𝐔𝐑𝐒𝐄𝐒 𝐀𝐖𝐀𝐊𝐄𝐍𝐒';
        description = 'Absolute dominance and sadistic royal smirks.\nUnhinged reactions, lethal aura, and god-tier confidence. 👑🩸';
      } else if (/gojo/i.test(lower)) {
        headline = '𝐓𝐇𝐄 𝐇𝐎𝐍𝐎𝐑𝐄𝐃 𝐎𝐍𝐄 𝐈𝐒 𝐇𝐄𝐑𝐄';
        description = 'Limitless swagger with playful chaos and infinite drip.\nUnmatched cocky grins and iconic flex moods. 💠🤞';
      } else {
        headline = `${toMathBold(clean.toUpperCase())} • 𝐏𝐄𝐀𝐊 𝐀𝐔𝐑𝐀 𝐔𝐍𝐋𝐄𝐀𝐒𝐇𝐄𝐃`;
        description = 'Cold stares, ruthless charm, and unstoppable presence.\nEvery reaction hits different with pure main-character energy. 🗡️⚡';
      }
    } else if (isSoftCute) {
      headline = `${toMathBold(clean.toUpperCase())} 𝐈𝐍 𝐅𝐔𝐋𝐋 𝐁𝐋𝐎𝐎𝐌`;
      description = 'Soft pastel charm, sweetest smiles, and heartwarming reactions.\nMade to make your daily chats radiate pure aesthetic happiness. 🌸🎀';
    }

    if (aiService) {
      try {
        const prompt = `You are a high-aesthetic anime & pop-culture sticker caption stylist for WhatsApp channels.\n` +
          `Write an aesthetic caption for sticker pack featuring: "${clean}".\n` +
          `Character vibe: ${isDarkBadass ? 'menacing, badass, cold swagger, ruthlessly cool' : (isSoftCute ? 'soft aesthetic, cute, sweet smiles' : 'aesthetic, cool, expressive reactions')}.\n` +
          `Respond with valid JSON ONLY:\n` +
          `{\n` +
          `  "headline": "<punchy all-caps 3-6 word tagline>",\n` +
          `  "description": "<2 sentences capturing their exact facial expressions, smirks, and chat moods with 2 fitting emojis>",\n` +
          `  "template": "badass" or "blossom" or "cyber" or "royal"\n` +
          `}`;

        const res = await Promise.race([
          aiService.generate({
            task: 'description',
            text: prompt,
            context: { query: clean },
            maxTokens: 140
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 6000))
        ]);

        const raw = (typeof res === 'object' && res !== null ? res.text : res) ?? '';
        const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.headline && parsed.headline.length > 3) {
            headline = toMathBold(parsed.headline.trim().toUpperCase());
          }
          if (parsed.description && parsed.description.length > 15) {
            description = parsed.description.trim().replace(/^["']|["']$/g, '');
          }
          if (parsed.template && ['badass', 'blossom', 'cyber', 'royal'].includes(parsed.template.toLowerCase())) {
            templateKey = parsed.template.toLowerCase();
          }
        }
      } catch {}
    }

    const vars = {
      title: clean,
      character: clean,
      styled_title: toMathBold(clean.toUpperCase()),
      styled_character: toMathBoldItalic(clean),
      headline,
      description,
      stickers,
      packs: String(packs).padStart(2, '0')
    };

    const template = this.templates?.get(templateKey) ?? this.templates?.get('badass') ?? this.templates?.get('default');
    const rendered = this.render(template, vars);

    return {
      caption: rendered,
      headline,
      description,
      template: templateKey,
      character: clean
    };
  }

  /** Generate tailored "About" description matching the character's aura using AI with fallback */
  async generateAbout(character, { aiService = null, style = 'aesthetic' } = {}) {
    const defaultAbout = 'A fresh pack filled with cool reactions,\nfunny moments, moods & everyday vibes. 🫶🏼💫';
    const clean = (character || '')
      .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
      .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
      .trim();
    if (!clean || !aiService) return defaultAbout;
    try {
      const prompt = `Write a short 1-2 sentence aesthetic description for a sticker pack featuring "${clean}". Capture their aura, moods, and cool reactions. Keep it short and pretty with 2 aesthetic emojis. Max 2 lines.`;
      const res = await Promise.race([
        aiService.generate({
          task: 'description',
          text: prompt,
          context: { query: clean },
          maxTokens: 50
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 6000))
      ]);
      const rawText = (typeof res === 'object' && res !== null ? res.text : res) ?? '';
      const text = String(rawText).trim().replace(/^["']|["']$/g, '');
      if (text.length > 15 && text.length < 250) {
        return text;
      }
    } catch {}
    return defaultAbout;
  }

  /** Render the default template from settings/templates. */
  renderDefault(vars = {}) {
    const templateName = this.settings?.get('captions.defaultTemplate') ?? 'default';
    const template = this.templates?.get(templateName) ?? this.templates?.get('default');
    if (!template) throw new Error(`Caption template "${templateName}" not found`);
    return this.render(template, vars);
  }
}

/** Validate a template: balanced braces, known-ish variables (warn only). */
export function validateTemplate(template) {
  const problems = [];
  const opens = (template.match(/\{\{/g) ?? []).length;
  const closes = (template.match(/\}\}/g) ?? []).length;
  if (opens !== closes) problems.push(`Unbalanced braces: ${opens} "{{" vs ${closes} "}}"`);
  const vars = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  const unknown = vars.filter((v) => !CAPTION_VARIABLES.includes(v) && !/^pack_\d{2}_count$/.test(v));
  if (unknown.length) problems.push(`Unknown variables: ${[...new Set(unknown)].join(', ')}`);
  return { valid: problems.length === 0, problems, variables: [...new Set(vars)] };
}

export async function generateAuraCaption(options = {}) {
  const engine = new CaptionEngine();
  return engine.generateAuraCaption(options);
}

/**
 * Renders the exact user-requested aesthetic sticker drop card for channels:
 *
 * ╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮
 * 💠 𝑻𝑨𝑵𝑱𝑰𝑹𝑶 𝑲𝑨𝑴𝑨𝑫𝑶
 * ╰━━━ ⋆｡˚❀˚｡⋆ ━━━╯
 *
 * ╭───────────────╮
 * │ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  60
 * │ 📦 𝐏𝐀𝐂𝐊𝐒       •  02
 * ╰───────────────╯
 *
 * ╭─━━━━━━━♡━━━━━━━─╮
 * ✨ 𝐓𝐀𝐍𝐉𝐈𝐑𝐎 𝐊𝐀𝐌𝐀𝐃𝐎 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓! ✨
 * ╰─━━━━━━━♡━━━━━━━─╯
 *
 * A fresh demon-slayer pack filled with funny
 * reactions, emotional moments, battles & vibes. ⚔️🔥
 *
 *    💌 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 • 𝐔𝐒𝐄 • 𝐄𝐍𝐉𝐎𝐘
 *
 * ╭───────────────╮
 * ❤️ 𝐒𝐇𝐀𝐑𝐄   •   💠 𝐑𝐄𝐀𝐂𝐓
 * 🌸 𝐅𝐎𝐋𝐋𝐎𝐖
 * ╰───────────────╯
 *
 *     𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
 *           ╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝐊𝐄𝗥s⃟❥🌸⃟╬
 */
export function buildAestheticStickerCaption({
  title = '',
  character = '',
  count = 0,
  packsCount = 1,
  description = '',
  botUser = 'Lancy_easy_bot'
} = {}) {
  const rawCandidate = character || title || 'Stickers';
  const cleanChar = String(rawCandidate)
    .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
    .replace(/^(?:lancy\s*-\s*)/i, '')
    .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+|pack)/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim() || 'Stickers';

  const upperChar = cleanChar.toUpperCase();
  const styledChar = toMathBoldItalic(upperChar);
  const headline = `${toMathBold(upperChar)} 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓!`;
  const stickers = String(count || 0);
  const packs = String(packsCount || 1).padStart(2, '0');

  let desc = description;
  if (!desc) {
    const lower = cleanChar.toLowerCase();
    if (lower.includes('tanjiro') || lower.includes('demon') || lower.includes('kamado') || lower.includes('kimetsu') || lower.includes('slayer')) {
      desc = 'A fresh demon-slayer pack filled with funny\nreactions, emotional moments, battles & vibes. ⚔️🔥';
    } else if (lower.includes('toji')) {
      desc = 'Cold-blooded sorcerer killer aura, swagger smirks, and unhinged combat energy. 🗡️⚡';
    } else if (lower.includes('sukuna')) {
      desc = 'Cursed king malevolence, four-eyed smirks, and demonic slaughter moods. 🩸🔥';
    } else if (lower.includes('gojo')) {
      desc = 'The limitless honored one, smug blindfolded smirks, and peak domain swagger. 🤞🏼✨';
    } else if (lower.includes('cat') || lower.includes('kitty') || lower.includes('cute')) {
      desc = 'Soft pastel aesthetics, heartwarming reactions, and darling cozy moments. 🐾🌸';
    } else {
      desc = 'A fresh pack filled with cool reactions,\nfunny moments, moods & everyday vibes. 🫶🏼💫';
    }
  }

  const footer = '╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝐊𝐄𝗥s⃟❥🌸⃟╬';

  return [
    '╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮',
    `💠 ${styledChar}`,
    '╰━━━ ⋆｡˚❀˚｡⋆ ━━━╯',
    '',
    '╭───────────────╮',
    `│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  ${stickers}`,
    `│ 📦 𝐏𝐀𝐂𝐊𝐒       •  ${packs}`,
    '╰───────────────╯',
    '',
    '╭─━━━━━━━♡━━━━━━━─╮',
    `✨ ${headline} ✨`,
    '╰─━━━━━━━♡━━━━━━━─╯',
    '',
    desc,
    '',
    '   💌 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 • 𝐔𝐒𝐄 • 𝐄𝐍𝐉𝐎𝐘',
    '',
    '╭───────────────╮',
    '❤️ 𝐒𝐇𝐀𝐑𝐄   •   💠 𝐑𝐄𝐀𝐂𝐓',
    '🌸 𝐅𝐎𝐋𝐋𝐎𝐖',
    '╰───────────────╯',
    '',
    '    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘',
    `          ${footer}`
  ].join('\n');
}

/**
 * Render an aesthetic Telegram channel broadcast card caption using any builtin or user template,
 * live Unicode font style, and pack metadata (works for both custom_emoji and regular packs).
 */
export function renderChannelPackCardCaption({
  title = '',
  character = '',
  count = 0,
  packsCount = 1,
  stickerKind = 'regular',
  description = '',
  tagline = '',
  vibes = '100%',
  creatorLabel = 'lancy aesthetic',
  templateName = 'bloom_crating',
  fontStyle = 'math_bold_italic',
  templateStore = null,
  customTemplateText = null
} = {}) {
  const isCustomEmoji = stickerKind === 'custom_emoji';
  const rawCandidate = character || title || (isCustomEmoji ? 'Custom Emojis' : 'Stickers');
  const cleanChar = String(rawCandidate)
    .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
    .replace(/^(?:lancy\s*-\s*)/i, '')
    .replace(/\s*(?:custom\s*emojis?|emojis?|stickers?|collection|wa\s*import|part\s*\d+|pack)/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim() || (isCustomEmoji ? 'LANCY' : 'STICKERS');

  const upperChar = cleanChar.toUpperCase();
  const styledTitle = applyFontTransform(upperChar, fontStyle);
  const kindLabel = toMathBold(isCustomEmoji ? 'EMOJIS' : 'STICKERS');
  const packs = String(Math.max(1, Number(packsCount) || 1)).padStart(2, '0');
  const defaultTagline = isCustomEmoji
    ? 'cute emojis, big vibes & a touch of magic'
    : 'cute stickers, big vibes & a touch of magic';
  const resolvedTagline = String(tagline || defaultTagline).trim();
  const taglineStyled = fontStyle === 'normal'
    ? resolvedTagline
    : (fontStyle === 'small_caps' ? toSmallCaps(resolvedTagline) : toSoftCute(resolvedTagline));

  const resolvedDesc = String(description || (isCustomEmoji
    ? 'Upgrade your chats with adorable\nanimated emojis, expressive reactions,\nand dreamy aesthetics. 🌷💗'
    : 'Upgrade your chats with expressive\nstickers, iconic moods,\nand dreamy aesthetics. 🌷💗')).trim();

  const footerSmall = toSmallCaps(String(creatorLabel || 'lancy aesthetic').replace(/^@/, ''));
  const templateText = customTemplateText
    || templateStore?.get?.(templateName)
    || BUILTIN_TEMPLATES[templateName]
    || null;

  if (templateText) {
    const engine = new CaptionEngine({ templates: templateStore });
    return engine.render(templateText, {
      title: rawCandidate,
      character: cleanChar,
      styled_title: styledTitle,
      styled_character: styledTitle,
      kind_label: kindLabel,
      stickerKind,
      stickers: count || 0,
      packs: packsCount || 1,
      vibes: vibes || '100%',
      tagline: resolvedTagline,
      tagline_styled: taglineStyled,
      description: resolvedDesc,
      headline: `${toMathBold(upperChar)} ${isCustomEmoji ? '𝐄𝐌𝐎𝐉𝐈𝐒' : '𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒'}`,
      cta: '𝐓𝐀𝐏 • 𝐀𝐃𝐃 • 𝐄𝐍𝐉𝐎𝐘',
      footer: footerSmall,
      footer_smallcaps: footerSmall,
      fontStyle
    }).trim();
  }

  return [
    '˚ ༘♡ ⋆｡˚ ❀ ˚ ༘♡ ⋆｡˚',
    `🌸 ${styledTitle} 🌸`,
    '    ─── ⋆⋅ 𓆩♡𓆪 ⋅⋆ ───',
    '',
    `  ┌ 🦋 ${kindLabel} ┈ ${count || 0}`,
    `  ├ 🎀 𝐏𝐀𝐂𝐊𝐒  ┈ ${packs}`,
    `  └ ✨ 𝐕𝐈𝐁𝐄𝐒  ┈ ${vibes || '100%'}`,
    '',
    `꒰ა ${taglineStyled} ໒꒱`,
    '',
    resolvedDesc,
    '',
    '  ╭──────────────────╮',
    '     🎀 𝐓𝐀𝐏 • 𝐀𝐃𝐃 • 𝐄𝐍𝐉𝐎𝐘',
    '  ╰──────────────────╯',
    '',
    '   💕 𝐒𝐡𝐚𝐫𝐞  |  🌸 𝐑𝐞𝐚𝐜𝐭  |  🦋 𝐅𝐨𝐥𝐥𝐨𝐰',
    `     crafted by • ${footerSmall} 🌺`
  ].join('\n');
}

