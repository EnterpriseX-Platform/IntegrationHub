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

interface NavItem {
  section?: string;
  path: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { section: 'Workflows', path: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-[18px] h-[18px]" /> },
  { path: '/projects', label: 'Projects', icon: <FolderOpen className="w-[18px] h-[18px]" /> },
  { path: '/executions', label: 'Executions', icon: <History className="w-[18px] h-[18px]" /> },
  { path: '/schedulers', label: 'Schedulers', icon: <Clock className="w-[18px] h-[18px]" /> },
  { path: '/tasks', label: 'Run Flow', icon: <Zap className="w-[18px] h-[18px]" /> },
  { section: 'Data', path: '/baskets', label: 'Baskets', icon: <FolderKanban className="w-[18px] h-[18px]" /> },
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
      className={`bg-[var(--nav-bg)] border-r border-[var(--nav-border)] flex flex-col shrink-0 ${isMobile ? 'fixed left-0 top-12 bottom-0 z-40' : 'relative z-20'} overflow-hidden ${isMobile ? 'shadow-xl' : ''} transition-all duration-300 ${widthClass} ${translateClass}`}
    >
      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <React.Fragment key={item.path}>
            {item.section && (isCollapsed
              ? <div className="mx-3 my-2 border-t border-[var(--nav-border)]" />
              : <div className="px-4 pt-4 pb-1 text-[13px] text-[var(--nav-icon)]">{item.section}</div>)}
            <NavLink
              to={item.path}
              title={isCollapsed ? item.label : undefined}
              className={`relative flex items-center h-10 text-sm border-l-[3px] transition-colors ${
                isCollapsed ? 'justify-center' : 'gap-3 px-4'
              } ${
                isActive
                  ? 'bg-[var(--nav-active)] border-[var(--nav-bar)] text-[var(--nav-text-strong)] font-semibold'
                  : 'border-transparent text-[var(--nav-text)] font-normal hover:bg-[var(--nav-hover)] hover:text-[var(--nav-text-strong)]'
              }`}
            >
              <span className={`flex-shrink-0 ${isActive ? 'text-[var(--nav-text-strong)]' : 'text-[var(--nav-icon)]'}`}>
                {item.icon}
              </span>
              {!isCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
            </React.Fragment>
          );
        })}
      </nav>
    </aside>
  );
};
