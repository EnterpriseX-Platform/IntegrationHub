// Example: How to register a custom connection type using the SDK

import { registerConnectionType, connectionRegistry as _connectionRegistry } from './ConnectionRegistry';
import type { ConnectionTypeDefinition } from './types';

// Example: Register a custom Slack connection type
export function registerSlackConnection(): void {
  const slackConnection: ConnectionTypeDefinition = {
    id: 'slack',
    name: 'Slack',
    description: 'Connect to Slack workspace',
    category: 'api',
    icon: 'fa-brands fa-slack',
    colors: {
      bg: 'bg-purple-100',
      text: 'text-purple-600',
      border: 'border-purple-200',
      gradient: 'from-purple-500 to-purple-600',
    },
    fields: [
      {
        name: 'botToken',
        label: 'Bot User OAuth Token',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'xoxb-...',
        helpText: 'Find this in your Slack app settings under OAuth & Permissions',
      },
      {
        name: 'channel',
        label: 'Default Channel',
        type: 'text',
        required: false,
        placeholder: '#general',
        helpText: 'Optional: Default channel to post messages',
      },
      {
        name: 'webhookUrl',
        label: 'Webhook URL',
        type: 'text',
        required: false,
        placeholder: 'https://hooks.slack.com/services/...',
        helpText: 'Optional: Incoming webhook URL for posting messages',
      },
    ],
  };

  registerConnectionType(slackConnection);
  console.log('[Example] Slack connection type registered!');
}

// Example: Register a custom Elasticsearch connection
export function registerElasticsearchConnection(): void {
  const esConnection: ConnectionTypeDefinition = {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    description: 'Connect to Elasticsearch cluster',
    category: 'database',
    icon: 'fa-search',
    colors: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-600',
      border: 'border-yellow-200',
      gradient: 'from-yellow-500 to-yellow-600',
    },
    fields: [
      {
        name: 'nodes',
        label: 'Node URLs',
        type: 'text',
        required: true,
        placeholder: 'http://localhost:9200,http://localhost:9201',
        helpText: 'Comma-separated list of Elasticsearch node URLs',
      },
      {
        name: 'username',
        label: 'Username',
        type: 'text',
        required: false,
      },
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        secret: true,
      },
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        secret: true,
        helpText: 'Optional: API key for authentication',
      },
    ],
  };

  registerConnectionType(esConnection);
  console.log('[Example] Elasticsearch connection type registered!');
}

// Usage example:
// import { initializeConnectionSDK } from './index';
// import { registerSlackConnection } from './example';
// 
// initializeConnectionSDK();
// registerSlackConnection();
// 
// console.log(connectionRegistry.getAll());
