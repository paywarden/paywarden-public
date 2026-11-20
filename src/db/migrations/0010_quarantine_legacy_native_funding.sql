-- An old pending sweep may already have sent TRX without a durable hash.
-- Do not infer permission to send another payment from a stale balance.
INSERT INTO order_events (order_id, event_type, payload)
SELECT s.order_id, 'sweep_funding_reconciliation_required', jsonb_build_object(
  'previous_status', s.status, 'migration', '0010_quarantine_legacy_native_funding'
)
FROM sweep_jobs s
WHERE s.status = 'pending' AND NOT EXISTS (
  SELECT 1 FROM native_funding f WHERE f.funding_id = s.funding_id
);
--> statement-breakpoint
UPDATE sweep_jobs s SET status = 'legacy_review', updated_at = now(),
  last_error = 'Legacy native funding has no durable broadcast history; reconcile TRX transfers before resuming'
WHERE s.status = 'pending' AND NOT EXISTS (
  SELECT 1 FROM native_funding f WHERE f.funding_id = s.funding_id
);
