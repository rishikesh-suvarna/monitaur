import {
  BellIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { userAPI } from '../apis';
import { useAuth } from '../contexts/AuthContext';
import LoadingSpinner from './LoadingSpinner';

const SettingsPage = () => {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');

  const { data: profileData, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: userAPI.getProfile,
  });

  const tabs = [
    { id: 'profile', name: 'Profile', icon: UserCircleIcon },
    { id: 'notifications', name: 'Notifications', icon: BellIcon },
    { id: 'security', name: 'Security', icon: ShieldCheckIcon },
    { id: 'api', name: 'API Access', icon: CodeBracketIcon },
    { id: 'about', name: 'About', icon: DocumentTextIcon },
  ];

  const handleLogout = async () => {
    if (window.confirm('Are you sure you want to sign out?')) {
      await logout();
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const profile = profileData?.data?.user;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600">Manage your account settings and preferences</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <nav className="space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-lg text-left transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary-50 text-primary-700 border-r-2 border-primary-600'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <tab.icon className="w-5 h-5 mr-3" />
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="lg:col-span-3">
          <div className="card">
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium text-gray-900">Profile Information</h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={profile?.email || user?.email || ''}
                      disabled
                      className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Email address cannot be changed. Contact support if needed.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      User ID
                    </label>
                    <input
                      type="text"
                      value={profile?.id || 'N/A'}
                      disabled
                      className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Account Created
                    </label>
                    <input
                      type="text"
                      value={profile?.created_at ? new Date(profile.created_at).toLocaleString() : 'N/A'}
                      disabled
                      className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-200">
                  <button
                    onClick={handleLogout}
                    className="btn btn-danger"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium text-gray-900">Notification Preferences</h3>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-gray-900">Email Notifications</h4>
                      <p className="text-sm text-gray-500">Receive alerts via email when servers go offline or exceed thresholds</p>
                    </div>
                    <input
                      type="checkbox"
                      defaultChecked
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-gray-900">Critical Alerts Only</h4>
                      <p className="text-sm text-gray-500">Only receive notifications for critical-level alerts</p>
                    </div>
                    <input
                      type="checkbox"
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-gray-900">Weekly Summary</h4>
                      <p className="text-sm text-gray-500">Receive a weekly summary of your server performance</p>
                    </div>
                    <input
                      type="checkbox"
                      defaultChecked
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-200">
                  <button className="btn btn-primary">
                    Save Preferences
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium text-gray-900">Security Settings</h3>

                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Authentication</h4>
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex items-center">
                        <ShieldCheckIcon className="w-5 h-5 text-green-500 mr-2" />
                        <span className="text-sm font-medium text-green-800">
                          Your account is secured with Firebase Authentication
                        </span>
                      </div>
                      <p className="text-sm text-green-700 mt-1">
                        Password changes are managed through Firebase. Use the "Forgot Password" option on the login page.
                      </p>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Active Sessions</h4>
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900">Current Session</p>
                          <p className="text-sm text-gray-500">Started {new Date().toLocaleString()}</p>
                        </div>
                        <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">
                          Active
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'api' && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium text-gray-900">API Access</h3>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">API Endpoint</h4>
                  <code className="block text-sm text-blue-800 bg-blue-100 p-2 rounded">
                    http://localhost:8080/api/v1
                  </code>
                </div>

                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Authentication</h4>
                    <p className="text-sm text-gray-600 mb-3">
                      API requests require a Firebase ID token in the Authorization header:
                    </p>
                    <code className="block text-sm bg-gray-100 p-3 rounded">
                      Authorization: Bearer &lt;firebase-id-token&gt;
                    </code>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Available Endpoints</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-mono">GET</span>
                        <code>/dashboard</code>
                        <span className="text-gray-500">- Get dashboard data</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-mono">GET</span>
                        <code>/servers</code>
                        <span className="text-gray-500">- List servers</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-mono">POST</span>
                        <code>/servers</code>
                        <span className="text-gray-500">- Create server</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-mono">GET</span>
                        <code>/servers/:id/metrics</code>
                        <span className="text-gray-500">- Get server metrics</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="space-y-6">
                <h3 className="text-lg font-medium text-gray-900">About Monitaur</h3>

                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Version</h4>
                    <p className="text-sm text-gray-600">1.0.0</p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Description</h4>
                    <p className="text-sm text-gray-600">
                      Monitaur is a lightweight server monitoring solution that helps you keep track of your infrastructure's health and performance in real-time.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Features</h4>
                    <ul className="text-sm text-gray-600 list-disc list-inside space-y-1">
                      <li>Real-time server monitoring</li>
                      <li>CPU, Memory, Disk, and Network metrics</li>
                      <li>Customizable alert thresholds</li>
                      <li>Historical data and charts</li>
                      <li>Multi-server dashboard</li>
                      <li>REST API access</li>
                    </ul>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Technology Stack</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm text-gray-600">
                      <div>
                        <p className="font-medium">Backend:</p>
                        <ul className="list-disc list-inside ml-2">
                          <li>Go</li>
                          <li>PostgreSQL</li>
                          <li>Firebase Auth</li>
                          <li>WebSockets</li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-medium">Frontend:</p>
                        <ul className="list-disc list-inside ml-2">
                          <li>React</li>
                          <li>Vite</li>
                          <li>Tailwind CSS</li>
                          <li>Recharts</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
