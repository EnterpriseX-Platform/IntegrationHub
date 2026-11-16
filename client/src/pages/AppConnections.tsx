import React, { useState, useEffect } from 'react';
import { 
  Plus, Tag, Edit2, Trash2, Link as LinkIcon, 
  Server, Database, Globe, Users,
  CheckCircle, XCircle, RefreshCw
} from 'lucide-react';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Search as CdsSearch, Select, SelectItem, TextInput, IconButton, Loading } from '@carbon/react';

interface Connection {
  id: string;
  name: string;
  type: 'sftp' | 'database' | 'http' | 'api';
  config: any;
  status: 'connected' | 'disconnected' | 'error';
  isShared: boolean;
  sharedWith: string[];
  tags: { tag: Tag }[];
  createdAt: string;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  description?: string;
}

import { API_URL, apiFetch } from '../config/api';

const connectionIcons: Record<string, React.ReactNode> = {
  sftp: <Server className="w-5 h-5" />,
  database: <Database className="w-5 h-5" />,
  http: <Globe className="w-5 h-5" />,
  api: <LinkIcon className="w-5 h-5" />,
};

const connectionColors: Record<string, string> = {
  sftp: 'bg-orange-100 text-orange-700',
  database: 'bg-blue-100 text-blue-700',
  http: 'bg-green-100 text-green-700',
  api: 'bg-purple-100 text-purple-700',
};

export const AppConnections: React.FC = () => {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedTag, setSelectedTag] = useState<string>('');
  
  // Modals
  const [, setShowConnectionModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [, setEditingConnection] = useState<Connection | null>(null);
  const [] = useState<Tag | null>(null);

  useEffect(() => {
    fetchConnections();
    fetchTags();
  }, []);

  const fetchConnections = async () => {
    try {
      const response = await fetch(`${API_URL}/app-connections`);
      const result = await response.json();
      if (result.success) {
        setConnections(result.data);
      }
    } catch (error) {
      console.error('Error fetching connections:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchTags = async () => {
    try {
      const response = await fetch(`${API_URL}/app-connections/tags`);
      const result = await response.json();
      if (result.success) {
        setTags(result.data);
      }
    } catch (error) {
      console.error('Error fetching tags:', error);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;
    
    try {
      const response = await apiFetch(`${API_URL}/app-connections/${id}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      if (result.success) {
        fetchConnections();
      }
    } catch (error) {
      console.error('Error deleting connection:', error);
    }
  };

  const handleTestConnection = async (id: string) => {
    try {
      const response = await fetch(`${API_URL}/app-connections/${id}/test`, {
        method: 'POST'
      });
      const result = await response.json();
      alert(result.success ? 'Connection test successful!' : 'Connection test failed');
    } catch (error) {
      console.error('Error testing connection:', error);
    }
  };

  const filteredConnections = connections.filter(conn => {
    const matchesSearch = conn.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = selectedType === 'all' || conn.type === selectedType;
    const matchesTag = !selectedTag || conn.tags.some(t => t.tag.id === selectedTag);
    return matchesSearch && matchesType && matchesTag;
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">App Connections</h1>
          <p className="text-gray-600 mt-1">
            Manage shared connections across all projects
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            onClick={() => setShowTagModal(true)}
            leftIcon={<Tag className="w-4 h-4" />}
          >
            Manage Tags
          </Button>
          <Button
            onClick={() => {
              setEditingConnection(null);
              setShowConnectionModal(true);
            }}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Add Connection
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="cds--tile app-tile p-4 mb-6">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <CdsSearch
              id="app-connections-search"
              labelText="Search connections"
              placeholder="Search connections..."
              value={searchTerm}
              onChange={(e: any) => setSearchTerm(e.target.value)}
              onClear={() => setSearchTerm('')}
            />
          </div>

          <Select
            id="app-connections-type"
            labelText="Type"
            hideLabel
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
          >
            <SelectItem value="all" text="All Types" />
            <SelectItem value="sftp" text="SFTP" />
            <SelectItem value="database" text="Database" />
            <SelectItem value="http" text="HTTP" />
            <SelectItem value="api" text="API" />
          </Select>

          <Select
            id="app-connections-tag"
            labelText="Tag"
            hideLabel
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
          >
            <SelectItem value="" text="All Tags" />
            {tags.map(tag => (
              <SelectItem key={tag.id} value={tag.id} text={tag.name} />
            ))}
          </Select>
        </div>
      </div>

      {/* Connections Grid */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loading withOverlay={false} description="Loading connections" />
        </div>
      ) : filteredConnections.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <Server className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">No connections found</h3>
          <p className="text-gray-500">Create a new connection to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredConnections.map(connection => (
            <div
              key={connection.id}
              className="cds--tile app-tile p-5 hover:shadow-md transition-shadow"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div className={`p-2 rounded-lg ${connectionColors[connection.type] || 'bg-gray-100'}`}>
                  {connectionIcons[connection.type] || <Server className="w-5 h-5" />}
                </div>
                <div className="flex gap-1">
                  <IconButton kind="ghost" size="sm" label="Test connection" onClick={() => handleTestConnection(connection.id)}>
                    <RefreshCw className="w-4 h-4" />
                  </IconButton>
                  <IconButton
                    kind="ghost"
                    size="sm"
                    label="Edit"
                    onClick={() => {
                      setEditingConnection(connection);
                      setShowConnectionModal(true);
                    }}
                  >
                    <Edit2 className="w-4 h-4" />
                  </IconButton>
                  <IconButton kind="ghost" size="sm" label="Delete" onClick={() => handleDeleteConnection(connection.id)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </div>
              </div>

              {/* Content */}
              <h3 className="font-semibold text-gray-900 mb-1">{connection.name}</h3>
              <p className="text-sm text-gray-500 capitalize mb-3">{connection.type}</p>

              {/* Tags */}
              {connection.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {connection.tags.map(({ tag }) => (
                    <span
                      key={tag.id}
                      className="px-2 py-0.5 text-xs rounded-full"
                      style={{ backgroundColor: tag.color + '20', color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  {connection.status === 'connected' ? (
                    <span className="flex items-center gap-1 text-xs text-green-600">
                      <CheckCircle className="w-3 h-3" /> Connected
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <XCircle className="w-3 h-3" /> Disconnected
                    </span>
                  )}
                </div>
                {connection.isShared && (
                  <span className="flex items-center gap-1 text-xs text-blue-600">
                    <Users className="w-3 h-3" /> Shared
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tag Management Modal */}
      <Modal
        isOpen={showTagModal}
        onClose={() => setShowTagModal(false)}
        title="Manage Tags"
        size="md"
      >
        <div className="space-y-4">
          {/* Add New Tag Form */}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              try {
                const response = await fetch(`${API_URL}/app-connections/tags`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name: formData.get('name'),
                    color: formData.get('color'),
                    description: formData.get('description')
                  })
                });
                if (response.ok) {
                  fetchTags();
                  e.currentTarget.reset();
                }
              } catch (error) {
                console.error('Error creating tag:', error);
              }
            }}
            className="flex gap-2"
          >
            <div className="flex-1">
              <TextInput id="app-connections-tag-name" name="name" labelText="Tag name" hideLabel placeholder="Tag name" required />
            </div>
            <input
              name="color"
              type="color"
              defaultValue="#3B82F6"
              className="w-12 h-10 rounded cursor-pointer"
            />
            <Button type="submit" size="sm">Add</Button>
          </form>

          {/* Tags List */}
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {tags.map(tag => (
              <div
                key={tag.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="font-medium">{tag.name}</span>
                  <span className="text-xs text-gray-500">
                    ({(tag as any)._count?.connections || 0} connections)
                  </span>
                </div>
                <IconButton
                  kind="ghost"
                  size="sm"
                  label="Delete tag"
                  onClick={async () => {
                    if (!confirm('Delete this tag?')) return;
                    try {
                      await apiFetch(`${API_URL}/app-connections/tags/${tag.id}`, {
                        method: 'DELETE'
                      });
                      fetchTags();
                    } catch (error) {
                      console.error('Error deleting tag:', error);
                    }
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default AppConnections;
