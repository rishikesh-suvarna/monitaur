import {
  ArrowRightOnRectangleIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();

  const navigation = [
    { name: 'Dashboard', href: '/', icon: ChartBarIcon },
    { name: 'Servers', href: '/servers', icon: ComputerDesktopIcon },
    { name: 'Alerts', href: '/alerts', icon: ExclamationTriangleIcon },
    { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
  ];

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-primary-200">
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-center h-28 px-4 border-b border-primary-200 p-2">
            <img src="/icon.svg" alt="Monitaur Logo" className="h-full" />
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-0 py-0">
            {navigation.map((item, index) => {
              const isActive = location.pathname === item.href ||
                (item.href !== '/' && location.pathname.startsWith(item.href));

              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={clsx(
                    'flex items-center px-6 py-4 text-sm font-light transition-colors border-b border-primary-200',
                    isActive
                      ? 'bg-black text-white'
                      : 'text-black hover:bg-primary-100'
                  )}
                >
                  <item.icon className={clsx(
                    'w-4 h-4 mr-4 transition-colors',
                    isActive
                      ? 'text-white'
                      : 'text-primary-600'
                  )} />
                  <span className="uppercase tracking-wide text-xs">
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </nav>

          {/* User section */}
          <div className="px-6 py-4 border-t border-primary-200">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-light text-black truncate uppercase tracking-wide">
                  {user?.email}
                </p>
                <p className="text-xs text-primary-600 truncate mt-1">
                  Account
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="flex-shrink-0 p-1 text-primary-600 hover:text-black transition-colors"
                title="Sign out"
              >
                <ArrowRightOnRectangleIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="pl-64">
        <div className="flex flex-col min-h-screen">
          {/* Page content */}
          <main className="flex-1 p-6 bg-white">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
};

export default Layout;
