// Public API routes - URL format: /api/{projectCode}/{basePath}/{operationPath}
// Example: /api/dga/v1/users
//   - projectCode: dga
//   - basePath: /v1
//   - operationPath: /users

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { ExecutionEngine } from '../sdk/execution';
import { DatabaseExecutor } from '../sdk/execution/executors/DatabaseExecutor';
import { HttpRequestExecutor } from '../sdk/execution/executors/HttpRequestExecutor';
import { FileReadExecutor } from '../sdk/execution/executors/FileReadExecutor';
import { FileWriteExecutor } from '../sdk/execution/executors/FileWriteExecutor';
import { TransformExecutor } from '../sdk/execution/executors/TransformExecutor';
import { ConditionExecutor } from '../sdk/execution/executors/ConditionExecutor';
import { ApiInputExecutor } from '../sdk/execution/executors/ApiInputExecutor';
import { ApiOutputExecutor } from '../sdk/execution/executors/ApiOutputExecutor';
import { ForEachExecutor } from '../sdk/execution/executors/ForEachExecutor';
import { OcrExecutor } from '../sdk/execution/executors/OcrExecutor';
import { BasketActionExecutor } from '../sdk/execution/executors/BasketActionExecutor';
import { FileEncryptExecutor } from '../sdk/execution/executors/FileEncryptExecutor';
import { FileDecryptExecutor } from '../sdk/execution/executors/FileDecryptExecutor';
import { authenticateApiKey, flowAuth as _flowAuth } from '../middleware/auth';
import { apiService, ApiMapping } from '../services/apiService';

const router = Router();

// Parse URL: /{projectCode}/public/{basePath...}/{operationPath}
// (Router mounted at PUBLIC_API_ROOT, so fullPath starts with /{project}/public)
function parseUrl(fullPath: string): { projectCode: string; remainingPath: string } | null {
  // Match pattern: /{projectCode}/public/{rest...}
  const match = fullPath.match(/^\/([a-zA-Z0-9_-]+)\/public(\/.*)?$/);
  if (!match) return null;

  return {
    projectCode: match[1],
    remainingPath: match[2] || '/',
  };
}

// Get client IP
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (typeof realIp === 'string') {
    return realIp;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Check if IP is allowed
function isIpAllowed(clientIp: string, whitelist: string[], blacklist: string[]): boolean {
  // Check blacklist
  if (blacklist?.length > 0) {
    if (blacklist.some(ip => clientIp === ip || matchCidr(clientIp, ip))) {
      return false;
    }
  }
  
  // Check whitelist
  if (whitelist?.length > 0) {
    return whitelist.some(ip => clientIp === ip || matchCidr(clientIp, ip));
  }
  
  return true;
}

function matchCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return false;
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  const ipNum = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  const rangeNum = range.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  const maskBits = 0xFFFFFFFF << (32 - mask);
  return (ipNum & maskBits) === (rangeNum & maskBits);
}

// Apply authentication middleware to all routes
router.all('*', authenticateApiKey);

// Dynamic API endpoint handler
// If URL doesn't match /{projectCode}/public/... pattern, fall through to deployedApiRouter
router.all('*', async (req: Request, res: Response, next: NextFunction) => {
  const fullPath = req.path;
  const method = req.method.toUpperCase();

  const parsed = parseUrl(fullPath);

  if (!parsed) {
    // Not a standardized public URL — let deployedApiRouter handle it
    return next();
  }

  const { projectCode, remainingPath } = parsed;

  const projectId = apiService.getProjectCodeCache().get(projectCode);
  if (!projectId) {
    return res.status(404).json({
      error: 'Project not found',
      projectCode,
      availableProjects: Array.from(apiService.getProjectCodeCache().keys()),
    });
  }

  const match = apiService.findMatchingApi(projectCode, remainingPath);

  if (!match) {
    return res.status(404).json({
      error: 'API not found for this project',
      projectCode,
      remainingPath,
    });
  }

  return handleApiRequest(match.api, match.operationPath, method, req, res, { rawOutput: true });
});

async function handleApiRequest(
  api: ApiMapping,
  operationPath: string,
  method: string,
  req: Request,
  res: Response,
  options?: { rawOutput?: boolean }
) {
  const config = api.config;

  // Find matching operation and extract path parameters
  let apiOperation: any = null;
  let pathParams: Record<string, string> = {};

  for (const op of (config.apiSpec?.operations || [])) {
    if (op.method !== method) continue;
    if (op.path === operationPath) {
      apiOperation = op;
      break;
    }

    // Extract param names from pattern like /{year}/province
    const paramNames: string[] = [];
    const opPattern = op.path.replace(/{([^}]+)}/g, (_: string, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const regex = new RegExp(`^${opPattern}$`);
    const match = operationPath.match(regex);
    if (match) {
      apiOperation = op;
      paramNames.forEach((name, i) => {
        pathParams[name] = match[i + 1];
      });
      break;
    }
  }

  if (!apiOperation) {
    return res.status(404).json({
      error: 'Operation not found',
      method,
      path: operationPath,
    });
  }

  const operationId = apiOperation.id || apiOperation.operationId;
  if (!operationId) {
    return res.status(404).json({ error: 'Operation ID not found' });
  }

  // Get deployment config
  const deploymentConfig = config.deployment || {};
  
  // Get operation-specific or global security config
  const securityConfig = apiOperation.security || config.security || {};
  
  // Check if API key is required (deployment config takes precedence)
  const requireApiKey = deploymentConfig.requireApiKey !== undefined 
    ? deploymentConfig.requireApiKey 
    : (securityConfig.requireApiKey !== false);
  
  // Validate authentication if required
  if (requireApiKey) {
    // API key is required by default
    if (!req.apiKey) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'API_KEY_REQUIRED',
        message: 'Provide API key via Authorization: Bearer <key> or X-API-Key header',
      });
    }

    // Validate project match
    if (req.apiKey.projectId !== api.projectId) {
      return res.status(403).json({
        error: 'API key not valid for this project',
        code: 'WRONG_PROJECT',
      });
    }

    // Validate allowed key types
    const allowedTypes = securityConfig.allowedKeyTypes || ['client', 'server', 'service'];
    if (!allowedTypes.includes(req.apiKey.type)) {
      return res.status(403).json({
        error: `Key type '${req.apiKey.type}' not allowed for this operation`,
        code: 'INVALID_KEY_TYPE',
        allowedTypes,
      });
    }

    // Validate scopes
    const requiredScopes = securityConfig.scopes || ['read'];
    const hasScope = requiredScopes.some((scope: string) => 
      req.apiKey!.scopes.includes(scope) || req.apiKey!.scopes.includes('admin')
    );
    if (!hasScope) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'INSUFFICIENT_SCOPE',
        required: requiredScopes,
        yourScopes: req.apiKey.scopes,
      });
    }
  }

  // Validate IP if configured at operation level
  if (securityConfig.validateIp || securityConfig.ipWhitelist?.length > 0) {
    const clientIp = getClientIp(req);
    const whitelist = securityConfig.ipWhitelist || [];
    const blacklist = securityConfig.ipBlacklist || [];
    
    if (!isIpAllowed(clientIp, whitelist, blacklist)) {
      return res.status(403).json({
        error: 'Access denied from this IP address',
        code: 'IP_NOT_ALLOWED',
        yourIp: clientIp,
      });
    }
  }

  return executeDeployedFlow(api.flowId, operationId, req, res, config, api, securityConfig, pathParams, options?.rawOutput);
}

async function executeDeployedFlow(
  flowId: string,
  operationId: string,
  req: Request,
  res: Response,
  config: any,
  api: ApiMapping,
  _securityConfig: any,
  pathParams: Record<string, string> = {},
  rawOutput?: boolean
) {
  try {
    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      include: { project: { select: { id: true, name: true, code: true } } },
    });

    if (!flow || flow.status !== 'Active') {
      return res.status(404).json({ error: 'API not found or not active' });
    }

    const operationFlows = config.operationFlows || {};
    const flowData = operationFlows[operationId];

    if (!flowData) {
      return res.status(404).json({
        error: 'Operation flow not found',
        operationId,
      });
    }

    const startTime = Date.now();

    // Initialize Execution Engine with apiSpec for schema-based transforms
    const engine = new ExecutionEngine({
      connections: new Map(),
      apiSpec: config.apiSpec, // Pass apiSpec for response schema transforms
      onLog: (log) => console.log(`[API ${operationId}] ${log.level}: ${log.message}`),
    });

    // Register executors
    engine.registerExecutor(new ApiInputExecutor());
    engine.registerExecutor(new ApiOutputExecutor());
    engine.registerExecutor(new DatabaseExecutor());
    engine.registerExecutor(new HttpRequestExecutor());
    engine.registerExecutor(new FileReadExecutor());
    engine.registerExecutor(new FileWriteExecutor());
    engine.registerExecutor(new TransformExecutor());
    engine.registerExecutor(new ConditionExecutor());
    engine.registerExecutor(new ForEachExecutor());
    engine.registerExecutor(new OcrExecutor());
    engine.registerExecutor(new BasketActionExecutor());
    engine.registerExecutor(new FileEncryptExecutor());
    engine.registerExecutor(new FileDecryptExecutor());

    // Build execution context with auth info
    const executionContext = {
      method: req.method as any,
      path: req.path,
      query: req.query as Record<string, any>,
      params: { ...req.params, ...pathParams },
      headers: req.headers as Record<string, any>,
      body: req.body,
      auth: req.apiKey ? {
        keyId: req.apiKey.id,
        type: req.apiKey.type,
        scopes: req.apiKey.scopes,
        validated: true,
      } : null,
      clientIp: getClientIp(req),
    };

    const flowDef = {
      operationId,
      nodes: flowData.nodes || [],
      edges: flowData.edges || [],
    };

    const result = await engine.execute(flowDef, executionContext);

    // Build detailed execution logs
    const executionLogs: any[] = [
      { timestamp: new Date(startTime).toISOString(), level: 'info', message: `🚀 Execution started`, operationId },
      { timestamp: new Date().toISOString(), level: 'info', message: `📡 ${req.method} ${req.path}` },
      { timestamp: new Date().toISOString(), level: 'info', message: `🔑 Auth: ${req.apiKey?.type || 'none'}`, auth: req.apiKey?.type },
    ];

    // Add node execution logs
    if (result.metadata?.nodeResults) {
      for (const nodeResult of result.metadata.nodeResults) {
        // Find node name from flow definition
        const node = flowData.nodes?.find((n: any) => n.id === nodeResult.nodeId);
        const nodeName = node?.data?.label || node?.type || nodeResult.nodeId;
        
        executionLogs.push({
          timestamp: nodeResult.startedAt,
          level: nodeResult.success ? 'info' : 'error',
          message: `${nodeResult.success ? '✅' : '❌'} Node: ${nodeName} (${nodeResult.nodeType})`,
          nodeId: nodeResult.nodeId,
          nodeName: nodeName,
          nodeType: nodeResult.nodeType,
          duration: `${nodeResult.durationMs}ms`,
        });

        if (nodeResult.error) {
          executionLogs.push({
            timestamp: nodeResult.endedAt,
            level: 'error',
            message: `   Error: ${nodeResult.error}`,
            nodeId: nodeResult.nodeId,
            nodeName: nodeName,
          });
        }
      }
    }

    executionLogs.push({
      timestamp: new Date().toISOString(),
      level: result.success ? 'info' : 'error',
      message: result.success 
        ? `✅ Execution completed (${result.metadata?.durationMs}ms)`
        : `❌ Execution failed: ${result.error}`,
      duration: result.metadata?.durationMs,
    });

    // Create execution log with detailed node results
    const apiCallerName = req.apiKey
      ? `${req.apiKey.name} / ${operationId}`
      : `API / ${operationId}`;
    await prisma.execution.create({
      data: {
        flowId,
        projectId: flow.projectId,
        status: result.success ? 'Completed' : 'Failed',
        startedAt: new Date(startTime),
        endedAt: new Date(),
        triggerType: 'api',
        callerName: apiCallerName,
        result: JSON.stringify({
          ...result,
          nodeExecutions: result.metadata?.nodeResults?.map((nr: any) => {
            const node = flowData.nodes?.find((n: any) => n.id === nr.nodeId);
            return {
              nodeId: nr.nodeId,
              nodeType: nr.nodeType,
              nodeName: node?.data?.label || node?.type || nr.nodeId,
              status: nr.success ? 'success' : 'error',
              startedAt: nr.startedAt,
              endedAt: nr.endedAt,
              durationMs: nr.durationMs,
              error: nr.error,
              output: nr.output,
            };
          }),
        }),
        logs: JSON.stringify(executionLogs),
        error: result.error || null,
      },
    });

    // Check if result is a file download
    if (result.success && result.data?._fileDownload) {
      const fileDownload = result.data._fileDownload;
      const headers = result.data.headers || {};

      // Use the safe writer — handles Thai/Unicode in Content-Disposition
      // filenames (RFC 5987) and percent-encodes other non-ASCII values.
      const { setSafeHeader } = require('../utils/safeHeaders');
      for (const [key, value] of Object.entries(headers)) {
        setSafeHeader(res, key, value as string);
      }

      // Stream the file
      const fsMod = require('fs');
      if (!fsMod.existsSync(fileDownload.filePath)) {
        return res.status(404).json({ success: false, error: 'Generated file is no longer on disk' });
      }
      const fileStream = fsMod.createReadStream(fileDownload.filePath);
      fileStream.on('error', (err: Error) => {
        console.error('Error streaming public API file:', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read file' });
        else res.destroy();
      });
      return fileStream.pipe(res);
    }

    // For deployed APIs: return result.data directly without wrapper
    // to match the OpenAPI spec response schema exactly
    if (rawOutput && result.success && result.data) {
      return res.status(result.data.statusCode || 200).json(result.data.body || result.data);
    }

    return res.status(result.success ? 200 : 500).json({
      success: result.success,
      data: result.data,
      meta: {
        operationId,
        projectCode: api.projectCode,
        basePath: api.basePath,
        executedAt: new Date().toISOString(),
        executionTime: `${Date.now() - startTime}ms`,
        auth: req.apiKey ? { type: req.apiKey.type, scopes: req.apiKey.scopes } : null,
      },
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// Deployed API Router
// Handles requests at deployed publicUrl paths (e.g., /int/partner API/v1/...)
// These are separate from the /deh/{project}/public/... public routes
// ============================================================

export const deployedApiRouter = Router();

// Deployed API handler - matches requests against deployedUrlCache
deployedApiRouter.all('*', async (req: Request, res: Response, next: NextFunction) => {
  const fullPath = req.path;

  // Quick check: find matching deployed URL prefix
  // Sort by length (longest first) for greedy matching
  const sortedEntries = Array.from(apiService.getDeployedUrlCache().entries())
    .sort((a, b) => b[0].length - a[0].length);

  let matchedApi: ApiMapping | null = null;
  let operationPath: string = '';

  for (const [publicUrl, api] of sortedEntries) {
    if (fullPath === publicUrl || fullPath.startsWith(publicUrl + '/')) {
      matchedApi = api;
      operationPath = fullPath.slice(publicUrl.length) || '/';
      break;
    }
  }

  if (!matchedApi) {
    return next(); // Not a deployed API URL, pass through
  }

  // Authenticate using DB API key middleware
  authenticateApiKey(req, res, async () => {
    const method = req.method.toUpperCase();
    return handleApiRequest(matchedApi!, operationPath, method, req, res, { rawOutput: true });
  });
});

export default router;
