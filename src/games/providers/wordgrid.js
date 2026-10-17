/**
 * Live 8x8 Word Grid Generator for Lancy Bot.
 * Places 10 non-repetitive hidden words (3 to 7 letters) into an 8x8 matrix
 * across all 8 directions (horizontal, vertical, diagonal, forward & reverse)
 * with intelligent letter-intersection packing.
 */

const WORDS_3 = [
  'ACE', 'ACT', 'AIR', 'ART', 'ASH', 'AWE', 'BAG', 'BAY', 'BED', 'BOX',
  'BOY', 'BUS', 'CAT', 'CAR', 'CAP', 'COW', 'CRY', 'CUP', 'CUT', 'DAD',
  'DAY', 'DEN', 'DEW', 'DOG', 'DOT', 'DRY', 'EAR', 'EAT', 'EGG', 'ELM',
  'END', 'ERA', 'EVE', 'EYE', 'FAN', 'FAR', 'FIG', 'FIN', 'FIT', 'FLY',
  'FOG', 'FOX', 'FUN', 'FUR', 'GAP', 'GAS', 'GEM', 'GYM', 'HAT', 'HEN',
  'HIP', 'HIT', 'HOP', 'HOT', 'HUG', 'ICE', 'INK', 'ION', 'IVY', 'JAM',
  'JAR', 'JAW', 'JET', 'JOB', 'JOG', 'JOY', 'KEY', 'KID', 'KIT', 'LAB',
  'LAW', 'LEG', 'LID', 'LIP', 'LOG', 'LOW', 'MAP', 'MAT', 'MEN', 'MIX',
  'MOB', 'MUD', 'MUG', 'NET', 'NEW', 'NOD', 'NUT', 'OAK', 'OAR', 'OAT',
  'OIL', 'OLD', 'OWL', 'PAD', 'PAL', 'PAN', 'PAW', 'PAY', 'PEA', 'PEN',
  'PET', 'PIE', 'PIG', 'PIN', 'PIT', 'POD', 'POP', 'POT', 'PUB', 'PUG',
  'RAM', 'RAN', 'RAT', 'RAW', 'RAY', 'RED', 'RIB', 'RID', 'RIM', 'RIP',
  'ROD', 'ROW', 'RUB', 'RUG', 'RUN', 'SAD', 'SAP', 'SAW', 'SEA', 'SET',
  'SHY', 'SIN', 'SIP', 'SIR', 'SIT', 'SIX', 'SKI', 'SKY', 'SLY', 'SOB',
  'SON', 'SOY', 'SPA', 'SPY', 'SUB', 'SUN', 'TAB', 'TAG', 'TAN', 'TAP',
  'TAR', 'TEA', 'TEN', 'TIE', 'TIN', 'TIP', 'TOE', 'TON', 'TOP', 'TOY',
  'TRY', 'TUB', 'TUG', 'VAN', 'VET', 'VOW', 'WAR', 'WAX', 'WAY', 'WEB',
  'WET', 'WIG', 'WIN', 'WIT', 'WOE', 'WOK', 'YAK', 'YAM', 'YAP', 'YAW',
  'YES', 'YET', 'YEW', 'ZAP', 'ZEN', 'ZIP', 'ZOO'
];

const WORDS_4 = [
  'AURA', 'APEX', 'ARCH', 'ARMY', 'ATOM', 'BACK', 'BALL', 'BAND', 'BANK', 'BARK',
  'BARN', 'BASE', 'BATH', 'BEAM', 'BEAR', 'BEAT', 'BELL', 'BELT', 'BEND', 'BEST',
  'BIKE', 'BIRD', 'BITE', 'BLEW', 'BLUE', 'BOAT', 'BODY', 'BOLD', 'BOLT', 'BOND',
  'BONE', 'BOOK', 'BOOM', 'BOOT', 'BOSS', 'BOWL', 'BULB', 'BURN', 'BUSH', 'CAFE',
  'CAGE', 'CAKE', 'CALL', 'CALM', 'CAMP', 'CAPE', 'CARD', 'CARE', 'CART', 'CASH',
  'CAST', 'CAVE', 'CELL', 'CHAT', 'CHEF', 'CHIN', 'CHIP', 'CITY', 'CLAW', 'CLAY',
  'CLIP', 'CLUB', 'CLUE', 'COAL', 'COAT', 'CODE', 'COIN', 'COLD', 'CONE', 'COOK',
  'COOL', 'COPY', 'CORD', 'CORE', 'CORN', 'COZY', 'CRAB', 'CREW', 'CROP', 'CROW',
  'CUBE', 'CURE', 'CURL', 'CYAN', 'DARK', 'DART', 'DASH', 'DATA', 'DAWN', 'DEAL',
  'DECK', 'DEEP', 'DEER', 'DESK', 'DIAL', 'DICE', 'DIRT', 'DISC', 'DISH', 'DIVE',
  'DOCK', 'DOME', 'DOOR', 'DOVE', 'DRAG', 'DRAW', 'DROP', 'DRUM', 'DUCK', 'DUEL',
  'DUKE', 'DULL', 'DUNE', 'DUSK', 'DUST', 'DUTY', 'EARN', 'EAST', 'EASY', 'ECHO',
  'EDGE', 'EPIC', 'EXIT', 'FACE', 'FACT', 'FADE', 'FAIR', 'FALL', 'FAME', 'FANG',
  'FARM', 'FAST', 'FATE', 'FEAR', 'FEED', 'FEEL', 'FILE', 'FILM', 'FIND', 'FIRE',
  'FIRM', 'FISH', 'FIST', 'FIVE', 'FLAG', 'FLAT', 'FLAW', 'FLEW', 'FLIP', 'FLOW',
  'FOAM', 'FOLD', 'FOLK', 'FONT', 'FOOD', 'FOOT', 'FORK', 'FORM', 'FORT', 'FREE',
  'FROG', 'FUEL', 'FULL', 'FUND', 'FUSE', 'GAIN', 'GALE', 'GAME', 'GATE', 'GEAR',
  'GIFT', 'GIRL', 'GLAD', 'GLOW', 'GLUE', 'GOAL', 'GOAT', 'GOLD', 'GOLF', 'GRAB',
  'GRAY', 'GREW', 'GRID', 'GRIM', 'GRIN', 'GRIP', 'GROW', 'GRUB', 'GULF', 'HALO',
  'HAND', 'HARP', 'HAWK', 'HAZE', 'HEAD', 'HEAL', 'HEAT', 'HERO', 'HIGH', 'HILL',
  'HINT', 'HOLD', 'HOME', 'HOOD', 'HOOK', 'HOPE', 'HORN', 'HOST', 'HUNT', 'ICON',
  'IDEA', 'IRON', 'ISLE', 'JADE', 'JAZZ', 'JUMP', 'KEEP', 'KING', 'KITE', 'KNOT',
  'LAKE', 'LAMP', 'LAND', 'LANE', 'LAVA', 'LEAF', 'LEAP', 'LIFE', 'LIFT', 'LIME',
  'LINE', 'LINK', 'LION', 'LIST', 'LIVE', 'LOAD', 'LOCK', 'LOOP', 'LORD', 'LOVE',
  'LUCK', 'LYNX', 'MAGE', 'MAIN', 'MALL', 'MARK', 'MASK', 'MATH', 'MAZE', 'MEAL',
  'MINT', 'MIST', 'MODE', 'MOON', 'MOSS', 'MOVE', 'MYTH', 'NAME', 'NAVY', 'NEON',
  'NEST', 'NEWS', 'NODE', 'NOON', 'NOTE', 'NOVA', 'OATH', 'ONYX', 'OPAL', 'OPEN',
  'PACE', 'PACK', 'PAGE', 'PALM', 'PARK', 'PART', 'PATH', 'PEAK', 'PEAR', 'PIER',
  'PINE', 'PINK', 'PIPE', 'PLAN', 'PLAY', 'PLOT', 'PLUG', 'PLUM', 'POEM', 'POET',
  'POLE', 'POND', 'POOL', 'PORT', 'POSE', 'POST', 'PURE', 'PUSH', 'QUIZ', 'RACE',
  'RAFT', 'RAIN', 'RANK', 'RARE', 'REEF', 'RENT', 'REST', 'RICE', 'RICH', 'RIDE',
  'RING', 'RISE', 'RISK', 'ROAD', 'ROAR', 'ROCK', 'ROLE', 'ROOF', 'ROOM', 'ROOT',
  'ROPE', 'ROSE', 'RUBY', 'RULE', 'RUSH', 'RUST', 'SAFE', 'SAGE', 'SAIL', 'SALT',
  'SAND', 'SAVE', 'SEAL', 'SEED', 'SELF', 'SHIP', 'SHOE', 'SHOP', 'SHOT', 'SHOW',
  'SIDE', 'SIGN', 'SILK', 'SINK', 'SITE', 'SIZE', 'SKIN', 'SKIP', 'SLAB', 'SLIP',
  'SLOT', 'SLOW', 'SNAP', 'SNOW', 'SOAP', 'SOCK', 'SOFT', 'SOIL', 'SOLO', 'SONG',
  'SOUL', 'SOUP', 'SPIN', 'SPOT', 'STAR', 'STAY', 'STEM', 'STEP', 'STOP', 'SUIT',
  'SURF', 'SWAN', 'SWAP', 'SWIM', 'SYNC', 'TAIL', 'TALE', 'TALK', 'TALL', 'TANK',
  'TAPE', 'TASK', 'TEAM', 'TEAR', 'TECH', 'TENT', 'TERM', 'TEST', 'TEXT', 'TIDE',
  'TILE', 'TIME', 'TINT', 'TONE', 'TOOL', 'TOUR', 'TOWN', 'TRAP', 'TRAY', 'TREE',
  'TREK', 'TRIM', 'TRIP', 'TRUE', 'TUBE', 'TUNE', 'TURN', 'TWIN', 'TYPE', 'UNIT',
  'VALE', 'VASE', 'VAST', 'VEIL', 'VEIN', 'VENT', 'VERB', 'VEST', 'VIBE', 'VIEW',
  'VINE', 'VOID', 'VOLT', 'VOTE', 'WAKE', 'WALK', 'WALL', 'WAND', 'WARM', 'WAVE',
  'WEAK', 'WEAR', 'WEEK', 'WELL', 'WEST', 'WILD', 'WILL', 'WIND', 'WINE', 'WING',
  'WIRE', 'WISE', 'WISH', 'WOLF', 'WOOD', 'WOOL', 'WORD', 'WORK', 'WORM', 'WRAP',
  'YARD', 'YARN', 'YEAR', 'YOGA', 'ZERO', 'ZINC', 'ZONE', 'ZOOM'
];

const WORDS_5 = [
  'SHACK', 'FLAME', 'DREAM', 'GHOST', 'SPARK', 'STORM', 'CLOUD', 'OCEAN', 'RIVER', 'TIGER',
  'EAGLE', 'SHARK', 'WHALE', 'SNAKE', 'ZEBRA', 'PANDA', 'KOALA', 'LEMON', 'MANGO', 'PEACH',
  'BERRY', 'MELON', 'GRAPE', 'APPLE', 'PIZZA', 'PASTA', 'SUSHI', 'STEAK', 'BREAD', 'CANDY',
  'MUSIC', 'DANCE', 'PIANO', 'DRUMS', 'ANIME', 'MANGA', 'NINJA', 'CYBER', 'PIXEL', 'LASER',
  'ROBOT', 'SPACE', 'ORBIT', 'COMET', 'SOLAR', 'LUNAR', 'EARTH', 'MAGIC', 'SPELL', 'WITCH',
  'CROWN', 'SWORD', 'ARMOR', 'ARROW', 'QUEST', 'GUILD', 'ARENA', 'PRIZE', 'MEDAL', 'SMILE',
  'LAUGH', 'PEACE', 'HEART', 'TRUST', 'BRAVE', 'SMART', 'QUICK', 'LUCKY', 'HAPPY', 'CHILL',
  'VIBES', 'TREND', 'FLASH', 'LIGHT', 'NIGHT', 'SHINE', 'GLINT', 'FROST', 'BLITZ', 'CRUSH',
  'PULSE', 'SURGE', 'DRIFT', 'BLADE', 'CHAIN', 'CHARM', 'CHASE', 'CHESS', 'CHIEF', 'CLIFF',
  'CLOCK', 'COAST', 'CORAL', 'CRANE', 'CREEK', 'CREST', 'CYCLE', 'DELTA', 'DEPTH', 'DINER',
  'ELITE', 'EMBER', 'FAITH', 'FEAST', 'FIELD', 'FIERY', 'FLAIR', 'FLEET', 'FLOAT', 'FLOCK',
  'FLOOR', 'FLUTE', 'FOCUS', 'FORGE', 'FRAME', 'FRESH', 'FRONT', 'FRUIT', 'GIANT', 'GLARE',
  'GLASS', 'GLIDE', 'GLOBE', 'GLORY', 'GRACE', 'GRAIN', 'GRAND', 'GRANT', 'GRAPH', 'GRASS',
  'GREAT', 'GREEN', 'GROVE', 'GUARD', 'GUIDE', 'HAVEN', 'HONEY', 'HONOR', 'HORSE', 'HOTEL',
  'HOUSE', 'HYPER', 'IMAGE', 'INDEX', 'IVORY', 'JEWEL', 'JOKER', 'JUDGE', 'JUICE', 'KARMA',
  'KINGS', 'LANCE', 'LOGIC', 'LOTUS', 'LYRIC', 'MAPLE', 'MARCH', 'MATCH', 'METRO', 'MIGHT',
  'MODEL', 'MONEY', 'MOUNT', 'MOUSE', 'MOVIE', 'NEXUS', 'NOBLE', 'NORTH', 'NOVEL', 'OASIS',
  'OLIVE', 'OMEGA', 'OPERA', 'OUTER', 'OWNER', 'PANEL', 'PARTY', 'PATCH', 'PEARL', 'PHASE',
  'PHONE', 'PHOTO', 'PILOT', 'PITCH', 'PLANT', 'PLATE', 'PLAZA', 'POINT', 'POKER', 'POLAR',
  'POWER', 'PRESS', 'PRIDE', 'PRIME', 'PRINT', 'PROOF', 'PROUD', 'QUEEN', 'QUIET', 'QUOTA',
  'QUOTE', 'RADAR', 'RADIO', 'RAVEN', 'REALM', 'REBEL', 'RIDER', 'RIDGE', 'ROYAL', 'RULER',
  'SALAD', 'SAUCE', 'SCALE', 'SCENE', 'SCOPE', 'SCORE', 'SCOUT', 'SENSE', 'SHADE', 'SHAKE',
  'SHAPE', 'SHARE', 'SHARP', 'SHELF', 'SHELL', 'SHIFT', 'SHIRT', 'SHOCK', 'SHORE', 'SHORT',
  'SIGHT', 'SIGMA', 'SIREN', 'SKILL', 'SKULL', 'SLATE', 'SLEEP', 'SLICE', 'SLIDE', 'SLOPE',
  'SMOKE', 'SNACK', 'SONIC', 'SOUND', 'SOUTH', 'SPADE', 'SPARE', 'SPEAK', 'SPEED', 'SPICE',
  'SPIKE', 'SPINE', 'SPORT', 'SQUAD', 'STACK', 'STAFF', 'STAGE', 'STAMP', 'STAND', 'START',
  'STATE', 'STEAM', 'STEEL', 'STICK', 'STILL', 'STOCK', 'STONE', 'STORE', 'STORY', 'STRIP',
  'STUDY', 'STYLE', 'SUGAR', 'SUITE', 'SUPER', 'SWEET', 'SWING', 'SYRUP', 'TABLE', 'TASTE',
  'THEME', 'THORN', 'THROW', 'THUMB', 'TITAN', 'TITLE', 'TOAST', 'TOKEN', 'TOPIC', 'TORCH',
  'TOTAL', 'TOUCH', 'TOWER', 'TRACE', 'TRACK', 'TRADE', 'TRAIL', 'TRAIN', 'TRAIT', 'TREAT',
  'TRIBE', 'TRICK', 'TROOP', 'TRUCK', 'TRUTH', 'TULIP', 'TURBO', 'TWIST', 'ULTRA', 'UNION',
  'UNITY', 'UPPER', 'URBAN', 'VALID', 'VALUE', 'VAULT', 'VENOM', 'VIDEO', 'VIGOR', 'VILLA',
  'VINYL', 'VIPER', 'VIRAL', 'VISTA', 'VITAL', 'VIVID', 'VOCAL', 'VOICE', 'VOTER', 'WAGON',
  'WATCH', 'WATER', 'WHEAT', 'WHEEL', 'WHITE', 'WHOLE', 'WORLD', 'WORTH', 'YACHT', 'YOUTH'
];

const WORDS_6_7 = [
  'BELIEF', 'PRANCE', 'DRAGON', 'GALAXY', 'PLANET', 'ROCKET', 'METEOR', 'NEBULA', 'COSMOS', 'CASTLE',
  'PALACE', 'TEMPLE', 'FOREST', 'JUNGLE', 'DESERT', 'ISLAND', 'CANYON', 'VALLEY', 'SUNSET', 'AURORA',
  'BREEZE', 'SHADOW', 'MIRROR', 'GOLDEN', 'SILVER', 'BRONZE', 'COPPER', 'LEGEND', 'MYTHIC', 'HEROIC',
  'KNIGHT', 'WIZARD', 'ARCHER', 'PIRATE', 'VIKING', 'SPIRIT', 'PORTAL', 'MATRIX', 'VORTEX', 'CIPHER',
  'PUZZLE', 'RIDDLE', 'SECRET', 'ARCADE', 'GAMING', 'STREAM', 'AVATAR', 'BANNER', 'SHIELD', 'DAGGER',
  'FALCON', 'JAGUAR', 'KRAKEN', 'COFFEE', 'MATCHA', 'COOKIE', 'WAFFLE', 'ACTION', 'ANCHOR', 'ARTIST',
  'AUTUMN', 'BEACON', 'BEAUTY', 'BLAZER', 'BRIDGE', 'BRIGHT', 'BUBBLE', 'BUCKET', 'BUTTON', 'CAMERA',
  'CANDLE', 'CANVAS', 'CARBON', 'CARPET', 'CENTER', 'CHANCE', 'CHARGE', 'CHERRY', 'CHOICE', 'CIRCLE',
  'CLEVER', 'COBALT', 'COLONY', 'COMBAT', 'COMEDY', 'CORNER', 'CROWN', 'CRUISE', 'CUSTOM', 'DANCER',
  'DANGER', 'DESIGN', 'DETAIL', 'DEVICE', 'DOLLAR', 'DOMAIN', 'DOUBLE', 'DRIVER', 'EMPIRE', 'ENERGY',
  'ENGINE', 'ESCAPE', 'EXOTIC', 'EXPERT', 'FACTOR', 'FAMILY', 'FATHER', 'FIGURE', 'FILTER', 'FINGER',
  'FINISH', 'FLIGHT', 'FLOWER', 'FUTURE', 'GARDEN', 'GARLIC', 'GENIUS', 'GLITCH', 'GLOBAL', 'GUITAR',
  'HAMMER', 'HARBOR', 'HEALTH', 'HELMET', 'HUNTER', 'IMPACT', 'KARATE', 'KERNEL', 'JACKET', 'LAUNCH',
  'LEADER', 'LUXURY', 'MAGNET', 'MARBLE', 'MARKET', 'MASTER', 'MEMORY', 'MENTOR', 'METHOD', 'MODERN',
  'MOMENT', 'MOTION', 'MUSEUM', 'MYSTIC', 'NATURE', 'NECTAR', 'NUMBER', 'OBJECT', 'OFFICE', 'OPTION',
  'ORANGE', 'ORIGIN', 'OXYGEN', 'PACKET', 'PARADE', 'PATROL', 'PEANUT', 'PEPPER', 'PERSON', 'PHOTON',
  'PILLAR', 'PLASMA', 'PLAYER', 'POCKET', 'POETRY', 'POLICY', 'POTION', 'POWDER', 'PRINCE', 'PROFIT',
  'PULSAR', 'PURPLE', 'QUARTZ', 'RABBIT', 'RANDOM', 'RANGER', 'REASON', 'RECORD', 'REFLEX', 'REGION',
  'REMOTE', 'REPLAY', 'REWARD', 'RHYTHM', 'RIBBON', 'RUNNER', 'SAFARI', 'SALMON', 'SAMPLE', 'SATURN',
  'SCHOOL', 'SCREEN', 'SCRIPT', 'SEARCH', 'SEASON', 'SECTOR', 'SENSOR', 'SERENE', 'SERVER', 'SIGNAL',
  'SILENT', 'SIMPLE', 'SINGLE', 'SKETCH', 'SMOOTH', 'SNIPER', 'SOCCER', 'SOCIAL', 'SOCKET', 'SOURCE',
  'SPHERE', 'SPIDER', 'SPRING', 'SQUARE', 'STATUE', 'STATUS', 'STEREO', 'STREET', 'STRIKE', 'STRING',
  'STRONG', 'STUDIO', 'SUBMIT', 'SUMMER', 'SUMMIT', 'SUPPER', 'SWITCH', 'SYMBOL', 'SYSTEM', 'TABLET',
  'TARGET', 'TALENT', 'TACTIC', 'TENNIS', 'THEORY', 'THREAD', 'THRONE', 'TICKET', 'TIMBER', 'TOMATO',
  'TRAVEL', 'TREATY', 'TRIPLE', 'TROPHY', 'TUNNEL', 'TURTLE', 'ULTIMA', 'UNIQUE', 'UPDATE', 'VALIANT',
  'VECTOR', 'VELVET', 'VENDOR', 'VERTEX', 'VESSEL', 'VICTOR', 'VISION', 'VISUAL', 'VOLUME', 'VOYAGE',
  'WALKER', 'WALLET', 'WEALTH', 'WEAPON', 'WINDOW', 'WINNER', 'WINTER', 'WISDOM', 'WONDER', 'YELLOW',
  'ZEPHYR', 'DIAMOND', 'EMERALD', 'CRYSTAL', 'THUNDER', 'PHANTOM', 'SAMURAI', 'PHOENIX', 'UNICORN',
  'MYSTERY', 'FORTUNE', 'VICTORY', 'TRIUMPH', 'PANTHER', 'GLACIER', 'VOLCANO', 'MONSTER', 'CAPTAIN',
  'DESTINY', 'HARMONY', 'GRAVITY', 'ECLIPSE', 'HORIZON', 'ODYSSEY', 'KINGDOM', 'MIRACLE', 'FREEDOM',
  'JOURNEY', 'COMPASS', 'LANTERN', 'WHISPER', 'BLOSSOM', 'RAINBOW', 'STARDUST', 'SKYLINE', 'NETWORK'
];

const DIRECTIONS = [
  [0, 1],   // Right →
  [1, 0],   // Down ↓
  [0, -1],  // Left ←
  [-1, 0],  // Up ↑
  [1, 1],   // Down-Right ↘
  [-1, -1], // Up-Left ↖
  [1, -1],  // Down-Left ↙
  [-1, 1]   // Up-Right ↗
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlaceWord(grid, word, r0, c0, dr, dc) {
  const size = grid.length;
  let intersections = 0;
  for (let i = 0; i < word.length; i++) {
    const r = r0 + dr * i;
    const c = c0 + dc * i;
    if (r < 0 || r >= size || c < 0 || c >= size) return -1;
    const cell = grid[r][c];
    if (cell !== null && cell !== word[i]) return -1;
    if (cell === word[i]) intersections++;
  }
  return intersections;
}

/**
 * Generates an 8x8 Word Grid with 10 hidden words (sorted by length then A-Z).
 */
export function generateLiveWordGrid({ size = 8 } = {}) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const placedWords = [];
  const usedSet = new Set();

  // Pick candidate pools: 2-3 long words (6-7 chars), 1-2 medium (5 chars), 1-2 (4 chars), 4-5 short (3 chars)
  const longPool = shuffle(WORDS_6_7.filter((w) => w.length <= size - 1));
  const med5Pool = shuffle(WORDS_5);
  const med4Pool = shuffle(WORDS_4);
  const short3Pool = shuffle(WORDS_3);

  const tryPlaceFromPool = (pool, targetCount) => {
    let count = 0;
    for (const word of pool) {
      if (count >= targetCount || placedWords.length >= 10) break;
      if (usedSet.has(word)) continue;
      // Avoid substrings of already placed words
      if (placedWords.some((pw) => pw.word.includes(word) || word.includes(pw.word))) continue;

      let bestPlacement = null;
      let bestScore = -1;

      const dirs = shuffle(DIRECTIONS);
      for (const [dr, dc] of dirs) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            const inter = canPlaceWord(grid, word, r, c, dr, dc);
            if (inter >= 0) {
              // Prefer placements that share 1-2 intersections so all 10 words pack cleanly into 8x8
              const score = inter * 10 + Math.random() * 3;
              if (score > bestScore) {
                bestScore = score;
                bestPlacement = { r0: r, c0: c, dr, dc };
              }
            }
          }
        }
      }

      if (bestPlacement) {
        const { r0, c0, dr, dc } = bestPlacement;
        for (let i = 0; i < word.length; i++) {
          grid[r0 + dr * i][c0 + dc * i] = word[i];
        }
        const r1 = r0 + dr * (word.length - 1);
        const c1 = c0 + dc * (word.length - 1);
        placedWords.push({
          word,
          r0,
          c0,
          r1,
          c1,
          foundBy: null,
          revealedChars: 1
        });
        usedSet.add(word);
        count++;
      }
    }
  };

  // Place longest words first so they anchor the 8x8 matrix
  tryPlaceFromPool(longPool, 3);
  tryPlaceFromPool(med5Pool, 1);
  tryPlaceFromPool(med4Pool, 1);
  tryPlaceFromPool(short3Pool, 10 - placedWords.length);

  // Fill any remaining empty cells with balanced uppercase letters
  const fillerAlphabet = 'EARIOTNSLCUDPMHGBFYWKVXZJQ';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!grid[r][c]) {
        grid[r][c] = fillerAlphabet[Math.floor(Math.random() * 20)];
      }
    }
  }

  // Sort the 10 hidden words from shortest to longest (and alphabetically within same length)
  // exactly matching the classic Word Grid layout:
  // ∘ D _ _
  // ∘ E _ _
  // ...
  // ∘ P _ _ _ _ _ _
  placedWords.sort((a, b) => {
    if (a.word.length !== b.word.length) return a.word.length - b.word.length;
    return a.word.localeCompare(b.word);
  });

  return {
    id: `wg_${Date.now()}`,
    size,
    grid,
    words: placedWords
  };
}

/**
 * Formats a Word Grid entry line:
 * - Unfound: `∘ P _ _ _ _ _ _` (or `∘ P R _ _ _ _ _` if hinted)
 * - Found:   `✅ PRANCE — @winner`
 */
export function formatWordGridEntry(entry) {
  const w = entry.word;
  if (entry.foundBy) {
    return `✅ ${w} — ${entry.foundBy}`;
  }
  const revealed = Math.max(1, Math.min(w.length - 1, entry.revealedChars || 1));
  const chars = [];
  for (let i = 0; i < w.length; i++) {
    chars.push(i < revealed ? w[i] : '_');
  }
  return `∘ ${chars.join(' ')}`;
}
