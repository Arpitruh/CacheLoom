import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CacheloomClient } from '../sdk/client.js';

// Never run this against production by accident. The script writes and claims
// disposable jobs, and a passing smoke check is not a production certification.
const url = process.env.CACHELOOM_STAGING_URL ?? 'http://127.0.0.1:8080';
const apiKey = process.env.CACHELOOM_STAGING_KEY;
const parsed = new URL(url);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
if (!local && process.env.CACHELOOM_ALLOW_REMOTE_SMOKE !== 'I_UNDERSTAND_STAGING_ONLY')
  throw new Error('Remote smoke tests require an explicit staging-only acknowledgement');
if (!local && parsed.protocol !== 'https:') throw new Error('Remote staging requires HTTPS');
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
    parsed.search || parsed.hash) throw new Error('Invalid staging URL');
if (!apiKey || apiKey.length < 32) throw new Error('Set CACHELOOM_STAGING_KEY (32+ characters)');
const fetchJSON = async path => {
  const result = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5000) });
  return { status: result.status, body: await result.json() };
};
const client = new CacheloomClient({ url, apiKey, timeoutMs: 5000 });
const key = 'smoke:' + randomUUID();
const queue = 'smoke_' + randomUUID().replaceAll('-', '').slice(0, 12);
let jobId;
try {
  assert.equal((await fetchJSON('/health')).status, 200);
  assert.equal((await fetchJSON('/ready')).status, 200);
  const missing = await fetch(new URL('/v1/kv', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'GET', key }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(missing.status, 401, 'Unauthenticated requests must be denied');
  assert.equal(await client.set(key, { smoke: true }, { ttlSeconds: 120 }), true);
  assert.deepEqual(await client.get(key), { smoke: true });
  assert.ok((await client.ttl(key)) > 0);
  assert.equal(await client.del(key), true);
  assert.equal(await client.get(key), null);
  const first = await client.enqueue(queue, { smoke: true }, { idempotencyKey: key });
  jobId = first.id;
  const duplicate = await client.enqueue(queue, { smoke: true }, { idempotencyKey: key });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  const [job] = await client.claim(queue, { leaseSeconds: 30 });
  assert.equal(job.id, first.id);
  assert.equal(job.payload.smoke, true);
  assert.equal(await client.acknowledge(job.id, job.lease_token), true);
  assert.equal((await client.getJob(job.id)).status, 'completed');
  console.log('[smoke] health, readiness, auth, key TTL, dedupe, claim and ACK: passed');
} finally {
  // Completed jobs keep their dedupe keys by design; this smoke test uses a
  // unique queue/key on each run. Operators can remove them after a retention window.
  await client.del(key).catch(() => {});
  if (jobId) console.log('[smoke] completed test job:', jobId);
}
