export class KeyedLock {
  constructor() { this.tails = new Map(); }
  async run(key, action) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release; const current = new Promise(r => { release = r; }); this.tails.set(key, current);
    let timer;
    try {
      await Promise.race([previous, new Promise(r => { timer = setTimeout(r, 15000); timer.unref?.(); })]);
    } finally {
      clearTimeout(timer);
    }
    try { return await action(); } finally { release(); if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}
