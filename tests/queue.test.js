import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue, QueueManager } from '../src/core/queue.js';
import { sleep } from '../src/utils/time.js';

test('runs jobs and resolves results', async () => {
  const q = new JobQueue({ name: 't', concurrency: 2 });
  const result = await q.add({ type: 'x', run: async () => 42 });
  assert.equal(result, 42);
});

test('respects concurrency limit', async () => {
  const q = new JobQueue({ name: 't', concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  const make = () => ({ run: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(50); active--; } });
  await Promise.all(Array.from({ length: 6 }, () => q.add(make())));
  assert.equal(maxActive, 2);
});

test('retries with backoff then succeeds', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  let attempts = 0;
  const result = await q.add({
    type: 'flaky',
    run: async () => {
      attempts++;
      if (attempts < 3) { const e = new Error('boom'); e.retryable = true; throw e; }
      return 'ok';
    }
  }, { attempts: 3, baseMs: 5, maxMs: 20 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('non-retryable errors fail immediately', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  let attempts = 0;
  await assert.rejects(q.add({
    type: 'bad',
    run: async () => { attempts++; const e = new Error('nope'); e.code = 'INVALID_X'; throw e; }
  }, { attempts: 5, baseMs: 5 }));
  assert.equal(attempts, 1);
});

test('exhausting retries rejects with the last error', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  let attempts = 0;
  await assert.rejects(
    q.add({ type: 'always', run: async () => { attempts++; const e = new Error('always'); e.retryable = true; throw e; } }, { attempts: 2, baseMs: 5 }),
    /always/
  );
  assert.equal(attempts, 2);
});

test('cancellation aborts a running job', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  const controller = new AbortController();
  const promise = q.add({
    type: 'long',
    run: async (job, ctx) => {
      await sleep(5000);
      if (ctx.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return 'done';
    }
  }, { signal: controller.signal });
  await sleep(20);
  controller.abort();
  await assert.rejects(promise, /AbortError|aborted/i);
});

test('cancel by id removes pending jobs', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  const blocker = q.add({ run: async () => { await sleep(100); return 'blocker'; } });
  const pending = q.add({ id: 'p1', run: async () => 'never' });
  q.cancel('p1');
  await assert.rejects(pending, /cancelled/i);
  assert.equal(await blocker, 'blocker');
});

test('pause and resume', async () => {
  const q = new JobQueue({ name: 't', concurrency: 1 });
  q.pause();
  let ran = false;
  const p = q.add({ run: async () => { ran = true; } });
  await sleep(30);
  assert.equal(ran, false);
  q.resume();
  await p;
  assert.equal(ran, true);
});

test('QueueManager routes named queues', async () => {
  const mgr = new QueueManager({ a: { concurrency: 1 }, b: { concurrency: 3 } });
  const ra = await mgr.add('a', { run: async () => 'A' });
  const rb = await mgr.add('b', { run: async () => 'B' });
  assert.equal(ra, 'A');
  assert.equal(rb, 'B');
  assert.equal(mgr.queue('a').concurrency, 1);
  assert.equal(mgr.queue('b').concurrency, 3);
});

test('drained waits for all work', async () => {
  const q = new JobQueue({ name: 't', concurrency: 2 });
  await Promise.all(Array.from({ length: 5 }, (_, i) => q.add({ run: async () => { await sleep(10); return i; } })));
  await q.drained();
  assert.equal(q.size, 0);
  assert.equal(q.activeCount, 0);
});
