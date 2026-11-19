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


test('dashboard is read-only and protected by a restrictive content security policy', async () => withServer(async url => {
  const response = await fetch(url + '/dashboard');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  assert.match(html, /Queue Monitor/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  const script = await fetch(url + '/dashboard.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('x-content-type-options'), /nosniff/);
}));


test('rotating secrets can overlap without mixing project data', async () => {
  const rotating = 'new-secret-that-is-long-enough-for-rotation-123';
  const { parseKeys } = await import('../src/server.js');
  const server = createCacheloomServer({
    keys: JSON.stringify({ alpha: [K1, rotating], beta: K2 }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const oldClient = new CacheloomClient({ url, apiKey: K1 });
    const newClient = new CacheloomClient({ url, apiKey: rotating });
    const beta = new CacheloomClient({ url, apiKey: K2 });
    await oldClient.set('rotation-test', 42);
    assert.equal(await newClient.get('rotation-test'), 42);
    assert.equal(await beta.get('rotation-test'), null);
    assert.throws(() => parseKeys(JSON.stringify({ a: K1, b: K1 })), /Duplicate API secrets/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('request limit is scoped to a project and denies excess traffic', async () => {
  const server = createCacheloomServer({
    keys: JSON.stringify({ alpha: K1, beta: K2 }), maxRequestsPerMinute: 2,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const alpha = new CacheloomClient({ url, apiKey: K1 });
    const beta = new CacheloomClient({ url, apiKey: K2 });
    assert.equal(await alpha.get('x'), null);
    assert.equal(await alpha.get('x'), null);
    await assert.rejects(() => alpha.get('x'), /429/);
    assert.equal(await beta.get('x'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
