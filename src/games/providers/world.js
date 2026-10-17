import { FLAGS } from '../data/flags.js';
import { CARS } from '../data/cars.js';
import { getLiveAnimeCharacter } from './anime.js';

let cachedRestCountries = null;

function maskPattern(name = '') {
  return String(name)
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w[0] + '_' : w[0] + '_'.repeat(Math.min(6, w.length - 2)) + w[w.length - 1]))
    .join('  ');
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
 * Returns a live, non-repetitive Flag question across 195+ sovereign nations.
 */
export async function getLiveFlagQuestion({ seenIds = new Set(), difficulty = 'ALL' } = {}) {
  const liveList = await ensureRestCountriesLoaded();
  if (liveList && liveList.length > 0) {
    let pool = liveList.filter((f) => !seenIds.has(f.id));
    if (difficulty && difficulty !== 'ALL') {
      const diffPool = pool.filter((f) => f.difficulty === difficulty);
      if (diffPool.length > 0) pool = diffPool;
    }
    if (pool.length > 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // Fallback to static FLAGS dataset
  let fb = FLAGS.filter((f) => !seenIds.has(`flag_${f.code}`));
  if (!fb.length) fb = FLAGS;
  const picked = fb[Math.floor(Math.random() * fb.length)];
  return {
    id: `flag_${picked.code}`,
    name: picked.name,
    displayName: `${picked.name} (${picked.capital})`,
    difficulty: picked.difficulty || 'MEDIUM',
    imageUrl: `https://flagcdn.com/w640/${picked.code.toLowerCase()}.png`,
    hint1: `Continent: ${picked.continent} • Letters: ${picked.name.length}`,
    hint2: `Capital City: ${picked.capital} • Pattern: ${maskPattern(picked.name)}`,
    aliases: picked.aliases || [picked.name.toLowerCase()]
  };
}

/**
 * Returns a non-repetitive, 100% pure-symbol Car & Global Brand Logo challenge (zero text leaks).
 */
export async function getLiveLogoQuestion({ seenIds = new Set(), difficulty = 'ALL' } = {}) {
  let pool = CARS.filter((c) => !seenIds.has(c.id || `car_${c.name}`));
  if (difficulty && difficulty !== 'ALL') {
    const diffPool = pool.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }
  if (!pool.length) pool = CARS;
  const picked = pool[Math.floor(Math.random() * pool.length)];

  return {
    id: picked.id || `car_${picked.name.toLowerCase()}`,
    name: picked.name,
    displayName: `${picked.name} (${picked.category || picked.country}, est. ${picked.founded})`,
    difficulty: picked.difficulty || 'EASY',
    imageUrl: picked.imageUrl,
    hint1: `${picked.category || 'Brand Symbol'} • Origin: ${picked.country} (est. ${picked.founded})`,
    hint2: `Famous For: ${picked.famousModel} • Pattern: ${maskPattern(picked.name)}`,
    aliases: picked.aliases || [picked.name.toLowerCase()]
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
 * Fetches a live HD visual subject for Grid Quiz (3x3 Tile Reveal) or Picture Guessing (Pixel/Blur Uncover).
 * Alternates between Live Wikipedia HD Landmarks/Wildlife/Art and Live AniList Icons.
 */
export async function getLiveVisualMystery({ seenIds = new Set(), mode = 'grid' } = {}) {
  const candidates = LIVE_WIKI_SUBJECTS.filter((s) => !seenIds.has(`vis_${s.wikiTitle}`));
  const useWiki = candidates.length > 0 && Math.random() < 0.65;

  if (useWiki) {
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    for (const item of shuffled.slice(0, 3)) {
      const imgUrl = await fetchWikipediaSummaryImage(item.wikiTitle);
      if (imgUrl) {
        return {
          id: `vis_${item.wikiTitle}`,
          name: item.name,
          displayName: `${item.name} (${item.category})`,
          category: item.category,
          difficulty: 'MEDIUM',
          imageUrl: imgUrl,
          hint1: `Category: ${item.category} • ${item.clue1}`,
          hint2: `Name Pattern: ${maskPattern(item.name)}`,
          aliases: item.aliases
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
