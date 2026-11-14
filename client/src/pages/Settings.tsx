import { useState, useEffect } from 'react';
import { 
  Building2,
  Users, 
  UserPlus, 
  Shield, 
  Edit2,
  Trash2,
  Search,
  X,
  Settings,
  Database,
  Server,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  Variable,
  Monitor,
  UsersRound
} from 'lucide-react';
import { GroupsPanel } from '../components/access/GroupsPanel';
import { TenantsPanel } from '../components/tenant/TenantsPanel';
import { useCurrentUser, isSuperAdmin } from '../lib/currentUser';
import { AdminOnlyNotice } from '../components/access/AdminOnly';
import { Button } from '../components/ui/Button';

interface UserData {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  status: 'active' | 'inactive';
  createdAt: string;
  lastLogin?: string;
}

interface ConfigEntry {
  key: string;
  value: string; // '********' when isSecret (masked by the server)
  description: string | null;
  category: string;
  isSecret: boolean;
  updatedAt: string;
}

interface SystemInfo {
  database: {
    provider: string | null;
    host: string | null;
    port: number | null;
    name: string | null;
    status: 'connected' | 'disconnected';
    latencyMs: number | null;
  };
  application: {
    environment: string;
    basePath: string;
    nodeVersion: string;
  };
  server: {
    hostname: string;
    platform: string;
    uptimeSeconds: number;
    timezone: string;
  };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}, ${h} hour${h === 1 ? '' : 's'}`;
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'}, ${m} min`;
  return `${m} min`;
}

import { API_URL, apiFetch } from '../config/api';

declare const __APP_VERSION__: string;

const tabs = [
  { id: 'tenants', label: 'Tenants', icon: Building2 },
  { id: 'users', label: 'User Management', icon: Users },
  { id: 'groups', label: 'Groups', icon: UsersRound },
  { id: 'config', label: 'Configuration', icon: Variable },
  { id: 'system', label: 'System Info', icon: Monitor },
];

/** Settings is admin only; the server refuses these APIs to other users anyway. */
export default function SystemSettings() {
  const user = useCurrentUser();
  if (!isSuperAdmin(user)) return <AdminOnlyNotice page="System Settings" />;
  return <SettingsAdmin />;
}

function SettingsAdmin() {
  const [activeTab, setActiveTab] = useState<'tenants' | 'users' | 'groups' | 'config' | 'system'>('users');
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [usersError, setUsersError] = useState<string | null>(null);

  // Configuration (system_configs table, read-only here)
  const [configs, setConfigs] = useState<ConfigEntry[] | null>(null);
  const [configsError, setConfigsError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // System info
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemInfoError, setSystemInfoError] = useState<string | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);

  const fetchSystemInfo = async () => {
    setSystemInfoLoading(true);
    setSystemInfoError(null);
    try {
      const response = await fetch(`${API_URL}/admin/system-info`);
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to load system info');
      setSystemInfo(data.data);
    } catch (error) {
      setSystemInfoError(error instanceof Error ? error.message : String(error));
    } finally {
      setSystemInfoLoading(false);
    }
  };

  // Reload every time the tab is opened, so status and uptime are current
  useEffect(() => {
    if (activeTab === 'system') fetchSystemInfo();
  }, [activeTab]);

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role: 'user' as 'admin' | 'user',
    status: 'active' as 'active' | 'inactive'
  });

  // Check if current user is admin
  const userStr = localStorage.getItem('user');
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const isAdmin = currentUser?.role === 'admin';

  // Fetch users
  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin]);

  const fetchUsers = async () => {
    setUsersError(null);
    try {
      const response = await fetch(`${API_URL}/admin/users`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to load users');
      setUsers(data.data || []);
    } catch (error) {
      console.error('Failed to fetch users:', error);
      setUsersError(error instanceof Error ? error.message : String(error));
    }
  };

  const fetchConfigs = async () => {
    setConfigsError(null);
    try {
      const response = await fetch(`${API_URL}/admin/config`);
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to load configuration');
      setConfigs(data.data || []);
    } catch (error) {
      setConfigsError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (activeTab === 'config') fetchConfigs();
  }, [activeTab]);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(formData)
      });
      
      if (response.ok) {
        setShowAddUser(false);
        setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
        fetchUsers();
      }
    } catch (error) {
      const newUser: UserData = {
        id: Date.now().toString(),
        ...formData,
        createdAt: new Date().toISOString().split('T')[0]
      };
      setUsers([...users, newUser]);
      setShowAddUser(false);
      setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    
    setLoading(true);
    try {
      const response = await apiFetch(`${API_URL}/admin/users/${editingUser.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(formData)
      });
      
      if (response.ok) {
        setEditingUser(null);
        setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
        fetchUsers();
      }
    } catch (error) {
      setUsers(users.map(u => u.id === editingUser.id ? { ...u, ...formData } : u));
      setEditingUser(null);
      setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    
    try {
      await apiFetch(`${API_URL}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      fetchUsers();
    } catch (error) {
      setUsers(users.filter(u => u.id !== userId));
    }
  };

  const openEditModal = (user: UserData) => {
    setEditingUser(user);
    setFormData({
      name: user.name,
      email: user.email,
      password: '',
      role: user.role,
      status: user.status
    });
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Non-admin view
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-xl border border-gray-200 p-8 md:p-12 text-center shadow-sm max-w-md w-full">
          <Shield className="w-12 h-12 md:w-16 md:h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg md:text-xl font-semibold text-gray-900">Admin Access Required</h2>
          <p className="text-gray-500 mt-2 text-sm">Only administrators can access system settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">System Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Users, stored configuration and server details</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 overflow-x-auto scrollbar-hide">
        <nav className="flex gap-6 -mb-px">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 pb-3 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {/* User Management Tab */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            {/* Search and Add */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button 
                onClick={() => setShowAddUser(true)} 
                size="md"
                leftIcon={<UserPlus className="h-3.5 w-3.5" />}
                className="whitespace-nowrap"
              >
                Add User
              </Button>
            </div>

            {/* Users Table */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider">User</th>
                      <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">Role</th>
                      <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="px-3 py-2 text-right text-[12px] font-medium text-gray-500 uppercase tracking-wider"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-7 w-7 rounded-md bg-blue-100 flex items-center justify-center">
                              <span className="text-blue-600 font-medium text-xs">
                                {user.name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => Array.from(n)[0]).join('').toUpperCase()}
                              </span>
                            </div>
                            <div className="ml-2 min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">{user.name}</div>
                              <div className="text-xs text-gray-500 truncate">{user.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap hidden sm:table-cell">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[12px] font-medium ${
                            user.role === 'admin' 
                              ? 'bg-blue-50 text-blue-700' 
                              : 'bg-gray-100 text-gray-700'
                          }`}>
                            {user.role === 'admin' ? 'Admin' : 'User'}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium ${
                            user.status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${user.status === 'active' ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span>{user.status === 'active' ? 'Active' : 'Inactive'}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right">
                          <button
                            onClick={() => openEditModal(user)}
                            className="text-gray-400 hover:text-blue-600 hover:bg-blue-50 p-1.5 rounded transition-colors mr-0.5"
                            title="Edit"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(user.id)}
                            className="text-gray-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {usersError ? (
                <div className="text-center py-8 px-4">
                  <p className="text-sm text-red-700 mb-3">Couldn't load users: {usersError}</p>
                  <button
                    onClick={fetchUsers}
                    className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                  </button>
                </div>
              ) : filteredUsers.length === 0 && (
                <div className="text-center py-8">
                  <Users className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500 text-sm">No users found</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'groups' && <GroupsPanel />}
        {activeTab === 'tenants' && <TenantsPanel />}

        {/* Configuration Tab — the system_configs table, read-only */}
        {activeTab === 'config' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search keys..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Settings stored in the database (system_configs). Read-only here.
              </p>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
              {configsError ? (
                <div className="text-center py-8 px-4">
                  <p className="text-sm text-red-700 mb-3">Couldn't load configuration: {configsError}</p>
                  <button
                    onClick={fetchConfigs}
                    className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                  </button>
                </div>
              ) : !configs ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading configuration…
                </div>
              ) : (() => {
                const shown = configs.filter(c => !searchQuery || c.key.toLowerCase().includes(searchQuery.toLowerCase()));
                if (shown.length === 0) {
                  return (
                    <div className="text-center py-8">
                      <Variable className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500 text-sm">{configs.length === 0 ? 'No configuration stored yet' : 'No keys match your search'}</p>
                    </div>
                  );
                }
                return (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider">Key</th>
                          <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider">Value</th>
                          <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">Category</th>
                          <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell">Updated</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {shown.map((c) => (
                          <tr key={c.key} className="hover:bg-gray-50 transition-colors">
                            <td className="px-3 py-2 align-top">
                              <div className="font-mono text-sm font-medium text-gray-900">{c.key}</div>
                              {c.description && <div className="text-xs text-gray-500 mt-0.5">{c.description}</div>}
                            </td>
                            <td className="px-3 py-2 align-top max-w-md">
                              {c.isSecret ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[12px] font-medium bg-amber-100 text-amber-700 border border-amber-200">
                                  Secret
                                </span>
                              ) : (
                                <span className="font-mono text-sm text-gray-600 break-all line-clamp-2" title={c.value}>{c.value}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 align-top whitespace-nowrap text-sm text-gray-600 hidden sm:table-cell">{c.category}</td>
                            <td className="px-3 py-2 align-top whitespace-nowrap text-sm text-gray-500 hidden md:table-cell">
                              {new Date(c.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                            </td>
                            <td className="px-3 py-2 align-top whitespace-nowrap text-right">
                              {!c.isSecret && (
                                <button
                                  onClick={() => copyToClipboard(c.value, c.key)}
                                  className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 p-1.5 rounded transition-colors"
                                  title="Copy value"
                                >
                                  {copiedKey === c.key ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* System Information Tab */}
        {activeTab === 'system' && !systemInfo && (
          <div>
            {systemInfoError ? (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
                <p className="font-medium mb-1">Couldn't load system info</p>
                <p>{systemInfoError}</p>
                <button
                  onClick={fetchSystemInfo}
                  className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 text-[13px] bg-white border border-red-200 rounded-lg hover:bg-red-100"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading system info…
              </div>
            )}
          </div>
        )}
        {activeTab === 'system' && systemInfo && (
          <div className="space-y-4">
            <div className="flex items-center justify-end gap-3 text-xs text-gray-500">
              {systemInfoError && <span className="text-red-600">Refresh failed: {systemInfoError}</span>}
              <button
                onClick={fetchSystemInfo}
                disabled={systemInfoLoading}
                className="inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${systemInfoLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
            {/* Database */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-gray-100 rounded-lg">
                  <Database className="w-5 h-5 text-gray-600" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">Database</h3>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${systemInfo.database.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                      <span className={`text-xs font-medium ${systemInfo.database.status === 'connected' ? 'text-green-700' : 'text-red-700'}`}>
                        {systemInfo.database.status === 'connected'
                          ? `Connected${systemInfo.database.latencyMs !== null ? ` · ${systemInfo.database.latencyMs} ms` : ''}`
                          : 'Disconnected'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Provider</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.database.provider ?? '—'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Host</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.database.host ?? '—'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Port</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.database.port ?? '—'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Database</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.database.name ?? '—'}</p>
                </div>
              </div>
            </div>

            {/* Application */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-gray-100 rounded-lg">
                  <Settings className="w-5 h-5 text-gray-600" />
                </div>
                <h3 className="text-sm font-semibold text-gray-900">Application</h3>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Version</p>
                  <p className="text-sm font-medium text-gray-900">{__APP_VERSION__}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Environment</p>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[12px] font-medium ${
                    systemInfo.application.environment === 'production'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {systemInfo.application.environment}
                  </span>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Base Path</p>
                  <p className="text-sm font-medium text-gray-900 font-mono">{systemInfo.application.basePath}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Node.js</p>
                  <p className="text-sm font-medium text-gray-900 font-mono">{systemInfo.application.nodeVersion}</p>
                </div>
              </div>
            </div>

            {/* Server */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-gray-100 rounded-lg">
                  <Server className="w-5 h-5 text-gray-600" />
                </div>
                <h3 className="text-sm font-semibold text-gray-900">Server</h3>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Host</p>
                  <p className="text-sm font-medium text-gray-900 font-mono truncate" title={systemInfo.server.hostname}>{systemInfo.server.hostname}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Platform</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.server.platform}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Uptime</p>
                  <p className="text-sm font-medium text-gray-900">{formatUptime(systemInfo.server.uptimeSeconds)}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-[12px] text-gray-500 mb-0.5">Timezone</p>
                  <p className="text-sm font-medium text-gray-900">{systemInfo.server.timezone}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add/Edit User Modal */}
      {(showAddUser || editingUser) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-4 md:p-5 w-full max-w-sm shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900">
                {editingUser ? 'Edit User' : 'Add User'}
              </h3>
              <button
                onClick={() => {
                  setShowAddUser(false);
                  setEditingUser(null);
                  setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
                }}
                className="text-gray-400 hover:text-gray-600 p-1 hover:bg-gray-100 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={editingUser ? handleUpdateUser : handleAddUser} className="space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-1">Full Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-1">
                  Password {editingUser && '(leave blank)'}
                </label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  {...(!editingUser && { required: true })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-1">Role</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })}
                    className="w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as 'active' | 'inactive' })}
                    className="w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShowAddUser(false);
                    setEditingUser(null);
                    setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" isLoading={loading}>
                  {editingUser ? 'Update' : 'Add'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
