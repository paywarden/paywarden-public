import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerFrontendRoutes } from '../api/frontend.js';

describe('production frontend routing', () => {
  const app = Fastify();
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paywarden-frontend-'));
    const dashboardRoot = join(root, 'dashboard');
    const checkoutRoot = join(root, 'checkout');
    await mkdir(dashboardRoot);
    await mkdir(checkoutRoot);
    await writeFile(join(dashboardRoot, 'index.html'), '<title>Admin</title>');
    await writeFile(join(checkoutRoot, 'index.html'), '<title>Checkout</title>');
    await writeFile(join(checkoutRoot, 'app.js'), 'checkout();');
    await registerFrontendRoutes(app, { dashboardRoot, checkoutRoot });
  });

  afterAll(async () => {
    await app.close();
    if (root) {
      const target = resolve(root);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('paywarden-frontend-')
      ) {
        throw new Error('Unexpected frontend fixture directory');
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it('serves the checkout entry point for an order URL', async () => {
    const res = await app.inject('/checkout/11111111-1111-4111-8111-111111111111');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<title>Checkout</title>');
  });

  it('keeps dashboard deep links on the admin entry point', async () => {
    const res = await app.inject('/admin/orders/example');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<title>Admin</title>');
  });

  it('serves checkout assets from the checkout directory', async () => {
    expect((await app.inject('/checkout/app.js')).body).toBe('checkout();');
  });

  it('does not turn missing API endpoints into an HTML response', async () => {
    const res = await app.inject('/api/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
