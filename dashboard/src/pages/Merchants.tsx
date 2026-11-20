import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Copy, Check } from 'lucide-react'
import { api } from '../api/admin'

interface NewMerchantResult {
  id: string
  name: string
  api_key: string
  webhook_secret: string
}

export default function Merchants() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newMerchant, setNewMerchant] = useState<NewMerchantResult | null>(null)
  const [form, setForm] = useState({ name: '', webhook_secret: '' })
  const [copied, setCopied] = useState(false)

  const { data } = useQuery({
    queryKey: ['admin', 'merchants'],
    queryFn: api.getMerchants,
  })

  const create = useMutation({
    mutationFn: () => api.createMerchant(form),
    onSuccess: (result: NewMerchantResult) => {
      setNewMerchant(result)
      setShowCreate(false)
      setForm({ name: '', webhook_secret: '' })
      qc.invalidateQueries({ queryKey: ['admin', 'merchants'] })
    },
  })

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.updateMerchant(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'merchants'] }),
  })

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Merchants</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          + New Merchant
        </button>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h3 className="font-semibold text-gray-900 mb-4">Create Merchant</h3>
            <div className="space-y-3 mb-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Webhook Secret</label>
                <input
                  value={form.webhook_secret}
                  onChange={(e) => setForm((f) => ({ ...f, webhook_secret: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="min 8 characters"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button
                onClick={() => create.mutate()}
                disabled={!form.name || form.webhook_secret.length < 8 || create.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
              >
                {create.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API key reveal dialog */}
      {newMerchant && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h3 className="font-semibold text-gray-900 mb-1">Merchant Created</h3>
            <p className="text-sm text-red-600 mb-4">Save this API key now — it will not be shown again.</p>
            <div className="bg-gray-50 rounded p-3 mb-4">
              <p className="text-xs text-gray-500 mb-1">API Key</p>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-800 break-all flex-1">{newMerchant.api_key}</code>
                <button onClick={() => copyKey(newMerchant.api_key)} className="text-gray-500 hover:text-gray-900 shrink-0">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <button
              onClick={() => setNewMerchant(null)}
              className="w-full py-2 bg-gray-900 text-white rounded text-sm font-medium"
            >
              I have saved the API key
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              <th className="px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="px-4 py-3 font-medium text-gray-600">API Key Prefix</th>
              <th className="px-4 py-3 font-medium text-gray-600">Orders</th>
              <th className="px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 font-medium text-gray-600">Created</th>
              <th className="px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((m: Record<string, unknown>) => (
              <tr key={m.id as string} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
                  <Link to={`/admin/merchants/${m.id as string}`} className="text-blue-600 hover:underline">
                    {m.name as string}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-600">pw_{m.api_key_prefix as string}...</td>
                <td className="px-4 py-3 text-gray-600">{m.order_count as number}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${(m.is_active as boolean) ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {(m.is_active as boolean) ? 'active' : 'inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{new Date(m.created_at as string).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Link to={`/admin/merchants/${m.id as string}`} className="text-xs text-blue-600 hover:underline">
                      View
                    </Link>
                    <button
                      onClick={() => toggle.mutate({ id: m.id as string, is_active: !(m.is_active as boolean) })}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {(m.is_active as boolean) ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
