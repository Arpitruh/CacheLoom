import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCacheloomServer } from '../src/server.js';
import { CacheloomClient } from '../sdk/client.js';

// The normal npm test command still works without PostgreSQL installed.
// CI explicitly enables this suite with a disposable PostgreSQL container.
const enabled = process.env.RUN_PG_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const { Pool } = enabled ? await import('pg') : {};
const { PostgresStore } = enabled ? await import('../src/pg-store.js') : {};
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 12 }) : null;
const store = pool ? new PostgresStore({ pool }) : null;
const prefix = 'ci-' + crypto.randomUUID() + ':';
const key = name => prefix + name;
if (pool) {
  await pool.query(await readFile(new URL('../db/001_kv.sql', import.meta.url), 'utf8'));
}

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM cacheloom_kv WHERE key LIKE $1', [prefix + '%']);
  await pool.end();
});

test('values persist across store instances; NX, XX and TTL still work', { skip: !enabled }, async () => {
  assert.equal(await store.set(key('item'), { value: 1 }, { ttlSeconds: 10, nx: true }), true);
  assert.equal(await store.set(key('item'), 2, { nx: true }), false);
  const second = new PostgresStore({ pool });
  assert.deepEqual(await second.get(key('item')), { value: 1 });
  assert.equal(await second.set(key('missing'), 2, { xx: true }), false);
  assert.equal(await second.set(key('item'), 3, { xx: true }), true);
  assert.equal(await second.ttl(key('item')), -1);
  assert.equal(await store.expire(key('item'), 5), true);
  assert.equal(await store.ttl(key('item')) > 0, true);
  assert.equal(await store.del(key('item')), true);
  assert.equal(await store.ttl(key('item')), -2);
});

test('expired rows act like absent keys without waiting for the cleanup timer', { skip: !enabled }, async () => {
  const k = key('expired');
  await store.set(k, 'old');
  await pool.query("UPDATE cacheloom_kv SET expires_at=clock_timestamp()-interval '2 seconds' WHERE key=$1", [k]);
  assert.equal(await store.get(k), null);
  assert.equal(await store.ttl(k), -2);
  assert.equal(await store.set(k, 'new', { nx: true }), true);
  assert.equal(await store.get(k), 'new');
});

test('concurrent counters stay atomic across separate connection pools', { skip: !enabled }, async () => {
  const k = key('counter');
  await store.set(k, 0, { ttlSeconds: 120 });
  const otherPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const other = new PostgresStore({ pool: otherPool });
  try {
    await Promise.all(Array.from({ length: 36 }, (_, i) => (i % 2 ? other : store).incr(k)));
    assert.equal(await store.get(k), 36);
    assert.equal(await store.ttl(k) > 0, true);
    assert.equal(await store.incr(k, 4), 40);
    await store.set(key('not-a-number'), 'hello');
    await assert.rejects(() => store.incr(key('not-a-number')), /VALUE_NOT_INTEGER/);
  } finally { await otherPool.end(); }
});

test('HTTP clients can share storage without crossing project keyspaces', { skip: !enabled }, async () => {
  const secretA = 'integration-test-secret-for-project-alpha-123';
  const secretB = 'integration-test-secret-for-project-bravo-456';
  const server = createCacheloomServer({ keys: JSON.stringify({ alpha: secretA, bravo: secretB }), store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const alpha = new CacheloomClient({ url, apiKey: secretA });
    const bravo = new CacheloomClient({ url, apiKey: secretB });
    assert.equal(await alpha.set(key('shared'), { durable: true }), true);
    assert.deepEqual(await alpha.get(key('shared')), { durable: true });
    assert.equal(await bravo.get(key('shared')), null);
    assert.equal((await fetch(url + '/ready')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
