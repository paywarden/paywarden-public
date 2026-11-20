import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Security
  API_KEY: z.string().min(10),
  WEBHOOK_SECRET: z.string().min(10),
  // Required in HD mode (checked in superRefine below); absent in static mode,
  // where the server holds no seed at all.
  VAULT_KEY: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/, 'VAULT_KEY must be 64 hex chars')
    .optional(),
  HMAC_SECRET: z.string().min(32),

  // TRON
  TRONGRID_API_KEY: z.string().min(1),
  TRON_NETWORK: z.enum(['mainnet', 'nile', 'shasta']).default('nile'),
  USDT_CONTRACT: z.string().min(1),

  // Payment
  ORDER_TTL: z.string().default('1800').transform(Number),
  MIN_CONFIRMATIONS: z.string().default('19').transform(Number),
  SCAN_INTERVAL: z.string().default('3000').transform(Number),

  // Receiving-address source.
  //   hd     — HD wallet (xpub) derives one fresh address per order (self-hosted default).
  //   static — merchants register their own addresses; orders on the same
  //            address are told apart by a 4-digit amount tail. The server
  //            holds no seed, xpub, or signing capability in this mode.
  ADDRESS_MODE: z.enum(['hd', 'static']).default('hd'),

  // Chain Watcher
  SCAN_MODE: z.enum(['address', 'block']).default('address'),
  // Alert when an order sits in `detected` longer than this many hours
  // without reaching MIN_CONFIRMATIONS (likely reorged-out tx).
  DETECTED_STUCK_HOURS: z.string().default('2').transform(Number),

  // Admin Dashboard
  ADMIN_PASSWORD: z.string().min(8),
  JWT_SECRET: z.string().min(32),

  // Demo mode (optional — enables /demo checkout route)
  DEMO_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // CORS (optional — comma-separated origins, e.g. "https://paywarden.io,https://api.paywarden.io")
  CORS_ORIGIN: z.string().optional(),

  // Trust X-Forwarded-* headers from a reverse proxy. MUST stay false unless
  // the app is genuinely sitting behind a trusted proxy (Caddy/Nginx) that
  // strips client-supplied X-Forwarded-For. Setting it to true while exposing
  // the app directly lets any client spoof their IP and bypass rate limits.
  // Default: false (safe by default — operator must explicitly opt in).
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Allow merchants to register webhook callback_url targets that resolve to
  // private / loopback / link-local addresses. Default false: webhook
  // delivery rejects 127.0.0.1 / RFC1918 / fc00::/7 / *.local / etc. to
  // prevent a stolen API key from turning the webhook fetcher into an
  // internal-network probe (SSRF). Set to true ONLY for dev / integration
  // testing against http://localhost:4000/webhook style receivers.
  ALLOW_PRIVATE_CALLBACKS: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Notifications — Telegram (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Notifications — Email/SMTP (optional)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587').transform(Number),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),

  // Fund Sweep (optional — if unset, sweep is disabled)
  HOT_WALLET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'HOT_WALLET_KEY must be 64 hex chars')
    .optional(),
  COLD_WALLET_ADDRESS: z.string().min(34).optional(),
  SWEEP_MODE: z.enum(['burn', 'delegate']).default('burn'),
  SWEEP_GAS_TOPUP_TRX: z.string().default('20').transform(Number),
  SWEEP_MIN_USDT: z.string().default('0.5').transform(Number),
  SWEEP_DELAY_MS: z.string().default('30000').transform(Number),
  HOT_WALLET_ALERT_TRX: z.string().default('50').transform(Number),
}).superRefine((cfg, ctx) => {
  if (cfg.ADDRESS_MODE === 'hd' && !cfg.VAULT_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['VAULT_KEY'],
      message: 'required when ADDRESS_MODE=hd (encrypts the HD wallet seed)',
    });
  }

  // Fail-fast production gate (Iron Rule 6): the dev-friendly minimums above
  // are too weak for credentials guarding real funds. API_KEY doubles as the
  // auto-seeded default merchant credential, so a short value from a copied
  // .env would be a live production key.
  if (cfg.NODE_ENV !== 'production') return;

  const minimums: Array<[key: 'API_KEY' | 'WEBHOOK_SECRET' | 'ADMIN_PASSWORD', min: number]> = [
    ['API_KEY', 32],
    ['WEBHOOK_SECRET', 32],
    ['ADMIN_PASSWORD', 12],
  ];
  for (const [key, min] of minimums) {
    if (cfg[key].length < min) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `must be at least ${min} characters in production`,
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console -- logger not yet initialized at this point
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
