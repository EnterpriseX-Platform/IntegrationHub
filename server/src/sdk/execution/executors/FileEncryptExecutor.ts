// File Encrypt Executor - PGP/RSA/AES encryption for files

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { prisma } from '../../../lib/prisma';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pipeline } from 'stream/promises';

// RSA hybrid format magic bytes for validation
const RSA_HYBRID_MAGIC = Buffer.from('RSAH'); // 4 bytes magic
const RSA_HYBRID_VERSION = 1;

interface FileEncryptData {
  encryptionKeyId: string;
  source: 'input' | 'basket' | 'local';
  basketId?: string;
  filePattern?: string;
  localPath?: string;
  outputFileName?: string;
  outputDestination: 'temp' | 'basket';
  outputBasketId?: string;
  armor?: boolean;
}

export class FileEncryptExecutor extends NodeExecutor {
  readonly type = 'file-encrypt';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as FileEncryptData;

    if (!data.encryptionKeyId) {
      throw new Error('Encryption key ID is required');
    }

    // 1. Load encryption key from DB
    const keyRecord = await prisma.apiKey.findUnique({
      where: { id: data.encryptionKeyId },
    });

    if (!keyRecord) {
      throw new Error(`Encryption key not found: ${data.encryptionKeyId}`);
    }

    if (!keyRecord.publicKey) {
      throw new Error(`Public key not set for key: ${keyRecord.name}`);
    }

    const algorithm = keyRecord.algorithm || 'pgp';
    const publicKey = keyRecord.publicKey;
    const armor = data.armor !== false; // default true

    // 2. Resolve input files
    const files = await this.resolveInputFiles(data, context);

    if (files.length === 0) {
      throw new Error('No files found to encrypt');
    }

    // 3. Create temp output directory
    const tmpDir = `/tmp/encrypt-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    // 4. Encrypt each file
    const encryptedFiles: any[] = [];

    for (const file of files) {
      const fileName = path.basename(file.path);
      const outputName = this.resolveOutputFileName(data.outputFileName, fileName, algorithm, context);
      const outputPath = path.join(tmpDir, outputName);

      this.log(context, 'info', `Encrypting ${fileName} (${(file.size / 1024 / 1024).toFixed(1)}MB) with ${algorithm.toUpperCase()}`);

      switch (algorithm) {
        case 'pgp':
          await this.encryptPGP(file.path, outputPath, publicKey, armor);
          break;
        case 'rsa':
          await this.encryptRSAHybrid(file.path, outputPath, publicKey);
          break;
        case 'rsa-direct':
          await this.encryptRSADirect(file.path, outputPath, publicKey);
          break;
        case 'aes-128-gcm': case 'aes-192-gcm': case 'aes-256-gcm':
        case 'aes-128-cbc': case 'aes-192-cbc': case 'aes-256-cbc':
          await this.encryptAES(file.path, outputPath, publicKey, algorithm);
          break;
        default:
          throw new Error(`Unsupported algorithm: ${algorithm}`);
      }

      const stats = await fs.promises.stat(outputPath);

      // 5. If output to basket, register the file
      if (data.outputDestination === 'basket' && data.outputBasketId) {
        await this.writeToBasket(outputPath, outputName, data.outputBasketId, stats.size);
      }

      encryptedFiles.push({
        fileName: outputName,
        originalFileName: fileName,
        path: outputPath,
        size: stats.size,
        algorithm,
      });
    }

    this.log(context, 'info', `Encrypted ${encryptedFiles.length} file(s) with ${algorithm.toUpperCase()}`);

    return {
      files: encryptedFiles,
      filesProcessed: encryptedFiles.length,
      algorithm,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * PGP encryption using openpgp library
   * Reads file into memory (openpgp requires it)
   */
  private async encryptPGP(inputPath: string, outputPath: string, armoredPublicKey: string, armor: boolean): Promise<void> {
    const openpgp = await import('openpgp');
    const key = await openpgp.readKey({ armoredKey: armoredPublicKey });
    const fileBuffer = await fs.promises.readFile(inputPath);
    const message = await openpgp.createMessage({ binary: fileBuffer });

    if (armor) {
      const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: key,
        format: 'armored',
      });
      await fs.promises.writeFile(outputPath, encrypted as string, 'utf-8');
    } else {
      const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: key,
        format: 'binary',
      });
      await fs.promises.writeFile(outputPath, Buffer.from(encrypted as Uint8Array));
    }
  }

  /**
   * RSA Hybrid encryption (streaming):
   * 1. Generate random AES-256-GCM key
   * 2. Encrypt AES key with RSA-OAEP
   * 3. Stream-encrypt file data with AES-256-GCM
   *
   * File format:
   * [MAGIC(4)][VERSION(1)][encKeyLen(2)][encryptedAESKey][IV(12)][encrypted data...][authTag(16)]
   */
  private async encryptRSAHybrid(inputPath: string, outputPath: string, publicKeyPem: string): Promise<void> {
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // Encrypt AES key with RSA-OAEP
    const encryptedKey = crypto.publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      aesKey
    );

    // Write header
    const keyLenBuf = Buffer.alloc(2);
    keyLenBuf.writeUInt16BE(encryptedKey.length);
    const versionBuf = Buffer.from([RSA_HYBRID_VERSION]);

    const writeStream = fs.createWriteStream(outputPath);
    writeStream.write(RSA_HYBRID_MAGIC);
    writeStream.write(versionBuf);
    writeStream.write(keyLenBuf);
    writeStream.write(encryptedKey);
    writeStream.write(iv);

    // Stream encrypt with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const readStream = fs.createReadStream(inputPath);

    await pipeline(readStream, cipher, writeStream);

    // Append auth tag at the end
    const authTag = cipher.getAuthTag();
    await fs.promises.appendFile(outputPath, authTag);
  }

  /**
   * RSA Direct encryption for small files (< 446 bytes for RSA-4096)
   */
  private async encryptRSADirect(inputPath: string, outputPath: string, publicKeyPem: string): Promise<void> {
    const fileBuffer = await fs.promises.readFile(inputPath);
    const maxSize = 446;
    if (fileBuffer.length > maxSize) {
      throw new Error(
        `File too large for RSA Direct: ${fileBuffer.length} bytes (max ${maxSize}). Use RSA (hybrid) or AES instead.`
      );
    }
    const encrypted = crypto.publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      fileBuffer
    );
    await fs.promises.writeFile(outputPath, encrypted);
  }

  /**
   * AES symmetric encryption (streaming):
   * Resolves key from base64 (stored in publicKey) or JSON format
   *
   * GCM format: [iv(12)][encrypted data...][authTag(16)]
   * CBC format: [iv(16)][encrypted data (PKCS7 padded)]
   */
  private async encryptAES(inputPath: string, outputPath: string, keyData: string, algorithm: string): Promise<void> {
    const key = this.resolveAESKey(keyData);

    if (algorithm.endsWith('-gcm')) {
      const iv = crypto.randomBytes(12);
      const writeStream = fs.createWriteStream(outputPath);
      writeStream.write(iv);

      const cipher = crypto.createCipheriv(algorithm as any, key, iv);
      const readStream = fs.createReadStream(inputPath);

      await pipeline(readStream, cipher, writeStream);

      // Append auth tag
      const authTag = cipher.getAuthTag();
      await fs.promises.appendFile(outputPath, authTag);
    } else {
      // CBC mode
      const iv = crypto.randomBytes(16);
      const writeStream = fs.createWriteStream(outputPath);
      writeStream.write(iv);

      const cipher = crypto.createCipheriv(algorithm as any, key, iv);
      cipher.setAutoPadding(true); // PKCS7 padding
      const readStream = fs.createReadStream(inputPath);

      await pipeline(readStream, cipher, writeStream);
    }
  }

  /**
   * Resolve AES key from either base64 string or JSON format
   * Supports both:
   * - Raw base64: "abc123..." (32 bytes = 256 bits)
   * - JSON: { key: "hex...", keyBase64: "base64..." }
   */
  private resolveAESKey(keyData: string): Buffer {
    // Try JSON first
    if (keyData.startsWith('{')) {
      try {
        const parsed = JSON.parse(keyData);
        if (parsed.keyBase64) return Buffer.from(parsed.keyBase64, 'base64');
        if (parsed.key) return Buffer.from(parsed.key, 'hex');
        throw new Error('JSON key format missing "key" or "keyBase64" field');
      } catch (e: any) {
        if (e.message.includes('missing')) throw e;
        throw new Error(`Invalid AES key JSON: ${e.message}`);
      }
    }
    // Raw base64
    const buf = Buffer.from(keyData, 'base64');
    if (![16, 24, 32].includes(buf.length)) {
      throw new Error(`Invalid AES key length: expected 16/24/32 bytes, got ${buf.length}`);
    }
    return buf;
  }

  private resolveOutputFileName(
    template: string | undefined,
    originalFileName: string,
    algorithm: string,
    context: ExecutionContext
  ): string {
    if (!template) {
      const ext = algorithm === 'pgp' ? '.pgp' : '.enc';
      return originalFileName + ext;
    }

    let resolved = template
      .replace(/\{\{input\.fileName\}\}/g, originalFileName)
      .replace(/\{\{fileName\}\}/g, originalFileName)
      .replace(/\{\{baseName\}\}/g, path.basename(originalFileName, path.extname(originalFileName)))
      .replace(/\{\{ext\}\}/g, path.extname(originalFileName));

    if (resolved.includes('{{')) {
      resolved = this.resolveTemplate(resolved, context) as string;
    }

    return resolved;
  }

  private async resolveInputFiles(data: FileEncryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
    switch (data.source) {
      case 'basket':
        return this.resolveBasketFiles(data, context);
      case 'local':
        return this.resolveLocalFiles(data, context);
      case 'input':
      default:
        return this.resolveFromInput(context);
    }
  }

  private async resolveBasketFiles(data: FileEncryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
    if (!data.basketId) throw new Error('Basket ID is required for basket source');

    const pattern = data.filePattern || '*.*';
    const varMatch = pattern.match(/^\{\{(.+?)\}\}$/);
    if (varMatch) {
      const loopItem = context.variables.get(varMatch[1]) as any;
      if (loopItem?.path) {
        const filePath = loopItem.path.startsWith('/') ? loopItem.path : '/' + loopItem.path;
        if (fs.existsSync(filePath)) {
          return [{ path: filePath, size: fs.statSync(filePath).size }];
        }
      }
    }

    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    const basketFiles = await prisma.basketFile.findMany({
      where: { basketId: data.basketId, status: { in: ['open', 'active', 'uploaded', 'published'] } },
      orderBy: { createdAt: 'desc' },
    });

    return basketFiles
      .filter(f => regex.test(f.fileName))
      .map(f => ({ path: f.path.startsWith('/') ? f.path : '/' + f.path, size: f.size }))
      .filter(f => fs.existsSync(f.path));
  }

  private async resolveLocalFiles(data: FileEncryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
    const filePath = data.localPath ? this.resolveTemplate(data.localPath, context) as string : '';
    if (!filePath || !fs.existsSync(filePath)) return [];

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const pattern = data.filePattern || '*.*';
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return fs.readdirSync(filePath)
        .filter(f => regex.test(f))
        .map(f => {
          const fullPath = path.join(filePath, f);
          return { path: fullPath, size: fs.statSync(fullPath).size };
        });
    }

    return [{ path: filePath, size: stats.size }];
  }

  private resolveFromInput(context: ExecutionContext): { path: string; size: number }[] {
    const input = context.input as any;

    if (input?.files && Array.isArray(input.files)) {
      return input.files
        .filter((f: any) => f.path && fs.existsSync(f.path))
        .map((f: any) => ({ path: f.path, size: f.size || fs.statSync(f.path).size }));
    }
    if (input?.downloads && Array.isArray(input.downloads)) {
      return input.downloads
        .filter((d: any) => d.success && d.localPath && fs.existsSync(d.localPath))
        .map((d: any) => ({ path: d.localPath, size: fs.statSync(d.localPath).size }));
    }
    if (input?.path && fs.existsSync(input.path)) {
      return [{ path: input.path, size: fs.statSync(input.path).size }];
    }
    if (input?.localPath && fs.existsSync(input.localPath)) {
      return [{ path: input.localPath, size: fs.statSync(input.localPath).size }];
    }

    return [];
  }

  private async writeToBasket(filePath: string, fileName: string, basketId: string, size: number): Promise<void> {
    const basket = await prisma.basket.findUnique({ where: { id: basketId } });
    if (!basket) throw new Error(`Output basket not found: ${basketId}`);

    const storagePath = basket.path || `/data/baskets/${basketId}`;
    const destDir = storagePath.startsWith('/') ? storagePath : '/' + storagePath;
    fs.mkdirSync(destDir, { recursive: true });

    const destPath = path.join(destDir, fileName);
    await fs.promises.copyFile(filePath, destPath);

    const activeSession = await prisma.processingSession.findFirst({
      where: { basketId, status: { in: ['open', 'processing'] } },
      orderBy: { startedAt: 'desc' },
    });

    await prisma.basketFile.create({
      data: {
        basketId,
        sessionId: activeSession?.id,
        fileName,
        originalName: fileName,
        mimeType: 'application/octet-stream',
        path: destPath,
        size,
        status: 'uploaded',
        metadata: '{"encrypted":true}',
      },
    });
  }
}
