import { useState, useEffect } from 'react';
import { 
  Building2,
  Users, 
  UserPlus, 
  Shield, 
  Edit2,
  Trash2,
  Settings,
  Database,
  Server,
  RefreshCw,
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
import {
  Tabs, TabList, Tab, Search as CdsSearch, TableContainer, Table, TableHead, TableRow,
  TableHeader, TableBody, TableCell, Tag, IconButton, InlineLoading,
  ComposedModal, ModalHeader, ModalBody, ModalFooter, Stack, TextInput, PasswordInput,
  Select, SelectItem, Button as CdsButton,
} from '@carbon/react';

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
  const closeUserForm = () => {
    setShowAddUser(false);
    setEditingUser(null);
    setFormData({ name: '', email: '', password: '', role: 'user', status: 'active' });
  };

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
      <Tabs
        selectedIndex={Math.max(0, tabs.findIndex(t => t.id === activeTab))}
        onChange={({ selectedIndex }: { selectedIndex: number }) => setActiveTab(tabs[selectedIndex].id as any)}
      >
        <TabList aria-label="Settings sections" contained={false}>
          {tabs.map((tab) => (
            <Tab key={tab.id} renderIcon={tab.icon as any}>{tab.label}</Tab>
          ))}
        </TabList>
      </Tabs>

      <div>
        {/* User Management Tab */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            {/* Search and Add */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
              <CdsSearch
                className="flex-1 max-w-md"
                size="md"
                labelText="Search users"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e: any) => setSearchQuery(e.target.value)}
                onClear={() => setSearchQuery('')}
              />
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
            <div className="overflow-hidden">
              <TableContainer>
                <Table size="md" useZebraStyles={false}>
                  <TableHead>
                    <TableRow>
                      <TableHeader>User</TableHeader>
                      <TableHeader className="hidden sm:table-cell">Role</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader aria-label="Actions" />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredUsers.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-7 w-7 bg-blue-100 flex items-center justify-center">
                              <span className="text-blue-600 font-medium text-xs">
                                {user.name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => Array.from(n)[0]).join('').toUpperCase()}
                              </span>
                            </div>
                            <div className="ml-2 min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">{user.name}</div>
                              <div className="text-xs text-gray-500 truncate">{user.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Tag size="sm" type={user.role === 'admin' ? 'blue' : 'gray'}>{user.role === 'admin' ? 'Admin' : 'User'}</Tag>
                        </TableCell>
                        <TableCell>
                          <Tag size="sm" type={user.status === 'active' ? 'green' : 'red'}>{user.status === 'active' ? 'Active' : 'Inactive'}</Tag>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <IconButton kind="ghost" size="sm" label="Edit" onClick={() => openEditModal(user)}>
                            <Edit2 className="w-4 h-4" />
                          </IconButton>
                          <IconButton kind="ghost" size="sm" label="Delete" onClick={() => handleDeleteUser(user.id)}>
                            <Trash2 className="w-4 h-4" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {usersError ? (
                <div className="text-center py-8 px-4">
                  <p className="text-sm text-red-700 mb-3">Couldn't load users: {usersError}</p>
                  <Button variant="secondary" size="sm" onClick={fetchUsers} leftIcon={<RefreshCw />}>Retry</Button>
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
              <CdsSearch
                className="flex-1 max-w-md"
                size="md"
                labelText="Search keys"
                placeholder="Search keys..."
                value={searchQuery}
                onChange={(e: any) => setSearchQuery(e.target.value)}
                onClear={() => setSearchQuery('')}
              />
              <p className="text-xs text-gray-500">
                Settings stored in the database (system_configs). Read-only here.
              </p>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
              {configsError ? (
                <div className="text-center py-8 px-4">
                  <p className="text-sm text-red-700 mb-3">Couldn't load configuration: {configsError}</p>
                  <Button variant="secondary" size="sm" onClick={fetchConfigs} leftIcon={<RefreshCw />}>Retry</Button>
                </div>
              ) : !configs ? (
                <div className="flex items-center justify-center py-8"><InlineLoading description="Loading configuration…
                " /></div>
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
                  <TableContainer>
                    <Table size="md">
                      <TableHead>
                        <TableRow>
                          <TableHeader>Key</TableHeader>
                          <TableHeader>Value</TableHeader>
                          <TableHeader className="hidden sm:table-cell">Category</TableHeader>
                          <TableHeader className="hidden md:table-cell">Updated</TableHeader>
                          <TableHeader aria-label="Actions" />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {shown.map((c) => (
                          <TableRow key={c.key}>
                            <TableCell className="align-top">
                              <div className="font-mono text-sm font-medium text-gray-900">{c.key}</div>
                              {c.description && <div className="text-xs text-gray-500 mt-0.5">{c.description}</div>}
                            </TableCell>
                            <TableCell className="align-top max-w-md">
                              {c.isSecret ? (
                                <Tag size="sm" type="warm-gray">Secret</Tag>
                              ) : (
                                <span className="font-mono text-sm text-gray-600 break-all line-clamp-2" title={c.value}>{c.value}</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top whitespace-nowrap hidden sm:table-cell">{c.category}</TableCell>
                            <TableCell className="align-top whitespace-nowrap hidden md:table-cell">
                              {new Date(c.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                            </TableCell>
                            <TableCell className="align-top whitespace-nowrap text-right">
                              {!c.isSecret && (
                                <IconButton kind="ghost" size="sm" label={copiedKey === c.key ? 'Copied' : 'Copy value'} onClick={() => copyToClipboard(c.value, c.key)}>
                                  {copiedKey === c.key ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                                </IconButton>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
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
                <Button variant="secondary" size="sm" onClick={fetchSystemInfo} leftIcon={<RefreshCw />}>Retry</Button>
              </div>
            ) : (
              <div className="flex items-center justify-center py-12"><InlineLoading description="Loading system info…
              " /></div>
            )}
          </div>
        )}
        {activeTab === 'system' && systemInfo && (
          <div className="space-y-4">
            <div className="flex items-center justify-end gap-3 text-xs text-gray-500">
              {systemInfoError && <span className="text-red-600">Refresh failed: {systemInfoError}</span>}
              <Button variant="secondary" size="sm" onClick={fetchSystemInfo} isLoading={systemInfoLoading} leftIcon={<RefreshCw />}>Refresh</Button>
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
      <ComposedModal
        size="sm"
        open={showAddUser || !!editingUser}
        onClose={() => { closeUserForm(); return false; }}
      >
        <form onSubmit={editingUser ? handleUpdateUser : handleAddUser}>
          <ModalHeader title={editingUser ? 'Edit User' : 'Add User'} closeModal={closeUserForm} />
          <ModalBody hasForm>
            <Stack gap={5}>
              <TextInput
                id="user-name"
                labelText="Full Name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
              <TextInput
                id="user-email"
                type="email"
                labelText="Email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
              <PasswordInput
                id="user-password"
                labelText={editingUser ? 'Password (leave blank to keep)' : 'Password'}
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                autoComplete="new-password"
                {...(!editingUser && { required: true })}
              />
              <div className="grid grid-cols-2 gap-4">
                <Select
                  id="user-role"
                  labelText="Role"
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })}
                >
                  <SelectItem value="user" text="User" />
                  <SelectItem value="admin" text="Admin" />
                </Select>
                <Select
                  id="user-status"
                  labelText="Status"
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as 'active' | 'inactive' })}
                >
                  <SelectItem value="active" text="Active" />
                  <SelectItem value="inactive" text="Inactive" />
                </Select>
              </div>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <CdsButton kind="secondary" type="button" onClick={closeUserForm}>Cancel</CdsButton>
            <CdsButton kind="primary" type="submit" disabled={loading}>
              {loading ? <InlineLoading description="Saving" /> : (editingUser ? 'Update' : 'Add')}
            </CdsButton>
          </ModalFooter>
        </form>
      </ComposedModal>
    </div>
  );
}
