import React, { useState, useRef, useEffect } from 'react';
import { useLocation, Link, useParams, useNavigate } from 'react-router-dom';
import {
  Notification as Bell, Sun, Moon, User, Settings, Logout as LogOut, Help as HelpCircle, Security as Shield,
} from '@carbon/icons-react';
import {
  Header as CdsHeader, HeaderMenuButton, HeaderName, HeaderGlobalBar, HeaderGlobalAction,
  HeaderPanel, SkipToContent, Switcher, SwitcherItem, SwitcherDivider, Tag,
} from '@carbon/react';

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
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme || 'light');
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.classList.toggle('cds--g100', next === 'dark');
    document.documentElement.classList.toggle('cds--g10', next !== 'dark');
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
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)
        && !(event.target as HTMLElement).closest?.('.cds--header__action')) {
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
    <CdsHeader aria-label={APP_NAME} className="app-header cds--g100">
      <SkipToContent />
      <HeaderMenuButton
        aria-label={isSidebarCollapsed ? 'Open menu' : 'Close menu'}
        onClick={onToggleSidebar}
        isActive={!isSidebarCollapsed}
        isCollapsible
        className="app-header__menu"
      />
      <HeaderName as={Link as any} to="/dashboard" prefix="">
        <DehLogo size={20} className="mr-2" />
        <span className="hidden sm:inline">{APP_NAME}</span>
      </HeaderName>
      <div className="app-header__tenant"><TenantSwitcher /></div>
      <span className="app-header__title hidden sm:block truncate">
        {breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].label : 'Dashboard'}
      </span>

      <HeaderGlobalBar>
        <HeaderGlobalAction aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={toggleTheme} tooltipAlignment="end">
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </HeaderGlobalAction>
        <HeaderGlobalAction aria-label="Notifications" tooltipAlignment="end" className="relative">
          <Bell size={20} />
          {notificationCount > 0 && (
            <span className="absolute top-2 right-2 min-w-4 h-4 px-1 bg-red-600 text-white text-[11px] rounded-full flex items-center justify-center">
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          )}
        </HeaderGlobalAction>
        <HeaderGlobalAction
          aria-label={userName}
          isActive={isProfileOpen}
          onClick={() => setIsProfileOpen(v => !v)}
          tooltipAlignment="end"
        >
          <span className="w-[26px] h-[26px] rounded-full bg-[#393939] flex items-center justify-center text-white text-xs font-semibold">{userInitial}</span>
        </HeaderGlobalAction>
      </HeaderGlobalBar>

      <HeaderPanel expanded={isProfileOpen} aria-label="Account" className="app-header__panel cds--g100">
        <div ref={dropdownRef} className="flex flex-col h-full">
          <div className="px-4 py-4 border-b border-[#393939]">
            <p className="text-sm font-semibold text-[#f4f4f4] truncate">{userName}</p>
            <p className="text-xs text-[#c6c6c6] truncate">{userEmail}</p>
            {isAdmin && (
              <Tag type="purple" size="sm" className="mt-2" renderIcon={Shield}>Admin</Tag>
            )}
          </div>
          <Switcher aria-label="Account menu">
            <SwitcherItem aria-label="Profile" onClick={() => { setIsProfileOpen(false); navigate('/profile'); }}>
              <span className="inline-flex items-center gap-3"><User size={16} /> Profile</span>
            </SwitcherItem>
            {isAdmin && (
              <SwitcherItem aria-label="Settings" onClick={() => { setIsProfileOpen(false); navigate('/settings'); }}>
                <span className="inline-flex items-center gap-3"><Settings size={16} /> Settings</span>
              </SwitcherItem>
            )}
            <SwitcherItem aria-label="Help & Support" onClick={() => setIsProfileOpen(false)}>
              <span className="inline-flex items-center gap-3"><HelpCircle size={16} /> Help & Support</span>
            </SwitcherItem>
            <SwitcherDivider />
            <SwitcherItem aria-label="Sign out" onClick={handleLogout}>
              <span className="inline-flex items-center gap-3"><LogOut size={16} /> Sign out</span>
            </SwitcherItem>
          </Switcher>
        </div>
      </HeaderPanel>
    </CdsHeader>
  );
};

export { getBreadcrumbs };
