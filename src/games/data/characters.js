/**
 * Iconic Characters Dataset covering Anime, Celebrities, and Pop Culture / Cartoons.
 * Includes high-quality character artwork, franchises, clues, and match aliases.
 */
export const CHARACTERS = [
  // ── ANIME & MANGA ─────────────────────────────────────────────────────
  {
    name: 'Gojo Satoru',
    category: 'Anime',
    universe: 'Jujutsu Kaisen',
    difficulty: 'EASY',
    clue1: 'Known as the strongest sorcerer with iconic Six Eyes and blindfold.',
    clue2: 'Signature technique: Limitless & Infinite Void.',
    imageUrl: 'https://images.alphacoders.com/133/1335359.png',
    aliases: ['gojo', 'satoru gojo', 'gojo satoru']
  },
  {
    name: 'Monkey D. Luffy',
    category: 'Anime',
    universe: 'One Piece',
    difficulty: 'EASY',
    clue1: 'A rubber-bodied captain aiming to become the Pirate King.',
    clue2: 'Wears an iconic straw hat and loves meat.',
    imageUrl: 'https://images5.alphacoders.com/132/1324707.png',
    aliases: ['luffy', 'monkey d luffy', 'straw hat']
  },
  {
    name: 'Naruto Uzumaki',
    category: 'Anime',
    universe: 'Naruto',
    difficulty: 'EASY',
    clue1: 'Jinchuriki of the Nine-Tailed Fox from the Hidden Leaf Village.',
    clue2: 'Signature jutsu: Shadow Clones & Rasengan; became the 7th Hokage.',
    imageUrl: 'https://images7.alphacoders.com/131/1310656.png',
    aliases: ['naruto', 'naruto uzumaki']
  },
  {
    name: 'Son Goku',
    category: 'Anime',
    universe: 'Dragon Ball',
    difficulty: 'EASY',
    clue1: 'Saiyan warrior sent to Earth who achieved Super Saiyan & Ultra Instinct.',
    clue2: 'Signature attack: Kamehameha Wave.',
    imageUrl: 'https://images3.alphacoders.com/132/1329864.png',
    aliases: ['goku', 'son goku', 'kakarot']
  },
  {
    name: 'Eren Yeager',
    category: 'Anime',
    universe: 'Attack on Titan',
    difficulty: 'EASY',
    clue1: 'Inheritor of the Attack Titan and Founding Titan who vowed to destroy the Titans.',
    clue2: 'Famous for his quote: "Tatakae" (Fight) and initiating the Rumbling.',
    imageUrl: 'https://images7.alphacoders.com/112/1122822.jpg',
    aliases: ['eren', 'eren yeager', 'eren jaeger']
  },
  {
    name: 'Anya Forger',
    category: 'Anime',
    universe: 'Spy x Family',
    difficulty: 'EASY',
    clue1: 'Telepathic foster daughter who loves peanuts and spy cartoons.',
    clue2: 'Famous for her smirking "Heh" face and dog named Bond.',
    imageUrl: 'https://images.alphacoders.com/123/1239857.jpg',
    aliases: ['anya', 'anya forger']
  },
  {
    name: 'Levi Ackerman',
    category: 'Anime',
    universe: 'Attack on Titan',
    difficulty: 'MEDIUM',
    clue1: "Humanity's strongest soldier and captain of the Special Operations Squad.",
    clue2: 'Known for his clean-freak habits and spinning dual-blade combat.',
    imageUrl: 'https://images6.alphacoders.com/131/1310329.jpeg',
    aliases: ['levi', 'levi ackerman', 'captain levi']
  },
  {
    name: 'Roronoa Zoro',
    category: 'Anime',
    universe: 'One Piece',
    difficulty: 'EASY',
    clue1: 'Pirate Hunter and master of the Three-Sword Style (Santoryu).',
    clue2: 'Famous for having zero sense of direction and green hair.',
    imageUrl: 'https://images8.alphacoders.com/132/1326168.png',
    aliases: ['zoro', 'roronoa zoro']
  },
  {
    name: 'Tanjiro Kamado',
    category: 'Anime',
    universe: 'Demon Slayer',
    difficulty: 'EASY',
    clue1: 'Wields a black Nichirin blade and carries his sister in a wooden box.',
    clue2: 'Practices Sun Breathing and Water Breathing.',
    imageUrl: 'https://images2.alphacoders.com/131/1311005.jpeg',
    aliases: ['tanjiro', 'tanjiro kamado']
  },
  {
    name: 'Killua Zoldyck',
    category: 'Anime',
    universe: 'Hunter x Hunter',
    difficulty: 'MEDIUM',
    clue1: 'Ex-assassin from the famous Zoldyck family who transmutes his aura into electricity.',
    clue2: 'Signature technique: Godspeed (Kanmuru).',
    imageUrl: 'https://images.alphacoders.com/131/1311287.jpeg',
    aliases: ['killua', 'killua zoldyck']
  },
  {
    name: 'Light Yagami',
    category: 'Anime',
    universe: 'Death Note',
    difficulty: 'MEDIUM',
    clue1: 'Brilliant student who found a supernatural notebook and proclaimed himself Kira.',
    clue2: 'Accompanied by the Shinigami Ryuk who loves apples.',
    imageUrl: 'https://images4.alphacoders.com/134/1340156.png',
    aliases: ['light', 'light yagami', 'kira']
  },
  {
    name: 'Saitama',
    category: 'Anime',
    universe: 'One Punch Man',
    difficulty: 'EASY',
    clue1: 'A hero for fun who can defeat any opponent with a single punch.',
    clue2: 'Lost his hair due to intense training: 100 pushups, 100 situps, 100 squats, 10km run.',
    imageUrl: 'https://images7.alphacoders.com/131/1311293.jpeg',
    aliases: ['saitama', 'one punch man']
  },

  // ── CELEBRITIES & SPORTS ICONS ────────────────────────────────────────
  {
    name: 'Cristiano Ronaldo',
    category: 'Celebrity',
    universe: 'Football / Sports',
    difficulty: 'EASY',
    clue1: 'Portuguese football icon famous for the number 7 and "SIUUU" celebration.',
    clue2: 'Has won 5 Ballon d\'Or awards and holds the record for most international goals.',
    imageUrl: 'https://images6.alphacoders.com/133/1335965.png',
    aliases: ['cristiano ronaldo', 'ronaldo', 'cr7', 'cristiano']
  },
  {
    name: 'Lionel Messi',
    category: 'Celebrity',
    universe: 'Football / Sports',
    difficulty: 'EASY',
    clue1: 'Argentine football legend known as "La Pulga", won the 2022 World Cup.',
    clue2: 'Record 8-time Ballon d\'Or winner and legendary FC Barcelona playmaker.',
    imageUrl: 'https://images8.alphacoders.com/131/1311545.jpeg',
    aliases: ['messi', 'lionel messi', 'leo messi']
  },
  {
    name: 'Drake',
    category: 'Celebrity',
    universe: 'Music / Hip Hop',
    difficulty: 'EASY',
    clue1: 'Canadian rapper and founder of OVO, known as "The 6 God".',
    clue2: 'Hit albums include "Take Care", "Views", and "Certified Lover Boy".',
    imageUrl: 'https://images.alphacoders.com/131/1312384.jpeg',
    aliases: ['drake', 'champagnepapi', 'aubrey graham']
  },
  {
    name: 'Taylor Swift',
    category: 'Celebrity',
    universe: 'Music / Pop',
    difficulty: 'EASY',
    clue1: 'Global pop superstar with the record-breaking "The Eras Tour".',
    clue2: 'Hit albums: "1989", "Red", "Folklore", and "Midnights".',
    imageUrl: 'https://images2.alphacoders.com/133/1332906.png',
    aliases: ['taylor swift', 'taylor']
  },
  {
    name: 'Michael Jackson',
    category: 'Celebrity',
    universe: 'Music / Pop Legend',
    difficulty: 'EASY',
    clue1: 'The "King of Pop" renowned for the Moonwalk dance and white glove.',
    clue2: 'Released "Thriller", the best-selling album of all time.',
    imageUrl: 'https://images7.alphacoders.com/131/1313420.jpeg',
    aliases: ['michael jackson', 'mj']
  },
  {
    name: 'The Weeknd',
    category: 'Celebrity',
    universe: 'Music / R&B',
    difficulty: 'EASY',
    clue1: 'Canadian artist known for "Blinding Lights", "Starboy", and red blazer aesthetic.',
    clue2: 'Real name: Abel Tesfaye; founder of XO records.',
    imageUrl: 'https://images2.alphacoders.com/131/1314562.jpeg',
    aliases: ['the weeknd', 'weeknd', 'abel tesfaye', 'abel']
  },
  {
    name: 'Billie Eilish',
    category: 'Celebrity',
    universe: 'Music / Alternative Pop',
    difficulty: 'MEDIUM',
    clue1: 'Grammy & Oscar-winning singer famous for "Bad Guy" and "Birds of a Feather".',
    clue2: 'Often collaborates closely with her producer brother Finneas.',
    imageUrl: 'https://images.alphacoders.com/131/1315892.jpeg',
    aliases: ['billie eilish', 'billie']
  },
  {
    name: 'Dwayne "The Rock" Johnson',
    category: 'Celebrity',
    universe: 'Hollywood / WWE',
    difficulty: 'EASY',
    clue1: 'WWE legend turned Hollywood superstar known as "The People\'s Champion".',
    clue2: 'Famous for "The People\'s Eyebrow" and movies like Jumanji & Fast & Furious.',
    imageUrl: 'https://images.alphacoders.com/131/1316021.jpeg',
    aliases: ['the rock', 'dwayne johnson', 'rock']
  },

  // ── CARTOONS & POP CULTURE HEROES ─────────────────────────────────────
  {
    name: 'Spider-Man',
    category: 'Comics & Cartoons',
    universe: 'Marvel Universe',
    difficulty: 'EASY',
    clue1: 'Bitten by a radioactive spider; his motto is "With great power comes great responsibility".',
    clue2: 'Secret identity: Peter Parker of Queens, New York.',
    imageUrl: 'https://images5.alphacoders.com/133/1331776.png',
    aliases: ['spider-man', 'spiderman', 'peter parker', 'spidey']
  },
  {
    name: 'Batman',
    category: 'Comics & Cartoons',
    universe: 'DC Universe',
    difficulty: 'EASY',
    clue1: 'The Dark Knight and protector of Gotham City who uses stealth and gadgets.',
    clue2: 'Secret identity: Billionaire Bruce Wayne.',
    imageUrl: 'https://images8.alphacoders.com/133/1333014.png',
    aliases: ['batman', 'bruce wayne', 'dark knight']
  },
  {
    name: 'SpongeBob SquarePants',
    category: 'Cartoons',
    universe: 'Nickelodeon',
    difficulty: 'EASY',
    clue1: 'Lives in a pineapple under the sea and works as a fry cook at the Krusty Krab.',
    clue2: 'Best friend: Patrick Star; pet snail: Gary.',
    imageUrl: 'https://images3.alphacoders.com/133/1334029.png',
    aliases: ['spongebob', 'spongebob squarepants']
  },
  {
    name: 'Ben 10',
    category: 'Cartoons',
    universe: 'Cartoon Network',
    difficulty: 'EASY',
    clue1: 'Wields the Omnitrix watch that transforms him into 10 alien heroes.',
    clue2: 'Famous aliens: Heatblast, Four Arms, XLR8, and Diamondhead.',
    imageUrl: 'https://images2.alphacoders.com/133/1335011.png',
    aliases: ['ben 10', 'ben tennyson']
  },
  {
    name: 'Shrek',
    category: 'Cartoons',
    universe: 'DreamWorks',
    difficulty: 'EASY',
    clue1: 'A lovable green ogre who lives in a swamp and travels with a talking Donkey.',
    clue2: 'Rescued Princess Fiona from a dragon-guarded tower.',
    imageUrl: 'https://images.alphacoders.com/133/1336024.png',
    aliases: ['shrek']
  },
  {
    name: 'Iron Man',
    category: 'Comics & Cartoons',
    universe: 'Marvel Universe',
    difficulty: 'EASY',
    clue1: 'Genius, billionaire, playboy, philanthropist protected by an armored suit.',
    clue2: 'Secret identity: Tony Stark; powered by an Arc Reactor.',
    imageUrl: 'https://images7.alphacoders.com/133/1337092.png',
    aliases: ['iron man', 'ironman', 'tony stark']
  },
  {
    name: 'Pikachu',
    category: 'Gaming & Anime',
    universe: 'Pokémon',
    difficulty: 'EASY',
    clue1: 'Electric mouse Pokémon and Ash Ketchum\'s loyal partner.',
    clue2: 'Signature attacks: Thunderbolt & Volt Tackle; says "Pika Pika!".',
    imageUrl: 'https://images.alphacoders.com/133/1338101.png',
    aliases: ['pikachu']
  }
];

/**
 * Returns a random character question item according to difficulty filter.
 */
export function getRandomCharacter(difficultyFilter = null, usedNames = new Set()) {
  let pool = CHARACTERS;
  if (difficultyFilter && ['EASY', 'MEDIUM', 'HARD'].includes(difficultyFilter.toUpperCase())) {
    pool = CHARACTERS.filter((c) => c.difficulty === difficultyFilter.toUpperCase());
  }

  const unused = pool.filter((c) => !usedNames.has(c.name));
  const candidateList = unused.length > 0 ? unused : pool;
  const picked = candidateList[Math.floor(Math.random() * candidateList.length)];
  usedNames.add(picked.name);

  return picked;
}
