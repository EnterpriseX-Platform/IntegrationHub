import { useEffect, useState } from 'react';
import { API_URL } from '../config/api';

export interface TenantSummary { id: string; slug: string; name: string; role: string; branding?: Record<string, unknown> }
export interface CurrentUser {
  id?: string; email?: string; name?: string | null; role?: string;
  /** Active tenant of this login and the user's role in it */
  tenantId?: string; tenantRole?: string; tenants?: TenantSummary[];
}

const EVENT = 'current-user-changed';

/** The user saved at login / last refresh, or null. */
export function storedUser(): CurrentUser | null {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}

/** Unknown role counts as not admin; the server checks again on every call. */
export function isAdminUser(u: CurrentUser | null = storedUser()): boolean {
  return u?.role === 'admin' || u?.tenantRole === 'tenant-admin';
}

/** Platform super-admin (manages tenants, users and system settings). */
export function isSuperAdmin(u: CurrentUser | null = storedUser()): boolean {
  return u?.role === 'admin';
}

let lastRefresh = 0;

/**
 * Re-read the logged-in user from the server so a role changed by an admin
 * applies without logging out. Throttled; returns false when the session is gone.
 */
export async function refreshCurrentUser(force = false): Promise<boolean> {
  const token = localStorage.getItem('token');
  if (!token) return false;
  if (!force && Date.now() - lastRefresh < 30_000) return true;
  lastRefresh = Date.now();
  try {
    const res = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return false;
    if (!res.ok) return true; // couldn't check (5xx, Cloudflare) — keep what we have
    const data = await res.json();
    if (!data.success) return false;
    const before = localStorage.getItem('user');
    const after = JSON.stringify(data.data);
    if (before !== after) {
      localStorage.setItem('user', after);
      window.dispatchEvent(new Event(EVENT));
    }
    return true;
  } catch {
    return true;
  }
}

/** Current user, re-rendering when a refresh changes it (also across tabs). */
export function useCurrentUser(): CurrentUser | null {
  const [user, setUser] = useState(storedUser);
  useEffect(() => {
    const update = () => setUser(storedUser());
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(EVENT, update); window.removeEventListener('storage', update); };
  }, []);
  return user;
}
