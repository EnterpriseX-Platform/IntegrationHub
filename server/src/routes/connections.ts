import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponseWrapper, Connection } from '../types';
import axios from 'axios';
import { Client as SSHClient } from 'ssh2';
import * as oracledb from 'oracledb';
import { Client as PgClient } from 'pg';
import { normalizePrivateKey } from '../lib/ppk-converter';
import { maskConfig, mergeSecrets } from '../lib/connectionSecrets';
import { guardProjects, projectRole, roleAllows, adminOnly } from '../lib/access';
import nodemailer from 'nodemailer';

const router = Router();

// Connections hold secrets: non-admins need editor on the connection's project.
// App-level connections (no project) are admin only.
router.param('id', guardProjects(async (id) => {
  const c = await prisma.connection.findUnique({ where: { id }, select: { projectId: true } });
  return c ? (c.projectId ? [c.projectId] : []) : null;
}, 'editor'));

// Helper function to test database connection
async function testDatabaseConnection(config: any): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const startTime = Date.now();
  
  try {
    // Test based on database type
    switch (config.type) {
      case 'sqlite':
        // Test SQLite by trying to query with Prisma
        await prisma.$queryRaw`SELECT 1`;
        return {
          success: true,
          latency: Date.now() - startTime,
          message: 'SQLite connection successful',
        };
        
      case 'oracle':
        return await testOracleConnection(config, startTime);
        
      case 'postgresql':
      case 'postgres':
        return await testPostgresConnection(config, startTime);
        
      case 'mysql':
        return {
          success: false,
          latency: Date.now() - startTime,
          message: 'MySQL test not implemented',
          error: 'MySQL driver not installed. Please install mysql2 package.',
        };
        
      default:
        return {
          success: false,
          latency: Date.now() - startTime,
          message: `Unsupported database type: ${config.type}`,
          error: `Database type '${config.type}' is not supported for connection testing`,
        };
    }
  } catch (error) {
    return {
      success: false,
      latency: Date.now() - startTime,
      message: 'Database connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Test Oracle connection with timeout
async function testOracleConnection(config: any, startTime: number): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  let connection: oracledb.Connection | undefined;
  
  // Create timeout promise (5 seconds)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Connection timeout after 5 seconds')), 5000);
  });
  
  try {
    // Build connection string
    const connectString = config.database 
      ? `${config.host}:${config.port || 1521}/${config.database}`
      : `${config.host}:${config.port || 1521}`;
    
    // Race between connection and timeout
    connection = await Promise.race([
      oracledb.getConnection({
        user: config.username,
        password: config.password,
        connectString: connectString,
      }),
      timeoutPromise
    ]);
    
    // Test with simple query (also with timeout)
    const queryPromise = connection.execute('SELECT 1 FROM DUAL');
    await Promise.race([
      queryPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 3000))
    ]);
    
    return {
      success: true,
      latency: Date.now() - startTime,
      message: `Oracle connection successful (${config.host}:${config.port || 1521})`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    
    // Show actual Oracle error message to user
    // Common Oracle errors:
    // ORA-12170: TNS:Connect timeout occurred (network issue)
    // ORA-1017: Invalid username/password
    // ORA-12541: TNS:No listener
    // ORA-12543: TNS:destination host unreachable
    
    return {
      success: false,
      latency: Date.now() - startTime,
      message: `Oracle: ${errorMsg}`,
      error: errorMsg,
    };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

// Test PostgreSQL connection
async function testPostgresConnection(config: any, startTime: number): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const client = new PgClient({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.username,
    password: config.password,
    connectionTimeoutMillis: 10000,
  });
  
  try {
    await client.connect();
    await client.query('SELECT 1');
    
    return {
      success: true,
      latency: Date.now() - startTime,
      message: `PostgreSQL connection successful (${config.host}:${config.port || 5432})`,
    };
  } catch (error) {
    return {
      success: false,
      latency: Date.now() - startTime,
      message: 'PostgreSQL connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    try {
      await client.end();
    } catch (e) {
      // Ignore close errors
    }
  }
}

// Helper function to test SFTP connection
async function testSFTPConnection(config: any): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const conn = new SSHClient();
    const timeout = setTimeout(() => {
      conn.end();
      resolve({
        success: false,
        latency: Date.now() - startTime,
        message: 'SFTP connection timeout',
        error: 'Connection timed out after 10 seconds',
      });
    }, 10000);
    
    conn.on('ready', () => {
      clearTimeout(timeout);
      console.log(`[SFTP Test] Connected successfully to ${config.host}:${config.port || 22} as ${config.username}`);
      conn.end();
      resolve({
        success: true,
        latency: Date.now() - startTime,
        message: 'SFTP connection successful',
      });
    });
    
    conn.on('error', (err: any) => {
      clearTimeout(timeout);
      console.error(`[SFTP Test] Connection failed to ${config.host}:${config.port || 22} as ${config.username}`);
      console.error(`[SFTP Test] Error: ${err.message}`);
      console.error(`[SFTP Test] Level: ${err.level || 'unknown'}`);
      console.error(`[SFTP Test] Auth type: ${config.authType}`);
      if (config.authType === 'private-key') {
        console.error(`[SFTP Test] Private key: ${config.privateKey ? `present (${config.privateKey.length} chars)` : 'MISSING'}`);
      }
      resolve({
        success: false,
        latency: Date.now() - startTime,
        message: 'SFTP connection failed',
        error: err.message,
      });
    });

    try {
      const connectConfig: any = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        ...(config.authType === 'password' ? { password: config.password } : {}),
        ...(config.authType === 'private-key' ? {
          privateKey: normalizePrivateKey(config.privateKey),
          passphrase: config.passphrase,
        } : {}),
        readyTimeout: 10000,
      };
      console.log(`[SFTP Test] Connecting to ${connectConfig.host}:${connectConfig.port} as ${connectConfig.username} (auth: ${config.authType})`);
      conn.connect(connectConfig);
    } catch (err) {
      clearTimeout(timeout);
      console.error(`[SFTP Test] Exception:`, err instanceof Error ? err.message : err);
      resolve({
        success: false,
        latency: Date.now() - startTime,
        message: 'SFTP connection failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });
}

// Helper function to test an SMTP connection: connect, STARTTLS/TLS, authenticate. Sends nothing.
async function testSMTPConnection(config: any): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const startTime = Date.now();
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: Number(config.port) || 587,
      secure: config.secure === true || config.secure === 'true' || Number(config.port) === 465,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      tls: config.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
      // Some relays (some) take 20+ s to greet
      connectionTimeout: 45000,
      greetingTimeout: 45000,
    });
    await transporter.verify();
    return { success: true, latency: Date.now() - startTime, message: 'SMTP connection successful' };
  } catch (err: any) {
    return { success: false, latency: Date.now() - startTime, message: 'SMTP connection failed', error: err?.message || String(err) };
  }
}

// Helper function to test HTTP connection
async function testHTTPConnection(config: any): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const startTime = Date.now();
  
  try {
    const url = config.baseUrl;
    const headers: Record<string, string> = { ...(config.headers || {}) };
    
    // Add auth headers based on auth type
    if (config.authType === 'bearer' && config.auth?.token) {
      headers['Authorization'] = `Bearer ${config.auth.token}`;
    } else if (config.authType === 'api-key' && config.auth?.apiKey) {
      headers[config.auth.apiKeyHeader || 'X-API-Key'] = config.auth.apiKey;
    } else if (config.authType === 'basic' && config.auth?.username) {
      const auth = Buffer.from(`${config.auth.username}:${config.auth.password || ''}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }
    
    const response = await axios.get(url, {
      headers,
      timeout: config.timeout || 30000,
      validateStatus: () => true, // Don't throw on error status
    });
    
    const latency = Date.now() - startTime;
    
    if (response.status >= 200 && response.status < 400) {
      return {
        success: true,
        latency,
        message: `HTTP ${response.status}: Connection successful`,
      };
    } else {
      return {
        success: false,
        latency,
        message: `HTTP ${response.status}: ${response.statusText}`,
        error: `Server returned status ${response.status}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      latency: Date.now() - startTime,
      message: 'HTTP connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Helper function to test Google Drive connection
async function testGoogleDriveConnection(config: any): Promise<{ success: boolean; latency: number; message: string; error?: string }> {
  const startTime = Date.now();
  
  try {
    // For now, simulate the test as we would need googleapis library
    // In production, this would use the googleapis library to test the connection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const authType = config.authType || 'unknown';
    
    if (authType === 'oauth2') {
      if (!config.clientId) {
        return {
          success: false,
          latency: Date.now() - startTime,
          message: 'OAuth2 configuration incomplete',
          error: 'Client ID is required for OAuth2 authentication',
        };
      }
      return {
        success: true,
        latency: Date.now() - startTime,
        message: 'Google Drive OAuth2 configuration validated (token generation required)',
      };
    } else if (authType === 'service-account') {
      if (!config.serviceAccountKey) {
        return {
          success: false,
          latency: Date.now() - startTime,
          message: 'Service Account configuration incomplete',
          error: 'Service Account JSON key is required',
        };
      }
      // Try to parse the service account key
      try {
        const keyData = JSON.parse(config.serviceAccountKey);
        if (!keyData.client_email || !keyData.private_key) {
          return {
            success: false,
            latency: Date.now() - startTime,
            message: 'Invalid Service Account key',
            error: 'Service Account key must contain client_email and private_key',
          };
        }
        return {
          success: true,
          latency: Date.now() - startTime,
          message: `Service Account validated: ${keyData.client_email}`,
        };
      } catch (e) {
        return {
          success: false,
          latency: Date.now() - startTime,
          message: 'Invalid Service Account key format',
          error: 'Service Account key must be valid JSON',
        };
      }
    }
    
    return {
      success: false,
      latency: Date.now() - startTime,
      message: 'Unknown authentication type',
      error: `Authentication type '${authType}' is not supported`,
    };
  } catch (error) {
    return {
      success: false,
      latency: Date.now() - startTime,
      message: 'Google Drive connection test failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// GET /api/connections/:id/test - Test connection and save result
router.get('/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const connection = await prisma.connection.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!connection) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Connection not found',
      };
      return res.status(404).json(response);
    }

    // Parse config
    let config: any = {};
    try {
      config = typeof connection.config === 'string' 
        ? JSON.parse(connection.config) 
        : connection.config;
    } catch (e) {
      config = {};
    }

    // Test connection based on type
    let testResult: { success: boolean; latency: number; message: string; error?: string };
    
    if (connection.type === 'database') {
      testResult = await testDatabaseConnection(config);
    } else if (connection.type === 'sftp') {
      testResult = await testSFTPConnection(config);
    } else if (connection.type === 'smtp') {
      testResult = await testSMTPConnection(config);
    } else if (connection.type === 'http' || connection.type === 'rest-api') {
      testResult = await testHTTPConnection(config);
    } else if (connection.type === 'google-drive') {
      testResult = await testGoogleDriveConnection(config);
    } else {
      // Fallback for other types
      await new Promise(resolve => setTimeout(resolve, 500));
      testResult = {
        success: true,
        latency: 500,
        message: 'Connection test simulated',
      };
    }

    // Update connection status in database
    const updatedConnection = await prisma.connection.update({
      where: { id },
      data: {
        status: testResult.success ? 'Connected' : 'Error',
      },
    });

    // SECURITY: never echo `config` back — it holds cleartext secrets (SFTP/DB
    // passwords, API keys, private keys). The test response only needs the
    // connection identity + updated status, not credentials.
    const { config: _omitConfig, ...connectionSafe } = updatedConnection as any;

    const response: ApiResponseWrapper<{
      connection: Connection;
      testResult: { success: boolean; latency: string; message: string; error?: string };
    }> = {
      success: testResult.success,
      data: {
        connection: {
          ...connectionSafe,
          createdAt: updatedConnection.createdAt.toISOString(),
        } as unknown as Connection,
        testResult: {
          success: testResult.success,
          latency: `${testResult.latency}ms`,
          message: testResult.message,
          error: testResult.error,
        },
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error testing connection:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to test connection',
    };
    return res.status(500).json(response);
  }
});

// POST /api/connections - Create new connection
router.post('/', async (req: Request, res: Response) => {
  try {
    const { projectId, name, type, config } = req.body;
    if (projectId && !roleAllows(await projectRole(req, projectId), 'editor')) {
      return res.status(403).json({ success: false, error: 'You do not have access to this project' });
    }

    // Validate required fields
    if (!projectId || !name || !type) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project ID, name, and type are required',
      };
      return res.status(400).json(response);
    }

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    // Create connection
    const newConnection = await prisma.connection.create({
      data: {
        projectId,
        name,
        type,
        config: JSON.stringify(config || {}),
        status: 'Disconnected',
      },
    });

    const response: ApiResponseWrapper<Connection> = {
      success: true,
      data: { ...newConnection, config: maskConfig(newConnection.config) } as unknown as Connection,
      message: 'Connection created successfully',
    };
    return res.status(201).json(response);
  } catch (error) {
    console.error('Error creating connection:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to create connection',
    };
    return res.status(500).json(response);
  }
});

// PUT /api/connections/:id - Update connection
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, status, config } = req.body;

    // Check if connection exists
    const existingConnection = await prisma.connection.findUnique({
      where: { id },
    });

    if (!existingConnection) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Connection not found',
      };
      return res.status(404).json(response);
    }

    // Preserve existing secrets when the incoming config leaves them blank
    // (the edit form sends "" for unchanged passwords/keys, since we mask them).
    const mergedConfig = config !== undefined
      ? JSON.stringify(mergeSecrets(config, existingConnection.config))
      : undefined;

    const updatedConnection = await prisma.connection.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(type && { type }),
        ...(status && { status }),
        ...(mergedConfig !== undefined && { config: mergedConfig }),
      },
    });

    const response: ApiResponseWrapper<Connection> = {
      success: true,
      data: { ...updatedConnection, config: maskConfig(updatedConnection.config) } as unknown as Connection,
      message: 'Connection updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating connection:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update connection',
    };
    return res.status(500).json(response);
  }
});

// DELETE /api/connections/:id - Delete connection
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if connection exists
    const existingConnection = await prisma.connection.findUnique({
      where: { id },
    });

    if (!existingConnection) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Connection not found',
      };
      return res.status(404).json(response);
    }

    // Delete connection
    await prisma.connection.delete({
      where: { id },
    });

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Connection deleted successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error deleting connection:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to delete connection',
    };
    return res.status(500).json(response);
  }
});

// POST /api/connections/position - Update connection positions
router.post('/position', adminOnly, async (req: Request, res: Response) => {
  try {
    const { positions } = req.body;

    if (!Array.isArray(positions) || positions.length === 0) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Positions array is required',
      };
      return res.status(400).json(response);
    }

    // Update positions in transaction
    await prisma.$transaction(
      positions.map((item: { connectionId: string; position: number }) =>
        prisma.connection.update({
          where: { id: item.connectionId },
          data: { displayOrder: item.position },
        })
      )
    );

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Connection positions updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating connection positions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update connection positions',
    };
    return res.status(500).json(response);
  }
});

export default router;
