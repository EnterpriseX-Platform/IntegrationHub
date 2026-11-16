import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { 
  PlusIcon, 
  LinkIcon,
  TrashIcon,
  PencilIcon,
  PlayIcon,
} from '../components/icons';
import { Search, InlineNotification, InlineLoading, Tag, IconButton } from '@carbon/react';
import { Button } from '../components/ui/Button';
import ConnectionModal from '../components/modals/ConnectionModal';
import type { Connection, DatabaseConfig, SFTPConfig, HTTPConfig, GoogleDriveConfig } from '../types';
import { apiFetch } from '../config/api';
import SftpBrowserModal from '../components/connections/SftpBrowserModal';

const connectionTypeLabels: Record<string, { label: string; icon: string; color: string; bgColor: string }> = {
  'database': { 
    label: 'Database', 
    icon: 'fa-database', 
    color: 'text-blue-600', 
    bgColor: 'bg-blue-100' 
  },
  'sftp': { 
    label: 'SFTP', 
    icon: 'fa-server', 
    color: 'text-green-600', 
    bgColor: 'bg-green-100' 
  },
  'smtp': {
    label: 'SMTP (Email)',
    icon: 'fa-envelope',
    color: 'text-rose-600',
    bgColor: 'bg-rose-100'
  },
  'http': { 
    label: 'HTTP / REST API', 
    icon: 'fa-globe', 
    color: 'text-purple-600', 
    bgColor: 'bg-purple-100' 
  },
  'google-drive': { 
    label: 'Google Drive', 
    icon: 'fa-brands fa-google-drive', 
    color: 'text-red-600', 
    bgColor: 'bg-red-100' 
  },
  'rest-api': { 
    label: 'REST API', 
    icon: 'fa-plug', 
    color: 'text-indigo-600', 
    bgColor: 'bg-indigo-100' 
  },
  'graphql': { 
    label: 'GraphQL', 
    icon: 'fa-project-diagram', 
    color: 'text-pink-600', 
    bgColor: 'bg-pink-100' 
  },
  'oauth2': { 
    label: 'OAuth 2.0', 
    icon: 'fa-key', 
    color: 'text-yellow-600', 
    bgColor: 'bg-yellow-100' 
  },
  'custom': { 
    label: 'Custom', 
    icon: 'fa-cog', 
    color: 'text-gray-600', 
    bgColor: 'bg-gray-100' 
  },
};

const databaseTypeLabels: Record<string, string> = {
  'postgresql': 'PostgreSQL',
  'mysql': 'MySQL',
  'sqlite': 'SQLite',
  'oracle': 'Oracle',
  'mssql': 'SQL Server',
  'mongodb': 'MongoDB',
};

export default function Connections() {
  const { projectId } = useParams<{ projectId: string }>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchConnections = async () => {
    if (!projectId) {
      console.warn('[Connections] No projectId provided');
      setLoading(false);
      return;
    }
    
    console.log('[Connections] Fetching connections for project:', projectId);
    
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`/api/projects/${projectId}`, {
        credentials: 'include',
      });
      const data = await response.json();
      
      console.log('[Connections] API response:', data);
      
      if (data.success && data.data) {
        // Parse connection config strings to objects
        const parsedConnections = (data.data.connections || []).map((conn: Connection) => {
          try {
            return {
              ...conn,
              config: typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config,
              createdAt: new Date(conn.createdAt),
              updatedAt: new Date(conn.updatedAt),
              lastTestedAt: conn.lastTestedAt ? new Date(conn.lastTestedAt) : undefined,
            };
          } catch (parseErr) {
            console.error('[Connections] Error parsing config for connection:', conn.id, parseErr);
            return conn;
          }
        });
        console.log('[Connections] Parsed connections:', parsedConnections.length);
        setConnections(parsedConnections);
      } else {
        console.error('[Connections] API error:', data.error);
        setError(data.error || 'Failed to load connections');
      }
    } catch (err) {
      console.error('[Connections] Error fetching connections:', err);
      setError(err instanceof Error ? err.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    console.log('[Connections] Component mounted, projectId:', projectId);
    fetchConnections();
    
    // Add global error handler
    const handleError = (event: ErrorEvent) => {
      console.error('[Connections] Global error:', event.error);
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, [projectId]);

  const handleSave = async (connection: Partial<Connection>) => {
    if (!projectId) return;
    
    // Clear previous errors
    setError(null);
    setSuccessMessage(null);
    
    try {
      console.log('[Connections] Saving connection:', { id: connection.id, name: connection.name, type: connection.type });
      
      const url = connection.id ? `/api/connections/${connection.id}` : '/api/connections';
      const method = connection.id ? 'PUT' : 'POST';
      
      const payload = {
        ...connection,
        projectId,
        config: typeof connection.config === 'object' ? connection.config : JSON.parse(connection.config || '{}'),
      };
      
      console.log('[Connections] Sending request:', { url, method, payload });
      
      const response = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      
      const data = await response.json();
      console.log('[Connections] Response:', data);
      
      if (data.success) {
        setSuccessMessage(connection.id ? 'Connection updated successfully' : 'Connection created successfully');
        setIsModalOpen(false);
        setEditingConnection(null);
        await fetchConnections();
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        console.error('[Connections] API error:', data.error);
        setError(data.error || 'Failed to save connection');
      }
    } catch (err) {
      console.error('[Connections] Error saving connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to save connection');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;
    
    try {
      const response = await apiFetch(`/api/connections/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      
      const data = await response.json();
      
      if (data.success) {
        setSuccessMessage('Connection deleted successfully');
        fetchConnections();
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        setError(data.error || 'Failed to delete connection');
      }
    } catch (err) {
      console.error('Error deleting connection:', err);
      setError('Failed to delete connection');
    }
  };

  const handleTest = async (id: string) => {
    console.log('[Connections] Testing connection:', id);
    setTestingId(id);
    setError(null);
    setSuccessMessage(null);
    
    try {
      const response = await fetch(`/api/connections/${id}/test`, {
        credentials: 'include',
      });
      const data = await response.json();
      console.log('[Connections] Test response:', data);
      
      if (data.success) {
        setSuccessMessage(`Connection test successful! Latency: ${data.data?.testResult?.latency || 'N/A'}`);
        await fetchConnections();
      } else {
        console.error('[Connections] Test failed:', data.error);
        setError(data.error || 'Connection test failed');
      }
    } catch (err) {
      console.error('[Connections] Error testing connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to test connection');
    } finally {
      setTestingId(null);
    }
  };

  const handleEdit = (connection: Connection) => {
    console.log('[Connections] Editing connection:', connection.id);
    setEditingConnection(connection);
    setIsModalOpen(true);
  };

  const [browsing, setBrowsing] = useState<Connection | null>(null);

  const handleNew = () => {
    console.log('[Connections] Creating new connection - START');
    setEditingConnection(null);
    setIsModalOpen(true);
    console.log('[Connections] setIsModalOpen(true) called, isModalOpen should be true');
  };

  const filteredConnections = connections.filter((conn) =>
    conn.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getConnectionDetail = (conn: Connection) => {
    if (conn.type === 'database') {
      const config = conn.config as DatabaseConfig;
      const dbType = config?.type || 'unknown';
      const dbName = config?.database || config?.connectionString || 'unknown';
      return `${databaseTypeLabels[dbType] || dbType} • ${dbName}`;
    }
    if (conn.type === 'sftp') {
      const config = conn.config as SFTPConfig;
      return `${config?.host || 'unknown'}:${config?.port || 22}`;
    }
    if (conn.type === 'http' || conn.type === 'rest-api') {
      const config = conn.config as HTTPConfig;
      return config?.baseUrl || 'No URL configured';
    }
    if (conn.type === 'google-drive') {
      const config = conn.config as GoogleDriveConfig;
      const authType = config?.authType || 'unknown';
      return `Google Drive • ${authType === 'oauth2' ? 'OAuth 2.0' : 'Service Account'}`;
    }
    return 'No details available';
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Connections</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your database, API, and file transfer connections</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            console.log('[Connections] Button clicked!');
            handleNew();
          }}
          leftIcon={<PlusIcon className="w-5 h-5" />}
        >
          New Connection
        </Button>
      </div>

      {/* Alerts */}
      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          title={error}
          onClose={() => { setError(null); return false; }}
        />
      )}

      {successMessage && (
        <InlineNotification
          kind="success"
          lowContrast
          title={successMessage}
          onClose={() => { setSuccessMessage(null); return false; }}
        />
      )}

      {/* Search */}
      <div className="max-w-md">
        <Search
          id="connections-search"
          size="md"
          labelText="Search connections"
          placeholder="Search connections..."
          value={searchQuery}
          onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          onClear={() => setSearchQuery('')}
        />
      </div>


      {loading ? (
        <div className="flex items-center justify-center py-12">
          <InlineLoading description="Loading connections..." />
        </div>
      ) : null}

      {/* Empty State */}
      {!loading && filteredConnections.length === 0 && (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <LinkIcon className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {searchQuery ? 'No connections found' : 'No connections yet'}
          </h3>
          <p className="text-gray-500 mb-4">
            {searchQuery 
              ? 'Try adjusting your search query' 
              : 'Create your first connection to start integrating with external services'}
          </p>
          {!searchQuery && (
            <Button
              variant="primary"
              onClick={() => {
                console.log('[Connections] Create Connection button clicked!');
                handleNew();
              }}
              leftIcon={<PlusIcon className="w-5 h-5" />}
            >
              Create Connection
            </Button>
          )}
        </div>
      )}

      {/* Connections Grid */}
      {!loading && filteredConnections.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filteredConnections.map((connection) => {
            const typeInfo = connectionTypeLabels[connection.type] || connectionTypeLabels['custom'];
            
            return (
              <div key={connection.id} className="cds--tile app-tile">
                <div className="p-2">
                  {/* Header */}
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <div className={`w-12 h-12 ${typeInfo.bgColor} rounded-xl flex items-center justify-center`}>
                        <i className={`fas ${typeInfo.icon} ${typeInfo.color} text-xl`}></i>
                      </div>
                    </div>
                    <div className="ml-4 flex-1 min-w-0">
                      <h3 className="text-lg font-medium text-gray-900 truncate" title={connection.name}>{connection.name}</h3>
                      <p className="text-sm text-gray-500">{typeInfo.label}</p>
                    </div>
                  </div>
                  
                  {/* Details */}
                  <div className="mt-4">
                    <p className="text-sm text-gray-600 truncate" title={getConnectionDetail(connection)}>
                      {getConnectionDetail(connection)}
                    </p>
                  </div>
                  
                  {/* Status Badges */}
                  <div className="mt-4 flex items-center gap-2 flex-wrap">
                    <Tag size="sm" type={connection.isActive ? 'green' : 'gray'}>
                      {connection.isActive ? (
                        <><i className="fas fa-check-circle mr-1"></i> Active</>
                      ) : (
                        <><i className="fas fa-pause-circle mr-1"></i> Inactive</>
                      )}
                    </Tag>
                    
                    {connection.lastTestStatus && (
                      <Tag size="sm" type={connection.lastTestStatus === 'success' ? 'green' : 'red'}>
                        {connection.lastTestStatus === 'success' ? (
                          <><i className="fas fa-check mr-1"></i> Test OK</>
                        ) : (
                          <><i className="fas fa-times mr-1"></i> Test Failed</>
                        )}
                      </Tag>
                    )}
                  </div>
                  
                  {/* Actions */}
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-400">
                        Updated {connection.updatedAt.toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                      <div className="flex gap-1">
                        {connection.type === 'sftp' && (
                          <IconButton kind="ghost" size="sm" label="Browse files" onClick={() => setBrowsing(connection)}>
                            <i className="fas fa-folder-open"></i>
                          </IconButton>
                        )}
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Test Connection"
                          onClick={() => handleTest(connection.id)}
                          disabled={testingId === connection.id}
                        >
                          {testingId === connection.id ? (
                            <InlineLoading />
                          ) : (
                            <PlayIcon className="w-4 h-4" />
                          )}
                        </IconButton>
                        <IconButton kind="ghost" size="sm" label="Edit" onClick={() => handleEdit(connection)}>
                          <PencilIcon className="w-4 h-4" />
                        </IconButton>
                        <IconButton kind="ghost" size="sm" label="Delete" onClick={() => handleDelete(connection.id)}>
                          <TrashIcon className="w-4 h-4" />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {browsing && (
        <SftpBrowserModal
          connectionId={browsing.id}
          connectionName={browsing.name}
          onClose={() => setBrowsing(null)}
        />
      )}

      {/* Modal - isModalOpen: ${isModalOpen} */}
      <ConnectionModal
        isOpen={isModalOpen}
        onClose={() => {
          console.log('[Connections] Closing modal');
          setIsModalOpen(false);
          setEditingConnection(null);
        }}
        onSave={handleSave}
        connection={editingConnection}
        projectId={projectId || ''}
      />
    </div>
  );
}
