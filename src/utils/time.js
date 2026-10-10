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
