import type { ConnectionTypeDefinition, DatabaseSubtype } from '../types';

// Database subtypes configuration
export const databaseSubtypes: DatabaseSubtype[] = [
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    icon: 'fa-database',
    defaultPort: 5432,
    driver: 'postgresql',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 5432 },
      { name: 'database', label: 'Database Name', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { name: 'ssl', label: 'Enable SSL', type: 'checkbox', defaultValue: false },
      { name: 'schema', label: 'Schema', type: 'text', defaultValue: 'public', helpText: 'Default schema to use' },
    ],
  },
  {
    id: 'mysql',
    name: 'MySQL',
    icon: 'fa-database',
    defaultPort: 3306,
    driver: 'mysql',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 3306 },
      { name: 'database', label: 'Database Name', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { name: 'ssl', label: 'Enable SSL', type: 'checkbox', defaultValue: false },
    ],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    icon: 'fa-database',
    defaultPort: 0,
    driver: 'sqlite',
    fields: [
      { name: 'connectionString', label: 'Database File Path', type: 'text', required: true, placeholder: './data/database.db', helpText: 'Path to SQLite database file' },
    ],
  },
  {
    id: 'oracle',
    name: 'Oracle',
    icon: 'fa-database',
    defaultPort: 1521,
    driver: 'oracle',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 1521 },
      { name: 'database', label: 'Service Name', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
    ],
  },
  {
    id: 'mssql',
    name: 'SQL Server',
    icon: 'fa-database',
    defaultPort: 1433,
    driver: 'mssql',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 1433 },
      { name: 'database', label: 'Database Name', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { name: 'encrypt', label: 'Enable Encryption', type: 'checkbox', defaultValue: true },
    ],
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    icon: 'fa-database',
    defaultPort: 27017,
    driver: 'mongodb',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 27017 },
      { name: 'database', label: 'Database Name', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text', required: false },
      { name: 'password', label: 'Password', type: 'password', required: false, secret: true },
      { name: 'replicaSet', label: 'Replica Set', type: 'text', helpText: 'Optional replica set name' },
    ],
  },
  {
    id: 'redis',
    name: 'Redis',
    icon: 'fa-database',
    defaultPort: 6379,
    driver: 'redis',
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 6379 },
      { name: 'password', label: 'Password', type: 'password', secret: true },
      { name: 'database', label: 'Database Index', type: 'number', defaultValue: 0, helpText: 'Redis database index (0-15)' },
    ],
  },
];

// Main database connection type
export const databaseConnectionType: ConnectionTypeDefinition = {
  id: 'database',
  name: 'Database',
  description: 'Connect to relational and NoSQL databases',
  category: 'database',
  icon: 'fa-database',
  colors: {
    bg: 'bg-blue-100',
    text: 'text-blue-600',
    border: 'border-blue-200',
    gradient: 'from-blue-500 to-blue-600',
  },
  fields: [
    {
      name: 'subtype',
      label: 'Database Type',
      type: 'select',
      required: true,
      options: databaseSubtypes.map(s => ({
        value: s.id,
        label: s.name,
        icon: s.icon,
      })),
    },
  ],
};

// Export individual database subtypes as separate types
export const getDatabaseType = (subtype: string): ConnectionTypeDefinition => {
  const dbSubtype = databaseSubtypes.find(s => s.id === subtype);
  if (!dbSubtype) {
    throw new Error(`Unknown database subtype: ${subtype}`);
  }

  return {
    id: dbSubtype.id as any,
    name: dbSubtype.name,
    description: `Connect to ${dbSubtype.name} database`,
    category: 'database',
    icon: dbSubtype.icon,
    colors: {
      bg: 'bg-blue-100',
      text: 'text-blue-600',
      border: 'border-blue-200',
    },
    fields: dbSubtype.fields,
  };
};

// Register all database types
export function registerDatabaseTypes(register: (type: ConnectionTypeDefinition) => void): void {
  // Register main database category
  register(databaseConnectionType);
  
  // Register each database subtype
  databaseSubtypes.forEach(subtype => {
    register(getDatabaseType(subtype.id));
  });
}
