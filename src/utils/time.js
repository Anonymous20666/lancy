export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export function now() {
  return Date.now();
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Debounce: trailing call wins. */
export function debounce(fn, waitMs) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  debounced.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  return debounced;
}

/** Throttle: leading + trailing, at most once per window. */
export function throttle(fn, waitMs) {
  let last = 0;
  let timer = null;
  let lastArgs = null;

  const throttled = (...args) => {
    lastArgs = args;
    const now = Date.now();
    const remaining = waitMs - (now - last);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      const toCall = lastArgs;
      lastArgs = null;
      if (toCall) fn(...toCall);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        const toCall = lastArgs;
        lastArgs = null;
        if (toCall) fn(...toCall);
      }, remaining);
    }
  };

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  return throttled;
}

/** Parse 'mm:ss' or 'hh:mm:ss' or seconds string/number into integer seconds. */
export function parseDurationToSeconds(val) {
  if (typeof val === 'number') return Math.round(val);
  if (!val || typeof val !== 'string') return 0;
  const parts = val.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  const num = Number(val);
  return isNaN(num) ? 0 : Math.round(num);
}
