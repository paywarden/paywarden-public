import { useParams, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { AlertTriangle, ExternalLink, RotateCcw } from 'lucide-react'
import { api } from '../api/admin'
import StatusBadge from '../components/StatusBadge'

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'orders', id],
    queryFn: () => api.getOrder(id!),
    refetchInterval: 10_000,
  })

  const refreshOrder = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'orders'] })
    qc.invalidateQueries({ queryKey: ['admin', 'incidents'] })
    qc.invalidateQueries({ queryKey: ['admin', 'wallet'] })
  }

  const retryWebhook = useMutation({
    mutationFn: () => api.retryOrderWebhook(id!),
    onSuccess: refreshOrder,
  })

  const retrySweep = useMutation({
    mutationFn: () => api.retryOrderSweep(id!),
    onSuccess: refreshOrder,
  })

  if (isLoading) return <div className="text-gray-400 p-4">Loading...</div>
  if (!data) return <div className="text-gray-400 p-4">Order not found</div>

  const { order, events, transaction, settlement, meta, recovery } = data
  const canRetryWebhook = recovery?.webhook?.can_retry === true
  const canRetrySweep = recovery?.sweep?.can_retry === true

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin/orders" className="text-sm text-blue-600 hover:underline">← Orders</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-600 font-mono">{order.id}</span>
        <span className="ml-auto inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
          {meta?.tron_network ?? 'network unknown'}
        </span>
      </div>

      {(canRetryWebhook || canRetrySweep) && (
        <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 text-sm font-medium text-orange-800">
                <AlertTriangle size={16} />
                Manual recovery available
              </div>
              <p className="mt-2 text-sm text-gray-700">
                This order has a recoverable delivery or settlement issue. Retry the failed step directly from the admin panel.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canRetryWebhook && (
                <button
                  onClick={() => retryWebhook.mutate()}
                  disabled={retryWebhook.isPending}
                  className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  <RotateCcw size={14} />
                  {retryWebhook.isPending ? 'Retrying webhook...' : 'Retry webhook'}
                </button>
              )}
              {canRetrySweep && (
                <button
                  onClick={() => retrySweep.mutate()}
                  disabled={retrySweep.isPending}
                  className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
                >
                  <RotateCcw size={14} />
                  {retrySweep.isPending ? 'Retrying sweep...' : 'Retry sweep'}
                </button>
              )}
            </div>
          </div>
          {(retryWebhook.error || retrySweep.error) && (
            <p className="mt-3 text-sm text-rose-700">
              {(retryWebhook.error as Error | null)?.message ?? (retrySweep.error as Error | null)?.message}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Order Details</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd><StatusBadge status={order.status} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">External ID</dt>
              <dd className="font-mono text-xs text-gray-700">{order.external_id}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Webhook delivery</dt>
              <dd className="text-gray-700">{recovery?.webhook?.status ?? 'Not scheduled'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Expected</dt>
              <dd className="text-gray-900 font-medium">{Number(order.amount_expected).toFixed(2)} USDT</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Received</dt>
              <dd className="text-gray-900 font-medium">{Number(order.amount_received).toFixed(6)} USDT</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Created</dt>
              <dd className="text-gray-600">{new Date(order.created_at).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Expires</dt>
              <dd className="text-gray-600">{new Date(order.expires_at).toLocaleString()}</dd>
            </div>
            {order.tx_hash && (
              <div className="flex justify-between">
                <dt className="text-gray-500">TxHash</dt>
                <dd>
                  <a
                    href={`${meta?.tx_explorer_base_url ?? 'https://tronscan.org/#/transaction/'}${order.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline font-mono text-xs"
                  >
                    {order.tx_hash.slice(0, 16)}...
                    <ExternalLink size={12} />
                  </a>
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Chain</dt>
              <dd className="text-gray-700">{meta?.tron_network ?? '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5 flex flex-col items-center">
          <p className="text-sm font-medium text-gray-700 mb-3">Payment Address</p>
          <QRCodeSVG value={order.address} size={160} />
          <p className="font-mono text-xs text-gray-500 mt-3 break-all text-center">{order.address}</p>
          {meta?.address_explorer_base_url && (
            <a
              href={`${meta.address_explorer_base_url}${order.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
            >
              Open address in explorer
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      {transaction && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <h3 className="font-medium text-gray-900 mb-3">Transaction</h3>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-gray-500">Amount</dt>
              <dd className="font-medium">{Number(transaction.amount).toFixed(6)} USDT</dd>
            </div>
            <div>
              <dt className="text-gray-500">Confirmations</dt>
              <dd className="font-medium">{transaction.confirmations}</dd>
            </div>
            <div>
              <dt className="text-gray-500">From</dt>
              <dd className="font-mono text-xs text-gray-700">{transaction.from_address}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Block</dt>
              <dd>{transaction.block_number}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
        <h3 className="font-medium text-gray-900 mb-3">Settlement</h3>
        <dl className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-2">
          <div>
            <dt className="text-gray-500">Fund Sweep</dt>
            <dd className="font-medium text-gray-900">
              {meta?.sweep_enabled ? `Enabled (${meta.sweep_mode})` : 'Disabled'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Last Swept At</dt>
            <dd className="text-gray-700">
              {settlement?.last_swept_at ? new Date(settlement.last_swept_at).toLocaleString() : 'Not swept yet'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Sweep state</dt>
            <dd className="text-gray-700">{recovery?.sweep?.status ?? 'Not scheduled'}</dd>
          </div>
          <div className="lg:col-span-2">
            <dt className="text-gray-500">Sweep Tx</dt>
            <dd className="mt-1">
              {settlement?.sweep_tx_hash && meta?.tx_explorer_base_url ? (
                <a
                  href={`${meta.tx_explorer_base_url}${settlement.sweep_tx_hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline"
                >
                  {settlement.sweep_tx_hash}
                  <ExternalLink size={12} />
                </a>
              ) : (
                <span className="text-gray-500">No sweep transaction recorded</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-medium text-gray-900 mb-4">Event Timeline</h3>
        <div className="space-y-3">
          {events.map((ev: Record<string, unknown>) => (
            <div key={ev.id as string} className="flex gap-3 text-sm">
              <div className="text-gray-400 text-xs whitespace-nowrap mt-0.5">
                {new Date(ev.created_at as string).toLocaleString()}
              </div>
              <div>
                <span className="font-medium text-gray-800">{ev.event_type as string}</span>
                {Object.keys(ev.payload as object).length > 0 && (
                  <pre className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">
                    {JSON.stringify(ev.payload, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
