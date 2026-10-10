/**
 * 3-Part Aesthetic Sticker Pack Naming
 *
 * Supports the user's custom 3-part layout:
 * Header: 🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸
 * Middle: {{name}} (or "(Sticker name)")
 * Footer: ╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬
 */

export const DEFAULT_PACK_NAME_TEMPLATE = `🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸\n\n{{name}}\n\n╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬`;

/**
 * Clean character/sticker name from raw text, brackets, or existing banners.
 */
export function extractCleanStickerName(raw) {
  if (!raw) return 'Stickers';
  let s = String(raw).trim();
  // Strip outer parentheses or brackets e.g. (Toji) or ( Sticker name )
  s = s.replace(/^\s*\(\s*|\s*\)\s*$/g, '');
  // Strip previous 3-part template prefixes and footers if pasted whole
  if (s.includes('\n')) {
    const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      // Find the middle line that isn't the header or footer
      const mid = lines.find((l) => !l.includes('ʟᴀɴᴄʏ') && !l.includes('🌸') && !l.includes('╬'));
      if (mid) s = mid;
    }
  }
  s = s
    .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
    .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
    .replace(/^[𓆩♡𓆪\s]+/, '')
    .replace(/[𓆩♡𓆪\s]+$/, '')
    .trim();
  return s || 'Stickers';
}

/**
 * Format the 3-part pack title using a template.
 * If user gives a custom template like "Pappy\n\n( Sticker name )\n\nThen wtv here",
 * it replaces the placeholder with the actual sticker name.
 */
export function formatPackTitle(characterOrName, template = DEFAULT_PACK_NAME_TEMPLATE) {
  const clean = extractCleanStickerName(characterOrName);
  const tmpl = String(template || DEFAULT_PACK_NAME_TEMPLATE).trim();

  // Pattern matches {{name}}, (Sticker name), ( sticker name ), [name], or (Sticker Name)
  const placeholderRegex = /\{\{\s*name\s*\}\}|\(\s*sticker\s*name\s*\)|\[\s*name\s*\]/i;
  if (placeholderRegex.test(tmpl)) {
    return tmpl.replace(placeholderRegex, clean);
  }

  // If template is just a prefix e.g. "Pappy", append the clean name and footer
  return `🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸\n\n${clean}\n\n╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬`;
}

/**
 * Convert formatted 3-part pack title to Telegram-compliant title:
 * Single line, max 64 characters.
 */
export function toTelegramPackTitle(formattedOrName, maxLen = 64) {
  const clean = extractCleanStickerName(formattedOrName);
  const title = `🌸♥︎xɪᴛᴛʟᴇ ʟᴀɴᴄʏ♥︎🌸 • ${clean}`;
  if (title.length <= maxLen) return title;
  return clean.slice(0, maxLen).trim();
}

/**
 * Format pack name for WhatsApp sticker pack metadata.
 * Retains the 3-part aesthetic formatting cleanly.
 */
export function toWhatsAppPackTitle(formattedOrName, template = DEFAULT_PACK_NAME_TEMPLATE) {
  if (String(formattedOrName).includes('\n') && !formattedOrName.includes('{{')) {
    return String(formattedOrName).trim();
  }
  return formatPackTitle(formattedOrName, template);
}

/**
 * Extract clean Telegram pack short name from URL or raw name.
 * Prevents false matches like "https".
 */
export function extractTelegramPackName(input) {
  const trimmed = String(input || '').trim();
  const linkMatch = trimmed.match(/(?:t\.me\/addstickers\/|telegram\.me\/addstickers\/|addstickers\/)([a-zA-Z0-9_]+)/i);
  if (linkMatch) return linkMatch[1];
  const nameMatch = trimmed.match(/^[a-zA-Z0-9_]{3,64}$/);
  if (nameMatch) return nameMatch[0];
  return null;
}
