/** Retry with exponential backoff + jitter. Never throws the last error silently — it rethrows. */

export class RetryError extends Error {
  constructor(message, { attempts, lastError } = {}) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelay(attempt, { baseMs = 500, maxMs = 30000, factor = 2, jitter = 0.25 } = {}) {
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt - 1));
  const jitterAmount = exp * jitter * Math.random();
  return Math.round(exp + jitterAmount);
}

/**
 * @param {() => Promise<T>} fn
 * @param {object} opts
 * @param {number} opts.attempts max attempts (default 3)
 * @param {(error, attempt) => boolean} opts.shouldRetry return false to abort
 * @param {(attempt, delay) => void} opts.onRetry
 */
export async function withRetry(fn, opts = {}) {
  const {
    attempts = 3,
    baseMs = 500,
    maxMs = 30000,
    factor = 2,
    jitter = 0.25,
    shouldRetry = () => true,
    onRetry
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) break;
      const delay = backoffDelay(attempt, { baseMs, maxMs, factor, jitter });
      onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }
  if (lastError instanceof RetryError) throw lastError;
  throw new RetryError(`Failed after ${attempts} attempt(s): ${lastError?.message ?? lastError}`, {
    attempts,
    lastError
  });
}
