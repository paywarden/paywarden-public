import path from 'node:path';
import { root, git, read, write, runLog, fileHash } from './common.mjs';
import { requireGreenBaseline } from './policy.mjs';

if (!process.env.INTEGRATION_DATABASE_URL || !process.env.INTEGRATION_REDIS_URL) throw new Error('Disposable PostgreSQL and Redis services are required');
const dir = path.join(root, 'test-reports/ci-' + (process.env.GITHUB_RUN_ID ?? Date.now()));
const revision = git('rev-parse', 'HEAD');
const tracked = git('ls-files', 'src', 'checkout/src', 'dashboard/src').split('\n').filter(file => /\.test\.tsx?$/.test(file));
const normalize = file => path.resolve(root, file).replaceAll('\\', '/').toLowerCase();
const expected = new Set(tracked.map(normalize));
const files = JSON.parse(runLog('discovery', process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json'], dir));
if (files.length !== expected.size || files.some(row => !expected.has(normalize(row.file)))) throw new Error('Unexpected test discovery');
runLog('architecture', process.execPath, ['scripts/release/architecture.mjs'], dir);
runLog('release-policy', process.execPath, ['--test', 'scripts/release/policy.test.mjs', 'scripts/release/checks.mjs'], dir);
runLog('tests', process.execPath, ['scripts/test-report.mjs', path.join(dir, 'baseline')], dir);
const baseline = read(path.join(dir, 'baseline/manifest.json'));
requireGreenBaseline(baseline, revision, expected.size);
runLog('backend-build', process.execPath, ['node_modules/typescript/bin/tsc'], dir);
for (const project of ['checkout', 'dashboard']) {
  const cwd = path.join(root, project);
  runLog(project + '-typecheck', process.execPath, [path.join(cwd, 'node_modules/typescript/bin/tsc'), '-b'], dir, { cwd });
  runLog(project + '-build', process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), 'build'], dir, { cwd });
}
write(path.join(dir, 'validation.json'), { revision, passed: true, sourceTestFiles: expected.size, summary: baseline.summary,
  baselineManifestHash: fileHash(path.join(dir, 'baseline/manifest.json')), builds: ['backend', 'checkout', 'dashboard'] });
console.log(JSON.stringify({ passed: true, revision, tests: baseline.summary.passed, skipped: baseline.summary.skipped }));
