import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolatileStore } from '../src/store.js';
test('set/get preserves objects and isolation', () => {
  const s = new VolatileStore(); const obj = { nested: { count: 1 } };
  assert.equal(s.set('a', obj), true); obj.nested.count = 12;
  assert.deepEqual(s.get('a'), { nested: { count: 1 } });
  const copy = s.get('a'); copy.nested.count = 200;
  assert.equal(s.get('a').nested.count, 1);
});
test('TTL, NX/XX, expiration', () => {
  let now = 1000; const s = new VolatileStore({ now: () => now });
  assert.equal(s.set('x', 'a', { ttlSeconds: 5 }), true);
  assert.equal(s.ttl('x'), 5);
  assert.equal(s.set('x', 'b', { nx: true }), false);
  assert.equal(s.set('x', 'b', { xx: true }), true);
  now += 6000;
  assert.equal(s.get('x'), 'b');
  assert.equal(s.expire('x', 2), true);
  now += 2000;
  assert.equal(s.get('x'), null);
  assert.equal(s.ttl('x'), -2);
});
test('atomic integer updates preserve TTL', () => {
  let now = 0; const s = new VolatileStore({ now: () => now });
  s.set('n', 4, { ttlSeconds: 10 });
  assert.equal(s.incr('n', 3), 7);
  assert.equal(s.ttl('n'), 10);
  assert.throws(() => s.incr('n', Number.MAX_SAFE_INTEGER), /VALUE_NOT_INTEGER/);
});
test('capacity bounds without silent data eviction', () => {
  const s = new VolatileStore({ maxKeys: 1 }); s.set('one', 1);
  assert.throws(() => s.set('two', 2), /STORE_CAPACITY_EXCEEDED/);
});
