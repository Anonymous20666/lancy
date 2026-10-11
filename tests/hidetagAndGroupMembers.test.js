import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { TelegramController } from '../src/telegram/bot.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';

test('Database group_members: record, retrieve, and remove members', () => {
  const db = new Database(':memory:');
  const chatId = -100123456789;

  // Record member 1
  db.recordGroupMember(chatId, { id: 1001, username: 'alice', first_name: 'Alice' });
  // Record member 2
  db.recordGroupMember(chatId, { id: 1002, username: 'bob', first_name: 'Bob' });
  // Ignore bots
  db.recordGroupMember(chatId, { id: 9999, username: 'some_bot', first_name: 'Bot', is_bot: true });

  let members = db.getGroupMembers(chatId);
  assert.equal(members.length, 2);
  assert.equal(members.some((m) => m.user_id === 1001), true);
  assert.equal(members.some((m) => m.user_id === 1002), true);
  assert.equal(members.some((m) => m.user_id === 9999), false);

  // Updating user details
  db.recordGroupMember(chatId, { id: 1001, username: 'alice_updated', first_name: 'Alice Wonder' });
  members = db.getGroupMembers(chatId);
  assert.equal(members.length, 2);
  const updatedAlice = members.find((m) => m.user_id === 1001);
  assert.equal(updatedAlice.username, 'alice_updated');
  assert.equal(updatedAlice.first_name, 'Alice Wonder');

  // Remove member 2
  db.removeGroupMember(chatId, 1002);
  members = db.getGroupMembers(chatId);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, 1001);

  assert.equal(db.getGroupMemberCount(chatId), 1);
  db.close();
});

test('TelegramController /hidetag: rejects private chats', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 1 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 10,
    chat: { id: 12345, type: 'private' },
    from: { id: 12345, first_name: 'Solo' },
    text: '/hidetag Hello'
  };

  await controller.handleHideTag(msg, ['Hello']);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /only available in group chats/i);
  db.close();
});

test('TelegramController /hidetag: blocks non-administrators', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async (chatId, userId) => {
      return { status: 'member', user: { id: userId } };
    },
    getChatAdministrators: async () => [],
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 1 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 10,
    chat: { id: -100999, type: 'supergroup' },
    from: { id: 7777, first_name: 'Regular Member' },
    text: '/hidetag Testing'
  };

  await controller.handleHideTag(msg, ['Testing']);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Only group administrators can use/i);
  db.close();
});

test('TelegramController /hidetag: administrator sends EXACTLY ONE message tagging all users invisibly', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const deletedMessages = [];
  const chatId = -100999;

  // Pre-populate some members in the group
  db.recordGroupMember(chatId, { id: 2001, username: 'member1', first_name: 'Member One' });
  db.recordGroupMember(chatId, { id: 2002, username: 'member2', first_name: 'Member Two' });

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async (chatId, userId) => {
      return { status: 'administrator', user: { id: userId } };
    },
    getChatAdministrators: async () => [
      { status: 'creator', user: { id: 3001, is_bot: false, username: 'owner_user', first_name: 'Owner' } },
      { status: 'administrator', user: { id: 99999, is_bot: true, username: 'Lancy_easy_bot' } } // bot itself excluded
    ],
    deleteMessage: async (cid, mid) => {
      deletedMessages.push({ cid, mid });
      return true;
    },
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 100 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 55,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Admin Joe' }, // Caller admin
    text: '/hidetag Important announcement for everyone!'
  };

  await controller.handleHideTag(msg, ['Important', 'announcement', 'for', 'everyone!']);

  // Exactly ONE message sent
  assert.equal(sentMessages.length, 1);
  const sent = sentMessages[0];
  assert.equal(sent.cid, chatId);

  // Announcement text is present
  assert.match(sent.text, /Important announcement for everyone!/);

  // Invisible mentions contain zero-width spaces for member 2001, 2002, 3001, and caller 1001
  assert.match(sent.text, /<a href="tg:\/\/user\?id=2001">\u3164<\/a>/);
  assert.match(sent.text, /<a href="tg:\/\/user\?id=2002">\u3164<\/a>/);
  assert.match(sent.text, /<a href="tg:\/\/user\?id=3001">\u3164<\/a>/);
  assert.match(sent.text, /<a href="tg:\/\/user\?id=1001">\u3164<\/a>/);

  // Bot itself is not tagged
  assert.doesNotMatch(sent.text, /<a href="tg:\/\/user\?id=8859351350">/);

  // Trigger command message was deleted
  assert.equal(deletedMessages.length, 1);
  assert.equal(deletedMessages[0].mid, 55);

  db.close();
});

test('TelegramController /hidetag: replying to another message carries reply_to_message_id', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const chatId = -100555;

  db.recordGroupMember(chatId, { id: 4001, username: 'chatter', first_name: 'Chatter' });

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'administrator' }),
    getChatAdministrators: async () => [],
    deleteMessage: async () => true,
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 200 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 88,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Admin Joe' },
    text: '/hidetag',
    reply_to_message: {
      message_id: 77,
      from: { id: 4001, first_name: 'Chatter' },
      text: 'Original important post'
    }
  };

  await controller.handleHideTag(msg, []);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].opts.reply_to_message_id, 77);
  assert.match(sentMessages[0].text, /Attention everyone!/);
  assert.match(sentMessages[0].text, /<a href="tg:\/\/user\?id=4001">\u3164<\/a>/);

  db.close();
});

test('TelegramController /tagall -v: visible flag attaches readable mentions', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const chatId = -100777;

  db.recordGroupMember(chatId, { id: 5001, username: 'user_alpha', first_name: 'Alpha' });
  db.recordGroupMember(chatId, { id: 5002, username: null, first_name: 'Beta' });

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'creator' }),
    getChatAdministrators: async () => [],
    deleteMessage: async () => true,
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 300 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 99,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Creator' },
    text: '/tagall -v Roll call'
  };

  await controller.handleHideTag(msg, ['-v', 'Roll', 'call']);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Roll call/);
  assert.match(sentMessages[0].text, /@user_alpha/);
  assert.match(sentMessages[0].text, /<a href="tg:\/\/user\?id=5002">Beta<\/a>/);

  db.close();
});

test('TelegramController handleUpdate: passively tracks group members and supports !hidetag prefix', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const chatId = -100888;

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'administrator' }),
    getChatAdministrators: async () => [],
    deleteMessage: async () => true,
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 400 };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });
  controller.botUsername = 'Lancy_easy_bot';

  // 1. Group message arrives from user 7001
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: 7001, username: 'chatter1', first_name: 'Chatter 1' },
      text: 'Good morning guys'
    }
  });

  // 2. New member joins via new_chat_members
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: 7001, username: 'chatter1', first_name: 'Chatter 1' },
      new_chat_members: [
        { id: 7002, username: 'newbie', first_name: 'Newbie', is_bot: false },
        { id: 8888, username: 'some_bot', first_name: 'Bot', is_bot: true }
      ]
    }
  });

  let members = db.getGroupMembers(chatId);
  assert.equal(members.length, 2);
  assert.equal(members.some((m) => m.user_id === 7001), true);
  assert.equal(members.some((m) => m.user_id === 7002), true);
  assert.equal(members.some((m) => m.user_id === 8888), false);

  // 3. User 7002 leaves via left_chat_member
  await controller.handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: 7001, username: 'chatter1', first_name: 'Chatter 1' },
      left_chat_member: { id: 7002 }
    }
  });

  members = db.getGroupMembers(chatId);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, 7001);

  // 4. Admin executes !hidetag command with exclamation prefix
  await controller.handleUpdate({
    update_id: 4,
    message: {
      message_id: 13,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: 9001, first_name: 'Admin Boss' },
      text: '!hidetag Wake up everyone!'
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Wake up everyone!/);
  // User 7001 should be invisibly tagged
  assert.match(sentMessages[0].text, /<a href="tg:\/\/user\?id=7001">\u3164<\/a>/);

  db.close();
});

test('TelegramController /hidetag pin: pins announcement with notification so all 2k members are alerted', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const pinnedMessages = [];
  const chatId = -100444;

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'creator' }),
    getChatAdministrators: async () => [],
    deleteMessage: async () => true,
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 505 };
    },
    pinChatMessage: async (cid, mid, opts) => {
      pinnedMessages.push({ cid, mid, opts });
      return true;
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 22,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Creator' },
    text: '/hidetag pin Big news today!'
  };

  await controller.handleHideTag(msg, ['pin', 'Big', 'news', 'today!']);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Big news today!/);

  // Pinned with loud notification for all members
  assert.equal(pinnedMessages.length, 1);
  assert.equal(pinnedMessages[0].mid, 505);
  assert.equal(pinnedMessages[0].opts.disableNotification, false);

  db.close();
});

test('TelegramController /hidetag: large groups (>80 members) use ghost batches that auto-delete', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sentMessages = [];
  const deletedMessages = [];
  const chatId = -100666;

  // Add 120 members to database
  for (let i = 1; i <= 120; i++) {
    db.recordGroupMember(chatId, { id: 8000 + i, username: `user_${i}`, first_name: `Member ${i}` });
  }

  const mockApi = {
    me: { id: 8859351350, username: 'Lancy_easy_bot' },
    getChatMember: async () => ({ status: 'administrator' }),
    getChatAdministrators: async () => [],
    deleteMessage: async (cid, mid) => {
      deletedMessages.push({ cid, mid });
      return true;
    },
    sendMessage: async (cid, text, opts) => {
      const msgId = 600 + sentMessages.length;
      sentMessages.push({ cid, text, opts, message_id: msgId });
      return { message_id: msgId };
    }
  };

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: new StateMachine(db)
  });

  const msg = {
    message_id: 33,
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1001, first_name: 'Admin' },
    text: '/hidetag Big rally!'
  };

  await controller.handleHideTag(msg, ['Big', 'rally!']);

  // Main message is sent immediately
  assert.ok(sentMessages.length >= 1);
  assert.match(sentMessages[0].text, /Big rally!/);

  // Trigger command message (id 33) is deleted
  assert.ok(deletedMessages.some((d) => d.mid === 33));

  db.close();
});
