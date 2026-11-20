import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Siren, ShieldAlert } from 'lucide-react'
import { api } from '../api/admin'

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function Overview() {
  const { data: stats } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: api.getStats,
    refetchInterval: 30_000,
  })

  const { data: wallet } = useQuery({
    queryKey: ['admin', 'wallet'],
    queryFn: api.getWallet,
    refetchInterval: 15_000,
  })

  const { data: daily = [] } = useQuery({
    queryKey: ['admin', 'stats', 'daily'],
    queryFn: api.getDailyStats,
    refetchInterval: 60_000,
  })

  const { data: incidents } = useQuery({
    queryKey: ['admin', 'incidents'],
    queryFn: api.getIncidents,
    refetchInterval: 15_000,
  })

  const freeAddresses = stats?.address_pool.free ?? 0
  const totalAddresses = stats?.address_pool.total ?? 0
  const hasLowAddressPool =
    totalAddresses > 0 && (freeAddresses < 5 || freeAddresses / totalAddresses < 0.2)
  const sweepFailures = wallet?.sweep_queue.failed ?? 0
  const hasHotWalletWarning = !!wallet?.hot_wallet?.is_low_balance
  const activeIssues = [
    hasHotWalletWarning,
    sweepFailures > 0,
    hasLowAddressPool,
  ].filter(Boolean).length

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Overview</h2>

      <div className={`mb-6 rounded-xl border p-4 ${
        activeIssues > 0
          ? 'border-orange-200 bg-orange-50'
          : 'border-emerald-200 bg-emerald-50'
      }`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className={`inline-flex items-center gap-2 text-sm font-medium ${
              activeIssues > 0 ? 'text-orange-800' : 'text-emerald-800'
            }`}>
              {activeIssues > 0 ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              {activeIssues > 0 ? `Operations need attention (${activeIssues})` : 'Operations look healthy'}
            </div>
            <p className="mt-2 text-sm text-gray-700">
              {activeIssues > 0
                ? 'Hot wallet balance, sweep failures, and address pool capacity are the fastest ways this gateway degrades in production.'
                : 'No active wallet, sweep, or address pool issues are visible from the current admin metrics.'}
            </p>
          </div>
          <Link
            to="/admin/settings"
            className="inline-flex items-center gap-2 self-start rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Open wallet settings
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
        <StatCard
          label="Orders Today"
          value={stats?.today.order_count ?? '—'}
          sub={`${stats?.today.completed_count ?? 0} completed`}
        />
        <StatCard
          label="Revenue Today (USDT)"
          value={stats ? Number(stats.today.total_received).toFixed(2) : '—'}
        />
        <StatCard
          label="Success Rate Today"
          value={stats ? `${stats.today.success_rate}%` : '—'}
        />
        <StatCard
          label="Total Merchants"
          value={stats?.total.merchant_count ?? '—'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-3">
        <StatCard
          label="Total Orders"
          value={stats?.total.order_count ?? '—'}
          sub={`${stats?.total.completed_count ?? 0} completed`}
        />
        <StatCard
          label="Total Revenue (USDT)"
          value={stats ? Number(stats.total.total_received).toFixed(2) : '—'}
        />
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Address Pool</p>
          <p className="text-2xl font-semibold text-gray-900 mt-1">
            {stats?.address_pool.free ?? '—'} / {stats?.address_pool.total ?? '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">free / total</p>
          {stats && (
            <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full"
                style={{
                  width: stats.address_pool.total > 0
                    ? `${(stats.address_pool.free / stats.address_pool.total) * 100}%`
                    : '0%'
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-3">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Hot Wallet</p>
          <p className={`text-2xl font-semibold mt-1 ${
            hasHotWalletWarning ? 'text-orange-700' : 'text-gray-900'
          }`}>
            {!wallet
              ? '—'
              : !wallet.hot_wallet
                ? 'Disabled'
                : `${Number(wallet.hot_wallet.trx_balance).toFixed(2)} TRX`}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {!wallet
              ? 'Loading wallet status'
              : !wallet.hot_wallet
                ? 'Sweep mode is not configured'
                : wallet.hot_wallet.is_low_balance
                  ? 'Below alert threshold'
                  : 'Balance above alert threshold'}
          </p>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Sweep Queue</p>
          <p className={`text-2xl font-semibold mt-1 ${
            sweepFailures > 0 ? 'text-rose-700' : 'text-gray-900'
          }`}>
            {!wallet ? '—' : sweepFailures}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {!wallet
              ? 'Loading queue status'
              : sweepFailures > 0
                ? `${wallet.sweep_queue.waiting} waiting, ${wallet.sweep_queue.active} active`
                : 'No failed sweep jobs'}
          </p>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Operational Risks</p>
          <p className={`text-2xl font-semibold mt-1 ${
            activeIssues > 0 ? 'text-orange-700' : 'text-gray-900'
          }`}>
            {activeIssues}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {hasLowAddressPool
              ? `Address pool is running low at ${freeAddresses}/${totalAddresses}`
              : 'Address pool has healthy headroom'}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <p className="text-sm font-medium text-gray-700">Recent Incidents</p>
            <p className="text-xs text-gray-400 mt-1">
              Latest webhook and sweep failures from the event log
            </p>
          </div>
          <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            (incidents?.data?.length ?? 0) > 0
              ? 'bg-rose-50 text-rose-700'
              : 'bg-gray-100 text-gray-500'
          }`}>
            <Siren size={14} />
            {incidents?.data?.length ?? 0} recent incidents
          </div>
        </div>

        {!incidents ? (
          <p className="text-sm text-gray-400">Loading incidents...</p>
        ) : incidents.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 size={16} />
            No webhook or sweep failures recorded recently.
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.data.map((incident: Record<string, unknown>) => {
              const payload = (incident.payload as Record<string, unknown> | null) ?? {}
              const reason = typeof payload.reason === 'string' ? payload.reason : 'No reason recorded'
              const eventType = incident.event_type as string
              const isSweep = eventType === 'sweep_failed'
              const orderStatus = typeof incident.order_status === 'string' ? incident.order_status : ''

              return (
                <div
                  key={incident.id as string}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3"
                >
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                        <ShieldAlert size={15} className={isSweep ? 'text-amber-600' : 'text-rose-600'} />
                        {isSweep ? 'Sweep failed' : 'Webhook failed'}
                        {orderStatus && (
                          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-gray-600 border border-gray-200">
                            {orderStatus}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-gray-700 break-words">{reason}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span>Merchant: {String(incident.merchant_name ?? '—')}</span>
                        <span>External ID: {String(incident.external_id ?? '—')}</span>
                        {payload.attempt !== undefined && <span>Attempt: {String(payload.attempt)}</span>}
                        {payload.attempts_made !== undefined && <span>Attempts: {String(payload.attempts_made)}</span>}
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

      {daily.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <p className="text-sm font-medium text-gray-700 mb-4">7-Day Revenue (USDT)</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: unknown) => [Number(v).toFixed(2), 'USDT']} />
              <Line type="monotone" dataKey="total_received" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
