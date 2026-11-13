// Project Types
export interface Project {
  id: string;
  name: string;
  description: string;
  flows: Flow[];
  connections: Connection[];
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'inactive' | 'archived';
}

// Flow Types
export interface Flow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  connections: NodeConnection[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
  executionCount: number;
}

// Connection Types (External API/Service Connections)
export interface Connection {
  id: string;
  projectId: string;
  name: string;
  type: ConnectionType;
  config: ConnectionConfig | DatabaseConfig | SFTPConfig | HTTPConfig | GoogleDriveConfig | SMTPConfig;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt?: Date;
  lastTestStatus?: 'success' | 'failed';
}

export type ConnectionType = 
  | 'rest-api'
  | 'graphql'
  | 'database'
  | 'message-queue'
  | 'file-storage'
  | 'oauth2'
  | 'custom'
  | 'sftp'
  | 'http'
  | 'google-drive'
  | 'smtp';

// Database Connection Types
export type DatabaseType = 'postgresql' | 'mysql' | 'sqlite' | 'oracle' | 'mssql' | 'mongodb';

export interface DatabaseConfig {
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
  sslMode?: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  connectionString?: string; // For SQLite or custom connection strings
  schema?: string;
  options?: Record<string, unknown>;
}

// SFTP Connection Types
export interface SFTPConfig {
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private-key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  basePath?: string;
}

// SMTP Connection (Send Email node)
export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  allowSelfSigned: boolean;
}

// HTTP Connection Types
export interface HTTPConfig {
  baseUrl: string;
  authType: 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2';
  auth?: HTTPAuthConfig;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  verifySsl?: boolean;
}

// Google Drive Connection Types
export interface GoogleDriveConfig {
  authType: 'oauth2' | 'service-account';
  // OAuth2
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  // Service Account
  serviceAccountKey?: string; // JSON key file content
  serviceAccountEmail?: string;
  privateKey?: string;
  // Settings
  folderId?: string; // Default folder to use
  sharedDriveId?: string; // Shared drive ID (optional)
}

export interface HTTPAuthConfig {
  // Basic Auth
  username?: string;
  password?: string;
  // Bearer Token
  token?: string;
  // API Key
  apiKey?: string;
  apiKeyHeader?: string;
  // OAuth2
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ConnectionConfig {
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: AuthConfig;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  customProperties?: Record<string, unknown>;
}

export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2';
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface RetryPolicy {
  maxRetries: number;
  retryDelay: number;
  backoffMultiplier: number;
  retryOnStatusCodes: number[];
}

// Flow Node Types
export interface FlowNode {
  id: string;
  type: NodeType;
  position: Position;
  data: NodeData;
  config?: NodeConfig;
}

export type NodeType =
  | 'trigger'
  | 'action'
  | 'condition'
  | 'transform'
  | 'delay'
  | 'merge'
  | 'split'
  | 'custom';

export interface Position {
  x: number;
  y: number;
}

export interface NodeData {
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  connectionId?: string;
  operation?: string;
}

export interface NodeConfig {
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  condition?: ConditionConfig;
  transform?: TransformConfig;
  delay?: DelayConfig;
  customCode?: string;
}

export interface ConditionConfig {
  operator: 'and' | 'or';
  rules: ConditionRule[];
}

export interface ConditionRule {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'endsWith' | 'regex';
  value: unknown;
}

export interface TransformConfig {
  type: 'map' | 'filter' | 'reduce' | 'jsonata' | 'javascript';
  expression?: string;
  mappings?: TransformMapping[];
}

export interface TransformMapping {
  source: string;
  target: string;
  transform?: string;
}

export interface DelayConfig {
  duration: number;
  unit: 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days';
}

// Node Connection Types (Connections between nodes in a flow)
export interface NodeConnection {
  id: string;
  sourceId: string;
  targetId: string;
  sourceHandle?: string;
  targetHandle?: string;
  condition?: string;
  label?: string;
}

// Execution Types
export interface Execution {
  id: string;
  flowId: string;
  projectId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  triggerType: 'manual' | 'scheduled' | 'webhook' | 'event';
  triggerData?: unknown;
  results: NodeExecutionResult[];
  error?: ExecutionError;
  logs: ExecutionLog[];
}

export type ExecutionStatus = 
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface NodeExecutionResult {
  nodeId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: ExecutionError;
}

export interface ExecutionError {
  code: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface ExecutionLog {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  nodeId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// API Specification Types
export interface ApiSpec {
  id: string;
  projectId: string;
  name: string;
  version: string;
  format: 'openapi' | 'swagger' | 'graphql' | 'asyncapi' | 'custom';
  content: string;
  parsed: OpenAPISpec | GraphQLSpec | AsyncAPISpec;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{
    url: string;
    description?: string;
  }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
}

export interface PathItem {
  summary?: string;
  description?: string;
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  parameters?: Parameter[];
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
}

export interface Parameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Schema;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, MediaType>;
}

export interface Response {
  description: string;
  content?: Record<string, MediaType>;
  headers?: Record<string, unknown>;
}

export interface MediaType {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface Schema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  format?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  nullable?: boolean;
  $ref?: string;
}

export interface SecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlows;
  openIdConnectUrl?: string;
}

export interface OAuthFlows {
  implicit?: OAuthFlow;
  password?: OAuthFlow;
  clientCredentials?: OAuthFlow;
  authorizationCode?: OAuthFlow;
}

export interface OAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

export interface GraphQLSpec {
  schema: string;
  types: GraphQLType[];
  queries: GraphQLOperation[];
  mutations: GraphQLOperation[];
  subscriptions: GraphQLOperation[];
}

export interface GraphQLType {
  name: string;
  kind: 'scalar' | 'object' | 'interface' | 'union' | 'enum' | 'input_object';
  fields?: GraphQLField[];
  enumValues?: string[];
}

export interface GraphQLField {
  name: string;
  type: string;
  args?: GraphQLArgument[];
}

export interface GraphQLArgument {
  name: string;
  type: string;
  defaultValue?: unknown;
}

export interface GraphQLOperation {
  name: string;
  description?: string;
  args: GraphQLArgument[];
  returnType: string;
}

export interface AsyncAPISpec {
  asyncapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  channels: Record<string, Channel>;
}

export interface Channel {
  description?: string;
  subscribe?: MessageOperation;
  publish?: MessageOperation;
  bindings?: Record<string, unknown>;
}

export interface MessageOperation {
  operationId?: string;
  message: Message;
}

export interface Message {
  name?: string;
  title?: string;
  contentType?: string;
  payload?: Schema;
}

// UI Mock Data Types (for demonstration)
export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  image?: string | null;
  status: 'Active' | 'Inactive';
  projectGroup?: string | null;
  agency?: string | null;
  agencyLevel?: string | null;
  flows: ProjectFlow[];
  connections: ProjectConnection[];
  scheduler?: SchedulerItem[];
  apiSpecs?: ProjectApiSpec[];
}

export interface ProjectFlow {
  id: string;
  name: string;
  type: 'trigger' | 'apispec';
  status: 'Active' | 'Inactive';
  lastRun: string;
  result: 'Success' | 'Running' | 'Failed';
}

export interface ProjectConnection {
  name: string;
  type: 'database' | 'sftp' | 'http';
  status: 'Connected' | 'Disconnected';
  detail: string;
}

export interface SchedulerItem {
  flow: string;
  type: 'trigger' | 'apispec';
  schedule: string;
  status: 'Active' | 'Inactive';
  nextRun: string;
}

export interface ProjectApiSpec {
  name: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  status: 'Active' | 'Inactive';
}
