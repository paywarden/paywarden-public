export interface CheckoutStatus {
  id: string
  status:
    | 'pending'
    | 'detected'
    | 'confirmed'
    | 'completed'
    | 'expired'
    | 'failed'
    | 'underpaid'
    | 'overpaid'
    | 'callback_sent'
    | 'callback_failed'
  payment_status?: 'confirmed' | 'underpaid' | 'overpaid' | null
  amount_expected: string
  amount_payable?: string
  amount_received: string
  currency: string
  network: string
  address: string
  tx_hash: string | null
  expires_at: string
  confirmations: number | null
}

export interface CheckoutMessage {
  type:
    | 'checkout.ready'
    | 'checkout.payment_detected'
    | 'checkout.completed'
    | 'checkout.overpaid'
    | 'checkout.underpaid'
    | 'checkout.expired'
    | 'checkout.error'
  orderId: string
  payload?: {
    status?: string
    amountExpected?: string
    amountReceived?: string
    txHash?: string | null
  }
  timestamp: number
}
