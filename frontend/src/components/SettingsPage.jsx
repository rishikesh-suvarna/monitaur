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
    <div className="space-y-8 bg-white">
      {/* Header */}
      <div className="border-b border-primary-200 pb-6">
        <h1 className="text-2xl font-light text-black tracking-wide">Settings</h1>
        <p className="text-primary-600 mt-1 font-light text-sm">Account settings and preferences</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <nav className="space-y-0 border border-primary-200">
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center px-4 py-3 text-xs font-light text-left transition-colors border-primary-200 ${
                  index < tabs.length - 1 ? 'border-b' : ''
                } ${
                  activeTab === tab.id
                    ? 'bg-black text-white'
                    : 'text-primary-600 hover:bg-primary-100'
                }`}
              >
                <tab.icon className="w-4 h-4 mr-3" />
                <span className="uppercase tracking-wide">{tab.name}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="lg:col-span-3">
          <div className="border border-primary-200 p-6">
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <h2 className="text-lg font-light text-black tracking-wide">Profile Information</h2>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={profile?.email || user?.email || ''}
                      disabled
                      className="w-full px-3 py-3 border border-primary-200 bg-primary-50 text-primary-600"
                    />
                    <p className="text-xs text-primary-500 mt-2">
                      Email cannot be changed. Contact support if needed.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                      User ID
                    </label>
                    <input
                      type="text"
                      value={profile?.id || 'N/A'}
                      disabled
                      className="w-full px-3 py-3 border border-primary-200 bg-primary-50 text-primary-600"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-primary-600 mb-2 uppercase tracking-wide">
                      Account Created
                    </label>
                    <input
                      type="text"
                      value={profile?.created_at ? new Date(profile.created_at).toLocaleString() : 'N/A'}
                      disabled
                      className="w-full px-3 py-3 border border-primary-200 bg-primary-50 text-primary-600"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-primary-200">
                  <button
                    onClick={handleLogout}
                    className="border border-primary-800 bg-primary-900 text-white px-4 py-2 hover:bg-black transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6">
                <h2 className="text-lg font-light text-black tracking-wide">Notification Preferences</h2>

                <div className="space-y-6">
                  <div className="flex items-center justify-between py-4 border-b border-primary-200">
                    <div>
                      <h3 className="text-sm font-light text-black">Email Notifications</h3>
                      <p className="text-xs text-primary-600 mt-1">Receive alerts via email when servers go offline</p>
                    </div>
                    <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 border border-primary-300 focus:ring-0 focus:ring-offset-0"
                    />
                  </div>

                  <div className="flex items-center justify-between py-4 border-b border-primary-200">
                    <div>
                      <h3 className="text-sm font-light text-black">Critical Alerts Only</h3>
                      <p className="text-xs text-primary-600 mt-1">Only receive critical-level alerts</p>
                    </div>
                    <input
                      type="checkbox"
                      className="w-4 h-4 border border-primary-300 focus:ring-0 focus:ring-offset-0"
                    />
                  </div>

                  <div className="flex items-center justify-between py-4">
                    <div>
                      <h3 className="text-sm font-light text-black">Weekly Summary</h3>
                      <p className="text-xs text-primary-600 mt-1">Weekly performance summary</p>
                    </div>
                    <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 border border-primary-300 focus:ring-0 focus:ring-offset-0"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-primary-200">
                  <button className="border border-black px-4 py-2 text-black hover:bg-black hover:text-white transition-colors">
                    Save Preferences
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <h2 className="text-lg font-light text-black tracking-wide">Security Settings</h2>

                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-light text-black mb-3">Authentication</h3>
                    <div className="border border-primary-200 p-4">
                      <div className="flex items-center mb-2">
                        <ShieldCheckIcon className="w-4 h-4 text-black mr-2" />
                        <span className="text-sm font-light text-black">
                          Firebase Authentication
                        </span>
                      </div>
                      <p className="text-xs text-primary-600">
                        Password changes managed through Firebase. Use "Forgot Password" on login.
                      </p>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-light text-black mb-3">Active Sessions</h3>
                    <div className="border border-primary-200 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-light text-black">Current Session</p>
                          <p className="text-xs text-primary-600">Started {new Date().toLocaleString()}</p>
                        </div>
                        <span className="text-xs text-primary-600 uppercase tracking-wide">
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
                <h2 className="text-lg font-light text-black tracking-wide">API Access</h2>

                <div className="border border-primary-200 p-4">
                  <h3 className="text-xs text-black mb-2 uppercase tracking-wide">API Endpoint</h3>
                  <code className="block text-xs text-black bg-primary-100 p-3 font-mono">
                    {import.meta.env.VITE_APP_SERVER_URL}/api/v1
                  </code>
                </div>

                <div className="space-y-4">
                  <div>
                    <h3 className="text-xs text-black mb-2 uppercase tracking-wide">Authentication</h3>
                    <p className="text-xs text-primary-600 mb-3">
                      API requests require Firebase ID token in Authorization header:
                    </p>
                    <code className="block text-xs bg-primary-100 p-3 font-mono text-black">
                      Authorization: Bearer &lt;firebase-id-token&gt;
                    </code>
                  </div>

                  <div>
                    <h3 className="text-xs text-black mb-2 uppercase tracking-wide">Available Endpoints</h3>
                    <div className="space-y-2 text-xs border border-primary-200 p-4">
                      <div className="flex items-center space-x-3 py-1">
                        <span className="px-2 py-1 bg-primary-100 text-black font-mono">GET</span>
                        <code>/dashboard</code>
                        <span className="text-primary-600">Dashboard data</span>
                      </div>
                      <div className="flex items-center space-x-3 py-1">
                        <span className="px-2 py-1 bg-primary-100 text-black font-mono">GET</span>
                        <code>/servers</code>
                        <span className="text-primary-600">List servers</span>
                      </div>
                      <div className="flex items-center space-x-3 py-1">
                        <span className="px-2 py-1 bg-primary-100 text-black font-mono">POST</span>
                        <code>/servers</code>
                        <span className="text-primary-600">Create server</span>
                      </div>
                      <div className="flex items-center space-x-3 py-1">
                        <span className="px-2 py-1 bg-primary-100 text-black font-mono">GET</span>
                        <code>/servers/:id/metrics</code>
                        <span className="text-primary-600">Server metrics</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="space-y-6">
                <h2 className="text-lg font-light text-black tracking-wide">About Monitaur</h2>

                <div className="space-y-6">
                  <div className="border-b border-primary-200 pb-4">
                    <h3 className="text-xs text-black uppercase tracking-wide mb-2">Version</h3>
                    <p className="text-sm text-primary-600">1.0.0</p>
                  </div>

                  <div className="border-b border-primary-200 pb-4">
                    <h3 className="text-xs text-black uppercase tracking-wide mb-2">Description</h3>
                    <p className="text-sm text-primary-600 font-light leading-relaxed">
                      Lightweight server monitoring solution for tracking infrastructure health and performance in real-time.
                    </p>
                  </div>

                  <div className="border-b border-primary-200 pb-4">
                    <h3 className="text-xs text-black uppercase tracking-wide mb-3">Features</h3>
                    <ul className="text-sm text-primary-600 space-y-1">
                      <li>• Real-time server monitoring</li>
                      <li>• CPU, Memory, Disk, Network metrics</li>
                      <li>• Customizable alert thresholds</li>
                      <li>• Historical data and charts</li>
                      <li>• Multi-server dashboard</li>
                      <li>• REST API access</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-xs text-black uppercase tracking-wide mb-3">Technology Stack</h3>
                    <div className="grid grid-cols-2 gap-6 text-sm text-primary-600">
                      <div>
                        <p className="text-xs text-black uppercase tracking-wide mb-2">Backend</p>
                        <ul className="space-y-1">
                          <li>• Go</li>
                          <li>• PostgreSQL</li>
                          <li>• Firebase Auth</li>
                          <li>• WebSockets</li>
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs text-black uppercase tracking-wide mb-2">Frontend</p>
                        <ul className="space-y-1">
                          <li>• React</li>
                          <li>• Vite</li>
                          <li>• Tailwind CSS</li>
                          <li>• Recharts</li>
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
