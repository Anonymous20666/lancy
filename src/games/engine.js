import { EventEmitter } from 'node:events';
import { RichMessageBuilder, rt, richButton } from '../telegram/rich.js';
import { kvTable, WINGS } from '../telegram/ui.js';
import {
  fetchImageBuffer,
  renderFramedMedia,
  renderGridMask,
  renderMysteryBlur,
  renderWordGrid,
  renderPokemonArenaCard
} from './visuals.js';
import { getLiveAnimeCharacter } from './providers/anime.js';
import { getLiveSongChallenge, getLiveLyricChallenge, MUSIC_CATEGORIES } from './providers/music.js';
import {
  getLiveFlagQuestion,
  getLiveCarLogoQuestion,
  getLiveBrandLogoQuestion,
  getLiveAppIconQuestion,
  getLiveLogoQuestion,
  getLiveVisualMystery
} from './providers/world.js';
import {
  getLiveTriviaQuestion,
  getLiveEmojiQuiz,
  getLiveWordScramble,
  getLiveRiddle,
  scrambleWordTiles
} from './providers/wordmind.js';
import { generateLiveWordGrid, formatWordGridEntry } from './providers/wordgrid.js';
import {
  getLivePokemonQuestion,
  buildPokedexRichMessage,
  buildFighterPokemon,
  getTypeMultiplier,
  renderPokemonDuelRich
} from './providers/pokemon.js';
import {
  createTicTacToeState,
  checkTicTacToeWinner,
  computeLancyTttMove,
  buildTicTacToeRich,
  createConnectFourState,
  dropConnectFourDisc,
  checkConnectFourWin,
  computeLancyConnectFourCol,
  buildConnectFourRich,
  createRpsState,
  resolveRpsClash,
  buildRpsRich,
  createNumberVaultState,
  getHeatFeedback,
  buildNumberVaultRich,
  generateHigherLowerPair,
  buildHigherLowerRich
} from './boards.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Levenshtein distance for typo-tolerant sniping in group chats.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

export function isFuzzyMatch(rawInput, aliases = []) {
  if (!rawInput || !aliases.length) return false;
  const trimmedRaw = String(rawInput).trim();
  if (trimmedRaw.length > 80) return false;

  let cleaned = trimmedRaw
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const prefixRegex = /^(is it|i think|maybe|could it be|its|it is|it's|this is|i guess|a|an|the)\s+/i;
  while (prefixRegex.test(cleaned)) {
    cleaned = cleaned.replace(prefixRegex, '').trim();
  }
  if (!cleaned) return false;

  for (const alias of aliases) {
    const target = String(alias || '').toLowerCase().trim();
    if (!target) continue;
    if (cleaned === target) return true;

    if (target.length >= 4 && cleaned.length <= target.length + 18) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const boundaryRegex = new RegExp(`(^|\\s)${escaped}($|\\s)`, 'i');
      if (boundaryRegex.test(cleaned)) return true;
    }

    if (target.length >= 5 && levenshtein(cleaned, target) <= 1) return true;
    if (target.length >= 8 && levenshtein(cleaned, target) <= 2) return true;
  }
  return false;
}

export const GAME_MODE_META = {
  pokemon: { title: 'POKÉMON WORLD • CATCH & SNIPE', icon: '⚡', tab: 'visual' },
  whosthatpokemon: { title: 'WHO\'S THAT POKÉMON?!', icon: '🔴', tab: 'visual' },
  wordgrid: { title: 'WORD GRID • FIND 10 HIDDEN WORDS', icon: '🔠', tab: 'mind', isBoard: true },
  anime: { title: 'GUESS THE ANIME CHARACTER', icon: '👀', tab: 'visual' },
  silhouette: { title: 'WHO\'S THAT CHARACTER', icon: '🕶️', tab: 'visual' },
  song: { title: 'GUESS THE SONG • BEAT DROP', icon: '🎵', tab: 'visual' },
  grid: { title: '3×3 MYSTERY PICTURE GRID', icon: '🧩', tab: 'visual' },
  picture: { title: 'PICTURE UNCOVER • HD BLUR', icon: '🖼️', tab: 'visual' },
  flags: { title: 'GUESS THE WORLD FLAG', icon: '🌍', tab: 'visual' },
  cars: { title: 'GUESS THE CAR LOGO • SUPERCARS & AUTOS', icon: '🏎️', tab: 'visual' },
  logos: { title: 'GUESS THE BRAND LOGO • FASHION & TECH', icon: '🏢', tab: 'visual' },
  icons: { title: 'GUESS THE APP & TECH ICON', icon: '📱', tab: 'visual' },
  logomix: { title: 'MIXED LOGO, CAR & ICON BLITZ', icon: '🚘', tab: 'visual' },
  emoji: { title: 'EMOJI QUIZ • DECODE THE VIBE', icon: '😎', tab: 'mind' },
  scramble: { title: 'WORD SCRAMBLE • ANAGRAM', icon: '🔤', tab: 'mind' },
  riddles: { title: 'RIDDLES & BRAIN TEASERS', icon: '🕵️', tab: 'mind' },
  trivia: { title: 'LIVE TRIVIA BATTLE', icon: '🧠', tab: 'mind' },
  lyrics: { title: 'FINISH THE LYRIC / CHORUS', icon: '🎤', tab: 'mind' },
  daily: { title: 'DAILY 3-STAGE GAUNTLET', icon: '🔥', tab: 'daily' },
  mixed: { title: 'ULTIMATE ARCADE MIX', icon: '🎲', tab: 'visual' },
  pokebattle: { title: 'POKÉMON 1V1 STADIUM DUEL', icon: '⚔️', tab: 'pvp', isBoard: true },
  ttt: { title: 'TIC-TAC-TOE ARENA', icon: '❌', tab: 'pvp', isBoard: true },
  connect4: { title: 'CONNECT FOUR GRAVITY', icon: '🔴', tab: 'pvp', isBoard: true },
  rps: { title: 'ROCK PAPER SCISSORS', icon: '🪨', tab: 'pvp', isBoard: true },
  number: { title: 'VAULT CRACKER 1–1000', icon: '🔐', tab: 'pvp', isBoard: true },
  highlow: { title: 'HIGHER OR LOWER • LIVE STATS', icon: '⬆️', tab: 'pvp', isBoard: true }
};

export class GameEngine extends EventEmitter {
  constructor({ api, db, log = console } = {}) {
    super();
    this.api = api;
    this.db = db;
    this.log = log;
    this.sessions = new Map(); // chatId -> Session
    this.chatModePreset = new Map(); // chatId -> 'unlimited' | 'rounds:5' | 'rounds:10' | 'rounds:15' | 'miss:3' | 'miss:5' | 'miss:10'
    this.chatRoundPrefs = new Map(); // chatId -> 0 (Unlimited) | 5 | 10 | 15
    this.chatMaxMissPrefs = new Map(); // chatId -> 0 (Truly Unlimited) | 3 | 5 | 10
    this.chatMusicCatPrefs = new Map(); // chatId -> 'afro' (Default Naija/Afrobeats) | 'pop' | 'rap' | 'all'
  }

  hasActiveGame(chatId) {
    return this.sessions.has(Number(chatId));
  }

  getSession(chatId) {
    return this.sessions.get(Number(chatId)) || null;
  }

  /**
   * Returns the single active mode preset for a chat so ONLY ONE button is ever selected!
   * Default: 'unlimited' (Pure Unlimited — nothing else pre-selected!).
   */
  getModePreset(chatId) {
    const cid = Number(chatId);
    return this.chatModePreset.get(cid) || 'unlimited';
  }

  /**
   * 0 = Unlimited rounds (default).
   */
  getPreferredRounds(chatId) {
    const cid = Number(chatId);
    return this.chatRoundPrefs.has(cid) ? this.chatRoundPrefs.get(cid) : 0;
  }

  setPreferredRounds(chatId, rounds) {
    const cid = Number(chatId);
    const num = Number(rounds);
    const r = [0, 5, 10, 15].includes(num) ? num : 0;
    this.chatRoundPrefs.set(cid, r);
    if (r === 0) {
      // Pure Unlimited selected! Clear any auto-stop selection so NOTHING else is selected for the user!
      this.chatModePreset.set(cid, 'unlimited');
      this.chatMaxMissPrefs.set(cid, 0);
      const active = this.sessions.get(cid);
      if (active) active.maxUnanswered = 0;
    } else {
      this.chatModePreset.set(cid, `rounds:${r}`);
      this.chatMaxMissPrefs.set(cid, 0);
    }
    return r;
  }

  /**
   * 0 = Pure Unlimited (no auto-stop when 'unlimited' is selected).
   * If user explicitly selects '3 Missed', '5 Missed', or '10 Missed', returns 3, 5, or 10.
   */
  getPreferredMaxMiss(chatId) {
    const cid = Number(chatId);
    return this.chatMaxMissPrefs.has(cid) ? this.chatMaxMissPrefs.get(cid) : 0;
  }

  setPreferredMaxMiss(chatId, maxMiss) {
    const cid = Number(chatId);
    const num = Math.max(1, Math.min(25, Number(maxMiss) || 5));
    this.chatMaxMissPrefs.set(cid, num);
    this.chatRoundPrefs.set(cid, 0);
    this.chatModePreset.set(cid, `miss:${num}`);
    const active = this.sessions.get(cid);
    if (active) {
      active.maxUnanswered = num;
    }
    return num;
  }

  /**
   * Music Category preference per chat ('afro' = Naija/Afrobeats default, 'pop', 'rap', 'all').
   */
  getPreferredMusicCategory(chatId) {
    const cid = Number(chatId);
    return this.chatMusicCatPrefs.get(cid) || 'afro';
  }

  setPreferredMusicCategory(chatId, cat) {
    const cid = Number(chatId);
    const clean = MUSIC_CATEGORIES[cat] ? cat : 'afro';
    this.chatMusicCatPrefs.set(cid, clean);
    const active = this.sessions.get(cid);
    if (active) {
      active.musicCategory = clean;
    }
    return clean;
  }

  /**
   * Builds the 100% Bot API 10.3 Rich Message 4-Tab Game Hub.
   */
  buildHubRichMessage(chatId, tab = 'visual') {
    const cid = Number(chatId);
    const activeTab = ['visual', 'mind', 'pvp', 'daily'].includes(tab) ? tab : 'visual';
    const preset = this.getModePreset(cid);
    const musicCat = this.getPreferredMusicCategory(cid);
    const musicMeta = MUSIC_CATEGORIES[musicCat] || MUSIC_CATEGORIES.afro;

    let modeDescription = '♾️ Unlimited Rounds (Non-Stop)';
    if (preset.startsWith('rounds:')) {
      modeDescription = `⚡ Fixed Match (${preset.split(':')[1]} Rounds)`;
    } else if (preset.startsWith('miss:')) {
      modeDescription = `🛑 Auto-Stop after ${preset.split(':')[1]} Missed Rounds`;
    }

    const topList = this.db?.getGameLeaderboard ? this.db.getGameLeaderboard(cid, 1) : [];
    const topPlayer = topList?.[0]
      ? `👑 ${topList[0].username ? '@' + topList[0].username : topList[0].first_name} (${topList[0].score} XP)`
      : 'No snipers crowned yet!';

    const b = new RichMessageBuilder();
    b.heading(`${WINGS} LANCY GAME ARENA ${WINGS}`, 1);
    b.paragraph(rt.italic('₊˚⊹♡  100% live group arcade • zero spam • 10.3 rich studio  ˙ᵕ˙'));
    b.divider();

    b.table(kvTable([
      ['👑 Group Champion', topPlayer],
      ['⚙️ Match Mode', modeDescription],
      ['🎵 Music Vibe', musicMeta.label],
      ['🧹 Zero-Spam Mode', 'Old round cards & wrong guesses auto-delete!']
    ]), { compact: true });

    // Expandable Blockquote Game Help Guide so players know how every button works!
    const helpGuideText =
`🎮 HOW TO USE THE GAME ARENA BUTTONS (TAP TO EXPAND):

1️⃣ CATEGORY TABS (Top 4 Buttons):
• 🎬 Visual & Audio — Pokémon World, Popular Anime, Guess the Song, Car Symbols, 3×3 Grid, Picture Uncover & Flags.
• 🧠 Mind & Words — 8×8 Word Grid (/grid), Word Scramble, Emoji Quiz, Live Trivia, Riddles & Finish the Lyric.
• ⚔️ PvP & Board — 1v1 Pokémon Stadium (/pokebattle), Tic-Tac-Toe, Connect 4, Rock Paper Scissors, Vault Cracker & Higher/Lower.
• 🏆 Daily & Top — 2× XP Daily Gauntlet, Group Top 10, Global Top 10 & Daily Streak Hall of Fame.

2️⃣ 🎵 MUSIC & LYRICS VIBE SELECTOR:
• Tap [🇳🇬 Naija/Afro], [🌍 Global Pop], [🎤 Rap & R&B], or [🔥 All Mix] to pick which songs & lyrics play in "Guess the Song" and "Finish the Lyric"!

3️⃣ ⚙️ MATCH LENGTH & MODE BUTTONS (Bottom Rows):
• ♾️ Unlimited — Runs non-stop without pre-selecting any other limit until you tap "🛑 End".
• ⚡ 5 / 🔥 10 / 👑 15 — Plays a fixed 5, 10, or 15-round tournament then shows the Victory Podium.
• 🛑 3 / 5 / 10 Missed — Runs unlimited rounds, but automatically stops if the group fails to answer 3, 5, or 10 rounds.

4️⃣ 🕹️ HOW TO PLAY & IN-GAME CONTROLS:
• Just type your answer in chat (typo-tolerant!) OR tap the A / B / C / D choice buttons!
• Tap 💡 Hint for a clue, ⏭️ Skip to jump to the next question, or 🛑 End to finish and view the Podium!`;

    b.expandableBlockquote(helpGuideText);

    // Category Tab Switcher
    b.buttons([
      richButton.callback('🎬 Visual & Audio', 'game_hub:visual', { style: activeTab === 'visual' ? 'success' : 'primary' }),
      richButton.callback('🧠 Mind & Words', 'game_hub:mind', { style: activeTab === 'mind' ? 'success' : 'primary' })
    ]);
    b.buttons([
      richButton.callback('⚔️ PvP & Board', 'game_hub:pvp', { style: activeTab === 'pvp' ? 'success' : 'primary' }),
      richButton.callback('🏆 Daily & Top', 'game_hub:daily', { style: activeTab === 'daily' ? 'success' : 'primary' })
    ]);
    b.divider();

    if (activeTab === 'visual') {
      b.heading('🎬 VISUAL, POKÉMON & AUDIO SNIPERS (LIVE)', 2);
      b.blockquote('Catch wild & ✨ Shiny Pokémon, snipe top popular anime icons, guess pure brand symbols, or play 30s audio beat drops ♡');
      b.buttons([
        richButton.callback('⚡ Pokémon World (Catch)', 'game_start:pokemon', { style: 'success' }),
        richButton.callback('👀 Popular Anime Icons', 'game_start:anime', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback(`🎵 Guess Song (${musicMeta.shortLabel})`, 'game_start:song', { style: 'success' }),
        richButton.callback('🏎️ Logos & Icons Studio →', 'game_sub:logos', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('🌍 Guess the Flag', 'game_start:flags', { style: 'primary' }),
        richButton.callback('🖼️ Picture & 3×3 Grid →', 'game_sub:picture', { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('📖 My Pokédex & Team', 'game_pokedex:me', { style: 'primary' }),
        richButton.callback('🎲 Ultimate Mixed Blitz', 'game_start:mixed', { style: 'success' })
      ]);
    } else if (activeTab === 'mind') {
      b.heading('🧠 WORD GRID, MIND & LYRIC BLITZ (LIVE)', 2);
      b.blockquote('Hunt 10 hidden words in the 8×8 Word Grid (/grid), unscramble anagrams, decode viral emojis, or finish iconic Naija & Global lyrics ♡');
      b.buttons([
        richButton.callback('🔠 Word Grid (10 Hidden Words)', 'game_start:wordgrid', { style: 'success' }),
        richButton.callback(`🎤 Finish Lyric (${musicMeta.shortLabel})`, 'game_start:lyrics', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('🧠 Live Trivia Battle', 'game_start:trivia', { style: 'success' }),
        richButton.callback('🔤 Word Scramble', 'game_start:scramble', { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('😎 Emoji Quiz', 'game_start:emoji', { style: 'primary' }),
        richButton.callback('🕵️ Riddles & Teasers', 'game_start:riddles', { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🔥 Daily Gauntlet (2× XP)', 'game_start:daily', { style: 'success' })
      ]);
    } else if (activeTab === 'pvp') {
      b.heading('⚔️ INTERACTIVE BOARD & STADIUM DUELS', 2);
      b.blockquote('Battle head-to-head with your caught Pokémon team, challenge friends in Tic-Tac-Toe / Connect 4, or duel Lancy AI ♡');
      b.buttons([
        richButton.callback('⚔️ Pokémon 1v1 Stadium', 'game_start:pokebattle', { style: 'success' }),
        richButton.callback('📖 My Pokédex', 'game_pokedex:me', { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('❌⭕ Tic-Tac-Toe (3×3 / 4×4)', 'game_start:ttt', { style: 'primary' }),
        richButton.callback('🔴🟡 Connect Four', 'game_start:connect4', { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🪨📄✂️ Rock Paper Scissors', 'game_start:rps', { style: 'primary' }),
        richButton.callback('🔐 Number Vault (1–1000)', 'game_start:number', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('⬆️⬇️ Higher or Lower (Live Stats)', 'game_start:highlow', { style: 'success' })
      ]);
    } else {
      b.heading('🏆 DAILY CHALLENGE & HALL OF FAME', 2);
      const topRows = this.db?.getGameLeaderboard ? this.db.getGameLeaderboard(cid, 5) : [];
      if (topRows.length > 0) {
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        const tableRows = [
          [
            { text: rt.bold('#'), is_header: true },
            { text: rt.bold('Player'), is_header: true },
            { text: rt.bold('XP'), is_header: true },
            { text: rt.bold('Best ⚡'), is_header: true }
          ],
          ...topRows.map((p, i) => [
            { text: medals[i] || `${i + 1}` },
            { text: rt.bold(p.username ? `@${p.username}` : (p.first_name || 'Player')) },
            { text: `${p.score} XP` },
            { text: p.fastest_ms ? `${(p.fastest_ms / 1000).toFixed(1)}s` : '—' }
          ])
        ];
        b.table(tableRows, { compact: true, bordered: true });
      } else {
        b.blockquote('No snipers on the board yet! Start any match below to claim #1 ♡');
      }
      b.buttons([
        richButton.callback('🔥 Launch Today\'s Daily Gauntlet (2× XP)', 'game_start:daily', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('💬 Group Top 10', 'game_lb:group', { style: 'primary' }),
        richButton.callback('🌍 Global Top 10', 'game_lb:global', { style: 'primary' }),
        richButton.callback('🔥 Daily Streaks', 'game_lb:streaks', { style: 'primary' })
      ]);
    }

    b.divider();
    // Music Category Selector (Naija/Afrobeats, Global Pop, Rap & R&B, All Mix)
    if (activeTab === 'visual' || activeTab === 'mind') {
      b.buttons([
        richButton.callback(`${musicCat === 'afro' ? '✓ ' : ''}🇳🇬 Naija/Afro`, `game_mcat:afro:${activeTab}`, { style: musicCat === 'afro' ? 'success' : 'primary' }),
        richButton.callback(`${musicCat === 'pop' ? '✓ ' : ''}🌍 Global Pop`, `game_mcat:pop:${activeTab}`, { style: musicCat === 'pop' ? 'success' : 'primary' }),
        richButton.callback(`${musicCat === 'rap' ? '✓ ' : ''}🎤 Rap & R&B`, `game_mcat:rap:${activeTab}`, { style: musicCat === 'rap' ? 'success' : 'primary' }),
        richButton.callback(`${musicCat === 'all' ? '✓ ' : ''}🔥 All Mix`, `game_mcat:all:${activeTab}`, { style: musicCat === 'all' ? 'success' : 'primary' })
      ]);
    }

    // Mutually-Exclusive Match Mode Selector: ONLY ONE button across both rows is ever selected!
    b.buttons([
      richButton.callback(`${preset === 'unlimited' ? '✓ ' : ''}♾️ Unlimited`, 'game_rounds:0:' + activeTab, { style: preset === 'unlimited' ? 'success' : 'primary' }),
      richButton.callback(`${preset === 'rounds:5' ? '✓ ' : ''}⚡ 5`, 'game_rounds:5:' + activeTab, { style: preset === 'rounds:5' ? 'success' : 'primary' }),
      richButton.callback(`${preset === 'rounds:10' ? '✓ ' : ''}🔥 10`, 'game_rounds:10:' + activeTab, { style: preset === 'rounds:10' ? 'success' : 'primary' }),
      richButton.callback(`${preset === 'rounds:15' ? '✓ ' : ''}👑 15`, 'game_rounds:15:' + activeTab, { style: preset === 'rounds:15' ? 'success' : 'primary' })
    ]);
    b.buttons([
      richButton.callback(`${preset === 'miss:3' ? '✓ ' : ''}🛑 3 Missed`, 'game_maxmiss:3:' + activeTab, { style: preset === 'miss:3' ? 'success' : 'primary' }),
      richButton.callback(`${preset === 'miss:5' ? '✓ ' : ''}🛑 5 Missed`, 'game_maxmiss:5:' + activeTab, { style: preset === 'miss:5' ? 'success' : 'primary' }),
      richButton.callback(`${preset === 'miss:10' ? '✓ ' : ''}🛑 10 Missed`, 'game_maxmiss:10:' + activeTab, { style: preset === 'miss:10' ? 'success' : 'primary' })
    ]);
    b.footer(rt.italic('zero-spam: finished round cards auto-delete after reveal • only podiums stay ♡'));

    b.validate();
    return b.toJSON();
  }

  /**
   * Builds the 100% Bot API 10.3 Rich Message Categorized Submenu (Logos Studio, Picture Studio).
   */
  buildSubmenuRichMessage(chatId, sub = 'logos') {
    const cid = Number(chatId);
    const b = new RichMessageBuilder();

    if (sub === 'picture') {
      b.heading(`${WINGS} PICTURE & GRID ARENA ${WINGS}`, 1);
      b.paragraph(rt.italic('₊˚⊹♡  high-definition visual uncover & 3×3 mystery grids  ˙ᵕ˙'));
      b.divider();
      b.blockquote('Uncover famous world landmarks, exotic wildlife & masterpiece art tile-by-tile or pixel-by-pixel with interactive 4-choice buttons! ♡');
      b.buttons([
        richButton.callback('🧩 3×3 Mystery Picture Grid', 'game_start:grid', { style: 'success' }),
        richButton.callback('🖼️ Picture Uncover (HD Blur)', 'game_start:picture', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('« Back to Main Arena', 'game_hub:visual', { style: 'primary' })
      ]);
      b.footer(rt.italic('zero-spam: old cards auto-clean • tap any button to start! ♡'));
      b.validate();
      return b.toJSON();
    }

    // Default: 'logos' submenu (Car Logos, Brand Logos, App Icons, Mixed)
    b.heading(`${WINGS} LOGOS, CARS & ICONS ARENA ${WINGS}`, 1);
    b.paragraph(rt.italic('₊˚⊹♡  pure symbol sniping • zero text leaks • 4-choice buttons  ˙ᵕ˙'));
    b.divider();
    b.blockquote('Every visual symbol has been 100% verified to contain zero brand text! Pick your favorite category below ♡');
    b.buttons([
      richButton.callback('🏎️ Car Logos Only (Supercars & Autos)', 'game_start:cars', { style: 'success' }),
      richButton.callback('🏢 Global Brands (Fashion & Tech)', 'game_start:logos', { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('📱 App & Gaming Icons (Gen-Z)', 'game_start:icons', { style: 'primary' }),
      richButton.callback('🎲 Mixed Brand & Emblem Blitz', 'game_start:logomix', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Back to Main Arena', 'game_hub:visual', { style: 'primary' })
    ]);
    b.footer(rt.italic('zero-spam: old cards auto-clean • tap any button to start! ♡'));
    b.validate();
    return b.toJSON();
  }

  /**
   * Builds the 100% Bot API 10.3 Rich Message Leaderboard Screen (Group, Global, or Daily Streaks).
   */
  buildLeaderboardRichMessage(chatId, scope = 'group') {
    const cid = Number(chatId);
    const b = new RichMessageBuilder();
    const title = scope === 'global'
      ? 'GLOBAL HALL OF FAME'
      : scope === 'streaks'
        ? 'DAILY GAUNTLET STREAKS'
        : 'GROUP HALL OF FAME';

    b.heading(`${WINGS} ${title} ${WINGS}`, 1);
    b.paragraph(rt.italic('₊˚⊹♡  top trivia snipers, speed records & daily legends  ˙ᵕ˙'));
    b.divider();

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    if (scope === 'streaks') {
      const rows = this.db?.getDailyStreakLeaderboard ? this.db.getDailyStreakLeaderboard(10) : [];
      if (!rows.length) {
        b.blockquote('No daily streaks recorded yet! Tap "Play Daily Gauntlet" to start your 🔥 streak today ♡');
      } else {
        const tableRows = [
          [
            { text: rt.bold('Rank'), is_header: true },
            { text: rt.bold('Player'), is_header: true },
            { text: rt.bold('Streak 🔥'), is_header: true },
            { text: rt.bold('Best'), is_header: true },
            { text: rt.bold('Clears'), is_header: true }
          ],
          ...rows.map((p, idx) => [
            { text: medals[idx] || `#${idx + 1}` },
            { text: rt.bold(p.username ? `@${p.username}` : (p.first_name || 'Player')) },
            { text: rt.bold(`🔥 ${p.current_streak}d`) },
            { text: `${p.best_streak}d` },
            { text: String(p.total_daily_wins || 1) }
          ])
        ];
        b.table(tableRows, { compact: true, bordered: true });
      }
    } else {
      const rows = scope === 'global'
        ? (this.db?.getGlobalGameLeaderboard ? this.db.getGlobalGameLeaderboard(10) : [])
        : (this.db?.getGameLeaderboard ? this.db.getGameLeaderboard(cid, 10) : []);

      if (!rows.length) {
        b.blockquote('No games played here yet! Tap below to launch a live match ♡');
      } else {
        const tableRows = [
          [
            { text: rt.bold('Rank'), is_header: true },
            { text: rt.bold('Player'), is_header: true },
            { text: rt.bold('Total XP'), is_header: true },
            { text: rt.bold('Wins 🏆'), is_header: true },
            { text: rt.bold('Fastest ⚡'), is_header: true }
          ],
          ...rows.map((p, idx) => [
            { text: medals[idx] || `#${idx + 1}` },
            { text: rt.bold(p.username ? `@${p.username}` : (p.first_name || 'Player')) },
            { text: rt.bold(`${p.score} XP`) },
            { text: String(p.games_won || 0) },
            { text: p.fastest_ms ? `${(p.fastest_ms / 1000).toFixed(1)}s` : '—' }
          ])
        ];
        b.table(tableRows, { compact: true, bordered: true });
      }
    }

    b.divider();
    b.buttons([
      richButton.callback('💬 Group Top 10', 'game_lb:group', { style: scope === 'group' ? 'success' : 'primary' }),
      richButton.callback('🌍 Global Top 10', 'game_lb:global', { style: scope === 'global' ? 'success' : 'primary' }),
      richButton.callback('🔥 Daily Streaks', 'game_lb:streaks', { style: scope === 'streaks' ? 'success' : 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎮 Back to Game Hub', 'game_hub:visual', { style: 'primary' }),
      richButton.callback('🔥 Play Daily Gauntlet', 'game_start:daily', { style: 'success' })
    ]);

    b.validate();
    return b.toJSON();
  }

  /**
   * Starts any of the 16 live game modes in a chat.
   * Default: Unlimited rounds (totalRounds = 0) until maxUnanswered (default 5) failed-to-answer rounds!
   */
  async startGame(chatId, {
    mode = 'flags',
    totalRounds = null,
    maxUnanswered = null,
    difficulty = 'ALL',
    musicCategory = null,
    startedBy = null
  } = {}) {
    const cid = Number(chatId);
    if (this.sessions.has(cid)) {
      const active = this.sessions.get(cid);
      if (active.state === 'ended' || active.state === 'stopped') {
        this.sessions.delete(cid);
      } else {
        return {
          ok: false,
          error: `A ${active.mode.toUpperCase()} match is already running in this chat! Tap "🛑 End" on the game card or send /game stop first ♡`
        };
      }
    }

    const normalizedMode = this.#normalizeMode(mode);
    const meta = GAME_MODE_META[normalizedMode] || GAME_MODE_META.flags;

    let rounds = this.getPreferredRounds(cid); // 0 = Unlimited by default!
    if (normalizedMode === 'daily') {
      rounds = 3;
    } else if (totalRounds !== null && totalRounds !== undefined) {
      const parsed = Number(totalRounds);
      rounds = Number.isFinite(parsed) && parsed > 0 ? Math.min(50, parsed) : 0;
    }

    const maxMiss = (maxUnanswered !== null && maxUnanswered !== undefined)
      ? Math.max(0, Math.min(25, Number(maxUnanswered)))
      : this.getPreferredMaxMiss(cid);

    const resolvedMusicCat = musicCategory && MUSIC_CATEGORIES[musicCategory]
      ? this.setPreferredMusicCategory(cid, musicCategory)
      : this.getPreferredMusicCategory(cid);

    const session = {
      chatId: cid,
      mode: normalizedMode,
      difficulty: String(difficulty || 'ALL').toUpperCase(),
      musicCategory: resolvedMusicCat,
      totalRounds: rounds, // 0 = Unlimited
      maxUnanswered: maxMiss, // 0 = Pure Unlimited (or 3/5/10 if selected)
      unansweredCount: 0,
      currentRound: 0,
      startedBy: startedBy || { id: 0, first_name: 'Player' },
      state: 'starting',
      scores: new Map(), // userId -> { id, name, username, score, streak, correctCount, fastestMs }
      matchSeenIds: new Set(),
      usedIds: this.db?.getSeenGameItems ? this.db.getSeenGameItems(cid, normalizedMode) : new Set(),
      currentQuestion: null,
      boardState: null,
      cardMessageId: null,
      roundGuessMsgIds: [], // Wrong guess message IDs to auto-delete when round ends
      roundStartTime: null,
      wrongUsersThisRound: new Set(),
      lastWinner: null,
      lastActionNotice: null,
      timerHandle: null,
      hint1Timeout: null,
      hint2Timeout: null
    };

    this.sessions.set(cid, session);
    this.log.info?.({ chatId: cid, mode: normalizedMode, rounds, maxMiss, musicCategory: resolvedMusicCat }, 'game session initialized');

    if (meta.isBoard) {
      await this.#startBoardSession(session);
    } else {
      void this.#runNextRound(session);
    }
    return { ok: true, session };
  }

  /**
   * Builds a user's persistent Pokédex & Trainer Passport Rich Message.
   */
  buildUserPokedexRich(chatId, user) {
    const cid = Number(chatId);
    const uid = Number(user?.id || 0);
    const stats = this.db?.getUserPokedexStats ? this.db.getUserPokedexStats(uid) : {
      uniqueCount: 0, totalCaptured: 0, shinyCount: 0, topPokemon: null, rankTitle: '🎒 Rookie Trainer'
    };
    const dexRows = this.db?.getUserPokedex ? this.db.getUserPokedex(uid, 10) : [];
    const groupTop = this.db?.getGroupPokedexLeaderboard ? this.db.getGroupPokedexLeaderboard(cid, 5) : [];
    return buildPokedexRichMessage(user, stats, dexRows, groupTop);
  }

  #normalizeMode(raw = 'flags') {
    const m = String(raw || 'flags').toLowerCase().trim();
    const aliases = {
      pokemon: 'pokemon', poke: 'pokemon', pkmn: 'pokemon', pokeworld: 'pokemon',
      whosthatpokemon: 'whosthatpokemon', pksilhouette: 'whosthatpokemon',
      pokebattle: 'pokebattle', pokeduel: 'pokebattle', pkduel: 'pokebattle',
      wordgrid: 'wordgrid', wgrid: 'wordgrid', wordsearch: 'wordgrid',
      flag: 'flags', flags: 'flags',
      car: 'cars', cars: 'cars',
      logo: 'logos', logos: 'logos',
      icon: 'icons', icons: 'icons',
      logomix: 'logomix',
      character: 'anime', characters: 'anime', anime: 'anime',
      silhouette: 'silhouette', whosthat: 'silhouette',
      song: 'song', music: 'song', audio: 'song', beat: 'song',
      grid: 'grid', gridquiz: 'grid', tilegrid: 'grid', picgrid: 'grid',
      picture: 'picture', pic: 'picture', photo: 'picture', blur: 'picture',
      emoji: 'emoji', emojis: 'emoji',
      scramble: 'scramble', word: 'scramble', anagram: 'scramble',
      riddle: 'riddles', riddles: 'riddles', teaser: 'riddles',
      trivia: 'trivia', quiz: 'trivia', poll: 'trivia', ai: 'trivia',
      lyric: 'lyrics', lyrics: 'lyrics', quote: 'lyrics',
      daily: 'daily', challenge: 'daily',
      mixed: 'mixed',
      ttt: 'ttt', tictactoe: 'ttt', xo: 'ttt',
      connect4: 'connect4', c4: 'connect4',
      rps: 'rps', rockpaperscissors: 'rps',
      number: 'number', vault: 'number', guessnumber: 'number',
      highlow: 'highlow', hl: 'highlow', higherlower: 'highlow'
    };
    return aliases[m] || 'flags';
  }

  /**
   * Deletes the finished round's game card and any wrong guess spam messages
   * so only the active round card, winning snipes, and final Victory Podium stay in chat.
   */
  async #cleanupFinishedRound(session, { deleteCard = true } = {}) {
    if (!session) return;
    const cid = session.chatId;

    if (deleteCard && session.cardMessageId) {
      const oldCardId = session.cardMessageId;
      session.cardMessageId = null;
      this.api.deleteMessage?.(cid, oldCardId)?.catch?.(() => {});
    }
  }

  /**
   * Initializes interactive board / duel modes (Word Grid, Pokémon Stadium, Tic-Tac-Toe, Connect 4, RPS, Vault Cracker, Higher/Lower).
   */
  async #startBoardSession(session) {
    session.state = 'in_board';
    const starter = session.startedBy || { id: 0, first_name: 'Player 1' };

    if (session.mode === 'wordgrid') {
      await this.#startNextWordGridBoard(session);
      return;
    }

    let richPayload = null;

    if (session.mode === 'pokebattle') {
      const topRow = this.db?.getUserPokedex ? this.db.getUserPokedex(starter.id, 1)?.[0] : null;
      const p1 = buildFighterPokemon(starter, topRow);
      session.boardState = {
        type: 'pokebattle',
        phase: 'lobby',
        p1,
        p2: null,
        turn: 1,
        winner: null,
        lastLog: null
      };
      richPayload = renderPokemonDuelRich(session);
    } else if (session.mode === 'ttt') {
      session.boardState = createTicTacToeState(starter, 3);
      richPayload = buildTicTacToeRich(session.boardState);
    } else if (session.mode === 'connect4') {
      session.boardState = createConnectFourState(starter);
      richPayload = buildConnectFourRich(session.boardState);
    } else if (session.mode === 'rps') {
      session.boardState = createRpsState(starter);
      richPayload = buildRpsRich(session.boardState);
    } else if (session.mode === 'number') {
      session.boardState = createNumberVaultState(starter);
      richPayload = buildNumberVaultRich(session.boardState);
    } else if (session.mode === 'highlow') {
      const pair = await generateHigherLowerPair(session.usedIds);
      session.boardState = {
        type: 'highlow',
        streak: 0,
        pair,
        revealed: false,
        gameOver: false,
        lastOutcome: null
      };
      richPayload = buildHigherLowerRich(session.boardState);
    }

    if (richPayload) {
      const sent = typeof this.api.sendRichMessage === 'function'
        ? await this.api.sendRichMessage(session.chatId, richPayload).catch((err) => {
            this.log.error?.({ err, chatId: session.chatId }, 'failed to send board rich message');
            return null;
          })
        : await this.api.sendMessage(session.chatId, 'Board game started').catch(() => null);
      session.cardMessageId = sent?.message_id || null;
      this.#armBoardInactivityTimer(session, 180_000);
    }
  }

  #armBoardInactivityTimer(session, ms = 180_000) {
    this.#clearSessionTimers(session);
    session.timerHandle = setTimeout(() => {
      if (this.sessions.get(session.chatId) === session) {
        this.sessions.delete(session.chatId);
      }
    }, ms);
    session.timerHandle?.unref?.();
  }

  /**
   * Stops and cleans up the active game session in the chat.
   * If players scored points during the match, posts the Victory Podium and deletes the active round card!
   */
  async stopGame(chatId, { user = null } = {}) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session) {
      return { ok: false, error: 'There is no active game in this chat right now ♡' };
    }

    session.isStopped = true;
    this.#clearSessionTimers(session);

    // Clean up the active round card & wrong guesses
    await this.#cleanupFinishedRound(session, { deleteCard: true });

    const stopper = user?.username ? `@${user.username}` : (user?.first_name || 'Player');

    // If players scored points in this round-based session, show the Victory Podium!
    if (session.scores && session.scores.size > 0) {
      await this.#finishGame(session, { reason: `Match ended by ${stopper}` });
      return { ok: true };
    }

    session.state = 'stopped';
    this.sessions.delete(cid);

    const b = new RichMessageBuilder();
    b.heading(`${WINGS} MATCH ENDED ${WINGS}`, 2);
    b.blockquote(`🛑 ${session.mode.toUpperCase()} match ended by ${stopper}. Tap below to launch a new game anytime! ♡`);
    b.buttons([
      richButton.callback('🎮 Open Game Hub', 'game_hub:visual', { style: 'primary' }),
      richButton.callback('🏆 Leaderboard', 'game_lb:group', { style: 'primary' })
    ]);

    if (typeof this.api.sendRichMessage === 'function') {
      await this.api.sendRichMessage(cid, b.toJSON()).catch(() => {});
    } else if (typeof this.api.sendMessage === 'function') {
      await this.api.sendMessage(cid, `🛑 ${session.mode.toUpperCase()} match ended`).catch(() => {});
    }
    return { ok: true };
  }

  /**
   * Skips the current round in a round-based game, briefly reveals the answer, then deletes the skipped card.
   */
  async skipRound(chatId, { user = null } = {}) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session || !session.currentQuestion) {
      return { ok: false, error: 'No active round to skip right now ♡' };
    }

    this.#clearSessionTimers(session);
    session.state = 'round_ended';
    const q = session.currentQuestion;
    const answer = q.displayName || q.name;
    const clickerTag = user?.username ? `@${user.username}` : (user?.first_name || 'Player');

    session.lastWinner = null;
    session.lastActionNotice = `⏭️ Round skipped by ${clickerTag}`;

    await this.#updateRoundCard(session, {
      stage: 3,
      bannerStatus: `⏭️ Round Skipped by ${clickerTag}!\n✅ Correct Answer: ${answer}`,
      showControls: false
    });

    await sleep(2500);
    if (!this.sessions.has(cid) || session.isStopped) return { ok: true };
    await this.#cleanupFinishedRound(session, { deleteCard: true });
    void this.#runNextRound(session);
    return { ok: true };
  }

  /**
   * Drops an early hint (or uncovers extra grid tiles / unblurs image) in the active round.
   */
  async giveHint(chatId, { user = null } = {}) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session || !session.currentQuestion || session.state !== 'in_round') {
      return { ok: false, error: 'No active question to hint right now ♡' };
    }

    const q = session.currentQuestion;
    q.currentStage = Math.min(2, (q.currentStage || 0) + 1);
    if (q.roundMode === 'grid') {
      this.#revealNextGridTiles(q, 2);
    }

    const clickerTag = user?.username ? `@${user.username}` : (user?.first_name || 'Player');
    session.lastActionNotice = `💡 Hint #${q.currentStage} unlocked by ${clickerTag}`;

    await this.#updateRoundCard(session, {
      stage: q.currentStage,
      bannerStatus: `💡 Hint #${q.currentStage} unlocked by ${clickerTag}! Check clues below ♡`
    });
    return { ok: true };
  }

  /**
   * Evaluates incoming group chat messages for Word Grid hunting, Number Vault guessing, and Round-based sniping!
   * Tracks wrong guesses so they are auto-deleted when the round ends to prevent chat spam,
   * and tracks group chat activity (`chatMessagesSinceCard`) so active boards/rounds repost at the bottom of the chat!
   */
  async handleChatMessage(message) {
    if (!message?.chat?.id || !message?.text) return false;
    const cid = Number(message.chat.id);
    const session = this.sessions.get(cid);
    if (!session) return false;

    session.chatMessagesSinceCard = (session.chatMessagesSinceCard || 0) + 1;
    const rawText = String(message.text).trim();

    // 1. Handle Word Grid (8x8 Hidden Word Search) typed words!
    if (session.state === 'in_board' && session.mode === 'wordgrid' && session.boardState?.words) {
      const upper = rawText.toUpperCase().replace(/[^A-Z]/g, '');
      const isSingleWord = rawText.split(/\s+/).length === 1 && !rawText.startsWith('/');
      const matchedEntry = session.boardState.words.find((w) => !w.foundBy && w.word === upper);
      if (matchedEntry) {
        await this.#processWordGridHit(session, message.from, matchedEntry);
        return true;
      }
      return false;
    }

    // 2. Handle Number Guessing (Vault Cracker) typed guesses
    if (session.state === 'in_board' && session.mode === 'number' && session.boardState && !session.boardState.winner) {
      if (/^\d{1,4}$/.test(rawText)) {
        const guess = Number(rawText);
        if (guess >= 1 && guess <= 1000) {
          await this.#processNumberVaultGuess(session, message.from, guess, { fromChat: true });
          return true;
        }
      }
      return false;
    }

    // 3. Handle Round-Based Trivia/Visual/Pokémon/Audio/Word Sniping
    if (session.state !== 'in_round' || !session.currentQuestion) return false;
    const fromUid = Number(message.from?.id);
    if (fromUid && session.wrongUsersThisRound.has(fromUid)) return false;

    const aliases = session.currentQuestion.aliases || [];
    if (!isFuzzyMatch(rawText, aliases)) {
      return false;
    }

    // Correct answer! Winner is announced and awarded XP!
    await this.#awardRoundWin(session, message.from);
    return true;
  }

  /**
   * Awards the round to the winning player, shows the winner on the Rich Message card for 3s,
   * auto-catches Pokémon into the winner's Pokédex if playing Pokémon World,
   * then deletes that round's card & wrong guesses before advancing!
   */
  async #awardRoundWin(session, fromUser) {
    if (session.state !== 'in_round') return;
    const cid = session.chatId;
    const reactionMs = session.roundStartTime ? Date.now() - session.roundStartTime : 4500;
    this.#clearSessionTimers(session);
    session.state = 'round_ended';
    session.unansweredCount = 0; // Reset unanswered streak!

    const uid = Number(fromUser.id);
    const existing = session.scores.get(uid) || {
      id: uid,
      name: fromUser.first_name || 'Player',
      username: fromUser.username || null,
      score: 0,
      streak: 0,
      correctCount: 0,
      fastestMs: null
    };

    for (const [otherId, p] of session.scores.entries()) {
      if (otherId !== uid) p.streak = 0;
    }

    existing.streak += 1;
    existing.correctCount += 1;

    const q = session.currentQuestion;
    const isPokemonRound = q.roundMode === 'pokemon' || q.roundMode === 'whosthatpokemon';
    const shinyBonus = (isPokemonRound && q.isShiny) ? 3.0 : 1.0;
    const basePoints = session.mode === 'daily' ? 200 : 100;
    const speedBonus = reactionMs < 4500 ? 50 : reactionMs < 9000 ? 25 : 0;
    const tileBonus = q.roundMode === 'grid' ? Math.max(0, (9 - (q.revealedTiles?.length || 1)) * 12) : 0;
    const streakMultiplier = existing.streak >= 3 ? 1.5 : existing.streak === 2 ? 1.25 : 1.0;
    const pointsAwarded = Math.round((basePoints + speedBonus + tileBonus) * streakMultiplier * shinyBonus);

    existing.score += pointsAwarded;
    if (!existing.fastestMs || reactionMs < existing.fastestMs) {
      existing.fastestMs = reactionMs;
    }
    session.scores.set(uid, existing);

    if (this.db) {
      this.db.recordGameAnswer(cid, fromUser, pointsAwarded, reactionMs);
    }

    let catchBannerLine = '';
    if (isPokemonRound && this.db?.recordPokemonCapture) {
      const catchRes = this.db.recordPokemonCapture({
        user: fromUser,
        chatId: cid,
        pokemonId: q.pokemonId,
        pokemonName: q.name,
        types: q.types,
        isShiny: q.isShiny,
        cp: q.rolledCp
      });
      if (catchRes) {
        const dexTag = catchRes.isNewDexEntry ? '🆕 NEW POKÉDEX ENTRY!' : `Caught ×${catchRes.capturesCount}`;
        catchBannerLine = `\n🔴 CAUGHT INTO POKÉDEX: ${q.isShiny ? '✨ Shiny ' : ''}${q.name} (${q.rolledCp} CP • ${dexTag})`;
      }
    }

    const answerName = q.displayName || q.name;
    const winnerTag = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || 'Player');
    const reactionSec = (reactionMs / 1000).toFixed(1);
    const streakBadge = existing.streak >= 2 ? ` • 🔥 ${existing.streak}x Streak!` : '';

    session.lastWinner = {
      name: winnerTag,
      points: pointsAwarded,
      reactionSec
    };
    session.lastActionNotice = `🎉 Last round sniped by ${winnerTag} (+${pointsAwarded} XP in ${reactionSec}s)`;

    await this.#updateRoundCard(session, {
      stage: 3, // Full HD reveal!
      bannerStatus: `🏆 WINNER: SNIPED BY ${winnerTag} in ${reactionSec}s! (+${pointsAwarded} XP${streakBadge})\n✅ Answer: ${answerName}${catchBannerLine}`,
      showControls: false
    });

    await sleep(3000);
    if (!this.sessions.has(cid) || session.isStopped) return;
    // Delete the finished round card & wrong guesses so the chat doesn't get spammed!
    await this.#cleanupFinishedRound(session, { deleteCard: true });
    void this.#runNextRound(session);
  }

  /**
   * Handles all button callbacks (`game_*`) for the Game Hub, Leaderboards, Pokédex, Active Rounds, and Interactive Boards.
   */
  async handleCallback(query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = String(query.data || '');
    const fromUser = query.from;

    if (!chatId) {
      await this.api.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'game_noop') {
      await this.api.answerCallbackQuery(query.id);
      return;
    }

    // 1. Hub Tab Navigation
    if (data.startsWith('game_hub:')) {
      const tab = data.split(':')[1] || 'visual';
      const rich = this.buildHubRichMessage(chatId, tab);
      await this.api.answerCallbackQuery(query.id);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(async () => {
          await this.api.sendRichMessage(chatId, rich).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, rich).catch(() => {});
      }
      return;
    }

    // 1b. Submenu Navigation (Logos Studio, Picture Studio)
    if (data.startsWith('game_sub:')) {
      const sub = data.split(':')[1] || 'logos';
      const rich = this.buildSubmenuRichMessage(chatId, sub);
      await this.api.answerCallbackQuery(query.id);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(async () => {
          await this.api.sendRichMessage(chatId, rich).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, rich).catch(() => {});
      }
      return;
    }

    // 1b. Personal Pokédex & Trainer Passport View
    if (data.startsWith('game_pokedex:')) {
      await this.api.answerCallbackQuery(query.id, { text: 'Opening your Pokédex & Trainer Passport! 📖' });
      const rich = this.buildUserPokedexRich(chatId, fromUser);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(async () => {
          await this.api.sendRichMessage(chatId, rich).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, rich).catch(() => {});
      }
      return;
    }

    // 2. Preferred Round Count Toggle (0 = Unlimited default, 5, 10, 15)
    if (data.startsWith('game_rounds:')) {
      const parts = data.split(':');
      const targetR = Number(parts[1]);
      const prevR = this.getPreferredRounds(chatId);
      const tab = parts[2] || 'visual';
      const label = targetR === 0 ? '♾️ Unlimited Rounds' : `${targetR} Rounds`;
      if (prevR === targetR) {
        await this.api.answerCallbackQuery(query.id, {
          text: `You've already selected ${label} before!`,
          show_alert: true
        });
        return;
      }
      const r = this.setPreferredRounds(chatId, targetR);
      await this.api.answerCallbackQuery(query.id, { text: `Match mode set to ${label}! ⚡` });
      const rich = this.buildHubRichMessage(chatId, tab);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(() => {});
      }
      return;
    }

    // 2b. Changeable Auto-Stop Unanswered Limit Toggle
    if (data.startsWith('game_maxmiss:')) {
      const parts = data.split(':');
      const targetM = Number(parts[1]) || 5;
      const prevM = this.getPreferredMaxMiss(chatId);
      const tab = parts[2] || 'visual';
      if (prevM === targetM) {
        await this.api.answerCallbackQuery(query.id, {
          text: `You've already selected ${targetM} unanswered rounds limit before!`,
          show_alert: true
        });
        return;
      }
      const m = this.setPreferredMaxMiss(chatId, targetM);
      await this.api.answerCallbackQuery(query.id, { text: `Auto-stop set to ${m} unanswered rounds! 🛑` });
      const rich = this.buildHubRichMessage(chatId, tab);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(() => {});
      }
      return;
    }

    // 2c. Music Category Selector Toggle (Naija/Afrobeats, Global Pop, Rap & R&B, All Mix)
    if (data.startsWith('game_mcat:')) {
      const parts = data.split(':');
      const targetCat = parts[1] || 'afro';
      const prevCat = this.getPreferredMusicCategory(chatId);
      const tab = parts[2] || 'visual';
      const meta = MUSIC_CATEGORIES[targetCat] || MUSIC_CATEGORIES.afro;
      if (prevCat === targetCat) {
        await this.api.answerCallbackQuery(query.id, {
          text: `You've already selected ${meta.label} category before!`,
          show_alert: true
        });
        return;
      }
      const cat = this.setPreferredMusicCategory(chatId, targetCat);
      await this.api.answerCallbackQuery(query.id, { text: `🎵 Music & Lyrics set to: ${meta.label}!` });
      const rich = this.buildHubRichMessage(chatId, tab);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(() => {});
      }
      return;
    }

    // 3. Leaderboard Scopes (Group, Global, Streaks)
    if (data === 'game_leaderboard' || data.startsWith('game_lb:')) {
      const scope = data.includes(':') ? data.split(':')[1] : 'group';
      await this.api.answerCallbackQuery(query.id);
      const rich = this.buildLeaderboardRichMessage(chatId, scope);
      if (messageId) {
        await this.api.editMessageRich(chatId, messageId, rich).catch(async () => {
          await this.api.sendRichMessage(chatId, rich).catch(() => {});
        });
      } else {
        await this.api.sendRichMessage(chatId, rich).catch(() => {});
      }
      return;
    }

    // 4. Launch Any Game Mode
    if (data.startsWith('game_start:')) {
      const mode = data.split(':')[1] || 'flags';
      const existing = this.sessions.get(Number(chatId));
      if (existing && (existing.state === 'in_board' && (existing.boardState?.winner || existing.boardState?.gameOver))) {
        this.#clearSessionTimers(existing);
        this.sessions.delete(Number(chatId));
      }

      const res = await this.startGame(chatId, {
        mode,
        startedBy: fromUser
      });
      if (!res.ok) {
        await this.api.answerCallbackQuery(query.id, { text: res.error, show_alert: true });
      } else {
        await this.api.answerCallbackQuery(query.id, { text: `Launching ${mode.toUpperCase()}! 🚀` });
        // Delete the Hub launcher card so it doesn't clutter the chat while the game runs!
        if (messageId) {
          this.api.deleteMessage?.(chatId, messageId)?.catch?.(() => {});
        }
      }
      return;
    }

    // 5. In-Round Controls (Hint, Skip, Stop, Reshuffle Scramble, Uncover Grid Tile, Multiple Choice Answer)
    const session = this.sessions.get(Number(chatId));
    if (!session) {
      await this.api.answerCallbackQuery(query.id, {
        text: '✕ This match has already ended! Start a new one with /game ♡',
        show_alert: true
      });
      return;
    }

    if (data.startsWith('game_ctrl:') || data.startsWith('game_ctl:')) {
      const action = data.split(':')[1];
      const clickerTag = fromUser?.username ? `@${fromUser.username}` : (fromUser?.first_name || 'Player');
      if (action === 'stop') {
        await this.api.answerCallbackQuery(query.id, { text: `Ending match (${fromUser.first_name})...` });
        await this.stopGame(chatId, { user: fromUser });
        return;
      }
      if (action === 'skip') {
        await this.api.answerCallbackQuery(query.id, { text: `Skipped by ${fromUser.first_name}! ⏭️` });
        await this.skipRound(chatId, { user: fromUser });
        return;
      }
      if (action === 'hint') {
        await this.api.answerCallbackQuery(query.id, { text: `Hint unlocked by ${fromUser.first_name}! 💡` });
        await this.giveHint(chatId, { user: fromUser });
        return;
      }
      if (action === 'shuffle' && session.currentQuestion?.roundMode === 'scramble') {
        session.currentQuestion.scrambledTiles = scrambleWordTiles(session.currentQuestion.name);
        await this.api.answerCallbackQuery(query.id, { text: `Tiles reshuffled by ${fromUser.first_name}! 🔀` });
        await this.#updateRoundCard(session, {
          stage: session.currentQuestion.currentStage || 0,
          bannerStatus: `🔀 Tiles reshuffled by ${clickerTag}! Type the unscrambled word in chat ♡`
        });
        return;
      }
      if (action === 'gridtile' && session.currentQuestion?.roundMode === 'grid') {
        const revealed = this.#revealNextGridTiles(session.currentQuestion, 2);
        await this.api.answerCallbackQuery(query.id, {
          text: revealed ? `2 mystery tiles unlocked by ${fromUser.first_name}! 🧩` : 'All tiles are already uncovered!'
        });
        if (revealed) {
          await this.#updateRoundCard(session, {
            stage: session.currentQuestion.currentStage || 0,
            bannerStatus: `🧩 ${session.currentQuestion.revealedTiles.length}/9 tiles uncovered by ${clickerTag}! Snipe the answer in chat ♡`
          });
        }
        return;
      }
    }

    // 5b. Word Grid Controls (Hint / Next Grid)
    if (data.startsWith('game_wg:')) {
      await this.#handleWordGridCallback(session, query, data);
      return;
    }

    // 5c. Pokémon 1v1 Stadium Duel Controls
    if (data.startsWith('game_pkduel:')) {
      await this.#handlePokemonDuelCallback(session, query, data);
      return;
    }

    // 6. Multiple-Choice Button Sniping (Trivia, Lyrics, etc.)
    if (data.startsWith('game_ans:')) {
      if (session.state !== 'in_round' || !session.currentQuestion) {
        await this.api.answerCallbackQuery(query.id, {
          text: '✕ Round already finished! Wait for the next round ♡',
          show_alert: true
        });
        return;
      }
      const uid = Number(fromUser.id);
      if (session.wrongUsersThisRound.has(uid)) {
        await this.api.answerCallbackQuery(query.id, {
          text: "✕ You've already selected this before! You are locked out for this round ♡",
          show_alert: true
        });
        return;
      }

      const pickedIdx = Number(data.split(':')[1]);
      const q = session.currentQuestion;
      const userTag = fromUser?.username ? `@${fromUser.username}` : (fromUser?.first_name || 'Player');
      if (pickedIdx === q.correctIndex) {
        await this.api.answerCallbackQuery(query.id, { text: `🎉 Bullseye, ${fromUser.first_name}! You sniped it!` });
        await this.#awardRoundWin(session, fromUser);
      } else {
        session.wrongUsersThisRound.add(uid);
        await this.api.answerCallbackQuery(query.id, {
          text: `✕ Wrong choice, ${fromUser.first_name}! You're locked out for this round.`,
          show_alert: true
        });
        await this.#updateRoundCard(session, {
          stage: q.currentStage || 0,
          bannerStatus: `⚠️ ${userTag} picked a wrong choice! Round is still open — tap or type to snipe!`
        });
      }
      return;
    }

    // 7. Interactive Board & Duel Callbacks
    if (data.startsWith('game_ttt:')) {
      await this.#handleTicTacToeCallback(session, query, data);
      return;
    }
    if (data.startsWith('game_c4:')) {
      await this.#handleConnectFourCallback(session, query, data);
      return;
    }
    if (data.startsWith('game_rps:')) {
      await this.#handleRpsCallback(session, query, data);
      return;
    }
    if (data.startsWith('game_num:')) {
      await this.#handleNumberVaultCallback(session, query, data);
      return;
    }
    if (data.startsWith('game_hl:')) {
      await this.#handleHigherLowerCallback(session, query, data);
      return;
    }

    await this.api.answerCallbackQuery(query.id);
  }

  /**
   * ── INTERACTIVE BOARD HANDLERS ──
   */
  async #handleTicTacToeCallback(session, query, data) {
    const state = session.boardState;
    if (!state || state.type !== 'ttt') return;
    const parts = data.split(':');
    const action = parts[1];
    const from = query.from;
    const uid = Number(from.id);

    if (action === 'size' && !state.p2 && state.moves === 0) {
      const newSize = Number(parts[2]) === 4 ? 4 : 3;
      session.boardState = createTicTacToeState(state.p1, newSize);
      await this.api.answerCallbackQuery(query.id, { text: `Switched to ${newSize}×${newSize} grid!` });
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildTicTacToeRich(session.boardState)).catch(() => {});
      return;
    }

    if (action === 'bot' && !state.p2) {
      state.p2 = { id: -1, name: 'Lancy AI', isBot: true };
      await this.api.answerCallbackQuery(query.id, { text: '🤖 Lancy AI joined as Player O!' });
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildTicTacToeRich(state)).catch(() => {});
      return;
    }

    if (action === 'move' && !state.winner) {
      const idx = Number(parts[2]);
      if (state.board[idx] !== null) {
        await this.api.answerCallbackQuery(query.id, { text: '✕ That tile is already taken! Pick an empty tile.', show_alert: true });
        return;
      }

      if (state.turn === 'X') {
        if (uid !== state.p1.id) {
          await this.api.answerCallbackQuery(query.id, { text: `Wait for ${state.p1.name} (❌) to make their move!` });
          return;
        }
        state.board[idx] = 'X';
        state.moves += 1;
      } else {
        // Turn is O
        if (!state.p2) {
          if (uid === state.p1.id) {
            await this.api.answerCallbackQuery(query.id, {
              text: 'Tap "🤖 Play vs Lancy AI" below if you want to play solo, or let another member tap a tile!',
              show_alert: true
            });
            return;
          }
          state.p2 = { id: uid, name: from.first_name || 'Player 2', username: from.username || null };
        } else if (uid !== state.p2.id) {
          await this.api.answerCallbackQuery(query.id, { text: `It is ${state.p2.name} (⭕)'s turn!` });
          return;
        }
        state.board[idx] = 'O';
        state.moves += 1;
      }

      let outcome = checkTicTacToeWinner(state.board, state.size);
      if (outcome) {
        state.winner = outcome.winner;
        state.winLine = outcome.winLine;
        this.#recordBoardVictory(session.chatId, state.winner === 'X' ? state.p1 : state.winner === 'O' ? state.p2 : null, 180);
      } else {
        state.turn = state.turn === 'X' ? 'O' : 'X';
        // If playing vs Lancy AI and it's O's turn, make AI move immediately!
        if (state.turn === 'O' && state.p2?.isBot) {
          const botIdx = computeLancyTttMove(state.board, state.size);
          if (botIdx !== -1) {
            state.board[botIdx] = 'O';
            state.moves += 1;
            outcome = checkTicTacToeWinner(state.board, state.size);
            if (outcome) {
              state.winner = outcome.winner;
              state.winLine = outcome.winLine;
            } else {
              state.turn = 'X';
            }
          }
        }
      }

      this.#armBoardInactivityTimer(session);
      await this.api.answerCallbackQuery(query.id);
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildTicTacToeRich(state)).catch(() => {});
    }
  }

  async #handleConnectFourCallback(session, query, data) {
    const state = session.boardState;
    if (!state || state.type !== 'connect4') return;
    const parts = data.split(':');
    const action = parts[1];
    const from = query.from;
    const uid = Number(from.id);

    if (action === 'bot' && !state.p2) {
      state.p2 = { id: -1, name: 'Lancy AI', isBot: true };
      await this.api.answerCallbackQuery(query.id, { text: '🤖 Lancy AI joined as Gold Discs!' });
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildConnectFourRich(state)).catch(() => {});
      return;
    }

    if (action === 'drop' && !state.winner) {
      const col = Number(parts[2]);
      if (state.turn === 'R') {
        if (uid !== state.p1.id) {
          await this.api.answerCallbackQuery(query.id, { text: `It's ${state.p1.name} (🔴)'s turn!` });
          return;
        }
      } else {
        if (!state.p2) {
          if (uid === state.p1.id) {
            await this.api.answerCallbackQuery(query.id, {
              text: 'Tap "🤖 Play vs Lancy AI" to play solo, or let a friend drop a Gold disc!',
              show_alert: true
            });
            return;
          }
          state.p2 = { id: uid, name: from.first_name || 'Player 2', username: from.username || null };
        } else if (uid !== state.p2.id) {
          await this.api.answerCallbackQuery(query.id, { text: `It's ${state.p2.name} (🟡)'s turn!` });
          return;
        }
      }

      const landedRow = dropConnectFourDisc(state, col);
      if (landedRow === -1) {
        await this.api.answerCallbackQuery(query.id, { text: '✕ That column is full! Pick another column.', show_alert: true });
        return;
      }

      let win = checkConnectFourWin(state.grid, state.rows, state.cols);
      if (win) {
        state.winner = win;
        this.#recordBoardVictory(session.chatId, win === 'R' ? state.p1 : win === 'Y' ? state.p2 : null, 220);
      } else {
        state.turn = state.turn === 'R' ? 'Y' : 'R';
        if (state.turn === 'Y' && state.p2?.isBot) {
          const aiCol = computeLancyConnectFourCol(state);
          if (aiCol !== -1) {
            dropConnectFourDisc(state, aiCol);
            win = checkConnectFourWin(state.grid, state.rows, state.cols);
            if (win) state.winner = win;
            else state.turn = 'R';
          }
        }
      }

      this.#armBoardInactivityTimer(session);
      await this.api.answerCallbackQuery(query.id);
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildConnectFourRich(state)).catch(() => {});
    }
  }

  async #handleRpsCallback(session, query, data) {
    const state = session.boardState;
    if (!state || state.type !== 'rps' || state.winner) return;
    const parts = data.split(':');
    const action = parts[1];
    const from = query.from;
    const uid = Number(from.id);

    if (action === 'bot' && !state.p2) {
      state.p2 = { id: -1, name: 'Lancy AI', isBot: true, hp: 3, choice: null };
      await this.api.answerCallbackQuery(query.id, { text: '🤖 Lancy AI stepped into the arena!' });
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildRpsRich(state)).catch(() => {});
      return;
    }

    if (action === 'pick') {
      const weapon = parts[2];
      if (uid === state.p1.id) {
        state.p1.choice = weapon;
        if (state.p2?.isBot) {
          const moves = ['rock', 'paper', 'scissors'];
          state.p2.choice = moves[Math.floor(Math.random() * moves.length)];
        }
      } else if (!state.p2) {
        state.p2 = { id: uid, name: from.first_name || 'Player 2', username: from.username || null, hp: 3, choice: weapon };
      } else if (uid === state.p2.id) {
        state.p2.choice = weapon;
      } else {
        await this.api.answerCallbackQuery(query.id, { text: 'This duel is between the two active fighters!' });
        return;
      }

      if (state.p1.choice && state.p2?.choice) {
        resolveRpsClash(state);
        if (state.winner && !state.winner.isBot) {
          this.#recordBoardVictory(session.chatId, state.winner, 150);
        }
        await this.api.answerCallbackQuery(query.id, { text: '⚔️ Clash resolved!' });
      } else {
        await this.api.answerCallbackQuery(query.id, {
          text: `🔒 Locked in ${weapon.toUpperCase()}! Waiting for opponent...`
        });
      }

      this.#armBoardInactivityTimer(session);
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildRpsRich(state)).catch(() => {});
    }
  }

  async #handleNumberVaultCallback(session, query, data) {
    const state = session.boardState;
    if (!state || state.type !== 'number' || state.winner) return;
    const parts = data.split(':');
    const action = parts[1];

    if (action === 'clue') {
      state.clueUnlocked = true;
      await this.api.answerCallbackQuery(query.id, { text: '💡 Vault Intel unlocked!' });
      await this.api.editMessageRich(session.chatId, session.cardMessageId, buildNumberVaultRich(state)).catch(() => {});
      return;
    }

    if (action === 'guess') {
      const guess = Number(parts[2]);
      await this.api.answerCallbackQuery(query.id, { text: `Probing ${guess}...` });
      await this.#processNumberVaultGuess(session, query.from, guess);
    }
  }

  async #processNumberVaultGuess(session, fromUser, guess, { fromChat = false } = {}) {
    const state = session.boardState;
    if (!state || state.winner) return;

    state.attempts += 1;
    const playerTag = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || 'Player');

    if (guess === state.secret) {
      state.winner = { id: Number(fromUser.id), name: fromUser.first_name || 'Player', username: fromUser.username };
      state.history.push({ player: playerTag, guess, feedback: '🎯 BULLSEYE! VAULT CRACKED!' });
      this.#recordBoardVictory(session.chatId, state.winner, 200);
    } else {
      if (guess < state.secret && guess >= state.minBound) {
        state.minBound = Math.min(state.secret - 1, guess + 1);
      } else if (guess > state.secret && guess <= state.maxBound) {
        state.maxBound = Math.max(state.secret + 1, guess - 1);
      }
      state.history.push({
        player: playerTag,
        guess,
        feedback: getHeatFeedback(guess, state.secret)
      });

      if (state.attempts >= state.maxAttempts) {
        state.history.push({
          player: '🔒 System',
          guess: state.secret,
          feedback: `Out of attempts! Code was ${state.secret}`
        });
        state.winner = { name: 'Vault Lockdown (Nobody)', isBot: true };
      }
    }

    this.#armBoardInactivityTimer(session);
    const rich = buildNumberVaultRich(state);
    if (fromChat || (session.chatMessagesSinceCard || 0) >= 2 || !session.cardMessageId) {
      const oldCardId = session.cardMessageId;
      const sent = typeof this.api.sendRichMessage === 'function'
        ? await this.api.sendRichMessage(session.chatId, rich).catch(() => null)
        : await this.api.sendMessage(session.chatId, 'Number Vault Update').catch(() => null);
      if (sent?.message_id) {
        session.cardMessageId = sent.message_id;
        session.chatMessagesSinceCard = 0;
        if (oldCardId && oldCardId !== sent.message_id) {
          this.api.deleteMessage?.(session.chatId, oldCardId)?.catch?.(() => {});
        }
      }
    } else {
      if (typeof this.api.editMessageRich === 'function') {
        await this.api.editMessageRich(session.chatId, session.cardMessageId, rich).catch(() => {});
      } else if (typeof this.api.editMessageText === 'function') {
        await this.api.editMessageText({
          chat_id: session.chatId,
          message_id: session.cardMessageId,
          text: 'Number Vault Update'
        }).catch(() => {});
      }
    }
  }

  async #handleHigherLowerCallback(session, query, data) {
    const state = session.boardState;
    if (!state || state.type !== 'highlow' || state.gameOver) return;
    const choice = data.split(':')[2]; // 'higher' | 'lower'
    const from = query.from;
    const playerTag = from.username ? `@${from.username}` : (from.first_name || 'Player');

    const valA = state.pair.itemA.value;
    const valB = state.pair.itemB.value;
    const isHigher = valB >= valA;
    const correct = (choice === 'higher' && isHigher) || (choice === 'lower' && !isHigher);

    if (correct) {
      state.streak += 1;
      const oldB = state.pair.itemB;
      state.lastOutcome = `✅ ${playerTag} nailed it! ${oldB.name} has ${oldB.formatted}! (+40 XP)`;
      if (this.db) {
        this.db.recordGameAnswer(session.chatId, from, 40, 2500);
      }
      const nextPair = await generateHigherLowerPair(session.usedIds);
      state.pair = {
        metric: nextPair.metric,
        unit: nextPair.unit,
        itemA: nextPair.itemA,
        itemB: nextPair.itemB
      };
      await this.api.answerCallbackQuery(query.id, { text: `🔥 Streak: ${state.streak}!` });
    } else {
      state.revealed = true;
      state.gameOver = true;
      state.lastOutcome = `💥 Streak Broken at ${state.streak}! ${state.pair.itemB.name} actually has ${state.pair.itemB.formatted}!`;
      await this.api.answerCallbackQuery(query.id, { text: '💥 Wrong call! Streak ended!' });
    }

    this.#armBoardInactivityTimer(session);
    await this.api.editMessageRich(session.chatId, session.cardMessageId, buildHigherLowerRich(state)).catch(() => {});
  }

  #recordBoardVictory(chatId, winner, xp = 180) {
    if (!winner || winner.isBot || !winner.id || !this.db) return;
    this.db.recordGameAnswer(chatId, { id: winner.id, first_name: winner.name, username: winner.username }, xp, 3000);
    this.db.recordGameWin(chatId, { id: winner.id, first_name: winner.name });
  }

  /**
   * ── LANCY WORD GRID (8x8 HIDDEN WORD SEARCH) ──
   * Uses delete-and-repost on word discoveries so the updated board + checklist
   * always stays right at the bottom of an active group chat without spamming!
   */
  async #startNextWordGridBoard(session) {
    if (!this.sessions.has(session.chatId) || session.isStopped) return;
    await this.#cleanupFinishedRound(session, { deleteCard: true });

    session.currentRound += 1;
    session.roundGuessMsgIds = [];
    session.chatMessagesSinceCard = 0;
    const wg = generateLiveWordGrid({ size: 8 });
    session.boardState = {
      type: 'wordgrid',
      grid: wg.grid,
      words: wg.words,
      foundWords: [],
      lastFinderText: null
    };

    const { payload, files } = await this.#buildWordGridRichMessage(session);
    const sent = typeof this.api.sendRichMessage === 'function'
      ? await this.api.sendRichMessage(session.chatId, payload, {}, files).catch((err) => {
          this.log.error?.({ err, chatId: session.chatId }, 'failed to send word grid rich message');
          return null;
        })
      : await this.api.sendMessage(session.chatId, 'Word Grid').catch(() => null);
    session.cardMessageId = sent?.message_id || null;
    session.chatMessagesSinceCard = 0;
    this.#armBoardInactivityTimer(session, 240_000);
  }

  /**
   * Deletes the previous Word Grid message (and any wrong guesses) and sends a fresh
   * updated Word Grid message at the bottom of the group chat so players never have to scroll up!
   */
  async #refreshWordGridCard(session) {
    if (!this.sessions.has(session.chatId) || session.isStopped) return;
    const oldCardId = session.cardMessageId;
    const { payload, files } = await this.#buildWordGridRichMessage(session);
    const sent = typeof this.api.sendRichMessage === 'function'
      ? await this.api.sendRichMessage(session.chatId, payload, {}, files).catch(async () => {
          // Fallback to in-place edit if send failed
          if (oldCardId && typeof this.api.editMessageRich === 'function') {
            await this.api.editMessageRich(session.chatId, oldCardId, payload, {}, files).catch(() => {});
            return { message_id: oldCardId };
          }
          return null;
        })
      : await this.api.sendMessage(session.chatId, 'Word Grid').catch(() => null);

    if (sent?.message_id) {
      session.cardMessageId = sent.message_id;
      session.chatMessagesSinceCard = 0;
      if (oldCardId && oldCardId !== sent.message_id) {
        this.api.deleteMessage?.(session.chatId, oldCardId)?.catch?.(() => {});
      }
    }
  }

  async #buildWordGridRichMessage(session) {
    const st = session.boardState;
    const b = new RichMessageBuilder();
    const files = {};

    const imgBuf = await renderWordGrid({
      grid: st.grid,
      foundWords: st.foundWords
    });
    if (imgBuf) {
      files.media = {
        buffer: imgBuf,
        filename: 'word_grid.jpg',
        contentType: 'image/jpeg'
      };
      b.photo('attach://media');
    }

    b.heading('🔠 WORD GRID – FIND THE HIDDEN WORDS!', 1);

    const checklistLines = st.words.map((entry) => formatWordGridEntry(entry)).join('\n');
    b.paragraph(rt.bold(checklistLines));

    const remainingCount = st.words.filter((w) => !w.foundBy).length;
    if (remainingCount > 0) {
      b.heading(`★ ${remainingCount} ${remainingCount === 1 ? 'Word Is' : 'Words Are'} Left`, 2);
    } else {
      b.heading('🎉 All 10 Words Found! Next Word Grid dropping in 3s...', 2);
    }

    if (st.lastFinderText) {
      b.paragraph(rt.bold(st.lastFinderText));
    }

    if (remainingCount > 0) {
      b.buttons([
        richButton.callback('💡 Reveal Letter', 'game_wg:hint', { style: 'primary' }),
        richButton.callback('📌 Drop Here', 'game_wg:repost', { style: 'primary' }),
        richButton.callback('🔄 New Grid', 'game_wg:next', { style: 'success' })
      ]);
      b.buttons([
        richButton.callback('🛑 End & Podium', 'game_ctrl:stop', { style: 'danger' })
      ]);
    }

    b.validate();
    return { payload: b.toJSON(), files };
  }

  async #processWordGridHit(session, fromUser, matchedEntry) {
    const st = session.boardState;
    if (!st || matchedEntry.foundBy) return;

    const uid = Number(fromUser.id);
    const winnerTag = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || 'Player');
    matchedEntry.foundBy = winnerTag;

    st.foundWords.push({
      r0: matchedEntry.r0,
      c0: matchedEntry.c0,
      r1: matchedEntry.r1,
      c1: matchedEntry.c1
    });

    const pointsAwarded = matchedEntry.word.length * 15;
    const existing = session.scores.get(uid) || {
      id: uid,
      name: fromUser.first_name || 'Player',
      username: fromUser.username || null,
      score: 0,
      streak: 0,
      correctCount: 0,
      fastestMs: 3000
    };
    existing.score += pointsAwarded;
    existing.correctCount += 1;
    session.scores.set(uid, existing);

    if (this.db) {
      this.db.recordGameAnswer(session.chatId, fromUser, pointsAwarded, 3000);
    }

    const remaining = st.words.filter((w) => !w.foundBy).length;
    st.lastFinderText = `🎯 ${winnerTag} found "${matchedEntry.word}" (+${pointsAwarded} XP)! • ★ ${remaining} left`;
    this.#armBoardInactivityTimer(session, 240_000);

    // Delete the old Word Grid message and post the newly updated Word Grid at the bottom of the chat!
    await this.#refreshWordGridCard(session);

    if (remaining === 0) {
      await sleep(3000);
      if (!this.sessions.has(session.chatId) || session.isStopped) return;
      if (session.totalRounds > 0 && session.currentRound >= session.totalRounds) {
        await this.#finishGame(session);
      } else {
        await this.#startNextWordGridBoard(session);
      }
    }
  }

  async #handleWordGridCallback(session, query, data) {
    const st = session.boardState;
    if (!st || st.type !== 'wordgrid') return;
    const action = data.split(':')[1];

    const clickerTag = query.from?.username ? `@${query.from.username}` : (query.from?.first_name || 'Player');

    if (action === 'hint') {
      const unfound = st.words.filter((w) => !w.foundBy && (w.revealedChars || 1) < w.word.length - 1);
      if (!unfound.length) {
        await this.api.answerCallbackQuery(query.id, { text: 'Maximum letter hints already revealed!' });
        return;
      }
      // Reveal 1 extra letter on up to 3 unfound words
      unfound.sort((a, b) => b.word.length - a.word.length);
      for (const entry of unfound.slice(0, 3)) {
        entry.revealedChars = (entry.revealedChars || 1) + 1;
      }
      st.lastFinderText = `💡 Extra letter clues unlocked by ${clickerTag}!`;
      await this.api.answerCallbackQuery(query.id, { text: `Letter clues unlocked by ${query.from?.first_name || 'Player'}! 💡` });
      if ((session.chatMessagesSinceCard || 0) >= 2) {
        await this.#refreshWordGridCard(session);
      } else if (session.cardMessageId) {
        const { payload, files } = await this.#buildWordGridRichMessage(session);
        await this.api.editMessageRich(session.chatId, session.cardMessageId, payload, {}, files).catch(() => {});
      }
      return;
    }

    if (action === 'repost') {
      st.lastFinderText = `📌 Word Grid moved here by ${clickerTag}!`;
      await this.api.answerCallbackQuery(query.id, { text: `Word Grid moved by ${query.from?.first_name || 'Player'}! 📌` });
      await this.#refreshWordGridCard(session);
      return;
    }

    if (action === 'next') {
      st.lastFinderText = `🔄 New Word Grid launched by ${clickerTag}!`;
      await this.api.answerCallbackQuery(query.id, { text: `New Word Grid launched by ${query.from?.first_name || 'Player'}! 🔄` });
      await this.#startNextWordGridBoard(session);
    }
  }

  /**
   * ── POKÉMON 1V1 STADIUM DUEL HANDLER ──
   */
  async #handlePokemonDuelCallback(session, query, data) {
    const st = session.boardState;
    if (!st || st.type !== 'pokebattle') return;
    const parts = data.split(':');
    const action = parts[1];
    const arg = parts[2];
    const from = query.from;
    const uid = Number(from.id);

    if (action === 'join' && st.phase === 'lobby') {
      if (arg === 'ai') {
        st.p2 = buildFighterPokemon(
          { id: -1, first_name: 'Champion Cynthia (AI)' },
          { pokemon_id: 445, pokemon_name: 'Garchomp', types: 'Dragon / Ground', best_cp: 1950, is_shiny: 1 }
        );
        st.p2.isBot = true;
        st.phase = 'battle';
        st.lastLog = `🤖 Champion Cynthia sent out ${st.p2.name}! ${st.p1.trainerName}, make your first move!`;
        await this.api.answerCallbackQuery(query.id, { text: 'Champion Cynthia accepted the challenge! ⚡' });
      } else {
        if (uid === st.p1.userId) {
          await this.api.answerCallbackQuery(query.id, {
            text: 'Tap "🤖 Battle Champion Lancy AI" to play solo, or let another trainer tap Accept Challenge!',
            show_alert: true
          });
          return;
        }
        const topRow = this.db?.getUserPokedex ? this.db.getUserPokedex(uid, 1)?.[0] : null;
        st.p2 = buildFighterPokemon(from, topRow);
        st.phase = 'battle';
        st.lastLog = `🔥 ${st.p2.trainerName} sent out ${st.p2.name} (${st.p2.cp} CP)! ${st.p1.trainerName} attacks first!`;
        await this.api.answerCallbackQuery(query.id, { text: `You sent out ${st.p2.name}!` });
      }
      this.#armBoardInactivityTimer(session);
      await this.api.editMessageRich(session.chatId, session.cardMessageId, renderPokemonDuelRich(session)).catch(() => {});
      return;
    }

    if (action === 'move' && st.phase === 'battle' && !st.winner) {
      const attacker = st.turn === 1 ? st.p1 : st.p2;
      const defender = st.turn === 1 ? st.p2 : st.p1;
      if (uid !== attacker.userId) {
        await this.api.answerCallbackQuery(query.id, { text: `Wait for ${attacker.trainerName} to pick a move!` });
        return;
      }

      const moveIdx = Number(arg) || 0;
      const logLine = this.#applyPokemonMove(attacker, defender, moveIdx);
      st.lastLog = logLine;

      if (defender.hp <= 0) {
        defender.hp = 0;
        st.winner = attacker;
        st.lastLog = `${logLine}\n🏆 ${defender.name} fainted! ${attacker.trainerName} wins the Stadium Duel (+200 XP)!`;
        this.#recordBoardVictory(session.chatId, { id: attacker.userId, name: attacker.trainerName }, 200);
      } else {
        st.turn = st.turn === 1 ? 2 : 1;
        // If playing vs AI and it's AI's turn, execute AI counter-attack immediately!
        if (st.turn === 2 && st.p2?.isBot) {
          const aiMoveIdx = st.p2.hp < st.p2.maxHp * 0.35 && st.p2.healsLeft > 0
            ? 3
            : Math.floor(Math.random() * 3);
          const aiLog = this.#applyPokemonMove(st.p2, st.p1, aiMoveIdx);
          st.lastLog = `${logLine}\n${aiLog}`;
          if (st.p1.hp <= 0) {
            st.p1.hp = 0;
            st.winner = st.p2;
            st.lastLog += `\n💥 ${st.p1.name} fainted! Champion Cynthia wins!`;
          } else {
            st.turn = 1;
          }
        }
      }

      await this.api.answerCallbackQuery(query.id);
      this.#armBoardInactivityTimer(session);
      await this.api.editMessageRich(session.chatId, session.cardMessageId, renderPokemonDuelRich(session)).catch(() => {});
    }
  }

  #applyPokemonMove(attacker, defender, moveIdx) {
    const move = attacker.moves[moveIdx] || attacker.moves[0];
    if (move.healRatio) {
      if (attacker.healsLeft <= 0) {
        return `⚠️ ${attacker.name} reached for a Sitrus Berry, but the pouch is empty!`;
      }
      attacker.healsLeft -= 1;
      const healAmt = Math.round(attacker.maxHp * move.healRatio);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
      return `🍒 ${attacker.name} ate a Sitrus Berry and restored +${healAmt} HP!`;
    }

    if (Math.random() > (move.accuracy ?? 1.0)) {
      return `💨 ${attacker.name} used ${move.label}, but ${defender.name} dodged the attack!`;
    }

    const typeMult = move.type && move.type !== 'Normal'
      ? getTypeMultiplier(move.type, defender.primaryType)
      : 1.0;
    const isCrit = Math.random() < (0.12 + (move.critBonus || 0));
    const critMult = isCrit ? 1.45 : 1.0;
    const variance = 0.9 + Math.random() * 0.2;
    const dmg = Math.max(8, Math.round(move.power * typeMult * critMult * variance));
    defender.hp = Math.max(0, defender.hp - dmg);

    const effTag = typeMult > 1.2
      ? ' • 💥 SUPER EFFECTIVE!'
      : typeMult < 0.9
        ? ' • 🛡️ Not very effective...'
        : '';
    const critTag = isCrit ? ' • 🎯 CRITICAL HIT!' : '';
    return `${attacker.name} used ${move.label} → -${dmg} HP!${effTag}${critTag}`;
  }

  /**
   * ── ROUND-BASED LIVE GAME RUNNER (100% Bot API 10.3 Rich Message) ──
   */
  async #runNextRound(session) {
    if (!this.sessions.has(session.chatId) || session.isStopped) return;
    this.#clearSessionTimers(session);

    // If a fixed round count was chosen (> 0), finish once we've completed all rounds.
    // When totalRounds === 0 (default), the game runs UNLIMITED rounds until maxUnanswered (default 5) are missed!
    if (session.totalRounds > 0 && session.currentRound >= session.totalRounds) {
      return this.#finishGame(session);
    }

    session.currentRound += 1;
    session.wrongUsersThisRound.clear();
    session.roundGuessMsgIds = [];
    session.chatMessagesSinceCard = 0;
    session.state = 'in_round';

    // Determine effective mode for this round (supports 'mixed' and 'daily' 3-stage gauntlet!)
    let roundMode = session.mode;
    if (session.mode === 'mixed') {
      const mixModes = ['pokemon', 'anime', 'flags', 'song', 'cars', 'logos', 'icons', 'grid', 'picture', 'emoji', 'scramble', 'riddles', 'trivia', 'lyrics'];
      roundMode = mixModes[(session.currentRound - 1 + Math.floor(Math.random() * mixModes.length)) % mixModes.length];
    } else if (session.mode === 'daily') {
      const dailyStages = ['pokemon', 'song', 'trivia'];
      roundMode = dailyStages[(session.currentRound - 1) % dailyStages.length];
    }

    // Fetch live question from provider with error-handling fallback
    let question;
    try {
      question = await this.#fetchQuestionForMode(session, roundMode);
    } catch (err) {
      this.log.error?.({ err: err?.message, roundMode }, 'fetchQuestionForMode failed, falling back to trivia');
      question = await getLiveTriviaQuestion({ seenIds: session.usedIds });
      roundMode = 'trivia';
    }
    if (!question) {
      question = await getLiveTriviaQuestion({ seenIds: session.usedIds });
      roundMode = 'trivia';
    }
    question.roundMode = roundMode;
    question.currentStage = 0;
    this.#ensureQuestionOptions(question, roundMode);

    if (question.id) {
      session.usedIds.add(question.id);
      session.matchSeenIds?.add?.(question.id);
      if (this.db?.markGameItemSeen) {
        this.db.markGameItemSeen(session.chatId, session.mode, question.id);
      }
    }

    // Pre-fetch image buffer once if this round has an imageUrl so progressive hints/unblur are instant!
    if (question.imageUrl) {
      question.rawImageBuffer = await fetchImageBuffer(question.imageUrl);
      if (!question.rawImageBuffer) {
        const fallbackUrl = question.imageUrl.replace(/\/[a-f0-9]{6}(\?|$)/i, '/ffffff$1');
        question.rawImageBuffer = await fetchImageBuffer(fallbackUrl);
      }
    }
    if (roundMode === 'grid') {
      question.revealedTiles = [4, Math.floor(Math.random() * 4) * 2];
    }

    if (session.isStopped || this.sessions.get(session.chatId) !== session) return;

    session.currentQuestion = question;
    session.roundStartTime = Date.now();

    const { payload, files } = await this.#buildRoundRichMessage(session, {
      stage: 0,
      bannerStatus: '⏱️ 30s Smart Timer • Type your answer in chat or use the buttons below! ♡'
    });

    if (session.isStopped || this.sessions.get(session.chatId) !== session) return;

    let sent = null;
    if (typeof this.api.sendRichMessage === 'function') {
      sent = await this.api.sendRichMessage(session.chatId, payload, {}, files).catch((err) => {
        this.log.error?.({ err, chatId: session.chatId, roundMode }, 'failed to send round rich message');
        return null;
      });
    } else if (files?.media?.buffer && typeof this.api.sendPhoto === 'function') {
      sent = await this.api.sendPhoto(session.chatId, files.media.buffer, {
        caption: payload?.text || 'Round Start'
      }).catch(() => null);
    } else if (typeof this.api.sendMessage === 'function') {
      sent = await this.api.sendMessage(session.chatId, payload?.text || 'Round Start').catch(() => null);
    }
    if (session.isStopped || this.sessions.get(session.chatId) !== session) {
      if (sent?.message_id) {
        this.api.deleteMessage?.(session.chatId, sent.message_id)?.catch?.(() => {});
      }
      return;
    }
    session.cardMessageId = sent?.message_id || null;

    // Smart Hint 1 at 10s elapsed (20s remaining)
    session.hint1Timeout = setTimeout(async () => {
      if (session.state !== 'in_round' || !session.cardMessageId) return;
      question.currentStage = Math.max(question.currentStage, 1);
      if (roundMode === 'grid') this.#revealNextGridTiles(question, 2);

      await this.#updateRoundCard(session, {
        stage: question.currentStage,
        bannerStatus: '⏱️ 20s remaining • 💡 Hint 1 Unlocked!'
      });
    }, 10_000);
    session.hint1Timeout?.unref?.();

    // Smart Hint 2 at 20s elapsed (10s remaining)
    session.hint2Timeout = setTimeout(async () => {
      if (session.state !== 'in_round' || !session.cardMessageId) return;
      question.currentStage = Math.max(question.currentStage, 2);
      if (roundMode === 'grid') this.#revealNextGridTiles(question, 2);

      await this.#updateRoundCard(session, {
        stage: question.currentStage,
        bannerStatus: '⏱️ 10s remaining! • 🔥 Final Hint Unlocked!'
      });
    }, 20_000);
    session.hint2Timeout?.unref?.();

    // Round Timeout at 30s
    session.timerHandle = setTimeout(async () => {
      if (session.state !== 'in_round') return;
      session.state = 'round_ended';
      session.unansweredCount = (session.unansweredCount || 0) + 1;
      session.lastWinner = null;
      session.lastActionNotice = '⌛ Round timed out (unanswered)';
      const ans = question.displayName || question.name;
      const hasAutoStop = session.maxUnanswered > 0;
      const missInfo = hasAutoStop
        ? `${session.unansweredCount}/${session.maxUnanswered} missed`
        : '♾️ Unlimited Mode';

      await this.#updateRoundCard(session, {
        stage: 3, // Reveal full HD media & answer briefly before auto-deleting
        bannerStatus: `⌛ TIME'S UP! Nobody sniped it (${missInfo}).\n✅ Answer: ${ans}`,
        showControls: false
      });

      await sleep(3000);
      if (!this.sessions.has(session.chatId) || session.isStopped) return;

      // Auto-delete timed-out round card & wrong guess spam!
      await this.#cleanupFinishedRound(session, { deleteCard: true });

      // Check if we hit the unanswered limit (if a '🛑 X Missed' mode was chosen, or 20 idle rounds in pure unlimited)
      const effectiveStopLimit = hasAutoStop ? session.maxUnanswered : 20;
      if (session.unansweredCount >= effectiveStopLimit) {
        return this.#finishGame(session, {
          reason: `Auto-stopped after ${effectiveStopLimit} unanswered rounds 💤`
        });
      }

      void this.#runNextRound(session);
    }, 30_000);
    session.timerHandle?.unref?.();
  }

  #ensureQuestionOptions(q, roundMode) {
    if (!q) return;
    const cleanTarget = String(q.name || q.displayName || '').trim();
    if (!cleanTarget) return;

    if (!Array.isArray(q.options) || q.options.length < 2) {
      const distractors = [
        'Lancy Challenger',
        'Mystery Champion',
        'Apex Contender',
        'Phantom Choice'
      ].filter((d) => d.toLowerCase() !== cleanTarget.toLowerCase());
      const all = [cleanTarget, ...distractors.slice(0, 3)].sort(() => Math.random() - 0.5);
      q.options = all;
      q.correctIndex = all.indexOf(cleanTarget);
    } else {
      if (q.correctIndex === undefined || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
        let idx = q.options.findIndex((opt) => String(opt).trim().toLowerCase() === cleanTarget.toLowerCase());
        if (idx === -1) {
          q.options[0] = cleanTarget;
          idx = 0;
        }
        q.correctIndex = idx;
      }
    }

    if (!Array.isArray(q.aliases)) q.aliases = [];
    const letter = String.fromCharCode(65 + q.correctIndex).toLowerCase();
    q.aliases.push(
      cleanTarget.toLowerCase(),
      letter,
      `option ${letter}`,
      `${letter})`,
      `[${letter}]`
    );
  }

  #revealNextGridTiles(question, count = 2) {
    if (!question.revealedTiles) question.revealedTiles = [4];
    const hidden = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !question.revealedTiles.includes(i));
    if (!hidden.length) return false;
    hidden.sort(() => Math.random() - 0.5);
    for (const idx of hidden.slice(0, count)) {
      question.revealedTiles.push(idx);
    }
    return true;
  }

  async #fetchQuestionForMode(session, roundMode) {
    if (!session.matchSeenIds) session.matchSeenIds = new Set();
    const opts = {
      seenIds: session.usedIds,
      matchSeenIds: session.matchSeenIds,
      difficulty: session.difficulty,
      mode: roundMode,
      musicCategory: session.musicCategory || this.getPreferredMusicCategory(session.chatId)
    };
    switch (roundMode) {
      case 'pokemon':
      case 'whosthatpokemon':
        return await getLivePokemonQuestion(opts);
      case 'anime':
      case 'silhouette':
        return await getLiveAnimeCharacter(opts);
      case 'song':
        return await getLiveSongChallenge(opts);
      case 'lyrics':
        return await getLiveLyricChallenge(opts);
      case 'grid':
      case 'picture':
        return await getLiveVisualMystery(opts);
      case 'flags':
        return await getLiveFlagQuestion(opts);
      case 'cars':
        return await getLiveCarLogoQuestion(opts);
      case 'logos':
        return await getLiveBrandLogoQuestion(opts);
      case 'icons':
        return await getLiveAppIconQuestion(opts);
      case 'logomix':
        return await getLiveLogoQuestion(opts);
      case 'emoji':
        return await getLiveEmojiQuiz(opts);
      case 'scramble':
        return await getLiveWordScramble(opts);
      case 'riddles':
        return await getLiveRiddle(opts);
      case 'trivia':
      default:
        return await getLiveTriviaQuestion(opts);
    }
  }

  /**
   * Builds the Bot API 10.3 Rich Message + multipart files for any active round state.
   * Uses high-visibility Level-1/Level-2 Headings and Bold Paragraphs so questions and answers stand out clearly!
   */
  async #buildRoundRichMessage(session, { stage = 0, bannerStatus = '', showControls = true } = {}) {
    const q = session.currentQuestion;
    const roundMode = q.roundMode || session.mode;
    const meta = GAME_MODE_META[roundMode] || GAME_MODE_META.flags;

    const b = new RichMessageBuilder();
    const files = {};

    // 1. Top Media Block (Photo or Audio)
    if (roundMode === 'song' && q.audioBuffer) {
      files.track = {
        buffer: q.audioBuffer,
        filename: q.audioFilename || 'mystery_beat.mp3',
        contentType: q.audioContentType || 'audio/mpeg'
      };
      b.audio({
        media: 'attach://track',
        title: stage >= 3 ? q.name : `🎵 Mystery Track #${session.currentRound}`,
        performer: stage >= 3 ? q.artist : (q.genreLabel || 'Lancy Beat Drop ♡')
      });
    } else if (q.rawImageBuffer) {
      let processedImg = null;
      if (roundMode === 'pokemon' || roundMode === 'whosthatpokemon') {
        processedImg = await renderPokemonArenaCard(q.rawImageBuffer, {
          isSilhouette: roundMode === 'whosthatpokemon' && stage < 3,
          isShiny: Boolean(q.isShiny),
          primaryType: q.primaryType || 'Electric'
        });
      } else if (roundMode === 'grid') {
        const tiles = stage >= 3 ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : (q.revealedTiles || [4]);
        processedImg = await renderGridMask(q.rawImageBuffer, tiles);
      } else if (roundMode === 'picture') {
        processedImg = await renderMysteryBlur(q.rawImageBuffer, stage);
      } else if (roundMode === 'silhouette') {
        processedImg = await renderFramedMedia(q.rawImageBuffer, {
          isSilhouette: stage < 3,
          accent: stage >= 3 ? 'gold' : 'pink'
        });
      } else {
        processedImg = await renderFramedMedia(q.rawImageBuffer, {
          accent: stage >= 3 ? 'gold' : 'pink'
        });
      }

      if (processedImg) {
        files.media = {
          buffer: processedImg,
          filename: 'arena_visual.jpg',
          contentType: 'image/jpeg'
        };
        b.photo('attach://media');
      }
    }

    // 2. Native 10.3 Heading & Mode Title
    const headerPrefix = session.mode === 'daily' ? `🔥 DAILY STAGE ${session.currentRound}/3 • ` : '';
    b.heading(`${WINGS} ${headerPrefix}${meta.icon} ${meta.title} ${WINGS}`, 2);

    // 3. HIGH-VISIBILITY QUESTION OR REVEALED ANSWER DISPLAY!
    if (stage >= 3) {
      // Round Revealed (Winner Sniped, Skipped, or Time's Up) -> Huge Bold Answer Banner!
      const finalAns = (q.displayName || q.name || '').toUpperCase();
      b.heading(`✅ ANSWER: ${finalAns}`, 1);
      b.paragraph(rt.bold(bannerStatus));
      b.divider();
    } else {
      // Active Question -> Large Heading 1 + Bold Options so everyone can read it effortlessly!
      if (roundMode === 'pokemon' || roundMode === 'whosthatpokemon') {
        if (q.isShiny) {
          b.heading('✨ WILD SHINY ENCOUNTER! (3× XP + SHINY DEX)', 1);
        }
        b.heading(`📖 "${q.clueText}"`, 1);
        b.paragraph(rt.bold('⚡ Tap a button or type the Pokémon\'s name!'));
        if (Array.isArray(q.options) && q.options.length === 4) {
          const optLines = q.options.map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)}) ${opt}`).join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      } else if (roundMode === 'emoji') {
        b.heading(`🎯 ${q.emojis}`, 1);
        b.paragraph(rt.bold(`📂 Category: ${q.category || 'Vibe'} — Tap a button or type in chat!`));
        if (Array.isArray(q.options) && q.options.length === 4) {
          const optLines = q.options.map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)}) ${opt}`).join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      } else if (roundMode === 'scramble') {
        b.heading(`🔤 ${q.scrambledTiles}`, 1);
        b.paragraph(rt.bold(`📂 Category: ${q.category || 'Word'} (${(q.name || '').length} Letters) — Tap or type in chat!`));
        if (Array.isArray(q.options) && q.options.length === 4) {
          const optLines = q.options.map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)}) ${opt}`).join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      } else if (roundMode === 'riddles') {
        b.heading(`🕵️ "${q.riddleText}"`, 1);
        b.paragraph(rt.bold('💡 Tap a button or type your answer in chat!'));
        if (Array.isArray(q.options) && q.options.length === 4) {
          const optLines = q.options.map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)}) ${opt}`).join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      } else if (roundMode === 'trivia') {
        b.heading(`❓ ${q.questionText}`, 1);
        const optLines = (q.options || [])
          .map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)})  ${opt}`)
          .join('\n\n');
        b.paragraph(rt.bold(optLines));
      } else if (roundMode === 'lyrics') {
        b.heading(`${q.context}`, 2);
        b.heading(`🎤 "${q.quote}"`, 1);
        if (Array.isArray(q.options) && q.options.length > 0) {
          const optLine = q.options
            .map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)}) ${opt.toUpperCase()}`)
            .join('   •   ');
          b.paragraph(rt.bold(optLine));
        }
      } else if (roundMode === 'song') {
        b.heading(`🎧 LISTEN & GUESS THE HIT! (${q.genreLabel || 'Afrobeats & Hits'})`, 1);
        if (q.promptOverride) {
          b.heading(q.promptOverride, 2);
        }
        if (Array.isArray(q.options) && q.options.length > 0) {
          const optLines = q.options
            .map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)})  ${opt}`)
            .join('\n');
          b.paragraph(rt.bold(optLines));
        }
      } else if (q.promptOverride) {
        b.heading(`❓ ${q.promptOverride}`, 1);
        if (Array.isArray(q.options) && q.options.length >= 2) {
          const optLines = q.options
            .map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)})  ${opt}`)
            .join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      } else {
        const defaultPrompt = roundMode === 'cars'
          ? '🏎️ WHICH CAR BRAND EMBLEM IS THIS? TAP OR TYPE!'
          : roundMode === 'logos'
            ? '🏢 WHICH GLOBAL BRAND IS THIS? TAP OR TYPE!'
            : roundMode === 'icons'
              ? '📱 WHICH APP / TECH ICON IS THIS? TAP OR TYPE!'
              : roundMode === 'anime'
                ? '👀 WHO IS THIS ANIME CHARACTER? TAP OR TYPE!'
                : roundMode === 'flags'
                  ? '🌍 WHICH COUNTRY\'S FLAG IS THIS? TAP OR TYPE!'
                  : roundMode === 'grid' || roundMode === 'picture'
                    ? '🖼️ WHAT IS THIS PICTURE? TAP OR TYPE!'
                    : '❓ TAP A BUTTON OR TYPE IN CHAT!';
        b.heading(defaultPrompt, 1);
        if (Array.isArray(q.options) && q.options.length >= 2) {
          const optLines = q.options
            .map((opt, idx) => `🔹 ${String.fromCharCode(65 + idx)})  ${opt}`)
            .join('   •   ');
          b.paragraph(rt.bold(optLines));
        }
      }

      // Highlight unlocked hints prominently in bold text above the table!
      if (stage >= 1 && q.hint1) {
        b.paragraph(rt.bold(`💡 HINT 1: ${q.hint1}`));
      }
      if (stage >= 2 && q.hint2) {
        b.paragraph(rt.bold(`🔥 HINT 2: ${q.hint2}`));
      }
    }

    // 4. Live Status & Hints KV Table
    const roundDisplay = session.totalRounds > 0
      ? `${session.currentRound} / ${session.totalRounds} (${q.difficulty || 'LIVE'})`
      : `Round #${session.currentRound} • ♾️ Unlimited`;

    const statusText = session.lastWinner
      ? `👑 ${session.lastWinner.name} (+${session.lastWinner.points} XP in ${session.lastWinner.reactionSec}s)`
      : 'Open Bounty (+100–225 XP) • Waiting for first snipe!';

    const tableRows = [
      ['🎮 Round', roundDisplay],
      ['🎯 Last Round Winner', statusText]
    ];
    if (session.maxUnanswered > 0) {
      tableRows.push(['🛑 Auto-Stop', `${session.unansweredCount || 0} / ${session.maxUnanswered} Missed`]);
    }

    if (roundMode === 'pokemon' || roundMode === 'whosthatpokemon') {
      tableRows.push(['🧬 Elemental Type', q.typeBadges || '⚡ Mystery']);
      tableRows.push(['🗺️ Region & CP', `${q.region} • ${q.rolledCp} CP ${q.isShiny ? '(✨ SHINY)' : ''}`]);
    } else if (roundMode === 'anime' && q.universe) {
      tableRows.push(['📺 Anime Series', q.universe]);
    } else if (roundMode === 'grid' && stage < 3) {
      tableRows.push(['🧩 Revealed Tiles', `${(q.revealedTiles || []).length} / 9 tiles uncovered`]);
    }

    b.table(kvTable(tableRows), { compact: true });
    if (stage < 3) {
      b.blockquote(bannerStatus);
    }

    // 5. Interactive Action Buttons
    if (showControls && session.state === 'in_round') {
      if (Array.isArray(q.options) && q.options.length >= 2) {
        for (let i = 0; i < q.options.length; i += 2) {
          const row = [];
          const l1 = String.fromCharCode(65 + i);
          row.push(richButton.callback(`${l1}) ${String(q.options[i]).slice(0, 22)}`, `game_ans:${i}`, { style: 'primary' }));
          if (i + 1 < q.options.length) {
            const l2 = String.fromCharCode(65 + i + 1);
            row.push(richButton.callback(`${l2}) ${String(q.options[i + 1]).slice(0, 22)}`, `game_ans:${i + 1}`, { style: 'primary' }));
          }
          b.buttons(row);
        }
      }

      if (roundMode === 'grid') {
        b.buttons([
          richButton.callback('🔓 Uncover 2 Tiles', 'game_ctrl:gridtile', { style: 'success' }),
          richButton.callback('💡 Drop Hint', 'game_ctrl:hint', { style: 'primary' })
        ]);
      } else if (roundMode === 'scramble') {
        b.buttons([
          richButton.callback('🔀 Reshuffle Tiles', 'game_ctrl:shuffle', { style: 'success' }),
          richButton.callback('💡 Drop Hint', 'game_ctrl:hint', { style: 'primary' })
        ]);
      } else {
        b.buttons([
          richButton.callback('💡 Hint', 'game_ctrl:hint', { style: 'primary' }),
          richButton.callback('⏭️ Skip', 'game_ctrl:skip', { style: 'primary' }),
          richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
        ]);
      }

      if (roundMode === 'pokemon' || roundMode === 'whosthatpokemon') {
        b.buttons([
          richButton.callback('📖 My Pokédex', 'game_pokedex:me', { style: 'primary' }),
          richButton.callback('⚔️ 1v1 Stadium', 'game_start:pokebattle', { style: 'success' })
        ]);
      }

      if (roundMode === 'grid' || roundMode === 'scramble') {
        b.buttons([
          richButton.callback('⏭️ Skip Round', 'game_ctrl:skip', { style: 'primary' }),
          richButton.callback('🛑 End Match', 'game_ctrl:stop', { style: 'danger' })
        ]);
      }
    }

    b.validate();
    return {
      payload: b.toJSON(),
      files: Object.keys(files).length > 0 ? files : null
    };
  }

  async #updateRoundCard(session, opts) {
    if (!session.cardMessageId) return;
    try {
      const { payload, files } = await this.#buildRoundRichMessage(session, opts);
      if (typeof this.api.sendRichMessage === 'function') {
        const isActiveRound = (opts?.stage ?? 0) < 3 && session.state === 'in_round';
        if (isActiveRound && (session.chatMessagesSinceCard || 0) >= 4) {
          const oldCardId = session.cardMessageId;
          const sent = await this.api.sendRichMessage(session.chatId, payload, {}, files).catch(() => null);
          if (sent?.message_id) {
            session.cardMessageId = sent.message_id;
            session.chatMessagesSinceCard = 0;
            if (oldCardId && oldCardId !== sent.message_id) {
              this.api.deleteMessage?.(session.chatId, oldCardId)?.catch?.(() => {});
            }
            return;
          }
        }
        const editRes = await this.api.editMessageRich(session.chatId, session.cardMessageId, payload, {}, files).catch(() => null);
        if (!editRes && session.cardMessageId) {
          const oldCardId = session.cardMessageId;
          const sent = await this.api.sendRichMessage(session.chatId, payload, {}, files).catch(() => null);
          if (sent?.message_id) {
            session.cardMessageId = sent.message_id;
            session.chatMessagesSinceCard = 0;
            if (oldCardId && oldCardId !== sent.message_id) {
              this.api.deleteMessage?.(session.chatId, oldCardId)?.catch?.(() => {});
            }
          }
        }
      } else if (typeof this.api.editMessageCaption === 'function') {
        await this.api.editMessageCaption({
          chat_id: session.chatId,
          message_id: session.cardMessageId,
          caption: opts?.bannerStatus || 'Round Update'
        }).catch(() => {});
      } else if (typeof this.api.editMessageText === 'function') {
        await this.api.editMessageText({
          chat_id: session.chatId,
          message_id: session.cardMessageId,
          text: opts?.bannerStatus || 'Round Update'
        }).catch(() => {});
      }
    } catch (err) {
      this.log.debug?.({ err: err?.message, chatId: session.chatId }, 'round card edit skipped');
    }
  }

  /**
   * Finalizes the match and sends a 100% Bot API 10.3 Rich Message Victory Podium
   * (the Podium stays permanently in chat as the important match record!).
   */
  async #finishGame(session, { reason = null } = {}) {
    session.state = 'ended';
    this.#clearSessionTimers(session);
    await this.#cleanupFinishedRound(session, { deleteCard: true });
    this.sessions.delete(session.chatId);

    const players = Array.from(session.scores.values()).sort((a, b) => b.score - a.score);
    const fastest = players.filter((p) => p.fastestMs).sort((a, b) => a.fastestMs - b.fastestMs)[0] || null;

    let dailyStreakNotice = null;
    if (players.length > 0 && this.db) {
      const champ = players[0];
      this.db.recordGameWin(session.chatId, { id: champ.id, first_name: champ.name });

      if (session.mode === 'daily') {
        const today = new Date().toISOString().slice(0, 10);
        for (const p of players) {
          const streakRes = this.db.recordDailyCompletion({ id: p.id, first_name: p.name, username: p.username }, today);
          if (p.id === champ.id) {
            dailyStreakNotice = `🔥 Daily Gauntlet Cleared! ${champ.name}'s Daily Streak: ${streakRes.streak} Day(s) (Best: ${streakRes.bestStreak}d)!`;
          }
        }
      }
    }

    const meta = GAME_MODE_META[session.mode] || GAME_MODE_META.flags;
    const b = new RichMessageBuilder();
    b.heading(`${WINGS} 🏆 VICTORY PODIUM • ${meta.title} ${WINGS}`, 1);
    const subReason = reason ? `${reason} • ` : '';
    b.paragraph(rt.italic(`₊˚⊹♡  ${subReason}${session.currentRound} rounds played • saved to hall of fame  ˙ᵕ˙`));
    b.divider();

    if (players.length === 0) {
      b.blockquote(
        reason
          ? `${reason}\nNo points were scored this match! Tap Rematch below to run it back ♡`
          : 'No points were scored this match! Tap Rematch below to run it back ♡'
      );
    } else {
      const medals = ['🥇 1ST', '🥈 2ND', '🥉 3RD', '4️⃣ 4TH', '5️⃣ 5TH'];
      const podiumRows = [
        [
          { text: rt.bold('Place'), is_header: true },
          { text: rt.bold('Player'), is_header: true },
          { text: rt.bold('Match XP'), is_header: true },
          { text: rt.bold('Snipes'), is_header: true },
          { text: rt.bold('Fastest ⚡'), is_header: true }
        ],
        ...players.slice(0, 6).map((p, idx) => [
          { text: rt.bold(medals[idx] || `#${idx + 1}`) },
          { text: rt.bold(p.username ? `@${p.username}` : p.name) },
          { text: rt.bold(`${p.score} XP`) },
          { text: `${p.correctCount} ✓` },
          { text: p.fastestMs ? `${(p.fastestMs / 1000).toFixed(1)}s` : '—' }
        ])
      ];
      b.table(podiumRows, { compact: true, bordered: true });

      const champ = players[0];
      const champTag = champ.username ? `@${champ.username}` : champ.name;
      b.heading(`👑 MATCH GAME LEADER: ${champTag} (${champ.score} XP)`, 2);

      const highlights = [`👑 Match Game Leader: ${champTag} (+${champ.score} XP • ${champ.correctCount} snipes)`];
      if (fastest) {
        const fastestTag = fastest.username ? `@${fastest.username}` : fastest.name;
        highlights.push(`⚡ Fastest Trigger: ${fastestTag} in ${(fastest.fastestMs / 1000).toFixed(1)}s`);
      }
      if (dailyStreakNotice) {
        highlights.push(dailyStreakNotice);
      }
      if (reason) {
        highlights.push(`🛑 ${reason}`);
      }
      b.blockquote(highlights.join('\n'));
    }

    b.divider();
    b.buttons([
      richButton.callback(`🔄 Rematch (${session.mode.toUpperCase()})`, `game_start:${session.mode}`, { style: 'success' }),
      richButton.callback('🎲 Play Mixed Blitz', 'game_start:mixed', { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎮 Open Game Hub', `game_hub:${meta.tab || 'visual'}`, { style: 'primary' }),
      richButton.callback('🏆 Hall of Fame', 'game_lb:group', { style: 'primary' })
    ]);

    b.validate();
    if (typeof this.api.sendRichMessage === 'function') {
      await this.api.sendRichMessage(session.chatId, b.toJSON()).catch((err) => {
        this.log.error?.({ err, chatId: session.chatId }, 'failed to send rich victory podium');
      });
    } else if (typeof this.api.sendMessage === 'function') {
      await this.api.sendMessage(session.chatId, '🏆 VICTORY PODIUM').catch(() => {});
    }
  }

  #clearSessionTimers(session) {
    if (session.timerHandle) clearTimeout(session.timerHandle);
    if (session.hint1Timeout) clearTimeout(session.hint1Timeout);
    if (session.hint2Timeout) clearTimeout(session.hint2Timeout);
    session.timerHandle = null;
    session.hint1Timeout = null;
    session.hint2Timeout = null;
  }
}
