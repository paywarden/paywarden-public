import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export async function registerFrontendRoutes(
  app: FastifyInstance,
  roots: { dashboardRoot: string; checkoutRoot: string },
): Promise<void> {
  await app.register(staticPlugin, { root: roots.dashboardRoot, prefix: '/admin' });
  await app.register(staticPlugin, {
    root: roots.checkoutRoot,
    prefix: '/checkout',
    decorateReply: false,
  });

  app.get('/checkout/:order_id(^[0-9a-fA-F-]{36}$)', async (_req, reply) =>
    reply.sendFile('index.html', roots.checkoutRoot),
  );

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url === '/admin' || req.url.startsWith('/admin/')) {
      return reply.sendFile('index.html', roots.dashboardRoot);
    }
    return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
  });
}
