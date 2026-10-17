import { RichMessageBuilder, rt, richButton } from '../telegram/rich.js';
import { kvTable, WINGS } from '../telegram/ui.js';
import { getLiveFlagQuestion, getLiveLogoQuestion } from './providers/world.js';
import { getLiveAnimeCharacter } from './providers/anime.js';

function formatPlayerTag(p) {
  if (!p) return 'Waiting for Challenger...';
  if (p.isBot) return '🤖 Lancy AI ♡';
  return p.username ? `@${p.username}` : (p.name || 'Player');
}

/**
 * ── 1. TIC-TAC-TOE (3x3 Classic & 4x4 Super Grid — PvP or vs Lancy AI) ──
 */
export function createTicTacToeState(starterUser, size = 3) {
  const gridSize = size === 4 ? 4 : 3;
  return {
    type: 'ttt',
    size: gridSize,
    board: Array(gridSize * gridSize).fill(null), // null | 'X' | 'O'
    p1: { id: Number(starterUser.id), name: starterUser.first_name || 'Player 1', username: starterUser.username || null },
    p2: null, // joins on first tap or 'Play vs Lancy'
    turn: 'X',
    winner: null, // 'X' | 'O' | 'DRAW'
    winLine: [],
    moves: 0
  };
}

export function checkTicTacToeWinner(board, size = 3) {
  const lines = [];
  // Rows & Cols
  for (let i = 0; i < size; i++) {
    const row = [];
    const col = [];
    for (let j = 0; j < size; j++) {
      row.push(i * size + j);
      col.push(j * size + i);
    }
    lines.push(row, col);
  }
  // Diagonals
  const d1 = [];
  const d2 = [];
  for (let i = 0; i < size; i++) {
    d1.push(i * size + i);
    d2.push(i * size + (size - 1 - i));
  }
  lines.push(d1, d2);

  for (const line of lines) {
    const first = board[line[0]];
    if (first && line.every((idx) => board[idx] === first)) {
      return { winner: first, winLine: line };
    }
  }
  if (board.every((cell) => cell !== null)) {
    return { winner: 'DRAW', winLine: [] };
  }
  return null;
}

export function computeLancyTttMove(board, size = 3) {
  const empty = board.map((v, i) => (v === null ? i : -1)).filter((i) => i !== -1);
  if (!empty.length) return -1;

  // 1. Check if O (Lancy) can win immediately
  for (const idx of empty) {
    const copy = [...board];
    copy[idx] = 'O';
    if (checkTicTacToeWinner(copy, size)?.winner === 'O') return idx;
  }
  // 2. Block X from winning immediately
  for (const idx of empty) {
    const copy = [...board];
    copy[idx] = 'X';
    if (checkTicTacToeWinner(copy, size)?.winner === 'X') return idx;
  }
  // 3. Center if available
  const center = Math.floor((size * size) / 2);
  if (board[center] === null) return center;

  return empty[Math.floor(Math.random() * empty.length)];
}

export function buildTicTacToeRich(state) {
  const b = new RichMessageBuilder();
  const title = state.size === 4 ? 'TIC-TAC-TOE • 4×4 BLITZ' : 'TIC-TAC-TOE • DUEL ARENA';
  b.heading(`${WINGS} ${title} ${WINGS}`, 1);
  b.paragraph(rt.italic('₊˚⊹♡  tap a tile on the grid to claim your spot  ˙ᵕ˙'));
  b.divider();

  let statusText = '';
  if (state.winner === 'DRAW') {
    statusText = '🤝 Stalemate! Nobody budged — tap Rematch!';
  } else if (state.winner) {
    const winPlayer = state.winner === 'X' ? state.p1 : state.p2;
    statusText = `🏆 WINNER: ${formatPlayerTag(winPlayer)} (${state.winner === 'X' ? '❌' : '⭕'}) (+180 XP!)`;
  } else {
    const activePlayer = state.turn === 'X' ? state.p1 : state.p2;
    statusText = state.turn === 'X'
      ? `❌ ${formatPlayerTag(activePlayer)}'s Turn`
      : state.p2
        ? `⭕ ${formatPlayerTag(activePlayer)}'s Turn`
        : '⭕ Any challenger can tap a tile to join as Player 2!';
  }

  b.table(kvTable([
    ['❌ Player X', formatPlayerTag(state.p1)],
    ['⭕ Player O', formatPlayerTag(state.p2)],
    ['⚡ Status', statusText]
  ]), { compact: true });

  b.divider();

  const winSet = new Set(state.winLine || []);
  for (let r = 0; r < state.size; r++) {
    const rowBtns = [];
    for (let c = 0; c < state.size; c++) {
      const idx = r * state.size + c;
      const val = state.board[idx];
      const label = val === 'X' ? '❌' : val === 'O' ? '⭕' : '·';
      let style = 'primary';
      if (winSet.has(idx)) style = 'success';
      else if (val === 'X') style = 'danger';
      else if (val === 'O') style = 'success';

      rowBtns.push(
        richButton.callback(label, state.winner ? 'game_noop' : `game_ttt:move:${idx}`, { style })
      );
    }
    b.buttons(rowBtns);
  }

  b.divider();
  if (!state.p2 && !state.winner) {
    b.buttons([
      richButton.callback('🤖 Play vs Lancy AI', 'game_ttt:bot', { style: 'success' }),
      richButton.callback(state.size === 3 ? '🔥 Switch to 4×4 Grid' : '🎯 Switch to 3×3 Grid', `game_ttt:size:${state.size === 3 ? 4 : 3}`, { style: 'primary' })
    ]);
  }
  b.buttons([
    richButton.callback('🔄 Rematch', `game_start:ttt`, { style: 'primary' }),
    richButton.callback('🎮 Game Hub', 'game_hub:pvp', { style: 'primary' }),
    richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
  ]);

  b.validate();
  return b.toJSON();
}

/**
 * ── 2. CONNECT FOUR (7x6 Gravity Grid — PvP or vs Lancy AI) ──
 */
export function createConnectFourState(starterUser) {
  const rows = 6;
  const cols = 7;
  return {
    type: 'connect4',
    rows,
    cols,
    grid: Array.from({ length: rows }, () => Array(cols).fill(null)), // null | 'R' | 'Y'
    p1: { id: Number(starterUser.id), name: starterUser.first_name || 'Player 1', username: starterUser.username || null },
    p2: null,
    turn: 'R', // 'R' = 🔴, 'Y' = 🟡
    winner: null, // 'R' | 'Y' | 'DRAW'
    lastMove: null
  };
}

export function dropConnectFourDisc(state, col) {
  if (col < 0 || col >= state.cols) return -1;
  for (let r = state.rows - 1; r >= 0; r--) {
    if (state.grid[r][col] === null) {
      state.grid[r][col] = state.turn;
      state.lastMove = { r, c: col };
      return r;
    }
  }
  return -1;
}

export function checkConnectFourWin(grid, rows = 6, cols = 7) {
  const dirs = [
    [0, 1],  // horizontal
    [1, 0],  // vertical
    [1, 1],  // diag down-right
    [1, -1]  // diag down-left
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const player = grid[r][c];
      if (!player) continue;
      for (const [dr, dc] of dirs) {
        let count = 1;
        for (let step = 1; step < 4; step++) {
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || grid[nr][nc] !== player) break;
          count++;
        }
        if (count >= 4) return player;
      }
    }
  }

  const isFull = grid[0].every((cell) => cell !== null);
  return isFull ? 'DRAW' : null;
}

export function computeLancyConnectFourCol(state) {
  const validCols = [];
  for (let c = 0; c < state.cols; c++) {
    if (state.grid[0][c] === null) validCols.push(c);
  }
  if (!validCols.length) return -1;

  // Try winning column or blocking column
  for (const targetDisc of ['Y', 'R']) {
    for (const c of validCols) {
      const copyGrid = state.grid.map((row) => [...row]);
      for (let r = state.rows - 1; r >= 0; r--) {
        if (copyGrid[r][c] === null) {
          copyGrid[r][c] = targetDisc;
          break;
        }
      }
      if (checkConnectFourWin(copyGrid, state.rows, state.cols) === targetDisc) return c;
    }
  }

  // Prefer center columns
  const centerOrder = [3, 2, 4, 1, 5, 0, 6].filter((c) => validCols.includes(c));
  return Math.random() < 0.7 ? centerOrder[0] : validCols[Math.floor(Math.random() * validCols.length)];
}

export function buildConnectFourRich(state) {
  const b = new RichMessageBuilder();
  b.heading(`${WINGS} CONNECT FOUR • GRAVITY GRID ${WINGS}`, 1);
  b.paragraph(rt.italic('₊˚⊹♡  connect 4 discs horizontally, vertically, or diagonally  ˙ᵕ˙'));
  b.divider();

  let statusText = '';
  if (state.winner === 'DRAW') {
    statusText = '🤝 Full Board Draw! Nobody connected 4!';
  } else if (state.winner) {
    const winP = state.winner === 'R' ? state.p1 : state.p2;
    statusText = `🏆 WINNER: ${formatPlayerTag(winP)} (${state.winner === 'R' ? '🔴' : '🟡'}) (+220 XP!)`;
  } else {
    statusText = state.turn === 'R'
      ? `🔴 ${formatPlayerTag(state.p1)}'s Turn`
      : state.p2
        ? `🟡 ${formatPlayerTag(state.p2)}'s Turn`
        : '🟡 Any player can tap a column below to join as Player 2!';
  }

  b.table(kvTable([
    ['🔴 Red Discs', formatPlayerTag(state.p1)],
    ['🟡 Gold Discs', formatPlayerTag(state.p2)],
    ['⚡ Turn', statusText]
  ]), { compact: true });

  // Render visual 7x6 grid inside a blockquote
  const boardLines = state.grid.map((row) =>
    row.map((cell) => (cell === 'R' ? '🔴' : cell === 'Y' ? '🟡' : '⚫')).join(' ')
  );
  boardLines.push('1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣');
  b.blockquote(boardLines.join('\n'));

  if (!state.winner) {
    b.buttons([
      richButton.callback('⬇️ 1', 'game_c4:drop:0', { style: 'primary' }),
      richButton.callback('⬇️ 2', 'game_c4:drop:1', { style: 'primary' }),
      richButton.callback('⬇️ 3', 'game_c4:drop:2', { style: 'primary' }),
      richButton.callback('⬇️ 4', 'game_c4:drop:3', { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('⬇️ 5', 'game_c4:drop:4', { style: 'primary' }),
      richButton.callback('⬇️ 6', 'game_c4:drop:5', { style: 'primary' }),
      richButton.callback('⬇️ 7', 'game_c4:drop:6', { style: 'primary' })
    ]);
  }

  b.divider();
  if (!state.p2 && !state.winner) {
    b.buttons([
      richButton.callback('🤖 Play vs Lancy AI', 'game_c4:bot', { style: 'success' })
    ]);
  }
  b.buttons([
    richButton.callback('🔄 Rematch', 'game_start:connect4', { style: 'primary' }),
    richButton.callback('🎮 Game Hub', 'game_hub:pvp', { style: 'primary' }),
    richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
  ]);

  b.validate();
  return b.toJSON();
}

/**
 * ── 3. ROCK, PAPER, SCISSORS (Best-of-3 Arena Clash — PvP or vs Lancy) ──
 */
export function createRpsState(starterUser) {
  return {
    type: 'rps',
    p1: { id: Number(starterUser.id), name: starterUser.first_name || 'Player 1', username: starterUser.username || null, hp: 3, choice: null },
    p2: null, // joins when someone else taps a move or 'Play vs Lancy'
    round: 1,
    history: [],
    winner: null
  };
}

const RPS_EMOJI = { rock: '🪨 Rock', paper: '📄 Paper', scissors: '✂️ Scissors' };
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function resolveRpsClash(state) {
  const c1 = state.p1.choice;
  const c2 = state.p2.choice;
  state.p1.choice = null;
  state.p2.choice = null;

  let outcome = '';
  if (c1 === c2) {
    outcome = `Round ${state.round}: Both threw ${RPS_EMOJI[c1]} — Clash Draw! ⚡`;
  } else if (RPS_BEATS[c1] === c2) {
    state.p2.hp = Math.max(0, state.p2.hp - 1);
    outcome = `Round ${state.round}: ${formatPlayerTag(state.p1)}'s ${RPS_EMOJI[c1]} crushed ${RPS_EMOJI[c2]}! 💥`;
  } else {
    state.p1.hp = Math.max(0, state.p1.hp - 1);
    outcome = `Round ${state.round}: ${formatPlayerTag(state.p2)}'s ${RPS_EMOJI[c2]} beat ${RPS_EMOJI[c1]}! 💥`;
  }

  state.history.push(outcome);
  state.round += 1;

  if (state.p1.hp <= 0) state.winner = state.p2;
  else if (state.p2.hp <= 0) state.winner = state.p1;
}

export function buildRpsRich(state) {
  const b = new RichMessageBuilder();
  b.heading(`${WINGS} ROCK • PAPER • SCISSORS ARENA ${WINGS}`, 1);
  b.paragraph(rt.italic('₊˚⊹♡  best-of-3 HP battle • choices stay hidden until both lock in  ˙ᵕ˙'));
  b.divider();

  const hpBar = (hp) => '❤️'.repeat(hp) + '🖤'.repeat(Math.max(0, 3 - hp));
  const p1Status = state.p1.choice ? '🔒 Locked In!' : '⏳ Choosing...';
  const p2Status = !state.p2
    ? 'Tap any weapon below to challenge!'
    : state.p2.choice
      ? '🔒 Locked In!'
      : '⏳ Choosing...';

  b.table(kvTable([
    [`⚔️ ${formatPlayerTag(state.p1)}`, `${hpBar(state.p1.hp)} • ${state.winner ? '' : p1Status}`],
    [`🛡️ ${formatPlayerTag(state.p2)}`, `${state.p2 ? hpBar(state.p2.hp) : '❤️❤️❤️'} • ${state.winner ? '' : p2Status}`],
    ['🔥 Round', state.winner ? `🏆 Winner: ${formatPlayerTag(state.winner)} (+150 XP!)` : `Round ${state.round}`]
  ]), { compact: true });

  if (state.history.length > 0) {
    b.blockquote(state.history.slice(-3).join('\n'));
  }

  if (!state.winner) {
    b.buttons([
      richButton.callback('🪨 Rock', 'game_rps:pick:rock', { style: 'primary' }),
      richButton.callback('📄 Paper', 'game_rps:pick:paper', { style: 'primary' }),
      richButton.callback('✂️ Scissors', 'game_rps:pick:scissors', { style: 'primary' })
    ]);
    if (!state.p2) {
      b.buttons([
        richButton.callback('🤖 Battle vs Lancy AI', 'game_rps:bot', { style: 'success' })
      ]);
    }
  }

  b.divider();
  b.buttons([
    richButton.callback('🔄 Rematch', 'game_start:rps', { style: 'primary' }),
    richButton.callback('🎮 Game Hub', 'game_hub:pvp', { style: 'primary' }),
    richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
  ]);

  b.validate();
  return b.toJSON();
}

/**
 * ── 4. NUMBER GUESSING: MULTIPLAYER VAULT CRACKER (1 – 1000) ──
 */
export function createNumberVaultState(starterUser) {
  const secret = Math.floor(Math.random() * 1000) + 1;
  return {
    type: 'number',
    secret,
    minBound: 1,
    maxBound: 1000,
    attempts: 0,
    maxAttempts: 18,
    history: [], // [{ player, guess, feedback }]
    clueUnlocked: false,
    winner: null,
    startedBy: starterUser
  };
}

export function getHeatFeedback(guess, secret) {
  const diff = Math.abs(guess - secret);
  const dir = guess < secret ? '⬆️ HIGHER' : '⬇️ LOWER';
  if (diff <= 10) return `🔥 BOILING HOT! Go ${dir}!`;
  if (diff <= 35) return `🌶️ Super Warm! Go ${dir}!`;
  if (diff <= 100) return `♨️ Warm — Go ${dir}`;
  if (diff <= 250) return `❄️ Cool — Go ${dir}`;
  return `🧊 Freezing — Go ${dir}`;
}

export function buildNumberVaultRich(state) {
  const b = new RichMessageBuilder();
  b.heading(`${WINGS} VAULT CRACKER • 1 TO 1000 ${WINGS}`, 1);
  b.paragraph(rt.italic('₊˚⊹♡  type any number in chat to narrow the vault range & snipe the code  ˙ᵕ˙'));
  b.divider();

  const span = state.maxBound - state.minBound;
  const pctNarrowed = Math.min(99, Math.max(5, Math.round((1 - span / 999) * 100)));
  const rangeVisual = `[ ${state.minBound} ◄━━━ 🎯 ${state.winner ? state.secret : '???'} ━━━► ${state.maxBound} ]`;

  b.blockquote(
    state.winner
      ? `🎉 VAULT CRACKED! Secret Code: ${state.secret}\n🏆 Cracked by ${formatPlayerTag(state.winner)} in ${state.attempts} tries (+200 XP)!`
      : `🔐 Active Vault Window (${pctNarrowed}% narrowed):\n${rangeVisual}`
  );

  const parityClue = state.secret % 2 === 0 ? 'Even Number' : 'Odd Number';
  const digitSum = String(state.secret).split('').reduce((acc, d) => acc + Number(d), 0);

  b.table(kvTable([
    ['🎯 Range Window', `${state.minBound}  —  ${state.maxBound}`],
    ['🔢 Attempts', `${state.attempts} / ${state.maxAttempts}`],
    ['💡 Vault Intel', state.clueUnlocked ? `${parityClue} • Digit Sum: ${digitSum}` : 'Tap "Unlock Clue" or keep guessing!']
  ]), { compact: true });

  if (state.history.length > 0) {
    const guessRows = [
      [
        { text: rt.bold('Player'), is_header: true },
        { text: rt.bold('Guess'), is_header: true },
        { text: rt.bold('Radar Signal'), is_header: true }
      ],
      ...state.history.slice(-5).map((h) => [
        { text: h.player },
        { text: rt.bold(String(h.guess)) },
        { text: h.feedback }
      ])
    ];
    b.table(guessRows, { compact: true, bordered: true });
  }

  b.divider();
  if (!state.winner) {
    const mid = Math.floor((state.minBound + state.maxBound) / 2);
    b.buttons([
      richButton.callback(`🎯 Probe Midpoint (${mid})`, `game_num:guess:${mid}`, { style: 'success' }),
      richButton.callback('💡 Unlock Clue', 'game_num:clue', { style: 'primary' })
    ]);
  }
  b.buttons([
    richButton.callback('🔄 New Vault', 'game_start:number', { style: 'primary' }),
    richButton.callback('🎮 Game Hub', 'game_hub:pvp', { style: 'primary' }),
    richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
  ]);

  b.validate();
  return b.toJSON();
}

/**
 * ── 5. HIGHER OR LOWER: LIVE STATS CLASH ──
 */
export async function generateHigherLowerPair(seenIds = new Set()) {
  const modeRoll = Math.random();
  if (modeRoll < 0.55) {
    const c1 = await getLiveFlagQuestion({ seenIds });
    seenIds.add(c1.id);
    const c2 = await getLiveFlagQuestion({ seenIds });
    if (c1.population && c2.population && c1.population !== c2.population) {
      return {
        metric: 'Country Population 🌍',
        unit: 'people',
        itemA: { name: c1.name, value: c1.population, formatted: c1.population.toLocaleString() },
        itemB: { name: c2.name, value: c2.population, formatted: c2.population.toLocaleString() }
      };
    }
  }

  // Fallback / alternate: Anime Character Favourites on AniList
  const a1 = await getLiveAnimeCharacter({ seenIds });
  seenIds.add(a1.id);
  const a2 = await getLiveAnimeCharacter({ seenIds });
  const v1 = a1.favourites || Math.floor(Math.random() * 40000) + 5000;
  let v2 = a2.favourites || Math.floor(Math.random() * 40000) + 5000;
  if (v1 === v2) v2 += 1250;

  return {
    metric: 'Anime Fan Favorites 💖 (AniList)',
    unit: 'favorites',
    itemA: { name: a1.displayName, value: v1, formatted: `${v1.toLocaleString()} 💖` },
    itemB: { name: a2.displayName, value: v2, formatted: `${v2.toLocaleString()} 💖` }
  };
}

export function buildHigherLowerRich(state) {
  const b = new RichMessageBuilder();
  b.heading(`${WINGS} HIGHER OR LOWER • LIVE STATS ${WINGS}`, 1);
  b.paragraph(rt.italic(`₊˚⊹♡  comparing: ${state.pair.metric}  ˙ᵕ˙`));
  b.divider();

  b.table(kvTable([
    ['🔥 Group Survival Streak', `${state.streak} in a row`],
    ['📊 Benchmark (A)', `${state.pair.itemA.name} — ${state.pair.itemA.formatted}`],
    ['❓ Challenger (B)', `${state.pair.itemB.name} — ${state.revealed ? state.pair.itemB.formatted : '???'}`]
  ]), { compact: true });

  if (state.lastOutcome) {
    b.blockquote(state.lastOutcome);
  } else {
    b.blockquote(`Does ${state.pair.itemB.name} have HIGHER or LOWER ${state.pair.metric} than ${state.pair.itemA.name}?`);
  }

  if (!state.gameOver) {
    b.buttons([
      richButton.callback(`⬆️ HIGHER`, 'game_hl:pick:higher', { style: 'success' }),
      richButton.callback(`⬇️ LOWER`, 'game_hl:pick:lower', { style: 'danger' })
    ]);
  }

  b.divider();
  b.buttons([
    richButton.callback('🔄 New Streak', 'game_start:highlow', { style: 'primary' }),
    richButton.callback('🎮 Game Hub', 'game_hub:pvp', { style: 'primary' }),
    richButton.callback('🛑 End', 'game_ctrl:stop', { style: 'danger' })
  ]);

  b.validate();
  return b.toJSON();
}
