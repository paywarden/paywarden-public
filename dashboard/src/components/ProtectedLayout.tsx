import { Navigate, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/admin'
import Layout from './Layout'

export default function ProtectedLayout() {
  const { isLoading, isError } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: api.getStats,
    retry: false,
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (isError) return <Navigate to="/admin/login" replace />

  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}
