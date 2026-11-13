import { nodeRegistry } from '../nodeRegistry';

const apiNodes = [
  {
    type: 'api-input',
    category: 'api',
    label: 'API Input',
    icon: 'fa-sign-in-alt',
    color: 'bg-blue-500',
    description: 'HTTP Endpoint',
    supportedFlowTypes: ['rest-api'] as const,
    ports: [{ id: 'out', type: 'output' as const, position: 'right' as const }]
  },
  {
    type: 'api-output',
    category: 'api',
    label: 'API Output',
    icon: 'fa-sign-out-alt',
    color: 'bg-blue-600',
    description: 'HTTP Response',
    supportedFlowTypes: ['rest-api'] as const,
    ports: [{ id: 'in', type: 'input' as const, position: 'left' as const }]
  }
];

const eventNodes = [
  {
    type: 'basket-trigger',
    category: 'trigger',
    label: 'Basket',
    icon: 'fa-folder-open',
    color: 'bg-amber-500',
    description: 'File basket',
    supportedFlowTypes: ['event'] as const,
    ports: [{ id: 'out', type: 'output' as const, position: 'right' as const }]
  },
  {
    type: 'sftp-action',
    category: 'action',
    label: 'SFTP Transfer',
    icon: 'fa-server',
    color: 'bg-teal-500',
    description: 'SFTP upload/download',
    supportedFlowTypes: ['event'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  },
  {
    type: 'basket-action',
    category: 'action',
    label: 'File Basket',
    icon: 'fa-archive',
    color: 'bg-amber-600',
    description: 'Copy/ZIP/Organize files',
    supportedFlowTypes: ['event'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  },
  {
    type: 'email-action',
    category: 'action',
    label: 'Email',
    icon: 'fa-envelope',
    color: 'bg-rose-500',
    description: 'Send email via SMTP',
    supportedFlowTypes: ['event'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  },
  {
    type: 'delay',
    category: 'processing',
    label: 'Delay',
    icon: 'fa-hourglass-half',
    color: 'bg-purple-500',
    description: 'Wait/delay',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  }
];

// Unified integration nodes
const integrationNodes = [
  {
    type: 'http-request',
    category: 'integration',
    label: 'HTTP Request',
    icon: 'fa-globe',
    color: 'bg-sky-500',
    description: 'HTTP API / Download',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'file-read',
    category: 'integration',
    label: 'File Read',
    icon: 'fa-file-import',
    color: 'bg-lime-500',
    description: 'Read & Parse files',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'file-write',
    category: 'integration',
    label: 'File Write',
    icon: 'fa-file-export',
    color: 'bg-orange-500',
    description: 'Create files',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'database',
    category: 'integration',
    label: 'Database',
    icon: 'fa-database',
    color: 'bg-indigo-500',
    description: 'SQL operations',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'ocr',
    category: 'integration',
    label: 'OCR',
    icon: 'fa-file-alt',
    color: 'bg-purple-500',
    description: 'Extract text from documents',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  },
  {
    type: 'file-encrypt',
    category: 'integration',
    label: 'File Encrypt',
    icon: 'fa-lock',
    color: 'bg-emerald-500',
    description: 'Encrypt files (PGP/RSA/AES)',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'file-decrypt',
    category: 'integration',
    label: 'File Decrypt',
    icon: 'fa-unlock',
    color: 'bg-emerald-600',
    description: 'Decrypt files (PGP/RSA/AES)',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'data-admin',
    category: 'integration',
    label: 'Data Admin',
    icon: 'fa-table',
    color: 'bg-violet-600',
    description: 'Read from Data Catalog',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'in-top', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const },
      { id: 'out-bottom', type: 'output' as const, position: 'bottom' as const }
    ]
  }
];

const processingNodes = [
  {
    type: 'transform',
    category: 'processing',
    label: 'Transform',
    icon: 'fa-exchange-alt',
    color: 'bg-cyan-500',
    description: 'Transform data',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  },
  {
    type: 'condition',
    category: 'processing',
    label: 'Condition',
    icon: 'fa-code-branch',
    color: 'bg-pink-500',
    description: 'If/Else logic',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'true', type: 'output' as const, position: 'right' as const },
      { id: 'false', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'for-each',
    category: 'processing',
    label: 'For Each',
    icon: 'fa-redo',
    color: 'bg-emerald-500',
    description: 'Loop over items',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'body', type: 'output' as const, position: 'bottom' as const },
      { id: 'done', type: 'output' as const, position: 'right' as const }
    ]
  }
];

// Aggregate nodes for Fan-out/Fan-in pattern
const aggregateNodes = [
  {
    type: 'aggregate-split',
    category: 'aggregate',
    label: 'Fan Out (Split)',
    icon: 'fa-sitemap',
    color: 'bg-violet-500',
    description: 'Split execution into parallel branches',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in', type: 'input' as const, position: 'left' as const },
      { id: 'out1', type: 'output' as const, position: 'right' as const },
      { id: 'out2', type: 'output' as const, position: 'right' as const },
      { id: 'out3', type: 'output' as const, position: 'bottom' as const }
    ]
  },
  {
    type: 'aggregate-join',
    category: 'aggregate',
    label: 'Fan In (Join)',
    icon: 'fa-compress-alt',
    color: 'bg-fuchsia-500',
    description: 'Merge results from parallel branches',
    supportedFlowTypes: ['all'] as const,
    ports: [
      { id: 'in1', type: 'input' as const, position: 'left' as const },
      { id: 'in2', type: 'input' as const, position: 'left' as const },
      { id: 'in3', type: 'input' as const, position: 'top' as const },
      { id: 'out', type: 'output' as const, position: 'right' as const }
    ]
  }
];

export function registerAllNodes(): void {
  const allNodes = [...apiNodes, ...eventNodes, ...integrationNodes, ...processingNodes, ...aggregateNodes];
  console.log('[NodeRegistry] Registering', allNodes.length, 'nodes:', allNodes.map(n => n.type));
  allNodes.forEach(node => {
    nodeRegistry.register(node);
  });
  console.log('[NodeRegistry] Total registered:', nodeRegistry.getAll().length);
}

export { apiNodes, eventNodes, integrationNodes, processingNodes, aggregateNodes };
