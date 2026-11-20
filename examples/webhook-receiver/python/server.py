"""
PayWarden — Sample Webhook Receiver (Python)

Receives payment events, verifies HMAC-SHA256 signature, logs the payload.
Use this as a starting point to integrate PayWarden into your backend.

Usage:
    WEBHOOK_SECRET=your_secret python server.py

Then configure your merchant's callback_url to http://localhost:4000/webhook

Requires Python 3.9+ (no external dependencies).
"""

import hashlib
import hmac
import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "4000"))
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

if not WEBHOOK_SECRET:
    print("WEBHOOK_SECRET env var is required", file=sys.stderr)
    sys.exit(1)


def verify_signature(raw_body: bytes, header_value: str | None) -> bool:
    """Verify X-Signature header matches HMAC-SHA256 of the raw body."""
    if not header_value:
        return False
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(header_value, expected)


class WebhookHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Health check."""
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Webhook receiver running")

    def do_POST(self):
        if self.path != "/webhook":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length)
        signature = self.headers.get("X-Signature")
        idempotency_key = self.headers.get("X-Idempotency-Key")

        # Step 1: Verify signature — ALWAYS do this before processing
        if not verify_signature(raw_body, signature):
            print("[webhook] Invalid signature — rejecting")
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b"Invalid signature")
            return

        # Step 2: Parse payload
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Invalid JSON")
            return

        # Step 3: Idempotency check (in production, use Redis or your DB)
        print(f"[webhook] idempotency_key={idempotency_key}")

        # Step 4: Handle the event
        event = payload.get("event", "")

        if event == "payment.confirmed":
            print(
                f'[webhook] ✓ Payment confirmed: order={payload["order_id"]} '
                f'amount={payload["amount_received"]} {payload["currency"]} '
                f'tx={payload["tx_hash"]}'
            )
            # TODO: fulfill the order in your system

        elif event == "payment.detected":
            print(
                f'[webhook] ⏳ Payment detected (awaiting confirmations): '
                f'order={payload["order_id"]}'
            )

        elif event == "payment.expired":
            print(f'[webhook] ✗ Payment expired: order={payload["order_id"]}')
            # TODO: cancel or re-create the order

        elif event == "payment.underpaid":
            print(
                f'[webhook] ⚠ Underpaid: order={payload["order_id"]} '
                f'expected={payload["amount_expected"]} '
                f'received={payload["amount_received"]}'
            )

        else:
            print(f"[webhook] Unknown event: {event}")

        # Step 5: Respond 200 — PayWarden will retry on non-2xx
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"received": True}).encode())

    def log_message(self, format, *args):
        """Suppress default access logs to keep output clean."""
        pass


if __name__ == "__main__":
    server = HTTPServer(("", PORT), WebhookHandler)
    print(f"[webhook-receiver] Listening on http://localhost:{PORT}/webhook")
    print("[webhook-receiver] Waiting for PayWarden events...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[webhook-receiver] Shutting down")
        server.server_close()
