import { FLAGS } from '../data/flags.js';
import { CAR_BRANDS, GLOBAL_BRANDS, APP_ICONS, ALL_VISUAL_BRANDS, CARS } from '../data/cars.js';
import { getLiveAnimeCharacter } from './anime.js';

let cachedRestCountries = null;

function maskPattern(name = '') {
  return String(name)
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w[0] + '_' : w[0] + '_'.repeat(Math.min(6, w.length - 2)) + w[w.length - 1]))
    .join('  ');
}

/**
 * Creates 4 balanced multiple-choice options with a shuffled order and correctIndex.
 * Also appends option letter aliases ('a', 'b', 'c', 'd', 'option a', etc.) to allow typing the letter in chat.
 */
function createMultipleChoice(targetName, candidatePool, existingAliases = []) {
  const cleanTarget = String(targetName).trim();
  const distractors = candidatePool
    .filter((n) => String(n).trim().toLowerCase() !== cleanTarget.toLowerCase())
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((n) => String(n).trim());

  while (distractors.length < 3) {
    distractors.push(`Option ${distractors.length + 1}`);
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

/**
 * Loads all 250+ world countries live from RestCountries v3.1 API once and caches in memory.
 */
async function ensureRestCountriesLoaded() {
  if (cachedRestCountries && cachedRestCountries.length > 50) return cachedRestCountries;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(
      'https://restcountries.com/v3.1/independent?status=true&fields=name,cca2,capital,region,subregion,population,currencies,altSpellings',
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) return null;

    cachedRestCountries = raw
      .filter((c) => c?.cca2 && c?.name?.common)
      .map((c) => {
        const code = String(c.cca2).toLowerCase();
        const name = c.name.common;
        const capital = Array.isArray(c.capital) && c.capital[0] ? c.capital[0] : 'N/A';
        const pop = Number(c.population || 0);
        const popFormatted = pop >= 1_000_000
          ? `${(pop / 1_000_000).toFixed(1)}M`
          : `${Math.round(pop / 1000)}K`;
        const difficulty = pop > 45_000_000 ? 'EASY' : pop > 8_000_000 ? 'MEDIUM' : 'HARD';
        const region = c.subregion || c.region || 'World';
        const currencyObj = c.currencies ? Object.values(c.currencies)[0] : null;
        const currencyName = currencyObj?.name ? ` • Currency: ${currencyObj.name}` : '';

        const aliases = Array.from(new Set([
          name.toLowerCase(),
          ...(c.name.official ? [c.name.official.toLowerCase()] : []),
          ...((c.altSpellings || []).filter((s) => s.length >= 3 && s.length <= 28).map((s) => s.toLowerCase()))
        ]));

        return {
          id: `flag_${code}`,
          name,
          displayName: `${name} (${capital})`,
          code,
          population: pop,
          difficulty,
          imageUrl: `https://flagcdn.com/w640/${code}.png`,
          hint1: `Region: ${region} • Pop: ~${popFormatted}${currencyName}`,
          hint2: `Capital City: ${capital} • Pattern: ${maskPattern(name)}`,
          aliases
        };
      });

    return cachedRestCountries;
  } catch {
    return null;
  }
}

/**
 * Returns a live Flag question with 4 interactive multiple-choice buttons across 195+ sovereign nations.
 */
export async function getLiveFlagQuestion({ seenIds = new Set(), difficulty = 'ALL' } = {}) {
  const liveList = await ensureRestCountriesLoaded();
  const pool = (liveList && liveList.length > 0) ? liveList : FLAGS.map((f) => ({
    id: `flag_${f.code.toLowerCase()}`,
    name: f.name,
    displayName: `${f.name} (${f.capital})`,
    code: f.code.toLowerCase(),
    difficulty: f.difficulty || 'MEDIUM',
    imageUrl: `https://flagcdn.com/w640/${f.code.toLowerCase()}.png`,
    hint1: `Continent: ${f.continent} • Letters: ${f.name.length}`,
    hint2: `Capital City: ${f.capital} • Pattern: ${maskPattern(f.name)}`,
    aliases: f.aliases || [f.name.toLowerCase()]
  }));

  let unseen = pool.filter((f) => !seenIds.has(f.id));
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = unseen.filter((f) => f.difficulty === difficulty);
    if (diffPool.length > 0) unseen = diffPool;
  }
  const candidatePool = unseen.length > 0 ? unseen : pool;
  const picked = candidatePool[Math.floor(Math.random() * candidatePool.length)];

  // Generate 4 country choices
  const countryNames = pool.map((c) => c.name);
  const mc = createMultipleChoice(picked.name, countryNames, picked.aliases);

  return {
    ...picked,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

/**
 * Returns a dedicated Car Logo challenge (Ferrari, Porsche, Lamborghini, Tesla, BMW, etc.)
 * with 4 interactive multiple-choice buttons, live downloads, and strict non-repeating guarantees.
 */
export async function getLiveCarLogoQuestion({ seenIds = new Set(), difficulty = 'ALL', matchSeenIds = new Set() } = {}) {
  let pool = CAR_BRANDS;
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = CAR_BRANDS.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }

  // 1. Primary candidates: neither seen historically nor in this active match
  let candidates = pool.filter((c) => !seenIds.has(c.id) && !matchSeenIds.has(c.id));

  // 2. If historical DB seen items exhausted the pool, guarantee no repeats in the current active match!
  if (candidates.length === 0) {
    candidates = pool.filter((c) => !matchSeenIds.has(c.id));
  }

  // 3. Fallback: if match ran 50+ rounds and exhausted all items, reset matchSeenIds
  if (candidates.length === 0) {
    matchSeenIds.clear();
    candidates = pool;
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  seenIds.add(picked.id);
  matchSeenIds.add(picked.id);

  const carNames = CAR_BRANDS.map((c) => c.name);
  const mc = createMultipleChoice(picked.name, carNames, picked.aliases);

  // Live download URL with dynamic cache buster to force fresh HTTP fetch
  const liveUrl = picked.imageUrl.includes('?')
    ? `${picked.imageUrl}&_live=1&t=${Date.now()}`
    : `${picked.imageUrl}?_live=1&t=${Date.now()}`;

  return {
    id: picked.id,
    name: picked.name,
    displayName: `${picked.name} (${picked.category}, est. ${picked.founded})`,
    difficulty: picked.difficulty || 'EASY',
    imageUrl: liveUrl,
    hint1: `${picked.category} • Origin: ${picked.country} (est. ${picked.founded})`,
    hint2: `Famous For: ${picked.famousModel} • Pattern: ${maskPattern(picked.name)}`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

/**
 * Returns a dedicated Global Corporate/Fashion/Food Brand challenge (Apple, Nike, Starbucks, Adidas, etc.)
 * with 4 interactive multiple-choice buttons and non-repeating guarantees.
 */
export async function getLiveBrandLogoQuestion({ seenIds = new Set(), difficulty = 'ALL', matchSeenIds = new Set() } = {}) {
  let pool = GLOBAL_BRANDS;
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = GLOBAL_BRANDS.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }

  let candidates = pool.filter((c) => !seenIds.has(c.id) && !matchSeenIds.has(c.id));
  if (candidates.length === 0) {
    candidates = pool.filter((c) => !matchSeenIds.has(c.id));
  }
  if (candidates.length === 0) {
    matchSeenIds.clear();
    candidates = pool;
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  seenIds.add(picked.id);
  matchSeenIds.add(picked.id);

  const brandNames = GLOBAL_BRANDS.map((c) => c.name);
  const mc = createMultipleChoice(picked.name, brandNames, picked.aliases);

  const liveUrl = picked.imageUrl.includes('?')
    ? `${picked.imageUrl}&_live=1&t=${Date.now()}`
    : `${picked.imageUrl}?_live=1&t=${Date.now()}`;

  return {
    id: picked.id,
    name: picked.name,
    displayName: `${picked.name} (${picked.category})`,
    difficulty: picked.difficulty || 'EASY',
    imageUrl: liveUrl,
    hint1: `${picked.category} • Origin: ${picked.country} (est. ${picked.founded})`,
    hint2: `Famous For: ${picked.famousModel} • Pattern: ${maskPattern(picked.name)}`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

/**
 * Returns a dedicated App & Tech Icon challenge (Discord, Spotify, TikTok, Netflix, Instagram, etc.)
 * with 4 interactive multiple-choice buttons.
 */
export async function getLiveAppIconQuestion({ seenIds = new Set(), difficulty = 'ALL', matchSeenIds = new Set() } = {}) {
  let pool = APP_ICONS;
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = APP_ICONS.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }

  let candidates = pool.filter((c) => !seenIds.has(c.id) && !matchSeenIds.has(c.id));
  if (candidates.length === 0) {
    candidates = pool.filter((c) => !matchSeenIds.has(c.id));
  }
  if (candidates.length === 0) {
    matchSeenIds.clear();
    candidates = pool;
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  seenIds.add(picked.id);
  matchSeenIds.add(picked.id);

  const iconNames = APP_ICONS.map((c) => c.name);
  const mc = createMultipleChoice(picked.name, iconNames, picked.aliases);

  const liveUrl = picked.imageUrl.includes('?')
    ? `${picked.imageUrl}&_live=1&t=${Date.now()}`
    : `${picked.imageUrl}?_live=1&t=${Date.now()}`;

  return {
    id: picked.id,
    name: picked.name,
    displayName: `${picked.name} (${picked.category})`,
    difficulty: picked.difficulty || 'EASY',
    imageUrl: liveUrl,
    hint1: `${picked.category} • Platform: ${picked.country} (est. ${picked.founded})`,
    hint2: `Features: ${picked.famousModel} • Pattern: ${maskPattern(picked.name)}`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

/**
 * Mixed/Universal Brand & Symbol Question: pulls across Car Brands, Global Brands, and App Icons.
 */
export async function getLiveLogoQuestion({ seenIds = new Set(), difficulty = 'ALL', mode = 'mixed', matchSeenIds = new Set() } = {}) {
  if (mode === 'cars') return getLiveCarLogoQuestion({ seenIds, difficulty, matchSeenIds });
  if (mode === 'icons') return getLiveAppIconQuestion({ seenIds, difficulty, matchSeenIds });
  if (mode === 'logos') return getLiveBrandLogoQuestion({ seenIds, difficulty, matchSeenIds });

  let pool = ALL_VISUAL_BRANDS;
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = ALL_VISUAL_BRANDS.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }

  let candidates = pool.filter((c) => !seenIds.has(c.id) && !matchSeenIds.has(c.id));
  if (candidates.length === 0) {
    candidates = pool.filter((c) => !matchSeenIds.has(c.id));
  }
  if (candidates.length === 0) {
    matchSeenIds.clear();
    candidates = pool;
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  seenIds.add(picked.id);
  matchSeenIds.add(picked.id);

  const allNames = ALL_VISUAL_BRANDS.map((c) => c.name);
  const mc = createMultipleChoice(picked.name, allNames, picked.aliases);

  const liveUrl = picked.imageUrl.includes('?')
    ? `${picked.imageUrl}&_live=1&t=${Date.now()}`
    : `${picked.imageUrl}?_live=1&t=${Date.now()}`;

  return {
    id: picked.id,
    name: picked.name,
    displayName: `${picked.name} (${picked.category})`,
    difficulty: picked.difficulty || 'EASY',
    imageUrl: liveUrl,
    hint1: `${picked.category} • ${picked.country} (est. ${picked.founded})`,
    hint2: `Famous For: ${picked.famousModel} • Pattern: ${maskPattern(picked.name)}`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}

const LIVE_WIKI_SUBJECTS = [
  { name: 'Eiffel Tower', wikiTitle: 'Eiffel_Tower', category: 'World Landmark', clue1: 'Iron lattice tower in Paris, France built in 1889.', aliases: ['eiffel tower', 'eiffel'] },
  { name: 'Taj Mahal', wikiTitle: 'Taj_Mahal', category: 'World Landmark', clue1: 'Ivory-white marble mausoleum in Agra, India.', aliases: ['taj mahal'] },
  { name: 'Colosseum', wikiTitle: 'Colosseum', category: 'World Landmark', clue1: 'Ancient oval amphitheatre in the center of Rome, Italy.', aliases: ['colosseum', 'coliseum'] },
  { name: 'Statue of Liberty', wikiTitle: 'Statue_of_Liberty', category: 'World Landmark', clue1: 'Colossal copper neoclassical sculpture on Liberty Island, New York.', aliases: ['statue of liberty', 'liberty'] },
  { name: 'Machu Picchu', wikiTitle: 'Machu_Picchu', category: 'World Landmark', clue1: '15th-century Inca citadel located high in the Andes Mountains in Peru.', aliases: ['machu picchu'] },
  { name: 'Great Wall of China', wikiTitle: 'Great_Wall_of_China', category: 'World Landmark', clue1: 'Series of ancient fortifications stretching across northern China.', aliases: ['great wall of china', 'great wall'] },
  { name: 'Christ the Redeemer', wikiTitle: 'Christ_the_Redeemer_(statue)', category: 'World Landmark', clue1: 'Art Deco statue of Jesus Christ overlooking Rio de Janeiro, Brazil.', aliases: ['christ the redeemer'] },
  { name: 'Mount Fuji', wikiTitle: 'Mount_Fuji', category: 'Iconic Nature', clue1: 'Active stratovolcano and snow-capped cultural icon of Japan.', aliases: ['mount fuji', 'mt fuji', 'fuji'] },
  { name: 'Sydney Opera House', wikiTitle: 'Sydney_Opera_House', category: 'World Landmark', clue1: 'Multi-venue performing arts centre with sail-shaped shells in Australia.', aliases: ['sydney opera house', 'opera house'] },
  { name: 'Pyramids of Giza', wikiTitle: 'Giza_pyramid_complex', category: 'Ancient Wonder', clue1: 'Ancient royal tombs guarded by the Great Sphinx in Egypt.', aliases: ['pyramids of giza', 'pyramids', 'great pyramid'] },
  { name: 'Burj Khalifa', wikiTitle: 'Burj_Khalifa', category: 'World Landmark', clue1: 'World\'s tallest skyscraper (828m) located in Dubai, UAE.', aliases: ['burj khalifa'] },
  { name: 'Golden Gate Bridge', wikiTitle: 'Golden_Gate_Bridge', category: 'World Landmark', clue1: 'Iconic International Orange suspension bridge in San Francisco.', aliases: ['golden gate bridge', 'golden gate'] },
  { name: 'Snow Leopard', wikiTitle: 'Snow_leopard', category: 'Exotic Wildlife', clue1: 'Ghost of the mountains — large felid native to Central and South Asia.', aliases: ['snow leopard', 'leopard'] },
  { name: 'Red Panda', wikiTitle: 'Red_panda', category: 'Exotic Wildlife', clue1: 'Small reddish-brown arboreal mammal with a ringed tail from the Himalayas.', aliases: ['red panda'] },
  { name: 'Giant Panda', wikiTitle: 'Giant_panda', category: 'Exotic Wildlife', clue1: 'Bamboo-eating black-and-white bear native to south-central China.', aliases: ['giant panda', 'panda'] },
  { name: 'King Penguin', wikiTitle: 'King_penguin', category: 'Exotic Wildlife', clue1: 'Second-largest penguin species with bright orange cheek patches.', aliases: ['king penguin', 'penguin', 'emperor penguin'] },
  { name: 'Peacock', wikiTitle: 'Indian_peafowl', category: 'Exotic Wildlife', clue1: 'Famous for its iridescent blue-green train of eye-spotted feathers.', aliases: ['peacock', 'peafowl'] },
  { name: 'Flamingo', wikiTitle: 'Flamingo', category: 'Exotic Wildlife', clue1: 'Pink wading bird known for standing on one leg.', aliases: ['flamingo'] },
  { name: 'Koala', wikiTitle: 'Koala', category: 'Exotic Wildlife', clue1: 'Arboreal eucalyptus-eating marsupial native to Australia.', aliases: ['koala', 'koala bear'] },
  { name: 'Chameleon', wikiTitle: 'Chameleon', category: 'Exotic Wildlife', clue1: 'Color-shifting lizard with independently mobile eyes and a prehensile tail.', aliases: ['chameleon'] },
  { name: 'Mona Lisa', wikiTitle: 'Mona_Lisa', category: 'Masterpiece Art', clue1: 'Renaissance portrait painted by Leonardo da Vinci hanging in the Louvre.', aliases: ['mona lisa'] },
  { name: 'The Starry Night', wikiTitle: 'The_Starry_Night', category: 'Masterpiece Art', clue1: 'Swirling night-sky masterpiece painted by Vincent van Gogh in 1889.', aliases: ['starry night', 'the starry night'] }
];

async function fetchWikipediaSummaryImage(wikiTitle) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LancyBot/2.0 (Telegram Game Engine)' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.originalimage?.source || data?.thumbnail?.source || null;
  } catch {
    return null;
  }
}

/**
 * Fetches a live HD visual subject for Grid Quiz (3x3 Tile Reveal) or Picture Guessing (Pixel/Blur Uncover)
 * with 4 interactive multiple-choice buttons.
 */
export async function getLiveVisualMystery({ seenIds = new Set(), mode = 'grid' } = {}) {
  const candidates = LIVE_WIKI_SUBJECTS.filter((s) => !seenIds.has(`vis_${s.wikiTitle}`));
  const useWiki = candidates.length > 0 && Math.random() < 0.65;

  if (useWiki) {
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    for (const item of shuffled.slice(0, 3)) {
      const imgUrl = await fetchWikipediaSummaryImage(item.wikiTitle);
      if (imgUrl) {
        const wikiNames = LIVE_WIKI_SUBJECTS.map((w) => w.name);
        const mc = createMultipleChoice(item.name, wikiNames, item.aliases);
        return {
          id: `vis_${item.wikiTitle}`,
          name: item.name,
          displayName: `${item.name} (${item.category})`,
          category: item.category,
          difficulty: 'MEDIUM',
          imageUrl: imgUrl,
          hint1: `Category: ${item.category} • ${item.clue1}`,
          hint2: `Name Pattern: ${maskPattern(item.name)}`,
          options: mc.options,
          correctIndex: mc.correctIndex,
          aliases: mc.aliases
        };
      }
    }
  }

  // Otherwise pull a live Anime Character from AniList
  const animeChar = await getLiveAnimeCharacter({ seenIds });
  return {
    ...animeChar,
    id: `${mode}_${animeChar.id}`,
    category: `Anime (${animeChar.universe})`
  };
}
