// API Output Node Executor - Formats API response with auto-transform

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import * as fs from 'fs';
import * as path from 'path';

interface FieldMapping {
  source: string;      // e.g., "rows", "rows[0].name", "count"
  target: string;      // e.g., "data", "name", "total"
  transform?: string;  // optional: "string", "number", "boolean", "date", "array"
}

interface ApiOutputNodeData {
  statusCode: number;
  body?: any;
  headers?: Record<string, string>;

  // Schema-based Transform (from API Spec)
  useApiSpecSchema?: boolean; // Auto transform based on API Spec response schema

  // Auto Transform Configuration
  autoTransform?: boolean;
  responseType?: 'object' | 'array' | 'string' | 'number' | 'boolean';
  fieldMappings?: FieldMapping[];
  wrapInDataKey?: boolean;  // wrap result in { data: ... }
  includeMetadata?: boolean; // include _meta: { count, timestamp }

  // File download mode - stream file instead of JSON response
  responseMode?: 'json' | 'file';  // default: 'json'

  // Legacy/simple mode
  mapping?: string;  // JavaScript expression (legacy)
}

export class ApiOutputExecutor extends NodeExecutor {
  readonly type = 'api-output';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as ApiOutputNodeData;

    // File download mode - stream file instead of JSON
    if (data.responseMode === 'file') {
      return this.handleFileDownload(node, context, data);
    }

    // Auto-detect file download from previous node (e.g., file-read with parseAs: 'download')
    const prevInput = this.getFromPreviousNode(node.id, context);
    if (prevInput?._fileDownload) {
      this.log(context, 'info', 'API Output: Auto-detected file download from input');
      return {
        statusCode: data.statusCode || 200,
        body: prevInput,
      };
    }

    let body: any;
    let transformMode = 'default';
    
    // Priority 1: Schema-based Transform (from API Spec)
    if (data.useApiSpecSchema !== false && context.apiSpec) {
      body = this.executeSchemaTransform(context, node.id);
      transformMode = 'schema';
    }
    // Priority 2: Auto Transform Mode
    else if (data.autoTransform) {
      body = this.executeAutoTransform(data, context);
      transformMode = 'auto';
    }
    // Priority 3: Legacy mapping (JavaScript expression)
    else if (data.mapping) {
      body = this.executeMapping(data.mapping, context);
      transformMode = 'mapping';
    }
    // Priority 4: Static body
    else if (data.body !== undefined) {
      body = this.resolveBody(data.body, context);
      transformMode = 'static';
    }
    // Priority 5: Get from previous node
    else {
      body = this.getFromPreviousNode(node.id, context);
      transformMode = 'previous';
    }
    
    // Apply response type conversion
    body = this.convertResponseType(body, data.responseType);
    
    // Wrap in data key if configured
    if (data.wrapInDataKey && !body?.data) {
      const result: any = { data: body };
      if (data.includeMetadata) {
        result._meta = this.generateMetadata(body);
      }
      body = result;
    }

    const response = {
      statusCode: data.statusCode || 200,
      body,
      headers: data.headers || { 'Content-Type': 'application/json' },
    };

    // Debug logging
    this.log(context, 'debug', 'API Output Response', {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      transformMode,
      fieldMappings: data.fieldMappings,
    });

    return response;
  }
  
  /**
   * Schema-based Transform: Transform data to match API Spec Response Schema
   */
  private executeSchemaTransform(context: ExecutionContext, nodeId: string): any {
    const input = this.getFromPreviousNode(nodeId, context);
    const apiSpec = context.apiSpec;
    const operationId = context.flow.operationId;
    
    // Debug logging
    this.log(context, 'debug', 'API Output Schema Transform', {
      input,
      inputType: typeof input,
      isArray: Array.isArray(input),
      hasApiSpec: !!apiSpec,
      operationId,
      availableOperations: apiSpec?.operations?.map((o: any) => o.id),
    });
    
    // Find current operation in apiSpec
    const operation = apiSpec?.operations?.find((op: any) => op.id === operationId);
    if (!operation) {
      this.log(context, 'debug', 'API Output: No operation found in apiSpec, using auto-detect');
      return this.autoDetectTransform(input);
    }
    
    // Find 200/201 response schema
    const successResponse = operation.responses?.find((r: any) => r.code === '200' || r.code === '201');
    if (!successResponse?.content?.['application/json']?.schema) {
      console.log('[ApiOutputExecutor] No response schema found, using auto-detect');
      return this.autoDetectTransform(input);
    }
    
    const schema = successResponse.content['application/json'].schema;
    this.log(context, 'debug', 'API Output: Transforming with schema', {
      schemaType: schema.type,
      hasProperties: !!schema.properties,
      propertyKeys: schema.properties ? Object.keys(schema.properties) : [],
    });
    
    // Get source data (usually rows from database)
    let sourceData = input;
    if (input?.rows && Array.isArray(input.rows)) {
      sourceData = input.rows;
    }
    
    // Transform based on schema type
    if (schema.type === 'array' && Array.isArray(sourceData)) {
      // Array response - transform each item
      const itemsSchema = schema.items || { type: 'object' };
      return sourceData.map((item: any) => this.transformItemBySchema(item, itemsSchema));
    } else if (schema.type === 'object' && Array.isArray(sourceData)) {
      // Object response but source is array (wrap with data key or use first item)
      if (schema.properties?.data?.type === 'array') {
        // { data: [...], total: n } format
        const result: any = {};
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key === 'data' && (propSchema as any).type === 'array') {
            result[key] = sourceData.map((item: any) => 
              this.transformItemBySchema(item, (propSchema as any).items || { type: 'object' })
            );
          } else if (key === 'total' && (propSchema as any).type === 'integer') {
            // Calculate total from rowCount or array length
            result[key] = input?.rowCount || sourceData.length || 0;
          } else {
            result[key] = this.transformValueBySchema(input?.[key], propSchema as any);
          }
        }
        return result;
      } else {
        // Single object - take first array item
        return this.transformItemBySchema(sourceData[0], schema);
      }
    } else if (schema.type === 'object' && typeof sourceData === 'object') {
      // Single object response
      return this.transformItemBySchema(sourceData, schema);
    }
    
    // Default: return as-is
    this.log(context, 'debug', 'API Output: Schema transform - no match, returning as-is', {
      schemaType: schema.type,
      sourceDataType: typeof sourceData,
      isArray: Array.isArray(sourceData),
    });
    return sourceData;
  }
  
  /**
   * Transform a single item according to schema properties
   */
  private transformItemBySchema(item: any, schema: any): any {
    if (!item || typeof item !== 'object') return item;
    if (!schema.properties) return item;
    
    const result: Record<string, any> = {};
    
    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      const propSchema = fieldSchema as any;
      
      // Find matching source field (case-insensitive, snake_case to camelCase)
      const sourceValue = this.findMatchingField(item, fieldName);
      
      // Transform value by schema type
      result[fieldName] = this.transformValueBySchema(sourceValue, propSchema);
    }
    
    return result;
  }
  
  /**
   * Find matching field in source object (handles snake_case to camelCase and vice versa)
   */
  private findMatchingField(source: any, targetField: string): any {
    if (!source || typeof source !== 'object') return undefined;
    
    // Direct match
    if (source[targetField] !== undefined) return source[targetField];
    
    // camelCase to snake_case (e.g., deptCode -> agc_code)
    const snakeCase = targetField.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (source[snakeCase] !== undefined) return source[snakeCase];
    
    // camelCase to UPPER_CASE (e.g., deptCode -> DEPT_CODE)
    const upperCase = targetField.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
    if (source[upperCase] !== undefined) return source[upperCase];
    
    // snake_case to camelCase (e.g., agc_code -> deptCode)
    const camelCase = targetField.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (source[camelCase] !== undefined) return source[camelCase];
    
    // Case-insensitive search
    const lowerTarget = targetField.toLowerCase().replace(/_/g, '');
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase().replace(/_/g, '') === lowerTarget) return value;
    }
    
    return undefined;
  }
  
  /**
   * Transform value according to schema type
   */
  private transformValueBySchema(value: any, schema: any): any {
    if (value === undefined || value === null) return value;
    
    const type = schema.type || 'string';
    
    switch (type) {
      case 'string':
        return String(value);
      case 'integer':
      case 'number':
        return Number(value);
      case 'boolean':
        return Boolean(value);
      case 'array':
        if (Array.isArray(value)) {
          return value.map(item => this.transformValueBySchema(item, schema.items || { type: 'object' }));
        }
        return [value];
      case 'object':
        if (schema.properties && typeof value === 'object') {
          return this.transformItemBySchema(value, schema);
        }
        return value;
      default:
        return value;
    }
  }
  
  /**
   * Auto Transform: Automatically map fields from previous node (usually database)
   */
  private executeAutoTransform(data: ApiOutputNodeData, context: ExecutionContext): any {
    const input = this.getFromPreviousNode(context.flow.nodes.find(n => n.data === data)?.id || '', context);
    
    // If no field mappings, return input as-is or extract common patterns
    if (!data.fieldMappings || data.fieldMappings.length === 0) {
      return this.autoDetectTransform(input);
    }
    
    // Apply field mappings
    const result: Record<string, any> = {};
    
    for (const mapping of data.fieldMappings) {
      const value = this.getValueFromObjectByPath(input, mapping.source);
      const transformedValue = this.transformValue(value, mapping.transform);
      this.setValueToObjectByPath(result, mapping.target, transformedValue);
    }
    
    return result;
  }
  
  /**
   * Auto detect common patterns (e.g., database result { rows: [...] } -> [...])
   */
  private autoDetectTransform(input: any): any {
    if (!input) return input;
    
    // Pattern 1: Database result { rows: [...], rowCount: n }
    if (input.rows && Array.isArray(input.rows)) {
      return input.rows;
    }
    
    // Pattern 2: HTTP response { data: ..., status: ... }
    if (input.data !== undefined && (input.status || input.statusCode)) {
      return input.data;
    }
    
    // Pattern 3: Single row result
    if (input.row && typeof input.row === 'object') {
      return input.row;
    }
    
    // Default: return as-is
    return input;
  }
  
  /**
   * Transform value to specified type
   */
  private transformValue(value: any, transform?: string): any {
    if (value === undefined || value === null) return value;
    
    switch (transform) {
      case 'string':
        return String(value);
      case 'number':
        return Number(value);
      case 'boolean':
        return Boolean(value);
      case 'date':
        return value instanceof Date ? value.toISOString() : String(value);
      case 'array':
        return Array.isArray(value) ? value : [value];
      default:
        return value;
    }
  }
  
  /**
   * Convert response to specified type
   */
  private convertResponseType(body: any, responseType?: string): any {
    switch (responseType) {
      case 'array':
        return Array.isArray(body) ? body : (body ? [body] : []);
      case 'string':
        return typeof body === 'string' ? body : JSON.stringify(body);
      case 'number':
        return Number(body);
      case 'boolean':
        return Boolean(body);
      case 'object':
      default:
        return typeof body === 'object' ? body : { value: body };
    }
  }
  
  /**
   * Execute legacy JavaScript mapping expression
   */
  private executeMapping(mapping: string, context: ExecutionContext): any {
    try {
      // Get input from previous node
      const input = this.getFromPreviousNode('', context);
      
      // Debug logging
      this.log(context, 'debug', 'API Output: Executing mapping expression', { mapping, input });
      
      // Create safe function with context variables
      const fn = new Function('input', 'path', 'query', 'body', 'header', 'vars', `
        "use strict";
        return ${mapping};
      `);
      
      const result = fn(
        input,
        context.input?.params,
        context.input?.query,
        context.input?.body,
        context.input?.headers,
        Object.fromEntries(context.variables || new Map())
      );
      
      this.log(context, 'debug', 'API Output: Mapping result', { result });
      return result;
    } catch (error) {
      this.log(context, 'error', 'API Output: Mapping error', { error: error instanceof Error ? error.message : String(error) });
      return { error: 'Invalid mapping expression' };
    }
  }
  
  /**
   * Resolve template in body
   */
  private resolveBody(body: any, context: ExecutionContext): any {
    if (typeof body === 'string') {
      return this.resolveTemplate(body, context);
    }
    if (typeof body === 'object' && body !== null) {
      const resolved: any = {};
      for (const [key, value] of Object.entries(body)) {
        resolved[key] = typeof value === 'string' 
          ? this.resolveTemplate(value, context)
          : value;
      }
      return resolved;
    }
    return body;
  }
  
  /**
   * Get output from previous connected node
   */
  private getFromPreviousNode(nodeId: string, context: ExecutionContext): any {
    if (!context.nodeResults) return undefined;
    
    const incomingEdge = context.flow.edges.find(e => e.target === nodeId);
    if (incomingEdge) {
      const prevResult = context.nodeResults.get(incomingEdge.source);
      if (prevResult?.output) {
        return prevResult.output;
      }
    }
    
    // Fallback: try to get from last executed node
    const lastNodeId = Array.from(context.nodeResults.keys()).pop();
    if (lastNodeId) {
      return context.nodeResults.get(lastNodeId)?.output;
    }
    
    return undefined;
  }
  
  /**
   * Generate metadata for response
   */
  private generateMetadata(body: any): Record<string, any> {
    const meta: Record<string, any> = {
      timestamp: new Date().toISOString(),
    };
    
    if (Array.isArray(body)) {
      meta.count = body.length;
    } else if (body && typeof body === 'object') {
      meta.count = Object.keys(body).length;
    }
    
    return meta;
  }
  
  /**
   * Get value from object by dot-notation path
   */
  private getValueFromObjectByPath(obj: any, path: string): any {
    if (!path) return obj;
    const keys = path.split('.');
    let value = obj;
    
    for (const key of keys) {
      if (value === null || value === undefined) return undefined;
      
      // Handle array index like "rows[0]"
      const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
      if (arrayMatch) {
        const arr = value[arrayMatch[1]];
        if (Array.isArray(arr)) {
          value = arr[parseInt(arrayMatch[2])];
        } else {
          return undefined;
        }
      } else {
        value = value[key];
      }
    }
    
    return value;
  }
  
  /**
   * Set value to object by dot-notation path
   */
  private setValueToObjectByPath(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Handle file download response - returns special _fileDownload marker
   * so the HTTP handler can stream the file instead of returning JSON
   */
  private handleFileDownload(node: ExecutionNode, context: ExecutionContext, data: ApiOutputNodeData): any {
    const input = this.getFromPreviousNode(node.id, context);

    this.log(context, 'debug', 'API Output: File download mode', { input });

    // Extract file info from input (from file-read list mode or direct path)
    let filePath: string | undefined;
    let fileName: string | undefined;
    let mimeType: string = 'application/octet-stream';

    // Pattern 1: file-read list mode output { files: [{ data: { path, fileName } }] }
    if (input?.files && Array.isArray(input.files) && input.files.length > 0) {
      const file = input.files[0];
      const fileData = file.data || file;
      filePath = fileData.path;
      fileName = fileData.fileName || fileData.name;
    }
    // Pattern 2: Direct file info { path, fileName }
    else if (input?.path) {
      filePath = input.path;
      fileName = input.fileName || input.name || path.basename(input.path);
    }
    // Pattern 3: file-read single file { data: { path, fileName } }
    else if (input?.data?.path) {
      filePath = input.data.path;
      fileName = input.data.fileName || input.data.name || path.basename(input.data.path);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      this.log(context, 'error', 'API Output: File not found for download', { filePath, input });
      return {
        statusCode: 404,
        body: { error: 'File not found', path: filePath },
        headers: { 'Content-Type': 'application/json' },
      };
    }

    // Detect MIME type from extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.zip': 'application/zip',
      '.pdf': 'application/pdf',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.txt': 'text/plain',
    };
    mimeType = mimeTypes[ext] || 'application/octet-stream';

    const fileSize = fs.statSync(filePath).size;
    fileName = fileName || path.basename(filePath);

    this.log(context, 'info', `API Output: File download - ${fileName} (${fileSize} bytes)`, { filePath, fileName, mimeType, fileSize });

    // Return special marker inside body for HTTP handler to stream the file
    // ExecutionEngine maps result.body -> result.data, so _fileDownload must be in body
    return {
      statusCode: data.statusCode || 200,
      body: {
        _fileDownload: {
          filePath,
          fileName,
          mimeType,
          fileSize,
        },
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'Content-Length': String(fileSize),
        },
      },
    };
  }
}
