import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { renderGameCard, renderPodiumCard } from '../src/games/canvas.js';
import { getRandomFlag, FLAGS } from '../src/games/data/flags.js';
import { getRandomCar, CARS } from '../src/games/data/cars.js';
import { getRandomCharacter, CHARACTERS } from '../src/games/data/characters.js';
import { getAiOrCuratedTrivia, CURATED_TRIVIA } from '../src/games/data/trivia.js';
import { GameEngine } from '../src/games/engine.js';

test('GameCanvas: renderGameCard produces valid PNG buffer with Lancy aesthetic', async () => {
  const cardBuf = await renderGameCard({
    category: 'GUESS THE FLAG',
    categoryIcon: '🌍',
    round: 1,
    totalRounds: 5,
    difficulty: 'EASY',
    promptText: 'Type your answer in chat! ♡',
    timerText: '30s Smart Timer'
  });

  assert.ok(Buffer.isBuffer(cardBuf));
  assert.ok(cardBuf.length > 5000); // PNG header and bytes
  assert.equal(cardBuf[0], 0x89);    // PNG signature
  assert.equal(cardBuf[1], 0x50);
});

test('GameCanvas: renderPodiumCard produces valid PNG buffer with rankings', async () => {
  const podiumBuf = await renderPodiumCard({
    category: 'FLAGS',
    totalRounds: 5,
    topPlayers: [
      { name: 'Alex', score: 350 },
      { name: 'Sam', score: 200 }
    ],
    fastestPlayer: { name: 'Alex', ms: 1400 }
  });

  assert.ok(Buffer.isBuffer(podiumBuf));
  assert.ok(podiumBuf.length > 5000);
});

test('GameData: Datasets are populated with rich metadata', async () => {
  assert.ok(FLAGS.length >= 50);
  const flag = getRandomFlag('EASY');
  assert.ok(flag.name);
  assert.ok(flag.code);
  assert.ok(flag.imageUrl.includes('flagcdn.com'));
  assert.ok(Array.isArray(flag.aliases) && flag.aliases.length > 0);

  assert.ok(CARS.length >= 50);
  const car = getRandomCar('EASY');
  assert.ok(car.name);
  assert.ok(car.country);
  assert.ok(car.imageUrl.includes('car-logos-dataset'));

  assert.ok(CHARACTERS.length >= 20);
  const char = getRandomCharacter();
  assert.ok(char.name);
  assert.ok(char.universe);

  assert.ok(CURATED_TRIVIA.length >= 10);
  const trivia = await getAiOrCuratedTrivia();
  assert.ok(trivia.question);
  assert.equal(trivia.options.length, 4);
});

test('GameEngine: session lifecycle, chat answer interception, and scoring', async () => {
  const db = new Database(':memory:');
  const sentPhotos = [];
  const editedCaptions = [];
  const chatId = -100444;

  const mockApi = {
    sendPhoto: async (cid, photo, opts) => {
      sentPhotos.push({ cid, opts });
      return { message_id: 888 };
    },
    editMessageCaption: async (opts) => {
      editedCaptions.push(opts);
      return true;
    },
    sendMessage: async (cid, text, opts) => ({ message_id: 999 })
  };

  const engine = new GameEngine({ api: mockApi, db, log: console });

  // 1. Start Flags Game
  const startRes = await engine.startGame(chatId, { mode: 'flags', totalRounds: 2 });
  assert.equal(startRes.ok, true);
  assert.equal(engine.hasActiveGame(chatId), true);

  // Wait for round 1 to initialize
  const session = engine.getSession(chatId);
  assert.ok(session);

  for (let i = 0; i < 60; i++) {
    if (session.cardMessageId) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(session.currentRound, 1);
  assert.ok(session.currentQuestion);

  // 2. Chat message with correct answer
  const correctAlias = session.currentQuestion.aliases[0];
  const userMsg = {
    chat: { id: chatId },
    from: { id: 7001, first_name: 'PlayerOne', username: 'player_one' },
    text: `i think it is ${correctAlias}`
  };

  const answered = await engine.handleChatMessage(userMsg);
  assert.equal(answered, true);

  // Score recorded in DB
  const leaderboard = db.getGameLeaderboard(chatId);
  assert.equal(leaderboard.length, 1);
  assert.equal(leaderboard[0].user_id, 7001);
  assert.ok(leaderboard[0].score >= 100);

  // Card caption edited in-place to WINNER state
  assert.ok(editedCaptions.some((c) => c.caption.includes('WINNER')));

  // 3. Stop Game
  await engine.stopGame(chatId);
  assert.equal(engine.hasActiveGame(chatId), false);

  db.close();
});

test('TelegramController /game: renders launcher menu and leaderboard', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const chatId = -100555;

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'administrator' }),
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 101 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  // /game menu
  const msg = {
    message_id: 1,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Admin' },
    text: '/game'
  };

  await controller.handleGameCommand(msg, []);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /LANCY GAME ARENA/);
  assert.ok(sentMessages[0].opts?.reply_markup?.inline_keyboard);

  // /topleaderboard
  await controller.handleGameLeaderboard(msg);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /GAME ARENA LEADERBOARD/);

  db.close();
});
