import { EventEmitter } from 'node:events';
import { renderGameCard, renderPodiumCard } from './canvas.js';
import { getRandomFlag } from './data/flags.js';
import { getRandomCar } from './data/cars.js';
import { getRandomCharacter } from './data/characters.js';
import { getAiOrCuratedTrivia } from './data/trivia.js';

/**
 * High-performance Levenshtein Distance calculation for fuzzy matching typos.
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

/**
 * Normalizes input text and checks for a match against accepted aliases.
 */
function isFuzzyMatch(rawInput, aliases = []) {
  if (!rawInput || !aliases.length) return false;

  let cleaned = String(rawInput)
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip multiple conversational filler prefixes repeatedly
  const prefixRegex = /^(is it|i think|maybe|could it be|its|it is|it's|this is|i guess|a|the)\s+/i;
  while (prefixRegex.test(cleaned)) {
    cleaned = cleaned.replace(prefixRegex, '').trim();
  }

  if (!cleaned) return false;

  for (const alias of aliases) {
    const target = alias.toLowerCase().trim();
    if (cleaned === target) return true;

    // Word boundary containment (e.g. "it is definitely france bro")
    if (target.length >= 3) {
      const boundaryRegex = new RegExp(`(^|\\s)${target}($|\\s)`, 'i');
      if (boundaryRegex.test(cleaned)) return true;
    }

    // Fuzzy matching threshold based on length
    if (target.length >= 5 && levenshtein(cleaned, target) <= 1) return true;
    if (target.length >= 8 && levenshtein(cleaned, target) <= 2) return true;
  }
  return false;
}

/**
 * Safely fetches an image buffer with a fast 3-second timeout.
 */
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Sleeps for a specified number of milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GameEngine extends EventEmitter {
  constructor({ api, db, log = console } = {}) {
    super();
    this.api = api;
    this.db = db;
    this.log = log;
    this.sessions = new Map(); // chatId -> Session
  }

  /**
   * Checks whether a game is actively running in the given chat.
   */
  hasActiveGame(chatId) {
    return this.sessions.has(Number(chatId));
  }

  /**
   * Retrieves active session details for inspection.
   */
  getSession(chatId) {
    return this.sessions.get(Number(chatId)) || null;
  }

  /**
   * Starts a new game session in the specified chat.
   */
  async startGame(chatId, {
    mode = 'flags',
    totalRounds = 5,
    difficulty = 'ALL',
    startedBy = null
  } = {}) {
    const cid = Number(chatId);
    if (this.sessions.has(cid)) {
      return { ok: false, error: 'A game is already active in this chat! Use /game stop to end it first.' };
    }

    const validModes = ['flags', 'cars', 'characters', 'mixed', 'poll'];
    const chosenMode = validModes.includes(mode?.toLowerCase()) ? mode.toLowerCase() : 'flags';
    const rounds = Math.max(1, Math.min(20, Number(totalRounds) || 5));

    const session = {
      chatId: cid,
      mode: chosenMode,
      difficulty: String(difficulty).toUpperCase(),
      totalRounds: rounds,
      currentRound: 0,
      startedBy,
      state: 'starting',
      scores: new Map(), // userId -> { id, name, username, score, streak, correctCount, fastestMs }
      usedIds: new Set(),
      currentQuestion: null,
      cardMessageId: null,
      pollId: null,
      roundStartTime: null,
      timerHandle: null,
      hint1Timeout: null,
      hint2Timeout: null
    };

    this.sessions.set(cid, session);
    this.log.info?.({ chatId: cid, mode: chosenMode, rounds }, 'game session initialized');

    // Launch round 1 asynchronously
    void this.#runNextRound(session);
    return { ok: true, session };
  }

  /**
   * Stops and cleans up the game session in the given chat.
   */
  async stopGame(chatId, { user = null } = {}) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session) {
      return { ok: false, error: 'There is no active game in this chat.' };
    }

    session.isStopped = true;
    session.state = 'stopped';
    this.#clearSessionTimers(session);
    this.sessions.delete(cid);

    const userName = user?.first_name || 'Admin';
    await this.api.sendMessage(
      cid,
      `<blockquote>🛑 <b>Game stopped</b> by ${userName}. See you next time! ♡</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    return { ok: true };
  }

  /**
   * Skips the current round and reveals the answer.
   */
  async skipRound(chatId) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session || !session.currentQuestion) {
      return { ok: false, error: 'No active question to skip.' };
    }

    this.#clearSessionTimers(session);
    const answer = session.currentQuestion.displayName || session.currentQuestion.name;

    if (session.cardMessageId) {
      await this.api.editMessageCaption({
        chat_id: cid,
        message_id: session.cardMessageId,
        caption: `<blockquote>⏭️ <b>Round Skipped!</b>\nAnswer: <b>${answer}</b> ♡</blockquote>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    await sleep(2500);
    void this.#runNextRound(session);
    return { ok: true };
  }

  /**
   * Forces early hint in the active round.
   */
  async giveHint(chatId) {
    const cid = Number(chatId);
    const session = this.sessions.get(cid);
    if (!session || !session.currentQuestion || !session.cardMessageId) {
      return { ok: false, error: 'No active question to hint.' };
    }

    const q = session.currentQuestion;
    const hintText = q.hint1 || q.capital || q.country || 'No extra hint available!';

    await this.api.editMessageCaption({
      chat_id: cid,
      message_id: session.cardMessageId,
      caption: `<blockquote>💡 <b>Early Hint:</b> ${hintText} ♡</blockquote>`,
      parse_mode: 'HTML'
    }).catch(() => {});

    return { ok: true };
  }

  /**
   * Checks incoming group messages against the active question's answers.
   */
  async handleChatMessage(message) {
    if (!message?.chat?.id || !message?.text) return false;
    const cid = Number(message.chat.id);
    const session = this.sessions.get(cid);
    if (!session || session.state !== 'in_round' || !session.currentQuestion) return false;

    const aliases = session.currentQuestion.aliases || [];
    if (!isFuzzyMatch(message.text, aliases)) return false;

    // Correct Answer Found!
    const fromUser = message.from;
    const reactionMs = session.roundStartTime ? Date.now() - session.roundStartTime : 5000;
    this.#clearSessionTimers(session);
    session.state = 'round_ended';

    // Compute player scoring
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

    existing.streak += 1;
    existing.correctCount += 1;

    // Base: 100 pts. Speed bonus: +50 if under 4.0s. Streak multiplier.
    const speedBonus = reactionMs < 4000 ? 50 : 0;
    const streakMultiplier = existing.streak >= 3 ? 1.5 : 1.0;
    const pointsAwarded = Math.round((100 + speedBonus) * streakMultiplier);

    existing.score += pointsAwarded;
    if (!existing.fastestMs || reactionMs < existing.fastestMs) {
      existing.fastestMs = reactionMs;
    }
    session.scores.set(uid, existing);

    // Save to persistent database
    if (this.db) {
      this.db.recordGameAnswer(cid, fromUser, pointsAwarded, reactionMs);
    }

    const answerName = session.currentQuestion.displayName || session.currentQuestion.name;
    const winnerTag = fromUser.username ? `@${fromUser.username}` : fromUser.first_name;
    const reactionSec = (reactionMs / 1000).toFixed(1);
    const streakFlame = existing.streak >= 2 ? ` 🔥 x${existing.streak} Streak!` : '';

    // In-place edit of the visual card to WINNER state
    if (session.cardMessageId) {
      await this.api.editMessageCaption({
        chat_id: cid,
        message_id: session.cardMessageId,
        caption: `<blockquote>🎉 <b>WINNER: ${winnerTag}!</b>\n✅ Answer: <b>${answerName}</b>\n⚡ Sniped in <b>${reactionSec}s</b> (+${pointsAwarded} XP)${streakFlame} ♡</blockquote>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    await sleep(3500);
    if (!this.sessions.has(cid) || session.isStopped) return true;
    void this.#runNextRound(session);
    return true;
  }

  /**
   * Internal runner for advancing to the next round or finishing the game.
   */
  async #runNextRound(session) {
    if (!this.sessions.has(session.chatId) || session.isStopped) return;
    session.currentRound += 1;
    this.#clearSessionTimers(session);

    if (session.currentRound > session.totalRounds) {
      return this.#finishGame(session);
    }

    session.state = 'in_round';
    session.roundStartTime = Date.now();

    // 1. Pick next question
    let question = null;
    let categoryTitle = 'GUESS THE FLAG';
    let categoryIcon = '🌍';
    let mediaUrl = null;
    let hint1 = '';
    let hint2 = '';

    if (session.mode === 'flags') {
      const flag = getRandomFlag(session.difficulty, session.usedIds);
      categoryTitle = 'GUESS THE FLAG';
      categoryIcon = '🌍';
      mediaUrl = flag.imageUrl;
      hint1 = `Continent: ${flag.continent} | Length: ${flag.name.length} letters`;
      hint2 = `Capital City: ${flag.capital}`;
      question = {
        name: flag.name,
        displayName: `${flag.name} 🏛️ ${flag.capital}`,
        aliases: flag.aliases,
        hint1,
        hint2,
        difficulty: flag.difficulty,
        imageUrl: flag.imageUrl
      };
    } else if (session.mode === 'cars') {
      const car = getRandomCar(session.difficulty, session.usedIds);
      categoryTitle = 'GUESS THE CAR';
      categoryIcon = '🚘';
      mediaUrl = car.imageUrl;
      hint1 = `Country of Origin: ${car.country} | Founded: ~${car.founded}`;
      hint2 = `Famous Model: ${car.famousModel}`;
      question = {
        name: car.name,
        displayName: `${car.name} (${car.country})`,
        aliases: car.aliases,
        hint1,
        hint2,
        difficulty: car.difficulty,
        imageUrl: car.imageUrl
      };
    } else if (session.mode === 'characters') {
      const char = getRandomCharacter(session.difficulty, session.usedIds);
      categoryTitle = 'GUESS THE CHARACTER';
      categoryIcon = '👀';
      mediaUrl = char.imageUrl;
      hint1 = `Franchise/Category: ${char.universe}`;
      hint2 = `${char.clue1}`;
      question = {
        name: char.name,
        displayName: `${char.name} (${char.universe})`,
        aliases: char.aliases,
        hint1,
        hint2,
        difficulty: char.difficulty,
        imageUrl: char.imageUrl
      };
    } else {
      // Mixed / Trivia / Poll
      const trivia = await getAiOrCuratedTrivia();
      categoryTitle = 'AI TRIVIA QUIZ';
      categoryIcon = '🧠';
      question = {
        name: trivia.options[trivia.correctIndex],
        displayName: trivia.options[trivia.correctIndex],
        aliases: [trivia.options[trivia.correctIndex], String.fromCharCode(65 + trivia.correctIndex)],
        hint1: `Category: ${trivia.category}`,
        hint2: `Explanation Hint: ${trivia.explanation.slice(0, 50)}...`,
        difficulty: trivia.difficulty || 'MEDIUM',
        trivia
      };
    }

    session.currentQuestion = question;

    // 2. Render and send Visual Game Card (for image modes)
    try {
      const mediaBuf = mediaUrl ? await fetchImageBuffer(mediaUrl) : null;
      const cardBuffer = await renderGameCard({
        category: categoryTitle,
        categoryIcon,
        round: session.currentRound,
        totalRounds: session.totalRounds,
        difficulty: question.difficulty || 'MEDIUM',
        mediaBuffer: mediaBuf,
        promptText: 'Type your answer in chat! First correct wins +120 XP ♡',
        timerText: '30s Smart Timer'
      });

      const initialCaption = `<blockquote>🎮 <b>Round ${session.currentRound}/${session.totalRounds}</b> • ${categoryTitle}\n⏱️ 30s remaining • Type your answer directly in chat! ♡</blockquote>`;
      const sent = await this.api.sendPhoto(session.chatId, cardBuffer, {
        caption: initialCaption,
        parse_mode: 'HTML'
      });

      session.cardMessageId = sent?.message_id || null;
    } catch (err) {
      this.log.error?.({ err, chatId: session.chatId }, 'failed to send visual card');
    }

    // 3. Precision Smart Timer (Zero-Spam in-place caption edits)
    // Hint 1 at 10s (20s left)
    session.hint1Timeout = setTimeout(async () => {
      if (session.state !== 'in_round' || !session.cardMessageId) return;
      await this.api.editMessageCaption({
        chat_id: session.chatId,
        message_id: session.cardMessageId,
        caption: `<blockquote>🎮 <b>Round ${session.currentRound}/${session.totalRounds}</b> • ⏱️ 20s remaining\n💡 <b>Hint 1:</b> ${question.hint1} ♡</blockquote>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }, 10000);

    // Hint 2 at 20s (10s left)
    session.hint2Timeout = setTimeout(async () => {
      if (session.state !== 'in_round' || !session.cardMessageId) return;
      await this.api.editMessageCaption({
        chat_id: session.chatId,
        message_id: session.cardMessageId,
        caption: `<blockquote>🎮 <b>Round ${session.currentRound}/${session.totalRounds}</b> • ⏱️ 10s remaining!\n💡 <b>Hint 2:</b> ${question.hint2} ♡</blockquote>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }, 20000);

    // Round Timeout at 30s
    session.timerHandle = setTimeout(async () => {
      if (session.state !== 'in_round') return;
      session.state = 'round_ended';
      const ans = question.displayName || question.name;

      if (session.cardMessageId) {
        await this.api.editMessageCaption({
          chat_id: session.chatId,
          message_id: session.cardMessageId,
          caption: `<blockquote>⌛ <b>Time's Up!</b> Nobody guessed in time.\n✅ Correct Answer: <b>${ans}</b> ♡</blockquote>`,
          parse_mode: 'HTML'
        }).catch(() => {});
      }

      await sleep(3500);
      if (!this.sessions.has(session.chatId) || session.isStopped) return;
      void this.#runNextRound(session);
    }, 30000);
  }

  /**
   * Finalizes the game session and generates the victory podium.
   */
  async #finishGame(session) {
    session.state = 'ended';
    this.#clearSessionTimers(session);
    this.sessions.delete(session.chatId);

    const players = Array.from(session.scores.values()).sort((a, b) => b.score - a.score);
    const topPlayers = players.slice(0, 3);
    const fastest = players.filter((p) => p.fastestMs).sort((a, b) => a.fastestMs - b.fastestMs)[0] || null;

    if (players.length > 0 && this.db) {
      // Record game win for 1st place
      this.db.recordGameWin(session.chatId, { id: players[0].id, first_name: players[0].name });
    }

    try {
      const podiumBuf = await renderPodiumCard({
        category: session.mode.toUpperCase(),
        totalRounds: session.totalRounds,
        topPlayers,
        fastestPlayer: fastest ? { name: fastest.name, ms: fastest.fastestMs } : null
      });

      let summaryHtml = `<blockquote>🏆 <b>MATCH RESULTS: ${session.mode.toUpperCase()}</b> ♡\n\n`;
      if (players.length === 0) {
        summaryHtml += 'No points were scored this match! Play again with <code>/game</code>!</blockquote>';
      } else {
        const medals = ['🥇', '🥈', '🥉'];
        players.slice(0, 5).forEach((p, idx) => {
          const medal = medals[idx] || `<b>#${idx + 1}</b>`;
          summaryHtml += `${medal} <b>${p.name}</b> — ${p.score} pts (${p.correctCount} correct)\n`;
        });
        if (fastest) {
          summaryHtml += `\n⚡ <b>Fastest Snipe:</b> ${fastest.name} in ${(fastest.fastestMs / 1000).toFixed(1)}s!`;
        }
        summaryHtml += '</blockquote>';
      }

      await this.api.sendPhoto(session.chatId, podiumBuf, {
        caption: summaryHtml,
        parse_mode: 'HTML'
      });
    } catch (err) {
      this.log.error?.({ err, chatId: session.chatId }, 'failed to send victory podium');
    }
  }

  /**
   * Clears all active timeouts on a session.
   */
  #clearSessionTimers(session) {
    if (session.timerHandle) clearTimeout(session.timerHandle);
    if (session.hint1Timeout) clearTimeout(session.hint1Timeout);
    if (session.hint2Timeout) clearTimeout(session.hint2Timeout);
    session.timerHandle = null;
    session.hint1Timeout = null;
    session.hint2Timeout = null;
  }
}
