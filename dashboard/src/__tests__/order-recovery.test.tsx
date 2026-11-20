import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OrderDetail from '../pages/OrderDetail'

const { state } = vi.hoisted(() => ({ state: { data: {} as Record<string, unknown> } }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.data, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'order' }),
  Link: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children) }))

describe('admin recovery actions', () => {
  beforeEach(() => {
    state.data = { order: { id: 'order', external_id: 'invoice', address: 'address', status: 'underpaid',
      amount_expected: '100', amount_received: '1', created_at: '', expires_at: '' }, events: [],
      meta: { sweep_enabled: true }, recovery: { webhook: { can_retry: true }, sweep: { can_retry: true } } }
  })
  it.each(['underpaid', 'overpaid'])('renders both failed-step recovery buttons for %s', (status) => {
    (state.data.order as Record<string, unknown>).status = status
    const html = renderToStaticMarkup(<OrderDetail />)
    expect(html).toContain('Retry webhook'); expect(html).toContain('Retry sweep')
  })
  it('does not offer retry for already delivered callbacks or successful sweeps with old failure events', () => {
    state.data.recovery = { webhook: { can_retry: false }, sweep: { can_retry: false } }
    state.data.events = [{ event_type: 'sweep_failed', created_at: '', payload: {} }]
    ;(state.data.order as Record<string, unknown>).status = 'callback_failed'
    const html = renderToStaticMarkup(<OrderDetail />)
    expect(html).not.toContain('Retry webhook'); expect(html).not.toContain('Retry sweep')
  })
})
