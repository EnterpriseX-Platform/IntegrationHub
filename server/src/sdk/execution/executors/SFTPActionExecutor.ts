// SFTP Action Executor - SFTP file transfer (Upload & Download) with Basket support

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';
import { loadRsaPrivateKey } from '../../../lib/rsaKeys';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { normalizePrivateKey } from '../../../lib/ppk-converter';
import { downloadNewFolders } from './sftpFolderSync';

const prisma = new PrismaClient();

// Names a downloaded remote file can be stored under in the basket: decryption
// renames the row, so "X.zip.pgp" on the server is kept as "X.zip".
function storedNamesFor(remoteName: string): string[] {
  const names = [remoteName];
  const m = remoteName.match(/^(.+)\.(pgp|gpg|asc|enc)$/i);
  if (m) names.push(m[1]);
  return names;
}

// Generate batch name from pattern (same as basket-sessions.ts)
function generateBatchName(pattern: string): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const year = now.getFullYear();
  const buddhistYear = year + 543; // พ.ศ.
  
  // Replace placeholders
  let name = pattern
    .replace(/\{YYYY\+543\}/g, buddhistYear.toString())     // {YYYY+543} -> พ.ศ. (2567)
    .replace(/\{BYYYY\}/g, buddhistYear.toString())         // {BYYYY} -> พ.ศ. (2567)
    .replace(/\{YYYY\}/g, year.toString())                  // {YYYY} -> ค.ศ. (2024)
    .replace(/\{YY\}/g, String(year).slice(-2))            // {YY} -> ค.ศ. 2 หลัก (24)
    .replace(/\{BYY\}/g, String(buddhistYear).slice(-2))   // {BYY} -> พ.ศ. 2 หลัก (67)
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'))
    .replace(/\{YYYYMMDD\}/g, dateStr)
    .replace(/\{HH\}/g, String(now.getHours()).padStart(2, '0'))
    .replace(/\{mm\}/g, String(now.getMinutes()).padStart(2, '0'))
    .replace(/\{ss\}/g, String(now.getSeconds()).padStart(2, '0'))
    .replace(/\{HHMMSS\}/g, timeStr);
  
  // Handle sequence numbers
  if (name.includes('{NNN}')) {
    name = name.replace('{NNN}', '{SEQ3}'); // 3 digits with leading zeros
  }
  if (name.includes('{NN}')) {
    name = name.replace('{NN}', '{SEQ2}'); // 2 digits with leading zeros
  }
  if (name.includes('{N}')) {
    name = name.replace('{N}', '{SEQ1}'); // 1 digit without leading zeros
  }
  
  return name;
}

interface SFTPActionData {
  connectionId: string;
  operation: 'upload' | 'download' | 'download-new-folders';
  newFoldersOnly?: boolean;
  targetFolder?: string;
  explorerBasketId?: string;
  startFromFolder?: string;
  maxFolders?: number;
  linkBaseUrl?: string;
  groupByFiscalYear?: boolean;
  remotePath: string;
  remoteFileName?: string;
  // Basket source options - FILE STATUS (not session status)
  basketId?: string;
  fileStatus?: 'ready' | 'all' | 'pending' | 'uploaded' | 'published' | 'processing' | 'transferred' | 'archived' | 'failed';
  filePattern?: string;
  // Actions after transfer
  publishAfterTransfer?: boolean;
  deleteAfterUpload?: boolean;
  archiveAfterUpload?: boolean;
  deleteAfterDownload?: boolean;
  extractZipFiles?: boolean;
  autoCreateSession?: boolean;
  sessionMode?: 'always_new' | 'existing_or_new' | 'reuse_existing';
  // Encryption
  encryptionKeyId?: string;
}

export class SFTPActionExecutor extends NodeExecutor {
  readonly type = 'sftp-action';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as SFTPActionData;
    
    if (!data.connectionId) {
      throw new Error('SFTP connection ID is required');
    }

    // Get connection config
    const connection = await prisma.connection.findUnique({
      where: { id: data.connectionId }
    });
    
    if (!connection) {
      throw new Error(`Connection not found: ${data.connectionId}`);
    }

    const config = typeof connection.config === 'string' 
      ? JSON.parse(connection.config) 
      : connection.config;

    const operation = data.operation || 'upload';
    
    // 'Download from SFTP' + 'Only new folders' (older flows saved the separate operation name)
    if (operation === 'download-new-folders' || (operation === 'download' && data.newFoldersOnly === true)) {
      return downloadNewFolders(config, {
        remotePath: this.resolveTemplate(data.remotePath || '', context),
        filePattern: data.filePattern,
        targetFolder: data.targetFolder ? this.resolveTemplate(data.targetFolder, context) : undefined,
        startFromFolder: data.startFromFolder ? this.resolveTemplate(data.startFromFolder, context) : undefined,
        maxFolders: data.maxFolders,
        linkBaseUrl: data.linkBaseUrl || process.env.PUBLIC_APP_URL,
        groupByFiscalYear: data.groupByFiscalYear === true,
        basketId: data.basketId || undefined,
        explorerBasketId: data.explorerBasketId || undefined,
        encryptionKeyId: data.encryptionKeyId || undefined,
      }, (level, message) => this.log(context, level, message));
    }
    if (operation === 'download') {
      return this.executeDownload(config, data, context);
    } else {
      return this.executeUpload(config, data, context);
    }
  }

  private async executeUpload(config: any, data: SFTPActionData, context: ExecutionContext): Promise<any> {
    const fileStatus = data.fileStatus || 'published';
    const pattern = data.filePattern || '*.*';
    
    // Get files from basket
    let files: any[] = [];
    let sessionId: string | undefined;
    
    if (data.basketId) {
      const basket = await prisma.basket.findUnique({
        where: { id: data.basketId }
      });
      
      if (!basket) {
        throw new Error(`Basket not found: ${data.basketId}`);
      }

      // Map fileStatus to the set of file statuses to send.
      const statusMap: Record<string, string[]> = {
        // web uploads land as 'pending', flow-written files as 'uploaded'
        'ready': ['pending', 'uploaded', 'published'],
        'all': ['pending', 'uploaded', 'published', 'processing', 'transferred', 'archived', 'failed'],
        'pending': ['pending'],
        'uploaded': ['uploaded'],
        'published': ['published'],
        'processing': ['processing'],
        'transferred': ['transferred'],
        'archived': ['archived'],
        'failed': ['failed']
      };
      const selectedStatuses = statusMap[fileStatus] || ['pending', 'uploaded', 'published'];

      // Select files DIRECTLY from the basket (across any session). Previously this
      // required a session in published/processing/active/open and only the latest
      // one — so files dropped into the basket whose session had already moved to
      // 'completed' (e.g. a UI upload, which lands as 'pending' files in a completed
      // session) were never picked up by a manual UPLOAD run.
      // Run by a basket-trigger on this same basket: send the files of the
      // session(s) that fired it — the same ready files the trigger saw —
      // instead of filtering the whole basket by status. Web uploads land as
      // 'pending' and flow-written files as 'uploaded'; a fixed status filter
      // silently skipped one kind (and could sweep up stray files elsewhere).
      const triggerSessionIds = context.variables.get('triggerSessionIds') as string[] | undefined;
      const triggerBasketId = context.variables.get('basketId');
      if (Array.isArray(triggerSessionIds) && triggerSessionIds.length > 0 && triggerBasketId === data.basketId) {
        files = await prisma.basketFile.findMany({
          where: {
            basketId: data.basketId,
            sessionId: { in: triggerSessionIds },
            status: { in: ['pending', 'uploaded', 'published'] },
          },
          orderBy: { createdAt: 'asc' },
        });
        this.log(context, 'info', `Sending ready files from triggering session(s): ${triggerSessionIds.join(', ')}`);
      } else {
        files = await prisma.basketFile.findMany({
          where: {
            basketId: data.basketId,
            status: { in: selectedStatuses },
          },
          orderBy: { createdAt: 'asc' },
        });
      }

      // Filter by glob pattern
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      files = files.filter(f => regex.test(f.fileName));
      sessionId = files[0]?.sessionId || undefined;
    }

    if (files.length === 0) {
      return {
        operation: 'upload',
        basketId: data.basketId,
        sessionId,
        pattern,
        fileStatus,
        filesFound: 0,
        uploads: [],
        status: 'no_files',
        message: `No ${fileStatus} files matching "${pattern}" found`,
        executedAt: new Date().toISOString(),
      };
    }

    const uploads = [];
    for (const file of files) {
      const result = await this.uploadSingleFile(config, file, data, context);
      uploads.push(result);
      
      // Delete source file if configured
      if (data.deleteAfterUpload && result.success) {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
          await prisma.basketFile.delete({ where: { id: file.id } });
        } catch (e) {
          console.error(`Failed to delete file ${file.path}:`, e);
        }
      }
      
      // Individual file archive is handled in session cleanup
    }
    
    // After all transfers, archive the uploaded files so they are not re-sent on
    // the next run. Files may span multiple sessions (we select by basket now),
    // so archive per-session; files with no session get marked archived directly.
    let sessionResult = null;
    const okIds = new Set(uploads.filter(u => u.success).map(u => u.fileId));
    if (okIds.size > 0 && data.archiveAfterUpload) {
      const bySession = new Map<string, string[]>();
      for (const f of files) {
        if (!okIds.has(f.id)) continue;
        const sid = f.sessionId || '__none__';
        if (!bySession.has(sid)) bySession.set(sid, []);
        bySession.get(sid)!.push(f.id);
      }
      for (const [sid, ids] of bySession) {
        if (sid !== '__none__') await this.archiveSessionFiles(sid, ids);
        else await prisma.basketFile.updateMany({ where: { id: { in: ids } }, data: { status: 'archived' } });
      }
    }
    // Best-effort: complete the (first) session if every file transferred.
    if (sessionId && uploads.length > 0 && uploads.every(u => u.success) && (data.archiveAfterUpload || data.publishAfterTransfer)) {
      sessionResult = await this.completeSession(sessionId, data.basketId!, true);
    }

    return {
      operation: 'upload',
      basketId: data.basketId,
      sessionId,
      pattern,
      fileStatus,
      filesFound: files.length,
      uploads,
      sessionResult,
      status: 'success',
      executedAt: new Date().toISOString(),
    };
  }

  private async executeDownload(config: any, data: SFTPActionData, _context: ExecutionContext): Promise<any> {
    // If remotePath is empty or just '/', use basePath directly; otherwise join basePath + remotePath
    const remotePath = (!data.remotePath || data.remotePath === '/')
      ? (config.basePath || '/')
      : path.posix.join(config.basePath || '/', data.remotePath);
    const pattern = data.filePattern || '*.*';
    let basketPath = '/data/incoming';
    let basketId: string | undefined;

    // Get basket path if basketId is specified
    if (data.basketId) {
      const basket = await prisma.basket.findUnique({
        where: { id: data.basketId }
      });
      if (basket) {
        basketPath = basket.path;
        basketId = basket.id;
      }
    }

    // Ensure basket folder exists
    if (!fs.existsSync(basketPath)) {
      fs.mkdirSync(basketPath, { recursive: true });
    }

    const downloads = await this.downloadFiles(config, remotePath, basketPath, pattern, data.deleteAfterDownload, basketId, data.extractZipFiles, data.autoCreateSession, data.sessionMode);

    // Get sessionId from first successful download (all files in same session)
    const sessionId = downloads.find(d => d.success)?.sessionId;

    // Decrypt downloaded files if encryption key is configured
    const decryptedFiles: any[] = [];
    if (data.encryptionKeyId) {
      for (const download of downloads) {
        if (download.success) {
          try {
            const result = await this.decryptFile(download.localPath, data.encryptionKeyId);
            // Replace original encrypted file with decrypted version
            if (fs.existsSync(result.decryptedPath) && result.decryptedPath !== download.localPath) {
              fs.unlinkSync(download.localPath);
              download.localPath = result.decryptedPath;
              download.fileName = path.basename(result.decryptedPath);
              download.decrypted = true;
              download.decryptionAlgorithm = result.algorithm;
              // Read decrypted size from disk
              const decryptedSize = fs.statSync(result.decryptedPath).size;
              download.size = decryptedSize;
              // Update basket file record so UI shows decrypted name/size
              if (download.fileId) {
                await prisma.basketFile.update({
                  where: { id: download.fileId },
                  data: {
                    fileName: download.fileName,
                    originalName: download.fileName,
                    path: result.decryptedPath,
                    size: decryptedSize,
                  }
                });
              }
            }
            decryptedFiles.push({ file: download.fileName, algorithm: result.algorithm, success: true });
          } catch (err) {
            decryptedFiles.push({ file: download.fileName, success: false, error: (err as Error).message });
          }
        }
      }
    }

    // Extract ZIP files if option enabled (runs after decryption so .zip.pgp → .zip → extracted)
    const extractedFiles: any[] = [];
    if (data.extractZipFiles) {
      for (const download of downloads) {
        if (download.success && download.fileName.toLowerCase().endsWith('.zip')) {
          try {
            const extracted = await this.extractZipFile(download.localPath, basketPath, basketId, sessionId);
            extractedFiles.push({
              zipFile: download.fileName,
              extracted
            });
          } catch (err) {
            console.error(`Failed to extract ${download.fileName}:`, err);
            extractedFiles.push({
              zipFile: download.fileName,
              error: (err as Error).message
            });
          }
        }
      }
    }

    return {
      operation: 'download',
      remotePath,
      basketPath,
      basketId,
      pattern,
      filesDownloaded: downloads.filter(d => d.success).length,
      filesSkipped: downloads.filter(d => d.skipped).length,
      extractedFiles: extractedFiles.length > 0 ? extractedFiles : undefined,
      decryptedFiles: decryptedFiles.length > 0 ? decryptedFiles : undefined,
      downloads,
      status: 'success',
      executedAt: new Date().toISOString(),
    };
  }

  private async extractZipFile(zipPath: string, extractTo: string, basketId?: string, sessionId?: string): Promise<string[]> {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const extractedFiles: string[] = [];

    // Create extraction folder
    const zipName = path.basename(zipPath, '.zip');
    const extractFolder = path.join(extractTo, zipName);
    
    if (!fs.existsSync(extractFolder)) {
      fs.mkdirSync(extractFolder, { recursive: true });
    }

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      
      const entryName = entry.entryName;
      const entryPath = path.join(extractFolder, entryName);
      
      // Ensure parent directory exists
      const parentDir = path.dirname(entryPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      // Extract file
      zip.extractEntryTo(entry, extractFolder, true, true);
      
      extractedFiles.push(entryName);
      
      // Create basket file record if basketId provided
      if (basketId) {
        const stats = fs.statSync(entryPath);
        await prisma.basketFile.create({
          data: {
            basketId,
            sessionId,
            fileName: entryName,
            originalName: entryName,
            size: stats.size,
            mimeType: 'application/octet-stream',
            path: entryPath,
            status: 'uploaded'
          }
        });
      }
    }

    return extractedFiles;
  }

  // Encrypt a file using the encryption key from Secrets Vault
  private async encryptFile(filePath: string, keyId: string): Promise<{ encryptedPath: string; algorithm: string }> {
    const apiKey = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!apiKey) throw new Error(`Encryption key not found: ${keyId}`);

    const algorithm = apiKey.algorithm || 'pgp';
    const encryptedPath = filePath + (algorithm === 'pgp' ? '.pgp' : '.enc');

    if (algorithm === 'pgp') {
      const openpgp = await import('openpgp');
      const publicKey = await openpgp.readKey({ armoredKey: apiKey.publicKey! });
      const plainData = fs.readFileSync(filePath);
      const message = await openpgp.createMessage({ binary: plainData });
      const encrypted = await openpgp.encrypt({ message, encryptionKeys: publicKey, format: 'binary' });
      fs.writeFileSync(encryptedPath, encrypted as any);
    } else if (algorithm === 'rsa') {
      // RSA hybrid: AES-256-GCM for data, RSA-OAEP for key
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const encKey = crypto.publicEncrypt(
        { key: apiKey.publicKey!, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aesKey
      );
      const keyLen = Buffer.alloc(2);
      keyLen.writeUInt16BE(encKey.length);
      const magic = Buffer.from('RSAH');
      const ver = Buffer.from([1]);
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const plainData = fs.readFileSync(filePath);
      const encData = Buffer.concat([cipher.update(plainData), cipher.final()]);
      const tag = cipher.getAuthTag();
      fs.writeFileSync(encryptedPath, Buffer.concat([magic, ver, keyLen, encKey, iv, encData, tag]));
    } else {
      // AES-256-GCM
      const keyBuf = Buffer.from(apiKey.publicKey!, 'base64');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
      const plainData = fs.readFileSync(filePath);
      const encData = Buffer.concat([cipher.update(plainData), cipher.final()]);
      const tag = cipher.getAuthTag();
      fs.writeFileSync(encryptedPath, Buffer.concat([iv, encData, tag]));
    }

    return { encryptedPath, algorithm };
  }

  // Decrypt a file using the encryption key from Secrets Vault
  private async decryptFile(filePath: string, keyId: string): Promise<{ decryptedPath: string; algorithm: string }> {
    const apiKey = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!apiKey) throw new Error(`Encryption key not found: ${keyId}`);

    const algorithm = apiKey.algorithm || 'pgp';
    const decryptedPath = filePath.replace(/\.(pgp|gpg|enc)$/, '') || filePath + '.dec';

    if (algorithm === 'pgp') {
      const openpgp = await import('openpgp');
      const encData = fs.readFileSync(filePath);

      // Read private key (armored PEM block)
      let privKey = await openpgp.readPrivateKey({ armoredKey: apiKey.secretKey! });

      // OpenPGP.js v6 requires explicit key unlock via decryptKey() before use,
      // even when the key has no passphrase. Without this step, decrypt() throws
      // "No decryption key packets found" because locked keys are skipped.
      if (!privKey.isDecrypted()) {
        try {
          privKey = await openpgp.decryptKey({ privateKey: privKey, passphrase: '' });
        } catch {
          // Key may have a non-empty passphrase — proceed and let decrypt() fail with a clear error
        }
      }

      // Read the encrypted message — try binary first (most .pgp files), fallback to armored
      let message;
      try {
        message = await openpgp.readMessage({ binaryMessage: encData });
      } catch {
        const armored = fs.readFileSync(filePath, 'utf-8');
        message = await openpgp.readMessage({ armoredMessage: armored });
      }

      const { data } = await openpgp.decrypt({
        message,
        decryptionKeys: privKey,
        format: 'binary',
        config: { allowInsecureDecryptionWithSigningKeys: true }
      });
      fs.writeFileSync(decryptedPath, Buffer.from(data as Uint8Array));
    } else if (algorithm === 'rsa') {
      const file = fs.readFileSync(filePath);
      let off = 4 + 1; // RSAH magic + version
      const kl = file.readUInt16BE(off); off += 2;
      const ek = file.subarray(off, off + kl); off += kl;
      const iv = file.subarray(off, off + 12); off += 12;
      const encData = file.subarray(off, file.length - 16);
      const tag = file.subarray(file.length - 16);
      const aesKey = crypto.privateDecrypt(
        { key: loadRsaPrivateKey(apiKey.secretKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        ek
      );
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
      fs.writeFileSync(decryptedPath, decrypted);
    } else {
      // AES-256-GCM
      const file = fs.readFileSync(filePath);
      const iv = file.subarray(0, 12);
      const encData = file.subarray(12, file.length - 16);
      const tag = file.subarray(file.length - 16);
      const parsed = JSON.parse(apiKey.secretKey!);
      const keyBuf = Buffer.from(parsed.keyBase64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
      fs.writeFileSync(decryptedPath, decrypted);
    }

    return { decryptedPath, algorithm };
  }

  private async uploadSingleFile(
    config: any,
    file: any,
    data: SFTPActionData,
    context: ExecutionContext
  ): Promise<any> {
    // Real name as uploaded: basket fileName carries a "file-<ts>-<id>_" prefix
    const originalFileName = file.originalName || file.fileName;
    const remoteFileName = data.remoteFileName
      ? this.resolveFileName(data.remoteFileName, context, originalFileName)
      : originalFileName;

    // Combine basePath from connection + remotePath from node config
    const basePath = config.basePath || '/';
    const remotePath = data.remotePath || '';

    let uploadPath = file.path;
    let finalRemoteFileName = remoteFileName;
    let encrypted = false;
    let encAlgorithm = '';

    // Encrypt before upload if encryption key is configured
    if (data.encryptionKeyId) {
      try {
        const result = await this.encryptFile(file.path, data.encryptionKeyId);
        uploadPath = result.encryptedPath;
        finalRemoteFileName = remoteFileName + (result.algorithm === 'pgp' ? '.pgp' : '.enc');
        encrypted = true;
        encAlgorithm = result.algorithm;
      } catch (err) {
        return {
          fileId: file.id,
          fileName: originalFileName,
          success: false,
          error: `Encryption failed: ${(err as Error).message}`,
        };
      }
    }

    const remoteFullPath = path.posix.join(basePath, remotePath, finalRemoteFileName);

    try {
      await this.uploadFile(config, uploadPath, remoteFullPath);

      // Clean up encrypted temp file
      if (encrypted && uploadPath !== file.path) {
        try { fs.unlinkSync(uploadPath); } catch {}
      }

      // Update file status to transferred
      await prisma.basketFile.update({
        where: { id: file.id },
        data: { status: 'transferred' }
      });

      return {
        fileId: file.id,
        localFile: file.path,
        fileName: originalFileName,
        remotePath: remoteFullPath,
        remoteFileName: finalRemoteFileName,
        size: file.size,
        encrypted,
        encryptionAlgorithm: encAlgorithm || undefined,
        success: true,
      };
    } catch (err) {
      // Clean up encrypted temp file on error
      if (encrypted && uploadPath !== file.path) {
        try { fs.unlinkSync(uploadPath); } catch {}
      }
      return {
        fileId: file.id,
        localFile: file.path,
        fileName: originalFileName,
        remotePath: remoteFullPath,
        remoteFileName: finalRemoteFileName,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async archiveSessionFiles(sessionId: string, fileIds: string[]): Promise<void> {
    try {
      // Get basket path from session
      const session = await prisma.processingSession.findUnique({
        where: { id: sessionId },
        include: { basket: true }
      });
      
      if (!session) return;
      
      // Create archive directory
      const archiveDir = path.join(session.basket.path, 'archive', session.batchName);
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      
      // Move files to archive
      for (const fileId of fileIds) {
        const file = await prisma.basketFile.findUnique({ where: { id: fileId } });
        if (file && fs.existsSync(file.path)) {
          const archivePath = path.join(archiveDir, file.fileName);
          fs.renameSync(file.path, archivePath);
          
          await prisma.basketFile.update({
            where: { id: fileId },
            data: { 
              status: 'archived',
              path: archivePath
            }
          });
        }
      }
      
      console.log(`[SFTP] Archived ${fileIds.length} files to ${archiveDir}`);
    } catch (e) {
      console.error(`Failed to archive session files:`, e);
    }
  }
  
  private async completeSession(sessionId: string, _basketId: string, allSuccess: boolean): Promise<any> {
    try {
      // Update session status to completed or archived
      const newStatus = allSuccess ? 'completed' : 'archived';
      
      const session = await prisma.processingSession.update({
        where: { id: sessionId },
        data: {
          status: newStatus,
          completedAt: new Date()
        }
      });

      await prisma.sessionLog.create({
        data: {
          sessionId,
          type: 'session_completed',
          message: `Session ${newStatus} after SFTP transfer`,
          metadata: JSON.stringify({ allSuccess, completedAt: new Date() })
        }
      });

      console.log(`[SFTP] Session ${sessionId} marked as ${newStatus}`);
      return { success: true, status: newStatus, completedAt: session.completedAt };
    } catch (error) {
      console.error('Failed to complete session:', error);
      return { success: false, error: String(error) };
    }
  }

  private resolveFileName(template: string, _context: ExecutionContext, originalFileName: string): string {
    let result = template;
    
    // Replace {{original}}
    result = result.replace(/\{\{original\}\}/g, originalFileName);
    
    // Replace {{date}}
    const date = new Date().toISOString().split('T')[0];
    result = result.replace(/\{\{date\}\}/g, date);
    
    // Replace {{timestamp}}
    result = result.replace(/\{\{timestamp\}\}/g, Date.now().toString());
    
    // Replace {{filename}} (without extension)
    const filenameWithoutExt = originalFileName.replace(/\.[^/.]+$/, '');
    result = result.replace(/\{\{filename\}\}/g, filenameWithoutExt);
    
    // Replace {{extension}}
    const ext = originalFileName.split('.').pop() || '';
    result = result.replace(/\{\{extension\}\}/g, ext);
    
    return result;
  }

  private async uploadFile(config: any, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          // Ensure remote directory exists
          const remoteDir = path.posix.dirname(remotePath);
          sftp.mkdir(remoteDir, () => {
            // Ignore error (dir might exist)
            
            const readStream = fs.createReadStream(localPath);
            const writeStream = sftp.createWriteStream(remotePath);

            // A basket row whose file is gone from disk used to emit an
            // unhandled 'error' here, which takes the whole server process
            // down and kills every other flow running at the time.
            readStream.on('error', (err: Error) => {
              conn.end();
              reject(new Error(`Cannot read local file ${localPath}: ${err.message}`));
            });

            writeStream.on('close', () => {
              conn.end();
              resolve();
            });

            writeStream.on('error', (err: Error) => {
              conn.end();
              reject(err);
            });

            readStream.pipe(writeStream);
          });
        });
      });

      conn.on('error', reject);

      conn.connect({
        host: config.host,
        port: config.port || 22,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey ? normalizePrivateKey(config.privateKey) : undefined,
        readyTimeout: 20000,
      });
    });
  }

  private async downloadFiles(
    config: any,
    remotePath: string,
    localPath: string,
    pattern: string,
    deleteAfterDownload?: boolean,
    basketId?: string,
    _extractZipFiles?: boolean,
    autoCreateSession?: boolean,
    sessionMode?: 'always_new' | 'existing_or_new' | 'reuse_existing'
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const downloads: any[] = [];
      let dedupedCount = 0;

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          // List remote directory
          sftp.readdir(remotePath, async (err, list) => {
            if (err) {
              conn.end();
              return reject(err);
            }
            
            // Filter by pattern
            const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            let files = list.filter(f => regex.test(f.filename) && f.attrs.isFile());

            // With deleteAfterDownload=false the remote files stay put, so every
            // scheduled run used to fetch them again into a fresh session once the
            // previous one was published — and publishing that session imported
            // the same rows a second time (one file seen in two sessions).
            // Skip a file this basket already holds with the same remote mtime,
            // in any session.
            if (basketId) {
              const fresh: typeof files = [];
              for (const f of files) {
                const mtime = f.attrs.mtime ? new Date(f.attrs.mtime * 1000) : undefined;
                const seen = mtime && await prisma.basketFile.findFirst({
                  where: { basketId, fileName: { in: storedNamesFor(f.filename) }, remoteModifiedAt: mtime },
                  select: { id: true },
                });
                if (seen) {
                  downloads.push({
                    fileName: f.filename,
                    remotePath: path.posix.join(remotePath, f.filename),
                    success: false,
                    skipped: true,
                    reason: 'already downloaded into this basket',
                  });
                } else {
                  fresh.push(f);
                }
              }
              if (fresh.length < files.length) {
                console.log(`[SFTP] Skipped ${files.length - fresh.length} of ${files.length} file(s) already downloaded into basket ${basketId}`);
              }
              files = fresh;
            }

            if (files.length === 0) {
              conn.end();
              return resolve(downloads);
            }
            
            // Create session for batch basket
            let sessionId: string | undefined;
            let sessionFolder = localPath;
            
            if (basketId) {
              const basket = await prisma.basket.findUnique({
                where: { id: basketId }
              });
              
              if (basket && basket.type === 'batch' && autoCreateSession !== false) {
                // Note: 'sftp' type baskets do NOT auto-create sessions
                // sessionMode: 'always_new' (default) | 'existing_or_new' | 'reuse_existing'
                const mode = sessionMode || 'existing_or_new';

                // Try to find existing open session
                let reuseSession: any = null;
                if (mode === 'existing_or_new' || mode === 'reuse_existing') {
                  reuseSession = await prisma.processingSession.findFirst({
                    where: { basketId, status: 'open' },
                    orderBy: { startedAt: 'desc' },
                  });
                }

                if (mode === 'reuse_existing' && !reuseSession) {
                  throw new Error('No open session found for basket. Please create a session first or use sessionMode: existing_or_new');
                }

                if (reuseSession) {
                  // Reuse existing open session. Counters are recomputed from
                  // the rows after the downloads finish — adding files.length
                  // here double-counted every re-download of the same file.
                  sessionId = reuseSession.id;
                  console.log(`[SFTP] Reusing existing open session "${reuseSession.batchName}" (${reuseSession.id}) for basket ${basketId}`);

                  sessionFolder = path.join(localPath, 'sessions', reuseSession.batchName);
                  if (!fs.existsSync(sessionFolder)) {
                    fs.mkdirSync(sessionFolder, { recursive: true });
                  }
                } else {
                  // Create a new session
                  const pattern = basket.sessionPattern || '{YYYY+543}-{NN}';
                  let baseName = generateBatchName(pattern);

                  // Handle {SEQ} placeholders with reset logic
                  const seqMatch = baseName.match(/\{SEQ(\d)?\}/);
                  if (seqMatch) {
                    const digits = seqMatch[1] ? parseInt(seqMatch[1]) : 3;
                    const now = new Date();

                    let fromDate: Date;
                    if (pattern.includes('{YYYY-MM-DD}')) {
                      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    } else if (pattern.includes('{YYYY-MM}') || pattern.includes('{MM}')) {
                      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    } else if (pattern.includes('{YYYY+543}') || pattern.includes('{BYYYY}') || pattern.includes('{YYYY}')) {
                      fromDate = new Date(now.getFullYear(), 0, 1);
                    } else {
                      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    }
                    fromDate.setHours(0, 0, 0, 0);

                    const existingSessions = await prisma.processingSession.count({
                      where: {
                        basketId,
                        startedAt: { gte: fromDate },
                        status: { in: ['open', 'published', 'processing', 'completed', 'archived'] }
                      }
                    });

                    const seqNum = existingSessions + 1;
                    const seqStr = digits === 1 ? String(seqNum) : String(seqNum).padStart(digits, '0');
                    baseName = baseName.replace(seqMatch[0], seqStr);
                  }

                  let sessionName = baseName;
                  let suffix = 1;
                  while (await prisma.processingSession.findFirst({ where: { batchName: sessionName, basketId } })) {
                    sessionName = `${baseName}-${suffix}`;
                    suffix++;
                  }

                  const session = await prisma.processingSession.create({
                    data: {
                      basketId,
                      batchName: sessionName,
                      status: 'open',
                      publishMode: 'manual',
                      fileCount: files.length,
                      totalSize: files.reduce((sum, f) => sum + f.attrs.size, 0),
                      startedAt: new Date()
                    }
                  });
                  sessionId = session.id;
                  console.log(`[SFTP] Created new session "${sessionName}" (${session.id}) for basket ${basketId}`);

                  sessionFolder = path.join(localPath, 'sessions', sessionName);
                  if (!fs.existsSync(sessionFolder)) {
                    fs.mkdirSync(sessionFolder, { recursive: true });
                  }
                }
              }
            }
            
            // Download each file
            for (const file of files) {
              const remoteFile = path.posix.join(remotePath, file.filename);
              const localFile = path.join(sessionFolder, file.filename);
              
              try {
                await new Promise<void>((res, rej) => {
                  sftp.fastGet(remoteFile, localFile, (err) => {
                    if (err) rej(err);
                    else res();
                  });
                });
                
                // Create basket file record if basketId provided.
                // With deleteAfterDownload=false the same remote files are
                // re-fetched on every run, so insert only when this session
                // doesn't already track the file — otherwise each scheduled
                // run added a full duplicate set of rows (one deployment: 1,177 real
                // PDFs had grown to 23,574 rows, all re-OCR'd every run).
                let createdFileId: string | undefined;
                if (basketId) {
                  const remoteModifiedAt = file.attrs.mtime
                    ? new Date(file.attrs.mtime * 1000)
                    : undefined;

                  const existing = sessionId
                    ? await prisma.basketFile.findFirst({
                        where: { sessionId, fileName: { in: storedNamesFor(file.filename) } },
                      })
                    : null;

                  if (existing) {
                    // Refresh what the re-download actually changed. `status`
                    // is deliberately left alone: a file already processed
                    // must not be silently re-queued.
                    await prisma.basketFile.update({
                      where: { id: existing.id },
                      data: {
                        size: file.attrs.size,
                        path: localFile,
                        ...(remoteModifiedAt && { remoteModifiedAt }),
                      },
                    });
                    createdFileId = existing.id;
                    dedupedCount++;
                  } else {
                    const created = await prisma.basketFile.create({
                      data: {
                        basketId,
                        sessionId,
                        fileName: file.filename,
                        originalName: file.filename,
                        size: file.attrs.size,
                        mimeType: 'application/octet-stream',
                        path: localFile,
                        status: 'uploaded',
                        ...(remoteModifiedAt && { remoteModifiedAt }),
                      }
                    });
                    createdFileId = created.id;
                  }
                }

                downloads.push({
                  fileName: file.filename,
                  remotePath: remoteFile,
                  localPath: localFile,
                  size: file.attrs.size,
                  success: true,
                  sessionId,
                  fileId: createdFileId,
                });
                
                // Delete remote file if configured
                if (deleteAfterDownload) {
                  sftp.unlink(remoteFile, () => {});
                }
              } catch (downloadErr) {
                downloads.push({
                  fileName: file.filename,
                  remotePath: remoteFile,
                  error: (downloadErr as Error).message,
                  success: false
                });
              }
            }
            
            // Recompute the session counters from the rows that actually
            // exist, so a re-download can't inflate them.
            if (sessionId) {
              try {
                const agg = await prisma.basketFile.aggregate({
                  where: { sessionId },
                  _count: { _all: true },
                  _sum: { size: true },
                });
                await prisma.processingSession.update({
                  where: { id: sessionId },
                  data: {
                    fileCount: agg._count._all,
                    totalSize: agg._sum.size || 0,
                  },
                });
              } catch (aggErr) {
                console.warn('[SFTP] Failed to refresh session counters:', (aggErr as Error).message);
              }
            }

            if (dedupedCount > 0) {
              console.log(`[SFTP] ${dedupedCount} of ${files.length} file(s) already tracked in this session — refreshed instead of duplicated`);
            }

            conn.end();
            resolve(downloads);
          });
        });
      });
      
      conn.on('error', (err) => reject(err));
      
      conn.connect({
        host: config.host,
        port: config.port || 22,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey ? normalizePrivateKey(config.privateKey) : undefined,
        readyTimeout: 20000,
      });
    });
  }
}
