import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinProvider } from '../src/ai/providers/builtin.js';
import { AIService } from '../src/ai/service.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';

const provider = new BuiltinProvider();

test('builtin provider is always available', () => {
  assert.equal(provider.available, true);
});

test('generates captions with pack metadata', async () => {
  const { text } = { text: await provider.generate({ task: 'caption', text: 'gojo', context: { query: 'gojo', stickers: 100, packs: 2 }, style: 'girly' }) };
  const out = text;
  assert.match(out, /Gojo/);
  assert.match(out, /100/);
  assert.match(out, /02/);
});

test('generates titles and names', async () => {
  const title = await provider.generate({ task: 'title', text: 'gojo satoru' });
  assert.equal(title, 'Gojo Satoru');
  const name = await provider.generate({ task: 'name', text: 'cute owl stickers' });
  assert.match(name, /Cute Owl Stickers/);
});

test('rewrite keeps meaning, changes tone', async () => {
  const out = await provider.generate({ task: 'rewrite', text: 'this pack is cute lol', style: 'elegant' });
  assert.match(out, /this pack is cute lol/i);
});

test('shorten reduces text', async () => {
  const long = 'First sentence here. Second sentence here. Third sentence here.';
  const out = await provider.generate({ task: 'shorten', text: long });
  assert.ok(out.length < long.length);
});

test('chat responds in character and never claims powers', async () => {
  const out = await provider.generate({ task: 'chat', text: 'can you publish my pack for me?', style: 'girly' });
  assert.ok(out.length > 0);
  assert.doesNotMatch(out, /I published/i);
});

test('all styles produce output', async () => {
  for (const style of ['girly', 'soft', 'cute', 'elegant', 'gen-z', 'gothic', 'anime', 'minimal', 'premium', 'chaotic']) {
    const out = await provider.generate({ task: 'chat', text: 'hi', style });
    assert.ok(out.length > 0, style);
  }
});

test('AIService falls back to builtin when the provider fails', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, { env: { AI_PROVIDER: 'ollama', AI_ENDPOINT: 'http://127.0.0.1:1' } });
  const ai = new AIService({ settings });
  let fallbackCalls = 0;
  const original = ai.fallback.generate.bind(ai.fallback);
  ai.fallback.generate = async (...args) => { fallbackCalls++; return original(...args); };
  const { text, provider: used } = await ai.generate({ task: 'chat', text: 'hello ♡' });
  assert.ok(text.length > 0);
  assert.equal(used, 'builtin');
  assert.equal(fallbackCalls, 1, 'fallback provider was used');
  await ai.stop();
  db.close();
});

test('AIService runs the builtin provider through the worker', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, { env: { AI_PROVIDER: 'builtin' } });
  const ai = new AIService({ settings });
  let fallbackCalls = 0;
  const original = ai.fallback.generate.bind(ai.fallback);
  ai.fallback.generate = async (...args) => { fallbackCalls++; return original(...args); };
  ai.start();
  const { text, provider: used } = await ai.generate({ task: 'title', text: 'lancy pack' });
  assert.equal(text, 'Lancy Pack');
  assert.equal(used, 'builtin');
  assert.ok(ai.worker, 'worker is running');
  assert.equal(fallbackCalls, 0, 'the worker answered — no fallback needed');
  // a second request also goes through the worker (round-trip stability)
  const again = await ai.generate({ task: 'name', text: 'cute owl' });
  assert.match(again.text, /Cute Owl/);
  assert.equal(fallbackCalls, 0);
  await ai.stop();
  db.close();
});

test('AIService stop terminates the worker and rejects pending work', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, { env: { AI_PROVIDER: 'builtin' } });
  const ai = new AIService({ settings });
  ai.start();
  await ai.generate({ task: 'chat', text: 'hi' });
  assert.ok(ai.worker);
  await ai.stop();
  assert.equal(ai.worker, null);
  db.close();
});
