import client from './client'

export const api = {
  login: (password: string) =>
    client.post('/api/v1/admin/auth/login', { password }),

  logout: () =>
    client.post('/api/v1/admin/auth/logout'),

  getStats: () =>
    client.get('/api/v1/admin/stats').then((r) => r.data),

  getDailyStats: () =>
    client.get('/api/v1/admin/stats/daily').then((r) => r.data),

  getIncidents: () =>
    client.get('/api/v1/admin/incidents').then((r) => r.data),

  getOrders: (params: Record<string, string | number | undefined>) =>
    client.get('/api/v1/admin/orders', { params }).then((r) => r.data),

  getOrder: (id: string) =>
    client.get(`/api/v1/admin/orders/${id}`).then((r) => r.data),

  retryOrderWebhook: (id: string) =>
    client.post(`/api/v1/admin/orders/${id}/retry-webhook`).then((r) => r.data),

  retryOrderSweep: (id: string) =>
    client.post(`/api/v1/admin/orders/${id}/retry-sweep`).then((r) => r.data),

  getMerchants: () =>
    client.get('/api/v1/admin/merchants').then((r) => r.data),

  getMerchant: (id: string) =>
    client.get(`/api/v1/admin/merchants/${id}`).then((r) => r.data),

  rotateMerchantApiKey: (id: string) =>
    client.post(`/api/v1/admin/merchants/${id}/rotate-api-key`).then((r) => r.data),

  createMerchant: (data: { name: string; webhook_secret: string }) =>
    client.post('/api/v1/admin/merchants', data).then((r) => r.data),

  updateMerchant: (id: string, data: { name?: string; is_active?: boolean; webhook_secret?: string }) =>
    client.put(`/api/v1/admin/merchants/${id}`, data).then((r) => r.data),

  getWallet: () =>
    client.get('/api/v1/admin/wallet').then((r) => r.data),
}
