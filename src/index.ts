import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { registerFrontendRoutes } from './api/frontend.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Redis } from 'ioredis';

import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { checkDbConnection, closeDb } from './db/index.js';
import { seedDefaultMerchantIfEmpty } from './db/seed-default-merchant.js';
import { WalletService } from './services/wallet.js';
import { OrderEngine } from './services/order-engine.js';
import { WebhookNotifier, initWebhookWorker, closeWebhookWorker } from './services/webhook-notifier.js';
import { startRecoveryMonitor } from './services/recovery-monitor.js';
import { initChainWatcher, startChainWatcher, rebuildPendingAddressSet, closeChainWatcher } from './services/chain-watcher.js';
import { GasManager, createTronWeb } from './services/gas-manager.js';
import { FundSweeper } from './services/fund-sweeper.js';
import { Notifier } from './services/notifier.js';
import { errorHandler } from './api/middleware/error-handler.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerPaymentRoutes } from './api/routes/payments.js';
import { registerWalletRoutes } from './api/routes/wallet.js';
import { registerMerchantRoutes } from './api/routes/merchants.js';
import { registerDebugRoutes } from './api/routes/debug.js';
import { registerAdminRoutes } from './api/routes/admin.js';
import { registerCheckoutRoutes } from './api/routes/checkout.js';
import { registerDemoRoutes } from './api/routes/demo.js';
import { registerMerchantAddressRoutes } from './api/routes/merchant-addresses.js';

async function main(): Promise<void> {
  logger.info({ addressMode: env.ADDRESS_MODE }, 'Starting PayWarden...');

  // 1. Connect database
  try {
    await checkDbConnection();
    logger.info('Database connected');
    await seedDefaultMerchantIfEmpty();
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to database');
    process.exit(1);
  }

  // 2. Connect Redis
  let redis: InstanceType<typeof Redis>;
  try {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    await redis.ping();
    logger.info('Redis connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to Redis');
    process.exit(1);
  }

  // 3. Init services
  const wallet = new WalletService();
  if (env.ADDRESS_MODE === 'hd') {
    await wallet.init();
  } else {
    logger.info('Static-address mode — HD wallet, vault and sweep are disabled');
  }

  const tronWeb = createTronWeb();
  const gasManager = new GasManager(tronWeb);
  const fundSweeper = new FundSweeper(wallet, gasManager, env.REDIS_URL);
  fundSweeper.init();

  if (fundSweeper.isSweepEnabled()) {
    logger.info('Fund sweep enabled (HOT_WALLET_KEY + COLD_WALLET_ADDRESS configured)');
  } else {
    logger.info('Fund sweep disabled — set HOT_WALLET_KEY and COLD_WALLET_ADDRESS to enable');
  }

  const notifier = new Notifier();

  gasManager.setNotifier(notifier);
  fundSweeper.setNotifier(notifier);

  const webhookNotifier = new WebhookNotifier();
  const orderEngine = new OrderEngine(wallet, webhookNotifier, fundSweeper);
  orderEngine.setRedis(redis);
  orderEngine.setNotifier(notifier);

  // 4. Init webhook worker with callbacks
  initWebhookWorker(
    env.REDIS_URL,
    (orderId, details) => orderEngine.markWebhookCompleted(orderId, details),
    (orderId, details) => orderEngine.markWebhookFailed(orderId, details),
  );

  // 5. Rebuild pending_addresses Set + Init chain watcher
  await rebuildPendingAddressSet(redis);
  initChainWatcher(env.REDIS_URL, orderEngine, redis);

  // 6. Build Fastify app
  const app = Fastify({
    logger: false, // use pino directly
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    // Trust X-Forwarded-* headers from a reverse proxy (Nginx/Caddy) so that
    // rate limiting and logs see real client IPs. Configurable via the
    // TRUST_PROXY env var and DEFAULTS TO FALSE — when the app is exposed
    // directly without a proxy in front of it, any client could otherwise
    // forge X-Forwarded-For and bypass IP-based rate limits. Operators
    // running behind Caddy/Nginx (the docker-compose.prod.yml topology) must
    // explicitly set TRUST_PROXY=true in .env.production.
    trustProxy: env.TRUST_PROXY,
  });

  // CORS: by default the app is same-origin (dashboard, checkout and API all live
  // under api.paywarden.io). If CORS_ORIGIN is set, only those exact origins are
  // allowed with credentials (required for the admin dashboard's httpOnly cookie).
  const corsOrigin = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : false;
  await app.register(cors, {
    origin: corsOrigin,
    credentials: corsOrigin !== false,
  });
  // CSP sized for the same-origin Vite SPAs (dashboard + checkout): no inline
  // scripts in Vite production output, styles need 'unsafe-inline' (runtime
  // style injection), images allow data: (QR codes). Second containment layer
  // for the admin origin — an XSS sink in the dashboard must not be able to
  // load attacker script against the admin cookie.
  await app.register(helmet, {
    // Framing policy lives in CSP frame-ancestors (universally supported):
    // 'self' everywhere except /checkout, which merchants embed cross-origin.
    // The legacy X-Frame-Options header can't express that split, so drop it.
    xFrameOptions: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        // helmet merges this in by default; over plain HTTP (Docker-first
        // without a TLS proxy) it makes browsers upgrade same-origin asset
        // requests to https and breaks the page. TLS operators get HSTS.
        upgradeInsecureRequests: null,
      },
    },
  });

  // The checkout page is DESIGNED to be embedded in merchant pages via
  // cross-origin <iframe> (docs/2c-checkout-ui.md) — the global
  // frame-ancestors 'self' / X-Frame-Options above would block exactly that
  // integration. Relax framing for /checkout only; the admin SPA stays locked.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/checkout') || req.url.startsWith('/demo')) {
      const csp = reply.getHeader('content-security-policy');
      if (typeof csp === 'string') {
        reply.header(
          'content-security-policy',
          csp.replace("frame-ancestors 'self'", 'frame-ancestors *'),
        );
      }
    }
  });
  await app.register(cookie);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  await registerFrontendRoutes(app, {
    dashboardRoot: join(__dirname, '../dashboard/dist'),
    checkoutRoot: join(__dirname, '../checkout/dist'),
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  app.setErrorHandler(errorHandler);

  // 7. Register routes
  registerHealthRoutes(app, { redis, wallet });
  registerPaymentRoutes(app, orderEngine);
  if (env.ADDRESS_MODE === 'hd') registerWalletRoutes(app, wallet);
  registerMerchantRoutes(app);
  registerAdminRoutes(app, { gasManager, fundSweeper, orderEngine });
  if (env.ADDRESS_MODE === 'static') registerMerchantAddressRoutes(app, { orderEngine });
  registerCheckoutRoutes(app);
  if (env.NODE_ENV === 'development') {
    registerDebugRoutes(app, orderEngine);
    logger.warn('Debug routes enabled (NODE_ENV=development)');
  }

  if (env.DEMO_MODE) {
    registerDemoRoutes(app, orderEngine);
    logger.info('Demo mode enabled — /demo route active');
  }

  // 8. Start chain watcher
  await startChainWatcher();
  const stopRecovery = startRecoveryMonitor(webhookNotifier, fundSweeper);

  // 9. Schedule expired order cleanup (every 60s)
  setInterval(async () => {
    try {
      const count = await orderEngine.processExpiredOrders();
      if (count > 0) logger.info({ count }, 'Expired orders cleaned up');
    } catch (err) {
      logger.error({ err }, 'Error processing expired orders');
    }
  }, 60_000);

  // 9b. Background health monitor — triggers notifications on critical state.
  // Separate from /api/v1/health route so alerts aren't tied to container healthcheck hits.
  setInterval(async () => {
    try {
      if (env.ADDRESS_MODE === 'hd' && !wallet.isInitialized()) {
        await notifier.notify({ type: 'wallet_uninitialized' });
      }
    } catch (err) {
      logger.error({ err }, 'Background health monitor error');
    }
  }, 5 * 60_000);

  // 10. Start HTTP server
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info({ port: env.PORT, host: env.HOST }, 'HTTP server started');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await app.close();
    await stopRecovery();
    await closeChainWatcher();
    await closeWebhookWorker();
    await fundSweeper.close();
    await closeDb();
    redis.disconnect();
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
