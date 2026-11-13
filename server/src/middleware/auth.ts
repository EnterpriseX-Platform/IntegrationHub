import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import crypto from 'crypto';

// Extend Express Request to include apiKey
declare global {
  namespace Express {
    interface Request {
      apiKey?: {
        id: string;
        projectId: string;
        type: string;
        scopes: string[];
        name: string;
      };
      authContext?: {
        method: 'bearer' | 'hmac' | 'none';
        validated: boolean;
        ip?: string;
      };
    }
  }
}

// Generate secure API key
export function generateApiKey(type: 'client' | 'server' | 'webhook' | 'service' = 'client'): { key: string; secret?: string } {
  const prefix = {
    client: 'apx_c',
    server: 'apx_s',
    webhook: 'apx_w',
    service: 'apx_svc',
  }[type];

  const key = prefix + '_' + crypto.randomBytes(32).toString('hex');
  
  // Generate secret key for server-side HMAC validation
  if (type === 'server' || type === 'webhook') {
    const secret = 'sk_' + crypto.randomBytes(32).toString('hex');
    return { key, secret };
  }

  return { key };
}

// Validate HMAC signature
function validateHmac(payload: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Check if IP is in whitelist/blacklist
function validateIpAddress(clientIp: string, whitelist: string[], blacklist: string[]): { valid: boolean; reason?: string } {
  // Check blacklist first
  if (blacklist.length > 0 && isIpMatch(clientIp, blacklist)) {
    return { valid: false, reason: 'IP_BLOCKED' };
  }

  // Check whitelist (if configured)
  if (whitelist.length > 0 && !isIpMatch(clientIp, whitelist)) {
    return { valid: false, reason: 'IP_NOT_ALLOWED' };
  }

  return { valid: true };
}

// Check if IP matches patterns (supports CIDR notation)
function isIpMatch(ip: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    // Exact match
    if (ip === pattern) return true;
    
    // CIDR notation (e.g., 192.168.1.0/24)
    if (pattern.includes('/')) {
      return isIpInCidr(ip, pattern);
    }
    
    // Wildcard (e.g., 192.168.1.*)
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '\\d+') + '$');
      return regex.test(ip);
    }
    
    return false;
  });
}

// Check if IP is in CIDR range
function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bits = '32'] = cidr.split('/');
  const mask = parseInt(bits, 10);
  
  const ipNum = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  const rangeNum = range.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  
  const maskBits = 0xFFFFFFFF << (32 - mask);
  
  return (ipNum & maskBits) === (rangeNum & maskBits);
}

// Get client IP from request
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

// Main authentication middleware
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientIp = getClientIp(req);
  
  // Extract API key from various sources
  let apiKeyValue: string | null = null;
  let authMethod: 'bearer' | 'hmac' | 'header' | 'query' = 'bearer';
  let hmacSignature: string | null = null;

  // 1. Check Authorization header (Bearer)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    apiKeyValue = authHeader.substring(7);
  }

  // 2. Check custom header (X-API-Key)
  if (!apiKeyValue && req.headers['x-api-key']) {
    apiKeyValue = req.headers['x-api-key'] as string;
    authMethod = 'header';
  }

  // 3. Check query parameter
  if (!apiKeyValue && req.query.apiKey) {
    apiKeyValue = req.query.apiKey as string;
    authMethod = 'query';
  }

  // 4. Check HMAC signature (server-to-server)
  const hmacHeader = req.headers['x-hmac-signature'] as string;
  const hmacKey = req.headers['x-api-key'] as string;
  if (hmacHeader && hmacKey) {
    apiKeyValue = hmacKey;
    hmacSignature = hmacHeader;
    authMethod = 'hmac';
  }

  // No API key found - allow anonymous (some flows may not require auth)
  if (!apiKeyValue) {
    req.authContext = { method: 'none', validated: false, ip: clientIp };
    return next();
  }

  try {
    // Find API key in database
    const apiKey = await prisma.apiKey.findUnique({
      where: { key: apiKeyValue },
      include: { project: true },
    });

    // Validate API key exists and is active
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'Invalid API key',
        code: 'INVALID_KEY',
      });
      return;
    }

    if (!apiKey.isActive) {
      await logApiKeyUsage(apiKey.id, 'authenticate', clientIp, req.headers['user-agent'] || null, false, 'KEY_INACTIVE');
      res.status(401).json({
        success: false,
        error: 'API key is inactive',
        code: 'KEY_INACTIVE',
      });
      return;
    }

    // Check expiration
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
      await logApiKeyUsage(apiKey.id, 'authenticate', clientIp, req.headers['user-agent'] || null, false, 'KEY_EXPIRED');
      res.status(401).json({
        success: false,
        error: 'API key has expired',
        code: 'KEY_EXPIRED',
      });
      return;
    }

    // Validate IP if required
    if (apiKey.validateIp) {
      const ipCheck = validateIpAddress(clientIp, apiKey.ipWhitelist, apiKey.ipBlacklist);
      if (!ipCheck.valid) {
        await logApiKeyUsage(apiKey.id, 'denied_ip', clientIp, req.headers['user-agent'] || null, false, ipCheck.reason || null);
        res.status(403).json({
          success: false,
          error: `Access denied from IP: ${clientIp}`,
          code: ipCheck.reason,
        });
        return;
      }
    }

    // Validate HMAC for server-side keys
    if (apiKey.type === 'server' || apiKey.type === 'webhook') {
      if (!apiKey.secretKey) {
        res.status(500).json({
          success: false,
          error: 'Server key not properly configured',
          code: 'CONFIG_ERROR',
        });
        return;
      }

      // If HMAC signature provided, validate it
      if (hmacSignature) {
        const payload = JSON.stringify(req.body) || '';
        const timestamp = req.headers['x-timestamp'] as string;
        const dataToSign = timestamp + ':' + payload;
        
        if (!validateHmac(dataToSign, hmacSignature, apiKey.secretKey)) {
          await logApiKeyUsage(apiKey.id, 'authenticate', clientIp, req.headers['user-agent'] || null, false, 'INVALID_HMAC');
          res.status(401).json({
            success: false,
            error: 'Invalid HMAC signature',
            code: 'INVALID_HMAC',
          });
          return;
        }

        // Check timestamp to prevent replay attacks (5 minute window)
        const ts = parseInt(timestamp, 10);
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - ts) > 300) {
          res.status(401).json({
            success: false,
            error: 'Request timestamp too old',
            code: 'TIMESTAMP_EXPIRED',
          });
          return;
        }
      }
    }

    // Check path restrictions
    if (apiKey.allowedPaths.length > 0) {
      const pathAllowed = apiKey.allowedPaths.some(allowed => 
        req.path.startsWith(allowed) || req.path.match(new RegExp(allowed))
      );
      if (!pathAllowed) {
        await logApiKeyUsage(apiKey.id, 'denied_scope', clientIp, req.headers['user-agent'] || null, false, 'PATH_NOT_ALLOWED');
        res.status(403).json({
          success: false,
          error: 'This API key cannot access this path',
          code: 'PATH_NOT_ALLOWED',
        });
        return;
      }
    }

    // Update last used
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });

    // Log successful authentication
    await logApiKeyUsage(apiKey.id, 'authenticate', clientIp, req.headers['user-agent'] || null, true, null, req.path);

    // Attach API key info to request
    req.apiKey = {
      id: apiKey.id,
      projectId: apiKey.projectId,
      type: apiKey.type,
      scopes: apiKey.scopes,
      name: apiKey.name,
    };

    req.authContext = {
      method: authMethod === 'query' || authMethod === 'header' ? 'bearer' : authMethod,
      validated: true,
      ip: clientIp,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
    });
  }
}

// Log API key usage
async function logApiKeyUsage(
  apiKeyId: string,
  action: string,
  ipAddress: string,
  userAgent: string | null,
  success: boolean,
  errorMessage: string | null,
  path?: string
): Promise<void> {
  try {
    await prisma.apiKeyAuditLog.create({
      data: {
        apiKeyId,
        action,
        ipAddress,
        userAgent,
        path: path || null,
        success,
        errorMessage,
      },
    });
  } catch (e) {
    console.error('Failed to log API key usage:', e);
  }
}

// Middleware to require specific scopes
export function requireScopes(...requiredScopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.apiKey) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const hasScope = requiredScopes.some(scope => 
      req.apiKey!.scopes.includes(scope) || req.apiKey!.scopes.includes('admin')
    );

    if (!hasScope) {
      res.status(403).json({
        success: false,
        error: `Required scope: ${requiredScopes.join(' or ')}`,
        code: 'INSUFFICIENT_SCOPE',
      });
      return;
    }

    next();
  };
}

// Middleware for flow-specific auth configuration
interface FlowAuthConfig {
  requireApiKey: boolean;
  validateIp?: boolean;
  allowedKeyTypes?: ('client' | 'server' | 'webhook' | 'service')[];
  requireHmac?: boolean;
}

export function flowAuth(config: FlowAuthConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // If API key is not required, skip
    if (!config.requireApiKey) {
      return next();
    }

    // Ensure API key is present
    if (!req.apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key required for this endpoint',
        code: 'API_KEY_REQUIRED',
      });
      return;
    }

    // Validate key type
    if (config.allowedKeyTypes && !config.allowedKeyTypes.includes(req.apiKey.type as any)) {
      res.status(403).json({
        success: false,
        error: `Key type '${req.apiKey.type}' not allowed for this endpoint`,
        allowedTypes: config.allowedKeyTypes,
        code: 'INVALID_KEY_TYPE',
      });
      return;
    }

    // Require HMAC for server keys
    if (config.requireHmac && req.apiKey.type === 'server') {
      if (req.authContext?.method !== 'hmac') {
        res.status(401).json({
          success: false,
          error: 'HMAC signature required for server keys',
          code: 'HMAC_REQUIRED',
        });
        return;
      }
    }

    next();
  };
}

// Helper to create HMAC signature (for client SDK)
export function createHmacSignature(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const dataToSign = ts + ':' + payload;
  return crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex');
}
