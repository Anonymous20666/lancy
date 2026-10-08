/**
 * LancyError — every user-facing failure carries a clean, human message.
 * Technical details go to the log, never to the chat.
 */
export class LancyError extends Error {
  constructor(userMessage, { code = 'LANCY_ERROR', details = null, cause = null, retryable = false } = {}) {
    super(userMessage);
    this.name = 'LancyError';
    this.userMessage = userMessage;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }

  /** Wrap any unknown error into a LancyError with a friendly message. */
  static wrap(error, fallback = '♡ Something went wrong on my side.') {
    if (error instanceof LancyError) return error;
    const err = new LancyError(fallback, { cause: error, code: 'INTERNAL' });
    err.cause = error;
    return err;
  }
}

/** Friendly messages for common Telegram API failures. */
export function friendlyTelegramError(error) {
  const desc = String(error?.response?.description || error?.message || error);
  if (/message is not modified/i.test(desc)) return null; // not an error for us
  if (/chat not found/i.test(desc)) return '♡ I could not find that chat.';
  if (/bot was blocked by the user/i.test(desc)) return '♡ You blocked me… unblock me and try again?';
  if (/too many requests/i.test(desc)) return '♡ Telegram is rate-limiting me — give me a second ♡';
  if (/message to edit not found/i.test(desc)) return null;
  if (/query is too old/i.test(desc)) return '♡ That button expired — tap a fresh one ♡';
  return `♡ Telegram said no: ${truncate(desc, 120)}`;
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Map plogme/Baileys Boom disconnect reasons to friendly text. */
export function friendlyDisconnectReason(statusCode) {
  const reasons = {
    401: 'logged out — the session was removed from WhatsApp',
    403: 'blocked or banned by WhatsApp',
    408: 'connection lost',
    409: 'logged in from another device',
    428: 'connection closed',
    440: 'logged out from another device',
    500: 'WhatsApp server error',
    515: 'restart required by WhatsApp'
  };
  return reasons[statusCode] ?? `connection closed (code ${statusCode})`;
}
