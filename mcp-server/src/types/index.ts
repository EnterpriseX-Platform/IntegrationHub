// Types for Integration Platform MCP Server

export interface FlowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  data?: Record<string, any>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface Flow {
  id: string;
  name: string;
  projectId: string;
  type: 'rest-api' | 'event';
  status: 'Draft' | 'Active' | 'Inactive';
  nodes: FlowNode[] | string;  // API may return string that needs parsing
  connections: FlowEdge[] | string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleParameter {
  name: string;
  value: string;
  description?: string;
}

export interface ScheduleTriggerData {
  cron: string;
  timezone?: string;
  enabled?: boolean;
  parameters?: ScheduleParameter[];
}

export interface DatabaseNodeData {
  connectionId: string;
  operation: 'select' | 'insert' | 'update' | 'delete';
  sql?: string;
  table?: string;
  columnMapping?: { column: string; value: string }[];
  whereClause?: string;
}

export interface ExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionId?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
