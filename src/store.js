/** Single-process volatile store. Explicitly not a durable or clustered Redis substitute. */
export class VolatileStore {
  #items = new Map();
  #now;
  #capacity;
  constructor({ maxKeys = 10000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('Invalid maxKeys');
    this.#capacity = maxKeys;
    this.#now = now;
  }
  #live(key) {
    const item = this.#items.get(key);
    if (item && item.expiresAt !== null && item.expiresAt <= this.#now()) {
      this.#items.delete(key);
      return undefined;
    }
    return item;
  }
  get(key) { const e = this.#live(key); return e ? structuredClone(e.value) : null; }
  has(key) { return this.#live(key) !== undefined; }
  set(key, value, { ttlSeconds, nx = false, xx = false } = {}) {
    if (nx && xx) throw new Error('nx and xx cannot be combined');
    const existing = this.#live(key);
    if ((nx && existing) || (xx && !existing)) return false;
    if (!existing && this.#items.size >= this.#capacity) {
      this.sweep();
      if (this.#items.size >= this.#capacity) throw new Error('STORE_CAPACITY_EXCEEDED');
    }
    const expiresAt = ttlSeconds === undefined ? null : this.#now() + ttlSeconds * 1000;
    this.#items.set(key, { value: structuredClone(value), expiresAt });
    return true;
  }
  del(key) { this.#live(key); return this.#items.delete(key); }
  expire(key, seconds) {
    const e = this.#live(key);
    if (!e) return false;
    e.expiresAt = this.#now() + seconds * 1000;
    return true;
  }
  ttl(key) {
    const e = this.#live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - this.#now()) / 1000));
  }
  incr(key, by = 1) {
    const e = this.#live(key);
    const old = e ? e.value : 0;
    if (!Number.isSafeInteger(old) || !Number.isSafeInteger(by) || !Number.isSafeInteger(old + by)) {
      throw new Error('VALUE_NOT_INTEGER');
    }
    if (e) e.value = old + by;
    else this.set(key, by);
    return old + by;
  }
  sweep() {
    let removed = 0;
    for (const [key, entry] of this.#items) {
      if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
        this.#items.delete(key); removed++;
      }
    }
    return removed;
  }
  get size() { this.sweep(); return this.#items.size; }
}
