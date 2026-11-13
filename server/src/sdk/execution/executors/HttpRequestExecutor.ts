// HTTP Request Executor - Unified HTTP operations (API calls + File Download + File Upload)

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import axios, { AxiosRequestConfig, Method } from 'axios';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import FormData from 'form-data';
import prisma from '../../../lib/prisma';

interface HttpRequestData {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string> | string;
  body?: any;
  queryParams?: Record<string, string>;
  timeout?: number;

  // TLS: set insecure=true (or rejectUnauthorized=false) to skip certificate
  // verification — needed for endpoints that serve an incomplete cert chain
  // (e.g. some APIs that omit the intermediate CA).
  insecure?: boolean;
  rejectUnauthorized?: boolean;

  // Connection-based mode (optional)
  connectionId?: string;  // REST API connection for baseUrl + auth

  // For file download mode
  downloadFile?: boolean;
  savePath?: string;      // Basket path or {{basket}}/filename
  fileName?: string;      // {{original}}, {{timestamp}}, custom

  // For file upload mode (multipart/form-data)
  uploadFile?: boolean;
  uploadFilePath?: string;        // Path to file to upload (template supported)
  uploadFieldName?: string;       // Form field name (default: "file")
  contentType?: 'json' | 'form-data' | 'form-urlencoded';
  formFields?: Record<string, string>;  // Extra form fields to include

  // Pagination: loop until ALL pages are fetched (for endpoints that page via
  // limit/offset, e.g. partner API /unit-insp). The executor injects limit/offset on
  // each request, accumulates the items array, and returns a single merged
  // response (items replaced with the full set; total preserved).
  paginate?: boolean;
  pageSize?: number;                 // items per request (default 1000)
  paginationIn?: 'body' | 'query';   // where to put limit/offset (default: body for POST/PUT/PATCH, else query)
  limitParam?: string;               // page-size field name (default 'limit')
  offsetParam?: string;              // offset field name (default 'offset')
  itemsPath?: string;                // dot-path to the items array (e.g. 'value.items'; empty = response is the array)
  totalPath?: string;                // dot-path to the total count (e.g. 'value.total')
  maxPages?: number;                 // safety cap on page count (default 1000)
}

interface ConnectionHTTPConfig {
  baseUrl?: string;
  authType?: 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2';
  auth?: {
    username?: string;
    password?: string;
    token?: string;
    apiKey?: string;
    apiKeyHeader?: string;
  };
  headers?: Record<string, string>;
  timeout?: number;
}

export class HttpRequestExecutor extends NodeExecutor {
  readonly type = 'http-request';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as HttpRequestData;

    // Resolve connection config if connectionId is provided
    let connConfig: ConnectionHTTPConfig | null = null;
    if (data.connectionId) {
      connConfig = await this.getConnectionConfig(data.connectionId);
      this.log(context, 'debug', `Using connection: ${data.connectionId}`, { baseUrl: connConfig.baseUrl, authType: connConfig.authType });
    }

    // Build full URL: connection baseUrl + node url (endpoint path)
    let rawUrl = data.url || '';
    if (connConfig?.baseUrl) {
      const baseUrl = connConfig.baseUrl.replace(/\/$/, '');
      if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
        // Endpoint path — append to base URL
        const endpoint = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
        rawUrl = `${baseUrl}${endpoint}`;
      } else if (!rawUrl) {
        rawUrl = baseUrl;
      }
      // If rawUrl is already a full URL, use it as-is (direct URL overrides)
    }

    if (!rawUrl) {
      throw new Error('URL is required. Provide a URL directly or select a connection.');
    }

    // Resolve templates
    const url = this.resolveTemplate(rawUrl, context);

    // Handle file upload mode
    if (data.uploadFile && data.uploadFilePath) {
      return this.handleUpload(url as string, data, connConfig, context);
    }

    // Build merged headers: connection headers + connection auth + node headers
    const mergedHeaders = this.buildMergedHeaders(data, connConfig, context);

    // Build request config
    const config: AxiosRequestConfig = {
      method: (data.method || 'GET') as Method,
      url: url,
      timeout: data.timeout || connConfig?.timeout || 30000,
      headers: mergedHeaders,
      responseType: data.downloadFile ? 'stream' : 'json',
    };

    // Skip TLS cert verification when requested (insecure / rejectUnauthorized:false).
    if (data.insecure === true || data.rejectUnauthorized === false) {
      config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
      this.log(context, 'warn', 'TLS certificate verification DISABLED for this request', { url });
    }

    // Add query params
    if (data.queryParams) {
      config.params = this.resolveObjectTemplates(data.queryParams, context);
    }

    // Add body
    if (['POST', 'PUT', 'PATCH'].includes(data.method) && data.body) {
      if (typeof data.body === 'string') {
        const resolved = this.resolveTemplate(data.body, context) as string;
        // Try to parse as JSON, otherwise send as raw string
        try {
          config.data = JSON.parse(resolved);
        } catch {
          config.data = resolved;
        }
      } else {
        config.data = this.resolveObjectTemplates(data.body, context);
      }
    }

    // Debug logging - Request details
    this.log(context, 'debug', `HTTP Request: ${config.method?.toUpperCase()} ${url}`, {
      url,
      method: config.method,
      headers: config.headers,
      queryParams: config.params,
      body: config.data,
      timeout: config.timeout,
    });

    // Paginated mode: loop limit/offset until all pages collected, return merged result
    if (data.paginate && !data.downloadFile) {
      return this.handlePaginated(config, url as string, data, context);
    }

    // Make request
    const response = await axios(config);

    // Debug logging - Response details
    this.log(context, 'debug', `HTTP Response: ${response.status} ${response.statusText}`, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: data.downloadFile ? '<stream>' : response.data,
    });

    // Handle file download
    if (data.downloadFile) {
      return this.handleDownload(response, url, data, context);
    }

    // Return API response
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      url,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Paginated fetch: repeatedly call the endpoint injecting limit/offset, accumulate
   * the items array, and return ONE merged response. Stops when collected >= total,
   * a page returns no items, a short page arrives (no total available), or maxPages.
   */
  private async handlePaginated(baseConfig: AxiosRequestConfig, url: string, data: HttpRequestData, context: ExecutionContext): Promise<any> {
    const pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : 1000;
    const limitParam = data.limitParam || 'limit';
    const offsetParam = data.offsetParam || 'offset';
    const method = String(baseConfig.method || 'GET').toUpperCase();
    const where: 'body' | 'query' = data.paginationIn || (['POST', 'PUT', 'PATCH'].includes(method) ? 'body' : 'query');
    const itemsPath = data.itemsPath || '';
    const totalPath = data.totalPath || '';
    const maxPages = Number(data.maxPages) > 0 ? Number(data.maxPages) : 1000;

    let offset = 0;
    let pages = 0;
    let total: number | null = null;
    const all: any[] = [];
    let prevSig: string | null = null;   // previous page signature — detect endpoints that ignore offset
    let last: any = null;

    while (pages < maxPages) {
      const cfg: AxiosRequestConfig = { ...baseConfig };
      if (where === 'body') {
        const body = (baseConfig.data && typeof baseConfig.data === 'object') ? { ...baseConfig.data } : {};
        body[limitParam] = pageSize;
        body[offsetParam] = offset;
        cfg.data = body;
      } else {
        cfg.params = { ...(baseConfig.params || {}), [limitParam]: pageSize, [offsetParam]: offset };
      }

      const response = await axios(cfg);
      last = response;
      const itemsVal = itemsPath ? this.getPath(response.data, itemsPath) : response.data;
      const pageItems: any[] = Array.isArray(itemsVal) ? itemsVal : [];
      if (totalPath) {
        const t = Number(this.getPath(response.data, totalPath));
        if (Number.isFinite(t)) total = t;
      }
      // Whole-page signature. An endpoint that ignores offset returns the SAME
      // page every time → identical signature → stop WITHOUT re-appending. This
      // makes pagination safe to enable on a non-paged endpoint (no duplication,
      // no infinite loop) while preserving legitimately content-identical rows
      // WITHIN a page (e.g. repeated zero rows in financial statements).
      const sig = JSON.stringify(pageItems);
      if (pages > 0 && sig === prevSig) break;   // same page as before → offset ignored → stop
      prevSig = sig;

      all.push(...pageItems);
      pages++;

      this.log(context, 'debug', `Paginated page ${pages}: offset=${offset} got=${pageItems.length} accumulated=${all.length} total=${total ?? '?'}`);

      if (pageItems.length === 0) break;       // no data on this page
      if (total != null && all.length >= total) break;
      if (total == null && pageItems.length < pageSize) break;
      offset += pageSize;
    }

    // Merge: keep the wrapper shape of the last response, replace items with the full set.
    let mergedData: any;
    if (itemsPath) {
      mergedData = last ? JSON.parse(JSON.stringify(last.data ?? {})) : {};
      this.setPath(mergedData, itemsPath, all);
      if (totalPath) this.setPath(mergedData, totalPath, total ?? all.length);
    } else {
      mergedData = all;
    }

    this.log(context, 'info', `Paginated fetch complete: ${all.length} items across ${pages} page(s)`, { url, pages, total: total ?? all.length });

    return {
      status: last ? last.status : 200,
      statusText: last ? last.statusText : 'OK',
      headers: last ? last.headers : {},
      data: mergedData,
      url,
      pages,
      total: total ?? all.length,
      timestamp: new Date().toISOString(),
    };
  }

  private getPath(obj: any, dotPath: string): any {
    if (!dotPath) return obj;
    return dotPath.split('.').reduce((acc: any, k: string) => (acc == null ? undefined : acc[k]), obj);
  }

  private setPath(obj: any, dotPath: string, value: any): void {
    const keys = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }

  private async handleUpload(url: string, data: HttpRequestData, connConfig: ConnectionHTTPConfig | null, context: ExecutionContext): Promise<any> {
    const filePath = this.resolveTemplate(data.uploadFilePath!, context) as string;

    if (!fs.existsSync(filePath)) {
      throw new Error(`Upload file not found: ${filePath}`);
    }

    const fieldName = data.uploadFieldName || 'file';
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    this.log(context, 'info', `Uploading file: ${fileName} (${(fileSize / 1024).toFixed(1)} KB) to ${url}`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File to upload no longer exists on disk: ${filePath}`);
    }

    // Build FormData
    const form = new FormData();
    const uploadStream = fs.createReadStream(filePath);
    uploadStream.on('error', (err: Error) => {
      this.log(context, 'error', `Upload stream failed for ${filePath}: ${err.message}`);
    });
    form.append(fieldName, uploadStream, {
      filename: fileName,
    });

    // Add extra form fields
    if (data.formFields) {
      const resolvedFields = this.resolveObjectTemplates(data.formFields, context);
      for (const [key, value] of Object.entries(resolvedFields)) {
        form.append(key, String(value));
      }
    }

    // Merge connection + node headers + form headers
    const mergedHeaders = this.buildMergedHeaders(data, connConfig, context);

    const config: AxiosRequestConfig = {
      method: (data.method || 'POST') as Method,
      url,
      data: form,
      headers: {
        ...mergedHeaders,
        ...form.getHeaders(),
      },
      timeout: data.timeout || connConfig?.timeout || 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    // Add query params
    if (data.queryParams) {
      config.params = this.resolveObjectTemplates(data.queryParams, context);
    }

    this.log(context, 'debug', `Upload request: ${config.method?.toUpperCase()} ${url}`, {
      fileName,
      fileSize,
      fieldName,
      formFields: data.formFields,
    });

    const response = await axios(config);

    this.log(context, 'debug', `Upload response: ${response.status}`, response.data);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      url,
      uploadedFile: fileName,
      uploadedSize: fileSize,
      timestamp: new Date().toISOString(),
    };
  }

  private async handleDownload(response: any, url: string, data: HttpRequestData, context: ExecutionContext): Promise<any> {
    // Determine file name
    const originalName = this.extractFileName(url, response.headers);
    const fileName = data.fileName
      ? this.resolveTemplate(data.fileName, context).replace(/\{\{original\}\}/g, originalName)
      : originalName;

    // Determine save path
    let savePath: string;
    if (data.savePath) {
      const resolvedPath = this.resolveTemplate(data.savePath, context);
      if (resolvedPath.includes('{{basket}}')) {
        savePath = resolvedPath.replace(/\{\{basket\}\}/g, '/data/incoming');
      } else {
        savePath = resolvedPath;
      }
      savePath = path.join(savePath, fileName);
    } else {
      savePath = path.join('/data/incoming', fileName);
    }

    // Ensure directory exists
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save file
    const writer = fs.createWriteStream(savePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });

    const stats = fs.statSync(savePath);

    return {
      status: response.status,
      url,
      localPath: savePath,
      fileName,
      size: stats.size,
      contentType: response.headers['content-type'],
      timestamp: new Date().toISOString(),
    };
  }

  private extractFileName(url: string, headers: any): string {
    // Try Content-Disposition header
    const disposition = headers['content-disposition'];
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match) return match[1].replace(/['"]/g, '');
    }

    // Try URL path
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split('/').pop();
      if (fileName) return fileName;
    } catch {}

    return `download-${Date.now()}`;
  }

  /**
   * Override to use base class resolveTemplate which supports standard naming:
   * - path.xxx -> URL path parameters
   * - query.xxx -> Query string parameters
   * - body.xxx -> Request body fields
   * - header.xxx -> HTTP headers
   */
  protected resolveTemplate(template: string, context: ExecutionContext): string {
    if (typeof template !== 'string') return template;
    if (!template.includes('{{') && !template.includes('${')) return template;

    // Use base class implementation with standard naming convention
    return super.resolveTemplate(template, context);
  }

  private resolveObjectTemplates(obj: any, context: ExecutionContext): any {
    if (typeof obj === 'string') {
      return this.resolveTemplate(obj, context);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveObjectTemplates(item, context));
    }
    if (typeof obj === 'object' && obj !== null) {
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveObjectTemplates(value, context);
      }
      return resolved;
    }
    return obj;
  }

  /**
   * Look up connection config from database
   */
  private async getConnectionConfig(connectionId: string): Promise<ConnectionHTTPConfig> {
    const conn = await prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!conn) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    let config: any = {};
    try {
      config = typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config;
    } catch {
      config = conn.config || {};
    }

    return config as ConnectionHTTPConfig;
  }

  /**
   * Build merged headers from connection config + node data
   * Priority: node headers > connection auth headers > connection default headers
   */
  private buildMergedHeaders(
    data: HttpRequestData,
    connConfig: ConnectionHTTPConfig | null,
    context: ExecutionContext
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    // 1. Connection default headers
    if (connConfig?.headers) {
      Object.assign(headers, connConfig.headers);
    }

    // 2. Connection auth headers
    if (connConfig?.authType && connConfig.authType !== 'none' && connConfig.auth) {
      switch (connConfig.authType) {
        case 'basic': {
          const username = connConfig.auth.username || '';
          const password = connConfig.auth.password || '';
          headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
          break;
        }
        case 'bearer': {
          if (connConfig.auth.token) {
            headers['Authorization'] = `Bearer ${connConfig.auth.token}`;
          }
          break;
        }
        case 'api-key': {
          const headerName = connConfig.auth.apiKeyHeader || 'X-API-Key';
          if (connConfig.auth.apiKey) {
            headers[headerName] = connConfig.auth.apiKey;
          }
          break;
        }
      }
    }

    // 3. Node-level headers (highest priority, can override connection headers)
    if (data.headers) {
      let nodeHeaders: Record<string, string>;
      if (typeof data.headers === 'string') {
        try {
          nodeHeaders = JSON.parse(data.headers);
        } catch {
          nodeHeaders = {};
        }
      } else {
        nodeHeaders = data.headers;
      }
      const resolvedNodeHeaders = this.resolveObjectTemplates(nodeHeaders, context);
      Object.assign(headers, resolvedNodeHeaders);
    }

    return headers;
  }
}
