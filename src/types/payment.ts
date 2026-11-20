export interface WebhookPayload {
  event: string;
  order_id: string;
  external_id: string;
  amount_expected: string;
  amount_payable: string;
  amount_received: string;
  currency: string;
  network: string;
  tx_hash: string | null;
  from_address: string | null;
  to_address: string;
  status: string;
  payment_status?: string;
  timestamp: string;
}

export interface WebhookDeliveryContext {
  deliveryGeneration?: number;
  callbackUrl: string;
  statusCode: number;
  attempt: number;
  durationMs: number;
  deliveredAt: string;
  idempotencyKey: string;
}

export interface WebhookFailureContext {
  deliveryGeneration?: number;
  callbackUrl: string;
  statusCode: number | null;
  attempt: number;
  durationMs: number;
  failedAt: string;
  idempotencyKey: string;
  reason: string;
}
