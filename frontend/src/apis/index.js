import api from '../config/api';

// Dashboard API
export const dashboardAPI = {
  getDashboard: () => api.get('/dashboard'),
};

// Servers API
export const serversAPI = {
  getServers: () => api.get('/servers'),
  createServer: (data) => api.post('/servers', data),
  deleteServer: (id) => api.delete(`/servers/${id}`),
  getServerMetrics: (id, hours = 24) => api.get(`/servers/${id}/metrics?hours=${hours}`),
  getServerDashboard: (id, hours = 24) => api.get(`/servers/${id}/dashboard?hours=${hours}`),
  getMetricsChart: (id, type = 'cpu', hours = 24) =>
    api.get(`/servers/${id}/chart?type=${type}&hours=${hours}`),
};

// Alerts API
export const alertsAPI = {
  getServerAlerts: (id, limit = 50) => api.get(`/servers/${id}/alerts?limit=${limit}`),
  resolveAlert: (id) => api.put(`/alerts/${id}/resolve`),
};

// User API
export const userAPI = {
  getProfile: () => api.get('/profile'),
};
