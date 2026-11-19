/** Tiny, dependency-free Node.js / browser client for Cacheloom HTTP v1. */
export class CacheloomClient {
  constructor({ url, apiKey, timeoutMs = 5000 }) {
    if (!url || !apiKey) throw new Error('url and apiKey required');
    this.url = new URL('/v1/kv', url);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }
  async command(command, key, fields = {}) {
    const response = await fetch(this.url, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command, key, ...fields }), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Cacheloom ${response.status}: ${body.error}`);
    return body.result;
  }
  get(key) { return this.command('GET', key); }
  set(key, value, options = {}) { return this.command('SET', key, { value, ...options }); }
  del(key) { return this.command('DEL', key); }
  expire(key, ttlSeconds) { return this.command('EXPIRE', key, { ttlSeconds }); }
  ttl(key) { return this.command('TTL', key); }
  incr(key, by = 1) { return this.command('INCR', key, { by }); }
}
