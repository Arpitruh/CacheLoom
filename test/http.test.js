import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCacheloomServer } from '../src/server.js';
import { CacheloomClient } from '../sdk/client.js';
const K1 = 'test-secret-which-is-at-least-32-characters-111';
const K2 = 'test-secret-which-is-at-least-32-characters-222';
async function withServer(fn) {
  const server = createCacheloomServer({ keys: JSON.stringify({ alpha: K1, beta: K2 }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await fn(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('project keys isolate values', async () => withServer(async url => {
  const a = new CacheloomClient({ url, apiKey: K1 });
  const b = new CacheloomClient({ url, apiKey: K2 });
  assert.equal(await a.set('hello', { ok: true }), true);
  assert.deepEqual(await a.get('hello'), { ok: true });
  assert.equal(await b.get('hello'), null);
  assert.equal(await b.incr('counter'), 1);
  assert.equal(await b.incr('counter', 4), 5);
  assert.equal(await a.get('counter'), null);
}));
test('auth and validation', async () => withServer(async url => {
  const invalid = new CacheloomClient({ url, apiKey: 'invalid' });
  await assert.rejects(() => invalid.get('test'), /401/);
  const a = new CacheloomClient({ url, apiKey: K1 });
  await assert.rejects(() => a.set('x', 1, { ttlSeconds: -1 }), /400/);
  assert.equal(await a.set('x', 1, { ttlSeconds: 10, nx: true }), true);
  assert.equal(await a.set('x', 4, { nx: true }), false);
  assert.equal(await a.ttl('x') > 0, true);
  assert.equal(await a.del('x'), true);
  assert.equal(await a.ttl('x'), -2);
}));
