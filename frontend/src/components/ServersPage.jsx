import {
  ClipboardDocumentIcon,
  ComputerDesktopIcon,
  EyeIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { serversAPI } from '../apis';
import AddServerModal from './AddServerModal';
import LoadingSpinner from './LoadingSpinner';

const ServersPage = () => {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: serversData, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: serversAPI.getServers,
  });

  const deleteServerMutation = useMutation({
    mutationFn: serversAPI.deleteServer,
    onSuccess: () => {
      queryClient.invalidateQueries(['servers']);
      queryClient.invalidateQueries(['dashboard']);
    },
  });

  const handleDeleteServer = async (serverId, serverName) => {
    if (window.confirm(`Are you sure you want to delete "${serverName}"? This action cannot be undone.`)) {
      await deleteServerMutation.mutateAsync(serverId);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    // You could add a toast notification here
  };

  const getStatusBadge = (server) => {
    const isConnected = server.status === 'online';
    const hasWarning = server.status === 'warning';

    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        isConnected && !hasWarning
          ? 'bg-green-100 text-green-800'
          : hasWarning
          ? 'bg-yellow-100 text-yellow-800'
          : 'bg-gray-100 text-gray-800'
      }`}>
        <span className={`w-2 h-2 rounded-full mr-1.5 ${
          isConnected && !hasWarning
            ? 'bg-green-400'
            : hasWarning
            ? 'bg-yellow-400'
            : 'bg-gray-400'
        }`} />
        {isConnected && !hasWarning ? 'Online' : hasWarning ? 'Warning' : 'Offline'}
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-danger-50 border border-danger-200 text-danger-700 px-4 py-3 rounded">
        Error loading servers: {error.message}
      </div>
    );
  }

  const servers = serversData?.data?.servers || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Servers</h1>
          <p className="text-gray-600">Manage your monitored servers</p>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="btn btn-primary flex items-center"
        >
          <PlusIcon className="w-5 h-5 mr-2" />
          Add Server
        </button>
      </div>

      {/* Servers Grid */}
      {servers.length === 0 ? (
        <div className="text-center py-12">
          <ComputerDesktopIcon className="w-16 h-16 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No servers yet</h3>
          <p className="text-gray-500 mb-6">Get started by adding your first server to monitor.</p>
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="btn btn-primary"
          >
            Add Your First Server
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => (
            <div key={server.id} className="card hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center">
                  <div className="p-2 bg-primary-50 rounded-lg">
                    <ComputerDesktopIcon className="w-6 h-6 text-primary-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-semibold text-gray-900">{server.name}</h3>
                    <p className="text-sm text-gray-500">
                      {server.last_seen ?
                        `Last seen ${new Date(server.last_seen).toLocaleString()}` :
                        'Never connected'
                      }
                    </p>
                  </div>
                </div>
                {getStatusBadge(server)}
              </div>

              {/* Server Token */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Server Token
                </label>
                <div className="flex items-center space-x-2">
                  <code className="flex-1 px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-800 truncate">
                    {server.token}
                  </code>
                  <button
                    onClick={() => copyToClipboard(server.token)}
                    className="p-1 text-gray-500 hover:text-gray-700"
                    title="Copy token"
                  >
                    <ClipboardDocumentIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-4 border-t border-gray-200">
                <Link
                  to={`/servers/${server.id}`}
                  className="flex items-center text-sm text-primary-600 hover:text-primary-700 font-medium"
                >
                  <EyeIcon className="w-4 h-4 mr-1" />
                  View Details
                </Link>
                <button
                  onClick={() => handleDeleteServer(server.id, server.name)}
                  disabled={deleteServerMutation.isLoading}
                  className="flex items-center text-sm text-danger-600 hover:text-danger-700 font-medium disabled:opacity-50"
                >
                  <TrashIcon className="w-4 h-4 mr-1" />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Server Modal */}
      <AddServerModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
      />
    </div>
  );
};

export default ServersPage;
