/**
 * Full Pokémon World Provider for Lancy Bot:
 * 1. Live PokéAPI v2 + Official HD & Shiny Artwork ("Who's That Pokémon?!")
 * 2. Curated Top 200+ Iconic Fan-Favorite Pokémon (Gen 1–9 All-Stars & Legends)
 * 3. Redacted Pokédex Flavor Clues, Type Badges, Base Stats & CP Calculation
 * 4. Interactive 1v1 Pokémon Stadium Duel Engine (PvP or vs Champion Lancy AI)
 */

import { RichMessageBuilder, rt, richButton } from '../../telegram/rich.js';
import { kvTable } from '../../telegram/ui.js';

export const TYPE_EMOJI = {
  Fire: '🔥',
  Water: '🌊',
  Electric: '⚡',
  Grass: '🌿',
  Psychic: '🔮',
  Ghost: '👻',
  Dark: '🌑',
  Dragon: '🐉',
  Ice: '❄️',
  Fairy: '✨',
  Fighting: '🥊',
  Steel: '⚙️',
  Flying: '🪽',
  Poison: '☠️',
  Ground: '🏜️',
  Rock: '🪨',
  Bug: '🦋',
  Normal: '⭐'
};

export const TYPE_CHART = {
  Fire: { strong: ['Grass', 'Ice', 'Bug', 'Steel'], weak: ['Water', 'Dragon', 'Rock', 'Fire'] },
  Water: { strong: ['Fire', 'Ground', 'Rock'], weak: ['Water', 'Grass', 'Dragon'] },
  Electric: { strong: ['Water', 'Flying'], weak: ['Electric', 'Grass', 'Dragon', 'Ground'] },
  Grass: { strong: ['Water', 'Ground', 'Rock'], weak: ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'] },
  Psychic: { strong: ['Fighting', 'Poison'], weak: ['Psychic', 'Steel', 'Dark'] },
  Ghost: { strong: ['Psychic', 'Ghost'], weak: ['Dark', 'Normal'] },
  Dark: { strong: ['Psychic', 'Ghost'], weak: ['Fighting', 'Dark', 'Fairy'] },
  Dragon: { strong: ['Dragon'], weak: ['Steel', 'Fairy'] },
  Ice: { strong: ['Grass', 'Ground', 'Flying', 'Dragon'], weak: ['Fire', 'Water', 'Ice', 'Steel'] },
  Fairy: { strong: ['Fighting', 'Dragon', 'Dark'], weak: ['Fire', 'Poison', 'Steel'] },
  Fighting: { strong: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'], weak: ['Poison', 'Flying', 'Psychic', 'Bug', 'Fairy', 'Ghost'] },
  Steel: { strong: ['Ice', 'Rock', 'Fairy'], weak: ['Fire', 'Water', 'Electric', 'Steel'] },
  Flying: { strong: ['Grass', 'Fighting', 'Bug'], weak: ['Electric', 'Rock', 'Steel'] },
  Poison: { strong: ['Grass', 'Fairy'], weak: ['Poison', 'Ground', 'Rock', 'Ghost', 'Steel'] },
  Ground: { strong: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'], weak: ['Grass', 'Bug', 'Flying'] },
  Rock: { strong: ['Fire', 'Ice', 'Flying', 'Bug'], weak: ['Fighting', 'Ground', 'Steel'] },
  Bug: { strong: ['Grass', 'Psychic', 'Dark'], weak: ['Fire', 'Fighting', 'Poison', 'Flying', 'Ghost', 'Steel', 'Fairy'] },
  Normal: { strong: [], weak: ['Rock', 'Steel', 'Ghost'] }
};

export const SIGNATURE_MOVES_BY_TYPE = {
  Fire: { name: 'Flamethrower', power: 34 },
  Water: { name: 'Hydro Pump', power: 35 },
  Electric: { name: 'Thunderbolt', power: 34 },
  Grass: { name: 'Leaf Blade', power: 33 },
  Psychic: { name: 'Psychic Blast', power: 34 },
  Ghost: { name: 'Shadow Ball', power: 34 },
  Dark: { name: 'Dark Pulse', power: 33 },
  Dragon: { name: 'Draco Meteor', power: 36 },
  Ice: { name: 'Ice Beam', power: 34 },
  Fairy: { name: 'Moonblast', power: 34 },
  Fighting: { name: 'Aura Sphere', power: 35 },
  Steel: { name: 'Flash Cannon', power: 33 },
  Flying: { name: 'Brave Bird', power: 34 },
  Poison: { name: 'Sludge Bomb', power: 33 },
  Ground: { name: 'Earthquake', power: 35 },
  Rock: { name: 'Stone Edge', power: 34 },
  Bug: { name: 'X-Scissor', power: 32 },
  Normal: { name: 'Hyper Voice', power: 32 }
};

/**
 * Curated list of 180+ Most Iconic, Globally-Known Pokémon IDs (Gen 1 Classics + Fan-Favorite Starters & Legends)
 */
export const ICONIC_POKEMON_IDS = [
  // Gen 1 Kanto Icons
  1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 18, 25, 26, 31, 34, 35, 36, 37, 38, 39,
  45, 52, 54, 55, 58, 59, 63, 64, 65, 66, 68, 76, 78, 79, 80, 82, 83, 92, 93,
  94, 95, 103, 104, 106, 107, 113, 115, 121, 122, 123, 125, 126, 127, 129, 130,
  131, 132, 133, 134, 135, 136, 137, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151,
  // Gen 2 Johto Icons
  152, 154, 155, 157, 158, 160, 169, 172, 175, 181, 196, 197, 202, 208, 212, 214,
  229, 230, 242, 243, 244, 245, 248, 249, 250, 251,
  // Gen 3 Hoenn Icons
  252, 254, 255, 257, 258, 260, 282, 289, 302, 306, 330, 334, 350, 359, 373, 376,
  380, 381, 382, 383, 384, 385, 386,
  // Gen 4 Sinnoh Icons
  387, 389, 390, 392, 393, 395, 405, 407, 445, 447, 448, 461, 462, 466, 467, 468,
  470, 471, 475, 478, 483, 484, 487, 491, 493,
  // Gen 5–9 Mega Fan-Favorites & Starters/Legends
  495, 500, 503, 553, 571, 609, 612, 635, 637, 643, 644, 658, 663, 700, 706, 716,
  717, 718, 722, 724, 727, 745, 778, 791, 792, 800, 807, 815, 887, 888, 908, 937, 959, 1007, 1008
];

const FALLBACK_POKEMON = [
  { id: 25, name: 'Pikachu', types: ['Electric'], region: 'Kanto (Gen I)', bst: 430, clue: 'When several of these gather, their electricity can build and cause lightning storms.' },
  { id: 6, name: 'Charizard', types: ['Fire', 'Flying'], region: 'Kanto (Gen I)', bst: 534, clue: 'Spits fire that is hot enough to melt boulders. Known to cause forest fires unintentionally.' },
  { id: 150, name: 'Mewtwo', types: ['Psychic'], region: 'Kanto (Gen I)', bst: 680, clue: 'Created by a scientist after years of horrific gene-splicing and DNA engineering experiments.' },
  { id: 448, name: 'Lucario', types: ['Fighting', 'Steel'], region: 'Sinnoh (Gen IV)', bst: 525, clue: 'By catching the Aura emanating from others, it can read their thoughts and movements.' },
  { id: 658, name: 'Greninja', types: ['Water', 'Dark'], region: 'Kalos (Gen VI)', bst: 530, clue: 'Creates throwing stars out of compressed water that can split metal in two.' },
  { id: 94, name: 'Gengar', types: ['Ghost', 'Poison'], region: 'Kanto (Gen I)', bst: 500, clue: 'Hides in shadows at night and absorbs warmth, making the surrounding air chill.' },
  { id: 133, name: 'Eevee', types: ['Normal'], region: 'Kanto (Gen I)', bst: 325, clue: 'Its unstable genetic code enables it to evolve into eight different elemental forms.' },
  { id: 384, name: 'Rayquaza', types: ['Dragon', 'Flying'], region: 'Hoenn (Gen III)', bst: 680, clue: 'Lives in the ozone layer far above the clouds and descends to calm Kyogre and Groudon.' },
  { id: 143, name: 'Snorlax', types: ['Normal'], region: 'Kanto (Gen I)', bst: 540, clue: 'Is not satisfied unless it eats over 880 pounds of food every day, then promptly goes to sleep.' },
  { id: 130, name: 'Gyarados', types: ['Water', 'Flying'], region: 'Kanto (Gen I)', bst: 540, clue: 'Evolves from Magikarp; known in ancient literature for rampaging through entire cities.' },
  { id: 197, name: 'Umbreon', types: ['Dark'], region: 'Johto (Gen II)', bst: 525, clue: 'When exposed to the moon\'s aura, the rings on its body glow faintly with mysterious power.' },
  { id: 282, name: 'Gardevoir', types: ['Psychic', 'Fairy'], region: 'Hoenn (Gen III)', bst: 518, clue: 'Will expend all its psychic power to create a small black hole in order to protect its Trainer.' },
  { id: 149, name: 'Dragonite', types: ['Dragon', 'Flying'], region: 'Kanto (Gen I)', bst: 600, clue: 'An extremely rare marine dragon said to circle the globe in just 16 hours.' },
  { id: 445, name: 'Garchomp', types: ['Dragon', 'Ground'], region: 'Sinnoh (Gen IV)', bst: 600, clue: 'Flies through the sky at sonic speed like a jet plane, never allowing its prey to escape.' },
  { id: 249, name: 'Lugia', types: ['Psychic', 'Flying'], region: 'Johto (Gen II)', bst: 680, clue: 'Known as the Guardian of the Seas; a light fluttering of its wings can cause a 40-day storm.' }
];

const pokemonCache = new Map();

function cap(str = '') {
  const s = String(str).trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function maskPokemonName(name = '') {
  return String(name)
    .split(/[\s-]+/)
    .map((w) => (w.length <= 2 ? w[0] + '_' : w[0] + ' ' + '_ '.repeat(Math.min(6, w.length - 2)).trim() + ' ' + w[w.length - 1]))
    .join('   ');
}

function regionFromGen(genName = '') {
  const g = String(genName).toLowerCase();
  if (g.includes('viii')) return 'Galar (Gen VIII)';
  if (g.includes('vii')) return 'Alola (Gen VII)';
  if (g.includes('vi')) return 'Kalos (Gen VI)';
  if (g.includes('ix')) return 'Paldea (Gen IX)';
  if (g.includes('iv')) return 'Sinnoh (Gen IV)';
  if (g.includes('iii')) return 'Hoenn (Gen III)';
  if (g.includes('ii')) return 'Johto (Gen II)';
  if (g.includes('v')) return 'Unova (Gen V)';
  return 'Kanto (Gen I)';
}

export function getPokemonArtworkUrl(pokemonId, isShiny = false) {
  const id = Number(pokemonId) || 25;
  return isShiny
    ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/${id}.png`
    : `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
}

/**
 * Fetches live Pokémon data + Species Pokédex flavor text from PokéAPI v2.
 */
async function fetchLivePokemonById(id) {
  if (pokemonCache.has(id)) return pokemonCache.get(id);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4200);
    const [pkRes, spRes] = await Promise.all([
      fetch(`https://pokeapi.co/api/v2/pokemon/${id}`, { signal: controller.signal }),
      fetch(`https://pokeapi.co/api/v2/pokemon-species/${id}`, { signal: controller.signal })
    ]);
    clearTimeout(timer);

    if (!pkRes.ok) return null;
    const pk = await pkRes.json();
    const sp = spRes.ok ? await spRes.json() : null;

    const englishName = sp?.names?.find((n) => n.language?.name === 'en')?.name || cap(pk.name);
    const types = (pk.types || []).map((t) => cap(t.type?.name)).filter(Boolean);
    const statsMap = {};
    let bst = 0;
    for (const s of pk.stats || []) {
      const val = Number(s.base_stat || 50);
      bst += val;
      statsMap[s.stat?.name] = val;
    }

    const region = regionFromGen(sp?.generation?.name);
    const genus = sp?.genera?.find((g) => g.language?.name === 'en')?.genus || 'Mystery Pokémon';

    // Pick a clean English flavor text entry and redact the Pokémon's name
    const enEntries = (sp?.flavor_text_entries || []).filter((f) => f.language?.name === 'en');
    let flavor = enEntries.length > 0
      ? enEntries[Math.floor(Math.random() * Math.min(4, enEntries.length))].flavor_text
      : `Known as the ${genus} from ${region}.`;
    flavor = String(flavor)
      .replace(/[\f\n\r\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const rx = new RegExp(englishName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    flavor = flavor.replace(rx, '???');
    const slugRx = new RegExp(String(pk.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    flavor = flavor.replace(slugRx, '???');

    const evolvesFrom = sp?.evolves_from_species?.name ? cap(sp.evolves_from_species.name) : null;
    const isLegendary = Boolean(sp?.is_legendary || sp?.is_mythical);

    const parsed = {
      pokemonId: Number(id),
      name: englishName,
      slug: String(pk.name).toLowerCase(),
      types: types.length ? types : ['Normal'],
      region,
      genus,
      bst: bst || 450,
      stats: {
        hp: statsMap.hp || 70,
        atk: statsMap.attack || 75,
        def: statsMap.defense || 70,
        spa: statsMap['special-attack'] || 75,
        spd: statsMap.speed || 75
      },
      flavor,
      evolvesFrom,
      isLegendary
    };

    pokemonCache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Generates a live "Who's That Pokémon?!" encounter (with 1-in-10 Wild Shiny chance!).
 */
export async function getLivePokemonQuestion({ seenIds = new Set() } = {}) {
  const unseenIds = ICONIC_POKEMON_IDS.filter((id) => !seenIds.has(`pk_${id}`));
  const pool = unseenIds.length > 0 ? unseenIds : ICONIC_POKEMON_IDS;
  const targetId = pool[Math.floor(Math.random() * pool.length)];

  // 1 in 10 chance of a Wild Shiny Encounter!
  const isShiny = Math.random() < 0.10;

  let data = await fetchLivePokemonById(targetId);
  if (!data) {
    const fb = FALLBACK_POKEMON[Math.floor(Math.random() * FALLBACK_POKEMON.length)];
    data = {
      pokemonId: fb.id,
      name: fb.name,
      slug: fb.name.toLowerCase(),
      types: fb.types,
      region: fb.region,
      genus: 'Iconic Pokémon',
      bst: fb.bst,
      stats: { hp: 80, atk: 88, def: 78, spa: 90, spd: 85 },
      flavor: fb.clue,
      evolvesFrom: null,
      isLegendary: fb.bst >= 600
    };
  }

  const typeBadges = data.types.map((t) => `${TYPE_EMOJI[t] || '⭐'} ${t}`).join(' • ');
  const baseCp = Math.round(data.bst * (1.8 + Math.random() * 0.6) * (isShiny ? 1.35 : 1) * (data.isLegendary ? 1.2 : 1));
  const evoText = data.evolvesFrom ? `Evolves from ${data.evolvesFrom}` : data.isLegendary ? '🌟 Legendary / Mythical' : 'Base / Special Stage';

  const allPokemonNames = FALLBACK_POKEMON.map((p) => p.name);
  const distractors = allPokemonNames
    .filter((n) => n.toLowerCase() !== data.name.toLowerCase())
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  while (distractors.length < 3) {
    distractors.push(`Wild Pokémon ${distractors.length + 1}`);
  }
  const options = [data.name, ...distractors].sort(() => Math.random() - 0.5);
  const correctIndex = options.indexOf(data.name);
  const letter = String.fromCharCode(65 + correctIndex).toLowerCase();

  const aliases = Array.from(new Set([
    data.name.toLowerCase(),
    data.slug.replace(/-/g, ' '),
    data.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    letter,
    `option ${letter}`,
    `${letter})`
  ]));

  return {
    id: `pk_${data.pokemonId}`,
    pokemonId: data.pokemonId,
    name: data.name,
    displayName: `${isShiny ? '✨ Shiny ' : ''}${data.name} (#${String(data.pokemonId).padStart(3, '0')})`,
    primaryType: data.types[0] || 'Electric',
    types: data.types,
    typeBadges,
    region: data.region,
    genus: data.genus,
    isShiny,
    isLegendary: data.isLegendary,
    rolledCp: baseCp,
    difficulty: data.isLegendary ? 'MEDIUM' : 'EASY',
    imageUrl: getPokemonArtworkUrl(data.pokemonId, isShiny),
    hint1: `${typeBadges} • ${data.region} (#${String(data.pokemonId).padStart(3, '0')})`,
    clueText: data.flavor,
    hint2: `${evoText} • Stats: HP ${data.stats.hp} | ATK ${data.stats.atk} | SPD ${data.stats.spd} • Pattern: ${maskPokemonName(data.name)}`,
    options,
    correctIndex,
    aliases
  };
}

/**
 * Builds the 10.3 Rich Message Trainer Card & Pokédex view for a user.
 */
export function buildPokedexRichMessage(user, stats, dexRows = [], groupTop = []) {
  const trainerName = user?.username ? `@${user.username}` : (user?.first_name || 'Trainer');
  const b = new RichMessageBuilder();

  b.heading('✦ LANCY POKÉDEX & TRAINER PASSPORT ✦', 1);
  b.paragraph(rt.italic('₊˚⊹♡  catch pokémon in /pokemon • build your dream team • battle in /pokebattle  ˙ᵕ˙'));
  b.divider();

  const bestPartner = stats.topPokemon
    ? `${stats.topPokemon.is_shiny ? '✨ ' : ''}${stats.topPokemon.pokemon_name} (${stats.topPokemon.best_cp} CP)`
    : 'None caught yet — play /pokemon!';

  b.table(kvTable([
    ['🎓 Trainer', `${trainerName} (${stats.rankTitle})`],
    ['📖 Unique Pokédex', `${stats.uniqueCount} / ${ICONIC_POKEMON_IDS.length} Iconic Species`],
    ['🔴 Total Caught', `${stats.totalCaptured} Pokémon`],
    ['✨ Shiny Vault', `${stats.shinyCount} Shiny Pokémon`],
    ['👑 Ace Partner', bestPartner]
  ]), { compact: true });

  if (dexRows.length > 0) {
    b.heading('⚡ YOUR TOP CAUGHT POKÉMON TEAM', 2);
    const teamRows = dexRows.slice(0, 8).map((r, idx) => [
      `${idx + 1}. ${r.is_shiny ? '✨ ' : ''}${r.pokemon_name}`,
      `${r.types}`,
      `${r.best_cp} CP (×${r.captures_count})`
    ]);
    b.table({
      headers: ['Pokémon', 'Element', 'Best CP'],
      rows: teamRows,
      align: ['left', 'left', 'right']
    });
  } else {
    b.blockquote('🌱 Your Pokédex is empty! Tap "⚡ Start Who\'s That Pokémon" below and snipe any wild Pokémon to catch it into your team!');
  }

  if (groupTop.length > 0) {
    b.heading('🏆 TOP TRAINERS LEADERBOARD', 3);
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lbRows = groupTop.slice(0, 5).map((row, i) => [
      `${medals[i] || '•'} ${row.username ? '@' + row.username : row.first_name}`,
      `${row.unique_dex} Dex ${row.shinies > 0 ? `(✨${row.shinies})` : ''}`,
      `${row.max_cp} CP`
    ]);
    b.table({
      headers: ['Trainer', 'Pokédex', 'Top CP'],
      rows: lbRows,
      align: ['left', 'center', 'right']
    });
  }

  b.buttons([
    richButton.callback('⚡ Play Who\'s That Pokémon', 'game_start:pokemon', { style: 'success' }),
    richButton.callback('⚔️ Pokémon 1v1 Stadium', 'game_start:pokebattle', { style: 'primary' })
  ]);
  b.buttons([
    richButton.callback('🔙 Game Hub', 'game_hub:visual', { style: 'primary' })
  ]);

  return b.toJSON();
}

/**
 * Creates a fighter object for the 1v1 Pokémon Stadium Battle from a user's top caught Pokémon
 * (or drafts an Iconic Legendary/Starter rental if the user has no captures yet).
 */
export function buildFighterPokemon(user, topDexRow = null) {
  const rentalPool = [
    { pokemon_id: 6, pokemon_name: 'Charizard', types: 'Fire / Flying', best_cp: 1850, is_shiny: 0 },
    { pokemon_id: 658, pokemon_name: 'Greninja', types: 'Water / Dark', best_cp: 1820, is_shiny: 0 },
    { pokemon_id: 448, pokemon_name: 'Lucario', types: 'Fighting / Steel', best_cp: 1800, is_shiny: 0 },
    { pokemon_id: 150, pokemon_name: 'Mewtwo', types: 'Psychic', best_cp: 2100, is_shiny: 0 },
    { pokemon_id: 384, pokemon_name: 'Rayquaza', types: 'Dragon / Flying', best_cp: 2150, is_shiny: 0 },
    { pokemon_id: 94, pokemon_name: 'Gengar', types: 'Ghost / Poison', best_cp: 1790, is_shiny: 0 },
    { pokemon_id: 25, pokemon_name: 'Pikachu', types: 'Electric', best_cp: 1750, is_shiny: 0 }
  ];

  const chosen = topDexRow || rentalPool[Math.floor(Math.random() * rentalPool.length)];
  const primaryType = String(chosen.types || 'Electric').split(/\s*\/\s*/)[0].trim() || 'Electric';
  const sig = SIGNATURE_MOVES_BY_TYPE[primaryType] || SIGNATURE_MOVES_BY_TYPE.Electric;
  const maxHp = Math.min(180, Math.max(110, Math.round((Number(chosen.best_cp) || 1600) / 14)));

  return {
    userId: user.id,
    trainerName: user.username ? `@${user.username}` : (user.first_name || 'Trainer'),
    pokemonId: chosen.pokemon_id,
    name: `${chosen.is_shiny ? '✨ ' : ''}${chosen.pokemon_name}`,
    primaryType,
    typesLabel: chosen.types,
    cp: chosen.best_cp || 1800,
    isRental: !topDexRow,
    hp: maxHp,
    maxHp,
    healsLeft: 2,
    moves: [
      { id: 0, label: `${TYPE_EMOJI[primaryType] || '⚡'} ${sig.name}`, power: sig.power, type: primaryType, accuracy: 0.95 },
      { id: 1, label: '💥 Hyper Strike', power: 44, type: 'Normal', accuracy: 0.78 },
      { id: 2, label: '⚡ Extreme Speed', power: 26, type: 'Normal', accuracy: 1.0, critBonus: 0.25 },
      { id: 3, label: '🍒 Sitrus Heal', healRatio: 0.32 }
    ]
  };
}

function hpBar(hp, maxHp) {
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const filled = Math.round(ratio * 8);
  const block = ratio > 0.5 ? '🟩' : ratio > 0.25 ? '🟨' : '🟥';
  return `${block.repeat(filled)}${'⬜'.repeat(8 - filled)} ${Math.max(0, hp)}/${maxHp} HP`;
}

export function getTypeMultiplier(attackType, defenderType) {
  const chart = TYPE_CHART[attackType];
  if (!chart) return 1.0;
  if (chart.strong.includes(defenderType)) return 1.6;
  if (chart.weak.includes(defenderType)) return 0.7;
  return 1.0;
}

/**
 * Renders the 10.3 Rich Message Stadium Duel Screen.
 */
export function renderPokemonDuelRich(session) {
  const st = session.boardState;
  const b = new RichMessageBuilder();
  b.heading('⚔️ POKÉMON STADIUM 1V1 DUEL ⚔️', 1);

  if (st.phase === 'lobby') {
    b.blockquote(`🏟️ ${st.p1.trainerName} sent out ${st.p1.name} (${st.p1.cp} CP)!\nWho will accept the Stadium Challenge, or battle Champion Cynthia (Lancy AI)?`);
    b.table(kvTable([
      ['🔴 Challenger', `${st.p1.trainerName} • ${st.p1.name} (${TYPE_EMOJI[st.p1.primaryType] || '⚡'} ${st.p1.typesLabel})`],
      ['🔵 Opponent', 'Waiting for Challenger...']
    ]), { compact: true });
    b.buttons([
      richButton.callback('⚔️ Accept Challenge (PvP)', 'game_pkduel:join:pvp', { style: 'success' }),
      richButton.callback('🤖 Battle Champion Lancy AI', 'game_pkduel:join:ai', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🛑 Cancel Match', 'game_ctl:stop', { style: 'danger' })
    ]);
    return b.toJSON();
  }

  const activeFighter = st.turn === 1 ? st.p1 : st.p2;
  b.table(kvTable([
    [`🔴 ${st.p1.trainerName} (${st.p1.name})`, hpBar(st.p1.hp, st.p1.maxHp)],
    [`🔵 ${st.p2.trainerName} (${st.p2.name})`, hpBar(st.p2.hp, st.p2.maxHp)],
    ['🎯 Current Turn', st.winner ? `🏆 Winner: ${st.winner.trainerName}!` : `⚡ ${activeFighter.trainerName}'s ${activeFighter.name}`]
  ]), { compact: true });

  b.blockquote(st.lastLog || `⚡ ${activeFighter.trainerName}, choose a move for ${activeFighter.name}!`);

  if (!st.winner) {
    const m = activeFighter.moves;
    b.buttons([
      richButton.callback(m[0].label, 'game_pkduel:move:0', { style: 'success' }),
      richButton.callback(m[1].label, 'game_pkduel:move:1', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback(m[2].label, 'game_pkduel:move:2', { style: 'primary' }),
      richButton.callback(`${m[3].label} (${activeFighter.healsLeft})`, 'game_pkduel:move:3', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🛑 End Match', 'game_ctl:stop', { style: 'danger' })
    ]);
  } else {
    b.buttons([
      richButton.callback('🔄 Rematch Stadium', 'game_start:pokebattle', { style: 'success' }),
      richButton.callback('📖 My Pokédex', 'game_pokedex:me', { style: 'primary' })
    ]);
  }

  return b.toJSON();
}
