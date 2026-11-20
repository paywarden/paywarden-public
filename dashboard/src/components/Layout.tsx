import { NavLink, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LayoutDashboard, ShoppingCart, Store, Settings, LogOut } from 'lucide-react'
import { api } from '../api/admin'

const navItems = [
  { to: '/admin/overview', icon: LayoutDashboard, label: 'Overview' },
  { to: '/admin/orders', icon: ShoppingCart, label: 'Orders' },
  { to: '/admin/merchants', icon: Store, label: 'Merchants' },
  { to: '/admin/settings', icon: Settings, label: 'Settings' },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.clear()
      navigate('/admin/login')
    },
  })

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-6 py-5 border-b border-gray-200">
          <h1 className="text-base font-semibold text-gray-900">PayWarden</h1>
          <p className="text-xs text-gray-400 mt-0.5">Admin</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-gray-200">
          <button
            onClick={() => logout.mutate()}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
