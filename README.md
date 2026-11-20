<p align="center">
  <img src="docs/assets/logo.svg" width="64" height="64" alt="PayWarden">
</p>

<h1 align="center">PayWarden</h1>

<p align="center">
  <b>Non-custodial USDT payment gateway. Self-hosted. Open source.</b><br>
  Accept USDT (TRC-20) without giving up your keys — ever.
</p>

<p align="center">
  <a href="https://github.com/paywarden/paywarden-public/actions"><img src="https://github.com/paywarden/paywarden-public/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSL--1.1-blue" alt="License"></a>
  <a href="https://github.com/paywarden/paywarden-public/releases"><img src="https://img.shields.io/github/v/release/paywarden/paywarden-public?include_prereleases" alt="Release"></a>
</p>

---

## What is PayWarden?

PayWarden is a self-hosted payment gateway for USDT on the TRON network. It watches the blockchain, detects incoming payments, confirms them, fires webhooks, and optionally sweeps funds to your cold wallet — all while **your private keys never leave your server**.

Think of it as **BTCPay Server for USDT/TRC-20**.

### Key features

- **Non-custodial** — your seed is encrypted on your server. We never see it.
- **HD Wallet** — BIP44 address derivation, one unique address per order.
- **Auto detection** — TronGrid polling, ~3s to detect incoming transfers.
- **Webhook callbacks** — HMAC-SHA256 signed, exponential backoff retry (up to 10x).
- **Fund sweeping** — auto-sweep confirmed USDT to your cold wallet (optional).
- **Admin dashboard** — built-in UI for orders, merchants, and revenue.
- **Checkout page** — embeddable payment page with QR code.
- **Multi-merchant** — isolate API keys, orders, and webhooks per merchant.
- **Event sourcing** — full audit trail in `order_events` table.

---

## Quick Start

> **Goal: first confirmed webhook in 15 minutes.** This guide uses the Nile testnet (free USDT, no real money).

### Prerequisites

- Docker + Docker Compose v2.0+
- A free [TronGrid](https://www.trongrid.io/) API key
- Node.js 20+ to run the secret generation commands below

### 1. Clone and configure

```bash
git clone https://github.com/paywarden/paywarden-public.git
cd paywarden-public
cp .env.example .env
mkdir -p vault
```

Generate your secrets (run each line, paste the output into `.env`):

```bash
# Vault key (encrypts your mnemonic)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# API key
node -e "console.log('pw_' + require('crypto').randomBytes(24).toString('hex'))"

# Webhook secret
node -e "console.log('whsec_' + require('crypto').randomBytes(24).toString('hex'))"

# HMAC secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# JWT secret (for admin dashboard)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `TRONGRID_API_KEY` and choose an `ADMIN_PASSWORD`. The example uses Nile testnet
and the Compose service names `postgres` and `redis`.

For this local walkthrough, set `ALLOW_PRIVATE_CALLBACKS=true` so the app can
deliver webhooks to the sample receiver on the Compose network. Keep that
setting disabled on public deployments. On Linux, ensure the bind-mounted
`vault/` is writable by the container's `node` user (UID 1000).

To enable the demo checkout page, add `DEMO_MODE=true` to your `.env`.

### 2. Start the stack

Compose starts PostgreSQL, Redis, and the sample webhook receiver. The
`migrate` service applies the database migrations before the app starts.

```bash
docker compose --profile quickstart up -d --build
docker compose --profile quickstart ps
```

### 3. Initialize wallet

On first boot with an empty database, PayWarden automatically seeds a "Default
Merchant" whose API key is the `API_KEY` value from your `.env` — so you can
call the authenticated API immediately, no admin login required for this
quick path. (For the full admin-driven multi-merchant flow, see the
[quick-start guide](https://docs.paywarden.io/guide/quick-start).)

```bash
curl -X POST http://localhost:3000/api/v1/wallet/init \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

> **Write down the 24-word mnemonic immediately.** Lost mnemonic = lost funds.

### 4. Watch the sample webhook receiver

The receiver started by the `quickstart` profile verifies webhook HMAC
signatures. From the app container, it is reachable at
`http://webhook:4000/webhook`. To watch its logs, run this in a second terminal.

```bash
docker compose --profile quickstart logs -f webhook
```

### 5. Create a payment

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "order_001",
    "amount": "10.00",
    "callback_url": "http://webhook:4000/webhook"
  }'
```

Or, if you enabled `DEMO_MODE`, just open **http://localhost:3000/demo** in your browser — it creates a test order and takes you straight to the checkout page.

### 6. Pay with testnet USDT

Send Nile testnet USDT to the address returned in step 5 (or shown on the checkout page). Get free testnet TRX and USDT from the [Nile faucet](https://nileex.io/join/getJoinPage).

### 7. Watch the magic

1. **~3s** — payment detected on-chain
2. **~57s** — 19 block confirmations
3. **Instant** — webhook fires to your receiver (check the terminal from step 4)
4. **30s later** — funds swept to cold wallet (if configured)

Your webhook receiver terminal should show:

```
[webhook] ✓ Payment confirmed: order=... amount=10.000000 USDT tx=...
```

That's it. Your first confirmed webhook. Now [read the full docs](https://docs.paywarden.io) to integrate with your app.

---

## Architecture

```
                   ┌──────────────────────────────────────┐
                   │            PayWarden                  │
                   │                                       │
 Your app ──API──▶ │  Fastify HTTP Server                  │
                   │  ├─ POST /payments  (create order)    │
                   │  ├─ GET  /payments  (query/list)      │
                   │  └─ GET  /health                      │
                   │                                       │
                   │  OrderEngine (state machine + events)  │
                   │                                       │
 TronGrid ◀─poll── │  ChainWatcher (every 3s)              │
                   │                                       │
 Your app ◀─hook── │  WebhookNotifier (retry up to 10x)    │
                   │                                       │
 Cold wallet ◀──── │  FundSweeper → GasManager             │
                   └───────────────┬───────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │  PostgreSQL 16  │
                          │  Redis 7        │
                          └─────────────────┘
```

---

## API Reference

Merchant payment APIs require `X-API-Key` unless a route is explicitly marked no auth. Admin APIs use the `/api/v1/admin/auth/login` session cookie.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/payments` | Create payment order |
| `GET` | `/api/v1/payments/:id` | Get order by ID |
| `GET` | `/api/v1/payments` | List orders (paginated, filterable) |
| `POST` | `/api/v1/wallet/init` | Initialize HD wallet |
| `GET` | `/api/v1/health` | Health check (no auth) |
| `GET` | `/api/v1/checkout/:id/status` | Checkout page status (no auth) |

`POST /api/v1/payments` is idempotent per merchant + `external_id`. Repeating the same payload returns the existing order with HTTP `200`; reusing the same `external_id` with different amount, currency, or callback URL returns HTTP `409`.

### Order statuses

| Status | Meaning |
|--------|---------|
| `pending` | Awaiting payment |
| `detected` | Transfer seen, waiting for confirmations |
| `confirmed` | Amount matches, confirmed on-chain |
| `overpaid` | Received more than expected |
| `underpaid` | Received less than expected |
| `completed` | Webhook delivered successfully |
| `expired` | TTL exceeded, no payment received |
| `callback_failed` | Webhook failed after all retries |

Full API documentation: [docs.paywarden.io](https://docs.paywarden.io)

---

## Webhook verification

Webhooks are signed with HMAC-SHA256. Always verify before processing:

```javascript
import { createHmac } from 'crypto';

function verifyWebhook(body, signature, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return expected === signature;
}
```

Webhook payload:

Webhooks are sent with an `X-Signature: sha256=<hex>` header (plus
`X-Idempotency-Key` and `X-Timestamp`). The payload is flat:

```json
{
  "event": "payment.confirmed",
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "external_id": "order_001",
  "amount_expected": "10.000000",
  "amount_received": "10.000000",
  "currency": "USDT",
  "network": "nile",
  "tx_hash": "abc123...",
  "from_address": "TPayer...",
  "to_address": "TXyz...",
  "status": "confirmed",
  "timestamp": "2026-01-01T00:05:00Z"
}
```

---

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `VAULT_KEY` | 64-char hex — encrypts your mnemonic |
| `API_KEY` | Merchant API authentication key |
| `WEBHOOK_SECRET` | HMAC signing key for webhooks |
| `HMAC_SECRET` | Internal HMAC key for API key storage |
| `TRONGRID_API_KEY` | Free key from trongrid.io |
| `USDT_CONTRACT` | USDT (TRC-20) contract address (see TRON network table below) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `ADMIN_PASSWORD` | Admin dashboard password (min 8 chars) |
| `JWT_SECRET` | JWT signing key for admin sessions |

### TRON network

| Variable | Default | Description |
|----------|---------|-------------|
| `TRON_NETWORK` | `nile` | `mainnet` / `nile` / `shasta` |
| `USDT_CONTRACT` | Nile testnet | USDT contract address |

> Mainnet USDT: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`

### Block scanning and recovery

`SCAN_MODE=address` is the default. In `block` mode the scanner processes confirmed
heights and reads each block again after five more confirmed blocks. Its
checkpoint advances in PostgreSQL after successful processing. If an older
deployment skipped blocks, run an inclusive HD backfill using the same network
and contract settings as the original orders.

```bash
docker compose exec app node dist/scripts/backfill-blocks.js FROM_HEIGHT TO_HEIGHT
```

Backfill leaves the live scan checkpoint untouched. The command reports the
first incomplete block if it stops. The app's confirmation worker handles
detected payments on pending orders. Review late-payment events manually,
including transfers to addresses issued to multiple orders by older versions.
Address scanning watches pending orders. Use a block backfill to reconcile an
older payment to an expired HD order while running in address mode.

Before upgrading an existing HD installation, stop the old app and apply the
new migrations. Migration `0005` reserves previously issued addresses. New
addresses stay assigned to their orders after expiry or sweeping.

### Payment

| Variable | Default | Description |
|----------|---------|-------------|
| `ORDER_TTL` | `1800` | Order expiry in seconds (30 min) |
| `MIN_CONFIRMATIONS` | `19` | Blocks to wait (~57s) |
| `SCAN_INTERVAL` | `3000` | Polling interval in ms |
| `SCAN_MODE` | `address` | `address` or `block` (for high concurrency) |

### Demo mode (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_MODE` | `false` | Set `true` to enable `/demo` route (auto-creates test orders) |

### Fund sweeping (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `HOT_WALLET_KEY` | — | Hot wallet private key (64-char hex) |
| `COLD_WALLET_ADDRESS` | — | Sweep destination |
| `SWEEP_MODE` | `burn` | Sweep mode |
| `SWEEP_GAS_TOPUP_TRX` | `20` | TRX to send for gas |
| `SWEEP_MIN_USDT` | `0.5` | Min amount to trigger sweep |
| `SWEEP_DELAY_MS` | `30000` | Delay after confirmation |

Leave `HOT_WALLET_KEY` empty to disable sweeping.

### Proxy / CORS / Safety (optional)

All three variables default to the safe value. Do not flip them on unless you
understand the consequences.

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers. Set `true` **only** when behind a trusted reverse proxy (Caddy / Nginx) that strips client-supplied `X-Forwarded-For`. Enabling this while exposing PayWarden directly lets any client spoof their IP and bypass rate limits. |
| `CORS_ORIGIN` | — | Comma-separated list of allowed origins, e.g. `https://paywarden.io,https://api.paywarden.io`. Leave unset to disable CORS. |
| `ALLOW_PRIVATE_CALLBACKS` | `false` | When `false`, webhook delivery rejects `callback_url` values that resolve to loopback / RFC1918 / link-local addresses (SSRF protection). Set `true` only for local development. |
| `HOT_WALLET_ALERT_TRX` | `50` | Low-balance alert threshold for hot-wallet TRX. |

### Alerting / Notifications (optional)

PayWarden emits operator alerts for low hot-wallet balance, permanently-failed
webhook deliveries, failed fund sweeps, and uninitialized wallet state.
Configure one or both channels — alerts are deduplicated per event type for
30 minutes. If no channel is configured, alerts are logged only (a warning is
emitted at startup when `NODE_ENV=production`).

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Target chat id (user or group) |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port (defaults to `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address (defaults to `SMTP_USER`) |
| `ALERT_EMAIL_TO` | Destination email address |

See `.env.example` for a complete template.

---

## Production deployment

This public repository provides source releases. Build both Docker targets from
the same release tag before using the production Compose file. See
[deployment instructions](docs/deployment.md).

## Local development

When running the app and migrations on the host, replace the Compose service
names in the local `.env` with the loopback addresses below. Keep the service
names for the all-container quick start.

```dotenv
DATABASE_URL=postgresql://paywarden:localdev123@127.0.0.1:5432/paywarden
REDIS_URL=redis://127.0.0.1:6379
```

```bash
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

Run tests:

```bash
pnpm --dir dashboard install --frozen-lockfile
pnpm test:unit
pnpm test:report
```

Integration tests require disposable PostgreSQL 16 and Redis 7 services. They
apply migrations, truncate test tables and flush Redis; do not use application data.

```bash
INTEGRATION_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/paywarden_test \
INTEGRATION_REDIS_URL=redis://127.0.0.1:6379/15 pnpm test:integration
```

`test:integration` fails if either URL is missing and runs files serially
because they share fixtures. CI runs both unit and PostgreSQL/Redis integration
tests on pull requests. `test:report` writes an HTML report, raw logs and a hashed
manifest under `test-reports/`; set both URLs to include all integration tests.

### Payment reliability and upgrades

Payment and callback outcomes are separate. API responses expose `payment_status`
(`confirmed`, `underpaid`, `overpaid`, or `null` before confirmation). Successful
webhook delivery preserves `underpaid`/`overpaid`; only a fully paid order becomes
`completed`. Checkout displays and emits the payment outcome independently of
callback delivery. Amount classification retains the existing 0.01 USDT tolerance.

Confirmation commits the payment fact, audit event and webhook outbox together.
Configured HD sweeping also gets a durable intent in that transaction and does
not depend on the merchant callback succeeding. A background cycle recovers due
work every five seconds. Redis loss or enqueue failure does not delete the intent.
HTTP delivery remains at least once: merchants must deduplicate `X-Idempotency-Key`.
The immutable payload and `evt_<delivery UUID>` key survive retries and restarts;
an observed acknowledgement is retained to retry bookkeeping without another POST.
Losing both acknowledgement records can cause a repeat POST with the same key.
Acknowledgements are bound to the callback URL and its delivery generation.
Changing the callback URL increments that generation, including A-to-B-to-A
changes, so a previous endpoint's acknowledgement cannot complete the new target.

Sweeps persist signed bytes and the transaction hash before broadcasting. Recovery
checks the original hash and can rebroadcast only those same bytes. A timeout,
expired transaction or missing receipt remains `unknown`, which requires chain
reconciliation and never authorizes an automatic replacement. Completion requires
a solidified successful receipt and a matching USDT Transfer event (contract,
sender, recipient and amount). Only proven failed execution permits an explicit
admin retry to create a new transaction; the prior hash remains in audit history.

TRX activation and gas top-ups use an independent `native_funding` ledger. Each
sweep funding cycle persists signed bytes and a hash before its first native
broadcast. Failed USDT preparation cannot roll this record back. Restart and
response-loss recovery checks that original hash; even a stale low balance cannot
authorize a second payment in the same cycle. Unknown native transactions are
never replaced, including after expiration. An explicit retry after proven failed
execution starts a new funding cycle and retains the previous funding history.

The admin order detail returns actual webhook/sweep states and recovery actions.
The dashboard exposes failed-step retries for confirmed, underpaid and overpaid
payments; old failure events do not re-enable an already successful step. Retrying
an unknown sweep rechecks its original transaction rather than replacing it.

Before upgrading an existing installation, stop **all** old application workers,
back up PostgreSQL and Redis, apply migrations through
`0010_quarantine_legacy_native_funding`, then start the new application. Mixed old
and new workers are unsupported. Migration 0008 repairs historical false success
and records `payment_status_reconciled` events. Legacy callback/sweep records with
insufficient evidence become `legacy_review` and are not sent automatically.
Old Redis callback jobs without a durable delivery identity are quarantined by
the new worker; their payload alone cannot authorize an HTTP request.
Known historical sweep hashes are checked against solidified chain receipts;
they are never replaced automatically. Reconcile ambiguous callbacks with the
merchant and ambiguous sweeps against chain history before any manual action.
Migration 0009 adds native funding history and callback target generations.
Migration 0010 quarantines old pending sweeps whose TRX funding may already have
been broadcast without a persisted hash. These require manual chain reconciliation;
a balance query alone is insufficient evidence to authorize another TRX payment.

Operators can inspect outstanding durable work with read-only queries:

```sql
SELECT id, order_id, status, attempt, next_attempt_at, last_error
FROM webhook_deliveries WHERE status NOT IN ('delivered', 'failed');
SELECT order_id, status, tx_hash, next_attempt_at, last_error
FROM sweep_jobs WHERE status NOT IN ('confirmed', 'skipped');
SELECT order_id, funding_id, purpose, status, tx_hash, last_error
FROM native_funding WHERE status NOT IN ('confirmed', 'skipped');
```

Live-chain validation checklist:

- [`docs/live-validation.md`](docs/live-validation.md) for Nile testnet -> mainnet payment, webhook, sweep, and gas alert verification

Deployment smoke test:

```bash
SMOKE_BASE_URL=http://localhost:3000 ADMIN_PASSWORD=your-admin-password pnpm smoke
```

The smoke script assumes the API is already running at `SMOKE_BASE_URL`, PostgreSQL and Redis are reachable, and the wallet has already been initialized. It verifies health and admin endpoints; it does not boot the stack for you.

If you want to load local variables from a file while testing on a workstation:

```bash
tsx --env-file=.env src/scripts/smoke-test.ts
```

Type check:

```bash
pnpm typecheck
```

---

## How it compares

|  | PayWarden | NOWPayments | BTCPay Server |
|--|-----------|-------------|---------------|
| Non-custodial | Yes | No | Yes |
| USDT/TRC-20 native | Yes | Yes | No (BTC-focused) |
| Self-hosted | Yes | No | Yes |
| Transaction fee | 0% | 0.5-1% | 0% |
| Webhook callbacks | Yes | Yes | Yes |
| Admin dashboard | Yes | Yes | Yes |
| TypeScript | Yes | — | No (C#) |

---

## Cloud version

Don't want to self-host? [PayWarden Cloud](https://paywarden.io/cloud) runs the same engine — we handle uptime, you keep your keys.

Currently in private beta. [Join the waitlist →](mailto:cloud@paywarden.io)

---

## License

[Business Source License 1.1](LICENSE) — free to self-host, converts to Apache 2.0 after 4 years.

---

## Links

- [Documentation](https://docs.paywarden.io)
- [GitHub](https://github.com/paywarden/paywarden-public)
- [Webhook receiver examples](examples/webhook-receiver/)
- [Cloud](https://paywarden.io/cloud)

