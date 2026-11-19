import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareNotificationJob,
  createNotificationStagingHandler,
  NOTIFICATION_STAGING_QUEUE,
} from '../integrations/notification-staging.js';

test('Notification Service staging shadow uses the exact HTTP job contract', () => {
  const outboxId = '5c486c18-6727-47d1-8703-11e460516e7e';
  const notificationId = 'ebf889ee-01b9-4b5c-8443-72816208ee6b';
  const mapped = prepareNotificationJob({
    outboxId, notificationId, priority: 7,
    scheduledFor: '2026-11-19T12:01:00Z',
    recipient: 'private@example.test', // This value must never leave the original service.
  }, { now: Date.parse('2026-11-19T12:00:00Z') });
  assert.equal(mapped.queue, NOTIFICATION_STAGING_QUEUE);
  assert.deepEqual({ command: 'ENQUEUE', queue: mapped.queue, ...mapped.payload,
    ...mapped.options }, {
    command: 'ENQUEUE',
    queue: NOTIFICATION_STAGING_QUEUE,
    notificationId,
    outboxId,
    idempotencyKey: outboxId,
    priority: 7,
    maxAttempts: 3,
    delaySeconds: 60,
  });
  assert.equal(JSON.stringify(mapped).includes('private@example.test'), false);
});

test('unknown and processing notifications never simulate a provider send', async () => {
  const attempts = [];
  for (const status of ['unknown', 'processing', 'cancelled']) {
    const handler = createNotificationStagingHandler({
      inspect: async () => ({ status }),
      onSimulatedDelivery: async event => attempts.push(event),
    });
    const payload = { notificationId: 'notification-1', outboxId: 'outbox-1' };
    const context = { job: { id: 'job-1', attempts: 1 }, signal: new AbortController().signal };
    if (status === 'processing') {
      await assert.rejects(() => handler(payload, context), /not safe to simulate/);
    } else {
      assert.equal((await handler(payload, context)).skipped, true);
    }
  }
  assert.equal(attempts.length, 0);
});

test('distinct recovered outbox events receive distinct idempotency keys', () => {
  const notificationId = 'notification-1';
  const first = prepareNotificationJob({ notificationId, outboxId: 'outbox-first' });
  const afterRedisLoss = prepareNotificationJob({ notificationId, outboxId: 'outbox-recovery' });
  assert.notEqual(first.options.idempotencyKey, afterRedisLoss.options.idempotencyKey);
  assert.equal(first.payload.notificationId, afterRedisLoss.payload.notificationId);
});
