/** Tiny, dependency-free Node.js / browser client for Cacheloom HTTP v1. */
export class CacheloomClient {
  constructor({ url, apiKey, timeoutMs = 5000 }) {
    if (!url || !apiKey) throw new Error('url and apiKey required');
    this.url = new URL('/v1/kv', url);
    this.jobsUrl = new URL('/v1/jobs', url);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }
  async request(url, body) {
    const response = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Cacheloom ${response.status}: ${body.error}`);
    return body.result;
  }
  command(command, key, fields = {}) { return this.request(this.url, { command, key, ...fields }); }
  jobCommand(command, fields = {}) { return this.request(this.jobsUrl, { command, ...fields }); }
  enqueue(queue, payload, options = {}) { return this.jobCommand('ENQUEUE', { queue, payload, ...options }); }
  claim(queue, options = {}) { return this.jobCommand('CLAIM', { queue, ...options }); }
  acknowledge(id, leaseToken) { return this.jobCommand('ACK', { id, leaseToken }); }
  fail(id, leaseToken, error, options = {}) {
    return this.jobCommand('FAIL', { id, leaseToken, error, ...options });
  }
  extend(id, leaseToken, leaseSeconds) { return this.jobCommand('EXTEND', { id, leaseToken, leaseSeconds }); }
  getJob(id) { return this.jobCommand('GET', { id }); }
  cancelJob(id) { return this.jobCommand('CANCEL', { id }); }
  replayJob(id) { return this.jobCommand('REPLAY', { id }); }
  get(key) { return this.command('GET', key); }
  set(key, value, options = {}) { return this.command('SET', key, { value, ...options }); }
  del(key) { return this.command('DEL', key); }
  expire(key, ttlSeconds) { return this.command('EXPIRE', key, { ttlSeconds }); }
  ttl(key) { return this.command('TTL', key); }
  incr(key, by = 1) { return this.command('INCR', key, { by }); }
}
