import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  catalogSearch,
  thenkiriSearch,
  thenkiriDetails,
  thenkiriGetLink,
  dramafrenDl,
  anydramaDl,
  justwatchDl,
  justwatchWatch
} from 'social-dl';
import { logger } from '../core/logger.js';
import { normalizeTrack } from '../music/model.js';
import { normalizeLangCode, isDubAudioLabel } from './streamingServer.js';

const execFileAsync = promisify(execFile);

const TRAILER_RE = /\b(trailers?|teasers?|promos?|sneak\s*peeks?|clips?|samples?|excerpts?|snippets?|featurettes?|previews?|recaps?|reviews?|reactions?|ending\s*explained|explained|summary|behind\s*the\s*scenes|making\s*of|soundtrack|ost|theme\s*song|short\s*film|(?:parody|spoof)\s+(?:trailer|teaser|clip|skit|short|recap)|compilations?|highlights?|interviews?|deleted\s+scenes?|bloopers?|gag\s+reel|music\s+video|status\s+video|gameplay|playthrough|walkthrough|longplay|speedrun|cutscenes?|no\s*commentary|audiobook|podcast|video\s*essays?|retrospectives?|easter\s*eggs|iceberg|tributes?|fan\s*films?|fan\s*edits?|tiktok\s*edits?|youtube\s*shorts?|spoilers?|breakdown|(?:opening|final|ending|best|top|iconic|leaked|bonus|mid[\s-]?credit|post[\s-]?credit)\s+scenes?|scene\s+\d+|(?:part|pt)\s*\d+\s*(?:of|\/)\s*[2-9]\d*|episode\s+\d+\s+part\s+\d+)\b/i;
const SPLIT_PART_RE = /\b(?:part|pt)\s*(?:1|2|3|4|i|ii|iii|iv)(?:\s*(?:of|\/)\s*\d+)?\b/i;
const GAME_NOISE_RE = /\b(?:the\s+game|video\s+game|pc\s+game|nintendo|playstation|ps[1-5]|xbox|wii|ds)\b/i;
const PREVIEW_PATH_RE = /(?:^|[_./-])(?:(?:index_)?previews?|trailers?|teasers?|samples?|clips?)(?:[_./-]|$)/i;
const DIRECT_VIDEO_RE = /\.(mkv|mp4|webm|m3u8)(\?|$)/i;
const AD_OR_BAD_DOMAIN_RE = /(hai8g\.|doubleclick|googlesyndication|adsterra|popads|shorte\.st|adf\.ly|ouo\.io|facebook\.com|twitter\.com|x\.com|instagram\.com|t\.me\/)/i;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const CINEMA_STREAM_NODES = ['https://proxy1.flikhub.net', 'https://proxy.yenime.net', 'https://proxy3.flikhub.net'];
const CINEMA_STREAM_ROUTES = ['berlin', 'jennifer', 'scarlet', 'zendaya', 'lookmovie', 'meowtv', 'vidnest', 'sadie'];
const PUNKFLIX_HOST = 'https://punkflix.net';
const CINEMA_PLAYER_HEADERS = {
  Referer: 'https://player.cinezo.live/',
  Origin: 'https://player.cinezo.live',
  'User-Agent': UA
};
const VIDBOLT_HEADERS = {
  Referer: 'https://vidbolt.xyz/',
  Origin: 'https://vidbolt.xyz',
  'User-Agent': UA
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'movie', 'series', 'film', 'full', 'download', 'watch', 'online', 'free', 'hd',
  '1080p', '720p', '480p', '360p', '2160p', '4k', 'webrip', 'web', 'dl', 'bluray',
  'brrip', 'hdrip', 'x264', 'x265', 'hevc', 'aac', 'mp4', 'mkv'
]);
const RELEASE_TAG_WORDS = new Set([
  'feature', 'special', 'uncut', 'dvd', 'dvdrip', 'bdrip', 'hdtv', 'cam', 'ts', 'print',
  'paramount', 'warner', 'universal', 'sony', 'disney', 'pixar', 'fox', 'netflix', 'amzn',
  'dsnp', 'hmax', 'hulu', 'direct', 'complete', 'edition', 'directors', 'cut', 'unrated',
  'remastered', 'restored', 'extended', 'proper', 'repack', 'hdr', 'sdr', 'uhd', 'fhd',
  'sd', 'hq', 'english', 'eng', 'en', 'dual',
  'audio', 'multi', 'sub', 'subbed', 'subtitles', 'subtitle', 'srt',
  'h264', 'h265', 'av1', 'ac3', 'eac3', 'ddp', 'dd', 'dts', 'avi', 'mov', 'yts', 'yify', 'rarbg', 'etrg',
  'evo', 'sparks', 'nkiri', 'thenkiri', 'netnaija', 'fzmovies', 'toxicwap', 'awafim',
  'hollywood', 'bollywood', 'nollywood', 'kdrama', 'drama', 'anime',
  'official', 'movies', 'films', 'hdmovies', 'boxset', 'collection', 'streaming',
  '10bit', '8bit', '12bit', '60fps', '5', '7', 'ddp5'
]);
const NUMERAL_NORMALIZE = {
  ii: '2', two: '2',
  iii: '3', three: '3',
  iv: '4', four: '4',
  v: '5', five: '5',
  vi: '6', six: '6',
  vii: '7', seven: '7',
  viii: '8', eight: '8',
  ix: '9', nine: '9',
  x: '10', ten: '10'
};

function expandCamelCaseText(text = '') {
  return String(text || '')
    .replace(/([a-z]{3,})([A-Z][a-z]{2,})/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTargetTitleWords(text = '', targetTitle = '', { episodeTitle = '', alternateTitle = '' } = {}) {
  let s = String(text || '');
  const targets = [targetTitle, expandCamelCaseText(targetTitle), episodeTitle, alternateTitle]
    .map((x) => String(x || '').replace(/\s*\(\d{1,2}\)\s*$/g, '').trim())
    .filter((t) => t.length >= 3);
  for (const t of [...new Set(targets)]) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    s = s.replace(new RegExp(escaped, 'ig'), ' ');
  }
  return s;
}

const EXPLICIT_CHUNKED_PART_RE = /\b(?:part|pt)\s*\d+\s*(?:of|\/)\s*[2-9]\d*\b/i;

function isSplitPartTitle(text = '', targetTitle = '', { isTv = false, episodeTitle = '', alternateTitle = '' } = {}) {
  const cleanTarget = String(targetTitle || '').trim();
  const cleanEp = String(episodeTitle || '').trim();
  const rawStr = String(text || '');
  if (EXPLICIT_CHUNKED_PART_RE.test(rawStr)) return true;
  if (cleanTarget && /\b(?:part|pt)\b/i.test(cleanTarget)) return false;
  if (isTv && (/\b(?:part|pt|\([1-4]\))\b/i.test(cleanEp) || /\b(?:s\d{1,2}\s*e\d{1,3}|episode\s*0*\d{1,3}|e\d{1,3})\b/i.test(rawStr))) {
    return false;
  }
  const withoutTitle = stripTargetTitleWords(rawStr, cleanTarget, { episodeTitle: cleanEp, alternateTitle });
  return SPLIT_PART_RE.test(withoutTitle);
}

function isTrailerLike(text = '', targetTitle = '', extra = {}) {
  const s = String(text || '');
  if (PREVIEW_PATH_RE.test(s)) return true;
  const withoutTitle = stripTargetTitleWords(s, targetTitle, extra);
  if (TRAILER_RE.test(withoutTitle)) return true;
  if (GAME_NOISE_RE.test(s) && !GAME_NOISE_RE.test(String(targetTitle || '')) && !/\bgame\b/i.test(String(targetTitle || ''))) {
    return true;
  }
  return false;
}

function isNonFeatureOrClipTitle(text = '', targetTitle = '', extra = {}) {
  return isTrailerLike(text, targetTitle, extra) || isSplitPartTitle(text, targetTitle, extra);
}

const LANG_WORDS_RE = /\b(english|eng|hindi|hin|spanish|spa|esp|latino|castellano|french|fre|fra|german|ger|deu|italian|ita|portuguese|por|russian|rus|arabic|ara|turkish|tur|korean|kor|japanese|jpn|chinese|chi|zho|mandarin|cantonese|tamil|tam|telugu|tel|malayalam|mal|thai|tha|indonesian|ind|vietnamese|vie|polish|pol|dutch|dut|nld)\s+(?:audio|dub(?:s|bed|bing)?|version|track|voice\s*over|voiceover)\b/gi;
const MENTIONED_LANG_RE = /\b(english|eng|hindi|hin|spanish|spa|esp|latino|castellano|french|fre|fra|german|ger|deu|italian|ita|portuguese|por|russian|rus|arabic|ara|turkish|tur|korean|kor|japanese|jpn|chinese|chi|zho|mandarin|cantonese|tamil|tam|telugu|tel|malayalam|mal|thai|tha|indonesian|ind|vietnamese|vie|polish|pol|dutch|dut|nld|dublado|vff|vfq|truefrench)\b/gi;
const STANDALONE_DUB_LANG_RE = /\b(hindi|dublado|latino|castellano|vff|vfq|truefrench)\b/gi;

export function isDubbedCandidateText(text = '', { preferredAudioLang = '', targetTitle = '' } = {}) {
  const prefLang = normalizeLangCode(preferredAudioLang);
  const raw = stripTargetTitleWords(String(text || ''), targetTitle);
  if (!raw.trim()) return false;
  // Strip subtitle notes so "English Subbed" / "Spanish Subtitles" is never mistaken for a dub.
  const withoutSubs = raw
    .replace(/\b(?:english|eng|hindi|hin|french|fre|fra|spanish|spa|esp|japanese|jpn|korean|kor|chinese|chi|zho|arabic|ara|portuguese|por|german|ger|deu|italian|ita|russian|rus|turkish|tur|thai|tha|indonesian|ind|vietnamese|vie)\s*[-_ ]*\bsub(?:s|bed|titles?|titled)?\b/gi, ' ')
    .replace(/\bmulti[\s._-]*subs?\b/gi, ' ');
  const isDual = /\b(?:dual|multi)[\s._-]*audio\b/i.test(withoutSubs);

  if (!isDual && isDubAudioLabel(withoutSubs)) return true;

  const detectedCodes = [];
  for (const m of withoutSubs.matchAll(LANG_WORDS_RE)) {
    const c = normalizeLangCode(m[1]);
    if (c) detectedCodes.push({ code: c, explicitDub: /\b(?:dub|voice|latino|castellano)/i.test(m[0]) });
  }
  if (!isDual) {
    for (const m of withoutSubs.matchAll(STANDALONE_DUB_LANG_RE)) {
      const c = normalizeLangCode(m[1]);
      if (c) detectedCodes.push({ code: c, explicitDub: true });
    }
  }
  if (!detectedCodes.length) {
    if (!isDual || !prefLang) return false;
    const mentioned = new Set();
    for (const m of withoutSubs.matchAll(MENTIONED_LANG_RE)) {
      const c = normalizeLangCode(m[1]);
      if (c) mentioned.add(c);
    }
    return mentioned.size > 0 && !mentioned.has(prefLang);
  }
  if (isDual && prefLang && detectedCodes.some((d) => d.code === prefLang && !d.explicitDub)) {
    return false;
  }
  return detectedCodes.some((d) => {
    if (d.explicitDub && (!prefLang || d.code !== prefLang)) return true;
    if (prefLang) return d.code !== prefLang;
    return d.code !== 'en';
  });
}

function parseIso8601Duration(raw = '') {
  const m = String(raw || '').match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return 0;
  return Math.round((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0));
}

function extractQualityLabel(raw = '') {
  const m = String(raw || '').match(/(?:^|[\s([/_-])(2160p?|4K|1080p?|720p?|480p?|360p?)(?=$|[\s)\]/_-])/i);
  if (m) {
    const val = m[1].toUpperCase();
    if (val === '4K') return '4K';
    return val.endsWith('P') ? val.toLowerCase() : `${val.toLowerCase()}p`;
  }
  return 'HD';
}

function tokenizeWords(text = '') {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeToken(tok) {
  return NUMERAL_NORMALIZE[tok] || tok;
}

function stripCodecTags(text = '') {
  return String(text || '')
    .replace(/\b(?:(?:ddp?|ac3|eac3|dts|aac|audio|ch|channels?)[\s._-]*)?(?:5\.1|7\.1|2\.0|5\s+1|7\s+1)\b/gi, ' ')
    .replace(/\b(?:ddp?|ac3|eac3|dts)\s*(?:5|7|2)\b/gi, ' ')
    .replace(/\b(?:8|10|12)\s*bit\b/gi, ' ')
    .replace(/\b(?:24|30|60|120)\s*fps\b/gi, ' ')
    .replace(/\b(?:2k|4k|8k)\b/gi, ' ');
}

function extractSequelNumbers(text = '', { ignoreYear = null } = {}) {
  const nums = new Set();
  const raw = stripCodecTags(text).toLowerCase();
  const toks = tokenizeWords(raw);
  for (let i = 0; i < toks.length; i++) {
    const prev = toks[i - 1] || '';
    const norm = normalizeToken(toks[i]);
    if (!/^\d{1,2}$/.test(norm)) continue;
    const n = Number(norm);
    if (n < 2 || n > 19) continue;
    if (['s', 'season', 'ep', 'episode', 'e'].includes(prev)) continue;
    if (/^s\d{1,2}e\d{1,3}$/i.test(prev)) continue;
    if (ignoreYear && String(ignoreYear) === norm) continue;
    nums.add(String(n));
  }
  return nums;
}

function significantTokens(text = '') {
  const rawToks = tokenizeWords(text);
  const out = [];
  for (let i = 0; i < rawToks.length; i++) {
    const t = rawToks[i];
    if (t === 'part' || t === 'vol' || t === 'chapter') {
      const next = normalizeToken(rawToks[i + 1] || '');
      if (/^\d{1,2}$/.test(next)) continue;
    }
    const norm = normalizeToken(t);
    if (/^\d{1,2}$/.test(norm)) {
      out.push(norm);
      continue;
    }
    if (STOP_WORDS.has(t)) continue;
    if (t.length >= 2) out.push(t);
  }
  if (!out.length) {
    return rawToks.filter((t) => !STOP_WORDS.has(t) && t.length >= 1);
  }
  return [...new Set(out)];
}

export function scoreTitleMatch(targetTitle, targetYear, candidateText, { isTv = false, season = null, episode = null, episodeTitle = null, alternateTitle = null, alternateSeason = null } = {}) {
  const candRaw = String(candidateText || '');
  const candLower = candRaw.toLowerCase();
  const titleFilterOpts = { isTv, episodeTitle: episodeTitle || '', alternateTitle: alternateTitle || '' };
  if (!candLower || isTrailerLike(candLower, targetTitle, titleFilterOpts)) return -100;
  if (isTv && EXPLICIT_CHUNKED_PART_RE.test(candRaw)) return -100;
  if (!isTv && isSplitPartTitle(candRaw, targetTitle, titleFilterOpts)) return -100;

  if (
    !isTv
    && !/\b(?:season|episode|ep\b|s\d{1,2}\s*e\d|complete\s+series)\b/i.test(String(targetTitle || ''))
    && /\b(?:s\d{1,2}\s*e\d{1,3}|season\s*\d{1,2}|episode\s*\d{1,3}|complete\s+series)\b/i.test(candRaw)
  ) {
    return -80;
  }

  // Strip TV episode markers and audio/bitrate specs before token matching
  const candNoCodec = stripCodecTags(candLower);
  const candExpanded = stripCodecTags(expandCamelCaseText(candRaw).toLowerCase());
  const candCleaned = candExpanded
    .replace(/\b(?:s\d{1,2}\s*e\d{1,3}|season\s*\d{1,2}|episode\s*0*\d{1,3}|seasons?|episodes?)\b/gi, ' ');
  const candForTitle = isTv ? candCleaned : candNoCodec;
  const candTokList = tokenizeWords(candForTitle).map(normalizeToken);
  const candTokSet = new Set(candTokList);
  const candJoinedPairs = new Set();
  for (let i = 0; i < candTokList.length - 1; i++) {
    candJoinedPairs.add(`${candTokList[i]}${candTokList[i + 1]}`);
  }

  const expandedTarget = expandCamelCaseText(targetTitle);
  const rawWords = significantTokens(targetTitle);
  const spacedWords = significantTokens(expandedTarget);
  const words = spacedWords.length >= rawWords.length ? spacedWords : rawWords;
  if (!words.length) return -60;
  const wordSet = new Set([...rawWords, ...spacedWords]);
  const cleanEpTitle = String(episodeTitle || '').replace(/\s*\(\d{1,2}\)\s*$/g, '').trim();
  const epWordSet = new Set(cleanEpTitle ? significantTokens(expandCamelCaseText(cleanEpTitle)) : []);
  const altWordSet = new Set(alternateTitle ? significantTokens(expandCamelCaseText(alternateTitle)) : []);

  const targetMatchesCand = (w) => (
    candTokSet.has(w)
    || (w.length >= 4 && (candTokSet.has(`${w}s`) || candTokSet.has(`${w}es`)))
    || candJoinedPairs.has(w)
  );

  let matchedWords = 0;
  for (const w of words) {
    if (targetMatchesCand(w)) matchedWords += 1;
  }
  const primaryComplete = words.length <= 4
    ? matchedWords === words.length
    : (matchedWords / Math.max(1, words.length)) >= 0.80;
  let usedAltWords = false;
  if (!primaryComplete && altWordSet.size >= 2) {
    const altWordsArr = [...altWordSet];
    const altHits = altWordsArr.filter(targetMatchesCand).length;
    if (altHits === altWordsArr.length || (altWordsArr.length >= 5 && altHits / altWordsArr.length >= 0.80)) {
      matchedWords = altHits;
      usedAltWords = true;
    }
  }
  if (matchedWords === 0) return -60;

  const activeWordCount = usedAltWords ? altWordSet.size : words.length;
  const coverage = matchedWords / Math.max(1, activeWordCount);
  // Require every significant title token for 1..4 word titles so partial collisions
  // (e.g. "The Three Musketeers" vs "Barbie and the Three Musketeers") never match.
  if (activeWordCount <= 4 && coverage < 1) return -55;
  if (activeWordCount >= 5 && coverage < 0.80) return -55;

  // Guard sequel/installment mismatches (e.g. "John Wick 4" vs "John Wick", or "Dune Part Two" vs "Dune")
  const targetSeq = extractSequelNumbers(targetTitle);
  const candSeq = extractSequelNumbers(candForTitle);
  for (const sNum of targetSeq) {
    if (!candSeq.has(sNum)) return -70;
  }
  if (targetSeq.size === 0 && !isTv) {
    for (const cNum of candSeq) {
      if (Number(cNum) >= 2 && Number(cNum) <= 9) return -55;
    }
  }

  let score = matchedWords * 14;
  if (coverage === 1) score += 12;

  // When YouTube/video uploads append cast/channel credits after "|" (e.g. "Title | Full Movie | Actor A | Actor B"),
  // evaluate extra story words on the leading title segment if that segment matches 100% of target tokens.
  let tokensForExtra = candTokList;
  if (candForTitle.includes('|') && words.length >= 2) {
    const segments = candForTitle.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    const genericLeadRe = /^(?:full|free|watch|official|new|hd|4k|1080p|720p|indie|movie|film|movies|cinema|episode|series)+$/;
    for (let sIdx = 0; sIdx < Math.min(2, segments.length); sIdx += 1) {
      if (sIdx === 1) {
        const seg0Toks = tokenizeWords(segments[0]).map(normalizeToken).filter(Boolean);
        if (!seg0Toks.length || !seg0Toks.every((t) => STOP_WORDS.has(t) || RELEASE_TAG_WORDS.has(t) || genericLeadRe.test(t))) {
          break;
        }
      }
      const segToks = tokenizeWords(segments[sIdx]).map(normalizeToken);
      const segSet = new Set(segToks);
      const allInSeg = words.every((w) => segSet.has(w) || (w.length >= 4 && (segSet.has(`${w}s`) || segSet.has(`${w}es`))));
      if (allInSeg) {
        tokensForExtra = segToks;
        break;
      }
    }
  }

  // Penalize unrequested extra story words across ALL title lengths (prevents "Barbie" matching
  // "Barbie and the Three Musketeers" or "The Three Musketeers" matching "Barbie and the Three Musketeers")
  const extraStoryWords = [];
  for (let i = 0; i < tokensForExtra.length; i++) {
    const ct = tokensForExtra[i];
    if (!ct || STOP_WORDS.has(ct) || RELEASE_TAG_WORDS.has(ct)) continue;
    if (isTv && (ct === 'tv' || ct === 'show' || ct === 'series')) continue;
    if (/^(19\d\d|20\d\d|\d{3,4}p?)$/.test(ct)) continue;
    if (wordSet.has(ct) || epWordSet.has(ct) || altWordSet.has(ct)) continue;
    const joinedNext = i + 1 < tokensForExtra.length ? `${ct}${tokensForExtra[i + 1]}` : '';
    const joinedPrev = i > 0 ? `${tokensForExtra[i - 1]}${ct}` : '';
    if ((joinedNext && (wordSet.has(joinedNext) || altWordSet.has(joinedNext))) || (joinedPrev && (wordSet.has(joinedPrev) || altWordSet.has(joinedPrev)))) {
      continue;
    }
    const isPluralVariant = [...words, ...altWordSet].some((w) => w.length >= 4 && (ct === `${w}s` || ct === `${w}es`));
    if (isPluralVariant) continue;
    if (ct.length >= 2) extraStoryWords.push(ct);
  }
  const uniqueExtraCount = new Set(extraStoryWords).size;
  if (uniqueExtraCount > 0) {
    if (activeWordCount === 1) {
      score -= uniqueExtraCount * 28;
    } else if (activeWordCount === 2) {
      score -= uniqueExtraCount * 26;
    } else {
      score -= uniqueExtraCount * 16;
    }
  }

  // Year match & mismatch guard
  const candYears = [...candRaw.matchAll(/\b(19[3-9]\d|20[0-3]\d)\b/g)].map((m) => Number(m[1]));
  if (targetYear) {
    const yNum = Number(targetYear);
    if (candYears.includes(yNum)) score += 20;
    else if (candYears.some((cy) => Math.abs(cy - yNum) <= 1)) score += 8;
    else if (candYears.length > 0 && candYears.every((cy) => Math.abs(cy - yNum) > 1)) score -= 55;
  }

  if (isTv && season != null) {
    const epMatches = epWordSet.size >= 2 ? [...epWordSet].filter(targetMatchesCand).length : 0;
    const epTitleMatched = epWordSet.size >= 2 && epMatches >= Math.min(2, epWordSet.size);
    const allowedSeasons = (usedAltWords && alternateSeason != null && !epTitleMatched)
      ? new Set([Number(alternateSeason)])
      : new Set([Number(season), ...(alternateSeason != null ? [Number(alternateSeason)] : [])]);
    const parsed = parseEpisodeCode(candRaw);
    if (parsed.seasonNumber != null && !allowedSeasons.has(parsed.seasonNumber)) return -60;
    if (episode != null && parsed.episodeNumber != null && parsed.episodeNumber !== Number(episode)) return -60;
    for (const sNum of allowedSeasons) {
      const sPad = String(sNum).padStart(2, '0');
      if (new RegExp(`\\b(s0?${sNum}(?:e\\d+)?|season\\s*0?${sNum}\\b|s${sPad})`, 'i').test(candLower)) {
        score += 18;
        break;
      }
    }
    if (epTitleMatched) {
      score += 14;
    }
  }
  if (!isTv && /\b(hollywood\s*movie|nollywood|bollywood|k-drama|anime|download|full\s*movie)\b/i.test(candLower)) score += 6;
  return score;
}

function parseEpisodeCode(text = '') {
  const s = String(text || '');
  const se = s.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i)
    || s.match(/Season\s*(\d{1,2})\D+Episode\s*(\d{1,3})\b/i)
    || s.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (se) return { seasonNumber: Number(se[1]), episodeNumber: Number(se[2]) };
  const sOnly = s.match(/\b(?:Season|S)\s*0*(\d{1,2})\b/i);
  const ep = s.match(/(?:^|[\s._\-\[(])(?:Episode|Ep|E)\s*0*(\d{1,3})(?=$|[\s._\-\])])/i);
  if (ep) return { seasonNumber: sOnly ? Number(sOnly[1]) : null, episodeNumber: Number(ep[1]) };
  return { seasonNumber: sOnly ? Number(sOnly[1]) : null, episodeNumber: null };
}

function matchEpisodeSource(sources, { type = 'movie', season = null, episode = null }) {
  const isTv = String(type).toLowerCase() === 'tv';
  const clean = (Array.isArray(sources) ? sources : []).filter((s) => {
    const label = `${s?.label || ''} ${s?.title || ''} ${s?.url || ''}`;
    return s?.url && !isTrailerLike(label) && !AD_OR_BAD_DOMAIN_RE.test(s.url);
  });
  if (!clean.length) return [];

  if (isTv && episode != null) {
    const targetS = season != null ? Number(season) : 1;
    const targetE = Number(episode);
    const exact = clean.filter((s) => {
      const text = `${s.label || ''} ${s.title || ''} ${s.url || ''}`;
      const parsed = parseEpisodeCode(text);
      const sNum = s.seasonNumber != null ? Number(s.seasonNumber) : parsed.seasonNumber;
      const eNum = s.episodeNumber != null ? Number(s.episodeNumber) : parsed.episodeNumber;
      if (eNum !== targetE) return false;
      if (sNum != null && sNum !== targetS) return false;
      return true;
    });
    return exact;
  }

  return clean
    .slice()
    .sort((a, b) => {
      const aL = `${a.label || ''} ${a.title || ''}`;
      const bL = `${b.label || ''} ${b.title || ''}`;
      const score = (lbl, url) => (
        (/downloadwella/i.test(url || '') ? 14 : 0) +
        (/download\s*movie|full\s*movie|1080p|720p|mp4|mkv/i.test(lbl) ? 10 : 0) -
        (/subtitle|srt|zip/i.test(lbl) ? 20 : 0)
      );
      return score(bL, b.url) - score(aL, a.url);
    });
}

function buildSearchQueries({ title, year = null, type = 'movie', season = null, alternateTitle = null, alternateSeason = null }) {
  const base = String(title || '').trim();
  const noParen = base.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const spaced = expandCamelCaseText(noParen);
  const isTv = String(type).toLowerCase() === 'tv';
  const out = [];
  if (year && spaced) out.push(`${spaced} ${year}`);
  if (year && noParen && noParen !== spaced) out.push(`${noParen} ${year}`);
  if (isTv && season) out.push(`${spaced} S${String(season).padStart(2, '0')}`);
  if (alternateTitle) {
    const altClean = expandCamelCaseText(String(alternateTitle).replace(/\s*\([^)]*\)\s*/g, ' ').trim());
    if (altClean) out.push(altClean);
    if (isTv && alternateSeason != null) out.push(`${altClean} S${String(alternateSeason).padStart(2, '0')}`);
  }
  if (spaced) out.push(spaced);
  if (noParen && noParen !== spaced) out.push(noParen);
  if (base && base !== noParen && base !== spaced) out.push(base);
  return [...new Set(out)];
}

const LANG_DISPLAY_NAMES = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  hi: 'Hindi',
  ar: 'Arabic',
  tr: 'Turkish',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  bn: 'Bengali',
  pl: 'Polish',
  uk: 'Ukrainian',
  nl: 'Dutch',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  tl: 'Filipino',
  fa: 'Persian',
  he: 'Hebrew'
};

function langCodeToDisplayName(code, fallback = 'Subtitles') {
  const c = normalizeLangCode(code);
  if (c && LANG_DISPLAY_NAMES[c]) return LANG_DISPLAY_NAMES[c];
  const raw = String(fallback || '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
  return raw || 'Subtitles';
}

function inferSubtitleType(url = '', explicitType = '', mimeHint = '') {
  const extMatch = String(url || '').split('?')[0].toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch?.[1] || '';
  const hint = `${explicitType} ${mimeHint}`.toLowerCase();
  if (ext === 'ttml' || ext === 'dfxp' || hint.includes('ttml') || hint.includes('dfxp')) return 'ttml';
  if (ext === 'ass' || ext === 'ssa' || hint.includes('ass') || hint.includes('ssa')) return 'ass';
  if (ext === 'vtt' || hint.includes('vtt')) return 'vtt';
  if (ext === 'srt' || hint.includes('srt') || hint.includes('subrip')) return 'srt';
  if (ext === 'm3u8' || hint.includes('hls')) return 'hls_vtt';
  return 'srt';
}

function formatSubtitleHint({ url, headers = {}, langRaw = '', labelRaw = '', explicitType = '', mimeHint = '', forced = false, sdh = false, tier = 'same_route' }) {
  const langCode = normalizeLangCode(langRaw) || normalizeLangCode(labelRaw);
  const language = langCodeToDisplayName(langCode, langRaw || labelRaw || 'Subtitles');
  const rawDesc = String(labelRaw || langRaw || '').trim();
  const variantTags = [];
  if (forced || /\bforced\b/i.test(rawDesc) || /\bforced\b/i.test(url)) variantTags.push('Forced');
  if (sdh || /\b(?:sdh|cc|hearing\s*impaired|closed\s*captions?)\b/i.test(rawDesc) || /[._-](?:sdh|hi|cc)(?:[._-]|$)/i.test(url)) variantTags.push('SDH');
  if (/\bsigns?(?:\s*(?:&|and)\s*songs?)?\b/i.test(rawDesc)) variantTags.push('Signs & Songs');

  let label = rawDesc;
  const cleanedRaw = rawDesc.replace(/\b(?:subtitles?|subs?)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!label || /^(?:[a-z]{2,3})$/i.test(label) || cleanedRaw.toLowerCase() === language.toLowerCase()) {
    label = variantTags.length ? `${language} (${variantTags.join(', ')})` : `${language} Subtitles`;
  } else if (variantTags.length && !new RegExp(variantTags[0], 'i').test(label)) {
    label = `${label} (${variantTags.join(', ')})`;
  }
  return {
    language,
    langCode: langCode || '',
    label,
    url,
    headers,
    tier,
    type: inferSubtitleType(url, explicitType, mimeHint)
  };
}

function decodeXmlEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function inspectDashAudioTracks(xml = '', preferredAudioLang = '') {
  const prefLang = normalizeLangCode(preferredAudioLang);
  const sets = [];
  for (const m of String(xml || '').matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const isText = /\bcontentType\s*=\s*["']text["']/i.test(attrs)
      || /\bmimeType\s*=\s*["'](?:text\/|application\/(?:ttml\+xml|x-subrip))/i.test(`${attrs} ${inner}`);
    const isAudio = /\bcontentType\s*=\s*["']audio["']/i.test(attrs)
      || (!/\bcontentType\s*=\s*["'](?:video|text)["']/i.test(attrs) && /\bmimeType\s*=\s*["']audio\//i.test(`${attrs} ${inner}`));
    if (!isAudio || isText) continue;

    const langRaw = attrs.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]
      || inner.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    const lang = normalizeLangCode(langRaw);
    const labelText = [
      attrs.match(/\blabel\s*=\s*["']([^"']+)["']/i)?.[1],
      inner.match(/<Label[^>]*>([\s\S]*?)<\/Label>/i)?.[1]
    ].filter(Boolean).join(' ');
    const roles = [...inner.matchAll(/<Role[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi)].map((r) => r[1].toLowerCase());
    const isDub = roles.includes('dub') || isDubAudioLabel(labelText);
    const isMain = roles.includes('main') || roles.includes('original');
    const isComment = roles.some((r) => r.includes('commentary') || r.includes('description') || r.includes('alternate'));

    let score = 0;
    if (prefLang && lang) score += (lang === prefLang) ? 100 : -80;
    if (isMain) score += 30;
    if (isDub) score -= 120;
    else score += 30;
    if (isComment) score -= 100;
    sets.push({ lang, labelText, isDub, score });
  }
  if (!sets.length) {
    return { audioLanguage: '', audioIsDub: false, audioLanguages: [] };
  }
  const best = sets.reduce((a, b) => (b.score > a.score ? b : a), sets[0]);
  const audioLanguages = [...new Set(sets.map((s) => s.lang).filter(Boolean))];
  const wrongLangDub = Boolean(prefLang && best.lang && best.lang !== prefLang);
  return {
    audioLanguage: best.lang || '',
    audioIsDub: Boolean(best.isDub || wrongLangDub),
    audioLanguages
  };
}

export function extractDashSubtitleHints(xml, manifestUrl, headers = {}) {
  const dashSubs = [];
  const seenUrls = new Set();
  if (!xml || !manifestUrl) return dashSubs;
  const srcXml = String(xml);
  const headXml = srcXml.split(/<Period\b/i)[0] || '';
  const topBaseMatch = headXml.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
  const mpdBaseDir = topBaseMatch
    ? new URL(decodeXmlEntities(topBaseMatch[1].trim()), manifestUrl).toString()
    : manifestUrl;

  const pushSub = (rawUrl, baseDir, { langRaw, labelRaw, mimeHint, forced, sdh }) => {
    const cleanRaw = decodeXmlEntities(String(rawUrl || '').trim());
    if (!cleanRaw) return;
    const isTextMime = /\b(?:text\/vtt|ttml|subrip|x-ssa|x-ass)\b/i.test(String(mimeHint || ''));
    const looksLikeSubUrl = /\.(?:vtt|srt|ttml|dfxp|ass|ssa|xml)(?:\?|$)/i.test(cleanRaw)
      || /[?&](?:format|fmt|type)=(?:vtt|webvtt|srt|ttml|dfxp)\b/i.test(cleanRaw);
    if (!looksLikeSubUrl && !isTextMime) return;
    try {
      const absSubUrl = new URL(cleanRaw, baseDir).toString();
      if (seenUrls.has(absSubUrl)) return;
      seenUrls.add(absSubUrl);
      dashSubs.push(formatSubtitleHint({
        url: absSubUrl,
        headers,
        langRaw,
        labelRaw,
        mimeHint,
        forced,
        sdh,
        tier: 'same_route'
      }));
    } catch {}
  };

  const scanScope = (scopeXml, periodBaseDir) => {
    for (const asMatch of String(scopeXml).matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
      const asAttrs = asMatch[1] || '';
      const asInner = asMatch[2] || '';
      const asMime = asAttrs.match(/\bmimeType\s*=\s*["']([^"']+)["']/i)?.[1]
        || asInner.match(/\bmimeType\s*=\s*["']([^"']+)["']/i)?.[1]
        || '';
      const isTextSet = /\bcontentType\s*=\s*["']text["']/i.test(asAttrs)
        || /\b(?:text\/vtt|application\/ttml\+xml|application\/x-subrip)/i.test(`${asAttrs} ${asInner}`);
      if (!isTextSet) continue;

      const asLang = (asAttrs.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1] || '').trim();
      const asLabel = decodeXmlEntities(
        asAttrs.match(/\blabel\s*=\s*["']([^"']+)["']/i)?.[1]
        || asInner.match(/<Label[^>]*>([\s\S]*?)<\/Label>/i)?.[1]
        || ''
      ).trim();
      const roles = [...asInner.matchAll(/<Role[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi)].map((r) => r[1].toLowerCase());
      const asForced = roles.includes('forced-subtitle') || /\bforced\b/i.test(asLabel);
      const asSdh = roles.includes('caption') || roles.includes('subtitle') && /\b(?:sdh|cc|hearing)\b/i.test(asLabel);

      const repMatches = [...asInner.matchAll(/<Representation\b([^>]*)(?:\/>|>([\s\S]*?)<\/Representation>)/gi)];
      if (repMatches.length) {
        for (const rep of repMatches) {
          const rAttrs = rep[1] || '';
          const rInner = rep[2] || '';
          const rId = rAttrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || '';
          const rMime = rAttrs.match(/\bmimeType\s*=\s*["']([^"']+)["']/i)?.[1] || asMime;
          const rLang = (rAttrs.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1] || asLang || 'en').trim();
          const rLabel = decodeXmlEntities(rAttrs.match(/\blabel\s*=\s*["']([^"']+)["']/i)?.[1] || asLabel).trim();

          for (const bMatch of rInner.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/gi)) {
            pushSub(bMatch[1], periodBaseDir, {
              langRaw: rLang,
              labelRaw: rLabel,
              mimeHint: rMime,
              forced: asForced,
              sdh: asSdh
            });
          }

          const segTpl = rInner.match(/<SegmentTemplate\b([^>]*)>/i)?.[1]
            || asInner.match(/<SegmentTemplate\b([^>]*)>/i)?.[1]
            || '';
          const tplMedia = segTpl.match(/\bmedia\s*=\s*["']([^"']+)["']/i)?.[1] || '';
          if (tplMedia && !/\$(?:Number|Time)(?:%[^$]*)?\$/i.test(tplMedia)) {
            const subBaseM = rInner.match(/<BaseURL>([^<]+)<\/BaseURL>/i) || asInner.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
            const baseDir = subBaseM
              ? new URL(decodeXmlEntities(subBaseM[1].trim()), periodBaseDir).toString()
              : periodBaseDir;
            const resolvedTpl = rId ? tplMedia.replace(/\$RepresentationID\$/gi, rId) : tplMedia;
            pushSub(resolvedTpl, baseDir, {
              langRaw: rLang,
              labelRaw: rLabel,
              mimeHint: rMime,
              forced: asForced,
              sdh: asSdh
            });
          }

          for (const sUrlMatch of `${rInner}\n${asInner}`.matchAll(/<SegmentURL\b[^>]*\bmedia\s*=\s*["']([^"']+)["']/gi)) {
            pushSub(sUrlMatch[1], periodBaseDir, {
              langRaw: rLang,
              labelRaw: rLabel,
              mimeHint: rMime,
              forced: asForced,
              sdh: asSdh
            });
          }
        }
      }

      const asDirectBase = asInner.replace(/<Representation\b[\s\S]*?<\/Representation>/gi, '');
      for (const bMatch of asDirectBase.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/gi)) {
        pushSub(bMatch[1], periodBaseDir, {
          langRaw: asLang || 'en',
          labelRaw: asLabel,
          mimeHint: asMime,
          forced: asForced,
          sdh: asSdh
        });
      }
    }
  };

  const periods = [...srcXml.matchAll(/<Period\b[^>]*>([\s\S]*?)<\/Period>/gi)];
  if (periods.length) {
    for (const pMatch of periods) {
      const pInner = pMatch[1] || '';
      const beforeAs = pInner.split(/<AdaptationSet\b/i)[0] || '';
      const pBaseM = beforeAs.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
      const pBaseDir = pBaseM
        ? new URL(decodeXmlEntities(pBaseM[1].trim()), mpdBaseDir).toString()
        : mpdBaseDir;
      scanScope(pInner, pBaseDir);
    }
  } else {
    scanScope(srcXml, mpdBaseDir);
  }
  return dashSubs;
}

export class MovieStreamResolver {
  constructor({
    movieApi,
    subtitles = null,
    adultCatalog = null,
    fetchImpl = fetch,
    ffprobeRunner = null,
    thenkiri = undefined,
    socialAdapters = undefined,
    ytSearchFn = null,
    enableYtDlp = null,
    enableWebFallback = true,
    realDebridKey = process.env.REALDEBRID_API_KEY || '',
    allDebridKey = process.env.ALLDEBRID_API_KEY || '',
    premiumizeKey = process.env.PREMIUMIZE_API_KEY || '',
    log
  } = {}) {
    this.movieApi = movieApi;
    this.subtitles = subtitles;
    this.adultCatalog = adultCatalog;
    this.fetchImpl = fetchImpl;
    this.ffprobeRunner = ffprobeRunner;
    this.hasCustomThenkiri = thenkiri !== undefined;
    this.hasCustomSocialAdapters = socialAdapters !== undefined;
    this.thenkiri = thenkiri || { thenkiriSearch, thenkiriDetails, thenkiriGetLink };
    this.socialAdapters = socialAdapters || { catalogSearch, dramafrenDl, anydramaDl, justwatchDl, justwatchWatch };
    this.ytSearchFn = ytSearchFn;
    this.enableYtDlp = enableYtDlp !== null ? Boolean(enableYtDlp) : (Boolean(ytSearchFn) || fetchImpl === fetch);
    this.enableWebFallback = enableWebFallback;
    this.realDebridKey = String(realDebridKey || '').trim();
    this.allDebridKey = String(allDebridKey || '').trim();
    this.premiumizeKey = String(premiumizeKey || '').trim();
    this.hostCooldowns = new Map();
    this.log = log || logger().child({ module: 'movie-resolver' });
  }

  #computeVodMinDuration(minDuration = 0, { isTv = false } = {}) {
    const dur = Number(minDuration || 0);
    if (dur >= 1200) {
      return isTv
        ? Math.max(480, Math.round(dur * 0.56))
        : Math.max(2400, Math.round(dur * 0.78));
    }
    if (dur >= 600) {
      return isTv
        ? Math.max(360, Math.round(dur * 0.58))
        : Math.max(420, Math.round(dur * 0.75));
    }
    if (this.fetchImpl === fetch) {
      return isTv ? 900 : 3600;
    }
    return 0;
  }

  async #probeContainerFormatWithFfprobe(url, headers = {}, { preferredAudioLang = '' } = {}) {
    const canRunFfprobe = this.fetchImpl === fetch || typeof this.ffprobeRunner === 'function';
    if (!canRunFfprobe || !url || !/^https?:\/\//i.test(url)) return null;
    try {
      let parsed = null;
      if (typeof this.ffprobeRunner === 'function') {
        parsed = await this.ffprobeRunner(url, headers);
      } else {
        const hdrLines = Object.entries(headers || {})
          .filter(([, v]) => v != null && String(v).trim() !== '')
          .map(([k, v]) => `${k}: ${String(v).trim()}`)
          .join('\r\n');
        const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams'];
        if (hdrLines) args.push('-headers', `${hdrLines}\r\n`);
        args.push('-user_agent', UA, url);
        const { stdout } = await execFileAsync('ffprobe', args, { timeout: 5500, maxBuffer: 2 * 1024 * 1024 });
        parsed = JSON.parse(stdout || '{}');
      }
      if (!parsed || typeof parsed !== 'object') return null;
      const dur = Number(parsed?.format?.duration || 0);
      const prefLang = normalizeLangCode(preferredAudioLang);
      const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
      const audioScored = streams
        .filter((s) => s?.codec_type === 'audio')
        .map((s) => {
          const lang = normalizeLangCode(s?.tags?.language || s?.tags?.lang || '');
          const titleTag = [s?.tags?.title, s?.tags?.handler_name].filter(Boolean).join(' ');
          const disp = s?.disposition || {};
          const explicitDub = Boolean(disp.dub || isDubAudioLabel(titleTag));
          const wrongLang = Boolean(prefLang && lang && lang !== prefLang && !disp.original);
          const isDub = explicitDub || wrongLang;
          let score = 0;
          if (prefLang && lang) score += (lang === prefLang) ? 100 : -80;
          if (isDub) score -= 120;
          else {
            score += 30;
            if (disp.original || /\b(?:main|original|orig|raw|native)\b/i.test(titleTag)) score += 40;
          }
          if (disp.commentary || /\b(?:commentary|description|descriptive)\b/i.test(titleTag)) score -= 100;
          if (disp.default) score += 4;
          return { lang, isDub, score };
        })
        .sort((a, b) => b.score - a.score);
      const bestAudio = audioScored[0] || null;
      return {
        durationSeconds: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0,
        audioLanguage: bestAudio?.lang || '',
        audioIsDub: Boolean(bestAudio?.isDub),
        audioTrackCount: audioScored.length
      };
    } catch {
      return null;
    }
  }

  async #probeHttpStream(url, headers = {}, { minDuration = 0, maxDuration = 0, isTv = false, preferredAudioLang = '', skipFfprobe = false } = {}) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (/\.mpd(\?|$)|\/manifest\.mpd/i.test(url)) return null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Range: 'bytes=0-1023',
          ...headers
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!res?.ok && res?.status !== 206) return null;
      const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (ctype.includes('text/html') || ctype.includes('application/json') || ctype.includes('dash+xml')) return null;
      const cr = String(res.headers?.get?.('content-range') || '');
      const crMatch = cr.match(/\/(\d+)\s*$/);
      const totalBytes = crMatch ? Number(crMatch[1]) : (res.status === 200 ? Number(res.headers?.get?.('content-length') || 0) : 0);
      const isHls = ctype.includes('mpegurl') || /\.m3u8(\?|$)/i.test(url);
      let ffMeta = null;
      if (isHls) {
        const body = await res.text?.().catch(() => '');
        if (!body || !body.includes('#EXTM3U')) return null;
      } else {
        const effectiveFloor = this.#computeVodMinDuration(minDuration, { isTv });
        const maxMult = isTv ? 1.45 : 1.30;
        const effectiveCeiling = maxDuration || (Number(minDuration) >= 1200 ? Math.round(Number(minDuration) * maxMult) : 0);
        const minSizeBytes = effectiveFloor >= 1800 ? 15 * 1024 * 1024 : (effectiveFloor > 0 ? 5 * 1024 * 1024 : 0);
        if (minSizeBytes > 0 && Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes < minSizeBytes) {
          return null;
        }
        const ranProbeCheck = !skipFfprobe && (effectiveFloor > 0 || preferredAudioLang || typeof this.ffprobeRunner === 'function');
        if (ranProbeCheck) {
          ffMeta = await this.#probeContainerFormatWithFfprobe(url, headers, { preferredAudioLang });
          if (ffMeta?.durationSeconds > 0) {
            if (effectiveFloor > 0 && ffMeta.durationSeconds < effectiveFloor) return null;
            if (effectiveCeiling > 0 && ffMeta.durationSeconds > effectiveCeiling) return null;
          } else if (effectiveFloor > 0 && (typeof this.ffprobeRunner === 'function' || this.fetchImpl === fetch)) {
            const largeEnoughBytes = effectiveFloor >= 1800 ? 180 * 1024 * 1024 : 60 * 1024 * 1024;
            if (typeof this.ffprobeRunner === 'function' && ffMeta === null) return null;
            if (!(Number.isFinite(totalBytes) && totalBytes >= largeEnoughBytes)) return null;
          }
        }
      }
      return {
        url,
        headers,
        isHls,
        sizeBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
        durationSeconds: ffMeta?.durationSeconds || null,
        audioLanguage: ffMeta?.audioLanguage || '',
        audioIsDub: Boolean(ffMeta?.audioIsDub),
        contentType: ctype || (isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4')
      };
    } catch {
      return null;
    }
  }

  async #probeHlsPlaylistAndSegment(playlistUrl, headers = {}, depth = 0, { minDuration = 0, preferredHeight = null, preferredAudioLang = '', isTv = false } = {}) {
    if (!playlistUrl || !/^https?:\/\//i.test(playlistUrl) || depth > 2) return null;
    const prefLang = normalizeLangCode(preferredAudioLang);
    try {
      const res = await this.fetchImpl(playlistUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          ...headers
        },
        signal: AbortSignal.timeout(7000)
      });
      if (!res?.ok || typeof res.text !== 'function') return null;
      const text = await res.text();
      if (!text || !text.includes('#EXTM3U')) return null;

      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const isMaster = lines.some((l) => /^#EXT-X-STREAM-INF:/i.test(l));
      if (isMaster) {
        const masterUrl = res.url || playlistUrl;
        const audioTracks = [];
        for (const line of lines) {
          if (!/^#EXT-X-MEDIA:/i.test(line) || !/\bTYPE=AUDIO\b/i.test(line)) continue;
          const groupId = line.match(/\bGROUP-ID="([^"]+)"/i)?.[1] || '';
          const langRaw = line.match(/\bLANGUAGE="([^"]+)"/i)?.[1] || '';
          const name = line.match(/\bNAME="([^"]+)"/i)?.[1] || '';
          const isDefault = /\bDEFAULT=YES\b/i.test(line);
          const isAuto = /\bAUTOSELECT=YES\b/i.test(line);
          const lang = normalizeLangCode(langRaw) || normalizeLangCode(name);
          const isDub = isDubAudioLabel(name) || isDubAudioLabel(groupId) || isDubbedCandidateText(`${name} ${groupId}`, { preferredAudioLang: prefLang });
          let score = 0;
          if (prefLang && lang) score += (lang === prefLang) ? 100 : -80;
          if (isDub) score -= 120;
          else {
            score += 30;
            if (/\b(?:main|original|orig|raw|native)\b/i.test(name)) score += 40;
          }
          if (/\b(?:commentary|description|descriptive)\b/i.test(name)) score -= 100;
          if (isDefault) score += 4;
          if (isAuto) score += 2;
          audioTracks.push({ groupId, lang, name, isDub, score });
        }
        const hasMediaAudio = audioTracks.length > 0;
        const groupBestAudioScore = new Map();
        for (const a of audioTracks) {
          const prev = groupBestAudioScore.get(a.groupId);
          if (prev === undefined || a.score > prev) groupBestAudioScore.set(a.groupId, a.score);
        }

        const masterSubs = [];
        for (const line of lines) {
          if (!/^#EXT-X-MEDIA:/i.test(line) || !/\bTYPE=SUBTITLES\b/i.test(line)) continue;
          const uriM = line.match(/\bURI="([^"]+)"/i);
          if (!uriM) continue;
          const nameM = line.match(/\bNAME="([^"]+)"/i);
          const langM = line.match(/\bLANGUAGE="([^"]+)"/i);
          const forced = /\bFORCED=YES\b/i.test(line);
          const sdh = /transcribes-spoken-dialog/i.test(line) || /\b(?:sdh|cc)\b/i.test(nameM?.[1] || '');
          masterSubs.push(formatSubtitleHint({
            url: new URL(uriM[1], masterUrl).toString(),
            headers,
            langRaw: langM?.[1] || nameM?.[1] || 'en',
            labelRaw: nameM?.[1] || langM?.[1] || '',
            forced,
            sdh,
            tier: 'same_route'
          }));
        }
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
          if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
          const nextUri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
          if (!nextUri) continue;
          const resMatch = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
          const avgBwMatch = lines[i].match(/AVERAGE-BANDWIDTH=(\d+)/i);
          const bwMatch = lines[i].match(/\bBANDWIDTH=(\d+)/i);
          const audioGroup = lines[i].match(/\bAUDIO="([^"]+)"/i)?.[1] || '';
          const height = resMatch ? Number(resMatch[1]) : 720;
          const bwBps = Number(avgBwMatch?.[1] || bwMatch?.[1] || 0);
          variants.push({
            uri: new URL(nextUri, masterUrl).toString(),
            height,
            bandwidthKbps: bwBps > 0 ? Math.round(bwBps / 1000) : null,
            audioGroup,
            audioScore: audioGroup && groupBestAudioScore.has(audioGroup) ? groupBestAudioScore.get(audioGroup) : 0
          });
        }
        const targetH = Number(preferredHeight || 0);
        const maxAudScore = audioTracks.length
          ? variants.reduce((mx, v) => Math.max(mx, v.audioScore), -Infinity)
          : 0;
        variants.sort((a, b) => {
          if (audioTracks.length) {
            const tierA = a.audioScore >= maxAudScore - 30 ? 1 : 0;
            const tierB = b.audioScore >= maxAudScore - 30 ? 1 : 0;
            if (tierA !== tierB) return tierB - tierA;
          }
          if (targetH > 0) {
            const fitA = a.height <= targetH ? 1000 + a.height : (500 - a.height);
            const fitB = b.height <= targetH ? 1000 + b.height : (500 - b.height);
            if (fitB !== fitA) return fitB - fitA;
          }
          const scoreH = (h) => (h === 1080 ? 35 : h === 720 ? 30 : h <= 1080 ? 20 : 10);
          return scoreH(b.height) - scoreH(a.height);
        });
        for (const v of variants.slice(0, 2)) {
          const nested = await this.#probeHlsPlaylistAndSegment(v.uri, headers, depth + 1, { minDuration, preferredHeight, preferredAudioLang, isTv });
          if (nested) {
            const estDur = nested.durationSeconds || minDuration || 0;
            const estSizeBytes = (v.bandwidthKbps && estDur > 0) ? Math.round((v.bandwidthKbps * 1000 / 8) * estDur) : null;
            const matchingAudio = v.audioGroup
              ? audioTracks.filter((a) => !a.groupId || a.groupId === v.audioGroup)
              : audioTracks;
            const audioPool = matchingAudio.length ? matchingAudio : audioTracks;
            const winningAudio = audioPool.length
              ? audioPool.reduce((best, cur) => (cur.score > best.score ? cur : best), audioPool[0])
              : null;
            const wrongLangDub = Boolean(prefLang && winningAudio?.lang && winningAudio.lang !== prefLang);
            const resolvedLang = winningAudio?.lang || nested.audioLanguage || '';
            const resolvedIsDub = Boolean(
              winningAudio?.isDub
              || wrongLangDub
              || (!winningAudio?.lang && nested.audioIsDub)
              || (prefLang && !winningAudio?.lang && nested.audioLanguage && nested.audioLanguage !== prefLang)
            );
            return {
              ...nested,
              url: (hasMediaAudio && !targetH) || (masterSubs.length && !targetH) ? masterUrl : (hasMediaAudio ? masterUrl : nested.url),
              subtitleHints: [...(masterSubs || []), ...(nested.subtitleHints || [])],
              qualityLabel: v.height ? `${v.height}p` : nested.qualityLabel,
              sizeBytes: estSizeBytes || nested.sizeBytes || null,
              variants: variants.map(({ uri, height, bandwidthKbps }) => ({ url: uri, height, bandwidthKbps })),
              audioLanguage: resolvedLang,
              audioIsDub: resolvedIsDub,
              audioLanguages: [...new Set([
                ...audioTracks.map((a) => a.lang),
                nested.audioLanguage || ''
              ].filter(Boolean))]
            };
          }
        }
        return null;
      }

      const hasEndlist = lines.some((l) => /^#EXT-X-ENDLIST\b/i.test(l));
      const segLines = lines.filter((l) => !l.startsWith('#'));
      let totalVodSec = 0;
      for (const l of lines) {
        const m = l.match(/^#EXTINF:([0-9.]+)/i);
        if (m) totalVodSec += Number(m[1]) || 0;
      }
      const effectiveFloor = this.#computeVodMinDuration(minDuration, { isTv });
      if (hasEndlist && effectiveFloor > 0 && totalVodSec > 0 && totalVodSec < effectiveFloor) {
        return null;
      }
      // Reject unclosed short preview stubs (e.g. 2-3 segments <= 45s without EXT-X-ENDLIST)
      if (!hasEndlist && segLines.length <= 3 && totalVodSec > 0 && totalVodSec <= 45) {
        return null;
      }
      const maxHlsMult = isTv ? 1.45 : 1.30;
      if (minDuration >= 1200 && totalVodSec > Math.round(minDuration * maxHlsMult)) {
        return null;
      }

      const firstSegLine = segLines[0];
      if (!firstSegLine) return null;
      const firstSegUrl = new URL(firstSegLine, res.url || playlistUrl).toString();
      const segRes = await this.fetchImpl(firstSegUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Range: 'bytes=0-511',
          ...headers
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!segRes?.ok && segRes?.status !== 206) return null;
      const segType = String(segRes.headers?.get?.('content-type') || '').toLowerCase();
      if (segType.includes('text/html') || segType.includes('application/json')) return null;

      let segAudioLang = '';
      let segAudioIsDub = false;
      if (prefLang && (this.fetchImpl === fetch || typeof this.ffprobeRunner === 'function')) {
        const segMeta = await this.#probeContainerFormatWithFfprobe(firstSegUrl, headers, { preferredAudioLang }).catch(() => null);
        if (segMeta) {
          segAudioLang = segMeta.audioLanguage || '';
          segAudioIsDub = Boolean(segMeta.audioIsDub);
        }
      }

      return {
        url: res.url || playlistUrl,
        headers,
        isHls: true,
        isDash: false,
        format: 'hls',
        contentType: 'application/vnd.apple.mpegurl',
        qualityLabel: extractQualityLabel(playlistUrl),
        durationSeconds: totalVodSec > 0 ? Math.round(totalVodSec) : null,
        audioLanguage: segAudioLang,
        audioIsDub: segAudioIsDub
      };
    } catch {
      return null;
    }
  }

  async #probeDashManifest(mpdUrl, headers = {}, { minDuration = 0, durationSeconds = null, expectedEpisodeTitle = null, preferredAudioLang = '', isTv = false } = {}) {
    if (!mpdUrl || !/^https?:\/\//i.test(mpdUrl)) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await this.fetchImpl(mpdUrl, {
          method: 'GET',
          headers: {
            'User-Agent': UA,
            ...headers
          },
          signal: AbortSignal.timeout(9000)
        });
        if (!res?.ok || typeof res.text !== 'function') {
          if ((res?.status === 429 || res?.status >= 500) && attempt === 0) {
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          return null;
        }
        const xml = await res.text();
        if (!xml || !/<MPD\b/i.test(xml) || !/<AdaptationSet\b/i.test(xml)) return null;

      if (expectedEpisodeTitle) {
        const progTitleMatch = xml.match(/<ProgramInformation\b[^>]*>[\s\S]*?<Title>([^<]+)<\/Title>/i);
        const progTitle = progTitleMatch
          ? progTitleMatch[1]
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;|&apos;/g, "'")
              .trim()
          : '';
        if (!progTitle || scoreTitleMatch(expectedEpisodeTitle, null, progTitle, { isTv: false }) < 14) {
          return null;
        }
      }

      const durMatch = xml.match(/\bmediaPresentationDuration="([^"]+)"/i);
      const mpdSeconds = durMatch ? parseIso8601Duration(durMatch[1]) : 0;
      const effectiveFloor = this.#computeVodMinDuration(minDuration, { isTv });
      if (effectiveFloor > 0 && mpdSeconds > 0 && mpdSeconds < effectiveFloor) {
        return null;
      }
      const maxDashMult = isTv ? 1.45 : 1.30;
      if (minDuration >= 1200 && mpdSeconds > Math.round(minDuration * maxDashMult)) {
        return null;
      }

      const baseMatch = xml.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
      const repMatch = xml.match(/<Representation\b[^>]*\bid="([^"]+)"/i);
      const initMatch = xml.match(/<SegmentTemplate\b[^>]*\binitialization="([^"]+)"/i);
      if (baseMatch && initMatch && repMatch) {
        try {
          const decodedBase = baseMatch[1].trim().replace(/&amp;/g, '&');
          const absBase = new URL(decodedBase, res.url || mpdUrl).toString();
          const initName = initMatch[1].replace(/\$RepresentationID\$/g, repMatch[1]);
          const initUrl = new URL(initName, absBase).toString();
          const initRes = await this.fetchImpl(initUrl, {
            method: 'GET',
            headers: {
              'User-Agent': UA,
              Range: 'bytes=0-511',
              ...headers
            },
            signal: AbortSignal.timeout(6000)
          });
          if (!initRes?.ok && initRes?.status !== 206) return null;
          const initType = String(initRes.headers?.get?.('content-type') || '').toLowerCase();
          if (initType.includes('text/html') || initType.includes('application/json')) return null;
        } catch {
          return null;
        }
      }

      const heights = [...xml.matchAll(/(?:\bheight|\bmaxHeight)="(\d+)"/gi)].map((m) => Number(m[1])).filter(Boolean);
      const maxH = heights.length ? Math.max(...heights) : 0;
      const qualityLabel = maxH >= 2160 ? '4K' : maxH ? `${maxH}p` : extractQualityLabel(mpdUrl);

      const manifestUrl = res.url || mpdUrl;
      const dashSubs = extractDashSubtitleHints(xml, manifestUrl, headers);
      const dashAudio = inspectDashAudioTracks(xml, preferredAudioLang);

        return {
          url: manifestUrl,
          headers,
          isHls: false,
          isDash: true,
          format: 'dash',
          contentType: 'application/dash+xml',
          durationSeconds: mpdSeconds || durationSeconds || null,
          qualityLabel,
          subtitleHints: dashSubs,
          audioLanguage: dashAudio.audioLanguage,
          audioIsDub: dashAudio.audioIsDub,
          audioLanguages: dashAudio.audioLanguages
        };
      } catch {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  #routePayloadMatchesTarget(data, { tmdbId, imdbId = null, title = '', originalTitle = '', year = null, isTv = false, season = null, episode = null, episodeTitle = null }) {
    if (!data || typeof data !== 'object') return false;
    const meta = (data.meta && typeof data.meta === 'object') ? data.meta : {};
    const isEpisodeObj = isTv && (
      String(data.type || meta.type || '').toLowerCase() === 'episode'
      || meta.episode_number != null
      || meta.episodeNumber != null
      || meta.season_number != null
      || meta.seasonNumber != null
      || data.season != null
      || data.episode != null
      || (meta.air_date != null && meta.first_air_date == null && meta.release_date == null)
    );
    const respTmdb = isEpisodeObj
      ? (data.tmdbId ?? data.tmdb_id ?? data.seriesId ?? data.showId ?? meta.tmdbId ?? meta.tmdb_id ?? meta.show_id)
      : (data.tmdbId ?? data.tmdb_id ?? data.id ?? data.mediaId ?? meta.tmdbId ?? meta.tmdb_id ?? meta.id);
    if (respTmdb != null && /^\d+$/.test(String(respTmdb)) && /^\d+$/.test(String(tmdbId)) && String(respTmdb) !== String(tmdbId)) {
      return false;
    }
    const respImdb = data.imdbId ?? data.imdb_id ?? meta.imdbId ?? meta.imdb_id;
    if (imdbId && respImdb && String(respImdb).replace(/^tt/i, '') !== String(imdbId).replace(/^tt/i, '')) {
      return false;
    }
    if (isTv && episode != null) {
      const respS = data.season ?? data.seasonNumber ?? meta.season ?? meta.seasonNumber ?? meta.season_number;
      const respE = data.episode ?? data.episodeNumber ?? meta.episode ?? meta.episodeNumber ?? meta.episode_number;
      if (respS != null && season != null && Number(respS) !== Number(season)) return false;
      if (respE != null && Number(respE) !== Number(episode)) return false;
    }
    const respRelease = data.releaseDate ?? data.release_date ?? meta.release_date ?? meta.releaseDate ?? meta.first_air_date ?? meta.air_date;
    const respYearMatch = respRelease ? String(respRelease).match(/\b(19\d\d|20\d\d)\b/) : null;
    if (year && respYearMatch) {
      const ry = Number(respYearMatch[1]);
      if (isEpisodeObj) {
        if (ry < Number(year) - 1) return false;
      } else if (Math.abs(ry - Number(year)) > 1) {
        return false;
      }
    }
    const respTitle = data.title || data.name || data.movieTitle || meta.title || meta.name || meta.original_title || meta.original_name;
    const isGenericEpTitle = Boolean(respTitle && /^episode\s*\d+$/i.test(String(respTitle).trim()));
    const hasEmptyMetaObj = Boolean(
      data.meta && typeof data.meta === 'object' && Object.keys(data.meta).length === 0
      && respTmdb == null && !respImdb && !respTitle && !respRelease
    );
    if (hasEmptyMetaObj) {
      return false;
    }
    if (isTv && isGenericEpTitle && respTmdb == null && !respImdb) {
      return false;
    }
    if (title && respTitle && !isEpisodeObj) {
      const mainScore = scoreTitleMatch(title, year, String(respTitle), { isTv, season });
      const origScore = originalTitle ? scoreTitleMatch(originalTitle, year, String(respTitle), { isTv, season }) : -100;
      if (Math.max(mainScore, origScore) < 14) {
        return false;
      }
    } else if (isEpisodeObj && episodeTitle && respTitle && !isGenericEpTitle) {
      if (scoreTitleMatch(episodeTitle, null, String(respTitle), { isTv: false }) < 14) {
        return false;
      }
    }
    return true;
  }

  async #fetchRouteJson(routeName, endpoint, reqHeaders, { timeoutMs = 6000 } = {}) {
    let host = '';
    try { host = new URL(endpoint).host; } catch {}
    const cooldownUntil = host ? (this.hostCooldowns?.get(host) || 0) : 0;
    const now = Date.now();
    if (cooldownUntil > now) {
      const waitMs = Math.min(1800, cooldownUntil - now);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    const res = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers: reqHeaders,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res?.status === 429) {
      const ra = Number(res.headers?.get?.('retry-after') || 0);
      const backoffMs = Math.min(6000, Math.max(900, ra > 0 ? ra * 1000 : 1800));
      if (host) this.hostCooldowns?.set(host, Date.now() + backoffMs);
      return { _rateLimited: true, _host: host, _route: routeName, _endpoint: endpoint };
    }
    if (!res?.ok || typeof res.json !== 'function') return null;
    const json = await res.json();
    if (json && typeof json === 'object') json._route = routeName;
    return json;
  }

  async #fetchVidboltCandidates({ isTv = false, tmdbId, season = null, episode = null } = {}) {
    if (!tmdbId || !/^\d+$/.test(String(tmdbId))) return [];
    const base = isTv
      ? `https://vidbolt.xyz/api/resolve?id=${encodeURIComponent(tmdbId)}&type=tv&season=${Number(season || 1)}&episode=${Number(episode || 1)}`
      : `https://vidbolt.xyz/api/resolve?id=${encodeURIComponent(tmdbId)}&type=movie`;
    const urls = [base, `${base}&only=vega`];
    const seen = new Set();
    const payloads = [];
    for (const ep of urls) {
      try {
        const res = await this.fetchImpl(ep, { headers: VIDBOLT_HEADERS, signal: AbortSignal.timeout(7000) });
        if (!res?.ok || typeof res.json !== 'function') continue;
        const data = await res.json();
        const rawSources = [
          ...(Array.isArray(data?.stream?.sources) ? data.stream.sources : []),
          ...(Array.isArray(data?.sources) ? data.sources : []),
          ...(Array.isArray(data?.streams) ? data.streams : [])
        ];
        if (!rawSources.length && data?.stream?.url) rawSources.push(data.stream);
        const normalizedSources = [];
        for (const s of rawSources) {
          if (!s?.url || !/^https?:\/\//i.test(s.url) || seen.has(s.url)) continue;
          seen.add(s.url);
          const masterSubs = [];
          if (typeof s.master === 'string' && s.master.includes('#EXTM3U')) {
            const masterLines = s.master.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const line of masterLines) {
              if (!/^#EXT-X-MEDIA:/i.test(line) || !/\bTYPE=SUBTITLES\b/i.test(line)) continue;
              const uriM = line.match(/\bURI="([^"]+)"/i);
              if (!uriM) continue;
              const nameM = line.match(/\bNAME="([^"]+)"/i);
              const langM = line.match(/\bLANGUAGE="([^"]+)"/i);
              masterSubs.push(formatSubtitleHint({
                url: new URL(uriM[1], s.url).toString(),
                headers: VIDBOLT_HEADERS,
                langRaw: langM?.[1] || nameM?.[1] || 'en',
                labelRaw: nameM?.[1] || langM?.[1] || '',
                forced: /\bFORCED=YES\b/i.test(line),
                sdh: /transcribes-spoken-dialog/i.test(line) || /\b(?:sdh|cc)\b/i.test(nameM?.[1] || ''),
                tier: 'same_route'
              }));
            }
          }
          normalizedSources.push({
            url: s.url,
            type: s.kind || s.type || (/\.m3u8/i.test(s.url) ? 'hls' : ''),
            quality: s.quality || '',
            source: 'vidbolt',
            headers: { ...VIDBOLT_HEADERS },
            subtitles: masterSubs
          });
        }
        if (normalizedSources.length) {
          payloads.push({
            tmdbId: String(tmdbId),
            _route: 'vidbolt',
            _headers: { ...VIDBOLT_HEADERS },
            sources: normalizedSources
          });
        }
      } catch {}
    }
    return payloads;
  }

  async #resolveFromTorrentioDebrid({ imdbId = null, isTv = false, season = null, episode = null, title = '', durationSeconds = null, preferredAudioLang = '', excludeSet = new Set() } = {}) {
    const debridProviders = [
      this.realDebridKey ? ['realdebrid', this.realDebridKey] : null,
      this.allDebridKey ? ['alldebrid', this.allDebridKey] : null,
      this.premiumizeKey ? ['premiumize', this.premiumizeKey] : null
    ].filter(Boolean);
    if (!debridProviders.length) return null;
    const imdbDigits = String(imdbId || '').trim().match(/^(?:tt)?(\d+)$/i)?.[1] || '';
    if (!imdbDigits) return null;
    const normImdb = `tt${imdbDigits}`;
    const prefLang = normalizeLangCode(preferredAudioLang);
    const minDuration = durationSeconds ? Number(durationSeconds) : 0;

    for (const [providerName, token] of debridProviders) {
      try {
        const ep = `https://torrentio.strem.fun/${providerName}=${encodeURIComponent(token)}/stream/${isTv ? 'series' : 'movie'}/${normImdb}${isTv ? `:${Number(season || 1)}:${Number(episode || 1)}` : ''}.json`;
        const res = await this.fetchImpl(ep, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (!res?.ok || typeof res.json !== 'function') continue;
        const data = await res.json();
        const streams = Array.isArray(data?.streams) ? data.streams : [];
        const ranked = streams
          .filter((s) => s?.url && /^https?:\/\//i.test(s.url) && !excludeSet.has(s.url) && !AD_OR_BAD_DOMAIN_RE.test(s.url))
          .map((s) => {
            const label = `${s.name || ''} ${s.title || ''}`.trim();
            if (isTrailerLike(label, title) || isNonFeatureOrClipTitle(label, title) || (!isTv && isSplitPartTitle(label, title))) {
              return null;
            }
            const isDub = isDubbedCandidateText(label, { preferredAudioLang: prefLang, targetTitle: title });
            const qLabel = extractQualityLabel(label);
            let score = isDub ? -100 : 50;
            if (qLabel === '1080p') score += 15;
            else if (qLabel === '720p') score += 12;
            else if (qLabel === '4K') score += 8;
            return { s, label, isDub, qLabel, score };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        for (const cand of ranked.slice(0, 3)) {
          const probed = await this.#probeHttpStream(cand.s.url, {}, { minDuration, isTv, preferredAudioLang: prefLang });
          if (!probed || excludeSet.has(probed.url)) continue;
          return {
            url: probed.url,
            headers: probed.headers || {},
            format: /\.mkv(\?|$)/i.test(probed.url) ? 'mkv' : (probed.isHls ? 'hls' : 'mp4'),
            isHls: Boolean(probed.isHls),
            isDash: false,
            durationSeconds: probed.durationSeconds || durationSeconds || null,
            sizeBytes: probed.sizeBytes || null,
            qualityLabel: cand.qLabel || 'HD',
            audioLanguage: probed.audioLanguage || prefLang || '',
            audioIsDub: Boolean(probed.audioIsDub || cand.isDub),
            source: 'torrentio_debrid'
          };
        }
      } catch {}
    }
    return null;
  }

  async #resolveFromTmdbStreamNetwork({
    type = 'movie',
    id,
    tmdbId: explicitTmdbId = null,
    imdbId = null,
    title = '',
    originalTitle = '',
    year = null,
    season = null,
    episode = null,
    episodeTitle = null,
    durationSeconds = null,
    preferredHeight = null,
    preferredAudioLang = '',
    excludeUrls = []
  } = {}) {
    const excludeSet = new Set(Array.isArray(excludeUrls) ? excludeUrls.filter(Boolean) : []);
    const rawId = String(explicitTmdbId || id || '').trim();
    const cleanImdb = /^tt\d+$/i.test(String(imdbId || '').trim())
      ? String(imdbId).trim()
      : (/^tt\d+$/i.test(String(id || '').trim()) ? String(id).trim() : null);
    let tmdbId = /^\d+$/.test(rawId) ? rawId : (cleanImdb || '');
    if (!tmdbId) return { stream: null, subtitleHints: [], fallbackStreams: [] };
    let isNumericTmdb = /^\d+$/.test(tmdbId);
    const isTv = String(type).toLowerCase() === 'tv';
    const minDuration = durationSeconds ? Number(durationSeconds) : 0;
    const prefLang = normalizeLangCode(preferredAudioLang);
    const makeBaseQuery = (targetId) => (
      isTv
        ? `/tv?id=${encodeURIComponent(targetId)}&season=${season == null ? 1 : Number(season)}&episode=${Number(episode || 1)}&mode=json`
        : `/movie?id=${encodeURIComponent(targetId)}&mode=json`
    );
    const baseQuery = makeBaseQuery(tmdbId);

    const reqHeaders = { ...CINEMA_PLAYER_HEADERS, 'User-Agent': UA };
    const seenStreamUrls = new Set();
    const probedStreamUrls = new Set();
    const siblingSubUrls = new Set();
    const siblingSubtitleHints = [];

    const normalizeSubList = (rawSubs, hdrs = CINEMA_PLAYER_HEADERS) => {
      const list = this.#normalizeSubList(rawSubs, { headers: hdrs });
      for (const item of list) {
        if (!siblingSubUrls.has(item.url)) {
          siblingSubUrls.add(item.url);
          siblingSubtitleHints.push(item);
        }
      }
      return list;
    };

    const detectCandidateAudioMeta = ({ srcObj = null, data = null, itemObj = null, decodedUrl = '', qualityHint = '', routeName = '' }) => {
      const rawLang = itemObj?.lang || itemObj?.language || itemObj?.audioLang
        || srcObj?.audioLang || srcObj?.audio_language || srcObj?.lang || srcObj?.language
        || data?.audioLanguage || data?.audio_language || '';
      const candAudioLang = normalizeLangCode(rawLang);
      const labelParts = [
        itemObj?.label,
        itemObj?.name,
        itemObj?.title,
        srcObj?.label,
        srcObj?.name,
        srcObj?.title,
        typeof srcObj?.audio === 'string' ? srcObj.audio : '',
        qualityHint,
        data?.label,
        routeName
      ].filter(Boolean).join(' ');
      const urlHasDub = /(?:^|[/?&._-])(?:eng(?:lish)?[-_ ]?dub|dubbed|dub|fandub|dublado|vff|vfq|latino|castellano)(?:$|[/?&._=-])/i.test(decodedUrl)
        || isDubbedCandidateText(decodedUrl, { preferredAudioLang: prefLang, targetTitle: title });
      const explicitDub = Boolean(
        srcObj?.dub || srcObj?.isDub || itemObj?.dub || itemObj?.isDub
        || isDubAudioLabel(labelParts)
        || isDubbedCandidateText(labelParts, { preferredAudioLang: prefLang, targetTitle: title })
        || urlHasDub
      );
      const langMismatch = Boolean(prefLang && candAudioLang && candAudioLang !== prefLang);
      const isOrigMatch = Boolean(
        srcObj?.isOriginal === true
        || itemObj?.original === true
        || (prefLang && candAudioLang === prefLang && !explicitDub)
      );
      return {
        audioLanguage: candAudioLang,
        explicitDub,
        isLikelyDub: explicitDub || langMismatch,
        isOrigMatch
      };
    };

    const collectCandidates = (payloads) => {
      const batch = [];
      const addCandidate = (rawUrl, { typeHint = '', qualityHint = '', routeSubs = [], routeName = '', durationHint = null, hasRouteMetaProof = false, srcObj = null, data = null, itemObj = null, candHeaders = null } = {}) => {
        const url = String(rawUrl || '').trim();
        if (!url || !/^https?:\/\//i.test(url) || seenStreamUrls.has(url) || excludeSet.has(url)) return;
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch {}
        if (AD_OR_BAD_DOMAIN_RE.test(url) || isTrailerLike(decoded, title) || isNonFeatureOrClipTitle(decoded, title)) return;

        // Verify embedded Zendaya slug/episode metadata when present to avoid title collisions
        let hasSlugProof = false;
        let requireEpisodeTitle = null;
        const cleanEpTitle = episodeTitle && !/^episode\s*\d+$/i.test(String(episodeTitle).trim())
          ? String(episodeTitle).trim()
          : null;
        try {
          const tParam = new URL(url).searchParams.get('t');
          if (tParam && /^[A-Za-z0-9+/_=-]+$/.test(tParam)) {
            const decodedToken = JSON.parse(Buffer.from(tParam, 'base64').toString('utf8'));
            const metaR = decodedToken?.r;
            if (metaR && typeof metaR === 'object') {
              const slugEpMatches = isTv && episode != null && Number(metaR.se || 0) > 0
                ? (Number(metaR.se) === Number(season || 1) && Number(metaR.ep || 0) === Number(episode))
                : false;
              if (isTv && episode != null && Number(metaR.se || 0) > 0) {
                if (!slugEpMatches) return;
                hasSlugProof = true;
              }
              if (title && metaR.slug) {
                const slugWords = String(metaR.slug).replace(/-[A-Za-z0-9]{6,14}$/, '').replace(/-/g, ' ');
                const titleMatched = scoreTitleMatch(title, year, slugWords, { isTv }) >= 14;
                const origTitleMatched = Boolean(originalTitle && scoreTitleMatch(originalTitle, year, slugWords, { isTv }) >= 14);
                if (titleMatched || origTitleMatched) {
                  hasSlugProof = true;
                } else {
                  const isMpdCandidate = String(typeHint).toLowerCase() === 'dash'
                    || /\.mpd(\?|$)|\/manifest\.mpd/i.test(url)
                    || /\.mpd(\?|$)|\/manifest\.mpd/i.test(decoded);
                  const targetSeq = extractSequelNumbers(title, { ignoreYear: year });
                  const slugSeq = extractSequelNumbers(slugWords, { ignoreYear: year });
                  const hasConflictingSequel = !isTv && (
                    [...targetSeq].some((n) => !slugSeq.has(n))
                    || (targetSeq.size === 0 && [...slugSeq].some((n) => Number(n) >= 2 && Number(n) <= 9))
                  );
                  const slugYearM = slugWords.match(/\b(19\d\d|20[0-3]\d)\b/);
                  const hasConflictingYear = Boolean(year && slugYearM && Math.abs(Number(slugYearM[1]) - Number(year)) > 1);
                  if (hasConflictingSequel || hasConflictingYear) {
                    return;
                  }
                  const targetTokens = significantTokens(title).filter((w) => w.length >= 4);
                  const origTokenList = originalTitle ? significantTokens(originalTitle).filter((w) => w.length >= 4) : [];
                  const titleTokens = new Set(targetTokens);
                  const origTokens = new Set(origTokenList);
                  const slugTokenList = [...new Set(significantTokens(slugWords).filter((w) => w.length >= 4))];
                  const overlapCount = slugTokenList.filter((w) => titleTokens.has(w) || origTokens.has(w)).length;
                  const requiredOverlap = (targetTokens.length >= 2 || origTokenList.length >= 2) ? 2 : 1;
                  const sharesDistinctiveWord = overlapCount >= requiredOverlap && overlapCount > 0;
                  const origIsNonLatin = Boolean(originalTitle && /[^\u0000-\u024F]/.test(String(originalTitle)));
                  if (hasRouteMetaProof && (sharesDistinctiveWord || origIsNonLatin || (isTv && (cleanEpTitle || slugEpMatches)))) {
                    hasSlugProof = false;
                  } else if (slugEpMatches && cleanEpTitle && isMpdCandidate) {
                    hasSlugProof = false;
                    requireEpisodeTitle = cleanEpTitle;
                  } else {
                    return;
                  }
                }
              }
            }
          }
        } catch {}

        if (/internal\.sadie\./i.test(url) && !hasRouteMetaProof && !hasSlugProof) {
          return;
        }
        seenStreamUrls.add(url);
        const isDash = String(typeHint).toLowerCase() === 'dash'
          || /\.mpd(\?|$)|\/manifest\.mpd/i.test(url)
          || /\.mpd(\?|$)|\/manifest\.mpd/i.test(decoded);
        const isHls = !isDash && (String(typeHint).toLowerCase() === 'hls'
          || /\.m3u8(\?|$)/i.test(url)
          || /\.m3u8(\?|$)/i.test(decoded));
        const isSadie = routeName === 'sadie' || /internal\.sadie\./i.test(url);
        const isPunkflix = routeName === 'punkflix' || /punkflix\.net/i.test(url);
        const isVidbolt = routeName === 'vidbolt' || /vidbolt/i.test(url);
        const qLabel = extractQualityLabel(`${qualityHint} ${decoded}`);
        const audioMeta = detectCandidateAudioMeta({ srcObj, data, itemObj, decodedUrl: decoded, qualityHint, routeName });

        let rank = isSadie
          ? (isHls ? 10 : 12)
          : isPunkflix
            ? (isHls ? 52 : 55)
            : isVidbolt
              ? (isHls ? 46 : 50)
              : isDash
                ? 32
                : (isHls ? 38 : 48);
        if (hasSlugProof) rank += 14;
        else if (hasRouteMetaProof) rank += 12;
        else if (requireEpisodeTitle) rank -= 4;
        if (audioMeta.isOrigMatch) rank += 60;
        if (audioMeta.isLikelyDub) rank -= 120;
        const qHeight = Number(String(qLabel || '').match(/(\d{3,4})p/i)?.[1] || 0);
        if (preferredHeight && qHeight > 0) {
          rank += qHeight <= preferredHeight ? (12 + Math.round(qHeight / 100)) : -8;
        } else if (qLabel === '720p') rank += 6;
        else if (qLabel === '1080p') rank += 7;
        else if (qLabel === '4K') rank += 4;
        else if (qLabel === '480p') rank += 2;
        batch.push({
          url,
          headers: candHeaders || CINEMA_PLAYER_HEADERS,
          routeName: routeName || (isVidbolt ? 'vidbolt' : (isPunkflix ? 'punkflix' : '')),
          isHls,
          isDash,
          qualityLabel: qLabel,
          rank,
          routeSubs,
          durationHint,
          requireEpisodeTitle,
          audioLanguage: audioMeta.audioLanguage,
          explicitDub: audioMeta.explicitDub,
          isLikelyDub: audioMeta.isLikelyDub
        });
      };

      const pushSrcObj = (srcObj, { data, routeSubs, durHint, dataQualityHint, hasRouteMetaProof }) => {
        if (!srcObj || typeof srcObj !== 'object') return;
        const rName = srcObj.source || data._route || '';
        const tHint = srcObj.type || '';
        const effectiveHeaders = (srcObj.headers && typeof srcObj.headers === 'object')
          ? srcObj.headers
          : ((data._headers && typeof data._headers === 'object') ? data._headers : CINEMA_PLAYER_HEADERS);
        const srcSubs = normalizeSubList([
          ...(Array.isArray(srcObj.subtitles) ? srcObj.subtitles : []),
          ...(Array.isArray(srcObj.captions) ? srcObj.captions : []),
          ...(Array.isArray(srcObj.tracks) ? srcObj.tracks : []),
          ...(Array.isArray(srcObj.subs) ? srcObj.subs : [])
        ], effectiveHeaders);
        const mergedCandSubs = [...srcSubs, ...routeSubs.filter((s) => !srcSubs.some((x) => x.url === s.url))];
        const candMeta = { qualityHint: dataQualityHint, routeSubs: mergedCandSubs, routeName: rName, durationHint: durHint, hasRouteMetaProof, srcObj, data, candHeaders: effectiveHeaders };
        if (srcObj.hls) addCandidate(srcObj.hls, { ...candMeta, typeHint: 'hls' });
        if (srcObj.original) addCandidate(srcObj.original, { ...candMeta, typeHint: /\.m3u8/i.test(srcObj.original) ? 'hls' : tHint });
        if (srcObj.url) addCandidate(srcObj.url, { ...candMeta, typeHint: tHint, qualityHint: srcObj.quality || dataQualityHint });
        if (srcObj.playlist) addCandidate(srcObj.playlist, { ...candMeta, typeHint: 'hls' });
        if (Array.isArray(srcObj.qualities)) {
          for (const q of srcObj.qualities) {
            if (typeof q === 'string') addCandidate(q, { ...candMeta, typeHint: tHint });
            else if (q?.url) {
              const qSubs = Array.isArray(q.subtitles) ? normalizeSubList(q.subtitles, effectiveHeaders) : [];
              addCandidate(q.url, {
                ...candMeta,
                routeSubs: qSubs.length ? [...qSubs, ...mergedCandSubs.filter((s) => !qSubs.some((x) => x.url === s.url))] : mergedCandSubs,
                typeHint: q.type || tHint,
                qualityHint: q.quality || q.label || '',
                itemObj: q
              });
            }
          }
        } else if (srcObj.qualities && typeof srcObj.qualities === 'object') {
          for (const [qKey, qVal] of Object.entries(srcObj.qualities)) {
            if (typeof qVal === 'string') addCandidate(qVal, { ...candMeta, typeHint: tHint, qualityHint: qKey });
            else if (qVal?.url) addCandidate(qVal.url, { ...candMeta, typeHint: qVal.type || tHint, qualityHint: qKey, itemObj: qVal });
          }
        }
      };

      for (const data of payloads) {
        if (!data || data._rateLimited) continue;
        if (!this.#routePayloadMatchesTarget(data, { tmdbId, imdbId, title, originalTitle, year, isTv, season, episode, episodeTitle })) continue;

        const metaObj = (data.meta && typeof data.meta === 'object') ? data.meta : {};
        const isPayloadEpisodeObj = isTv && (
          String(data.type || metaObj.type || '').toLowerCase() === 'episode'
          || metaObj.episode_number != null
          || metaObj.episodeNumber != null
          || metaObj.season_number != null
          || metaObj.seasonNumber != null
          || data.season != null
          || data.episode != null
          || (metaObj.air_date != null && metaObj.first_air_date == null && metaObj.release_date == null)
        );
        const payloadTitleText = String(
          data.title ?? data.name ?? data.movieTitle ?? metaObj.title ?? metaObj.name ?? metaObj.original_title ?? metaObj.original_name ?? ''
        ).trim();
        const nonGenericPayloadTitle = payloadTitleText && !/^episode\s*\d+$/i.test(payloadTitleText) ? payloadTitleText : '';
        const payloadShowId = isPayloadEpisodeObj
          ? (data.tmdbId ?? data.tmdb_id ?? data.seriesId ?? data.showId ?? metaObj.tmdbId ?? metaObj.tmdb_id ?? metaObj.show_id)
          : (data.tmdbId ?? data.tmdb_id ?? data.id ?? data.mediaId ?? metaObj.tmdbId ?? metaObj.tmdb_id ?? metaObj.id);
        const hasRouteMetaProof = Boolean(payloadShowId ?? nonGenericPayloadTitle);
        const routeHdrs = (data._headers && typeof data._headers === 'object') ? data._headers : CINEMA_PLAYER_HEADERS;
        const routeSubs = normalizeSubList([
          ...(Array.isArray(data.subtitles) ? data.subtitles : []),
          ...(Array.isArray(data.captions) ? data.captions : []),
          ...(Array.isArray(data.tracks) ? data.tracks : []),
          ...(Array.isArray(data.subs) ? data.subs : [])
        ], routeHdrs);
        const durHint = data.duration_ms ? Math.round(Number(data.duration_ms) / 1000) : null;
        const dataQualityHint = data.quality?.resolution || data.quality?.video_codec || '';
        const srcList = [
          data.source || data.stream,
          ...(Array.isArray(data.sources) ? data.sources : []),
          ...(Array.isArray(data.streams) ? data.streams : [])
        ].filter(Boolean);
        for (const srcObj of srcList) {
          pushSrcObj(srcObj, { data, routeSubs, durHint, dataQualityHint, hasRouteMetaProof });
        }
      }

      siblingSubtitleHints.sort((a, b) => (a.language === 'English' ? -1 : b.language === 'English' ? 1 : 0));
      batch.sort((a, b) => b.rank - a.rank);
      return batch;
    };

    const probeBatch = async (candList) => {
      let dubFallback = null;
      const originals = [];
      const origHosts = new Set();
      const origUrls = new Set();
      const urlHost = (u) => {
        try { return new URL(u).host.toLowerCase(); } catch { return ''; }
      };
      const recordOriginal = (hit) => {
        if (!hit?.stream?.url || origUrls.has(hit.stream.url)) return false;
        origUrls.add(hit.stream.url);
        const h = urlHost(hit.stream.url);
        if (h) origHosts.add(h);
        originals.push(hit);
        return originals.length >= 3;
      };
      const evaluateHit = (streamObj, subs) => {
        if (!streamObj?.url || excludeSet.has(streamObj.url)) return { immediate: null };
        const probedLang = normalizeLangCode(streamObj.audioLanguage || '');
        const explicitSourceDub = Boolean(streamObj.candExplicitDub);
        const hasExplicitOriginal = !explicitSourceDub && Boolean(prefLang && probedLang === prefLang && streamObj.audioIsDub === false);
        const resolvedIsDub = explicitSourceDub || (!hasExplicitOriginal && Boolean(
          streamObj.audioIsDub
          || (prefLang && probedLang && probedLang !== prefLang)
          || (!probedLang && streamObj.candIsLikelyDub)
        ));
        const finalLang = probedLang || streamObj.candAudioLang || '';
        const { candExplicitDub, candIsLikelyDub, candAudioLang, ...cleanStream } = streamObj;
        const enriched = {
          ...cleanStream,
          audioLanguage: finalLang || (prefLang && !resolvedIsDub ? prefLang : ''),
          audioIsDub: resolvedIsDub
        };
        const hit = { stream: enriched, subtitleHints: subs };
        if (!resolvedIsDub) return { immediate: hit };
        if (!dubFallback) dubFallback = hit;
        return { immediate: null };
      };

      for (const cand of candList.slice(0, 12)) {
        if (probedStreamUrls.has(cand.url) || excludeSet.has(cand.url)) continue;
        const candHost = urlHost(cand.url);
        if (originals.length >= 1 && candHost && origHosts.has(candHost)) continue;
        probedStreamUrls.add(cand.url);
        const candHeaders = cand.headers || CINEMA_PLAYER_HEADERS;
        const sameSubs = (cand.routeSubs || []).map((s) => ({ ...s, tier: 'same_route' }));
        const metaSubs = siblingSubtitleHints
          .filter((s) => !sameSubs.some((r) => r.url === s.url))
          .map((s) => ({ ...s, tier: 'meta_match' }));
        const mergedRouteSubs = [...sameSubs, ...metaSubs];
        if (cand.isDash) {
          const probedDash = await this.#probeDashManifest(cand.url, candHeaders, {
            minDuration: Math.max(minDuration, cand.durationHint || 0),
            durationSeconds: cand.durationHint || durationSeconds,
            expectedEpisodeTitle: cand.requireEpisodeTitle || null,
            preferredAudioLang: prefLang,
            isTv
          });
          if (probedDash) {
            const allDashSubs = [
              ...(Array.isArray(probedDash.subtitleHints) ? probedDash.subtitleHints : []),
              ...mergedRouteSubs
            ];
            const res = evaluateHit({
              url: probedDash.url,
              headers: probedDash.headers,
              format: 'dash',
              isHls: false,
              isDash: true,
              durationSeconds: probedDash.durationSeconds || cand.durationHint || durationSeconds || null,
              qualityLabel: probedDash.qualityLabel !== 'HD' ? probedDash.qualityLabel : cand.qualityLabel,
              source: cand.routeName === 'vidbolt' ? 'movie_vidbolt' : 'movie_tmdb_stream',
              subtitleHints: allDashSubs,
              audioLanguage: probedDash.audioLanguage,
              audioIsDub: probedDash.audioIsDub,
              candAudioLang: cand.audioLanguage,
              candExplicitDub: cand.explicitDub,
              candIsLikelyDub: cand.isLikelyDub
            }, allDashSubs);
            if (res.immediate && recordOriginal(res.immediate)) break;
          }
        } else if (cand.isHls) {
          const effMin = Math.max(minDuration, cand.durationHint || 0);
          const probedHls = await this.#probeHlsPlaylistAndSegment(cand.url, candHeaders, 0, {
            minDuration: effMin,
            preferredHeight,
            preferredAudioLang: prefLang,
            isTv
          });
          if (probedHls) {
            const maxHlsMult = isTv ? 1.45 : 1.30;
            if (effMin >= 1200 && probedHls.durationSeconds > 0 && probedHls.durationSeconds > Math.round(effMin * maxHlsMult)) {
              continue;
            }
            const allHlsSubs = [...(probedHls.subtitleHints || []), ...mergedRouteSubs];
            const res = evaluateHit({
              url: probedHls.url,
              headers: probedHls.headers,
              format: 'hls',
              isHls: true,
              isDash: false,
              durationSeconds: probedHls.durationSeconds || cand.durationHint || durationSeconds || null,
              qualityLabel: probedHls.qualityLabel !== 'HD' ? probedHls.qualityLabel : cand.qualityLabel,
              sizeBytes: probedHls.sizeBytes || null,
              variants: probedHls.variants || null,
              source: cand.routeName === 'vidbolt' ? 'movie_vidbolt' : 'movie_tmdb_stream',
              subtitleHints: allHlsSubs,
              audioLanguage: probedHls.audioLanguage,
              audioIsDub: probedHls.audioIsDub,
              candAudioLang: cand.audioLanguage,
              candExplicitDub: cand.explicitDub,
              candIsLikelyDub: cand.isLikelyDub
            }, allHlsSubs);
            if (res.immediate && recordOriginal(res.immediate)) break;
          }
        } else {
          const probedDirect = await this.#probeHttpStream(cand.url, candHeaders, { minDuration, isTv, preferredAudioLang: prefLang });
          if (probedDirect) {
            if (probedDirect.isHls) {
              const hlsCheck = await this.#probeHlsPlaylistAndSegment(probedDirect.url, candHeaders, 0, {
                minDuration,
                preferredHeight,
                preferredAudioLang: prefLang,
                isTv
              });
              if (!hlsCheck) continue;
              const maxDirectHlsMult = isTv ? 1.45 : 1.30;
              if (minDuration >= 1200 && hlsCheck.durationSeconds > 0 && hlsCheck.durationSeconds > Math.round(minDuration * maxDirectHlsMult)) {
                continue;
              }
              const allHlsSubs = [...(hlsCheck.subtitleHints || []), ...mergedRouteSubs];
              const res = evaluateHit({
                url: hlsCheck.url,
                headers: hlsCheck.headers,
                format: 'hls',
                isHls: true,
                durationSeconds: hlsCheck.durationSeconds || durationSeconds || null,
                qualityLabel: hlsCheck.qualityLabel !== 'HD' ? hlsCheck.qualityLabel : cand.qualityLabel,
                sizeBytes: hlsCheck.sizeBytes || null,
                variants: hlsCheck.variants || null,
                source: cand.routeName === 'vidbolt' ? 'movie_vidbolt' : 'movie_tmdb_stream',
                subtitleHints: allHlsSubs,
                audioLanguage: hlsCheck.audioLanguage,
                audioIsDub: hlsCheck.audioIsDub,
                candAudioLang: cand.audioLanguage,
                candExplicitDub: cand.explicitDub,
                candIsLikelyDub: cand.isLikelyDub
              }, allHlsSubs);
              if (res.immediate && recordOriginal(res.immediate)) break;
              continue;
            }
            const res = evaluateHit({
              url: probedDirect.url,
              headers: probedDirect.headers,
              format: /\.mkv(\?|$)/i.test(probedDirect.url) ? 'mkv' : 'mp4',
              isHls: false,
              durationSeconds: probedDirect.durationSeconds || durationSeconds || null,
              qualityLabel: cand.qualityLabel,
              sizeBytes: probedDirect.sizeBytes || null,
              source: cand.routeName === 'vidbolt' ? 'movie_vidbolt' : 'movie_tmdb_stream',
              subtitleHints: mergedRouteSubs,
              audioLanguage: probedDirect.audioLanguage || '',
              audioIsDub: Boolean(probedDirect.audioIsDub),
              candAudioLang: cand.audioLanguage,
              candExplicitDub: cand.explicitDub,
              candIsLikelyDub: cand.isLikelyDub
            }, mergedRouteSubs);
            if (res.immediate && recordOriginal(res.immediate)) break;
          }
        }
      }
      return {
        original: originals[0] || null,
        fallbackStreams: originals.slice(1, 3).map((x) => x.stream),
        dubFallback
      };
    };

    // Wave A: 1 multi-source request per distinct host + VidBolt aggregator concurrently
    const waveASpecs = [
      ...(isNumericTmdb
        ? [{
          routeName: 'punkflix',
          endpoint: isTv
            ? `${PUNKFLIX_HOST}/tv/${encodeURIComponent(tmdbId)}/${Number(season || 1)}/${Number(episode || 1)}.json`
            : `${PUNKFLIX_HOST}/movie/${encodeURIComponent(tmdbId)}.json`
        }]
        : []),
      {
        routeName: 'zendaya',
        endpoint: `${CINEMA_STREAM_NODES[1]}${baseQuery}&sources=zendaya,berlin,jennifer,lookmovie,meowtv,vidnest&hevc=1`
      },
      {
        routeName: 'flikhub1',
        endpoint: `${CINEMA_STREAM_NODES[0]}${baseQuery}&sources=zendaya,berlin,jennifer,scarlet,lookmovie,meowtv,vidnest`
      },
      {
        routeName: 'flikhub3',
        endpoint: `${CINEMA_STREAM_NODES[2]}${baseQuery}&sources=zendaya,berlin,jennifer,scarlet,lookmovie,meowtv,vidnest`
      }
    ];

    const [waveAResults, vidboltWaveA] = await Promise.all([
      Promise.allSettled(waveASpecs.map((s) => this.#fetchRouteJson(s.routeName, s.endpoint, reqHeaders))),
      isNumericTmdb
        ? this.#fetchVidboltCandidates({ isTv, tmdbId, season, episode }).catch(() => [])
        : Promise.resolve([])
    ]);
    const waveAPayloads = [
      ...waveAResults.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value),
      ...vidboltWaveA
    ];

    // If we started from an IMDb tt-ID and Wave A returned meta.id (numeric TMDB ID), adopt it for Punkflix/VidBolt & Wave B
    let discoveredTmdbId = isNumericTmdb ? tmdbId : null;
    if (!discoveredTmdbId) {
      for (const p of waveAPayloads) {
        const candMetaId = p?.meta?.id ?? p?.tmdbId ?? p?.tmdb_id ?? null;
        if (candMetaId != null && /^\d+$/.test(String(candMetaId))) {
          discoveredTmdbId = String(candMetaId);
          tmdbId = discoveredTmdbId;
          isNumericTmdb = true;
          break;
        }
      }
    }

    const waveACandidates = collectCandidates(waveAPayloads);
    const waveAHit = await probeBatch(waveACandidates);
    if (waveAHit.original) {
      return { ...waveAHit.original, fallbackStreams: waveAHit.fallbackStreams || [], discoveredTmdbId };
    }
    let bestDubFallback = waveAHit.dubFallback || null;

    // If Wave A started with an IMDb ID and discovered a numeric TMDB ID, also check Punkflix & VidBolt before Wave B
    if (discoveredTmdbId && !waveASpecs.some((s) => s.routeName === 'punkflix')) {
      const punkEp = isTv
        ? `${PUNKFLIX_HOST}/tv/${encodeURIComponent(discoveredTmdbId)}/${Number(season || 1)}/${Number(episode || 1)}.json`
        : `${PUNKFLIX_HOST}/movie/${encodeURIComponent(discoveredTmdbId)}.json`;
      const [punkPayload, vidboltExtra] = await Promise.all([
        this.#fetchRouteJson('punkflix', punkEp, reqHeaders).catch(() => null),
        this.#fetchVidboltCandidates({ isTv, tmdbId: discoveredTmdbId, season, episode }).catch(() => [])
      ]);
      const discPayloads = [...(punkPayload ? [punkPayload] : []), ...vidboltExtra];
      if (discPayloads.length) {
        const punkHit = await probeBatch(collectCandidates(discPayloads));
        if (punkHit.original) return { ...punkHit.original, fallbackStreams: punkHit.fallbackStreams || [], discoveredTmdbId };
        if (!bestDubFallback && punkHit.dubFallback) bestDubFallback = punkHit.dubFallback;
      }
    }

    // Wave B: paced per-route fallback across alternate hosts only when Wave A had no original stream
    const activeBaseQuery = makeBaseQuery(discoveredTmdbId || tmdbId);
    const secondaryRoutes = CINEMA_STREAM_ROUTES.filter((s) => s !== 'zendaya');
    const waveBSpecs = secondaryRoutes.map((src, idx) => {
      const host = CINEMA_STREAM_NODES[idx % CINEMA_STREAM_NODES.length];
      return {
        routeName: src,
        endpoint: `${host}${activeBaseQuery}&sources=${src}${host === CINEMA_STREAM_NODES[1] ? '&hevc=1' : ''}`
      };
    });
    const waveBPayloads = [];
    const paceMs = this.fetchImpl === fetch ? 180 : 0;
    for (let i = 0; i < waveBSpecs.length; i += 2) {
      const chunk = waveBSpecs.slice(i, i + 2);
      const resChunk = await Promise.allSettled(
        chunk.map((s) => this.#fetchRouteJson(s.routeName, s.endpoint, reqHeaders))
      );
      for (const r of resChunk) {
        if (r.status === 'fulfilled' && r.value && !r.value._rateLimited) {
          waveBPayloads.push(r.value);
        }
      }
      if (paceMs > 0 && i + 2 < waveBSpecs.length) {
        await new Promise((r) => setTimeout(r, paceMs));
      }
    }
    const waveBCandidates = collectCandidates(waveBPayloads);
    const waveBHit = await probeBatch(waveBCandidates);
    if (waveBHit.original) return { ...waveBHit.original, fallbackStreams: waveBHit.fallbackStreams || [], discoveredTmdbId };
    if (!bestDubFallback && waveBHit.dubFallback) bestDubFallback = waveBHit.dubFallback;

    // If Wave A got rate-limited on any host, do one backed-off retry on the non-limited node(s)
    const rateLimited = waveAPayloads.some((p) => p?._rateLimited);
    if (rateLimited) {
      const retryRes = await Promise.allSettled(
        waveASpecs.slice(1).map((s) => this.#fetchRouteJson(s.routeName, s.endpoint, reqHeaders))
      );
      const retryCandidates = collectCandidates(
        retryRes.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value)
      );
      const retryHit = await probeBatch(retryCandidates);
      if (retryHit.original) return { ...retryHit.original, fallbackStreams: retryHit.fallbackStreams || [], discoveredTmdbId };
      if (!bestDubFallback && retryHit.dubFallback) bestDubFallback = retryHit.dubFallback;
    }

    if (bestDubFallback) {
      return {
        ...bestDubFallback,
        fallbackStreams: [],
        discoveredTmdbId,
        stream: {
          ...bestDubFallback.stream,
          audioIsDub: true,
          dubOnly: true,
          dubOnlyWarning: '⚠️ Dub Only Available'
        }
      };
    }

    return { stream: null, subtitleHints: [], fallbackStreams: [], discoveredTmdbId };
  }

  #normalizeSubList(rawSubs, { headers = CINEMA_PLAYER_HEADERS } = {}) {
    const list = [];
    const localSeen = new Set();
    for (const sub of (Array.isArray(rawSubs) ? rawSubs : [])) {
      const subUrl = String(sub?.file || sub?.url || sub?.src || sub?.link || sub?.path || '').trim();
      if (!subUrl || !/^https?:\/\//i.test(subUrl) || localSeen.has(subUrl)) continue;
      localSeen.add(subUrl);
      const langRaw = String(sub?.srclang || sub?.lang || sub?.language || sub?.label || sub?.name || 'Subtitles').trim();
      const labelRaw = String(sub?.label || sub?.name || sub?.title || langRaw).trim();
      list.push(formatSubtitleHint({
        url: subUrl,
        headers: (sub?.headers && typeof sub.headers === 'object' && Object.keys(sub.headers).length) ? sub.headers : headers,
        langRaw,
        labelRaw,
        explicitType: sub?.type || sub?.format || '',
        mimeHint: sub?.mimeType || '',
        forced: Boolean(sub?.forced),
        sdh: Boolean(sub?.sdh || sub?.hi),
        tier: sub?.tier || 'same_route'
      }));
    }
    list.sort((a, b) => (a.language === 'English' ? -1 : b.language === 'English' ? 1 : 0));
    return list;
  }

  async #fetchTmdbSubtitleHints({ isTv = false, tmdbId, season = null, episode = null } = {}) {
    const idStr = String(tmdbId || '').trim();
    if (!/^\d+$/.test(idStr)) return [];
    const reqHeaders = { ...CINEMA_PLAYER_HEADERS, 'User-Agent': UA };
    const punkEndpoint = isTv
      ? `${PUNKFLIX_HOST}/tv/${encodeURIComponent(idStr)}/${Number(season || 1)}/${Number(episode || 1)}.json`
      : `${PUNKFLIX_HOST}/movie/${encodeURIComponent(idStr)}.json`;
    const berlinEndpoint = isTv
      ? `${CINEMA_STREAM_NODES[0]}/tv?id=${encodeURIComponent(idStr)}&season=${Number(season || 1)}&episode=${Number(episode || 1)}&mode=json&sources=berlin`
      : `${CINEMA_STREAM_NODES[0]}/movie?id=${encodeURIComponent(idStr)}&mode=json&sources=berlin`;

    const settled = await Promise.allSettled(
      [punkEndpoint, berlinEndpoint].map(async (ep) => {
        const res = await this.fetchImpl(ep, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(4500) });
        if (!res?.ok || typeof res.json !== 'function') return null;
        return res.json();
      })
    );
    const out = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const v = r.value;
      const rawArr = [
        ...(Array.isArray(v.subtitles) ? v.subtitles : []),
        ...(Array.isArray(v.captions) ? v.captions : []),
        ...(Array.isArray(v.tracks) ? v.tracks : [])
      ];
      for (const item of this.#normalizeSubList(rawArr, { headers: CINEMA_PLAYER_HEADERS })) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        out.push({ ...item, tier: 'meta_match' });
      }
    }
    out.sort((a, b) => (a.language === 'English' ? -1 : b.language === 'English' ? 1 : 0));
    return out;
  }

  async #probeWithRefererVariants(url, probeOpts = {}) {
    for (const headers of [
      {},
      { ...CINEMA_PLAYER_HEADERS },
      { Referer: 'https://punkflix.net/', Origin: 'https://punkflix.net' },
      { Referer: 'https://cinezo.live/', Origin: 'https://cinezo.live' },
      { Referer: 'https://holaflix.xyz/', Origin: 'https://holaflix.xyz' },
      { Referer: 'https://holaflix.cc/', Origin: 'https://holaflix.cc' }
    ]) {
      const probed = await this.#probeHttpStream(url, headers, probeOpts);
      if (probed) return probed;
    }
    return null;
  }

  async #resolveDownloadHostUrl(candidateUrl, { allowUnprobedMock = false, minDuration = 0, maxDuration = 0, isTv = false, preferredAudioLang = '' } = {}) {
    if (!candidateUrl || AD_OR_BAD_DOMAIN_RE.test(candidateUrl) || isTrailerLike(candidateUrl)) return null;
    let resolved = null;
    if (/downloadwella\.com/i.test(candidateUrl) || !DIRECT_VIDEO_RE.test(candidateUrl)) {
      resolved = await Promise.race([
        this.thenkiri.thenkiriGetLink?.(candidateUrl).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 9000))
      ]);
    }
    const finalUrl = resolved?.url || (DIRECT_VIDEO_RE.test(candidateUrl) ? candidateUrl : null);
    if (!finalUrl || !/^https?:\/\//i.test(finalUrl) || isTrailerLike(finalUrl)) return null;
    const headers = resolved?.headers || (candidateUrl.includes('downloadwella') ? { Referer: 'https://downloadwella.com/' } : {});
    if (this.fetchImpl === fetch) {
      const probed = await this.#probeHttpStream(finalUrl, headers, { minDuration, maxDuration, isTv, preferredAudioLang });
      if (!probed) return null;
      return {
        url: probed.url,
        headers,
        format: resolved?.format || 'mkv',
        durationSeconds: probed.durationSeconds || null,
        sizeBytes: probed.sizeBytes || null,
        audioLanguage: probed.audioLanguage || '',
        audioIsDub: Boolean(probed.audioIsDub)
      };
    }
    // Custom mock fetchImpl (unit tests): probe if non-mock-resolved URL, or trust thenkiriGetLink output.
    if (allowUnprobedMock && resolved?.url) {
      return { url: resolved.url, headers, format: resolved?.format || 'mkv' };
    }
    const probed = await this.#probeHttpStream(finalUrl, headers, { minDuration, maxDuration, isTv, preferredAudioLang });
    if (probed) {
      return {
        url: probed.url,
        headers,
        format: resolved?.format || 'mkv',
        durationSeconds: probed.durationSeconds || null,
        sizeBytes: probed.sizeBytes || null,
        audioLanguage: probed.audioLanguage || '',
        audioIsDub: Boolean(probed.audioIsDub)
      };
    }
    return resolved?.url ? { url: resolved.url, headers, format: resolved?.format || 'mkv' } : null;
  }

  async #resolveFromThenkiriCatalog(opts) {
    const { type, title, year, season, episode, episodeTitle = null, alternateTitle = null, alternateSeason = null, originalLanguage = '', durationSeconds = null } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = this.#computeVodMinDuration(durationSeconds || 0, { isTv });
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.4)) : 0;
    const queries = buildSearchQueries(opts);
    const seenUrls = new Set();
    const rankedPosts = [];

    for (const q of queries) {
      const searchRes = await Promise.race([
        this.thenkiri.thenkiriSearch?.(q).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 8000))
      ]);
      for (const item of (searchRes?.results || [])) {
        if (!item?.url || seenUrls.has(item.url)) continue;
        if (isTrailerLike(`${item.title || ''} ${item.url}`, title, { isTv, episodeTitle: episodeTitle || '', alternateTitle: alternateTitle || '' })) continue;
        seenUrls.add(item.url);
        const s = scoreTitleMatch(title, year, item.title || item.url, { isTv, season, episode, episodeTitle, alternateTitle, alternateSeason });
        if (s >= 22) {
          const isDubPost = isDubbedCandidateText(item.title || '', { preferredAudioLang: prefLang, targetTitle: title });
          rankedPosts.push({ ...item, score: s, isDubPost });
        }
      }
      if (rankedPosts.some((p) => !p.isDubPost && p.score >= 32)) break;
    }
    rankedPosts.sort((a, b) => (Number(a.isDubPost) - Number(b.isDubPost)) || (b.score - a.score));

    let dubFallback = null;
    for (const post of rankedPosts.slice(0, 3)) {
      const details = await Promise.race([
        this.thenkiri.thenkiriDetails?.(post.url).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 8000))
      ]);
      const sanitizedSources = (details?.sources || []).map((s) => ({
        ...s,
        label: String(s?.label || '').replace(/<[^>]+>/g, ' ').replace(/\b(?:class|href|target|rel|style)\s*=\s*["'][^"']*["']/gi, ' ').replace(/\s+/g, ' ').trim()
      }));
      const candidates = matchEpisodeSource(sanitizedSources, { type, season, episode })
        .sort((a, b) => (
          Number(isDubbedCandidateText(`${a.label || ''} ${a.title || ''}`, { preferredAudioLang: prefLang, targetTitle: title }))
          - Number(isDubbedCandidateText(`${b.label || ''} ${b.title || ''}`, { preferredAudioLang: prefLang, targetTitle: title }))
        ));
      for (const cand of candidates.slice(0, 3)) {
        const candText = `${post.title || ''} ${cand.label || ''} ${cand.title || ''} ${cand.url || ''}`;
        const candIsDub = Boolean(post.isDubPost || isDubbedCandidateText(candText, { preferredAudioLang: prefLang, targetTitle: title }));
        const res = await this.#resolveDownloadHostUrl(cand.url, {
          allowUnprobedMock: true,
          minDuration,
          maxDuration,
          isTv,
          preferredAudioLang: prefLang
        });
        if (res) {
          const hit = {
            ...res,
            audioIsDub: Boolean(res.audioIsDub || candIsDub),
            source: 'thenkiri_downloadwella',
            qualityLabel: extractQualityLabel(cand.label)
          };
          if (!hit.audioIsDub) return hit;
          if (!dubFallback) dubFallback = hit;
        }
      }
    }
    return dubFallback;
  }

  async #scrapeThenkiriNgPost(postUrl, { type, title = '', season, episode, minDuration = 0, maxDuration = 0, preferredAudioLang = '' }) {
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(preferredAudioLang);
    try {
      const resp = await this.fetchImpl(postUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000)
      });
      if (!resp?.ok || typeof resp.text !== 'function') return null;
      const html = await resp.text();
      if (!html || html.length < 200) return null;
      const rawAnchors = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .map((m) => ({
          url: m[1],
          label: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        }))
        .filter((a) => /downloadwella\.com|\.(?:mkv|mp4)(?:\?|$)/i.test(a.url) && !AD_OR_BAD_DOMAIN_RE.test(a.url) && !isTrailerLike(`${a.label} ${a.url}`, title));
      const matched = matchEpisodeSource(rawAnchors, { type, season, episode })
        .sort((a, b) => (
          Number(isDubbedCandidateText(`${a.label || ''} ${a.url || ''}`, { preferredAudioLang: prefLang, targetTitle: title }))
          - Number(isDubbedCandidateText(`${b.label || ''} ${b.url || ''}`, { preferredAudioLang: prefLang, targetTitle: title }))
        ));
      let dubFallback = null;
      for (const cand of matched.slice(0, 3)) {
        const candIsDub = isDubbedCandidateText(`${cand.label || ''} ${cand.url || ''}`, { preferredAudioLang: prefLang, targetTitle: title });
        const resolved = await this.#resolveDownloadHostUrl(cand.url, { minDuration, maxDuration, isTv, preferredAudioLang: prefLang });
        if (resolved) {
          const hit = {
            ...resolved,
            audioIsDub: Boolean(resolved.audioIsDub || candIsDub),
            source: 'thenkiri_ng',
            qualityLabel: extractQualityLabel(cand.label)
          };
          if (!hit.audioIsDub) return hit;
          if (!dubFallback) dubFallback = hit;
        }
      }
      return dubFallback;
    } catch {}
    return null;
  }

  async #resolveFromThenkiriNg(opts) {
    const { type, title, year, season, episode, episodeTitle = null, alternateTitle = null, alternateSeason = null, originalLanguage = '', durationSeconds = null } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = this.#computeVodMinDuration(durationSeconds || 0, { isTv });
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.4)) : 0;
    const queries = buildSearchQueries(opts);
    const ranked = [];
    const seen = new Set();

    for (const q of queries.slice(0, 2)) {
      try {
        const res = await this.fetchImpl(`https://thenkiri.ng/?s=${encodeURIComponent(q)}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000)
        });
        if (!res?.ok || typeof res.text !== 'function') continue;
        const html = await res.text();
        for (const m of html.matchAll(/<h[1-3][^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>\s*<a[^>]+href=["'](https?:\/\/thenkiri\.ng\/[^"'?#]+\/)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const postUrl = m[1];
          const postTitle = m[2].replace(/<[^>]+>/g, '').replace(/&#\d+;/g, ' ').trim();
          if (seen.has(postUrl) || isTrailerLike(postTitle, title, { isTv, episodeTitle: episodeTitle || '', alternateTitle: alternateTitle || '' })) continue;
          seen.add(postUrl);
          const sc = scoreTitleMatch(title, year, postTitle, { isTv, season, episode, episodeTitle, alternateTitle, alternateSeason });
          if (sc >= 22) {
            const isDubPost = isDubbedCandidateText(postTitle, { preferredAudioLang: prefLang, targetTitle: title });
            ranked.push({ url: postUrl, title: postTitle, score: sc, isDubPost });
          }
        }
        if (ranked.some((r) => !r.isDubPost && r.score >= 32)) break;
      } catch {}
    }

    ranked.sort((a, b) => (Number(a.isDubPost) - Number(b.isDubPost)) || (b.score - a.score));
    let dubFallback = null;
    for (const post of ranked.slice(0, 3)) {
      const hit = await this.#scrapeThenkiriNgPost(post.url, { type, title, season, episode, minDuration, maxDuration, preferredAudioLang: prefLang });
      if (hit) {
        if (!hit.audioIsDub && !post.isDubPost) return hit;
        if (!dubFallback) dubFallback = { ...hit, audioIsDub: true };
      }
    }
    return dubFallback;
  }

  async #resolveFromArchiveOrg(opts) {
    const {
      id = null,
      type,
      title,
      originalTitle = '',
      year,
      durationSeconds = null,
      season = null,
      episode = null,
      episodeTitle = null,
      alternateTitle = null,
      alternateSeason = null,
      originalLanguage = '',
      excludeUrls = []
    } = opts;
    const excludeSet = new Set(Array.isArray(excludeUrls) ? excludeUrls.filter(Boolean) : []);
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = this.#computeVodMinDuration(durationSeconds || 0, { isTv }) || (isTv ? 420 : 2100);
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.30)) : 0;
    const cleanTitle = String(title || '').replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
    const spacedTitle = expandCamelCaseText(cleanTitle);
    const spacedAlt = alternateTitle ? expandCamelCaseText(String(alternateTitle).replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()) : '';
    const filterOpts = { isTv, episodeTitle: episodeTitle || '', alternateTitle: spacedAlt };
    if (String(id || '').startsWith('archive:')) {
      const ident = String(id).slice('archive:'.length).trim();
      const directHit = await this.#resolveArchiveIdentifier(ident, minDuration, {
        title: cleanTitle,
        originalTitle,
        year,
        isTv,
        season,
        episode,
        episodeTitle,
        alternateTitle: spacedAlt,
        alternateSeason,
        maxDuration,
        preferredAudioLang: prefLang,
        excludeSet
      });
      if (directHit) return directHit;
    }
    if (!cleanTitle) return null;

    const titleClauses = [spacedTitle];
    if (cleanTitle && cleanTitle !== spacedTitle) titleClauses.push(cleanTitle);
    if (spacedAlt && !titleClauses.includes(spacedAlt)) titleClauses.unshift(spacedAlt);
    const titleExpr = titleClauses.map((t) => `"${t}"`).join(' OR ');

    const queryExpr = isTv && episode != null
      ? `title:(${titleExpr}) AND mediatype:(movies OR television)`
      : `title:(${titleExpr}) AND mediatype:(movies OR television)`;

    try {
      const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(queryExpr)}&sort[]=downloads+desc&fl[]=identifier,title,year,downloads,language&rows=8&output=json`;
      const res = await this.fetchImpl(searchUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
      if (!res?.ok || typeof res.json !== 'function') return null;
      const data = await res.json();
      const docs = (Array.isArray(data?.response?.docs) ? data.response.docs : [])
        .filter((d) => {
          const text = `${d?.title || ''} ${d?.identifier || ''}`;
          return d?.identifier && !isTrailerLike(text, cleanTitle, filterOpts) && !isNonFeatureOrClipTitle(text, cleanTitle, filterOpts);
        })
        .map((d) => {
          const langText = Array.isArray(d.language) ? d.language.join(' ') : (d.language || '');
          return {
            ...d,
            isDubDoc: isDubbedCandidateText(`${d.title || ''} ${d.identifier || ''} ${langText}`, { preferredAudioLang: prefLang, targetTitle: cleanTitle }),
            score: scoreTitleMatch(cleanTitle, year, `${d.title || ''} ${d.year || ''}`, {
              isTv,
              season,
              episode,
              episodeTitle,
              alternateTitle: spacedAlt,
              alternateSeason
            })
          };
        })
        .filter((d) => d.score >= 22)
        .sort((a, b) => (Number(a.isDubDoc) - Number(b.isDubDoc)) || (b.score - a.score) || ((Number(b.downloads) || 0) - (Number(a.downloads) || 0)));

      let dubFallback = null;
      const origHits = [];
      for (const doc of docs.slice(0, 4)) {
        const resolved = await this.#resolveArchiveIdentifier(doc.identifier, minDuration, {
          title: cleanTitle,
          originalTitle,
          year,
          isTv,
          season,
          episode,
          episodeTitle,
          alternateTitle: spacedAlt,
          alternateSeason,
          maxDuration,
          preferredAudioLang: prefLang,
          excludeSet
        });
        if (resolved) {
          const hit = doc.isDubDoc ? { ...resolved, audioIsDub: true } : resolved;
          if (!hit.audioIsDub) {
            origHits.push(hit);
            if (origHits.length >= 2) break;
          } else if (!dubFallback) {
            dubFallback = hit;
          }
        }
      }
      if (origHits.length) {
        const primary = origHits[0];
        const extraFallbacks = [
          ...(Array.isArray(primary.fallbackStreams) ? primary.fallbackStreams : []),
          ...origHits.slice(1)
        ].filter((f) => f?.url && f.url !== primary.url);
        return { ...primary, fallbackStreams: extraFallbacks.slice(0, 2) };
      }
      if (dubFallback) return dubFallback;
    } catch {}
    return null;
  }

  async #resolveArchiveIdentifier(identifier, minDuration = 2100, { title = '', originalTitle = '', year = null, isTv = false, season = null, episode = null, episodeTitle = null, alternateTitle = null, alternateSeason = null, maxDuration = 0, preferredAudioLang = '', excludeSet = new Set() } = {}) {
    if (!identifier) return null;
    const prefLang = normalizeLangCode(preferredAudioLang);
    const filterOpts = { isTv, episodeTitle: episodeTitle || '', alternateTitle: alternateTitle || '' };
    const cleanEpMatch = String(episodeTitle || '').replace(/\s*\(\d{1,2}\)\s*$/g, '').trim();
    const epNormRe = cleanEpMatch.length >= 4
      ? new RegExp(cleanEpMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]+'), 'i')
      : null;
    try {
      const metaRes = await this.fetchImpl(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(7000)
      });
      if (!metaRes?.ok || typeof metaRes.json !== 'function') return null;
      const meta = await metaRes.json();
      const rawMetaTitle = String(meta?.metadata?.title || '').trim();
      const metaTitle = `${rawMetaTitle} ${identifier}`.trim();
      if (isTrailerLike(metaTitle, title, filterOpts) || isNonFeatureOrClipTitle(metaTitle, title, filterOpts)) return null;
      if (title && rawMetaTitle && !isTv) {
        const metaText = `${rawMetaTitle} ${meta?.metadata?.year || ''}`.trim();
        const mainSc = scoreTitleMatch(title, year, metaText, { isTv, season, episode, episodeTitle, alternateTitle, alternateSeason });
        const origSc = originalTitle ? scoreTitleMatch(originalTitle, year, metaText, { isTv, season, episode, episodeTitle, alternateTitle, alternateSeason }) : -100;
        if (Math.max(mainSc, origSc) < 14) return null;
      }
      const metaLangRaw = Array.isArray(meta?.metadata?.language) ? meta.metadata.language[0] : meta?.metadata?.language;
      const metaLang = normalizeLangCode(metaLangRaw || '');
      const metaDub = isDubbedCandidateText(`${metaTitle} ${metaLangRaw || ''}`, { preferredAudioLang: prefLang, targetTitle: title })
        || Boolean(prefLang && metaLang && metaLang !== prefLang);

      const allowedSeasons = new Set();
      if (season != null) allowedSeasons.add(Number(season));
      if (alternateSeason != null) allowedSeasons.add(Number(alternateSeason));

      const files = Array.isArray(meta?.files) ? meta.files : [];
      const videos = files
        .filter((f) => {
          if (!f?.name || !/\.(mp4|mkv)$/i.test(f.name) || isTrailerLike(f.name, title, filterOpts) || isNonFeatureOrClipTitle(f.name, title, filterOpts)) return false;
          if (isTv && episode != null) {
            const parsed = parseEpisodeCode(f.name);
            const titleMatchesEp = Boolean(epNormRe && epNormRe.test(f.name));
            if (parsed.episodeNumber != null && parsed.episodeNumber !== Number(episode) && !titleMatchesEp) return false;
            if (parsed.seasonNumber != null && allowedSeasons.size > 0 && !allowedSeasons.has(parsed.seasonNumber) && !titleMatchesEp) return false;
            if (parsed.episodeNumber == null && !titleMatchesEp && files.some((other) => /\.(mp4|mkv)$/i.test(other?.name || '') && parseEpisodeCode(other.name).episodeNumber === Number(episode))) {
              return false;
            }
          }
          const lenSec = Number(f.length);
          const sizeBytes = Number(f.size || 0);
          if (Number.isFinite(lenSec) && lenSec > 0 && lenSec < minDuration) return false;
          if (maxDuration && Number.isFinite(lenSec) && lenSec > maxDuration) return false;
          const minRawBytes = isTv ? 18 * 1024 * 1024 : 45 * 1024 * 1024;
          if (!Number.isFinite(lenSec) && sizeBytes > 0 && sizeBytes < minRawBytes) return false;
          if (sizeBytes > 4.5 * 1024 * 1024 * 1024) return false; // prefer clean streams over huge >4.5GB remuxes
          return true;
        })
        .sort((a, b) => {
          const rank = (f) => {
            const name = f.name.toLowerCase();
            let s = 0;
            const fileIsDub = isDubbedCandidateText(f.name, { preferredAudioLang: prefLang, targetTitle: title });
            if (fileIsDub) s -= 60;
            else s += 40;
            if (name.endsWith('.mp4')) s += 15;
            if (/1080p/.test(name)) s += 12;
            else if (/720p/.test(name)) s += 10;
            if (Number.isFinite(Number(f.length)) && Number(f.length) >= minDuration) s += 12;
            if (/512kb|_ipod|_iphone|_psp/.test(name)) s -= 15;
            return s;
          };
          return rank(b) - rank(a);
        });

      const srtFiles = files.filter((f) => f?.name && /\.(srt|vtt|ass|ssa|ttml|dfxp)$/i.test(f.name));
      const subtitleHints = srtFiles.map((f) => {
        const subUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`;
        const langMatch = f.name.match(/[._-]([a-z]{2,3}|english|spanish|french|japanese|korean)(?:[._-]|$)/i);
        return formatSubtitleHint({
          url: subUrl,
          headers: {},
          langRaw: langMatch?.[1] || (/en/i.test(f.name) ? 'en' : ''),
          labelRaw: f.name.replace(/\.[^.]+$/, ''),
          tier: 'same_route'
        });
      });

      const resolvedList = [];
      for (const chosen of videos.slice(0, 3)) {
        const directUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${chosen.name.split('/').map(encodeURIComponent).join('/')}`;
        if (excludeSet.has(directUrl)) continue;
        const probed = await this.#probeHttpStream(directUrl, {}, {
          minDuration,
          maxDuration,
          isTv,
          preferredAudioLang: prefLang
        });
        if (!probed || excludeSet.has(probed.url)) continue;

        const durSec = probed.durationSeconds || (Number.isFinite(Number(chosen.length)) ? Math.round(Number(chosen.length)) : null);
        const fileDub = isDubbedCandidateText(chosen.name, { preferredAudioLang: prefLang, targetTitle: title });
        resolvedList.push({
          url: probed.url,
          headers: {},
          format: chosen.name.toLowerCase().endsWith('.mkv') ? 'mkv' : 'mp4',
          durationSeconds: durSec,
          sizeBytes: Number(chosen.size || 0) || probed.sizeBytes || null,
          audioLanguage: probed.audioLanguage || metaLang || '',
          audioIsDub: Boolean(probed.audioIsDub || fileDub || metaDub),
          source: 'archive_org',
          qualityLabel: extractQualityLabel(chosen.name),
          subtitleHints: subtitleHints.map((s) => ({ ...s, tier: 'same_route' }))
        });
        if (resolvedList.filter((x) => !x.audioIsDub).length >= 2) break;
      }
      if (!resolvedList.length) return null;
      const nonDubs = resolvedList.filter((x) => !x.audioIsDub);
      const primary = nonDubs[0] || resolvedList[0];
      return {
        ...primary,
        fallbackStreams: nonDubs.slice(1, 3)
      };
    } catch {
      return null;
    }
  }

  async #resolveFromOpenWebSearch(opts) {
    const { type, title, year, season, episode, episodeTitle = null, alternateTitle = null, alternateSeason = null, durationSeconds = null, originalLanguage = '' } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = durationSeconds ? Math.max(isTv ? 420 : 1200, Math.floor(Number(durationSeconds) * (isTv ? 0.56 : 0.65))) : (isTv ? 420 : 2100);
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.35)) : 0;
    const cleanTitle = expandCamelCaseText(String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
    if (!cleanTitle) return null;
    const altClean = alternateTitle ? expandCamelCaseText(String(alternateTitle).replace(/\s*\([^)]*\)\s*/g, ' ').trim()) : '';

    const searchTerm = isTv && season != null
      ? `${altClean || cleanTitle} S${String(season).padStart(2, '0')}`
      : (year ? `${cleanTitle} ${year}` : cleanTitle);

    let dubFallback = null;
    const pickOrSaveDub = (hit) => {
      if (!hit) return null;
      if (!hit.audioIsDub) return hit;
      if (!dubFallback) dubFallback = hit;
      return null;
    };

    // 1. WordPress JSON catalog search (clean JSON, avoids HTML scraper CAPTCHAs)
    const wpHosts = ['https://thenkiri.ng', 'https://thenkiri.com', 'https://nkiri.ink'];
    for (const host of wpHosts) {
      try {
        const res = await this.fetchImpl(`${host}/wp-json/wp/v2/posts?search=${encodeURIComponent(searchTerm)}&per_page=5`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(6000)
        });
        if (!res?.ok || typeof res.json !== 'function') continue;
        const posts = await res.json();
        const ranked = (Array.isArray(posts) ? posts : [])
          .map((p) => {
            const pTitle = String(p?.title?.rendered || p?.slug || '').replace(/<[^>]+>/g, '').replace(/&#\d+;/g, ' ').trim();
            return {
              url: p?.link,
              html: String(p?.content?.rendered || ''),
              title: pTitle,
              isDubPost: isDubbedCandidateText(pTitle, { preferredAudioLang: prefLang, targetTitle: cleanTitle }),
              score: scoreTitleMatch(cleanTitle, year, pTitle, { isTv, season, episode, episodeTitle, alternateTitle: altClean, alternateSeason })
            };
          })
          .filter((p) => p.url && !isTrailerLike(p.title, cleanTitle, { isTv, episodeTitle: episodeTitle || '', alternateTitle: altClean }) && p.score >= 22)
          .sort((a, b) => (Number(a.isDubPost) - Number(b.isDubPost)) || (b.score - a.score));

        for (const post of ranked.slice(0, 2)) {
          if (host.includes('thenkiri.ng')) {
            const hit = await this.#scrapeThenkiriNgPost(post.url, { type, title: cleanTitle, season, episode, minDuration, maxDuration, preferredAudioLang: prefLang });
            const origHit = pickOrSaveDub(hit && post.isDubPost ? { ...hit, audioIsDub: true } : hit);
            if (origHit) return origHit;
          } else {
            // Check inline downloadwella links directly from WP post HTML first, then social-dl details
            const inlineAnchors = [...(post.html || '').matchAll(/href=["'](https?:\/\/[^"']*(?:downloadwella\.com|\.(?:mkv|mp4))[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
              .map((m) => ({ url: m[1], label: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));
            const details = await Promise.race([
              this.thenkiri.thenkiriDetails?.(post.url).catch(() => null),
              new Promise((r) => setTimeout(() => r(null), 6500))
            ]);
            const mergedSources = [
              ...inlineAnchors,
              ...(details?.sources || []).map((s) => ({
                ...s,
                label: String(s?.label || '').replace(/<[^>]+>/g, ' ').replace(/\b(?:class|href|target|rel|style)\s*=\s*["'][^"']*["']/gi, ' ').replace(/\s+/g, ' ').trim()
              }))
            ];
            for (const cand of matchEpisodeSource(mergedSources, { type, season, episode }).slice(0, 3)) {
              const candDub = Boolean(post.isDubPost || isDubbedCandidateText(`${cand.label || ''} ${cand.url || ''}`, { preferredAudioLang: prefLang, targetTitle: cleanTitle }));
              const dl = await this.#resolveDownloadHostUrl(cand.url, { minDuration, maxDuration, isTv, preferredAudioLang: prefLang });
              if (dl) {
                const origHit = pickOrSaveDub({
                  ...dl,
                  audioIsDub: Boolean(dl.audioIsDub || candDub),
                  source: 'web_catalog_wp',
                  qualityLabel: extractQualityLabel(cand.label)
                });
                if (origHit) return origHit;
              }
            }
          }
        }
      } catch {}
    }

    // 2. PeerTube Federation (SepiaSearch) full-feature index (zero CF, direct MP4/HLS)
    const peerHit = pickOrSaveDub(await this.#resolveFromPeerTube(opts).catch(() => null));
    if (peerHit) return peerHit;

    // 3. Dailymotion long-form JSON catalog fallback (strict minDuration + zero trailers/games)
    if (this.enableYtDlp) {
      try {
        const epTag = isTv && episode != null
          ? ` S${String(season || 1).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
          : '';
        const dmQuery = `${altClean || cleanTitle}${epTag} ${!isTv && year ? year : ''}`.trim();
        const dmRes = await this.fetchImpl(
          `https://api.dailymotion.com/videos?search=${encodeURIComponent(dmQuery)}&longer_than=20&fields=id,title,duration,url&limit=6`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }
        );
        if (dmRes?.ok && typeof dmRes.json === 'function') {
          const dmData = await dmRes.json();
          const dmCandidates = (Array.isArray(dmData?.list) ? dmData.list : [])
            .filter((v) => {
              if (!v?.url || isTrailerLike(v.title || '', cleanTitle, { isTv, episodeTitle: episodeTitle || '', alternateTitle: altClean })) return false;
              const vDur = Number(v.duration || 0);
              if (vDur < minDuration) return false;
              if (maxDuration && vDur > maxDuration) return false;
              return true;
            })
            .map((v) => ({
              ...v,
              isDub: isDubbedCandidateText(v.title || '', { preferredAudioLang: prefLang, targetTitle: cleanTitle }),
              score: scoreTitleMatch(cleanTitle, year, v.title, { isTv, season, episode, episodeTitle, alternateTitle: altClean, alternateSeason })
            }))
            .filter((v) => v.score >= 22)
            .sort((a, b) => (Number(a.isDub) - Number(b.isDub)) || (b.score - a.score));

          for (const cand of dmCandidates.slice(0, 2)) {
            const ytRes = await this.#extractYtDlpStream(cand.url, { title: cleanTitle, year, isTv, season, episode, episodeTitle, alternateTitle: altClean, alternateSeason, minDuration, maxDuration, strictTitle: true, preferredAudioLang: prefLang });
            const origHit = pickOrSaveDub(ytRes && cand.isDub ? { ...ytRes, audioIsDub: true } : ytRes);
            if (origHit) return origHit;
          }
        }
      } catch {}

      // 4. OK.ru full-length video catalog fallback (guarded by zero-trailer + minDuration in #extractYtDlpStream)
      const okHit = pickOrSaveDub(await this.#resolveFromOkRu(opts).catch(() => null));
      if (okHit) return okHit;
    }

    return dubFallback;
  }

  async #resolveFromPeerTube(opts) {
    const { type, title, year, season, episode, episodeTitle = null, alternateTitle = null, alternateSeason = null, durationSeconds = null, originalLanguage = '' } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = durationSeconds ? Math.max(isTv ? 420 : 1200, Math.floor(Number(durationSeconds) * (isTv ? 0.56 : 0.65))) : (isTv ? 420 : 2100);
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.35)) : 0;
    const cleanTitle = expandCamelCaseText(String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
    const altClean = alternateTitle ? expandCamelCaseText(String(alternateTitle).replace(/\s*\([^)]*\)\s*/g, ' ').trim()) : '';
    if (!cleanTitle) return null;

    const epTag = isTv && episode != null
      ? ` S${String(season || 1).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : '';
    const q = `${altClean || cleanTitle}${epTag}${!isTv && year ? ` ${year}` : ''}`.trim();
    try {
      const searchUrl = `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(q)}&durationMin=${minDuration}&count=8`;
      const res = await this.fetchImpl(searchUrl, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!res?.ok || typeof res.json !== 'function') return null;
      const data = await res.json();
      const rows = (Array.isArray(data?.data) ? data.data : [])
        .filter((v) => {
          if (!v?.uuid || v.isLive || !v.name || isTrailerLike(v.name, cleanTitle, { isTv, episodeTitle: episodeTitle || '', alternateTitle: altClean })) return false;
          const dur = Number(v.duration || 0);
          if (!dur || dur < minDuration) return false;
          if (maxDuration && dur > maxDuration) return false;
          return true;
        })
        .map((v) => ({
          ...v,
          isDub: isDubbedCandidateText(`${v.name || ''} ${v.language?.id || ''}`, { preferredAudioLang: prefLang, targetTitle: cleanTitle }),
          score: scoreTitleMatch(cleanTitle, year, v.name, { isTv, season, episode, episodeTitle, alternateTitle: altClean, alternateSeason })
        }))
        .filter((v) => v.score >= 22)
        .sort((a, b) => (Number(a.isDub) - Number(b.isDub)) || (b.score - a.score));

      let dubFallback = null;
      for (const cand of rows.slice(0, 3)) {
        let origin = '';
        for (const u of [cand.embedUrl, cand.url, cand.account?.url, cand.channel?.url]) {
          if (!u) continue;
          try {
            origin = new URL(u).origin;
            break;
          } catch {}
        }
        if (!origin) continue;
        const vidRes = await this.fetchImpl(`${origin}/api/v1/videos/${encodeURIComponent(cand.uuid)}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(5000)
        }).catch(() => null);
        if (!vidRes?.ok || typeof vidRes.json !== 'function') continue;
        const vid = await vidRes.json();
        const vidLang = normalizeLangCode(vid?.language?.id || cand?.language?.id || '');
        const vidDub = Boolean(cand.isDub || (prefLang && vidLang && vidLang !== prefLang));
        const directFiles = [
          ...(Array.isArray(vid?.files) ? vid.files : []),
          ...(Array.isArray(vid?.streamingPlaylists?.[0]?.files) ? vid.streamingPlaylists[0].files : [])
        ]
          .filter((f) => f?.fileUrl && /^https?:\/\//i.test(f.fileUrl) && !isTrailerLike(f.fileUrl, cleanTitle))
          .sort((a, b) => {
            const ra = Number(a.resolution?.id || 0);
            const rb = Number(b.resolution?.id || 0);
            const prefA = ra <= 720 ? ra : 300;
            const prefB = rb <= 720 ? rb : 300;
            return prefB - prefA;
          });
        const bestFile = directFiles[0];
        if (bestFile?.fileUrl) {
          const probed = await this.#probeHttpStream(bestFile.fileUrl, {}, {
            minDuration,
            maxDuration,
            isTv,
            preferredAudioLang: prefLang
          });
          if (probed) {
            const hit = {
              url: probed.url,
              headers: {},
              format: 'mp4',
              isHls: false,
              durationSeconds: probed.durationSeconds || Number(vid?.duration || cand.duration) || null,
              sizeBytes: Number(bestFile.size || 0) || probed.sizeBytes || null,
              audioLanguage: probed.audioLanguage || vidLang || '',
              audioIsDub: Boolean(probed.audioIsDub || vidDub),
              qualityLabel: bestFile.resolution?.label || extractQualityLabel(bestFile.fileUrl),
              source: 'peertube_sepiasearch'
            };
            if (!hit.audioIsDub) return hit;
            if (!dubFallback) dubFallback = hit;
            continue;
          }
        }
        const hlsUrl = vid?.streamingPlaylists?.[0]?.playlistUrl;
        if (hlsUrl) {
          const hlsCheck = await this.#probeHlsPlaylistAndSegment(hlsUrl, {}, 0, {
            minDuration,
            preferredAudioLang: prefLang,
            isTv
          });
          if (hlsCheck) {
            const hit = {
              url: hlsCheck.url,
              headers: hlsCheck.headers,
              format: 'hls',
              isHls: true,
              durationSeconds: hlsCheck.durationSeconds || Number(cand.duration) || null,
              audioLanguage: hlsCheck.audioLanguage || vidLang || '',
              audioIsDub: Boolean(hlsCheck.audioIsDub || vidDub),
              qualityLabel: hlsCheck.qualityLabel,
              source: 'peertube_sepiasearch'
            };
            if (!hit.audioIsDub) return hit;
            if (!dubFallback) dubFallback = hit;
          }
        }
      }
      if (dubFallback) return dubFallback;
    } catch {}
    return null;
  }

  async #resolveFromOkRu(opts) {
    if (!this.enableYtDlp) return null;
    const { type, title, year, season, episode, episodeTitle = null, alternateTitle = null, alternateSeason = null, durationSeconds = null, originalLanguage = '' } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = durationSeconds ? Math.max(isTv ? 420 : 1200, Math.floor(Number(durationSeconds) * (isTv ? 0.56 : 0.65))) : (isTv ? 420 : 2100);
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.35)) : 0;
    const cleanTitle = expandCamelCaseText(String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
    const altClean = alternateTitle ? expandCamelCaseText(String(alternateTitle).replace(/\s*\([^)]*\)\s*/g, ' ').trim()) : '';
    if (!cleanTitle) return null;

    const epTag = isTv && episode != null
      ? ` S${String(season || 1).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : '';
    const q = `${altClean || cleanTitle}${epTag} ${!isTv && year ? year : ''} ${isTv ? 'full episode' : 'full movie'}`.trim();
    try {
      const res = await this.fetchImpl(`https://m.ok.ru/video?st.cmd=video&st.query=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5500)
      });
      if (!res?.ok || typeof res.text !== 'function') return null;
      const html = await res.text();
      if (!html) return null;
      const seen = new Set();
      const candidates = [];
      for (const m of html.matchAll(/href=["'](\/video\/(\d{6,}))["'][^>]*>([\s\S]{1,220}?)<\/a>/gi)) {
        const videoId = m[2];
        if (!videoId || seen.has(videoId)) continue;
        seen.add(videoId);
        const candTitle = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!candTitle || isTrailerLike(candTitle, cleanTitle, { isTv, episodeTitle: episodeTitle || '', alternateTitle: altClean })) continue;
        const sc = scoreTitleMatch(cleanTitle, year, candTitle, { isTv, season, episode, episodeTitle, alternateTitle: altClean, alternateSeason });
        if (sc >= 22) {
          const isDub = isDubbedCandidateText(candTitle, { preferredAudioLang: prefLang, targetTitle: cleanTitle });
          candidates.push({ url: `https://ok.ru/video/${videoId}`, title: candTitle, score: sc, isDub });
        }
      }
      candidates.sort((a, b) => (Number(a.isDub) - Number(b.isDub)) || (b.score - a.score));
      let dubFallback = null;
      for (const cand of candidates.slice(0, 2)) {
        const ytRes = await this.#extractYtDlpStream(cand.url, {
          title: cleanTitle,
          year,
          isTv,
          season,
          episode,
          episodeTitle,
          alternateTitle: altClean,
          alternateSeason,
          minDuration,
          maxDuration,
          strictTitle: true,
          preferredAudioLang: prefLang
        });
        if (ytRes) {
          const hit = { ...ytRes, audioIsDub: Boolean(ytRes.audioIsDub || cand.isDub), source: 'ok_ru_feature' };
          if (!hit.audioIsDub) return hit;
          if (!dubFallback) dubFallback = hit;
        }
      }
      if (dubFallback) return dubFallback;
    } catch {}
    return null;
  }

  async #resolveFromSocialAdapters(opts) {
    const { type, title, year, season, episode, originalLanguage = '' } = opts;
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = this.#computeVodMinDuration(opts.durationSeconds || 0, { isTv });
    const maxDuration = opts.durationSeconds ? Math.round(Number(opts.durationSeconds) * 1.45) : 0;
    const cleanTitle = String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanTitle || !this.socialAdapters?.catalogSearch) return null;

    const extractMediaFromAdapterResult = async (res, sourceTag, candIsDub = false) => {
      const resTitle = String(res?.title || res?.name || '').trim();
      if (resTitle) {
        if (isTrailerLike(resTitle, cleanTitle)) return null;
        if (scoreTitleMatch(cleanTitle, year, resTitle, { isTv, season, episode }) < 14) return null;
      }
      const resIsDub = Boolean(candIsDub || (resTitle && isDubbedCandidateText(resTitle, { preferredAudioLang: prefLang, targetTitle: cleanTitle })));
      const mediaUrls = [];
      if (typeof res?.url === 'string') mediaUrls.push(res.url);
      if (typeof res?.downloadUrl === 'string') mediaUrls.push(res.downloadUrl);
      if (Array.isArray(res?.sources)) {
        for (const s of res.sources) {
          if (typeof s === 'string') mediaUrls.push(s);
          else if (s?.url) mediaUrls.push(s.url);
        }
      }
      if (Array.isArray(res?.medias)) {
        for (const m of res.medias) {
          if (m?.url) mediaUrls.push(m.url);
        }
      }
      for (const mUrl of mediaUrls) {
        if (!mUrl || AD_OR_BAD_DOMAIN_RE.test(mUrl) || isTrailerLike(mUrl, cleanTitle)) continue;
        const probed = await this.#probeWithRefererVariants(mUrl, { minDuration, maxDuration, isTv, preferredAudioLang: prefLang });
        if (!probed) continue;
        const urlDub = isDubbedCandidateText(mUrl, { preferredAudioLang: prefLang, targetTitle: cleanTitle });
        if (probed.isHls) {
          const hls = await this.#probeHlsPlaylistAndSegment(probed.url, probed.headers, 0, {
            minDuration,
            preferredAudioLang: prefLang,
            isTv
          });
          if (hls) {
            return {
              url: hls.url,
              headers: hls.headers,
              format: 'hls',
              isHls: true,
              durationSeconds: hls.durationSeconds || opts.durationSeconds || null,
              audioLanguage: hls.audioLanguage || '',
              audioIsDub: Boolean(hls.audioIsDub || resIsDub || urlDub),
              qualityLabel: hls.qualityLabel,
              source: sourceTag
            };
          }
        } else if (DIRECT_VIDEO_RE.test(probed.url)) {
          return {
            url: probed.url,
            headers: probed.headers,
            format: /\.mkv(\?|$)/i.test(probed.url) ? 'mkv' : 'mp4',
            isHls: false,
            durationSeconds: probed.durationSeconds || opts.durationSeconds || null,
            sizeBytes: probed.sizeBytes || null,
            audioLanguage: probed.audioLanguage || '',
            audioIsDub: Boolean(probed.audioIsDub || resIsDub || urlDub),
            qualityLabel: extractQualityLabel(probed.url),
            source: sourceTag
          };
        }
      }
      return null;
    };

    const jobs = [
      { provider: 'dramafren', dl: this.socialAdapters.dramafrenDl, tag: 'dramafren' },
      { provider: 'anydrama', dl: this.socialAdapters.anydramaDl, tag: 'anydrama' },
      { provider: 'justwatch', dl: this.socialAdapters.justwatchWatch || this.socialAdapters.justwatchDl, tag: 'justwatch' }
    ];
    let dubFallback = null;
    for (const job of jobs) {
      if (typeof job.dl !== 'function') continue;
      try {
        const searchRes = await Promise.race([
          this.socialAdapters.catalogSearch(job.provider, cleanTitle, { limit: 4 }).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 5000))
        ]);
        const items = Array.isArray(searchRes?.items) ? searchRes.items : (Array.isArray(searchRes?.results) ? searchRes.results : []);
        const ranked = items
          .filter((it) => it?.url && !isTrailerLike(it.title || it.name || '', cleanTitle))
          .map((it) => ({
            ...it,
            isDub: isDubbedCandidateText(it.title || it.name || '', { preferredAudioLang: prefLang, targetTitle: cleanTitle }),
            score: scoreTitleMatch(cleanTitle, year, `${it.title || it.name || ''} ${it.year || ''}`, { isTv, season, episode })
          }))
          .filter((it) => it.score >= 26)
          .sort((a, b) => (Number(a.isDub) - Number(b.isDub)) || (b.score - a.score));
        const best = ranked[0];
        if (!best?.url) continue;
        const resolved = await Promise.race([
          job.dl(best.url).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 6000))
        ]);
        const hit = await extractMediaFromAdapterResult(resolved, `social_${job.tag}`, best.isDub);
        if (hit) {
          if (!hit.audioIsDub) return hit;
          if (!dubFallback) dubFallback = hit;
        }
      } catch {}
    }
    return dubFallback;
  }

  async #defaultYtSearch(query) {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-warnings',
      '--ignore-errors',
      '--js-runtimes', 'node:/usr/bin/node',
      '--dump-single-json',
      '--flat-playlist',
      query
    ], { timeout: 14000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  }

  async #defaultYtExtract(pageUrl) {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-warnings',
      '--js-runtimes', 'node:/usr/bin/node',
      '--extractor-args', 'youtube:player_client=default,web_safari,android',
      '--dump-single-json',
      '-f', 'best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/best[height<=720][acodec!=none][vcodec!=none]/best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
      pageUrl
    ], { timeout: 18000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout || '{}');
  }

  async #extractYtDlpStream(pageUrl, { title, year = null, isTv = false, season = null, episode = null, episodeTitle = null, alternateTitle = null, alternateSeason = null, minDuration = 1800, maxDuration = 0, strictTitle = true, preferredAudioLang = '' } = {}) {
    try {
      const prefLang = normalizeLangCode(preferredAudioLang);
      const info = await this.#defaultYtExtract(pageUrl);
      const filterOpts = { isTv, episodeTitle: episodeTitle || '', alternateTitle: alternateTitle || '' };
      if (!info || isTrailerLike(info.title || '', title, filterOpts)) return null;
      const dur = Number(info.duration || 0);
      if (!dur || dur < minDuration) return null;
      if (maxDuration && dur > maxDuration) return null;
      if (strictTitle && scoreTitleMatch(title, year, info.title, { isTv, season, episode, episodeTitle, alternateTitle, alternateSeason }) < 22) return null;
      const url = info.url || info.requested_downloads?.[0]?.url;
      if (!url || !/^https?:\/\//i.test(url)) return null;
      if (info.vcodec === 'none' || info.acodec === 'none') return null;
      const ytLang = normalizeLangCode(info.language || '');
      const titleIsDub = isDubbedCandidateText(info.title || '', { preferredAudioLang: prefLang, targetTitle: title });
      const langMismatch = Boolean(prefLang && ytLang && ytLang !== prefLang);
      return {
        url,
        headers: info.http_headers || {},
        format: info.ext || 'mp4',
        durationSeconds: Math.round(dur),
        audioLanguage: ytLang || '',
        audioIsDub: Boolean(titleIsDub || langMismatch),
        qualityLabel: info.height ? `${info.height}p` : 'HD',
        source: 'web_ytdlp_full'
      };
    } catch {
      return null;
    }
  }

  async #resolveFromYtDlpFullSearch(opts) {
    const {
      type,
      title,
      year,
      season,
      episode,
      episodeTitle = null,
      alternateTitle = null,
      alternateSeason = null,
      durationSeconds = null,
      originalLanguage = '',
      excludeUrls = []
    } = opts;
    const excludeSet = new Set(Array.isArray(excludeUrls) ? excludeUrls.filter(Boolean) : []);
    const isTv = String(type).toLowerCase() === 'tv';
    const prefLang = normalizeLangCode(originalLanguage);
    const minDuration = durationSeconds
      ? (this.#computeVodMinDuration(durationSeconds, { isTv }) || (isTv ? 420 : 1200))
      : (isTv ? 720 : (this.ytSearchFn ? 2100 : 3000));
    const maxDuration = durationSeconds ? Math.round(Number(durationSeconds) * (isTv ? 1.45 : 1.30)) : 0;
    const cleanTitle = String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanTitle) return null;

    const spacedTitle = expandCamelCaseText(cleanTitle);
    const spacedAlt = alternateTitle ? expandCamelCaseText(String(alternateTitle).replace(/\s*\([^)]*\)\s*/g, ' ').trim()) : '';
    const cleanEp = String(episodeTitle || '').replace(/\s*\(\d{1,2}\)\s*$/g, '').replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    const sPad = String(season ?? 1).padStart(2, '0');
    const ePad = String(episode ?? 1).padStart(2, '0');

    const queriesToRun = [];
    if (isTv && episode != null) {
      const leadTitle = spacedAlt || spacedTitle;
      queriesToRun.push(`ytsearch8:${leadTitle}${cleanEp ? ` ${cleanEp}` : ''} Episode ${episode}`);
      queriesToRun.push(`ytsearch8:${spacedTitle} S${sPad}E${ePad} full episode`);
      if (spacedAlt && spacedAlt !== leadTitle) {
        queriesToRun.push(`ytsearch8:${spacedAlt} ${cleanEp || `Episode ${episode}`}`);
      }
      if (alternateSeason != null && Number(alternateSeason) !== Number(season ?? 1)) {
        const altPad = String(alternateSeason).padStart(2, '0');
        queriesToRun.push(`ytsearch8:${leadTitle} S${altPad}E${ePad} full episode`);
      }
    } else {
      queriesToRun.push(`ytsearch8:${spacedTitle} ${year || ''} full movie`.trim());
      if (year) queriesToRun.push(`ytsearch8:${spacedTitle} full movie`);
    }
    const uniqueQueries = [...new Set(queriesToRun)].slice(0, this.ytSearchFn ? 2 : 3);

    const searchRunner = this.ytSearchFn || ((q) => this.#defaultYtSearch(q));
    const filterOpts = { isTv, episodeTitle: episodeTitle || '', alternateTitle: spacedAlt };
    const mapRank = (e, minScore) => {
      if (!e?.url && !e?.webpage_url && !e?.directStreamUrl) return null;
      if (isTrailerLike(e.title || '', cleanTitle, filterOpts) || isNonFeatureOrClipTitle(e.title || '', cleanTitle, filterOpts) || isSplitPartTitle(e.title || '', cleanTitle, filterOpts)) return null;
      const dur = Number(e.duration || 0);
      if (!dur) return null;
      const sc = scoreTitleMatch(cleanTitle, year, e.title, {
        isTv,
        season,
        episode,
        episodeTitle,
        alternateTitle: spacedAlt,
        alternateSeason
      });
      if (sc < minScore) return null;
      const isDub = isDubbedCandidateText(e.title || '', { preferredAudioLang: prefLang, targetTitle: cleanTitle });
      return { entry: e, dur, sc, isDub };
    };

    const effectiveMinDur = minDuration;
    let dubFallback = null;
    const origHits = [];
    const seenCandKeys = new Set();

    for (const q of uniqueQueries) {
      let entries = [];
      try {
        entries = await searchRunner(q);
      } catch {
        continue;
      }
      const candidates = (Array.isArray(entries) ? entries : [])
        .map((e) => mapRank(e, 22))
        .filter((x) => x && x.dur >= minDuration && (!maxDuration || x.dur <= maxDuration))
        .sort((a, b) => (Number(a.isDub) - Number(b.isDub)) || (b.sc - a.sc));

      for (const { entry: cand, isDub } of candidates.slice(0, 4)) {
        const keyUrl = cand.webpage_url || cand.url || cand.directStreamUrl;
        if (!keyUrl || seenCandKeys.has(keyUrl)) continue;
        seenCandKeys.add(keyUrl);

        let hit = null;
        if (cand.directStreamUrl) {
          if (excludeSet.has(cand.directStreamUrl)) continue;
          hit = {
            url: cand.directStreamUrl,
            headers: cand.headers || {},
            format: cand.ext || 'mp4',
            durationSeconds: Math.round(Number(cand.duration)),
            audioLanguage: '',
            audioIsDub: Boolean(isDub),
            qualityLabel: cand.qualityLabel || 'HD',
            source: 'web_ytdlp_full'
          };
        } else {
          const extracted = await this.#extractYtDlpStream(cand.webpage_url || cand.url, {
            title: cleanTitle,
            year,
            isTv,
            season,
            episode,
            episodeTitle,
            alternateTitle: spacedAlt,
            alternateSeason,
            minDuration: effectiveMinDur,
            maxDuration,
            preferredAudioLang: prefLang
          });
          if (extracted && !excludeSet.has(extracted.url)) {
            hit = { ...extracted, audioIsDub: Boolean(extracted.audioIsDub || isDub) };
          }
        }
        if (hit && !excludeSet.has(hit.url)) {
          if (!hit.audioIsDub) {
            if (!origHits.some((h) => h.url === hit.url)) origHits.push(hit);
            if (origHits.length >= 2) break;
          } else if (!dubFallback) {
            dubFallback = hit;
          }
        }
      }
      if (origHits.length > 0) break;
    }

    if (origHits.length) {
      return {
        ...origHits[0],
        fallbackStreams: origHits.slice(1, 3)
      };
    }
    return dubFallback;
  }

  async resolve(opts = {}, extra = {}) {
    const {
      type = 'movie',
      id,
      title,
      year = null,
      releaseDate: rawReleaseDate = null,
      season = null,
      episode = null,
      episodeTitle = null,
      durationSeconds = null,
      artwork = null,
      imdbId = null,
      rating = null,
      genres = null,
      overview = null,
      fetchSubtitles = true,
      preferredHeight: rawPreferredHeight = null,
      allowAdultFeatures: rawAllowAdultFeatures = null,
      isAdultHint = false
    } = opts;
    const allowAdultFeatures = Boolean(rawAllowAdultFeatures ?? extra.allowAdultFeatures ?? false);
    const rawExclude = Array.isArray(opts.excludeUrls) ? opts.excludeUrls : (Array.isArray(extra?.excludeUrls) ? extra.excludeUrls : []);
    const excludeSet = new Set(rawExclude.filter(Boolean));
    const directDownloadUrls = Array.isArray(opts.downloadUrls) ? opts.downloadUrls : (Array.isArray(extra?.downloadUrls) ? extra.downloadUrls : []);
    const preferredHeight = Number(rawPreferredHeight || extra?.preferredHeight || 0) || null;
    const emit = typeof opts.onProgress === 'function'
      ? opts.onProgress
      : (typeof extra?.onProgress === 'function' ? extra.onProgress : () => {});

    const isTv = String(type).toLowerCase() === 'tv';
    const effectiveSeasonArg = isTv ? (season == null ? 1 : Number(season)) : null;
    let playback = null;
    let detailMeta = null;
    let epMeta = null;
    let resolvedTmdbId = opts.tmdbId || (/^\d+$/.test(String(id || '')) ? String(id) : null);
    let franchiseTmdbId = opts.franchiseTmdbId || null;
    let franchiseTitle = opts.franchiseTitle || null;
    let franchiseSeasonNumber = opts.franchiseSeasonNumber ?? null;
    let franchiseSeasonName = opts.franchiseSeasonName || opts.seasonName || null;

    if (this.movieApi && id) {
      const needDetail = !year || !imdbId || !rawReleaseDate || !opts.originalLanguage || (!durationSeconds && !isTv);
      const isGenericEpTitle = !episodeTitle || /^episode\s*\d+$/i.test(String(episodeTitle).trim());
      const needEpMeta = isTv && episode != null && (isGenericEpTitle || !durationSeconds) && typeof this.movieApi.getTvSeasonEpisodes === 'function';
      const [pbRes, dtRes, epRes, mapRes] = await Promise.allSettled([
        this.movieApi.getPlaybackInfo?.(isTv ? 'tv' : 'movie', id, { season: effectiveSeasonArg, episode, title, year, imdbId }),
        needDetail ? (isTv ? this.movieApi.getTvShow?.(id) : this.movieApi.getMovie?.(id)) : Promise.resolve(null),
        needEpMeta ? this.movieApi.getTvSeasonEpisodes(id, effectiveSeasonArg) : Promise.resolve(null),
        (!resolvedTmdbId && typeof this.movieApi.resolveNumericTmdbInfo === 'function')
          ? this.movieApi.resolveNumericTmdbInfo({ id, imdbId, type: isTv ? 'tv' : 'movie', title, year })
          : Promise.resolve(null)
      ]);
      if (pbRes.status === 'fulfilled') playback = pbRes.value || null;
      else this.log?.debug?.({ err: pbRes.reason?.message, id }, 'movie playback info unavailable');
      if (dtRes.status === 'fulfilled' && dtRes.value && (!dtRes.value.id || String(dtRes.value.id) === String(id))) {
        detailMeta = dtRes.value;
      }
      if (epRes.status === 'fulfilled' && Array.isArray(epRes.value?.episodes)) {
        epMeta = epRes.value.episodes.find((ep) => Number(ep?.episodeNumber) === Number(episode)) || null;
      }
      if (mapRes.status === 'fulfilled' && mapRes.value) {
        if (!resolvedTmdbId && mapRes.value.tmdbId) resolvedTmdbId = String(mapRes.value.tmdbId);
        if (!franchiseTmdbId && mapRes.value.franchiseTmdbId) {
          franchiseTmdbId = mapRes.value.franchiseTmdbId;
          franchiseTitle = mapRes.value.franchiseTitle || franchiseTitle;
          franchiseSeasonNumber = mapRes.value.franchiseSeasonNumber ?? franchiseSeasonNumber;
          franchiseSeasonName = mapRes.value.franchiseSeasonName || franchiseSeasonName;
        }
      }
      if (!resolvedTmdbId && detailMeta?.tmdbId) resolvedTmdbId = String(detailMeta.tmdbId);
      if (!franchiseTmdbId && detailMeta?.franchiseTmdbId) {
        franchiseTmdbId = detailMeta.franchiseTmdbId;
        franchiseTitle = detailMeta.franchiseTitle || franchiseTitle;
        franchiseSeasonNumber = detailMeta.franchiseSeasonNumber ?? franchiseSeasonNumber;
        franchiseSeasonName = detailMeta.franchiseSeasonName || franchiseSeasonName;
      }
    }

    const effectiveEpisodeTitle = (
      episodeTitle && !/^episode\s*\d+$/i.test(String(episodeTitle).trim())
        ? episodeTitle
        : (epMeta?.title && !/^episode\s*\d+$/i.test(String(epMeta.title).trim()) ? epMeta.title : episodeTitle)
    ) || null;
    const effectiveOriginalTitle = opts.originalTitle || extra?.originalTitle || detailMeta?.originalTitle || detailMeta?.original_title || null;
    const effectiveYear = year ?? detailMeta?.year ?? null;
    const effectiveReleaseDate = rawReleaseDate ?? detailMeta?.releaseDate ?? playback?.releaseDate ?? null;
    const effectiveImdbId = imdbId ?? detailMeta?.imdbId ?? null;
    const effectiveArtwork = artwork || epMeta?.still || detailMeta?.poster || detailMeta?.backdrop || null;
    const effectiveDurationSeconds = durationSeconds ?? epMeta?.runtimeSeconds ?? detailMeta?.runtimeSeconds ?? detailMeta?.durationSeconds ?? null;
    const effectiveRating = rating ?? detailMeta?.rating ?? null;
    const effectiveGenres = Array.isArray(genres) && genres.length ? genres : (Array.isArray(detailMeta?.genres) ? detailMeta.genres : null);
    const effectiveOverview = overview || epMeta?.overview || detailMeta?.overview || null;
    const effectiveOriginalLanguage = normalizeLangCode(
      opts.originalLanguage || extra?.originalLanguage || detailMeta?.originalLanguage || playback?.originalLanguage || detailMeta?.language || ''
    );
    const alternateTitle = (franchiseTitle && franchiseSeasonName && !String(franchiseSeasonName).toLowerCase().startsWith('season '))
      ? (String(franchiseTitle).toLowerCase().replace(/[^a-z0-9]/g, '') === String(franchiseSeasonName).toLowerCase().replace(/[^a-z0-9]/g, '')
        ? franchiseTitle
        : `${franchiseTitle} ${franchiseSeasonName}`)
      : (franchiseSeasonName && !/^season\s*\d+$/i.test(franchiseSeasonName) ? `${title} ${franchiseSeasonName}` : null);
    const alternateSeason = franchiseSeasonNumber != null ? Number(franchiseSeasonNumber) : null;

    if (this.movieApi && !playback?.rootStream && (resolvedTmdbId || franchiseTmdbId) && !/^\d+$/.test(String(id || ''))) {
      const pbId = franchiseTmdbId || resolvedTmdbId;
      const pbSeason = franchiseTmdbId && alternateSeason != null && Number(effectiveSeasonArg) === 1
        ? alternateSeason
        : effectiveSeasonArg;
      playback = await this.movieApi.getPlaybackInfo?.(isTv ? 'tv' : 'movie', pbId, { season: pbSeason, episode }).catch(() => playback);
    }

    // 1. Primary Root Streams & TMDB Direct Stream Network (HTTP 200/206 or verified HLS)
    emit('⏳ [1/5] Checking primary HD stream route…');
    let resolvedStream = null;
    let dubFallbackStream = null;
    let dubFallbackSubHints = [];
    let tmdbSubtitleHints = [];
    const fallbackPool = [];
    const fallbackSeen = new Set();
    const pushFallbackStream = (s) => {
      if (!s?.url || excludeSet.has(s.url) || fallbackSeen.has(s.url) || s.audioIsDub) return;
      fallbackSeen.add(s.url);
      fallbackPool.push(s);
    };
    const pushFallbacks = (arr) => {
      if (Array.isArray(arr)) arr.forEach(pushFallbackStream);
    };
    const acceptCandidate = (candidate, okMsg, subHints = []) => {
      if (!candidate?.url || excludeSet.has(candidate.url)) return false;
      if (candidate.audioIsDub) {
        if (!dubFallbackStream) {
          dubFallbackStream = candidate;
          if (subHints.length) dubFallbackSubHints = subHints;
        }
        return false;
      }
      pushFallbacks(candidate.fallbackStreams);
      if (resolvedStream) {
        if (candidate.url !== resolvedStream.url) pushFallbackStream(candidate);
        return false;
      }
      resolvedStream = candidate;
      if (subHints.length && !tmdbSubtitleHints.length) tmdbSubtitleHints = subHints;
      if (okMsg) emit(okMsg);
      return true;
    };
    const root = playback?.rootStream;
    const effectiveMinDuration = Number(
      effectiveDurationSeconds
      || (root?.duration_ms ? Math.round(Number(root.duration_ms) / 1000) : 0)
      || 0
    );
    const titleFilterOpts = { isTv, episodeTitle: effectiveEpisodeTitle || '', alternateTitle: alternateTitle || '' };
    if (root) {
      const rootLang = normalizeLangCode(root.language || root.audioLanguage || root.lang || '');
      const rootExplicitDub = Boolean(root.dub || root.isDub || isDubAudioLabel(root.label || root.name || ''));
      const candidateUrls = [root.hls_url, root.direct_url].filter(Boolean);
      for (const candUrl of candidateUrls) {
        if (excludeSet.has(candUrl) || isTrailerLike(candUrl, title, titleFilterOpts) || isNonFeatureOrClipTitle(candUrl, title, titleFilterOpts)) continue;
        const probed = await this.#probeWithRefererVariants(candUrl, { minDuration: effectiveMinDuration, isTv, preferredAudioLang: effectiveOriginalLanguage });
        if (probed && !excludeSet.has(probed.url)) {
          if (probed.isHls) {
            const hlsVerified = await this.#probeHlsPlaylistAndSegment(probed.url, probed.headers, 0, {
              minDuration: effectiveMinDuration,
              preferredHeight,
              preferredAudioLang: effectiveOriginalLanguage,
              isTv
            });
            if (!hlsVerified || excludeSet.has(hlsVerified.url)) continue;
            const rootQ = extractQualityLabel(root.quality?.resolution || root.quality?.video_codec);
            const hlsLang = hlsVerified.audioLanguage || rootLang;
            const isDub = Boolean(
              hlsVerified.audioIsDub
              || rootExplicitDub
              || (effectiveOriginalLanguage && hlsLang && hlsLang !== effectiveOriginalLanguage)
            );
            const candStream = {
              url: hlsVerified.url,
              headers: hlsVerified.headers,
              format: 'hls',
              isHls: true,
              isDash: false,
              durationSeconds: root.duration_ms ? Math.round(root.duration_ms / 1000) : (hlsVerified.durationSeconds || effectiveDurationSeconds),
              qualityLabel: hlsVerified.qualityLabel !== 'HD' ? hlsVerified.qualityLabel : rootQ,
              sizeBytes: root.size_bytes || hlsVerified.sizeBytes || null,
              variants: hlsVerified.variants || null,
              subtitleHints: hlsVerified.subtitleHints || [],
              audioLanguage: hlsLang || effectiveOriginalLanguage || '',
              audioIsDub: isDub,
              source: 'movie_api_root'
            };
            acceptCandidate(candStream, `✅ [1/5] Primary HD stream ready (${candStream.qualityLabel})`);
          } else {
            const urlDub = isDubAudioLabel(candUrl)
              || /(?:^|[/?&._-])(?:eng(?:lish)?[-_ ]?dub|dubbed)(?:$|[/?&._=-])/i.test(candUrl)
              || isDubbedCandidateText(candUrl, { preferredAudioLang: effectiveOriginalLanguage, targetTitle: title });
            const detLang = probed.audioLanguage || rootLang;
            const isDub = Boolean(
              probed.audioIsDub
              || rootExplicitDub
              || urlDub
              || (effectiveOriginalLanguage && detLang && detLang !== effectiveOriginalLanguage)
            );
            const candStream = {
              url: probed.url,
              headers: probed.headers,
              format: root.container || 'mp4',
              isHls: false,
              isDash: false,
              durationSeconds: probed.durationSeconds || (root.duration_ms ? Math.round(root.duration_ms / 1000) : effectiveDurationSeconds),
              sizeBytes: root.size_bytes || probed.sizeBytes || null,
              qualityLabel: extractQualityLabel(root.quality?.resolution || root.quality?.video_codec),
              audioLanguage: detLang || effectiveOriginalLanguage || '',
              audioIsDub: isDub,
              source: 'movie_api_root'
            };
            acceptCandidate(candStream, `✅ [1/5] Primary HD stream ready (${candStream.qualityLabel})`);
          }
        }
      }
    }
    let netRes = null;
    if (!resolvedStream) {
      emit('⏳ [1/5] Primary route unavailable — checking alternate HD routes…');
      const netTargetId = franchiseTmdbId && alternateSeason != null && Number(effectiveSeasonArg) === 1
        ? franchiseTmdbId
        : (resolvedTmdbId || id);
      const netTargetSeason = franchiseTmdbId && alternateSeason != null && Number(effectiveSeasonArg) === 1
        ? alternateSeason
        : effectiveSeasonArg;
      const netTargetTitle = franchiseTmdbId && franchiseTitle ? franchiseTitle : title;
      netRes = await this.#resolveFromTmdbStreamNetwork({
        type,
        id: netTargetId,
        tmdbId: netTargetId,
        imdbId: effectiveImdbId,
        title: netTargetTitle,
        originalTitle: effectiveOriginalTitle,
        year: effectiveYear,
        season: netTargetSeason,
        episode,
        episodeTitle: effectiveEpisodeTitle,
        durationSeconds: effectiveMinDuration || effectiveDurationSeconds,
        preferredHeight,
        preferredAudioLang: effectiveOriginalLanguage,
        excludeUrls: [...excludeSet]
      }).catch(() => ({ stream: null, subtitleHints: [], fallbackStreams: [] }));
      pushFallbacks(netRes?.fallbackStreams);
      if (netRes?.stream) {
        const netHints = Array.isArray(netRes?.subtitleHints) ? netRes.subtitleHints : [];
        if (!netRes.stream.audioIsDub) {
          acceptCandidate(netRes.stream, `✅ [1/5] Alternate HD stream ready (${netRes.stream.qualityLabel || 'HD'})`, netHints);
        } else {
          acceptCandidate(netRes.stream, null, netHints);
          emit('⏳ [1/5] Only dubbed HD route found — checking remaining sources for original audio…');
        }
      } else if (dubFallbackStream) {
        emit('⏳ [1/5] Only dubbed root route found — checking remaining sources for original audio…');
      }
    }

    // 1.2 Optional Debrid Stremio/Torrentio cached HTTPS stream when operator configures debrid key
    if (!resolvedStream && effectiveImdbId && (this.realDebridKey || this.allDebridKey || this.premiumizeKey)) {
      const debHit = await this.#resolveFromTorrentioDebrid({
        imdbId: effectiveImdbId,
        isTv,
        season: effectiveSeasonArg,
        episode,
        title,
        durationSeconds: effectiveMinDuration || effectiveDurationSeconds,
        preferredAudioLang: effectiveOriginalLanguage,
        excludeSet
      }).catch(() => null);
      acceptCandidate(debHit, debHit ? `✅ [1/5] Cached HD stream ready (${debHit.qualityLabel || 'HD'})` : null);
    }

    // 1.5 Explicit direct download URLs from WordPress/Nkiri catalog metadata
    if (!resolvedStream && directDownloadUrls.length) {
      for (const dlUrl of directDownloadUrls.slice(0, 3)) {
        if (excludeSet.has(dlUrl) || isTrailerLike(dlUrl, title) || isNonFeatureOrClipTitle(dlUrl, title)) continue;
        const directRes = await this.#resolveDownloadHostUrl(dlUrl, {
          allowUnprobedMock: this.fetchImpl !== fetch,
          minDuration: effectiveMinDuration,
          isTv,
          preferredAudioLang: effectiveOriginalLanguage
        });
        if (directRes && !excludeSet.has(directRes.url)) {
          const dlDub = Boolean(directRes.audioIsDub || isDubbedCandidateText(dlUrl, { preferredAudioLang: effectiveOriginalLanguage, targetTitle: title }));
          const cand = { ...directRes, audioIsDub: dlDub, source: 'thenkiri_downloadwella', qualityLabel: extractQualityLabel(dlUrl) };
          if (acceptCandidate(cand, `✅ [1.5/5] Direct HD download stream ready (${cand.qualityLabel || 'HD'})`)) break;
        }
      }
    }

    // 2. Primary Web Catalog (Zero-Trailer, direct MKV/MP4)
    if (!resolvedStream && title) {
      if (this.enableWebFallback || this.hasCustomThenkiri) {
        emit('🔎 [2/5] Searching HD feature stream index…');
        const tkHit = await this.#resolveFromThenkiriCatalog({
          type,
          title,
          year: effectiveYear,
          season,
          episode,
          episodeTitle: effectiveEpisodeTitle,
          alternateTitle,
          alternateSeason,
          durationSeconds: effectiveDurationSeconds,
          originalLanguage: effectiveOriginalLanguage
        });
        acceptCandidate(tkHit, tkHit ? `✅ [2/5] HD feature stream ready (${tkHit.qualityLabel || 'HD'})` : null);
      }
      if (!resolvedStream && (this.enableWebFallback || this.hasCustomSocialAdapters)) {
        const socHit = await this.#resolveFromSocialAdapters({
          type,
          title,
          year: effectiveYear,
          season,
          episode,
          episodeTitle: effectiveEpisodeTitle,
          alternateTitle,
          alternateSeason,
          durationSeconds: effectiveDurationSeconds,
          originalLanguage: effectiveOriginalLanguage
        });
        acceptCandidate(socHit, socHit ? `✅ [2/5] HD feature stream ready (${socHit.qualityLabel || 'HD'})` : null);
      }
    }

    // 3. Extended Catalog Index
    if (!resolvedStream && this.enableWebFallback && title) {
      emit('🔎 [3/5] Scanning extended HD stream index…');
      const ngHit = await this.#resolveFromThenkiriNg({
        type,
        title,
        year: effectiveYear,
        season,
        episode,
        episodeTitle: effectiveEpisodeTitle,
        alternateTitle,
        alternateSeason,
        durationSeconds: effectiveDurationSeconds,
        originalLanguage: effectiveOriginalLanguage
      });
      acceptCandidate(ngHit, ngHit ? `✅ [3/5] Extended HD stream ready (${ngHit.qualityLabel || 'HD'})` : null);
    }

    // 4. Open Feature Index
    if (!resolvedStream && this.enableWebFallback && title) {
      emit('🔎 [4/5] Searching web full-feature catalog…');
      const archHit = await this.#resolveFromArchiveOrg({
        id,
        type,
        title,
        originalTitle: effectiveOriginalTitle,
        year: effectiveYear,
        durationSeconds: effectiveDurationSeconds,
        season: effectiveSeasonArg,
        episode,
        episodeTitle: effectiveEpisodeTitle,
        alternateTitle,
        alternateSeason,
        originalLanguage: effectiveOriginalLanguage,
        excludeUrls: [...excludeSet]
      });
      if (!acceptCandidate(archHit, archHit ? `✅ [4/5] Full-feature stream ready (${archHit.qualityLabel || 'HD'})` : null)) {
        const openHit = await this.#resolveFromOpenWebSearch({
          type,
          title,
          year: effectiveYear,
          season: effectiveSeasonArg,
          episode,
          episodeTitle: effectiveEpisodeTitle,
          alternateTitle,
          alternateSeason,
          durationSeconds: effectiveDurationSeconds,
          originalLanguage: effectiveOriginalLanguage
        });
        acceptCandidate(openHit, openHit ? `✅ [4/5] Full-feature stream ready (${openHit.qualityLabel || 'HD'})` : null);
      }
    }

    // Fast-path 18+ Full Features first when Wikidata/TMDB flagged adult hint & caller allows NSFW features
    if (!resolvedStream && allowAdultFeatures && isAdultHint && this.adultCatalog && !isTv && title) {
      emit('🔞 [5/5] Resolving 18+ Full-Feature Cinema stream…');
      const adultHit = await this.adultCatalog.resolveFeatureMatch({
        title,
        year: effectiveYear,
        preferredHeight: Number(rawPreferredHeight ?? extra.preferredHeight) || 720
      }).catch(() => null);
      acceptCandidate(adultHit, adultHit ? `✅ [5/5] Verified 18+ feature stream (${adultHit.qualityLabel || 'HD'})` : null);
    }

    // 5. Full-Length Video Stream Verification (STRICT Zero-Trailer & min runtime guard)
    if (!resolvedStream && this.enableYtDlp && title) {
      emit('🎬 [5/5] Scanning full-length video streams (zero-trailer filter)…');
      const ytHit = await this.#resolveFromYtDlpFullSearch({
        type,
        title,
        year: effectiveYear,
        season: effectiveSeasonArg,
        episode,
        episodeTitle: effectiveEpisodeTitle,
        alternateTitle,
        alternateSeason,
        durationSeconds: effectiveDurationSeconds,
        originalLanguage: effectiveOriginalLanguage,
        excludeUrls: [...excludeSet]
      });
      acceptCandidate(ytHit, ytHit ? `✅ [5/5] Verified full-length stream (${ytHit.qualityLabel || 'HD'})` : null);
    }

    // 5.5 18+ Full-Feature Cinema Fallback (DM / NSFW-enabled chats only)
    if (!resolvedStream && allowAdultFeatures && this.adultCatalog && !isTv && title) {
      emit('🔞 [5.5] Scanning 18+ Cinema & Full Feature providers…');
      const adultFallbackHit = await this.adultCatalog.resolveFeatureMatch({
        title,
        year: effectiveYear,
        preferredHeight: Number(rawPreferredHeight ?? extra.preferredHeight) || 720
      }).catch(() => null);
      acceptCandidate(adultFallbackHit, adultFallbackHit ? `✅ [5.5] Verified 18+ feature stream (${adultFallbackHit.qualityLabel || 'HD'})` : null);
    }

    // Only promote dubbed fallback AFTER all original-audio steps have been exhausted
    if (!resolvedStream && dubFallbackStream && !excludeSet.has(dubFallbackStream.url) && !opts.requireOriginalAudio) {
      resolvedStream = {
        ...dubFallbackStream,
        audioIsDub: true,
        dubOnly: true,
        dubOnlyWarning: '⚠️ Dub Only Available'
      };
      if (!tmdbSubtitleHints.length && dubFallbackSubHints.length) {
        tmdbSubtitleHints = dubFallbackSubHints;
      }
      emit(`⚠️ No original audio source found — playing dubbed stream (${resolvedStream.qualityLabel || 'HD'})`);
    }

    // 6. Sync Subtitles (.srt/.vtt) asynchronously when stream resolves
    let subtitleInfo = null;
    if (resolvedStream && fetchSubtitles && this.subtitles) {
      emit('💬 [Subs] Matching & syncing subtitles…');
      const allowApiSubs = resolvedStream.source === 'movie_api_root' || resolvedStream.source === 'movie_tmdb_stream' || resolvedStream.source === 'movie_vidbolt';
      const streamScopedHints = this.#normalizeSubList(
        Array.isArray(resolvedStream.subtitleHints) ? resolvedStream.subtitleHints : [],
        { headers: resolvedStream.headers || CINEMA_PLAYER_HEADERS }
      );
      let extraApiSubs = [];
      const subTmdbId = netRes?.discoveredTmdbId || resolvedTmdbId || franchiseTmdbId || (/^\d+$/.test(String(id || '')) ? id : null);
      const subSeasonArg = (franchiseTmdbId && alternateSeason != null && Number(effectiveSeasonArg) === 1 && String(subTmdbId) === String(franchiseTmdbId))
        ? alternateSeason
        : effectiveSeasonArg;
      if (allowApiSubs && subTmdbId) {
        extraApiSubs = await this.#fetchTmdbSubtitleHints({ isTv, tmdbId: subTmdbId, season: subSeasonArg, episode }).catch(() => []);
      }
      const playbackApiSubs = (allowApiSubs && Array.isArray(playback?.subtitles))
        ? this.#normalizeSubList(playback.subtitles, { headers: CINEMA_PLAYER_HEADERS })
        : [];
      const tmdbMetaSubs = allowApiSubs
        ? tmdbSubtitleHints.map((h) => ({ ...h, tier: h?.tier || 'meta_match' }))
        : [];
      const mergedHints = [
        ...streamScopedHints,
        ...playbackApiSubs,
        ...tmdbMetaSubs,
        ...extraApiSubs
      ];
      subtitleInfo = await this.subtitles.resolveForMedia({
        type: isTv ? 'tv' : (type || 'movie'),
        id,
        tmdbId: subTmdbId,
        imdbId: effectiveImdbId,
        title,
        year: effectiveYear,
        season: effectiveSeasonArg,
        episode,
        streamUrl: resolvedStream.url,
        headers: resolvedStream.headers,
        streamSource: resolvedStream.source,
        subtitleHints: mergedHints,
        durationSeconds: Number(resolvedStream.durationSeconds || effectiveDurationSeconds || 0) || null,
        releaseHint: `${resolvedStream.qualityLabel || ''} ${resolvedStream.url || ''}`.trim()
      }).catch(() => null);
      if (subtitleInfo?.filePath || subtitleInfo?.found) {
        const subLang = subtitleInfo.label
          || (subtitleInfo.language && String(subtitleInfo.language).toLowerCase() !== 'eng'
            ? `${String(subtitleInfo.language).toUpperCase()} Subtitles`
            : 'English Subtitles');
        const trackCount = Array.isArray(subtitleInfo.tracks) ? subtitleInfo.tracks.length : 1;
        emit(`✅ [Subs] Synced: ${subLang}${trackCount > 1 ? ` (${trackCount} tracks)` : ''}`);
      } else {
        emit('ℹ️ [Subs] No external subtitles matched — streaming clean video.');
      }
    }

    if (!resolvedStream) {
      let releaseDate = effectiveReleaseDate || null;
      if (!releaseDate && this.movieApi && id && !detailMeta) {
        const detail = await (isTv ? this.movieApi.getTvShow?.(id) : this.movieApi.getMovie?.(id))?.catch?.(() => null);
        releaseDate = detail?.releaseDate || null;
      }
      const relStr = releaseDate ? String(releaseDate).slice(0, 10) : '';
      const todayStr = new Date().toISOString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(relStr) && relStr > todayStr) {
        emit(`❌ Upcoming release (${relStr}) — full stream isn't released yet.`);
        return {
          ok: false,
          track: null,
          playback,
          subtitles: null,
          webappUrl: null,
          reason: `"${title || 'This title'}" releases on ${relStr} — full stream isn't available yet.`
        };
      }
      emit('❌ No playable full-length feature stream found for this title.');
      return {
        ok: false,
        track: null,
        playback,
        subtitles: null,
        webappUrl: null,
        reason: 'No playable non-trailer full stream found for this title.'
      };
    }

    const displayTitle = isTv && episode != null
      ? `${title} · S${String(effectiveSeasonArg ?? 1).padStart(2, '0')}E${String(episode).padStart(2, '0')}${effectiveEpisodeTitle ? ` — ${effectiveEpisodeTitle}` : ''}`
      : `${title}${effectiveYear ? ` (${effectiveYear})` : ''}`;

    const qualityTag = extractQualityLabel(resolvedStream.qualityLabel, resolvedStream.format);
    const metaSubtitle = isTv && episode != null
      ? `${effectiveYear ? `${effectiveYear} · ` : ''}S${String(effectiveSeasonArg ?? 1).padStart(2, '0')}E${String(episode).padStart(2, '0')} · ${qualityTag}`
      : `${effectiveYear ? `${effectiveYear} · ` : ''}Feature Film · ${qualityTag}`;

    const isDash = Boolean(resolvedStream.isDash || resolvedStream.format === 'dash' || /\.mpd(\?|$)/i.test(resolvedStream.url));
    const isHls = !isDash && Boolean(resolvedStream.isHls || resolvedStream.format === 'hls' || /\.m3u8(\?|$)/i.test(resolvedStream.url));
    const cleanFallbacks = fallbackPool
      .filter((f) => f?.url && f.url !== resolvedStream.url && !excludeSet.has(f.url))
      .slice(0, 3)
      .map((f, idx) => {
        const fDash = Boolean(f.isDash || f.format === 'dash' || /\.mpd(\?|$)/i.test(f.url));
        const fHls = !fDash && Boolean(f.isHls || f.format === 'hls' || /\.m3u8(\?|$)/i.test(f.url));
        return {
          url: f.url,
          headers: f.headers || {},
          format: f.format || (fDash ? 'dash' : fHls ? 'hls' : 'mp4'),
          isHls: fHls,
          isDash: fDash,
          durationSeconds: f.durationSeconds || null,
          sizeBytes: f.sizeBytes || null,
          qualityLabel: f.qualityLabel || null,
          label: `Source ${idx + 2}`,
          source: f.source || null,
          subtitleHints: Array.isArray(f.subtitleHints) ? f.subtitleHints : [],
          audioLanguage: f.audioLanguage || '',
          audioIsDub: Boolean(f.audioIsDub)
        };
      });
    const rawIdStr = String(id || '').trim();
    const canonicalTrackId = `${isTv ? 'tv' : 'mv'}:${id || title}:${isTv ? (effectiveSeasonArg ?? 1) : 0}:${episode || 0}`;

    const track = normalizeTrack({
      id: canonicalTrackId,
      providerId: canonicalTrackId,
      provider: 'movie',
      tmdbId: /^\d+$/.test(rawIdStr) ? rawIdStr : (resolvedTmdbId || franchiseTmdbId || netRes?.discoveredTmdbId || null),
      imdbId: effectiveImdbId || null,
      mediaKind: isTv ? 'tv' : 'movie',
      seriesId: rawIdStr || null,
      season: isTv ? effectiveSeasonArg : null,
      seasonNumber: isTv ? effectiveSeasonArg : null,
      episode: isTv && episode != null ? Number(episode) : null,
      episodeNumber: isTv && episode != null ? Number(episode) : null,
      episodeTitle: effectiveEpisodeTitle || null,
      originalTitle: effectiveOriginalTitle || null,
      originalLanguage: effectiveOriginalLanguage || null,
      releaseDate: effectiveReleaseDate || null,
      downloadUrls: directDownloadUrls.length ? directDownloadUrls : null,
      fallbackStreams: cleanFallbacks,
      title: displayTitle,
      artist: metaSubtitle,
      artwork: effectiveArtwork || null,
      year: effectiveYear || null,
      rating: effectiveRating,
      genres: effectiveGenres,
      overview: effectiveOverview,
      durationSeconds: Number(resolvedStream.durationSeconds || effectiveDurationSeconds || 0) || null,
      mediaType: 'video',
      streamUrl: resolvedStream.url,
      streamHeaders: resolvedStream.headers || {},
      format: resolvedStream.format || (isDash ? 'dash' : isHls ? 'hls' : 'mp4'),
      isHls,
      isDash,
      subtitlePath: subtitleInfo?.filePath || null,
      subtitleLabel: subtitleInfo?.label || null,
      subtitleCuesCount: subtitleInfo?.cues?.length || 0,
      subtitleSameRoute: Boolean(subtitleInfo?.sameRoute),
      subtitleTracks: Array.isArray(subtitleInfo?.tracks) ? subtitleInfo.tracks : [],
      preferredAudioLang: effectiveOriginalLanguage || null,
      audioLanguage: resolvedStream.audioLanguage || effectiveOriginalLanguage || null,
      audioIsDub: Boolean(resolvedStream.audioIsDub),
      dubOnly: Boolean(resolvedStream.dubOnly || resolvedStream.audioIsDub),
      dubOnlyWarning: resolvedStream.dubOnlyWarning || (resolvedStream.audioIsDub ? '⚠️ Dub Only Available' : null),
      sizeBytes: resolvedStream.sizeBytes || null,
      variants: resolvedStream.variants || null,
      capabilities: {
        seek: true,
        video: true
      }
    }, 'movie');

    return {
      ok: true,
      track,
      playback,
      subtitles: subtitleInfo,
      variants: resolvedStream.variants || null,
      fallbackStreams: cleanFallbacks,
      sizeBytes: resolvedStream.sizeBytes || null,
      audioLanguage: track.audioLanguage,
      audioIsDub: track.audioIsDub,
      dubOnly: track.dubOnly,
      dubOnlyWarning: track.dubOnlyWarning,
      source: resolvedStream.source,
      webappUrl: null
    };
  }
}
