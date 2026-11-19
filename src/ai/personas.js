/**
 * Multi-Persona & Multi-Voice Cast Registry for Pappy / Lancy AI.
 *
 * Supports real, verified Gemini 3.8 Live voices & Edge-TTS profiles across
 * men, boys, ladies, girls, older women, and older men — plus dynamic custom names
 * so whoever a user addresses in voice or text replies with their own standalone character.
 */

export const VOICE_ARCHETYPES = {
  man: { geminiVoice: 'Charon', edgeTtsVoice: 'pappy', gender: 'male', ageGroup: 'man' },
  boy: { geminiVoice: 'Puck', edgeTtsVoice: 'leo', gender: 'male', ageGroup: 'boy' },
  lady: { geminiVoice: 'Aoede', edgeTtsVoice: 'ava', gender: 'female', ageGroup: 'lady' },
  girl: { geminiVoice: 'Leda', edgeTtsVoice: 'maya', gender: 'female', ageGroup: 'girl' },
  old_woman: { geminiVoice: 'Gacrux', edgeTtsVoice: 'nana', gender: 'female', ageGroup: 'old_woman' },
  old_man: { geminiVoice: 'Algenib', edgeTtsVoice: 'elder', gender: 'male', ageGroup: 'old_man' }
};

export const BUILTIN_PERSONAS = {
  pappy: {
    id: 'pappy',
    name: 'Pappy',
    gender: 'male',
    ageGroup: 'man',
    geminiVoice: 'Charon',
    edgeTtsVoice: 'pappy',
    personality: 'Charismatic, grounded, deep-voiced host and DJ with effortless warmth, Nigerian English & Pidgin flair, sharp cinema/music taste, and captivating long-form storytelling.'
  },
  ava: {
    id: 'ava',
    name: 'Ava',
    gender: 'female',
    ageGroup: 'lady',
    geminiVoice: 'Aoede',
    edgeTtsVoice: 'ava',
    personality: 'Warm, confident, expressive woman with quick playful wit, emotional depth, and a soft spot for R&B, Afrobeats, and gripping dark romance stories.'
  },
  maya: {
    id: 'maya',
    name: 'Maya',
    gender: 'female',
    ageGroup: 'girl',
    geminiVoice: 'Leda',
    edgeTtsVoice: 'maya',
    personality: 'Bright, curious, energetic young girl voice with lively reactions, love for trending music videos, anime, pop culture, and vivid animated storytelling.'
  },
  leo: {
    id: 'leo',
    name: 'Leo',
    gender: 'male',
    ageGroup: 'boy',
    geminiVoice: 'Puck',
    edgeTtsVoice: 'leo',
    personality: 'Upbeat, energetic young guy/boy energy — quick on the draw, hyped about bangers, action movies, adventures, and fast playful banter.'
  },
  nana: {
    id: 'nana',
    name: 'Nana',
    gender: 'female',
    ageGroup: 'old_woman',
    geminiVoice: 'Gacrux',
    edgeTtsVoice: 'nana',
    personality: 'Warm, wise elder woman / grandmotherly presence with calm patient grace, ancestral folklore, rich dramatic storytelling rhythm, and comforting wisdom.'
  },
  elder: {
    id: 'elder',
    name: 'Elder',
    gender: 'male',
    ageGroup: 'old_man',
    geminiVoice: 'Algenib',
    edgeTtsVoice: 'elder',
    personality: 'Measured, gravelly wise old man voice — thoughtful, unhurried, rich in history, classic cinema, legends, and deep life insight.'
  },
  zara: {
    id: 'zara',
    name: 'Zara',
    gender: 'female',
    ageGroup: 'lady',
    geminiVoice: 'Kore',
    edgeTtsVoice: 'zara',
    personality: 'Bold, dramatic, sharp-witted woman who loves dark romance, plot twists, late-night debates, and unflinching honesty.'
  },
  marcus: {
    id: 'marcus',
    name: 'Marcus',
    gender: 'male',
    ageGroup: 'man',
    geminiVoice: 'Fenrir',
    edgeTtsVoice: 'marcus',
    personality: 'Smooth, cinematic, focused man — analytical about film craft, crime thrillers, lyrics, and deep atmospheric music.'
  },
  chloe: {
    id: 'chloe',
    name: 'Chloe',
    gender: 'female',
    ageGroup: 'girl',
    geminiVoice: 'Zephyr',
    edgeTtsVoice: 'chloe',
    personality: 'Sweet, sunny, perceptive young feminine voice who keeps conversations light, warm, and genuinely curious.'
  }
};

export const PERSONA_TRIGGER_NAMES = [
  'pappy', 'lancy', 'ava', 'maya', 'leo', 'nana', 'elder', 'zara', 'marcus', 'chloe'
];

const LIKELY_FEMALE_SUFFIXES_OR_NAMES = /^(?:ava|maya|nana|zara|chloe|sarah|ada|amara|chioma|tolu|sophia|bella|elena|kemi|lola|grace|victoria|queen|esther|naomi|rachel|olivia|emma|mia|aisha|fatima|zainab)$/i;
const LIKELY_MALE_NAMES = /^(?:pappy|leo|elder|marcus|john|tunde|chidi|david|tobi|kunle|mike|alex|daniel|samuel|chris|joshua|ibrahim|kofi|kwame)$/i;

export function getPersonaById(idOrVoice) {
  const clean = String(idOrVoice || '').trim().toLowerCase();
  if (!clean) return BUILTIN_PERSONAS.pappy;
  if (clean === 'lancy' || clean === 'charon' || clean === 'deep_male' || clean === 'male' || clean === 'ng_male') {
    return BUILTIN_PERSONAS.pappy;
  }
  if (BUILTIN_PERSONAS[clean]) return BUILTIN_PERSONAS[clean];
  if (clean === 'lady' || clean === 'woman' || clean === 'female' || clean === 'aoede' || clean === 'ng_female') return BUILTIN_PERSONAS.ava;
  if (clean === 'girl' || clean === 'young_female' || clean === 'leda') return BUILTIN_PERSONAS.maya;
  if (clean === 'boy' || clean === 'young_male' || clean === 'puck') return BUILTIN_PERSONAS.leo;
  if (clean === 'old_woman' || clean === 'grandma' || clean === 'elder_woman' || clean === 'gacrux' || clean === 'uk_female') return BUILTIN_PERSONAS.nana;
  if (clean === 'old_man' || clean === 'grandpa' || clean === 'elder_man' || clean === 'algenib') return BUILTIN_PERSONAS.elder;
  if (clean === 'kore') return BUILTIN_PERSONAS.zara;
  if (clean === 'fenrir' || clean === 'marcus') return BUILTIN_PERSONAS.marcus;
  if (clean === 'zephyr') return BUILTIN_PERSONAS.chloe;
  return null;
}

export function buildCustomPersona(name, archetypeHint = null) {
  const cleanName = String(name || '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 28) || 'Pappy';
  const existing = getPersonaById(cleanName);
  if (existing) return existing;

  let archKey = archetypeHint && VOICE_ARCHETYPES[archetypeHint] ? archetypeHint : null;
  if (!archKey) {
    if (LIKELY_FEMALE_SUFFIXES_OR_NAMES.test(cleanName) || /(?:a|ah|ia|na|la|elle|ette|yn)$/i.test(cleanName)) {
      archKey = 'lady';
    } else if (LIKELY_MALE_NAMES.test(cleanName)) {
      archKey = 'man';
    } else {
      archKey = 'man';
    }
  }
  const arch = VOICE_ARCHETYPES[archKey];
  return {
    id: cleanName.toLowerCase(),
    name: cleanName[0].toUpperCase() + cleanName.slice(1),
    gender: arch.gender,
    ageGroup: arch.ageGroup,
    geminiVoice: arch.geminiVoice,
    edgeTtsVoice: arch.edgeTtsVoice,
    personality: `You are ${cleanName[0].toUpperCase() + cleanName.slice(1)} (${arch.ageGroup}, ${arch.gender}), standing as your own distinct conversational voice and co-host alongside Pappy and Ava. Speak naturally in character, never say you are an AI pretending to be ${cleanName}.`
  };
}

/**
 * Detect whether the speaker explicitly called a specific persona name or requested a voice archetype.
 */
export function resolvePersonaFromText(text = '', currentPersona = BUILTIN_PERSONAS.pappy, participantNames = []) {
  const clean = String(text || '').trim();
  if (!clean) return { persona: currentPersona || BUILTIN_PERSONAS.pappy, switched: false };

  // 1. Explicit voice-type switch requests ("use an old woman voice", "switch to lady voice", "talk like a boy")
  const archMatch = clean.match(/\b(?:switch\s+to|use|give\s+me|change\s+to|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(old\s+woman|grandma|elder\s+woman|old\s+man|grandpa|elder\s+man|lady|woman|girl|young\s+girl|boy|young\s+boy|man|deep\s+male)\b/i);
  if (archMatch) {
    const rawArch = archMatch[1].toLowerCase().replace(/\s+/g, '_');
    const normMap = {
      old_woman: 'old_woman', grandma: 'old_woman', elder_woman: 'old_woman',
      old_man: 'old_man', grandpa: 'old_man', elder_man: 'old_man',
      lady: 'lady', woman: 'lady',
      girl: 'girl', young_girl: 'girl',
      boy: 'boy', young_boy: 'boy',
      man: 'man', deep_male: 'man'
    };
    const p = getPersonaById(normMap[rawArch] || rawArch) || BUILTIN_PERSONAS.pappy;
    return { persona: p, switched: p.id !== currentPersona?.id, explicitVoiceRequest: true };
  }

  // 2. Direct built-in cast address at start or explicitly called ("Ava, ...", "Hey Nana ...", "Pappy ...")
  const namesRe = new RegExp(`(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask|let)\\s+)?\\b(${PERSONA_TRIGGER_NAMES.join('|')})\\b(?:[\\s,:-]+|$)`, 'i');
  const m = clean.match(namesRe);
  if (m) {
    const picked = getPersonaById(m[1]) || BUILTIN_PERSONAS.pappy;
    return { persona: picked, switched: picked.id !== currentPersona?.id, calledName: picked.name };
  }

  // 3. Explicit persona/character naming ("I'm calling Zara", "Hey Amara reply me", "Call yourself <Name>")
  const customM = clean.match(/^(?:[Hh]ey|[Hh]i|[Yy]o|[Cc]all|[Aa]sk)\s+([A-Z][a-z]{2,16})(?:[,\s]+|$)/);
  if (customM) {
    const candidate = customM[1];
    const isHumanParticipant = (participantNames || []).some(
      (n) => String(n || '').trim().toLowerCase().split(/\s+/)[0] === candidate.toLowerCase()
    );
    if (!isHumanParticipant && !/^(?:wait|look|guys|bro|sis|man|boss|what|who|why|how|when|where|tell|play|pause|stop|skip)$/i.test(candidate)) {
      const custom = buildCustomPersona(candidate);
      return { persona: custom, switched: custom.id !== currentPersona?.id, calledName: custom.name };
    }
  }

  return { persona: currentPersona || BUILTIN_PERSONAS.pappy, switched: false };
}
