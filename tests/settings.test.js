import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { DEFAULT_SETTINGS, RESTART_REQUIRED_PATHS, flattenSettings, mergeSettings, applySettingPatch } from '../src/config/defaults.js';

function setup(env = {}) {
  const db = new Database(':memory:');
  const sm = new SettingsManager(db, { env });
  return { db, sm };
}

test('defaults cover every category from the spec', () => {
  const categories = ['general', 'telegram', 'whatsapp', 'pinterest', 'stickers', 'captions', 'ai', 'media', 'performance', 'storage', 'security', 'logging', 'advanced'];
  for (const c of categories) {
    assert.ok(DEFAULT_SETTINGS[c], `missing category ${c}`);
    assert.ok(Object.keys(DEFAULT_SETTINGS[c]).length >= 3, `${c} should have real settings`);
  }
});

test('WhatsApp physical pack limit defaults to 60 (plogme-enforced)', () => {
  const { sm } = setup();
  assert.equal(sm.get('whatsapp.physicalStickerPackLimit'), 60);
  assert.equal(sm.get('stickers.whatsappPhysicalPackSize'), 60);
});

test('get/set with dotted paths', () => {
  const { sm } = setup();
  assert.equal(sm.get('pinterest.searchDepth'), 'deep');
  const result = sm.set('pinterest.searchDepth', 'very_deep');
  assert.equal(result.hotReloaded, true);
  assert.equal(sm.get('pinterest.searchDepth'), 'very_deep');
});

test('unknown setting paths are rejected', () => {
  const { sm } = setup();
  assert.throws(() => sm.set('nonsense.path', 1), /Unknown setting/);
});

test('restart-required paths are flagged honestly, not applied live', () => {
  const { sm } = setup();
  const before = sm.get('storage.database');
  const result = sm.set('storage.database', 'data/other.db');
  assert.equal(result.restartRequired, true);
  assert.equal(result.hotReloaded, false);
  assert.equal(result.applied, false);
  assert.equal(sm.needsRestart(), true);
  // The value IS persisted (for after restart) but flagged.
  sm.clearRestartFlags();
  assert.equal(sm.needsRestart(), false);
});

test('safe settings emit change events', () => {
  const { sm } = setup();
  const events = [];
  sm.on('change', (e) => events.push(e));
  sm.set('captions.defaultTitle', 'New Title');
  assert.equal(events.length, 1);
  assert.equal(events[0].path, 'captions.defaultTitle');
  assert.equal(events[0].value, 'New Title');
});

test('settings persist across instances (restart)', () => {
  const path = `/tmp/lancy-settings-${Date.now()}.db`;
  {
    const db = new Database(path);
    const sm = new SettingsManager(db, {});
    sm.set('stickers.defaultStickerAmount', 80);
    db.close();
  }
  {
    const db = new Database(path);
    const sm = new SettingsManager(db, {});
    assert.equal(sm.get('stickers.defaultStickerAmount'), 80);
    db.close();
  }
});

test('env overrides win for secrets and identity', () => {
  const { sm } = setup({ BOT_TOKEN: 'secret-token', OWNER_IDS: '111,222', AI_PROVIDER: 'ollama' });
  assert.equal(sm.get('telegram.botToken'), 'secret-token');
  assert.deepEqual(sm.get('general.ownerIds'), [111, 222]);
  assert.equal(sm.get('ai.provider'), 'ollama');
});

test('mergeSettings deep-merges and preserves defaults', () => {
  const merged = mergeSettings({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 } });
  assert.deepEqual(merged, { a: { b: 9, c: 2 }, d: 3 });
});

test('flatten and patch round-trip', () => {
  const flat = flattenSettings(DEFAULT_SETTINGS);
  assert.ok('whatsapp.physicalStickerPackLimit' in flat);
  const patched = applySettingPatch(DEFAULT_SETTINGS, 'whatsapp.physicalStickerPackLimit', 30);
  assert.equal(patched.whatsapp.physicalStickerPackLimit, 30);
  assert.equal(DEFAULT_SETTINGS.whatsapp.physicalStickerPackLimit, 60, 'defaults are not mutated');
});

test('restart-required set is complete and honest', () => {
  for (const p of ['telegram.botToken', 'storage.database', 'security.ownerIds', 'general.ownerIds', 'ai.provider']) {
    assert.ok(RESTART_REQUIRED_PATHS.has(p), p);
  }
  // Safe paths must NOT be in the set.
  assert.ok(!RESTART_REQUIRED_PATHS.has('captions.defaultTitle'));
  assert.ok(!RESTART_REQUIRED_PATHS.has('pinterest.searchDepth'));
});
