// Execution Engine SDK Types

export interface ExecutionNode {
  id: string;
  type: string;
  data?: Record<string, any>;
}

export interface ExecutionEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface FlowDefinition {
  operationId: string;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
}

export interface ExecutionInput {
  method: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, any>;
  body?: any;
  params?: Record<string, any>;
}

export interface ExecutionResult {
  success: boolean;
  statusCode: number;
  data?: any;
  error?: string;
  metadata: {
    operationId: string;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    nodeResults: NodeExecutionResult[];
  };
}

export interface NodeExecutionResult {
  nodeId: string;
  nodeType: string;
  success: boolean;
  output?: any;
  error?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
}

export interface ExecutionContext {
  flow: FlowDefinition;
  input: ExecutionInput;
  variables: Map<string, any>;
  nodeResults: Map<string, NodeExecutionResult>;
  logs: ExecutionLog[];
  apiSpec?: any; // OpenAPI spec for response schema validation/transform
}

export interface ExecutionLog {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  nodeId?: string;
  message: string;
  data?: any;
}

export interface NodeExecutorConfig {
  type: string;
  execute: (node: ExecutionNode, context: ExecutionContext) => Promise<any>;
}

export interface EngineConfig {
  connections: Map<string, any>;
  middlewares?: ExecutionMiddleware[];
  // Wall-clock deadline (epoch ms). The engine checks this between nodes and
  // between for-each batches and aborts the run once passed, so a flow with a
  // huge item list can't grind on for days.
  deadlineAt?: number;
  onLog?: (log: ExecutionLog) => void;
  onNodeStart?: (nodeId: string, context: ExecutionContext) => void;
  onNodeComplete?: (nodeId: string, result: NodeExecutionResult, context: ExecutionContext) => void;
  onNodeError?: (nodeId: string, error: Error, context: ExecutionContext) => void;
  apiSpec?: any; // OpenAPI spec for response schema
}

export type ExecutionMiddleware = (
  context: ExecutionContext,
  next: () => Promise<void>
) => Promise<void>;
