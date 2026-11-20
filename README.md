# CacheLoom

**Build infrastructure you own.** A free, self-hostable foundation for a multi-project cache, session, and job platform.

> **Project status (20 November 2026): Paused / archived in place.** The code remains available for learning, local testing and future development, but active deployment and production rollout are on hold. Latest version: `v1.0.0-rc.1` (experimental; no stable v1.0 release). CacheLoom is **not Redis-protocol-compatible** and **cannot replace BullMQ without integration changes**. Do not use it for production authentication, sessions or notification queues without completing the release gates below.

## Current state

| Area | Status |
| --- | --- |
| REST API, SDK, caching, TTL, atomic counters | Implemented |
| PostgreSQL persistence, durable queue, worker SDK | Implemented, experimental |
| Dashboard, rate limits, key rotation and recovery tests | Implemented / tested in CI |
| GitHub CI | Passing on the last checked commit (`deb513c`) |
| Oracle Cloud staging | Not deployed; signup/payment verification blocked the plan |
| Northflank staging | Container image built, but deployment was **not healthy** at last inspection: required `CACHELOOM_API_KEYS` was missing |
| Neon staging integration and remote smoke tests | Not verified |
| Stable production release | Not released |

**Deployment note:** A Northflank service was created during staging exploration, but it was restarting with `Error: CACHELOOM_API_KEYS is required`. Do not treat the service URL as a working endpoint or expect continuous availability. Hosting/account resources are **not** automatically stopped or deleted by pausing repository development; review them separately if needed.

**Scope at pause:** No production Auth Service or Notification Service migration was performed. PostgreSQL-backed storage is a pragmatic durable alternative for some use cases, **not** a high-throughput drop-in Redis implementation. Existing local setup, architecture, integration notes and release gates remain documented below.

## Available today

- Dependency-free HTTP server and JavaScript SDK (Node.js >=20); optional PostgreSQL driver for durable storage
- Isolated application keyspaces using per-project bearer tokens
- JSON `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `INCR`
- NX/XX conditionals and optional TTL on SET
- Constant-time API key digest comparisons
- Capacity limit with **no silent eviction**, payload/key/TTL bounds, cleanup sweeper
- PostgreSQL-backed durable JSON values, transactional counters and restart recovery
- Automated unit tests, PostgreSQL integration tests and Dockerfile

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
4. **M4 (implemented, experimental):** Reusable worker SDK, queue metrics and monitoring page; RESP2 compatibility remains a later milestone.
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

## Security and retention (v0.5.0)

CacheLoom accepts either one API key or up to three keys per project:

```bash
export CACHELOOM_API_KEYS='{"auth":["old-secret-with-at-least-32-characters","new-secret-with-at-least-32-characters"]}'
```

Rotate safely: (1) deploy both secrets, (2) update and verify clients,
(3) remove the old secret and restart every API instance. Keys are hashed
in memory. **Do not commit secrets** or include them in logs. Duplicated
secrets across projects are rejected on startup.

`CACHELOOM_PROJECT_RPM=600` caps authenticated requests per project
**across all PostgreSQL-backed replicas** using one atomic database row per
project per minute. In memory mode the guard remains per instance. This is
a fixed-window limit, not a billing system or a fine-grained user-level quota.
A global limit increases database write traffic, so monitor the free tier. Restrict
network exposure and use HTTPS before putting the service online.

### Job retention

Old completed and cancelled jobs can be pruned in limited batches; dead,
pending and running jobs are never deleted by this command. It defaults
to a dry run:

```bash
export CACHELOOM_PROJECT=auth
export CACHELOOM_RETENTION_DAYS=30
npm run prune:jobs
npm run prune:jobs -- --apply
```

**Warning:** Deleting jobs also releases their original idempotency keys.
Choose a retention window longer than the longest client retry/replay window.
Back up the database before enabling deletion. There is no automatic pruning.

### PostgreSQL backup and recovery runbook

For local PostgreSQL with standard tools installed:

```bash
# Use a trusted host and keep database credentials out of shell history.
pg_dump --format=custom --no-owner --file=cacheloom.backup "$DATABASE_URL"

# Restore only into a fresh, isolated database first.
pg_restore --no-owner --dbname="$RESTORE_DATABASE_URL" cacheloom.backup
```

After restoring, run `npm run migrate` using the restored database URL,
then verify `/ready`, a sample key read and queue status/metrics. Never
overwrite a live database during a rehearsal. Confirm backups are encrypted,
access-controlled, and regularly tested; `pg_dump` by itself is not a
managed backup service. Database restoration may replay recently accepted jobs;
external side effects must remain idempotent.

CacheLoom continues to be experimental. No production migration or paid
service is included in this release.

## Distributed quotas and recovery checks (v0.6.0)

With `CACHELOOM_STORAGE=postgres`, `CACHELOOM_PROJECT_RPM` is an atomic
per-project fixed-window request budget shared across every API replica using
the same database. Request admission fails closed if the database counter
cannot be updated. This trades some PostgreSQL write overhead for a consistent
global limit. Memory mode still uses an inexpensive per-instance counter.

Run `npm run migrate` before restarting a PostgreSQL-backed service to create
the `cacheloom_rate_limits` table. CI tests competing requests across two
independent connection pools and verifies that the limit cannot be exceeded.
Counter cleanup is available through the `PostgresRateLimiter.prune()` API;
automatic pruning is not enabled.

### Simulated worker recovery

PostgreSQL integration tests simulate a worker disappearing with a running
job, then a second queue instance reclaiming the expired lease. The old
worker's acknowledgement is rejected. This is not a full disaster-recovery or
database-restore test and does not guarantee exactly-once external delivery.

### Local load test

Start a disposable local CacheLoom instance connected to a disposable
PostgreSQL database. Then run:

```bash
export CACHELOOM_KEY='your-local-test-secret'
CACHELOOM_BENCH_REQUESTS=100 CACHELOOM_BENCH_CONCURRENCY=5 npm run bench:local
```

The benchmark only accepts localhost addresses and reports throughput,
p50/p95/p99 timings and failures. It creates delayed jobs in the database,
which you should remove from the disposable test database afterward.
It is **not** a published performance benchmark or a production capacity
claim. Rate limits apply during benchmarking; choose a test-only budget.

No paid service or production Notification/Auth migration is part of v0.6.

## Restore verification, audited replay and performance checks (v0.7.0)

### Verified PostgreSQL restoration in CI

GitHub Actions now seeds test-only key/value, job, and rate-limit records,
takes a `pg_dump` custom-format backup, restores into a **separate**
`cacheloom_restore_test` database, and verifies that the restored job can
be claimed and acknowledged. This is a repeatable, disposable restore drill,
not a guarantee about a particular hosted backup provider or its retention.

CI never connects to a production database for this test. The restore
fixture refuses any database URL without the expected test database name.

### Audited manual replay

A dead job may have already triggered an external side effect before the
original worker lost its lease. Replaying it requires an operator reason
(10–300 characters) and explicit acceptance of the duplicate-risk tradeoff.

```js
await client.replayJob(
  jobId,
  'Checked provider records and confirmed that no notification was sent',
  true, // The operator accepts potential duplicate-delivery risk.
);
const recentReplayReasons = await client.replayAudit(25);
```

Both the status change and audit record are committed in the same SQL
transaction. Only successful replays write audit rows, and the history is
scoped to the authenticated project. **Breaking API change:** old calls to
`REPLAY` without a reason and acknowledgment are rejected.

### Local performance exercise

```bash
# Disposable cacheloom_test database ONLY. Run migrations first.
CACHELOOM_BENCH_TEST=1 BENCH_JOBS=100 npm run bench:pg
```

The benchmark covers enqueue → claim → acknowledgment and reports total
duration and claim-batch p50/p95. It cleans up its own test jobs, and does
not establish production capacity. CI runs a small bounded version on
PostgreSQL 16. Test database credentials and TLS should remain securely
configured; never run the benchmark against hosted production data.

**Still to do before production migration:** repeat restore drills against
your actual staging infrastructure; measure representative multi-worker
traffic; add provider-side idempotency checks and operational alerts.

## Notification Service staging bridge (v0.8.0)

CacheLoom now includes a **staging-only** mapping for the current
`Arpitruh/Notification-Service` relay and worker. Its existing relay
publishes an outbox ID, notification ID, scheduled time and priority. The
bridge maps these into a CacheLoom job without carrying recipients, rendered
email, SMTP credentials or template data.

```js
import {
  enqueueNotificationForStaging,
  NOTIFICATION_STAGING_QUEUE,
  createNotificationStagingHandler,
} from './integrations/notification-staging.js';
import { CacheloomWorker } from './sdk/worker.js';

await enqueueNotificationForStaging(client, {
  outboxId: 'outbox-123', notificationId: 'notification-456',
  scheduledFor: new Date(Date.now() + 60_000).toISOString(), priority: 3,
});

// The test handler only records that a delivery WOULD have been attempted.
const handler = createNotificationStagingHandler({
  inspect: async id => stagingNotificationLookup(id),
  onSimulatedDelivery: async event => stagingLog.push(event),
});
new CacheloomWorker({
  client, queue: NOTIFICATION_STAGING_QUEUE,
  handler, pollIntervalMs: 2000,
}).start();
```

### Important differences from the production BullMQ flow

- The PostgreSQL notification outbox and attempt ledger remain authoritative.
  CacheLoom's `idempotencyKey` uses the outbox ID and prevents duplicate
  enqueues **as long as the corresponding CacheLoom record is retained**.
- CacheLoom uses a different job ID and attempt numbering. This adapter does
  **not** implement BullMQ's `Job` interface or its exponential backoff,
  stalled-job behavior, `getJob()` reconciliation, or provider-side guarantees.
- Notification Service currently uses its own delivery claim fence, outcome
  classification and safe handling of uncertain SMTP acceptance. These must
  remain intact before any real provider integration.
- The staging simulation never sends real email or SMS. It is not a real
  Notification Service deployment or a production migration.
- Integration tests use a disposable PostgreSQL database, synthetic
  notification IDs and CacheLoom's actual HTTP/worker paths. No paid services
  or credentials are required.

**Migration gate:** Only consider a feature-flagged staging integration
after adapting Notification Service's relay, readiness, reconciler and worker
to preserve the notification database's delivery safety checks. Prove restart
recovery and provider-acceptance ambiguity with mocked providers before
even discussing a production cutover.

## Notification Service contract checks (v0.9.0)

CacheLoom tests now verify the job body produced by the new
non-production Notification Service mirror, including nested metadata-only
payloads, outbox-ID deduplication, and notification state handling.

See [Notification Service staging PR #12](https://github.com/Arpitruh/Notification-Service/pull/12).
That draft adds a feature flag to the **real outbox relay**. BullMQ and
PostgreSQL remain authoritative: the mirror starts only after the outbox
commit and never changes notification status or dispatches email/SMS.
The PR's integration tests exercise Redis job-loss reconciliation against
disposable PostgreSQL and Redis with the CacheLoom request mocked.

This is staging coverage, **not a deployed full end-to-end cutover**.
The Notification Service PR stays unmerged pending a deliberate staging
deployment and review. Production remains on BullMQ/Redis. Do not enable
`CACHELOOM_STAGING_SHADOW` in production.

## v1.0.0-rc.1 release gates

**This is a release candidate, not a production-ready 1.0 release.**
The new CI smoke workflow starts a disposable PostgreSQL 16 server and
verifies readiness, auth, key TTL, idempotent enqueue, claim and ACK via
the real HTTP client.

To run it against a locally controlled staging instance:

```bash
export CACHELOOM_STAGING_URL=http://127.0.0.1:8080
export CACHELOOM_STAGING_KEY='your-32-character-or-longer-test-key'
npm run smoke:staging
```

Remote staging **requires HTTPS** and the explicit environment variable
`CACHELOOM_ALLOW_REMOTE_SMOKE=I_UNDERSTAND_STAGING_ONLY`. Do not point
the smoke script at a production service; it writes disposable keys and jobs.

**Release blockers that remain open:**
- Deploy a real private staging CacheLoom service and rerun smoke checks
  against it (not merely a CI container)
- Verify rollback to BullMQ/Redis using a realistic notification failure
  and test provider-acceptance ambiguity without real outbound messages
- Test multi-worker throughput, free-tier Postgres limits and failure alerts
  for representative workloads
- Audit network exposure, operator permissions, secrets and backup schedules
- Review Notification Service's [draft staging PR](https://github.com/Arpitruh/Notification-Service/pull/12)
  before merging or activating it

Do not replace Auth Service sessions or Notification Service's queue until
these gates are met. CacheLoom does **not** implement the Redis protocol.
