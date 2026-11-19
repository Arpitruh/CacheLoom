import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheloomWorker } from '../sdk/worker.js';

function fakeClient({ work = [] } = {}) {
  const events = { claimed: 0, extended: 0, acknowledged: 0, failed: 0 };
  return {
    events,
    async claim() { events.claimed++; return work.splice(0, 1); },
    async extend() { events.extended++; return new Date(Date.now() + 5000).toISOString(); },
    async acknowledge() { events.acknowledged++; return true; },
    async fail() { events.failed++; return { status: 'pending' }; },
  };
}
const job = () => ({ id: 'job-1', lease_token: 'token-1', payload: { hello: true } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('worker processes and acknowledges a job, then shuts down cleanly', async () => {
  const client = fakeClient({ work: [job()] });
  let handled = 0;
  const worker = new CacheloomWorker({ client, queue: 'emails', pollIntervalMs: 100,
    handler: async payload => { assert.equal(payload.hello, true); handled++; } });
  worker.start();
  await delay(180);
  const stopped = await worker.stop();
  assert.deepEqual(stopped, { drained: true });
  assert.equal(handled, 1);
  assert.equal(client.events.acknowledged, 1);
  assert.equal(client.events.failed, 0);
});

test('heartbeats renew leases while a job handler is running', async () => {
  const client = fakeClient({ work: [job()] });
  const worker = new CacheloomWorker({ client, queue: 'emails', leaseSeconds: 5,
    heartbeatIntervalMs: 100, pollIntervalMs: 100,
    handler: async () => { await delay(320); } });
  worker.start();
  await delay(450);
  await worker.stop();
  assert.ok(client.events.extended >= 2);
  assert.equal(client.events.acknowledged, 1);
});

test('a lost lease aborts the handler and is never acknowledged', async () => {
  const client = fakeClient({ work: [job()] });
  client.extend = async () => { client.events.extended++; return null; };
  let aborted = false;
  const events = [];
  const worker = new CacheloomWorker({ client, queue: 'emails', leaseSeconds: 5,
    heartbeatIntervalMs: 100, pollIntervalMs: 100, onEvent: event => events.push(event),
    handler: async (_payload, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    } });
  worker.start();
  await delay(260);
  await worker.stop();
  assert.equal(aborted, true);
  assert.equal(client.events.acknowledged, 0);
  assert.equal(client.events.failed, 0);
  assert.ok(events.some(e => e.type === 'lease-lost'));
});

test('handler failures use the queue retry API', async () => {
  const client = fakeClient({ work: [job()] });
  const worker = new CacheloomWorker({ client, queue: 'emails', pollIntervalMs: 100,
    handler: async () => { throw new Error('SMTP unavailable'); } });
  worker.start();
  await delay(150);
  await worker.stop();
  assert.equal(client.events.failed, 1);
  assert.equal(client.events.acknowledged, 0);
});

test('graceful shutdown drains in-flight work', async () => {
  const client = fakeClient({ work: [job()] });
  let finished = false;
  const worker = new CacheloomWorker({ client, queue: 'emails', pollIntervalMs: 100,
    handler: async () => { await delay(190); finished = true; } });
  worker.start();
  await delay(45);
  assert.deepEqual(await worker.stop({ timeoutMs: 2000 }), { drained: true });
  assert.equal(finished, true);
  assert.equal(client.events.acknowledged, 1);
});

test('shutdown deadline aborts remaining handler signal', async () => {
  const client = fakeClient({ work: [job()] });
  let signalled = false;
  const worker = new CacheloomWorker({ client, queue: 'emails', pollIntervalMs: 100,
    handler: async (_payload, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', () => { signalled = true; resolve(); }, { once: true }));
    } });
  worker.start();
  await delay(45);
  assert.deepEqual(await worker.stop({ timeoutMs: 30 }), { drained: false });
  await delay(40);
  assert.equal(signalled, true);
  assert.equal(client.events.acknowledged, 0);
});
