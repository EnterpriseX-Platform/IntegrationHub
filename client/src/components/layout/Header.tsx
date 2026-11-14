import React, { useState, useRef, useEffect } from 'react';
import { useLocation, Link, useParams, useNavigate } from 'react-router-dom';
import { 
  Bell, Sun, Moon, Menu, 
  User, 
  Settings, 
  LogOut,
  HelpCircle,
  ChevronDown,
  Shield
} from 'lucide-react';

import { useCurrentUser } from '../../lib/currentUser';
import { TenantSwitcher } from '../tenant/TenantSwitcher';
import { DehLogo } from '../ui/DehLogo';
import { APP_NAME } from '../../config/brand';
import { API_URL, BASE_PATH } from '../../config/api';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

// Project name cache to avoid repeated API calls
const projectNameCache: Record<string, string> = {};

const useProjectName = (projectId: string | undefined) => {
  const [projectName, setProjectName] = useState<string>('Project');

  useEffect(() => {
    if (!projectId) return;

    // Check cache first
    if (projectNameCache[projectId]) {
      setProjectName(projectNameCache[projectId]);
      return;
    }

    // Fetch project name
    fetch(`${API_URL}/projects/${projectId}`)
      .then(res => res.json())
      .then(result => {
        if (result.success && result.data) {
          const name = result.data.name;
          projectNameCache[projectId] = name;
          setProjectName(name);
        }
      })
      .catch(() => {
        setProjectName('Project');
      });
  }, [projectId]);

  return projectName;
};

const getBreadcrumbs = (pathname: string, projectName: string): BreadcrumbItem[] => {
  const crumbs: BreadcrumbItem[] = [];

  // Extract project ID from URL if present
  const projectMatch = pathname.match(/\/projects\/([^\/]+)/);
  const projectId = projectMatch ? projectMatch[1] : null;

  if (pathname === '/dashboard') {
    crumbs.push({ label: 'Dashboard' });
  } else if (pathname === '/projects') {
    crumbs.push({ label: 'Projects' });
  } else if (pathname.startsWith('/projects/')) {
    crumbs.push({ label: 'Projects', path: '/projects' });
    
    // Check for sub-routes
    if (pathname.includes('/flows/')) {
      // Inside flow designer
      crumbs.push({ label: projectName, path: `/projects/${projectId}` });
      crumbs.push({ label: 'Flow Designer' });
    } else if (pathname.includes('/baskets')) {
      crumbs.push({ label: projectName, path: `/projects/${projectId}` });
      crumbs.push({ label: 'Baskets' });
    } else if (pathname.includes('/connections')) {
      crumbs.push({ label: projectName, path: `/projects/${projectId}` });
      crumbs.push({ label: 'Connections' });
    } else if (pathname.includes('/executions')) {
      crumbs.push({ label: projectName, path: `/projects/${projectId}` });
      crumbs.push({ label: 'Executions' });
    } else if (pathname.includes('/flows')) {
      crumbs.push({ label: projectName, path: `/projects/${projectId}` });
      crumbs.push({ label: 'Flows' });
    } else {
      // Just the project page
      crumbs.push({ label: projectName });
    }
  } else if (pathname.startsWith('/flows/')) {
    crumbs.push({ label: 'Projects', path: '/projects' });
    crumbs.push({ label: 'Flow Designer' });
  } else if (pathname.startsWith('/apispecs/')) {
    crumbs.push({ label: 'Projects', path: '/projects' });
    crumbs.push({ label: 'API Specification' });
  } else if (pathname === '/executions') {
    crumbs.push({ label: 'Executions' });
  } else if (pathname === '/connections') {
    crumbs.push({ label: 'Connections' });
  } else if (pathname === '/baskets') {
    crumbs.push({ label: 'Baskets' });
  } else if (pathname === '/profile') {
    crumbs.push({ label: 'Profile' });
  } else if (pathname === '/settings') {
    crumbs.push({ label: 'Settings' });
  } else if (pathname === '/schedulers') {
    crumbs.push({ label: 'Schedulers' });
  } else if (pathname.startsWith('/data-admin')) {
    crumbs.push({ label: 'Data Admin' });
  } else if (pathname === '/apispecs') {
    crumbs.push({ label: 'API Specs' });
  } else if (pathname === '/tasks') {
    crumbs.push({ label: 'Run Flow' });
  } else if (pathname.startsWith('/file-explorer')) {
    crumbs.push({ label: 'File Explorer' });
  } else if (pathname.startsWith('/data-repository')) {
    crumbs.push({ label: 'Repository' });
  } else if (pathname.startsWith('/analytics-workbench')) {
    crumbs.push({ label: 'Analytics Workbench' });
  } else if (pathname.startsWith('/executions/')) {
    crumbs.push({ label: 'Executions' });
  } else if (pathname.startsWith('/schedulers/')) {
    crumbs.push({ label: 'Scheduler Logs' });
  } else if (pathname.startsWith('/event-flows/')) {
    crumbs.push({ label: 'Flow Designer' });
  }

  return crumbs;
};

interface HeaderProps {
  notificationCount?: number;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  notificationCount = 0,
  isSidebarCollapsed = false,
  onToggleSidebar
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme || 'dark');
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    setTheme(next);
  };
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // Get project ID from URL params
  const projectId = params.id || params.projectId;
  const projectName = useProjectName(projectId);
  
  const breadcrumbs = getBreadcrumbs(location.pathname, projectName);

  // Get user info from localStorage
  const user = useCurrentUser();
  const userName = user?.name || 'Administrator';
  const userEmail = user?.email || 'admin@integration.local';
  const userInitial = userName.charAt(0).toUpperCase();
  const userRole = user?.role || 'user';
  const isAdmin = userRole === 'admin';

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = `${BASE_PATH}/login`;
  };

  return (
    <header className="h-12 shrink-0 bg-black text-[#f4f4f4] border-b border-[#262626] flex items-center justify-between gap-2 relative z-30">
      {/* Left: menu · product · tenant · page title (Carbon UI shell, RunLoop style) */}
      <div className="flex items-center min-w-0 flex-1 h-full">
        <button
          onClick={onToggleSidebar}
          title={isSidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
          className="shrink-0 w-12 h-12 flex items-center justify-center text-[#f4f4f4] hover:bg-[#262626] transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <Link to="/dashboard" className="shrink-0 flex items-center gap-2 pl-1 pr-4 h-full hover:bg-[#262626]">
          <DehLogo size={22} className="text-[#f4f4f4]" />
          <span className="text-[14px] font-semibold tracking-tight hidden sm:inline">{APP_NAME}</span>
        </Link>
        <span className="w-px h-6 bg-[#393939] hidden sm:block" />
        <TenantSwitcher />
        <span className="w-px h-6 bg-[#393939] hidden sm:block" />
        <span className="px-4 text-[14px] font-semibold text-white truncate">
          {breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].label : 'Dashboard'}
        </span>
      </div>

      {/* Right side actions */}
      <div className="flex items-center shrink-0">
        {/* Carbon theme toggle (g100 dark / g10 light) */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          className="w-12 h-12 flex items-center justify-center text-[#f4f4f4] hover:bg-[#262626] transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>

        {/* Notification Bell */}
        <button className="relative w-12 h-12 flex items-center justify-center text-[#f4f4f4] hover:bg-[#262626] transition-colors">
          <Bell className="w-[18px] h-[18px]" />
          {notificationCount > 0 && (
            <span className="absolute top-1 right-1 min-w-4 h-4 px-1 bg-red-500 text-white text-[12px] ring-2 ring-black rounded-full flex items-center justify-center font-medium">
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          )}
        </button>

        {/* User Profile Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsProfileOpen(!isProfileOpen)}
            className="flex items-center gap-2 h-12 px-2 md:px-3 hover:bg-[#262626] transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-[#4589ff] flex items-center justify-center text-white text-xs font-semibold">
              {userInitial}
            </div>
            <div className="hidden text-left max-w-[180px]">
              <p className="text-[13px] font-medium text-[#f4f4f4] leading-tight truncate">{userName}</p>
              <p className="text-[12px] text-[#a8a8a8] leading-tight truncate">{userEmail}</p>
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform hidden ${isProfileOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown Menu */}
          {isProfileOpen && (
            <div className="absolute right-0 top-full mt-0 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
              {/* User Info Header */}
              <div className="px-4 py-3 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-medium">
                    {userInitial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{userName}</p>
                    <p className="text-xs text-gray-500 truncate">{userEmail}</p>
                    {isAdmin && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 mt-1">
                        <Shield className="w-3 h-3 mr-1" />
                        Admin
                      </span>
                    )}
                  </div>
                </div>
              </div>
              
              {/* Menu Items */}
              <button
                onClick={() => {
                  setIsProfileOpen(false);
                  navigate('/profile');
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <User className="w-4 h-4 text-gray-400" />
                Profile
              </button>
              
              {/* Settings - Admin only */}
              {isAdmin && (
                <button
                  onClick={() => {
                    setIsProfileOpen(false);
                    navigate('/settings');
                  }}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Settings className="w-4 h-4 text-gray-400" />
                  Settings
                </button>
              )}
              
              <button
                onClick={() => {
                  setIsProfileOpen(false);
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <HelpCircle className="w-4 h-4 text-gray-400" />
                Help & Support
              </button>
              
              <div className="border-t border-gray-100 mt-1 pt-1">
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export { getBreadcrumbs };
