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
  '🕯': '5451882707875276247',
  '🧸': '5354952271031455473',
  '🕊': '5434121252874756456',
  '🌙': '5807786710456602258',
  '✨': '5472164874886846699',
  '💫': '5469741319330996757',
  '💎': '5471952986970267163',
  '🫧': '5902009110290766704',
  '🪽': '6339264655361318131',
  '🪻': '5375282786489880721',
  '🥀': '5354881288106951870',
  '🕷': '5445149053853637789',
  '🕸': '5445388468215619925',
  '🦇': '5442769745050871204',
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
  '⚙️': '5260343246831237239',
  '⚙': '5260343246831237239',
  '📊': '5231200819986047254',
  '📈': '5373001317042101552',
  '💬': '5368408034202632731',
  '🤖': '5372981976804366741',
  '🌐': '5447410659077661506',
  '⏱': '5953759695226278894',
  '⏱️': '5953759695226278894',
  '🔜': '5440621591387980068',
  '🕐': '5199801757194030112',
  '⚡️': '5431449001532594346',
  '⚡': '5431449001532594346',
  '🚀': '5445284980978621387',
  '🔄': '5264727218734524899',
  '🗑': '5372825386591732174',
  '🗑️': '5372825386591732174',
  '➕': '5226945370684140473',
  '➖': '5229113891081956317',
  '📦': '5463172695132745432',
  '⏩': '5850534558608396441',

  // Moods & Reactions (by @holypappy)
  '🥺': '5413400535342532088',
  '🥹': '5420254671786744816',
  '🥰': '5325565443367259779',
  '🥵': '5461064793903351127',
  '😍': '5280517167782058238',
  '❤️‍🔥': '5449394813709327952',
  '❤️🔥': '5449394813709327952',
  '🫰': '5967655464912031948',
  '💘': '5452140079495518256',
  '⭐️': '5435957248314579621',
  '⭐': '5435957248314579621',
  '🌺': '5379647078853020173',
  '🌷': '5404835520150773707',
  '💐': '5190661263629243818',
  '🌹': '5440911110838425969',
  '🔞': '5377424158399432811',
  '🍑': '5375191900686927814',
  '🍬': '5848280675735572249',
  '🍭': '5424799150912838494',
  '🍫': '5816550191792133132',
  '🐰': '5372883239801224452',
  '🐱': '5375417691412676666',
  '🐣': '5470113903448956707',
  '🦋': '5445096582238181549',
  '🤷‍♂️': '5244884121934639059',
  '🤷♂️': '5244884121934639059',
  '👑': '5348306023889254367',
  '💄': '5366200064530203016',
  '💋': '5420273668427096000',
  '💌': '5472019095106886003',
  '💜': '5449468596952507859',
  '💙': '5449759615346548186',
  '💚': '5449380056201697322',
  '💛': '5449366943666543715',
  '🧡': '5449599833973203438',
  '🤎': '5449727072379346350',
  '💯': '5341498088408234504',
  '💣': '5818847054402686884',
  '💥': '5355054675936693221',
  '🔮': '5350466242115286518',
  '🪄': '5260426225599405269',
  '🎯': '5350460637182993292',
  '🏆': '6156436440260549720',
  '🥇': '5440539497383087970',
  '🎤': '5348138640423793920',
  '🎧': '5354899958329784877',
  '🎼': '5969867162616075178',
  '🎵': '5188621441926438751',
  '🎶': '5188705588925702510',
  '🧁': '5372907046804920585',
  '🌟': '5458799228719472718',
  // Auto-harvested & live-verified UI, Control, Flag & Reaction Emojis
  '⚠️': '5447644880824181073',
  '⚠': '5447644880824181073',
  '▶': '5341270334882463507',
  '▶️': '5341270334882463507',
  '🎙️': '5382013970905309819',
  '🎙': '5382013970905309819',
  '✅': '5771711424711626153',
  '🔒': '5348223165380179822',
  '⬇️': '5406745015365943482',
  '⬇': '5406745015365943482',
  '📢': '5355224833951023328',
  '⏳': '5451732530048802485',
  '📥': '5433811242135331842',
  '👥': '5372926953978341366',
  '📋': '5429528244913218983',
  '🏠': '5465226866321268133',
  '♥︎': '5348576757152759323',
  '♥': '5348576757152759323',
  '💡': '5472146462362048818',
  '💠': '5449903466686233293',
  '🏷️': '5343863498696833806',
  '🏷': '5343863498696833806',
  '🆔': '5431763212750073430',
  '☑️': '5454096630372379732',
  '☑': '5454096630372379732',
  '🔊': '5433875219968184554',
  '🔘': '5429555393401469575',
  '🎲': '5350314303352223876',
  '📺': '5373330964372004748',
  '📡': '5330247425871328294',
  '🗳': '5359741159566484212',
  '🎨': '5431456208487716895',
  '📂': '5431721976769027887',
  '🎛': '5330418941095325697',
  '🎛️': '5330418941095325697',
  '⏸': '5359543311897998264',
  '⏸️': '5359543311897998264',
  '📅': '5364233403300330811',
  '♾️': '5449366574299393809',
  '♾': '5449366574299393809',
  '⚔️': '5408935401442267103',
  '⚔': '5408935401442267103',
  '🔗': '5375129357373165375',
  'ℹ️': '5334544901428229844',
  'ℹ': '5334544901428229844',
  '👁️': '5461080380339667332',
  '👁': '5461080380339667332',
  '🟢': '5416081784641168838',
  '🌍': '5399898266265475100',
  '🔕': '5244807637157029775',
  '🛡️': '5361948635317680832',
  '🛡': '5361948635317680832',
  '✏️': '5334673106202010226',
  '✏': '5334673106202010226',
  '🎉': '5436040291507247633',
  '🍿': '5371081166013078244',
  '📚': '5373098009640836781',
  '📌': '5397782960512444700',
  '📣': '5469903029144657419',
  '🎮': '5467583879948803288',
  '🏢': '5264733042710181045',
  '⏰': '5413704112220949842',
  '❌': '5465665476971471368',
  '🔇': '5343930942568283286',
  '⚜️': '6052931808645880026',
  '⚜': '6052931808645880026',
  '🔠': '5449367416112985759',
  '✂️': '5237808360882977239',
  '✂': '5237808360882977239',
  '📷': '5228992515306174330',
  '🔔': '5242628160297641831',
  '🫶🏼': '5357107687484038897',
  '💗': '5242212506247670694',
  '☀️': '5469947168523558652',
  '☀': '5469947168523558652',
  '⬜': '6129780378572954907',
  '⌨️': '5472111548572900003',
  '⌨': '5472111548572900003',
  '🩸': '5352531829326891265',
  '🎭': '5359441070201513074',
  '🎚': '5222342355448781603',
  '🎚️': '5222342355448781603',
  '🥷': '5386534612962915793',
  '🔤': '5436102787576411840',
  '🌅': '5433727756561048984',
  '❤️‍🩹': '5470166383654347072',
  '❤‍🩹': '5470166383654347072',
  '💿': '5433996423945278087',
  '📻': '5433594530970488811',
  '🐹': '5282938489954902480',
  '🦖': '5460873384390830669',
  '📍': '5350747347724810871',
  '📁': '5433653135799228968',
  '💕': '5465511459444235288',
  '🇬🇧': '5202196682497859879',
  '✖': '5226660202035554522',
  '🧠': '5237799019329105246',
  '🏎️': '5190458184690588640',
  '🏎': '5190458184690588640',
  '📄': '5343597635926245720',
  '🌌': '5427139096340377507',
  '🌿': '5449850741667668411',
  '🔼': '5449683594425410231',
  '🔽': '5447183459602669338',
  '🎥': '5431443461024791843',
  '👇': '5470177992950946662',
  '💻': '5431376038628171216',
  '📀': '5433812431841284733',
  '🎁': '5199749070830197566',
  '🐼': '5280639613004685879',
  '🤞🏼': '5472139590414376346',
  '🐾': '5188308218551475917',
  '🇪🇸': '5201957744877248121',
  '🇫🇷': '5202132623060640759',
  '🇸🇦': '5202079966761590204',
  '🇧🇷': '5202074005346983800',
  '🇷🇺': '5449408995691341691',
  '🇮🇩': '5291937150814661333',
  '🎌': '5413869111979556783',
  '🏴‍☠️': '5386372293263892965',
  '🏴‍☠': '5386372293263892965',
  '📤': '5433614747381538714',
  '🙋': '5400186531585499808',
  '🕒': '5877458226823302157',
  '💢': '5467910507916697142',
  '🔵': '5427308464080726262',
  '🤫': '5370930189322688800',
  '📹': '5375309569905938163',
  '👉': '5471978009449731768',
  '🤞': '5472139590414376346',
  '🪩': '5375407018418904583',
  '🦊': '5283051451889756068',
  '🍷': '5330280024673101519',
  '🍒': '5406759193052995173',
  '💦': '5202202712631944524',
  '🪷': '5208911829505432564',
  '🍯': '5402418909557053333',
  '🥂': '5372923951796198347',
  '🎓': '5375163339154399459',
  '📭': '5352896944496728039',
  '🧾': '5426940939434243979',
  '🐇': '5460999037954042754',
  '😭': '5377556559356238807',
  '💀': '5370971163310693562',
  '😹': '5370677443382221953',
  '🙃': '5373179691328871991',
  '😮‍💨': '5373111135060892185',
  '🗯️': '5465132703458270101',
  '🗯': '5465132703458270101',
  '😿': '5386666691797195065',
  '😞': '5370812696197339229',
  '🌧️': '5283243028905994049',
  '🌧': '5283243028905994049',
  '💧': '5427132915882439149',
  '💞': '5451609943092239685',
  '🫶': '5357107687484038897',
  '🌀': '5332717075016200826',
  '🗿': '5442983582882601962',
  '🛸': '5319139188744936824',
  '🚨': '5323679617716863034',
  '🧊': '5238067068238046937',
  '🐍': '5409076727341130651',
  '🕹️': '5453921696354419743',
  '🕹': '5453921696354419743',
  '🦁': '5397972596203462916',
  '⛔': '5226646518269752676',
  '📬': '5350421256627838238',
  '⬆': '5382299856813455091',
  '⬆️': '5382299856813455091',
  '🔧': '5348239232852836489',
  '🖥': '5282843764451195532',
  '🖥️': '5282843764451195532',
  '👽': '5371018382181145040',
  '🆓': '5364112491381006601',
  '🧪': '5411512278740640309',
  '🔥': '5420315771991497307',
  '👤': '5373012449597335010',
  '📸': '5348104929225489792',
  '❤️': '5235606026207633751',
  '❤': '5235606026207633751',
  '🔴': '5411225014148014586',
  '📖': '5226512880362332956',
  '📝': '5334882760735598374',
  '🙈': '5467370583282950466',
  '🤨': '5370562939554111732',
  '👾': '5370869711888194012',
  '🌊': '6037258197377490416',
  '⭕': '5827702452333317430',
  '💃': '5190799832159100491',
  '👀': '5424885441100782420',
  '🏖️': '5433645645376264953',
  '🏖': '5433645645376264953',
  '☁️': '5287571024500498635',
  '☁': '5287571024500498635',
  '😂': '5370953476635368811',
  '🤡': '5371074117971745503',
  '🫠': '5373161588041718232',
  '😤': '5370650883304462905',
  '😾': '5370977588581767676',
  '💔': '5471954395719539651',
  '😔': '5370781385885751708',
  '😘': '5373189724372474575',
  '🤪': '5370853232098681087',
  '😎': '5373141891321699086',
  '👊': '5470058558500382450',
  '🐦': '5332594174527022579',
  '🗣️': '5370765563226236970',
  '🗣': '5370765563226236970',

  // Restored & Newly Harvested Live Telegram UI / Player / Reaction Emojis
  '🧹': '4956591954088428445',
  '💾': '5427158655621443938',
  '🎞': '5409178187353566863',
  '🎞️': '5409178187353566863',
  '⚪': '5409037625958872144',
  '⚪️': '5409037625958872144',
  '🟠': '5285217382422293688',
  '🟡': '5287355137969367127',
  '🟣': '5287288879508891910',
  '◀': '5375094039857106055',
  '◀️': '5375094039857106055',
  '⏹': '5431424189506536603',
  '⏹️': '5431424189506536603',
  '🔁': '5915754611955735302',
  '⏭': '5197194879549085520',
  '⏭️': '5197194879549085520',
  '🔦': '5294421050661024240',
  '🏜': '5400122996134262107',
  '🏜️': '5400122996134262107',
  '🕴': '5429169056798225808',
  '🕴️': '5429169056798225808',
  '🗾': '5433713467204868918',
  '🕶': '5433749227102548934',
  '🕶️': '5433749227102548934',
  '🃏': '4956525562483967357',
  '⛏': '6206188632747808299',
  '⛏️': '6206188632747808299',
  '☢': '5341789927141028113',
  '☢️': '5341789927141028113',
  '🗄': '6302872216346298615',
  '🗄️': '6302872216346298615',
  '🎴': '6122844418706769888',
  '↘': '6253444083436489388',
  '↘️': '6253444083436489388',

  // UI Control & Panel Semantic Fallbacks (preserve original alternative_text while displaying custom icon)
  '📜': '5343597635926245720',
  '🔀': '5431702975833719852',
  '⏮': '5375401426371514977',
  '⏮️': '5375401426371514977',
  '⏪': '5375401426371514977',
  '🕘': '5199801757194030112',
  '⏬': '5406745015365943482',
  '◻': '6129780378572954907',
  '◻️': '6129780378572954907',
  '↗': '5375600360666728936',
  '↗️': '5375600360666728936',
  '↖': '5375401426371514977',
  '↙': '5375401426371514977',
  '♻': '5264727218734524899',
  '♻️': '5264727218734524899',
  '🔢': '5449367416112985759',
  '💑': '5465511459444235288',
  '👩‍❤️‍👨': '5465511459444235288',
  '📓': '5226512880362332956',
  '📐': '5348239232852836489',
  '🚪': '5465226866321268133',
  '🧵': '5375129357373165375',
  '🕵️': '4958587679361991667',
  '🕵': '4958587679361991667',
  '🎒': '5463172695132745432',
  '♂️': '5449903466686233293',
  '♂': '5449903466686233293',
  '🪨': '5442983582882601962',
};

// Sort keys longest first so multi-codepoint emojis (e.g. ❤️🔥, 🤷‍♂️) match before single characters
const SORTED_EMOJIS = Object.keys(CUSTOM_EMOJI_MAP).sort((a, b) => b.length - a.length);
const EMOJI_REGEX = new RegExp(`(${SORTED_EMOJIS.map(escapeRegExp).join('|')})`, 'g');
const UNICODE_EMOJI_SEGMENT_RE = /([\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*))/gu;

let globalCatalogLookup = null;

/**
 * Connect the dynamic SQLite custom emoji catalog lookup (1,350+ synced emojis) so
 * both Rich messages and HTML posts automatically resolve custom IDs beyond hardcoded keys.
 */
export function setGlobalCustomEmojiLookup(lookupFn) {
  globalCatalogLookup = typeof lookupFn === 'function' ? lookupFn : null;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveEmojiIdWithCatalog(emoji, { registry = null } = {}) {
  if (!emoji) return null;
  if (CUSTOM_EMOJI_MAP[emoji]) return CUSTOM_EMOJI_MAP[emoji];
  const stripped = String(emoji).replace(/[\uFE0E\uFE0F]/g, '');
  if (CUSTOM_EMOJI_MAP[stripped]) return CUSTOM_EMOJI_MAP[stripped];
  if (registry?.lookupCandidates) {
    const cands = registry.lookupCandidates(emoji, { limit: 1 });
    if (cands?.[0]?.customEmojiId) return String(cands[0].customEmojiId);
  }
  if (globalCatalogLookup) {
    const found = globalCatalogLookup(emoji);
    if (found) return String(found);
  }
  return null;
}

/**
 * Get custom emoji ID if mapped (or dynamically indexed when catalog lookup is connected).
 */
export function getCustomEmojiId(emoji, opts = {}) {
  return resolveEmojiIdWithCatalog(emoji, opts) ?? null;
}

/**
 * Transform plain text with mapped/cataloged emojis into Telegram HTML format:
 * <tg-emoji emoji-id="5375129864179319277">🎀</tg-emoji>
 */
export function toCustomEmojiHtml(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  const useExtended = Boolean(opts.useCatalog || opts.registry || globalCatalogLookup);
  if (!useExtended) {
    return text.replace(EMOJI_REGEX, (match) => {
      const id = CUSTOM_EMOJI_MAP[match];
      return id ? `<tg-emoji emoji-id="${id}">${match}</tg-emoji>` : match;
    });
  }
  return text.replace(UNICODE_EMOJI_SEGMENT_RE, (match) => {
    if (/^[0-9#*©®™]$/.test(match)) return match;
    const id = resolveEmojiIdWithCatalog(match, opts);
    return id ? `<tg-emoji emoji-id="${id}">${match}</tg-emoji>` : match;
  });
}

/**
 * Upgrade standard Unicode emojis inside Telegram HTML (e.g. user captions & rich posts)
 * to `<tg-emoji emoji-id="...">` safely: skips inside HTML tags, attributes, `<code>`/`<pre>`,
 * and existing `<tg-emoji>...</tg-emoji>` spans.
 */
export function enhanceHtmlWithCustomEmojis(html, { registry = null } = {}) {
  if (typeof html !== 'string' || !html) return html;
  const lookupOpts = { registry, useCatalog: true };
  // Tokenize existing <tg-emoji>...</tg-emoji>, <code>...</code>, <pre>...</pre>, or single HTML tags
  const tokenRe = /(<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>|<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>)/gi;
  const parts = html.split(tokenRe);
  return parts.map((part, idx) => {
    if (!part) return '';
    // Odd indices are matched protected tags/blocks -> preserve untouched
    if (idx % 2 === 1) return part;
    return part.replace(UNICODE_EMOJI_SEGMENT_RE, (match) => {
      if (/^[0-9#*©®™]$/.test(match)) return match;
      const id = resolveEmojiIdWithCatalog(match, lookupOpts);
      return id ? `<tg-emoji emoji-id="${id}">${match}</tg-emoji>` : match;
    });
  }).join('');
}

/**
 * Build Telegram Bot API `custom_emoji` UTF-16 entities for plain-text messages/captions
 * (when parse_mode is unset and no entities were provided by the caller).
 */
export function extractCustomEmojiEntities(text, { maxEntities = 80, registry = null } = {}) {
  if (typeof text !== 'string' || !text) return { text, entities: [] };
  const lookupOpts = { registry, useCatalog: true };
  const matcher = new RegExp(UNICODE_EMOJI_SEGMENT_RE.source, 'gu');
  const entities = [];
  for (const m of text.matchAll(matcher)) {
    const match = m[0];
    if (!match || /^[0-9#*©®™]$/.test(match)) continue;
    const id = resolveEmojiIdWithCatalog(match, lookupOpts);
    if (!id) continue;
    entities.push({
      type: 'custom_emoji',
      offset: m.index,
      length: match.length,
      custom_emoji_id: String(id)
    });
    if (entities.length >= maxEntities) break;
  }
  return { text, entities };
}

/**
 * Transform a string or RichText into rich tokens, replacing mapped emojis
 * with { type: 'custom_emoji', alternative_text: emoji, custom_emoji_id: id }.
 */
export function enhanceRichText(content, opts = {}) {
  if (content == null) return content;
  if (Array.isArray(content)) {
    return content.map((c) => enhanceRichText(c, opts)).flat(Infinity);
  }
  if (typeof content === 'object') {
    if (content.type === 'custom_emoji') return content;
    if (content.text !== undefined) {
      return { ...content, text: enhanceRichText(content.text, opts) };
    }
    return content;
  }
  if (typeof content !== 'string') return content;

  const matcher = globalCatalogLookup || opts.registry ? UNICODE_EMOJI_SEGMENT_RE : EMOJI_REGEX;
  const parts = content.split(matcher);
  if (parts.length <= 1) return content;

  const result = [];
  for (const part of parts) {
    if (!part) continue;
    const isRealEmoji = matcher === EMOJI_REGEX ? Boolean(CUSTOM_EMOJI_MAP[part]) : (!/^[0-9#*©®™]$/.test(part) && UNICODE_EMOJI_SEGMENT_RE.test(part));
    if (UNICODE_EMOJI_SEGMENT_RE.lastIndex) UNICODE_EMOJI_SEGMENT_RE.lastIndex = 0;
    const id = isRealEmoji ? resolveEmojiIdWithCatalog(part, opts) : null;
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
    if (clone._rawEmoji) {
      delete clone._rawEmoji;
      return clone;
    }
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
          clone.buttons = clone.buttons.map((btn) => {
            if (btn && btn._rawEmoji) {
              const { _rawEmoji, ...rest } = btn;
              return rest;
            }
            return {
              ...btn,
              text: enhanceRichText(btn.text)
            };
          });
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
      case 'photo':
      case 'video':
      case 'audio':
      case 'animation':
      case 'document':
      case 'collage':
      case 'slideshow':
        if (clone.caption && clone.caption.text !== undefined) {
          clone.caption = { ...clone.caption, text: enhanceRichText(clone.caption.text) };
        }
        break;
      default:
        break;
    }
    return clone;
  });
}
