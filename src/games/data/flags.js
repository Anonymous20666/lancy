/**
 * Extensive Flags Dataset with Tiered Difficulty, ISO 2-letter codes for FlagCDN,
 * capital city clues, continent information, and fuzzy match aliases.
 */
export const FLAGS = [
  // ── EASY (Commonly Recognized Flags) ──────────────────────────────────
  {
    name: 'United States',
    code: 'us',
    difficulty: 'EASY',
    continent: 'North America',
    capital: 'Washington, D.C.',
    aliases: ['united states', 'usa', 'america', 'us', 'united states of america']
  },
  {
    name: 'United Kingdom',
    code: 'gb',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'London',
    aliases: ['united kingdom', 'uk', 'britain', 'great britain', 'england']
  },
  {
    name: 'Nigeria',
    code: 'ng',
    difficulty: 'EASY',
    continent: 'Africa',
    capital: 'Abuja',
    aliases: ['nigeria', 'naija']
  },
  {
    name: 'France',
    code: 'fr',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Paris',
    aliases: ['france']
  },
  {
    name: 'Japan',
    code: 'jp',
    difficulty: 'EASY',
    continent: 'Asia',
    capital: 'Tokyo',
    aliases: ['japan', 'nippon']
  },
  {
    name: 'Brazil',
    code: 'br',
    difficulty: 'EASY',
    continent: 'South America',
    capital: 'Brasília',
    aliases: ['brazil', 'brasil']
  },
  {
    name: 'Germany',
    code: 'de',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Berlin',
    aliases: ['germany', 'deutschland']
  },
  {
    name: 'Canada',
    code: 'ca',
    difficulty: 'EASY',
    continent: 'North America',
    capital: 'Ottawa',
    aliases: ['canada']
  },
  {
    name: 'Italy',
    code: 'it',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Rome',
    aliases: ['italy', 'italia']
  },
  {
    name: 'Spain',
    code: 'es',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Madrid',
    aliases: ['spain', 'espana']
  },
  {
    name: 'South Korea',
    code: 'kr',
    difficulty: 'EASY',
    continent: 'Asia',
    capital: 'Seoul',
    aliases: ['south korea', 'korea']
  },
  {
    name: 'Australia',
    code: 'au',
    difficulty: 'EASY',
    continent: 'Oceania',
    capital: 'Canberra',
    aliases: ['australia', 'aussie']
  },
  {
    name: 'India',
    code: 'in',
    difficulty: 'EASY',
    continent: 'Asia',
    capital: 'New Delhi',
    aliases: ['india', 'bharat']
  },
  {
    name: 'South Africa',
    code: 'za',
    difficulty: 'EASY',
    continent: 'Africa',
    capital: 'Pretoria',
    aliases: ['south africa']
  },
  {
    name: 'Mexico',
    code: 'mx',
    difficulty: 'EASY',
    continent: 'North America',
    capital: 'Mexico City',
    aliases: ['mexico']
  },
  {
    name: 'Argentina',
    code: 'ar',
    difficulty: 'EASY',
    continent: 'South America',
    capital: 'Buenos Aires',
    aliases: ['argentina']
  },
  {
    name: 'China',
    code: 'cn',
    difficulty: 'EASY',
    continent: 'Asia',
    capital: 'Beijing',
    aliases: ['china', 'prc']
  },
  {
    name: 'Ghana',
    code: 'gh',
    difficulty: 'EASY',
    continent: 'Africa',
    capital: 'Accra',
    aliases: ['ghana']
  },
  {
    name: 'Jamaica',
    code: 'jm',
    difficulty: 'EASY',
    continent: 'North America',
    capital: 'Kingston',
    aliases: ['jamaica']
  },
  {
    name: 'Egypt',
    code: 'eg',
    difficulty: 'EASY',
    continent: 'Africa',
    capital: 'Cairo',
    aliases: ['egypt']
  },
  {
    name: 'Portugal',
    code: 'pt',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Lisbon',
    aliases: ['portugal']
  },
  {
    name: 'Netherlands',
    code: 'nl',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Amsterdam',
    aliases: ['netherlands', 'holland']
  },
  {
    name: 'Russia',
    code: 'ru',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Moscow',
    aliases: ['russia']
  },
  {
    name: 'Saudi Arabia',
    code: 'sa',
    difficulty: 'EASY',
    continent: 'Asia',
    capital: 'Riyadh',
    aliases: ['saudi arabia', 'saudi']
  },
  {
    name: 'Turkey',
    code: 'tr',
    difficulty: 'EASY',
    continent: 'Europe',
    capital: 'Ankara',
    aliases: ['turkey', 'turkiye']
  },

  // ── MEDIUM (Distinctive Patterns & Regional Powers) ──────────────────
  {
    name: 'Kazakhstan',
    code: 'kz',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Astana',
    aliases: ['kazakhstan', 'kazakh']
  },
  {
    name: 'Uruguay',
    code: 'uy',
    difficulty: 'MEDIUM',
    continent: 'South America',
    capital: 'Montevideo',
    aliases: ['uruguay']
  },
  {
    name: 'Nepal',
    code: 'np',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Kathmandu',
    aliases: ['nepal']
  },
  {
    name: 'Kenya',
    code: 'ke',
    difficulty: 'MEDIUM',
    continent: 'Africa',
    capital: 'Nairobi',
    aliases: ['kenya']
  },
  {
    name: 'Morocco',
    code: 'ma',
    difficulty: 'MEDIUM',
    continent: 'Africa',
    capital: 'Rabat',
    aliases: ['morocco']
  },
  {
    name: 'Greece',
    code: 'gr',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Athens',
    aliases: ['greece', 'hellas']
  },
  {
    name: 'Norway',
    code: 'no',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Oslo',
    aliases: ['norway', 'norge']
  },
  {
    name: 'Sweden',
    code: 'se',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Stockholm',
    aliases: ['sweden', 'sverige']
  },
  {
    name: 'Switzerland',
    code: 'ch',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Bern',
    aliases: ['switzerland', 'swiss']
  },
  {
    name: 'United Arab Emirates',
    code: 'ae',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Abu Dhabi',
    aliases: ['united arab emirates', 'uae', 'emirates']
  },
  {
    name: 'Colombia',
    code: 'co',
    difficulty: 'MEDIUM',
    continent: 'South America',
    capital: 'Bogotá',
    aliases: ['colombia']
  },
  {
    name: 'Chile',
    code: 'cl',
    difficulty: 'MEDIUM',
    continent: 'South America',
    capital: 'Santiago',
    aliases: ['chile']
  },
  {
    name: 'Peru',
    code: 'pe',
    difficulty: 'MEDIUM',
    continent: 'South America',
    capital: 'Lima',
    aliases: ['peru']
  },
  {
    name: 'Iceland',
    code: 'is',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Reykjavík',
    aliases: ['iceland']
  },
  {
    name: 'New Zealand',
    code: 'nz',
    difficulty: 'MEDIUM',
    continent: 'Oceania',
    capital: 'Wellington',
    aliases: ['new zealand', 'kiwi']
  },
  {
    name: 'Singapore',
    code: 'sg',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Singapore',
    aliases: ['singapore']
  },
  {
    name: 'Thailand',
    code: 'th',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Bangkok',
    aliases: ['thailand']
  },
  {
    name: 'Vietnam',
    code: 'vn',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Hanoi',
    aliases: ['vietnam']
  },
  {
    name: 'Philippines',
    code: 'ph',
    difficulty: 'MEDIUM',
    continent: 'Asia',
    capital: 'Manila',
    aliases: ['philippines', 'pilipinas']
  },
  {
    name: 'Cameroon',
    code: 'cm',
    difficulty: 'MEDIUM',
    continent: 'Africa',
    capital: 'Yaoundé',
    aliases: ['cameroon']
  },
  {
    name: 'Senegal',
    code: 'sn',
    difficulty: 'MEDIUM',
    continent: 'Africa',
    capital: 'Dakar',
    aliases: ['senegal']
  },
  {
    name: 'Ivory Coast',
    code: 'ci',
    difficulty: 'MEDIUM',
    continent: 'Africa',
    capital: 'Yamoussoukro',
    aliases: ['ivory coast', "cote d'ivoire", 'cote divoire']
  },
  {
    name: 'Croatia',
    code: 'hr',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Zagreb',
    aliases: ['croatia', 'hrvatska']
  },
  {
    name: 'Poland',
    code: 'pl',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Warsaw',
    aliases: ['poland', 'polska']
  },
  {
    name: 'Ukraine',
    code: 'ua',
    difficulty: 'MEDIUM',
    continent: 'Europe',
    capital: 'Kyiv',
    aliases: ['ukraine']
  },

  // ── HARD (Microstates, Island Nations & Lookalikes) ───────────────────
  {
    name: 'Bhutan',
    code: 'bt',
    difficulty: 'HARD',
    continent: 'Asia',
    capital: 'Thimphu',
    aliases: ['bhutan']
  },
  {
    name: 'Sri Lanka',
    code: 'lk',
    difficulty: 'HARD',
    continent: 'Asia',
    capital: 'Colombo',
    aliases: ['sri lanka', 'ceylon']
  },
  {
    name: 'Eswatini',
    code: 'sz',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Mbabane',
    aliases: ['eswatini', 'swaziland']
  },
  {
    name: 'Kiribati',
    code: 'ki',
    difficulty: 'HARD',
    continent: 'Oceania',
    capital: 'South Tarawa',
    aliases: ['kiribati']
  },
  {
    name: 'Saint Lucia',
    code: 'lc',
    difficulty: 'HARD',
    continent: 'North America',
    capital: 'Castries',
    aliases: ['saint lucia', 'st lucia']
  },
  {
    name: 'Seychelles',
    code: 'sc',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Victoria',
    aliases: ['seychelles']
  },
  {
    name: 'Madagascar',
    code: 'mg',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Antananarivo',
    aliases: ['madagascar']
  },
  {
    name: 'Suriname',
    code: 'sr',
    difficulty: 'HARD',
    continent: 'South America',
    capital: 'Paramaribo',
    aliases: ['suriname']
  },
  {
    name: 'Vanuatu',
    code: 'vu',
    difficulty: 'HARD',
    continent: 'Oceania',
    capital: 'Port Vila',
    aliases: ['vanuatu']
  },
  {
    name: 'Barbados',
    code: 'bb',
    difficulty: 'HARD',
    continent: 'North America',
    capital: 'Bridgetown',
    aliases: ['barbados']
  },
  {
    name: 'Mongolia',
    code: 'mn',
    difficulty: 'HARD',
    continent: 'Asia',
    capital: 'Ulaanbaatar',
    aliases: ['mongolia']
  },
  {
    name: 'Monaco',
    code: 'mc',
    difficulty: 'HARD',
    continent: 'Europe',
    capital: 'Monaco',
    aliases: ['monaco']
  },
  {
    name: 'Liechtenstein',
    code: 'li',
    difficulty: 'HARD',
    continent: 'Europe',
    capital: 'Vaduz',
    aliases: ['liechtenstein']
  },
  {
    name: 'Tuvalu',
    code: 'tv',
    difficulty: 'HARD',
    continent: 'Oceania',
    capital: 'Funafuti',
    aliases: ['tuvalu']
  },
  {
    name: 'San Marino',
    code: 'sm',
    difficulty: 'HARD',
    continent: 'Europe',
    capital: 'San Marino',
    aliases: ['san marino']
  },
  {
    name: 'Chad',
    code: 'td',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: "N'Djamena",
    aliases: ['chad']
  },
  {
    name: 'Papua New Guinea',
    code: 'pg',
    difficulty: 'HARD',
    continent: 'Oceania',
    capital: 'Port Moresby',
    aliases: ['papua new guinea', 'png']
  },
  {
    name: 'Djibouti',
    code: 'dj',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Djibouti',
    aliases: ['djibouti']
  },
  {
    name: 'Mauritius',
    code: 'mu',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Port Louis',
    aliases: ['mauritius']
  },
  {
    name: 'Eritrea',
    code: 'er',
    difficulty: 'HARD',
    continent: 'Africa',
    capital: 'Asmara',
    aliases: ['eritrea']
  }
];

/**
 * Returns a random flag item according to desired difficulty filter.
 */
export function getRandomFlag(difficultyFilter = null, usedCodes = new Set()) {
  let pool = FLAGS;
  if (difficultyFilter && ['EASY', 'MEDIUM', 'HARD'].includes(difficultyFilter.toUpperCase())) {
    pool = FLAGS.filter((f) => f.difficulty === difficultyFilter.toUpperCase());
  }

  const unused = pool.filter((f) => !usedCodes.has(f.code));
  const candidateList = unused.length > 0 ? unused : pool;
  const picked = candidateList[Math.floor(Math.random() * candidateList.length)];
  usedCodes.add(picked.code);

  return {
    ...picked,
    imageUrl: `https://flagcdn.com/w640/${picked.code}.png`
  };
}
