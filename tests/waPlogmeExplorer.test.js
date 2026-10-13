import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { WASession } from '../src/whatsapp/session.js';
import { InboundHandler } from '../src/whatsapp/inbound.js';
import { registry } from '../src/whatsapp/explorer/registry.js';
import { lab } from '../src/whatsapp/explorer/lab.js';
import { PlogmeRenderer } from '../src/whatsapp/explorer/renderer.js';

function fakeSettings(overrides = {}) {
  const map = new Map(Object.entries(overrides));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v)
  };
}

test('PlogmeRegistry loads audited manifest, categories, features and exports', () => {
  const summary = registry.getAuditSummary();
  assert.equal(summary.package, 'plogme');
  assert.equal(summary.version, '2.0.7');
  assert.equal(summary.totalExports, 396);
  assert.equal(summary.totalSocketMethods, 669);
  assert.equal(summary.categoriesCount, 10);
  assert.ok(summary.featuresCount >= 20);

  // Category lookup
  const richCat = registry.getCategory('rich');
  assert.ok(richCat);
  assert.equal(richCat.prefix, 'PLOG-RCH');

  // Feature lookup
  const rchFeature = registry.getFeature('PLOG-RCH-001');
  assert.ok(rchFeature);
  assert.equal(rchFeature.name, 'Native Flow Multiple Copy Buttons (cta_copy)');
  assert.ok(rchFeature.workingCode.includes('nativeFlow'));
  assert.ok(Array.isArray(rchFeature.copyActions));
  assert.ok(rchFeature.copyActions.length >= 3);

  // Search
  const pollResults = registry.search('poll');
  assert.ok(pollResults.length >= 2);
  assert.ok(pollResults.some((f) => f.id === 'PLOG-POL-001'));
});

test('PlogmeRenderer renders master menu with multiple genuine native copy buttons in one message', () => {
  const master = PlogmeRenderer.renderMasterMenu({ p: '.' });
  assert.ok(master.text.includes('PLOGME BAILEYS EXPLORER'));
  assert.ok(master.text.includes('plogme@2.0.7'));
  assert.ok(master.text.includes('Categories Index'));
  assert.ok(master.text.includes('.tmenu rich'));
  assert.ok(master.footer.includes('Plogme 2.0.7'));

  // MUST contain multiple native copy buttons within that SAME message
  assert.ok(Array.isArray(master.nativeFlow));
  assert.equal(master.nativeFlow.length, 4);
  assert.equal(master.nativeFlow[0].text, '📋 Copy Ref ID');
  assert.equal(master.nativeFlow[0].copy, 'PLOG-RCH-001');
  assert.equal(master.nativeFlow[1].text, '📋 Copy Signature');
  assert.ok(master.nativeFlow[2].copy.includes('sock.sendMessage'));
  assert.ok(master.nativeFlow[3].copy.includes('Implement WhatsApp native copy buttons'));
});

test('PlogmeRenderer renders category, feature, search, and audit views', () => {
  // Category view
  const catView = PlogmeRenderer.renderCategoryView('polls', { p: '.' });
  assert.ok(catView.text.includes('POLLS & INTERACTIVE VOTING'));
  assert.ok(catView.text.includes('PLOG-POL-001'));
  assert.ok(catView.nativeFlow.length >= 1);

  // Feature view
  const feat = registry.getFeature('PLOG-POL-001');
  const featView = PlogmeRenderer.renderFeatureView(feat, { p: '.' });
  assert.ok(featView.text.includes('PLOG-POL-001'));
  assert.ok(featView.text.includes('Method Signature'));
  assert.ok(featView.text.includes('Minimal Working Code'));
  assert.ok(featView.nativeFlow.some((b) => b.copy === 'PLOG-POL-001'));

  // Search view
  const searchResults = registry.search('album');
  const searchView = PlogmeRenderer.renderSearchView('album', searchResults, { p: '.' });
  assert.ok(searchView.text.includes('SEARCH: "album"'));
  assert.ok(searchView.text.includes('PLOG-MED-003'));

  // Audit view
  const auditView = PlogmeRenderer.renderAuditView({ p: '.' });
  assert.ok(auditView.text.includes('PLOGME 2.0.7 AUDIT REPORT'));
  assert.ok(auditView.text.includes('396'));
  assert.ok(auditView.text.includes('669'));
});

test('PlogmeTestLab executes local verification tests without errors or leaks', async () => {
  // Test native copy buttons
  const res1 = await lab.runTest('PLOG-RCH-001');
  assert.equal(res1.status, 'PASS');
  assert.ok(res1.details.includes('cta_copy'));

  // Test polls
  const res2 = await lab.runTest('PLOG-POL-001');
  assert.equal(res2.status, 'PASS');

  // Test poll vote aggregation
  const res3 = await lab.runTest('PLOG-POL-002');
  assert.equal(res3.status, 'PASS');
  assert.ok(res3.details.includes('getAggregateVotesInPollMessage'));

  // Test event listener cleanup (no memory leak)
  const res4 = await lab.runTest('PLOG-EVT-001');
  assert.equal(res4.status, 'PASS');
  assert.ok(res4.details.includes('cleanup'));

  // Test JID helpers
  const res5 = await lab.runTest('PLOG-UTL-001');
  assert.equal(res5.status, 'PASS');
  assert.ok(res5.details.includes('isJidGroup'));
});

test('WASession.sendInteractiveMessage delivers nativeFlow and supports fallback', async () => {
  const payloadsSent = [];
  const session = new WASession({
    sessionId: 'wa_sess_inter',
    name: 'InterSession',
    phone: '2348012345678'
  });
  session.status = 'online';
  session.sock = {
    sendMessage: async (jid, payload) => {
      payloadsSent.push({ jid, payload });
      return { key: { id: 'msg_123' } };
    }
  };

  const payload = {
    text: 'Test Explorer Menu',
    footer: 'Explorer Footer',
    nativeFlow: [{ text: '📋 Copy ID', copy: 'PLOG-RCH-001' }]
  };

  await session.sendInteractiveMessage('2348012345678@s.whatsapp.net', payload);

  assert.equal(payloadsSent.length, 1);
  assert.equal(payloadsSent[0].payload.text, 'Test Explorer Menu');
  assert.deepEqual(payloadsSent[0].payload.nativeFlow, [{ text: '📋 Copy ID', copy: 'PLOG-RCH-001' }]);

  // Test fallback if sock.sendMessage fails
  session.sock.sendMessage = async (jid, p) => {
    if (p.nativeFlow) throw new Error('Interactive message unsupported');
    payloadsSent.push({ jid, payload: p });
    return { key: { id: 'fallback_123' } };
  };

  await session.sendInteractiveMessage('2348012345678@s.whatsapp.net', payload);
  assert.equal(payloadsSent.length, 2);
  assert.ok(payloadsSent[1].payload.text.includes('📋 *Copy Actions:*'));
  assert.ok(payloadsSent[1].payload.text.includes('PLOG-RCH-001'));
});

test('InboundHandler .tmenu: owner-only security, single-message master menu, categories, and test lab', async () => {
  const db = new Database(':memory:');
  const interactiveSends = [];
  const textSends = [];

  const session = new WASession({
    sessionId: 'wa_sess_tmenu',
    name: 'Explorer Session',
    phone: '2348012345678'
  });
  session.status = 'online';
  session.jid = '2348012345678@s.whatsapp.net';
  session.sendInteractiveMessage = async (jid, p) => {
    interactiveSends.push({ jid, ...p });
    return { key: { id: 'interactive_' + Date.now() } };
  };
  session.sendText = async (jid, text) => {
    textSends.push({ jid, text });
    return { key: { id: 'text_' + Date.now() } };
  };

  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });
  const ownerJid = '2348012345678@s.whatsapp.net';
  const nonOwnerJid = '2348099999999@s.whatsapp.net';

  // 1. Non-owner is completely blocked and silently dropped
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: false, participant: nonOwnerJid },
      message: { conversation: '.tmenu' }
    },
    command: '.tmenu',
    text: '.tmenu'
  });
  assert.equal(interactiveSends.length, 0);
  assert.equal(textSends.length, 0);

  // 2. Owner .tmenu -> displays single message master menu with native copy buttons
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu' }
    },
    command: '.tmenu',
    text: '.tmenu'
  });
  assert.equal(interactiveSends.length, 1);
  assert.ok(interactiveSends[0].text.includes('PLOGME BAILEYS EXPLORER'));
  assert.ok(interactiveSends[0].nativeFlow.length >= 3);

  // 3. Owner .tmenu rich -> category view
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu rich' }
    },
    command: '.tmenu',
    text: '.tmenu rich'
  });
  assert.equal(interactiveSends.length, 2);
  assert.ok(interactiveSends[1].text.includes('RICH MESSAGES & NATIVE FLOW'));

  // 4. Owner .tmenu PLOG-RCH-001 -> feature spec
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu PLOG-RCH-001' }
    },
    command: '.tmenu',
    text: '.tmenu PLOG-RCH-001'
  });
  assert.equal(interactiveSends.length, 3);
  assert.ok(interactiveSends[2].text.includes('PLOG-RCH-001'));
  assert.ok(interactiveSends[2].text.includes('Method Signature'));

  // 5. Owner .tmenu search poll -> search view
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu search poll' }
    },
    command: '.tmenu',
    text: '.tmenu search poll'
  });
  assert.equal(interactiveSends.length, 4);
  assert.ok(interactiveSends[3].text.includes('SEARCH: "poll"'));

  // 6. Owner .tmenu test PLOG-RCH-001 -> executes test lab
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu test PLOG-RCH-001' }
    },
    command: '.tmenu',
    text: '.tmenu test PLOG-RCH-001'
  });
  assert.equal(interactiveSends.length, 5);
  assert.ok(interactiveSends[4].text.includes('TEST LAB: [PLOG-RCH-001] ✅'));

  // 7. Owner .tmenu audit -> full audit report
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.tmenu audit' }
    },
    command: '.tmenu',
    text: '.tmenu audit'
  });
  assert.equal(interactiveSends.length, 6);
  assert.ok(interactiveSends[5].text.includes('PLOGME 2.0.7 AUDIT REPORT'));

  // 8. Public .menu remains 100% secret (no mention of .tmenu)
  await handler.handle({
    session,
    message: {
      key: { remoteJid: ownerJid, fromMe: true },
      message: { conversation: '.menu' }
    },
    command: '.menu',
    text: '.menu'
  });
  assert.equal(textSends.length, 1);
  assert.equal(textSends[0].text.includes('.tmenu'), false, '.tmenu must NOT be visible in .menu');

  db.close();
});
