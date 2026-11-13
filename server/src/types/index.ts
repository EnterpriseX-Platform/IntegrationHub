export type FlowType = 'apispec' | 'trigger';
export type FlowStatus = 'Active' | 'Inactive' | 'Draft';
export type ExecutionStatus = 'Running' | 'Completed' | 'Failed' | 'Pending';
export type ConnectionType = 'database' | 'sftp' | 'http';
export type ConnectionStatus = 'Connected' | 'Disconnected' | 'Error';
export type NodeType = 
  | 'api-input' | 'api-output' | 'trigger' | 'webhook' 
  | 'sftp' | 'http' | 'database' 
  | 'transform' | 'loop' | 'condition';

export interface FlowNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  label: string;
  config: string;
}

export interface NodeConnection {
  source: string;
  target: string;
}

export interface Flow {
  id: string;
  projectId: string;
  name: string;
  type: FlowType;
  status: FlowStatus;
  nodes?: FlowNode[];
  connections?: NodeConnection[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiSpec {
  id: string;
  projectId: string;
  name: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  status: FlowStatus;
  description?: string;
  baseUrl?: string;
  parameters?: ApiParameter[];
  responses?: ApiResponse[];
}

export interface ApiParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiResponse {
  code: string;
  description: string;
  example?: any;
}

export interface Connection {
  id: string;
  projectId: string;
  name: string;
  type: ConnectionType;
  status: ConnectionStatus;
  config?: ConnectionConfig;
  createdAt: string;
}

export interface ConnectionConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  database?: string;
  url?: string;
  protocol?: string;
  timeout?: number;
}

export interface SchedulerEntry {
  id: string;
  projectId: string;
  flowId: string;
  flow: string;
  type: FlowType;
  schedule: string;
  status: FlowStatus;
  nextRun: string;
}

export interface Execution {
  id: string;
  // Nullable because non-flow sources (e.g. data-repository imports) also
  // create execution rows. For traditional flow runs these are still populated.
  flowId: string | null;
  projectId: string | null;
  // 'flow' | 'repo-import'
  sourceType?: string;
  sourceId?: string | null;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  logs?: ExecutionLog[];
  result?: any;
}

export interface ExecutionLog {
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning';
  message: string;
  nodeId?: string;
  nodeName?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: 'Active' | 'Inactive';
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiResponseWrapper<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
