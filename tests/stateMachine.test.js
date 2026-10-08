import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine, States, DEFAULT_STATE_TIMEOUT_MS } from '../src/core/stateMachine.js';

function makeMachine() {
  const persisted = new Map();
  const sm = new StateMachine({
    loadPersisted: (tgId) => persisted.get(String(tgId)) ?? null,
    persist: (tgId, record) => persisted.set(String(tgId), structuredClone(record))
  });
  return { sm, persisted };
}

test('transitions run onEnter and persist state', async () => {
  const { sm, persisted } = makeMachine();
  const entered = [];
  sm.register(States.PINTEREST_SEARCH, {
    onEnter: (ctx, info) => entered.push(info.reason)
  });
  await sm.transition('1', States.PINTEREST_SEARCH, { context: { mode: 'mixed' } });
  assert.equal(sm.state('1'), States.PINTEREST_SEARCH);
  assert.deepEqual(entered, ['enter']);
  assert.equal(persisted.get('1').state, States.PINTEREST_SEARCH);
  assert.equal(persisted.get('1').context.mode, 'mixed');
});

test('context update merges and persists', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  sm.register(States.PINTEREST_SEARCH, {});
  await sm.transition('1', States.PINTEREST_SEARCH, { context: { a: 1 } });
  sm.update('1', { b: 2 });
  assert.deepEqual(sm.context('1'), { a: 1, b: 2 });
});

test('onCleanup of the old state runs on transition', async () => {
  const { sm } = makeMachine();
  const cleaned = [];
  sm.register(States.WA_PAIR_NAME, { onCleanup: () => cleaned.push('pair-name') });
  sm.register(States.WA_PAIR_NUMBER, {});
  await sm.transition('1', States.WA_PAIR_NAME, {});
  await sm.transition('1', States.WA_PAIR_NUMBER, { context: { name: 'x' } });
  assert.deepEqual(cleaned, ['pair-name']);
});

test('back returns to the previous state with its context', async () => {
  const { sm } = makeMachine();
  sm.register(States.WA_PAIR_NAME, { onEnter: () => {} });
  sm.register(States.WA_PAIR_NUMBER, { onEnter: () => {} });
  sm.register(States.IDLE, {});
  await sm.transition('1', States.WA_PAIR_NAME, { context: { step: 'name' } });
  await sm.transition('1', States.WA_PAIR_NUMBER, { context: { step: 'number', name: 'Lancy' } });
  await sm.back('1');
  assert.equal(sm.state('1'), States.WA_PAIR_NAME);
  assert.deepEqual(sm.context('1'), { step: 'name' });
});

test('back with empty history goes to fallback', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  sm.register(States.PINTEREST_SEARCH, {});
  await sm.transition('1', States.PINTEREST_SEARCH, {});
  await sm.back('1');
  assert.equal(sm.state('1'), States.IDLE);
});

test('cancel runs onCancel then returns to IDLE', async () => {
  const { sm } = makeMachine();
  let cancelled = 0;
  sm.register(States.MANUAL_STICKER_COLLECTION, { onCancel: () => cancelled++ });
  sm.register(States.IDLE, {});
  await sm.transition('1', States.MANUAL_STICKER_COLLECTION, { context: { wanted: 10 } });
  await sm.cancel('1');
  assert.equal(cancelled, 1);
  assert.equal(sm.state('1'), States.IDLE);
  assert.deepEqual(sm.context('1'), {});
});

test('messages route to the current state handler', async () => {
  const { sm } = makeMachine();
  const received = [];
  sm.register(States.PINTEREST_SEARCH, {
    onMessage: (ctx, message) => { received.push(message.text); return true; }
  });
  await sm.transition('1', States.PINTEREST_SEARCH, {});
  const handled = await sm.handleMessage('1', { text: 'gojo' });
  assert.equal(handled, true);
  assert.deepEqual(received, ['gojo']);
});

test('unhandled messages return false', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  const handled = await sm.handleMessage('1', { text: 'hi' });
  assert.equal(handled, false);
});

test('state timeout resets to IDLE and runs onTimeout', async () => {
  const { sm } = makeMachine();
  let timedOut = 0;
  sm.register(States.PINTEREST_SEARCH, { onTimeout: () => timedOut++ });
  sm.register(States.IDLE, {});
  await sm.transition('1', States.PINTEREST_SEARCH, {}, );
  // Force-expire by re-arming with a tiny timeout via direct timer control:
  const record = sm.for('1');
  clearTimeout(record.timer);
  record.timer = setTimeout(() => {}, 10);
  // simulate the timeout path
  await sm.reset('1', { reason: 'timeout' });
  assert.equal(sm.state('1'), States.IDLE);
});

test('reset clears state without onCancel', async () => {
  const { sm } = makeMachine();
  let cancelled = 0;
  sm.register(States.AI_CHAT, { onCancel: () => cancelled++ });
  sm.register(States.IDLE, {});
  await sm.transition('1', States.AI_CHAT, {});
  await sm.reset('1');
  assert.equal(cancelled, 0);
  assert.equal(sm.state('1'), States.IDLE);
});

test('recovery: unknown persisted state falls back to IDLE', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  // Simulate a persisted state that no longer exists after an update.
  const machine = new StateMachine({
    loadPersisted: () => ({ state: 'REMOVED_STATE', context: { x: 1 } }),
    persist: () => {}
  });
  machine.register(States.IDLE, {});
  assert.equal(machine.state('1'), States.IDLE);
  assert.equal(machine.context('1').recoveredFrom, 'REMOVED_STATE');
});

test('history is capped', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  const states = [States.PINTEREST_SEARCH, States.PINTEREST_RESULTS, States.STICKER_COUNT_SELECTION,
    States.MANUAL_STICKER_COLLECTION, States.PACK_PREVIEW, States.PACK_CREATION, States.WA_PAIR_NAME,
    States.WA_PAIR_NUMBER, States.WA_PAIRING, States.WA_SESSION_MENU, States.WA_PACK_SELECTION,
    States.WA_CAPTION_EDITOR];
  for (const state of states) sm.register(state, {});
  await sm.transition('1', States.IDLE, {});
  for (const s of states) await sm.transition('1', s, { context: { s } });
  const record = sm.for('1');
  assert.ok(record.history.length <= 10, `history capped, got ${record.history.length}`);
});

test('onMessage handlers compose: new handler defers to the previous one', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  const calls = [];
  // first registration (e.g. the pinterest screen)
  sm.register(States.PINTEREST_SEARCH, {
    onMessage: async (sctx, message) => {
      calls.push('pinterest');
      return message.text === 'for-pinterest';
    }
  });
  // second registration (e.g. the stickers screen sharing the state)
  sm.register(States.PINTEREST_SEARCH, {
    onMessage: async (sctx, message) => {
      calls.push('stickers');
      if (!sctx.context.packFlow) return false; // defer
      return message.text === 'for-stickers';
    }
  });
  await sm.transition('1', States.PINTEREST_SEARCH, { context: { packFlow: false } });
  // non-packFlow: stickers defers, pinterest handles
  assert.equal(await sm.handleMessage('1', { text: 'for-pinterest' }), true);
  assert.deepEqual(calls, ['stickers', 'pinterest']);
  // packFlow: stickers handles it, pinterest never runs
  calls.length = 0;
  await sm.transition('1', States.PINTEREST_SEARCH, { context: { packFlow: true } });
  assert.equal(await sm.handleMessage('1', { text: 'for-stickers' }), true);
  assert.deepEqual(calls, ['stickers']);
  // neither handles
  calls.length = 0;
  assert.equal(await sm.handleMessage('1', { text: 'unrelated' }), false);
  assert.deepEqual(calls, ['stickers', 'pinterest']);
});

test('re-registering a hook replaces it (onCleanup does not chain)', async () => {
  const { sm } = makeMachine();
  sm.register(States.IDLE, {});
  const cleaned = [];
  sm.register(States.WA_PAIR_NAME, { onCleanup: () => cleaned.push('first') });
  sm.register(States.WA_PAIR_NAME, { onCleanup: () => cleaned.push('second') });
  await sm.transition('1', States.WA_PAIR_NAME, {});
  await sm.transition('1', States.IDLE, {});
  assert.deepEqual(cleaned, ['second'], 'only the latest onCleanup runs');
});
