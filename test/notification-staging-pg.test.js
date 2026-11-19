import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_PG_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const { Pool } = enabled ? await import('pg') : {};
const { PostgresJobQueue } = enabled ? await import('../src/job-queue.js') : {};
const { createCacheloomServer } = enabled ? await import('../src/server.js') : {};
const { CacheloomClient } = enabled ? await import('../sdk/client.js') : {};
const { CacheloomWorker } = enabled ? await import('../sdk/worker.js') : {};
const { enqueueNotificationForStaging, NOTIFICATION_STAGING_QUEUE,
  createNotificationStagingHandler } = await import('../integrations/notification-staging.js');

const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 8 }) : null;
const jobs = pool ? new PostgresJobQueue({ pool }) : null;
const project = 'staging_' + randomUUID().replaceAll('-', '').slice(0, 12);
const key = 'staging-integration-test-key-longer-than-32-characters';
after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM cacheloom_jobs WHERE project=$1', [project]);
  await pool.end();
});

test('notification outbox event is de-duplicated and simulated without contacting a provider',
  { skip: !enabled }, async () => {
    const server = createCacheloomServer({ keys: JSON.stringify({ [project]: key }), jobs });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const client = new CacheloomClient({ url, apiKey: key });
    const outboxId = randomUUID();
    const notificationId = randomUUID();
    const event = { outboxId, notificationId, priority: 5 };
    const observed = [];
    try {
      const [a, b] = await Promise.all([
        enqueueNotificationForStaging(client, event),
        enqueueNotificationForStaging(client, event),
      ]);
      assert.equal(a.id, b.id, 'the outbox event must produce one durable job');
      assert.equal([a, b].filter(x => x.duplicate).length, 1);
      const handler = createNotificationStagingHandler({
        inspect: async id => {
          assert.equal(id, notificationId);
          return { status: 'queued' };
        },
        onSimulatedDelivery: async call => { observed.push(call); },
      });
      // The same HTTP client and heartbeat/ack paths used in production-like
      // workers are exercised, but the handler cannot send email or SMS.
      const worker = new CacheloomWorker({
        client, queue: NOTIFICATION_STAGING_QUEUE, handler, concurrency: 1,
        pollIntervalMs: 100, leaseSeconds: 5, heartbeatIntervalMs: 500,
      });
      worker.start();
      const deadline = Date.now() + 6000;
      while (observed.length === 0 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(observed.length, 1);
      assert.deepEqual(await worker.stop(), { drained: true });
      assert.equal((await client.getJob(a.id)).status, 'completed');
      assert.equal(observed[0].outboxId, outboxId);
      assert.equal(observed[0].notificationId, notificationId);
      assert.equal((await client.queueMetrics(NOTIFICATION_STAGING_QUEUE))
        .find(x => x.status === 'completed')?.count, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
test('staging payload prevents a completed notification from simulating a second delivery',
  { skip: !enabled }, async () => {
    const seen = [];
    const handler = createNotificationStagingHandler({
      inspect: async () => ({ status: 'sent' }),
      onSimulatedDelivery: async x => { seen.push(x); },
    });
    const result = await handler({ notificationId: 'sent-1', outboxId: 'outbox-1' },
      { job: { id: randomUUID(), attempts: 2 }, signal: new AbortController().signal });
    assert.equal(result.skipped, true);
    assert.equal(seen.length, 0);
  });
