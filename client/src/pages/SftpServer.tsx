import React, { useState, useEffect } from 'react';
import { 
  Server, Users, Key, Folder, Plus, Copy, Download,
  Terminal, Activity, Database, ChevronRight, HardDrive, Eye, EyeOff,
  RefreshCw, X, FolderOpen, File as FileIcon
} from 'lucide-react';
import { Button } from '../components/ui/Button';

interface SftpUser {
  id: string;
  username: string;
  uid: number;
  gid: number;
  homeDirectory: string;
  allowedDirectories: string[];
  hasKeyAuth: boolean;
  hasPasswordAuth: boolean;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

interface SftpKey {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  userId: string;
  createdAt: string;
}

interface SftpFile {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

interface ConnectionInfo {
  host: string;
  port: number;
  username: string;
  authMethods: string[];
  instructions: {
    password?: string;
    publickey?: string;
  };
}

type TabType = 'overview' | 'users' | 'files' | 'logs';

import { API_URL } from '../config/api';

export const SftpServer: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [users, setUsers] = useState<SftpUser[]>([]);
  const [keys, setKeys] = useState<SftpKey[]>([]);
  const [files, setFiles] = useState<SftpFile[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [, setLoading] = useState(false);
  
  // Modals
  const [showUserModal, setShowUserModal] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [, setShowFileBrowser] = useState(false);
  const [, setSelectedUser] = useState<SftpUser | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [generatedKey, setGeneratedKey] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  
  // Form states
  const [userForm, setUserForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    homeDirectory: '',
    allowedDirectories: '',
    hasPasswordAuth: true,
    hasKeyAuth: false,
  });
  const [keyForm, setKeyForm] = useState({ name: '', userId: '' });

  // Stats
  const stats = {
    totalUsers: users.length,
    activeConnections: users.filter(u => u.isActive).length,
    totalKeys: keys.length,
    diskUsage: '2.5 GB',
    totalFiles: files.length
  };

  useEffect(() => {
    fetchUsers();
    fetchFiles();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/sftp/users`);
      const data = await res.json();
      if (data.success) setUsers(data.data);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
    setLoading(false);
  };

  const fetchFiles = async (path = '/') => {
    try {
      const res = await fetch(`${API_URL}/sftp/files?path=${path}`);
      const data = await res.json();
      if (data.success) {
        setFiles(data.data.files);
        setCurrentPath(data.data.path);
      }
    } catch (err) {
      console.error('Failed to fetch files:', err);
    }
  };

  const fetchConnectionInfo = async (userId: string) => {
    try {
      const res = await fetch(`${API_URL}/sftp/connection-info/${userId}`);
      const data = await res.json();
      if (data.success) {
        setConnectionInfo(data.data);
        setShowConnectionModal(true);
      }
    } catch (err) {
      console.error('Failed to fetch connection info:', err);
    }
  };

  const createUser = async () => {
    if (userForm.password !== userForm.confirmPassword) {
      alert('Passwords do not match');
      return;
    }
    
    try {
      const res = await fetch(`${API_URL}/sftp/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userForm.username,
          password: userForm.password,
          homeDirectory: userForm.homeDirectory || `/home/${userForm.username}`,
          allowedDirectories: userForm.allowedDirectories.split(',').map(d => d.trim()).filter(Boolean),
          hasPasswordAuth: userForm.hasPasswordAuth,
          hasKeyAuth: userForm.hasKeyAuth,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setUsers([...users, data.data]);
        setShowUserModal(false);
        setUserForm({
          username: '',
          password: '',
          confirmPassword: '',
          homeDirectory: '',
          allowedDirectories: '',
          hasPasswordAuth: true,
          hasKeyAuth: false,
        });
      }
    } catch (err) {
      console.error('Failed to create user:', err);
    }
  };

  const generateKey = async () => {
    try {
      const res = await fetch(`${API_URL}/sftp/keys/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: keyForm.name,
          userId: keyForm.userId,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setGeneratedKey({
          privateKey: data.data.privateKey,
          publicKey: data.data.publicKey,
        });
        setKeys([...keys, data.data]);
        setShowKeyModal(false);
      }
    } catch (err) {
      console.error('Failed to generate key:', err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('Copied to clipboard!');
  };

  const downloadPrivateKey = () => {
    if (!generatedKey) return;
    const blob = new Blob([generatedKey.privateKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sftp_key_${Date.now()}.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const renderOverview = () => (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg"><Users className="w-5 h-5 text-blue-600" /></div>
            <div>
              <p className="text-sm text-blue-600">SFTP Users</p>
              <p className="text-2xl font-bold text-blue-900">{stats.totalUsers}</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 rounded-lg p-4 border border-green-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg"><Key className="w-5 h-5 text-green-600" /></div>
            <div>
              <p className="text-sm text-green-600">SSH Keys</p>
              <p className="text-2xl font-bold text-green-900">{stats.totalKeys}</p>
            </div>
          </div>
        </div>
        <div className="bg-purple-50 rounded-lg p-4 border border-purple-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg"><Folder className="w-5 h-5 text-purple-600" /></div>
            <div>
              <p className="text-sm text-purple-600">Files</p>
              <p className="text-2xl font-bold text-purple-900">{stats.totalFiles}</p>
            </div>
          </div>
        </div>
        <div className="bg-orange-50 rounded-lg p-4 border border-orange-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-100 rounded-lg"><HardDrive className="w-5 h-5 text-orange-600" /></div>
            <div>
              <p className="text-sm text-orange-600">Disk Usage</p>
              <p className="text-2xl font-bold text-orange-900">{stats.diskUsage}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-medium text-gray-900 mb-4">Quick Actions</h3>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setShowUserModal(true)} leftIcon={<Plus className="w-4 h-4" />}>
            Create SFTP User
          </Button>
          <Button variant="secondary" onClick={() => setShowFileBrowser(true)} leftIcon={<FolderOpen className="w-4 h-4" />}>
            Browse Files
          </Button>
        </div>
      </div>
    </div>
  );

  const renderUsers = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-medium text-gray-900">SFTP Users</h3>
          <p className="text-sm text-gray-500">Manage users, passwords, and SSH keys</p>
        </div>
        <Button onClick={() => setShowUserModal(true)} leftIcon={<Plus className="w-4 h-4" />}>
          Add User
        </Button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Home Directory</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Auth</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {users.map(user => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                      <Users className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{user.username}</p>
                      <p className="text-xs text-gray-500">UID: {user.uid}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{user.homeDirectory}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    {user.hasPasswordAuth && <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-700 rounded">Password</span>}
                    {user.hasKeyAuth && <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">Key</span>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => fetchConnectionInfo(user.id)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Connection Info">
                      <Copy className="w-4 h-4" />
                    </button>
                    <button onClick={() => { setKeyForm({ ...keyForm, userId: user.id }); setShowKeyModal(true); }} className="p-1.5 text-gray-400 hover:text-green-600" title="Generate Key">
                      <Key className="w-4 h-4" />
                    </button>
                    <button onClick={() => { setSelectedUser(user); setShowFileBrowser(true); }} className="p-1.5 text-gray-400 hover:text-purple-600" title="Browse Files">
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  No SFTP users yet. Click "Add User" to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderFiles = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-medium text-gray-900">File Browser</h3>
          <p className="text-sm text-gray-500">Current path: {currentPath}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => fetchFiles('/')} leftIcon={<RefreshCw className="w-4 h-4" />}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="divide-y divide-gray-100">
          {currentPath !== '/' && (
            <button onClick={() => fetchFiles(currentPath.split('/').slice(0, -1).join('/') || '/')} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 text-left">
              <Folder className="w-5 h-5 text-gray-400" />
              <span className="text-gray-600">..</span>
            </button>
          )}
          {files.map((file, idx) => (
            <div key={idx} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
              {file.type === 'directory' ? (
                <Folder className="w-5 h-5 text-yellow-500" />
              ) : (
                <FileIcon className="w-5 h-5 text-blue-500" />
              )}
              <span className="flex-1 text-gray-900">{file.name}</span>
              <span className="text-sm text-gray-500">{formatBytes(file.size)}</span>
              <span className="text-xs text-gray-400">{new Date(file.modifiedAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              {file.type === 'directory' && (
                <button onClick={() => fetchFiles(`${currentPath}/${file.name}`.replace(/\/+/g, '/'))} className="text-blue-600 hover:text-blue-800">
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Server className="w-6 h-6" />
            SFTP Server Management
          </h1>
          <p className="text-gray-600 mt-1">Manage users, SSH keys, and file transfers</p>
        </div>
        <span className="flex items-center gap-1 text-sm text-green-600 bg-green-50 px-3 py-1 rounded-full">
          <Activity className="w-4 h-4" />
          Running on port 2222
        </span>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex border-b border-gray-200">
          {[
            { id: 'overview', label: 'Overview', icon: Database },
            { id: 'users', label: 'Users & Keys', icon: Users },
            { id: 'files', label: 'Files', icon: Folder },
            { id: 'logs', label: 'Logs', icon: Terminal },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as TabType)}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'users' && renderUsers()}
          {activeTab === 'files' && renderFiles()}
          {activeTab === 'logs' && (
            <div className="bg-gray-900 rounded-lg p-4 font-mono text-sm text-green-400 h-[400px] overflow-y-auto">
              <div className="text-gray-500 mb-2"># SFTP Server Logs</div>
              <div>[2024-03-07 10:30:15] [INFO] Server started on port 22</div>
              <div>[2024-03-07 10:35:22] [AUTH] User 'john.doe' authenticated via key</div>
              <div className="text-yellow-400">[2024-03-07 10:45:33] [WARN] Failed login attempt</div>
            </div>
          )}
        </div>
      </div>

      {/* User Modal */}
      {showUserModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">Create SFTP User</h3>
              <button onClick={() => setShowUserModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                <input type="text" value={userForm.username} onChange={e => setUserForm({...userForm, username: e.target.value})} className="w-full px-3 py-2 border rounded-lg" placeholder="e.g., sftp_user" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input type="password" value={userForm.password} onChange={e => setUserForm({...userForm, password: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
                  <input type="password" value={userForm.confirmPassword} onChange={e => setUserForm({...userForm, confirmPassword: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Home Directory</label>
                <input type="text" value={userForm.homeDirectory} onChange={e => setUserForm({...userForm, homeDirectory: e.target.value})} className="w-full px-3 py-2 border rounded-lg" placeholder={`/home/${userForm.username}`} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Allowed Directories (comma-separated)</label>
                <input type="text" value={userForm.allowedDirectories} onChange={e => setUserForm({...userForm, allowedDirectories: e.target.value})} className="w-full px-3 py-2 border rounded-lg" placeholder="/uploads, /downloads" />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={userForm.hasPasswordAuth} onChange={e => setUserForm({...userForm, hasPasswordAuth: e.target.checked})} />
                  <span className="text-sm">Password Auth</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={userForm.hasKeyAuth} onChange={e => setUserForm({...userForm, hasKeyAuth: e.target.checked})} />
                  <span className="text-sm">Key Auth</span>
                </label>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setShowUserModal(false)}>Cancel</Button>
              <Button onClick={createUser}>Create User</Button>
            </div>
          </div>
        </div>
      )}

      {/* Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">Generate SSH Key</h3>
              <button onClick={() => setShowKeyModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
                <strong>Warning:</strong> Private key will be shown only once. Save it securely!
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Key Name</label>
                <input type="text" value={keyForm.name} onChange={e => setKeyForm({...keyForm, name: e.target.value})} className="w-full px-3 py-2 border rounded-lg" placeholder="e.g., laptop-key" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setShowKeyModal(false)}>Cancel</Button>
              <Button onClick={generateKey}>Generate Key Pair</Button>
            </div>
          </div>
        </div>
      )}

      {/* Connection Info Modal */}
      {showConnectionModal && connectionInfo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">Connection Information</h3>
              <button onClick={() => setShowConnectionModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between"><span className="text-gray-600">Host:</span> <span className="font-mono">{connectionInfo.host}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">Port:</span> <span className="font-mono">{connectionInfo.port}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">Username:</span> <span className="font-mono">{connectionInfo.username}</span></div>
              </div>
              
              {connectionInfo.authMethods.includes('password') && (
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Password Authentication</h4>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded-lg font-mono text-sm flex justify-between items-center">
                    <code>{connectionInfo.instructions.password}</code>
                    <button onClick={() => connectionInfo.instructions.password && copyToClipboard(connectionInfo.instructions.password)} className="text-gray-400 hover:text-white">
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
              
              {connectionInfo.authMethods.includes('publickey') && (
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Key Authentication</h4>
                  <div className="bg-gray-900 text-gray-100 p-3 rounded-lg font-mono text-sm flex justify-between items-center">
                    <code>{connectionInfo.instructions.publickey}</code>
                    <button onClick={() => connectionInfo.instructions.publickey && copyToClipboard(connectionInfo.instructions.publickey)} className="text-gray-400 hover:text-white">
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
              <Button onClick={() => setShowConnectionModal(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}

      {/* Generated Key Modal */}
      {generatedKey && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">SSH Key Generated - Save Private Key!</h3>
              <button onClick={() => setGeneratedKey(null)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
                <strong>IMPORTANT:</strong> This is the only time you will see the private key. Download it now!
              </div>
              
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="font-medium text-gray-700">Private Key (Save this!)</label>
                  <div className="flex gap-2">
                    <button onClick={() => setShowPrivateKey(!showPrivateKey)} className="text-sm text-blue-600">
                      {showPrivateKey ? <EyeOff className="w-4 h-4 inline" /> : <Eye className="w-4 h-4 inline" />} {showPrivateKey ? 'Hide' : 'Show'}
                    </button>
                    <button onClick={downloadPrivateKey} className="text-sm text-green-600">
                      <Download className="w-4 h-4 inline" /> Download
                    </button>
                  </div>
                </div>
                <textarea 
                  readOnly 
                  value={showPrivateKey ? generatedKey.privateKey : '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••'}
                  className="w-full h-32 px-3 py-2 border rounded-lg font-mono text-xs bg-gray-50"
                />
              </div>
              
              <div>
                <label className="font-medium text-gray-700 mb-2 block">Public Key (Add to ~/.ssh/authorized_keys)</label>
                <div className="flex gap-2">
                  <textarea readOnly value={generatedKey.publicKey} className="flex-1 px-3 py-2 border rounded-lg font-mono text-xs bg-gray-50" rows={3} />
                  <button onClick={() => copyToClipboard(generatedKey.publicKey)} className="inline-flex items-center justify-center px-3 h-9 bg-gray-100 rounded-lg hover:bg-gray-200 whitespace-nowrap">
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
              <Button onClick={() => setGeneratedKey(null)}>I've Saved the Private Key</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SftpServer;
