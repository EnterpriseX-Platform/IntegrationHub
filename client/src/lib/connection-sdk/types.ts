// Connection Type Definition
export interface ConnectionTypeDefinition {
  id: ConnectionType;
  name: string;
  description: string;
  category: 'database' | 'storage' | 'api' | 'messaging' | 'custom';
  icon: string; // FontAwesome class
  iconComponent?: React.ComponentType;
  colors: {
    bg: string;
    text: string;
    border: string;
    gradient?: string;
  };
  fields: ConnectionField[];
  testConnection?: (config: any) => Promise<TestResult>;
}

// Field definition for each connection type
export interface ConnectionField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'textarea' | 'checkbox' | 'file';
  required?: boolean;
  placeholder?: string;
  defaultValue?: any;
  options?: { value: string; label: string; icon?: string }[]; // For select type
  validation?: {
    pattern?: RegExp;
    min?: number;
    max?: number;
    message?: string;
  };
  dependsOn?: {
    field: string;
    value: any;
  };
  helpText?: string;
  secret?: boolean; // For password fields
}

// Database sub-types
export interface DatabaseSubtype {
  id: string;
  name: string;
  icon: string;
  defaultPort: number;
  driver?: string;
  fields: ConnectionField[];
}

// Test result
export interface TestResult {
  success: boolean;
  latency?: number;
  message: string;
  error?: string;
  details?: Record<string, any>;
}

// Connection types
export type ConnectionType = 
  | 'database'
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'oracle'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'sftp'
  | 'ftp'
  | 's3'
  | 'google-drive'
  | 'dropbox'
  | 'onedrive'
  | 'rest-api'
  | 'graphql'
  | 'soap'
  | 'kafka'
  | 'rabbitmq'
  | 'mqtt'
  | 'webhook'
  | 'custom'
  | string;

// Connection config interface
export interface ConnectionConfig {
  [key: string]: any;
}

// Connection interface
export interface Connection {
  id: string;
  projectId: string;
  name: string;
  type: ConnectionType;
  subtype?: string; // For databases: postgresql, mysql, etc.
  config: ConnectionConfig;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt?: Date;
  lastTestStatus?: 'success' | 'failed';
}
