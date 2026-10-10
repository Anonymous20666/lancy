import { TelegramAPI } from './api.js';
import { TelegramController } from './bot.js';
import { StateMachine } from '../core/stateMachine.js';
import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';

import { createDashboardScreen } from './screens/dashboard.js';
import { createPinterestScreen } from './screens/pinterest.js';
import { createStickersScreen } from './screens/stickers.js';
import { createWhatsAppScreen } from './screens/whatsapp.js';
import { createAIScreen } from './screens/ai.js';
import { createSettingsScreen } from './screens/settings.js';
import { createHelpScreen } from './screens/help.js';
import { createDownloaderScreen } from './screens/downloader.js';
import { createCloneScreen } from './screens/clone.js';

const SCREEN_FACTORIES = [
  createDashboardScreen,
  createPinterestScreen,
  createStickersScreen,
  createWhatsAppScreen,
  createAIScreen,
  createSettingsScreen,
  createHelpScreen,
  createDownloaderScreen,
  createCloneScreen
];

/**
 * MultiBotManager — Manages concurrent cloned bots ("Bring Your Own Bot Token").
 * Runs each cloned bot with its own TelegramAPI and TelegramController instance,
 * sharing the application's core media downloaders, scraper, and database.
 */
export class MultiBotManager {
  constructor({ app, db, settings }) {
    this.app = app;
    this.db = db;
    this.settings = settings;
    this.log = logger().child({ module: 'multi-bot-manager' });
    this.runningBots = new Map(); // botId -> { controller, api, botRecord }
  }

  /**
   * Rehydrate and start all active cloned bots from the database on boot.
   */
  async startAll() {
    try {
      const bots = this.db.all("SELECT * FROM cloned_bots WHERE status = 'active'");
      this.log.info({ count: bots.length }, 'starting active cloned bots');
      for (const botRecord of bots) {
        await this.startBot(botRecord).catch((err) => {
          this.log.error({ err: err.message, botId: botRecord.id, botUsername: botRecord.bot_username }, 'failed to start cloned bot');
          try {
            this.db.run("UPDATE cloned_bots SET status = 'error', error_message = ? WHERE id = ?", err.message, botRecord.id);
          } catch {}
        });
      }
    } catch (err) {
      this.log.error({ err }, 'failed to query cloned_bots');
    }
  }

  /**
   * Validate a bot token via getMe.
   * @param {string} token - Telegram Bot Token
   * @returns {Promise<{ ok: boolean, botInfo?: object, error?: string }>}
   */
  async validateToken(token) {
    if (!token || typeof token !== 'string') {
      return { ok: false, error: 'Token is empty or invalid.' };
    }
    const cleanToken = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(cleanToken)) {
      return { ok: false, error: 'Invalid token format. It must look like 123456789:ABCdefGHI...' };
    }

    try {
      const api = new TelegramAPI(cleanToken);
      const me = await api.getMe();
      if (!me?.username) {
        return { ok: false, error: 'Could not connect to Telegram with this token.' };
      }
      return { ok: true, botInfo: me };
    } catch (err) {
      return { ok: false, error: err.description || err.message || 'Telegram Bot API rejected this token.' };
    }
  }

  /**
   * Register a new cloned bot and immediately boot it.
   */
  async registerAndStartBot({ ownerTgId, token, botName, config = {} }) {
    const cleanToken = token.trim();
    const valResult = await this.validateToken(cleanToken);
    if (!valResult.ok) {
      throw new Error(valResult.error);
    }

    const { botInfo } = valResult;
    const cleanBotName = String(botName || botInfo.first_name || 'Lancy').trim().slice(0, 40);

    // Save or update in database
    this.db.run(
      `INSERT INTO cloned_bots (owner_tg_id, token, bot_name, bot_username, status, config_json, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))
       ON CONFLICT(token) DO UPDATE SET
         owner_tg_id = excluded.owner_tg_id,
         bot_name = excluded.bot_name,
         bot_username = excluded.bot_username,
         status = 'active',
         config_json = excluded.config_json,
         error_message = NULL,
         updated_at = datetime('now')`,
      Number(ownerTgId),
      cleanToken,
      cleanBotName,
      botInfo.username,
      JSON.stringify(config)
    );

    const botRecord = this.db.get('SELECT * FROM cloned_bots WHERE token = ?', cleanToken);
    await this.startBot(botRecord);
    return botRecord;
  }

  /**
   * Boot an individual bot record.
   */
  async startBot(botRecord) {
    if (this.runningBots.has(botRecord.id)) {
      await this.stopBot(botRecord.id);
    }

    const api = new TelegramAPI(botRecord.token, { log: this.log.child({ botId: botRecord.id }) });
    const me = await api.getMe();

    // Isolated State Machine for this cloned bot
    const sm = new StateMachine();

    const botContext = {
      botId: botRecord.id,
      botName: botRecord.bot_name || me.first_name || 'Lancy',
      botUsername: me.username,
      ownerId: Number(botRecord.owner_tg_id),
      isClone: true
    };

    // Create a clone-scoped application proxy so all screens reference this clone's API and controller
    let controller = null;
    const cloneApp = Object.create(this.app);
    cloneApp.telegram = {
      api,
      controller: null,
      markMediaDeliveryMessage: (id) => controller?.markMediaDeliveryMessage?.(id),
      isMediaDeliveryMessage: (msg) => controller?.isMediaDeliveryMessage?.(msg),
      isMediaDeliveryMessageId: (id) => controller?.isMediaDeliveryMessageId?.(id)
    };

    const cloneScreens = new Map();
    for (const factory of SCREEN_FACTORIES) {
      const screen = factory({ app: cloneApp });
      cloneScreens.set(screen.id, screen);
      screen.registerStateHandlers?.(sm);
    }

    controller = new TelegramController({
      api,
      db: this.db,
      settings: this.settings,
      stateMachine: sm,
      app: cloneApp,
      screens: cloneScreens,
      botContext,
      log: this.log.child({ clone: `@${me.username}` })
    });
    cloneApp.telegram.controller = controller;

    await controller.start();
    this.runningBots.set(botRecord.id, { controller, api, botRecord });
    this.log.info({ botId: botRecord.id, username: `@${me.username}` }, 'cloned bot is live');
    return controller;
  }

  /**
   * Stop a running cloned bot.
   */
  async stopBot(botId) {
    const running = this.runningBots.get(botId);
    if (!running) return;
    try {
      await running.controller.stop();
    } catch {}
    this.runningBots.delete(botId);
  }

  /**
   * Pause a cloned bot.
   */
  async pauseBot(botId) {
    await this.stopBot(botId);
    this.db.run("UPDATE cloned_bots SET status = 'paused', updated_at = datetime('now') WHERE id = ?", botId);
  }

  /**
   * Resume a paused cloned bot.
   */
  async resumeBot(botId) {
    const botRecord = this.db.get('SELECT * FROM cloned_bots WHERE id = ?', botId);
    if (!botRecord) throw new Error('Cloned bot not found.');
    this.db.run("UPDATE cloned_bots SET status = 'active', error_message = NULL, updated_at = datetime('now') WHERE id = ?", botId);
    botRecord.status = 'active';
    await this.startBot(botRecord);
  }

  /**
   * Delete and stop a cloned bot.
   */
  async deleteBot(botId, ownerTgId) {
    await this.stopBot(botId);
    this.db.run('DELETE FROM cloned_bots WHERE id = ? AND owner_tg_id = ?', botId, Number(ownerTgId));
    return true;
  }

  /**
   * Get all cloned bots belonging to a user.
   */
  getBotsForOwner(ownerTgId) {
    return this.db.all('SELECT * FROM cloned_bots WHERE owner_tg_id = ? ORDER BY id DESC', Number(ownerTgId));
  }

  getBotById(botId) {
    return this.db.get('SELECT * FROM cloned_bots WHERE id = ?', botId);
  }

  getBotByUsername(username) {
    const clean = String(username || '').replace(/^@/, '').trim().toLowerCase();
    return this.db.get('SELECT * FROM cloned_bots WHERE LOWER(bot_username) = ?', clean);
  }

  getRunningBot(botId) {
    return this.runningBots.get(botId) ?? null;
  }

  /**
   * Broadcast a message to all users of a specific cloned bot.
   * Can be targeted to all languages or a specific language.
   */
  async broadcast(botId, senderTgId, text, targetLanguage = null) {
    const running = this.runningBots.get(botId);
    const botRecord = this.db.get('SELECT * FROM cloned_bots WHERE id = ?', botId);
    if (!botRecord) throw new Error('Bot not found.');
    if (Number(botRecord.owner_tg_id) !== Number(senderTgId)) {
      throw new Error('Only the owner can broadcast to this bot.');
    }

    const api = running?.api || new TelegramAPI(botRecord.token);
    let users = [];
    if (targetLanguage) {
      users = this.db.all(
        'SELECT tg_id FROM bot_users WHERE bot_id = ? AND language = ? AND is_banned = 0',
        botId,
        targetLanguage
      );
    } else {
      users = this.db.all(
        'SELECT tg_id FROM bot_users WHERE bot_id = ? AND is_banned = 0',
        botId
      );
    }

    let sentCount = 0;
    let failedCount = 0;

    for (const u of users) {
      try {
        await api.sendMessage(u.tg_id, text, { parse_mode: 'HTML' });
        sentCount++;
        await sleep(35); // stay under Telegram 30 msgs/sec broadcast rate limit
      } catch {
        failedCount++;
      }
    }

    this.db.run(
      `INSERT INTO bot_broadcasts (bot_id, sender_tg_id, message_text, target_language, sent_count, failed_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      botId, Number(senderTgId), text, targetLanguage, sentCount, failedCount
    );

    return { sentCount, failedCount, total: users.length };
  }

  /**
   * Hot-reloads command suggestions across the primary bot and all active cloned bots.
   * @returns {Promise<Array<{ botId?: number, bot?: string, username?: string, success: boolean, error?: string }>>}
   */
  async hotReloadAllCommands() {
    const results = [];
    // 1. Primary bot controller if available
    if (this.app?.telegram?.controller?.registerCommands) {
      try {
        await this.app.telegram.controller.registerCommands();
        results.push({ bot: 'primary', success: true });
      } catch (err) {
        results.push({ bot: 'primary', success: false, error: err.message });
      }
    }

    // 2. All running cloned bots
    for (const [botId, { controller, botRecord }] of this.runningBots.entries()) {
      try {
        if (controller?.registerCommands) {
          await controller.registerCommands();
          results.push({ botId, username: botRecord?.bot_username, success: true });
        }
      } catch (err) {
        results.push({ botId, username: botRecord?.bot_username, success: false, error: err.message });
      }
    }

    this.log.info({ results }, 'hot-reloaded command suggestions across bots');
    return results;
  }

  /**
   * Shutdown all cloned bots cleanly.
   */
  async stopAll() {
    for (const botId of Array.from(this.runningBots.keys())) {
      await this.stopBot(botId);
    }
  }
}
