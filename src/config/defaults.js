/**
 * Lancy Bot default settings — the COMPLETE configuration tree.
 * Every category from the product spec lives here. Values are persisted
 * in the `bot_settings` table and hot-reloaded where safe.
 */

export const DEFAULT_SETTINGS = {
  general: {
    botName: 'Lancy Bot',
    botUsername: '',
    ownerIds: [],
    timezone: 'UTC',
    language: 'en',
    defaultStyle: 'girly',
    defaultEmojis: '♡ ✦ ★ ·',
    defaultCreatorName: 'Lancy'
  },

  telegram: {
    // botToken is env-only (never stored in the DB, never hot-reloaded)
    adminIds: [],
    richMessages: true,          // use Bot API 10.3 rich messages
    paginationSize: 5,
    progressAnimation: true,
    previewBehavior: 'inline',   // inline | photo
    messageCleanup: false,       // delete screen messages on navigation
    notificationPreferences: 'all', // all | errors | none
    stickerAddDelayMs: 250       // gentle pacing between addStickerToSet calls
  },

  whatsapp: {
    defaultSession: null,
    reconnectBehavior: 'auto',   // auto | manual
    pairingTimeoutSeconds: 120,
    mediaQuality: 'highest',     // highest | balanced
    captionDefaults: 'template', // template | ai | none
    albumSettings: 'auto',       // auto | always | never
    channelCacheMinutes: 10,
    physicalStickerPackLimit: 60, // plogme enforces max 60 per stickerPackMessage
    publishingDelayMs: 1200,
    retryCount: 3,
    sendToOwnDmOnConnect: true
  },

  pinterest: {
    provider: 'web',             // web | fixture
    defaultMode: 'mixed',        // mixed | images | videos | random
    searchDepth: 'deep',         // quick | deep | very_deep
    resultCount: 60,
    imageQuality: 'original',    // original | large | medium
    videoQuality: 'highest',
    duplicateDetection: true,
    cacheDurationMinutes: 60,
    searchTimeoutSeconds: 30,
    maxConcurrentSearches: 2,
    // Deep-search expansion targets per depth level:
    depthPages: { quick: 1, deep: 3, very_deep: 6 },
    depthTargetResults: { quick: 24, deep: 60, very_deep: 120 }
  },

  stickers: {
    defaultPackName: 'Lancy Pack',
    creatorName: 'Lancy',
    packEmoji: '♡',
    defaultStickerAmount: 30,
    telegramFormat: 'static',    // static | video
    imageProcessingQuality: 92,
    videoStickerBehavior: 'convert', // convert | skip | fail
    thumbnail: true,
    emojiAssignment: 'auto',     // auto | pack | first
    // Telegram limits (verified against current Bot API; still configurable,
    // and cross-checked live via getStickerSet where possible)
    telegramStickersPerSet: 120,     // static/emoji sets
    telegramEmojiStickersPerSet: 200, // emoji sets
    telegramVideoStickersPerSet: 50,  // video sets
    telegramAnimatedStickersPerSet: 50,
    telegramCreateInitialLimit: 1,    // createNewStickerSet initial stickers (safe: 1)
    telegramStaticMaxBytes: 512 * 1024,
    telegramVideoMaxBytes: 256 * 1024,
    whatsappPhysicalPackSize: 60     // mirrors whatsapp.physicalStickerPackLimit
  },

  captions: {
    defaultTemplate: 'default',
    creatorFooter: '𓆩♡𓆪 made with love by {{creator}}',
    defaultTitle: '{{query}} Collection',
    cta: 'download • use • enjoy ♡',
    separatorStyle: 'line',      // line | dots | thick | none
    emojiStyle: 'soft',          // soft | none | bold
    aiAutoCaption: false,
    previewBeforePublishing: true
  },

  ai: {
    enabled: true,
    provider: 'builtin',         // builtin | ollama | openai-compatible
    endpoint: 'http://127.0.0.1:11434',
    model: '',
    apiKey: '',                  // env-overridable, never shown in UI
    personality: 'lancy',
    style: 'girly',
    creativity: 0.7,
    maxTokens: 400,
    timeoutSeconds: 30,
    fallbackProvider: 'builtin',
    autoCaption: false,
    chatMode: true
  },

  media: {
    ffmpegPath: '',              // empty = auto-detect (ffmpeg-static, vendor, PATH)
    maxDownloadBytes: 60 * 1024 * 1024,
    maxProcessingSeconds: 120,
    imageFormat: 'webp',
    videoFormat: 'webm',
    compression: 'balanced',     // conservative | balanced | aggressive
    temporaryStorage: 'data/tmp',
    cleanupIntervalMinutes: 30
  },

  performance: {
    workerConcurrency: 4,
    queueConcurrency: 2,
    pinterestConcurrency: 2,
    whatsappSessionConcurrency: 3,
    aiConcurrency: 1,
    cpuLimitPercent: 80,
    memoryLimitMb: 1024,
    retryCount: 3,
    exponentialBackoff: true
  },

  storage: {
    database: 'data/lancy.db',
    redis: '',                   // empty = in-process cache only
    mediaCache: 'data/cache/media',
    cacheTtlMinutes: 1440,
    automaticCleanup: true,
    persistentSearchHistory: true
  },

  security: {
    ownerIds: [],                // mirrored from general.ownerIds
    allowedUsers: [],            // empty = owner + admins only
    sessionCredentialPermissions: '0600',
    encryptSecrets: false,       // optional at-rest encryption for creds
    tokenProtection: true,
    sessionIsolation: true
  },

  logging: {
    level: 'info',               // trace | debug | info | warn | error
    fileLogs: true,
    consoleLogs: true,
    errorLogs: true,
    auditLogs: true,
    retentionDays: 14
  },

  advanced: {
    hotReload: true,
    debugMode: false,
    experimentalApis: false,
    featureFlags: {},
    maintenanceMode: false
  }
};

/**
 * Settings whose change REQUIRES a controlled reinitialization/restart.
 * Everything else hot-reloads safely. We never pretend hot reload worked
 * when the underlying service requires a restart.
 */
export const RESTART_REQUIRED_PATHS = new Set([
  'telegram.botToken',
  'storage.database',
  'storage.redis',
  'security.encryptSecrets',
  'security.ownerIds',
  'general.ownerIds',
  'media.ffmpegPath',
  'ai.provider',
  'ai.endpoint'
]);

/** Deep-merge user settings over defaults. */
export function mergeSettings(defaults, overrides) {
  if (Array.isArray(defaults) || Array.isArray(overrides)) {
    return overrides === undefined ? defaults : overrides;
  }
  if (isPlainObject(defaults) && isPlainObject(overrides)) {
    const out = { ...defaults };
    for (const key of Object.keys(overrides)) {
      out[key] = key in defaults ? mergeSettings(defaults[key], overrides[key]) : overrides[key];
    }
    return out;
  }
  return overrides === undefined ? defaults : overrides;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten to dotted paths: { 'whatsapp.physicalStickerPackLimit': 60, ... } */
export function flattenSettings(tree, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) Object.assign(out, flattenSettings(value, path));
    else out[path] = value;
  }
  return out;
}

/** Apply a dotted-path patch to a settings tree (returns a new tree). */
export function applySettingPatch(tree, path, value) {
  const clone = structuredClone(tree);
  const parts = path.split('.');
  let node = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return clone;
}
