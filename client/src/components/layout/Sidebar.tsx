import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SideNav, SideNavItems, SideNavLink, SideNavDivider } from '@carbon/react';
import {
  Dashboard, FolderOpen, RecentlyViewed, Folders, Archive, Flash, TreeViewAlt, Time,
} from '@carbon/icons-react';

interface NavItem {
  section?: string;
  path: string;
  label: string;
  icon: React.ComponentType<any>;
}

const navItems: NavItem[] = [
  { section: 'Workflows', path: '/dashboard', label: 'Dashboard', icon: Dashboard },
  { path: '/projects', label: 'Projects', icon: FolderOpen },
  { path: '/executions', label: 'Executions', icon: RecentlyViewed },
  { path: '/schedulers', label: 'Schedulers', icon: Time },
  { path: '/tasks', label: 'Run Flow', icon: Flash },
  { section: 'Data', path: '/baskets', label: 'Baskets', icon: Folders },
  { path: '/file-explorer', label: 'File Explorer', icon: TreeViewAlt },
  { path: '/data-repository', label: 'Repository', icon: Archive },
];

interface SidebarProps {
  isCollapsed?: boolean;
  /** When true, sidebar uses mobile drawer behaviour (slides in/out from left). */
  isMobile?: boolean;
  /** Visible/hidden state for the mobile drawer. Ignored on desktop. */
  isMobileOpen?: boolean;
}

/**
 * Carbon SideNav. Desktop: expanded (256px) or icon rail (48px), laid out in
 * the page flow (see .app-sidenav in index.css). Mobile: overlay drawer.
 */
export const Sidebar: React.FC<SidebarProps> = ({ isCollapsed = false, isMobile = false, isMobileOpen = false }) => {
  const location = useLocation();
  const expanded = isMobile ? isMobileOpen : !isCollapsed;
  // Carbon marks a collapsed SideNav `inert` (nothing inside can be clicked)
  // and slides it off-screen. On desktop the collapsed state is our own icon
  // rail, so Carbon is always told "expanded" and the rail is pure CSS.
  const carbonExpanded = isMobile ? isMobileOpen : true;

  return (
    <SideNav
      aria-label="Main navigation"
      expanded={carbonExpanded}
      isPersistent={!isMobile}
      isFixedNav={!isMobile}
      isChildOfHeader={false}
      className={`app-sidenav ${isMobile ? 'app-sidenav--mobile' : ''} ${expanded ? '' : 'app-sidenav--rail'}`}
    >
      <SideNavItems>
        {navItems.map((item, idx) => {
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <React.Fragment key={item.path}>
              {item.section && (expanded
                ? <li className="app-sidenav__section">{item.section}</li>
                : idx > 0 && <SideNavDivider />)}
              <SideNavLink
                as={Link as any}
                to={item.path}
                renderIcon={item.icon}
                isActive={isActive}
                title={expanded ? undefined : item.label}
              >
                {item.label}
              </SideNavLink>
            </React.Fragment>
          );
        })}
      </SideNavItems>
    </SideNav>
  );
};
