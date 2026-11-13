// OCR Executor - Extract text from documents using ABBYY FineReader Server 14
// REST API: workflows → submit file → poll job → get result
//
// ABBYY FineReader Server 14 REST API endpoints:
//   GET  /api/workflows                              — List available workflows
//   POST /api/workflows/{workflowName}/input/file     — Submit file for processing
//   POST /api/workflows/{workflowName}/input/multipart — Submit large file (multipart)
//   GET  /api/jobs/{jobId}                            — Check job status
//   GET  /api/jobs/{jobId}/result                     — Download result

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { prisma } from '../../../lib/prisma';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import FormData from 'form-data';

interface OcrData {
  // Connection or direct URL
  connectionId?: string;
  url?: string;                // Direct URL override (template supported)

  // Operation mode
  operation?: 'process' | 'status' | 'result';  // Default: 'process' (full pipeline)

  // File source
  filePath?: string;           // Direct file path (template supported)
  fileSource?: string;         // Variable path e.g. "vars.currentFile.path"

  // ABBYY FineReader Server options
  workflowName?: string;       // Workflow name in FineReader Server (default: auto-detect first available)
  language?: string;           // OCR language (default: "Thai,English")
  outputFormat?: string;       // "txt" | "pdf" | "docx" | "xml" (default: "txt")
  profile?: string;            // OCR profile/preset name
  serverLocation?: string;     // FineReader Server Manager hostname (default: "localhost")

  // Async polling
  pollInterval?: number;       // ms between polls (default: 5000)
  maxWaitTime?: number;        // max wait ms (default: 300000 = 5min)

  // Auth
  authType?: 'none' | 'basic' | 'bearer' | 'api-key';
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;       // Header name for API key (default: "X-API-Key")

  // Custom endpoints (override ABBYY defaults)
  uploadEndpoint?: string;     // Default: /api/workflows/{workflowName}/input/file
  statusEndpoint?: string;     // Default: /api/jobs/{jobId}
  resultEndpoint?: string;     // Default: /api/jobs/{jobId}/result

  // Variable name for output
  varName?: string;
}

export class OcrExecutor extends NodeExecutor {
  readonly type = 'ocr';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as OcrData;
    const operation = data.operation || 'process';

    // Resolve base URL
    const baseUrl = await this.resolveBaseUrl(data, context);
    if (!baseUrl) {
      throw new Error('OCR service URL is required. Provide connectionId or url.');
    }

    // Build auth headers
    const authHeaders = this.buildAuthHeaders(data, context);

    this.log(context, 'info', `OCR ${operation}: ${baseUrl}`);

    switch (operation) {
      case 'process':
        return this.processFile(data, context, baseUrl, authHeaders);
      case 'status':
        return this.checkStatus(data, context, baseUrl, authHeaders);
      case 'result':
        return this.getResult(data, context, baseUrl, authHeaders);
      default:
        throw new Error(`Unknown OCR operation: ${operation}`);
    }
  }

  /**
   * Full pipeline:
   * 1. Get available workflows (if workflowName not set)
   * 2. Upload file to ABBYY FineReader Server
   * 3. Poll job status
   * 4. Get result text
   */
  private async processFile(
    data: OcrData,
    context: ExecutionContext,
    baseUrl: string,
    authHeaders: Record<string, string>
  ): Promise<any> {
    // Step 1: Resolve file path
    const filePath = this.resolveFilePath(data, context);
    if (!filePath) {
      throw new Error('File path is required. Provide filePath or fileSource.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    const serverLocation = data.serverLocation || 'localhost';
    this.log(context, 'info', `OCR processing file: ${fileName} (${(fileSize / 1024).toFixed(1)} KB)`);

    // Step 2: Resolve workflow name
    let workflowName = data.workflowName;
    if (!workflowName) {
      // Auto-detect: get first available workflow from ABBYY
      try {
        const workflowsUrl = this.joinUrl(baseUrl, `/api/workflows?serverLocation=${serverLocation}`);
        this.log(context, 'debug', `Fetching workflows from: ${workflowsUrl}`);
        const wfResponse = await axios.get(workflowsUrl, {
          headers: authHeaders,
          timeout: 15000,
        });
        const workflows = wfResponse.data;
        if (Array.isArray(workflows) && workflows.length > 0) {
          // Use the first workflow's name
          workflowName = workflows[0].name || workflows[0].Name || workflows[0];
          this.log(context, 'info', `Using workflow: ${workflowName} (auto-detected from ${workflows.length} available)`);
        } else if (typeof workflows === 'object' && workflows.workflows) {
          // Alternative response format
          const wfList = workflows.workflows;
          if (Array.isArray(wfList) && wfList.length > 0) {
            workflowName = wfList[0].name || wfList[0].Name || wfList[0];
            this.log(context, 'info', `Using workflow: ${workflowName}`);
          }
        }
      } catch (error: any) {
        this.log(context, 'warn', `Could not fetch workflows: ${error.message}. Using default.`);
      }
    }
    if (!workflowName) {
      workflowName = 'Default'; // Fallback
      this.log(context, 'info', `No workflow found, using default: ${workflowName}`);
    }

    // Step 3: Upload file to ABBYY FineReader Server
    // Always use multipart/form-data endpoint (more reliable across ABBYY versions)
    const defaultUploadEndpoint = `/api/workflows/${encodeURIComponent(workflowName)}/input/multipart`;
    const uploadEndpoint = data.uploadEndpoint
      ? data.uploadEndpoint.replace('{workflowName}', encodeURIComponent(workflowName))
      : defaultUploadEndpoint;
    const uploadUrl = this.joinUrl(baseUrl, uploadEndpoint) + `?serverLocation=${serverLocation}`;

    this.log(context, 'info', `Uploading to: ${uploadUrl}`, { fileName, workflowName, language: data.language });

    let uploadResponse: any;
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`OCR input file no longer exists on disk: ${filePath}`);
      }
      const form = new FormData();
      const ocrStream = fs.createReadStream(filePath);
      ocrStream.on('error', () => { /* surfaced by the axios call below */ });
      form.append('file', ocrStream, {
        filename: fileName,
        contentType: 'application/pdf',
      });
      uploadResponse = await axios.post(uploadUrl, form, {
        headers: {
          ...authHeaders,
          ...form.getHeaders(),
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    } catch (error: any) {
      const errMsg = error.response?.data?.message || error.response?.data?.Message || error.response?.data?.error || error.message;
      throw new Error(`OCR upload failed: ${errMsg} (status: ${error.response?.status || 'unknown'})`);
    }

    const uploadResult = uploadResponse.data;
    this.log(context, 'info', 'Upload response', { data: typeof uploadResult === 'string' ? uploadResult : JSON.stringify(uploadResult).substring(0, 200) });

    // ABBYY FineReader Server returns jobId directly as a quoted GUID string
    // e.g., "{2E3EE669-6EAF-4025-8549-23ADB684FD9B}" or just the GUID
    let jobId: string | undefined;

    if (typeof uploadResult === 'string') {
      // Direct GUID string response (common ABBYY pattern)
      // ABBYY returns "{GUID}" with braces — keep them as-is, they are required for status/result API
      const cleaned = uploadResult.replace(/^"|"$/g, '').trim();
      if (cleaned.match(/^[{]?[0-9a-fA-F-]{36}[}]?$/)) {
        jobId = cleaned;
      }
    }

    if (!jobId && typeof uploadResult === 'object') {
      // Check if result is returned immediately (synchronous mode)
      if (uploadResult.text || uploadResult.result || uploadResult.content) {
        const text = uploadResult.text || uploadResult.result || uploadResult.content;
        this.log(context, 'info', `OCR completed (sync): ${typeof text === 'string' ? text.length : 0} chars extracted`);
        return {
          success: true,
          text: typeof text === 'string' ? text : JSON.stringify(text),
          confidence: uploadResult.confidence,
          pages: uploadResult.pages || uploadResult.pageCount,
          fileName,
          processingTime: 0,
          mode: 'sync',
          rawResponse: uploadResult,
        };
      }

      // Try extracting jobId from object
      jobId = uploadResult.id || uploadResult.jobId || uploadResult.taskId || uploadResult.Id || uploadResult.JobId || uploadResult.requestId;
    }
    if (!jobId) {
      // If no jobId and no text, return raw response
      this.log(context, 'warn', 'No jobId or text in OCR response, returning raw');
      return {
        success: true,
        text: JSON.stringify(uploadResult),
        fileName,
        mode: 'raw',
        rawResponse: uploadResult,
      };
    }

    this.log(context, 'info', `OCR job created: ${jobId}, polling for completion...`);
    return this.pollForResult(data, context, baseUrl, authHeaders, jobId, fileName, serverLocation);
  }

  /**
   * Poll ABBYY FineReader Server job until processing is complete
   * ABBYY job states: Queued, InProgress, Completed, ProcessingFailed, etc.
   */
  private async pollForResult(
    data: OcrData,
    context: ExecutionContext,
    baseUrl: string,
    authHeaders: Record<string, string>,
    jobId: string,
    fileName: string,
    serverLocation: string = 'localhost'
  ): Promise<any> {
    const pollInterval = data.pollInterval || 5000;
    const maxWaitTime = data.maxWaitTime || 300000;
    const startTime = Date.now();

    // ABBYY endpoint: GET /api/jobs/{jobId}
    // ABBYY requires braces in GUID to be URL-encoded: %7BGUID%7D
    const encodedJobId = encodeURIComponent(jobId);
    const statusEndpoint = (data.statusEndpoint || '/api/jobs/{jobId}').replace('{jobId}', encodedJobId);
    const statusUrl = this.joinUrl(baseUrl, statusEndpoint) + `?serverLocation=${serverLocation}`;

    let lastStatus = '';
    let pollCount = 0;

    // Ask before waiting. Sleeping first cost a full pollInterval on every
    // file even when the job was already done — measured on one deployment, that made
    // a ~0.8s OCR take 5.8s, i.e. ~85% of the node's time was this sleep.
    // Back off from a short first delay up to pollInterval so a slow job still
    // doesn't hammer the OCR server.
    const firstDelay = Math.min(250, pollInterval);
    let nextDelay = firstDelay;

    while (Date.now() - startTime < maxWaitTime) {
      pollCount++;

      try {
        const statusResponse = await axios.get(statusUrl, {
          headers: authHeaders,
          timeout: 15000,
        });

        const statusData = statusResponse.data;
        // ABBYY uses "State" or "status" field
        const status = (statusData.State || statusData.state || statusData.status || statusData.Status || '').toString();
        const statusLower = status.toLowerCase();

        if (status !== lastStatus) {
          this.log(context, 'info', `OCR job ${jobId}: ${status} (poll #${pollCount})`);
          lastStatus = status;
        }

        // ABBYY completion states: JS_Complete, Completed, Done, Finished, Success, JS_Exported
        if (['js_complete', 'js_completed', 'completed', 'done', 'finished', 'success', 'js_exported'].includes(statusLower)) {
          // Get result: GET /api/jobs/{jobId}/result
          const resultEndpoint = (data.resultEndpoint || '/api/jobs/{jobId}/result').replace('{jobId}', encodedJobId);
          const resultUrl = this.joinUrl(baseUrl, resultEndpoint) + `?serverLocation=${serverLocation}`;

          let text = '';
          try {
            const resultResponse = await axios.get(resultUrl, {
              headers: authHeaders,
              timeout: 30000,
              responseType: 'arraybuffer', // ABBYY may return binary file
            });

            const body = Buffer.from(resultResponse.data);
            // ABBYY answers with a JSON job envelope whose output files are
            // base64 in InputFiles[].OutputDocuments[].Files[].FileContents.
            // Handing that JSON downstream as "text" is what made this node
            // silently produce nothing to parse.
            text = await this.extractResultText(body, context);
          } catch (resultError: any) {
            this.log(context, 'warn', `Could not fetch result file: ${resultError.message}. Using status data.`);
            // Try extracting text from statusData
            text = statusData.text || statusData.result || statusData.content || '';
          }

          const processingTime = Date.now() - startTime;

          this.log(context, 'info', `OCR completed: ${text.length} chars in ${processingTime}ms`);

          return {
            success: true,
            text: typeof text === 'string' ? text : JSON.stringify(text),
            confidence: statusData.confidence || statusData.Confidence,
            pages: statusData.pages || statusData.Pages || statusData.pageCount || statusData.PageCount,
            jobId,
            fileName,
            processingTime,
            mode: 'async',
            rawResponse: statusData,
          };
        }

        // ABBYY error states: ProcessingFailed, Failed, Error, Cancelled, JS_ProcessingFailed
        if (['processingfailed', 'failed', 'error', 'cancelled', 'timeout', 'js_processingfailed'].includes(statusLower)) {
          const errorMsg = statusData.error || statusData.Error || statusData.message || statusData.Message
            || `OCR processing failed with status: ${status}`;
          throw new Error(errorMsg);
        }

        // Still processing (Queued, InProgress) - continue polling
      } catch (error: any) {
        if (error.response?.status === 404) {
          throw new Error(`OCR job not found: ${jobId}`);
        }
        // For other errors, keep polling unless it's a thrown error from above
        if (error.message?.includes('OCR processing failed') || error.message?.includes('OCR job not found')) {
          throw error;
        }
        this.log(context, 'warn', `Poll error (will retry): ${error.message}`);
      }

      // Not finished yet — wait, widening the gap towards pollInterval.
      const remaining = maxWaitTime - (Date.now() - startTime);
      if (remaining <= 0) break;
      await this.sleep(Math.min(nextDelay, remaining));
      nextDelay = Math.min(nextDelay * 2, pollInterval);
    }

    throw new Error(`OCR processing timed out after ${maxWaitTime / 1000}s (${pollCount} polls)`);
  }

  /**
   * Check status of an existing ABBYY job
   */
  private async checkStatus(
    data: OcrData,
    context: ExecutionContext,
    baseUrl: string,
    authHeaders: Record<string, string>
  ): Promise<any> {
    const jobId = this.resolveTemplate(data.filePath || '', context) as string;
    if (!jobId) throw new Error('Job ID required for status check (provide in filePath)');

    const serverLocation = data.serverLocation || 'localhost';
    const encodedJobId = encodeURIComponent(jobId);
    const statusEndpoint = (data.statusEndpoint || '/api/jobs/{jobId}').replace('{jobId}', encodedJobId);
    const statusUrl = this.joinUrl(baseUrl, statusEndpoint) + `?serverLocation=${serverLocation}`;

    const response = await axios.get(statusUrl, { headers: authHeaders, timeout: 15000 });
    return response.data;
  }

  /**
   * Get result of a completed ABBYY job
   */
  private async getResult(
    data: OcrData,
    context: ExecutionContext,
    baseUrl: string,
    authHeaders: Record<string, string>
  ): Promise<any> {
    const jobId = this.resolveTemplate(data.filePath || '', context) as string;
    if (!jobId) throw new Error('Job ID required for result retrieval (provide in filePath)');

    const serverLocation = data.serverLocation || 'localhost';
    const encodedJobId = encodeURIComponent(jobId);
    const resultEndpoint = (data.resultEndpoint || '/api/jobs/{jobId}/result').replace('{jobId}', encodedJobId);
    const resultUrl = this.joinUrl(baseUrl, resultEndpoint) + `?serverLocation=${serverLocation}`;

    const response = await axios.get(resultUrl, {
      headers: authHeaders,
      timeout: 30000,
      responseType: 'arraybuffer',
    });

    const contentType = response.headers['content-type'] || '';
    let text = '';
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')) {
      text = Buffer.from(response.data).toString('utf-8');
    } else {
      text = Buffer.from(response.data).toString('utf-8');
    }

    return {
      success: true,
      text,
      jobId,
      rawResponse: { contentType, size: response.data.length },
    };
  }

  // --- Helpers ---

  private async resolveBaseUrl(data: OcrData, context: ExecutionContext): Promise<string> {
    // Direct URL takes precedence
    if (data.url) {
      return (this.resolveTemplate(data.url, context) as string).replace(/\/$/, '');
    }

    // Resolve from connection
    if (data.connectionId) {
      const connection = await prisma.connection.findUnique({
        where: { id: data.connectionId },
      });

      if (!connection) {
        throw new Error(`Connection not found: ${data.connectionId}`);
      }

      let config: any = {};
      try {
        config = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
      } catch {
        config = connection.config || {};
      }

      return (config.baseUrl || config.url || config.host || '').replace(/\/$/, '');
    }

    return '';
  }

  private buildAuthHeaders(data: OcrData, context: ExecutionContext): Record<string, string> {
    const headers: Record<string, string> = {};
    const authType = data.authType || 'none';

    switch (authType) {
      case 'basic': {
        const username = this.resolveTemplate(data.username || '', context) as string;
        const password = this.resolveTemplate(data.password || '', context) as string;
        headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        break;
      }
      case 'bearer': {
        const token = this.resolveTemplate(data.token || '', context) as string;
        headers['Authorization'] = `Bearer ${token}`;
        break;
      }
      case 'api-key': {
        const apiKey = this.resolveTemplate(data.apiKey || '', context) as string;
        const headerName = data.apiKeyHeader || 'X-API-Key';
        headers[headerName] = apiKey;
        break;
      }
    }

    return headers;
  }

  private resolveFilePath(data: OcrData, context: ExecutionContext): string | null {
    // Direct file path
    if (data.filePath) {
      return this.resolveTemplate(data.filePath, context) as string;
    }

    // From variable path (e.g., "vars.currentFile.path")
    if (data.fileSource) {
      const value = this.getStandardValue(context, data.fileSource);
      if (typeof value === 'string') return value;
      if (value?.path) return value.path;
      if (value?.localPath) return value.localPath;
      if (value?.filePath) return value.filePath;
    }

    // Try common variable names
    const currentFile = context.variables.get('currentFile');
    if (currentFile) {
      if (typeof currentFile === 'string') return currentFile;
      if (currentFile.path) return currentFile.path;
      if (currentFile.localPath) return currentFile.localPath;
      if (currentFile.filePath) return currentFile.filePath;
    }

    return null;
  }

  private joinUrl(base: string, endpoint: string): string {
    const cleanBase = base.replace(/\/$/, '');
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    return cleanBase + cleanEndpoint;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Turn an ABBYY `/result` response into plain text.
   *
   * The response is normally a JSON job envelope, not the recognised text. Walk
   * it for output files, prefer a text-ish one, and fall back to a PDF whose
   * embedded text layer we read with pdftotext. When the body isn't JSON at all
   * (a server configured to return the file directly) it is used as-is.
   */
  private async extractResultText(body: Buffer, context: ExecutionContext): Promise<string> {
    const asString = body.toString('utf-8');

    let envelope: any;
    try {
      envelope = JSON.parse(asString);
    } catch {
      return asString; // Not an envelope — already the payload.
    }
    if (!envelope || typeof envelope !== 'object') return asString;

    const outputs = this.collectOutputFiles(envelope);
    if (outputs.length === 0) {
      this.log(context, 'warn', 'OCR result envelope contained no output files; using the raw response.');
      return asString;
    }

    // A text/xml export needs no further work.
    const textual = outputs.find(o => /\.(txt|text|xml|csv|htm|html)$/i.test(o.fileName));
    if (textual) {
      this.log(context, 'info', `OCR result: reading text export "${textual.fileName}"`);
      return textual.data.toString('utf-8');
    }

    const pdf = outputs.find(o => /\.pdf$/i.test(o.fileName)) || outputs[0];
    this.log(context, 'info', `OCR result: extracting text layer from "${pdf.fileName}" (${pdf.data.length} bytes)`);
    return this.pdfToText(pdf.data, context);
  }

  /** Gather {fileName, data} for every output file carried in the envelope. */
  private collectOutputFiles(envelope: any): Array<{ fileName: string; data: Buffer }> {
    const found: Array<{ fileName: string; data: Buffer }> = [];

    const takeDocs = (docs: any) => {
      for (const doc of Array.isArray(docs) ? docs : []) {
        for (const file of Array.isArray(doc?.Files) ? doc.Files : []) {
          const contents = file?.FileContents;
          if (typeof contents !== 'string' || contents.length === 0) continue;
          try {
            found.push({ fileName: String(file.FileName || ''), data: Buffer.from(contents, 'base64') });
          } catch { /* skip unreadable entry */ }
        }
      }
    };

    // Real layout is InputFiles[].OutputDocuments[]; the top-level key is
    // accepted too since it is what the API docs suggest.
    for (const input of Array.isArray(envelope.InputFiles) ? envelope.InputFiles : []) {
      takeDocs(input?.OutputDocuments);
    }
    takeDocs(envelope.OutputDocuments);

    return found;
  }

  /**
   * Read a PDF's text layer via poppler's pdftotext.
   *
   * `-layout` is required, not cosmetic: in these risk reports the value sits
   * in a right-hand column, and default reading order moves it away from its
   * label, leaving the label with nothing after it to parse.
   */
  private pdfToText(pdf: Buffer, context: ExecutionContext): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmpFile, pdf);

    return new Promise<string>((resolve) => {
      execFile(
        'pdftotext',
        ['-layout', '-enc', 'UTF-8', tmpFile, '-'],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
          if (err) {
            this.log(context, 'warn', `pdftotext failed (${err.message}); no text extracted from the PDF output.`);
            resolve('');
            return;
          }
          resolve(stdout || '');
        }
      );
    });
  }
}
