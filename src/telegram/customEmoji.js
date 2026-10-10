/**
 * Telegram Premium Custom Emoji mappings and transformers for Lancy Bot.
 *
 * Provides custom emoji IDs provided for bot interfaces and packs (by @tonundrwrld and @holypappy).
 * Supports both HTML format (<tg-emoji emoji-id="...">) and Rich Message format
 * ({ type: 'custom_emoji', alternative_text, custom_emoji_id }).
 */

export const CUSTOM_EMOJI_MAP = {
  // Aesthetic & Theme
  '🎀': '5375129864179319277',
  '🖤': '5354812955177274307',
  '🤍': '5355221552596010343',
  '💖': '6136406830210882173',
  '🌸': '5375384680294025343',
  '🩰': '6235446744537106947',
  '🪞': '5875066183442501686',
  '🍓': '5469963154391833732',
  '🍰': '5390932938646887892',
  '🕯': '4958866680437539780',
  '🧸': '5354952271031455473',
  '🕊': '5434121252874756456',
  '🌙': '4958941455818163141',
  '✨': '5472164874886846699',
  '💫': '4956259055468282692',
  '💎': '4958472587123360612',
  '🫧': '5902009110290766704',
  '🪽': '6339264655361318131',
  '🪻': '5375282786489880721',
  '🥀': '5354881288106951870',
  '🕷': '5267389488572678688',
  '🕸': '5445388468215619925',
  '🦇': '5341561920212187837',
  '⛓': '5305487433331122959',
  '🗡': '6053190193878408151',
  '🗡️': '6053190193878408151',
  '🗝️': '5377583660599903534',
  '🗝': '5377583660599903534',
  '🦢': '5350817398641404705',
  '🏰': '5429403746696189687',

  // UI & Controls
  '🎬': '5375464961822695044',
  '🖼': '5803109924862959421',
  '🔍': '4958587679361991667',
  '🔎': '5818897412894233827',
  '📱': '6023639019290630537',
  '🥸': '6028090581094240774',
  '💾': '6132119538021435835',
  '⚙️': '5260343246831237239',
  '⚙': '5260343246831237239',
  '📊': '4958506272551863292',
  '📈': '5373001317042101552',
  '💬': '4956475826762679249',
  '🤖': '5372981976804366741',
  '🌐': '4956560549287560231',
  '⏱': '5953759695226278894',
  '⏱️': '5953759695226278894',
  '🔜': '5440621591387980068',
  '🕐': '5408910404732595664',
  '⚡️': '4958479549265347295',
  '⚡': '4958479549265347295',
  '🚀': '5445284980978621387',
  '🔄': '5264727218734524899',
  '🧹': '4956591954088428445',
  '🗑': '5372825386591732174',
  '🗑️': '5372825386591732174',
  '➕': '6203946234617535298',
  '➖': '6206302088603900186',
  '⏩': '5850534558608396441',

  // Moods & Reactions (by @holypappy)
  '🥺': '5413400535342532088',
  '🥹': '5420254671786744816',
  '🥰': '5325565443367259779',
  '🥵': '5461064793903351127',
  '😍': '5280517167782058238',
  '❤️‍🔥': '4956222745814762495',
  '❤️🔥': '4956222745814762495',
  '🫰': '5967655464912031948',
  '💘': '5452140079495518256',
  '⭐️': '4958714479681471536',
  '⭐': '4958714479681471536',
  '🌺': '5379647078853020173',
  '🌷': '5404835520150773707',
  '💐': '4956353063712457393',
  '🌹': '5440911110838425969',
  '🔞': '5377424158399432811',
  '🍑': '4956214684161147887',
  '🍬': '4958563494401147639',
  '🍭': '5424799150912838494',
  '🍫': '5816550191792133132',
  '🐰': '5372883239801224452',
  '🐱': '5375417691412676666',
  '🐣': '5470113903448956707',
  '🦋': '5445096582238181549',
  '🤷‍♂️': '5244884121934639059',
  '🤷♂️': '5244884121934639059',
  '👑': '4958725487682650920',
  '💄': '5366200064530203016',
  '💋': '4956680567853679460',
  '💌': '4958503072801228000',
  '💜': '5449468596952507859',
  '💙': '4956656232568980478',
  '💚': '5449380056201697322',
  '💛': '5449366943666543715',
  '🧡': '5449599833973203438',
  '🤎': '5449727072379346350',
  '💯': '6203738495639360972',
  '💣': '5818847054402686884',
  '💥': '5355054675936693221',
  '🔮': '4958624886663678191',
  '🪄': '5260426225599405269',
  '🎯': '5350460637182993292',
  '🏆': '6156436440260549720',
  '🥇': '5440539497383087970',
  '🎤': '4956441587283395517',
  '🎧': '5354899958329784877',
  '🎼': '5969867162616075178',
  '🎵': '5188621441926438751',
  '🎶': '4958562566688211974',
  '🧁': '5372907046804920585',
  '🌟': '4956745198521549627'
};

// Sort keys longest first so multi-codepoint emojis (e.g. ❤️🔥, 🤷‍♂️) match before single characters
const SORTED_EMOJIS = Object.keys(CUSTOM_EMOJI_MAP).sort((a, b) => b.length - a.length);
const EMOJI_REGEX = new RegExp(`(${SORTED_EMOJIS.map(escapeRegExp).join('|')})`, 'g');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get custom emoji ID if mapped.
 */
export function getCustomEmojiId(emoji) {
  return CUSTOM_EMOJI_MAP[emoji] ?? null;
}

/**
 * Transform text with mapped emojis into Telegram HTML format:
 * <tg-emoji emoji-id="5375129864179319277">🎀</tg-emoji>
 */
export function toCustomEmojiHtml(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(EMOJI_REGEX, (match) => {
    const id = CUSTOM_EMOJI_MAP[match];
    return id ? `<tg-emoji emoji-id="${id}">${match}</tg-emoji>` : match;
  });
}

/**
 * Transform a string or RichText into rich tokens, replacing mapped emojis
 * with { type: 'custom_emoji', alternative_text: emoji, custom_emoji_id: id }.
 */
export function enhanceRichText(content) {
  if (content == null) return content;
  if (Array.isArray(content)) {
    return content.map(enhanceRichText).flat(Infinity);
  }
  if (typeof content === 'object') {
    if (content.type === 'custom_emoji') return content;
    if (content.text !== undefined) {
      return { ...content, text: enhanceRichText(content.text) };
    }
    return content;
  }
  if (typeof content !== 'string') return content;

  // Split string by emojis
  const parts = content.split(EMOJI_REGEX);
  if (parts.length <= 1) return content;

  const result = [];
  for (const part of parts) {
    if (!part) continue;
    const id = CUSTOM_EMOJI_MAP[part];
    if (id) {
      result.push({
        type: 'custom_emoji',
        alternative_text: part,
        custom_emoji_id: id
      });
    } else {
      result.push(part);
    }
  }

  return result.length === 1 ? result[0] : result;
}

/**
 * Recursively enhance blocks of a Rich Message with custom emojis.
 */
export function applyCustomEmojisToBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (!b || typeof b !== 'object') return b;
    const clone = { ...b };
    switch (clone.type) {
      case 'paragraph':
      case 'heading':
      case 'footer':
      case 'pre':
        if (clone.text !== undefined) clone.text = enhanceRichText(clone.text);
        break;
      case 'pullquote':
        if (clone.text !== undefined) clone.text = enhanceRichText(clone.text);
        if (clone.credit !== undefined) clone.credit = enhanceRichText(clone.credit);
        break;
      case 'buttons':
        if (Array.isArray(clone.buttons)) {
          clone.buttons = clone.buttons.map((btn) => ({
            ...btn,
            text: enhanceRichText(btn.text)
          }));
        }
        break;
      case 'table':
        if (Array.isArray(clone.cells)) {
          clone.cells = clone.cells.map((row) =>
            row.map((cell) => (cell && cell.text !== undefined ? { ...cell, text: enhanceRichText(cell.text) } : cell))
          );
        }
        break;
      case 'list':
        if (Array.isArray(clone.items)) {
          clone.items = clone.items.map((it) => (it.blocks ? { ...it, blocks: applyCustomEmojisToBlocks(it.blocks) } : it));
        }
        break;
      case 'details':
        if (clone.summary !== undefined) clone.summary = enhanceRichText(clone.summary);
        if (Array.isArray(clone.blocks)) clone.blocks = applyCustomEmojisToBlocks(clone.blocks);
        break;
      case 'blockquote':
        if (Array.isArray(clone.blocks)) clone.blocks = applyCustomEmojisToBlocks(clone.blocks);
        break;
      case 'expandable_blockquote':
        if (clone.text !== undefined) clone.text = enhanceRichText(clone.text);
        if (Array.isArray(clone.blocks)) clone.blocks = applyCustomEmojisToBlocks(clone.blocks);
        break;
      default:
        break;
    }
    return clone;
  });
}
