import http from 'node:http';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VolatileStore } from './store.js';

const MAX_BODY = 64 * 1024;
const MAX_VALUE = 32 * 1024;
const MAX_TTL = 30 * 24 * 60 * 60;
const MAX_KEY_LENGTH = 256;

function failure(res, code, error) { send(res, code, { error }); }
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function parseKeys(input) {
  if (!input) throw new Error('CACHELOOM_API_KEYS is required');
  const data = JSON.parse(input);
  if (!data || Array.isArray(data) || typeof data !== 'object' || !Object.keys(data).length) throw new Error('Invalid key map');
  const entries = Object.entries(data);
  for (const [project, key] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project) || typeof key !== 'string' || key.length < 32) {
      throw new Error('Each project needs a valid ID and a secret of at least 32 characters');
    }
  }
  return entries.map(([project, secret]) => ({ project, digest: crypto.createHash('sha256').update(secret).digest() }));
}
function authenticate(header, keys) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!token || token.length > 512) return null;
  const digest = crypto.createHash('sha256').update(token).digest();
  for (const item of keys) if (crypto.timingSafeEqual(digest, item.digest)) return item.project;
  return null;
}
function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH; }
function validTTL(n) { return Number.isSafeInteger(n) && n >= 1 && n <= MAX_TTL; }
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { rejected = true; reject(Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createCacheloomServer({ keys, maxKeys = 10000, store = new VolatileStore({ maxKeys }) }) {
  const authKeys = Array.isArray(keys) ? keys : parseKeys(keys);
  const interval = setInterval(() => {
    // A temporary database outage should never become an unhandled timer error.
    void Promise.resolve().then(() => store.sweep())
      .catch(() => console.error('[cacheloom] expiry cleanup failed'));
  }, 60000);
  interval.unref();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') return send(res, 200, { status: 'up' });
      if (req.url === '/ready' && req.method === 'GET') {
        try {
          if (store.ping) await store.ping();
          return send(res, 200, { status: 'ready' });
        } catch {
          return failure(res, 503, 'STORAGE_UNAVAILABLE');
        }
      }
      if (req.url !== '/v1/kv' || req.method !== 'POST') return failure(res, 404, 'NOT_FOUND');
      const project = authenticate(req.headers.authorization, authKeys);
      if (!project) return failure(res, 401, 'UNAUTHORIZED');
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return failure(res, 415, 'CONTENT_TYPE_REQUIRED');
      const body = await readJSON(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !validKey(body.key)) return failure(res, 400, 'INVALID_KEY');
      // PostgreSQL TEXT cannot store a NUL byte, so encode the user key.
      const key = `${project}:${Buffer.from(body.key).toString('base64url')}`;
      let result;
      switch (body.command) {
        case 'GET': result = await store.get(key); break;
        case 'SET': {
          if (!Object.hasOwn(body, 'value') || body.value === undefined) return failure(res, 400, 'VALUE_REQUIRED');
          if (Buffer.byteLength(JSON.stringify(body.value)) > MAX_VALUE) return failure(res, 413, 'VALUE_TOO_LARGE');
          if (body.ttlSeconds !== undefined && !validTTL(body.ttlSeconds)) return failure(res, 400, 'INVALID_TTL');
          if (body.nx !== undefined && typeof body.nx !== 'boolean') return failure(res, 400, 'INVALID_NX');
          if (body.xx !== undefined && typeof body.xx !== 'boolean') return failure(res, 400, 'INVALID_XX');
          result = await store.set(key, body.value, { ttlSeconds: body.ttlSeconds, nx: body.nx, xx: body.xx });
          break;
        }
        case 'DEL': result = await store.del(key); break;
        case 'EXPIRE':
          if (!validTTL(body.ttlSeconds)) return failure(res, 400, 'INVALID_TTL');
          result = await store.expire(key, body.ttlSeconds); break;
        case 'TTL': result = await store.ttl(key); break;
        case 'INCR':
          if (body.by !== undefined && !Number.isSafeInteger(body.by)) return failure(res, 400, 'INVALID_INCREMENT');
          result = await store.incr(key, body.by ?? 1); break;
        default: return failure(res, 400, 'UNKNOWN_COMMAND');
      }
      send(res, 200, { result });
    } catch (error) {
      const status = error.status ||
        ({ STORE_CAPACITY_EXCEEDED: 507, VALUE_NOT_INTEGER: 409 }[error.message] ?? (error.code ? 503 : 400));
      if (status >= 500) console.error('[cacheloom] request could not be completed:', status);
      if (!res.headersSent && !res.destroyed) {
        failure(res, status, status === 400 ? 'INVALID_REQUEST'
          : status === 503 ? 'STORAGE_UNAVAILABLE' : error.message);
      }
    }
  });
  server.on('close', () => clearInterval(interval));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const backend = process.env.CACHELOOM_STORAGE ?? 'memory';
  if (!['memory', 'postgres'].includes(backend))
    throw new Error('CACHELOOM_STORAGE must be memory or postgres');
  const store = backend === 'postgres'
    ? (await import('./pg-store.js')).createPostgresStore({ connectionString: process.env.DATABASE_URL })
    : new VolatileStore({ maxKeys: Number(process.env.MAX_KEYS ?? 10000) });
  if (store.ping) await store.ping();
  const server = createCacheloomServer({ keys: process.env.CACHELOOM_API_KEYS, store });
  server.listen(port, host, () => console.log(`[cacheloom] ${backend} backend listening on ${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { void Promise.resolve(store.close?.()).then(() => process.exit(0)); });
  });
}
