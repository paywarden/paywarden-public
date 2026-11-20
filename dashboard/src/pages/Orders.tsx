import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/admin'
import StatusBadge from '../components/StatusBadge'

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'detected', label: 'Detected' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'underpaid', label: 'Underpaid' },
  { value: 'overpaid', label: 'Overpaid' },
  { value: 'callback_sent', label: 'Callback sent' },
  { value: 'completed', label: 'Completed' },
  { value: 'expired', label: 'Expired' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'callback_failed', label: 'Callback failed' },
] as const

export default function Orders() {
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Number(searchParams.get('page') ?? '1')
  const status = searchParams.get('status') ?? ''
  const merchantId = searchParams.get('merchantId') ?? ''

  const setFilters = (next: { page?: number; status?: string; merchantId?: string }) => {
    const params = new URLSearchParams(searchParams)

    const nextPage = next.page ?? page
    const nextStatus = next.status ?? status
    const nextMerchantId = next.merchantId ?? merchantId

    if (nextPage > 1) params.set('page', String(nextPage))
    else params.delete('page')

    if (nextStatus) params.set('status', nextStatus)
    else params.delete('status')

    if (nextMerchantId) params.set('merchantId', nextMerchantId)
    else params.delete('merchantId')

    setSearchParams(params)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'orders', page, status, merchantId],
    queryFn: () => api.getOrders({
      page,
      limit: 20,
      status: status || undefined,
      merchant_id: merchantId || undefined,
    }),
    refetchInterval: 15_000,
  })

  const { data: merchants } = useQuery({
    queryKey: ['admin', 'merchants'],
    queryFn: api.getMerchants,
    staleTime: 60_000,
  })

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Orders</h2>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <select
            value={status}
            onChange={(e) => setFilters({ status: e.target.value, page: 1 })}
            className="text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            value={merchantId}
            onChange={(e) => setFilters({ merchantId: e.target.value, page: 1 })}
            className="text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none max-w-56"
          >
            <option value="">All merchants</option>
            {merchants?.data.map((merchant: Record<string, unknown>) => (
              <option key={merchant.id as string} value={merchant.id as string}>
                {merchant.name as string}
              </option>
            ))}
          </select>
          <span className="text-sm text-gray-500 ml-auto">
            {data?.pagination.total ?? 0} orders
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                <th className="px-4 py-3 font-medium text-gray-600">Order ID</th>
                <th className="px-4 py-3 font-medium text-gray-600">Merchant</th>
                <th className="px-4 py-3 font-medium text-gray-600">Expected</th>
                <th className="px-4 py-3 font-medium text-gray-600">Received</th>
                <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 font-medium text-gray-600">Created</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td>
                </tr>
              )}
              {data?.data.map((order: Record<string, unknown>) => (
                <tr key={order.id as string} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link to={`/admin/orders/${order.id}`} className="text-blue-600 hover:underline font-mono text-xs">
                      {(order.id as string).slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{(order.merchant_name as string) ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-900">{Number(order.amount_expected as string).toFixed(2)} USDT</td>
                  <td className="px-4 py-3 text-gray-900">{Number(order.amount_received as string).toFixed(2)} USDT</td>
                  <td className="px-4 py-3"><StatusBadge status={order.status as string} /></td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{new Date(order.created_at as string).toLocaleString()}</td>
                </tr>
              ))}
              {data?.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No orders found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {data && data.pagination.total_pages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">
              Page {data.pagination.page} of {data.pagination.total_pages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 1}
                onClick={() => setFilters({ page: page - 1 })}
                className="px-3 py-1.5 text-sm border rounded disabled:opacity-40"
              >Prev</button>
              <button
                disabled={page >= data.pagination.total_pages}
                onClick={() => setFilters({ page: page + 1 })}
                className="px-3 py-1.5 text-sm border rounded disabled:opacity-40"
              >Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
