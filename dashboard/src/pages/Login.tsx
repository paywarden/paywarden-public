import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { api } from '../api/admin'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: () => navigate('/admin/overview'),
    onError: (error) => {
      if (isAxiosError(error) && error.response?.status === 429) {
        const seconds = Number(error.response.headers['retry-after'])
        const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null
        setError(minutes
          ? `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
          : 'Too many sign-in attempts. Please try again later.')
      } else if (isAxiosError(error) && error.response?.status === 401) {
        setError('Invalid password')
      } else {
        setError('Unable to sign in. Please try again.')
      }
    },
  })

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Admin Login</h1>
        <p className="text-sm text-gray-500 mb-6">PayWarden Gateway</p>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            setError('')
            mutation.mutate()
          }}
        >
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter admin password"
              autoFocus
            />
          </div>

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

          <button
            type="submit"
            disabled={mutation.isPending || !password}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {mutation.isPending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
