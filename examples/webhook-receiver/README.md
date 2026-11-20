# Sample Webhook Receivers

Minimal webhook receivers for testing PayWarden integration. Each one verifies the HMAC-SHA256 signature, logs the event, and responds 200.

Pick your language — they're functionally identical.

## Node.js (zero dependencies)

```bash
cd node
WEBHOOK_SECRET=your_secret node server.mjs
```

## Python (zero dependencies)

```bash
cd python
WEBHOOK_SECRET=your_secret python server.py
```

## What it does

1. Listens on `http://localhost:4000/webhook`
2. Verifies `X-Signature` header (HMAC-SHA256)
3. Parses the JSON payload
4. Logs the event type and key fields
5. Responds `200 OK`

## Configuration

Set your merchant's `callback_url` to `http://localhost:4000/webhook` when creating a payment order.

The `WEBHOOK_SECRET` must match the secret you used when creating the merchant.

## Events

| Event | Meaning |
|-------|---------|
| `payment.detected` | Transfer seen on-chain, awaiting confirmations |
| `payment.confirmed` | Required confirmations reached — safe to fulfill |
| `payment.expired` | Order expired without payment |
| `payment.underpaid` | Payment received but amount was insufficient |

## Next steps

- Add idempotency storage (Redis `SISMEMBER` or a DB table) to safely handle retries
- Connect the `payment.confirmed` handler to your order fulfillment logic
- In production, use HTTPS for your webhook endpoint

See the [Webhooks guide](https://docs.paywarden.io/guide/webhooks) for full details.
