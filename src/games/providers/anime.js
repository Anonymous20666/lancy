import { CHARACTERS } from '../data/characters.js';

/**
 * In-memory cache of live-fetched AniList / Jikan characters to keep rounds instant
 * while pulling across 1,500+ top anime characters dynamically.
 */
const liveAnimeCache = new Map(); // id -> character item
const fetchedPages = new Set();

function maskNameInBio(bio = '', name = '') {
  if (!bio) return '';
  let clean = String(bio)
    .replace(/~!.*?!~/gs, '') // remove AniList spoiler tags
    .replace(/<[^>]+>/g, '')
    .replace(/__+/g, '')
    .replace(/\*\*+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = String(name)
    .split(/[\s,.-]+/)
    .filter((p) => p.length >= 3);
  for (const part of parts) {
    const rx = new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    clean = clean.replace(rx, '???');
  }

  // Take first 1-2 meaningful sentences
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 20 && !/^(source|note|voice|age|birthday|height|weight):/i.test(s));

  const snippet = (sentences[0] || clean).slice(0, 145).trim();
  return snippet.length > 10 ? snippet : 'Iconic fan-favorite anime character.';
}

function buildNamePattern(name = '') {
  return String(name)
    .split(' ')
    .map((word) => {
      if (word.length <= 2) return word[0] + '_';
      return word[0] + '_'.repeat(Math.min(6, word.length - 2)) + word[word.length - 1];
    })
    .join('  ');
}

/**
 * Fetches a random page of top popular anime characters live from AniList GraphQL.
 */
async function fetchAniListPage(page = 1) {
  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 25) {
        characters(sort: FAVOURITES_DESC) {
          id
          name {
            full
            native
            alternative
          }
          image {
            large
          }
          description
          favourites
          media(sort: POPULARITY_DESC, type: ANIME, perPage: 2) {
            nodes {
              title {
                english
                romaji
              }
            }
          }
        }
      }
    }
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { page } }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    const chars = json?.data?.Page?.characters || [];
    const results = [];

    for (const c of chars) {
      const fullName = c?.name?.full?.trim();
      const img = c?.image?.large;
      if (!fullName || !img || img.includes('default.jpg')) continue;

      const mediaNode = c?.media?.nodes?.[0];
      const animeTitle = mediaNode?.title?.english || mediaNode?.title?.romaji;
      // Strictly exclude manga-only / novel-only characters without an anime adaptation
      if (!animeTitle) continue;

      const favs = Number(c.favourites || 0);
      // Only include genuinely popular, widely recognized characters
      if (favs < 14000) continue;

      const nameParts = fullName.split(/\s+/).filter((p) => p.length >= 3);
      const alts = (c?.name?.alternative || [])
        .map((a) => String(a).trim().toLowerCase())
        .filter((a) => a.length >= 3 && a.length <= 32);

      const aliases = Array.from(new Set([
        fullName.toLowerCase(),
        ...nameParts.map((p) => p.toLowerCase()),
        ...alts
      ]));

      const difficulty = favs > 35000 ? 'EASY' : favs > 22000 ? 'MEDIUM' : 'HARD';
      const bioClue = maskNameInBio(c.description, fullName);

      const item = {
        id: `al_${c.id}`,
        name: fullName,
        displayName: `${fullName} (${animeTitle})`,
        universe: animeTitle,
        difficulty,
        imageUrl: img,
        hint1: `Anime: ${animeTitle}`,
        hint2: `${bioClue} • Pattern: ${buildNamePattern(fullName)}`,
        aliases,
        favourites: favs
      };
      liveAnimeCache.set(item.id, item);
      results.push(item);
    }
    fetchedPages.add(page);
    return results;
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

function createAnimeMultipleChoice(targetName, candidatePool, existingAliases = []) {
  const cleanTarget = String(targetName).trim();
  const distractors = candidatePool
    .map((c) => (typeof c === 'string' ? c : c.name))
    .filter((n) => String(n).trim().toLowerCase() !== cleanTarget.toLowerCase())
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((n) => String(n).trim());

  while (distractors.length < 3) {
    distractors.push(`Anime Hero ${distractors.length + 1}`);
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
 * Returns a live, non-repetitive Popular Anime Character question (Top 150 All-Stars)
 * with 4 interactive multiple-choice buttons.
 */
export async function getLiveAnimeCharacter({ seenIds = new Set(), difficulty = 'ALL' } = {}) {
  // Strictly pull from Pages 1..6 (Top 150 Most Popular Anime Characters Worldwide)
  const maxPage = difficulty === 'EASY' ? 3 : 6;
  const randomPage = Math.floor(Math.random() * maxPage) + 1;

  if (!fetchedPages.has(randomPage) || liveAnimeCache.size < 35) {
    await fetchAniListPage(randomPage);
  }

  let candidates = Array.from(liveAnimeCache.values()).filter((c) => !seenIds.has(c.id));
  if (difficulty && difficulty !== 'ALL') {
    const diffFiltered = candidates.filter((c) => c.difficulty === difficulty);
    if (diffFiltered.length > 0) candidates = diffFiltered;
  }

  const pool = liveAnimeCache.size >= 10 ? Array.from(liveAnimeCache.values()) : CHARACTERS;

  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    const mc = createAnimeMultipleChoice(picked.name, pool, picked.aliases);
    return {
      ...picked,
      options: mc.options,
      correctIndex: mc.correctIndex,
      aliases: mc.aliases
    };
  }

  // Fallback to curated CHARACTERS if offline
  const fallbackPool = CHARACTERS.filter((c) => !seenIds.has(`cur_${c.name}`));
  const chosen = (fallbackPool.length ? fallbackPool : CHARACTERS)[
    Math.floor(Math.random() * (fallbackPool.length || CHARACTERS.length))
  ];
  const mc = createAnimeMultipleChoice(chosen.name, CHARACTERS, chosen.aliases || [chosen.name.toLowerCase()]);

  return {
    id: `cur_${chosen.name}`,
    name: chosen.name,
    displayName: `${chosen.name} (${chosen.universe})`,
    universe: chosen.universe,
    difficulty: chosen.difficulty || 'MEDIUM',
    imageUrl: chosen.imageUrl,
    hint1: `Franchise: ${chosen.universe} • ${chosen.clue1}`,
    hint2: `${chosen.clue2} • Pattern: ${buildNamePattern(chosen.name)}`,
    options: mc.options,
    correctIndex: mc.correctIndex,
    aliases: mc.aliases
  };
}
