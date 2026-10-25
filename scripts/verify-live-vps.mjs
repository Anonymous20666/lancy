import { LancyApp } from '../src/app.js';

const CHAT_ID = -1003949983275; // ♡🌸⃟𝗦𝗘𝗢𝗨𝗟𝗖𝗜𝗧𝗬⃟🌸♡

const app = new LancyApp({ env: process.env });
app.setupTelegram();
let exitCode = 0;
try {
  await app.music.accounts.sync();
  const records = app.music.accounts.records();
  console.log('1. Synced Account Records:', JSON.stringify(records.map(r => ({ alias: r.alias, enabled: r.enabled, allowed: r.allowed }))));

  const api = app.telegram.api;
  const me = await api.call('getMe', {});
  api.me = me;
  const chat = await api.getChat(CHAT_ID);
  const admins = await api.call('getChatAdministrators', { chat_id: CHAT_ID });
  const caller = admins.find(a => !a.user?.is_bot && ['creator', 'administrator'].includes(a.status)) || admins[0];
  console.log('2. Target Group Chat:', JSON.stringify({ id: chat.id, title: chat.title, callerId: caller.user.id }));

  const ctx = {
    tgId: caller.user.id,
    chatId: CHAT_ID,
    user: caller.user,
    api
  };

  const prep = await app.music.prepare(ctx, CHAT_ID);
  console.log('3. Live CallSetup.prepare(-1003949983275) Result:', JSON.stringify(prep));

  const livePool = await app.voiceClient.accounts(CHAT_ID);
  console.log('4. Live Voice Bridge Accounts for -1003949983275:', JSON.stringify(livePool));
} catch (err) {
  console.error('LIVE VERIFY ERROR:', err);
  exitCode = 1;
} finally {
  clearInterval(app.musicQueueManager?.poller);
  app.musicQueueManager?.eventAbort?.abort();
  await app.voiceClient?.stopDaemon?.().catch(() => {});
  app.db?.close?.();
  process.exit(exitCode);
}
