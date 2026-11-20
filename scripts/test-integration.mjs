import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.INTEGRATION_DATABASE_URL || !process.env.INTEGRATION_REDIS_URL) {
  console.error(
    'Set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_URL to disposable services. Tests migrate/truncate PostgreSQL and flush the Redis database.',
  );
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    'src/__tests__/integration',
    '--no-file-parallelism',
    '--testTimeout=15000',
    '--hookTimeout=30000',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
