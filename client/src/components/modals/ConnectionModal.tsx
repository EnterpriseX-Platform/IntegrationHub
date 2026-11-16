import { useState, useEffect } from 'react';
import { TextInput, NumberInput, PasswordInput, Select, SelectItem, TextArea, Checkbox, RadioButtonGroup, RadioButton, InlineNotification, IconButton } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ConnectionTypeSelector } from './ConnectionTypeSelector';
import type { Connection, DatabaseConfig, SFTPConfig, HTTPConfig, HTTPAuthConfig, GoogleDriveConfig, DatabaseType, SMTPConfig } from '../../types';

type ConnectionFormType = 'database' | 'postgresql' | 'mysql' | 'sqlite' | 'oracle' | 'mssql' | 'mongodb' | 'redis' | 'sftp' | 'ftp' | 's3' | 'google-drive' | 'dropbox' | 'rest-api' | 'graphql' | 'soap' | 'kafka' | 'rabbitmq' | 'mqtt' | 'webhook' | 'http' | 'smtp' | '';
type DatabaseDriver = DatabaseType;
type SFTPAuthType = 'password' | 'private-key';
type HTTPAuthType = 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2';
type GoogleDriveAuthType = 'oauth2' | 'service-account';

type SMTPForm = SMTPConfig;
const SMTP_DEFAULTS: SMTPForm = { host: '', port: 587, secure: false, username: '', password: '', fromAddress: '', fromName: '', allowSelfSigned: false };

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (connection: Partial<Connection>) => void;
  connection?: Connection | null;
  projectId: string;
}

const databaseDefaults: Record<DatabaseDriver, { port: number; defaultPort: number }> = {
  postgresql: { port: 5432, defaultPort: 5432 },
  mysql: { port: 3306, defaultPort: 3306 },
  sqlite: { port: 0, defaultPort: 0 },
  oracle: { port: 1521, defaultPort: 1521 },
  mssql: { port: 1433, defaultPort: 1433 },
  mongodb: { port: 27017, defaultPort: 27017 },
};

export default function ConnectionModal({
  isOpen,
  onClose,
  onSave,
  connection,
  projectId,
}: ConnectionModalProps) {
  // Step removed - using unified form
  const [connectionType, setConnectionType] = useState<ConnectionFormType>('');
  
  // Common fields
  const [name, setName] = useState('');
  
  // Database fields
  const [dbType, setDbType] = useState<DatabaseDriver>('postgresql');
  const [dbHost, setDbHost] = useState('localhost');
  const [dbPort, setDbPort] = useState(5432);
  const [dbName, setDbName] = useState('');
  const [dbUsername, setDbUsername] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [dbSsl, setDbSsl] = useState(false);
  const [dbConnectionString, setDbConnectionString] = useState('');
  
  // SFTP fields
  const [smtp, setSmtp] = useState<SMTPForm>(SMTP_DEFAULTS);
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpUsername, setSftpUsername] = useState('');
  const [sftpAuthType, setSftpAuthType] = useState<SFTPAuthType>('password');
  const [sftpPassword, setSftpPassword] = useState('');
  const [sftpPrivateKey, setSftpPrivateKey] = useState('');
  const [sftpPassphrase, setSftpPassphrase] = useState('');
  const [sftpBasePath, setSftpBasePath] = useState('/');
  
  // HTTP fields
  const [httpUrl, setHttpUrl] = useState('');
  const [httpAuthType, setHttpAuthType] = useState<HTTPAuthType>('none');
  const [httpTimeout, setHttpTimeout] = useState(30000);
  const [httpHeaders, setHttpHeaders] = useState<Record<string, string>>({});
  const [httpHeaderKey, setHttpHeaderKey] = useState('');
  const [httpHeaderValue, setHttpHeaderValue] = useState('');
  
  // HTTP Auth fields
  const [httpUsername, setHttpUsername] = useState('');
  const [httpPassword, setHttpPassword] = useState('');
  const [httpToken, setHttpToken] = useState('');
  const [httpApiKey, setHttpApiKey] = useState('');
  const [httpApiKeyHeader, setHttpApiKeyHeader] = useState('X-API-Key');
  const [httpClientId, setHttpClientId] = useState('');
  const [httpClientSecret, setHttpClientSecret] = useState('');
  const [httpTokenUrl, setHttpTokenUrl] = useState('');
  const [httpScopes, setHttpScopes] = useState('');
  
  // Google Drive fields
  const [gdAuthType, setGdAuthType] = useState<GoogleDriveAuthType>('oauth2');
  const [gdClientId, setGdClientId] = useState('');
  const [gdClientSecret, setGdClientSecret] = useState('');
  const [gdRedirectUri, setGdRedirectUri] = useState('http://localhost:8137/auth/callback');
  const [gdAccessToken, setGdAccessToken] = useState('');
  const [gdRefreshToken, setGdRefreshToken] = useState('');
  const [gdServiceAccountKey, setGdServiceAccountKey] = useState('');
  const [gdFolderId, setGdFolderId] = useState('');
  const [gdSharedDriveId, setGdSharedDriveId] = useState('');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connection) {
      setName(connection.name);
      setConnectionType(connection.type as ConnectionFormType);
      
      const dbTypes = ['database', 'postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb'];
      if (dbTypes.includes(connection.type)) {
        const config = connection.config as DatabaseConfig;
        // Use connection.type if it's a specific DB type, otherwise fall back to config.type
        const specificDbType = (connection.type !== 'database' ? connection.type : config.type) || 'postgresql';
        setDbType(specificDbType as DatabaseDriver);
        // Set connectionType to specific database type so dropdown shows correctly
        setConnectionType(specificDbType as ConnectionFormType);
        setDbHost(config.host || 'localhost');
        setDbPort(config.port || (databaseDefaults[specificDbType as DatabaseDriver]?.defaultPort ?? 5432));
        setDbName(config.database || '');
        setDbUsername(config.username || '');
        setDbPassword(config.password || '');
        setDbSsl(config.ssl || false);
        setDbConnectionString(config.connectionString || '');
      } else if (connection.type === 'sftp') {
        const config = connection.config as SFTPConfig;
        setSftpHost(config.host || '');
        setSftpPort(config.port || 22);
        setSftpUsername(config.username || '');
        setSftpAuthType(config.authType || 'password');
        setSftpPassword(config.password || '');
        setSftpPrivateKey(config.privateKey || '');
        setSftpPassphrase(config.passphrase || '');
        setSftpBasePath(config.basePath || '/');
      } else if (connection.type === 'http' || connection.type === 'rest-api' || connection.type === 'graphql') {
        const config = connection.config as HTTPConfig;
        setHttpUrl(config.baseUrl || '');
        setHttpAuthType(config.authType || 'none');
        setHttpTimeout(config.timeout || 30000);
        setHttpHeaders(config.headers || {});
        if (config.auth) {
          setHttpUsername(config.auth.username || '');
          setHttpPassword(config.auth.password || '');
          setHttpToken(config.auth.token || '');
          setHttpApiKey(config.auth.apiKey || '');
          setHttpApiKeyHeader(config.auth.apiKeyHeader || 'X-API-Key');
          setHttpClientId(config.auth.clientId || '');
          setHttpClientSecret(config.auth.clientSecret || '');
          setHttpTokenUrl(config.auth.tokenUrl || '');
          setHttpScopes(config.auth.scopes?.join(',') || '');
        }
      } else if (connection.type === 'smtp') {
        setSmtp({ ...SMTP_DEFAULTS, ...(connection.config as unknown as Partial<SMTPForm>) });
      } else if (connection.type === 'google-drive') {
        const config = connection.config as GoogleDriveConfig;
        setGdAuthType(config.authType || 'oauth2');
        setGdClientId(config.clientId || '');
        setGdClientSecret(config.clientSecret || '');
        setGdRedirectUri(config.redirectUri || 'http://localhost:8137/auth/callback');
        setGdAccessToken(config.accessToken || '');
        setGdRefreshToken(config.refreshToken || '');
        setGdServiceAccountKey(config.serviceAccountKey || '');
        setGdFolderId(config.folderId || '');
        setGdSharedDriveId(config.sharedDriveId || '');
      }
    } else {
      resetForm();
    }
  }, [connection, isOpen]);

  const resetForm = () => {
    setConnectionType('');
    setName('');
    setSmtp(SMTP_DEFAULTS);
    
    // Reset database fields
    setDbType('postgresql');
    setDbHost('localhost');
    setDbPort(5432);
    setDbName('');
    setDbUsername('');
    setDbPassword('');
    setDbSsl(false);
    setDbConnectionString('');
    
    // Reset SFTP fields
    setSftpHost('');
    setSftpPort(22);
    setSftpUsername('');
    setSftpAuthType('password');
    setSftpPassword('');
    setSftpPrivateKey('');
    setSftpPassphrase('');
    setSftpBasePath('/');
    
    // Reset HTTP fields
    setHttpUrl('');
    setHttpAuthType('none');
    setHttpTimeout(30000);
    setHttpHeaders({});
    setHttpHeaderKey('');
    setHttpHeaderValue('');
    setHttpUsername('');
    setHttpPassword('');
    setHttpToken('');
    setHttpApiKey('');
    setHttpApiKeyHeader('X-API-Key');
    setHttpClientId('');
    setHttpClientSecret('');
    setHttpTokenUrl('');
    setHttpScopes('');
    
    // Reset Google Drive fields
    setGdAuthType('oauth2');
    setGdClientId('');
    setGdClientSecret('');
    setGdRedirectUri('http://localhost:8137/auth/callback');
    setGdAccessToken('');
    setGdRefreshToken('');
    setGdServiceAccountKey('');
    setGdFolderId('');
    setGdSharedDriveId('');
    
    setError(null);
  };

  const handleDbTypeChange = (type: DatabaseDriver) => {
    setDbType(type);
    setDbPort(databaseDefaults[type].port);
  };

  const handleAddHeader = () => {
    if (httpHeaderKey.trim() && httpHeaderValue.trim()) {
      setHttpHeaders({ ...httpHeaders, [httpHeaderKey.trim()]: httpHeaderValue.trim() });
      setHttpHeaderKey('');
      setHttpHeaderValue('');
    }
  };

  const handleRemoveHeader = (key: string) => {
    const newHeaders = { ...httpHeaders };
    delete newHeaders[key];
    setHttpHeaders(newHeaders);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);
    
    try {
      let config: DatabaseConfig | SFTPConfig | HTTPConfig | GoogleDriveConfig | SMTPForm;
      
      // Check if it's a database type (generic 'database' or specific like 'postgresql', 'mysql', etc.)
      if (['database', 'postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'redis'].includes(connectionType)) {
        if (dbType === 'sqlite') {
          if (!dbConnectionString.trim()) {
            setError('Please enter a database file path');
            setIsSubmitting(false);
            return;
          }
          config = {
            type: dbType,
            host: '',
            port: 0,
            database: dbConnectionString,
            username: '',
            password: '',
            connectionString: dbConnectionString,
          };
        } else {
          if (!dbHost.trim() || !dbName.trim()) {
            setError('Please enter host and database name');
            setIsSubmitting(false);
            return;
          }
          config = {
            type: dbType,
            host: dbHost,
            port: dbPort,
            database: dbName,
            username: dbUsername,
            password: dbPassword,
            ssl: dbSsl,
          };
        }
      } else if (connectionType === 'sftp') {
        if (!sftpHost.trim() || !sftpUsername.trim()) {
          setError('Please enter host and username');
          setIsSubmitting(false);
          return;
        }
        config = {
          host: sftpHost,
          port: sftpPort,
          username: sftpUsername,
          authType: sftpAuthType,
          ...(sftpAuthType === 'password' ? { password: sftpPassword } : {}),
          ...(sftpAuthType === 'private-key' ? { 
            privateKey: sftpPrivateKey,
            passphrase: sftpPassphrase 
          } : {}),
          basePath: sftpBasePath,
        };
      } else if (['http', 'rest-api', 'graphql'].includes(connectionType)) {
        if (!httpUrl.trim()) {
          setError('Please enter a base URL');
          setIsSubmitting(false);
          return;
        }
        
        const auth: HTTPAuthConfig = {};
        if (httpAuthType === 'basic') {
          auth.username = httpUsername;
          auth.password = httpPassword;
        } else if (httpAuthType === 'bearer') {
          auth.token = httpToken;
        } else if (httpAuthType === 'api-key') {
          auth.apiKey = httpApiKey;
          auth.apiKeyHeader = httpApiKeyHeader;
        } else if (httpAuthType === 'oauth2') {
          auth.clientId = httpClientId;
          auth.clientSecret = httpClientSecret;
          auth.tokenUrl = httpTokenUrl;
          auth.scopes = httpScopes.split(',').map(s => s.trim()).filter(Boolean);
        }
        
        config = {
          baseUrl: httpUrl,
          authType: httpAuthType,
          auth: httpAuthType !== 'none' ? auth : undefined,
          headers: Object.keys(httpHeaders).length > 0 ? httpHeaders : undefined,
          timeout: httpTimeout,
        };
      } else if (connectionType === 'smtp') {
        if (!smtp.host.trim() || !smtp.fromAddress.trim()) {
          setError('Please enter the SMTP host and the From address');
          setIsSubmitting(false);
          return;
        }
        config = { ...smtp, host: smtp.host.trim(), fromAddress: smtp.fromAddress.trim() };
      } else if (connectionType === 'google-drive') {
        if (gdAuthType === 'oauth2') {
          if (!gdClientId.trim()) {
            setError('Please enter Client ID');
            setIsSubmitting(false);
            return;
          }
          config = {
            authType: 'oauth2',
            clientId: gdClientId,
            clientSecret: gdClientSecret,
            redirectUri: gdRedirectUri,
            accessToken: gdAccessToken,
            refreshToken: gdRefreshToken,
            folderId: gdFolderId || undefined,
            sharedDriveId: gdSharedDriveId || undefined,
          };
        } else {
          // When editing, a blank key means "keep the existing one" (it is
          // masked out of the API response), so only require it for new connections.
          if (!gdServiceAccountKey.trim() && !connection) {
            setError('Please enter Service Account JSON Key');
            setIsSubmitting(false);
            return;
          }
          config = {
            authType: 'service-account',
            serviceAccountKey: gdServiceAccountKey,
            folderId: gdFolderId || undefined,
            sharedDriveId: gdSharedDriveId || undefined,
          };
        }
      } else {
        setError('Invalid connection type');
        setIsSubmitting(false);
        return;
      }
      
      // Map specific database types back to 'database' for the type field
      // The specific database type is stored in config.type
      const finalConnectionType = ['postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'redis'].includes(connectionType) 
        ? 'database' 
        : connectionType;
      
      const connectionData: Partial<Connection> = {
        id: connection?.id,
        name: name.trim(),
        type: finalConnectionType as any,
        config,
        projectId,
        isActive: connection?.isActive ?? false,
        createdAt: connection?.createdAt || new Date(),
        updatedAt: new Date(),
      };
      
      console.log('[ConnectionModal] Calling onSave with:', connectionData);
      
      try {
        await onSave(connectionData);
        console.log('[ConnectionModal] onSave completed successfully');
      } catch (saveErr) {
        console.error('[ConnectionModal] onSave error:', saveErr);
        setError(saveErr instanceof Error ? saveErr.message : 'Failed to save connection');
      }
    } catch (err) {
      console.error('[ConnectionModal] Error in handleSubmit:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderUnifiedForm = () => {
    return (
      <div className="space-y-5">
        {/* Connection Type Selector - Always at top */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">Connection Type</label>
          <ConnectionTypeSelector
            value={connectionType}
            onChange={(typeId) => {
              setConnectionType(typeId as ConnectionFormType);
              // Auto-set database type when selecting a specific database
              if (['postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'redis'].includes(typeId)) {
                setDbType(typeId as DatabaseDriver);
                setDbPort(databaseDefaults[typeId as DatabaseDriver].port);
              }
            }}
            placeholder="Select a connection type..."
          />
        </div>
        
        {/* Dynamic Form based on selected type */}
        {isDatabaseType(connectionType) && renderDatabaseForm()}
        {connectionType === 'sftp' && renderSFTPForm()}
        {(['rest-api', 'http', 'graphql'].includes(connectionType)) && renderHTTPForm()}
        {connectionType === 'google-drive' && renderGoogleDriveForm()}
        {connectionType === 'smtp' && renderSMTPForm()}
        
        {/* Show placeholder if no type selected */}
        {!connectionType && (
          <div className="text-center py-8 text-gray-400">
            <i className="fas fa-plug text-4xl mb-3"></i>
            <p>Select a connection type to continue</p>
          </div>
        )}
      </div>
    );
  };

  const numVal = (v: number | string | undefined) => parseInt(String(v ?? ''));

  const renderDatabaseForm = () => (
    <div className="space-y-4">
      {/* Only show Database Type selector if generic 'database' type was selected (rare case now) */}
      {connectionType === 'database' && (
        <Select
          id="conn-db-type"
          labelText="Database Type"
          value={dbType}
          onChange={(e) => handleDbTypeChange(e.target.value as DatabaseDriver)}
        >
          <SelectItem value="postgresql" text="PostgreSQL" />
          <SelectItem value="mysql" text="MySQL" />
          <SelectItem value="sqlite" text="SQLite" />
          <SelectItem value="oracle" text="Oracle" />
          <SelectItem value="mssql" text="SQL Server" />
          <SelectItem value="mongodb" text="MongoDB" />
        </Select>
      )}

      <TextInput
        id="conn-db-name"
        labelText="Connection Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Production Database"
      />

      {dbType === 'sqlite' ? (
        <TextInput
          id="conn-db-file"
          labelText="Database File Path"
          value={dbConnectionString}
          onChange={(e) => setDbConnectionString(e.target.value)}
          placeholder="e.g., ./data/mydb.sqlite or /path/to/database.db"
          helperText="Enter the full path to your SQLite database file"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <TextInput
              id="conn-db-host"
              labelText="Host"
              value={dbHost}
              onChange={(e) => setDbHost(e.target.value)}
              placeholder="localhost"
            />
            <NumberInput
              id="conn-db-port"
              label="Port"
              value={dbPort}
              hideSteppers
              allowEmpty
              onChange={(_e, { value }) => setDbPort(numVal(value) || 0)}
            />
          </div>

          <TextInput
            id="conn-db-dbname"
            labelText="Database Name"
            value={dbName}
            onChange={(e) => setDbName(e.target.value)}
            placeholder="mydatabase"
          />

          <div className="grid grid-cols-2 gap-4">
            <TextInput
              id="conn-db-user"
              labelText="Username"
              value={dbUsername}
              onChange={(e) => setDbUsername(e.target.value)}
              placeholder="postgres"
            />
            <PasswordInput
              id="conn-db-password"
              labelText="Password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
            />
          </div>

          <Checkbox
            id="db-ssl"
            labelText="Enable SSL/TLS"
            checked={dbSsl}
            onChange={(_e, { checked }) => setDbSsl(checked)}
          />
        </>
      )}
    </div>
  );

  const renderSMTPForm = () => (
    <div className="space-y-4">
      <TextInput id="conn-smtp-name" labelText="Connection Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Mail server" />

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <TextInput id="conn-smtp-host" labelText={<>SMTP Host <span className="text-red-500">*</span></>} value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" />
        </div>
        <NumberInput
          id="conn-smtp-port"
          label="Port"
          value={smtp.port}
          hideSteppers
          allowEmpty
          onChange={(_e, { value }) => {
            const port = numVal(value) || 587;
            setSmtp({ ...smtp, port, secure: port === 465 ? true : smtp.secure });
          }}
        />
      </div>

      <Checkbox
        id="conn-smtp-secure"
        labelText="SSL/TLS from the start (usually port 465). Leave off for STARTTLS on 587/25."
        checked={smtp.secure}
        onChange={(_e, { checked }) => setSmtp({ ...smtp, secure: checked })}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextInput id="conn-smtp-user" labelText="Username" value={smtp.username} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} placeholder="Leave blank if no login" autoComplete="off" />
        <PasswordInput
          id="conn-smtp-password"
          labelText="Password"
          value={smtp.password}
          onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
          placeholder={connection ? 'Leave blank = keep current' : ''}
          autoComplete="new-password"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextInput id="conn-smtp-from" type="email" labelText={<>From address <span className="text-red-500">*</span></>} value={smtp.fromAddress} onChange={(e) => setSmtp({ ...smtp, fromAddress: e.target.value })} placeholder="noreply@example.com" />
        <TextInput id="conn-smtp-fromname" labelText="From name" value={smtp.fromName} onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} placeholder="DEH" />
      </div>

      <Checkbox
        id="conn-smtp-selfsigned"
        labelText="Accept a self-signed certificate (internal mail servers only)"
        checked={smtp.allowSelfSigned}
        onChange={(_e, { checked }) => setSmtp({ ...smtp, allowSelfSigned: checked })}
      />
    </div>
  );

  const renderSFTPForm = () => (
    <div className="space-y-4">
      <TextInput
        id="conn-sftp-name"
        labelText="Connection Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Production SFTP"
      />

      <div className="grid grid-cols-2 gap-4">
        <TextInput
          id="conn-sftp-host"
          labelText="Host"
          value={sftpHost}
          onChange={(e) => setSftpHost(e.target.value)}
          placeholder="sftp.example.com"
        />
        <NumberInput
          id="conn-sftp-port"
          label="Port"
          value={sftpPort}
          hideSteppers
          allowEmpty
          onChange={(_e, { value }) => setSftpPort(numVal(value) || 22)}
        />
      </div>

      <TextInput
        id="conn-sftp-user"
        labelText={<>Username <span className="text-red-500">*</span></>}
        value={sftpUsername}
        onChange={(e) => setSftpUsername(e.target.value)}
        placeholder="SSH username (e.g., boboebud02)"
        helperText="SSH login username — required even when using private key authentication"
      />

      <RadioButtonGroup
        name="conn-sftp-auth"
        legendText="Authentication Type"
        valueSelected={sftpAuthType}
        onChange={(value) => setSftpAuthType(value as SFTPAuthType)}
      >
        <RadioButton id="conn-sftp-auth-password" labelText="Password" value="password" />
        <RadioButton id="conn-sftp-auth-key" labelText="Private Key" value="private-key" />
      </RadioButtonGroup>

      {sftpAuthType === 'password' ? (
        <PasswordInput
          id="conn-sftp-password"
          labelText="Password"
          value={sftpPassword}
          onChange={(e) => setSftpPassword(e.target.value)}
          placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
        />
      ) : (
        <>
          <TextArea
            id="conn-sftp-key"
            labelText="Private Key"
            value={sftpPrivateKey}
            onChange={(e) => setSftpPrivateKey(e.target.value)}
            placeholder="Paste OpenSSH, PEM, or PuTTY PPK key here"
            rows={6}
            className="font-mono text-sm"
            helperText="Supports OpenSSH, PEM, and PuTTY PPK v2 formats — PPK keys are auto-converted"
          />
          <PasswordInput
            id="conn-sftp-passphrase"
            labelText="Passphrase (Optional)"
            value={sftpPassphrase}
            onChange={(e) => setSftpPassphrase(e.target.value)}
          />
        </>
      )}

      <TextInput
        id="conn-sftp-basepath"
        labelText="Base Path"
        value={sftpBasePath}
        onChange={(e) => setSftpBasePath(e.target.value)}
        placeholder="/home/username"
        helperText="Default directory for file operations"
      />
    </div>
  );

  const renderHTTPForm = () => (
    <div className="space-y-4">
      <TextInput
        id="conn-http-name"
        labelText="Connection Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Shopify API"
      />

      <TextInput
        id="conn-http-url"
        labelText="Base URL"
        value={httpUrl}
        onChange={(e) => setHttpUrl(e.target.value)}
        placeholder="https://api.example.com"
      />

      <NumberInput
        id="conn-http-timeout"
        label="Timeout (ms)"
        value={httpTimeout}
        hideSteppers
        allowEmpty
        onChange={(_e, { value }) => setHttpTimeout(numVal(value) || 30000)}
      />

      {/* Headers */}
      <div>
        <label className="cds--label">Custom Headers</label>
        <div className="flex gap-2 mb-2 items-end">
          <div className="flex-1">
            <TextInput
              id="conn-http-header-key"
              labelText="Header name"
              hideLabel
              value={httpHeaderKey}
              onChange={(e) => setHttpHeaderKey(e.target.value)}
              placeholder="Header name"
            />
          </div>
          <div className="flex-1">
            <TextInput
              id="conn-http-header-value"
              labelText="Header value"
              hideLabel
              value={httpHeaderValue}
              onChange={(e) => setHttpHeaderValue(e.target.value)}
              placeholder="Value"
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleAddHeader}>
            Add
          </Button>
        </div>
        {Object.entries(httpHeaders).length > 0 && (
          <div className="space-y-1">
            {Object.entries(httpHeaders).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded text-sm">
                <span className="text-gray-700"><strong>{key}:</strong> {value}</span>
                <IconButton kind="ghost" size="sm" label={`Remove header ${key}`} onClick={() => handleRemoveHeader(key)}>
                  <Close />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auth Type */}
      <Select
        id="conn-http-auth"
        labelText="Authentication"
        value={httpAuthType}
        onChange={(e) => setHttpAuthType(e.target.value as HTTPAuthType)}
      >
        <SelectItem value="none" text="None" />
        <SelectItem value="basic" text="Basic Auth" />
        <SelectItem value="bearer" text="Bearer Token" />
        <SelectItem value="api-key" text="API Key" />
        <SelectItem value="oauth2" text="OAuth 2.0" />
      </Select>

      {/* Auth Fields */}
      {httpAuthType === 'basic' && (
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            id="conn-http-user"
            labelText="Username"
            value={httpUsername}
            onChange={(e) => setHttpUsername(e.target.value)}
          />
          <PasswordInput
            id="conn-http-password"
            labelText="Password"
            value={httpPassword}
            onChange={(e) => setHttpPassword(e.target.value)}
            placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
          />
        </div>
      )}

      {httpAuthType === 'bearer' && (
        <PasswordInput
          id="conn-http-token"
          labelText="Bearer Token"
          value={httpToken}
          onChange={(e) => setHttpToken(e.target.value)}
          placeholder="eyJhbGciOiJIUzI1NiIs..."
        />
      )}

      {httpAuthType === 'api-key' && (
        <>
          <TextInput
            id="conn-http-apikey-header"
            labelText="API Key Header"
            value={httpApiKeyHeader}
            onChange={(e) => setHttpApiKeyHeader(e.target.value)}
            placeholder="X-API-Key"
          />
          <TextInput
            id="conn-http-apikey"
            labelText="API Key"
            value={httpApiKey}
            onChange={(e) => setHttpApiKey(e.target.value)}
            placeholder="your-api-key"
          />
        </>
      )}

      {httpAuthType === 'oauth2' && (
        <>
          <TextInput
            id="conn-http-client-id"
            labelText="Client ID"
            value={httpClientId}
            onChange={(e) => setHttpClientId(e.target.value)}
          />
          <PasswordInput
            id="conn-http-client-secret"
            labelText="Client Secret"
            value={httpClientSecret}
            onChange={(e) => setHttpClientSecret(e.target.value)}
          />
          <TextInput
            id="conn-http-token-url"
            labelText="Token URL"
            value={httpTokenUrl}
            onChange={(e) => setHttpTokenUrl(e.target.value)}
            placeholder="https://oauth.example.com/token"
          />
          <TextInput
            id="conn-http-scopes"
            labelText="Scopes (comma-separated)"
            value={httpScopes}
            onChange={(e) => setHttpScopes(e.target.value)}
            placeholder="read,write,admin"
          />
        </>
      )}
    </div>
  );

  const renderGoogleDriveForm = () => (
    <div className="space-y-4">
      <TextInput
        id="conn-gd-name"
        labelText="Connection Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., My Google Drive"
      />

      <RadioButtonGroup
        name="conn-gd-auth"
        legendText="Authentication Type"
        valueSelected={gdAuthType}
        onChange={(value) => setGdAuthType(value as GoogleDriveAuthType)}
      >
        <RadioButton id="conn-gd-auth-oauth2" labelText="OAuth 2.0" value="oauth2" />
        <RadioButton id="conn-gd-auth-sa" labelText="Service Account" value="service-account" />
      </RadioButtonGroup>

      {gdAuthType === 'oauth2' ? (
        <>
          <TextInput
            id="conn-gd-client-id"
            labelText="Client ID"
            value={gdClientId}
            onChange={(e) => setGdClientId(e.target.value)}
            placeholder="xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
          />

          <PasswordInput
            id="conn-gd-client-secret"
            labelText="Client Secret"
            value={gdClientSecret}
            onChange={(e) => setGdClientSecret(e.target.value)}
          />

          <TextInput
            id="conn-gd-redirect"
            labelText="Redirect URI"
            value={gdRedirectUri}
            onChange={(e) => setGdRedirectUri(e.target.value)}
            placeholder="http://localhost:8137/auth/callback"
          />

          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="OAuth2 tokens will be generated when you test the connection."
          />
        </>
      ) : (
        <TextArea
          id="conn-gd-sa-key"
          labelText="Service Account JSON Key"
          value={gdServiceAccountKey}
          onChange={(e) => setGdServiceAccountKey(e.target.value)}
          placeholder={`{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key_id": "...",\n  "private_key": "...",\n  "client_email": "...",\n  "client_id": "...",\n  "auth_uri": "https://accounts.google.com/o/oauth2/auth",\n  "token_uri": "https://oauth2.googleapis.com/token"\n}`}
          rows={8}
          className="font-mono text-xs"
          helperText="Paste the contents of your service account JSON key file"
        />
      )}

      <div className="border-t border-gray-200 pt-4 mt-4 space-y-3">
        <p className="text-sm font-medium text-gray-700">Optional Settings</p>

        <TextInput
          id="conn-gd-folder"
          labelText="Default Folder ID"
          value={gdFolderId}
          onChange={(e) => setGdFolderId(e.target.value)}
          placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
          helperText="Google Drive folder ID for default file operations"
        />

        <TextInput
          id="conn-gd-shared-drive"
          labelText="Shared Drive ID (Optional)"
          value={gdSharedDriveId}
          onChange={(e) => setGdSharedDriveId(e.target.value)}
          placeholder="0AMkZ7d8J9k3lUk9PVA"
          helperText="For Google Shared Drives (Team Drives)"
        />
      </div>
    </div>
  );

  // Helper to determine if a type is a database type
  const isDatabaseType = (type: string): boolean => {
    return ['database', 'postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'redis'].includes(type);
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={connection ? 'Edit Connection' : 'New Connection'} size="md">
      <div className="sm:min-h-[min(560px,calc(100vh-14rem))]">
        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={error}
            className="mb-4"
          />
        )}

        {renderUnifiedForm()}
      </div>

      <div className="flex flex-row-reverse gap-2 pt-4 mt-4 border-t border-gray-200">
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting || !name.trim() || !connectionType}
          isLoading={isSubmitting}
        >
          {isSubmitting ? 'Saving...' : connection ? 'Update Connection' : 'Create Connection'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
