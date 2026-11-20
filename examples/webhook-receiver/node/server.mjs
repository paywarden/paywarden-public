/**
 * PayWarden — Sample Webhook Receiver (Node.js)
 *
 * Receives payment events, verifies HMAC-SHA256 signature, logs the payload.
 * Use this as a starting point to integrate PayWarden into your backend.
 *
 * Usage:
 *   WEBHOOK_SECRET=your_secret node server.mjs
 *
 * Then configure your merchant's callback_url to http://localhost:4000/webhook
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = process.env.PORT ?? 4000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  console.error('WEBHOOK_SECRET env var is required');
  process.exit(1);
}

/** Collect request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Verify X-Signature header matches HMAC-SHA256 of the raw body. */
function verifySignature(rawBody, headerValue) {
  if (!headerValue) return false;
  const expected =
    'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
  } catch {
    return false; // length mismatch
  }
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Webhook receiver running');
  }

  // Only accept POST /webhook
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    return res.end('Not Found');
  }

  const rawBody = await readBody(req);
  const signature = req.headers['x-signature'];
  const idempotencyKey = req.headers['x-idempotency-key'];

  // Step 1: Verify signature — ALWAYS do this before processing
  if (!verifySignature(rawBody, signature)) {
    console.error('[webhook] Invalid signature — rejecting');
    res.writeHead(401);
    return res.end('Invalid signature');
  }

  // Step 2: Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400);
    return res.end('Invalid JSON');
  }

  // Step 3: Idempotency check (in production, use Redis or your DB)
  // For this example, we just log the key
  console.log(`[webhook] idempotency_key=${idempotencyKey}`);

  // Step 4: Handle the event
  switch (payload.event) {
    case 'payment.confirmed':
      console.log(
        `[webhook] ✓ Payment confirmed: order=${payload.order_id} amount=${payload.amount_received} ${payload.currency} tx=${payload.tx_hash}`,
      );
      // TODO: fulfill the order in your system
      break;

    case 'payment.detected':
      console.log(
        `[webhook] ⏳ Payment detected (awaiting confirmations): order=${payload.order_id}`,
      );
      break;

    case 'payment.expired':
      console.log(`[webhook] ✗ Payment expired: order=${payload.order_id}`);
      // TODO: cancel or re-create the order
      break;

    case 'payment.underpaid':
      console.log(
        `[webhook] ⚠ Underpaid: order=${payload.order_id} expected=${payload.amount_expected} received=${payload.amount_received}`,
      );
      break;

    default:
      console.log(`[webhook] Unknown event: ${payload.event}`);
  }

  // Step 5: Respond 200 — PayWarden will retry on non-2xx
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ received: true }));
});

server.listen(PORT, () => {
  console.log(`[webhook-receiver] Listening on http://localhost:${PORT}/webhook`);
  console.log('[webhook-receiver] Waiting for PayWarden events...');
});
