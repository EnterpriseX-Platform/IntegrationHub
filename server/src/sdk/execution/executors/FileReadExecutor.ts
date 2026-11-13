// File Read Executor - Unified file reading from Basket/SFTP/Local + Parsing

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

const prisma = new PrismaClient();

/**
 * Auto-detect delimiter when caller passes 'auto' or just a default ',' that doesn't fit the data.
 * Picks the candidate that produces the most stable column count across the first ~5 lines.
 */
function detectDelimiter(sample: string): string {
  const lines = sample.split('\n').filter(l => l.trim()).slice(0, 5);
  if (lines.length === 0) return ',';
  const candidates = ['|', '\t', ';', ',']; // pipe is common in finance/gov data dumps
  let best: { d: string; cols: number; score: number } | null = null;
  for (const d of candidates) {
    const counts = lines.map(l => l.split(d).length);
    const cols = counts[0];
    if (cols < 2) continue;                        // didn't split → not a delimiter
    const stable = counts.every(c => c === cols);
    // Score: prefer more columns AND stable count; pipe wins over comma when both equal
    const score = (stable ? 100 : 0) + cols + (d === '|' ? 0.5 : 0);
    if (!best || score > best.score) best = { d, cols, score };
  }
  return best ? best.d : ',';
}

// CSV Parser with header options + auto-detect delimiter (pass delimiter='auto' to use detection)
function parseCSV(content: string, delimiter: string = ',', hasHeader: boolean = true, customHeaders?: string[]): any[] {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];

  // Auto-detect delimiter if requested OR if the default ',' didn't actually split anything
  let effDelim = delimiter;
  if (effDelim === 'auto' || (effDelim === ',' && lines[0].split(',').length === 1)) {
    effDelim = detectDelimiter(content);
  }

  let headers: string[];
  let startIndex: number;

  if (hasHeader) {
    // Use first line as headers
    headers = lines[0].split(effDelim).map(h => h.trim().replace(/^"|"$/g, ''));
    startIndex = 1;
  } else if (customHeaders && customHeaders.length > 0) {
    // Use custom headers
    headers = customHeaders;
    startIndex = 0;
  } else {
    // Auto-generate headers (col0, col1, col2...)
    const firstLineCols = lines[0].split(effDelim).length;
    headers = Array.from({ length: firstLineCols }, (_, i) => `col${i}`);
    startIndex = 0;
  }

  const results: any[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const values = lines[i].split(effDelim).map(v => v.trim().replace(/^"|"$/g, ''));
    const row: any = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    results.push(row);
  }

  return results;
}

// TXT Parser
function parseTXT(content: string): string[] {
  return content.split('\n').map(line => line.trim()).filter(line => line);
}

// XLSX Parser — converts Buffer (xlsx file) into an array of row objects keyed by header
async function parseXLSX(buffer: Buffer, hasHeader: boolean = true, customHeaders?: string[], sheetName?: string): Promise<any[]> {
  // Lazy require so the module isn't loaded for non-xlsx flows
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!sheet) return [];

  // Collect header
  let headers: string[];
  let startRow: number;
  if (hasHeader) {
    const hdr = sheet.getRow(1).values;
    // ExcelJS row.values is 1-indexed; drop element 0
    headers = (hdr as any[]).slice(1).map((v: any) => String(v ?? '').trim());
    startRow = 2;
  } else if (customHeaders && customHeaders.length > 0) {
    headers = customHeaders;
    startRow = 1;
  } else {
    headers = Array.from({ length: sheet.columnCount }, (_, i) => `col${i}`);
    startRow = 1;
  }

  const results: any[] = [];
  for (let r = startRow; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const vals = (row.values as any[]).slice(1);
    // Skip fully-empty rows
    if (vals.every(v => v === null || v === undefined || v === '')) continue;
    const obj: Record<string, any> = {};
    for (let i = 0; i < headers.length; i++) {
      let v = vals[i];
      // Unwrap rich-text or hyperlink objects to plain string
      if (v && typeof v === 'object') {
        if ('text' in v) v = (v as any).text;
        else if ('result' in v) v = (v as any).result;
        else if ('richText' in v) v = (v as any).richText.map((rt: any) => rt.text).join('');
      }
      obj[headers[i]] = v === undefined ? null : v;
    }
    results.push(obj);
  }
  return results;
}

interface FileReadData {
  // Source
  source: 'basket' | 'sftp' | 'local' | 'input';
  basketId?: string;        // Basket ID to read from
  basketPath?: string;      // Legacy: direct path
  sftpConnectionId?: string;
  sftpRemotePath?: string;
  localPath?: string;
  filePattern?: string;   // e.g., *.csv
  fileStatus?: 'open' | 'published' | 'all';  // For basket source
  sessionSource?: 'trigger' | 'latest' | 'specific' | 'all';  // How to select session
  sessionId?: string;       // For 'specific' mode
  // Parse options
  parseAs: 'csv' | 'tsv' | 'json' | 'txt' | 'raw' | 'auto' | 'list' | 'download' | 'xlsx';
  sheetName?: string;       // For xlsx: pick a specific sheet (default: first)
  delimiter?: string;
  hasHeader?: boolean;      // CSV has header row (default: true)
  customHeaders?: string;   // Comma-separated custom headers (e.g., "name,email,phone")
  maxRows?: number;
  encoding?: string;
}

export class FileReadExecutor extends NodeExecutor {
  readonly type = 'file-read';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as FileReadData;
    
    // Get file(s) based on source
    let files: { path: string; content?: string; size: number }[] = [];
    
    switch (data.source) {
      case 'basket':
        files = await this.readFromBasket(data, context);
        break;
      case 'sftp':
        files = await this.readFromSFTP(data, context);
        break;
      case 'local':
        files = await this.readFromLocal(data, context);
        break;
      case 'input':
      default:
        files = this.readFromInput(context);
        break;
    }

    if (files.length === 0) {
      throw new Error('No files found to read');
    }

    // Download mode: return file for binary streaming (zip, pdf, etc.)
    if (data.parseAs === 'download') {
      const file = files[0]; // Download first matching file
      const fileName = (file as any).originalName || path.basename(file.path);
      const ext = path.extname(fileName).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.zip': 'application/zip',
        '.pdf': 'application/pdf',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.csv': 'text/csv',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.xml': 'application/xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      return {
        _fileDownload: {
          filePath: file.path,
          fileName,
          size: file.size,
        },
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'Content-Length': String(file.size),
        },
      };
    }

    // Read file contents — binary formats (xlsx) need a Buffer, text formats need a string
    const encoding = data.encoding || 'utf-8';
    const useIconv = !Buffer.isEncoding(encoding);
    // Detect binary format: explicit 'xlsx' parseAs, or auto + .xlsx extension
    const isBinaryFormat = (file: any) => {
      if (data.parseAs === 'xlsx' || data.parseAs === 'raw' || data.parseAs === 'download') return true;
      if (data.parseAs === 'auto') {
        const ext = (file.path || file.fileName || '').toLowerCase().split('.').pop();
        return ext === 'xlsx' || ext === 'xlsm';
      }
      return false;
    };
    const filesWithContent = await Promise.all(
      files.map(async (file) => {
        const binary = isBinaryFormat(file);
        if (binary) {
          // Read as Buffer — preserve raw bytes for binary parsers
          const buf = await fs.promises.readFile(file.path);
          return { ...file, content: buf };
        }
        // Text formats: decode with requested encoding
        let content: string;
        if (useIconv) {
          const buf = await fs.promises.readFile(file.path);
          content = iconv.decode(buf, encoding);
        } else {
          content = await fs.promises.readFile(file.path, encoding as BufferEncoding);
        }
        return { ...file, content };
      })
    );

    // Parse files (parseFile is async — xlsx parsing uses await)
    const parsedFiles = await Promise.all(filesWithContent.map(async (file) => {
      const parsed = await this.parseFile(file, data);
      return {
        fileName: path.basename(file.path),
        path: file.path,
        size: file.size,
        ...parsed,
      };
    }));

    return {
      source: data.source,
      filesFound: files.length,
      files: parsedFiles,
      // If single file, also expose data directly for easy chaining
      data: parsedFiles.length === 1 ? parsedFiles[0].data : parsedFiles.map(f => f.data),
      timestamp: new Date().toISOString(),
    };
  }

  private async readFromBasket(data: FileReadData, context: ExecutionContext): Promise<any[]> {
    const pattern = data.filePattern || '*.*';
    const fileStatus = data.fileStatus || 'open';
    const sessionSource = data.sessionSource || 'auto';

    // Check if filePattern is a variable reference like {{currentFile}}
    const varMatch = pattern.match(/^\{\{(.+?)\}\}$/);
    if (varMatch) {
      const varName = varMatch[1];
      const loopItem = context.variables.get(varName) as any;
      if (loopItem && loopItem.path) {
        const filePath = loopItem.path.startsWith('/') ? loopItem.path : '/' + loopItem.path;
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          return [{
            path: filePath,
            size: stats.size,
            fileId: loopItem.id || loopItem.fileId,
            sessionId: loopItem.sessionId,
          }];
        }
      }
    }

    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');

    // If basketId provided, read from database
    if (data.basketId) {
      const basket = await prisma.basket.findUnique({
        where: { id: data.basketId }
      });

      if (!basket) {
        throw new Error(`Basket not found: ${data.basketId}`);
      }

      // Session source logic
      if (sessionSource === 'trigger' || (sessionSource === 'auto' && context.variables.has('triggerFiles'))) {
        // Use files from basket-trigger context directly
        const triggerFiles = context.variables.get('triggerFiles') as any[];
        if (triggerFiles && Array.isArray(triggerFiles)) {
          const filtered = triggerFiles.filter(f => regex.test(f.fileName || path.basename(f.path)));
          return filtered.map(f => ({
            path: f.path.startsWith('/') ? f.path : '/' + f.path,
            size: f.size,
            fileId: f.id || f.fileId,
            sessionId: f.sessionId,
          }));
        }

        // Explicitly configured to read the triggering session, but there is no
        // trigger context — this is a manual Run. Falling through to the
        // whole-basket branch below would quietly read every historical file
        // that matches the pattern (for one import that is 35 files / 4.7 GB,
        // which exhausts the heap and kills the server process). Stop here and
        // let the caller report that there was nothing to read.
        if (sessionSource === 'trigger') {
          return [];
        }
      }

      if (sessionSource === 'latest') {
        // Get the latest session for this basket
        const latestSession = await prisma.processingSession.findFirst({
          where: { basketId: data.basketId },
          orderBy: { startedAt: 'desc' },
        });
        if (latestSession) {
          const basketFiles = await prisma.basketFile.findMany({
            where: { basketId: data.basketId, sessionId: latestSession.id },
            orderBy: { createdAt: 'desc' },
          });
          return basketFiles.filter(f => regex.test(f.fileName)).map(f => ({
            path: f.path.startsWith('/') ? f.path : '/' + f.path,
            size: f.size,
            fileId: f.id,
            sessionId: f.sessionId,
            originalName: f.originalName || f.fileName,
          }));
        }
        return [];
      }

      if (sessionSource === 'specific' && data.sessionId) {
        const basketFiles = await prisma.basketFile.findMany({
          where: { basketId: data.basketId, sessionId: data.sessionId },
          orderBy: { createdAt: 'desc' },
        });
        return basketFiles.filter(f => regex.test(f.fileName)).map(f => ({
          path: f.path.startsWith('/') ? f.path : '/' + f.path,
          size: f.size,
          fileId: f.id,
          sessionId: f.sessionId,
          originalName: f.originalName || f.fileName,
        }));
      }

      // 'all' or default: get all files from basket with status filter
      const statusFilter = fileStatus === 'all'
        ? ['open', 'active', 'published', 'uploaded', 'pending']
        : fileStatus === 'open'
          ? ['open', 'active', 'uploaded', 'pending']
          : [fileStatus];

      const basketFiles = await prisma.basketFile.findMany({
        where: {
          basketId: data.basketId,
          status: { in: statusFilter },
        },
        orderBy: { createdAt: 'desc' }
      });

      const filteredFiles = basketFiles.filter(f => regex.test(f.fileName));

      return filteredFiles.map(f => ({
        path: f.path.startsWith('/') ? f.path : '/' + f.path,
        size: f.size,
        fileId: f.id,
        sessionId: f.sessionId,
        originalName: f.originalName || f.fileName,
      }));
    }

    // Legacy: read from basketPath directly
    const basketPath = data.basketPath || '/data/incoming';

    if (!fs.existsSync(basketPath)) {
      return [];
    }

    const files = fs.readdirSync(basketPath);

    return files
      .filter(f => regex.test(f))
      .map(f => {
        const fullPath = path.join(basketPath, f);
        const stats = fs.statSync(fullPath);
        return {
          path: fullPath,
          size: stats.size,
        };
      });
  }

  private async readFromSFTP(data: FileReadData, _context: ExecutionContext): Promise<any[]> {
    if (!data.sftpConnectionId) {
      throw new Error('SFTP connection ID required');
    }
    if (!data.sftpRemotePath) {
      throw new Error('SFTP remote path required');
    }

    const connection = await prisma.connection.findUnique({
      where: { id: data.sftpConnectionId }
    });
    
    if (!connection) {
      throw new Error(`Connection not found: ${data.sftpConnectionId}`);
    }

    const config = typeof connection.config === 'string' 
      ? JSON.parse(connection.config) 
      : connection.config;

    const remotePath = this.resolveTemplate(data.sftpRemotePath, _context);
    const localTemp = `/tmp/sftp-${Date.now()}`;
    fs.mkdirSync(localTemp, { recursive: true });

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const files: any[] = [];
      
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          const isFile = remotePath.includes('.');
          
          if (isFile) {
            // Download single file
            const localFile = path.join(localTemp, path.posix.basename(remotePath));
            const readStream = sftp.createReadStream(remotePath);
            const writeStream = fs.createWriteStream(localFile);

            readStream.on('error', (err: Error) => {
              conn.end();
              reject(new Error(`Cannot read remote file ${remotePath}: ${err.message}`));
            });
            
            writeStream.on('finish', () => {
              const stats = fs.statSync(localFile);
              files.push({ path: localFile, size: stats.size });
              conn.end();
              resolve(files);
            });
            
            writeStream.on('error', (err) => {
              conn.end();
              reject(err);
            });
            
            readStream.pipe(writeStream);
          } else {
            // List and download directory
            sftp.readdir(remotePath, (err, list) => {
              if (err) {
                conn.end();
                return reject(err);
              }

              const pattern = data.filePattern || '*.*';
              const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
              const matchingFiles = list.filter(f => regex.test(f.filename) && !f.attrs.isDirectory());

              let completed = 0;
              if (matchingFiles.length === 0) {
                conn.end();
                resolve([]);
                return;
              }

              matchingFiles.forEach(file => {
                const remoteFile = path.posix.join(remotePath, file.filename);
                const localFile = path.join(localTemp, file.filename);
                const readStream = sftp.createReadStream(remoteFile);
                const writeStream = fs.createWriteStream(localFile);

                readStream.on('error', (err: Error) => {
                  conn.end();
                  reject(new Error(`Cannot read remote file ${remoteFile}: ${err.message}`));
                });

                writeStream.on('finish', () => {
                  files.push({ path: localFile, size: file.attrs.size });
                  completed++;
                  if (completed === matchingFiles.length) {
                    conn.end();
                    resolve(files);
                  }
                });

                writeStream.on('error', (err) => {
                  conn.end();
                  reject(err);
                });

                readStream.pipe(writeStream);
              });
            });
          }
        });
      });

      conn.on('error', reject);

      const connectConfig: any = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 20000,
      };
      if (config.privateKey) connectConfig.privateKey = config.privateKey;
      else if (config.password) connectConfig.password = config.password;
      
      conn.connect(connectConfig);
    });
  }

  private async readFromLocal(data: FileReadData, context: ExecutionContext): Promise<any[]> {
    const filePath = data.localPath 
      ? this.resolveTemplate(data.localPath, context)
      : '';
    
    if (!filePath || !fs.existsSync(filePath)) {
      return [];
    }

    const stats = fs.statSync(filePath);
    return [{ path: filePath, size: stats.size }];
  }

  private readFromInput(context: ExecutionContext): any[] {
    const input = context.input as any;
    
    // From SFTP download or HTTP download
    if (input?.downloads && Array.isArray(input.downloads)) {
      const files = input.downloads
        .filter((d: any) => d.success && d.localPath && fs.existsSync(d.localPath))
        .map((d: any) => ({
          path: d.localPath,
          size: fs.statSync(d.localPath).size,
        }));
      if (files.length > 0) return files;
    }
    
    // From single file path
    if (input?.localPath && fs.existsSync(input.localPath)) {
      const stats = fs.statSync(input.localPath);
      return [{ path: input.localPath, size: stats.size }];
    }
    if (input?.path && fs.existsSync(input.path)) {
      const stats = fs.statSync(input.path);
      return [{ path: input.path, size: stats.size }];
    }
    
    // From HTTP response (text content) - support inline content parsing
    if (input?.data && typeof input.data === 'string') {
      // HTTP response body as text (CSV, JSON, etc.)
      return [{ 
        path: 'inline://from-http-response', 
        size: input.data.length,
        content: input.data  // Pass content directly
      }];
    }
    
    return [];
  }

  private async parseFile(file: any, data: FileReadData): Promise<any> {
    if (data.parseAs === 'list') {
      // Return file metadata only (no content reading)
      return {
        data: {
          fileName: path.basename(file.path),
          path: file.path,
          size: file.size,
          fileId: file.fileId,
          sessionId: file.sessionId,
        },
        format: 'list',
      };
    }

    if (data.parseAs === 'raw') {
      const rawData = file.content || fs.readFileSync(file.path);
      return { data: rawData, format: 'raw' };
    }

    // Support inline content from HTTP response or read from file
    const content = file.content || fs.readFileSync(file.path, (data.encoding || 'utf-8') as BufferEncoding);
    // Prefer file extension when path is available (xlsx etc. need binary parsing). Only fall back to ".txt"
    // if there's truly no path (pure inline HTTP body, no extension to infer from).
    const ext = file.path
      ? path.extname(file.path).toLowerCase()
      : (file.content ? '.txt' : '');
    
    // Auto-detect format
    let format = data.parseAs;
    if (format === 'auto') {
      if (ext === '.csv') format = 'csv';
      else if (ext === '.tsv') format = 'tsv';
      else if (ext === '.json') format = 'json';
      else if (ext === '.xlsx' || ext === '.xlsm') format = 'xlsx';
      else format = 'txt';
    }

    let parsedData: any;
    let rowCount = 0;

    // Parse custom headers if provided
    const customHeaders = data.customHeaders 
      ? data.customHeaders.split(',').map(h => h.trim()) 
      : undefined;

    switch (format) {
      case 'csv':
        parsedData = parseCSV(
          content.toString(), 
          data.delimiter || ',', 
          data.hasHeader !== false,  // default true
          customHeaders
        );
        rowCount = parsedData.length;
        break;
      case 'tsv':
        parsedData = parseCSV(
          content.toString(), 
          data.delimiter || '\t', 
          data.hasHeader !== false,
          customHeaders
        );
        rowCount = parsedData.length;
        break;
      case 'json':
        parsedData = JSON.parse(content.toString());
        rowCount = Array.isArray(parsedData) ? parsedData.length : 1;
        break;
      case 'xlsx': {
        // Ensure we have a Buffer (binary content) — if content is a string for any reason, re-read from disk
        const buf: Buffer = Buffer.isBuffer(content) ? content : fs.readFileSync(file.path);
        parsedData = await parseXLSX(
          buf,
          data.hasHeader !== false,
          customHeaders,
          (data as any).sheetName
        );
        rowCount = parsedData.length;
        break;
      }
      case 'txt':
      default:
        parsedData = parseTXT(content.toString());
        rowCount = parsedData.length;
        break;
    }

    // Apply max rows
    if (data.maxRows && data.maxRows > 0 && Array.isArray(parsedData)) {
      parsedData = parsedData.slice(0, data.maxRows);
      rowCount = parsedData.length;
    }

    return {
      format,
      rowCount,
      data: parsedData,
      headers: Array.isArray(parsedData) && parsedData.length > 0 && typeof parsedData[0] === 'object' 
        ? Object.keys(parsedData[0]) 
        : null,
    };
  }

  protected resolveTemplate(template: string, context: ExecutionContext): string {
    if (!template.includes('{{')) return template;
    
    return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const keys = path.trim().split('.');
      let value: any = context;
      for (const key of keys) {
        value = value?.[key];
      }
      return value !== undefined ? String(value) : match;
    });
  }
}
