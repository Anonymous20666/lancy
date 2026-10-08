import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoPacks, applySplitPlan, physicalPackName, splitSummary, DEFAULT_WA_PACK_LIMIT } from '../src/whatsapp/split.js';

/**
 * WhatsApp physical pack splitting — the exact matrix from the spec:
 *   60 → [60]        61 → [60, 1]     100 → [60, 40]
 *   120 → [60, 60]   121 → [60, 60, 1] 150 → [60, 60, 30]
 * plus 10 / 30 / 50. No sticker is ever duplicated to fill a pack.
 */

test('plogme default limit is 60', () => {
  assert.equal(DEFAULT_WA_PACK_LIMIT, 60);
});

test('splitting matrix (default limit 60)', () => {
  const cases = [
    [10, [10]],
    [30, [30]],
    [50, [50]],
    [60, [60]],
    [61, [60, 1]],
    [100, [60, 40]],
    [120, [60, 60]],
    [121, [60, 60, 1]],
    [150, [60, 60, 30]]
  ];
  for (const [total, expected] of cases) {
    const packs = splitIntoPacks(total, 60);
    assert.deepEqual(packs.map((p) => p.count), expected, `${total} should split into ${JSON.stringify(expected)}`);
    // starts are contiguous and 0-based
    packs.forEach((p, i) => {
      assert.equal(p.start, i === 0 ? 0 : packs[i - 1].start + packs[i - 1].count);
      assert.equal(p.index, i);
    });
    // total preserved — nothing duplicated, nothing lost
    assert.equal(packs.reduce((n, p) => n + p.count, 0), total);
  }
});

test('custom limits are honored', () => {
  assert.deepEqual(splitIntoPacks(100, 30).map((p) => p.count), [30, 30, 30, 10]);
  assert.deepEqual(splitIntoPacks(7, 3).map((p) => p.count), [3, 3, 1]);
  assert.deepEqual(splitIntoPacks(5, 10).map((p) => p.count), [5]);
});

test('zero and invalid inputs', () => {
  assert.deepEqual(splitIntoPacks(0), []);
  assert.throws(() => splitIntoPacks(-1), /non-negative/);
  assert.throws(() => splitIntoPacks(10.5), /non-negative|integer/);
  assert.throws(() => splitIntoPacks(10, 0), /positive integer/);
  assert.throws(() => splitIntoPacks('abc'), /non-negative|integer/);
});

test('applySplitPlan slices items without duplication', () => {
  const items = Array.from({ length: 121 }, (_, i) => `s${i}`);
  const packs = splitIntoPacks(121, 60);
  const slices = applySplitPlan(items, packs);
  assert.deepEqual(slices.map((s) => s.length), [60, 60, 1]);
  assert.equal(slices[0][0], 's0');
  assert.equal(slices[1][0], 's60');
  assert.equal(slices[2][0], 's120');
  // every item appears exactly once
  assert.deepEqual(slices.flat(), items);
});

test('physical pack names', () => {
  assert.equal(physicalPackName('Gojo Pack', 0, 1), 'Gojo Pack');
  assert.equal(physicalPackName('Gojo Pack', 0, 2), 'Gojo Pack 01');
  assert.equal(physicalPackName('Gojo Pack', 1, 2), 'Gojo Pack 02');
});

test('split summary for captions: STICKERS • 100 / PACKS • 02', () => {
  const s = splitSummary(100, 60);
  assert.equal(s.stickers, 100);
  assert.equal(s.packs, 2);
  assert.deepEqual(s.packSizes, [60, 40]);
  const s2 = splitSummary(60, 60);
  assert.equal(s2.packs, 1);
});
