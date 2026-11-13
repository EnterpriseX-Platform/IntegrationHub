import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderOpen,
  History,
  FolderKanban,
  Archive,
  Zap,
  FolderTree,
  Clock,
} from 'lucide-react';
import { DehLogo } from '../ui/DehLogo';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-[18px] h-[18px]" /> },
  { path: '/projects', label: 'Projects', icon: <FolderOpen className="w-[18px] h-[18px]" /> },
  { path: '/executions', label: 'Executions', icon: <History className="w-[18px] h-[18px]" /> },
  { path: '/schedulers', label: 'Schedulers', icon: <Clock className="w-[18px] h-[18px]" /> },
  { path: '/tasks', label: 'Run Flow', icon: <Zap className="w-[18px] h-[18px]" /> },
  { path: '/baskets', label: 'Baskets', icon: <FolderKanban className="w-[18px] h-[18px]" /> },
  { path: '/file-explorer', label: 'File Explorer', icon: <FolderTree className="w-[18px] h-[18px]" /> },
  { path: '/data-repository', label: 'Repository', icon: <Archive className="w-[18px] h-[18px]" /> },
];

interface SidebarProps {
  isCollapsed?: boolean;
  /** When true, sidebar uses mobile drawer behaviour (slides in/out from left). */
  isMobile?: boolean;
  /** Visible/hidden state for the mobile drawer. Ignored on desktop. */
  isMobileOpen?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ isCollapsed = false, isMobile = false, isMobileOpen = false }) => {
  const location = useLocation();

  // Mobile: full-width drawer that slides in from -translate-x-full → translate-x-0.
  // Desktop: push-style w-60 expanded / w-16 collapsed (Layout offsets main to match).
  const widthClass = isMobile ? 'w-64' : (isCollapsed ? 'w-16' : 'w-60');
  const translateClass = isMobile
    ? (isMobileOpen ? 'translate-x-0' : '-translate-x-full')
    : 'translate-x-0';

  return (
    <aside
      className={`bg-gray-50 flex flex-col fixed left-0 top-0 h-full z-40 overflow-hidden ${isMobile ? 'shadow-xl' : ''} transition-all duration-300 ${widthClass} ${translateClass}`}
    >
      {/* Logo */}
      <div className={`h-14 shrink-0 flex items-center ${isCollapsed ? 'justify-center px-2' : 'px-4'}`}>
        <DehLogo size={32} className="flex-shrink-0" />
        {!isCollapsed && (
          <div className="ml-2.5 min-w-0 leading-tight">
            <div className="font-semibold text-[15px] text-gray-900">DEH</div>
            <div className="text-[11px] text-gray-500 truncate">Data Exchange Hub</div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto pt-1 pb-3 px-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <NavLink
              key={item.path}
              to={item.path}
              title={isCollapsed ? item.label : undefined}
              className={`relative flex items-center h-9 rounded-lg text-sm transition-colors ${
                isCollapsed ? 'justify-center' : 'gap-2.5 px-2.5'
              } ${
                isActive
                  ? 'bg-sky-100 text-blue-700 font-semibold'
                  : 'text-gray-500 font-medium hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <span className={`flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-400'}`}>
                {item.icon}
              </span>
              {!isCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
};
