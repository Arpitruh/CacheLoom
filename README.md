# CacheLoom

**Build infrastructure you own.** A free, self-hostable foundation for a multi-project cache, session, and job platform.

> **Status: v0.4.0 / experimental.** PostgreSQL-backed durable keys are now available as an opt-in backend. CacheLoom is not Redis-protocol-compatible and cannot be used as a drop-in BullMQ backend. Do not move production authentication or notification queues until operational and failure-recovery testing is complete.

## Available today

- Dependency-free HTTP server and JavaScript SDK (Node.js >=20); optional PostgreSQL driver for durable storage
- Isolated application keyspaces using per-project bearer tokens
- JSON `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `INCR`
- NX/XX conditionals and optional TTL on SET
- Constant-time API key digest comparisons
- Capacity limit with **no silent eviction**, payload/key/TTL bounds, cleanup sweeper
- PostgreSQL-backed durable JSON values, transactional counters and restart recovery\n- Automated unit tests, PostgreSQL integration tests and Dockerfile

## Local start

```bash
cp .env.example .env
# Load environment in your shell or export the variables manually:
set -a; source .env; set +a
npm start
```

On PowerShell set `$env:CACHELOOM_API_KEYS='{"demo":"<YOUR-32-CHAR-RANDOM-SECRET>"}'` then `npm start`.

Generate a local secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Verify:

```bash
curl http://127.0.0.1:8080/health
curl -X POST http://127.0.0.1:8080/v1/kv \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $YOUR_SECRET" \
  -d '{"command":"SET","key":"greeting","value":"Hello!","ttlSeconds":60}'
```

JavaScript SDK:

```js
import { CacheloomClient } from './sdk/client.js';
const cache = new CacheloomClient({ url: 'http://127.0.0.1:8080', apiKey: process.env.CACHELOOM_KEY });
await cache.set('hello', { message: 'world' }, { ttlSeconds: 60 });
console.log(await cache.get('hello'));
console.log(await cache.incr('visits'));
```

Run tests: `npm test`. GitHub Actions tests Node.js 20, 22 and 24 on each change.

## PostgreSQL mode (v0.2.0)

Use an existing PostgreSQL instance or a free local Docker PostgreSQL container:

```bash
docker run --name cacheloom-postgres \
  -e POSTGRES_PASSWORD=local-dev-password \
  -e POSTGRES_DB=cacheloom -p 5432:5432 -d postgres:16
npm install
export DATABASE_URL='postgresql://postgres:local-dev-password@localhost:5432/cacheloom'
npm run migrate
export CACHELOOM_STORAGE=postgres
export CACHELOOM_API_KEYS='{"demo":"replace-this-with-a-random-secret-at-least-32-characters"}'
npm start
```

Run migrations explicitly before startup, including when deploying with Docker. The API deliberately does not create tables on boot.

`CACHELOOM_STORAGE=memory` (the default) retains the original in-process cache. `postgres` stores the same JSON values in `cacheloom_kv`. TTL and conditional writes use PostgreSQL's clock. Counters use a database transaction and advisory lock to avoid lost updates across instances.

For an external database, configure its required TLS parameters and network access. Do not expose the API to the internet without HTTPS, rate limiting, and secret management. PostgreSQL durability depends on database availability, backups and provider limits.

Test with `npm test`. CI also runs `npm run test:postgres` against disposable PostgreSQL 16. The database backend is not a high-throughput in-memory Redis substitute.

## Security and architecture limits

- Bind to `127.0.0.1` by default. Public deployment requires TLS/reverse proxy, firewall, rate limits and secret management.
- `/health` is unauthenticated; all KV commands require bearer authentication.
- Memory mode loses all values on shutdown; PostgreSQL mode keeps committed key/value data. The PostgreSQL backend includes a durable, at-least-once job queue; memory mode has no queue.
- Memory mode is single-process. PostgreSQL mode can share state between API instances, but lacks production-grade admission control and load testing.
- No RESP, Redis scripting, transactions, clustering, pub/sub or BullMQ compatibility.
- No paid services required to develop and test. PostgreSQL mode uses the open-source `pg` driver and whichever database you configure.

## Roadmap

1. **M1 (completed):** Core key-value operations, TTL, auth, JS SDK and tests.
2. **M2:** PostgreSQL-backed durable keyspace for sessions and distributed rate limits; key rotation and quotas.
3. **M3 (implemented, experimental):** Persistent SQL job queue using `FOR UPDATE SKIP LOCKED`, fenced leases, retries, scheduling and dead letters.
4. **M4 (in progress):** Reusable worker SDK, queue metrics and monitoring page; RESP2 compatibility remains a later milestone.
5. **M5:** Advanced administration, audit logs, backup/restore, operational observability and load testing.

Existing production Auth/Notification services remain unchanged until CacheLoom passes security and failure-recovery testing.

## Durable jobs (v0.3.0)

Jobs require `CACHELOOM_STORAGE=postgres` and an explicit `npm run migrate`.
The schema is shared with the key/value store, but each API key is restricted to
its own project's jobs. Storage and delivery are **at least once**, not exactly once.

```js
import { CacheloomClient } from './sdk/client.js';

const client = new CacheloomClient({
  url: 'http://127.0.0.1:8080', apiKey: process.env.CACHELOOM_KEY,
});

// A stable idempotency key prevents duplicate enqueue requests.
const created = await client.enqueue('emails', { recipient: 'user@example.test' }, {
  idempotencyKey: 'registration:user-123',
  maxAttempts: 3, delaySeconds: 10, priority: 10,
});

// Put this loop in a dedicated worker process, not in your API request handler.
const [job] = await client.claim('emails', { limit: 1, leaseSeconds: 60 });
if (job) {
  try {
    // Your handler must be idempotent: after a crash, this job may run twice.
    await processEmail(job.payload);
    const acknowledged = await client.acknowledge(job.id, job.lease_token);
    if (!acknowledged) console.warn('Lease expired before acknowledgement');
  } catch (error) {
    await client.fail(job.id, job.lease_token, 'Email delivery failed', {
      retryable: true, retryDelaySeconds: 15,
    });
  }
}
```

Supported `POST /v1/jobs` commands: `ENQUEUE`, `CLAIM`, `ACK`,
`FAIL`, `EXTEND`, `GET`, `CANCEL`, and `REPLAY`. Request bodies are
JSON, protected by a project API key. Jobs can be scheduled up to 30 days ahead.
Workers may extend an active lease, but an expired worker cannot ACK/FAIL
a reclaimed job. Priority is higher number first; each claim is bounded to
25 jobs. Persistent dedupe keys remain reserved even after completion.

**Limitations:** No BullMQ protocol compatibility, push notifications,
distributed cron, consumer quotas, job archival/retention, or automatic
handler isolation yet. `REPLAY` is intentionally limited to dead jobs.
A lost lease may mean the side effect ran before the worker crashed, so use
an idempotent handler and avoid blind retries of non-idempotent SMTP sends.
The free database and hosting plans have limits: use modest polling intervals,
monitor compute/storage use, and do not point CI at a production database.

## Worker SDK and monitoring (v0.4.0)

`CacheloomWorker` polls the durable queue, runs handlers concurrently, renews their
leases, and drains active jobs on shutdown. A handler receives an `AbortSignal`
when ownership is lost or the shutdown deadline expires. **The signal cannot undo
side effects that already happened**, so each external effect still needs its own
idempotency key.

```js
import { CacheloomClient } from './sdk/client.js';
import { CacheloomWorker } from './sdk/worker.js';

const client = new CacheloomClient({
  url: 'http://127.0.0.1:8080', apiKey: process.env.CACHELOOM_KEY,
});
const worker = new CacheloomWorker({
  client, queue: 'emails', concurrency: 2, leaseSeconds: 60,
  pollIntervalMs: 2000,
  handler: async (payload, { job, signal }) => {
    // Pass job.id to your provider as an idempotency key where possible.
    await sendEmail(payload, { signal, idempotencyKey: job.id });
  },
  onError: error => console.error('[emails]', error),
});
worker.start();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void worker.stop({ timeoutMs: 30000 }).then(({ drained }) => {
      if (!drained) process.exitCode = 1;
    });
  });
}
```

The worker is a separate Node.js process, not an API server route. Keep the
handler responsive to cancellation and monitor `lease-lost` events.

**Queue dashboard:** Open `/dashboard` on your CacheLoom server. Enter a
project API key to view queue counts and recent jobs without seeing payloads.
The key stays in the page's memory and is cleared manually; it is not stored
in browser storage. Use HTTPS and a trusted reverse proxy for any remote access.

The SDK also supports:

```js
const metrics = await client.queueMetrics('emails');
const recent = await client.listJobs({ queue: 'emails', status: 'dead', limit: 25 });
```

**Current limitations:** The dashboard is read-only, the worker SDK does not
guarantee exactly-once execution, and free PostgreSQL hosting can impose usage
and connection limits. No production Auth/Notification migration has happened.
