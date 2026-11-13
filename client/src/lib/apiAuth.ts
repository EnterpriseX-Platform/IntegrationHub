// Send the login token with every call to our own API.
//
// The server requires a valid session on /int/* (server/src/middleware/requireSession.ts).
// Most pages call fetch()/XMLHttpRequest directly without an Authorization header, so
// instead of touching every call site this adds `Authorization: Bearer <token>` to any
// request aimed at API_URL, and sends the user to the login page (remembering where
// they were) when the server says the session is gone.
//
// Downloads the browser opens itself (<a href>, window.open) cannot carry a header;
// those use withAuthToken() from config/api.ts.

import { API_URL, BASE_PATH, authToken } from '../config/api';

function isApiUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin && (u.pathname === API_URL || u.pathname.startsWith(`${API_URL}/`));
  } catch {
    return false;
  }
}

function isAuthCall(url: string): boolean {
  return new URL(url, window.location.href).pathname.startsWith(`${API_URL}/auth/`);
}

let redirecting = false;
function goToLogin() {
  if (redirecting) return;
  const base = BASE_PATH.replace(/\/$/, '');
  const here = window.location.pathname.startsWith(base) ? window.location.pathname.slice(base.length) || '/' : window.location.pathname;
  if (here.startsWith('/login')) return;
  redirecting = true;
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch { /* storage unavailable */ }
  // Login reads ?from= and returns there after signing in
  window.location.assign(`${base}/login?from=${encodeURIComponent(here + window.location.search)}`);
}

// A gateway or proxy error (Apache 502, Cloudflare 403 challenge, Vite proxy
// with no backend) arrives as an empty or HTML body. Pages read every response
// with res.json(), so without this they show the parser's own message
// ("Unexpected end of JSON input"). Give them the app's usual error shape
// instead, keeping the status code.
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normaliseError(res: Response): Response {
  if (res.ok) return res;
  if ((res.headers.get('content-type') || '').includes('application/json')) return res;
  return jsonError(
    res.status,
    res.status >= 500
      ? `Can't reach the server (HTTP ${res.status}). Try again in a moment.`
      : `The server returned an unexpected response (HTTP ${res.status}).`,
  );
}

async function isSessionRejection(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = await res.clone().json();
    return /login required|session expired/i.test(String(body?.error || ''));
  } catch {
    return false;
  }
}

export function installApiAuth() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isApiUrl(url)) return originalFetch(input, init);

    const token = authToken();
    let req: Request | undefined;
    if (token) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      req = new Request(input instanceof Request ? input : url, { ...init, headers });
    }
    let res: Response;
    try {
      res = normaliseError(await originalFetch(req ?? input, req ? undefined : init));
    } catch (err) {
      // Network failure ("Failed to fetch"); aborts still throw as callers expect.
      if (err instanceof TypeError) return jsonError(503, "Can't reach the server. Check your connection and try again.");
      throw err;
    }
    if (!isAuthCall(url) && (await isSessionRejection(res))) goToLogin();
    return res;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __apiUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__apiUrl = String(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (open as any).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __apiUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const token = authToken();
    if (token && this.__apiUrl && isApiUrl(this.__apiUrl)) {
      try { this.setRequestHeader('Authorization', `Bearer ${token}`); } catch { /* header already sent */ }
    }
    return send.call(this, body);
  };
}
