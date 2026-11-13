import type { ApiResponse, Flow, ExecutionResult } from '../types/index.js';

const API_URL = process.env.API_URL || 'http://localhost:3001/api';

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_URL) {
    this.baseUrl = baseUrl;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }
    
    return response.json();
  }

  // Flow Operations
  async getFlow(flowId: string): Promise<ApiResponse<Flow>> {
    return this.fetch<Flow>(`/flows/${flowId}`);
  }

  async updateFlow(flowId: string, data: Partial<Flow>): Promise<ApiResponse<Flow>> {
    return this.fetch<Flow>(`/flows/${flowId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async executeFlow(flowId: string, parameters?: Record<string, any>): Promise<ApiResponse<ExecutionResult>> {
    return this.fetch<ExecutionResult>(`/flows/${flowId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ parameters }),
    });
  }

  async getExecutions(flowId: string, limit: number = 10): Promise<ApiResponse<any[]>> {
    return this.fetch<any[]>(`/executions?flowId=${flowId}&limit=${limit}`);
  }

  async getExecutionLogs(executionId: string): Promise<ApiResponse<any>> {
    return this.fetch<any>(`/executions/${executionId}/logs`);
  }

  // Project Operations
  async getProject(projectId: string): Promise<ApiResponse<any>> {
    return this.fetch<any>(`/projects/${projectId}`);
  }

  async getProjectFlows(projectId: string): Promise<ApiResponse<Flow[]>> {
    return this.fetch<Flow[]>(`/projects/${projectId}/flows`);
  }
}

export const apiClient = new ApiClient();
