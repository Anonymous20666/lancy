import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { WhatsAppPublisher } from '../src/whatsapp/publisher.js';
import { splitIntoPacks } from '../src/whatsapp/split.js';

/**
 * Publishing pipeline — plan building (the preview and the executor share
 * ONE plan builder, so they can never disagree), splitting, multi-channel
 * delivery, permission revalidation, retries and per-pack error handling.
 */

function fakeSettings(overrides = {}) {
  const db = new Database(':memory:');
  const sm = new SettingsManager(db, {});
  for (const [k, v] of Object.entries(overrides)) sm.set(k, v);
  return sm;
}

function makePack(id, count, title = `Pack ${id}`) {
  return { id, tgTitle: title, title, count, stickerCount: count, query: 'gojo', link: `https://t.me/addstickers/p${id}` };
}

/** Insert real pack rows so the publication FK is satisfied; returns packs with DB ids. */
function insertPacks(db, specs) {
  return specs.map((spec, i) => {
    const row = db.run(
      `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, source, sticker_type, link)
       VALUES (1, ?, ?, 'gojo', ?, 'pinterest', 'static', ?)`,
      `pack_${spec.id}_${i}_by_lancybot`, spec.title, spec.count, spec.link
    );
    return { ...spec, id: Number(row.lastInsertRowid) };
  });
}

function makeSession({ failOn = null } = {}) {
  const calls = { packs: [], texts: [] };
  return {
    sessionId: 'wa_test',
    isOnline: true,
    jid: '2348000000000@s.whatsapp.net',
    calls,
    sendStickerPack: async (jid, pack) => {
      if (failOn && pack.name.includes(failOn)) {
        const e = new Error('rate limited'); e.retryable = true; throw e;
      }
      calls.packs.push({ jid, name: pack.name, stickers: pack.stickers.length, description: pack.description });
    },
    sendText: async (jid, text) => { calls.texts.push({ jid, text }); }
  };
}

function makeChannels(permissions = {}) {
  const revalidated = [];
  return {
    revalidated,
    revalidate: async (session, jids) => {
      revalidated.push(...jids);
      return jids.map((jid) => ({ jid, name: `chan-${jid.slice(0, 6)}`, canPublish: permissions[jid] ?? 'yes' }));
    },
    cached: () => []
  };
}

function getStickerBytesFactory() {
  return async (packId, index) => Buffer.from(`sticker-${packId}-${index}`);
}

test('buildPlan splits logical packs at the physical limit', () => {
  const db = new Database(':memory:');
  const settings = fakeSettings();
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });

  const plan = publisher.buildPlan({
    packs: [makePack(1, 60), makePack(2, 61), makePack(3, 100), makePack(4, 150)],
    sessionId: 'wa_test',
    channelJids: ['a@newsletter', 'b@newsletter'],
    caption: 'hi'
  });

  assert.deepEqual(plan.packs[0].physicalPacks.map((p) => p.stickerCount), [60]);
  assert.deepEqual(plan.packs[1].physicalPacks.map((p) => p.stickerCount), [60, 1]);
  assert.deepEqual(plan.packs[2].physicalPacks.map((p) => p.stickerCount), [60, 40]);
  assert.deepEqual(plan.packs[3].physicalPacks.map((p) => p.stickerCount), [60, 60, 30]);
  assert.equal(plan.totals.logicalPacks, 4);
  assert.equal(plan.totals.physicalPacks, 1 + 2 + 2 + 3);
  assert.equal(plan.totals.stickers, 371);
  assert.equal(plan.totals.destinations, 2);
  // logical sticker count is preserved
  assert.equal(plan.packs[3].pack.stickerCount, 150);
  db.close();
});

test('buildPlan respects a configured split size', () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.physicalStickerPackLimit': 30 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });
  const plan = publisher.buildPlan({ packs: [makePack(1, 100)], sessionId: 's', channelJids: ['x'], caption: '' });
  assert.deepEqual(plan.packs[0].physicalPacks.map((p) => p.stickerCount), [30, 30, 30, 10]);
  db.close();
});

test('publish delivers each physical pack to each channel, then the caption', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 1 });
  const channels = makeChannels();
  const publisher = new WhatsAppPublisher({ db, settings, channels });
  const session = makeSession();

  const [dbPack] = insertPacks(db, [makePack(1, 61)]);
  const plan = publisher.buildPlan({
    packs: [dbPack],
    sessionId: 'wa_test',
    channelJids: ['aaa@newsletter', 'bbb@newsletter'],
    caption: 'my caption'
  });

  const progress = [];
  const results = await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    getStickerBytes: getStickerBytesFactory(),
    onProgress: (p) => progress.push(p.stage)
  });

  // 61 stickers → packs [60, 1] → 2 packs × 2 channels = 4 pack sends
  assert.equal(session.calls.packs.length, 4);
  assert.deepEqual(session.calls.packs.map((c) => c.stickers).sort((a, b) => a - b), [1, 1, 60, 60]);
  // caption sent once per channel
  assert.equal(session.calls.texts.length, 2);
  assert.ok(session.calls.texts.every((t) => t.text === 'my caption'));
  // pack names carry the split index
  assert.ok(session.calls.packs.some((c) => c.name === 'Pack 1 01'));
  assert.ok(session.calls.packs.some((c) => c.name === 'Pack 1 02'));
  // results
  assert.equal(results.status, 'done');
  assert.equal(results.totals.succeeded, 4);
  assert.equal(results.totals.failed, 0);
  // permissions were revalidated before publishing
  assert.deepEqual(channels.revalidated.sort(), ['aaa@newsletter', 'bbb@newsletter']);
  // DB records
  const pub = db.get('SELECT * FROM wa_publications WHERE id = ?', results.publicationId);
  assert.equal(pub.status, 'done');
  assert.equal(pub.stickers_total, 61);
  assert.equal(pub.packs_total, 2);
  const physical = db.all('SELECT * FROM wa_physical_packs WHERE publication_id = ? ORDER BY pack_index', results.publicationId);
  assert.deepEqual(physical.map((p) => p.sticker_count), [60, 1]);
  assert.ok(physical.every((p) => p.status === 'sent'));
  const targets = db.all('SELECT * FROM wa_publication_targets WHERE publication_id = ?', results.publicationId);
  assert.equal(targets.length, 2);
  assert.ok(targets.every((t) => t.status === 'sent'));
  db.close();
});

test('channels without permission are skipped, not retried', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 3 });
  const channels = makeChannels({ 'nope@newsletter': 'no' });
  const publisher = new WhatsAppPublisher({ db, settings, channels });
  const session = makeSession();

  const [dbPack] = insertPacks(db, [makePack(1, 10)]);
  const plan = publisher.buildPlan({
    packs: [dbPack],
    sessionId: 'wa_test',
    channelJids: ['ok@newsletter', 'nope@newsletter'],
    caption: ''
  });
  const results = await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    getStickerBytes: getStickerBytesFactory()
  });
  assert.equal(session.calls.packs.length, 1, 'only the permitted channel got the pack');
  assert.equal(session.calls.packs[0].jid, 'ok@newsletter');
  assert.equal(results.totals.succeeded, 1);
  assert.equal(results.totals.skipped, 1);
  const skipped = results.targets.find((t) => t.jid === 'nope@newsletter');
  assert.equal(skipped.status, 'skipped');
  db.close();
});

test('send failures are counted per channel and reported cleanly', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 2 });
  const channels = makeChannels();
  const publisher = new WhatsAppPublisher({ db, settings, channels });
  const session = makeSession({ failOn: 'Pack 1 02' }); // second physical pack always fails

  const [dbPack] = insertPacks(db, [makePack(1, 61)]);
  const plan = publisher.buildPlan({
    packs: [dbPack],
    sessionId: 'wa_test',
    channelJids: ['aaa@newsletter'],
    caption: ''
  });
  const results = await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    getStickerBytes: getStickerBytesFactory()
  });
  assert.equal(results.status, 'partial');
  assert.equal(results.totals.succeeded, 1); // pack 01
  assert.equal(results.totals.failed, 1);    // pack 02
  const failed = results.packs[0].physicalPacks.find((p) => p.index === 1);
  assert.equal(failed.status, 'failed');
  assert.match(failed.rawError, /rate limited/); // raw error kept for logs
  assert.doesNotMatch(failed.error, /at Object|at async/); // friendly, no stack trace
  db.close();
});

test('offline session is refused before anything is sent', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings();
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });
  const session = makeSession();
  session.isOnline = false;
  const plan = publisher.buildPlan({ packs: [makePack(1, 10)], sessionId: 'wa_test', channelJids: ['a'], caption: '' });
  await assert.rejects(
    publisher.publish({ plan: { ...plan, userId: 1 }, session, getStickerBytes: getStickerBytesFactory() }),
    /not connected/i
  );
  assert.equal(session.calls.packs.length, 0);
  db.close();
});

test('each selected pack is posted separately — never merged', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 1 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });
  const session = makeSession();
  const dbPacks = insertPacks(db, [makePack(1, 10, 'Gojo Rage'), makePack(2, 20, 'Gojo Cute'), makePack(3, 30, 'Gojo Soft')]);
  const plan = publisher.buildPlan({
    packs: dbPacks,
    sessionId: 'wa_test',
    channelJids: ['a@newsletter'],
    caption: ''
  });
  await publisher.publish({ plan: { ...plan, userId: 1 }, session, getStickerBytes: getStickerBytesFactory() });
  const names = session.calls.packs.map((c) => c.name).sort();
  assert.deepEqual(names, ['Gojo Cute', 'Gojo Rage', 'Gojo Soft'], 'three separate packs, one per logical pack');
  db.close();
});

test('split plan never duplicates a sticker', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 1 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });
  const session = makeSession();
  const [dbPack] = insertPacks(db, [makePack(1, 121)]);
  const plan = publisher.buildPlan({
    packs: [dbPack],
    sessionId: 'wa_test',
    channelJids: ['a@newsletter'],
    caption: ''
  });
  let requested = 0;
  const seen = new Set();
  await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    getStickerBytes: async (packId, index) => {
      requested++;
      assert.ok(!seen.has(index), `sticker ${index} requested twice`);
      seen.add(index);
      return Buffer.from(`s${index}`);
    }
  });
  assert.equal(requested, 121, 'every sticker requested exactly once');
  db.close();
});

test('WhatsAppPublisher.publish uses telegramApi .tg method directly to download and publish packs', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 1 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });
  const session = makeSession();
  const [dbPack] = insertPacks(db, [makePack(1, 2, 'Toji Fushiguro')]);
  dbPack.tg_short_name = 'toji_pack_test_by_lancybot';

  // Transparent 1x1 WebP
  const sampleWebp = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  let getStickerSetCalled = false;
  let getFileCalled = 0;
  let downloadFileCalled = 0;

  const fakeTelegramApi = {
    getStickerSet: async (name) => {
      getStickerSetCalled = true;
      return {
        title: 'Toji Fushiguro',
        name,
        stickers: [
          { file_id: 'fid_001', emoji: '⚔️', is_animated: false, is_video: false },
          { file_id: 'fid_002', emoji: '🔥', is_animated: false, is_video: false }
        ]
      };
    },
    getFile: async (fileId) => {
      getFileCalled++;
      return { file_id: fileId, file_path: `stickers/${fileId}.webp` };
    },
    downloadFile: async (filePath) => {
      downloadFileCalled++;
      return sampleWebp;
    }
  };

  const plan = publisher.buildPlan({
    packs: [dbPack],
    sessionId: 'wa_test',
    channelJids: ['120363431396805997@newsletter'],
    caption: ''
  });

  await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    telegramApi: fakeTelegramApi
  });

  assert.ok(getStickerSetCalled, 'getStickerSet was called for pack');
  assert.equal(getFileCalled, 2, 'getFile was called for all stickers');
  assert.equal(downloadFileCalled, 2, 'downloadFile was called for all stickers');
  assert.equal(session.calls.packs.length, 1, 'sticker pack was published');
  assert.equal(session.calls.packs[0].stickers, 2, 'both stickers were published in the pack');
  assert.equal(session.calls.packs[0].jid, '120363431396805997@newsletter');
  db.close();
});

test('multi-pack publication drops separate preview, caption, and samples for each non-continuation pack', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.publishingDelayMs': 0, 'whatsapp.retryCount': 1 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: makeChannels() });

  const calls = { packs: [], texts: [], images: [], stickers: [] };
  const session = {
    sessionId: 'wa_test_multi',
    isOnline: true,
    jid: '2348000000000@s.whatsapp.net',
    calls,
    sendStickerPack: async (jid, pack) => { calls.packs.push({ jid, name: pack.name, stickers: pack.stickers.length }); },
    sendText: async (jid, text) => { calls.texts.push({ jid, text }); },
    sendImage: async (jid, buffer, caption) => { calls.images.push({ jid, caption }); },
    sendSticker: async (jid, buffer) => { calls.stickers.push({ jid }); }
  };

  const sampleWebp = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  const fakeApi = {
    getStickerSet: async (name) => {
      if (name.includes('sukuna')) {
        return {
          title: 'Sukuna Pack',
          name,
          stickers: [{ file_id: 'sukuna_1', emoji: '🔥', is_animated: false, is_video: false }]
        };
      }
      return {
        title: 'Ichigo Pack',
        name,
        stickers: [{ file_id: 'ichigo_1', emoji: '⚔️', is_animated: false, is_video: false }]
      };
    },
    getFile: async (id) => ({ file_path: `stickers/${id}.webp` }),
    downloadFile: async () => sampleWebp
  };

  const dbPacks = insertPacks(db, [
    { id: 1, title: 'Sukuna Pack', count: 1, tg_short_name: 'sukuna_by_lancy' },
    { id: 2, title: 'Ichigo Pack', count: 1, tg_short_name: 'ichigo_by_lancy' }
  ]);

  const plan = publisher.buildPlan({
    packs: dbPacks,
    sessionId: 'wa_test_multi',
    channelJids: ['chan1@newsletter'],
    caption: null // null triggers per-pack distinct caption generation
  });

  await publisher.publish({
    plan: { ...plan, userId: 1 },
    session,
    telegramApi: fakeApi
  });

  // Both distinct packs received their own announcement image + caption
  assert.equal(session.calls.images.length, 2, 'two distinct preview images with captions sent');
  assert.match(session.calls.images[0].caption, /Sukuna/i, 'first caption matches Sukuna pack');
  assert.match(session.calls.images[1].caption, /Ichigo/i, 'second caption matches Ichigo pack');

  // Both distinct packs had their physical packs published
  assert.equal(session.calls.packs.length, 2, 'both packs published');
  assert.equal(session.calls.packs[0].name, 'Sukuna Pack');
  assert.equal(session.calls.packs[1].name, 'Ichigo Pack');

  db.close();
});
