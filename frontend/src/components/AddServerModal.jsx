import { Dialog } from '@headlessui/react';
import { ClipboardDocumentIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { serversAPI } from '../apis';

const AddServerModal = ({ isOpen, onClose }) => {
  const [serverName, setServerName] = useState('');
  const [createdServer, setCreatedServer] = useState(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const createServerMutation = useMutation({
    mutationFn: serversAPI.createServer,
    onSuccess: (response) => {
      setCreatedServer(response.data.server);
      queryClient.invalidateQueries(['servers']);
      queryClient.invalidateQueries(['dashboard']);
    },
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!serverName.trim()) return;

    await createServerMutation.mutateAsync({ name: serverName.trim() });
  };

  const handleClose = () => {
    setServerName('');
    setCreatedServer(null);
    setCopied(false);
    onClose();
  };

  const copyToken = () => {
    if (createdServer) {
      navigator.clipboard.writeText(createdServer.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const configContent = createdServer ? `{
  "token": "${createdServer.token}",
  "api_endpoint": "${import.meta.env.VITE_APP_SERVER_WS_URL}/agent/connect",
  "collection_interval": 30,
  "server_name": "${createdServer.name}",
  "alert_thresholds": {
    "cpu": 60,
    "memory": 60,
    "disk": 90
  }
}` : '';

  return (
    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-lg w-full bg-white rounded-lg shadow-xl">
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <Dialog.Title className="text-lg font-semibold text-gray-900">
              {createdServer ? 'Server Created Successfully!' : 'Add New Server'}
            </Dialog.Title>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <XMarkIcon className="w-6 h-6" />
            </button>
          </div>

          <div className="p-6">
            {!createdServer ? (
              // Create server form
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="serverName" className="block text-sm font-medium text-gray-700 mb-1">
                    Server Name
                  </label>
                  <input
                    type="text"
                    id="serverName"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="e.g., Production Web Server"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    required
                  />
                </div>

                <div className="flex items-center justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="btn btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={createServerMutation.isLoading || !serverName.trim()}
                    className="btn btn-primary disabled:opacity-50"
                  >
                    {createServerMutation.isLoading ? 'Creating...' : 'Create Server'}
                  </button>
                </div>
              </form>
            ) : (
              // Server created success
              <div className="space-y-6">
                <div className="text-center">
                  <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    {createdServer.name}
                  </h3>
                  <p className="text-sm text-gray-600">
                    Your server has been created. Use the configuration below to set up your monitoring agent.
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Server Token
                    </label>
                    <button
                      onClick={copyToken}
                      className="text-sm text-primary-600 hover:text-primary-700 flex items-center"
                    >
                      <ClipboardDocumentIcon className="w-4 h-4 mr-1" />
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <code className="block w-full p-2 bg-gray-100 rounded text-sm font-mono text-gray-800 break-all">
                    {createdServer.token}
                  </code>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Agent Configuration (config.json)
                  </label>
                  <div className="relative">
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto">
                      {configContent}
                    </pre>
                    <button
                      onClick={() => navigator.clipboard.writeText(configContent)}
                      className="absolute top-2 right-2 p-2 text-gray-400 hover:text-gray-200"
                      title="Copy configuration"
                    >
                      <ClipboardDocumentIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">Next Steps:</h4>
                  <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                    <li>Download the monitoring agent from your server</li>
                    <li>Create the config.json file with the configuration above</li>
                    <li>Run the agent: <code className="bg-blue-100 px-1 rounded">./monitaur</code></li>
                    <li>Your server will appear online once the agent connects</li>
                  </ol>
                </div>

                <div className="flex justify-end">
                  <button onClick={handleClose} className="btn btn-primary">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>

          {createServerMutation.isError && (
            <div className="px-6 pb-6">
              <div className="bg-danger-50 border border-danger-200 text-danger-700 px-4 py-3 rounded">
                Error creating server: {createServerMutation.error.response?.data?.error || createServerMutation.error.message}
              </div>
            </div>
          )}
        </Dialog.Panel>
      </div>
    </Dialog>
  );
};

export default AddServerModal;
