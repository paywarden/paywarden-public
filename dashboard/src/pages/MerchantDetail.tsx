import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, ShieldAlert, Store } from 'lucide-react'
import { api } from '../api/admin'
import StatusBadge from '../components/StatusBadge'

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function MerchantDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'merchant', id],
    queryFn: () => api.getMerchant(id!),
    refetchInterval: 15_000,
  })
  const [name, setName] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const saveMerchant = useMutation({
    mutationFn: () =>
      api.updateMerchant(id!, {
        name: name.trim(),
        is_active: isActive,
        webhook_secret: webhookSecret.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'merchant', id] })
      qc.invalidateQueries({ queryKey: ['admin', 'merchants'] })
      setWebhookSecret('')
    },
  })
  const rotateApiKey = useMutation({
    mutationFn: () => api.rotateMerchantApiKey(id!),
    onSuccess: (result: { api_key: string }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'merchant', id] })
      qc.invalidateQueries({ queryKey: ['admin', 'merchants'] })
      setNewApiKey(result.api_key)
    },
  })

  useEffect(() => {
    if (!data?.merchant) return
    setName(data.merchant.name)
    setIsActive(data.merchant.is_active)
    setWebhookSecret('')
  }, [data?.merchant])

  if (isLoading) return <div className="text-gray-400 p-4">Loading...</div>
  if (!data) return <div className="text-gray-400 p-4">Merchant not found</div>

  const { merchant, stats, recent_orders: recentOrders, incidents } = data
  const needsAttention = stats.callback_failed_count > 0 || stats.incident_count > 0

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin/merchants" className="text-sm text-blue-600 hover:underline">← Merchants</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-600 font-mono">{merchant.id}</span>
      </div>

      <div className={`mb-6 rounded-xl border p-4 ${
        needsAttention ? 'border-orange-200 bg-orange-50' : 'border-emerald-200 bg-emerald-50'
      }`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white border border-gray-200">
                <Store size={20} className="text-gray-700" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{merchant.name}</h2>
                <p className="text-sm text-gray-500">pw_{merchant.api_key_prefix}...</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                merchant.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {merchant.is_active ? 'Active' : 'Inactive'}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                needsAttention ? 'bg-orange-100 text-orange-700' : 'bg-emerald-100 text-emerald-700'
              }`}>
                {needsAttention ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                {needsAttention ? 'Needs attention' : 'Healthy'}
              </span>
            </div>
          </div>

          <div className="text-sm text-gray-600">
            Created {new Date(merchant.created_at).toLocaleString()}
          </div>
        </div>
        <div className="mt-4">
          <Link
            to={`/admin/orders?merchantId=${merchant.id}`}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            View all merchant orders
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      {newApiKey && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium text-rose-800">New API key generated</p>
              <p className="mt-1 text-sm text-gray-700">
                Save it now. This raw key will not be shown again.
              </p>
            </div>
            <button
              onClick={() => setNewApiKey(null)}
              className="self-start rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700"
            >
              I have saved it
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-white px-3 py-3 border border-rose-100">
            <code className="flex-1 break-all text-xs text-gray-800">{newApiKey}</code>
            <button
              onClick={() => copyKey(newApiKey)}
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700"
            >
              <Copy size={14} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
        <StatCard
          label="Total Orders"
          value={stats.order_count}
          sub={`${stats.active_order_count} active`}
        />
        <StatCard
          label="Total Revenue (USDT)"
          value={Number(stats.total_received).toFixed(2)}
        />
        <StatCard
          label="Success Rate"
          value={`${stats.success_rate}%`}
          sub={`${stats.completed_count} completed`}
        />
        <StatCard
          label="Callback Failures"
          value={stats.callback_failed_count}
          sub={`${stats.incident_count} recent incidents`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-3">
        <div className="bg-white rounded-lg border border-gray-200 p-5 lg:col-span-1">
          <h3 className="font-medium text-gray-900 mb-4">Merchant Profile</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Status</dt>
              <dd className="font-medium text-gray-900">{merchant.is_active ? 'Active' : 'Inactive'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">API Key Prefix</dt>
              <dd className="font-mono text-xs text-gray-700">pw_{merchant.api_key_prefix}...</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Last Order</dt>
              <dd className="text-gray-700">
                {stats.last_order_at ? new Date(stats.last_order_at).toLocaleString() : 'No orders yet'}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Webhook Health</dt>
              <dd className={`font-medium ${needsAttention ? 'text-orange-700' : 'text-emerald-700'}`}>
                {needsAttention ? 'Intervention needed' : 'Healthy'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">Manage Merchant</h3>
            <span className="text-xs text-gray-400">Update settings without leaving this page</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Merchant Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Rotate Webhook Secret</label>
              <input
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Leave blank to keep the current secret"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                This updates the merchant default for new orders. Existing orders keep their snapshotted secret.
              </p>
            </div>

            <div className="md:col-span-2">
              <label className="inline-flex items-center gap-3 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Merchant is active
              </label>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => saveMerchant.mutate()}
              disabled={!name.trim() || (webhookSecret.trim().length > 0 && webhookSecret.trim().length < 8) || saveMerchant.isPending}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saveMerchant.isPending ? 'Saving...' : 'Save changes'}
            </button>
            {saveMerchant.isSuccess && (
              <span className="text-sm text-emerald-700">Merchant updated.</span>
            )}
            {saveMerchant.error && (
              <span className="text-sm text-rose-700">{(saveMerchant.error as Error).message}</span>
            )}
          </div>

          <div className="mt-6 border-t border-gray-100 pt-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">Rotate API Key</p>
                <p className="mt-1 text-xs text-gray-400">
                  Immediately invalidates the current key and issues a new one for this merchant.
                </p>
              </div>
              <button
                onClick={() => rotateApiKey.mutate()}
                disabled={rotateApiKey.isPending}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
              >
                {rotateApiKey.isPending ? 'Generating...' : 'Generate new API key'}
              </button>
            </div>
            {rotateApiKey.error && (
              <p className="mt-3 text-sm text-rose-700">{(rotateApiKey.error as Error).message}</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">Recent Incidents</h3>
            <span className="text-xs text-gray-400">{incidents.length} items</span>
          </div>

          {incidents.length === 0 ? (
            <div className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <CheckCircle2 size={16} />
              No webhook or sweep failures recorded for this merchant.
            </div>
          ) : (
            <div className="space-y-3">
              {incidents.map((incident: Record<string, unknown>) => {
                const payload = (incident.payload as Record<string, unknown> | null) ?? {}
                const reason = typeof payload.reason === 'string' ? payload.reason : 'No reason recorded'
                const eventType = incident.event_type === 'sweep_failed' ? 'Sweep failed' : 'Webhook failed'

                return (
                  <div key={incident.id as string} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                          <ShieldAlert size={15} className="text-rose-600" />
                          {eventType}
                        </div>
                        <p className="mt-1 text-sm text-gray-700 break-words">{reason}</p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                          <span>External ID: {String(incident.external_id ?? '—')}</span>
                          <span>Status: {String(incident.order_status ?? '—')}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-start gap-2 lg:items-end">
                        <span className="text-xs text-gray-500">
                          {new Date(incident.created_at as string).toLocaleString()}
                        </span>
                        <Link
                          to={`/admin/orders/${incident.order_id as string}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
                        >
                          Open order
                          <ArrowRight size={14} />
                        </Link>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-medium text-gray-900">Recent Orders</h3>
          <span className="text-sm text-gray-500">{recentOrders.length} items</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                <th className="px-4 py-3 font-medium text-gray-600">Order ID</th>
                <th className="px-4 py-3 font-medium text-gray-600">External ID</th>
                <th className="px-4 py-3 font-medium text-gray-600">Expected</th>
                <th className="px-4 py-3 font-medium text-gray-600">Received</th>
                <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 font-medium text-gray-600">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No orders yet</td>
                </tr>
              )}
              {recentOrders.map((order: Record<string, unknown>) => (
                <tr key={order.id as string} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link to={`/admin/orders/${order.id}`} className="text-blue-600 hover:underline font-mono text-xs">
                      {(order.id as string).slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{String(order.external_id ?? '—')}</td>
                  <td className="px-4 py-3 text-gray-900">{Number(order.amount_expected as string).toFixed(2)} USDT</td>
                  <td className="px-4 py-3 text-gray-900">{Number(order.amount_received as string).toFixed(2)} USDT</td>
                  <td className="px-4 py-3"><StatusBadge status={order.status as string} /></td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{new Date(order.created_at as string).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
