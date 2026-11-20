import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '../api/admin'

export default function Settings() {
  const { data } = useQuery({
    queryKey: ['admin', 'wallet'],
    queryFn: api.getWallet,
    refetchInterval: 15_000,
  })

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Settings</h2>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Chain Environment</h3>
          {!data ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Network</dt>
                <dd className="font-medium text-gray-900">{data.system.tron_network}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Sweep Mode</dt>
                <dd className="font-medium text-gray-900">
                  {data.system.sweep_enabled ? data.system.sweep_mode : 'disabled'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Hot Wallet Alert</dt>
                <dd className="font-medium text-gray-900">{data.system.hot_wallet_alert_trx} TRX</dd>
              </div>
              <div>
                <dt className="text-gray-500 mb-1">USDT Contract</dt>
                <dd className="font-mono text-xs text-gray-700 break-all">{data.system.usdt_contract}</dd>
              </div>
              <div>
                <dt className="text-gray-500 mb-1">TronGrid URL</dt>
                <dd className="font-mono text-xs text-gray-700 break-all">{data.system.trongrid_url}</dd>
              </div>
            </dl>
          )}
        </div>

        {/* Hot Wallet */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Hot Wallet</h3>
          {!data ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : !data.hot_wallet ? (
            <p className="text-sm text-gray-400">Not configured (HOT_WALLET_KEY not set)</p>
          ) : (
            <div className="space-y-3">
              {data.hot_wallet.is_low_balance && (
                <div className="flex items-center gap-2 text-orange-700 bg-orange-50 rounded-md px-3 py-2 text-sm">
                  <AlertTriangle size={14} />
                  Low TRX balance — please top up
                </div>
              )}
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Address</dt>
                  <dd className="font-mono text-xs text-gray-700 truncate max-w-[200px]">{data.hot_wallet.address}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">TRX Balance</dt>
                  <dd className="font-medium">{Number(data.hot_wallet.trx_balance).toFixed(2)} TRX</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {/* Cold Wallet */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Cold Wallet</h3>
          {!data ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : !data.cold_wallet ? (
            <p className="text-sm text-gray-400">Not configured (COLD_WALLET_ADDRESS not set)</p>
          ) : (
            <p className="font-mono text-xs text-gray-700 break-all">{data.cold_wallet.address}</p>
          )}
        </div>

        {/* Address Pool */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Address Pool</h3>
          {data ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Total</dt>
                <dd>{data.address_pool.total}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Free</dt>
                <dd className="text-green-700">{data.address_pool.free}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Allocated</dt>
                <dd className="text-blue-700">{data.address_pool.allocated}</dd>
              </div>
              <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5">
                <div
                  className="bg-green-500 h-1.5 rounded-full"
                  style={{
                    width: data.address_pool.total > 0
                      ? `${(data.address_pool.free / data.address_pool.total) * 100}%`
                      : '0%',
                  }}
                />
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gray-400">Loading...</p>
          )}
        </div>

        {/* Sweep Queue */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="font-medium text-gray-900 mb-4">Sweep Queue</h3>
          {data ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Waiting</dt>
                <dd>{data.sweep_queue.waiting}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Active</dt>
                <dd className="text-blue-700">{data.sweep_queue.active}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Failed</dt>
                <dd className={data.sweep_queue.failed > 0 ? 'text-red-600 font-medium' : ''}>{data.sweep_queue.failed}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gray-400">Loading...</p>
          )}
        </div>
      </div>
    </div>
  )
}
