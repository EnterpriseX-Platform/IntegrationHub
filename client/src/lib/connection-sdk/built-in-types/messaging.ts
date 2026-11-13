import type { ConnectionTypeDefinition } from '../types';

export const messagingTypes: ConnectionTypeDefinition[] = [
  {
    id: 'smtp',
    name: 'SMTP (Email)',
    description: 'Mail server for the Send Email node',
    category: 'messaging',
    icon: 'fa-envelope',
    colors: {
      bg: 'bg-rose-100',
      text: 'text-rose-600',
      border: 'border-rose-200',
      gradient: 'from-rose-500 to-rose-600',
    },
    fields: [
      { name: 'host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 587 },
      { name: 'secure', label: 'SSL/TLS (port 465)', type: 'checkbox', defaultValue: false },
      { name: 'username', label: 'Username', type: 'text' },
      { name: 'password', label: 'Password', type: 'password', secret: true },
      { name: 'fromAddress', label: 'From address', type: 'text', required: true },
      { name: 'fromName', label: 'From name', type: 'text' },
    ],
  },
  {
    id: 'kafka',
    name: 'Apache Kafka',
    description: 'Distributed event streaming platform',
    category: 'messaging',
    icon: 'fa-stream',
    colors: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      border: 'border-gray-300',
      gradient: 'from-gray-500 to-gray-600',
    },
    fields: [
      { name: 'brokers', label: 'Brokers', type: 'text', required: true, placeholder: 'localhost:9092,localhost:9093', helpText: 'Comma-separated broker addresses' },
      { name: 'clientId', label: 'Client ID', type: 'text' },
      { name: 'username', label: 'Username (SASL)', type: 'text' },
      { name: 'password', label: 'Password (SASL)', type: 'password', secret: true },
      { name: 'ssl', label: 'Enable SSL', type: 'checkbox', defaultValue: false },
    ],
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    description: 'Message broker with AMQP protocol',
    category: 'messaging',
    icon: 'fa-envelope',
    colors: {
      bg: 'bg-orange-100',
      text: 'text-orange-600',
      border: 'border-orange-200',
      gradient: 'from-orange-500 to-orange-600',
    },
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 5672 },
      { name: 'vhost', label: 'Virtual Host', type: 'text', defaultValue: '/' },
      { name: 'username', label: 'Username', type: 'text', required: true, defaultValue: 'guest' },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true, defaultValue: 'guest' },
      { name: 'ssl', label: 'Enable SSL', type: 'checkbox', defaultValue: false },
    ],
  },
  {
    id: 'mqtt',
    name: 'MQTT',
    description: 'IoT messaging protocol',
    category: 'messaging',
    icon: 'fa-wifi',
    colors: {
      bg: 'bg-cyan-100',
      text: 'text-cyan-600',
      border: 'border-cyan-200',
      gradient: 'from-cyan-500 to-cyan-600',
    },
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 1883 },
      { name: 'username', label: 'Username', type: 'text' },
      { name: 'password', label: 'Password', type: 'password', secret: true },
      { name: 'clientId', label: 'Client ID', type: 'text' },
      { name: 'ssl', label: 'Use TLS', type: 'checkbox', defaultValue: false },
    ],
  },
];

export function registerMessagingTypes(register: (type: ConnectionTypeDefinition) => void): void {
  messagingTypes.forEach(type => register(type));
}
