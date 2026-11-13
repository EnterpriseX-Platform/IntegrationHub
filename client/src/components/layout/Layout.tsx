import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { API_URL } from '../../config/api';
import { refreshCurrentUser } from '../../lib/currentUser';

const MOBILE_BREAKPOINT = 768; // tailwind md

const Layout: React.FC = () => {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);   // desktop only
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);   // mobile only
  const [authChecked, setAuthChecked] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Listen to viewport changes
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close mobile drawer on route change
  useEffect(() => { setIsMobileDrawerOpen(false); }, [location.pathname]);

  const toggleSidebar = () => {
    if (isMobile) setIsMobileDrawerOpen(v => !v);
    else setIsSidebarCollapsed(v => !v);
  };

  // Check authentication on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login', { replace: true, state: { from: `${location.pathname}${location.search}` } });
      return;
    }

    // Verify token is still valid
    fetch(`${API_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => {
        // Only the app's own 401 ends the session. Anything else that isn't OK
        // (a 5xx, a Cloudflare 403 challenge) means we couldn't check — handled below.
        if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!data.success) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          navigate('/login', { replace: true, state: { from: `${location.pathname}${location.search}` } });
        } else {
          // Update user info in case it changed
          localStorage.setItem('user', JSON.stringify(data.data));
          setAuthChecked(true);
        }
      })
      .catch(() => {
        // If API is unreachable, still allow access with existing token
        setAuthChecked(true);
      });
    // Checked once on mount; location is only read to remember where to return after login
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  // Pick up role changes (or a revoked session) without a reload: re-check on
  // navigation and when the tab regains focus (throttled in refreshCurrentUser)
  useEffect(() => {
    if (!authChecked) return;
    const check = () => refreshCurrentUser().then((ok) => {
      if (!ok) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        navigate('/login', { replace: true });
      }
    });
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, location.pathname]);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Backdrop for mobile drawer */}
      {isMobile && isMobileDrawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm md:hidden"
          onClick={() => setIsMobileDrawerOpen(false)}
        />
      )}

      {/* Sidebar — push-style on desktop, overlay drawer on mobile */}
      <Sidebar
        isCollapsed={!isMobile && isSidebarCollapsed}
        isMobile={isMobile}
        isMobileOpen={isMobileDrawerOpen}
      />

      {/* Main Content Area — no left margin on mobile (sidebar is overlay) */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ${
          isMobile ? 'ml-0' : (isSidebarCollapsed ? 'ml-16' : 'ml-60')
        }`}
      >
        {/* Header with collapse button */}
        <Header
          isSidebarCollapsed={isMobile ? !isMobileDrawerOpen : isSidebarCollapsed}
          onToggleSidebar={toggleSidebar}
        />

        {/* Page Content */}
        <main className="flex-1 min-h-0 flex flex-col overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;
