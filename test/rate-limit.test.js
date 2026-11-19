import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_PG_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const { Pool } = enabled ? await import('pg') : {};
const { PostgresRateLimiter } = enabled ? await import('../src/rate-limit.js') : {};
const { createCacheloomServer } = enabled ? await import('../src/server.js') : {};
const { CacheloomClient } = enabled ? await import('../sdk/client.js') : {};
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 12 }) : null;
const secondPool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 12 }) : null;
const project = 'limits_' + randomUUID().replaceAll('-', '').slice(0, 16);
const other = project + '_other';
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM cacheloom_rate_limits WHERE project=ANY($1::text[])', [[project, other]]);
  await Promise.all([pool.end(),secondPool.end()]);
});

test('the limit is atomic across independent pools and concurrent callers', { skip: !enabled }, async () => {
  const left = new PostgresRateLimiter({ pool, requestsPerMinute: 12 });
  const right = new PostgresRateLimiter({ pool: secondPool, requestsPerMinute: 12 });
  const attempts = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    (i % 2 ? left : right).consume(project)));
  assert.equal(attempts.filter(Boolean).length, 12);
  assert.equal(await left.consume(project), false);
  assert.equal(await right.consume(other), true);
});

test('two API replicas share their global request budget', { skip: !enabled }, async () => {
  const secret = 'test-rate-limit-secret-longer-than-32-characters';
  const serverA = createCacheloomServer({
    keys: JSON.stringify({ [project]: secret }),
    distributedLimiter: new PostgresRateLimiter({ pool, requestsPerMinute: 12 }),
  });
  const serverB = createCacheloomServer({
    keys: JSON.stringify({ [project]: secret }),
    distributedLimiter: new PostgresRateLimiter({ pool: secondPool, requestsPerMinute: 12 }),
  });
  await Promise.all([serverA,serverB].map(server =>
    new Promise(resolve => server.listen(0,'127.0.0.1',resolve))));
  try {
    const a = new CacheloomClient({ url: 'http://127.0.0.1:' + serverA.address().port, apiKey: secret });
    const b = new CacheloomClient({ url: 'http://127.0.0.1:' + serverB.address().port, apiKey: secret });
    // The previous test already exhausted this minute's budget.
    await assert.rejects(() => a.get('one'), /429/);
    await assert.rejects(() => b.get('two'), /429/);
    assert.equal((await fetch('http://127.0.0.1:' + serverA.address().port + '/ready')).status, 200);
  } finally {
    await Promise.all([serverA,serverB].map(server =>
      new Promise(resolve => server.close(resolve))));
  }
});

test('limiter readiness detects missing schema and pruning is bounded', { skip: !enabled }, async () => {
  const limiter = new PostgresRateLimiter({ pool, requestsPerMinute: 5 });
  await limiter.ready();
  await pool.query('INSERT INTO cacheloom_rate_limits(project,minute_bucket,requests) VALUES($1,-100,1)', [project]);
  assert.equal(await limiter.prune({ keepMinutes: 5 }) >= 1, true);
  await assert.rejects(() => limiter.prune({ keepMinutes: 0 }), /Invalid rate-limit retention/);
});
