# CacheLoom

**Build infrastructure you own.** A free, self-hostable foundation for a multi-project cache, session, and job platform.

> **Status: milestone 1 / experimental.** CacheLoom is **not a Redis protocol implementation** and **cannot replace BullMQ yet**. Current storage is memory-only, single-process, and not durable. Do not migrate production authentication sessions or notification queues to this version.

## Available today

- Dependency-free HTTP server and JavaScript SDK (Node.js >=20)
- Isolated application keyspaces using per-project bearer tokens
- JSON `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `INCR`
- NX/XX conditionals and optional TTL on SET
- Constant-time API key digest comparisons
- Capacity limit with **no silent eviction**, payload/key/TTL bounds, cleanup sweeper
- Automated tests and Dockerfile

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

## Security and architecture limits

- Bind to `127.0.0.1` by default. Public deployment requires TLS/reverse proxy, firewall, rate limits and secret management.
- `/health` is unauthenticated; all KV commands require bearer authentication.
- In-memory data is lost on shutdown. **Do not use for durable sessions, job queues or rate-limit state.**
- Single process; multiple replicas do not share state.
- No RESP, Redis scripting, transactions, clustering, pub/sub or BullMQ compatibility.
- No external runtime dependencies or paid services required for this milestone.

## Roadmap

1. **M1 (current):** Core key-value operations, TTL, auth, JS SDK and tests.
2. **M2:** PostgreSQL-backed durable keyspace for sessions and distributed rate limits; key rotation and quotas.
3. **M3:** Persistent SQL job queue using `FOR UPDATE SKIP LOCKED`, leases, retries, scheduling and dead letters.
4. **M4:** Redis RESP2 subset and command compatibility tests. BullMQ parity is a separate milestone.
5. **M5:** Admin dashboard, metrics, audit logs, backup/restore, observability and load testing.

Existing production Auth/Notification services remain unchanged until CacheLoom passes security and failure-recovery testing.
