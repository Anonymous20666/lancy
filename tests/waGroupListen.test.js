import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { WASession } from '../src/whatsapp/session.js';
import { InboundHandler } from '../src/whatsapp/inbound.js';
import { WhatsAppManager } from '../src/whatsapp/manager.js';

function fakeSettings(overrides = {}) {
  const map = new Map(Object.entries(overrides));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v)
  };
}

test('WASession group listen helpers, JID normalization, and events', () => {
  const session = new WASession({
    sessionId: 'wa_test_1',
    name: 'Test',
    phone: '2348012345678',
    listenedGroups: ['120363024849204928@g.us']
  });

  assert.equal(session.isGroupListened('120363024849204928@g.us'), true);
  assert.equal(session.isGroupListened('120363024849204928'), true);
  assert.equal(session.isGroupListened('120363024849204928:2@s.whatsapp.net'), true);
  assert.equal(session.isGroupListened('999999999999999999@g.us'), false);

  let changeEmitted = null;
  session.on('listenedGroupsChange', (groups) => {
    changeEmitted = groups;
  });

  // Add a new group
  const added = session.addListenedGroup('120363099999999999');
  assert.equal(added, true);
  assert.equal(session.isGroupListened('120363099999999999@g.us'), true);
  assert.deepEqual(changeEmitted, ['120363024849204928@g.us', '120363099999999999@g.us']);

  // Adding duplicate returns false
  assert.equal(session.addListenedGroup('120363099999999999@g.us'), false);

  // Remove a group
  const removed = session.removeListenedGroup('120363024849204928');
  assert.equal(removed, true);
  assert.equal(session.isGroupListened('120363024849204928@g.us'), false);
  assert.deepEqual(changeEmitted, ['120363099999999999@g.us']);

  // Clear all
  const clearedCount = session.clearListenedGroups();
  assert.equal(clearedCount, 1);
  assert.deepEqual(session.getListenedGroups(), []);
  assert.deepEqual(changeEmitted, []);
});

test('WASession isOwnerSender verifies owner via fromMe and credentials', () => {
  const session = new WASession({
    sessionId: 'wa_test_owner',
    phone: '2348012345678'
  });
  session.jid = '2348012345678@s.whatsapp.net';
  session.lid = '9876543210@lid';

  // 1. fromMe is always owner
  assert.equal(session.isOwnerSender({ key: { fromMe: true, remoteJid: '12036@g.us' } }), true);

  // 2. Participant matching phone/jid
  assert.equal(
    session.isOwnerSender({
      key: { fromMe: false, participant: '2348012345678:0@s.whatsapp.net', remoteJid: '12036@g.us' }
    }),
    true
  );

  // 3. Participant matching LID
  assert.equal(
    session.isOwnerSender({
      key: { fromMe: false, participant: '9876543210@lid', remoteJid: '12036@g.us' }
    }),
    true
  );

  // 4. Non-owner participant
  assert.equal(
    session.isOwnerSender({
      key: { fromMe: false, participant: '2348099999999@s.whatsapp.net', remoteJid: '12036@g.us' }
    }),
    false
  );
});

test('InboundHandler: owner .listen inside group chat activates listening, non-owner is ignored', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = new WASession({
    sessionId: 'wa_sess_gc',
    name: 'Lancy Session',
    phone: '2348012345678'
  });
  session.jid = '2348012345678@s.whatsapp.net';
  session.sendText = async (jid, text) => { sends.push({ jid, text }); };
  session.sock = {
    groupMetadata: async (jid) => ({ id: jid, subject: 'Secret Testing Hub' }),
    sendPresenceUpdate: async () => {}
  };

  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  const groupJid = '120363012345678901@g.us';

  // 1. Non-owner attempts .listen in group chat -> silently ignored
  await handler.handle({
    session,
    message: {
      key: { remoteJid: groupJid, fromMe: false, participant: '2348099999999@s.whatsapp.net' },
      message: { conversation: '.listen' }
    },
    command: '.listen',
    text: '.listen'
  });
  assert.equal(sends.length, 0);
  assert.equal(session.isGroupListened(groupJid), false);

  // 2. Owner sends .listen in group chat -> activates group listening
  await handler.handle({
    session,
    message: {
      key: { remoteJid: groupJid, fromMe: true, participant: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.listen' }
    },
    command: '.listen',
    text: '.listen'
  });
  assert.equal(session.isGroupListened(groupJid), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].jid, groupJid);
  assert.ok(sends[0].text.includes('GROUP LISTENING ACTIVATED'));
  assert.ok(sends[0].text.includes('Secret Testing Hub'));

  // 3. Now in listened group, standard command (.ping) from any member works!
  await handler.handle({
    session,
    message: {
      key: { remoteJid: groupJid, fromMe: false, participant: '2348099999999@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });
  assert.equal(sends.length, 2);
  assert.equal(sends[1].jid, groupJid);
  assert.ok(sends[1].text.includes('Pong!'));

  // 4. Owner sends .listen off in group chat -> deactivates group
  await handler.handle({
    session,
    message: {
      key: { remoteJid: groupJid, fromMe: true, participant: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.listen off' }
    },
    command: '.listen',
    text: '.listen off'
  });
  assert.equal(session.isGroupListened(groupJid), false);
  assert.equal(sends.length, 3);
  assert.ok(sends[2].text.includes('GROUP LISTENING DEACTIVATED'));

  // 5. Subsequent .ping in unlistened group is ignored
  await handler.handle({
    session,
    message: {
      key: { remoteJid: groupJid, fromMe: false, participant: '2348099999999@s.whatsapp.net' },
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });
  assert.equal(sends.length, 3); // No new message sent!
  db.close();
});

test('InboundHandler: owner .listen management in DM (list, add link, add JID, remove, clear)', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = new WASession({
    sessionId: 'wa_sess_dm_listen',
    name: 'Lancy Session',
    phone: '2348012345678'
  });
  session.jid = '2348012345678@s.whatsapp.net';
  session.sendText = async (jid, text) => { sends.push({ jid, text }); };
  session.sock = {
    groupMetadata: async (jid) => ({ id: jid, subject: `Group for ${jid.slice(0, 8)}` }),
    groupGetInviteInfo: async (code) => {
      if (code === 'validCode123') {
        return { id: '120363088888888888@g.us', subject: 'VIP Club Alpha' };
      }
      throw new Error('invalid invite');
    },
    groupFetchAllParticipating: async () => ({
      '120363077777777777@g.us': { id: '120363077777777777@g.us', subject: 'Anime Lounge' }
    }),
    sendPresenceUpdate: async () => {}
  };

  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });
  const dmJid = '2348012345678@s.whatsapp.net';

  // 1. .listen status when empty
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen' }
    },
    command: '.listen',
    text: '.listen'
  });
  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.includes('SECRET GC LISTENING'));
  assert.ok(sends[0].text.includes('0 active groups'));

  // 2. Add group by direct JID
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen 120363011111111111@g.us' }
    },
    command: '.listen',
    text: '.listen 120363011111111111@g.us'
  });
  assert.equal(session.isGroupListened('120363011111111111@g.us'), true);
  assert.equal(sends.length, 2);
  assert.ok(sends[1].text.includes('GROUP ADDED'));

  // 3. Add group by invite link
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen https://chat.whatsapp.com/validCode123' }
    },
    command: '.listen',
    text: '.listen https://chat.whatsapp.com/validCode123'
  });
  assert.equal(session.isGroupListened('120363088888888888@g.us'), true);
  assert.equal(sends.length, 3);
  assert.ok(sends[2].text.includes('VIP Club Alpha'));

  // 4. Add group by subject search in participating groups
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen Anime Lounge' }
    },
    command: '.listen',
    text: '.listen Anime Lounge'
  });
  assert.equal(session.isGroupListened('120363077777777777@g.us'), true);
  assert.equal(sends.length, 4);
  assert.ok(sends[3].text.includes('Anime Lounge'));

  // 5. .listen list shows all 3 groups
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen list' }
    },
    command: '.listen',
    text: '.listen list'
  });
  assert.equal(sends.length, 5);
  assert.ok(sends[4].text.includes('LISTENED GROUP CHATS (3)'));

  // 6. Remove one group
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen remove 120363011111111111@g.us' }
    },
    command: '.listen',
    text: '.listen remove 120363011111111111@g.us'
  });
  assert.equal(session.isGroupListened('120363011111111111@g.us'), false);
  assert.equal(sends.length, 6);
  assert.ok(sends[5].text.includes('GROUP REMOVED'));

  // 7. Clear all groups
  await handler.handle({
    session,
    message: {
      key: { remoteJid: dmJid, fromMe: true },
      message: { conversation: '.listen clear' }
    },
    command: '.listen',
    text: '.listen clear'
  });
  assert.equal(session.getListenedGroups().length, 0);
  assert.equal(sends.length, 7);
  assert.ok(sends[6].text.includes('GROUP LISTENING CLEARED'));

  db.close();
});

test('.menu remains secret and strictly does NOT show .listen', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = new WASession({
    sessionId: 'wa_sess_menu_secret',
    name: 'Lancy',
    phone: '2348012345678'
  });
  session.sendText = async (jid, text) => { sends.push({ jid, text }); };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net', fromMe: true },
      message: { conversation: '.menu' }
    },
    command: '.menu',
    text: '.menu'
  });

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.includes('.ping'));
  assert.ok(sends[0].text.includes('.menu'));
  assert.ok(sends[0].text.includes('.prefix'));
  assert.ok(sends[0].text.includes('.convert'));
  assert.ok(sends[0].text.includes('.tg'));
  assert.ok(sends[0].text.includes('.s'));
  // Strictly SECRET!
  assert.equal(sends[0].text.includes('listen'), false, '.listen must NOT be visible in .menu!');
  db.close();
});

test('WhatsAppManager persists and hydrates listened_groups_json', async () => {
  const db = new Database(':memory:');
  const manager = new WhatsAppManager({
    db,
    credsRoot: '/tmp/test_creds_listen',
    settings: fakeSettings()
  });

  const session = await manager.createSession({
    userId: 1,
    name: 'Persist Test',
    phone: '2348012345678'
  });

  assert.deepEqual(session.getListenedGroups(), []);

  // Add group -> triggers listenedGroupsChange -> updates db
  session.addListenedGroup('120363012345678901@g.us');

  const row = db.get('SELECT listened_groups_json FROM wa_sessions WHERE session_id = ?', session.sessionId);
  assert.ok(row);
  const parsed = JSON.parse(row.listened_groups_json);
  assert.deepEqual(parsed, ['120363012345678901@g.us']);

  // Hydrate into new manager instance
  const manager2 = new WhatsAppManager({
    db,
    credsRoot: '/tmp/test_creds_listen',
    settings: fakeSettings()
  });
  await manager2.restore();

  const rehydrated = manager2.get(session.sessionId);
  assert.ok(rehydrated);
  assert.equal(rehydrated.isGroupListened('120363012345678901@g.us'), true);
  assert.deepEqual(rehydrated.getListenedGroups(), ['120363012345678901@g.us']);

  db.close();
});
