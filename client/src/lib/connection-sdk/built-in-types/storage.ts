import type { ConnectionTypeDefinition } from '../types';

export const storageTypes: ConnectionTypeDefinition[] = [
  {
    id: 'sftp',
    name: 'SFTP',
    description: 'Secure File Transfer Protocol',
    category: 'storage',
    icon: 'fa-server',
    colors: {
      bg: 'bg-green-100',
      text: 'text-green-600',
      border: 'border-green-200',
      gradient: 'from-green-500 to-green-600',
    },
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'sftp.example.com' },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 22 },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { 
        name: 'authType', 
        label: 'Authentication Type', 
        type: 'select', 
        required: true,
        defaultValue: 'password',
        options: [
          { value: 'password', label: 'Password', icon: 'fa-lock' },
          { value: 'private-key', label: 'Private Key', icon: 'fa-key' },
        ],
      },
      { name: 'password', label: 'Password', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'password' } },
      { name: 'privateKey', label: 'Private Key', type: 'textarea', placeholder: 'Paste OpenSSH, PEM, or PuTTY PPK key here', helpText: 'Supports OpenSSH, PEM, and PuTTY PPK v2 formats', dependsOn: { field: 'authType', value: 'private-key' } },
      { name: 'passphrase', label: 'Passphrase', type: 'password', secret: true, dependsOn: { field: 'authType', value: 'private-key' } },
      { name: 'basePath', label: 'Base Path', type: 'text', defaultValue: '/', placeholder: '/home/user' },
      // Encryption settings
      { name: 'encryptOnUpload', label: 'Encrypt on Upload', type: 'checkbox', defaultValue: false, helpText: 'Encrypt files before uploading to SFTP' },
      { name: 'encryptionKeyId', label: 'Encryption Key (Upload)', type: 'text', placeholder: 'Select from Secrets Vault', helpText: 'Public key to encrypt outgoing files', dependsOn: { field: 'encryptOnUpload', value: true } },
      { name: 'decryptOnDownload', label: 'Decrypt on Download', type: 'checkbox', defaultValue: false, helpText: 'Decrypt files after downloading from SFTP' },
      { name: 'decryptionKeyId', label: 'Decryption Key (Download)', type: 'text', placeholder: 'Select from Secrets Vault', helpText: 'Private key to decrypt incoming files', dependsOn: { field: 'decryptOnDownload', value: true } },
    ],
  },
  {
    id: 'ftp',
    name: 'FTP',
    description: 'File Transfer Protocol',
    category: 'storage',
    icon: 'fa-server',
    colors: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-600',
      border: 'border-yellow-200',
      gradient: 'from-yellow-500 to-yellow-600',
    },
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true },
      { name: 'port', label: 'Port', type: 'number', required: true, defaultValue: 21 },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
      { name: 'secure', label: 'Use FTPS (SSL/TLS)', type: 'checkbox', defaultValue: false },
    ],
  },
  {
    id: 's3',
    name: 'AWS S3',
    description: 'Amazon Simple Storage Service',
    category: 'storage',
    icon: 'fa-cloud',
    colors: {
      bg: 'bg-orange-100',
      text: 'text-orange-600',
      border: 'border-orange-200',
      gradient: 'from-orange-500 to-orange-600',
    },
    fields: [
      { name: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { name: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { name: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true },
      { name: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
      { name: 'endpoint', label: 'Custom Endpoint', type: 'text', helpText: 'Optional: Custom S3 endpoint URL' },
    ],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Google Drive cloud storage',
    category: 'storage',
    icon: 'fa-brands fa-google-drive',
    colors: {
      bg: 'bg-red-100',
      text: 'text-red-600',
      border: 'border-red-200',
      gradient: 'from-red-500 to-red-600',
    },
    fields: [
      {
        name: 'authType',
        label: 'Authentication Type',
        type: 'select',
        required: true,
        defaultValue: 'oauth2',
        options: [
          { value: 'oauth2', label: 'OAuth 2.0', icon: 'fa-user' },
          { value: 'service-account', label: 'Service Account', icon: 'fa-robot' },
        ],
      },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, secret: true, dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'redirectUri', label: 'Redirect URI', type: 'text', defaultValue: 'http://localhost:8137/auth/callback', dependsOn: { field: 'authType', value: 'oauth2' } },
      { name: 'serviceAccountKey', label: 'Service Account JSON Key', type: 'textarea', required: true, placeholder: '{\n  "type": "service_account",\n  ...\n}', dependsOn: { field: 'authType', value: 'service-account' } },
      { name: 'folderId', label: 'Default Folder ID', type: 'text', helpText: 'Optional: Google Drive folder ID' },
    ],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    description: 'Dropbox cloud storage',
    category: 'storage',
    icon: 'fa-brands fa-dropbox',
    colors: {
      bg: 'bg-blue-100',
      text: 'text-blue-600',
      border: 'border-blue-200',
      gradient: 'from-blue-500 to-blue-600',
    },
    fields: [
      { name: 'accessToken', label: 'Access Token', type: 'password', required: true, secret: true },
      { name: 'basePath', label: 'Base Path', type: 'text', defaultValue: '/' },
    ],
  },
];

export function registerStorageTypes(register: (type: ConnectionTypeDefinition) => void): void {
  storageTypes.forEach(type => register(type));
}
