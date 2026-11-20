import type { CheckoutMessage, CheckoutStatus } from './types'

export function getCheckoutState(order: CheckoutStatus): CheckoutStatus['status'] {
  return order.payment_status ?? order.status
}

export function getPaymentMessage(order: CheckoutStatus): Omit<CheckoutMessage, 'timestamp'> | null {
  const orderId = order.id
  switch (getCheckoutState(order)) {
    case 'detected': return { type: 'checkout.payment_detected', orderId, payload: { txHash: order.tx_hash } }
    case 'completed':
    case 'confirmed': return { type: 'checkout.completed', orderId, payload: { amountReceived: order.amount_received } }
    case 'overpaid': return { type: 'checkout.overpaid', orderId, payload: { amountExpected: order.amount_expected, amountReceived: order.amount_received } }
    case 'underpaid': return { type: 'checkout.underpaid', orderId, payload: { amountExpected: order.amount_expected, amountReceived: order.amount_received } }
    case 'expired': return { type: 'checkout.expired', orderId }
    default: return null
  }
}
