import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const hash = value => createHash('sha256').update(value).digest('hex');
export function fileHash(file) {
  const digest = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try { let length; while ((length = fs.readSync(fd, chunk)) > 0) digest.update(chunk.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
export const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export function cleanRevision() {
  const dirty = git('status', '--porcelain');
  if (dirty) throw new Error('Commit the candidate files before building or validating');
  return git('rev-parse', 'HEAD');
}
export function loadNile() {
  process.loadEnvFile(path.join(root, '.env'));
  if (process.env.TRON_NETWORK !== 'nile' || process.env.USDT_CONTRACT !== 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf') {
    throw new Error('Nile network/contract guard rejected configuration');
  }
}
export function runLog(label, executable, args, dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  fs.writeFileSync(path.join(dir, label + '.log'), log);
  if (result.status !== 0) throw new Error(label + ' failed; inspect its local log');
  return result.stdout?.trim();
}
export function imageInfo(name) {
  const result = JSON.parse(execFileSync('docker', ['image', 'inspect', name], { encoding: 'utf8' }))[0];
  return { reference: name, id: result.Id, revision: result.Config.Labels?.['org.opencontainers.image.revision'] };
}
export function fileHashes(files) {
  return Object.fromEntries(files.map(file => [file.replaceAll('\\', '/'), fileHash(path.join(root, file))]));
}
export function candidateContext(directory) {
  const dir = path.resolve(root, directory);
  if (!dir.startsWith(path.join(root, 'test-reports') + path.sep)) throw new Error('Expected a directory inside test-reports');
  const candidate = read(path.join(dir, 'candidate.json'));
  const secret = read(path.join(dir, 'private', 'runtime.json'));
  const env = { ...process.env, RC_APP_IMAGE: candidate.images.app.id, RC_MIGRATE_IMAGE: candidate.images.migrate.id,
    RC_DB_PASSWORD: secret.databasePassword, RC_PROXY: secret.proxy ?? '', RC_HTTP_PORT: String(candidate.ports.http),
    RC_DB_PORT: String(candidate.ports.postgres), RC_REDIS_PORT: String(candidate.ports.redis), RC_RPC_PORT: String(candidate.ports.rpc),
    RC_WEBHOOK_PORT: String(candidate.ports.webhook) };
  const compose = (...args) => execFileSync('docker', ['compose', '-p', candidate.project, '-f', 'docker-compose.nile-rc.yml', ...args],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, candidate, secret, env, compose };
}
