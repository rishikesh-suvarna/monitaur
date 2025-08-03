import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FunnelIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { alertsAPI, serversAPI } from '../apis';
import LoadingSpinner from './LoadingSpinner';

const AlertsPage = () => {
  const [selectedServer, setSelectedServer] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const queryClient = useQueryClient();

  const { data: serversData } = useQuery({
    queryKey: ['servers'],
    queryFn: serversAPI.getServers,
  });

  const resolveAlertMutation = useMutation({
    mutationFn: alertsAPI.resolveAlert,
    onSuccess: () => {
      queryClient.invalidateQueries(['server-alerts']);
      queryClient.invalidateQueries(['dashboard']);
    },
  });

  // Get all alerts from all servers
  const servers = serversData?.data?.servers || [];
  const alertQueries = useQuery({
    queryKey: ['all-alerts', servers.map(s => s.id)],
    queryFn: async () => {
      if (servers.length === 0) return [];

      const alertPromises = servers.map(async (server) => {
        try {
          const response = await alertsAPI.getServerAlerts(server.id, 100);
          return response.data.alerts.map(alert => ({
            ...alert,
            server_name: server.name,
            server_id: server.id,
          }));
        } catch (error) {
          console.error(`Failed to fetch alerts for server ${server.id}:`, error);
          return [];
        }
      });

      const allAlerts = await Promise.all(alertPromises);
      return allAlerts.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
    enabled: servers.length > 0,
  });

  const alerts = alertQueries.data || [];

  // Filter alerts
  const filteredAlerts = alerts.filter(alert => {
    if (selectedServer !== 'all' && alert.server_id !== parseInt(selectedServer)) {
      return false;
    }
    if (statusFilter !== 'all') {
      if (statusFilter === 'resolved' && !alert.resolved) return false;
      if (statusFilter === 'unresolved' && alert.resolved) return false;
    }
    if (levelFilter !== 'all' && alert.level !== levelFilter) {
      return false;
    }
    return true;
  });

  const handleResolveAlert = async (alertId) => {
    await resolveAlertMutation.mutateAsync(alertId);
  };

  const getAlertIcon = (level, resolved) => {
    if (resolved) return CheckCircleIcon;
    return level === 'critical' ? XCircleIcon : ExclamationTriangleIcon;
  };

  const getAlertStyles = (level, resolved) => {
    if (resolved) {
      return 'bg-green-50 border-green-200 text-green-800';
    }
    return level === 'critical'
      ? 'bg-red-50 border-red-200 text-red-800'
      : 'bg-yellow-50 border-yellow-200 text-yellow-800';
  };

  const alertStats = {
    total: alerts.length,
    unresolved: alerts.filter(a => !a.resolved).length,
    critical: alerts.filter(a => a.level === 'critical' && !a.resolved).length,
    warning: alerts.filter(a => a.level === 'warning' && !a.resolved).length,
  };

  if (alertQueries.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Alerts</h1>
        <p className="text-gray-600">Monitor and manage system alerts across all servers</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-4">
        <div className="card">
          <div className="flex items-center">
            <div className="p-3 bg-blue-50 rounded-lg">
              <ExclamationTriangleIcon className="w-6 h-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Alerts</p>
              <p className="text-2xl font-semibold text-gray-900">{alertStats.total}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="p-3 bg-orange-50 rounded-lg">
              <ExclamationTriangleIcon className="w-6 h-6 text-orange-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Unresolved</p>
              <p className="text-2xl font-semibold text-gray-900">{alertStats.unresolved}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="p-3 bg-red-50 rounded-lg">
              <XCircleIcon className="w-6 h-6 text-red-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Critical</p>
              <p className="text-2xl font-semibold text-gray-900">{alertStats.critical}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="p-3 bg-yellow-50 rounded-lg">
              <ExclamationTriangleIcon className="w-6 h-6 text-yellow-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Warning</p>
              <p className="text-2xl font-semibold text-gray-900">{alertStats.warning}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex items-center space-x-4">
          <FunnelIcon className="w-5 h-5 text-gray-500" />
          <div className="flex items-center space-x-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Server</label>
              <select
                value={selectedServer}
                onChange={(e) => setSelectedServer(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
              >
                <option value="all">All Servers</option>
                {servers.map(server => (
                  <option key={server.id} value={server.id}>{server.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
              >
                <option value="all">All Status</option>
                <option value="unresolved">Unresolved</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
              >
                <option value="all">All Levels</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Alerts List */}
      <div className="card">
        {filteredAlerts.length === 0 ? (
          <div className="text-center py-12">
            <CheckCircleIcon className="w-16 h-16 text-green-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {alerts.length === 0 ? 'No alerts found' : 'No alerts match your filters'}
            </h3>
            <p className="text-gray-500">
              {alerts.length === 0
                ? 'All systems are running smoothly!'
                : 'Try adjusting your filters to see more alerts.'
              }
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAlerts.map((alert) => {
              const AlertIcon = getAlertIcon(alert.level, alert.resolved);

              return (
                <div
                  key={alert.id}
                  className={`p-4 rounded-lg border ${getAlertStyles(alert.level, alert.resolved)}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-3">
                      <AlertIcon className="w-5 h-5 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className="font-medium">{alert.server_name}</span>
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                            alert.level === 'critical'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}>
                            {alert.level}
                          </span>
                          {alert.resolved && (
                            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-800">
                              Resolved
                            </span>
                          )}
                        </div>
                        <p className="text-sm mb-2">{alert.message}</p>
                        <div className="flex items-center space-x-4 text-xs text-gray-600">
                          <span>{new Date(alert.created_at).toLocaleString()}</span>
                          {alert.value && alert.threshold && (
                            <span>Value: {alert.value.toFixed(1)}% (Threshold: {alert.threshold}%)</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 ml-4">
                      <Link
                        to={`/servers/${alert.server_id}`}
                        className="p-1 text-gray-500 hover:text-gray-700"
                        title="View server details"
                      >
                        <EyeIcon className="w-4 h-4" />
                      </Link>
                      {!alert.resolved && (
                        <button
                          onClick={() => handleResolveAlert(alert.id)}
                          disabled={resolveAlertMutation.isLoading}
                          className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded hover:bg-green-200 disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AlertsPage;
