import { getAiOrCuratedTrivia } from '../data/trivia.js';

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&eacute;/g, 'é')
    .replace(/&ntilde;/g, 'ñ');
}

function maskWord(str = '') {
  return String(str)
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w[0] + '_' : w[0] + '_'.repeat(Math.min(6, w.length - 2)) + w[w.length - 1]))
    .join('  ');
}

function createMultipleChoice(targetName, candidatePool, existingAliases = []) {
  const cleanTarget = String(targetName).trim();
  const distractors = candidatePool
    .map((c) => (typeof c === 'string' ? c : c?.name || c?.word || c?.answer || ''))
    .filter((n) => String(n).trim().toLowerCase() !== cleanTarget.toLowerCase() && String(n).trim().length > 0)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((n) => String(n).trim());

  while (distractors.length < 3) {
    distractors.push(`Choice ${distractors.length + 1}`);
  }

  const options = [cleanTarget, ...distractors].sort(() => Math.random() - 0.5);
  const correctIndex = options.indexOf(cleanTarget);
  const letter = String.fromCharCode(65 + correctIndex).toLowerCase();

  const aliases = Array.from(new Set([
    ...existingAliases,
    cleanTarget.toLowerCase(),
    letter,
    `option ${letter}`,
    `${letter})`
  ]));

  return { options, correctIndex, aliases };
}

export function scrambleWordTiles(word = '') {
  const clean = String(word).toUpperCase().replace(/[^A-Z]/g, '');
  if (clean.length <= 1) return clean;
  let chars = clean.split('');
  for (let attempt = 0; attempt < 10; attempt++) {
    chars = chars.sort(() => Math.random() - 0.5);
    if (chars.join('') !== clean) break;
  }
  if (chars.join('') === clean) {
    chars.reverse();
  }
  return chars.map((c) => `[ ${c} ]`).join(' ');
}

/**
 * 1. LIVE TRIVIA BATTLES (The Trivia API v2 -> OpenTDB -> Ollama AI / Curated)
 */
export async function getLiveTriviaQuestion({ seenIds = new Set() } = {}) {
  // Try The Trivia API v2 first (clean JSON, zero HTML entity issues, huge pool)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://the-trivia-api.com/v2/questions?limit=8', {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const list = await res.json();
      const unseen = (Array.isArray(list) ? list : []).filter(
        (q) => q?.id && q?.question?.text && q?.correctAnswer && !seenIds.has(`trv_${q.id}`)
      );
      if (unseen.length > 0) {
        const picked = unseen[0];
        const correct = String(picked.correctAnswer).trim();
        const wrongs = (picked.incorrectAnswers || []).slice(0, 3).map((x) => String(x).trim());
        const options = [...wrongs, correct].sort(() => Math.random() - 0.5);
        const correctIndex = options.indexOf(correct);
        const category = String(picked.category || 'General').replace(/_/g, ' ').toUpperCase();
        const diff = String(picked.difficulty || 'medium').toUpperCase();

        return {
          id: `trv_${picked.id}`,
          name: correct,
          displayName: correct,
          questionText: picked.question.text,
          options,
          correctIndex,
          category,
          difficulty: diff,
          hint1: `Category: ${category} • Difficulty: ${diff}`,
          hint2: `Starts with "${correct[0].toUpperCase()}" • Pattern: ${maskWord(correct)}`,
          aliases: [
            correct.toLowerCase(),
            String.fromCharCode(65 + correctIndex).toLowerCase()
          ]
        };
      }
    }
  } catch {}

  // Try OpenTDB second
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://opentdb.com/api.php?amount=6&type=multiple', {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const results = (data?.results || []).filter((r) => r?.question && r?.correct_answer);
      for (const r of results) {
        const qText = decodeHtmlEntities(r.question);
        const qId = `otdb_${Buffer.from(qText.slice(0, 36)).toString('base64url')}`;
        if (seenIds.has(qId)) continue;

        const correct = decodeHtmlEntities(r.correct_answer);
        const wrongs = (r.incorrect_answers || []).slice(0, 3).map(decodeHtmlEntities);
        const options = [...wrongs, correct].sort(() => Math.random() - 0.5);
        const correctIndex = options.indexOf(correct);
        const category = decodeHtmlEntities(r.category || 'General Knowledge');

        return {
          id: qId,
          name: correct,
          displayName: correct,
          questionText: qText,
          options,
          correctIndex,
          category,
          difficulty: String(r.difficulty || 'MEDIUM').toUpperCase(),
          hint1: `Category: ${category}`,
          hint2: `Pattern: ${maskWord(correct)}`,
          aliases: [
            correct.toLowerCase(),
            String.fromCharCode(65 + correctIndex).toLowerCase()
          ]
        };
      }
    }
  } catch {}

  // Fallback to AI / Curated trivia
  const t = await getAiOrCuratedTrivia();
  const ans = t.options[t.correctIndex];
  return {
    id: `ai_trv_${Date.now()}`,
    name: ans,
    displayName: ans,
    questionText: t.question,
    options: t.options,
    correctIndex: t.correctIndex,
    category: t.category || 'Pop Culture & Science',
    difficulty: t.difficulty || 'MEDIUM',
    hint1: `Category: ${t.category || 'Trivia'}`,
    hint2: t.explanation ? `${t.explanation.slice(0, 60)}...` : `Pattern: ${maskWord(ans)}`,
    aliases: [ans.toLowerCase(), String.fromCharCode(65 + t.correctIndex).toLowerCase()]
  };
}

/**
 * 2. EMOJI QUIZ (Decode the Vibe — Anime, Movies, Music, Games, Countries, Brands)
 */
const EMOJI_QUIZ_BANK = [
  { id: 'em_1', emojis: '👒🏴‍☠️🍖🐒⛵', name: 'One Piece', category: 'Anime', hint: 'Straw Hat Pirates looking for the ultimate treasure', aliases: ['one piece'] },
  { id: 'em_2', emojis: '🤞👁️🔵🟣♾️', name: 'Jujutsu Kaisen', category: 'Anime', hint: 'Domain Expansion: Infinite Void & Cursed Energy', aliases: ['jujutsu kaisen', 'jjk', 'gojo satoru'] },
  { id: 'em_3', emojis: '📓🍎🖊️💀⚖️', name: 'Death Note', category: 'Anime', hint: 'Shinigami Ryuk drops a supernatural notebook on Earth', aliases: ['death note'] },
  { id: 'em_4', emojis: '🧱🏃‍♂️⚔️巨人🩸', name: 'Attack on Titan', category: 'Anime', hint: 'Humanity lives inside three giant concentric walls', aliases: ['attack on titan', 'aot', 'shingeki no kyojin'] },
  { id: 'em_5', emojis: '🗡️👹🌊🔥🎴', name: 'Demon Slayer', category: 'Anime', hint: 'Tanjiro carries Nezuko in a wooden box on his back', aliases: ['demon slayer', 'kimetsu no yaiba'] },
  { id: 'em_6', emojis: '🦊🍜🍥🥷🍃', name: 'Naruto', category: 'Anime', hint: 'Nine-Tailed Fox ninja from the Hidden Leaf Village', aliases: ['naruto', 'naruto shippuden'] },
  { id: 'em_7', emojis: '🕵️‍♂️👩‍杀👧🥜🐶', name: 'Spy x Family', category: 'Anime', hint: 'A spy, an assassin, and a telepathic girl who loves peanuts', aliases: ['spy x family', 'spy family'] },
  { id: 'em_8', emojis: '⛓️🪚🐶😈🩸', name: 'Chainsaw Man', category: 'Anime', hint: 'Denji merges with his devil dog Pochita', aliases: ['chainsaw man', 'csm'] },
  { id: 'em_9', emojis: '🕷️🧑🏽‍🦱🌌⏳🕸️', name: 'Spider-Verse', category: 'Movies', hint: 'Miles Morales leaps across the multiverse', aliases: ['spider-man', 'spiderman', 'across the spider-verse', 'into the spider-verse', 'spider verse'] },
  { id: 'em_10', emojis: '🦁👑🌅🐗🐦', name: 'The Lion King', category: 'Movies', hint: 'Simba, Mufasa, Timon & Pumbaa in the Pride Lands', aliases: ['the lion king', 'lion king'] },
  { id: 'em_11', emojis: '🚢🧊💑🎻🌊', name: 'Titanic', category: 'Movies', hint: 'Jack and Rose aboard the unsinkable 1912 ocean liner', aliases: ['titanic'] },
  { id: 'em_12', emojis: '🧙‍♂️⚡🦉🧹🏰', name: 'Harry Potter', category: 'Movies', hint: 'The Boy Who Lived attends Hogwarts School of Witchcraft', aliases: ['harry potter'] },
  { id: 'em_13', emojis: '🦇🃏🚓🌃🔦', name: 'The Dark Knight', category: 'Movies', hint: 'Gotham City vigilante faces the Joker', aliases: ['batman', 'the dark knight', 'dark knight'] },
  { id: 'em_14', emojis: '🧤💎🟣🫰🌌', name: 'Avengers Endgame', category: 'Movies', hint: 'Thanos collects all six Infinity Stones and snaps', aliases: ['avengers', 'avengers endgame', 'infinity war', 'endgame'] },
  { id: 'em_15', emojis: '🧸🎀💗👠🏠', name: 'Barbie', category: 'Movies', hint: 'Leaving Barbieland for the real world in hot pink', aliases: ['barbie'] },
  { id: 'em_16', emojis: '💣🎩🔬🔥☢️', name: 'Oppenheimer', category: 'Movies', hint: 'J. Robert Oppenheimer and the Manhattan Project', aliases: ['oppenheimer'] },
  { id: 'em_17', emojis: '🏎️⚡🔴🏆🛣️', name: 'Cars', category: 'Movies', hint: 'Lightning McQueen says "Ka-Chow!"', aliases: ['cars', 'lightning mcqueen'] },
  { id: 'em_18', emojis: '🐀👨‍🍳🍲🥖🇫🇷', name: 'Ratatouille', category: 'Movies', hint: 'A rat named Remy dreams of becoming a Paris chef', aliases: ['ratatouille'] },
  { id: 'em_19', emojis: '🐼🥋🥟🐉🎋', name: 'Kung Fu Panda', category: 'Movies', hint: 'Po becomes the Dragon Warrior', aliases: ['kung fu panda'] },
  { id: 'em_20', emojis: '🕶️💊🟢💻🕴️', name: 'The Matrix', category: 'Movies', hint: 'Red pill or blue pill? Neo dodges bullets in slow motion', aliases: ['the matrix', 'matrix'] },
  { id: 'em_21', emojis: '🕺🪩🕶️✨🌃', name: 'Blinding Lights', category: 'Music', hint: 'The Weeknd\'s biggest synthwave mega-hit', aliases: ['blinding lights'] },
  { id: 'em_22', emojis: '☕💋☀️🏖️🎶', name: 'Espresso', category: 'Music', hint: 'Sabrina Carpenter: "That\'s that me..."', aliases: ['espresso'] },
  { id: 'em_23', emojis: '🧛‍♀️🩸🌕💔🎤', name: 'Vampire', category: 'Music', hint: 'Olivia Rodrigo hit lead single from GUTS', aliases: ['vampire'] },
  { id: 'em_24', emojis: '🐦🪶🤝💙🎶', name: 'Birds of a Feather', category: 'Music', hint: 'Billie Eilish hit: "...we should stick together"', aliases: ['birds of a feather'] },
  { id: 'em_25', emojis: '⛏️🧱🧟‍♂️💎🐉', name: 'Minecraft', category: 'Gaming', hint: 'Mine diamonds, build blocks, defeat the Ender Dragon', aliases: ['minecraft'] },
  { id: 'em_26', emojis: '👨‍🚀🔪🛸📮🤫', name: 'Among Us', category: 'Gaming', hint: 'Find the impostor venting on the spaceship', aliases: ['among us', 'amogus'] },
  { id: 'em_27', emojis: '🪂🚌🔫🏗️🏆', name: 'Fortnite', category: 'Gaming', hint: 'Drop from the Battle Bus and crank 90s for a Victory Royale', aliases: ['fortnite'] },
  { id: 'em_28', emojis: '🚗🔫🌴💰🚓', name: 'Grand Theft Auto', category: 'Gaming', hint: 'Five-star wanted level in Los Santos / Vice City', aliases: ['gta', 'grand theft auto', 'gta 5', 'gta v'] },
  { id: 'em_29', emojis: '⚽🚗🚀🥅💥', name: 'Rocket League', category: 'Gaming', hint: 'Supersonic acrobatic rocket-powered battle-cars playing soccer', aliases: ['rocket league'] },
  { id: 'em_30', emojis: '🗼🥐🍷🎨🐓', name: 'France', category: 'Country', hint: 'European country famous for Paris, croissants, and the Louvre', aliases: ['france'] },
  { id: 'em_31', emojis: '🗾🍣🌸🗻🚅', name: 'Japan', category: 'Country', hint: 'Land of the Rising Sun, bullet trains, and Mount Fuji', aliases: ['japan'] },
  { id: 'em_32', emojis: '💃⚽🌴🎭☕', name: 'Brazil', category: 'Country', hint: 'Home of the Amazon Rainforest, Rio Carnival, and 5 World Cups', aliases: ['brazil', 'brasil'] },
  { id: 'em_33', emojis: '🍕🍝🏛️🛵🎭', name: 'Italy', category: 'Country', hint: 'Boot-shaped Mediterranean country home to Rome and Venice', aliases: ['italy'] },
  { id: 'em_34', emojis: '🍏📱💻⌚🎧', name: 'Apple', category: 'Brand', hint: 'Cupertino tech giant behind iPhone, MacBook, and AirPods', aliases: ['apple'] },
  { id: 'em_35', emojis: '✔️👟🏃‍♂️🏀🏆', name: 'Nike', category: 'Brand', hint: '"Just Do It" athletic footwear and apparel icon', aliases: ['nike'] }
];

export async function getLiveEmojiQuiz({ seenIds = new Set() } = {}) {
  const unseen = EMOJI_QUIZ_BANK.filter((e) => !seenIds.has(e.id));
  const pool = unseen.length > 0 ? unseen : EMOJI_QUIZ_BANK;
  const picked = pool[Math.floor(Math.random() * pool.length)];

  const mc = createMultipleChoice(picked.name, EMOJI_QUIZ_BANK, picked.aliases);

  return {
    id: picked.id,
    name: picked.name,
    displayName: `${picked.name} (${picked.category})`,
    emojis: picked.emojis,
    category: picked.category,
    difficulty: 'MEDIUM',
    hint1: `Category: ${picked.category} • ${picked.hint}`,
    hint2: `Pattern: ${maskWord(picked.name)} (${picked.name.split(/\s+/).length} word${picked.name.includes(' ') ? 's' : ''})`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

/**
 * 3. WORD SCRAMBLE (Live Datamuse API + Themed Word Banks)
 */
const SCRAMBLE_TOPICS = [
  { topic: 'astronomy', label: 'Cosmos & Space' },
  { topic: 'music', label: 'Music & Sound' },
  { topic: 'ocean', label: 'Ocean & Nature' },
  { topic: 'cyberpunk', label: 'Tech & Cyber' },
  { topic: 'fashion', label: 'Fashion & Style' },
  { topic: 'cinema', label: 'Cinema & Arts' },
  { topic: 'magic', label: 'Fantasy & Magic' }
];

const FALLBACK_SCRAMBLE_WORDS = [
  { word: 'AESTHETIC', category: 'Vibe & Style', def: 'Concerned with beauty or the appreciation of beauty.' },
  { word: 'GALAXY', category: 'Cosmos & Space', def: 'A massive system of stars, stellar remnants, and interstellar gas.' },
  { word: 'SYMPHONY', category: 'Music & Sound', def: 'An elaborate musical composition for full orchestra.' },
  { word: 'LABYRINTH', category: 'Mystery', def: 'A complicated irregular network of passages or paths.' },
  { word: 'EUPHORIA', category: 'Emotion', def: 'A feeling or state of intense excitement and happiness.' },
  { word: 'PHANTOM', category: 'Mystery', def: 'A ghost or apparition that appears to the senses.' },
  { word: 'CRESCENT', category: 'Cosmos & Space', def: 'The curved sickle shape of the waxing or waning moon.' },
  { word: 'VELVET', category: 'Fashion & Style', def: 'A closely woven fabric of silk, cotton, or nylon with a thick short pile.' },
  { word: 'HORIZON', category: 'Nature', def: 'The line at which the earth\'s surface and the sky appear to meet.' },
  { word: 'SAPPHIRE', category: 'Luxury & Gems', def: 'A transparent precious stone, typically of a deep blue color.' },
  { word: 'ECLIPSE', category: 'Cosmos & Space', def: 'An obscuring of the light from one celestial body by the passage of another.' },
  { word: 'SERENADE', category: 'Music & Sound', def: 'A piece of music sung or played in the open air, typically at night.' },
  { word: 'PARADOX', category: 'Mind & Logic', def: 'A seemingly absurd or self-contradictory statement that may prove to be true.' },
  { word: 'OBSIDIAN', category: 'Nature & Gems', def: 'A dark natural glass formed by the cooling of molten lava.' },
  { word: 'NOSTALGIA', category: 'Emotion', def: 'A sentimental longing or wistful affection for the past.' }
];

export async function getLiveWordScramble({ seenIds = new Set() } = {}) {
  const chosenTopic = SCRAMBLE_TOPICS[Math.floor(Math.random() * SCRAMBLE_TOPICS.length)];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `https://api.datamuse.com/words?ml=${encodeURIComponent(chosenTopic.topic)}&md=d&max=40`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (res.ok) {
      const list = await res.json();
      const valid = (Array.isArray(list) ? list : []).filter((item) => {
        const w = String(item?.word || '').trim();
        return (
          /^[a-zA-Z]{6,10}$/.test(w) &&
          Array.isArray(item.defs) &&
          item.defs.length > 0 &&
          !seenIds.has(`scr_${w.toLowerCase()}`)
        );
      });

      if (valid.length > 0) {
        const picked = valid[Math.floor(Math.random() * Math.min(15, valid.length))];
        const upper = picked.word.toUpperCase();
        const rawDef = String(picked.defs[0] || '').replace(/^[a-z]+\t/i, '').trim();
        const scrambled = scrambleWordTiles(upper);
        const scrambleChoices = FALLBACK_SCRAMBLE_WORDS.map((w) => w.word);
        const mc = createMultipleChoice(upper, scrambleChoices, [upper.toLowerCase()]);

        return {
          id: `scr_${upper.toLowerCase()}`,
          name: upper,
          displayName: upper,
          scrambledTiles: scrambled,
          category: chosenTopic.label,
          difficulty: upper.length >= 9 ? 'HARD' : 'MEDIUM',
          hint1: `Theme: ${chosenTopic.label} • Definition: ${rawDef.slice(0, 120)}`,
          hint2: `Starts with "${upper[0]}" and ends with "${upper[upper.length - 1]}" • Pattern: ${maskWord(upper)}`,
          options: mc.options,
          correctIndex: mc.correctIndex,
          aliases: mc.aliases
        };
      }
    }
  } catch {}

  const pool = FALLBACK_SCRAMBLE_WORDS.filter((w) => !seenIds.has(`scr_${w.word.toLowerCase()}`));
  const item = (pool.length ? pool : FALLBACK_SCRAMBLE_WORDS)[
    Math.floor(Math.random() * (pool.length || FALLBACK_SCRAMBLE_WORDS.length))
  ];
  const mcFallback = createMultipleChoice(item.word, FALLBACK_SCRAMBLE_WORDS.map((w) => w.word), [item.word.toLowerCase()]);

  return {
    id: `scr_${item.word.toLowerCase()}`,
    name: item.word,
    displayName: item.word,
    scrambledTiles: scrambleWordTiles(item.word),
    category: item.category,
    difficulty: 'MEDIUM',
    hint1: `Theme: ${item.category} • Definition: ${item.def}`,
    hint2: `Starts with "${item.word[0]}" and ends with "${item.word[item.word.length - 1]}" • Pattern: ${maskWord(item.word)}`,
    options: mcFallback.options,
    correctIndex: mcFallback.correctIndex,
    aliases: mcFallback.aliases
  };
}

/**
 * 4. RIDDLES & BRAIN TEASERS (Live Riddles API + Curated Lateral Vault)
 */
const RIDDLE_VAULT = [
  { id: 'rid_1', riddle: 'I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?', answer: 'Echo', hint: 'You hear me in canyons and empty halls.', aliases: ['echo', 'an echo'] },
  { id: 'rid_2', riddle: 'The more of this there is, the less you see. What is it?', answer: 'Darkness', hint: 'Turn on a flashlight to make it disappear.', aliases: ['darkness', 'dark', 'the dark', 'fog'] },
  { id: 'rid_3', riddle: 'I have keys, but no locks and space, and no rooms. You can enter, but you can’t go outside. What am I?', answer: 'Keyboard', hint: 'You use me to type messages on a computer.', aliases: ['keyboard', 'a keyboard'] },
  { id: 'rid_4', riddle: 'What has to be broken before you can use it?', answer: 'Egg', hint: 'Common breakfast ingredient with a shell.', aliases: ['egg', 'an egg', 'eggs'] },
  { id: 'rid_5', riddle: 'I am always hungry and will die if not fed, but whatever I touch will soon turn red. What am I?', answer: 'Fire', hint: 'Water is my worst enemy; wood is my fuel.', aliases: ['fire', 'flame', 'a fire'] },
  { id: 'rid_6', riddle: 'What has cities, but no houses; forests, but no trees; and water, but no fish?', answer: 'Map', hint: 'Explorers and travelers use me to navigate.', aliases: ['map', 'a map', 'globe'] },
  { id: 'rid_7', riddle: 'What gets wetter the more it dries?', answer: 'Towel', hint: 'Hangs in your bathroom after a shower.', aliases: ['towel', 'a towel'] },
  { id: 'rid_8', riddle: 'I have branches, but no fruit, trunk or leaves. What am I?', answer: 'Bank', hint: 'Where people keep their money safe.', aliases: ['bank', 'a bank'] },
  { id: 'rid_9', riddle: 'What can travel all around the world while staying in a single corner?', answer: 'Stamp', hint: 'Stuck on the top-right of an envelope.', aliases: ['stamp', 'a stamp', 'postage stamp'] },
  { id: 'rid_10', riddle: 'The person who makes it has no need of it; the person who buys it has no use for it. The person who uses it can neither see nor feel it. What is it?', answer: 'Coffin', hint: 'Used at the very end of a life.', aliases: ['coffin', 'a coffin', 'casket'] },
  { id: 'rid_11', riddle: 'What runs all around a backyard, yet never moves?', answer: 'Fence', hint: 'Marks the boundary of a property.', aliases: ['fence', 'a fence', 'wall'] },
  { id: 'rid_12', riddle: 'What has many teeth, but cannot bite?', answer: 'Comb', hint: 'Used to style or untangle your hair.', aliases: ['comb', 'a comb', 'zipper'] },
  { id: 'rid_13', riddle: 'If you drop me I’m sure to crack, but give me a smile and I’ll always smile back. What am I?', answer: 'Mirror', hint: 'Shows your reflection.', aliases: ['mirror', 'a mirror'] },
  { id: 'rid_14', riddle: 'What begins with T, ends with T, and has T in it?', answer: 'Teapot', hint: 'Used to brew and pour hot tea.', aliases: ['teapot', 'a teapot'] },
  { id: 'rid_15', riddle: 'I follow you all the time and copy your every move, but you can’t touch me or catch me. What am I?', answer: 'Shadow', hint: 'Disappears when there is no light.', aliases: ['shadow', 'your shadow', 'a shadow'] }
];

export async function getLiveRiddle({ seenIds = new Set() } = {}) {
  const riddleAnswers = RIDDLE_VAULT.map((r) => r.answer);

  // Try live Riddles API when possible, filtering for concise 1-2 word answers
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://riddles-api.vercel.app/random', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data?.riddle && data?.answer) {
        const cleanAns = String(data.answer)
          .replace(/^(a|an|the|your|it is a|it's a)\s+/i, '')
          .replace(/[.!]+$/, '')
          .trim();
        const rId = `rid_live_${Buffer.from(cleanAns.toLowerCase()).toString('base64url').slice(0, 16)}`;
        if (cleanAns.split(/\s+/).length <= 2 && cleanAns.length >= 3 && cleanAns.length <= 18 && !seenIds.has(rId)) {
          const mcLive = createMultipleChoice(cleanAns, riddleAnswers, [cleanAns.toLowerCase(), String(data.answer).toLowerCase().trim()]);
          return {
            id: rId,
            name: cleanAns,
            displayName: cleanAns,
            riddleText: data.riddle,
            difficulty: 'MEDIUM',
            hint1: `Answer has ${cleanAns.length} letters (${cleanAns.split(/\s+/).length} word)`,
            hint2: `Starts with "${cleanAns[0].toUpperCase()}" • Pattern: ${maskWord(cleanAns)}`,
            options: mcLive.options,
            correctIndex: mcLive.correctIndex,
            aliases: mcLive.aliases
          };
        }
      }
    }
  } catch {}

  const pool = RIDDLE_VAULT.filter((r) => !seenIds.has(r.id));
  const picked = (pool.length ? pool : RIDDLE_VAULT)[
    Math.floor(Math.random() * (pool.length || RIDDLE_VAULT.length))
  ];
  const mc = createMultipleChoice(picked.answer, riddleAnswers, picked.aliases);

  return {
    id: picked.id,
    name: picked.answer,
    displayName: picked.answer,
    riddleText: picked.riddle,
    difficulty: 'MEDIUM',
    hint1: `Clue: ${picked.hint}`,
    hint2: `Pattern: ${maskWord(picked.answer)} (${picked.answer.length} letters)`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}
