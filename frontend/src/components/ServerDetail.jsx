import {
  ArrowLeftIcon,
  CircleStackIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  ServerIcon,
  WifiIcon,
} from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { alertsAPI, serversAPI } from '../apis';
import LoadingSpinner from './LoadingSpinner';

const ServerDetail = () => {
  const { id } = useParams();
  const [timeRange, setTimeRange] = useState(24);
  const [selectedMetric, setSelectedMetric] = useState('cpu');

  const { data: serverData, isLoading: serverLoading } = useQuery({
    queryKey: ['server-dashboard', id, timeRange],
    queryFn: () => serversAPI.getServerDashboard(id, timeRange),
    refetchInterval: 30000,
  });

  const { data: chartData, isLoading: chartLoading } = useQuery({
    queryKey: ['server-chart', id, selectedMetric, timeRange],
    queryFn: () => serversAPI.getMetricsChart(id, selectedMetric, timeRange),
    refetchInterval: 30000,
  });

  const { data: alertsData } = useQuery({
    queryKey: ['server-alerts', id],
    queryFn: () => alertsAPI.getServerAlerts(id, 20),
  });

  const timeRangeOptions = [
    { value: 1, label: '1 Hour' },
    { value: 6, label: '6 Hours' },
    { value: 24, label: '24 Hours' },
    { value: 72, label: '3 Days' },
    { value: 168, label: '1 Week' },
  ];

  const metricOptions = [
    { value: 'cpu', label: 'CPU Usage', icon: CpuChipIcon, color: '#3B82F6' },
    { value: 'memory', label: 'Memory Usage', icon: CircleStackIcon, color: '#10B981' },
    { value: 'disk', label: 'Disk Usage', icon: ServerIcon, color: '#F59E0B' },
    { value: 'network', label: 'Network I/O', icon: WifiIcon, color: '#8B5CF6' },
  ];

  if (serverLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!serverData?.data?.server) {
    return (
      <div className="text-center py-12">
        <ComputerDesktopIcon className="w-16 h-16 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Server not found</h3>
        <Link to="/servers" className="btn btn-primary">
          Back to Servers
        </Link>
      </div>
    );
  }

  const { server, metrics, statistics } = serverData.data;
  const alerts = alertsData?.data?.alerts || [];
  const chartMetrics = chartData?.data?.data || [];

  const formatChartData = (data) => {
    return data.map(item => ({
      time: new Date(item.timestamp).toLocaleTimeString(),
      value: selectedMetric === 'network' ? item.bytes_in / 1024 / 1024 : item.value, // Convert to MB for network
      bytes_out: selectedMetric === 'network' ? item.bytes_out / 1024 / 1024 : undefined,
    }));
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return 'text-green-600 bg-green-50 border-green-200';
      case 'warning': return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      default: return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  const formatBytes = (bytes) => {
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatUptime = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link to="/servers" className="text-gray-500 hover:text-gray-700">
            <ArrowLeftIcon className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{server.name}</h1>
            <div className="flex items-center space-x-4 mt-1">
              <span className={`px-3 py-1 text-sm font-medium rounded-full border ${getStatusColor(server.status)}`}>
                {server.is_connected ? (server.status === 'warning' ? 'Warning' : 'Online') : 'Offline'}
              </span>
              {server.last_seen && (
                <span className="text-sm text-gray-500">
                  Last seen: {new Date(server.last_seen).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Time Range Selector */}
        <select
          value={timeRange}
          onChange={(e) => setTimeRange(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          {timeRangeOptions.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Current Metrics */}
      {metrics.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              name: 'CPU Usage',
              value: `${metrics[0].cpu_usage.toFixed(1)}%`,
              icon: CpuChipIcon,
              color: 'text-blue-600 bg-blue-50',
              stat: statistics.cpu
            },
            {
              name: 'Memory Usage',
              value: `${metrics[0].memory_percent.toFixed(1)}%`,
              icon: CircleStackIcon,
              color: 'text-green-600 bg-green-50',
              detail: `${formatBytes(metrics[0].memory_used)} / ${formatBytes(metrics[0].memory_total)}`,
              stat: statistics.memory
            },
            {
              name: 'Disk Usage',
              value: `${metrics[0].disk_percent.toFixed(1)}%`,
              icon: ServerIcon,
              color: 'text-yellow-600 bg-yellow-50',
              detail: `${formatBytes(metrics[0].disk_used)} / ${formatBytes(metrics[0].disk_total)}`,
              stat: statistics.disk
            },
            {
              name: 'Uptime',
              value: formatUptime(metrics[0].uptime),
              icon: WifiIcon,
              color: 'text-purple-600 bg-purple-50',
              detail: `${metrics[0].cpu_cores} CPU cores`
            },
          ].map((metric, index) => (
            <div key={index} className="card">
              <div className="flex items-center">
                <div className={`p-3 rounded-lg ${metric.color}`}>
                  <metric.icon className="w-6 h-6" />
                </div>
                <div className="ml-4 flex-1">
                  <p className="text-sm font-medium text-gray-500">{metric.name}</p>
                  <p className="text-2xl font-semibold text-gray-900">{metric.value}</p>
                  {metric.detail && (
                    <p className="text-xs text-gray-500">{metric.detail}</p>
                  )}
                </div>
              </div>
              {metric.stat && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>Avg: {metric.stat.average.toFixed(1)}%</span>
                    <span>Max: {metric.stat.max.toFixed(1)}%</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Chart Section */}
      <div className="card">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-medium text-gray-900">Performance Metrics</h3>
          <div className="flex space-x-2">
            {metricOptions.map(option => (
              <button
                key={option.value}
                onClick={() => setSelectedMetric(option.value)}
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                  selectedMetric === option.value
                    ? 'bg-primary-100 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <option.icon className="w-4 h-4 mr-1.5" />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {chartLoading ? (
          <div className="h-64 flex items-center justify-center">
            <LoadingSpinner />
          </div>
        ) : chartMetrics.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {selectedMetric === 'network' ? (
                <AreaChart data={formatChartData(chartMetrics)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" />
                  <YAxis label={{ value: 'MB/s', angle: -90, position: 'insideLeft' }} />
                  <Tooltip
                    formatter={(value, name) => [
                      `${value.toFixed(2)} MB/s`,
                      name === 'value' ? 'Inbound' : 'Outbound'
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stackId="1"
                    stroke="#3B82F6"
                    fill="#3B82F6"
                    fillOpacity={0.6}
                  />
                  <Area
                    type="monotone"
                    dataKey="bytes_out"
                    stackId="2"
                    stroke="#10B981"
                    fill="#10B981"
                    fillOpacity={0.6}
                  />
                </AreaChart>
              ) : (
                <LineChart data={formatChartData(chartMetrics)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" />
                  <YAxis
                    domain={[0, 100]}
                    label={{ value: '%', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip formatter={(value) => [`${value.toFixed(1)}%`, selectedMetric.toUpperCase()]} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={metricOptions.find(m => m.value === selectedMetric)?.color}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center text-gray-500">
            No metrics data available
          </div>
        )}
      </div>

      {/* Recent Alerts */}
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Alerts</h3>
        {alerts.length > 0 ? (
          <div className="space-y-3">
            {alerts.slice(0, 10).map((alert) => (
              <div key={alert.id} className={`p-3 rounded-lg border ${
                alert.level === 'critical'
                  ? 'bg-red-50 border-red-200'
                  : 'bg-yellow-50 border-yellow-200'
              }`}>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${
                      alert.level === 'critical' ? 'text-red-900' : 'text-yellow-900'
                    }`}>
                      {alert.message}
                    </p>
                    <p className={`text-xs mt-1 ${
                      alert.level === 'critical' ? 'text-red-600' : 'text-yellow-600'
                    }`}>
                      {new Date(alert.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                    alert.resolved
                      ? 'bg-green-100 text-green-800'
                      : alert.level === 'critical'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-yellow-100 text-yellow-800'
                  }`}>
                    {alert.resolved ? 'Resolved' : alert.level}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            No recent alerts
          </div>
        )}
      </div>
    </div>
  );
};

export default ServerDetail;
