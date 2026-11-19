import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_STAGING_QUEUE, prepareNotificationJob,
  createNotificationStagingHandler,
} from '../integrations/notification-staging.js';

const event = {
  outboxId: 'outbox-abc-123', notificationId: 'notification-456',
  scheduledFor: '2026-11-19T12:01:00Z', priority: 7,
};
test('staging relay maps outbox identity and scheduling without personal data', () => {
  const mapped = prepareNotificationJob(event, { now: Date.parse('2026-11-19T12:00:00Z') });
  assert.equal(mapped.queue, NOTIFICATION_STAGING_QUEUE);
  assert.deepEqual(mapped.payload, { notificationId: event.notificationId, outboxId: event.outboxId });
  assert.deepEqual(mapped.options, {
    idempotencyKey: event.outboxId, priority: 7, delaySeconds: 60, maxAttempts: 3,
  });
  assert.equal(JSON.stringify(mapped).includes('recipient'), false);
});
test('invalid identifiers and schedules are rejected before enqueue', () => {
  assert.throws(() => prepareNotificationJob({ ...event, outboxId: '' }), /outbox ID/);
  assert.throws(() => prepareNotificationJob({ ...event, scheduledFor: 'not-a-date' }), /scheduled date/);
  assert.throws(() => prepareNotificationJob({ ...event, priority: 99999 }), /priority/);
  assert.throws(() => prepareNotificationJob({ ...event, scheduledFor: '2027-11-19T12:00:00Z' },
    { now: Date.parse('2026-11-19T12:00:00Z') }), /30-day/);
});
test('terminal notification states are never dispatched by the simulation', async () => {
  const attempts = [];
  const handler = createNotificationStagingHandler({
    inspect: async () => ({ status: 'sent' }),
    onSimulatedDelivery: async event => attempts.push(event),
  });
  const result = await handler({ notificationId: 'n1', outboxId: 'o1' },
    { job: { id: 'j1', attempts: 1 }, signal: new AbortController().signal });
  assert.deepEqual(result, { skipped: true, status: 'sent' });
  assert.equal(attempts.length, 0);
});
test('only eligible notifications trigger a simulated delivery', async () => {
  const attempts = [];
  const handler = createNotificationStagingHandler({
    inspect: async () => ({ status: 'queued' }),
    onSimulatedDelivery: async data => attempts.push(data),
  });
  assert.deepEqual(await handler({ notificationId: 'n1', outboxId: 'o1' },
    { job: { id: 'j1', attempts: 1 }, signal: new AbortController().signal }),
    { simulated: true });
  assert.deepEqual(attempts, [{
    notificationId: 'n1', outboxId: 'o1', jobId: 'j1', attempt: 1,
  }]);
});
