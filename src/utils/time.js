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
  let lastArgs;
  const invoke = () => {
    last = Date.now();
    timer = null;
    fn(...lastArgs);
    lastArgs = null;
  };
  return (...args) => {
    const elapsed = Date.now() - last;
    lastArgs = args;
    if (elapsed >= waitMs) {
      invoke();
    } else if (!timer) {
      timer = setTimeout(invoke, waitMs - elapsed);
    }
  };
}
