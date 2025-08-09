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
      <div className="fixed inset-0 bg-black/20" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-lg w-full bg-white border border-primary-200">
          <div className="flex items-center justify-between p-6 border-b border-primary-200">
            <Dialog.Title className="text-lg font-light text-black tracking-wide">
              {createdServer ? 'Server Created' : 'Add Server'}
            </Dialog.Title>
            <button
              onClick={handleClose}
              className="text-primary-600 hover:text-black transition-colors"
            >
              <XMarkIcon className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6">
            {!createdServer ? (
              // Create server form
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label htmlFor="serverName" className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                    Server Name
                  </label>
                  <input
                    type="text"
                    id="serverName"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="Production Web Server"
                    className="w-full px-3 py-3 border border-primary-300 text-black focus:outline-none focus:border-black"
                    required
                  />
                </div>

                <div className="flex items-center justify-end space-x-3 pt-4 border-t border-primary-200">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="border border-primary-300 px-4 py-2 text-primary-600 hover:border-black hover:text-black transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={createServerMutation.isLoading || !serverName.trim()}
                    className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors disabled:opacity-50"
                  >
                    {createServerMutation.isLoading ? 'Creating...' : 'Create Server'}
                  </button>
                </div>
              </form>
            ) : (
              // Server created success
              <div className="space-y-6">
                <div className="text-center py-6 border-b border-primary-200">
                  <div className="w-8 h-8 border border-black mx-auto mb-4 flex items-center justify-center">
                    <span className="text-xs">✓</span>
                  </div>
                  <h3 className="text-lg font-light text-black tracking-wide mb-2">
                    {createdServer.name}
                  </h3>
                  <p className="text-sm text-primary-600 font-light">
                    Server created successfully
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-primary-600 uppercase tracking-wide">
                      Server Token
                    </label>
                    <button
                      onClick={copyToken}
                      className="text-xs text-primary-600 hover:text-black flex items-center transition-colors"
                    >
                      <ClipboardDocumentIcon className="w-3 h-3 mr-1" />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <code className="block w-full p-3 border border-primary-200 bg-primary-50 text-xs font-mono text-black">
                    {createdServer.token}
                  </code>
                </div>

                <div>
                  <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                    Configuration File
                  </label>
                  <div className="relative border border-primary-200">
                    <pre className="bg-black text-white p-4 text-xs overflow-x-auto font-mono">
                      {configContent}
                    </pre>
                    <button
                      onClick={() => navigator.clipboard.writeText(configContent)}
                      className="absolute top-2 right-2 p-1 text-primary-400 hover:text-white transition-colors"
                      title="Copy configuration"
                    >
                      <ClipboardDocumentIcon className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="border border-primary-200 p-4">
                  <h4 className="text-xs text-black mb-3 uppercase tracking-wide">Setup Instructions</h4>
                  <ol className="text-xs text-primary-600 space-y-2">
                    <li>1. Download the monitoring agent</li>
                    <li>2. Create config.json with the configuration above</li>
                    <li>3. Run: <code className="bg-primary-100 px-1 py-0.5 font-mono">./monitaur</code></li>
                    <li>4. Server will appear online when connected</li>
                  </ol>
                </div>

                <div className="flex justify-end pt-4 border-t border-primary-200">
                  <button
                    onClick={handleClose}
                    className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>

          {createServerMutation.isError && (
            <div className="px-6 pb-6">
              <div className="border border-primary-800 bg-primary-900 text-white px-4 py-3">
                Error: {createServerMutation.error.response?.data?.error || createServerMutation.error.message}
              </div>
            </div>
          )}
        </Dialog.Panel>
      </div>
    </Dialog>
  );
};

export default AddServerModal;
