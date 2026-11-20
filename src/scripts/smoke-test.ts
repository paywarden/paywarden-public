import { fetch, Headers } from 'undici';
import { pino } from 'pino';

const log = pino({ name: 'smoke-test' });
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const adminPassword = process.env.ADMIN_PASSWORD;

function fail(message: string): never {
  throw new Error(message);
}

function extractCookie(headers: Headers): string {
  for (const value of headers.getSetCookie()) {
    const token = /^admin_token=([^;]+)/.exec(value)?.[1];
    if (token) return `admin_token=${token}`;
  }
  return fail('Admin login succeeded but no non-empty session cookie was returned');
}

async function checkPublicHealth(): Promise<void> {
  // Public /api/v1/health is intentionally minimal — only {status} —
  // because the detailed breakdown leaks deployment internals to anyone
  // hitting the LB. The smoke test still asserts a public 200 here as a
  // basic liveness probe; the per-component breakdown is now checked via
  // the admin /admin/health endpoint below.
  const res = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) fail(`Public health check failed with HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string };
  if (body.status !== 'ok') fail(`Public health status is ${body.status ?? 'unknown'}`);
}

async function checkAdminHealth(cookie: string): Promise<void> {
  // Detailed health (DB / Redis / TronGrid / wallet / watcher / chain
  // metadata) moved behind admin auth — fetch it with the smoke-test
  // session cookie and run the same per-check assertions the public
  // endpoint used to enforce.
  const res = await fetch(`${baseUrl}/api/v1/admin/health`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) fail(`Admin health check failed with HTTP ${res.status}`);
  const body = (await res.json()) as {
    status?: string;
    checks?: Record<string, string>;
    system?: Record<string, unknown>;
  };

  if (body.status !== 'ok') fail(`Admin health status is ${body.status ?? 'unknown'}`);
  const checks = body.checks ?? {};
  for (const [key, expected] of Object.entries({
    database: 'connected',
    redis: 'connected',
    watcher: 'running',
    wallet: 'initialized',
  })) {
    if (checks[key] !== expected) fail(`Admin health ${key}=${checks[key] ?? 'missing'} expected ${expected}`);
  }
  if (checks.trongrid !== 'reachable') fail(`Admin health trongrid=${checks.trongrid ?? 'missing'} expected reachable`);
  if (!body.system?.tronNetwork) fail('Admin health system metadata missing tronNetwork');
}

async function loginAdmin(): Promise<string> {
  if (!adminPassword) fail('ADMIN_PASSWORD is required for smoke test');

  const res = await fetch(`${baseUrl}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) fail(`Admin login failed with HTTP ${res.status}`);
  return extractCookie(res.headers);
}

async function checkAdmin(cookie: string): Promise<void> {
  const commonHeaders = {
    Cookie: cookie,
    Accept: 'application/json',
  };

  const statsRes = await fetch(`${baseUrl}/api/v1/admin/stats`, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(10_000),
  });
  if (!statsRes.ok) fail(`Admin stats failed with HTTP ${statsRes.status}`);

  const walletRes = await fetch(`${baseUrl}/api/v1/admin/wallet`, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(10_000),
  });
  if (!walletRes.ok) fail(`Admin wallet failed with HTTP ${walletRes.status}`);
  const wallet = (await walletRes.json()) as { system?: Record<string, unknown> };
  if (!wallet.system?.tron_network) fail('Admin wallet response missing system.tron_network');

  const ordersRes = await fetch(`${baseUrl}/api/v1/admin/orders`, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(10_000),
  });
  if (!ordersRes.ok) fail(`Admin orders failed with HTTP ${ordersRes.status}`);
}

async function main(): Promise<void> {
  log.info({ baseUrl }, 'starting smoke test');
  await checkPublicHealth();
  log.info('public health ok');

  const cookie = await loginAdmin();
  log.info('admin login ok');

  await checkAdminHealth(cookie);
  log.info('admin health ok');

  await checkAdmin(cookie);
  log.info('admin endpoints ok');

  log.info('smoke test passed');
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : err }, 'smoke test failed');
  process.exit(1);
});
