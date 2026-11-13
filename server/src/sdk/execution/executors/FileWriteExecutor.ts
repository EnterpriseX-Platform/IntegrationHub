// File Write Executor - Create files and save to Basket/SFTP/Local

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';

const prisma = new PrismaClient();

interface FileWriteData {
  // Data source
  dataSource: 'input' | 'template';
  dataPath?: string;        // e.g., "input.data", "db.rows"
  template?: string;        // For custom text output

  // Output format
  format: 'csv' | 'tsv' | 'json' | 'txt' | 'xlsx' | 'delimited' | 'zip';
  delimiter?: string;
  includeHeader?: boolean;
  columns?: string[];       // Specific column names for header

  // File naming
  fileName: string;         // {{timestamp}}, {{date}}, {{input.fileName}}

  // Destination
  destination: 'basket' | 'sftp' | 'local';

  // Basket options (when destination = 'basket')
  basketId?: string;        // Basket ID to write to
  basketType?: 'batch' | 'shares' | 'sftp';  // Basket type
  targetFolder?: string;    // Target folder for shares basket
  basketMode?: 'auto' | 'manual';  // Auto-create session or use manual
  customSessionName?: string;      // Optional custom session name
  autoPublish?: boolean;    // Auto publish session after file write
  clearFiles?: boolean;     // Clear existing files before writing
  sessionMode?: 'always_new' | 'existing_or_new' | 'reuse_existing';  // Session handling strategy
  sessionNamePattern?: string;  // Pattern for auto-generating session name

  // Content type & encoding
  contentType?: 'auto' | string;  // MIME type for the file, or 'auto' to detect from extension
  encoding?: string;  // File encoding (utf8, tis620, windows-874, etc.)

  // SFTP options (when destination = 'sftp')
  sftpConnectionId?: string;
  sftpRemotePath?: string;

  // Local options (when destination = 'local')
  localPath?: string;

  // ZIP options (when format = 'zip')
  sourceBasketId?: string;        // Basket to collect files from (defaults to input download basket)
  sourceSessionId?: string;       // Session to collect files from (defaults to latest/input session)
  sourceFolder?: string;          // Folder path to zip (for shares basket or local files)
  zipFilePattern?: string;        // Glob pattern to filter files (e.g., "*.csv", default: "*")
  compressionLevel?: number;      // 0-9, default: 6

  // XLSX options (when format = 'xlsx')
  headerMapping?: Record<string, string>;  // DB column → display header (e.g., DEPT_CODE → รหัส)
  sheetName?: string;             // Sheet tab name (default: 'Sheet1')
  sheets?: Array<{                // Multi-sheet support
    name: string;
    dataVar: string;              // Reference to context variable
    columns?: string[];
    headerMapping?: Record<string, string>;
  }>;
  autoFitColumns?: boolean;       // Auto-calculate column widths (default: true)
  freezeHeader?: boolean;         // Freeze first row (default: true)
}

export class FileWriteExecutor extends NodeExecutor {
  readonly type = 'file-write';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as FileWriteData;

    // Handle ZIP format separately — collect files and compress
    if (data.format === 'zip') {
      return this.executeZipWrite(node, data, context);
    }

    // Handle XLSX format separately — async binary workbook generation
    if (data.format === 'xlsx') {
      return this.executeXlsxWrite(node, data, context);
    }

    // Get source data
    let sourceData: any;
    if (data.dataSource === 'template' && data.template) {
      sourceData = this.resolveTemplate(data.template, context);
    } else {
      // Try dataPath first, then fallback to input directly
      const dataPath = data.dataPath || 'input.data';
      sourceData = this.getDataFromPath(context, dataPath);
      // If not found and dataPath is 'input.data', try 'input' directly
      if (!sourceData && dataPath === 'input.data') {
        sourceData = this.getDataFromPath(context, 'input');
      }
      // If sourceData has rows (database result), use rows
      if (sourceData && sourceData.rows) {
        sourceData = sourceData.rows;
      }
    }

    // Allow empty data - will create file with headers only
    if (!sourceData) {
      sourceData = [];
    }

    // Map/reorder fields according to columns config if specified
    if (data.columns && data.columns.length > 0 && Array.isArray(sourceData)) {
      sourceData = sourceData.map((row: any) => {
        const mappedRow: any = {};
        for (const col of data.columns!) {
          // Try exact match first, then case-insensitive match
          if (row.hasOwnProperty(col)) {
            mappedRow[col] = row[col];
          } else {
            // Try case-insensitive match
            const key = Object.keys(row).find(k => k.toLowerCase() === col.toLowerCase());
            mappedRow[col] = key !== undefined ? row[key] : '';
          }
        }
        return mappedRow;
      });
    }

    // Generate content
    const { content, extension } = this.generateContent(sourceData, data);

    // Generate file name
    const nowDt = new Date();
    const timestamp = Date.now().toString();
    const date = nowDt.toISOString().split('T')[0]; // YYYY-MM-DD
    const YYYY = String(nowDt.getFullYear());
    const MM = String(nowDt.getMonth() + 1).padStart(2, '0');
    const DD = String(nowDt.getDate()).padStart(2, '0');
    const HH = String(nowDt.getHours()).padStart(2, '0');
    const mm = String(nowDt.getMinutes()).padStart(2, '0');
    const ss = String(nowDt.getSeconds()).padStart(2, '0');
    const YYYYMMDD = `${YYYY}${MM}${DD}`;     // 20260518
    const HHmm = `${HH}${mm}`;                 // 1335
    const HHmmss = `${HH}${mm}${ss}`;          // 133538
    const time = HHmmss;                       // backward-compat
    const datetime = `${YYYYMMDD}_${HHmmss}`;  // 20260518_133538
    const buddhistYearN = parseInt(YYYY) + 543;
    let fileName = data.fileName
      .replace(/\{\{timestamp\}\}/g, timestamp)
      .replace(/\{\{datetime\}\}/g, datetime)
      .replace(/\{\{YYYYMMDD\}\}/g, YYYYMMDD)
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{HHmmss\}\}/g, HHmmss)
      .replace(/\{\{HHmm\}\}/g, HHmm)
      .replace(/\{\{time\}\}/g, time)
      .replace(/\{\{YYYY\}\}/g, YYYY)
      .replace(/\{\{MM\}\}/g, MM)
      .replace(/\{\{DD\}\}/g, DD)
      .replace(/\{\{HH\}\}/g, HH)
      .replace(/\{\{mm\}\}/g, mm)
      .replace(/\{\{ss\}\}/g, ss)
      .replace(/\{\{year\}\}/g, YYYY)
      .replace(/\{\{buddhistYear\}\}/g, String(buddhistYearN))
      .replace(/\{\{BYYYY\}\}/g, String(buddhistYearN))
      .replace(/\{\{extension\}\}/g, extension);
    // Resolve any {{vars.*}} / {{nodeName.*}} templates as well
    fileName = this.resolveTemplate(fileName, context);

    // Determine destination path
    let result: any;

    switch (data.destination) {
      case 'sftp':
        result = await this.writeToSFTP(content, fileName, data, context);
        break;
      case 'local':
        const localDestPath = data.localPath || '/tmp';
        result = this.writeToLocal(content, path.join(localDestPath, fileName));
        break;
      case 'basket':
      default:
        if (!data.basketId) {
          throw new Error('Basket ID is required when destination is basket');
        }
        result = await this.writeToBasket(content, fileName, data, context);
        break;
    }

    return {
      destination: data.destination,
      format: data.format,
      fileName,
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * ZIP format: Collect files from a source basket/session/folder and compress into a ZIP file,
   * then write to the destination basket (shares with folder) / sftp / local.
   */
  private async executeZipWrite(_node: ExecutionNode, data: FileWriteData, context: ExecutionContext): Promise<any> {
    // Resolve file name with date/year placeholders
    const now = new Date();
    const timestamp = Date.now().toString();
    const date = now.toISOString().split('T')[0];
    const year = now.getFullYear();
    const buddhistYear = year + 543;
    const YYYY = String(year);
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const YYYYMMDD = `${YYYY}${MM}${DD}`;
    const HHmm = `${HH}${mm}`;
    const HHmmss = `${HH}${mm}${ss}`;
    const datetime = `${YYYYMMDD}_${HHmmss}`;

    let fileName = data.fileName
      .replace(/\{\{timestamp\}\}/g, timestamp)
      .replace(/\{\{datetime\}\}/g, datetime)
      .replace(/\{\{YYYYMMDD\}\}/g, YYYYMMDD)
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{HHmmss\}\}/g, HHmmss)
      .replace(/\{\{HHmm\}\}/g, HHmm)
      .replace(/\{\{time\}\}/g, HHmmss)
      .replace(/\{\{YYYY\}\}/g, YYYY)
      .replace(/\{\{MM\}\}/g, MM)
      .replace(/\{\{DD\}\}/g, DD)
      .replace(/\{\{HH\}\}/g, HH)
      .replace(/\{\{mm\}\}/g, mm)
      .replace(/\{\{ss\}\}/g, ss)
      .replace(/\{\{extension\}\}/g, 'zip')
      .replace(/\{\{year\}\}/g, String(year))
      .replace(/\{\{buddhistYear\}\}/g, String(buddhistYear))
      .replace(/\{\{BYYYY\}\}/g, String(buddhistYear));

    // Also resolve any {{vars.*}} or {{nodeName.*}} templates
    fileName = this.resolveTemplate(fileName, context);

    // Ensure .zip extension
    if (!fileName.toLowerCase().endsWith('.zip')) {
      fileName += '.zip';
    }

    // Resolve targetFolder with year/date placeholders
    let targetFolder = data.targetFolder || '';
    if (targetFolder) {
      targetFolder = targetFolder
        .replace(/\{YYYY\+543\}/g, String(buddhistYear))
        .replace(/\{BYYYY\}/g, String(buddhistYear))
        .replace(/\{YYYY\}/g, String(year))
        .replace(/\{YY\}/g, String(year).slice(-2))
        .replace(/\{BYY\}/g, String(buddhistYear).slice(-2))
        .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
        .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'))
        .replace(/\{YYYYMMDD\}/g, now.toISOString().split('T')[0].replace(/-/g, ''));
      targetFolder = this.resolveTemplate(targetFolder, context);
    }

    // Collect files to zip
    const filesToZip = await this.collectFilesForZip(data, context);

    if (filesToZip.length === 0) {
      console.log('[FileWrite/ZIP] No files found to zip');
      return {
        destination: data.destination,
        format: 'zip',
        fileName,
        filesCollected: 0,
        status: 'empty',
        message: 'No files found to zip',
        timestamp: now.toISOString(),
      };
    }

    console.log(`[FileWrite/ZIP] Zipping ${filesToZip.length} files into ${fileName}`);

    // Create ZIP in temp location
    const tempZipPath = path.join('/tmp', `zip_${timestamp}_${fileName}`);
    await this.createZipFile(filesToZip, tempZipPath, data.compressionLevel);
    const zipStats = fs.statSync(tempZipPath);
    const zipContent = fs.readFileSync(tempZipPath);

    console.log(`[FileWrite/ZIP] ZIP created: ${zipStats.size} bytes (${filesToZip.length} files)`);

    // Write ZIP to destination
    let result: any;

    // Override targetFolder with resolved version
    const resolvedData = { ...data, targetFolder };

    switch (data.destination) {
      case 'sftp':
        result = await this.writeToSFTP(zipContent, fileName, resolvedData, context);
        break;
      case 'local':
        const localDestPath = data.localPath || '/tmp';
        const finalLocalPath = path.join(localDestPath, targetFolder, fileName);
        result = this.writeToLocal(zipContent, finalLocalPath);
        break;
      case 'basket':
      default:
        if (!data.basketId) {
          throw new Error('Basket ID is required when destination is basket');
        }
        result = await this.writeToBasket(zipContent, fileName, resolvedData, context);
        break;
    }

    // Clean up temp file
    try { fs.unlinkSync(tempZipPath); } catch (_e) { /* ignore */ }

    return {
      destination: data.destination,
      format: 'zip',
      fileName,
      targetFolder: targetFolder || undefined,
      filesCollected: filesToZip.length,
      fileNames: filesToZip.map(f => f.name),
      zipSize: zipStats.size,
      ...result,
      timestamp: now.toISOString(),
    };
  }

  /**
   * Collect files to include in the ZIP:
   * 1. From sourceBasketId + sourceSessionId (basket files from a download session)
   * 2. From previous node's download output (auto-detect from context.input)
   * 3. From sourceFolder (local directory)
   */
  private async collectFilesForZip(data: FileWriteData, context: ExecutionContext): Promise<Array<{ name: string; path: string }>> {
    const files: Array<{ name: string; path: string }> = [];
    const pattern = data.zipFilePattern || '*';

    // Method 1: Explicit sourceBasketId
    if (data.sourceBasketId) {
      const basket = await prisma.basket.findUnique({ where: { id: data.sourceBasketId } });
      if (!basket) throw new Error(`Source basket not found: ${data.sourceBasketId}`);

      let sessionId = data.sourceSessionId;

      // If no sessionId, try to get from input (previous sftp-action download output)
      if (!sessionId && (context.input as any)?.sessionId) {
        sessionId = (context.input as any).sessionId;
      }

      // If still no sessionId, find the latest session
      if (!sessionId) {
        const latestSession = await prisma.processingSession.findFirst({
          where: { basketId: data.sourceBasketId },
          orderBy: { startedAt: 'desc' }
        });
        if (latestSession) sessionId = latestSession.id;
      }

      // Get basket files
      const where: any = { basketId: data.sourceBasketId };
      if (sessionId) where.sessionId = sessionId;

      const basketFiles = await prisma.basketFile.findMany({ where, orderBy: { createdAt: 'asc' } });
      for (const bf of basketFiles) {
        if (this.matchPattern(bf.fileName, pattern) && fs.existsSync(bf.path)) {
          files.push({ name: bf.fileName, path: bf.path });
        }
      }
      return files;
    }

    // Method 2: Auto-detect from input (previous sftp-action download output)
    const input = context.input as any;
    if (input?.downloads && Array.isArray(input.downloads)) {
      for (const dl of input.downloads) {
        if (dl.success && dl.localPath && fs.existsSync(dl.localPath)) {
          if (this.matchPattern(dl.fileName, pattern)) {
            files.push({ name: dl.fileName, path: dl.localPath });
          }
        }
      }
      if (files.length > 0) return files;
    }

    // Also check basketPath from input (sftp-action stores downloaded files here)
    if (input?.basketPath || input?.basketId) {
      const inputBasketId = input.basketId || data.sourceBasketId;
      const inputSessionId = input.sessionId || data.sourceSessionId;
      if (inputBasketId) {
        const where: any = { basketId: inputBasketId };
        if (inputSessionId) where.sessionId = inputSessionId;
        const basketFiles = await prisma.basketFile.findMany({ where, orderBy: { createdAt: 'asc' } });
        for (const bf of basketFiles) {
          if (this.matchPattern(bf.fileName, pattern) && fs.existsSync(bf.path)) {
            files.push({ name: bf.fileName, path: bf.path });
          }
        }
        if (files.length > 0) return files;
      }
    }

    // Method 3: sourceFolder (local directory scan)
    if (data.sourceFolder) {
      const resolvedFolder = this.resolveTemplate(data.sourceFolder, context);
      if (fs.existsSync(resolvedFolder) && fs.statSync(resolvedFolder).isDirectory()) {
        const entries = fs.readdirSync(resolvedFolder);
        for (const entry of entries) {
          const fullPath = path.join(resolvedFolder, entry);
          if (fs.statSync(fullPath).isFile() && this.matchPattern(entry, pattern)) {
            files.push({ name: entry, path: fullPath });
          }
        }
      }
    }

    return files;
  }

  /**
   * Create a ZIP file from a list of file paths using archiver
   */
  private async createZipFile(
    files: Array<{ name: string; path: string }>,
    outputPath: string,
    compressionLevel: number = 6
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
   * XLSX format: Generate Excel workbook and write to destination
   */
  private async executeXlsxWrite(_node: ExecutionNode, data: FileWriteData, context: ExecutionContext): Promise<any> {
    // Get source data (same logic as main executeNode)
    let sourceData: any;
    if (data.dataSource === 'template' && data.template) {
      sourceData = this.resolveTemplate(data.template, context);
    } else {
      const dataPath = data.dataPath || 'input.data';
      sourceData = this.getDataFromPath(context, dataPath);
      if (!sourceData && dataPath === 'input.data') {
        sourceData = this.getDataFromPath(context, 'input');
      }
      if (sourceData && sourceData.rows) {
        sourceData = sourceData.rows;
      }
    }
    if (!sourceData) sourceData = [];

    // Map/reorder columns if specified
    if (data.columns && data.columns.length > 0 && Array.isArray(sourceData)) {
      sourceData = sourceData.map((row: any) => {
        const mappedRow: any = {};
        for (const col of data.columns!) {
          if (row.hasOwnProperty(col)) {
            mappedRow[col] = row[col];
          } else {
            const key = Object.keys(row).find(k => k.toLowerCase() === col.toLowerCase());
            mappedRow[col] = key !== undefined ? row[key] : '';
          }
        }
        return mappedRow;
      });
    }

    // Generate XLSX buffer
    const content = await this.generateXlsxContent(sourceData, data, context);

    // Generate file name — resolve context variables first, then built-in placeholders
    const now = new Date();
    const timestamp = Date.now().toString();
    const date = now.toISOString().split('T')[0];
    const YYYY = String(now.getFullYear());
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const YYYYMMDD = `${YYYY}${MM}${DD}`;
    const HHmm = `${HH}${mm}`;
    const HHmmss = `${HH}${mm}${ss}`;
    const time = HHmmss;
    const datetime = `${YYYYMMDD}_${HHmmss}`;
    const buddhistYearN = parseInt(YYYY) + 543;
    let fileName = this.resolveTemplate(data.fileName, context);
    if (typeof fileName === 'string') {
      fileName = fileName
        .replace(/\{\{timestamp\}\}/g, timestamp)
        .replace(/\{\{datetime\}\}/g, datetime)
        .replace(/\{\{YYYYMMDD\}\}/g, YYYYMMDD)
        .replace(/\{\{date\}\}/g, date)
        .replace(/\{\{HHmmss\}\}/g, HHmmss)
        .replace(/\{\{HHmm\}\}/g, HHmm)
        .replace(/\{\{time\}\}/g, time)
        .replace(/\{\{YYYY\}\}/g, YYYY)
        .replace(/\{\{MM\}\}/g, MM)
        .replace(/\{\{DD\}\}/g, DD)
        .replace(/\{\{HH\}\}/g, HH)
        .replace(/\{\{mm\}\}/g, mm)
        .replace(/\{\{ss\}\}/g, ss)
        .replace(/\{\{year\}\}/g, YYYY)
        .replace(/\{\{buddhistYear\}\}/g, String(buddhistYearN))
        .replace(/\{\{BYYYY\}\}/g, String(buddhistYearN))
        .replace(/\{\{extension\}\}/g, 'xlsx');
    }

    // Write to destination
    let result: any;
    switch (data.destination) {
      case 'sftp':
        result = await this.writeToSFTP(content, fileName, data, context);
        break;
      case 'local':
        const localDestPath = data.localPath || '/tmp';
        result = this.writeToLocal(content, path.join(localDestPath, fileName));
        break;
      case 'basket':
      default:
        if (!data.basketId) throw new Error('Basket ID is required when destination is basket');
        result = await this.writeToBasket(content, fileName, data, context);
        break;
    }

    this.log(context, 'info', `Generated XLSX file: ${fileName}`);

    return {
      destination: data.destination,
      format: 'xlsx',
      fileName,
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  private async generateXlsxContent(sourceData: any[], config: FileWriteData, context: ExecutionContext): Promise<Buffer> {
    const ExcelJS = require('exceljs');

    // Collect all sheets to write
    const sheetsToWrite: Array<{
      name: string;
      data: any[];
      columns?: string[];
      headerMapping?: Record<string, string>;
    }> = [];

    if (config.sheets && config.sheets.length > 0) {
      // Multi-sheet mode
      for (const sheetConfig of config.sheets) {
        let sheetData = context.variables.get(sheetConfig.dataVar);
        if (sheetData && sheetData.rows) sheetData = sheetData.rows;
        if (!Array.isArray(sheetData)) sheetData = sheetData ? [sheetData] : [];
        sheetsToWrite.push({
          name: sheetConfig.name,
          data: sheetData,
          columns: sheetConfig.columns,
          headerMapping: sheetConfig.headerMapping || config.headerMapping,
        });
      }
    } else {
      // Single-sheet mode
      sheetsToWrite.push({
        name: config.sheetName || 'Sheet1',
        data: sourceData,
        columns: config.columns,
        headerMapping: config.headerMapping,
      });
    }

    // Check total row count to decide streaming vs in-memory
    const totalRows = sheetsToWrite.reduce((sum, s) => sum + s.data.length, 0);
    const STREAMING_THRESHOLD = 10000;

    if (totalRows > STREAMING_THRESHOLD) {
      return this.generateXlsxStreaming(sheetsToWrite, config);
    }

    // In-memory mode for small datasets
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DEH';
    workbook.created = new Date();

    for (const sheet of sheetsToWrite) {
      this.addXlsxSheet(workbook, sheet.name, sheet.data, {
        columns: sheet.columns,
        headerMapping: sheet.headerMapping,
        includeHeader: config.includeHeader,
        autoFitColumns: config.autoFitColumns,
        freezeHeader: config.freezeHeader,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Streaming XLSX generation for large datasets (>10K rows).
   * Uses ExcelJS WorkbookWriter to write rows incrementally without holding all in memory.
   */
  private async generateXlsxStreaming(
    sheets: Array<{ name: string; data: any[]; columns?: string[]; headerMapping?: Record<string, string> }>,
    config: FileWriteData
  ): Promise<Buffer> {
    const ExcelJS = require('exceljs');
    const { PassThrough } = require('stream');

    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });
    workbook.creator = 'DEH';
    workbook.created = new Date();

    for (const sheet of sheets) {
      const data = sheet.data;
      if (!Array.isArray(data)) continue;

      const fieldNames = sheet.columns && sheet.columns.length > 0
        ? sheet.columns
        : (data.length > 0 ? Object.keys(data[0]) : []);

      const headerMapping = sheet.headerMapping || {};

      // Build case-insensitive key map from first row for efficient lookup
      let keyMap: Record<string, string> = {};
      if (data.length > 0) {
        for (const k of Object.keys(data[0])) {
          keyMap[k.toLowerCase()] = k;
        }
      }

      // Estimate column widths from header + first 200 rows (sample)
      const colWidths: number[] = fieldNames.map((f: string) => {
        const header = headerMapping[f] || f;
        return header.length;
      });

      const sampleSize = Math.min(data.length, 200);
      for (let i = 0; i < sampleSize; i++) {
        const row = data[i];
        for (let c = 0; c < fieldNames.length; c++) {
          const field = fieldNames[c];
          const val = row[field] ?? row[keyMap[field.toLowerCase()]] ?? '';
          const len = val != null ? String(val).length : 0;
          if (len > colWidths[c]) colWidths[c] = len;
        }
      }

      const worksheet = workbook.addWorksheet(sheet.name, {
        views: config.freezeHeader !== false ? [{ state: 'frozen', ySplit: 1 }] : undefined,
      });

      // Set columns with pre-calculated widths
      worksheet.columns = fieldNames.map((field: string, i: number) => ({
        header: config.includeHeader !== false ? (headerMapping[field] || field) : undefined,
        key: field,
        width: config.autoFitColumns !== false
          ? Math.min(Math.max(Math.ceil(colWidths[i] * 1.3) + 2, 10), 60)
          : undefined,
      }));

      // Style header row
      if (config.includeHeader !== false && fieldNames.length > 0) {
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.eachCell((cell: any) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
          cell.border = { bottom: { style: 'thin' } };
        });
        headerRow.commit();
      }

      // Stream data rows
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowValues: any[] = [];
        for (const field of fieldNames) {
          const val = row[field] ?? row[keyMap[field.toLowerCase()]] ?? '';
          rowValues.push(val);
        }
        // addRow with array is faster than object
        const wsRow = worksheet.addRow(rowValues);
        wsRow.commit();

        // Log progress every 50K rows
        if ((i + 1) % 50000 === 0) {
          console.log(`[FileWriteExecutor] Sheet "${sheet.name}": ${i + 1}/${data.length} rows written`);
        }
      }

      await worksheet.commit();
    }

    await workbook.commit();

    return Buffer.concat(chunks);
  }

  private addXlsxSheet(
    workbook: any,
    sheetName: string,
    data: any[],
    options: {
      columns?: string[];
      headerMapping?: Record<string, string>;
      includeHeader?: boolean;
      autoFitColumns?: boolean;
      freezeHeader?: boolean;
    }
  ): void {
    const worksheet = workbook.addWorksheet(sheetName);
    if (!Array.isArray(data)) data = [data];

    // Determine field names
    const fieldNames = options.columns && options.columns.length > 0
      ? options.columns
      : (data.length > 0 ? Object.keys(data[0]) : []);

    const headerMapping = options.headerMapping || {};

    // Build case-insensitive key map for efficient lookup
    let keyMap: Record<string, string> = {};
    if (data.length > 0) {
      for (const k of Object.keys(data[0])) {
        keyMap[k.toLowerCase()] = k;
      }
    }

    // Set up columns
    worksheet.columns = fieldNames.map((field: string) => ({
      header: options.includeHeader !== false ? (headerMapping[field] || field) : undefined,
      key: field,
    }));

    // Add data rows — use direct key lookup instead of Object.keys().find() for each row
    for (const row of data) {
      const rowValues: any[] = [];
      for (const field of fieldNames) {
        const val = row[field] ?? row[keyMap[field.toLowerCase()]] ?? '';
        rowValues.push(val);
      }
      worksheet.addRow(rowValues);
    }

    // Style header row
    if (options.includeHeader !== false && fieldNames.length > 0) {
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell: any) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE8E8E8' },
        };
        cell.border = {
          bottom: { style: 'thin' },
        };
      });
    }

    // Auto-fit column widths — sample first 200 rows instead of all rows
    if (options.autoFitColumns !== false) {
      const sampleSize = Math.min(data.length, 200);
      worksheet.columns.forEach((column: any, colIdx: number) => {
        let maxLength = column.header ? String(column.header).length : 8;
        // Sample rows for width estimation
        for (let r = 0; r < sampleSize; r++) {
          const row = data[r];
          const field = fieldNames[colIdx];
          const val = row[field] ?? row[keyMap[field.toLowerCase()]] ?? '';
          const cellLength = val != null ? String(val).length : 0;
          maxLength = Math.max(maxLength, cellLength);
        }
        // Thai characters are wider — use 1.3x multiplier
        column.width = Math.min(Math.max(Math.ceil(maxLength * 1.3) + 2, 10), 60);
      });
    }

    // Freeze header row
    if (options.freezeHeader !== false) {
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
  }

  /**
   * Simple glob pattern matcher (supports * and ?)
   */
  private matchPattern(fileName: string, pattern: string): boolean {
    if (pattern === '*' || pattern === '*.*') return true;
    // Support comma-separated patterns (e.g. "S_ITEM.txt,S_ITEM.xlsx")
    const patterns = pattern.includes(',') ? pattern.split(',').map(p => p.trim()) : [pattern];
    return patterns.some(p => {
      const regex = new RegExp(
        '^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i'
      );
      return regex.test(fileName);
    });
  }

  private generateContent(data: any, config: FileWriteData): { content: string | Buffer; extension: string } {
    switch (config.format) {
      case 'csv':
        return { content: this.toCSV(data, config.delimiter || ',', config.includeHeader !== false, config.columns), extension: 'csv' };
      case 'tsv':
        return { content: this.toCSV(data, config.delimiter || '\t', config.includeHeader !== false, config.columns), extension: 'tsv' };
      case 'delimited':
        return { content: this.toCSV(data, config.delimiter || '|', config.includeHeader !== false, config.columns), extension: 'txt' };
      case 'json':
        return { content: JSON.stringify(data, null, 2), extension: 'json' };
      case 'txt':
      default:
        return { content: this.toTXT(data), extension: 'txt' };
    }
  }

  private toCSV(data: any, delimiter: string, includeHeader: boolean, customColumns?: string[]): string {
    if (!Array.isArray(data)) data = [data];

    // Use custom columns if provided, otherwise extract from data
    const headers = customColumns && customColumns.length > 0 
      ? customColumns 
      : (data.length > 0 ? Object.keys(data[0]) : []);
    
    // If no data and no headers, return empty
    if (data.length === 0 && headers.length === 0) return '';
    
    let csv = '';

    if (includeHeader) {
      csv += headers.join(delimiter) + '\n';
    }

    for (const row of data) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Escape delimiter, newline, and quotes
        if (str.includes(delimiter) || str.includes('\n') || str.includes('"')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      });
      csv += values.join(delimiter) + '\n';
    }

    return csv;
  }

  private toTXT(data: any): string {
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) {
      return data.map(row => {
        if (typeof row === 'object') {
          return Object.values(row).join(' | ');
        }
        return String(row);
      }).join('\n');
    }
    if (typeof data === 'object') {
      return Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    return String(data);
  }

  private writeToLocal(content: string | Buffer, filePath: string, encoding?: string): any {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const writeOptions = typeof content === 'string' ? { encoding: encoding as BufferEncoding || 'utf8' } : undefined;
    fs.writeFileSync(filePath, content, writeOptions);
    const stats = fs.statSync(filePath);
    return { path: filePath, size: stats.size };
  }

  private async writeToBasket(
    content: string | Buffer, 
    fileName: string, 
    data: FileWriteData, 
    context: ExecutionContext
  ): Promise<any> {
    if (!data.basketId) {
      throw new Error('Basket ID is required');
    }

    // Get basket info
    const basket = await prisma.basket.findUnique({
      where: { id: data.basketId }
    });

    if (!basket) {
      throw new Error(`Basket not found: ${data.basketId}`);
    }

    // Handle Shares basket (direct folder write)
    if (basket.type === 'shares' || data.basketType === 'shares') {
      return this.writeToSharesBasket(content, fileName, data, basket, context);
    }

    // Handle SFTP basket (direct write without session)
    if (basket.type === 'sftp' || data.basketType === 'sftp') {
      return this.writeToSftpBasket(content, fileName, data, basket, context);
    }

    // Find or create processing session based on sessionMode
    let sessionId: string;
    let batchName: string;

    const sessionMode = data.sessionMode || 'always_new';

    if (sessionMode === 'reuse_existing') {
      // Try to find any existing open session, fail if not found
      const existingSession = await prisma.processingSession.findFirst({
        where: { 
          basketId: data.basketId,
          status: 'open'
        },
        orderBy: { startedAt: 'desc' }
      });

      if (!existingSession) {
        throw new Error('No open session found for basket. Please create a session first or use different session mode.');
      }
      sessionId = existingSession.id;
      batchName = existingSession.batchName;

      // Clear files with same name if they exist
      await this.clearFilesByName(sessionId, fileName, data.basketId);

    } else if (sessionMode === 'existing_or_new') {
      // Resolve session pattern early — if it has {{var}} that resolved to specific
      // values (e.g. "2568-แผน"), we should reuse the session WITH THAT NAME, not
      // just any open session. This makes (year, round) → unique session.
      const rawPattern = data.sessionNamePattern || basket.sessionPattern || 'Batch-{YYYYMMDD}-{SEQ}';
      const resolvedPattern = typeof rawPattern === 'string' ? this.resolveTemplate(rawPattern, context) : rawPattern;
      // If pattern still contains unresolved {{...}}, fall back to "any open session"
      const hasUnresolvedTemplate = typeof resolvedPattern === 'string' && /\{\{[^}]+\}\}/.test(resolvedPattern);

      // Use serializable transaction to prevent race condition when parallel
      // branches (aggregate-split / condition fan-out) both try to find/create
      // session simultaneously. Wrap in a retry loop because Serializable will
      // throw P2034 / "write conflict or deadlock" on contention.
      const runTxn = async () => prisma.$transaction(async (tx) => {
        // If resolvedPattern has no date/seq placeholders, it's a STABLE name (e.g. "2568-แผน")
        // — find open session by that exact name. Otherwise, fall back to "any open session"
        const isStableName = typeof resolvedPattern === 'string'
          && !hasUnresolvedTemplate
          && !/\{[A-Za-z0-9+_]+\}/.test(resolvedPattern); // no {YYYY}, {SEQ}, etc.

        const existingSession = await tx.processingSession.findFirst({
          where: isStableName
            ? { basketId: data.basketId, status: 'open', batchName: resolvedPattern }
            : { basketId: data.basketId, status: 'open' },
          orderBy: { startedAt: 'desc' }
        });

        if (existingSession) {
          return { id: existingSession.id, batchName: existingSession.batchName, created: false };
        }

        // No open session — create one inside the same transaction
        if (!data.basketId) throw new Error('basketId is required for existing_or_new session mode');
        const pattern = resolvedPattern;
        const generatedName = await this.generateBatchNameWithSeq(pattern, data.basketId, pattern);

        // Ensure unique name
        let uniqueName = generatedName;
        let suffix = 1;
        while (await tx.processingSession.findFirst({
          where: { batchName: uniqueName, basketId: data.basketId }
        })) {
          uniqueName = `${generatedName}-${suffix}`;
          suffix++;
        }

        const sessionPath = path.join(basket.path, 'sessions', uniqueName);
        fs.mkdirSync(sessionPath, { recursive: true });

        const session = await tx.processingSession.create({
          data: {
            basketId: data.basketId,
            batchName: uniqueName,
            status: 'open',
            publishMode: basket.autoPublish === 'auto' ? 'auto' : 'manual',
            fileCount: 0,
            totalSize: 0
          }
        });

        await tx.sessionLog.create({
          data: {
            sessionId: session.id,
            type: 'session_created',
            message: `Processing session ${uniqueName} created (auto)`,
            metadata: JSON.stringify({ path: sessionPath, source: 'file-write' })
          }
        });

        return { id: session.id, batchName: uniqueName, created: true };
      }, { isolationLevel: 'Serializable' });

      // Retry on Serializable conflict (P2034 / write conflict / deadlock) — common when
      // condition fan-out runs N file-write nodes in parallel and they all race to
      // create the same session. Exponential backoff, up to 5 attempts.
      let result: { id: string; batchName: string; created: boolean } | undefined;
      let lastErr: any;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          result = await runTxn();
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e);
          const isConflict = msg.includes('write conflict') || msg.includes('deadlock') || msg.includes('P2034') || msg.includes('could not serialize');
          if (!isConflict) throw e;
          const backoffMs = 50 * attempt + Math.floor(Math.random() * 100);
          console.log(`[FileWrite] Session txn conflict (attempt ${attempt}/5), retrying in ${backoffMs}ms…`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
      if (!result) throw lastErr || new Error('Session creation failed after 5 retries');

      sessionId = result.id;
      batchName = result.batchName;

      if (!result.created) {
        // Reusing existing session — clear files with same name
        await this.clearFilesByName(sessionId, fileName, data.basketId);
      }

    } else {
      // always_new: Always create a new session
      const rawPattern = data.sessionNamePattern || basket.sessionPattern || 'Batch-{YYYYMMDD}-{SEQ}';
      const pattern = typeof rawPattern === 'string' ? this.resolveTemplate(rawPattern, context) : rawPattern;
      const generatedName = await this.generateBatchNameWithSeq(pattern, data.basketId);
      const session = await this.createProcessingSession(data.basketId, basket, generatedName);
      sessionId = session.id;
      batchName = session.batchName;
    }

    // Write file to session directory
    const sessionDir = path.join(basket.path, 'sessions', batchName);
    const filePath = path.join(sessionDir, fileName);
    
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    const writeOptions = typeof content === 'string' ? { encoding: data.encoding as BufferEncoding || 'utf8' } : undefined;
    fs.writeFileSync(filePath, content, writeOptions);
    const stats = fs.statSync(filePath);

    // Create BasketFile record
    const basketFile = await prisma.basketFile.create({
      data: {
        basketId: data.basketId,
        sessionId: sessionId,
        fileName: fileName,
        originalName: fileName,
        size: stats.size,
        mimeType: this.getMimeType(fileName, data.contentType),
        path: filePath,
        status: 'uploaded',
        metadata: JSON.stringify({
          source: 'flow',
          flowId: context.flow.operationId,
          generatedAt: new Date().toISOString()
        })
      }
    });

    // Update session file count and size
    await prisma.processingSession.update({
      where: { id: sessionId },
      data: {
        fileCount: { increment: 1 },
        totalSize: { increment: stats.size }
      }
    });

    // Log file creation
    await prisma.basketFileLog.create({
      data: {
        fileId: basketFile.id,
        action: 'file_created',
        status: 'success',
        message: `File ${fileName} created via flow`,
        metadata: JSON.stringify({ size: stats.size, sessionId, flowId: context.flow.operationId })
      }
    });



    // Auto-publish if configured (use node config or basket config)
    let publishResult = null;
    const shouldAutoPublish = data.autoPublish !== undefined ? data.autoPublish : basket.autoPublish === 'auto';
    if (shouldAutoPublish) {
      publishResult = await this.publishSession(sessionId, data.basketId);
    }

    return {
      basketId: data.basketId,
      basketName: basket.name,
      sessionId,
      sessionName: batchName,
      fileId: basketFile.id,
      filePath,
      size: stats.size,
      autoPublished: shouldAutoPublish,
      publishResult
    };
  }

  private async writeToSharesBasket(
    content: string | Buffer,
    fileName: string,
    data: FileWriteData,
    basket: any,
    context: ExecutionContext
  ): Promise<any> {
    // For shares basket, write directly to target folder
    const targetFolder = data.targetFolder || '';
    const sharesDir = path.join(basket.path, targetFolder);
    const filePath = path.join(sharesDir, fileName);
    
    // Ensure directory exists
    if (!fs.existsSync(sharesDir)) {
      fs.mkdirSync(sharesDir, { recursive: true });
    }
    
    // Write file with encoding
    const writeOptions = typeof content === 'string' ? { encoding: data.encoding as BufferEncoding || 'utf8' } : undefined;
    fs.writeFileSync(filePath, content, writeOptions);
    const stats = fs.statSync(filePath);

    // Create BasketFile record (no session for shares)
    const basketFile = await prisma.basketFile.create({
      data: {
        basketId: data.basketId!,
        sessionId: undefined,
        fileName: fileName,
        originalName: fileName,
        size: stats.size,
        mimeType: this.getMimeType(fileName, data.contentType),
        path: filePath,
        status: 'uploaded',
        metadata: JSON.stringify({
          source: 'flow',
          flowId: context.flow.operationId,
          targetFolder: targetFolder,
          generatedAt: new Date().toISOString()
        })
      }
    });

    // Log file creation
    await prisma.basketFileLog.create({
      data: {
        fileId: basketFile.id,
        action: 'file_created',
        status: 'success',
        message: `File ${fileName} created in shares basket${targetFolder ? ' folder: ' + targetFolder : ''}`,
        metadata: JSON.stringify({ size: stats.size, flowId: context.flow.operationId, targetFolder })
      }
    });

    return {
      basketId: data.basketId,
      basketName: basket.name,
      basketType: 'shares',
      targetFolder,
      fileId: basketFile.id,
      filePath,
      size: stats.size,
      timestamp: new Date().toISOString()
    };
  }

  private async writeToSftpBasket(
    content: string | Buffer,
    fileName: string,
    data: FileWriteData,
    basket: any,
    context: ExecutionContext
  ): Promise<any> {
    // For SFTP basket, write directly to basket path (no session, no folders)
    const sftpDir = basket.path;
    const filePath = path.join(sftpDir, fileName);
    
    // Ensure directory exists
    if (!fs.existsSync(sftpDir)) {
      fs.mkdirSync(sftpDir, { recursive: true });
    }
    
    // Write file with encoding
    const writeOptions = typeof content === 'string' ? { encoding: data.encoding as BufferEncoding || 'utf8' } : undefined;
    fs.writeFileSync(filePath, content, writeOptions);
    const stats = fs.statSync(filePath);

    // Create BasketFile record (no session for sftp)
    const basketFile = await prisma.basketFile.create({
      data: {
        basketId: data.basketId!,
        sessionId: undefined,
        fileName: fileName,
        originalName: fileName,
        size: stats.size,
        mimeType: this.getMimeType(fileName, data.contentType),
        path: filePath,
        status: 'uploaded',
        metadata: JSON.stringify({
          source: 'flow',
          flowId: context.flow.operationId,
          basketType: 'sftp',
          generatedAt: new Date().toISOString()
        })
      }
    });

    // Log file creation
    await prisma.basketFileLog.create({
      data: {
        fileId: basketFile.id,
        action: 'file_created',
        status: 'success',
        message: `File ${fileName} created in SFTP basket`,
        metadata: JSON.stringify({ size: stats.size, flowId: context.flow.operationId, basketType: 'sftp' })
      }
    });

    return {
      basketId: data.basketId,
      basketName: basket.name,
      basketType: 'sftp',
      fileId: basketFile.id,
      filePath,
      size: stats.size,
      timestamp: new Date().toISOString()
    };
  }

  private async createProcessingSession(
    basketId: string, 
    basket: any, 
    baseName: string
  ): Promise<{ id: string; batchName: string }> {
    // Handle {SEQ} placeholder - sequence reset logic (use basket's original pattern for reset logic)
    let finalBatchName = await this.processSequencePattern(baseName, basketId, baseName);

    // Ensure unique name
    let uniqueName = finalBatchName;
    let suffix = 1;
    while (await prisma.processingSession.findFirst({ 
      where: { batchName: uniqueName, basketId } 
    })) {
      uniqueName = `${finalBatchName}-${suffix}`;
      suffix++;
    }

    // Create session directory
    const sessionPath = path.join(basket.path, 'sessions', uniqueName);
    fs.mkdirSync(sessionPath, { recursive: true });

    // Create session record
    const session = await prisma.processingSession.create({
      data: {
        basketId,
        batchName: uniqueName,
        status: 'open',
        publishMode: basket.autoPublish === 'auto' ? 'auto' : 'manual',
        fileCount: 0,
        totalSize: 0
      }
    });

    // Log session creation
    await prisma.sessionLog.create({
      data: {
        sessionId: session.id,
        type: 'session_created',
        message: `Processing session ${uniqueName} created (auto)`,
        metadata: JSON.stringify({ path: sessionPath, source: 'file-write' })
      }
    });

    return { id: session.id, batchName: uniqueName };
  }

  // Use same logic as basket-sessions.ts
  private generateBatchName(pattern: string): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const year = now.getFullYear();
    const buddhistYear = year + 543; // พ.ศ.
    
    // Replace placeholders (same as basket-sessions.ts)
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
    
    // Handle sequence numbers (same as basket-sessions.ts)
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

  private async generateBatchNameWithSeq(pattern: string, basketId: string, originalPattern?: string): Promise<string> {
    let name = this.generateBatchName(pattern);
    name = await this.processSequencePattern(name, basketId, originalPattern || pattern);
    return name;
  }

  private async processSequencePattern(baseName: string, basketId: string, originalPattern: string): Promise<string> {
    // Check for {SEQ}, {N}, {NN}, {NNN} patterns
    const seqMatch = baseName.match(/\{SEQ(\d)?\}/);
    if (!seqMatch) {
      return baseName;
    }

    const digits = seqMatch[1] ? parseInt(seqMatch[1]) : 3; // Default 3 digits
    const now = new Date();
    
    // Determine reset period based on ORIGINAL pattern (same as basket-sessions.ts)
    let fromDate: Date;
    
    if (originalPattern.includes('{YYYY-MM-DD}')) {
      // Reset daily
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (originalPattern.includes('{YYYY-MM}') || originalPattern.includes('{MM}')) {
      // Reset monthly
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (originalPattern.includes('{YYYY+543}') || originalPattern.includes('{BYYYY}') || originalPattern.includes('{YYYY}')) {
      // Reset yearly (support both Christian and Buddhist year)
      fromDate = new Date(now.getFullYear(), 0, 1);
    } else {
      // Default: reset daily
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    
    fromDate.setHours(0, 0, 0, 0);

    // Count existing sessions in this period (same as basket-sessions.ts)
    const count = await prisma.processingSession.count({
      where: { 
        basketId,
        startedAt: { gte: fromDate },
        status: { in: ['open', 'published', 'processing', 'completed', 'archived'] }
      }
    });

    const seqNum = count + 1;
    const seqStr = digits === 1 ? String(seqNum) : String(seqNum).padStart(digits, '0');

    // Replace sequence pattern
    return baseName.replace(seqMatch[0], seqStr);
  }

  private async clearFilesByName(sessionId: string, fileName: string, _basketId: string): Promise<void> {
    try {
      // Find files with same name in this session
      const files = await prisma.basketFile.findMany({
        where: { 
          sessionId,
          fileName: fileName
        }
      });
      
      if (files.length === 0) return;

      let totalSize = 0;
      
      // Delete physical files
      for (const file of files) {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
          totalSize += file.size;
        } catch (e) {
          console.error(`Failed to delete file ${file.path}:`, e);
        }
      }
      
      // Delete database records
      await prisma.basketFile.deleteMany({
        where: { 
          sessionId,
          fileName: fileName
        }
      });
      
      // Update session counts
      await prisma.processingSession.update({
        where: { id: sessionId },
        data: { 
          fileCount: { decrement: files.length },
          totalSize: { decrement: totalSize }
        }
      });
      
      // Log file deletion
      await prisma.sessionLog.create({
        data: {
          sessionId,
          type: 'files_deleted',
          message: `Cleared ${files.length} file(s) with name '${fileName}' before overwrite`,
          metadata: JSON.stringify({ fileName, count: files.length, size: totalSize })
        }
      });
      
      console.log(`[FileWrite] Cleared ${files.length} file(s) with name '${fileName}' from session ${sessionId}`);
    } catch (error) {
      console.error('Failed to clear files by name:', error);
    }
  }

  private async publishSession(sessionId: string, _basketId: string): Promise<any> {
    try {
      const session = await prisma.processingSession.update({
        where: { id: sessionId },
        data: {
          status: 'published',
          publishedAt: new Date()
        }
      });

      await prisma.sessionLog.create({
        data: {
          sessionId,
          type: 'session_published',
          message: `Session auto-published`,
          metadata: JSON.stringify({ auto: true })
        }
      });

      // Update basket files status
      await prisma.basketFile.updateMany({
        where: { sessionId },
        data: { status: 'published' }
      });

      return { success: true, publishedAt: session.publishedAt };
    } catch (error) {
      console.error('Failed to auto-publish session:', error);
      return { success: false, error: String(error) };
    }
  }

  private getMimeType(fileName: string, contentType?: string): string {
    // Use user-specified content type if provided and not 'auto'
    if (contentType && contentType !== 'auto') {
      return contentType;
    }
    
    // Auto-detect from file extension
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.csv': 'text/csv',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async writeToSFTP(content: string | Buffer, fileName: string, data: FileWriteData, context: ExecutionContext): Promise<any> {
    if (!data.sftpConnectionId || !data.sftpRemotePath) {
      throw new Error('SFTP connection and remote path required');
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

    const remoteDir = this.resolveTemplate(data.sftpRemotePath, context);
    const remotePath = path.posix.join(remoteDir, fileName);

    // Save to temp first with encoding
    const tempPath = `/tmp/${fileName}`;
    const writeOptions = typeof content === 'string' ? { encoding: data.encoding as BufferEncoding || 'utf8' } : undefined;
    fs.writeFileSync(tempPath, content, writeOptions);

    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          // Ensure remote directory exists
          sftp.mkdir(remoteDir, () => {
            const readStream = fs.createReadStream(tempPath);
            const writeStream = sftp.createWriteStream(remotePath);

            readStream.on('error', (err: Error) => {
              try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
              conn.end();
              reject(new Error(`Cannot read temp file ${tempPath}: ${err.message}`));
            });

            writeStream.on('close', () => {
              fs.unlinkSync(tempPath);
              conn.end();
              resolve({
                remotePath,
                connection: connection.name,
                size: fs.statSync(tempPath).size,
              });
            });

            writeStream.on('error', (err: Error) => {
              fs.unlinkSync(tempPath);
              conn.end();
              reject(err);
            });

            readStream.pipe(writeStream);
          });
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

  private getDataFromPath(context: ExecutionContext, path: string): any {
    const keys = path.split('.');
    let value: any = context;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (value === null || value === undefined) return undefined;

      // Handle 'vars' or 'variables' prefix → lookup from context.variables Map
      if ((key === 'vars' || key === 'variables') && value === context && context.variables instanceof Map) {
        // Next key is the variable name
        const varName = keys[i + 1];
        if (varName) {
          value = context.variables.get(varName);
          i++; // skip the varName key
          continue;
        }
      }

      value = value?.[key];
    }
    return value;
  }

  protected resolveTemplate(template: string, context: ExecutionContext): string {
    if (!template.includes('{{')) return template;

    return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const trimmedPath = path.trim();

      // Support arithmetic: {{varName+N}} or {{varName-N}}
      const arithMatch = trimmedPath.match(/^(\w+)([+-]\d+)$/);
      if (arithMatch && context.variables) {
        const [, varName, offsetStr] = arithMatch;
        const baseVal = context.variables.get(varName);
        if (baseVal !== undefined) {
          const num = Number(baseVal);
          if (!isNaN(num)) return String(num + parseInt(offsetStr, 10));
        }
      }

      const keys = trimmedPath.split('.');

      // Try context.variables first (single key or dotted path)
      if (context.variables) {
        const varValue = context.variables.get(trimmedPath);
        if (varValue !== undefined) return String(varValue);
        if (keys.length >= 2) {
          let val = context.variables.get(keys[0]);
          if (val !== undefined) {
            for (let i = 1; i < keys.length; i++) {
              val = val?.[keys[i]];
            }
            if (val !== undefined) return String(val);
          }
        }
      }

      // Fallback: traverse context object directly
      let value: any = context;
      for (const key of keys) {
        value = value?.[key];
      }
      return value !== undefined ? String(value) : match;
    });
  }
}
