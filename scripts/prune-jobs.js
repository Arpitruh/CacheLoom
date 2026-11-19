import { Pool } from 'pg';
import { PostgresJobQueue } from '../src/job-queue.js';

const project = process.env.CACHELOOM_PROJECT;
const url = process.env.DATABASE_URL;
const days = Number(process.env.CACHELOOM_RETENTION_DAYS ?? 30);
const apply = process.argv.includes('--apply');

if (!url || !project || !/^[a-zA-Z0-9_-]{1,64}$/.test(project))
  throw new Error('Set DATABASE_URL and a valid CACHELOOM_PROJECT');
if (!Number.isSafeInteger(days) || days < 1 || days > 3650)
  throw new Error('CACHELOOM_RETENTION_DAYS must be between 1 and 3650');

// Cleanup is intentionally manual. It releases idempotency keys for deleted
// records; do not run it until downstream replay windows have closed.
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
try {
  const queue = new PostgresJobQueue({ pool });
  const preview = await queue.prune({ project, olderThanDays: days, dryRun: true });
  console.log('[cacheloom] eligible terminal jobs:', preview.eligible);
  if (!apply) {
    console.log('[cacheloom] dry run. Pass --apply to delete at most 500 jobs.');
  } else {
    const result = await queue.prune({ project, olderThanDays: days, dryRun: false });
    console.log('[cacheloom] deleted terminal jobs:', result.deleted);
  }
} finally {
  await pool.end();
}
