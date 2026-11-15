export class KeyedLock {
  constructor({ defaultTimeoutMs = 60000 } = {}) {
    this.tails = new Map();
    this.defaultTimeoutMs = defaultTimeoutMs;
  }
  async run(key, action, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release; const current = new Promise(r => { release = r; }); this.tails.set(key, current);
    let timer;
    try {
      const waitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
      await Promise.race([previous, new Promise(r => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
    } finally {
      clearTimeout(timer);
    }
    try { return await action(); } finally { release(); if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}
