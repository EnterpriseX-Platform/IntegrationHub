// File Decrypt Executor - PGP/RSA/AES decryption for files

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { prisma } from '../../../lib/prisma';
import { loadRsaPrivateKey } from '../../../lib/rsaKeys';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Must match FileEncryptExecutor magic bytes
const RSA_HYBRID_MAGIC = Buffer.from('RSAH');
const RSA_HYBRID_VERSION = 1;

interface FileDecryptData {
  encryptionKeyId: string;
  source: 'input' | 'basket' | 'local';
  basketId?: string;
  filePattern?: string;
  localPath?: string;
  outputFileName?: string;
  outputDestination: 'temp' | 'basket';
  outputBasketId?: string;
  passphrase?: string;
}

export class FileDecryptExecutor extends NodeExecutor {
  readonly type = 'file-decrypt';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as FileDecryptData;

    if (!data.encryptionKeyId) {
      throw new Error('Encryption key ID is required');
    }

    // 1. Load key record - needs secretKey (private key) for decryption
    const keyRecord = await prisma.apiKey.findUnique({
      where: { id: data.encryptionKeyId },
    });

    if (!keyRecord) {
      throw new Error(`Encryption key not found: ${data.encryptionKeyId}`);
    }

    if (!keyRecord.secretKey) {
      throw new Error(`Private/secret key not set for key: ${keyRecord.name}. Cannot decrypt with imported public keys.`);
    }

    const algorithm = keyRecord.algorithm || 'pgp';
    const secretKey = keyRecord.secretKey;
    const publicKey = keyRecord.publicKey || undefined;

    // 2. Resolve input files
    const files = await this.resolveInputFiles(data, context);

    if (files.length === 0) {
      throw new Error('No files found to decrypt');
    }

    // 3. Create temp output directory
    const tmpDir = `/tmp/decrypt-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    // 4. Decrypt each file
    const decryptedFiles: any[] = [];

    for (const file of files) {
      const fileName = path.basename(file.path);
      const outputName = this.resolveOutputFileName(data.outputFileName, fileName, algorithm, context);
      const outputPath = path.join(tmpDir, outputName);

      this.log(context, 'info', `Decrypting ${fileName} (${(file.size / 1024 / 1024).toFixed(1)}MB) with ${algorithm.toUpperCase()}`);

      switch (algorithm) {
        case 'pgp':
          await this.decryptPGP(file.path, outputPath, secretKey, publicKey, data.passphrase);
          break;
        case 'rsa':
          await this.decryptRSAHybrid(file.path, outputPath, loadRsaPrivateKey(secretKey, data.passphrase));
          break;
        case 'rsa-direct':
          await this.decryptRSADirect(file.path, outputPath, loadRsaPrivateKey(secretKey, data.passphrase));
          break;
        case 'aes-128-gcm': case 'aes-192-gcm': case 'aes-256-gcm':
        case 'aes-128-cbc': case 'aes-192-cbc': case 'aes-256-cbc':
          await this.decryptAES(file.path, outputPath, secretKey, algorithm);
          break;
        default:
          throw new Error(`Unsupported algorithm: ${algorithm}`);
      }

      const stats = await fs.promises.stat(outputPath);

      // 5. If output to basket, register the file
      if (data.outputDestination === 'basket' && data.outputBasketId) {
        await this.writeToBasket(outputPath, outputName, data.outputBasketId, stats.size);
      }

      decryptedFiles.push({
        fileName: outputName,
        originalFileName: fileName,
        path: outputPath,
        size: stats.size,
        algorithm,
      });
    }

    this.log(context, 'info', `Decrypted ${decryptedFiles.length} file(s) with ${algorithm.toUpperCase()}`);

    return {
      files: decryptedFiles,
      filesProcessed: decryptedFiles.length,
      algorithm,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * PGP decryption - auto-detects armored vs binary format
   */
  private async decryptPGP(
    inputPath: string, outputPath: string,
    armoredPrivateKey: string, armoredPublicKey?: string,
    passphrase?: string
  ): Promise<void> {
    const openpgp = await import('openpgp');
    let privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });

    // Decrypt private key if passphrase-protected
    if (passphrase && !privateKey.isDecrypted()) {
      privateKey = await openpgp.decryptKey({ privateKey, passphrase });
    }

    const fileBuffer = await fs.promises.readFile(inputPath);

    // Detect armored vs binary
    const content = fileBuffer.toString('utf-8');
    let message;
    if (content.includes('-----BEGIN PGP MESSAGE-----')) {
      message = await openpgp.readMessage({ armoredMessage: content });
    } else {
      message = await openpgp.readMessage({ binaryMessage: fileBuffer });
    }

    const decryptOptions: any = {
      message,
      decryptionKeys: privateKey,
      format: 'binary',
    };

    // Add verification key if available
    if (armoredPublicKey) {
      try {
        decryptOptions.verificationKeys = await openpgp.readKey({ armoredKey: armoredPublicKey });
      } catch {
        // Skip verification if key can't be read
      }
    }

    const { data } = await openpgp.decrypt(decryptOptions);
    await fs.promises.writeFile(outputPath, Buffer.from(data as Uint8Array));
  }

  /**
   * RSA Hybrid decryption with format validation:
   * File format: [MAGIC(4)][VERSION(1)][encKeyLen(2)][encryptedAESKey][IV(12)][encrypted data...][authTag(16)]
   *
   * Also supports legacy format (no magic): [keyLen(2)][encryptedKey][iv(12)][authTag(16)][data]
   */
  /**
   * RSA Direct decryption for small files
   */
  private async decryptRSADirect(inputPath: string, outputPath: string, privateKey: crypto.KeyObject): Promise<void> {
    const encrypted = await fs.promises.readFile(inputPath);
    const decrypted = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encrypted
    );
    await fs.promises.writeFile(outputPath, decrypted);
  }

  private async decryptRSAHybrid(inputPath: string, outputPath: string, privateKey: crypto.KeyObject): Promise<void> {
    const fileBuffer = await fs.promises.readFile(inputPath);
    let offset = 0;

    // Check for magic bytes (new format)
    const hasNewFormat = fileBuffer.subarray(0, 4).equals(RSA_HYBRID_MAGIC);

    if (hasNewFormat) {
      // New format with magic + version
      offset += 4; // MAGIC
      const version = fileBuffer[offset];
      offset += 1; // VERSION
      if (version !== RSA_HYBRID_VERSION) {
        throw new Error(`Unsupported RSA hybrid format version: ${version}`);
      }

      const keyLen = fileBuffer.readUInt16BE(offset);
      offset += 2;

      if (keyLen > 1024 || keyLen === 0) {
        throw new Error(`Invalid encrypted key length: ${keyLen}. File may be corrupted.`);
      }

      const encryptedKey = fileBuffer.subarray(offset, offset + keyLen);
      offset += keyLen;

      const iv = fileBuffer.subarray(offset, offset + 12);
      offset += 12;

      // Data is everything until last 16 bytes (auth tag)
      const encryptedData = fileBuffer.subarray(offset, fileBuffer.length - 16);
      const authTag = fileBuffer.subarray(fileBuffer.length - 16);

      // Decrypt AES key with RSA
      const aesKey = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        encryptedKey
      );

      // Decrypt data with AES-256-GCM
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      await fs.promises.writeFile(outputPath, decrypted);

    } else {
      // Legacy format: [keyLen(2)][encryptedKey][iv(12)][authTag(16)][data]
      const keyLen = fileBuffer.readUInt16BE(offset);
      offset += 2;

      if (keyLen > 1024 || keyLen === 0) {
        throw new Error(`Invalid encrypted key length: ${keyLen}. File may not be RSA-encrypted.`);
      }

      const encryptedKey = fileBuffer.subarray(offset, offset + keyLen);
      offset += keyLen;

      const iv = fileBuffer.subarray(offset, offset + 12);
      offset += 12;

      const authTag = fileBuffer.subarray(offset, offset + 16);
      offset += 16;

      const encryptedData = fileBuffer.subarray(offset);

      const aesKey = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        encryptedKey
      );

      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      await fs.promises.writeFile(outputPath, decrypted);
    }
  }

  /**
   * AES symmetric decryption:
   * Resolves key from base64 or JSON format (matching FileEncryptExecutor)
   *
   * GCM format: [iv(12)][encrypted data...][authTag(16)]
   * CBC format: [iv(16)][encrypted data (PKCS7 padded)]
   */
  private async decryptAES(inputPath: string, outputPath: string, keyData: string, algorithm: string): Promise<void> {
    const key = this.resolveAESKey(keyData);
    const fileBuffer = await fs.promises.readFile(inputPath);

    let decrypted: Buffer;

    if (algorithm.endsWith('-gcm')) {
      // Format: [iv(12)][encrypted data...][authTag(16)]
      const iv = fileBuffer.subarray(0, 12);
      const encryptedData = fileBuffer.subarray(12, fileBuffer.length - 16);
      const authTag = fileBuffer.subarray(fileBuffer.length - 16);

      const decipher = crypto.createDecipheriv(algorithm as any, key, iv);
      decipher.setAuthTag(authTag);
      decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    } else {
      // aes-256-cbc: [iv(16)][encrypted data (PKCS7 padded)]
      const iv = fileBuffer.subarray(0, 16);
      const encryptedData = fileBuffer.subarray(16);

      const decipher = crypto.createDecipheriv(algorithm as any, key, iv);
      decipher.setAutoPadding(true);
      decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    }

    await fs.promises.writeFile(outputPath, decrypted);
  }

  /**
   * Resolve AES key from either base64 string or JSON format
   */
  private resolveAESKey(keyData: string): Buffer {
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
    const buf = Buffer.from(keyData, 'base64');
    if (![16, 24, 32].includes(buf.length)) {
      throw new Error(`Invalid AES key length: expected 16/24/32 bytes, got ${buf.length}`);
    }
    return buf;
  }

  private resolveOutputFileName(
    template: string | undefined,
    originalFileName: string,
    _algorithm: string,
    context: ExecutionContext
  ): string {
    if (!template) {
      const encExtensions = ['.pgp', '.gpg', '.enc', '.encrypted', '.aes'];
      const ext = path.extname(originalFileName).toLowerCase();
      if (encExtensions.includes(ext)) {
        return originalFileName.slice(0, -ext.length);
      }
      return originalFileName + '.decrypted';
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

  private async resolveInputFiles(data: FileDecryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
    switch (data.source) {
      case 'basket': return this.resolveBasketFiles(data, context);
      case 'local': return this.resolveLocalFiles(data, context);
      case 'input': default: return this.resolveFromInput(context);
    }
  }

  private async resolveBasketFiles(data: FileDecryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
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

  private async resolveLocalFiles(data: FileDecryptData, context: ExecutionContext): Promise<{ path: string; size: number }[]> {
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
        metadata: '{"decrypted":true}',
      },
    });
  }
}
