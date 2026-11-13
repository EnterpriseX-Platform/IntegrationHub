// ============================================
// API Configuration
// Change this one file to update API path everywhere
// ============================================

/**
 * Base path for frontend routing (matches CTX_BASE_PATH)
 */
export const BASE_PATH = import.meta.env.VITE_BASE_PATH || '/integration';

/**
 * Base API URL for backend (matches CTX_BACKEND_PATH)
 */
export const API_BASE_URL = import.meta.env.VITE_API_PREFIX || '/int';

/**
 * Full API URL (used for most fetch calls)
 */
export const API_URL = API_BASE_URL;

/**
 * Build API endpoint URL
 * Usage: api('/projects') -> '/int/projects'
 */
export function api(path: string): string {
  // Remove leading slash if present
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${API_BASE_URL}/${cleanPath}`;
}

/**
 * Public API root (matches CTX_PUBLIC)
 */
export const PUBLIC_API_ROOT = import.meta.env.VITE_PUBLIC_API_ROOT || '/deh';

/**
 * WAF-safe fetch wrapper — converts PUT/DELETE to POST with X-HTTP-Method-Override header.
 * Some WAFs (e.g. Cloudflare) block PUT/DELETE requests, so we tunnel them through POST.
 * Usage: drop-in replacement for fetch() in API calls.
 */
export function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const method = options?.method?.toUpperCase();
  if (method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
    const headers = new Headers(options?.headers);
    headers.set('X-HTTP-Method-Override', method);
    return fetch(url, { ...options, method: 'POST', headers });
  }
  return fetch(url, options);
}

/** The login token (set by the Login page), or '' when logged out / storage unavailable. */
export function authToken(): string {
  try {
    return localStorage.getItem('token') || '';
  } catch {
    return '';
  }
}

/** Headers carrying the login token, for fetch() calls to routes that require login. */
export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = authToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/**
 * `url` with the login token as `?token=`, for downloads opened by the browser itself
 * (<a href>, window.open), which cannot send an Authorization header.
 */
export function withAuthToken(url: string): string {
  const token = authToken();
  return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
}
