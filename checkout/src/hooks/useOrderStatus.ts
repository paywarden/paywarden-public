import { useEffect, useRef, useState } from 'react'
import type { CheckoutStatus, CheckoutMessage } from '../types'
import { getCheckoutState, getPaymentMessage } from '../payment-state'

const TERMINAL_STATES = new Set(['completed', 'expired', 'failed', 'callback_failed', 'underpaid', 'overpaid'])

function postToParent(msg: Omit<CheckoutMessage, 'timestamp'>) {
  window.parent.postMessage({ ...msg, timestamp: Date.now() }, '*')
}

export function useOrderStatus(orderId: string) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevStatusRef = useRef<string | null>(null)
  const readyPostedRef = useRef(false)

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/v1/checkout/${orderId}/status`)
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const data: CheckoutStatus = await res.json()
      setStatus(data)

      // Post ready on first successful fetch
      if (!readyPostedRef.current) {
        postToParent({ type: 'checkout.ready', orderId })
        readyPostedRef.current = true
      }

      const paymentState = getCheckoutState(data)

      // Emit status change events
      if (paymentState !== prevStatusRef.current) {
        prevStatusRef.current = paymentState
        const message = getPaymentMessage(data)
        if (message) postToParent(message)
      }

      // Stop polling in terminal state
      if (TERMINAL_STATES.has(data.status)) {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    fetchStatus()

    const getInterval = () =>
      prevStatusRef.current === 'detected' ? 3_000 : 5_000

    intervalRef.current = setInterval(fetchStatus, getInterval())

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (intervalRef.current) clearInterval(intervalRef.current)
      } else {
        fetchStatus()
        intervalRef.current = setInterval(fetchStatus, getInterval())
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [orderId])

  return { status, error, refetch: fetchStatus }
}
