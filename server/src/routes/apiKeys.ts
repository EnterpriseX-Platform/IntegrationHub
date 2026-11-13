import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import archiver from 'archiver';
import { prisma } from '../lib/prisma';
import { generateApiKey } from '../middleware/auth';
import { normalizeRsaPublicKey, normalizeRsaPrivateKey, rsaKeysMatch } from '../lib/rsaKeys';

// Register zip-encryptable format for password-protected ZIP export
archiver.registerFormat('zip-encryptable', require('archiver-zip-encryptable'));

const router = Router();

// GET /api/projects/:projectId/api-keys - List all API keys for a project
router.get('/projects/:projectId/api-keys', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    const apiKeys = await prisma.apiKey.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        key: true,
        type: true,
        isActive: true,
        scopes: true,
        validateIp: true,
        ipWhitelist: true,
        rateLimit: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        keyCategory: true,
        algorithm: true,
        publicKey: true,
        keyFormat: true,
        description: true,
        // Don't return secretKey for security
      },
    });

    return res.json({
      success: true,
      data: apiKeys,
    });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch API keys',
    });
  }
});

// GET /api/projects/:projectId/api-keys/:id/audit-logs - Get audit logs for an API key
router.get('/projects/:projectId/api-keys/:id/audit-logs', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100); // Max 100 per page
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const skip = (page - 1) * limit;

    // Verify the key belongs to this project
    const apiKey = await prisma.apiKey.findFirst({
      where: { id, projectId },
    });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'API key not found',
      });
    }

    // Get total count for pagination
    const total = await prisma.apiKeyAuditLog.count({
      where: { apiKeyId: id },
    });

    const logs = await prisma.apiKeyAuditLog.findMany({
      where: { apiKeyId: id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });

    return res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch audit logs',
    });
  }
});

// POST /api/projects/:projectId/api-keys - Create a new API key
router.post('/projects/:projectId/api-keys', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const {
      name,
      type = 'client', // client, server, webhook, service
      scopes = ['read'],
      expiresAt,
      validateIp = false,
      ipWhitelist = [],
      ipBlacklist = [],
      rateLimit,
      allowedPaths = [],
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Name is required',
      });
    }

    // Validate type
    const validTypes = ['client', 'server', 'webhook', 'service'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    // Generate key based on type
    const { key, secret } = generateApiKey(type);

    const apiKey = await prisma.apiKey.create({
      data: {
        projectId,
        name,
        key,
        type,
        secretKey: secret || null,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        validateIp,
        ipWhitelist,
        ipBlacklist,
        rateLimit,
        allowedPaths,
      },
    });

    // Return the key with secret (only shown once on creation)
    return res.json({
      success: true,
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key,
        secretKey: secret, // Only shown once!
        type: apiKey.type,
        scopes: apiKey.scopes,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
      message: secret 
        ? 'IMPORTANT: Store the secret key securely. It will not be shown again.'
        : undefined,
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create API key',
    });
  }
});

// PUT /api/projects/:projectId/api-keys/:id - Update API key settings
router.put('/projects/:projectId/api-keys/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const {
      name,
      isActive,
      scopes,
      validateIp,
      ipWhitelist,
      ipBlacklist,
      rateLimit,
      allowedPaths,
    } = req.body;

    const apiKey = await prisma.apiKey.update({
      where: { id, projectId },
      data: {
        ...(name !== undefined && { name }),
        ...(isActive !== undefined && { isActive }),
        ...(scopes !== undefined && { scopes }),
        ...(validateIp !== undefined && { validateIp }),
        ...(ipWhitelist !== undefined && { ipWhitelist }),
        ...(ipBlacklist !== undefined && { ipBlacklist }),
        ...(rateLimit !== undefined && { rateLimit }),
        ...(allowedPaths !== undefined && { allowedPaths }),
      },
    });

    return res.json({
      success: true,
      data: apiKey,
    });
  } catch (error) {
    console.error('Error updating API key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update API key',
    });
  }
});

// DELETE /api/projects/:projectId/api-keys/:id - Delete an API key
router.delete('/projects/:projectId/api-keys/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;

    await prisma.apiKey.delete({
      where: { id, projectId },
    });

    return res.json({
      success: true,
      message: 'API key deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting API key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete API key',
    });
  }
});

// POST /api/projects/:projectId/api-keys/:id/regenerate - Regenerate secret key (server keys only)
router.post('/projects/:projectId/api-keys/:id/regenerate', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;

    const existingKey = await prisma.apiKey.findFirst({
      where: { id, projectId },
    });

    if (!existingKey) {
      return res.status(404).json({
        success: false,
        error: 'API key not found',
      });
    }

    if (existingKey.type !== 'server' && existingKey.type !== 'webhook') {
      return res.status(400).json({
        success: false,
        error: 'Only server or webhook keys can regenerate secrets',
      });
    }

    // Generate new secret
    const { secret } = generateApiKey(existingKey.type as any);

    const updatedKey = await prisma.apiKey.update({
      where: { id },
      data: { secretKey: secret },
    });

    return res.json({
      success: true,
      data: {
        id: updatedKey.id,
        secretKey: secret, // Only shown once!
      },
      message: 'Secret key regenerated. Store it securely - it will not be shown again.',
    });
  } catch (error) {
    console.error('Error regenerating secret:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to regenerate secret key',
    });
  }
});

// GET /api/projects/:projectId/secrets - List all secrets (API keys + encryption keys)
router.get('/projects/:projectId/secrets', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    const secrets = await prisma.apiKey.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        key: true,
        type: true,
        isActive: true,
        scopes: true,
        validateIp: true,
        ipWhitelist: true,
        rateLimit: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        keyCategory: true,
        algorithm: true,
        publicKey: true,
        keyFormat: true,
        description: true,
        secretKey: true, // Fetched to derive hasPrivateKey, not exposed directly
      },
    });

    // Transform: replace secretKey with hasPrivateKey indicator (never expose raw private key)
    const safeSecrets = secrets.map(({ secretKey, ...rest }) => ({
      ...rest,
      hasPrivateKey: !!(secretKey && secretKey.length > 0),
    }));

    return res.json({
      success: true,
      data: safeSecrets,
    });
  } catch (error) {
    console.error('Error fetching secrets:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch secrets',
    });
  }
});

// POST /api/projects/:projectId/secrets/generate-keypair - Generate PGP or RSA key pair
router.post('/projects/:projectId/secrets/generate-keypair', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { name, algorithm, passphrase, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Name is required',
      });
    }

    const validAlgorithms = ['pgp', 'rsa', 'rsa-direct', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc'];
    if (!algorithm || !validAlgorithms.includes(algorithm)) {
      return res.status(400).json({
        success: false,
        error: `Algorithm must be one of: ${validAlgorithms.join(', ')}`,
      });
    }

    const { keySize = 4096 } = req.body;
    const validKeySizes = [2048, 3072, 4096];
    const rsaBits = validKeySizes.includes(keySize) ? keySize : 4096;

    let publicKey: string;
    let privateKey: string;
    let keyFormat: string;

    if (algorithm === 'pgp') {
      const openpgp = await import('openpgp');
      const keyPair = await openpgp.generateKey({
        type: 'rsa',
        rsaBits,
        userIDs: [{ name: name, email: `${name.toLowerCase().replace(/\s/g, '-')}@example.com` }],
        passphrase: passphrase || '',
      });
      publicKey = keyPair.publicKey;
      privateKey = keyPair.privateKey;
      keyFormat = 'armored';
    } else if (algorithm === 'rsa') {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: rsaBits,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        // Stored unencrypted: flows decrypt unattended and have no passphrase to give
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      publicKey = keyPair.publicKey;
      privateKey = keyPair.privateKey;
      keyFormat = 'pem';
    } else {
      // AES - derive key from password using PBKDF2
      if (!passphrase) {
        return res.status(400).json({ success: false, error: 'Passphrase is required for AES key generation' });
      }
      const validAesKeySizes = [128, 192, 256];
      const aesKeyBits = validAesKeySizes.includes(keySize) ? keySize : 256;
      const aesKeyBytes = aesKeyBits / 8; // 16, 24, or 32 bytes
      const salt = crypto.randomBytes(32);
      const iterations = 100000;
      const derivedKey = crypto.pbkdf2Sync(passphrase, salt, iterations, aesKeyBytes, 'sha256');
      // publicKey: base64 of derived key (used by encrypt executor)
      // secretKey/privateKey: JSON with salt + key for re-derivation if needed
      publicKey = derivedKey.toString('base64');
      privateKey = JSON.stringify({
        salt: salt.toString('hex'),
        key: derivedKey.toString('hex'),
        keyBase64: derivedKey.toString('base64'),
        iterations,
        digest: 'sha256',
      });
      keyFormat = 'derived';
    }

    // Generate a unique key identifier
    const keyIdentifier = 'enc_' + crypto.randomBytes(24).toString('hex');

    const apiKey = await prisma.apiKey.create({
      data: {
        projectId,
        name,
        key: keyIdentifier,
        type: 'service',
        keyCategory: 'encryption-key',
        algorithm,
        publicKey,
        secretKey: privateKey,
        keyFormat,
        description: description || null,
      },
    });

    return res.json({
      success: true,
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key,
        keyCategory: apiKey.keyCategory,
        algorithm: apiKey.algorithm,
        publicKey: apiKey.publicKey,
        keyFormat: apiKey.keyFormat,
        description: apiKey.description,
        createdAt: apiKey.createdAt,
        // Private key is NOT returned after creation
      },
      message: 'Key pair generated successfully. The private key is stored securely and will not be shown.',
    });
  } catch (error) {
    console.error('Error generating key pair:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate key pair',
    });
  }
});

// POST /api/projects/:projectId/secrets/import-key - Import external public key or symmetric key
const SUPPORTED_IMPORT_ALGORITHMS = ['pgp', 'rsa', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc'];
const AES_ALGORITHMS = ['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc'];
const AES_KEY_LENGTHS: Record<string, number> = {
  'aes-128-gcm': 16, 'aes-128-cbc': 16,
  'aes-192-gcm': 24, 'aes-192-cbc': 24,
  'aes-256-gcm': 32, 'aes-256-cbc': 32,
};

router.post('/projects/:projectId/secrets/import-key', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { name, algorithm, secretKey: rawSecretKey, passphrase, keyFormat: requestedFormat, description } = req.body;
    let { publicKey } = req.body;
    let secretKey: string | undefined = rawSecretKey;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Name is required',
      });
    }

    if (!algorithm || !SUPPORTED_IMPORT_ALGORITHMS.includes(algorithm)) {
      return res.status(400).json({
        success: false,
        error: `Algorithm must be one of: ${SUPPORTED_IMPORT_ALGORITHMS.join(', ')}`,
      });
    }

    if (!publicKey) {
      return res.status(400).json({
        success: false,
        error: AES_ALGORITHMS.includes(algorithm) ? 'Secret key is required' : 'Public key is required',
      });
    }

    const isAES = AES_ALGORITHMS.includes(algorithm);

    // Validate key format
    let detectedFormat: string;
    try {
      if (algorithm === 'pgp') {
        const openpgp = await import('openpgp');
        await openpgp.readKey({ armoredKey: publicKey });
        detectedFormat = 'armored';
        // Validate private key if provided
        if (secretKey) {
          await openpgp.readPrivateKey({ armoredKey: secretKey });
        }
      } else if (algorithm === 'rsa') {
        publicKey = normalizeRsaPublicKey(publicKey);
        detectedFormat = 'pem';
        if (secretKey) {
          secretKey = normalizeRsaPrivateKey(secretKey, passphrase);
          if (!rsaKeysMatch(publicKey, secretKey)) {
            throw new Error('Private key does not belong to this public key');
          }
        }
      } else {
        // AES - validate key length
        let keyBuf: Buffer;
        if (publicKey.startsWith('{')) {
          const parsed = JSON.parse(publicKey);
          if (parsed.keyBase64) keyBuf = Buffer.from(parsed.keyBase64, 'base64');
          else if (parsed.key) keyBuf = Buffer.from(parsed.key, 'hex');
          else throw new Error('JSON key format missing "key" or "keyBase64" field');
        } else {
          keyBuf = Buffer.from(publicKey, 'base64');
        }
        const expectedLen = AES_KEY_LENGTHS[algorithm];
        if (keyBuf.length !== expectedLen) {
          return res.status(400).json({
            success: false,
            error: `Invalid AES key length: expected ${expectedLen} bytes (${expectedLen * 8} bits), got ${keyBuf.length} bytes`,
          });
        }
        detectedFormat = 'base64';
      }
    } catch (parseError: any) {
      return res.status(400).json({
        success: false,
        error: isAES
          ? `Invalid AES secret key: ${parseError.message || 'must be base64 or JSON format'}`
          : `Invalid ${algorithm.toUpperCase()} key format: ${parseError.message || 'invalid format'}`,
      });
    }

    const keyIdentifier = 'enc_' + crypto.randomBytes(24).toString('hex');

    const apiKey = await prisma.apiKey.create({
      data: {
        projectId,
        name,
        key: keyIdentifier,
        type: 'service',
        keyCategory: 'encryption-key',
        algorithm,
        publicKey: publicKey,
        // AES symmetric: same key for both encrypt and decrypt
        // PGP/RSA: store private key if provided (for decryption)
        secretKey: isAES ? publicKey : (secretKey || undefined),
        keyFormat: requestedFormat || detectedFormat,
        description: description || null,
      },
    });

    return res.json({
      success: true,
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key,
        keyCategory: apiKey.keyCategory,
        algorithm: apiKey.algorithm,
        publicKey: isAES ? undefined : apiKey.publicKey,
        hasSecretKey: isAES ? undefined : !!apiKey.secretKey,
        keyFormat: apiKey.keyFormat,
        description: apiKey.description,
        createdAt: apiKey.createdAt,
      },
    });
  } catch (error) {
    console.error('Error importing key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to import key',
    });
  }
});

// PUT /api/projects/:projectId/secrets/:id/update-key - Update public/private key content
router.put('/projects/:projectId/secrets/:id/update-key', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    let { publicKey, secretKey } = req.body;
    const { passphrase } = req.body;

    const existing = await prisma.apiKey.findFirst({
      where: { id, projectId, keyCategory: 'encryption-key' },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Encryption key not found' });
    }

    const algorithm = existing.algorithm || 'pgp';
    const updateData: any = {};

    // Validate and update public key if provided
    if (publicKey) {
      try {
        if (algorithm === 'pgp') {
          const openpgp = await import('openpgp');
          await openpgp.readKey({ armoredKey: publicKey });
        } else if (algorithm === 'rsa') {
          publicKey = normalizeRsaPublicKey(publicKey);
        }
        updateData.publicKey = publicKey;
      } catch (err: any) {
        return res.status(400).json({ success: false, error: `Invalid ${algorithm.toUpperCase()} public key: ${err.message || 'invalid format'}` });
      }
    }

    // Validate and update private key if provided
    if (secretKey) {
      try {
        if (algorithm === 'pgp') {
          const openpgp = await import('openpgp');
          await openpgp.readPrivateKey({ armoredKey: secretKey });
        } else if (algorithm === 'rsa') {
          secretKey = normalizeRsaPrivateKey(secretKey, passphrase);
        }
        updateData.secretKey = secretKey;
      } catch (err: any) {
        return res.status(400).json({ success: false, error: `Invalid ${algorithm.toUpperCase()} private key: ${err.message || 'invalid format'}` });
      }
    }

    if (algorithm === 'rsa') {
      const pub = updateData.publicKey || existing.publicKey;
      const priv = updateData.secretKey || existing.secretKey;
      if (pub && priv && !/ENCRYPTED/.test(priv) && !rsaKeysMatch(pub, priv)) {
        return res.status(400).json({ success: false, error: 'Private key does not belong to the public key' });
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, error: 'No key data provided' });
    }

    await prisma.apiKey.update({
      where: { id },
      data: updateData,
    });

    return res.json({
      success: true,
      data: {
        id,
        hasPublicKey: !!(updateData.publicKey || existing.publicKey),
        hasSecretKey: !!(updateData.secretKey || existing.secretKey),
      },
    });
  } catch (error) {
    console.error('Error updating key:', error);
    return res.status(500).json({ success: false, error: 'Failed to update key' });
  }
});

// GET /api/projects/:projectId/secrets/:id/public-key - Download public key file
// Supports ?password=xxx to return password-protected ZIP
router.get('/projects/:projectId/secrets/:id/public-key', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const password = req.query.password as string | undefined;

    const apiKey = await prisma.apiKey.findFirst({
      where: { id, projectId, keyCategory: 'encryption-key' },
      select: {
        name: true,
        algorithm: true,
        publicKey: true,
        keyFormat: true,
      },
    });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'Encryption key not found',
      });
    }

    if (!apiKey.publicKey) {
      return res.status(404).json({
        success: false,
        error: 'No public key available for this entry',
      });
    }

    const safeName = apiKey.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const keyExt = apiKey.algorithm === 'pgp' ? 'asc' : 'pem';
    const keyFilename = `${safeName}-public.${keyExt}`;

    // If password provided, return password-protected ZIP
    if (password) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-public.zip"`);

      const archive = archiver('zip-encryptable' as any, {
        zlib: { level: 9 },
        forceLocalTime: true,
        password: password,
      } as any);

      archive.on('error', (err: Error) => {
        console.error('Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Failed to create ZIP' });
        }
      });

      archive.pipe(res);
      archive.append(Buffer.from(apiKey.publicKey, 'utf-8'), { name: keyFilename });
      await archive.finalize();
      return;
    }

    // Plain file download (no password)
    if (apiKey.algorithm === 'pgp') {
      res.setHeader('Content-Type', 'application/pgp-keys');
      res.setHeader('Content-Disposition', `attachment; filename="${keyFilename}"`);
    } else {
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', `attachment; filename="${keyFilename}"`);
    }

    return res.send(apiKey.publicKey);
  } catch (error) {
    console.error('Error downloading public key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to download public key',
    });
  }
});

// DELETE /api/projects/:projectId/secrets/:id - Delete an encryption key
router.delete('/projects/:projectId/secrets/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;

    await prisma.apiKey.delete({
      where: { id, projectId, keyCategory: 'encryption-key' },
    });

    return res.json({
      success: true,
      message: 'Encryption key deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting encryption key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete encryption key',
    });
  }
});

// PUT /api/projects/:projectId/secrets/:id - Update encryption key (toggle active)
router.put('/projects/:projectId/secrets/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const { isActive } = req.body;

    const updated = await prisma.apiKey.update({
      where: { id, projectId, keyCategory: 'encryption-key' },
      data: { isActive },
    });

    return res.json({
      success: true,
      data: {
        id: updated.id,
        isActive: updated.isActive,
      },
    });
  } catch (error) {
    console.error('Error updating encryption key:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update encryption key',
    });
  }
});

export default router;
