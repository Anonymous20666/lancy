import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/games/engine.js';
import { Database } from '../src/core/db.js';
import { CAR_BRANDS, GLOBAL_BRANDS, APP_ICONS } from '../src/games/data/cars.js';
import {
  getLiveCarLogoQuestion,
  getLiveBrandLogoQuestion,
  getLiveAppIconQuestion,
  getLiveLogoQuestion
} from '../src/games/providers/world.js';
import { fetchImageBuffer } from '../src/games/visuals.js';

test('Player Messages are NEVER deleted during game rounds or duels', async () => {
  const db = new Database(':memory:');
  const deletedMessages = [];
  const mockApi = {
    deleteMessage: async (cid, mid) => {
      deletedMessages.push({ cid, mid });
      return true;
    },
    sendMessage: async () => ({ message_id: 101 }),
    sendPhoto: async () => ({ message_id: 102 }),
    answerCallbackQuery: async () => true
  };

  const engine = new GameEngine({ api: mockApi, db, log: console });
  const cid = -100999;

  // 1. Test Number Vault Cracker chat message guesses
  await engine.startGame(cid, { mode: 'number', totalRounds: 1 });
  const session = engine.getSession(cid);
  assert.ok(session);
  session.boardState.secret = 777;

  // Player sends wrong number guess
  const wrongGuessMsg = {
    chat: { id: cid },
    from: { id: 111, first_name: 'PlayerOne' },
    message_id: 5555,
    text: '500'
  };
  await engine.handleChatMessage(wrongGuessMsg);

  // Player sends winning number guess
  const winGuessMsg = {
    chat: { id: cid },
    from: { id: 222, first_name: 'PlayerTwo' },
    message_id: 5556,
    text: '777'
  };
  await engine.handleChatMessage(winGuessMsg);

  // Assert user messages 5555 and 5556 were NOT deleted!
  assert.equal(deletedMessages.some((d) => d.mid === 5555 || d.mid === 5556), false);

  await engine.stopGame(cid);
  db.close();
});

test('Word Grid guesses by players are NEVER deleted', async () => {
  const db = new Database(':memory:');
  const deletedMessages = [];
  const mockApi = {
    deleteMessage: async (cid, mid) => {
      deletedMessages.push({ cid, mid });
      return true;
    },
    sendMessage: async () => ({ message_id: 201 }),
    sendPhoto: async () => ({ message_id: 202 }),
    answerCallbackQuery: async () => true
  };

  const engine = new GameEngine({ api: mockApi, db, log: console });
  const cid = -100888;

  await engine.startGame(cid, { mode: 'wordgrid', totalRounds: 1 });
  const session = engine.getSession(cid);
  assert.ok(session);

  const wordToFind = session.boardState.words[0].word;

  // User sends wrong random word
  await engine.handleChatMessage({
    chat: { id: cid },
    from: { id: 123, first_name: 'Guesser' },
    message_id: 8881,
    text: 'RANDOM'
  });

  // User sends correct word
  await engine.handleChatMessage({
    chat: { id: cid },
    from: { id: 456, first_name: 'Winner' },
    message_id: 8882,
    text: wordToFind
  });

  // Wait 1.5s to ensure any pending timers would have fired
  await new Promise((r) => setTimeout(r, 1500));

  // Assert none of the user messages were deleted!
  assert.equal(deletedMessages.some((d) => d.mid === 8881 || d.mid === 8882), false);

  await engine.stopGame(cid);
  db.close();
});

test('Car Logos: 50 consecutive rounds in Unlimited Mode never repeat any car', async () => {
  const seenIds = new Set();
  const matchSeenIds = new Set();
  const pickedIds = [];

  for (let round = 1; round <= CAR_BRANDS.length; round++) {
    const q = await getLiveCarLogoQuestion({ seenIds, difficulty: 'ALL', matchSeenIds });
    assert.ok(q.id);
    assert.ok(q.name);
    assert.ok(q.imageUrl);
    assert.ok(q.options.length === 4);
    assert.ok(q.options.includes(q.name));
    assert.equal(pickedIds.includes(q.id), false, `Car ${q.name} repeated on round ${round}!`);
    pickedIds.push(q.id);
  }

  assert.equal(pickedIds.length, CAR_BRANDS.length);
  assert.equal(new Set(pickedIds).size, CAR_BRANDS.length);
});

test('Live Downloads: Car and Brand logo URLs successfully fetch valid image buffers live', async () => {
  // Test 3 random car questions
  const qCar1 = await getLiveCarLogoQuestion();
  const qCar2 = await getLiveCarLogoQuestion();
  const qBrand = await getLiveBrandLogoQuestion();
  const qIcon = await getLiveAppIconQuestion();

  const [buf1, buf2, buf3, buf4] = await Promise.all([
    fetchImageBuffer(qCar1.imageUrl),
    fetchImageBuffer(qCar2.imageUrl),
    fetchImageBuffer(qBrand.imageUrl),
    fetchImageBuffer(qIcon.imageUrl)
  ]);

  assert.ok(Buffer.isBuffer(buf1) && buf1.length > 500);
  assert.ok(Buffer.isBuffer(buf2) && buf2.length > 500);
  assert.ok(Buffer.isBuffer(buf3) && buf3.length > 500);
  assert.ok(Buffer.isBuffer(buf4) && buf4.length > 500);
});
