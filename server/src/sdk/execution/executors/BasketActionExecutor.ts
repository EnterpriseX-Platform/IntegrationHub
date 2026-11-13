// Basket Action Executor - Copy, ZIP, and organize files between baskets
// Designed for basket-to-basket file operations with folder organization (e.g., by year)
// Supports shares basket folder structure (basketFolder + folderId on files)

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const prisma = new PrismaClient();

interface BasketActionData {
  // Operation: what to do with files
  operation: 'copy' | 'zip' | 'copy-and-zip' | 'extract';

  // Extract options (when operation = 'extract'): unzip a file produced by a
  // previous node (e.g. an http-request download) into the destination basket.
  sourceFilePath?: string;         // path to the .zip (template, e.g. {{dl.localPath}})
  autoCreateSession?: boolean;     // batch baskets: drop extracted files into a ProcessingSession (default true)
  sessionMode?: 'always_new' | 'existing_or_new' | 'reuse_existing';

  // Source basket
  sourceBasketId: string;          // Basket to read files from
  sourceSessionId?: string;        // Specific session (defaults to latest or from previous node)
  filePattern?: string;            // Glob pattern (e.g., "*.txt", "*.csv", default: "*")
  fileStatus?: string;             // Filter by status (default: all)

  // Destination basket
  destinationBasketId: string;     // Basket to write files to (usually shares type)
  targetFolder?: string;           // Folder path with date placeholders: {YYYY+543}, {BYYYY}, {MM}, etc.

  // ZIP options (when operation = 'zip' or 'copy-and-zip')
  zipFileName?: string;            // ZIP file name with placeholders: {{date}}, {{timestamp}}, {{fileName}}, etc.
  compressionLevel?: number;       // 0-9, default: 6

  // Options
  overwrite?: boolean;             // Overwrite existing files (default: true)
  deleteSource?: boolean;          // Delete source files after copy (default: false)
}

export class BasketActionExecutor extends NodeExecutor {
  readonly type = 'basket-action';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as BasketActionData;

    // Extract/unzip a file (from a previous node) into the destination basket.
    if (data.operation === 'extract') {
      return this.extractToBasket(data, context);
    }

    if (!data.sourceBasketId) {
      throw new Error('Source basket ID is required');
    }
    if (!data.destinationBasketId) {
      throw new Error('Destination basket ID is required');
    }

    // Resolve source & destination baskets
    const sourceBasket = await prisma.basket.findUnique({ where: { id: data.sourceBasketId } });
    if (!sourceBasket) throw new Error(`Source basket not found: ${data.sourceBasketId}`);

    const destBasket = await prisma.basket.findUnique({ where: { id: data.destinationBasketId } });
    if (!destBasket) throw new Error(`Destination basket not found: ${data.destinationBasketId}`);

    // Resolve target folder with date/year placeholders
    const targetFolder = this.resolveTargetFolder(data.targetFolder || '', context);

    // Collect source files
    const sourceFiles = await this.collectSourceFiles(data, context);

    if (sourceFiles.length === 0) {
      console.log('[BasketAction] No source files found');
      return {
        operation: data.operation,
        sourceBasket: sourceBasket.name,
        destinationBasket: destBasket.name,
        targetFolder: targetFolder || undefined,
        filesFound: 0,
        status: 'empty',
        message: 'No source files found',
      };
    }

    console.log(`[BasketAction] ${data.operation}: ${sourceFiles.length} files from "${sourceBasket.name}" → "${destBasket.name}/${targetFolder}"`);

    const result: any = {
      operation: data.operation,
      sourceBasket: sourceBasket.name,
      destinationBasket: destBasket.name,
      targetFolder: targetFolder || undefined,
      filesFound: sourceFiles.length,
    };

    // Ensure destination folder exists on disk AND in DB (for shares baskets)
    const { destDir, folderId } = await this.ensureDestinationFolder(destBasket, targetFolder);

    // Execute operation
    switch (data.operation) {
      case 'copy':
        result.copied = await this.copyFiles(sourceFiles, destDir, destBasket, targetFolder, folderId, data, context);
        break;

      case 'zip':
        result.zip = await this.zipFiles(sourceFiles, destDir, destBasket, targetFolder, folderId, data, context);
        break;

      case 'copy-and-zip':
        result.copied = await this.copyFiles(sourceFiles, destDir, destBasket, targetFolder, folderId, data, context);
        result.zip = await this.zipFiles(sourceFiles, destDir, destBasket, targetFolder, folderId, data, context);
        break;

      default:
        throw new Error(`Unknown operation: ${data.operation}`);
    }

    // Delete source files if requested
    if (data.deleteSource) {
      result.deleted = await this.deleteSourceFiles(sourceFiles);
    }

    result.folderId = folderId;
    result.timestamp = new Date().toISOString();
    return result;
  }

  // ─── Extract / Unzip a file into a basket ──────────────────────────────────
  private async extractToBasket(data: BasketActionData, context: ExecutionContext): Promise<any> {
    if (!data.destinationBasketId) throw new Error('Destination basket is required for extract');
    const zipPath = String(this.resolveTemplate(data.sourceFilePath || '', context) || '').trim();
    if (!zipPath) throw new Error('Source file path is required for extract (e.g. {{dl.localPath}})');
    if (!fs.existsSync(zipPath)) throw new Error(`Source file not found: ${zipPath}`);

    const basket = await prisma.basket.findUnique({
      where: { id: data.destinationBasketId },
      select: { id: true, name: true, path: true, type: true, sessionPattern: true },
    });
    if (!basket) throw new Error(`Destination basket not found: ${data.destinationBasketId}`);

    // For batch baskets, drop files into a ProcessingSession so they show in the UI.
    let sessionId: string | null = null;
    let targetDir = path.join(basket.path, 'incoming');
    if (basket.type === 'batch' && data.autoCreateSession !== false) {
      const sess = await this.ensureBatchSession(basket, data.sessionMode);
      sessionId = sess.sessionId;
      targetDir = sess.folder;
    }
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const mimeFor = (name: string): string => {
      const ext = path.extname(name).toLowerCase();
      return ext === '.pdf' ? 'application/pdf'
        : ext === '.xml' ? 'application/xml'
        : ext === '.csv' ? 'text/csv'
        : ext === '.txt' ? 'text/plain'
        : ext === '.json' ? 'application/json'
        : ext === '.zip' ? 'application/zip'
        : (ext === '.xlsx' || ext === '.xls') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/octet-stream';
    };

    const zip = new AdmZip(zipPath);
    let count = 0, bytes = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const base = path.basename(entry.entryName);
      if (!base) continue;
      const eId = 'f' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
      const eStored = `${eId}_${base}`;
      const ePath = path.join(targetDir, eStored);
      fs.writeFileSync(ePath, entry.getData());
      const eSize = fs.statSync(ePath).size;
      bytes += eSize;
      await prisma.basketFile.create({
        data: {
          id: eId, fileName: eStored, originalName: base, path: ePath, size: eSize,
          mimeType: mimeFor(base), basketId: basket.id, sessionId: sessionId || undefined,
          status: sessionId ? 'uploaded' : 'pending',
          metadata: JSON.stringify({ source: 'basket-action-extract', zip: path.basename(zipPath), entry: entry.entryName }),
        },
      });
      count++;
    }
    if (sessionId) {
      await prisma.processingSession.update({
        where: { id: sessionId },
        data: { fileCount: { increment: count }, totalSize: { increment: bytes } },
      }).catch(() => {});
    }
    await prisma.basketLog.create({
      data: { basketId: basket.id, type: 'upload', message: `Extracted ${count} file(s) from ${path.basename(zipPath)}`, fileCount: count, fileSize: bytes },
    }).catch(() => {});

    console.log(`[BasketAction] extract: ${count} file(s) from ${zipPath} → "${basket.name}"${sessionId ? ` (session ${sessionId})` : ''}`);
    return {
      operation: 'extract', destinationBasket: basket.name, sourceFile: zipPath,
      extracted: count, totalSize: bytes, sessionId: sessionId || undefined,
      status: 'success', timestamp: new Date().toISOString(),
    };
  }

  private genBatchName(pattern: string): string {
    const now = new Date();
    const y = now.getFullYear(), by = y + 543;
    const p2 = (n: number) => String(n).padStart(2, '0');
    let name = pattern
      .replace(/\{YYYY\+543\}/g, String(by)).replace(/\{BYYYY\}/g, String(by))
      .replace(/\{YYYY\}/g, String(y)).replace(/\{YY\}/g, String(y).slice(-2)).replace(/\{BYY\}/g, String(by).slice(-2))
      .replace(/\{MM\}/g, p2(now.getMonth() + 1)).replace(/\{DD\}/g, p2(now.getDate()))
      .replace(/\{YYYYMMDD\}/g, `${y}${p2(now.getMonth() + 1)}${p2(now.getDate())}`)
      .replace(/\{HH\}/g, p2(now.getHours())).replace(/\{mm\}/g, p2(now.getMinutes())).replace(/\{ss\}/g, p2(now.getSeconds()));
    return name.replace(/\{NNN\}/g, '{SEQ3}').replace(/\{NN\}/g, '{SEQ2}').replace(/\{N\}/g, '{SEQ1}');
  }

  private async ensureBatchSession(
    basket: { id: string; path: string; sessionPattern: string | null },
    mode?: string
  ): Promise<{ sessionId: string; folder: string }> {
    const m = mode || 'existing_or_new';
    let session: any = null;
    if (m === 'existing_or_new' || m === 'reuse_existing') {
      session = await prisma.processingSession.findFirst({ where: { basketId: basket.id, status: 'open' }, orderBy: { startedAt: 'desc' } });
    }
    if (m === 'reuse_existing' && !session) throw new Error('No open session found for basket — create one first or use sessionMode "existing_or_new".');
    if (!session) {
      let base = this.genBatchName(basket.sessionPattern || '{YYYY+543}-{NN}');
      const seqM = base.match(/\{SEQ(\d)?\}/);
      if (seqM) {
        const digits = seqM[1] ? parseInt(seqM[1]) : 3;
        const fromDate = new Date(new Date().getFullYear(), 0, 1); fromDate.setHours(0, 0, 0, 0);
        const cnt = await prisma.processingSession.count({ where: { basketId: basket.id, startedAt: { gte: fromDate } } });
        base = base.replace(seqM[0], digits === 1 ? String(cnt + 1) : String(cnt + 1).padStart(digits, '0'));
      }
      let nm = base, sfx = 1;
      while (await prisma.processingSession.findFirst({ where: { batchName: nm, basketId: basket.id } })) { nm = `${base}-${sfx++}`; }
      session = await prisma.processingSession.create({
        data: { basketId: basket.id, batchName: nm, status: 'open', publishMode: 'manual', fileCount: 0, totalSize: 0, startedAt: new Date() },
      });
    }
    const folder = path.join(basket.path, 'sessions', session.batchName);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    return { sessionId: session.id, folder };
  }

  /**
   * Ensure destination folder exists both on disk and as a DB record (for shares baskets).
   * For shares baskets: files go under basket.path/folders/<folderPath>/
   * For other baskets: files go under basket.path/<targetFolder>/
   */
  private async ensureDestinationFolder(
    destBasket: any,
    targetFolder: string
  ): Promise<{ destDir: string; folderId: string | null }> {
    if (!targetFolder) {
      // No folder specified — use basket root
      return { destDir: destBasket.path, folderId: null };
    }

    if (destBasket.type === 'shares') {
      // Shares baskets use folders/ subdirectory and basketFolder DB records
      const folderPath = targetFolder;
      const diskPath = path.join(destBasket.path, 'folders', folderPath);

      if (!fs.existsSync(diskPath)) {
        fs.mkdirSync(diskPath, { recursive: true });
      }

      // Find or create basketFolder record (support nested: e.g., "2569/03")
      const folderParts = targetFolder.split('/').filter(Boolean);
      let parentId: string | null = null;
      let currentPath = '';
      let folderId: string | null = null;

      for (const part of folderParts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        // Find existing folder
        let folder = await prisma.basketFolder.findFirst({
          where: {
            basketId: destBasket.id,
            path: currentPath,
          }
        });

        if (!folder) {
          // Create the folder record
          folder = await prisma.basketFolder.create({
            data: {
              basketId: destBasket.id,
              name: part,
              path: currentPath,
              parentId: parentId,
            }
          });
          console.log(`[BasketAction] Created folder "${currentPath}" in basket "${destBasket.name}"`);
        }

        parentId = folder.id;
        folderId = folder.id;
      }

      return { destDir: diskPath, folderId };
    } else {
      // Non-shares baskets: direct subdirectory
      const destDir = path.join(destBasket.path, targetFolder);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      return { destDir, folderId: null };
    }
  }

  /**
   * Collect files from the source basket
   */
  private async collectSourceFiles(
    data: BasketActionData,
    context: ExecutionContext
  ): Promise<Array<{ id: string; name: string; path: string; size: number }>> {
    const pattern = data.filePattern || '*';
    const files: Array<{ id: string; name: string; path: string; size: number }> = [];

    // Determine session ID
    let sessionId = data.sourceSessionId;

    // Try to get from previous node's output (sftp-action passes sessionId)
    if (!sessionId) {
      const input = context.input as any;
      if (input?.sessionId) {
        sessionId = input.sessionId;
      }
    }

    // If still no sessionId, find the latest session
    if (!sessionId) {
      const latestSession = await prisma.processingSession.findFirst({
        where: { basketId: data.sourceBasketId },
        orderBy: { startedAt: 'desc' }
      });
      if (latestSession) sessionId = latestSession.id;
    }

    // Query basket files
    const where: any = { basketId: data.sourceBasketId };
    if (sessionId) where.sessionId = sessionId;
    if (data.fileStatus && data.fileStatus !== 'all') {
      where.status = data.fileStatus;
    }

    const basketFiles = await prisma.basketFile.findMany({
      where,
      orderBy: { createdAt: 'asc' }
    });

    for (const bf of basketFiles) {
      if (this.matchPattern(bf.fileName, pattern) && fs.existsSync(bf.path)) {
        files.push({ id: bf.id, name: bf.fileName, path: bf.path, size: bf.size });
      }
    }

    return files;
  }

  /**
   * Copy files to destination basket folder
   */
  private async copyFiles(
    files: Array<{ id: string; name: string; path: string; size: number }>,
    destDir: string,
    _destBasket: any,
    targetFolder: string,
    folderId: string | null,
    data: BasketActionData,
    context: ExecutionContext
  ): Promise<any> {
    const results: Array<{ name: string; size: number; success: boolean; error?: string }> = [];
    let totalSize = 0;

    for (const file of files) {
      try {
        const destPath = path.join(destDir, file.name);

        // Check if file exists
        if (fs.existsSync(destPath)) {
          if (!data.overwrite) {
            results.push({ name: file.name, size: file.size, success: true, error: 'skipped (exists)' });
            continue;
          }
          // Overwrite: delete existing DB record(s) for this file
          const whereClause: any = {
            basketId: data.destinationBasketId,
            fileName: file.name,
          };
          if (folderId) whereClause.folderId = folderId;
          await prisma.basketFile.deleteMany({ where: whereClause });
        }

        // Copy file
        fs.copyFileSync(file.path, destPath);
        const stats = fs.statSync(destPath);
        totalSize += stats.size;

        // Create BasketFile record in destination (with folderId for shares)
        await prisma.basketFile.create({
          data: {
            basketId: data.destinationBasketId,
            fileName: file.name,
            originalName: file.name,
            size: stats.size,
            mimeType: this.getMimeType(file.name),
            path: destPath,
            status: 'uploaded',
            folderId: folderId,
            metadata: JSON.stringify({
              source: 'basket-action',
              operation: 'copy',
              sourceBasketId: data.sourceBasketId,
              targetFolder,
              flowId: context.flow.operationId,
              copiedAt: new Date().toISOString()
            })
          }
        });

        results.push({ name: file.name, size: stats.size, success: true });
      } catch (err) {
        results.push({ name: file.name, size: file.size, success: false, error: (err as Error).message });
      }
    }

    return {
      filesCopied: results.filter(r => r.success && !r.error?.includes('skipped')).length,
      filesSkipped: results.filter(r => r.error?.includes('skipped')).length,
      totalSize,
      files: results,
    };
  }

  /**
   * ZIP files and store in destination basket folder.
   * zipFileName supports: {{date}}, {{timestamp}}, {{year}}, {{buddhistYear}}, {{fileName}} (first source file base name)
   */
  private async zipFiles(
    files: Array<{ id: string; name: string; path: string; size: number }>,
    destDir: string,
    destBasket: any,
    targetFolder: string,
    folderId: string | null,
    data: BasketActionData,
    context: ExecutionContext
  ): Promise<any> {
    // Resolve ZIP file name
    const now = new Date();
    const year = now.getFullYear();
    const buddhistYear = year + 543;

    // Derive a name from the first source file (without extension)
    const firstFileName = files.length > 0 ? path.basename(files[0].name, path.extname(files[0].name)) : 'archive';

    let zipFileName = data.zipFileName || `${destBasket.name}_{{date}}.zip`;
    zipFileName = zipFileName
      .replace(/\{\{fileName\}\}/g, firstFileName)
      .replace(/\{\{timestamp\}\}/g, Date.now().toString())
      .replace(/\{\{date\}\}/g, now.toISOString().split('T')[0])
      .replace(/\{\{year\}\}/g, String(year))
      .replace(/\{\{buddhistYear\}\}/g, String(buddhistYear))
      .replace(/\{\{BYYYY\}\}/g, String(buddhistYear));

    // Also resolve {BYYYY}, {YYYY+543} style placeholders (same as targetFolder)
    zipFileName = zipFileName
      .replace(/\{YYYY\+543\}/g, String(buddhistYear))
      .replace(/\{BYYYY\}/g, String(buddhistYear))
      .replace(/\{YYYY\}/g, String(year))
      .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
      .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'));

    // Ensure .zip extension
    if (!zipFileName.toLowerCase().endsWith('.zip')) {
      zipFileName += '.zip';
    }

    // Create ZIP in temp location
    const tempZipPath = path.join('/tmp', `basket_zip_${Date.now()}_${zipFileName}`);
    await this.createZipFile(files, tempZipPath, data.compressionLevel || 6);
    const zipStats = fs.statSync(tempZipPath);

    // Move ZIP to destination
    const destZipPath = path.join(destDir, zipFileName);

    // Overwrite: delete existing DB record(s) for this ZIP file
    if (data.overwrite !== false && fs.existsSync(destZipPath)) {
      const whereClause: any = {
        basketId: data.destinationBasketId,
        fileName: zipFileName,
      };
      if (folderId) whereClause.folderId = folderId;
      await prisma.basketFile.deleteMany({ where: whereClause });
    } else if (data.overwrite === false && fs.existsSync(destZipPath)) {
      try { fs.unlinkSync(tempZipPath); } catch (_e) { /* ignore */ }
      return {
        fileName: zipFileName,
        filePath: destZipPath,
        skipped: true,
        reason: 'File already exists and overwrite is disabled',
      };
    }

    fs.copyFileSync(tempZipPath, destZipPath);
    try { fs.unlinkSync(tempZipPath); } catch (_e) { /* ignore */ }

    // Create BasketFile record (with folderId for shares)
    const basketFile = await prisma.basketFile.create({
      data: {
        basketId: data.destinationBasketId,
        fileName: zipFileName,
        originalName: zipFileName,
        size: zipStats.size,
        mimeType: 'application/zip',
        path: destZipPath,
        status: 'uploaded',
        folderId: folderId,
        metadata: JSON.stringify({
          source: 'basket-action',
          operation: 'zip',
          sourceBasketId: data.sourceBasketId,
          targetFolder,
          flowId: context.flow.operationId,
          filesIncluded: files.length,
          fileNames: files.map(f => f.name),
          createdAt: new Date().toISOString()
        })
      }
    });

    // Log
    await prisma.basketFileLog.create({
      data: {
        fileId: basketFile.id,
        action: 'file_created',
        status: 'success',
        message: `ZIP ${zipFileName} created with ${files.length} files`,
        metadata: JSON.stringify({
          sourceBasket: data.sourceBasketId,
          filesIncluded: files.length,
          zipSize: zipStats.size,
          originalSize: files.reduce((sum, f) => sum + f.size, 0)
        })
      }
    });

    console.log(`[BasketAction/ZIP] Created ${zipFileName}: ${zipStats.size} bytes (${files.length} files)`);

    return {
      fileName: zipFileName,
      filePath: destZipPath,
      fileId: basketFile.id,
      zipSize: zipStats.size,
      originalSize: files.reduce((sum, f) => sum + f.size, 0),
      filesIncluded: files.length,
      fileNames: files.map(f => f.name),
    };
  }

  /**
   * Delete source files after successful copy/zip
   */
  private async deleteSourceFiles(
    files: Array<{ id: string; name: string; path: string; size: number }>
  ): Promise<any> {
    let deleted = 0;
    for (const file of files) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        await prisma.basketFile.update({
          where: { id: file.id },
          data: { status: 'archived' }
        });
        deleted++;
      } catch (_err) {
        // Continue on error
      }
    }
    return { filesDeleted: deleted, totalFiles: files.length };
  }

  /**
   * Create a ZIP file using archiver
   */
  private async createZipFile(
    files: Array<{ name: string; path: string }>,
    outputPath: string,
    compressionLevel: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: compressionLevel } });

      output.on('close', () => resolve());
      archive.on('error', (err: Error) => reject(err));

      archive.pipe(output);

      for (const file of files) {
        archive.file(file.path, { name: file.name });
      }

      archive.finalize();
    });
  }

  /**
   * Resolve target folder path with date/year placeholders
   */
  private resolveTargetFolder(folder: string, context: ExecutionContext): string {
    if (!folder) return '';

    const now = new Date();
    const year = now.getFullYear();
    const buddhistYear = year + 543;

    let resolved = folder
      .replace(/\{YYYY\+543\}/g, String(buddhistYear))
      .replace(/\{BYYYY\}/g, String(buddhistYear))
      .replace(/\{YYYY\}/g, String(year))
      .replace(/\{YY\}/g, String(year).slice(-2))
      .replace(/\{BYY\}/g, String(buddhistYear).slice(-2))
      .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
      .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'))
      .replace(/\{YYYYMMDD\}/g, now.toISOString().split('T')[0].replace(/-/g, ''));

    // Also resolve {{vars.*}} templates
    if (resolved.includes('{{')) {
      resolved = resolved.replace(/\{\{([^}]+)\}\}/g, (match, varPath) => {
        const keys = varPath.trim().split('.');
        let value: any = context;
        for (const key of keys) {
          value = value?.[key];
        }
        return value !== undefined ? String(value) : match;
      });
    }

    return resolved;
  }

  /**
   * Simple glob pattern matcher
   */
  private matchPattern(fileName: string, pattern: string): boolean {
    if (pattern === '*' || pattern === '*.*') return true;
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    );
    return regex.test(fileName);
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.csv': 'text/csv',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}
