import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createLogger, logger } from './core/logger.js';
import { Database } from './core/db.js';
import { SettingsManager } from './config/settings.js';
import { StateMachine, States } from './core/stateMachine.js';
import { QueueManager } from './core/queue.js';
import { createBus } from './core/bus.js';
import { dataDir, ensureDir } from './utils/paths.js';
import { TelegramAPI } from './telegram/api.js';
import { TelegramController } from './telegram/bot.js';
import { MediaPipeline } from './media/pipeline.js';
import { DeepSearchPipeline } from './pinterest/search.js';
import { PinterestWebProvider } from './pinterest/web.js';
import { FixtureProvider, makeFixturePins } from './pinterest/fixtures.js';
import { ProviderRegistry } from './pinterest/provider.js';
import { TelegramStickerService } from './stickers/telegram.js';
import { StickerPackService } from './stickers/packService.js';
import { WhatsAppManager } from './whatsapp/manager.js';
import { ChannelService } from './whatsapp/channels.js';
import { WhatsAppPublisher } from './whatsapp/publisher.js';
import { InboundHandler } from './whatsapp/inbound.js';
import { CaptionEngine } from './captions/engine.js';
import { TemplateStore } from './captions/templates.js';
import { AIService } from './ai/service.js';
import { LancyAssistant } from './ai/assistant.js';
import { AutonomousScheduler } from './ai/scheduler.js';

import { MediaDownloader } from './media/downloader.js';
import { createDashboardScreen } from './telegram/screens/dashboard.js';
import { createPinterestScreen } from './telegram/screens/pinterest.js';
import { createStickersScreen } from './telegram/screens/stickers.js';
import { createWhatsAppScreen } from './telegram/screens/whatsapp.js';
import { createAIScreen } from './telegram/screens/ai.js';
import { createSettingsScreen } from './telegram/screens/settings.js';
import { createHelpScreen } from './telegram/screens/help.js';
import { createDownloaderScreen } from './telegram/screens/downloader.js';

/**
 * LancyApp — the composition root. Every service is constructed here and
 * injected where it belongs; nothing reaches across modules directly.
 */
export class LancyApp {
  constructor({ env = {}, dataDir: dataDirName, log } = {}) {
    this.env = env;
    this.version = '1.0.0';
    this.root = dataDir(dataDirName);
    this.log = log ?? createLogger({ level: env.LOG_LEVEL ?? 'info', logDir: join(this.root, 'logs') });

    // ── Core ──
    this.db = new Database(join(this.root, 'lancy.db'));
    this.settings = new SettingsManager(this.db, { env });
    this.bus = createBus();
    this.queues = new QueueManager({
      pinterest: { concurrency: this.settings.get('performance.pinterestConcurrency') ?? 2 },
      stickers: { concurrency: this.settings.get('performance.queueConcurrency') ?? 2 },
      whatsapp: { concurrency: this.settings.get('performance.whatsappSessionConcurrency') ?? 3 },
      ai: { concurrency: this.settings.get('performance.aiConcurrency') ?? 1 },
      media: { concurrency: this.settings.get('performance.workerConcurrency') ?? 4 }
    });

    // ── State machine (persisted per user) ──
    this.sm = new StateMachine({
      loadPersisted: (tgId) => {
        const row = this.db.get('SELECT * FROM user_states WHERE tg_id = ?', Number(tgId));
        if (!row) return null;
        return {
          state: row.state,
          context: this.db.readJsonColumn(row, 'context_json'),
          screenMessageId: row.screen_message_id,
          chatId: row.chat_id
        };
      },
      persist: (tgId, record) => {
        this.db.run(
          `INSERT INTO user_states (tg_id, state, context_json, screen_message_id, chat_id, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(tg_id) DO UPDATE SET
             state = excluded.state,
             context_json = excluded.context_json,
             screen_message_id = excluded.screen_message_id,
             chat_id = excluded.chat_id,
             updated_at = datetime('now')`,
          Number(tgId), record.state, JSON.stringify(record.context ?? {}),
          record.screenMessageId, record.chatId
        );
      }
    });

    // ── Media ──
    this.media = new MediaPipeline({
      db: this.db,
      cacheDir: join(this.root, 'cache', 'media'),
      settings: this.settings
    });

    // ── Pinterest ──
    this.pinterestProviders = new ProviderRegistry();
    this.pinterestProviders.register(new PinterestWebProvider({}));
    this.pinterestProviders.register(new FixtureProvider({
      pins: makeFixturePins(48, { baseUrl: 'http://127.0.0.1:9', seed: 'lancy-demo' }),
      label: 'demo'
    }));
    const providerName = this.settings.get('pinterest.provider') ?? 'web';
    this.pinterest = new DeepSearchPipeline({
      provider: this.pinterestProviders.get(providerName),
      media: this.media,
      db: this.db,
      settings: this.settings,
      queues: this.queues
    });

    // ── Telegram ──
    this.telegram = { api: null, controller: null };

    // ── Stickers ──
    this.stickerService = null; // needs api (bot username) — created in start()
    this.packs = null;

    // ── Captions ──
    this.templates = new TemplateStore(this.db);
    this.captions = new CaptionEngine({ settings: this.settings, templates: this.templates });

    // ── WhatsApp ──
    this.whatsapp = new WhatsAppManager({
      db: this.db,
      settings: this.settings,
      credsRoot: this.root
    });
    this.channels = new ChannelService({ db: this.db, settings: this.settings });
    this.publisher = new WhatsAppPublisher({ db: this.db, settings: this.settings, channels: this.channels, captions: this.captions });
    this.inboundHandler = new InboundHandler({ app: this, log: this.log });

    // ── AI ──
    this.ai = new AIService({ settings: this.settings });
    this.assistant = new LancyAssistant({ app: this });
    this.scheduler = new AutonomousScheduler({ app: this });

    this.mediaDownloader = new MediaDownloader({ log: this.log });

    // ── Screens ──
    this.screens = new Map();
  }

  /** Wire Telegram + sticker services (needs the bot token). */
  setupTelegram() {
    const token = this.env.BOT_TOKEN ?? this.settings.get('telegram.botToken');
    if (!token) {
      throw new Error('BOT_TOKEN is required — set it in .env (see .env.example)');
    }
    this.telegram.api = new TelegramAPI(token, { log: this.log });
    this.publisher.telegramApi = this.telegram.api;
    this.telegram.controller = new TelegramController({
      api: this.telegram.api,
      db: this.db,
      settings: this.settings,
      stateMachine: this.sm,
      app: this,
      screens: this.screens
    });
    this.telegram.markMediaDeliveryMessage = (id) => this.telegram.controller?.markMediaDeliveryMessage(id);
    this.telegram.isMediaDeliveryMessage = (msg) => this.telegram.controller?.isMediaDeliveryMessage(msg);
    this.telegram.isMediaDeliveryMessageId = (id) => this.telegram.controller?.isMediaDeliveryMessageId(id);

    this.stickerService = new TelegramStickerService({
      api: this.telegram.api,
      db: this.db,
      settings: this.settings
    });
    this.packs = new StickerPackService({
      db: this.db,
      settings: this.settings,
      stickerService: this.stickerService,
      media: this.media
    });

    // Register screens.
    const factories = [
      createDashboardScreen, createPinterestScreen, createStickersScreen,
      createWhatsAppScreen, createAIScreen, createSettingsScreen, createHelpScreen,
      createDownloaderScreen
    ];
    for (const factory of factories) {
      const screen = factory({ app: this });
      this.screens.set(screen.id, screen);
      screen.registerStateHandlers?.(this.sm);
    }

    // Global callback routes.
    this.telegram.controller.onAction('noop', () => {});

    // WhatsApp DM command router
    this.whatsapp.on('command', (data) => void this.inboundHandler.handle(data));
  }

  /** Hot-reload a safe setting into the affected live service. */
  applyHotReload(path, value) {
    switch (path.split('.')[0]) {
      case 'ai':
        this.ai.reconfigure?.();
        break;
      case 'logging':
        if (path === 'logging.level') this.log.level = value;
        break;
      case 'pinterest':
        if (path === 'pinterest.provider') {
          try {
            this.pinterest.provider = this.pinterestProviders.get(value);
          } catch { this.log.warn({ value }, 'unknown pinterest provider — keeping current'); }
        }
        break;
      default:
        break; // stateless reads pick up new values automatically
    }
    this.bus.emitSafe('settings.changed', { path, value });
  }

  /** Boot everything. */
  async start() {
    this.log.info('✦ Lancy Bot starting…');
    this.setupTelegram();

    // Recover persisted user states (safe recovery to IDLE).
    const stale = this.db.all("SELECT tg_id FROM user_states WHERE state != 'IDLE'");
    for (const row of stale) {
      await this.sm.reset(row.tg_id, { reason: 'boot-recovery' });
    }
    if (stale.length) this.log.info({ count: stale.length }, 'recovered stale user states');

    // Restore WhatsApp sessions (isolated, auto-reconnect).
    const restored = await this.whatsapp.restore();
    if (restored) this.log.info({ count: restored }, 'whatsapp sessions restored');

    // Start the AI worker & autonomous scheduler.
    this.ai.start();
    this.scheduler.start();

    // Media cache cleanup interval.
    if (this.settings.get('storage.automaticCleanup')) {
      const interval = (this.settings.get('media.cleanupIntervalMinutes') ?? 30) * 60 * 1000;
      this.cleanupTimer = setInterval(() => {
        const removed = this.media.cache.cleanup(this.settings.get('storage.cacheTtlMinutes') ?? 1440);
        if (removed) this.log.info({ removed }, 'media cache cleaned');
      }, interval);
      this.cleanupTimer.unref?.();
    }

    // Telegram polling.
    await this.telegram.controller.start();
    this.#setupTestTriggerWatcher();
    this.log.info('✦ Lancy Bot is ready ♡');
  }

  #setupTestTriggerWatcher() {
    const triggerFile = join(this.root, 'test_dispatch_trigger.json');
    const resultFile = join(this.root, 'test_dispatch_result.json');
    const interval = setInterval(async () => {
      if (!existsSync(triggerFile)) return;
      try {
        const content = readFileSync(triggerFile, 'utf8');
        unlinkSync(triggerFile);
        const data = JSON.parse(content);
        this.log.info({ data }, 'executing test dispatch trigger');

        if (data.action === 'fetch_channel_messages') {
          const session = this.whatsapp.get(data.sessionId);
          const msgs = await session.sock.newsletterFetchMessages('jid', data.channelJid, Number(data.count ?? 50));
          writeFileSync(resultFile, JSON.stringify({ ok: true, msgs }, null, 2));
          this.log.info({ count: msgs?.length }, 'channel messages fetched');
          return;
        }

        if (data.action === 'publish_test') {
          const session = this.whatsapp.get(data.sessionId);
          if (!session || !session.isOnline) {
            writeFileSync(resultFile, JSON.stringify({ error: 'Session not online or not found' }));
            return;
          }
          const userId = Number(data.userId ?? this.settings.get('general.ownerIds')?.[0] ?? 1001);
          const pack = (data.packId ? this.packs.getPack(userId, data.packId) : null) ?? (this.packs.listPacks(userId, { limit: 1 }).packs[0]);
          if (!pack) {
            writeFileSync(resultFile, JSON.stringify({ error: 'Pack not found' }));
            return;
          }
          const plan = this.publisher.buildPlan({
            userId,
            packs: [pack],
            sessionId: session.sessionId,
            channelJids: [data.channelJid],
            caption: data.caption ?? '♡ Test publish to Him channel'
          });
          const results = await this.publisher.publish({
            plan,
            session,
            telegramApi: this.telegram.api,
            getStickerBytes: async (packId, index) => {
              return this.packs.getStickerBytes(pack, index, {
                download: (fileId) => this.stickerService.downloadSticker(fileId)
              });
            }
          });
          writeFileSync(resultFile, JSON.stringify({ ok: true, results, plan }));
          this.log.info({ results }, 'test dispatch trigger complete');
        }
      } catch (err) {
        this.log.error({ err }, 'test dispatch trigger failed');
        writeFileSync(resultFile, JSON.stringify({ error: err.message, stack: err.stack }));
      }
    }, 1000);
    interval.unref?.();
    this.triggerInterval = interval;
  }

  /** Graceful shutdown. */
  async stop() {
    this.log.info('shutting down…');
    clearInterval(this.cleanupTimer);
    clearInterval(this.triggerInterval);
    this.scheduler?.stop();
    await this.telegram.controller?.stop();
    await this.whatsapp.stopAll();
    await this.ai.stop();
    await this.queues.shutdown();
    this.db.close();
  }
}
