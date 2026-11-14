import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

// Import routes
import projectsRouter from './routes/projects';
import flowsRouter from './routes/flows';
import executionsRouter from './routes/executions';
import connectionsRouter from './routes/connections';
import connectionSftpRouter from './routes/connectionSftp';
import sftpRouter from './routes/sftp';
import basketRouter from './routes/basket';
import basketsRouter from './routes/baskets';
import basketSessionsRouter from './routes/basket-sessions';
import basketSeedRouter from './routes/basket-seed';
import transferJobsRouter from './routes/transferJobs';
import apiSpecsRouter from './routes/apiSpecs';
import apiKeysRouter from './routes/apiKeys';
import { requireSession } from './middleware/requireSession';
import publicRouter, { deployedApiRouter } from './routes/public';
import schedulersRouter from './routes/schedulers';
import metricsRouter from './routes/metrics';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import workbenchRouter from './routes/workbench';
import repositoryRouter from './routes/repository';
import dataviewsRouter from './routes/dataviews';
import fileExplorerRouter from './routes/fileExplorer';
import shareLinksRouter from './routes/shareLinks';
import projectTagsRouter from './routes/projectTags';

// Import services
import { apiService } from './services/apiService';
import { schedulerService } from './services/scheduler';
import { ensureDefaultTenant } from './services/tenantBootstrap';
import { sweepStaleExecutions, EXECUTION_STALE_HOURS } from './lib/execution-progress';

// Load environment variables
const envPath = process.env.NODE_ENV === 'production' 
  ? path.resolve(__dirname, '../.env')
  : path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

// Create Express app
const app = express();

// Server Config
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Context Paths (CTX_* from .env)
const CTX_BASE_PATH = process.env.CTX_BASE_PATH || '/integration';
const CTX_BACKEND_PATH = process.env.CTX_BACKEND_PATH || '/int';
const CTX_PUBLIC = process.env.CTX_PUBLIC || '/deh';
const CTX_ADMIN_PATH = process.env.CTX_ADMIN_PATH || '/admin';

// Legacy support (backward compatible)
const API_PREFIX = process.env.API_PREFIX || CTX_BACKEND_PATH;
const PUBLIC_API_ROOT = process.env.PUBLIC_API_ROOT || CTX_PUBLIC;

// Path Config (จาก .env)
const PATH_BASKET_DIR = process.env.PATH_BASKET_DIR || '/data/basket';
const PATH_BASKETS_DIR = process.env.PATH_BASKETS_DIR || '/data/baskets';
const PATH_UPLOAD_DIR = process.env.PATH_UPLOAD_DIR || '/data/uploads';
const PATH_TEMP_DIR = process.env.PATH_TEMP_DIR || '/data/temp';
const PATH_LOG_DIR = process.env.PATH_LOG_DIR || '/data/logs';

// Database Config (จาก .env)
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_NAME = process.env.DB_NAME || 'integration_platform';
const DB_USER = process.env.DB_USER || 'integration';

// Security Config (available in process.env)
// const AUTH_SESSION_TIMEOUT = parseInt(process.env.AUTH_SESSION_TIMEOUT || '24', 10);
// const AUTH_MAX_LOGIN_ATTEMPTS = parseInt(process.env.AUTH_MAX_LOGIN_ATTEMPTS || '5', 10);

// Feature Flags
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';
const ENABLE_PUBLIC_API = process.env.ENABLE_PUBLIC_API !== 'false';
const ENABLE_ADMIN_PANEL = process.env.ENABLE_ADMIN_PANEL !== 'false';

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
  ],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Method Override Middleware — converts POST with X-HTTP-Method-Override header to PUT/DELETE
// This is needed because some WAFs (e.g. Cloudflare) block PUT/DELETE requests
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.method === 'POST') {
    const override = req.headers['x-http-method-override'] as string;
    if (override && ['PUT', 'DELETE', 'PATCH'].includes(override.toUpperCase())) {
      req.method = override.toUpperCase();
    }
  }
  next();
});

// API Key Middleware for /api/:slug/:version/* routes
// This middleware validates API keys for protected endpoints
const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Only apply to paths matching /api/:slug/:version/*
  const pathPattern = /^\/api\/[^\/]+\/v\d+\//;
  if (!pathPattern.test(req.path)) {
    return next(); // Skip if not a versioned API path
  }

  // Check if API Key is required (you can configure this per project/flow)
  const apiKey = req.headers['x-api-key'] as string;
  
  // TODO: In production, fetch from database and check if this specific API requires auth
  // For now, we'll validate against a demo key or skip if not configured
  const DEMO_API_KEYS = [
    'key_demo_12345',
    'key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    process.env.DEMO_API_KEY
  ].filter(Boolean);

  // If no API key provided
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API Key required',
      message: 'Please provide an API key in the X-API-Key header',
      documentation: 'See Deploy modal for your API key'
    });
  }

  // Validate API key (in production, check against database)
  const isValidKey = DEMO_API_KEYS.includes(apiKey) || apiKey.startsWith('key_');
  
  if (!isValidKey) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API Key',
      message: 'The provided API key is not valid'
    });
  }

  // Attach API key info to request for later use
  (req as any).apiKey = apiKey;
  next();
};

// Apply API Key middleware before routes
app.use(apiKeyMiddleware);

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  const apiKey = (req as any).apiKey ? ' [Authenticated]' : '';
  console.log(`[${timestamp}] ${req.method} ${req.path}${apiKey}`);
  next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Every internal /int route needs a logged-in user. Left open: /int/auth (login itself;
// /me and /logout check the token on their own), /health, the public API and the
// deployed API paths served by deployedApiRouter below (they use API keys).
// REQUIRE_LOGIN=false switches the check off (see middleware/requireSession.ts).
const LOGIN_REQUIRED_PREFIXES = [
  'projects', 'project-tags', 'flows', 'executions', 'connections', 'sftp', 'basket', 'baskets',
  'transfer-jobs', 'api-specs', 'schedulers', 'metrics', 'admin', 'analytics-workbench',
  'data-repository', 'dataviews', 'file-explorer', 'share-links',
].map((p) => `${API_PREFIX}/${p}`);
app.use(LOGIN_REQUIRED_PREFIXES, requireSession);

// API Routes
app.use(`${API_PREFIX}/projects`, projectsRouter);
app.use(`${API_PREFIX}/flows`, flowsRouter);
app.use(`${API_PREFIX}/executions`, executionsRouter);
app.use(`${API_PREFIX}/connections`, connectionSftpRouter); // SFTP browser on SFTP connections
app.use(`${API_PREFIX}/connections`, connectionsRouter);
app.use(`${API_PREFIX}/sftp`, sftpRouter); // SFTP Server management
app.use(`${API_PREFIX}/basket`, basketRouter);
app.use(`${API_PREFIX}/baskets`, basketsRouter);
app.use(`${API_PREFIX}/baskets`, basketSessionsRouter);
app.use(`${API_PREFIX}/baskets`, basketSeedRouter);
app.use(`${API_PREFIX}/transfer-jobs`, transferJobsRouter);
app.use(`${API_PREFIX}/api-specs`, apiSpecsRouter);
app.use(`${API_PREFIX}`, apiKeysRouter);
app.use(`${API_PREFIX}/schedulers`, schedulersRouter);
app.use(`${API_PREFIX}/metrics`, metricsRouter);
app.use(`${API_PREFIX}/auth`, authRouter); // Authentication
app.use(`${API_PREFIX}/admin`, adminRouter); // Admin setup
app.use(`${API_PREFIX}/analytics-workbench`, workbenchRouter); // Analytics Workbench
app.use(`${API_PREFIX}/data-repository`, repositoryRouter); // Data Repository
app.use(`${API_PREFIX}/dataviews`, dataviewsRouter); // Saved Data Views
app.use(`${API_PREFIX}/file-explorer`, fileExplorerRouter);
app.use(`${API_PREFIX}/share-links`, shareLinksRouter); // Global File Explorer workspace
// ProjectTag CRUD — mounts /int/projects/:projectId/tags and /int/project-tags/:id
app.use(`${API_PREFIX}`, projectTagsRouter);
app.use(PUBLIC_API_ROOT, publicRouter); // Public APIs: /{PUBLIC_API_ROOT}/{project}/public/{version}/...

// Deployed API Router: handles requests at deployed publicUrl paths (e.g., /int/partner API/v1/...)
// Must be after regular routes so they take priority, but before 404 handler
app.use(deployedApiRouter);

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'DEH API',
    version: '1.0.0',
    description: 'Backend API server for DEH',
    endpoints: {
      health: '/health',
      projects: `${API_PREFIX}/projects`,
      flows: `${API_PREFIX}/flows`,
      executions: `${API_PREFIX}/executions`,
      connections: `${API_PREFIX}/connections`,
    },
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: _req.path,
    method: _req.method,
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server
const server = app.listen(PORT, HOST, async () => {
  // Multi-tenancy phase 1: back-fill existing data into the "default" tenant
  ensureDefaultTenant().catch((err) => console.error('[tenant] default tenant bootstrap failed:', err));
  console.log('='.repeat(70));
  console.log('🚀 DEH API Server');
  console.log('='.repeat(70));
  console.log('📡 Server Config:');
  console.log(`   Port: ${PORT}`);
  console.log(`   Host: ${HOST}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('-'.repeat(70));
  console.log('🔗 Context Paths (CTX_*):');
  console.log(`   Frontend Base: ${CTX_BASE_PATH}`);
  console.log(`   Backend API: ${CTX_BACKEND_PATH}`);
  console.log(`   Public API: ${CTX_PUBLIC}`);
  console.log(`   Admin Path: ${CTX_ADMIN_PATH}`);
  console.log('-'.repeat(70));
  console.log('💾 Database:');
  console.log(`   Host: ${DB_HOST}:${DB_PORT}`);
  console.log(`   Database: ${DB_NAME}`);
  console.log(`   User: ${DB_USER}`);
  console.log('-'.repeat(70));
  console.log('📁 Paths:');
  console.log(`   Basket: ${PATH_BASKET_DIR}`);
  console.log(`   Baskets: ${PATH_BASKETS_DIR}`);
  console.log(`   Upload: ${PATH_UPLOAD_DIR}`);
  console.log(`   Temp: ${PATH_TEMP_DIR}`);
  console.log(`   Logs: ${PATH_LOG_DIR}`);
  console.log('-'.repeat(70));
  console.log('🔧 Features:');
  console.log(`   Scheduler: ${ENABLE_SCHEDULER ? '✅' : '❌'}`);
  console.log(`   Public API: ${ENABLE_PUBLIC_API ? '✅' : '❌'}`);
  console.log(`   Admin Panel: ${ENABLE_ADMIN_PANEL ? '✅' : '❌'}`);
  console.log('='.repeat(70));
  console.log('Available endpoints:');
  console.log(`  GET  ${API_PREFIX}/projects              - List all projects`);
  console.log(`  GET  ${API_PREFIX}/projects/:id          - Get project details`);
  console.log(`  POST ${API_PREFIX}/projects/:id/flows    - Create new flow`);
  console.log(`  GET  ${API_PREFIX}/flows/:id             - Get flow details`);
  console.log(`  PUT  ${API_PREFIX}/flows/:id             - Update flow`);
  console.log(`  POST ${API_PREFIX}/flows/:id/execute     - Execute flow`);
  console.log(`  GET  ${API_PREFIX}/executions            - List executions`);
  console.log(`  GET  ${API_PREFIX}/executions/:id/logs   - Get execution logs`);
  console.log(`  GET  ${API_PREFIX}/connections/:id/test  - Test connection`);
  console.log(`  GET  ${API_PREFIX}/schedulers            - List schedulers`);
  console.log(`  POST ${API_PREFIX}/auth/login            - Login`);
  console.log(`  GET  ${API_PREFIX}/admin/config          - Admin: Get config`);
  console.log(`  GET  ${API_PREFIX}/admin/stats           - Admin: Get stats`);
  console.log(`  GET  ${PUBLIC_API_ROOT}/:project/public/:version/* - Public APIs`);
  console.log('='.repeat(70));

  // Initialize API service (load active API flow mappings from DB)
  try {
    await apiService.initialize();
  } catch (error) {
    console.error('Failed to initialize API service:', error);
  }

  // Initialize scheduler service (load active cron jobs from DB)
  try {
    await schedulerService.initialize();
  } catch (error) {
    console.error('Failed to initialize scheduler service:', error);
  }

  // Release executions orphaned by a crash/restart, then keep checking. Without
  // this an interrupted run stays `Running` forever and the Run Flow screen
  // shows it as still in flight (and blocks the flow's concurrency slot).
  if (EXECUTION_STALE_HOURS > 0) {
    await sweepStaleExecutions();
    setInterval(() => { void sweepStaleExecutions(); }, 30 * 60 * 1000).unref();
  }

});

// Handle graceful shutdown
// ── Last-resort safety net ───────────────────────────────────────────────────
// An 'error' event with no listener (a ReadStream over a file that has been
// removed, for example) is fatal in Node: it terminates the process and every
// flow running inside it. Individual call sites handle their own errors; this
// exists so a single missed one degrades to a logged error instead of an
// outage. Anything logged here is a bug — find the unhandled emitter and fix it.
process.on('uncaughtException', (err: Error) => {
  console.error('[Server] UNCAUGHT EXCEPTION — server kept alive, fix the source:', err);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Server] UNHANDLED REJECTION — server kept alive, fix the source:', reason);
});

process.on('SIGTERM', () => {
  console.log('\n[Server] SIGTERM received, shutting down gracefully...');
  apiService.shutdown();
  schedulerService.stopAllJobs();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[Server] SIGINT received, shutting down gracefully...');
  apiService.shutdown();
  schedulerService.stopAllJobs();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

export default app;
