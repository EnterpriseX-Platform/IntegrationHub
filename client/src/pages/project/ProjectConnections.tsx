import { useState, useEffect } from 'react';
import { 
  Plug, 
  Plus, 
  AlertCircle, CheckCircle
} from 'lucide-react';
import { Search, Loading, InlineNotification } from '@carbon/react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import ConnectionModal from '../../components/modals/ConnectionModal';
import { ConnectionIcon } from '../../components/connections/ConnectionIcon';
import { ActionButtons, StatusBadge } from '../../components/connections/ActionButtons';
import SftpBrowserModal from '../../components/connections/SftpBrowserModal';
import type { Connection } from '../../types';
import { connectionRegistry } from '../../lib/connection-sdk';
import { API_URL, apiFetch } from '../../config/api';

interface Project {
  id: string;
  name: string;
}

interface APIConnection {
  id: string;
  name: string;
  type: string;
  status: string;
  config: string;
  displayOrder?: number;
  createdAt: string;
  lastTestedAt?: string;
}

export const ProjectConnections = ({ project }: { project: Project }) => {
  const [connections, setConnections] = useState<APIConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<APIConnection | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [browsing, setBrowsing] = useState<APIConnection | null>(null);
  const [testResult, setTestResult] = useState<{success: boolean; message: string; connectionName: string; error?: string; latency?: string} | null>(null);
  const [notification, setNotification] = useState<{type: 'success' | 'error'; title: string; message: string} | null>(null);
  
  // Drag and drop states
  const [draggedConnection, setDraggedConnection] = useState<APIConnection | null>(null);
  const [dragOverConnectionId, setDragOverConnectionId] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections();
  }, [project.id]);

  // Auto-dismiss notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const fetchConnections = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/projects/${project.id}`, {
        credentials: 'include',
      });
      const result = await response.json();
      if (result.success) {
        setConnections(result.data.connections || []);
      }
    } catch (error) {
      console.error('Error fetching connections:', error);
    } finally {
      setLoading(false);
    }
  };

  const testConnection = async (connectionId: string) => {
    setTestingId(connectionId);
    try {
      const response = await fetch(`${API_URL}/connections/${connectionId}/test`, {
        credentials: 'include',
      });
      const result = await response.json();
      const connection = connections.find(c => c.id === connectionId);
      const testData = result.data?.testResult;
      setTestResult({
        success: result.success,
        message: result.success ? 'Connection successful!' : (testData?.message || result.error || 'Connection failed'),
        connectionName: connection?.name || 'Connection',
        error: testData?.error,
        latency: testData?.latency,
      });
      fetchConnections();
    } catch (error) {
      const connection = connections.find(c => c.id === connectionId);
      setTestResult({
        success: false,
        message: 'Error testing connection',
        connectionName: connection?.name || 'Connection'
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleSave = async (connection: any) => {
    try {
      const url = connection.id ? `${API_URL}/connections/${connection.id}` : `${API_URL}/connections`;
      const method = connection.id ? 'PUT' : 'POST';
      
      const response = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...connection,
          projectId: project.id,
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        setShowCreateModal(false);
        setEditingConnection(null);
        setNotification({ type: 'success', title: 'Connection Saved', message: 'Connection saved successfully' });
        fetchConnections();
      } else {
        setNotification({ type: 'error', title: 'Failed to Save', message: result.error || 'Failed to save connection' });
      }
    } catch (error) {
      console.error('Error saving connection:', error);
      setNotification({ type: 'error', title: 'Network Error', message: error instanceof Error ? error.message : 'Failed to save connection' });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!connectionToDelete) return;
    
    setIsDeleting(true);
    try {
      const response = await apiFetch(`${API_URL}/connections/${connectionToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      
      const result = await response.json();
      
      if (result.success) {
        setConnections(connections.filter(c => c.id !== connectionToDelete.id));
        setShowDeleteModal(false);
        setConnectionToDelete(null);
        setNotification({ type: 'success', title: 'Connection Deleted', message: 'Connection deleted successfully' });
      } else {
        setNotification({ type: 'error', title: 'Failed to Delete', message: result.error || 'Failed to delete connection' });
      }
    } catch (error) {
      setNotification({ type: 'error', title: 'Network Error', message: 'Error deleting connection' });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteClick = (connection: APIConnection) => {
    setConnectionToDelete(connection);
    setShowDeleteModal(true);
  };

  const handleEdit = (connection: APIConnection) => {
    const config = typeof connection.config === 'string' 
      ? JSON.parse(connection.config) 
      : connection.config;
    
    const convertedConnection: Connection = {
      id: connection.id,
      name: connection.name,
      type: connection.type as any,
      config: config,
      isActive: connection.status === 'Connected',
      createdAt: new Date(connection.createdAt),
      updatedAt: new Date(connection.createdAt),
      projectId: project.id,
    };
    setEditingConnection(convertedConnection);
    setShowCreateModal(true);
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, connection: APIConnection) => {
    setDraggedConnection(connection);
    
    // Set drag image
    const dragImage = document.createElement('div');
    dragImage.className = 'bg-white border border-purple-400 rounded-lg p-3 shadow-lg text-sm font-medium';
    dragImage.textContent = connection.name;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };

  const handleDragOver = (e: React.DragEvent, targetConnection: APIConnection) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedConnection && draggedConnection.id !== targetConnection.id) {
      setDragOverConnectionId(targetConnection.id);
    }
  };

  const handleDragLeave = () => {
    setDragOverConnectionId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetConnection: APIConnection) => {
    e.preventDefault();
    setDragOverConnectionId(null);
    
    if (!draggedConnection || draggedConnection.id === targetConnection.id) {
      setDraggedConnection(null);
      return;
    }
    
    // Get filtered connections (same as displayed)
    const currentList = [...filteredConnections];
    const draggedIndex = currentList.findIndex(c => c.id === draggedConnection.id);
    const targetIndex = currentList.findIndex(c => c.id === targetConnection.id);
    
    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedConnection(null);
      return;
    }
    
    // Swap positions
    const [removed] = currentList.splice(draggedIndex, 1);
    currentList.splice(targetIndex, 0, removed);
    
    // Update connections state with new displayOrder
    const updatedConnections = connections.map(c => {
      const newIndex = currentList.findIndex(cc => cc.id === c.id);
      if (newIndex !== -1) {
        return { ...c, displayOrder: newIndex };
      }
      return c;
    });
    
    // Sort by displayOrder
    updatedConnections.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    setConnections(updatedConnections);
    setDraggedConnection(null);
    
    // Auto-save positions to backend
    try {
      const positions = currentList.map((c, index) => ({
        connectionId: c.id,
        position: index,
      }));
      await fetch(`${API_URL}/connections/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
    } catch (err) {
      console.error('Failed to save connection positions:', err);
    }
  };

  const handleDragEnd = () => {
    setDraggedConnection(null);
    setDragOverConnectionId(null);
  };

  const handleNew = () => {
    setEditingConnection(null);
    setShowCreateModal(true);
  };

  const filteredConnections = connections.filter(conn => {
    return conn.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const getConnectionTypeLabel = (type: string) => {
    const connType = connectionRegistry.get(type);
    return connType?.name || type;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loading withOverlay={false} small description="Loading connections" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Connections</h2>
          <p className="text-sm text-gray-500">
            Manage connections to external systems
          </p>
        </div>
        <Button onClick={handleNew} leftIcon={<Plus className="h-4 w-4" />}>
          Add Connection
        </Button>
      </div>

      {/* Search and View Toggle */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex-1 max-w-md">
          <Search
            id="project-connections-search"
            size="md"
            labelText="Search connections"
            placeholder="Search connections..."
            value={searchQuery}
            onChange={(e: any) => setSearchQuery(e.target?.value ?? '')}
            onClear={() => setSearchQuery('')}
          />
        </div>
        
      </div>

      {/* Connections List - Compact Cards */}
      {filteredConnections.length > 0 ? (
          /* Wide Row Cards */
          <div className="space-y-2">
            {filteredConnections.map(connection => {
              const config = JSON.parse(connection.config || '{}');
              const subtype = config.type || config.subtype;
              const isTesting = testingId === connection.id;
              
              return (
                <div 
                  key={connection.id}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, connection)}
                  onDragOver={(e) => handleDragOver(e, connection)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, connection)}
                  onDragEnd={handleDragEnd}
                  className={`cds--tile app-tile !px-4 !py-2.5 cursor-move transition-all duration-200 group flex flex-wrap items-center gap-x-4 gap-y-2 relative
                    ${dragOverConnectionId === connection.id && draggedConnection?.id !== connection.id 
                      ? 'opacity-30 scale-[0.98] border-purple-400' 
                      : ''}
                    ${draggedConnection?.id === connection.id ? 'opacity-40' : ''}
                  `}
                >
                  {/* Drop Placeholder - Dashed border */}
                  {dragOverConnectionId === connection.id && draggedConnection?.id !== connection.id && (
                    <div className="absolute inset-0 border-2 border-dashed border-purple-400 rounded-lg bg-purple-50/30 z-10 flex items-center justify-center">
                      <span className="text-xs text-purple-600 font-medium">Drop here</span>
                    </div>
                  )}
                  {/* Icon */}
                  <ConnectionIcon 
                    type={connection.type} 
                    subtype={subtype}
                    size="sm"
                  />
                  
                  {/* Name & Type */}
                  <div className="flex-1 sm:flex-none sm:w-52 lg:w-72 min-w-[9rem] shrink-0">
                    <h3 className="font-medium text-sm text-gray-900 truncate" title={connection.name}>{connection.name}</h3>
                    <p className="text-[12px] text-gray-500">
                      {getConnectionTypeLabel(subtype || connection.type)}
                    </p>
                  </div>
                  
                  {/* Host/URL */}
                  <div className="hidden sm:block flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-gray-600">
                      <i className="fas fa-server text-gray-400 text-[12px]"></i>
                      <span className="truncate">
                        {config.host || config.baseUrl || config.endpoint || 'No host configured'}
                      </span>
                    </div>
                    {config.database && (
                      <div className="flex items-center gap-1.5 text-[12px] text-gray-500 mt-0.5">
                        <i className="fas fa-database text-gray-400"></i>
                        <span className="truncate">{config.database}</span>
                      </div>
                    )}
                  </div>
                  
                  {/* Status */}
                  <div className="ml-auto sm:ml-0 shrink-0 sm:w-28">
                    <StatusBadge 
                      status={connection.status} 
                    />
                  </div>
                  
                  {/* Actions */}
                  <div className="flex items-center gap-1 ml-auto">
                    <ActionButtons
                      connectionId={connection.id}
                      isTesting={isTesting}
                      onTest={testConnection}
                      onEdit={() => handleEdit(connection)}
                      onDelete={() => handleDeleteClick(connection)}
                      onBrowse={connection.type === 'sftp' ? () => setBrowsing(connection) : undefined}
                      size="sm"
                    />
                  </div>
                </div>
              );
            })}
          </div>
      ) : (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
          <Plug className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {searchQuery ? 'No connections found' : 'No connections yet'}
          </h3>
          <p className="text-gray-500 mb-4 max-w-md mx-auto">
            {searchQuery 
              ? 'Try adjusting your search query'
              : 'Add connections to external systems like databases, storage, or APIs to get started'
            }
          </p>
          {!searchQuery && (
            <Button onClick={handleNew} leftIcon={<Plus className="h-4 w-4" />}>
              Add Connection
            </Button>
          )}
        </div>
      )}

      {/* Connection Modal */}
      {browsing && (
        <SftpBrowserModal
          connectionId={browsing.id}
          connectionName={browsing.name}
          onClose={() => setBrowsing(null)}
        />
      )}

      <ConnectionModal
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          setEditingConnection(null);
        }}
        onSave={handleSave}
        connection={editingConnection}
        projectId={project.id}
      />

      {/* Toast Notification */}
      {notification && (
        <div className="fixed top-4 right-4 z-[60] max-w-md">
          <InlineNotification
            kind={notification.type}
            lowContrast
            title={notification.title}
            subtitle={notification.message}
            onCloseButtonClick={() => setNotification(null)}
          />
        </div>
      )}

      {/* Test Result Modal */}
      <Modal
        isOpen={!!testResult}
        onClose={() => setTestResult(null)}
        title="Test Connection"
        size="sm"
      >
        {testResult && (
          <>
            <div className={`flex items-center gap-3 mb-3 ${testResult.success ? 'text-green-500' : 'text-red-500'}`}>
              {testResult.success ? (
                <CheckCircle className="h-10 w-10" />
              ) : (
                <AlertCircle className="h-10 w-10" />
              )}
            </div>
            <p className="text-sm text-gray-600">
              <strong>{testResult.connectionName}</strong>
            </p>
            <p className={`text-sm mt-2 ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
              {testResult.message}
            </p>
            {testResult.error && (
              <InlineNotification
                className="mt-3"
                kind="error"
                lowContrast
                hideCloseButton
                title="Error Detail:"
                subtitle={testResult.error}
              />
            )}
            {testResult.latency && (
              <p className="text-xs text-gray-400 mt-2">
                <i className="fas fa-clock mr-1"></i>
                Latency: {testResult.latency}
              </p>
            )}
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
              <Button onClick={() => setTestResult(null)}>
                OK
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal && !!connectionToDelete}
        onClose={() => setShowDeleteModal(false)}
        title="Delete Connection"
        size="sm"
      >
        {connectionToDelete && (
          <>
            <div className="flex items-center gap-3 text-amber-500 mb-3">
              <AlertCircle className="h-8 w-8" />
            </div>
            <p className="text-sm text-gray-600">
              Are you sure you want to delete <strong>{connectionToDelete.name}</strong>?
            </p>
            <p className="text-sm text-gray-500 mt-2">
              This action cannot be undone. Flows using this connection may fail.
            </p>
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
              <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteConfirm}
                isLoading={isDeleting}
              >
                Delete Connection
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};

export default ProjectConnections;
