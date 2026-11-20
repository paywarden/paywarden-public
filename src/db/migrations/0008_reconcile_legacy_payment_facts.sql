-- Data-only migration. Financial facts are independent of callback completion.
UPDATE orders AS o SET payment_status = COALESCE(
  (SELECT e.payload->>'status' FROM order_events e
   WHERE e.order_id = o.id AND e.event_type = 'payment_confirmed'
     AND e.payload->>'status' IN ('confirmed', 'underpaid', 'overpaid')
   ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
  CASE
    WHEN abs(o.amount_received::numeric - COALESCE(o.amount_payable, o.amount_expected)::numeric) <= 0.01 THEN 'confirmed'
    WHEN o.amount_received::numeric < COALESCE(o.amount_payable, o.amount_expected)::numeric THEN 'underpaid'
    ELSE 'overpaid'
  END
)
WHERE o.status IN ('confirmed', 'underpaid', 'overpaid', 'callback_sent', 'callback_failed', 'completed')
  AND o.payment_status IS NULL;
--> statement-breakpoint
INSERT INTO webhook_deliveries (order_id, event_type, callback_url, payload, status)
SELECT o.id, 'payment.' || o.payment_status, o.callback_url,
  jsonb_build_object(
    'event', 'payment.' || o.payment_status, 'order_id', o.id, 'external_id', o.external_id,
    'amount_expected', o.amount_expected, 'amount_payable', COALESCE(o.amount_payable, o.amount_expected),
    'amount_received', o.amount_received, 'currency', o.currency, 'network', o.network,
    'tx_hash', o.tx_hash, 'from_address', t.from_address, 'to_address', o.address,
    'status', o.payment_status, 'payment_status', o.payment_status, 'timestamp', o.updated_at
  ),
  CASE
    WHEN o.status = 'completed' OR EXISTS (
      SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event_type = 'webhook_sent'
    ) THEN 'delivered'
    WHEN o.status = 'callback_failed' OR EXISTS (
      SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event_type = 'webhook_failed'
    ) THEN 'failed'
    -- Old versions did not persist an intent or every HTTP acknowledgement.
    -- Require reconciliation before redelivering an ambiguous historical event.
    ELSE 'legacy_review'
  END
FROM orders o LEFT JOIN transactions t ON t.tx_hash = o.tx_hash
WHERE o.payment_status IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;
--> statement-breakpoint
-- Repair historical false success while retaining delivery completion above.
INSERT INTO order_events (order_id, event_type, payload)
SELECT id, 'payment_status_reconciled', jsonb_build_object(
  'previous_status', status, 'status', payment_status, 'migration', '0008_reconcile_legacy_payment_facts'
)
FROM orders
WHERE status IN ('completed', 'callback_sent', 'callback_failed')
  AND payment_status IN ('underpaid', 'overpaid');
--> statement-breakpoint
UPDATE orders SET status = payment_status
WHERE status IN ('completed', 'callback_sent', 'callback_failed')
  AND payment_status IN ('underpaid', 'overpaid');
--> statement-breakpoint
INSERT INTO sweep_jobs (order_id, amount, status, tx_hash, to_address, contract_address, last_error)
SELECT o.id, o.amount_received,
  CASE WHEN e.payload->>'sweep_tx_hash' IS NOT NULL
    AND e.payload->>'to' IS NOT NULL AND t.contract_addr IS NOT NULL
    AND (SELECT count(*) FROM orders h WHERE h.address = o.address) = 1
    THEN 'broadcast' ELSE 'legacy_review' END,
  e.payload->>'sweep_tx_hash', e.payload->>'to', t.contract_addr,
  'Legacy sweep requires solidified chain reconciliation; no replacement is authorized'
FROM orders o
LEFT JOIN transactions t ON t.tx_hash = o.tx_hash
LEFT JOIN LATERAL (
  SELECT payload FROM order_events WHERE order_id = o.id AND event_type = 'sweep_completed'
  ORDER BY created_at DESC, id DESC LIMIT 1
) e ON true
WHERE o.derivation_idx IS NOT NULL AND o.payment_status IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;
