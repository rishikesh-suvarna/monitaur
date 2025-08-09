import {
  CheckCircleIcon,
  CircleStackIcon,
  ClockIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  ServerIcon
} from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { dashboardAPI } from '../apis';
import LoadingSpinner from './LoadingSpinner';

const Dashboard = () => {
  const { data: dashboardData, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardAPI.getDashboard,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-primary-800 bg-primary-900 text-white px-4 py-3">
        Error loading dashboard: {error.response?.data?.error || error.message}
      </div>
    );
  }

  const { summary, servers, recent_alerts, system_health } = dashboardData?.data || {};

  const stats = [
    {
      name: 'Total Servers',
      value: summary?.total_servers || 0,
      icon: ComputerDesktopIcon,
    },
    {
      name: 'Online Servers',
      value: summary?.online_servers || 0,
      icon: CheckCircleIcon,
    },
    {
      name: 'Offline Servers',
      value: summary?.offline_servers || 0,
      icon: ClockIcon,
    },
    {
      name: 'Warning Servers',
      value: summary?.warning_servers || 0,
      icon: ExclamationTriangleIcon,
    },
  ];

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatUptime = (seconds) => {
    if (!seconds) return '0m';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <div className="space-y-8 bg-white min-h-screen">
      {/* Header */}
      <div className="border-b border-primary-200 pb-6">
        <h1 className="text-3xl font-light text-black tracking-wide">Monitaur</h1>
        <p className="text-primary-600 mt-1 font-light">
          Server monitoring dashboard
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-0 border border-primary-200">
        {stats.map((stat, index) => (
          <div
            key={stat.name}
            className={`p-6 border-primary-200 ${index < 3 ? 'border-r' : ''}`}
          >
            <div className="flex flex-col items-center text-center">
              <stat.icon className="w-6 h-6 text-black mb-3" />
              <p className="text-2xl font-light text-black mb-1">{stat.value}</p>
              <p className="text-xs text-primary-600 uppercase tracking-wide">{stat.name}</p>
            </div>
          </div>
        ))}
      </div>

      {/* System Health Overview */}
      {system_health && summary?.online_servers > 0 && (
        <div className="border border-primary-200 p-6">
          <h2 className="text-lg font-light text-black mb-6 tracking-wide">System Health</h2>
          <div className="grid grid-cols-3 gap-0 border border-primary-200">
            <div className="p-4 border-r border-primary-200 text-center">
              <CpuChipIcon className="w-5 h-5 text-black mx-auto mb-2" />
              <p className="text-lg font-light text-black">
                {system_health.average_cpu?.toFixed(1)}%
              </p>
              <p className="text-xs text-primary-600 uppercase tracking-wide">CPU</p>
            </div>
            <div className="p-4 border-r border-primary-200 text-center">
              <CircleStackIcon className="w-5 h-5 text-black mx-auto mb-2" />
              <p className="text-lg font-light text-black">
                {system_health.average_memory?.toFixed(1)}%
              </p>
              <p className="text-xs text-primary-600 uppercase tracking-wide">Memory</p>
            </div>
            <div className="p-4 text-center">
              <ServerIcon className="w-5 h-5 text-black mx-auto mb-2" />
              <p className="text-lg font-light text-black">
                {system_health.average_disk?.toFixed(1)}%
              </p>
              <p className="text-xs text-primary-600 uppercase tracking-wide">Disk</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-8">
        {/* Servers List */}
        <div className="border border-primary-200 p-6">
          <h2 className="text-lg font-light text-black mb-6 tracking-wide">Servers</h2>
          {servers && servers.length > 0 ? (
            <div className="space-y-0 border border-primary-200">
              {servers.slice(0, 5).map((server, index) => (
                <div
                  key={server.id}
                  className={`flex items-center justify-between p-4 ${
                    index < servers.slice(0, 5).length - 1 ? 'border-b border-primary-200' : ''
                  }`}
                >
                  <div className="flex items-center">
                    <div className={`w-2 h-2 rounded-full mr-4 ${
                      server.status === 'online' ? 'bg-black' :
                      server.status === 'warning' ? 'bg-primary-500' : 'bg-primary-300'
                    }`} />
                    <div>
                      <p className="font-light text-black">{server.name}</p>
                    </div>
                  </div>
                  <span className="text-xs text-primary-600 uppercase tracking-wide">
                    {server.status}
                  </span>
                </div>
              ))}
              {servers.length > 5 && (
                <div className="p-4 text-center border-t border-primary-200">
                  <p className="text-xs text-primary-600">
                    +{servers.length - 5} more
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <ComputerDesktopIcon className="w-8 h-8 text-primary-400 mx-auto mb-4" />
              <p className="text-primary-600 mb-4 font-light">No servers connected</p>
              <button className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors">
                Add Server
              </button>
            </div>
          )}
        </div>

        {/* Recent Alerts */}
        <div className="border border-primary-200 p-6">
          <h2 className="text-lg font-light text-black mb-6 tracking-wide">Recent Alerts</h2>
          {recent_alerts && recent_alerts.length > 0 ? (
            <div className="space-y-0 border border-primary-200">
              {recent_alerts.slice(0, 5).map((alert, index) => (
                <div
                  key={alert.id}
                  className={`p-4 ${
                    index < recent_alerts.slice(0, 5).length - 1 ? 'border-b border-primary-200' : ''
                  }`}
                >
                  <div className="flex items-start">
                    <ExclamationTriangleIcon className="w-4 h-4 text-black mt-1 mr-3" />
                    <div className="flex-1">
                      <p className="font-light text-black text-sm">{alert.message}</p>
                      <p className="text-xs text-primary-600 mt-2">
                        {alert.server?.name} • {new Date(alert.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <CheckCircleIcon className="w-8 h-8 text-primary-400 mx-auto mb-4" />
              <p className="text-primary-600 font-light">No alerts</p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="border border-primary-200 p-6">
        <h2 className="text-lg font-light text-black mb-6 tracking-wide">Actions</h2>
        <div className="flex space-x-4">
          <Link
            to="/servers"
            className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors flex items-center"
          >
            <PlusIcon className="w-4 h-4 mr-2" />
            Add Server
          </Link>
          <Link
            to="/alerts"
            className="border border-primary-300 px-4 py-2 text-primary-600 hover:border-black hover:text-black transition-colors flex items-center"
          >
            <ExclamationTriangleIcon className="w-4 h-4 mr-2" />
            View Alerts
          </Link>
          <Link
            to="/settings"
            className="border border-primary-300 px-4 py-2 text-primary-600 hover:border-black hover:text-black transition-colors flex items-center"
          >
            <CpuChipIcon className="w-4 h-4 mr-2" />
            Settings
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
