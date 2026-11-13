// Simple static file server with base path support + API proxy
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BASE_PATH = process.env.BASE_PATH || '/integration';
const DIST_DIR = path.join(__dirname, 'dist');

// Backend API config
// API_URL: backend host:port (no path)
// BACKEND_PATH: the path prefix backend registers routes on (CTX_BACKEND_PATH)
// PUBLIC_PATH: the path prefix for public APIs (CTX_PUBLIC)
// API_PATH: what the frontend bundle calls (hardcoded in Vite build)
const API_BASE = process.env.API_URL || 'http://server:8080';
const API_PATH = process.env.API_PATH || '/int';           // frontend calls /int/*
const BACKEND_PATH = process.env.BACKEND_PATH || '/int';   // backend listens on this
const PUBLIC_PATH = process.env.PUBLIC_PATH || '/deh';      // public API prefix

// Startup logging
console.log('========================================');
console.log('Frontend Server Startup');
console.log('========================================');
console.log('DIST_DIR:', DIST_DIR);
console.log('DIST exists:', fs.existsSync(DIST_DIR));
console.log('index.html exists:', fs.existsSync(path.join(DIST_DIR, 'index.html')));
console.log('BASE_PATH:', BASE_PATH);
console.log('PORT:', PORT);
console.log('HOST:', HOST);
console.log('API_BASE:', API_BASE);
console.log('API_PATH:', API_PATH, '(frontend calls)');
console.log('BACKEND_PATH:', BACKEND_PATH, '(backend listens)');
console.log('PUBLIC_PATH:', PUBLIC_PATH, '(public API)');
console.log('========================================');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

// Proxy API requests to backend
function proxyToBackend(req, res, targetPath) {
  // Parse API_BASE to get host/port
  const base = new URL(API_BASE);
  const targetUrl = url.parse(targetPath);

  const options = {
    hostname: base.hostname,
    port: base.port || 80,
    path: targetUrl.path,
    method: req.method,
    headers: {
      ...req.headers,
      host: base.host,
    },
  };

  console.log('[Proxy]', req.method, req.url, '->', `${API_BASE}${targetUrl.path}`);

  const proxyReq = http.request(options, (proxyRes) => {
    console.log('[Proxy Response]', proxyRes.statusCode, targetUrl.path);
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy Error]', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Backend unavailable',
      details: err.message
    }));
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;
  const startTime = Date.now();

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Proxy internal API requests: /int/* -> backend BACKEND_PATH/*
  if (pathname.startsWith(API_PATH + '/') || pathname === API_PATH) {
    let targetPath = req.url;
    // Rewrite path if API_PATH differs from BACKEND_PATH
    if (API_PATH !== BACKEND_PATH) {
      targetPath = BACKEND_PATH + req.url.slice(API_PATH.length);
    }
    return proxyToBackend(req, res, targetPath);
  }

  // Proxy public API requests: /deh/* -> backend as-is
  if (pathname.startsWith(PUBLIC_PATH + '/') || pathname === PUBLIC_PATH) {
    return proxyToBackend(req, res, req.url);
  }

  // Redirect root to BASE_PATH
  if (pathname === '/') {
    res.writeHead(302, { Location: BASE_PATH + '/' });
    res.end();
    return;
  }

  // Redirect /login to BASE_PATH/login (SPA route support)
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    const newPath = BASE_PATH + pathname;
    res.writeHead(302, { Location: newPath });
    res.end();
    return;
  }

  // Check if path starts with BASE_PATH
  if (!pathname.startsWith(BASE_PATH)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Remove BASE_PATH from pathname
  pathname = pathname.slice(BASE_PATH.length) || '/';

  // Map to file path
  let filePath = path.join(DIST_DIR, pathname);
  if (pathname === '/') {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  // Check if file exists
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA fallback: serve index.html for client-side routes
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.error('[Error] Failed to read file:', filePath, err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error: ' + err.message);
        return;
      }

      const duration = Date.now() - startTime;
      // index.html must never be cached, or browsers keep running the old
      // bundle after a deploy; hashed assets can be cached forever
      const headers = { 'Content-Type': contentType };
      if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      else if (pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      res.writeHead(200, headers);
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log('Frontend server is running!');
  console.log('URL: http://' + HOST + ':' + PORT + BASE_PATH + '/');
  console.log('API Proxy: ' + API_PATH + '/* -> ' + API_BASE + BACKEND_PATH + '/*');
  console.log('Public Proxy: ' + PUBLIC_PATH + '/* -> ' + API_BASE + PUBLIC_PATH + '/*');
  console.log('========================================');
});

// Error handling
server.on('error', (err) => {
  console.error('[Server Error]', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, closing server...');
  server.close(() => {
    console.log('[Shutdown] Server closed');
    process.exit(0);
  });
});
