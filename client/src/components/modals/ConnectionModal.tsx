import { useState, useEffect } from 'react';
import { XMarkIcon, EyeIcon, EyeSlashIcon } from '../icons';
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
  const [showDbPassword, setShowDbPassword] = useState(false);
  
  // SFTP fields
  const [smtp, setSmtp] = useState<SMTPForm>(SMTP_DEFAULTS);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpUsername, setSftpUsername] = useState('');
  const [sftpAuthType, setSftpAuthType] = useState<SFTPAuthType>('password');
  const [sftpPassword, setSftpPassword] = useState('');
  const [sftpPrivateKey, setSftpPrivateKey] = useState('');
  const [sftpPassphrase, setSftpPassphrase] = useState('');
  const [sftpBasePath, setSftpBasePath] = useState('/');
  const [showSftpPassword, setShowSftpPassword] = useState(false);
  
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
  const [showHttpPassword, setShowHttpPassword] = useState(false);
  const [showHttpToken, setShowHttpToken] = useState(false);
  
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
  const [showGdClientSecret, setShowGdClientSecret] = useState(false);
  
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

  const renderDatabaseForm = () => (
    <div className="space-y-4">
      {/* Only show Database Type selector if generic 'database' type was selected (rare case now) */}
      {connectionType === 'database' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Database Type</label>
          <select
            value={dbType}
            onChange={(e) => handleDbTypeChange(e.target.value as DatabaseDriver)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          >
            <option value="postgresql">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="sqlite">SQLite</option>
            <option value="oracle">Oracle</option>
            <option value="mssql">SQL Server</option>
            <option value="mongodb">MongoDB</option>
          </select>
        </div>
      )}
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Production Database"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      {dbType === 'sqlite' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Database File Path</label>
          <input
            type="text"
            value={dbConnectionString}
            onChange={(e) => setDbConnectionString(e.target.value)}
            placeholder="e.g., ./data/mydb.sqlite or /path/to/database.db"
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <p className="text-xs text-gray-500 mt-1">Enter the full path to your SQLite database file</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Host</label>
              <input
                type="text"
                value={dbHost}
                onChange={(e) => setDbHost(e.target.value)}
                placeholder="localhost"
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <input
                type="number"
                value={dbPort}
                onChange={(e) => setDbPort(parseInt(e.target.value) || 0)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Database Name</label>
            <input
              type="text"
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              placeholder="mydatabase"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
              <input
                type="text"
                value={dbUsername}
                onChange={(e) => setDbUsername(e.target.value)}
                placeholder="postgres"
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showDbPassword ? 'text' : 'password'}
                  value={dbPassword}
                  onChange={(e) => setDbPassword(e.target.value)}
                  placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 pr-10 focus:ring-primary-500 focus:border-primary-500"
                />
                <button
                  type="button"
                  onClick={() => setShowDbPassword(!showDbPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showDbPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="db-ssl"
              checked={dbSsl}
              onChange={(e) => setDbSsl(e.target.checked)}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <label htmlFor="db-ssl" className="text-sm text-gray-700">Enable SSL/TLS</label>
          </div>
        </>
      )}
    </div>
  );

  const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500';
  const renderSMTPForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Mail server" className={inputCls} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">SMTP Host <span className="text-red-500">*</span></label>
          <input type="text" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
          <input
            type="number"
            value={smtp.port}
            onChange={(e) => {
              const port = parseInt(e.target.value) || 587;
              setSmtp({ ...smtp, port, secure: port === 465 ? true : smtp.secure });
            }}
            className={inputCls}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} />
        SSL/TLS from the start (usually port 465). Leave off for STARTTLS on 587/25.
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
          <input type="text" value={smtp.username} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} placeholder="Leave blank if no login" className={inputCls} autoComplete="off" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <div className="relative">
            <input
              type={showSmtpPassword ? 'text' : 'password'}
              value={smtp.password}
              onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
              placeholder={connection ? 'Leave blank = keep current' : ''}
              className={`${inputCls} pr-10`}
              autoComplete="new-password"
            />
            <button type="button" onClick={() => setShowSmtpPassword(!showSmtpPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600">
              {showSmtpPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From address <span className="text-red-500">*</span></label>
          <input type="email" value={smtp.fromAddress} onChange={(e) => setSmtp({ ...smtp, fromAddress: e.target.value })} placeholder="noreply@example.com" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From name</label>
          <input type="text" value={smtp.fromName} onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} placeholder="DEH" className={inputCls} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={smtp.allowSelfSigned} onChange={(e) => setSmtp({ ...smtp, allowSelfSigned: e.target.checked })} />
        Accept a self-signed certificate (internal mail servers only)
      </label>
    </div>
  );

  const renderSFTPForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Production SFTP"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Host</label>
          <input
            type="text"
            value={sftpHost}
            onChange={(e) => setSftpHost(e.target.value)}
            placeholder="sftp.example.com"
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
          <input
            type="number"
            value={sftpPort}
            onChange={(e) => setSftpPort(parseInt(e.target.value) || 22)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
        <input
          type="text"
          value={sftpUsername}
          onChange={(e) => setSftpUsername(e.target.value)}
          placeholder="SSH username (e.g., sftpuser)"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
        <p className="text-xs text-gray-500 mt-1">SSH login username — required even when using private key authentication</p>
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Authentication Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="password"
              checked={sftpAuthType === 'password'}
              onChange={(e) => setSftpAuthType(e.target.value as SFTPAuthType)}
              className="text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-700">Password</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="private-key"
              checked={sftpAuthType === 'private-key'}
              onChange={(e) => setSftpAuthType(e.target.value as SFTPAuthType)}
              className="text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-700">Private Key</span>
          </label>
        </div>
      </div>
      
      {sftpAuthType === 'password' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <div className="relative">
            <input
              type={showSftpPassword ? 'text' : 'password'}
              value={sftpPassword}
              onChange={(e) => setSftpPassword(e.target.value)}
              placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
              className="w-full border border-gray-300 rounded-md px-3 py-2 pr-10 focus:ring-primary-500 focus:border-primary-500"
            />
            <button
              type="button"
              onClick={() => setShowSftpPassword(!showSftpPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showSftpPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Private Key</label>
            <textarea
              value={sftpPrivateKey}
              onChange={(e) => setSftpPrivateKey(e.target.value)}
              placeholder="Paste OpenSSH, PEM, or PuTTY PPK key here"
              rows={6}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">Supports OpenSSH, PEM, and PuTTY PPK v2 formats — PPK keys are auto-converted</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Passphrase (Optional)</label>
            <input
              type="password"
              value={sftpPassphrase}
              onChange={(e) => setSftpPassphrase(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </>
      )}
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Base Path</label>
        <input
          type="text"
          value={sftpBasePath}
          onChange={(e) => setSftpBasePath(e.target.value)}
          placeholder="/home/username"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
        <p className="text-xs text-gray-500 mt-1">Default directory for file operations</p>
      </div>
    </div>
  );

  const renderHTTPForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Shopify API"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
        <input
          type="text"
          value={httpUrl}
          onChange={(e) => setHttpUrl(e.target.value)}
          placeholder="https://api.example.com"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Timeout (ms)</label>
        <input
          type="number"
          value={httpTimeout}
          onChange={(e) => setHttpTimeout(parseInt(e.target.value) || 30000)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      {/* Headers */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Custom Headers</label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={httpHeaderKey}
            onChange={(e) => setHttpHeaderKey(e.target.value)}
            placeholder="Header name"
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-primary-500 focus:border-primary-500"
          />
          <input
            type="text"
            value={httpHeaderValue}
            onChange={(e) => setHttpHeaderValue(e.target.value)}
            placeholder="Value"
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-primary-500 focus:border-primary-500"
          />
          <button
            onClick={handleAddHeader}
            className="inline-flex items-center justify-center px-3 h-9 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-[14px] whitespace-nowrap"
          >
            Add
          </button>
        </div>
        {Object.entries(httpHeaders).length > 0 && (
          <div className="space-y-1">
            {Object.entries(httpHeaders).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded text-sm">
                <span className="text-gray-700"><strong>{key}:</strong> {value}</span>
                <button
                  onClick={() => handleRemoveHeader(key)}
                  className="text-red-500 hover:text-red-700"
                >
                  <XMarkIcon className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* Auth Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Authentication</label>
        <select
          value={httpAuthType}
          onChange={(e) => setHttpAuthType(e.target.value as HTTPAuthType)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        >
          <option value="none">None</option>
          <option value="basic">Basic Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="api-key">API Key</option>
          <option value="oauth2">OAuth 2.0</option>
        </select>
      </div>
      
      {/* Auth Fields */}
      {httpAuthType === 'basic' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              value={httpUsername}
              onChange={(e) => setHttpUsername(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <div className="relative">
              <input
                type={showHttpPassword ? 'text' : 'password'}
                value={httpPassword}
                onChange={(e) => setHttpPassword(e.target.value)}
                placeholder={connection ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
                className="w-full border border-gray-300 rounded-md px-3 py-2 pr-10 focus:ring-primary-500 focus:border-primary-500"
              />
              <button
                type="button"
                onClick={() => setShowHttpPassword(!showHttpPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showHttpPassword ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {httpAuthType === 'bearer' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bearer Token</label>
          <div className="relative">
            <input
              type={showHttpToken ? 'text' : 'password'}
              value={httpToken}
              onChange={(e) => setHttpToken(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              className="w-full border border-gray-300 rounded-md px-3 py-2 pr-10 focus:ring-primary-500 focus:border-primary-500"
            />
            <button
              type="button"
              onClick={() => setShowHttpToken(!showHttpToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showHttpToken ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}
      
      {httpAuthType === 'api-key' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key Header</label>
            <input
              type="text"
              value={httpApiKeyHeader}
              onChange={(e) => setHttpApiKeyHeader(e.target.value)}
              placeholder="X-API-Key"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="text"
              value={httpApiKey}
              onChange={(e) => setHttpApiKey(e.target.value)}
              placeholder="your-api-key"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </>
      )}
      
      {httpAuthType === 'oauth2' && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
            <input
              type="text"
              value={httpClientId}
              onChange={(e) => setHttpClientId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client Secret</label>
            <input
              type="password"
              value={httpClientSecret}
              onChange={(e) => setHttpClientSecret(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Token URL</label>
            <input
              type="text"
              value={httpTokenUrl}
              onChange={(e) => setHttpTokenUrl(e.target.value)}
              placeholder="https://oauth.example.com/token"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Scopes (comma-separated)</label>
            <input
              type="text"
              value={httpScopes}
              onChange={(e) => setHttpScopes(e.target.value)}
              placeholder="read,write,admin"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </>
      )}
    </div>
  );

  const renderGoogleDriveForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., My Google Drive"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Authentication Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="oauth2"
              checked={gdAuthType === 'oauth2'}
              onChange={(e) => setGdAuthType(e.target.value as GoogleDriveAuthType)}
              className="text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-700">OAuth 2.0</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="service-account"
              checked={gdAuthType === 'service-account'}
              onChange={(e) => setGdAuthType(e.target.value as GoogleDriveAuthType)}
              className="text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-700">Service Account</span>
          </label>
        </div>
      </div>
      
      {gdAuthType === 'oauth2' ? (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
            <input
              type="text"
              value={gdClientId}
              onChange={(e) => setGdClientId(e.target.value)}
              placeholder="xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client Secret</label>
            <div className="relative">
              <input
                type={showGdClientSecret ? 'text' : 'password'}
                value={gdClientSecret}
                onChange={(e) => setGdClientSecret(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 pr-10 focus:ring-primary-500 focus:border-primary-500"
              />
              <button
                type="button"
                onClick={() => setShowGdClientSecret(!showGdClientSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showGdClientSecret ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
              </button>
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Redirect URI</label>
            <input
              type="text"
              value={gdRedirectUri}
              onChange={(e) => setGdRedirectUri(e.target.value)}
              placeholder="http://localhost:8137/auth/callback"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          
          <div className="p-3 bg-blue-50 rounded-md">
            <p className="text-sm text-blue-700">
              <i className="fas fa-info-circle mr-1"></i>
              OAuth2 tokens will be generated when you test the connection.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Service Account JSON Key</label>
            <textarea
              value={gdServiceAccountKey}
              onChange={(e) => setGdServiceAccountKey(e.target.value)}
              placeholder={`{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key_id": "...",\n  "private_key": "...",\n  "client_email": "...",\n  "client_id": "...",\n  "auth_uri": "https://accounts.google.com/o/oauth2/auth",\n  "token_uri": "https://oauth2.googleapis.com/token"\n}`}
              rows={8}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-xs"
            />
            <p className="text-xs text-gray-500 mt-1">
              Paste the contents of your service account JSON key file
            </p>
          </div>
        </>
      )}
      
      <div className="border-t border-gray-200 pt-4 mt-4">
        <p className="text-sm font-medium text-gray-700 mb-2">Optional Settings</p>
        
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Default Folder ID</label>
          <input
            type="text"
            value={gdFolderId}
            onChange={(e) => setGdFolderId(e.target.value)}
            placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <p className="text-xs text-gray-500 mt-1">Google Drive folder ID for default file operations</p>
        </div>
        
        <div className="mt-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Shared Drive ID (Optional)</label>
          <input
            type="text"
            value={gdSharedDriveId}
            onChange={(e) => setGdSharedDriveId(e.target.value)}
            placeholder="0AMkZ7d8J9k3lUk9PVA"
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <p className="text-xs text-gray-500 mt-1">For Google Shared Drives (Team Drives)</p>
        </div>
      </div>
    </div>
  );

  // Helper to determine if a type is a database type
  const isDatabaseType = (type: string): boolean => {
    return ['database', 'postgresql', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'redis'].includes(type);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />

      <div className="relative bg-white w-full h-full sm:h-auto sm:max-h-[calc(100vh-3rem)] sm:max-w-lg sm:rounded-xl shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 shrink-0">
          <h3 className="text-base font-semibold text-gray-900">
            {connection ? 'Edit Connection' : 'New Connection'}
          </h3>
          <button onClick={onClose} className="h-8 w-8 -mr-1.5 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 sm:min-h-[min(560px,calc(100vh-10rem))]">
            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {error}
              </div>
            )}

            {renderUnifiedForm()}
          </div>

          <div className="shrink-0 flex flex-row-reverse gap-2 px-5 py-3 bg-gray-50 border-t border-gray-200">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim() || !connectionType}
              className="inline-flex justify-center items-center rounded-lg px-4 h-9 text-[14px] font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors bg-blue-600 text-white hover:bg-blue-700"
            >
              {isSubmitting ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  Saving...
                </>
              ) : (
                <>
                  <i className={`fas ${connection ? 'fa-save' : 'fa-plus'} mr-2`}></i>
                  {connection ? 'Update Connection' : 'Create Connection'}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex justify-center items-center rounded-lg border border-gray-300 px-4 h-9 bg-white text-[14px] font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 transition-colors"
            >
              Cancel
            </button>
          </div>
      </div>
    </div>
  );
}
