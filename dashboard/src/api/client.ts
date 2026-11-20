import axios from 'axios'

const client = axios.create({ withCredentials: true })

client.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && !window.location.pathname.includes('/login')) {
      window.location.href = '/admin/login'
    }
    return Promise.reject(err)
  },
)

export default client
