import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { ChannelService, detectPublishPermission, normalizeSubscribedResponse, normalizeMetadataResponse } from '../src/whatsapp/channels.js';

const ME = '2348012345678@s.whatsapp.net';

test('detectPublishPermission: explicit viewer role', () => {
  assert.equal(detectPublishPermission({ viewer_metadata: { role: 'admin' } }, ME), 'yes');
  assert.equal(detectPublishPermission({ viewer_metadata: { role: 'owner' } }, ME), 'yes');
  assert.equal(detectPublishPermission({ viewer_metadata: { role: 'subscriber' } }, ME), 'no');
});

test('detectPublishPermission: participants list', () => {
  const meta = {
    thread_metadata: {
      participants: [
        { id: '111@s.whatsapp.net', is_admin: true },
        { id: '2348012345678@s.whatsapp.net', is_super_admin: true },
        { id: '333@s.whatsapp.net', is_admin: false }
      ]
    }
  };
  assert.equal(detectPublishPermission(meta, ME), 'yes');
  const meta2 = { thread_metadata: { participants: [{ id: ME, is_admin: false, role: 'subscriber' }] } };
  assert.equal(detectPublishPermission(meta2, ME), 'no');
});

test('detectPublishPermission: capability flags', () => {
  assert.equal(detectPublishPermission({ viewer_metadata: { can_send: true } }, ME), 'yes');
  assert.equal(detectPublishPermission({ viewer_metadata: { can_post: false } }, ME), 'no');
});

test('detectPublishPermission: unknown stays unknown (verified at send time)', () => {
  assert.equal(detectPublishPermission({}, ME), 'unknown');
  assert.equal(detectPublishPermission(null, ME), 'unknown');
  assert.equal(detectPublishPermission({ thread_metadata: { settings: { who_can_post: 'admins' } } }, ME), 'unknown');
});

test('normalizeSubscribedResponse handles common shapes', () => {
  assert.deepEqual(normalizeSubscribedResponse(null), []);
  const a = normalizeSubscribedResponse({ newsletters: [{ jid: '1@newsletter', name: { text: 'Chan' } }] });
  assert.equal(a[0].jid, '1@newsletter');
  assert.equal(a[0].name, 'Chan');
  const b = normalizeSubscribedResponse({ result: { threads: [{ id: '2@newsletter' }] } });
  assert.equal(b[0].jid, '2@newsletter');
  const c = normalizeSubscribedResponse(['3@newsletter']);
  assert.equal(c[0].jid, '3@newsletter');
});

test('normalizeMetadataResponse', () => {
  const meta = normalizeMetadataResponse({
    result: { id: '9@newsletter', thread_metadata: { name: { text: 'News' }, description: { text: 'desc' }, subscribers_count: '42' } }
  });
  assert.equal(meta.name, 'News');
  assert.equal(meta.subscribers, '42');
});

test('ChannelService caches and revalidates permissions', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, {});
  const service = new ChannelService({ db, settings });
  const session = {
    sessionId: 'wa_1',
    jid: ME,
    listSubscribedNewsletters: async () => ({ newsletters: [{ jid: '1@newsletter', name: { text: 'Chan A' } }] }),
    getNewsletterMetadata: async () => ({ result: { id: '1@newsletter', thread_metadata: { name: { text: 'Chan A' } }, viewer_metadata: { role: 'admin' } } })
  };
  const channels = await service.discover(session);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].canPublish, 'yes');

  const revalidated = await service.revalidate(session, ['1@newsletter']);
  assert.equal(revalidated[0].canPublish, 'yes');

  const cached = service.cached('wa_1');
  assert.equal(cached.length, 1);
  assert.ok(cached[0].can_publish_checked_at);
  db.close();
});
