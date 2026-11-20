import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AxiosError, AxiosHeaders } from 'axios'
import { beforeEach, expect, it, vi } from 'vitest'
import Login from '../pages/Login'

const { state } = vi.hoisted(() => ({ state: { error: null as Error | null } }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onError: (error: Error) => void }) => {
    if (state.error) { const error = state.error; state.error = null; options.onError(error) }
    return { isPending: false, mutate: vi.fn() }
  },
}))
beforeEach(() => { state.error = null })
function httpError(status: number, headers = {}) {
  const error = new AxiosError('Request failed')
  error.response = { status, statusText: '', headers, data: {}, config: { headers: new AxiosHeaders() } }
  return error
}
it('shows the rate-limit delay instead of reporting a wrong password', () => {
  state.error = httpError(429, { 'retry-after': '540' })
  const html = renderToStaticMarkup(<Login />)
  expect(html).toContain('Too many sign-in attempts. Try again in 9 minutes.')
  expect(html).not.toContain('Invalid password')
})
it('reports invalid credentials only for HTTP 401', () => {
  state.error = httpError(401)
  expect(renderToStaticMarkup(<Login />)).toContain('Invalid password')
})
it('does not describe server or network failures as incorrect passwords', () => {
  for (const error of [httpError(503), new AxiosError('Network error')]) {
    state.error = error
    const html = renderToStaticMarkup(<Login />)
    expect(html).toContain('Unable to sign in. Please try again.')
    expect(html).not.toContain('Invalid password')
  }
})
