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
    <div className="space-y-8 bg-white">
      {/* Header */}
      <div className="border-b border-primary-200 pb-6">
        <h1 className="text-2xl font-light text-black tracking-wide">Alerts</h1>
        <p className="text-primary-600 mt-1 font-light text-sm">Monitor system alerts across servers</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-0 border border-primary-200">
        <div className="p-6 border-r border-primary-200 text-center">
          <ExclamationTriangleIcon className="w-5 h-5 text-black mx-auto mb-3" />
          <p className="text-xl font-light text-black mb-1">{alertStats.total}</p>
          <p className="text-xs text-primary-600 uppercase tracking-wide">Total</p>
        </div>
        <div className="p-6 border-r border-primary-200 text-center">
          <ExclamationTriangleIcon className="w-5 h-5 text-black mx-auto mb-3" />
          <p className="text-xl font-light text-black mb-1">{alertStats.unresolved}</p>
          <p className="text-xs text-primary-600 uppercase tracking-wide">Unresolved</p>
        </div>
        <div className="p-6 border-r border-primary-200 text-center">
          <XCircleIcon className="w-5 h-5 text-black mx-auto mb-3" />
          <p className="text-xl font-light text-black mb-1">{alertStats.critical}</p>
          <p className="text-xs text-primary-600 uppercase tracking-wide">Critical</p>
        </div>
        <div className="p-6 text-center">
          <ExclamationTriangleIcon className="w-5 h-5 text-black mx-auto mb-3" />
          <p className="text-xl font-light text-black mb-1">{alertStats.warning}</p>
          <p className="text-xs text-primary-600 uppercase tracking-wide">Warning</p>
        </div>
      </div>

      {/* Filters */}
      <div className="border border-primary-200 p-6">
        <div className="flex items-center space-x-6">
          <FunnelIcon className="w-4 h-4 text-primary-600" />
          <div className="flex items-center space-x-6">
            <div>
              <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">Server</label>
              <select
                value={selectedServer}
                onChange={(e) => setSelectedServer(e.target.value)}
                className="border border-primary-300 px-3 py-2 text-black focus:outline-none focus:border-black text-sm"
              >
                <option value="all">All Servers</option>
                {servers.map(server => (
                  <option key={server.id} value={server.id}>{server.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="border border-primary-300 px-3 py-2 text-black focus:outline-none focus:border-black text-sm"
              >
                <option value="all">All Status</option>
                <option value="unresolved">Unresolved</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">Level</label>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="border border-primary-300 px-3 py-2 text-black focus:outline-none focus:border-black text-sm"
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
      <div className="border border-primary-200 p-6">
        {filteredAlerts.length === 0 ? (
          <div className="text-center py-16">
            <CheckCircleIcon className="w-12 h-12 text-primary-400 mx-auto mb-6" />
            <h2 className="text-lg font-light text-black mb-2 tracking-wide">
              {alerts.length === 0 ? 'No alerts' : 'No matching alerts'}
            </h2>
            <p className="text-primary-600 font-light">
              {alerts.length === 0
                ? 'All systems running smoothly'
                : 'Try adjusting filters'
              }
            </p>
          </div>
        ) : (
          <div className="space-y-0 border border-primary-200">
            {filteredAlerts.map((alert, index) => (
              <div
                key={alert.id}
                className={`p-4 ${
                  index < filteredAlerts.length - 1 ? 'border-b border-primary-200' : ''
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3">
                    {alert.level === 'critical' ? (
                      <XCircleIcon className="w-4 h-4 text-black mt-1" />
                    ) : (
                      <ExclamationTriangleIcon className="w-4 h-4 text-black mt-1" />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-2">
                        <span className="font-light text-black">{alert.server_name}</span>
                        <span className="text-xs text-primary-600 uppercase tracking-wide">
                          {alert.level}
                        </span>
                        {alert.resolved && (
                          <span className="text-xs text-primary-600 uppercase tracking-wide">
                            Resolved
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-light text-black mb-2">{alert.message}</p>
                      <div className="flex items-center space-x-4 text-xs text-primary-600">
                        <span>{new Date(alert.created_at).toLocaleString()}</span>
                        {alert.value && alert.threshold && (
                          <span>Value: {alert.value.toFixed(1)}% (Threshold: {alert.threshold}%)</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 ml-4">
                    <Link
                      to={`/servers/${alert.server_id}`}
                      className="text-primary-600 hover:text-black transition-colors"
                      title="View server"
                    >
                      <EyeIcon className="w-4 h-4" />
                    </Link>
                    {!alert.resolved && (
                      <button
                        onClick={() => handleResolveAlert(alert.id)}
                        disabled={resolveAlertMutation.isLoading}
                        className="border border-primary-300 px-3 py-1 text-xs text-primary-600 hover:border-black hover:text-black disabled:opacity-50 transition-colors uppercase tracking-wide"
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AlertsPage;
