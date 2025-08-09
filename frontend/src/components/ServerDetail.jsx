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
  const [timeRange, setTimeRange] = useState(1);
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
    { value: 'cpu', label: 'CPU Usage', icon: CpuChipIcon },
    { value: 'memory', label: 'Memory Usage', icon: CircleStackIcon },
    { value: 'disk', label: 'Disk Usage', icon: ServerIcon },
    { value: 'network', label: 'Network I/O', icon: WifiIcon },
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
        <ComputerDesktopIcon className="w-8 h-8 text-primary-400 mx-auto mb-4" />
        <h3 className="text-lg font-light text-black mb-4">Server not found</h3>
        <Link to="/servers" className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors">
          Back to Servers
        </Link>
      </div>
    );
  }

  const { server, metrics, statistics } = serverData.data;
  const alerts = alertsData?.data?.alerts || [];
  const chartMetrics = chartData?.data?.data || [];

  const formatChartData = (data) => {
    if (!data || data.length === 0) return [];

    // Sort data by timestamp to ensure proper chronological order
    const sortedData = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return sortedData.map(item => {
      const date = new Date(item.timestamp);
      return {
        time: date.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit'
        }),
        fullTime: date.toLocaleString(),
        value: selectedMetric === 'network' ?
          (item.bytes_in ? item.bytes_in / 1024 / 1024 : 0) :
          (item.value || 0),
        bytes_out: selectedMetric === 'network' ?
          (item.bytes_out ? item.bytes_out / 1024 / 1024 : 0) :
          undefined,
      };
    });
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
    <div className="space-y-8 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-primary-200 pb-6">
        <div className="flex items-center space-x-4">
          <Link to="/servers" className="text-primary-600 hover:text-black transition-colors">
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-light text-black tracking-wide">{server.name}</h1>
            <div className="flex items-center space-x-4 mt-2">
              <div className="flex items-center">
                <div className={`w-2 h-2 rounded-full mr-2 ${
                  server.is_connected ?
                    (server.status === 'warning' ? 'bg-primary-500' : 'bg-black') :
                    'bg-primary-300'
                }`} />
                <span className="text-xs text-primary-600 uppercase tracking-wide">
                  {server.is_connected ? (server.status === 'warning' ? 'Warning' : 'Online') : 'Offline'}
                </span>
              </div>
              {server.last_seen && (
                <span className="text-xs text-primary-600">
                  {new Date(server.last_seen).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>

        <select
          value={timeRange}
          onChange={(e) => setTimeRange(Number(e.target.value))}
          className="border border-primary-300 px-3 py-2 text-black focus:outline-none focus:border-black"
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
        <div className="grid grid-cols-4 gap-0 border border-primary-200">
          {[
            {
              name: 'CPU',
              value: `${metrics[0].cpu_usage.toFixed(1)}%`,
              icon: CpuChipIcon,
              stat: statistics.cpu
            },
            {
              name: 'Memory',
              value: `${metrics[0].memory_percent.toFixed(1)}%`,
              icon: CircleStackIcon,
              detail: `${formatBytes(metrics[0].memory_used)} / ${formatBytes(metrics[0].memory_total)}`,
              stat: statistics.memory
            },
            {
              name: 'Disk',
              value: `${metrics[0].disk_percent.toFixed(1)}%`,
              icon: ServerIcon,
              detail: `${formatBytes(metrics[0].disk_used)} / ${formatBytes(metrics[0].disk_total)}`,
              stat: statistics.disk
            },
            {
              name: 'Uptime',
              value: formatUptime(metrics[0].uptime),
              icon: WifiIcon,
              detail: `${metrics[0].cpu_cores} cores`
            },
          ].map((metric, index) => (
            <div
              key={index}
              className={`p-6 border-primary-200 ${index < 3 ? 'border-r' : ''}`}
            >
              <div className="flex flex-col items-center text-center">
                <metric.icon className="w-5 h-5 text-black mb-3" />
                <p className="text-xl font-light text-black mb-1">{metric.value}</p>
                <p className="text-xs text-primary-600 uppercase tracking-wide mb-2">{metric.name}</p>
                {metric.detail && (
                  <p className="text-xs text-primary-500">{metric.detail}</p>
                )}
                {metric.stat && (
                  <div className="mt-3 pt-3 border-t border-primary-200 w-full">
                    <div className="flex justify-between text-xs text-primary-600">
                      <span>Avg: {metric.stat.average.toFixed(1)}%</span>
                      <span>Max: {metric.stat.max.toFixed(1)}%</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chart Section */}
      <div className="border border-primary-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-light text-black tracking-wide">Performance</h2>
          <div className="flex space-x-0 border border-primary-200">
            {metricOptions.map((option, index) => (
              <button
                key={option.value}
                onClick={() => setSelectedMetric(option.value)}
                className={`flex items-center px-4 py-2 text-xs uppercase tracking-wide transition-colors border-primary-200 ${
                  index < metricOptions.length - 1 ? 'border-r' : ''
                } ${
                  selectedMetric === option.value
                    ? 'bg-black text-white'
                    : 'text-primary-600 hover:bg-primary-100'
                }`}
              >
                <option.icon className="w-3 h-3 mr-2" />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {chartLoading ? (
          <div className="h-64 flex items-center justify-center border border-primary-200">
            <LoadingSpinner />
          </div>
        ) : chartMetrics.length > 0 ? (
          <div className="h-80 bg-white border border-primary-200">
            <ResponsiveContainer width="100%" height="100%">
              {selectedMetric === 'network' ? (
                <AreaChart
                  data={formatChartData(chartMetrics)}
                  margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
                >
                  <CartesianGrid
                    strokeDasharray="1 1"
                    stroke="#dadce0"
                    strokeWidth={0.5}
                  />
                  <XAxis
                    dataKey="time"
                    fontSize={11}
                    stroke="#5f6368"
                    tickLine={false}
                    axisLine={{ stroke: '#dadce0', strokeWidth: 1 }}
                  />
                  <YAxis
                    label={{
                      value: 'MB/s',
                      angle: -90,
                      position: 'insideLeft',
                      style: { textAnchor: 'middle', fontSize: '11px', fill: '#5f6368' }
                    }}
                    fontSize={11}
                    stroke="#5f6368"
                    tickLine={false}
                    axisLine={{ stroke: '#dadce0', strokeWidth: 1 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #dadce0',
                      borderRadius: '0',
                      fontSize: '12px',
                      padding: '8px'
                    }}
                    formatter={(value, name) => [
                      `${Number(value).toFixed(2)} MB/s`,
                      name === 'value' ? 'Inbound' : 'Outbound'
                    ]}
                    labelFormatter={(label) => `Time: ${label}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stackId="1"
                    stroke="#000000"
                    fill="#000000"
                    fillOpacity={0.1}
                    strokeWidth={2}
                  />
                  {formatChartData(chartMetrics)[0]?.bytes_out !== undefined && (
                    <Area
                      type="monotone"
                      dataKey="bytes_out"
                      stackId="2"
                      stroke="#9aa0a6"
                      fill="#9aa0a6"
                      fillOpacity={0.1}
                      strokeWidth={2}
                    />
                  )}
                </AreaChart>
              ) : (
                <LineChart
                  data={formatChartData(chartMetrics)}
                  margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
                >
                  <CartesianGrid
                    strokeDasharray="1 1"
                    stroke="#dadce0"
                    strokeWidth={0.5}
                  />
                  <XAxis
                    dataKey="time"
                    fontSize={11}
                    stroke="#5f6368"
                    tickLine={false}
                    axisLine={{ stroke: '#dadce0', strokeWidth: 1 }}
                  />
                  <YAxis
                    domain={[0, 100]}
                    label={{
                      value: '%',
                      angle: -90,
                      position: 'insideLeft',
                      style: { textAnchor: 'middle', fontSize: '11px', fill: '#5f6368' }
                    }}
                    fontSize={11}
                    stroke="#5f6368"
                    tickLine={false}
                    axisLine={{ stroke: '#dadce0', strokeWidth: 1 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #dadce0',
                      borderRadius: '0',
                      fontSize: '12px',
                      padding: '8px'
                    }}
                    formatter={(value) => [`${Number(value).toFixed(1)}%`, selectedMetric.toUpperCase()]}
                    labelFormatter={(label) => `Time: ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#000000"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: '#000000', stroke: 'white', strokeWidth: 2 }}
                  />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center text-primary-600 border border-primary-200 bg-primary-50">
            <div className="text-center">
              <div className="text-xs uppercase tracking-wide mb-2">No Data Available</div>
              <div className="text-xs">No metrics data for the selected time range</div>
            </div>
          </div>
        )}
      </div>

      {/* Recent Alerts */}
      <div className="border border-primary-200 p-6">
        <h2 className="text-lg font-light text-black mb-6 tracking-wide">Recent Alerts</h2>
        {alerts.length > 0 ? (
          <div className="space-y-0 border border-primary-200">
            {alerts.slice(0, 10).map((alert, index) => (
              <div
                key={alert.id}
                className={`p-4 ${
                  index < alerts.slice(0, 10).length - 1 ? 'border-b border-primary-200' : ''
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-light text-black text-sm">
                      {alert.message}
                    </p>
                    <p className="text-xs text-primary-600 mt-2">
                      {new Date(alert.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-xs text-primary-600 uppercase tracking-wide">
                    {alert.resolved ? 'Resolved' : alert.level}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-primary-600">
            No recent alerts
          </div>
        )}
      </div>
    </div>
  );
};

export default ServerDetail;
