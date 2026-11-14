import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, Key, BarChart2, Play, Pencil, Trash2, Plus,
  Eye, EyeOff, Copy, Check, X, RefreshCw,
  AlertCircle, Loader2, Search, Table2,
  ChevronRight, ChevronDown, Save,
  Settings, Filter, GripVertical, LayoutGrid,
  ArrowRight, ArrowLeft, ArrowRightLeft, FileSpreadsheet
} from 'lucide-react';
import { API_URL, apiFetch } from '../config/api';
import { useCurrentUser, isAdminUser } from '../lib/currentUser';
import { AdminOnlyNotice } from '../components/access/AdminOnly';

// ─── Auth helper ──────────────────────────────────────────────────────────────

function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem('token');
  const headers = new Headers(options?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return apiFetch(url, { ...options, headers });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectionType = 'postgresql' | 'mysql' | 'oracle';
type ConnectionStatus = 'Connected' | 'Disconnected' | 'Error';
type Permission = 'read' | 'write' | 'admin';
type ActiveTab = 'connections' | 'apikeys' | 'datasets' | 'sql-editor' | 'folders';

interface WbConnectionConfig {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

interface WbConnection {
  id: string;
  name: string;
  type: ConnectionType;
  status: ConnectionStatus;
  config: WbConnectionConfig;
  createdAt: string;
}

interface WbApiKey {
  id: string;
  name: string;
  key: string;
  permissions: Permission;
  isActive: boolean;
  expiresAt?: string;
  createdAt: string;
}

interface WbDataset {
  id: string;
  name: string;
  connectionId: string;
  connectionName?: string;
  tableName: string;
  description?: string;
  createdAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  oracle: 'Oracle',
};

const CONNECTION_TYPE_COLORS: Record<ConnectionType, string> = {
  postgresql: 'bg-blue-100 text-blue-700',
  mysql: 'bg-orange-100 text-orange-700',
  oracle: 'bg-red-100 text-red-700',
};

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  Connected: 'bg-green-100 text-green-700',
  Disconnected: 'bg-gray-100 text-gray-600',
  Error: 'bg-red-100 text-red-700',
};

const PERMISSION_COLORS: Record<Permission, string> = {
  read: 'bg-blue-100 text-blue-700',
  write: 'bg-amber-100 text-amber-700',
  admin: 'bg-red-100 text-red-700',
};

const DEFAULT_PORTS: Record<ConnectionType, string> = {
  postgresql: '5432',
  mysql: '3306',
  oracle: '1521',
};

// ─── Modal wrapper ────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <p className="text-gray-800 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="inline-flex items-center justify-center px-3 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
            Cancel
          </button>
          <button onClick={onConfirm} className="inline-flex items-center justify-center px-3 h-9 text-[14px] rounded-lg whitespace-nowrap bg-red-600 text-white hover:bg-red-700">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Section: Connections ─────────────────────────────────────────────────────

function ConnectionsSection() {
  const [connections, setConnections] = useState<WbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<WbConnection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WbConnection | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [form, setForm] = useState<{
    name: string;
    type: ConnectionType;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    ssl: boolean;
  }>({
    name: '', type: 'postgresql', host: '', port: '5432',
    database: '', username: '', password: '', ssl: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/connections`);
      const json = await res.json();
      if (json.success) setConnections(json.data?.connections ?? json.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditTarget(null);
    setForm({ name: '', type: 'postgresql', host: '', port: '5432', database: '', username: '', password: '', ssl: false });
    setError('');
    setShowModal(true);
  }

  function openEdit(c: WbConnection) {
    setEditTarget(c);
    setForm({
      name: c.name, type: c.type,
      host: c.config.host, port: c.config.port,
      database: c.config.database, username: c.config.username,
      password: c.config.password, ssl: c.config.ssl,
    });
    setError('');
    setShowModal(true);
  }

  async function handleSubmit() {
    if (!form.name || !form.host || !form.database || !form.username) {
      setError('Please fill in all required fields.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const body = {
        name: form.name, type: form.type,
        config: { host: form.host, port: form.port, database: form.database, username: form.username, password: form.password, ssl: form.ssl },
      };
      const url = editTarget
        ? `${API_URL}/analytics-workbench/connections/${editTarget.id}`
        : `${API_URL}/analytics-workbench/connections`;
      const res = await authFetch(url, {
        method: editTarget ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setShowModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(c: WbConnection) {
    const res = await authFetch(`${API_URL}/analytics-workbench/connections/${c.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { setDeleteTarget(null); load(); }
  }

  async function handleTest(c: WbConnection) {
    setTestingId(c.id);
    setTestResults(prev => ({ ...prev, [c.id]: { ok: false, msg: '' } }));
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/connections/${c.id}/test`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        const d = json.data;
        setTestResults(prev => ({ ...prev, [c.id]: { ok: true, msg: `${d?.count ?? d?.tables?.length ?? 0} tables found` } }));
      } else {
        setTestResults(prev => ({ ...prev, [c.id]: { ok: false, msg: json.error || 'Test failed' } }));
      }
    } catch {
      setTestResults(prev => ({ ...prev, [c.id]: { ok: false, msg: 'Connection error' } }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Connections</h2>
          <p className="text-sm text-gray-500 mt-0.5">Manage database connections for analytics</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-3 h-9 text-[14px] font-medium rounded-lg whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
          <Plus size={16} /> New Connection
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-blue-500" size={28} />
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <Database size={40} className="mb-3 opacity-50" />
          <p className="text-sm">No connections yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map(c => (
            <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Database size={18} className="text-blue-500 shrink-0" />
                  <div>
                    <span className="font-medium text-gray-900">{c.name}</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONNECTION_TYPE_COLORS[c.type]}`}>
                        {CONNECTION_TYPE_LABELS[c.type]}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[c.status]}`}>
                        {c.status}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {testResults[c.id] && (
                    <span className={`text-xs px-2 py-1 rounded-lg ${testResults[c.id].ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {testResults[c.id].ok ? <Check size={12} className="inline mr-1" /> : <AlertCircle size={12} className="inline mr-1" />}
                      {testResults[c.id].msg}
                    </span>
                  )}
                  <button
                    onClick={() => handleTest(c)}
                    disabled={testingId === c.id}
                    title="Test connection"
                    className="p-2 rounded-lg text-gray-500 hover:text-green-600 hover:bg-green-50 disabled:opacity-50"
                  >
                    {testingId === c.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  </button>
                  <button onClick={() => openEdit(c)} title="Edit" className="p-2 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-blue-50">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => setDeleteTarget(c)} title="Delete" className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-2 ml-7">
                {c.config.username}@{c.config.host}:{c.config.port}/{c.config.database}
              </p>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editTarget ? 'Edit Connection' : 'New Connection'} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My Production DB"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.type}
                onChange={e => {
                  const t = e.target.value as ConnectionType;
                  setForm(f => ({ ...f, type: t, port: DEFAULT_PORTS[t] }));
                }}
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="oracle">Oracle</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Host <span className="text-red-500">*</span></label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.host}
                  onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                  placeholder="localhost"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.port}
                  onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Database <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.database}
                onChange={e => setForm(f => ({ ...f, database: e.target.value }))}
                placeholder="mydb"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-blue-600"
                checked={form.ssl}
                onChange={e => setForm(f => ({ ...f, ssl: e.target.checked }))}
              />
              <span className="text-sm text-gray-700">Enable SSL</span>
            </label>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {editTarget ? 'Save Changes' : 'Create'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete connection "${deleteTarget.name}"? This action cannot be undone.`}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Section: API Keys ────────────────────────────────────────────────────────

function ApiKeysSection() {
  const [keys, setKeys] = useState<WbApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WbApiKey | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', permissions: 'read' as Permission, expiresAt: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/api-keys`);
      const json = await res.json();
      if (json.success) setKeys(json.data?.apiKeys ?? json.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!form.name) { setError('Name is required.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const body: { name: string; permissions: Permission; expiresAt?: string } = {
        name: form.name, permissions: form.permissions,
      };
      if (form.expiresAt) body.expiresAt = form.expiresAt;
      const res = await authFetch(`${API_URL}/analytics-workbench/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setNewKey(json.data?.key ?? null);
      setShowModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(k: WbApiKey) {
    const res = await authFetch(`${API_URL}/analytics-workbench/api-keys/${k.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !k.isActive }),
    });
    const json = await res.json();
    if (json.success) load();
  }

  async function handleDelete(k: WbApiKey) {
    const res = await authFetch(`${API_URL}/analytics-workbench/api-keys/${k.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { setDeleteTarget(null); load(); }
  }

  function maskKey(key: string) {
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  }

  function copyKey(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">API Keys</h2>
          <p className="text-sm text-gray-500 mt-0.5">Manage access tokens for the Analytics Workbench API</p>
        </div>
        <button
          onClick={() => { setForm({ name: '', permissions: 'read', expiresAt: '' }); setError(''); setShowModal(true); }}
          className="flex items-center gap-2 px-3.5 h-9 bg-blue-600 text-white text-[14px] font-medium rounded-lg hover:bg-blue-700 whitespace-nowrap"
        >
          <Plus size={16} /> New API Key
        </button>
      </div>

      {newKey && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-xl">
          <p className="text-sm font-medium text-green-800 mb-2">API key created. Copy it now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white border border-green-200 rounded px-3 py-2 text-green-900 truncate">{newKey}</code>
            <button onClick={() => copyKey(newKey)} className="p-2 rounded-lg bg-green-600 text-white hover:bg-green-700">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button onClick={() => setNewKey(null)} className="p-2 rounded-lg text-green-700 hover:bg-green-100">
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-blue-500" size={28} />
        </div>
      ) : keys.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <Key size={40} className="mb-3 opacity-50" />
          <p className="text-sm">No API keys yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map(k => (
            <div key={k.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900">{k.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PERMISSION_COLORS[k.permissions]}`}>
                      {k.permissions}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${k.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {k.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <code className="text-xs font-mono text-gray-500 bg-gray-50 px-2 py-1 rounded">
                      {revealed[k.id] ? k.key : maskKey(k.key)}
                    </code>
                    <button onClick={() => setRevealed(r => ({ ...r, [k.id]: !r[k.id] }))} className="text-gray-400 hover:text-gray-600">
                      {revealed[k.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    {revealed[k.id] && (
                      <button onClick={() => copyKey(k.key)} className="text-gray-400 hover:text-blue-600">
                        <Copy size={14} />
                      </button>
                    )}
                  </div>
                  {k.expiresAt && (
                    <p className="text-xs text-gray-400 mt-1">Expires: {new Date(k.expiresAt).toLocaleDateString()}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleToggle(k)}
                    title={k.isActive ? 'Deactivate' : 'Activate'}
                    className={`p-2 rounded-lg text-sm ${k.isActive ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-50'}`}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button onClick={() => setDeleteTarget(k)} className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title="New API Key" onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My application key"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
              <div className="space-y-2">
                {(['read', 'write', 'admin'] as Permission[]).map(p => (
                  <label key={p} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="permissions"
                      value={p}
                      checked={form.permissions === p}
                      onChange={() => setForm(f => ({ ...f, permissions: p }))}
                      className="accent-blue-600"
                    />
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PERMISSION_COLORS[p]}`}>{p}</span>
                    <span className="text-sm text-gray-600">
                      {p === 'read' ? 'Read-only access to datasets' : p === 'write' ? 'Read and write access' : 'Full admin access'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expires At (optional)</label>
              <input
                type="date"
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.expiresAt}
                onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={submitting}
                className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Create Key
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete API key "${deleteTarget.name}"? This cannot be undone.`}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Section: Datasets ────────────────────────────────────────────────────────

function DatasetsSection() {
  const [datasets, setDatasets] = useState<WbDataset[]>([]);
  const [connections, setConnections] = useState<WbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WbDataset | null>(null);

  // Form
  const [selConnId, setSelConnId] = useState('');
  const [tableList, setTableList] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTable, setSelectedTable] = useState('');
  const [dsName, setDsName] = useState('');
  const [dsDesc, setDsDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dsRes, connRes] = await Promise.all([
        authFetch(`${API_URL}/analytics-workbench/datasets`),
        authFetch(`${API_URL}/analytics-workbench/connections`),
      ]);
      const dsJson = await dsRes.json();
      const connJson = await connRes.json();
      if (dsJson.success) setDatasets(dsJson.data?.datasets ?? dsJson.data ?? []);
      if (connJson.success) setConnections(connJson.data?.connections ?? connJson.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function browseTables() {
    if (!selConnId) return;
    setLoadingTables(true);
    setTableList([]);
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/connections/${selConnId}/tables?search=${encodeURIComponent(tableSearch)}`);
      const json = await res.json();
      if (json.success) setTableList(json.data?.tables ?? json.data ?? []);
    } finally {
      setLoadingTables(false);
    }
  }

  function selectTable(t: string) {
    setSelectedTable(t);
    if (!dsName) setDsName(t);
  }

  async function handleSubmit() {
    if (!selConnId || !selectedTable || !dsName) {
      setError('Please select a connection, table, and enter a name.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: selConnId, tableName: selectedTable, name: dsName, description: dsDesc }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setShowModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(d: WbDataset) {
    const res = await authFetch(`${API_URL}/analytics-workbench/datasets/${d.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { setDeleteTarget(null); load(); }
  }

  function openModal() {
    setSelConnId(''); setTableList([]); setTableSearch('');
    setSelectedTable(''); setDsName(''); setDsDesc(''); setError('');
    setShowModal(true);
  }

  const filteredTables = tableList.filter(t => t.toLowerCase().includes(tableSearch.toLowerCase()));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Datasets</h2>
          <p className="text-sm text-gray-500 mt-0.5">Register tables from connected databases as datasets</p>
        </div>
        <button onClick={openModal} className="flex items-center gap-2 px-3 h-9 text-[14px] font-medium rounded-lg whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
          <Plus size={16} /> Add Dataset
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-blue-500" size={28} />
        </div>
      ) : datasets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <BarChart2 size={40} className="mb-3 opacity-50" />
          <p className="text-sm">No datasets yet. Add one from a connection.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {datasets.map(d => (
            <div key={d.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Table2 size={18} className="text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-gray-900">{d.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Table: <span className="font-mono text-gray-700">{d.tableName}</span>
                  </p>
                  {d.connectionName && (
                    <p className="text-xs text-gray-400 mt-0.5">Connection: {d.connectionName}</p>
                  )}
                  {d.description && (
                    <p className="text-xs text-gray-400 mt-0.5">{d.description}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">Added {new Date(d.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
              <button onClick={() => setDeleteTarget(d)} className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 shrink-0">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title="Add Dataset" onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Connection <span className="text-red-500">*</span></label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={selConnId}
                onChange={e => { setSelConnId(e.target.value); setTableList([]); setSelectedTable(''); }}
              >
                <option value="">Select a connection…</option>
                {connections.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({CONNECTION_TYPE_LABELS[c.type]})</option>
                ))}
              </select>
            </div>

            {selConnId && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="relative flex-1">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      className="w-full border border-gray-300 rounded-lg pl-8 pr-3 h-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Search tables…"
                      value={tableSearch}
                      onChange={e => setTableSearch(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={browseTables}
                    disabled={loadingTables}
                    className="flex items-center gap-1.5 px-3 h-9 text-[14px] rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 whitespace-nowrap"
                  >
                    {loadingTables ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Browse
                  </button>
                </div>
                {tableList.length > 0 && (
                  <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                    {filteredTables.map(t => (
                      <button
                        key={t}
                        onClick={() => selectTable(t)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${selectedTable === t ? 'bg-blue-100 text-blue-800 font-medium' : 'text-gray-700'}`}
                      >
                        {t}
                      </button>
                    ))}
                    {filteredTables.length === 0 && (
                      <p className="text-xs text-gray-400 px-3 py-2">No tables match.</p>
                    )}
                  </div>
                )}
                {selectedTable && (
                  <p className="text-xs text-blue-600 mt-1">Selected: <span className="font-mono">{selectedTable}</span></p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Dataset Name <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={dsName}
                onChange={e => setDsName(e.target.value)}
                placeholder="My Dataset"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                rows={2}
                value={dsDesc}
                onChange={e => setDsDesc(e.target.value)}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Add Dataset
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete dataset "${deleteTarget.name}"? This cannot be undone.`}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Types for Builder/Viewer ─────────────────────────────────────────────────

interface ColSchema { name: string; type: string; nullable?: boolean }

interface FieldConfig {
  name: string;
  alias: string;
  visible: boolean;
  order: number;
}

interface FilterConfig {
  id: string;
  field: string;
  op: string;
  value: string;
  logic: 'AND' | 'OR';
}

interface PivotField { name: string; type: string }
interface PivotValueField { name: string; type: string; fn: 'SUM' | 'COUNT' | 'AVG' | 'MAX' | 'MIN' }
interface PivotConfig {
  filters: PivotField[];
  columns: PivotField[];
  rows: PivotField[];
  values: PivotValueField[];
}

interface DataViewFolder { id: string; name: string; parentId: string | null; children?: DataViewFolder[] }
interface DataViewItem {
  id: string;
  name: string;
  description?: string;
  folderId?: string | null;
  datasetId: string;
  viewType: string;
  fields: string;
  filters: string;
  pivot: string;
  sortBy: string;
  folder?: { id: string; name: string } | null;
}

interface ViewerTab {
  id: string;
  viewId: string;
  viewName: string;
  datasetId: string;
  fields: FieldConfig[];
  filters: FilterConfig[];
  pivot: PivotConfig;
  viewType: string;
  rows: Record<string, unknown>[];
  columns: ColSchema[];
  total: number;
  loading: boolean;
}

const FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'];
const AGG_FNS: ('SUM' | 'COUNT' | 'AVG' | 'MAX' | 'MIN')[] = ['SUM', 'COUNT', 'AVG', 'MAX', 'MIN'];

// ─── Settings Modal (wraps existing sections) ─────────────────────────────────

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<ActiveTab>('connections');
  const TABS: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
    { id: 'connections', label: 'Connections', icon: <Database size={13} /> },
    { id: 'datasets', label: 'Datasets', icon: <Table2 size={13} /> },
    { id: 'apikeys', label: 'API Keys', icon: <Key size={13} /> },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-w-[95vw] flex flex-col" style={{ height: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2 font-bold text-gray-800">
            <Settings size={16} className="text-blue-500" /> Settings
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700">
            <X size={16} />
          </button>
        </div>
        {/* Tab bar */}
        <div className="flex border-b px-6 gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'connections' && <ConnectionsSection />}
          {tab === 'datasets' && <DatasetsSection />}
          {tab === 'apikeys' && <ApiKeysSection />}
        </div>
      </div>
    </div>
  );
}

// ─── Left Dataset Panel ───────────────────────────────────────────────────────

function LeftDatasetPanel({
  datasets, selectedDatasetId, onSelectDataset,
  savedViews, onOpenView, onDatasetAdded,
}: {
  datasets: WbDataset[];
  selectedDatasetId: string;
  onSelectDataset: (ds: WbDataset) => void;
  savedViews: DataViewItem[];
  onOpenView: (v: DataViewItem) => void;
  onDatasetAdded?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [viewsOpen, setViewsOpen] = useState(true);
  const filtered = datasets.filter(d => d.name.toLowerCase().includes(search.toLowerCase()));

  // Add Dataset compact modal state
  const [showAdd, setShowAdd] = useState(false);
  const [addConns, setAddConns] = useState<WbConnection[]>([]);
  const [addConnId, setAddConnId] = useState('');
  const [addTables, setAddTables] = useState<string[]>([]);
  const [addTableSearch, setAddTableSearch] = useState('');
  const [addSelTable, setAddSelTable] = useState('');
  const [addName, setAddName] = useState('');
  const [addLoadingTables, setAddLoadingTables] = useState(false);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState('');

  async function openAdd() {
    setAddConnId(''); setAddTables([]); setAddTableSearch('');
    setAddSelTable(''); setAddName(''); setAddError('');
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/connections`);
      const json = await res.json();
      setAddConns(json.data?.connections ?? json.data ?? []);
    } catch {}
    setShowAdd(true);
  }

  async function addBrowseTables(connId: string) {
    if (!connId) return;
    setAddLoadingTables(true);
    setAddTables([]);
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/connections/${connId}/tables?search=${encodeURIComponent(addTableSearch)}`);
      const json = await res.json();
      if (json.success) setAddTables(json.data?.tables ?? json.data ?? []);
    } finally {
      setAddLoadingTables(false);
    }
  }

  async function submitAdd() {
    if (!addConnId || !addSelTable || !addName) { setAddError('Please select connection, table, and name.'); return; }
    setAddSubmitting(true);
    setAddError('');
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: addConnId, tableName: addSelTable, name: addName }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setShowAdd(false);
      onDatasetAdded?.();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search */}
      <div className="p-2 border-b">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search datasets…"
            className="w-full text-xs pl-6 pr-2 py-1.5 border border-gray-200 rounded-md bg-white focus:outline-none focus:border-blue-400" />
        </div>
      </div>

      {/* Add Dataset compact modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-[420px] mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><Plus size={14} className="text-blue-500" /> Add Dataset</span>
              <button onClick={() => setShowAdd(false)} className="p-1 hover:bg-gray-100 rounded text-gray-400"><X size={14} /></button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Connection</label>
                <select
                  className="w-full text-xs border border-gray-200 rounded-lg px-2.5 h-9 bg-gray-50 focus:outline-none focus:border-blue-400"
                  value={addConnId}
                  onChange={e => { setAddConnId(e.target.value); setAddTables([]); setAddSelTable(''); }}
                >
                  <option value="">— select —</option>
                  {addConns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-xs font-medium text-gray-600 flex-1">Table</label>
                  <button
                    onClick={() => addBrowseTables(addConnId)}
                    disabled={!addConnId || addLoadingTables}
                    className="text-[12px] px-2 py-0.5 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 disabled:opacity-40 flex items-center gap-1"
                  >
                    {addLoadingTables ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Browse
                  </button>
                </div>
                <input
                  className="w-full text-xs border border-gray-200 rounded-lg px-2.5 h-9 focus:outline-none focus:border-blue-400 mb-1.5"
                  placeholder="Filter tables…"
                  value={addTableSearch}
                  onChange={e => setAddTableSearch(e.target.value)}
                />
                {addTables.length > 0 && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden max-h-32 overflow-y-auto">
                    {addTables.filter(t => t.toLowerCase().includes(addTableSearch.toLowerCase())).map(t => (
                      <button
                        key={t}
                        onClick={() => { setAddSelTable(t); if (!addName) setAddName(t); }}
                        className={`w-full text-left px-2.5 py-1 text-xs border-b border-gray-50 last:border-b-0 transition-colors ${addSelTable === t ? 'bg-blue-100 text-blue-700 font-medium' : 'hover:bg-gray-50 text-gray-700'}`}
                      >{t}</button>
                    ))}
                  </div>
                )}
                {addSelTable && <p className="text-[12px] text-blue-600 mt-1">Selected: <strong>{addSelTable}</strong></p>}
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Dataset Name</label>
                <input
                  className="w-full text-xs border border-gray-200 rounded-lg px-2.5 h-9 focus:outline-none focus:border-blue-400"
                  placeholder="e.g. Budget 2024"
                  value={addName}
                  onChange={e => setAddName(e.target.value)}
                />
              </div>
              {addError && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle size={11} />{addError}</p>}
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button onClick={() => setShowAdd(false)} className="inline-flex items-center justify-center px-3 h-8 text-[13px] border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 whitespace-nowrap">Cancel</button>
              <button onClick={submitAdd} disabled={addSubmitting} className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
                {addSubmitting && <Loader2 size={11} className="animate-spin" />} Add Dataset
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto text-xs">
        {/* Datasets section */}
        <div className="px-3 pt-2 pb-1 flex items-center justify-between">
          <span className="text-[12px] font-bold text-gray-400 uppercase tracking-wider">Datasets</span>
          <button onClick={openAdd} className="p-0.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Add dataset">
            <Plus size={12} />
          </button>
        </div>
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-gray-400 italic">No datasets yet</div>
        )}
        {filtered.map(ds => (
          <button key={ds.id} onClick={() => onSelectDataset(ds)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md mx-1 mb-0.5 text-left transition-colors ${
              selectedDatasetId === ds.id ? 'bg-blue-100 text-blue-700' : 'text-gray-700 hover:bg-gray-100'
            }`}>
            <Database size={12} className="flex-shrink-0 opacity-60" />
            <span className="truncate">{ds.name}</span>
          </button>
        ))}

        {/* Divider */}
        <div className="mx-2 my-2 border-t border-gray-100" />

        {/* Saved Views */}
        <button onClick={() => setViewsOpen(o => !o)}
          className="w-full flex items-center gap-1 px-3 py-1 text-[12px] font-bold text-gray-400 uppercase tracking-wider hover:text-gray-600">
          {viewsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          Saved Views
        </button>
        {viewsOpen && savedViews.map(v => (
          <button key={v.id} onClick={() => onOpenView(v)}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md mx-1 mb-0.5 text-left text-gray-600 hover:bg-gray-100 transition-colors">
            <Table2 size={12} className="flex-shrink-0 opacity-50" />
            <span className="truncate">{v.name}</span>
          </button>
        ))}
        {viewsOpen && savedViews.length === 0 && (
          <div className="px-3 py-1 text-gray-400 italic">No saved views</div>
        )}
      </div>
    </div>
  );
}

// ─── Fields Tab ───────────────────────────────────────────────────────────────

function FieldsTab({ schema, fields, onChange }: {
  schema: ColSchema[];
  fields: FieldConfig[];
  onChange: (f: FieldConfig[]) => void;
}) {
  const dragIdx = useRef<number | null>(null);

  const selectedNames = new Set(fields.map(f => f.name));
  const available = schema.filter(c => !selectedNames.has(c.name));

  function addField(col: ColSchema) {
    onChange([...fields, { name: col.name, alias: col.name, visible: true, order: fields.length }]);
  }

  function addAll() {
    const newFields = schema.map((c, i) => ({ name: c.name, alias: c.name, visible: true, order: i }));
    onChange(newFields);
  }

  function removeField(name: string) {
    onChange(fields.filter(f => f.name !== name));
  }

  function removeAll() { onChange([]); }

  function onDragStart(idx: number) { dragIdx.current = idx; }
  function onDrop(idx: number) {
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const arr = [...fields];
    const [moved] = arr.splice(dragIdx.current, 1);
    arr.splice(idx, 0, moved);
    onChange(arr.map((f, i) => ({ ...f, order: i })));
    dragIdx.current = null;
  }

  function typeTag(t: string) {
    const n = t.toLowerCase();
    if (n.includes('int') || n.includes('num') || n.includes('float') || n.includes('decimal') || n.includes('double'))
      return <span className="text-[12px] px-1.5 py-0.5 rounded bg-pink-100 text-pink-700 font-bold ml-auto flex-shrink-0">NUM</span>;
    if (n.includes('date') || n.includes('time'))
      return <span className="text-[12px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold ml-auto flex-shrink-0">DATE</span>;
    return <span className="text-[12px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-bold ml-auto flex-shrink-0">TEXT</span>;
  }

  return (
    <div className="flex flex-col h-full p-3 gap-3">
      <p className="text-xs text-gray-500">เลือก columns ที่ต้องการแสดง — ลาก ↕ เพื่อเรียงลำดับ</p>
      <div className="grid grid-cols-[1fr_36px_1fr] gap-2 flex-1 min-h-0">
        {/* Available */}
        <div className="border border-gray-200 rounded-lg overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b">
            <span className="text-xs font-semibold text-gray-600">Available Columns</span>
            <span className="text-[12px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{available.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {available.map(col => (
              <div key={col.name} onClick={() => addField(col)}
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer border-b border-gray-50">
                <span className="truncate flex-1">{col.name}</span>
                {typeTag(col.type)}
              </div>
            ))}
          </div>
        </div>

        {/* Arrow buttons */}
        <div className="flex flex-col items-center justify-center gap-2 pt-8">
          <button onClick={() => available[0] && addField(available[0])} title="Add"
            className="w-7 h-7 flex items-center justify-center border border-gray-200 rounded-md bg-white hover:bg-blue-50 hover:border-blue-300 text-gray-500 hover:text-blue-600 transition-colors">
            <ArrowRight size={13} />
          </button>
          <button onClick={addAll} title="Add all"
            className="w-7 h-7 flex items-center justify-center border border-gray-200 rounded-md bg-white hover:bg-blue-50 hover:border-blue-300 text-gray-500 hover:text-blue-600 transition-colors text-[12px] font-bold">
            »
          </button>
          <button onClick={removeAll} title="Remove all"
            className="w-7 h-7 flex items-center justify-center border border-gray-200 rounded-md bg-white hover:bg-red-50 hover:border-red-300 text-gray-500 hover:text-red-500 transition-colors">
            <ArrowLeft size={13} />
          </button>
        </div>

        {/* Selected */}
        <div className="border border-gray-200 rounded-lg overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b">
            <span className="text-xs font-semibold text-gray-600">Selected Columns</span>
            <span className="text-[12px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{fields.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {fields.map((f, idx) => (
              <div key={f.name}
                draggable onDragStart={() => onDragStart(idx)} onDragOver={e => e.preventDefault()} onDrop={() => onDrop(idx)}
                className="flex items-center gap-2 px-2 py-1.5 text-xs bg-blue-50 hover:bg-blue-100 border-b border-blue-100 cursor-grab group">
                <GripVertical size={12} className="text-gray-300 group-hover:text-gray-500 flex-shrink-0" />
                <span className="truncate flex-1 text-blue-800">{f.name}</span>
                {typeTag(schema.find(c => c.name === f.name)?.type || '')}
                <button onClick={() => removeField(f.name)} className="ml-1 text-gray-300 hover:text-red-500 flex-shrink-0">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Filter Tab ───────────────────────────────────────────────────────────────

function FilterTab({ schema, filters, onChange }: {
  schema: ColSchema[];
  filters: FilterConfig[];
  onChange: (f: FilterConfig[]) => void;
}) {
  function addFilter() {
    onChange([...filters, {
      id: Math.random().toString(36).slice(2),
      field: schema[0]?.name || '',
      op: '=',
      value: '',
      logic: 'AND',
    }]);
  }

  function update(id: string, patch: Partial<FilterConfig>) {
    onChange(filters.map(f => f.id === id ? { ...f, ...patch } : f));
  }

  function remove(id: string) {
    onChange(filters.filter(f => f.id !== id));
  }

  const sqlPreview = filters.map((f, i) => {
    const kw = i === 0 ? 'WHERE' : f.logic;
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${kw} ${f.field} ${f.op}`;
    return `${kw} ${f.field} ${f.op} ${f.value ? `'${f.value}'` : '?'}`;
  }).join('\n  ');

  return (
    <div className="p-4 flex flex-col gap-3 h-full overflow-y-auto">
      <p className="text-xs text-gray-500">กำหนดเงื่อนไขการกรองข้อมูล</p>

      {filters.map((f, i) => (
        <div key={f.id} className="flex items-center gap-2 p-2 bg-white border border-gray-200 rounded-lg">
          {i === 0 ? (
            <span className="text-[12px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700 min-w-[46px] text-center">WHERE</span>
          ) : (
            <select value={f.logic} onChange={e => update(f.id, { logic: e.target.value as 'AND' | 'OR' })}
              className="text-[12px] font-bold px-1 py-0.5 rounded border border-gray-200 bg-green-50 text-green-700 min-w-[46px]">
              <option>AND</option><option>OR</option>
            </select>
          )}
          <select value={f.field} onChange={e => update(f.id, { field: e.target.value })}
            className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-gray-50 min-w-[120px]">
            {schema.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <select value={f.op} onChange={e => update(f.id, { op: e.target.value })}
            className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-gray-50 w-[100px]">
            {FILTER_OPS.map(o => <option key={o}>{o}</option>)}
          </select>
          {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' && (
            <input value={f.value} onChange={e => update(f.id, { value: e.target.value })}
              className="flex-1 text-xs border border-gray-200 rounded-md px-2 py-1 min-w-0"
              placeholder="value…" />
          )}
          <button onClick={() => remove(f.id)} className="text-gray-300 hover:text-red-500 flex-shrink-0">
            <X size={14} />
          </button>
        </div>
      ))}

      <button onClick={addFilter}
        className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 py-1 w-fit">
        <Plus size={13} /> Add Condition
      </button>

      {filters.length > 0 && (
        <pre className="text-[12px] bg-green-50 border border-green-200 rounded-lg p-3 text-green-800 leading-relaxed mt-2 font-mono whitespace-pre-wrap">
          {sqlPreview || '(no conditions)'}
        </pre>
      )}
    </div>
  );
}

// ─── Pivot Tab (Excel-style) ──────────────────────────────────────────────────

type PivotZone = 'filters' | 'columns' | 'rows' | 'values';

function PivotTab({ schema, pivot, onChange, datasetId }: {
  schema: ColSchema[];
  pivot: PivotConfig;
  onChange: (p: PivotConfig) => void;
  datasetId: string;
}) {
  const allAssigned = new Set([
    ...pivot.filters.map(f => f.name),
    ...pivot.columns.map(f => f.name),
    ...pivot.rows.map(f => f.name),
    ...pivot.values.map(f => f.name),
  ]);

  function isNumeric(type: string) {
    const t = type.toLowerCase();
    return t.includes('int') || t.includes('num') || t.includes('float') || t.includes('decimal') || t.includes('double') || t.includes('money');
  }

  function toggleField(col: ColSchema) {
    if (allAssigned.has(col.name)) {
      // Remove from all zones
      onChange({
        filters: pivot.filters.filter(f => f.name !== col.name),
        columns: pivot.columns.filter(f => f.name !== col.name),
        rows: pivot.rows.filter(f => f.name !== col.name),
        values: pivot.values.filter(f => f.name !== col.name),
      });
    } else {
      // Auto-assign: numeric → Values, others → Rows
      if (isNumeric(col.type)) {
        onChange({ ...pivot, values: [...pivot.values, { name: col.name, type: col.type, fn: 'SUM' }] });
      } else {
        onChange({ ...pivot, rows: [...pivot.rows, { name: col.name, type: col.type }] });
      }
    }
  }

  function removeFromZone(zone: PivotZone, name: string) {
    onChange({ ...pivot, [zone]: (pivot[zone] as { name: string }[]).filter(f => f.name !== name) });
  }

  function updateValueFn(name: string, fn: 'SUM' | 'COUNT' | 'AVG' | 'MAX' | 'MIN') {
    onChange({ ...pivot, values: pivot.values.map(v => v.name === name ? { ...v, fn } : v) });
  }

  function ZoneChip({ field, zone, color }: { field: PivotField | PivotValueField; zone: PivotZone; color: string }) {
    const isValue = zone === 'values';
    const vf = field as PivotValueField;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[12px] font-medium border ${color}`}>
        {field.name}
        {isValue && (
          <select value={vf.fn} onChange={e => updateValueFn(field.name, e.target.value as typeof vf.fn)}
            className="text-[12px] font-bold bg-white/60 border-0 rounded px-0.5 cursor-pointer ml-0.5 focus:outline-none">
            {AGG_FNS.map(fn => <option key={fn}>{fn}</option>)}
          </select>
        )}
        <button onClick={() => removeFromZone(zone, field.name)} className="opacity-50 hover:opacity-100">
          <X size={10} />
        </button>
      </span>
    );
  }

  function Zone({ zone, label, color, icon }: { zone: PivotZone; label: string; color: string; icon: React.ReactNode }) {
    const items = pivot[zone] as (PivotField | PivotValueField)[];
    return (
      <div className="border border-gray-200 rounded-lg p-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-gray-500 uppercase tracking-wider">
          {icon} {label}
        </div>
        <div className={`min-h-[40px] border border-dashed rounded-md p-1.5 flex flex-wrap gap-1.5 items-start ${items.length > 0 ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 hover:border-blue-300'}`}>
          {items.map(f => (
            <ZoneChip key={f.name} field={f} zone={zone} color={color} />
          ))}
          {items.length === 0 && <span className="text-[12px] text-gray-300 italic self-center">ลาก field มาวาง หรือคลิก field ด้านซ้าย</span>}
        </div>
      </div>
    );
  }

  // ── Pivot execution state ──
  const [pivotRows, setPivotRows] = useState<Record<string, unknown>[]>([]);
  const [pivotCols, setPivotCols] = useState<{ name: string; type: string }[]>([]);
  const [pivotLoading, setPivotLoading] = useState(false);
  const [pivotError, setPivotError] = useState('');
  const [pivotTotalRows, setPivotTotalRows] = useState(0);

  const canRun = pivot.rows.length > 0 && pivot.values.length > 0 && !!datasetId;

  async function runPivot() {
    if (!canRun) return;
    setPivotLoading(true);
    setPivotError('');
    try {
      const body = {
        rows: pivot.rows.map(f => f.name),
        columns: pivot.columns.map(f => f.name),
        values: pivot.values.map(f => ({ name: f.name, fn: f.fn })),
        filters: pivot.filters.map(f => ({ field: f.name, op: '!=', value: '', logic: 'AND' })),
      };
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets/${datasetId}/pivot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setPivotRows(json.data?.rows ?? []);
        setPivotCols(json.data?.columns ?? []);
        setPivotTotalRows(json.data?.totalRows ?? 0);
      } else {
        setPivotError(json.error || 'Pivot query failed');
      }
    } catch (e: unknown) {
      setPivotError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPivotLoading(false);
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Field list */}
      <div className="w-[180px] flex-shrink-0 border-r border-gray-100 flex flex-col">
        <div className="px-3 py-2 bg-gray-50 border-b text-[12px] font-bold text-gray-500 uppercase tracking-wider">
          Fields
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {schema.map(col => {
            const checked = allAssigned.has(col.name);
            return (
              <button key={col.name} onClick={() => toggleField(col)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${checked ? 'text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
                <div className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300'}`}>
                  {checked && <Check size={9} color="white" strokeWidth={3} />}
                </div>
                <span className="truncate flex-1">{col.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: Zones + results */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="grid grid-cols-2 gap-2 p-3" style={{ flex: '0 0 auto' }}>
          <Zone zone="filters" label="Filters" color="bg-amber-50 text-amber-800 border-amber-200"
            icon={<Filter size={10} />} />
          <Zone zone="columns" label="Columns" color="bg-blue-50 text-blue-800 border-blue-200"
            icon={<LayoutGrid size={10} />} />
          <Zone zone="rows" label="Rows" color="bg-green-50 text-green-800 border-green-200"
            icon={<ArrowRightLeft size={10} className="rotate-90" />} />
          <Zone zone="values" label="Values" color="bg-violet-50 text-violet-800 border-violet-200"
            icon={<BarChart2 size={10} />} />
        </div>

        {/* Run button + hint */}
        <div className="px-3 pb-2 flex items-center gap-2">
          <button
            disabled={!canRun || pivotLoading}
            onClick={runPivot}
            className={`flex items-center gap-1.5 px-3 h-9 text-[14px] font-medium rounded-lg transition-colors ${canRun ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'} whitespace-nowrap`}
          >
            {pivotLoading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Run Pivot
          </button>
          {!canRun && schema.length > 0 && (
            <span className="text-[12px] text-gray-400">
              Assign at least one Row and one Value field
            </span>
          )}
          {pivotTotalRows > 0 && !pivotLoading && (
            <span className="text-[12px] text-gray-500 ml-auto">
              {pivotTotalRows.toLocaleString()} row{pivotTotalRows !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Error */}
        {pivotError && (
          <div className="mx-3 mb-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[12px] text-red-600">
            {pivotError}
          </div>
        )}

        {/* Results table */}
        {pivotCols.length > 0 && (
          <div className="flex-1 overflow-auto mx-3 mb-3 border border-gray-200 rounded-lg">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr>
                  {pivotCols.map(c => (
                    <th key={c.name} className="px-3 py-2 bg-blue-50 text-left font-semibold text-blue-700 border-b border-blue-200 whitespace-nowrap">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pivotRows.map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                    {pivotCols.map(c => (
                      <td key={c.name} className="px-3 py-1.5 border-b border-gray-100 whitespace-nowrap text-gray-700">
                        {row[c.name] != null ? String(row[c.name]) : ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Preview Panel ────────────────────────────────────────────────────────────

function PreviewPanel({ datasetId, fields, filters, loading: extLoading }: {
  datasetId: string;
  fields: FieldConfig[];
  filters: FilterConfig[];
  loading: boolean;
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cols, setCols] = useState<ColSchema[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runPreview = useCallback(async () => {
    if (!datasetId || fields.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const body = {
        fields: fields.map(f => f.name),
        filters: filters.map(f => ({ field: f.field, op: f.op, value: f.value, logic: f.logic })),
        limit: 10,
        offset: 0,
      };
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets/${datasetId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setRows(json.data?.rows ?? []);
        setCols(json.data?.columns ?? []);
      } else {
        setError(json.error || 'Query failed');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [datasetId, fields, filters]);

  useEffect(() => { runPreview(); }, [runPreview]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-white">
        <span className="text-xs font-bold text-gray-600">Preview</span>
        {loading || extLoading ? (
          <Loader2 size={12} className="animate-spin text-blue-500" />
        ) : (
          <span className="flex items-center gap-1 text-[12px] font-bold text-green-600">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" /> Live
          </span>
        )}
      </div>
      {error && <div className="px-3 py-2 text-[12px] text-red-500">{error}</div>}
      <div className="flex-1 overflow-auto">
        {cols.length > 0 ? (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>{cols.map(c => <th key={c.name} className="px-2 py-1.5 bg-gray-50 text-left font-semibold text-gray-500 border-b border-gray-200 whitespace-nowrap">{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  {cols.map(c => <td key={c.name} className="px-2 py-1 border-b border-gray-100 text-gray-700 whitespace-nowrap">{String(r[c.name] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4 text-[12px] text-gray-400 italic">Select fields to preview</div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="flex justify-between px-3 py-1.5 border-t bg-gray-50 text-[12px] text-gray-400">
          <span>{rows.length} rows (preview)</span>
        </div>
      )}
    </div>
  );
}

// ─── Save View Dialog ─────────────────────────────────────────────────────────

function SaveViewDialog({ onClose, onSave, initialName = '', initialFolderId = '' }: {
  onClose: () => void;
  onSave: (name: string, folderId: string, description: string) => Promise<void>;
  initialName?: string;
  initialFolderId?: string;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState(initialFolderId);
  const [folders, setFolders] = useState<DataViewFolder[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    authFetch(`${API_URL}/dataviews/folders`).then(r => r.json()).then(j => {
      if (j.success) setFolders(j.data ?? []);
    });
  }, []);

  async function createFolder() {
    if (!newFolderName.trim()) return;
    const res = await authFetch(`${API_URL}/dataviews/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newFolderName.trim() }),
    });
    const j = await res.json();
    if (j.success) {
      setFolders(prev => [...prev, j.data]);
      setFolderId(j.data.id);
      setNewFolderName('');
      setShowNewFolder(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('View name required'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), folderId, description.trim());
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[400px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2 font-bold text-gray-800">
            <Save size={16} className="text-blue-500" /> Save View
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">View Name *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              placeholder="ชื่อ view…" autoFocus />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Folder</label>
            <div className="flex gap-2">
              <select value={folderId} onChange={e => setFolderId(e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 focus:outline-none focus:border-blue-400">
                <option value="">— No Folder —</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button onClick={() => setShowNewFolder(v => !v)}
                className="inline-flex items-center justify-center px-3 h-8 border border-gray-200 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-50 whitespace-nowrap">
                + New
              </button>
            </div>
            {showNewFolder && (
              <div className="flex gap-2 mt-1.5">
                <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createFolder()}
                  placeholder="ชื่อ folder ใหม่…"
                  className="flex-1 text-xs border border-blue-400 rounded-lg px-2 py-1.5 focus:outline-none" autoFocus />
                <button onClick={createFolder} className="inline-flex items-center justify-center px-3 h-9 text-[14px] rounded-lg font-medium whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">Create</button>
                <button onClick={() => setShowNewFolder(false)} className="inline-flex items-center justify-center px-2 h-8 border border-gray-200 rounded-lg text-[13px] whitespace-nowrap"><X size={14} /></button>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              placeholder="อธิบาย view นี้…" />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="inline-flex items-center justify-center px-3 h-9 border border-gray-200 rounded-lg text-[14px] text-gray-600 hover:bg-gray-50 whitespace-nowrap">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-3 h-9 rounded-lg text-[14px] font-medium disabled:opacity-50 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
            {saving && <Loader2 size={16} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Viewer Mode ──────────────────────────────────────────────────────────────

function ViewerMode({ tabs, activeTabId, onSetActive, onCloseTab, onAddTab, savedViews }: {
  tabs: ViewerTab[];
  activeTabId: string;
  onSetActive: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (view: DataViewItem) => void;
  savedViews: DataViewItem[];
}) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const activeTab = tabs.find(t => t.id === activeTabId);

  async function exportExcel(tab: ViewerTab) {
    if (!tab || tab.rows.length === 0) return;
    try {
      const res = await apiFetch(`${API_URL}/analytics-workbench/export-excel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: tab.columns, rows: tab.rows, sheetName: tab.viewName, fileName: tab.viewName }),
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tab.viewName}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export error:', e);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-end bg-gray-100 border-b border-gray-200 pl-3 gap-0.5 overflow-x-auto">
        {tabs.map(t => (
          <div key={t.id} onClick={() => onSetActive(t.id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium border border-b-0 rounded-t-md cursor-pointer mt-1.5 whitespace-nowrap transition-colors ${
              t.id === activeTabId ? 'bg-white text-blue-700 border-gray-200' : 'bg-gray-200 text-gray-500 border-gray-200 hover:bg-gray-100'
            }`}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.id === activeTabId ? 'bg-blue-500' : 'bg-gray-400'}`} />
            {t.viewName}
            <button onClick={e => { e.stopPropagation(); onCloseTab(t.id); }}
              className="ml-1 text-gray-400 hover:text-gray-700"><X size={11} /></button>
          </div>
        ))}
        <div className="relative ml-1">
          <button onClick={() => setShowAddMenu(v => !v)}
            className="flex items-center gap-1 px-3 h-8 text-[13px] text-gray-400 hover:text-gray-600 mt-1.5 whitespace-nowrap">
            <Plus size={14} /> New Tab
          </button>
          {showAddMenu && (
            <div className="absolute top-full left-0 z-20 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[200px] py-1">
              {savedViews.map(v => (
                <button key={v.id} onClick={() => { onAddTab(v); setShowAddMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 text-left">
                  <Table2 size={12} className="opacity-50" /> {v.name}
                </button>
              ))}
              {savedViews.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">No saved views</div>}
            </div>
          )}
        </div>
      </div>

      {/* Toolbar */}
      {activeTab && (
        <div className="flex items-center gap-2 px-3 h-10 bg-white border-b border-gray-100">
          <button className="flex items-center gap-1.5 text-[14px] px-3 h-9 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 whitespace-nowrap">
            <Filter size={16} /> Filter
          </button>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          {activeTab.loading && <Loader2 size={13} className="animate-spin text-blue-500" />}
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full ml-1">{activeTab.total} rows</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => exportExcel(activeTab)}
              className="flex items-center gap-1.5 text-[13px] px-3 h-8 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium whitespace-nowrap">
              <FileSpreadsheet size={14} /> Export Excel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {activeTab && (
        <div className="flex-1 overflow-auto">
          {activeTab.loading ? (
            <div className="flex items-center justify-center h-32 text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="w-8 bg-gray-50 border-b border-r border-gray-200 text-[12px] text-gray-400 font-normal sticky top-0 z-10" />
                  {activeTab.columns.map(c => (
                    <th key={c.name} className="px-3 py-2 bg-gray-100 text-left text-[12px] font-bold text-gray-500 border-b border-r border-gray-200 sticky top-0 z-10 whitespace-nowrap cursor-pointer hover:bg-gray-200">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeTab.rows.map((r, i) => (
                  <tr key={i} className="hover:bg-blue-50 group">
                    <td className="text-center text-[12px] text-gray-300 bg-gray-50 border-b border-r border-gray-100 w-8">{i + 1}</td>
                    {activeTab.columns.map(c => {
                      const val = r[c.name];
                      const isNum = typeof val === 'number';
                      return (
                        <td key={c.name} className={`px-3 py-1.5 border-b border-r border-gray-100 whitespace-nowrap ${isNum ? 'text-right text-blue-700 tabular-nums' : 'text-gray-700'}`}>
                          {val == null ? '' : String(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Status bar */}
      {activeTab && !activeTab.loading && (
        <div className="flex items-center px-4 h-6 bg-gray-50 border-t border-gray-100 text-[12px] text-gray-400">
          <span>{activeTab.total} rows · {activeTab.columns.length} columns</span>
        </div>
      )}

      {tabs.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          <div className="text-center">
            <Table2 size={32} className="mx-auto mb-3 opacity-30" />
            <p>No tabs open — select a Saved View to open</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/** Analytics Workbench uses global connections and datasets, so it is admin only. */
export default function AnalyticsWorkbench() {
  const user = useCurrentUser();
  if (!isAdminUser(user)) return <AdminOnlyNotice page="Analytics Workbench" />;
  return <WorkbenchAdmin />;
}

function WorkbenchAdmin() {
  const [mode, setMode] = useState<'builder' | 'viewer'>('builder');
  const [showSettings, setShowSettings] = useState(false);
  const [builderTab, setBuilderTab] = useState<'fields' | 'filter' | 'pivot'>('fields');

  // Dataset selection
  const [datasets, setDatasets] = useState<WbDataset[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<WbDataset | null>(null);
  const [schema, setSchema] = useState<ColSchema[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Builder state
  const [fields, setFields] = useState<FieldConfig[]>([]);
  const [filters, setFilters] = useState<FilterConfig[]>([]);
  const [pivot, setPivot] = useState<PivotConfig>({ filters: [], columns: [], rows: [], values: [] });

  // Save view
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [savedViews, setSavedViews] = useState<DataViewItem[]>([]);

  // Viewer
  const [viewerTabs, setViewerTabs] = useState<ViewerTab[]>([]);
  const [activeViewerTabId, setActiveViewerTabId] = useState('');

  // Load datasets
  const loadDatasets = useCallback(async () => {
    const res = await authFetch(`${API_URL}/analytics-workbench/datasets`);
    const json = await res.json();
    if (json.success) setDatasets(json.data?.datasets ?? json.data ?? []);
  }, []);

  // Load saved views
  const loadViews = useCallback(async () => {
    const res = await authFetch(`${API_URL}/dataviews`);
    const json = await res.json();
    if (json.success) setSavedViews(json.data ?? []);
  }, []);

  useEffect(() => { loadDatasets(); loadViews(); }, [loadDatasets, loadViews]);

  // Load schema when dataset changes
  async function selectDataset(ds: WbDataset) {
    setSelectedDataset(ds);
    setSchema([]);
    setFields([]);
    setFilters([]);
    setPivot({ filters: [], columns: [], rows: [], values: [] });
    setSchemaLoading(true);
    try {
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets/${ds.id}/schema`);
      const json = await res.json();
      if (json.success) setSchema(json.data?.columns ?? json.data ?? []);
    } finally {
      setSchemaLoading(false);
    }
  }

  // Open saved view in builder
  function openViewInBuilder(v: DataViewItem) {
    // Find dataset and load
    const ds = datasets.find(d => d.id === v.datasetId);
    if (ds) {
      selectDataset(ds).then(() => {
        try {
          setFields(JSON.parse(v.fields) ?? []);
          setFilters(JSON.parse(v.filters) ?? []);
          setPivot(JSON.parse(v.pivot) ?? { filters: [], columns: [], rows: [], values: [] });
        } catch { /* ignore parse errors */ }
      });
    }
    setBuilderTab(v.viewType === 'pivot' ? 'pivot' : 'fields');
    setMode('builder');
  }

  // Open saved view in viewer
  async function openViewInViewer(v: DataViewItem) {
    const existing = viewerTabs.find(t => t.viewId === v.id);
    if (existing) { setActiveViewerTabId(existing.id); setMode('viewer'); return; }

    const tabId = Math.random().toString(36).slice(2);
    const parsedFields: FieldConfig[] = (() => { try { return JSON.parse(v.fields) ?? []; } catch { return []; } })();
    const parsedFilters: FilterConfig[] = (() => { try { return JSON.parse(v.filters) ?? []; } catch { return []; } })();
    const parsedPivot: PivotConfig = (() => { try { return JSON.parse(v.pivot) ?? { filters: [], columns: [], rows: [], values: [] }; } catch { return { filters: [], columns: [], rows: [], values: [] }; } })();

    const newTab: ViewerTab = {
      id: tabId, viewId: v.id, viewName: v.name, datasetId: v.datasetId,
      fields: parsedFields, filters: parsedFilters, pivot: parsedPivot, viewType: v.viewType,
      rows: [], columns: [], total: 0, loading: true,
    };
    setViewerTabs(prev => [...prev, newTab]);
    setActiveViewerTabId(tabId);
    setMode('viewer');

    // Fetch data
    try {
      const body = {
        fields: parsedFields.map(f => f.name),
        filters: parsedFilters.map(f => ({ field: f.field, op: f.op, value: f.value, logic: f.logic })),
        limit: 500, offset: 0,
      };
      const res = await authFetch(`${API_URL}/analytics-workbench/datasets/${v.datasetId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      setViewerTabs(prev => prev.map(t => t.id === tabId ? {
        ...t, loading: false,
        rows: json.data?.rows ?? [],
        columns: json.data?.columns ?? [],
        total: json.data?.totalCount ?? 0,
      } : t));
    } catch {
      setViewerTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: false } : t));
    }
  }

  // Save view
  async function handleSaveView(name: string, folderId: string, description: string) {
    if (!selectedDataset) throw new Error('No dataset selected');
    await authFetch(`${API_URL}/dataviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, description, folderId: folderId || null,
        datasetId: selectedDataset.id,
        viewType: builderTab === 'pivot' ? 'pivot' : 'flat',
        fields, filters, pivot,
      }),
    });
    loadViews();
  }

  const BUILDER_TABS = [
    { id: 'fields' as const, label: 'Fields', icon: <LayoutGrid size={13} /> },
    { id: 'filter' as const, label: 'Filter', icon: <Filter size={13} /> },
    { id: 'pivot' as const, label: 'Pivot', icon: <BarChart2 size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 overflow-hidden">

      {/* Settings modal */}
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); loadDatasets(); }} />}
      {showSaveDialog && (
        <SaveViewDialog onClose={() => setShowSaveDialog(false)} onSave={handleSaveView} />
      )}

      {/* Top bar */}
      <div className="h-11 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-gray-500" />
          <span className="font-bold text-sm text-gray-800">Analytics Workbench</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode switch */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['builder', 'viewer'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`inline-flex items-center justify-center px-3 h-8 text-[13px] font-medium rounded-lg transition-all capitalize ${
                  mode === m ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                } whitespace-nowrap`}>{m}</button>
            ))}
          </div>
          <button onClick={() => setShowSettings(true)}
            className="p-1.5 border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50 hover:text-gray-700">
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <div className="w-48 flex-shrink-0 border-r border-gray-200 bg-white overflow-hidden">
          <LeftDatasetPanel
            datasets={datasets}
            selectedDatasetId={selectedDataset?.id ?? ''}
            onSelectDataset={selectDataset}
            savedViews={savedViews}
            onOpenView={v => mode === 'viewer' ? openViewInViewer(v) : openViewInBuilder(v)}
            onDatasetAdded={() => loadDatasets()}
          />
        </div>

        {/* Main area */}
        {mode === 'builder' ? (
          <div className="flex flex-1 min-w-0 overflow-hidden">
            {/* Builder panel */}
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              {/* Tab bar */}
              <div className="flex border-b border-gray-200 bg-white px-3">
                {BUILDER_TABS.map(t => (
                  <button key={t.id} onClick={() => setBuilderTab(t.id)}
                    className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                      builderTab === t.id ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}>
                    {t.icon}{t.label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-hidden">
                {!selectedDataset ? (
                  <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    <div className="text-center">
                      <Database size={32} className="mx-auto mb-3 opacity-30" />
                      <p>Select a dataset from the left panel</p>
                    </div>
                  </div>
                ) : schemaLoading ? (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <Loader2 size={20} className="animate-spin mr-2" /> Loading schema…
                  </div>
                ) : (
                  <>
                    {builderTab === 'fields' && <FieldsTab schema={schema} fields={fields} onChange={setFields} />}
                    {builderTab === 'filter' && <FilterTab schema={schema} filters={filters} onChange={setFilters} />}
                    {builderTab === 'pivot' && <PivotTab schema={schema} pivot={pivot} onChange={setPivot} datasetId={selectedDataset?.id ?? ''} />}
                  </>
                )}
              </div>

              {/* Save bar */}
              <div className="flex items-center gap-3 px-4 h-12 bg-white border-t border-gray-100 flex-shrink-0">
                <span className="text-xs text-gray-500 truncate max-w-[200px]">
                  {selectedDataset ? selectedDataset.name : 'No dataset selected'}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    disabled={!selectedDataset}
                    onClick={() => setShowSaveDialog(true)}
                    className="flex items-center gap-1.5 px-3 h-8 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                    <Save size={14} /> Save View
                  </button>
                </div>
              </div>
            </div>

            {/* Right preview panel (hidden on small screens — open viewer mode to see results) */}
            <div className="hidden lg:flex w-56 flex-shrink-0 border-l border-gray-200 overflow-hidden flex-col">
              {selectedDataset ? (
                <PreviewPanel
                  datasetId={selectedDataset.id}
                  fields={fields}
                  filters={filters}
                  loading={schemaLoading}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-300 text-xs">No preview</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0 overflow-hidden">
            <ViewerMode
              tabs={viewerTabs}
              activeTabId={activeViewerTabId}
              onSetActive={setActiveViewerTabId}
              onCloseTab={id => {
                setViewerTabs(prev => {
                  const remaining = prev.filter(t => t.id !== id);
                  if (activeViewerTabId === id && remaining.length > 0) setActiveViewerTabId(remaining[remaining.length - 1].id);
                  return remaining;
                });
              }}
              onAddTab={openViewInViewer}
              savedViews={savedViews}
            />
          </div>
        )}
      </div>
    </div>
  );
}
