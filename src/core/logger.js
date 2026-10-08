import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let instance = null;

/**
 * Lancy logger. Pretty console in dev, JSON to file in production.
 */
export function createLogger({ level = process.env.LOG_LEVEL || 'info', logDir } = {}) {
  const streams = [{ level, stream: pino.destination({ sync: true }) }];
  try {
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      streams.push({ level, stream: pino.destination({ dest: join(logDir, 'lancy.log'), sync: false }) });
      streams.push({ level: 'error', stream: pino.destination({ dest: join(logDir, 'lancy-error.log'), sync: false }) });
    }
  } catch { /* logging must never crash the bot */ }

  instance = pino(
    {
      level,
      base: { service: 'lancy-bot' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) }
    },
    pino.multistream(streams)
  );
  return instance;
}

export function logger() {
  if (!instance) instance = createLogger();
  return instance;
}

/** Child logger with a fixed context (module name etc.). */
export function childLogger(bindings) {
  return logger().child(bindings);
}
