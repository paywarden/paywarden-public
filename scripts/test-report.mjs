#!/usr/bin/env node
/**
 * Auditable test run: executes typecheck, lint and the vitest suite, keeps
 * every raw output on disk, and renders a standalone HTML report from
 * vitest's machine-readable JSON (not from anything hand-written).
 *
 *   node scripts/test-report.mjs [outDir]
 *
 * Artifacts in outDir (default ./test-reports/<timestamp>/):
 *   report.html      human-readable, self-contained
 *   vitest.json      vitest --reporter=json (source of truth for the tables)
 *   junit.xml        vitest --reporter=junit (CI-consumable)
 *   vitest.log       full verbose terminal output
 *   tsc.log / eslint.log
 *   manifest.json    commands, exit codes, git HEAD + dirty files, SHA-256 of every artifact
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const outDir = resolve(process.argv[2] ?? join(root, 'test-reports', stamp));
mkdirSync(outDir, { recursive: true });

const bin = (name) =>
  join(
    root,
    'node_modules',
    {
      tsc: 'typescript/bin/tsc',
      eslint: 'eslint/bin/eslint.js',
      vitest: 'vitest/vitest.mjs',
    }[name],
  );

function run(label, cmd, args, logFile) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [cmd, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `$ ${[basename(cmd), ...args].join(' ')}\n\n${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(join(outDir, logFile), output);
  return {
    label,
    command: [basename(cmd), ...args].join(' '),
    exitCode: res.status,
    durationMs: Date.now() - t0,
    log: logFile,
  };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

const jsonPath = join(outDir, 'vitest.json');
const junitPath = join(outDir, 'junit.xml');

const steps = [
  run('typecheck', bin('tsc'), ['--noEmit'], 'tsc.log'),
  run('lint', bin('eslint'), ['src/'], 'eslint.log'),
  run(
    'vitest',
    bin('vitest'),
    [
      'run',
      ...(process.env.INTEGRATION_DATABASE_URL ? ['--no-file-parallelism', '--testTimeout=15000', '--hookTimeout=30000'] : []),
      '--reporter=verbose',
      '--reporter=json',
      `--outputFile.json=${jsonPath}`,
      '--reporter=junit',
      `--outputFile.junit=${junitPath}`,
    ],
    'vitest.log',
  ),
];

const results = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

const manifest = {
  generatedAt: startedAt.toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  git: {
    head: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(['status', '--porcelain']).split('\n').filter(Boolean),
  },
  steps,
  summary: results
    ? {
        // numTotalTestSuites counts describe blocks; files are testResults entries.
        files: results.testResults.length,
        filesPassed: results.testResults.filter((f) => f.status === 'passed').length,
        filesFailed: results.testResults.filter((f) => f.status === 'failed').length,
        suites: results.numTotalTestSuites,
        tests: results.numTotalTests,
        passed: results.numPassedTests,
        failed: results.numFailedTests,
        skipped: results.numPendingTests + (results.numTodoTests ?? 0),
        success: results.success,
      }
    : null,
  artifacts: {},
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (n) => (n == null ? '' : `${Math.round(n)} ms`);
const rel = (p) => p.replace(root, '').replace(/\\/g, '/').replace(/^\//, '');

function statusTag(s) {
  const cls = s === 'passed' ? 'ok' : s === 'failed' ? 'bad' : 'skip';
  return `<span class="tag ${cls}">${esc(s)}</span>`;
}

let filesHtml = '';
if (results) {
  for (const f of results.testResults) {
    const rows = f.assertionResults
      .map(
        (a) =>
          `<tr><td>${statusTag(a.status)}</td><td>${esc(a.ancestorTitles.join(' › '))}</td><td>${esc(a.title)}</td><td class="num">${ms(a.duration)}</td></tr>` +
          (a.failureMessages?.length
            ? `<tr><td></td><td colspan="3"><pre class="fail">${esc(a.failureMessages.join('\n'))}</pre></td></tr>`
            : ''),
      )
      .join('\n');
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const a of f.assertionResults)
      counts[a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped']++;
    filesHtml += `
<details ${counts.failed ? 'open' : ''}>
  <summary>${statusTag(f.status)} <code>${esc(rel(f.name))}</code> — ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${ms(f.endTime - f.startTime)}</summary>
  <table><thead><tr><th>status</th><th>suite</th><th>test</th><th>duration</th></tr></thead><tbody>${rows}</tbody></table>
</details>`;
  }
}

const stepsHtml = steps
  .map(
    (s) =>
      `<tr><td>${s.exitCode === 0 ? '<span class="tag ok">exit 0</span>' : `<span class="tag bad">exit ${s.exitCode}</span>`}</td><td>${esc(s.label)}</td><td><code>${esc(s.command)}</code></td><td class="num">${ms(s.durationMs)}</td><td><a href="${s.log}">${s.log}</a></td></tr>`,
  )
  .join('\n');

const logs = steps
  .map(
    (s) =>
      `<details><summary><code>${esc(s.log)}</code> (raw output, ${s.label})</summary><pre>${esc(readFileSync(join(outDir, s.log), 'utf8'))}</pre></details>`,
  )
  .join('\n');

const sum = manifest.summary;
const verdict = sum && sum.success && steps.every((s) => s.exitCode === 0) ? 'ok' : 'bad';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayWarden test report ${esc(stamp)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--ink:#e7e9ee;--muted:#9aa3b2;--ok:#22c55e;--bad:#ef4444;--skip:#f59e0b}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px}
.verdict{margin:18px 0;padding:14px 18px;border-radius:10px;border:1px solid var(--line);background:var(--panel)}
.verdict.ok{border-color:#14402a}.verdict.bad{border-color:#4a1a1e}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card .n{font-size:26px;font-weight:700}.card .l{color:var(--muted);font-size:12px}
.n.ok{color:var(--ok)}.n.bad{color:var(--bad)}.n.skip{color:var(--skip)}
table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase}
td.num{text-align:right;white-space:nowrap;color:var(--muted)}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.tag.ok{color:var(--ok);background:#10231a}.tag.bad{color:var(--bad);background:#2a1518}.tag.skip{color:var(--skip);background:#26200f}
code{background:#1e222b;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font:12px ui-monospace,Menlo,monospace}
pre{background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap}
pre.fail{color:#fca5a5}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 14px;margin:10px 0}summary{cursor:pointer;padding:10px 0;font-weight:600}
h2{font-size:17px;margin:32px 0 8px}
a{color:#7dd3fc}
</style></head><body><div class="wrap">
<h1>PayWarden test report</h1>
<div class="sub">generated ${esc(manifest.generatedAt)} · node ${esc(manifest.node)} · ${esc(manifest.platform)} · git <code>${esc(manifest.git.branch)}@${esc(manifest.git.head.slice(0, 12))}</code> · ${manifest.git.dirty.length} uncommitted paths</div>
<div class="verdict ${verdict}"><b>${verdict === 'ok' ? 'ALL GREEN' : 'FAILURES PRESENT'}</b> — every number below is read from <code>vitest.json</code>; raw logs are embedded at the bottom and saved next to this file. <code>manifest.json</code> carries SHA-256 of each artifact.</div>
<div class="grid">
  <div class="card"><div class="n">${sum ? sum.files : '—'}</div><div class="l">test files</div></div>
  <div class="card"><div class="n ok">${sum ? sum.passed : '—'}</div><div class="l">tests passed</div></div>
  <div class="card"><div class="n bad">${sum ? sum.failed : '—'}</div><div class="l">tests failed</div></div>
  <div class="card"><div class="n skip">${sum ? sum.skipped : '—'}</div><div class="l">skipped</div></div>
  <div class="card"><div class="n">${sum ? sum.tests : '—'}</div><div class="l">total</div></div>
</div>
<h2>Steps</h2>
<table><thead><tr><th>result</th><th>step</th><th>command</th><th>duration</th><th>log</th></tr></thead><tbody>${stepsHtml}</tbody></table>
<h2>Uncommitted paths at run time</h2>
<pre>${esc(manifest.git.dirty.join('\n') || '(clean)')}</pre>
<h2>Test files</h2>
${filesHtml || '<p>vitest.json missing — see vitest.log</p>'}
<h2>Raw logs</h2>
${logs}
</div></body></html>`;

writeFileSync(join(outDir, 'report.html'), html);

for (const name of [
  'report.html',
  'vitest.json',
  'junit.xml',
  'vitest.log',
  'tsc.log',
  'eslint.log',
]) {
  const p = join(outDir, name);
  if (existsSync(p))
    manifest.artifacts[name] = createHash('sha256').update(readFileSync(p)).digest('hex');
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const line = sum
  ? `${sum.passed} passed, ${sum.failed} failed, ${sum.skipped} skipped of ${sum.tests} tests in ${sum.files} files`
  : 'vitest produced no JSON';
process.stdout.write(
  `${verdict === 'ok' ? 'OK' : 'FAIL'}: ${line}\nreport: ${join(outDir, 'report.html')}\n`,
);
process.exit(verdict === 'ok' ? 0 : 1);
