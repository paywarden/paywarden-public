import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import './index.css'
import ProtectedLayout from './components/ProtectedLayout'

const Login = lazy(() => import('./pages/Login'))
const Overview = lazy(() => import('./pages/Overview'))
const Orders = lazy(() => import('./pages/Orders'))
const OrderDetail = lazy(() => import('./pages/OrderDetail'))
const Merchants = lazy(() => import('./pages/Merchants'))
const MerchantDetail = lazy(() => import('./pages/MerchantDetail'))
const Settings = lazy(() => import('./pages/Settings'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

function withSuspense(node: React.ReactNode) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-gray-500">
          Loading...
        </div>
      }
    >
      {node}
    </Suspense>
  )
}

const router = createBrowserRouter([
  { path: '/admin/login', element: withSuspense(<Login />) },
  {
    path: '/admin',
    element: <ProtectedLayout />,
    children: [
      { index: true, element: <Navigate to="/admin/overview" replace /> },
      { path: 'overview', element: withSuspense(<Overview />) },
      { path: 'orders', element: withSuspense(<Orders />) },
      { path: 'orders/:id', element: withSuspense(<OrderDetail />) },
      { path: 'merchants', element: withSuspense(<Merchants />) },
      { path: 'merchants/:id', element: withSuspense(<MerchantDetail />) },
      { path: 'settings', element: withSuspense(<Settings />) },
    ],
  },
  { path: '*', element: <Navigate to="/admin" replace /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
