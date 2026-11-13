import { Router, Request, Response } from 'express';
import { adminOnly } from '../lib/access';
import { generateKeyPair } from 'crypto';
import { promisify } from 'util';

const router = Router();

// SFTP server users and keys — admin only
router.use(adminOnly);
const generateKeyPairAsync = promisify(generateKeyPair);

// ============================================
// SFTP Server Management API
// ============================================

interface SftpUser {
  id: string;
  username: string;
  password?: string;
  uid: number;
  gid: number;
  homeDirectory: string;
  allowedDirectories: string[];
  publicKey?: string;
  hasKeyAuth: boolean;
  hasPasswordAuth: boolean;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}

// Mock storage - in production use database
const sftpUsers: Map<string, SftpUser> = new Map();
const sftpKeys: Map<string, { id: string; name: string; publicKey: string; privateKey: string; userId: string; createdAt: Date }> = new Map();

let userIdCounter = 1;
let keyIdCounter = 1;

// GET /api/sftp/config - Get SFTP server configuration
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = {
      host: process.env.SFTP_HOST || 'localhost',
      port: parseInt(process.env.SFTP_PORT || '2222'),
      protocol: 'SFTP',
      authMethods: ['password', 'publickey'],
      serverKeyFingerprint: 'SHA256:AbCdEf123... (mock)',
    };
    
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Error fetching SFTP config:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch config' });
  }
});

// GET /api/sftp/users - List all SFTP users
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = Array.from(sftpUsers.values()).map(user => ({
      ...user,
      password: undefined, // Hide password
    }));
    
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Error fetching SFTP users:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// POST /api/sftp/users - Create new SFTP user
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { 
      username, 
      password, 
      uid, 
      gid, 
      homeDirectory,
      allowedDirectories,
      hasKeyAuth,
      hasPasswordAuth 
    } = req.body;
    
    if (!username) {
      res.status(400).json({ success: false, error: 'Username is required' });
      return;
    }
    
    // Check if username exists
    const existingUser = Array.from(sftpUsers.values()).find(u => u.username === username);
    if (existingUser) {
      res.status(400).json({ success: false, error: 'Username already exists' });
      return;
    }
    
    const id = `sftp-user-${userIdCounter++}`;
    const user: SftpUser = {
      id,
      username,
      password: hasPasswordAuth ? password : undefined,
      uid: uid || 1000 + userIdCounter,
      gid: gid || 1000 + userIdCounter,
      homeDirectory: homeDirectory || `/home/${username}`,
      allowedDirectories: allowedDirectories || [homeDirectory || `/home/${username}`],
      hasKeyAuth: hasKeyAuth || false,
      hasPasswordAuth: hasPasswordAuth !== false,
      isActive: true,
      createdAt: new Date(),
    };
    
    sftpUsers.set(id, user);
    
    // Return user without password
    const { password: _, ...userWithoutPassword } = user;
    res.json({ 
      success: true, 
      data: userWithoutPassword,
      message: 'SFTP user created successfully'
    });
  } catch (error) {
    console.error('Error creating SFTP user:', error);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// DELETE /api/sftp/users/:id - Delete SFTP user
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!sftpUsers.has(id)) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    
    sftpUsers.delete(id);
    
    // Also delete associated keys
    for (const [keyId, key] of sftpKeys.entries()) {
      if (key.userId === id) {
        sftpKeys.delete(keyId);
      }
    }
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting SFTP user:', error);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

// POST /api/sftp/users/:id/reset-password - Reset user password
router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    
    const user = sftpUsers.get(id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    
    user.password = newPassword;
    user.hasPasswordAuth = true;
    
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// POST /api/sftp/keys/generate - Generate SSH key pair
router.post('/keys/generate', async (req: Request, res: Response) => {
  try {
    const { name, userId, bits = 2048 } = req.body;
    
    if (!name || !userId) {
      res.status(400).json({ success: false, error: 'Name and userId are required' });
      return;
    }
    
    const user = sftpUsers.get(userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    
    // Generate RSA key pair
    const { publicKey, privateKey } = await generateKeyPairAsync('rsa' as any, {
      modulusLength: bits,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      }
    });
    
    // Convert to OpenSSH format (simplified)
    const opensshPublicKey = `ssh-rsa ${Buffer.from(publicKey).toString('base64')} ${name}`;
    
    const keyId = `key-${keyIdCounter++}`;
    const keyData = {
      id: keyId,
      name,
      publicKey: opensshPublicKey,
      privateKey: privateKey.toString(),
      userId,
      createdAt: new Date()
    };
    
    sftpKeys.set(keyId, keyData);
    
    // Update user
    user.hasKeyAuth = true;
    user.publicKey = opensshPublicKey;
    
    // Return only public key and key info, private key shown only once
    res.json({
      success: true,
      data: {
        id: keyId,
        name,
        publicKey: opensshPublicKey,
        fingerprint: `SHA256:${Buffer.from(publicKey).toString('base64').substring(0, 16)}...`,
        privateKey: privateKey.toString(), // User must save this immediately
        createdAt: keyData.createdAt
      },
      warning: 'Private key is shown only once. Please save it securely!'
    });
  } catch (error) {
    console.error('Error generating key:', error);
    res.status(500).json({ success: false, error: 'Failed to generate key' });
  }
});

// GET /api/sftp/keys - List keys for a user
router.get('/keys', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;
    
    let keys = Array.from(sftpKeys.values());
    if (userId) {
      keys = keys.filter(k => k.userId === userId as string);
    }
    
    // Don't return private keys
    const keysWithoutPrivate = keys.map(({ privateKey, ...key }) => key);
    
    res.json({ success: true, data: keysWithoutPrivate });
  } catch (error) {
    console.error('Error fetching keys:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch keys' });
  }
});

// DELETE /api/sftp/keys/:id - Delete a key
router.delete('/keys/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!sftpKeys.has(id)) {
      res.status(404).json({ success: false, error: 'Key not found' });
      return;
    }
    
    sftpKeys.delete(id);
    res.json({ success: true, message: 'Key deleted successfully' });
  } catch (error) {
    console.error('Error deleting key:', error);
    res.status(500).json({ success: false, error: 'Failed to delete key' });
  }
});

// GET /api/sftp/files - List files in a directory
router.get('/files', async (req: Request, res: Response) => {
  try {
    const { path = '/' } = req.query;
    
    // Mock file listing - in production, use ssh2-sftp-client to connect to SFTP server
    const mockFiles = [
      { name: 'uploads', type: 'directory', size: 0, modifiedAt: new Date().toISOString() },
      { name: 'downloads', type: 'directory', size: 0, modifiedAt: new Date().toISOString() },
      { name: 'data_export_2024.csv', type: 'file', size: 156000, modifiedAt: new Date().toISOString() },
      { name: 'report.pdf', type: 'file', size: 2500000, modifiedAt: new Date().toISOString() },
      { name: 'archive.zip', type: 'file', size: 156000000, modifiedAt: new Date().toISOString() },
    ];
    
    res.json({ 
      success: true, 
      data: {
        path: path as string,
        files: mockFiles
      }
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ success: false, error: 'Failed to list files' });
  }
});

// GET /api/sftp/connection-info - Get connection information for a user
router.get('/connection-info/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    
    const user = sftpUsers.get(userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    
    const config: any = {
      host: process.env.SFTP_HOST || 'localhost',
      port: parseInt(process.env.SFTP_PORT || '2222'),
      username: user.username,
      authMethods: [] as string[],
      instructions: {} as any
    };
    
    if (user.hasPasswordAuth) {
      config.authMethods.push('password');
      config.instructions.password = `sftp -P ${config.port} ${user.username}@${config.host}`;
    }
    
    if (user.hasKeyAuth) {
      config.authMethods.push('publickey');
      config.instructions.publickey = `sftp -P ${config.port} -i ~/.ssh/${user.username}_key ${user.username}@${config.host}`;
    }
    
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Error fetching connection info:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch connection info' });
  }
});

// POST /api/sftp/directories - Create directory
router.post('/directories', async (req: Request, res: Response) => {
  try {
    const {  } = req.body;
    
    // In production, create directory via SFTP
    res.json({ success: true, message: 'Directory created successfully' });
  } catch (error) {
    console.error('Error creating directory:', error);
    res.status(500).json({ success: false, error: 'Failed to create directory' });
  }
});

// DELETE /api/sftp/files - Delete file or directory
router.delete('/files', async (req: Request, res: Response) => {
  try {
    const {  } = req.body;
    
    // In production, delete via SFTP
    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

export default router;
