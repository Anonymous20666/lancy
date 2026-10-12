import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionEngine, validateTemplate, CAPTION_VARIABLES, buildAestheticStickerCaption } from '../src/captions/engine.js';
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
  assert.match(out, /GOJO/);
  assert.match(out, /𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒\s+•\s+100/);
  assert.match(out, /𝐏𝐀𝐂𝐊𝐒\s+•\s+02/);
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
  assert.match(out, /𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒\s+•\s+60/);
  assert.match(out, /𝐏𝐀𝐂𝐊𝐒\s+•\s+01/);
  assert.match(out, /THE OWL HOUSE STICKERS ARE OUT!/);
  assert.match(out, /𝗟𝗔𝗡𝗖𝗬/);
});

test('buildAestheticStickerCaption renders exact Tanjiro aesthetic card matching layout', () => {
  const caption = buildAestheticStickerCaption({
    title: 'Tanjiro Kamado',
    character: 'Tanjiro Kamado',
    count: 60,
    packsCount: 2
  });
  assert.ok(caption.includes('╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮'));
  assert.ok(caption.includes('💠 𝑻𝑨𝑵𝑱𝑰𝑹𝑶 𝑲𝑨𝑴𝑨𝑫𝑶'));
  assert.ok(caption.includes('│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  60'));
  assert.ok(caption.includes('│ 📦 𝐏𝐀𝐂𝐊𝐒       •  02'));
  assert.ok(caption.includes('✨ 𝐓𝐀𝐍𝐉𝐈𝐑𝐎 𝐊𝐀𝐌𝐀𝐃𝐎 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 𝐀𝐑𝐄 𝐎𝐔𝐓! ✨'));
  assert.ok(caption.includes('A fresh demon-slayer pack filled with funny'));
  assert.ok(caption.includes('💌 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 • 𝐔𝐒𝐄 • 𝐄𝐍𝐉𝐎𝐘'));
  assert.ok(caption.includes('❤️ 𝐒𝐇𝐀𝐑𝐄   •   💠 𝐑𝐄𝐀𝐂𝐓'));
  assert.ok(caption.includes('𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘'));
  assert.ok(caption.includes('╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝐊𝐄𝗥s⃟❥🌸⃟╬'));
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
