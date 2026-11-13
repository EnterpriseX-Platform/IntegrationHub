export type NodeType = 
  | 'api-input' 
  | 'api-response' 
  | 'sftp' 
  | 'http' 
  | 'database' 
  | 'transform' 
  | 'loop' 
  | 'condition' 
  | 'schedule' 
  | 'webhook'
  | 'aggregate-split'
  | 'aggregate-join'
  | 'parallel-branch';

export interface FlowNode {
  id: string;
  type: NodeType;
  label: string;
  config?: string;
  x: number;
  y: number;
  inputs: number;
  outputs: number;
}

export interface FlowConnection {
  id: string;
  fromNodeId: string;
  fromOutput: number;
  toNodeId: string;
  toInput: number;
}

export interface Flow {
  id: string;
  name: string;
  type: 'api-spec' | 'trigger';
  status: 'draft' | 'active' | 'inactive';
  nodes: FlowNode[];
  connections: FlowConnection[];
}

export interface NodeTypeDefinition {
  type: NodeType;
  label: string;
  icon: string;
  category: 'input-output' | 'connections' | 'processing' | 'logic' | 'aggregate';
  inputs: number;
  outputs: number;
  color: string;
  bgGradient: string;
}

export const NODE_TYPES: NodeTypeDefinition[] = [
  {
    type: 'api-input',
    label: 'API Input',
    icon: 'arrow-right-circle',
    category: 'input-output',
    inputs: 0,
    outputs: 1,
    color: 'indigo',
    bgGradient: 'from-indigo-500 to-indigo-600',
  },
  {
    type: 'api-response',
    label: 'API Response',
    icon: 'arrow-left-circle',
    category: 'input-output',
    inputs: 1,
    outputs: 0,
    color: 'indigo',
    bgGradient: 'from-indigo-500 to-indigo-600',
  },
  {
    type: 'sftp',
    label: 'SFTP',
    icon: 'server',
    category: 'connections',
    inputs: 1,
    outputs: 1,
    color: 'green',
    bgGradient: 'from-emerald-500 to-emerald-600',
  },
  {
    type: 'http',
    label: 'HTTP API',
    icon: 'globe',
    category: 'connections',
    inputs: 1,
    outputs: 1,
    color: 'blue',
    bgGradient: 'from-blue-500 to-blue-600',
  },
  {
    type: 'database',
    label: 'Database',
    icon: 'database',
    category: 'connections',
    inputs: 1,
    outputs: 1,
    color: 'purple',
    bgGradient: 'from-purple-500 to-purple-600',
  },
  {
    type: 'transform',
    label: 'Transform',
    icon: 'transform',
    category: 'processing',
    inputs: 1,
    outputs: 1,
    color: 'amber',
    bgGradient: 'from-amber-500 to-amber-600',
  },
  {
    type: 'loop',
    label: 'Loop',
    icon: 'repeat',
    category: 'logic',
    inputs: 1,
    outputs: 2,
    color: 'cyan',
    bgGradient: 'from-cyan-500 to-cyan-600',
  },
  {
    type: 'condition',
    label: 'Condition',
    icon: 'git-branch',
    category: 'logic',
    inputs: 1,
    outputs: 2,
    color: 'pink',
    bgGradient: 'from-pink-500 to-pink-600',
  },
  {
    type: 'schedule',
    label: 'Schedule',
    icon: 'clock',
    category: 'input-output',
    inputs: 0,
    outputs: 1,
    color: 'red',
    bgGradient: 'from-red-500 to-red-600',
  },
  {
    type: 'webhook',
    label: 'Webhook',
    icon: 'webhook',
    category: 'input-output',
    inputs: 0,
    outputs: 1,
    color: 'red',
    bgGradient: 'from-red-500 to-red-600',
  },
];

export const getNodeTypeDefinition = (type: NodeType): NodeTypeDefinition => {
  return NODE_TYPES.find((n) => n.type === type) || NODE_TYPES[0];
};
