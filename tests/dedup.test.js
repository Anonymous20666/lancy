import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { DedupService } from '../src/media/dedup.js';
import { sha256Hex } from '../src/utils/hash.js';

function setup() {
  const db = new Database(':memory:');
  return { db, dedup: new DedupService(db) };
}

test('detects duplicates by sha256', () => {
  const { db, dedup } = setup();
  const buf = Buffer.from('image-bytes-1');
  const sha = sha256Hex(buf);
  const verdict = dedup.check(1, { sha256: sha, mediaUrl: 'http://x/1.jpg' });
  assert.equal(verdict.duplicate, false);
  dedup.markDelivered(1, { sha256: sha, mediaUrl: 'http://x/1.jpg' });
  const again = dedup.check(1, { sha256: sha, mediaUrl: 'http://different-url/2.jpg' });
  assert.equal(again.duplicate, true);
  assert.equal(again.reason, 'sha256');
  db.close();
});

test('detects duplicates by pin id and by URL', () => {
  const { db, dedup } = setup();
  dedup.markDelivered(1, { pinId: 'pin-1', mediaUrl: 'http://x/a.jpg' });
  assert.equal(dedup.check(1, { pinId: 'pin-1', mediaUrl: 'http://x/other.jpg' }).reason, 'pin_id');
  assert.equal(dedup.check(1, { mediaUrl: 'http://x/a.jpg' }).reason, 'media_url');
  assert.equal(dedup.check(1, { sourceUrl: 'http://x/a.jpg' }).reason, 'source_url');
  db.close();
});

test('detects perceptual duplicates (same image, different bytes)', () => {
  const { db, dedup } = setup();
  // Same phash, different sha → still a duplicate.
  dedup.markDelivered(1, { sha256: sha256Hex(Buffer.from('a')), phash: 'aaaaaaaaaaaaaaaa', mediaUrl: 'http://x/1.jpg' });
  const verdict = dedup.check(1, { sha256: sha256Hex(Buffer.from('b')), phash: 'aaaaaaaaaaaaaaab', mediaUrl: 'http://x/2.jpg' });
  assert.equal(verdict.duplicate, true);
  assert.equal(verdict.reason, 'perceptual_hash');
  db.close();
});

test('different images are not duplicates', () => {
  const { db, dedup } = setup();
  dedup.markDelivered(1, { sha256: sha256Hex(Buffer.from('a')), phash: 'aaaaaaaaaaaaaaaa' });
  const verdict = dedup.check(1, { sha256: sha256Hex(Buffer.from('b')), phash: '5555555555555555' });
  assert.equal(verdict.duplicate, false);
  db.close();
});

test('history is per-user', () => {
  const { db, dedup } = setup();
  const sha = sha256Hex(Buffer.from('shared'));
  dedup.markDelivered(1, { sha256: sha, mediaUrl: 'http://x/1.jpg' });
  assert.equal(dedup.check(1, { sha256: sha }).duplicate, true);
  assert.equal(dedup.check(2, { sha256: sha }).duplicate, false, 'user 2 has their own history');
  db.close();
});

test('survives restart (persistence)', () => {
  const path = `/tmp/lancy-dedup-test-${Date.now()}.db`;
  const sha = sha256Hex(Buffer.from('persistent'));
  {
    const db = new Database(path);
    const dedup = new DedupService(db);
    dedup.markDelivered(7, { sha256: sha, phash: 'aaaaaaaaaaaaaaaa', pinId: 'pin-9', mediaUrl: 'http://x/p.jpg' });
    db.close();
  }
  {
    const db = new Database(path);
    const dedup = new DedupService(db); // fresh instance = "restart"
    const verdict = dedup.check(7, { sha256: sha });
    assert.equal(verdict.duplicate, true, 'duplicate history survives restart');
    const byPin = dedup.check(7, { pinId: 'pin-9' });
    assert.equal(byPin.duplicate, true);
    db.close();
  }
});

test('global registry tracks cross-user content', () => {
  const { db, dedup } = setup();
  const sha = sha256Hex(Buffer.from('global'));
  assert.equal(dedup.hasSeenGlobally(sha), false);
  dedup.registerGlobal({ sha256: sha, mime: 'image/jpeg', size: 123 });
  assert.equal(dedup.hasSeenGlobally(sha), true);
  const stats = dedup.stats(1);
  assert.equal(stats.globalUnique, 1);
  db.close();
});
