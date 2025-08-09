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
      <div className="border border-primary-800 bg-primary-900 text-white px-4 py-3">
        Error loading servers: {error.message}
      </div>
    );
  }

  const servers = serversData?.data?.servers || [];

  return (
    <div className="space-y-8 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-primary-200 pb-6">
        <div>
          <h1 className="text-2xl font-light text-black tracking-wide">Servers</h1>
          <p className="text-primary-600 mt-1 font-light text-sm">Manage monitored servers</p>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors flex items-center"
        >
          <PlusIcon className="w-4 h-4 mr-2" />
          Add Server
        </button>
      </div>

      {/* Servers Grid */}
      {servers.length === 0 ? (
        <div className="text-center py-16">
          <ComputerDesktopIcon className="w-12 h-12 text-primary-400 mx-auto mb-6" />
          <h2 className="text-lg font-light text-black mb-2 tracking-wide">No servers</h2>
          <p className="text-primary-600 mb-8 font-light">Add your first server to start monitoring</p>
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="border border-black px-6 py-3 text-black hover:bg-black hover:text-white transition-colors"
          >
            Add Server
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => (
            <div key={server.id} className="border border-primary-200 p-6 hover:border-black transition-colors">
              {/* Header */}
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center">
                  <div className="p-2 border border-primary-200 mr-3">
                    <ComputerDesktopIcon className="w-5 h-5 text-black" />
                  </div>
                  <div>
                    <h3 className="font-light text-black text-lg tracking-wide">{server.name}</h3>
                    <p className="text-xs text-primary-600 mt-1">
                      {server.last_seen ?
                        new Date(server.last_seen).toLocaleString() :
                        'Never connected'
                      }
                    </p>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className={`w-2 h-2 rounded-full mr-2 ${
                    server.status === 'online' ? 'bg-black' :
                    server.status === 'warning' ? 'bg-primary-500' : 'bg-primary-300'
                  }`} />
                  <span className="text-xs text-primary-600 uppercase tracking-wide">
                    {server.status === 'online' ? 'Online' :
                     server.status === 'warning' ? 'Warning' : 'Offline'}
                  </span>
                </div>
              </div>

              {/* Server Token */}
              <div className="mb-6">
                <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                  Server Token
                </label>
                <div className="flex items-center border border-primary-200">
                  <code className="flex-1 px-3 py-2 bg-primary-50 text-xs font-mono text-black">
                    {server.token}
                  </code>
                  <button
                    onClick={() => copyToClipboard(server.token)}
                    className="p-2 text-primary-600 hover:text-black border-l border-primary-200 transition-colors"
                    title="Copy token"
                  >
                    <ClipboardDocumentIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-4 border-t border-primary-200">
                <Link
                  to={`/servers/${server.id}`}
                  className="flex items-center text-xs text-primary-600 hover:text-black font-light uppercase tracking-wide transition-colors"
                >
                  <EyeIcon className="w-4 h-4 mr-2" />
                  View Details
                </Link>
                <button
                  onClick={() => handleDeleteServer(server.id, server.name)}
                  disabled={deleteServerMutation.isLoading}
                  className="flex items-center text-xs text-primary-600 hover:text-black font-light uppercase tracking-wide disabled:opacity-50 transition-colors"
                >
                  <TrashIcon className="w-4 h-4 mr-2" />
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
