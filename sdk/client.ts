/**
 * Integration Platform Client SDK
 * Supports both Client Keys (Bearer) and Server Keys (HMAC)
 */

import crypto from 'crypto';

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  secretKey?: string; // Required for server/webhook keys (HMAC)
  timeout?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, string | number | boolean>;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    operationId: string;
    executedAt: string;
    executionTime: string;
  };
}

export class IntegrationClient {
  private config: ClientConfig;
  private keyType: 'client' | 'server' | 'webhook' | 'service';

  constructor(config: ClientConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
    
    // Detect key type from prefix
    if (config.apiKey.startsWith('apx_s_')) {
      this.keyType = 'server';
    } else if (config.apiKey.startsWith('apx_w_')) {
      this.keyType = 'webhook';
    } else if (config.apiKey.startsWith('apx_svc_')) {
      this.keyType = 'service';
    } else {
      this.keyType = 'client';
    }

    // Validate server keys have secret
    if ((this.keyType === 'server' || this.keyType === 'webhook') && !config.secretKey) {
      throw new Error(`Secret key is required for ${this.keyType} API keys`);
    }
  }

  /**
   * Generate HMAC signature for server-to-server requests
   */
  private generateHmacSignature(payload: string, timestamp: number): string {
    if (!this.config.secretKey) {
      throw new Error('Secret key not configured');
    }
    
    const dataToSign = `${timestamp}:${payload}`;
    return crypto
      .createHmac('sha256', this.config.secretKey)
      .update(dataToSign)
      .digest('hex');
  }

  /**
   * Build request headers based on key type
   */
  private buildHeaders(body?: any): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.keyType === 'client' || this.keyType === 'service') {
      // Client keys use Bearer token
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    } else {
      // Server keys use HMAC
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = body ? JSON.stringify(body) : '';
      const signature = this.generateHmacSignature(payload, timestamp);
      
      headers['X-API-Key'] = this.config.apiKey;
      headers['X-HMAC-Signature'] = signature;
      headers['X-Timestamp'] = timestamp.toString();
    }

    return headers;
  }

  /**
   * Make API request
   */
  async request<T = any>(options: RequestOptions): Promise<ApiResponse<T>> {
    const { method = 'GET', path, headers = {}, body, query } = options;

    // Build URL with query params
    let url = `${this.config.baseUrl}${path}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        params.append(key, String(value));
      });
      url += `?${params.toString()}`;
    }

    // Build headers
    const requestHeaders = {
      ...this.buildHeaders(body),
      ...headers,
    };

    // Make request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return data as ApiResponse<T>;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return { success: false, error: 'Request timeout' };
        }
        return { success: false, error: error.message };
      }
      
      return { success: false, error: 'Unknown error' };
    }
  }

  // Convenience methods
  async get<T = any>(path: string, query?: Record<string, string | number | boolean>): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'GET', path, query });
  }

  async post<T = any>(path: string, body: any): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'POST', path, body });
  }

  async put<T = any>(path: string, body: any): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'PUT', path, body });
  }

  async patch<T = any>(path: string, body: any): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'PATCH', path, body });
  }

  async delete<T = any>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>({ method: 'DELETE', path });
  }
}

// Example usage:
/*
// Client Key (simple Bearer token)
const client = new IntegrationClient({
  baseUrl: 'http://localhost:3001',
  apiKey: 'apx_c_abc123...',
});

// Server Key (HMAC signed)
const serverClient = new IntegrationClient({
  baseUrl: 'http://localhost:3001',
  apiKey: 'apx_s_def456...',
  secretKey: 'sk_ghi789...',
});

// Make requests
const result = await client.get('/api/dga/v1/users');
const created = await serverClient.post('/api/dga/v1/users', { name: 'John' });
*/

export default IntegrationClient;
