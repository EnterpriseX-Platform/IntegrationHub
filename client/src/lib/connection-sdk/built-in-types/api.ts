import type { ConnectionTypeDefinition } from '../types';

export const apiTypes: ConnectionTypeDefinition[] = [
  {
    id: 'rest-api',
    name: 'REST API',
    description: 'RESTful HTTP API',
    category: 'api',
    icon: 'fa-globe',
    colors: {
      bg: 'bg-purple-100',
      text: 'text-purple-600',
      border: 'border-purple-200',
      gradient: 'from-purple-500 to-purple-600',
    },
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'https://api.example.com' },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', defaultValue: 30000 },
      { 
        name: 'authType', 
        label: 'Authentication', 
        type: 'select', 
        required: true,
        defaultValue: 'none',
        options: [
          { value: 'none', label: 'None', icon: 'fa-unlock' },
          { value: 'basic', label: 'Basic Auth', icon: 'fa-user-lock' },
          { value: 'bearer', label: 'Bearer Token', icon: 'fa-key' },
          { value: 'api-key', label: 'API Key', icon: 'fa-shield-alt' },
          { value: 'oauth2', label: 'OAuth 2.0', icon: 'fa-user-shield' },
        ],
      },
      { name: 'username', label: 'Username', type: 'text', dependsOn: { field: 'authType', value: 'basic' } },
      { name: 'password', label: 'Password', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'basic' } },
      { name: 'token', label: 'Bearer Token', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'bearer' } },
      { name: 'apiKey', label: 'API Key', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'api-key' } },
      { name: 'apiKeyHeader', label: 'API Key Header', type: 'text', defaultValue: 'X-API-Key', dependsOn: { field: 'authType', value: 'api-key' } },
      { name: 'clientId', label: 'Client ID', type: 'text', dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'tokenUrl', label: 'Token URL', type: 'text', dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'scopes', label: 'Scopes', type: 'text', placeholder: 'read,write,admin', helpText: 'Comma-separated scopes', dependsOn: { field: 'authType', value: 'oauth2' } },
    ],
  },
  {
    id: 'graphql',
    name: 'GraphQL',
    description: 'GraphQL API endpoint',
    category: 'api',
    icon: 'fa-project-diagram',
    colors: {
      bg: 'bg-pink-100',
      text: 'text-pink-600',
      border: 'border-pink-200',
      gradient: 'from-pink-500 to-pink-600',
    },
    fields: [
      { name: 'endpoint', label: 'GraphQL Endpoint', type: 'text', required: true, placeholder: 'https://api.example.com/graphql' },
      { name: 'wsEndpoint', label: 'WebSocket Endpoint', type: 'text', placeholder: 'wss://api.example.com/graphql', helpText: 'Optional: For subscriptions' },
      { name: 'apiKey', label: 'API Key', type: 'password', secret: true },
    ],
  },
  {
    id: 'soap',
    name: 'SOAP',
    description: 'SOAP Web Service',
    category: 'api',
    icon: 'fa-envelope',
    colors: {
      bg: 'bg-indigo-100',
      text: 'text-indigo-600',
      border: 'border-indigo-200',
      gradient: 'from-indigo-500 to-indigo-600',
    },
    fields: [
      { name: 'wsdlUrl', label: 'WSDL URL', type: 'text', required: true },
      { name: 'username', label: 'Username', type: 'text' },
      { name: 'password', label: 'Password', type: 'password', secret: true },
    ],
  },
  {
    id: 'webhook',
    name: 'Webhook',
    description: 'Incoming webhook endpoint',
    category: 'api',
    icon: 'fa-webhook',
    colors: {
      bg: 'bg-teal-100',
      text: 'text-teal-600',
      border: 'border-teal-200',
      gradient: 'from-teal-500 to-teal-600',
    },
    fields: [
      { name: 'secret', label: 'Webhook Secret', type: 'password', secret: true, helpText: 'Secret for verifying webhook signatures' },
      { name: 'allowedIps', label: 'Allowed IPs', type: 'text', placeholder: '192.168.1.1, 10.0.0.0/8', helpText: 'Optional: Comma-separated allowed IP addresses' },
    ],
  },
];

export function registerApiTypes(register: (type: ConnectionTypeDefinition) => void): void {
  apiTypes.forEach(type => register(type));
}
