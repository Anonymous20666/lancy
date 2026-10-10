import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionEngine, validateTemplate, CAPTION_VARIABLES } from '../src/captions/engine.js';
import { BUILTIN_TEMPLATES, TemplateStore } from '../src/captions/templates.js';
import { Database } from '../src/core/db.js';

function makeEngine(settingsOverrides = {}) {
  const fakeSettings = {
    get: (path) => ({
      'general.timezone': 'UTC',
      'general.defaultCreatorName': 'Lancy',
      'captions.defaultTitle': '{{query}} Collection',
      ...settingsOverrides
    })[path]
  };
  return new CaptionEngine({ settings: fakeSettings, templates: new TemplateStore(null) });
}

test('renders all core variables', () => {
  const engine = makeEngine();
  const out = engine.render('{{title}} | {{query}} | {{stickers}} | {{packs}} | {{creator}} | {{pack_name}} | {{source}} | {{session_name}}', {
    title: 'Gojo Pack',
    query: 'gojo',
    stickers: 100,
    packs: 2,
    creator: 'Lancy',
    packName: 'Gojo • Lancy',
    source: 'Pinterest',
    sessionName: 'Lancy Main'
  });
  assert.equal(out, 'Gojo Pack | gojo | 100 | 02 | Lancy | Gojo • Lancy | Pinterest | Lancy Main');
});

test('packs is zero-padded', () => {
  const engine = makeEngine();
  assert.equal(engine.render('{{packs}}', { packs: 2 }), '02');
  assert.equal(engine.render('{{packs}}', { packs: 12 }), '12');
});

test('unknown variables render empty, never {{undefined}}', () => {
  const engine = makeEngine();
  const out = engine.render('a{{nope}}b', {});
  assert.equal(out, 'ab');
});

test('title template resolves nested variables', () => {
  const engine = makeEngine();
  const out = engine.render('{{title}}', { query: 'gojo' });
  assert.equal(out, 'gojo Collection');
});

test('per-pack counts: {{pack_01_count}}', () => {
  const engine = makeEngine();
  const out = engine.render('{{pack_01_count}} + {{pack_02_count}}', { packSizes: [60, 40] });
  assert.equal(out, '60 + 40');
});

test('telegram_link and date variables', () => {
  const engine = makeEngine();
  const out = engine.render('{{telegram_link}} on {{date}}', {
    telegramLink: 'https://t.me/addstickers/x',
    date: '08 Oct 2026'
  });
  assert.equal(out, 'https://t.me/addstickers/x on 08 Oct 2026');
});

test('default template renders a full caption', () => {
  const engine = makeEngine();
  const out = engine.renderDefault({
    query: 'gojo', title: 'Gojo Pack', stickers: 100, packs: 2,
    packName: 'Gojo Pack', telegramLink: 'https://t.me/addstickers/gojo_by_lancybot'
  });
  assert.match(out, /Gojo Pack/);
  assert.match(out, /𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • 100/);
  assert.match(out, /𝐏𝐀𝐂𝐊𝐒 • 02/);
});

test('aesthetic template renders ornate gothic box caption', () => {
  const engine = makeEngine({ 'captions.defaultTemplate': 'aesthetic' });
  const out = engine.renderDefault({
    title: 'THE OWL HOUSE',
    headline: 'THE OWL HOUSE STICKERS ARE OUT!',
    stickers: 60,
    packs: 1
  });
  assert.match(out, /THE OWL HOUSE/);
  assert.match(out, /𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • 60/);
  assert.match(out, /𝐏𝐀𝐂𝐊𝐒 • 01/);
  assert.match(out, /THE OWL HOUSE STICKERS ARE OUT!/);
  assert.match(out, /𝗟𝗔𝗡𝗖𝗬/);
});

test('every builtin template is valid', () => {
  for (const [name, template] of Object.entries(BUILTIN_TEMPLATES)) {
    const v = validateTemplate(template);
    assert.ok(v.valid, `${name}: ${v.problems.join(', ')}`);
  }
});

test('validateTemplate catches unbalanced braces and unknown vars', () => {
  assert.equal(validateTemplate('hello {{oops').valid, false);
  const v = validateTemplate('{{bogus_var}}');
  assert.equal(v.valid, false);
  assert.ok(v.problems[0].includes('bogus_var'));
});

test('caption variables list is complete', () => {
  for (const v of ['title', 'query', 'stickers', 'packs', 'creator', 'date', 'pack_name', 'source', 'telegram_link', 'session_name']) {
    assert.ok(CAPTION_VARIABLES.includes(v), v);
  }
});

test('template store persists custom templates', () => {
  const db = new Database(':memory:');
  const store = new TemplateStore(db, { userId: 1 });
  store.save('mine', 'hello {{query}}', { isDefault: true });
  assert.equal(store.get('mine'), 'hello {{query}}');
  assert.equal(store.get('default'), BUILTIN_TEMPLATES.default);
  const list = store.list();
  assert.ok(list.some((t) => t.name === 'mine' && !t.builtin));
  db.close();
});
