import {
  CheckCircleIcon,
  ClockIcon,
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import api from '../config/api';

const Dashboard = () => {
  const { data: dashboardData, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const response = await api.get('/dashboard');
      return response.data;
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-danger-50 border border-danger-200 text-danger-700 px-4 py-3 rounded">
        Error loading dashboard: {error.message}
      </div>
    );
  }

  const { summary, servers, recent_alerts } = dashboardData || {};

  const stats = [
    {
      name: 'Total Servers',
      value: summary?.total_servers || 0,
      icon: ComputerDesktopIcon,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
    },
    {
      name: 'Online Servers',
      value: summary?.online_servers || 0,
      icon: CheckCircleIcon,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
    },
    {
      name: 'Offline Servers',
      value: summary?.offline_servers || 0,
      icon: ClockIcon,
      color: 'text-gray-600',
      bgColor: 'bg-gray-50',
    },
    {
      name: 'Warning Servers',
      value: summary?.warning_servers || 0,
      icon: ExclamationTriangleIcon,
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-50',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.name} className="card">
            <div className="flex items-center">
              <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">{stat.name}</p>
                <p className="text-2xl font-semibold text-gray-900">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Servers List */}
        <div className="card">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Servers</h3>
          {servers && servers.length > 0 ? (
            <div className="space-y-3">
              {servers.slice(0, 5).map((server) => (
                <div key={server.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center">
                    <div className={`w-3 h-3 rounded-full mr-3 ${
                      server.status === 'online' ? 'bg-green-500' :
                      server.status === 'warning' ? 'bg-yellow-500' : 'bg-gray-400'
                    }`} />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{server.name}</p>
                      <p className="text-xs text-gray-500 capitalize">{server.status}</p>
                    </div>
                  </div>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                    server.status === 'online' ? 'bg-green-100 text-green-800' :
                    server.status === 'warning' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {server.status}
                  </span>
                </div>
              ))}
              {servers.length > 5 && (
                <p className="text-sm text-gray-500 text-center">
                  And {servers.length - 5} more servers...
                </p>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <ComputerDesktopIcon className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500">No servers connected yet</p>
              <button className="mt-2 btn btn-primary">
                Add Your First Server
              </button>
            </div>
          )}
        </div>

        {/* Recent Alerts */}
        <div className="card">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Alerts</h3>
          {recent_alerts && recent_alerts.length > 0 ? (
            <div className="space-y-3">
              {recent_alerts.slice(0, 5).map((alert) => (
                <div key={alert.id} className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-start">
                    <ExclamationTriangleIcon className="w-5 h-5 text-red-500 mt-0.5 mr-3" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-900">{alert.message}</p>
                      <p className="text-xs text-red-600 mt-1">
                        {alert.server?.name} • {new Date(alert.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <CheckCircleIcon className="w-12 h-12 text-green-400 mx-auto mb-4" />
              <p className="text-gray-500">No recent alerts</p>
              <p className="text-sm text-gray-400">All systems running smoothly</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
