#!/usr/bin/env node
import { loadEnvFile, getEnv } from './config/env.js';
import { LancyApp } from './app.js';

/**
 * ✦ LANCY BOT ✦ — entrypoint.
 */
async function main() {
  loadEnvFile('.env');
  const env = getEnv();

  if (!env.BOT_TOKEN) {
    console.error('✦ Lancy Bot needs a BOT_TOKEN.');
    console.error('  1. copy .env.example to .env');
    console.error('  2. paste the token from @BotFather');
    console.error('  3. set OWNER_IDS to your Telegram user id');
    process.exit(1);
  }
  if (!env.OWNER_IDS) {
    console.error('✦ Lancy Bot needs OWNER_IDS (your Telegram user id) in .env');
    process.exit(1);
  }

  const app = new LancyApp({ env });
  await app.start();

  const shutdown = async (signal) => {
    console.log(`\n${signal} — bye ♡`);
    await app.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    app.log.error({ err: error }, 'unhandled rejection');
  });
}

main().catch((error) => {
  console.error('✦ Lancy Bot failed to start:', error);
  process.exit(1);
});
