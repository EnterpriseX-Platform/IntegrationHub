import { useState, useEffect, useCallback, useMemo, useRef, DragEvent } from 'react';
import {
  Database, Key, Play, Pencil, Trash2, Plus,
  Eye, EyeOff, Copy, Check, X, RefreshCw,
  AlertCircle, Loader2, Upload,
  FolderOpen, FolderPlus, ChevronRight, ChevronDown,
  Table2, Download, Settings, Search,
  GripVertical, Columns, Clock, Terminal, Hash, Code, MoreVertical, Eraser, Menu,
  Filter, ListFilter, Star, ChevronLeft, ChevronsLeft, ChevronsRight, Save, Users
} from 'lucide-react';
import { AccessModal } from '../components/access/AccessModal';
import { useCurrentUser, isAdminUser } from '../lib/currentUser';
import * as XLSX from 'xlsx';
import { API_URL, apiFetch } from '../config/api';
import { UPLOAD_B64_CONTENT_TYPE, fileToBase64, uploadB64Url } from '../utils/uploadB64';

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
type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';
type SettingsTab = 'connections' | 'apikeys';

interface RepoConnectionConfig {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

interface RepoConnection {
  id: string;
  name: string;
  type: ConnectionType;
  status: ConnectionStatus;
  config: RepoConnectionConfig;
  createdAt: string;
}

interface RepoApiKey {
  id: string;
  name: string;
  key: string;
  permissions: Permission;
  isActive: boolean;
  expiresAt?: string;
  createdAt: string;
}

interface RepoTable {
  id: string;
  name: string;
  description?: string;
  connectionId?: string;
  connectionName?: string;
  folderId?: string | null;
  rowCount: number;
  sortOrder: number;
  syncStatus: SyncStatus;
  lastSyncAt?: string;
  createdAt: string;
  schema?: string; // JSON-stringified column metadata (used as a fallback for import mapping)
  filterColumns?: string | null; // filter registry — see parseFilterSpecs()
}

interface RepoFolder {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder: number;
  children?: RepoFolder[];
  tables?: { id: string }[];
  createdAt: string;
}

interface ColInfo {
  name: string;
  type: string;
  nullable?: boolean;
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

// ─── Modal ────────────────────────────────────────────────────────────────────

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

// ─── Custom Select ───────────────────────────────────────────────────────────

interface SelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  description?: string;
}

function CustomSelect({
  value, onChange, options, placeholder, label, compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  /** Toolbar height — same 28px as the buttons beside it. */
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [isOpen]);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} className="relative">
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      <button
        type="button"
        onClick={() => setIsOpen(o => !o)}
        className={`w-full flex items-center justify-between bg-white border rounded-lg transition-all ${
          compact ? 'h-8 px-2 text-[13px]' : 'px-3 py-2 text-[13px]'
        } ${
          isOpen
            ? 'border-teal-500 ring-2 ring-teal-100'
            : 'border-gray-300 hover:border-teal-400'
        }`}
      >
        <span className={`flex items-center truncate ${compact ? 'gap-1.5' : 'gap-2'}`}>
          {selected?.icon}
          <span className={selected ? 'text-gray-900' : 'text-gray-400'}>
            {selected?.label ?? placeholder ?? 'Select...'}
          </span>
        </span>
        <ChevronDown size={14} className={`text-gray-400 transition-transform duration-200 flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-[60] w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto py-1">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setIsOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                value === opt.value ? 'bg-teal-50 text-teal-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {opt.icon}
              <div className="flex-1 min-w-0">
                <div className="truncate">{opt.label}</div>
                {opt.description && <div className="text-[10px] text-gray-400">{opt.description}</div>}
              </div>
              {value === opt.value && <Check size={13} className="text-teal-500 flex-shrink-0" />}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-4 text-xs text-gray-400 text-center">No options</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section: Connections ─────────────────────────────────────────────────────

function ConnectionsSection() {
  const [connections, setConnections] = useState<RepoConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<RepoConnection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RepoConnection | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
      const res = await authFetch(`${API_URL}/data-repository/connections`);
      const json = await res.json();
      if (json.success) {
        const raw = json.data?.connections ?? json.data ?? [];
        setConnections(raw.map((c: any) => ({ ...c, config: typeof c.config === 'string' ? JSON.parse(c.config) : c.config })));
      }
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

  function openEdit(c: RepoConnection) {
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
        ? `${API_URL}/data-repository/connections/${editTarget.id}`
        : `${API_URL}/data-repository/connections`;
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

  async function handleDelete(c: RepoConnection) {
    const res = await authFetch(`${API_URL}/data-repository/connections/${c.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { setDeleteTarget(null); load(); }
  }

  async function handleTest(c: RepoConnection) {
    setTestingId(c.id);
    try {
      const res = await authFetch(`${API_URL}/data-repository/connections/${c.id}/test`, { method: 'POST' });
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
          <p className="text-sm text-gray-500 mt-0.5">Manage database connections for data import and sync</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-3 h-9 text-[14px] font-medium rounded-lg whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
          <Plus size={16} /> New Connection
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-teal-500" size={28} />
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <Database size={40} className="mb-3 opacity-50" />
          <p className="text-sm">No connections yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {connections.map(c => (
            <div key={c.id} className="bg-white border border-gray-200 rounded-lg px-3 py-2.5 hover:border-gray-300 transition-colors">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Database size={15} className="text-teal-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 truncate">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-px rounded font-medium leading-tight ${CONNECTION_TYPE_COLORS[c.type]}`}>
                        {CONNECTION_TYPE_LABELS[c.type]}
                      </span>
                      <span className={`text-[10px] px-1.5 py-px rounded font-medium leading-tight ${STATUS_COLORS[c.status]}`}>
                        {c.status}
                      </span>
                      {testResults[c.id] && (
                        <span className={`text-[10px] px-1.5 py-px rounded font-medium leading-tight ${testResults[c.id].ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                          {testResults[c.id].ok ? <Check size={10} className="inline mr-0.5" /> : <AlertCircle size={10} className="inline mr-0.5" />}
                          {testResults[c.id].msg}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 truncate mt-0.5">
                      {c.config.username}@{c.config.host}:{c.config.port}/{c.config.database}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => handleTest(c)}
                    disabled={testingId === c.id}
                    title="Test connection"
                    className="p-1.5 rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 disabled:opacity-50"
                  >
                    {testingId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  </button>
                  <button onClick={() => openEdit(c)} title="Edit" className="p-1.5 rounded-md text-gray-400 hover:text-teal-600 hover:bg-teal-50">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setDeleteTarget(c)} title="Delete" className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
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
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My Database"
              />
            </div>
            <CustomSelect
              label="Type"
              value={form.type}
              onChange={v => {
                const t = v as ConnectionType;
                setForm(f => ({ ...f, type: t, port: DEFAULT_PORTS[t] }));
              }}
              options={[
                { value: 'postgresql', label: 'PostgreSQL', icon: <Database size={14} className="text-blue-500" /> },
                { value: 'mysql', label: 'MySQL', icon: <Database size={14} className="text-orange-500" /> },
                { value: 'oracle', label: 'Oracle', icon: <Database size={14} className="text-red-500" /> },
              ]}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Host <span className="text-red-500">*</span></label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  value={form.host}
                  onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                  placeholder="localhost"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  value={form.port}
                  onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Database <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                value={form.database}
                onChange={e => setForm(f => ({ ...f, database: e.target.value }))}
                placeholder="mydb"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-teal-600"
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
  const [keys, setKeys] = useState<RepoApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RepoApiKey | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', permissions: 'read' as Permission, expiresAt: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/data-repository/api-keys`);
      const json = await res.json();
      if (json.success) setKeys(json.data?.apiKeys ?? json.data?.keys ?? json.data ?? []);
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
      const res = await authFetch(`${API_URL}/data-repository/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      const keyData = json.data?.key;
      setNewKey(typeof keyData === 'object' ? keyData?.key : keyData ?? null);
      setShowModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(k: RepoApiKey) {
    await authFetch(`${API_URL}/data-repository/api-keys/${k.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !k.isActive }),
    });
    load();
  }

  async function handleDelete(k: RepoApiKey) {
    const res = await authFetch(`${API_URL}/data-repository/api-keys/${k.id}`, { method: 'DELETE' });
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
          <p className="text-sm text-gray-500 mt-0.5">Manage access tokens for the Data Repository API</p>
        </div>
        <button
          onClick={() => { setForm({ name: '', permissions: 'read', expiresAt: '' }); setError(''); setShowModal(true); }}
          className="flex items-center gap-2 px-3.5 h-9 bg-teal-600 text-white text-[14px] font-medium rounded-lg hover:bg-teal-700 whitespace-nowrap"
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
          <Loader2 className="animate-spin text-teal-500" size={28} />
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
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${PERMISSION_COLORS[k.permissions]}`}>
                      {k.permissions}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${k.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
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
                      <button onClick={() => copyKey(k.key)} className="text-gray-400 hover:text-teal-600">
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
                    className={`p-2 rounded-lg ${k.isActive ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-50'}`}
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
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My app key"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
              <div className="space-y-2">
                {(['read', 'write', 'admin'] as Permission[]).map(p => (
                  <label key={p} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="repo-permissions"
                      value={p}
                      checked={form.permissions === p}
                      onChange={() => setForm(f => ({ ...f, permissions: p }))}
                      className="accent-teal-600"
                    />
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${PERMISSION_COLORS[p]}`}>{p}</span>
                    <span className="text-sm text-gray-600">
                      {p === 'read' ? 'Read-only access to tables' : p === 'write' ? 'Read and write access' : 'Full admin access'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expires At (optional)</label>
              <input
                type="date"
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
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

interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connectionId?: string | null;
  createdBy?: string | null;
  updatedAt: string;
}

// ─── Folder tree helpers ─────────────────────────────────────────────────────

function buildFolderTree(folders: RepoFolder[]): RepoFolder[] {
  const map: Record<string, RepoFolder> = {};
  folders.forEach(f => { map[f.id] = { ...f, children: [] }; });
  const roots: RepoFolder[] = [];
  folders.forEach(f => {
    if (f.parentId && map[f.parentId]) {
      map[f.parentId].children!.push(map[f.id]);
    } else {
      roots.push(map[f.id]);
    }
  });
  return roots;
}

// ─── Data filters ─────────────────────────────────────────────────────────────
//
// One registry string per table (repo_tables.filter_columns) drives the whole
// filter bar, so adding a filter to a table never needs a code change:
//
//   COLUMN:label:labelSource:optionsFrom:default   (comma-separated entries)
//
//   labelSource  sibling column holding the display name, or a lookup written
//                as SCHEMA.TABLE.CODE.NAME for tables that store codes only
//   optionsFrom  SCHEMA.TABLE.CODE.NAME — read the dropdown from a small
//                registry table instead of scanning the real one.  Add
//                "@PARENT_COL=parentField" to narrow it by another filter:
//                  DEPT:Department::APP.V_DEPT.CODE.NAME@PARENT_CODE=PARENT
//   default      value selected when the screen opens.  Big tables want one —
//                without it the first query runs completely unfiltered.

interface FilterSpec {
  column: string;
  label: string;
  labelSource?: string;
  optionsFrom?: string;
  defaultValue?: string;
  parentColumn?: string;
  parentField?: string;
}

interface FilterOption { value: string; label: string }

function parseFilterSpecs(raw?: string | null): FilterSpec[] {
  if (!raw) return [];
  const out: FilterSpec[] = [];
  for (const entry of String(raw).split(',')) {
    const text = entry.trim();
    if (!text) continue;
    const [column, label, labelSource, optionsFromRaw, defaultValue] = text.split(':').map(p => p.trim());
    if (!column) continue;
    let optionsFrom = optionsFromRaw || undefined;
    let parentColumn: string | undefined;
    let parentField: string | undefined;
    if (optionsFrom && optionsFrom.includes('@')) {
      const [src, clause] = optionsFrom.split('@');
      optionsFrom = src.trim() || undefined;
      const [pc, pf] = (clause || '').split('=');
      parentColumn = (pc || '').trim() || undefined;
      parentField = (pf || '').trim() || undefined;
    }
    out.push({
      column,
      label: label || column,
      labelSource: labelSource || undefined,
      optionsFrom,
      defaultValue: defaultValue || undefined,
      parentColumn,
      parentField,
    });
  }
  return out;
}

function serializeFilterSpecs(specs: FilterSpec[]): string {
  return specs
    .filter(sp => sp.column.trim())
    .map(sp => {
      const optionsFrom = sp.optionsFrom
        ? sp.optionsFrom + (sp.parentColumn && sp.parentField ? `@${sp.parentColumn}=${sp.parentField}` : '')
        : '';
      // Trailing empty fields are noise — drop them.
      const parts = [sp.column.trim(), sp.label?.trim() || '', sp.labelSource?.trim() || '', optionsFrom, sp.defaultValue?.trim() || ''];
      while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
      return parts.join(':');
    })
    .join(',');
}

/** Thai fiscal year — it turns over on 1 October, so October to December
 *  already belong to the next one. */
function thaiFiscalYear(now = new Date()): number {
  return now.getFullYear() + 543 + (now.getMonth() >= 9 ? 1 : 0);
}

/** A default can be written as a fixed value or as a token, so a table can open
 *  on "this fiscal year" without anyone editing the registry every October:
 *    {{fy}}   2569        {{fy2}}  69
 *    {{fy-1}} 2568        {{fy2-1}} 68   (and +1 likewise) */
function resolveDefaultValue(raw: string): string {
  return raw.replace(/\{\{\s*(fy2?)\s*([+-]\s*\d+)?\s*\}\}/gi, (_m, kind: string, offset?: string) => {
    const shift = offset ? parseInt(offset.replace(/\s+/g, ''), 10) : 0;
    const year = thaiFiscalYear() + shift;
    return kind.toLowerCase() === 'fy2' ? String(year).slice(-2) : String(year);
  });
}

/** The state a table opens in — every registry default already applied, so a
 *  big table is never queried unfiltered. */
function defaultFilterState(specs: FilterSpec[]): FilterState {
  const out: FilterState = {};
  for (const sp of specs) {
    if (!sp.defaultValue) continue;
    out[sp.column] = { values: [resolveDefaultValue(sp.defaultValue)], contains: '' };
  }
  return out;
}

/** Writes one column's default back into the registry string. */
function withColumnDefault(raw: string | null | undefined, column: string, defaultValue: string | null): string {
  const specs = parseFilterSpecs(raw);
  const hit = specs.find(sp => sp.column.toUpperCase() === column.toUpperCase());
  if (hit) hit.defaultValue = defaultValue || undefined;
  else if (defaultValue) specs.push({ column, label: column, defaultValue });
  // A registry entry that carries nothing but its own name is not worth keeping.
  return serializeFilterSpecs(specs.filter(sp => sp.defaultValue || sp.labelSource || sp.optionsFrom || (sp.label && sp.label !== sp.column)));
}

/** What one column's Excel-style menu holds: ticked values and/or a substring. */
interface ColFilter { values: string[]; contains: string }

const EMPTY_COL_FILTER: ColFilter = { values: [], contains: '' };

/** Everything filtered on the screen, keyed by column.  The registry panel and
 *  the funnel on the column head both write here, so the two can never end up
 *  asking for different values of the same column. */
type FilterState = Record<string, ColFilter>;

/** → the shape /query, /export and /ext/query expect. */
function toFilterPayload(state: FilterState): { column: string; values: string[]; op?: string }[] {
  const out: { column: string; values: string[]; op?: string }[] = [];
  for (const [column, f] of Object.entries(state)) {
    if (f.values.length > 0) out.push({ column, values: f.values });
    if (f.contains.trim()) out.push({ column, values: [f.contains.trim()], op: 'contains' });
  }
  return out;
}

function colFilterIsSet(f?: ColFilter): boolean {
  return !!f && (f.values.length > 0 || f.contains.trim() !== '');
}

// Searchable single-select for one filter column.  The menu is rendered inline
// (not through a portal) so a click inside it stays inside the filter panel —
// a portalled menu closes the panel on mousedown and the choice never lands.
function FilterSelect({ spec, value, options, loading, error, onChange }: {
  spec: FilterSpec;
  value: string;
  options: FilterOption[];
  loading?: boolean;
  error?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const selected = options.find(o => o.value === value);
  const needle = search.trim().toLowerCase();
  // Match the name as well as the code — needing to know the code already
  // defeats the point of opening the list.
  const matches = needle
    ? options.filter(o => o.value.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle))
    : options;
  const shown = matches.slice(0, 300);

  return (
    <div ref={ref} className="relative min-w-0">
      <label className="block text-[11px] font-medium text-gray-600 mb-1 truncate" title={spec.column}>
        {spec.label}
      </label>
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setSearch(''); }}
        className={`w-full flex items-center justify-between gap-1 px-2.5 py-1.5 bg-white border rounded-lg text-xs transition-all ${
          open ? 'border-teal-500 ring-2 ring-teal-100' : value ? 'border-teal-300' : 'border-gray-300 hover:border-teal-400'
        }`}
      >
        <span className={`truncate ${value ? 'text-gray-900' : 'text-gray-400'}`}>
          {value ? (selected ? (selected.label && selected.label !== selected.value ? `${selected.value} — ${selected.label}` : selected.value) : value) : 'All'}
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          {loading && <Loader2 size={11} className="animate-spin text-gray-300" />}
          {value && (
            <span
              role="button"
              onClick={e => { e.stopPropagation(); onChange(''); }}
              className="p-0.5 text-gray-400 hover:text-red-500"
              title="Clear"
            >
              <X size={11} />
            </span>
          )}
          <ChevronDown size={12} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="absolute z-[70] w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl">
          <div className="p-1.5 border-b border-gray-100">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search code or name…"
                className="w-full pl-6 pr-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-teal-400"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-xs ${value === '' ? 'bg-teal-50 text-teal-700' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              All
            </button>
            {error && <div className="px-3 py-3 text-[11px] text-red-500">{error}</div>}
            {!error && loading && options.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-gray-400 flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Loading options…
              </div>
            )}
            {!error && !loading && options.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-gray-400">No options</div>
            )}
            {shown.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                  value === o.value ? 'bg-teal-50 text-teal-700' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="font-mono text-[11px] text-gray-500 shrink-0">{o.value}</span>
                {o.label && o.label !== o.value && <span className="truncate">{o.label}</span>}
                {value === o.value && <Check size={12} className="text-teal-500 ml-auto shrink-0" />}
              </button>
            ))}
            {matches.length > shown.length && (
              <div className="px-3 py-1.5 text-[10px] text-gray-400 border-t border-gray-100">
                showing {shown.length} of {matches.length} — narrow the search
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Excel-style filter menu on a column head: a funnel that opens a search box
// over a tick list of the column's values.  Ticking values filters by exactly
// those; the search box can also filter by "contains", which is the only thing
// that reaches values beyond the listed ones on a big table.
function ColumnFilterMenu({ column, options, loading, truncated, filter, defaultValue, savingDefault, align, onOpen, onApply, onSetDefault }: {
  column: string;
  options: FilterOption[];
  loading?: boolean;
  truncated?: boolean;
  filter: ColFilter;
  defaultValue?: string;      // what the screen opens with, from the registry
  savingDefault?: boolean;
  align: 'left' | 'right';
  onOpen: () => void;
  onApply: (f: ColFilter) => void;
  onSetDefault: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set(filter.values));
  const ref = useRef<HTMLDivElement>(null);
  const active = filter.values.length > 0 || filter.contains.trim() !== '';
  // A default is one value — that is what the screen can open with.
  const tickedOne = checked.size === 1 && checked.size !== options.length ? [...checked][0] : null;

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Nothing ticked means "everything" — same as Excel showing all boxes ticked.
  useEffect(() => {
    if (open && filter.values.length === 0) setChecked(new Set(options.map(o => o.value)));
  }, [open, options, filter.values.length]);

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? options.filter(o => o.value.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle))
    : options;
  const allShownChecked = shown.length > 0 && shown.every(o => checked.has(o.value));

  function toggle(v: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  }

  function apply() {
    // Everything ticked is not a filter — keep the query clean.
    const values = checked.size === options.length ? [] : [...checked];
    onApply({ values, contains: filter.contains });
    setOpen(false);
  }

  function applyContains(text: string) {
    onApply({ values: [], contains: text });
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => { const next = !open; setOpen(next); setSearch(''); if (next) { setChecked(new Set(filter.values)); onOpen(); } }}
        className={`relative p-1 rounded transition-colors ${
          active ? 'text-teal-600 bg-teal-50 hover:bg-teal-100' : 'text-gray-300 hover:text-gray-600 hover:bg-gray-100'
        }`}
        title={active ? `Filtered on ${column}` : `Filter ${column}`}
      >
        <Filter size={12} fill={active ? 'currentColor' : 'none'} />
        {defaultValue && (
          <span className="absolute -top-0.5 -right-0.5 block w-1.5 h-1.5 rounded-full bg-teal-500 ring-1 ring-white" />
        )}
      </button>

      {open && (
        <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-40 w-[250px] bg-white border border-gray-200 rounded-lg shadow-2xl font-normal`}>
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && search.trim()) applyContains(search.trim()); if (e.key === 'Escape') setOpen(false); }}
                placeholder="Search values…"
                className="w-full pl-6 pr-2 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-teal-400"
              />
            </div>
            {search.trim() && (
              <button
                onClick={() => applyContains(search.trim())}
                className="mt-1.5 w-full text-left text-[11px] px-2 py-1 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 truncate"
                title={`Keep every row whose ${column} contains "${search.trim()}"`}
              >
                Contains “{search.trim()}”
              </button>
            )}
            {filter.contains.trim() && !search.trim() && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-sky-50 text-sky-700">
                <span className="truncate">Contains “{filter.contains}”</span>
                <button onClick={() => onApply({ values: filter.values, contains: '' })} className="ml-auto text-sky-400 hover:text-red-500" title="Remove">
                  <X size={10} />
                </button>
              </div>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {loading && options.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-gray-400 flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Loading values…
              </div>
            ) : options.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-gray-400">No values</div>
            ) : (
              <>
                <label className="flex items-center gap-2 px-3 h-7 text-[11px] text-gray-700 hover:bg-gray-50 cursor-pointer font-medium whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={allShownChecked}
                    onChange={() => setChecked(prev => {
                      const next = new Set(prev);
                      if (allShownChecked) shown.forEach(o => next.delete(o.value));
                      else shown.forEach(o => next.add(o.value));
                      return next;
                    })}
                    className="accent-teal-600"
                  />
                  (Select all{needle ? ' matching' : ''})
                </label>
                {shown.map(o => (
                  <label key={o.value} className="flex items-center gap-2 px-3 h-7 text-[11px] text-gray-700 hover:bg-gray-50 cursor-pointer whitespace-nowrap">
                    <input type="checkbox" checked={checked.has(o.value)} onChange={() => toggle(o.value)} className="accent-teal-600" />
                    <span className="font-mono shrink-0">{o.value}</span>
                    {o.label && o.label !== o.value && <span className="text-gray-400 truncate">{o.label}</span>}
                  </label>
                ))}
                {shown.length === 0 && <div className="px-3 py-3 text-[11px] text-gray-400">Nothing matches</div>}
              </>
            )}
          </div>

          {truncated && (
            <div className="px-3 py-1 text-[10px] text-amber-600 bg-amber-50 border-t border-amber-100">
              First {options.length} values only — use “Contains” to reach the rest.
            </div>
          )}

          {/* Remember one value as what this table opens with.  Big tables need
              this — without it the first query runs unfiltered. */}
          <div className="px-2 py-1.5 border-t border-gray-100 bg-gray-50/60">
            {defaultValue ? (
              <div className="flex items-center gap-1.5 text-[10px] text-teal-700">
                <Star size={10} className="text-teal-500 shrink-0" fill="currentColor" />
                <span className="truncate">เปิดจอมากรอง <span className="font-mono">{defaultValue}</span> ให้เลย</span>
                <button
                  onClick={() => onSetDefault(null)}
                  disabled={savingDefault}
                  className="ml-auto px-1.5 py-0.5 rounded text-gray-500 hover:bg-gray-200/70 disabled:opacity-40 shrink-0"
                >
                  ยกเลิกค่าตั้งต้น
                </button>
              </div>
            ) : (
              <button
                onClick={() => tickedOne && onSetDefault(tickedOne)}
                disabled={!tickedOne || savingDefault}
                className="w-full flex items-center gap-1.5 text-[10px] px-1.5 py-1 rounded text-gray-600 hover:bg-gray-200/70 disabled:opacity-40 disabled:hover:bg-transparent"
                title={tickedOne ? `เปิดจอนี้ครั้งต่อไปให้กรอง ${column} = ${tickedOne} ไว้ก่อน` : 'ติ๊กค่าเดียวก่อน แล้วจึงตั้งเป็นค่าตั้งต้นได้'}
              >
                {savingDefault ? <Loader2 size={10} className="animate-spin" /> : <Star size={10} />}
                <span className="truncate">
                  {tickedOne ? `ตั้ง ${tickedOne} เป็นค่าตั้งต้นของจอนี้` : 'ตั้งเป็นค่าตั้งต้น (ติ๊กค่าเดียว)'}
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-gray-100">
            <button
              onClick={() => { onApply({ values: [], contains: '' }); setOpen(false); }}
              disabled={!active}
              className="text-[11px] px-2 py-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-40"
            >
              Clear
            </button>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setOpen(false)} className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={apply} className="inline-flex items-center justify-center text-[13px] px-3 h-8 rounded whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section: Table Data Viewer ───────────────────────────────────────────────

function TableDataSection({ table, onRegistryChange, reloadKey }: {
  table: RepoTable;
  onRegistryChange: (filterColumns: string) => void;
  /** Bumped by the parent after an import or clear, so the grid re-reads its rows. */
  reloadKey: number;
}) {
  const [columns, setColumns] = useState<ColInfo[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const PAGE_SIZE = 50;

  // ── Filters (driven by the table's registry — see parseFilterSpecs) ────────
  const filterSpecs = useMemo(() => parseFilterSpecs(table.filterColumns), [table.filterColumns]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [options, setOptions] = useState<Record<string, FilterOption[]>>({});
  const [optLoading, setOptLoading] = useState<Record<string, boolean>>({});
  const [optError, setOptError] = useState<Record<string, string>>({});
  const optionsRef = useRef<Record<string, FilterOption[]>>({});
  optionsRef.current = options;
  // Excel-style filter menu on each column head — and the registry panel writes
  // into the same place, keyed by column
  const [colFilters, setColFilters] = useState<FilterState>(() => defaultFilterState(parseFilterSpecs(table.filterColumns)));
  const [savingDefault, setSavingDefault] = useState<string | null>(null);
  const [colValues, setColValues] = useState<Record<string, FilterOption[]>>({});
  const [colValuesLoading, setColValuesLoading] = useState<Record<string, boolean>>({});
  const [colValuesTruncated, setColValuesTruncated] = useState<Record<string, boolean>>({});
  // Current filters, readable from callbacks that were created before the last
  // state update (paging, refresh, export).
  const filtersRef = useRef<FilterState>(colFilters);
  filtersRef.current = colFilters;
  // column → the parent value its option list was loaded for
  const loadedRef = useRef<Record<string, string>>({});

  const loadOptions = useCallback(async (spec: FilterSpec, parentValue: string) => {
    setOptLoading(m => ({ ...m, [spec.column]: true }));
    setOptError(m => ({ ...m, [spec.column]: '' }));
    try {
      const qs = new URLSearchParams({ column: spec.column, limit: '2000' });
      if (spec.parentField && parentValue) qs.set('parentValue', parentValue);
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/distinct?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load options');
      const opts: FilterOption[] = json.data?.options
        ?? (json.data?.values ?? []).map((v: unknown) => ({ value: String(v), label: String(v) }));
      setOptions(m => ({ ...m, [spec.column]: opts }));
    } catch (e: unknown) {
      // A registry pointed at the real table instead of a small lookup will time
      // out here — that is a registry problem, so say so on the field itself.
      setOptError(m => ({ ...m, [spec.column]: e instanceof Error ? e.message : 'Cannot load options' }));
    } finally {
      setOptLoading(m => ({ ...m, [spec.column]: false }));
    }
  }, [table.id]);

  // Values a column's menu lists.  A registry column already holds its whole
  // list (codes + names), so those never hit the server.
  const COL_VALUE_LIMIT = 200;
  const loadColumnValues = useCallback(async (column: string) => {
    if ((optionsRef.current[column] || []).length > 0) return;
    setColValuesLoading(m => ({ ...m, [column]: true }));
    try {
      const qs = new URLSearchParams({ column, q: '', limit: String(COL_VALUE_LIMIT) });
      // Narrow the list by what is already filtered, the way Excel only lists
      // the values still visible.
      const payload = toFilterPayload(filtersRef.current).filter(f => f.column !== column);
      if (payload.length > 0) qs.set('filters', JSON.stringify(payload));
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/suggest?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      const values: string[] = json.data?.values ?? [];
      setColValues(m => ({ ...m, [column]: values.map(v => ({ value: String(v), label: String(v) })) }));
      setColValuesTruncated(m => ({ ...m, [column]: values.length >= COL_VALUE_LIMIT }));
    } catch {
      // A slow or failing lookup must not block the menu — it still offers
      // "Contains", which needs no list at all.
      setColValues(m => ({ ...m, [column]: m[column] ?? [] }));
    } finally {
      setColValuesLoading(m => ({ ...m, [column]: false }));
    }
  }, [table.id]);

  const ensureOptions = useCallback((spec: FilterSpec, vals: FilterState) => {
    const parent = spec.parentField ? vals[spec.parentField] : undefined;
    const parentValue = parent && parent.values.length === 1 ? parent.values[0] : '';
    if (loadedRef.current[spec.column] === parentValue) return;
    loadedRef.current[spec.column] = parentValue;
    loadOptions(spec, parentValue);
  }, [loadOptions]);

  const [editRid, setEditRid] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, any>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const [showAddRow, setShowAddRow] = useState(false);
  const [newValues, setNewValues] = useState<Record<string, any>>({});
  const [savingNew, setSavingNew] = useState(false);
  const [newError, setNewError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<Record<string, any> | null>(null);
  const [menuOpenRid, setMenuOpenRid] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpenRid) return;
    const close = () => setMenuOpenRid(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpenRid]);
  const [deletingRid, setDeletingRid] = useState<string | null>(null);

  const loadData = useCallback(async (p: number, state?: FilterState) => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: PAGE_SIZE, offset: p * PAGE_SIZE, filters: toFilterPayload(state ?? filtersRef.current) }),
      });
      const json = await res.json();
      if (json.success) {
        // Handle graceful table-not-found error from backend
        if (json.data.error) {
          setError(json.data.error);
          setRows([]);
          setTotalCount(0);
        } else {
          setRows(json.data.rows ?? []);
          setTotalCount(json.data.totalCount ?? 0);
          if (json.data.columns?.length > 0) {
            setColumns(json.data.columns.filter((c: ColInfo) => c.name !== '_rid'));
          }
        }
      } else {
        setError(json.error || 'Failed to load data');
      }
    } catch {
      setError('Request failed');
    } finally {
      setLoading(false);
    }
  }, [table.id]);

  useEffect(() => {
    let cols: ColInfo[] = [];
    try { cols = JSON.parse((table as any).schema || '[]'); } catch {}
    if (cols.length > 0) setColumns(cols.filter(c => c.name !== '_rid'));
    // The defaults are literals in the registry, so the first query already
    // carries them — a big table never gets queried unfiltered.
    const specs = parseFilterSpecs(table.filterColumns);
    const defaults = defaultFilterState(specs);
    setColFilters(defaults);
    setColValues({});
    setColValuesTruncated({});
    filtersRef.current = defaults;
    setOptions({});
    setOptError({});
    loadedRef.current = {};
    setFilterOpen(false);
    setPage(0);
    setPageInput('1');
    loadData(0, defaults);
    // Load lists for the fields that already hold a value, so the chips can
    // show names instead of bare codes.
    specs.filter(sp => defaults[sp.column]).forEach(sp => ensureOptions(sp, defaults));
  }, [table.id, table.filterColumns]);

  // An import or clear changed the rows: re-read the current page with the
  // filters on screen (the effect above already loaded on mount).
  const firstReloadRef = useRef(true);
  useEffect(() => {
    if (firstReloadRef.current) { firstReloadRef.current = false; return; }
    loadData(page, filtersRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  function applyColFilter(column: string, f: ColFilter) {
    const next = { ...filtersRef.current };
    if (colFilterIsSet(f)) next[column] = f; else delete next[column];
    // A child list is narrowed by its parent; keeping a stale child would query
    // a pair that does not exist and return 0 rows with no visible reason.
    for (const child of filterSpecs) {
      if (child.parentField === column) {
        delete next[child.column];
        delete loadedRef.current[child.column];
      }
    }
    setColFilters(next);
    filtersRef.current = next;
    setPage(0);
    setPageInput('1');
    loadData(0, next);
    for (const child of filterSpecs) if (child.parentField === column) ensureOptions(child, next);
  }

  /** The registry panel picks exactly one value; it keeps any "contains" the
   *  column's own menu had set. */
  function changeFilter(column: string, value: string) {
    const prev = filtersRef.current[column] ?? EMPTY_COL_FILTER;
    applyColFilter(column, { values: value ? [value] : [], contains: prev.contains });
  }

  /** Remember this column's value in the table's registry, so the screen opens
   *  with it already applied.  One value only — that is what a default is. */
  async function saveColumnDefault(column: string, value: string | null) {
    setSavingDefault(column);
    try {
      const filterColumns = withColumnDefault(table.filterColumns, column, value);
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterColumns }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Save failed');
      // Tell the page, so the registry travels with the table everywhere.
      onRegistryChange(filterColumns);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save the default');
    } finally {
      setSavingDefault(null);
    }
  }

  function clearFilters() {
    const next: FilterState = {};
    setColFilters(next);
    filtersRef.current = next;
    loadedRef.current = {};
    setPage(0);
    loadData(0, next);
    if (filterOpen) filterSpecs.forEach(sp => ensureOptions(sp, next));
  }

  function openFilterPanel() {
    const next = !filterOpen;
    setFilterOpen(next);
    if (next) filterSpecs.forEach(sp => ensureOptions(sp, filtersRef.current));
  }

  const activeColFilters = Object.entries(colFilters).filter(([, f]) => colFilterIsSet(f));
  const activeCount = activeColFilters.length;
  const specByColumn = (column: string) => filterSpecs.find(sp => sp.column === column);
  /** A chip reads with the registry's label and the value's name when it has one. */
  const chipLabel = (column: string, f: ColFilter) => {
    const parts: string[] = [];
    if (f.values.length === 1) {
      const hit = (options[column] || colValues[column] || []).find(o => o.value === f.values[0]);
      parts.push(hit && hit.label && hit.label !== hit.value ? `${f.values[0]} — ${hit.label}` : f.values[0]);
    } else if (f.values.length > 1) {
      parts.push(`${f.values.length} values`);
    }
    if (f.contains.trim()) parts.push(`~ ${f.contains.trim()}`);
    return parts.join(' · ');
  };

  function startEdit(row: Record<string, any>) {
    const vals: Record<string, any> = {};
    columns.forEach(c => { vals[c.name] = row[c.name] !== null && row[c.name] !== undefined ? String(row[c.name]) : ''; });
    setEditRid(row._rid);
    setEditValues(vals);
    setEditError('');
    setShowAddRow(false);
  }

  async function saveEdit() {
    if (!editRid) return;
    setSavingEdit(true);
    setEditError('');
    try {
      const originalRow = rows.find(r => r._rid === editRid);
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rid: editRid, newValues: editValues, originalRow }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Update failed');
      setEditRid(null);
      loadData(page);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSavingEdit(false);
    }
  }

  async function confirmDelete(row: Record<string, any>) {
    setDeletingRid(row._rid);
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/rows`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rid: row._rid, originalRow: row }),
      });
      const json = await res.json();
      if (json.success) {
        setDeleteTarget(null);
        const newPage = rows.length === 1 && page > 0 ? page - 1 : page;
        setPage(newPage);
        loadData(newPage);
      }
    } finally {
      setDeletingRid(null);
    }
  }

  async function insertRow() {
    setSavingNew(true);
    setNewError('');
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: newValues }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Insert failed');
      setShowAddRow(false);
      setNewValues({});
      loadData(page);
    } catch (e: unknown) {
      setNewError(e instanceof Error ? e.message : 'Insert failed');
    } finally {
      setSavingNew(false);
    }
  }

  function goPage(p: number) {
    const target = Math.min(Math.max(p, 0), Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1));
    setPage(target);
    setPageInput(String(target + 1));
    loadData(target);
  }

  function jumpToPage() {
    const n = parseInt(pageInput, 10);
    if (!Number.isFinite(n) || n < 1) { setPageInput(String(page + 1)); return; }
    const target = Math.min(n, Math.max(1, Math.ceil(totalCount / PAGE_SIZE))) - 1;
    if (target === page) { setPageInput(String(page + 1)); return; }
    goPage(target);
  }


  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

  // Server-side streaming export \u2014 works for tables with millions of rows
  // (no client-side row accumulation; data is streamed straight to the file).
  async function streamExport(format: 'csv' | 'xlsx') {
    setExporting(format);
    try {
      // The file must match the screen — export the filtered rows, not the table.
      const payload = toFilterPayload(filtersRef.current);
      const qs = `format=${format}${payload.length ? `&filters=${encodeURIComponent(JSON.stringify(payload))}` : ''}`;
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/export?${qs}`, { method: 'GET' });
      if (!res.ok) {
        let msg = 'Export failed';
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${table.name}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  }
  const exportCSV  = () => streamExport('csv');
  const exportXLSX = () => streamExport('xlsx');

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const startRow = page * PAGE_SIZE + 1;
  const endRow = Math.min((page + 1) * PAGE_SIZE, totalCount);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="text-xs text-gray-400 flex items-center gap-1.5">
            {loading && <Loader2 size={11} className="animate-spin text-teal-500" />}
            {/* Counting 300k rows takes seconds; saying "0 rows" until the count
                lands reads as an empty table. */}
            {loading && totalCount === 0
              ? 'กำลังนับแถว…'
              : `${totalCount.toLocaleString()} rows ${activeCount > 0 ? 'matched' : 'total'}`}
          </span>
          {activeColFilters.map(([col, f]) => {
            const sp = specByColumn(col);
            const isDefault = sp?.defaultValue && f.values.length === 1
      && f.values[0] === resolveDefaultValue(sp.defaultValue) && !f.contains.trim();
            return (
              <span
                key={`col-${col}`}
                className={`inline-flex items-center gap-1 max-w-[300px] pl-2 pr-1 py-0.5 rounded-md border text-[11px] ${
                  isDefault ? 'bg-teal-50 border-teal-200 text-teal-800' : 'bg-sky-50 border-sky-200 text-sky-800'
                }`}
                title={`${col}: ${f.values.join(', ')}${f.contains ? ` contains "${f.contains}"` : ''}${isDefault ? ' (default)' : ''}`}
              >
                <Filter size={9} className={isDefault ? 'text-teal-400' : 'text-sky-400'} />
                <span className={isDefault ? 'text-teal-500' : 'text-sky-500'}>{sp?.label || col}:</span>
                <span className="truncate">{chipLabel(col, f)}</span>
                {isDefault && <span className="text-[9px] text-teal-500 shrink-0">ค่าตั้งต้น</span>}
                <button
                  onClick={() => applyColFilter(col, EMPTY_COL_FILTER)}
                  className={`p-0.5 hover:text-red-500 ${isDefault ? 'text-teal-400' : 'text-sky-400'}`}
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </span>
            );
          })}
          {activeCount > 1 && (
            <button onClick={clearFilters} className="text-[11px] text-gray-400 hover:text-red-500 underline underline-offset-2">
              Clear all
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filterSpecs.length > 0 && (
            <button
              onClick={openFilterPanel}
              className={`flex items-center gap-1.5 px-2.5 h-8 text-[13px] font-medium rounded-lg border transition-colors ${
                filterOpen || activeCount > 0
                  ? 'border-teal-300 bg-teal-50 text-teal-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              } whitespace-nowrap`}
              title="Filters"
            >
              <Filter size={13} />
              Filters
              {activeCount > 0 && (
                <span className="ml-0.5 px-1.5 rounded bg-teal-600 text-white text-[10px] leading-4">{activeCount}</span>
              )}
            </button>
          )}
          <button
            onClick={() => loadData(page)}
            className="p-2 text-gray-500 hover:text-teal-600 rounded-lg hover:bg-teal-50"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={exportCSV}
              disabled={exporting !== null}
              className="flex items-center gap-1 px-2.5 h-8 text-[13px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
              title="Export CSV"
            >
              {exporting === 'csv' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              CSV
            </button>
            <div className="w-px h-5 bg-gray-200" />
            <button
              onClick={exportXLSX}
              disabled={exporting !== null}
              className="flex items-center gap-1 px-2.5 h-8 text-[13px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
              title="Export Excel"
            >
              {exporting === 'xlsx' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              XLSX
            </button>
          </div>
          <button
            onClick={() => {
              const init: Record<string, any> = {};
              columns.forEach(c => { init[c.name] = ''; });
              setNewValues(init);
              setShowAddRow(true);
              setEditRid(null);
            }}
            className="flex items-center gap-1.5 px-3 h-9 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 whitespace-nowrap"
            title="Add Row"
          >
            <Plus size={14} /> <span className="hidden sm:inline">Add Row</span>
          </button>
        </div>
      </div>


      {/* One panel for every filter — new registry entries just add a field
          here instead of stretching the toolbar.  Rendered inline (not as a
          dropdown) because the data pane clips absolutely-positioned children. */}
      {filterOpen && filterSpecs.length > 0 && (
        <div className="mb-2 flex-shrink-0 bg-white border border-gray-200 rounded-xl shadow-sm">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
              <ListFilter size={12} className="text-teal-500" /> Filters
            </span>
            <button onClick={() => setFilterOpen(false)} className="p-1 text-gray-400 hover:text-gray-600" title="Close">
              <X size={13} />
            </button>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filterSpecs.map(sp => (
              <FilterSelect
                key={sp.column}
                spec={sp}
                value={(colFilters[sp.column]?.values.length === 1 ? colFilters[sp.column].values[0] : '') || ''}
                options={options[sp.column] || []}
                loading={optLoading[sp.column]}
                error={optError[sp.column]}
                onChange={v => changeFilter(sp.column, v)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
            <span className="text-[10px] text-gray-400">
              {activeCount > 0
                ? `${activeCount} filter(s) applied — exports follow them too`
                : 'No filter applied'}
            </span>
            <button
              onClick={clearFilters}
              disabled={activeCount === 0}
              className="inline-flex items-center justify-center text-[13px] px-2 h-8 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 whitespace-nowrap"
            >
              Clear all
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex-shrink-0">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm min-h-0">
        {loading && columns.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="animate-spin text-teal-500" size={28} />
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-20">
              {/* One line per column: name, type, and the filter funnel — the
                  header stays as short as it can while every column is
                  filterable from where its data is. */}
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-[52px] px-1 py-1.5 border-r border-gray-200 select-none sticky left-0 bg-gray-50 z-10">
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-[10px] font-semibold text-gray-400">#</span>
                    {activeColFilters.length > 0 && (
                      <button
                        onClick={() => activeColFilters.forEach(([c]) => applyColFilter(c, EMPTY_COL_FILTER))}
                        className="text-gray-400 hover:text-red-500"
                        title="Clear every column filter"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </th>
                {columns.map((col, ci) => (
                  <th key={col.name} className="px-2 py-1.5 text-left border-r border-gray-200 whitespace-nowrap min-w-[110px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-semibold text-gray-700 truncate" title={col.name}>{col.name}</span>
                      <span className="text-[9px] font-normal text-gray-300 uppercase shrink-0">{col.type}</span>
                      <div className="ml-auto pl-1">
                        <ColumnFilterMenu
                          column={col.name}
                          options={(options[col.name]?.length ? options[col.name] : colValues[col.name]) || []}
                          loading={colValuesLoading[col.name]}
                          truncated={colValuesTruncated[col.name]}
                          filter={colFilters[col.name] ?? EMPTY_COL_FILTER}
                          defaultValue={(() => {
                            const raw = specByColumn(col.name)?.defaultValue;
                            return raw ? resolveDefaultValue(raw) : undefined;
                          })()}
                          savingDefault={savingDefault === col.name}
                          align={ci >= columns.length - 2 ? 'right' : 'left'}
                          onOpen={() => loadColumnValues(col.name)}
                          onApply={f => applyColFilter(col.name, f)}
                          onSetDefault={v => saveColumnDefault(col.name, v)}
                        />
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={loading ? 'opacity-40 transition-opacity' : 'transition-opacity'}>
              {/* Add Row inline form */}
              {showAddRow && (
                <tr className="bg-teal-50 border-b border-teal-100">
                  <td className="px-1 py-1.5 sticky left-0 bg-teal-50 z-10 border-r border-teal-100 w-[52px]">
                    <div className="flex items-center justify-center gap-0.5 relative">
                      {newError && <span className="text-[10px] text-red-500 absolute -top-4 left-0 whitespace-nowrap">{newError}</span>}
                      <span className="text-teal-400 font-bold text-[10px]">+</span>
                      <button onClick={insertRow} disabled={savingNew} className="p-1 text-teal-600 hover:text-teal-800 disabled:opacity-50" title="Save">
                        {savingNew ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      </button>
                      <button onClick={() => { setShowAddRow(false); setNewError(''); }} className="p-1 text-gray-400 hover:text-gray-600" title="Cancel">
                        <X size={14} />
                      </button>
                    </div>
                  </td>
                  {columns.map(col => (
                    <td key={col.name} className="px-2 py-1.5 border-r border-teal-100">
                      <input
                        className="w-full px-2 py-1 text-xs border border-teal-300 rounded focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white min-w-[80px]"
                        value={newValues[col.name] ?? ''}
                        onChange={e => setNewValues(v => ({ ...v, [col.name]: e.target.value }))}
                        placeholder={col.name}
                      />
                    </td>
                  ))}
                </tr>
              )}

              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="text-center py-16 text-gray-400 text-sm">
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-teal-500" /> กำลังโหลดข้อมูล…
                      </span>
                    ) : 'No rows found'}
                  </td>
                </tr>
              ) : rows.map((row, i) => {
                const isEditing = editRid === row._rid;
                const rowBg = isEditing ? 'bg-teal-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40';
                return (
                  <tr
                    key={row._rid ?? i}
                    className={`group border-b border-gray-100 transition-colors ${rowBg} hover:bg-teal-50/30`}
                  >
                    {/* Sticky-left: row number + actions in same cell (actions show on hover) */}
                    <td className={`px-1 py-1 border-r border-gray-100 select-none sticky left-0 z-10 ${rowBg} group-hover:bg-teal-50/30 relative w-[52px]`}>
                      {isEditing ? (
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={saveEdit} disabled={savingEdit} className="p-0.5 text-teal-600 hover:text-teal-800 disabled:opacity-50" title={editError || 'Save'}>
                            {savingEdit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          </button>
                          <button onClick={() => { setEditRid(null); setEditError(''); }} className="p-0.5 text-gray-400 hover:text-gray-600" title="Cancel">
                            <X size={12} />
                          </button>
                          {editError && (
                            <div className="absolute left-12 top-0 z-40 max-w-md rounded-md bg-red-50 border border-red-200 text-red-700 text-xs px-2 py-1 shadow-lg whitespace-nowrap" title={editError}>
                              <AlertCircle size={11} className="inline-block -mt-0.5 mr-1" />
                              {editError.length > 80 ? editError.slice(0, 80) + '…' : editError}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-0.5">
                          {/* Row number always visible; kebab fades in on hover beside it */}
                          <span className="text-[10px] text-gray-400 tabular-nums pl-0.5">{startRow + i}</span>
                          <button
                            onClick={e => { e.stopPropagation(); setMenuOpenRid(menuOpenRid === row._rid ? null : row._rid); }}
                            className="p-0.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-200/60 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Row actions"
                          >
                            <MoreVertical size={12} />
                          </button>
                          {/* Dropdown menu — anchored below kebab, slight right offset so it doesn't cover the row content directly */}
                          {menuOpenRid === row._rid && (
                            <div
                              className="absolute left-2 top-full mt-0.5 z-50 bg-white border border-gray-200 rounded-md shadow-xl py-1 min-w-[130px] text-xs ring-1 ring-black/5"
                              onClick={e => e.stopPropagation()}
                            >
                              <button
                                onClick={() => { setMenuOpenRid(null); startEdit(row); }}
                                className="w-full text-left px-3 py-1.5 hover:bg-gray-100 text-gray-700 flex items-center gap-2"
                              >
                                <Pencil size={12} className="text-teal-600" />
                                Edit row
                              </button>
                              <div className="my-0.5 border-t border-gray-100" />
                              <button
                                onClick={() => { setMenuOpenRid(null); setDeleteTarget(row); }}
                                disabled={deletingRid === row._rid}
                                className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center gap-2 disabled:opacity-40"
                              >
                                {deletingRid === row._rid ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                Delete row
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    {columns.map(col => (
                      <td key={col.name} className="px-3 py-1 border-r border-gray-100 max-w-[220px]">
                        {isEditing ? (
                          <input
                            className="w-full px-1.5 py-0.5 text-xs border border-teal-300 rounded focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white min-w-[80px]"
                            value={editValues[col.name] ?? ''}
                            onChange={e => setEditValues(v => ({ ...v, [col.name]: e.target.value }))}
                          />
                        ) : (
                          <span className={`text-xs block truncate ${row[col.name] === null || row[col.name] === undefined ? 'text-gray-300 italic' : 'text-gray-700'}`}>
                            {row[col.name] === null || row[col.name] === undefined ? 'null' : String(row[col.name])}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-2 flex-shrink-0 text-xs text-gray-500">
        <span>
          {totalCount > 0
            ? `Rows ${startRow}–${endRow} of ${totalCount.toLocaleString()}`
            : loading ? '…' : '0 rows'}
        </span>
        {/* Icon paging — with thousands of pages, stepping one at a time is not
            enough, so the page number is a box you can type into. */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => goPage(0)}
            disabled={page === 0 || loading}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-teal-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="First page"
          >
            <ChevronsLeft size={14} />
          </button>
          <button
            onClick={() => goPage(page - 1)}
            disabled={page === 0 || loading}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-teal-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="flex items-center gap-1 px-1">
            <input
              value={pageInput}
              onChange={e => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={e => {
                if (e.key === 'Enter') jumpToPage();
                if (e.key === 'Escape') setPageInput(String(page + 1));
              }}
              onBlur={jumpToPage}
              disabled={loading}
              aria-label="Page number"
              title={`Type a page and press Enter (1–${Math.max(1, totalPages)})`}
              className="w-12 px-1 py-1 text-center text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-teal-400 tabular-nums"
            />
            <span className="tabular-nums text-gray-400">/ {Math.max(1, totalPages).toLocaleString()}</span>
          </div>
          <button
            onClick={() => goPage(page + 1)}
            disabled={page >= totalPages - 1 || loading}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-teal-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Next page"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={() => goPage(totalPages - 1)}
            disabled={page >= totalPages - 1 || loading}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-teal-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="Last page"
          >
            <ChevronsRight size={14} />
          </button>
        </div>
      </div>

      {/* Delete confirm */}
      {deleteTarget && (
        <ConfirmDialog
          message="Delete this row? This cannot be undone."
          onConfirm={() => confirmDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Settings Modal ──────────────────────────────────────────────────────────

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('connections');
  const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'connections', label: 'Connections', icon: <Database size={13} /> },
    { id: 'apikeys', label: 'API Keys', icon: <Key size={13} /> },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-w-[95vw] flex flex-col" style={{ height: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2 font-bold text-gray-800">
            <Settings size={16} className="text-teal-500" /> Settings
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
                tab === t.id ? 'border-teal-500 text-teal-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'connections' && <ConnectionsSection />}
          {tab === 'apikeys' && <ApiKeysSection />}
        </div>
      </div>
    </div>
  );
}

// ─── Left Panel: Tree view (folders + tables) ──────────────────────────────

function LeftTreePanel({
  tables, folders, selectedTable, onSelectTable, onCreateTable, onCreateFolder,
  onDeleteFolder, onMoveTable, onRenameFolder, onReorderFolder, loading,
  savedQueries = [], onOpenSaved, onRenameSaved, onDeleteSaved, onCreateSql,
  isMobile = false, isOpen = true, onClose, canManage = true,
}: {
  /** False for non-admins: no new table/folder/SQL buttons. */
  canManage?: boolean;
  tables: RepoTable[];
  folders: RepoFolder[];
  selectedTable: RepoTable | null;
  onSelectTable: (t: RepoTable) => void;
  onCreateTable: () => void;
  onCreateFolder: () => void;
  onDeleteFolder: (f: RepoFolder) => void;
  onMoveTable: (tableId: string, folderId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onReorderFolder?: (folderId: string, beforeFolderId: string | null) => void;
  loading: boolean;
  savedQueries?: SavedQuery[];
  onOpenSaved?: (q: SavedQuery) => void;
  onRenameSaved?: (id: string, name: string) => void;
  onDeleteSaved?: (id: string) => void;
  onCreateSql?: () => void;
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [initializedCollapse, setInitializedCollapse] = useState(false);
  const [dragItem, setDragItem] = useState<{ id: string; type: 'table' | 'folder' } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tableId: string; tableName: string; folderId: string | null } | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState('');
  const contextRef = useRef<HTMLDivElement>(null);
  // Saved SQL lives in this panel too, under the tables
  const [savedOpen, setSavedOpen] = useState(true);
  const [tablesOpen, setTablesOpen] = useState(true);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const [renamingSaved, setRenamingSaved] = useState<string | null>(null);
  const [renameSavedDraft, setRenameSavedDraft] = useState('');
  const [confirmDeleteSaved, setConfirmDeleteSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!newMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [newMenuOpen]);

  // Close context menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) setContextMenu(null);
    }
    if (contextMenu) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  // Collapse all folders by default on first load (once folders have arrived)
  useEffect(() => {
    if (initializedCollapse || folders.length === 0) return;
    const init: Record<string, boolean> = {};
    for (const f of folders) init[f.id] = true;
    setCollapsed(init);
    setInitializedCollapse(true);
  }, [folders, initializedCollapse]);

  const filtered = tables.filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()));
  const folderTree = buildFolderTree(folders);

  // Tables at root (no folder)
  const rootTables = filtered.filter(t => !t.folderId);
  // Tables in folders
  const folderTablesMap: Record<string, RepoTable[]> = {};
  filtered.forEach(t => {
    if (t.folderId) {
      if (!folderTablesMap[t.folderId]) folderTablesMap[t.folderId] = [];
      folderTablesMap[t.folderId].push(t);
    }
  });

  function handleDragStart(e: DragEvent, id: string, type: 'table' | 'folder') {
    setDragItem({ id, type });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ id, type }));
  }

  function handleDragOver(e: DragEvent, targetId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(targetId);
  }

  function handleDrop(e: DragEvent, targetFolderId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    if (!dragItem) return;
    if (dragItem.type === 'table') {
      onMoveTable(dragItem.id, targetFolderId);
    } else if (dragItem.type === 'folder' && dragItem.id !== targetFolderId) {
      // Reorder: insert dragged folder before the target folder
      onReorderFolder?.(dragItem.id, targetFolderId);
    }
    setDragItem(null);
  }

  function handleContextMenu(e: React.MouseEvent, t: RepoTable) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tableId: t.id, tableName: t.name, folderId: t.folderId ?? null });
  }

  function handleFolderRename(folderId: string) {
    if (editFolderName.trim() && onRenameFolder) {
      onRenameFolder(folderId, editFolderName.trim());
    }
    setEditingFolder(null);
    setEditFolderName('');
  }

  function renderTableItem(t: RepoTable, depth = 0) {
    const isDragging = dragItem?.id === t.id;
    return (
      <button
        key={t.id}
        draggable
        onDragStart={e => handleDragStart(e, t.id, 'table')}
        onDragEnd={() => { setDragItem(null); setDragOver(null); }}
        onClick={() => onSelectTable(t)}
        onContextMenu={e => handleContextMenu(e, t)}
        className={`w-full text-left flex items-center gap-1.5 py-1 px-2 transition-colors border-l-2 group ${
          isDragging ? 'opacity-40' :
          selectedTable?.id === t.id
            ? 'bg-teal-50 border-l-teal-500 text-teal-800'
            : 'border-l-transparent text-gray-700 hover:bg-gray-50'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <GripVertical size={10} className="text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab flex-shrink-0" />
        <Table2 size={11} className={selectedTable?.id === t.id ? 'text-teal-500' : 'text-gray-400'} />
        <span className="flex-1 min-w-0 text-xs font-medium truncate">{t.name}</span>
        {t.rowCount > 0 && <span className="text-[10px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          t.syncStatus === 'error' ? 'bg-red-400' :
          t.syncStatus === 'syncing' ? 'bg-teal-400 animate-pulse' :
          'bg-gray-300'
        }`} />
      </button>
    );
  }

  function renderFolderNode(folder: RepoFolder, depth = 0) {
    const isCollapsed = collapsed[folder.id];
    const folderTables = folderTablesMap[folder.id] || [];
    const hasContent = folderTables.length > 0 || (folder.children && folder.children.length > 0);
    const isDragTarget = dragOver === folder.id;
    const isEditing = editingFolder === folder.id;
    const isDraggingFolder = dragItem?.type === 'folder';
    const isThisDragging = dragItem?.id === folder.id;

    return (
      <div key={folder.id}>
        {/* Reorder drop indicator (shown above target when dragging a folder) */}
        {isDraggingFolder && isDragTarget && !isThisDragging && (
          <div className="h-0.5 bg-teal-500 mx-2 my-0.5 rounded-full" />
        )}
        <div
          draggable={!isEditing}
          onDragStart={e => handleDragStart(e, folder.id, 'folder')}
          onDragEnd={() => { setDragItem(null); setDragOver(null); }}
          className={`flex items-center gap-1.5 py-1 px-2 group cursor-pointer transition-all ${
            isThisDragging
              ? 'opacity-40'
              : isDragTarget && !isDraggingFolder
                ? 'bg-teal-50 border-l-2 border-l-teal-500 border border-dashed border-teal-400 rounded-r-md mx-1'
                : 'border-l-2 border-l-transparent hover:bg-gray-50'
          }`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => { if (!isEditing) setCollapsed(c => ({ ...c, [folder.id]: !c[folder.id] })); }}
          onDragOver={e => handleDragOver(e, folder.id)}
          onDragLeave={() => setDragOver(null)}
          onDrop={e => handleDrop(e, folder.id)}
        >
          <GripVertical size={10} className="text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab flex-shrink-0" />
          <span className="w-3 text-gray-400 flex-shrink-0">
            {hasContent ? (isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />) : <span className="w-3" />}
          </span>
          <FolderOpen size={12} className={isDragTarget && !isDraggingFolder ? 'text-teal-500' : 'text-amber-500'} />
          {isEditing ? (
            <input
              autoFocus
              className="flex-1 min-w-0 text-xs font-semibold text-gray-800 bg-white border border-teal-400 rounded px-1 py-0.5 focus:outline-none"
              value={editFolderName}
              onChange={e => setEditFolderName(e.target.value)}
              onBlur={() => handleFolderRename(folder.id)}
              onKeyDown={e => { if (e.key === 'Enter') handleFolderRename(folder.id); if (e.key === 'Escape') { setEditingFolder(null); setEditFolderName(''); } }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className="flex-1 min-w-0 text-xs font-semibold text-gray-600 truncate"
              onDoubleClick={e => {
                e.stopPropagation();
                setEditingFolder(folder.id);
                setEditFolderName(folder.name);
              }}
              title="Double-click to rename"
            >{folder.name}</span>
          )}
          <span className="text-[10px] text-gray-400">{folderTables.length}</span>
          <button
            onClick={e => { e.stopPropagation(); onDeleteFolder(folder); }}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-0.5"
          >
            <Trash2 size={10} />
          </button>
        </div>
        {!isCollapsed && (
          <>
            {folder.children?.map(child => renderFolderNode(child, depth + 1))}
            {folderTables.map(t => renderTableItem(t, depth + 1))}
          </>
        )}
      </div>
    );
  }

  // Build interleaved list: folders and root tables sorted by sortOrder
  type TreeItem = { type: 'folder'; data: RepoFolder } | { type: 'table'; data: RepoTable };
  const rootItems: TreeItem[] = [
    ...folderTree.map(f => ({ type: 'folder' as const, data: f })),
    ...rootTables.map(t => ({ type: 'table' as const, data: t })),
  ].sort((a, b) => {
    const aOrder = a.type === 'folder' ? a.data.sortOrder : a.data.sortOrder;
    const bOrder = b.type === 'folder' ? b.data.sortOrder : b.data.sortOrder;
    return aOrder - bOrder;
  });

  const isRootDropTarget = dragOver === 'root' && dragItem != null;

  // On mobile: render as an overlay drawer (absolute-positioned) with translate-x animation.
  // On desktop: behave exactly as before (in-flow, always visible).
  const containerClass = isMobile
    ? `absolute inset-y-0 left-0 z-40 w-[280px] max-w-[85vw] border-r border-gray-200 bg-white flex flex-col h-full shadow-xl transition-transform duration-200 ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`
    : 'w-[280px] flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full';

  return (
    <div className={containerClass}>
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Repository</h3>
          <div className="flex items-center gap-0.5">
            {canManage && (
            <button onClick={onCreateFolder} className="p-1 rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50" title="New Folder">
              <FolderPlus size={13} />
            </button>
            )}
            {/* One "new" button for both kinds of thing this panel holds */}
            {canManage && (
            <div className="relative" ref={newMenuRef}>
              <button
                onClick={() => onCreateSql ? setNewMenuOpen(o => !o) : onCreateTable()}
                className="p-1 rounded-md text-teal-600 hover:bg-teal-50"
                title="เพิ่มใหม่"
              >
                <Plus size={13} />
              </button>
              {newMenuOpen && onCreateSql && (
                <div className="absolute right-0 top-full mt-1 z-50 w-40 bg-white border border-gray-200 rounded-lg shadow-xl py-1">
                  <button
                    onClick={() => { setNewMenuOpen(false); onCreateTable(); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  >
                    <Table2 size={12} className="text-teal-500" /> ตารางใหม่
                  </button>
                  <button
                    onClick={() => { setNewMenuOpen(false); onCreateSql(); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  >
                    <Terminal size={12} className="text-teal-500" /> คำสั่ง SQL ใหม่
                  </button>
                </div>
              )}
            </div>
            )}
            {isMobile && (
              <button onClick={onClose} className="p-1 ml-0.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Close">
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="w-full pl-7 pr-3 h-8 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 bg-gray-50"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Tree list */}
      <div
        className={`flex-1 overflow-y-auto py-1 transition-all ${
          isRootDropTarget ? 'bg-teal-50/30 border-2 border-dashed border-teal-300 rounded-lg m-1' : ''
        }`}
        onDragOver={e => { e.preventDefault(); setDragOver('root'); }}
        onDragLeave={() => setDragOver(null)}
        onDrop={e => handleDrop(e, null)}
      >
        {/* Section 1 — tables */}
        <button
          onClick={() => setTablesOpen(o => !o)}
          className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-gray-500 hover:bg-gray-50"
        >
          {tablesOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Table2 size={11} className="text-teal-500" />
          <span className="flex-1 text-left">ตาราง</span>
          <span className="text-gray-400 font-normal">{tables.length}</span>
        </button>
        {!tablesOpen ? null : loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={16} className="animate-spin text-teal-400" />
          </div>
        ) : rootItems.length === 0 && search ? (
          <div className="py-10 text-center text-gray-400 text-xs">No match</div>
        ) : rootItems.length === 0 ? (
          <div className="py-10 text-center text-gray-400 text-xs">No tables yet</div>
        ) : (
          <>
            {rootItems.map(item =>
              item.type === 'folder'
                ? renderFolderNode(item.data)
                : renderTableItem(item.data)
            )}
            {/* Drop zone hint at bottom when dragging */}
            {dragItem && (
              <div className="mx-2 mt-2 py-3 text-center text-[10px] text-teal-500 border-2 border-dashed border-teal-300 rounded-lg bg-teal-50/50 transition-all">
                Drop here to move to root
              </div>
            )}
          </>
        )}

        {/* Section 2 — saved SQL, kept in this panel next to the tables so it is
            there whichever tab you are on. */}
        {onOpenSaved && (
          <div className="mt-1 border-t border-gray-100 pt-1">
            <button
              onClick={() => setSavedOpen(o => !o)}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-gray-500 hover:bg-gray-50"
            >
              {savedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <Terminal size={11} className="text-teal-500" />
              <span className="flex-1 text-left">คำสั่ง SQL</span>
              <span className="text-gray-400 font-normal">{savedQueries.length}</span>
            </button>
            {savedOpen && (
              savedQueries.length === 0 ? (
                <div className="px-3 py-3 text-[10px] text-gray-400">
                  ยังไม่มี — เขียนใน SQL Editor แล้วกด Save
                </div>
              ) : (
                savedQueries.map(q => (
                  <div
                    key={q.id}
                    className="group flex items-center gap-1.5 py-1 pl-4 pr-2 hover:bg-gray-50 cursor-pointer"
                    onClick={() => { if (renamingSaved !== q.id) onOpenSaved(q); }}
                    title={q.sql}
                  >
                    <Terminal size={11} className="text-teal-500 flex-shrink-0" />
                    {renamingSaved === q.id ? (
                      <input
                        autoFocus
                        value={renameSavedDraft}
                        onChange={e => setRenameSavedDraft(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameSaved?.(q.id, renameSavedDraft); setRenamingSaved(null); }
                          if (e.key === 'Escape') setRenamingSaved(null);
                        }}
                        onBlur={() => { onRenameSaved?.(q.id, renameSavedDraft); setRenamingSaved(null); }}
                        className="flex-1 min-w-0 text-xs bg-white border border-teal-400 rounded px-1 py-0.5 focus:outline-none"
                      />
                    ) : (
                      <>
                        <span className="flex-1 min-w-0 text-xs text-gray-700 truncate">{q.name}</span>
                        <button
                          onClick={e => { e.stopPropagation(); setRenamingSaved(q.id); setRenameSavedDraft(q.name); }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-teal-600"
                          title="เปลี่ยนชื่อ"
                        >
                          <Pencil size={10} />
                        </button>
                        {/* two clicks to delete — the first turns it red */}
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            if (confirmDeleteSaved === q.id) { onDeleteSaved?.(q.id); setConfirmDeleteSaved(null); }
                            else setConfirmDeleteSaved(q.id);
                          }}
                          className={`p-0.5 ${confirmDeleteSaved === q.id ? 'text-red-600 opacity-100' : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500'}`}
                          title={confirmDeleteSaved === q.id ? 'กดอีกครั้งเพื่อลบ' : 'ลบ'}
                        >
                          <Trash2 size={10} />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextRef}
          className="fixed z-[100] bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 mb-0.5">
            {contextMenu.tableName}
          </div>
          {folders.length > 0 && (
            <>
              {folders.map(f => (
                <button
                  key={f.id}
                  onClick={() => { onMoveTable(contextMenu.tableId, f.id); setContextMenu(null); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2 transition-colors ${
                    contextMenu.folderId === f.id ? 'text-teal-600 font-medium' : 'text-gray-700'
                  }`}
                >
                  <FolderOpen size={11} className="text-amber-500" />
                  Move to {f.name}
                  {contextMenu.folderId === f.id && <Check size={10} className="ml-auto text-teal-500" />}
                </button>
              ))}
            </>
          )}
          {contextMenu.folderId && (
            <button
              onClick={() => { onMoveTable(contextMenu.tableId, null); setContextMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <X size={11} className="text-gray-400" />
              Remove from folder
            </button>
          )}
          <div className="border-t border-gray-100 mt-0.5 pt-0.5">
            <button
              onClick={() => {
                const t = tables.find(t => t.id === contextMenu.tableId);
                if (t) onSelectTable(t);
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <Eye size={11} className="text-gray-400" />
              View data
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SQL Editor Panel ─────────────────────────────────────────────────────────

interface SqlTab {
  id: string;
  name: string;
  sql: string;
  savedId?: string; // the saved statement this tab came from, if any
  result: { columns: { name: string }[]; rows: any[]; error?: string; time?: number; rowCount?: number } | null;
  running: boolean;
  resultTab: 'results' | 'messages';
  messages: string[];
}

interface SchemaTable {
  loading?: boolean;
  error?: string;
  name: string;
  columns?: { name: string; type: string }[];
  expanded?: boolean;
}

function SqlEditorPanel({ connections, saved, onSavedChanged, openRequest, onOpenHandled, newTabRequest }: {
  connections: RepoConnection[];
  saved: SavedQuery[];
  onSavedChanged: () => void;
  openRequest: SavedQuery | null;   // set when one is clicked in the tables panel
  onOpenHandled: () => void;
  newTabRequest: number;            // bumped when "new SQL" is picked there
}) {
  const [connId, setConnId] = useState('');
  const [tabs, setTabs] = useState<SqlTab[]>([
    { id: '1', name: 'Query 1', sql: '', result: null, running: false, resultTab: 'results', messages: [] },
  ]);
  const [activeTabId, setActiveTabId] = useState('1');
  const [tabCounter, setTabCounter] = useState(2);
  const [schemaTables, setSchemaTables] = useState<SchemaTable[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [showSchema, setShowSchema] = useState(false);
  const [savingName, setSavingName] = useState<string | null>(null); // the draft name being typed
  const [savingBusy, setSavingBusy] = useState(false);
  const [history, setHistory] = useState<{ sql: string; time: string; connName: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  // A statement renamed or deleted in the tables panel should not leave a stale
  // tab title behind.
  useEffect(() => {
    setTabs(prev => prev.map(t => {
      if (!t.savedId) return t;
      const hit = saved.find(q => q.id === t.savedId);
      if (!hit) return { ...t, savedId: undefined };
      return hit.name === t.name ? t : { ...t, name: hit.name };
    }));
  }, [saved]);

  // Close history dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false);
    }
    if (showHistory) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showHistory]);

  // Load schema when connection changes
  useEffect(() => {
    if (!connId) { setSchemaTables([]); return; }
    setSchemaLoading(true);
    authFetch(`${API_URL}/data-repository/connections/${connId}/tables`)
      .then(r => r.json())
      .then(json => {
        if (json.success) {
          const tableList = json.data?.tables ?? json.data ?? [];
          setSchemaTables(tableList.map((t: any) => ({ name: t.name ?? t, columns: undefined, expanded: false })));
        }
      })
      .catch(() => {})
      .finally(() => setSchemaLoading(false));
  }, [connId]);

  /** Save the active tab.  A tab opened from a saved statement updates it;
   *  anything else asks for a name first (typed in the toolbar, never a prompt). */
  async function saveActive(name?: string) {
    const sql = activeTab.sql.trim();
    if (!sql) {
      updateTab(activeTab.id, { messages: ['ยังไม่มีคำสั่ง SQL ให้บันทึก'], resultTab: 'messages' });
      return;
    }
    if (!activeTab.savedId && name === undefined) {
      setSavingName(activeTab.name);
      return;
    }
    setSavingBusy(true);
    try {
      const body = JSON.stringify({ name: name ?? activeTab.name, sql, connectionId: connId || null });
      const res = activeTab.savedId
        ? await authFetch(`${API_URL}/data-repository/sql/saved/${activeTab.savedId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
        : await authFetch(`${API_URL}/data-repository/sql/saved`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Save failed');
      const q: SavedQuery = json.data.query;
      updateTab(activeTab.id, { savedId: q.id, name: q.name, messages: [`บันทึกเป็น "${q.name}" แล้ว`] });
      setSavingName(null);
      onSavedChanged();
    } catch (e: unknown) {
      updateTab(activeTab.id, { messages: [`Error: ${e instanceof Error ? e.message : 'Save failed'}`], resultTab: 'messages' });
    } finally {
      setSavingBusy(false);
    }
  }

  /** An empty, never-run, unsaved tab is scratch space — it should not survive
   *  as a second tab once something real is open. */
  const isBlankTab = (t: SqlTab) => !t.savedId && !t.sql.trim() && !t.result;

  const openSaved = useCallback((q: SavedQuery) => {
    setTabs(prev => {
      const existing = prev.find(t => t.savedId === q.id);
      if (existing) { setActiveTabId(existing.id); return prev; }
      const newId = `s${q.id}`;
      setActiveTabId(newId);
      const kept = prev.filter(t => !isBlankTab(t));
      return [...kept, { id: newId, name: q.name, sql: q.sql, savedId: q.id, result: null, running: false, resultTab: 'results' as const, messages: [] }];
    });
    if (q.connectionId) setConnId(q.connectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click in the tables panel opens the statement here.
  useEffect(() => {
    if (!openRequest) return;
    openSaved(openRequest);
    onOpenHandled();
  }, [openRequest, openSaved, onOpenHandled]);

  // "คำสั่ง SQL ใหม่" from the tables panel opens an empty tab.
  const firstNewTabRequest = useRef(newTabRequest);
  useEffect(() => {
    if (newTabRequest === firstNewTabRequest.current) return;
    firstNewTabRequest.current = newTabRequest;
    addTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTabRequest]);

  function updateTab(id: string, patch: Partial<SqlTab>) {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }

  function addTab() {
    const newId = String(tabCounter);
    setTabs(prev => [
      ...prev.filter(t => !isBlankTab(t)),
      { id: newId, name: `Query ${tabCounter}`, sql: '', result: null, running: false, resultTab: 'results', messages: [] },
    ]);
    setActiveTabId(newId);
    setTabCounter(c => c + 1);
  }

  function closeTab(id: string) {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex(t => t.id === id);
    const newTabs = tabs.filter(t => t.id !== id);
    if (activeTabId === id) {
      setActiveTabId(newTabs[Math.min(idx, newTabs.length - 1)].id);
    }
    setTabs(newTabs);
  }

  async function runQuery(sqlOverride?: string) {
    const sql = (sqlOverride ?? activeTab.sql).trim();
    const tabId = activeTab.id;
    // Saying nothing here reads as "the editor is broken" — say what is missing.
    if (!connId) {
      updateTab(tabId, { messages: ['เลือก Connection ก่อน แล้วจึงกด Run'], resultTab: 'messages', result: null });
      return;
    }
    if (!sql) {
      updateTab(tabId, { messages: ['พิมพ์คำสั่ง SQL ก่อน'], resultTab: 'messages', result: null });
      return;
    }
    updateTab(tabId, { running: true, result: null, messages: [] });
    const connName = connections.find(c => c.id === connId)?.name ?? '';
    const start = performance.now();
    try {
      const res = await authFetch(`${API_URL}/data-repository/sql/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connId, sql }),
      });
      const elapsed = Math.round(performance.now() - start);
      const json = await res.json();
      if (json.success) {
        const cols = json.data.columns ?? [];
        const rows = json.data.rows ?? [];
        const rowsAffected = json.data.rowsAffected;
        const sqlUpper = sql.trim().toUpperCase();
        const isNonQuery = /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT)\b/.test(sqlUpper);
        const summary = isNonQuery
          ? `Statement executed successfully in ${elapsed}ms. ${rowsAffected ?? 0} row(s) affected.`
          : `Query executed successfully in ${elapsed}ms. ${rows.length} row(s) returned.`;
        updateTab(tabId, {
          running: false,
          result: { columns: cols, rows, time: elapsed, rowCount: rows.length },
          messages: [summary],
          resultTab: isNonQuery ? 'messages' : 'results',
        });
      } else {
        updateTab(tabId, {
          running: false,
          result: { columns: [], rows: [], error: json.error || 'Query failed', time: elapsed },
          messages: [`Error: ${json.error || 'Query failed'}`],
          resultTab: 'messages',
        });
      }
    } catch (e: unknown) {
      const elapsed = Math.round(performance.now() - start);
      const msg = e instanceof Error ? e.message : 'Request failed';
      updateTab(tabId, {
        running: false,
        result: { columns: [], rows: [], error: msg, time: elapsed },
        messages: [`Error: ${msg}`],
        resultTab: 'messages',
      });
    }
    // Add to history
    setHistory(prev => {
      const next = [{ sql, time: new Date().toLocaleTimeString(), connName }, ...prev];
      return next.slice(0, 20);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        // Run selected text only
        const ta = textareaRef.current;
        if (ta) {
          const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd).trim();
          if (selected) { runQuery(selected); return; }
        }
      }
      runQuery();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveActive();
    }
  }

  function formatSql(sql: string): string {
    const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
      'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES',
      'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW',
      'AS', 'IN', 'NOT', 'NULL', 'IS', 'LIKE', 'BETWEEN', 'EXISTS', 'UNION', 'ALL',
      'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COUNT', 'SUM',
      'AVG', 'MIN', 'MAX', 'CAST', 'COALESCE', 'WITH', 'RECURSIVE'];
    let result = sql;
    keywords.forEach(kw => {
      const regex = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
      result = result.replace(regex, kw);
    });
    return result;
  }

  function insertTableName(name: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newSql = activeTab.sql.substring(0, start) + name + activeTab.sql.substring(end);
    updateTab(activeTab.id, { sql: newSql });
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + name.length; }, 0);
  }

  async function toggleTableExpand(tableName: string) {
    const tbl = schemaTables.find(t => t.name === tableName);
    if (!tbl) return;
    if (tbl.expanded) {
      setSchemaTables(prev => prev.map(t => t.name === tableName ? { ...t, expanded: false } : t));
      return;
    }
    // Fetch columns if not loaded.  Oracle has no information_schema, so the
    // lookup has to happen server-side where the engine is known.
    if (!tbl.columns) {
      setSchemaTables(prev => prev.map(t => t.name === tableName ? { ...t, expanded: true, loading: true } : t));
      try {
        const res = await authFetch(`${API_URL}/data-repository/connections/${connId}/columns?table=${encodeURIComponent(tableName)}`);
        const json = await res.json();
        if (json.success) {
          const cols = (json.data?.columns ?? []).map((c: { name: string; type: string }) => ({ name: c.name, type: c.type }));
          setSchemaTables(prev => prev.map(t => t.name === tableName ? { ...t, columns: cols, expanded: true, loading: false, error: undefined } : t));
          return;
        }
        throw new Error(json.error || 'Could not read the columns');
      } catch (e: unknown) {
        setSchemaTables(prev => prev.map(t => t.name === tableName
          ? { ...t, expanded: true, loading: false, error: e instanceof Error ? e.message : 'Could not read the columns' }
          : t));
        return;
      }
    }
    setSchemaTables(prev => prev.map(t => t.name === tableName ? { ...t, expanded: !t.expanded } : t));
  }

  function exportCsv() {
    if (!activeTab.result || activeTab.result.error || !activeTab.result.columns.length) return;
    const { columns, rows } = activeTab.result;
    const header = columns.map(c => c.name).join(',');
    const body = rows.map(row => columns.map(c => {
      const v = row[c.name];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `query_result.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportXlsx() {
    if (!activeTab.result || activeTab.result.error || !activeTab.result.columns.length) return;
    const { columns, rows } = activeTab.result;
    const ws = XLSX.utils.json_to_sheet(rows, { header: columns.map(c => c.name) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Query Result');
    XLSX.writeFile(wb, 'query_result.xlsx');
  }

  const filteredSchema = schemaTables.filter(t => !schemaSearch || t.name.toLowerCase().includes(schemaSearch.toLowerCase()));
  const lineCount = (activeTab.sql.match(/\n/g) || []).length + 1;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* One row for the whole pane: what it is, then everything you do to it */}
      <div className="flex-shrink-0 px-3 py-1.5 bg-white border-b border-gray-200 flex items-center gap-1.5">
        <span className="shrink-0 flex items-center gap-1.5 h-7 pr-2.5 mr-1 border-r border-gray-200 text-xs font-semibold text-gray-700 max-w-[220px]">
          <Database size={13} className="text-teal-500 shrink-0" />
          <span className="truncate" title={activeTab.name}>{activeTab.savedId ? activeTab.name : 'SQL Editor'}</span>
        </span>
        <div className="w-48 shrink-0">
          <CustomSelect
            compact
            value={connId}
            onChange={v => setConnId(v)}
            placeholder="Connection..."
            options={connections.map(c => ({
              value: c.id,
              label: c.name,
              icon: <Database size={12} className={c.type === 'postgresql' ? 'text-blue-500' : c.type === 'mysql' ? 'text-orange-500' : 'text-red-500'} />,
            }))}
          />
        </div>
        {/* Kept clickable with nothing selected: a dead grey button is why this
            editor reads as broken.  runQuery() says what is missing instead. */}
        <button
          onClick={() => runQuery()}
          disabled={activeTab.running}
          className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-colors ${
            connId && activeTab.sql.trim()
              ? 'bg-teal-600 text-white hover:bg-teal-700'
              : 'bg-teal-600/40 text-white hover:bg-teal-600/60'
          } disabled:opacity-50`}
          title={!connId ? 'เลือก Connection ก่อน' : !activeTab.sql.trim() ? 'พิมพ์คำสั่ง SQL ก่อน' : 'Run (Ctrl+Enter)'}
        >
          {activeTab.running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Run
        </button>
        <button
          onClick={() => updateTab(activeTab.id, { sql: formatSql(activeTab.sql) })}
          disabled={!activeTab.sql.trim()}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition-colors"
          title="Format SQL"
        >
          <Code size={12} /> Format
        </button>
        <div className="relative" ref={historyRef}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            title="Query History"
          >
            <Clock size={12} /> History
          </button>
          {showHistory && history.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-96 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-50">
              <div className="px-3 py-2 border-b border-gray-100 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Recent Queries</div>
              {history.map((h, i) => (
                <button
                  key={i}
                  onClick={() => { updateTab(activeTab.id, { sql: h.sql }); setShowHistory(false); }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] text-gray-400">{h.time}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{h.connName}</span>
                  </div>
                  <div className="text-xs font-mono text-gray-700 truncate">{h.sql}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Naming happens on this line, not in an OS prompt box. */}
        {savingName !== null ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={savingName}
              onChange={e => setSavingName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveActive(savingName);
                if (e.key === 'Escape') setSavingName(null);
              }}
              placeholder="ตั้งชื่อแล้วกด Enter"
              className="w-40 h-8 px-2 text-xs border border-teal-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-400"
            />
            <button
              onClick={() => saveActive(savingName)}
              disabled={savingBusy || !savingName.trim()}
              className="h-8 px-2.5 rounded-lg text-[13px] bg-teal-600 text-white disabled:opacity-40"
            >
              {savingBusy ? <Loader2 size={14} className="animate-spin" /> : 'บันทึก'}
            </button>
            <button onClick={() => setSavingName(null)} className="h-8 px-2.5 rounded-lg text-[13px] border border-gray-200 text-gray-600">ยกเลิก</button>
          </div>
        ) : (
          <button
            onClick={() => saveActive()}
            disabled={savingBusy}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 transition-colors"
            title={activeTab.savedId ? 'บันทึกทับคำสั่งที่เก็บไว้' : 'บันทึกเก็บไว้ในแถบซ้าย'}
          >
            {savingBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {activeTab.savedId ? 'Save' : 'Save as'}
          </button>
        )}
        <button
          onClick={() => setShowSchema(s => !s)}
          className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-medium transition-colors ${showSchema ? 'text-teal-600 bg-teal-50' : 'text-gray-600 hover:bg-gray-100'}`}
          title="Toggle Schema Browser"
        >
          <Table2 size={14} /> Schema
        </button>
        <div className="flex-1" />
        {activeTab.result && !activeTab.result.error && activeTab.result.columns.length > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={exportCsv} className="flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-medium text-gray-500 hover:bg-gray-100 transition-colors" title="Export CSV">
              <Download size={11} /> CSV
            </button>
            <button onClick={exportXlsx} className="flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-medium text-gray-500 hover:bg-gray-100 transition-colors" title="Export XLSX">
              <Download size={11} /> XLSX
            </button>
          </div>
        )}
        {activeTab.result?.time != null && (
          <span className="text-[10px] text-gray-400 ml-1">{activeTab.result.time}ms</span>
        )}
      </div>

      {/* Query tabs — only worth a row when more than one is open */}
      {tabs.length > 1 && (
      <div className="flex-shrink-0 bg-gray-50 border-b border-gray-200 flex items-center gap-0 px-2 overflow-x-auto">
        {tabs.map(tab => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium cursor-pointer border-b-2 transition-colors whitespace-nowrap ${
              activeTabId === tab.id
                ? 'border-teal-500 text-teal-700 bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Terminal size={10} className={activeTabId === tab.id ? 'text-teal-500' : 'text-gray-400'} />
            {tab.name}
            {tab.running && <Loader2 size={10} className="animate-spin text-teal-500" />}
            {tabs.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                className="ml-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-opacity"
              >
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button onClick={addTab} className="p-1 text-gray-400 hover:text-teal-600 hover:bg-gray-100 rounded transition-colors ml-1" title="New Tab">
          <Plus size={12} />
        </button>
      </div>
      )}

      {/* Main area: schema browser + editor + results */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: the schema browser (saved SQL lives in the tables panel) */}
        {showSchema && (
          <div className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
            {!connId ? (
              <div className="px-3 py-6 text-center text-[11px] text-gray-400">เลือก Connection ก่อน</div>
            ) : (
              <>
            <div className="px-2 py-2 border-b border-gray-100">
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  className="w-full pl-7 pr-2 py-1 text-[11px] border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-teal-500 bg-gray-50"
                  placeholder="Filter tables..."
                  value={schemaSearch}
                  onChange={e => setSchemaSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {schemaLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 size={14} className="animate-spin text-teal-400" />
                </div>
              ) : filteredSchema.length === 0 ? (
                <div className="text-center py-6 text-[11px] text-gray-400">No tables found</div>
              ) : (
                filteredSchema.map(tbl => (
                  <div key={tbl.name}>
                    <div
                      className="flex items-center gap-1 px-2 py-1 hover:bg-gray-50 cursor-pointer group transition-colors"
                      onClick={() => toggleTableExpand(tbl.name)}
                      onDoubleClick={() => insertTableName(tbl.name)}
                      title="Double-click to insert, click to expand"
                    >
                      <span className="w-3 flex-shrink-0 text-gray-400">
                        {tbl.expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </span>
                      <Table2 size={10} className="text-blue-400 flex-shrink-0" />
                      <span className="flex-1 text-[11px] font-mono text-gray-700 truncate">{tbl.name}</span>
                      <button
                        onClick={e => { e.stopPropagation(); insertTableName(tbl.name); }}
                        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-teal-600 p-0.5 transition-opacity"
                        title="Insert table name"
                      >
                        <Plus size={9} />
                      </button>
                    </div>
                    {tbl.expanded && tbl.loading && (
                      <div className="ml-5 border-l border-gray-100 px-2 py-1 text-[10px] text-gray-400 flex items-center gap-1">
                        <Loader2 size={9} className="animate-spin" /> reading columns…
                      </div>
                    )}
                    {tbl.expanded && tbl.error && (
                      <div className="ml-5 border-l border-gray-100 px-2 py-1 text-[10px] text-red-500" title={tbl.error}>
                        {tbl.error}
                      </div>
                    )}
                    {tbl.expanded && tbl.columns && (
                      <div className="ml-5 border-l border-gray-100">
                        {tbl.columns.length === 0 && (
                          <div className="px-2 py-1 text-[10px] text-gray-400">no columns</div>
                        )}
                        {tbl.columns.map(col => (
                          <div
                            key={col.name}
                            className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] hover:bg-gray-50 cursor-pointer transition-colors"
                            onClick={() => insertTableName(col.name)}
                            title={`${col.type} - Click to insert`}
                          >
                            <Hash size={8} className="text-gray-300 flex-shrink-0" />
                            <span className="text-gray-600 font-mono truncate">{col.name}</span>
                            <span className="text-gray-400 text-[9px] ml-auto flex-shrink-0">{col.type}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
              </>
            )}
          </div>
        )}

        {/* Editor + Results split */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* SQL Editor with line numbers */}
          <div className="flex-shrink-0 border-b border-gray-700" style={{ height: '40%', minHeight: 120 }}>
            <div className="h-full flex bg-gray-900 overflow-hidden">
              {/* Line numbers gutter */}
              <div className="flex-shrink-0 w-10 bg-gray-800 text-right pr-2 pt-3 pb-3 overflow-hidden select-none">
                {Array.from({ length: Math.max(lineCount, 10) }, (_, i) => (
                  <div key={i} className="text-[11px] leading-[1.375rem] text-gray-600 font-mono">{i + 1}</div>
                ))}
              </div>
              {/* Textarea */}
              <textarea
                ref={textareaRef}
                className="flex-1 bg-gray-900 text-green-400 text-xs font-mono p-3 resize-none focus:outline-none leading-[1.375rem] placeholder-gray-600"
                value={activeTab.sql}
                onChange={e => updateTab(activeTab.id, { sql: e.target.value })}
                onKeyDown={handleKeyDown}
                placeholder="-- Write your SQL here...&#10;-- Ctrl+Enter to run, Ctrl+Shift+Enter to run selection"
                spellCheck={false}
              />
            </div>
          </div>

          {/* Results area */}
          <div className="flex-1 flex flex-col overflow-hidden bg-white">
            {/* Results/Messages tabs */}
            <div className="flex-shrink-0 flex items-center gap-0 px-3 border-b border-gray-200 bg-gray-50">
              <button
                onClick={() => updateTab(activeTab.id, { resultTab: 'results' })}
                className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                  activeTab.resultTab === 'results' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Table2 size={10} className="inline mr-1 -mt-0.5" />
                Results
                {activeTab.result && !activeTab.result.error && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">{activeTab.result.rowCount ?? 0}</span>
                )}
              </button>
              <button
                onClick={() => updateTab(activeTab.id, { resultTab: 'messages' })}
                className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                  activeTab.resultTab === 'messages' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Terminal size={10} className="inline mr-1 -mt-0.5" />
                Messages
                {activeTab.messages.length > 0 && activeTab.result?.error && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                )}
              </button>
              <div className="flex-1" />
              {activeTab.result?.time != null && (
                <span className="text-[10px] text-gray-400">
                  <Clock size={9} className="inline mr-0.5 -mt-0.5" />
                  {activeTab.result.time}ms &middot; {activeTab.result.rowCount ?? 0} rows
                </span>
              )}
            </div>

            {/* Results content */}
            <div className="flex-1 overflow-auto">
              {activeTab.resultTab === 'messages' ? (
                /* Messages tab */
                <div className="p-3 font-mono text-xs space-y-1">
                  {activeTab.messages.length === 0 ? (
                    <div className="text-gray-400 text-center py-8">No messages</div>
                  ) : (
                    activeTab.messages.map((msg, i) => (
                      <div key={i} className={`px-2 py-1 rounded ${msg.startsWith('Error') ? 'text-red-600 bg-red-50' : 'text-gray-700 bg-gray-50'}`}>
                        {msg}
                      </div>
                    ))
                  )}
                </div>
              ) : activeTab.running ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={20} className="animate-spin text-teal-400" />
                  <span className="ml-2 text-xs text-gray-400">Executing query...</span>
                </div>
              ) : activeTab.result?.error ? (
                <div className="px-4 py-3 text-xs text-red-600 bg-red-50 flex items-start gap-2 m-3 rounded-lg">
                  <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                  <pre className="whitespace-pre-wrap font-mono">{activeTab.result.error}</pre>
                </div>
              ) : activeTab.result && activeTab.result.columns.length > 0 ? (
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-gray-50 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-400 border-b border-gray-200 w-10 text-[10px]">#</th>
                      {activeTab.result.columns.map(col => (
                        <th key={col.name} className="px-3 py-2 text-left font-medium text-gray-600 border-b border-gray-200 whitespace-nowrap text-[11px]">{col.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeTab.result.rows.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-100 hover:bg-blue-50/30 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}>
                        <td className="px-3 py-1.5 text-[10px] text-gray-400">{i + 1}</td>
                        {activeTab.result!.columns.map(col => (
                          <td key={col.name} className="px-3 py-1.5 text-gray-700 whitespace-nowrap max-w-[300px] truncate font-mono text-[11px]">
                            {row[col.name] === null ? <span className="text-gray-300 italic">NULL</span> : String(row[col.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Database size={28} className="mb-2 opacity-20" />
                  <p className="text-xs font-medium">Run a query to see results</p>
                  <p className="text-[10px] text-gray-300 mt-1.5">Ctrl+Enter to execute &middot; Ctrl+Shift+Enter for selection</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Import Mapping Modal ─────────────────────────────────────────────────
 * Shows after the user picks a file. Lets them map each DB column to either:
 *   • a file column (auto-matched on name)
 *   • a static default value
 *   • skip (leave NULL)
 * Pre-fills from the last-saved mapping on the server.
 */
type ColMap = Record<string, { source: 'file' | 'default' | 'skip'; fileCol?: string; defaultValue?: any }>;

interface ImportMappingModalProps {
  tableId: string;
  tableName: string;
  rowCount: number;
  file: File;
  fileColumns: string[];
  sampleRow: Record<string, any>;
  dbColumns: { name: string; type: string }[];
  mode: 'append' | 'replace' | 'merge';
  onCancel: () => void;
  onConfirm: (mode: 'append' | 'replace' | 'merge', mapping: ColMap, mergeKeys: string[], addColumns: NewCol[]) => void;
}

// User-defined new destination columns to be created via ALTER TABLE before
// the import inserts rows. The chosen type is sent verbatim to the engine.
type NewCol = { name: string; type: string };

function ImportMappingModal(props: ImportMappingModalProps) {
  const { tableId, tableName, rowCount, file, fileColumns, sampleRow, dbColumns, mode: initialMode, onCancel, onConfirm } = props;
  const [mode, setMode] = useState<'append' | 'replace' | 'merge'>(initialMode);
  const [mapping, setMapping] = useState<ColMap>({});
  const [mergeKeys, setMergeKeys] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [loadingPrev, setLoadingPrev] = useState(true);
  // New destination columns the user wants to create (auto-ALTER on submit).
  const [addColumns, setAddColumns] = useState<NewCol[]>([]);
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('VARCHAR2(500)');

  // Common type suggestions — engine-agnostic; user can also type freely.
  const TYPE_PRESETS = [
    'VARCHAR2(50)', 'VARCHAR2(255)', 'VARCHAR2(500)', 'VARCHAR2(4000)',
    'NUMBER', 'NUMBER(10)', 'NUMBER(10,2)', 'INTEGER',
    'DATE', 'TIMESTAMP', 'CLOB',
    'VARCHAR(255)', 'TEXT', 'BOOLEAN',
  ];

  // Effective dbColumns shown in the mapping table = real ones + user-added (new)
  const dbColumnsAll: { name: string; type: string; isNew?: boolean }[] = [
    ...dbColumns,
    ...addColumns.map(c => ({ name: c.name, type: c.type, isNew: true })),
  ];

  // Build auto-mapping: exact match → case-insensitive → trimmed/snake-case match
  const autoMap = (): ColMap => {
    const m: ColMap = {};
    const lcFile = new Map(fileColumns.map(c => [c.toLowerCase().replace(/[\s_-]/g, ''), c]));
    for (const db of dbColumns) {
      const exact = fileColumns.find(c => c === db.name);
      if (exact) { m[db.name] = { source: 'file', fileCol: exact }; continue; }
      const ci = fileColumns.find(c => c.toLowerCase() === db.name.toLowerCase());
      if (ci) { m[db.name] = { source: 'file', fileCol: ci }; continue; }
      const fuzzy = lcFile.get(db.name.toLowerCase().replace(/[\s_-]/g, ''));
      if (fuzzy) { m[db.name] = { source: 'file', fileCol: fuzzy }; continue; }
      m[db.name] = { source: 'skip' };
    }
    return m;
  };

  // Initial load: fetch last-saved mapping, fall back to auto-map
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const headers = new Headers();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const r = await fetch(`${API_URL}/data-repository/tables/${tableId}/last-import-config`, { headers });
        const j = await r.json();
        if (j.success && j.data && j.data.mapping) {
          // Validate that mapped fileCols still exist in this file
          const saved: ColMap = j.data.mapping;
          const fileColSet = new Set(fileColumns);
          const cleaned: ColMap = {};
          for (const db of dbColumns) {
            const s = saved[db.name];
            if (s && s.source === 'file' && s.fileCol && fileColSet.has(s.fileCol)) {
              cleaned[db.name] = s;
            } else if (s && s.source === 'default') {
              cleaned[db.name] = s;
            } else if (s && s.source === 'skip') {
              cleaned[db.name] = s;
            }
          }
          // Auto-map anything that wasn't in saved config
          const auto = autoMap();
          for (const db of dbColumns) {
            if (!cleaned[db.name]) cleaned[db.name] = auto[db.name];
          }
          setMapping(cleaned);
          // Restore saved mergeKeys if present
          if (Array.isArray(j.data.mergeKeys)) {
            const valid = j.data.mergeKeys.filter((k: string) => dbColumns.some(c => c.name === k));
            setMergeKeys(valid);
          }
        } else {
          setMapping(autoMap());
        }
      } catch {
        setMapping(autoMap());
      } finally {
        setLoadingPrev(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOne = (dbCol: string, change: Partial<ColMap[string]>) => {
    setMapping(prev => ({ ...prev, [dbCol]: { ...(prev[dbCol] || { source: 'skip' }), ...change } as any }));
  };

  const stats = {
    file: Object.values(mapping).filter(m => m.source === 'file').length,
    def: Object.values(mapping).filter(m => m.source === 'default').length,
    skip: Object.values(mapping).filter(m => m.source === 'skip').length,
  };

  // File columns that aren't referenced by any DB column → silently dropped.
  // Show them so the user knows what's being ignored.
  const mappedFileCols = new Set(
    Object.values(mapping)
      .filter(m => m.source === 'file' && m.fileCol)
      .map(m => (m.fileCol as string).toLowerCase())
  );
  const ignoredFileCols = fileColumns.filter(c => !mappedFileCols.has(c.toLowerCase()));

  const filtered = filter
    ? dbColumnsAll.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    : dbColumnsAll;

  const addNewCol = () => {
    const name = newColName.trim().toUpperCase();
    const type = newColType.trim();
    if (!name || !type) return;
    if (dbColumnsAll.some(c => c.name.toUpperCase() === name)) return; // dup
    setAddColumns(prev => [...prev, { name, type }]);
    // Pre-map it to a file column with matching name (case-insensitive) if any
    const match = fileColumns.find(c => c.toLowerCase() === name.toLowerCase());
    setMapping(prev => ({
      ...prev,
      [name]: match ? { source: 'file', fileCol: match } : { source: 'skip' },
    }));
    setNewColName('');
    setNewColType('VARCHAR2(500)');
  };

  const removeNewCol = (colName: string) => {
    setAddColumns(prev => prev.filter(c => c.name !== colName));
    setMapping(prev => { const n = { ...prev }; delete n[colName]; return n; });
  };

  const submit = () => {
    // Strip "skip" entries from the payload (server will treat missing as NULL)
    const out: ColMap = {};
    for (const [k, v] of Object.entries(mapping)) {
      if (v && v.source !== 'skip') out[k] = v;
    }
    onConfirm(mode, out, mergeKeys, addColumns);
  };

  const toggleMergeKey = (col: string) => {
    setMergeKeys(prev => prev.includes(col) ? prev.filter(k => k !== col) : [...prev, col]);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2">
      <div className="bg-white rounded-lg shadow-xl w-[96vw] max-w-[1500px] h-[94vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Upload size={20} className="text-blue-600" />
              Import to <code className="bg-gray-100 px-2 py-0.5 rounded text-lg">{tableName}</code>
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              File: <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)} KB · table currently has {rowCount.toLocaleString()} row(s)
            </p>
          </div>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded"><X size={20} /></button>
        </div>

        {/* Mode selector — replaces the old browser prompt() */}
        <div className="px-6 py-3 bg-blue-50/50 border-b">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-700">Import mode:</span>
            <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setMode('append')}
                className={`inline-flex items-center justify-center px-3.5 h-9 ${mode === 'append' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} whitespace-nowrap`}
              >
                Append
              </button>
              <button
                type="button"
                onClick={() => setMode('merge')}
                className={`inline-flex items-center justify-center px-3.5 h-9 border-l border-gray-300 ${mode === 'merge' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} whitespace-nowrap`}
              >
                Merge by key
              </button>
              <button
                type="button"
                onClick={() => setMode('replace')}
                className={`inline-flex items-center justify-center px-3.5 h-9 border-l border-gray-300 ${mode === 'replace' ? 'bg-red-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} whitespace-nowrap`}
              >
                Replace
              </button>
            </div>
            <span className="text-xs text-gray-600 flex-1">
              {mode === 'append'
                ? '✓ Keep existing rows + schema, add new rows'
                : mode === 'merge'
                  ? '↻ DELETE rows matching key tuples then INSERT (upsert per row)'
                  : '⚠ DELETE rows matching key tuples then INSERT (bulk replace)'}
            </span>
          </div>

          {/* Key picker — required for both Merge and Replace */}
          {(mode === 'merge' || mode === 'replace') && (
            <div className="mt-2 pt-2 border-t border-blue-100">
              <div className="text-xs font-medium text-gray-700 mb-1.5">
                Match by (key column{mergeKeys.length !== 1 ? 's' : ''}):
                {mergeKeys.length === 0 && <span className="text-red-600 ml-2">⚠ Pick at least 1 to {mode === 'merge' ? 'merge' : 'replace'} safely</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dbColumns.map(c => {
                  const sel = mergeKeys.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => toggleMergeKey(c.name)}
                      className={`text-[11px] px-2 py-0.5 rounded border ${
                        sel
                          ? mode === 'merge'
                            ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                            : 'bg-red-100 border-red-400 text-red-800 font-medium'
                          : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {sel && '✓ '}{c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Toolbar */}
        <div className="px-6 py-2.5 bg-gray-50 border-b flex items-center gap-4 text-sm flex-wrap">
          <span className="text-gray-600">DB columns: <strong>{dbColumns.length}</strong>{addColumns.length > 0 && <span className="text-emerald-700"> (+{addColumns.length} new)</span>}</span>
          <span className="text-gray-400">·</span>
          <span className="text-green-700">from file: <strong>{stats.file}</strong></span>
          <span className="text-amber-700">default: <strong>{stats.def}</strong></span>
          <span className="text-gray-500">skip: <strong>{stats.skip}</strong></span>
          <button onClick={() => setMapping(autoMap())}
            className="inline-flex items-center justify-center ml-auto px-3 h-8 text-[13px] bg-white border rounded hover:bg-gray-50 whitespace-nowrap">
            Auto-map all
          </button>
          <input
            placeholder="Filter columns…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="px-3 py-1.5 text-sm border rounded w-56"
          />
        </div>

        {/* Ignored file columns — each row has a dropdown: Ignore (default) or
            Create as one of the common types (auto-ALTER on submit). */}
        {ignoredFileCols.length > 0 && (
          <div className="px-6 py-2 bg-amber-50/60 border-b text-xs">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle size={12} className="text-amber-700" />
              <span className="font-semibold text-amber-900">
                {ignoredFileCols.length} file column{ignoredFileCols.length === 1 ? '' : 's'} not in DB
              </span>
              <span className="text-amber-700 text-[11px]">— default is Ignore; pick a type to auto-create the destination column.</span>
            </div>
            <div className="grid grid-cols-[1fr_180px] gap-x-3 gap-y-1 max-h-32 overflow-y-auto">
              {ignoredFileCols.map(fc => {
                const colName = fc.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                const pending = addColumns.find(c => c.name === colName);
                return (
                  <div key={fc} className="contents">
                    <span className="font-mono text-amber-900 truncate self-center" title={fc}>{fc}</span>
                    <select
                      value={pending ? pending.type : '__ignore__'}
                      onChange={e => {
                        const v = e.target.value;
                        if (v === '__ignore__') {
                          // Remove the pending add (if any) and its mapping
                          setAddColumns(prev => prev.filter(c => c.name !== colName));
                          setMapping(prev => { const n = { ...prev }; delete n[colName]; return n; });
                          return;
                        }
                        // Set or replace the pending add with the chosen type
                        setAddColumns(prev => {
                          const without = prev.filter(c => c.name !== colName);
                          return [...without, { name: colName, type: v }];
                        });
                        setMapping(prev => ({ ...prev, [colName]: { source: 'file', fileCol: fc } }));
                      }}
                      className={`text-[11px] border rounded px-2 py-0.5 ${pending ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-white border-amber-200 text-amber-700'}`}
                      title={pending ? `Will ALTER TABLE ADD ${colName} ${pending.type}` : 'File column will be dropped silently'}
                    >
                      <option value="__ignore__">Ignore (drop)</option>
                      <optgroup label="Create new column as…">
                        <option value="VARCHAR2(500)">VARCHAR2(500)</option>
                        <option value="VARCHAR2(50)">VARCHAR2(50)</option>
                        <option value="VARCHAR2(255)">VARCHAR2(255)</option>
                        <option value="VARCHAR2(4000)">VARCHAR2(4000)</option>
                        <option value="CLOB">CLOB</option>
                        <option value="NUMBER">NUMBER</option>
                        <option value="NUMBER(10)">NUMBER(10)</option>
                        <option value="NUMBER(10,2)">NUMBER(10,2)</option>
                        <option value="INTEGER">INTEGER</option>
                        <option value="DATE">DATE</option>
                        <option value="TIMESTAMP">TIMESTAMP</option>
                        <option value="VARCHAR(255)">VARCHAR(255) (PG/MySQL)</option>
                        <option value="TEXT">TEXT (PG/MySQL)</option>
                        <option value="BOOLEAN">BOOLEAN (PG)</option>
                      </optgroup>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* + Create new destination column — runs ALTER TABLE before insert */}
        <div className="px-6 py-2 bg-emerald-50/40 border-b">
          <form
            onSubmit={(e) => { e.preventDefault(); addNewCol(); }}
            className="flex items-center gap-2 text-xs flex-wrap"
          >
            <span className="font-semibold text-emerald-800 flex items-center gap-1">
              <Plus size={12} /> Create new destination column:
            </span>
            <input
              value={newColName}
              onChange={e => setNewColName(e.target.value)}
              placeholder="column name (e.g. RECORD_ID)"
              className="px-2 py-1 border border-emerald-300 rounded text-xs uppercase tracking-wide w-56 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              maxLength={64}
            />
            <input
              list="col-type-presets"
              value={newColType}
              onChange={e => setNewColType(e.target.value)}
              placeholder="VARCHAR2(500)"
              className="px-2 py-1 border border-emerald-300 rounded text-xs w-40 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <datalist id="col-type-presets">
              {TYPE_PRESETS.map(t => <option key={t} value={t} />)}
            </datalist>
            <button
              type="submit"
              disabled={!newColName.trim() || !newColType.trim() || dbColumnsAll.some(c => c.name.toUpperCase() === newColName.trim().toUpperCase())}
              className="inline-flex items-center justify-center px-3 h-8 text-[13px] bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Add
            </button>
            <span className="text-[11px] text-gray-500 italic">Server will <code className="bg-white px-1 rounded">ALTER TABLE ADD</code> before insert. Duplicates are skipped.</span>
          </form>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loadingPrev ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading last mapping…
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white border-b text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 w-1/4">DB column</th>
                  <th className="text-left px-2 py-2 w-32">Source</th>
                  <th className="text-left px-2 py-2 w-1/4">File column / default</th>
                  <th className="text-left px-2 py-2">Sample value</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(db => {
                  const m = mapping[db.name] || { source: 'skip' };
                  const sample = m.source === 'file' && m.fileCol ? String(sampleRow[m.fileCol] ?? '') : '';
                  const isNew = (db as any).isNew === true;
                  return (
                    <tr key={db.name} className={`border-b hover:bg-gray-50 ${isNew ? 'bg-emerald-50/40' : ''}`}>
                      <td className="px-4 py-1.5 align-middle">
                        <div className="font-medium flex items-center gap-1.5">
                          {db.name}
                          {isNew && (
                            <>
                              <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-600 text-white">NEW</span>
                              <button
                                onClick={() => removeNewCol(db.name)}
                                className="ml-auto text-gray-300 hover:text-red-600 p-0.5"
                                title="Remove this pending new column"
                              >
                                <X size={11} />
                              </button>
                            </>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-400 font-mono">{db.type}</div>
                      </td>
                      <td className="px-2 py-1.5 align-middle">
                        <select
                          value={m.source}
                          onChange={e => setOne(db.name, { source: e.target.value as any })}
                          className={`text-xs border rounded px-2 py-1 w-full ${
                            m.source === 'file' ? 'bg-green-50' :
                            m.source === 'default' ? 'bg-amber-50' :
                            'bg-gray-50 text-gray-500'
                          }`}
                        >
                          <option value="file">From file</option>
                          <option value="default">Default value</option>
                          <option value="skip">Skip (NULL)</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 align-middle">
                        {m.source === 'file' ? (
                          <select
                            value={m.fileCol || ''}
                            onChange={e => setOne(db.name, { fileCol: e.target.value })}
                            className="text-xs border rounded px-2 py-1 w-full"
                          >
                            <option value="">(pick…)</option>
                            {fileColumns.map(fc => <option key={fc} value={fc}>{fc}</option>)}
                          </select>
                        ) : m.source === 'default' ? (
                          (() => {
                            // Preset templates resolved at import time on the server.
                            const PRESETS: { value: string; label: string; hint: string }[] = [
                              { value: '{{execution_id}}', label: 'Execution ID', hint: 'this import run id (cuid)' },
                              { value: '{{cuid}}',         label: 'New CUID (per row)', hint: 'unique id per row' },
                              { value: '{{uuid}}',         label: 'New UUID (per row)', hint: 'RFC 4122 v4' },
                              { value: '{{sysdate}}',      label: 'SYSDATE',           hint: 'server time (ISO)' },
                              { value: '{{now:date}}',     label: 'Today date',        hint: 'YYYY-MM-DD' },
                              { value: '{{now}}',          label: 'Now (ISO timestamp)', hint: 'full ISO string' },
                              { value: '{{user}}',         label: 'Import user',       hint: 'who triggered' },
                              { value: '{{table_id}}',     label: 'Table ID',          hint: 'this repo table id' },
                              { value: '{{table_name}}',   label: 'Table name',        hint: 'this repo table name' },
                            ];
                            const v: string = m.defaultValue ?? '';
                            const preset = PRESETS.find(p => p.value === v);
                            const isCustom = v !== '' && !preset;
                            return (
                              <div className="flex items-center gap-1">
                                <select
                                  value={preset ? preset.value : (isCustom ? '__custom__' : '')}
                                  onChange={e => {
                                    const sv = e.target.value;
                                    if (sv === '') setOne(db.name, { defaultValue: '' });
                                    else if (sv === '__custom__') setOne(db.name, { defaultValue: ' ' }); // trigger custom mode
                                    else setOne(db.name, { defaultValue: sv });
                                  }}
                                  className="text-xs border rounded px-2 py-1 bg-white max-w-[180px]"
                                  title="Pick a preset value, or choose Custom to type your own"
                                >
                                  <option value="">— pick —</option>
                                  <optgroup label="Auto-generated">
                                    {PRESETS.map(p => (
                                      <option key={p.value} value={p.value} title={p.hint}>{p.label}</option>
                                    ))}
                                  </optgroup>
                                  <option value="__custom__">Custom value…</option>
                                </select>
                                {isCustom && (
                                  <input
                                    type="text"
                                    autoFocus={v === ' '}
                                    value={v === ' ' ? '' : v}
                                    onChange={e => setOne(db.name, { defaultValue: e.target.value })}
                                    placeholder="e.g. 2569, SRC_A, …"
                                    className="text-xs border rounded px-2 py-1 flex-1 min-w-0"
                                  />
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          <span className="text-xs text-gray-400 italic">NULL</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-gray-500 truncate max-w-[300px] align-middle">
                        {m.source === 'default' && m.defaultValue !== undefined && m.defaultValue !== ''
                          ? <span className="text-amber-700">= {String(m.defaultValue)}</span>
                          : sample
                            ? <span className="font-mono">{sample.substring(0, 80)}</span>
                            : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No matching columns</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-gray-50 border-t flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Mapping will be saved for next-time import
          </span>
          <div className="flex gap-2">
            <button onClick={onCancel}
              className="inline-flex items-center justify-center px-3 h-9 text-[14px] border rounded hover:bg-white whitespace-nowrap">
              Cancel
            </button>
            <button onClick={submit}
              disabled={loadingPrev || stats.file + stats.def === 0 || ((mode === 'merge' || mode === 'replace') && mergeKeys.length === 0)}
              className="px-3 h-9 text-[14px] disabled:cursor-not-allowed rounded inline-flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
              <Upload size={14} /> {
                mode === 'merge'   ? `Merge by ${mergeKeys.length} key(s)`
                : mode === 'replace' ? `Replace by ${mergeKeys.length} key(s)`
                                     : `Import ${stats.file + stats.def} field(s)`
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Clear-by-Conditions Modal ────────────────────────────────────────────
 * List of conditions, each is (column + values).
 * All conditions are joined with AND. Within one condition, values are OR'd (IN).
 *
 * Example: 2 conditions, will produce:
 *   DELETE WHERE SOURCE IN ('SRC_A','SRC_B') AND FYEAR IN ('2567')
 *
 * Each condition card has its own column dropdown + values textarea + chip picker.
 */

interface Condition {
  id: string;
  column: string;
  valuesText: string;
}

interface ClearByKeyModalProps {
  tableId: string;
  tableName: string;
  rowCount: number;
  dbColumns: { name: string; type: string }[];
  onCancel: () => void;
  // Generalized: caller passes whatever payload it needs to the backend.
  // We pass conditions array so backend can build the AND/IN SQL.
  onConfirmConditions: (conditions: { column: string; values: any[] }[]) => void;
}

function ClearByKeyModal(props: ClearByKeyModalProps) {
  const { tableId, tableName, rowCount, dbColumns, onCancel, onConfirmConditions } = props;
  const [conditions, setConditions] = useState<Condition[]>([
    { id: `c-${Date.now()}`, column: '', valuesText: '' },
  ]);

  const updateCondition = (id: string, patch: Partial<Condition>) => {
    setConditions(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  };
  const addCondition = () => {
    setConditions(prev => [...prev, { id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, column: '', valuesText: '' }]);
  };
  const removeCondition = (id: string) => {
    setConditions(prev => prev.length <= 1 ? prev : prev.filter(c => c.id !== id));
  };

  // Parse each condition into {column, values[]}
  const parsedConditions = conditions.map(c => ({
    column: c.column,
    values: c.valuesText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).filter((v, i, a) => a.indexOf(v) === i),
  }));

  const validConditions = parsedConditions.filter(c => c.column && c.values.length > 0);
  const canSubmit = validConditions.length > 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-3xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2 text-gray-900">
              <Eraser size={18} className="text-orange-600" />
              ลบข้อมูลจาก <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">{tableName}</code>
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              ตอนนี้มี {rowCount.toLocaleString()} row · เงื่อนไขทุกข้อจะถูก <strong>AND</strong> กัน
            </p>
          </div>
          <button onClick={onCancel} className="p-1.5 hover:bg-gray-100 rounded"><X size={18} /></button>
        </div>

        {/* Body — list of condition cards */}
        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          {conditions.map((c, idx) => (
            <ConditionCard
              key={c.id}
              index={idx}
              total={conditions.length}
              condition={c}
              tableId={tableId}
              dbColumns={dbColumns}
              onChange={patch => updateCondition(c.id, patch)}
              onRemove={() => removeCondition(c.id)}
            />
          ))}

          <button
            type="button"
            onClick={addCondition}
            className="w-full py-2 text-sm border-2 border-dashed border-gray-300 hover:border-orange-400 hover:bg-orange-50/40 text-gray-500 hover:text-orange-700 rounded-md transition-colors flex items-center justify-center gap-1.5"
          >
            <Plus size={14} /> เพิ่มเงื่อนไข (AND)
          </button>

          {/* SQL preview */}
          {canSubmit && (
            <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
              <div className="text-[11px] text-red-700 font-medium mb-1">⚠ จะลบทุก row ที่ตรงเงื่อนไขทั้งหมด:</div>
              <code className="block text-xs text-red-800 font-mono leading-5">
                DELETE WHERE
                {validConditions.map((c, i) => (
                  <span key={i} className="block pl-3">
                    {i > 0 && <span className="text-red-500 font-bold">AND </span>}
                    <span className="text-orange-700">{c.column}</span>
                    {' '}IN ({c.values.slice(0, 3).map(v => `'${v}'`).join(', ')}{c.values.length > 3 ? `, … +${c.values.length - 3}` : ''})
                  </span>
                ))}
              </code>
              <div className="text-[11px] text-red-700/70 mt-1.5"><strong>ลบจริง — ไม่สามารถกู้คืนได้</strong></div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            {validConditions.length}/{conditions.length} เงื่อนไขพร้อมใช้งาน
          </span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="inline-flex items-center justify-center px-3 h-9 text-[14px] border rounded-lg hover:bg-white whitespace-nowrap">
              ยกเลิก
            </button>
            <button
              onClick={() => onConfirmConditions(validConditions)}
              disabled={!canSubmit}
              className="px-3.5 h-9 text-[14px] bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg inline-flex items-center gap-2 font-medium shadow-sm whitespace-nowrap"
            >
              <Eraser size={14} /> ลบ row ที่ตรงเงื่อนไข
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Single condition card — one column + one set of values
function ConditionCard({
  index, total, condition, tableId, dbColumns, onChange, onRemove,
}: {
  index: number;
  total: number;
  condition: Condition;
  tableId: string;
  dbColumns: { name: string; type: string }[];
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  const [distinctValues, setDistinctValues] = useState<string[]>([]);
  const [distinctLoading, setDistinctLoading] = useState(false);
  const [distinctTotal, setDistinctTotal] = useState(0);
  const [distinctTruncated, setDistinctTruncated] = useState(false);

  useEffect(() => {
    if (!condition.column) { setDistinctValues([]); return; }
    setDistinctLoading(true);
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const headers = new Headers();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const r = await fetch(`${API_URL}/data-repository/tables/${tableId}/distinct?column=${encodeURIComponent(condition.column)}&limit=200`, { headers });
        const j = await r.json();
        if (j.success) {
          setDistinctValues((j.data?.values ?? []).map((v: any) => v === null || v === undefined ? '' : String(v)));
          setDistinctTruncated(!!j.data?.truncated);
          setDistinctTotal(Number(j.data?.totalDistinct ?? 0));
        }
      } catch {/* ignore */}
      finally { setDistinctLoading(false); }
    })();
  }, [condition.column, tableId]);

  const currentValues = condition.valuesText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  const addValue = (v: string) => {
    if (currentValues.includes(v)) return;
    onChange({ valuesText: (condition.valuesText && !condition.valuesText.endsWith('\n') ? condition.valuesText + '\n' : condition.valuesText) + v });
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      {/* Card header */}
      <div className="px-3 py-2 bg-gray-50 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-orange-100 text-orange-700 text-[11px] font-bold">
            {index + 1}
          </span>
          <span className="text-xs font-medium text-gray-700">
            เงื่อนไขที่ {index + 1}
            {index > 0 && <span className="text-orange-600 font-bold ml-2">AND</span>}
          </span>
        </div>
        {total > 1 && (
          <button
            type="button"
            onClick={onRemove}
            className="text-gray-400 hover:text-red-600 hover:bg-red-50 rounded p-1"
            title="ลบเงื่อนไขนี้"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Card body */}
      <div className="p-3 grid grid-cols-12 gap-3">
        {/* Column dropdown */}
        <div className="col-span-4">
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Column</label>
          <select
            value={condition.column}
            onChange={e => onChange({ column: e.target.value, valuesText: '' })}
            className="w-full px-2 py-1.5 text-sm border rounded bg-white focus:border-orange-400 focus:ring-1 focus:ring-orange-200"
          >
            <option value="">— เลือก —</option>
            {dbColumns.map(c => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
          {condition.column && (
            <div className="text-[10px] text-gray-400 mt-1 truncate" title={dbColumns.find(d => d.name === condition.column)?.type || ''}>
              {dbColumns.find(d => d.name === condition.column)?.type || ''}
            </div>
          )}
        </div>

        {/* Values */}
        <div className="col-span-8">
          <label className="block text-[11px] font-medium text-gray-600 mb-1">
            ค่า (IN — 1 ค่าต่อบรรทัด)
            {currentValues.length > 0 && <span className="text-orange-600 ml-1.5">· {currentValues.length} ค่า</span>}
          </label>
          <textarea
            value={condition.valuesText}
            onChange={e => onChange({ valuesText: e.target.value })}
            placeholder={condition.column ? `พิมพ์ค่า หรือคลิก chip ด้านล่าง\nเช่น:\nSRC_A\nBBL` : 'เลือก column ก่อน'}
            disabled={!condition.column}
            rows={3}
            className="w-full px-2 py-1.5 text-xs font-mono border rounded focus:border-orange-400 focus:ring-1 focus:ring-orange-200 disabled:bg-gray-50 disabled:text-gray-400 resize-none"
          />

          {/* Click-to-add chips */}
          {condition.column && (
            <div className="mt-1.5">
              {distinctLoading && distinctValues.length === 0 && (
                <div className="text-[10px] text-gray-400 italic flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> กำลังโหลดค่าที่มีอยู่…
                </div>
              )}
              {!distinctLoading && distinctValues.length === 0 && (
                <div className="text-[10px] text-gray-400 italic">ไม่พบค่าใน column นี้ — พิมพ์ค่าเอง</div>
              )}
              {distinctValues.length > 0 && (
                <>
                  <div className="text-[10px] text-gray-500 mb-1 flex items-center justify-between">
                    <span>คลิกเพื่อเพิ่ม:</span>
                    <span className="text-gray-400">
                      {distinctTruncated ? `200/${distinctTotal.toLocaleString()}` : `${distinctValues.length}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto p-1.5 bg-gray-50 rounded border border-gray-200">
                    {distinctValues.map(v => {
                      const alreadyIn = currentValues.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => addValue(v)}
                          disabled={alreadyIn}
                          className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors max-w-[200px] truncate ${
                            alreadyIn
                              ? 'bg-red-100 border-red-300 text-red-700 cursor-default'
                              : 'bg-white border-gray-300 text-gray-700 hover:border-orange-400 hover:bg-orange-50'
                          }`}
                          title={alreadyIn ? `เพิ่มแล้ว: ${v}` : `เพิ่ม: ${v}`}
                        >
                          {alreadyIn && '✓ '}{v === '' ? '(ว่าง)' : v}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Filter registry editor (Properties tab) ─────────────────────────────────
//
// Edits repo_tables.filter_columns without anyone having to type the
// colon-separated string by hand — though the string is shown too, because the
// same format is used by the Report Studio repository screen and gets copied
// between the two.

function FilterRegistryEditor({ table, columns, onSaved }: {
  table: RepoTable;
  columns: { name: string; type: string }[];
  onSaved: (filterColumns: string) => void;
}) {
  const [draft, setDraft] = useState<FilterSpec[]>(() => parseFilterSpecs(table.filterColumns));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(parseFilterSpecs(table.filterColumns));
    setError('');
    setSaved(false);
  }, [table.id, table.filterColumns]);

  const serialized = serializeFilterSpecs(draft);
  const dirty = serialized !== (table.filterColumns || '');
  const listId = `repo-cols-${table.id}`;

  function update(i: number, patch: Partial<FilterSpec>) {
    setDraft(d => d.map((sp, idx) => idx === i ? { ...sp, ...patch } : sp));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterColumns: serialized }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Save failed');
      onSaved(serialized);
      setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, hint: string, value: string, onChange: (v: string) => void, opts?: { list?: string; placeholder?: string }) => (
    <div className="min-w-0">
      <label className="block text-[10px] font-medium text-gray-500 mb-0.5" title={hint}>{label}</label>
      <input
        list={opts?.list}
        value={value}
        placeholder={opts?.placeholder}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-teal-400 font-mono"
      />
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <datalist id={listId}>
        {columns.map(c => <option key={c.name} value={c.name} />)}
      </datalist>

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <ListFilter size={13} className="text-teal-500" />
          <span className="text-xs font-semibold text-gray-700">Filters on the Data tab</span>
          <span className="text-[10px] text-gray-400">{draft.length} column(s)</span>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-[11px] text-red-500">{error}</span>}
          {saved && !dirty && <span className="text-[11px] text-teal-600 flex items-center gap-1"><Check size={11} /> Saved</span>}
          <button
            onClick={() => setDraft(d => [...d, { column: '', label: '' }])}
            className="text-[11px] px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center gap-1"
          >
            <Plus size={11} /> Add filter
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="text-[13px] px-2.5 h-8 rounded-lg disabled:opacity-40 flex items-center gap-1 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
          </button>
        </div>
      </div>

      {draft.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">
          No filter on this table — the Data tab loads every row.
          <div className="mt-1 text-[11px]">Add one (with a default) for big tables.</div>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {draft.map((sp, i) => (
            <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/40 p-2.5">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                {field('Column', 'Column in this table that gets filtered', sp.column, v => update(i, { column: v }), { list: listId, placeholder: 'DEPT' })}
                {field('Label', 'Shown on the filter field', sp.label, v => update(i, { label: v }), { placeholder: 'Department' })}
                {field('Label source', 'Sibling column with the name, or SCHEMA.TABLE.CODE.NAME', sp.labelSource || '', v => update(i, { labelSource: v }), { placeholder: 'DEPT_NAME' })}
                {field('Options from', 'Small registry table to read the dropdown from: SCHEMA.TABLE.CODE.NAME', sp.optionsFrom || '', v => update(i, { optionsFrom: v }), { placeholder: 'APP.V_DEPT.CODE.NAME' })}
                {field('Narrow by', 'Column in that registry to match the parent filter against', sp.parentColumn || '', v => update(i, { parentColumn: v }), { placeholder: 'PARENT_CODE' })}
                {field('Parent filter', 'Which filter on this screen supplies that value', sp.parentField || '', v => update(i, { parentField: v }), { list: listId, placeholder: 'MIN' })}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mt-2 items-end">
                {field(
                  sp.defaultValue && /\{\{/.test(sp.defaultValue) ? `Default → ${resolveDefaultValue(sp.defaultValue)}` : 'Default',
                  'ค่าที่เลือกไว้ตั้งแต่เปิดจอ — ใส่ค่าคงที่ หรือ {{fy}} = ปีงบปัจจุบัน (2569), {{fy2}} = 2 หลักท้าย (69), บวกลบได้เช่น {{fy2-1}}',
                  sp.defaultValue || '',
                  v => update(i, { defaultValue: v }),
                  { placeholder: '2569 หรือ {{fy2}}' }
                )}
                <div className="lg:col-span-4 text-[10px] text-gray-400 truncate font-mono pb-1" title={serializeFilterSpecs([sp])}>
                  {serializeFilterSpecs([sp])}
                </div>
                <div className="flex justify-end pb-0.5">
                  <button
                    onClick={() => { setDraft(d => d.filter((_, idx) => idx !== i)); setSaved(false); }}
                    className="text-[11px] px-2 py-1 rounded-md text-red-500 hover:bg-red-50 flex items-center gap-1"
                  >
                    <Trash2 size={11} /> Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {serialized && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/60 rounded-b-xl">
          <div className="font-mono text-[10px] text-gray-500 break-all">{serialized}</div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DataRepository() {
  const [showSettings, setShowSettings] = useState(false);
  const [tables, setTables] = useState<RepoTable[]>([]);
  const [folders, setFolders] = useState<RepoFolder[]>([]);
  const [connections, setConnections] = useState<RepoConnection[]>([]);
  const [selectedTable, setSelectedTable] = useState<RepoTable | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  // Only admins share tables; the server enforces the same rule
  const isAdmin = isAdminUser(useCurrentUser());
  const [loading, setLoading] = useState(true);
  // Mobile-friendly sidebar — overlay on phones, always-visible from 640 px (sm)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 640);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const mobile = window.innerWidth < 640;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Create table state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', connectionId: '', folderId: '' });
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  // Create folder state
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderForm, setFolderForm] = useState({ name: '', parentId: '' });
  const [folderSubmitting, setFolderSubmitting] = useState(false);
  const [folderError, setFolderError] = useState('');

  // Discover existing tables state
  const [discoverConnId, setDiscoverConnId] = useState('');
  const [discoveredTables, setDiscoveredTables] = useState<{ name: string; schema?: string }[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [selectedExisting, setSelectedExisting] = useState<Set<string>>(new Set());
  const [discoverSearch, setDiscoverSearch] = useState('');

  // Import state
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Mapping modal state
  const [mappingModal, setMappingModal] = useState<{
    file: File;
    fileColumns: string[];
    sampleRow: Record<string, any>;
    dbColumns: { name: string; type: string }[];
    mode: 'append' | 'replace' | 'merge';
  } | null>(null);
  // Clear-by-key modal state
  const [clearModal, setClearModal] = useState<{
    table: RepoTable;
    dbColumns: { name: string; type: string }[];
  } | null>(null);

  // Delete states
  const [deleteTarget, setDeleteTarget] = useState<RepoTable | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<RepoFolder | null>(null);

  // Right panel tab state
  // The right side follows what was picked on the left: a table shows Data /
  // Properties, a saved statement shows the SQL editor.
  const [pane, setPane] = useState<'table' | 'sql'>('table');
  const [rightTab, setRightTab] = useState<'data' | 'properties'>('data');

  // Saved SQL — listed in the tables panel, opened in the SQL editor
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [openSavedRequest, setOpenSavedRequest] = useState<SavedQuery | null>(null);
  const [newSqlNonce, setNewSqlNonce] = useState(0);

  const loadSavedQueries = useCallback(async () => {
    try {
      const res = await authFetch(`${API_URL}/data-repository/sql/saved`);
      const json = await res.json();
      if (json.success) setSavedQueries(json.data?.queries ?? []);
    } catch { /* the editor still works without the list */ }
  }, []);

  useEffect(() => { loadSavedQueries(); }, [loadSavedQueries]);

  async function renameSavedQuery(id: string, name: string) {
    if (!name.trim()) return;
    try {
      await authFetch(`${API_URL}/data-repository/sql/saved/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
    } finally { loadSavedQueries(); }
  }

  async function deleteSavedQuery(id: string) {
    try {
      await authFetch(`${API_URL}/data-repository/sql/saved/${id}`, { method: 'DELETE' });
    } finally { loadSavedQueries(); }
  }

  // Table structure state
  const [structureCols, setStructureCols] = useState<{ name: string; type: string; nullable: boolean; length?: number; precision?: number; scale?: number }[]>([]);
  const [structureLoading, setStructureLoading] = useState(false);
  const [structureError, setStructureError] = useState('');
  const [structureEngine, setStructureEngine] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, cRes, fRes] = await Promise.all([
        authFetch(`${API_URL}/data-repository/tables`),
        authFetch(`${API_URL}/data-repository/connections`),
        authFetch(`${API_URL}/data-repository/folders`),
      ]);
      const tJson = await tRes.json();
      const cJson = await cRes.json();
      const fJson = await fRes.json();
      if (tJson.success) setTables(tJson.data?.tables ?? tJson.data ?? []);
      if (cJson.success) {
        const raw = cJson.data?.connections ?? cJson.data ?? [];
        setConnections(raw.map((c: any) => ({ ...c, config: typeof c.config === 'string' ? JSON.parse(c.config) : c.config })));
      }
      if (fJson.success) setFolders(fJson.data?.folders ?? fJson.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Load table structure
  async function loadStructure(tableId: string) {
    setStructureLoading(true);
    setStructureError('');
    setStructureCols([]);
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${tableId}/structure`);
      const json = await res.json();
      if (json.success) {
        if (json.data.error) {
          setStructureError(json.data.error);
        } else {
          setStructureCols(json.data.columns ?? []);
          setStructureEngine(json.data.engine ?? '');
        }
      } else {
        setStructureError(json.error || 'Failed');
      }
    } catch (e: unknown) {
      setStructureError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setStructureLoading(false);
    }
  }

  // The tables tree is an overlay on a narrow window, and it has nothing to do
  // with the SQL editor — it just sat on top of it.
  useEffect(() => {
    if (isMobile && pane === 'sql') setSidebarOpen(false);
  }, [isMobile, pane]);

  // When selecting a table, auto-load structure if on properties tab
  useEffect(() => {
    if (selectedTable && pane === 'table' && rightTab === 'properties') loadStructure(selectedTable.id);
  }, [selectedTable?.id, pane, rightTab]);

  async function handleCreateTable() {
    if (!createForm.name) { setCreateError('Table name is required.'); return; }
    setCreateSubmitting(true);
    setCreateError('');
    try {
      const body: { name: string; description: string; connectionId?: string; folderId?: string } = {
        name: createForm.name, description: createForm.description,
      };
      if (createForm.connectionId) body.connectionId = createForm.connectionId;
      if (createForm.folderId) body.folderId = createForm.folderId;
      const res = await authFetch(`${API_URL}/data-repository/tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setShowCreateModal(false);
      loadAll();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleCreateFolder() {
    if (!folderForm.name) { setFolderError('Folder name is required.'); return; }
    setFolderSubmitting(true);
    setFolderError('');
    try {
      const res = await authFetch(`${API_URL}/data-repository/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderForm.name, parentId: folderForm.parentId || undefined }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      setShowFolderModal(false);
      loadAll();
    } catch (e: unknown) {
      setFolderError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setFolderSubmitting(false);
    }
  }

  async function handleDeleteFolder(f: RepoFolder) {
    const res = await authFetch(`${API_URL}/data-repository/folders/${f.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { setDeleteFolderTarget(null); loadAll(); }
  }

  async function handleRenameFolder(folderId: string, newName: string) {
    await authFetch(`${API_URL}/data-repository/folders/${folderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    loadAll();
  }

  async function handleMoveTable(tableId: string, folderId: string | null) {
    await authFetch(`${API_URL}/data-repository/tables/${tableId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folderId || null }),
    });
    loadAll();
  }

  // Reorder: insert dragged folder right BEFORE target folder.
  // Compute new sortOrder values for dragged + everything after target.
  async function handleReorderFolder(draggedId: string, beforeId: string | null) {
    if (draggedId === beforeId) return;
    // Sort top-level folders by current sortOrder
    const topFolders = [...folders.filter(f => !f.parentId)]
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const dragged = topFolders.find(f => f.id === draggedId);
    if (!dragged) return;
    // Remove dragged then re-insert before target
    const remaining = topFolders.filter(f => f.id !== draggedId);
    let newOrder: RepoFolder[];
    if (beforeId) {
      const targetIdx = remaining.findIndex(f => f.id === beforeId);
      if (targetIdx < 0) return;
      newOrder = [...remaining.slice(0, targetIdx), dragged, ...remaining.slice(targetIdx)];
    } else {
      // null target → append to end
      newOrder = [...remaining, dragged];
    }
    // Persist new sortOrder per folder
    await Promise.all(newOrder.map((f, idx) =>
      authFetch(`${API_URL}/data-repository/folders/${f.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: idx }),
      })
    ));
    loadAll();
  }

  async function handleDiscoverTables(connectionId: string) {
    if (!connectionId) return;
    setDiscoverLoading(true);
    setDiscoverError('');
    setDiscoveredTables([]);
    setSelectedExisting(new Set());
    try {
      const res = await authFetch(`${API_URL}/data-repository/connections/${connectionId}/tables`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      const dbTables: { name: string; schema?: string }[] = json.data?.tables ?? [];
      const existingNames = new Set(tables.map(t => t.name.toUpperCase()));
      const available = dbTables.filter(t => !existingNames.has(t.name.toUpperCase()));
      setDiscoveredTables(available);
      if (available.length === 0 && dbTables.length > 0) {
        setDiscoverError(`All ${dbTables.length} tables are already in the repository.`);
      }
    } catch (e: unknown) {
      setDiscoverError(e instanceof Error ? e.message : 'Failed to discover tables');
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function handleAddExistingTables() {
    if (selectedExisting.size === 0 || !discoverConnId) return;
    setCreateSubmitting(true);
    setCreateError('');
    try {
      const connName = connections.find(c => c.id === discoverConnId)?.name || '';
      for (const tableName of selectedExisting) {
        await authFetch(`${API_URL}/data-repository/tables`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tableName, description: `From ${connName}`, connectionId: discoverConnId, folderId: createForm.folderId || undefined }),
        });
      }
      setShowCreateModal(false);
      loadAll();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleDeleteTable(t: RepoTable) {
    const res = await authFetch(`${API_URL}/data-repository/tables/${t.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      setDeleteTarget(null);
      if (selectedTable?.id === t.id) setSelectedTable(null);
      loadAll();
    }
  }

  // Step 1: file picked → parse client-side, fetch schema, open mapping modal
  // (mode = append vs replace is chosen inside the modal; default depends on whether
  //  the table already has data.)
  async function handleImport(file: File) {
    if (!selectedTable) return;

    const mode: 'append' | 'replace' = selectedTable.rowCount > 0 ? 'append' : 'replace';

    // Parse file headers + sample row using XLSX (works for xlsx, csv, tsv via XLSX.read)
    try {
      const buf = await file.arrayBuffer();
      let fileColumns: string[] = [];
      let sampleRow: Record<string, any> = {};
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) {
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
        if (rows.length > 0) {
          fileColumns = Object.keys(rows[0]);
          sampleRow = rows[0];
        }
      } else if (ext === 'json') {
        const text = new TextDecoder().decode(buf);
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.length > 0) {
          fileColumns = Object.keys(arr[0]);
          sampleRow = arr[0];
        }
      } else {
        setImportResult({ ok: false, msg: `Unsupported file type: .${ext}` });
        return;
      }
      if (fileColumns.length === 0) {
        setImportResult({ ok: false, msg: 'No columns detected in file' });
        return;
      }

      // Fetch the destination DB column list (so we know what we're mapping TO)
      let dbColumns: { name: string; type: string }[] = [];
      try {
        const sr = await authFetch(`${API_URL}/data-repository/tables/${selectedTable.id}/structure`);
        const sj = await sr.json();
        if (sj.success && Array.isArray(sj.data?.columns)) {
          dbColumns = sj.data.columns.map((c: any) => ({ name: c.name, type: c.type || '' }));
        }
      } catch {}
      // Fallback: use stored schema field
      if (dbColumns.length === 0) {
        try {
          const sch = JSON.parse(selectedTable.schema || '[]');
          if (Array.isArray(sch)) dbColumns = sch.map((c: any) => ({ name: c.name, type: c.type || '' }));
        } catch {}
      }
      // Last fallback: use file's columns as DB columns (typical replace mode)
      if (dbColumns.length === 0) {
        dbColumns = fileColumns.map(n => ({ name: n, type: 'TEXT' }));
      }

      setMappingModal({ file, fileColumns, sampleRow, dbColumns, mode });
    } catch (e: any) {
      setImportResult({ ok: false, msg: `Parse error: ${e.message}` });
    }
  }

  // Step 2: user confirmed mapping → upload with mapping JSON
  async function submitImportWithMapping(
    file: File,
    mode: 'append' | 'replace' | 'merge',
    mapping: Record<string, { source: 'file' | 'default' | 'skip'; fileCol?: string; defaultValue?: any }>,
    mergeKeys: string[],
    addColumns: { name: string; type: string }[] = []
  ) {
    if (!selectedTable) return;
    setImportingId(selectedTable.id);
    setImportResult(null);
    setMappingModal(null);
    try {
      const url = uploadB64Url(`${API_URL}/data-repository/tables/${selectedTable.id}/import`, file, {
        mode,
        mapping: JSON.stringify(mapping),
        mergeKeys: mode === 'merge' ? JSON.stringify(mergeKeys) : undefined,
        addColumns: addColumns.length > 0 ? JSON.stringify(addColumns) : undefined,
      });
      const body = await fileToBase64(file);
      const token = localStorage.getItem('token');
      const headers = new Headers({ 'Content-Type': UPLOAD_B64_CONTENT_TYPE });
      if (token) headers.set('Authorization', `Bearer ${token}`);
      // Pass the caller's display name so it lands in the execution log.
      // HTTP headers must be ASCII — percent-encode (server decodes).
      try {
        const u = JSON.parse(localStorage.getItem('user') || 'null');
        const rawName = u?.name || u?.email || '';
        if (rawName) headers.set('X-User-Name', encodeURIComponent(rawName));
      } catch {/* ignore */}
      const res = await fetch(url, { method: 'POST', headers, body });
      const json = await res.json();
      if (json.success) {
        setImportResult({ ok: true, msg: json.data?.message ?? `Import successful (${mode})` });
        loadAll();
        setDataVersion(v => v + 1);
      } else {
        setImportResult({ ok: false, msg: json.error || 'Import failed' });
      }
    } catch {
      setImportResult({ ok: false, msg: 'Upload failed' });
    } finally {
      setImportingId(null);
      setTimeout(() => setImportResult(null), 5000);
    }
  }

  // Clear-by-key: open modal — fetch fresh db columns first
  async function openClearByKey(table: RepoTable) {
    let dbColumns: { name: string; type: string }[] = [];
    try {
      const sr = await authFetch(`${API_URL}/data-repository/tables/${table.id}/structure`);
      const sj = await sr.json();
      if (sj.success && Array.isArray(sj.data?.columns)) {
        dbColumns = sj.data.columns.map((c: any) => ({ name: c.name, type: c.type || '' }));
      }
    } catch {}
    if (dbColumns.length === 0) {
      try {
        const sch = JSON.parse(table.schema || '[]');
        if (Array.isArray(sch)) dbColumns = sch.map((c: any) => ({ name: c.name, type: c.type || '' }));
      } catch {}
    }
    if (dbColumns.length === 0) {
      setImportResult({ ok: false, msg: 'No columns available — import data first' });
      setTimeout(() => setImportResult(null), 5000);
      return;
    }
    setClearModal({ table, dbColumns });
  }

  // Clear-by-conditions: POST to /clear endpoint
  async function submitClearByConditions(conditions: { column: string; values: any[] }[]) {
    if (!clearModal) return;
    const table = clearModal.table;
    setImportingId(table.id);
    setImportResult(null);
    setClearModal(null);
    try {
      const res = await authFetch(`${API_URL}/data-repository/tables/${table.id}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions }),
      });
      const json = await res.json();
      if (json.success) {
        const n = json.data?.rowsDeleted ?? 0;
        setImportResult({ ok: true, msg: `ลบไป ${n.toLocaleString()} row จาก ${table.name}` });
        loadAll();
        setDataVersion(v => v + 1);
      } else {
        setImportResult({ ok: false, msg: json.error || 'Clear failed' });
      }
    } catch {
      setImportResult({ ok: false, msg: 'Clear request failed' });
    } finally {
      setImportingId(null);
      setTimeout(() => setImportResult(null), 6000);
    }
  }

  return (
    // h-full, not h-screen: the page sits inside Layout's <main>, so a full
    // viewport height here overflows by the height of the app header and pushes
    // the pager below the fold.
    <div className="flex flex-col h-full min-h-0 bg-gray-50 overflow-hidden">
      {/* Top bar */}
      <header className="h-12 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-3 sm:px-5">
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(o => !o)}
              className="p-1.5 -ml-1 rounded-md text-gray-500 hover:text-teal-600 hover:bg-teal-50 transition-colors"
              title="Toggle tables sidebar"
            >
              <Menu size={16} />
            </button>
          )}
          <Database size={18} className="text-teal-500 shrink-0" />
          <span className="font-bold text-sm text-gray-800 truncate">Database Tool</span>
        </div>
        {isAdmin && <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-1.5 px-2 sm:px-3 h-8 rounded-lg text-gray-500 hover:text-teal-600 hover:bg-teal-50 text-[13px] font-medium transition-colors shrink-0 whitespace-nowrap"
        >
          <Settings size={14} /> <span className="hidden sm:inline">Settings</span>
        </button>}
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile backdrop */}
        {isMobile && sidebarOpen && (
          <div
            className="absolute inset-0 bg-black/30 z-30"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {/* Left panel: Tree (folders + tables) */}
        <LeftTreePanel
          tables={tables}
          folders={folders}
          selectedTable={selectedTable}
          onSelectTable={(t) => { setSelectedTable(t); setPane('table'); if (isMobile) setSidebarOpen(false); }}
          onCreateTable={() => {
            setCreateForm({ name: '', description: '', connectionId: '', folderId: '' });
            setCreateError('');
            setDiscoverConnId('');
            setDiscoveredTables([]);
            setSelectedExisting(new Set());
            setDiscoverSearch('');
            setShowCreateModal(true);
          }}
          onCreateFolder={() => {
            setFolderForm({ name: '', parentId: '' });
            setFolderError('');
            setShowFolderModal(true);
          }}
          savedQueries={savedQueries}
          canManage={isAdmin}
          onOpenSaved={isAdmin ? (q => { setOpenSavedRequest(q); setPane('sql'); if (isMobile) setSidebarOpen(false); }) : undefined}
          onRenameSaved={renameSavedQuery}
          onDeleteSaved={deleteSavedQuery}
          onCreateSql={isAdmin ? () => { setPane('sql'); setNewSqlNonce(n => n + 1); if (isMobile) setSidebarOpen(false); } : undefined}
          onDeleteFolder={f => setDeleteFolderTarget(f)}
          onMoveTable={handleMoveTable}
          onRenameFolder={handleRenameFolder}
          onReorderFolder={handleReorderFolder}
          loading={loading}
          isMobile={isMobile}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Right panel */}
        <main className="flex-1 overflow-hidden flex flex-col min-w-0">
          {/* Tab bar — only for a table; the SQL pane puts its own controls on
              one row instead of spending a second row on a tab bar. */}
          {pane === 'table' && (
          <div className="flex-shrink-0 bg-white border-b border-gray-200 flex items-center gap-0 px-2 sm:px-4 overflow-x-auto">
              <>
                <button
                  onClick={() => setRightTab('data')}
                  className={`shrink-0 whitespace-nowrap px-3 py-2 text-xs font-medium border-b-2 transition-colors ${rightTab === 'data' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                  <Table2 size={12} className="inline mr-1 -mt-0.5" /> Data
                </button>
                <button
                  onClick={() => setRightTab('properties')}
                  className={`shrink-0 whitespace-nowrap px-3 py-2 text-xs font-medium border-b-2 transition-colors ${rightTab === 'properties' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                  <Columns size={12} className="inline mr-1 -mt-0.5" /> Properties
                </button>
              </>
          </div>
          )}

          {pane === 'sql' ? null : rightTab === 'data' ? (
            /* ── Data Tab ── */
            selectedTable ? (
              <div className="flex-1 overflow-hidden flex flex-col min-w-0">
                {/* Table action bar */}
                <div className="flex-shrink-0 px-3 sm:px-5 py-2.5 bg-white border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <Table2 size={14} className="text-teal-500 shrink-0" />
                    <span className="text-sm font-semibold text-gray-900 truncate">{selectedTable.name}</span>
                    {selectedTable.rowCount > 0 && (
                      <span className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded bg-gray-100 shrink-0">
                        {selectedTable.rowCount.toLocaleString()} rows
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="file" accept=".csv,.tsv,.json,.xlsx,.xls,.zip" className="hidden" ref={fileInputRef}
                      onChange={e => { const file = e.target.files?.[0]; if (file) handleImport(file); e.target.value = ''; }}
                    />
                    {/* Import — primary button */}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importingId !== null}
                      title="Import a CSV / Excel / JSON / ZIP file"
                      className="group inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-md text-xs font-semibold text-white
                                 bg-blue-600 hover:bg-blue-700
                                 disabled:bg-gray-300 disabled:cursor-not-allowed
                                 transition-colors"
                    >
                      {importingId ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          <span>Importing…</span>
                        </>
                      ) : (
                        <>
                          <Upload size={13} />
                          <span>Import</span>
                        </>
                      )}
                    </button>

                    {/* Clear by key — outlined orange (label hides on mobile) */}
                    <button
                      onClick={() => openClearByKey(selectedTable)}
                      title="Bulk-delete rows by matching a key column"
                      className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[13px] font-medium
                                 text-orange-700 bg-orange-50 hover:bg-orange-100
                                 ring-1 ring-orange-200 hover:ring-orange-300
                                 transition-all whitespace-nowrap"
                    >
                      <Eraser size={13} />
                      <span className="hidden sm:inline">Clear by key</span>
                    </button>

                    {isAdmin && (
                      <button
                        onClick={() => setShowAccess(true)}
                        title="Who can see this table"
                        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[13px] font-medium text-gray-700 bg-white ring-1 ring-gray-200 hover:bg-gray-50 transition-colors whitespace-nowrap"
                      >
                        <Users size={13} />
                        <span className="hidden sm:inline">Access</span>
                      </button>
                    )}
                    {isAdmin && (
                      <AccessModal
                        isOpen={showAccess}
                        onClose={() => setShowAccess(false)}
                        kind="table"
                        id={selectedTable.id}
                        name={selectedTable.name}
                        canManage
                      />
                    )}

                    {/* Subtle divider */}
                    {isAdmin && <span className="hidden sm:inline-block h-5 w-px bg-gray-200 mx-0.5" />}

                    {/* Delete — ghost icon */}
                    {isAdmin && <button
                      onClick={() => setDeleteTarget(selectedTable)}
                      title="Remove table from this list (does NOT drop the source table)"
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-400
                                 hover:text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>}
                  </div>
                </div>

                {importResult && (
                  <div className={`flex-shrink-0 px-5 py-1.5 text-xs flex items-center gap-2 ${importResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                    {importResult.ok ? <Check size={12} /> : <AlertCircle size={12} />}
                    {importResult.msg}
                    <button onClick={() => setImportResult(null)} className="ml-auto text-gray-400 hover:text-gray-600"><X size={12} /></button>
                  </div>
                )}

                <div className="flex-1 overflow-hidden flex flex-col px-3 sm:px-5 py-3 min-w-0">
                  <TableDataSection
                    table={selectedTable}
                    reloadKey={dataVersion}
                    onRegistryChange={filterColumns => {
                      setSelectedTable(t => t && t.id === selectedTable.id ? { ...t, filterColumns } : t);
                      setTables(ts => ts.map(t => t.id === selectedTable.id ? { ...t, filterColumns } : t));
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                <Database size={40} className="mb-3 opacity-30" />
                <p className="text-sm font-medium">Select a table to view data</p>
                <p className="text-xs mt-1 text-gray-300">Or add a table from the left panel</p>
              </div>
            )
          ) : (
            /* ── Properties Tab ── */
            selectedTable ? (
              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="flex-shrink-0 px-5 py-3 bg-white border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-2">
                    <Table2 size={14} className="text-teal-500" />
                    <span className="text-sm font-semibold text-gray-900">{selectedTable.name}</span>
                    {structureEngine && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{structureEngine}</span>}
                  </div>
                  {selectedTable.description && <p className="text-xs text-gray-500">{selectedTable.description}</p>}
                  <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-400">
                    <span>Connection: <span className="text-gray-600">{connections.find(c => c.id === selectedTable.connectionId)?.name ?? 'None'}</span></span>
                    <span>Columns: <span className="text-gray-600">{structureCols.length}</span></span>
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-5 space-y-5">
                  <FilterRegistryEditor
                    table={selectedTable}
                    columns={structureCols.length > 0 ? structureCols : (() => {
                      try { return JSON.parse(selectedTable.schema || '[]'); } catch { return []; }
                    })()}
                    onSaved={filterColumns => {
                      setSelectedTable(t => t && t.id === selectedTable.id ? { ...t, filterColumns } : t);
                      setTables(ts => ts.map(t => t.id === selectedTable.id ? { ...t, filterColumns } : t));
                    }}
                  />
                  {structureLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 size={20} className="animate-spin text-teal-400" />
                    </div>
                  ) : structureError ? (
                    <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-4 py-3">
                      <AlertCircle size={16} /> {structureError}
                    </div>
                  ) : structureCols.length === 0 ? (
                    <div className="text-center py-16 text-gray-400 text-sm">No columns found</div>
                  ) : (
                    <div className="rounded-xl border border-gray-200 overflow-hidden bg-white shadow-sm">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200">
                            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 w-10">#</th>
                            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-700">Column Name</th>
                            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-700">Data Type</th>
                            <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-700">Nullable</th>
                            <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-700">Length/Precision</th>
                          </tr>
                        </thead>
                        <tbody>
                          {structureCols.map((col, i) => (
                            <tr key={col.name} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                              <td className="px-4 py-2 text-xs text-gray-400">{i + 1}</td>
                              <td className="px-4 py-2">
                                <code className="text-xs font-mono font-medium text-gray-800">{col.name}</code>
                              </td>
                              <td className="px-4 py-2">
                                <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">{col.type}</span>
                              </td>
                              <td className="px-4 py-2 text-center">
                                {col.nullable
                                  ? <span className="text-xs text-gray-400">YES</span>
                                  : <span className="text-xs text-red-500 font-medium">NOT NULL</span>
                                }
                              </td>
                              <td className="px-4 py-2 text-xs text-gray-500">
                                {col.precision != null ? `${col.precision}${col.scale != null ? `,${col.scale}` : ''}` :
                                 col.length != null ? col.length : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                <Columns size={40} className="mb-3 opacity-30" />
                <p className="text-sm font-medium">Select a table to view structure</p>
              </div>
            )
          )}

          {/* The SQL editor stays mounted and is hidden instead: unmounting it
              threw away whatever was typed the moment you looked at the data. */}
          <div className={pane === 'sql' ? 'flex-1 flex flex-col min-h-0 min-w-0' : 'hidden'}>
            <SqlEditorPanel
              connections={connections}
              saved={savedQueries}
              onSavedChanged={loadSavedQueries}
              openRequest={openSavedRequest}
              onOpenHandled={() => setOpenSavedRequest(null)}
              newTabRequest={newSqlNonce}
            />
          </div>
        </main>
      </div>

      {/* Settings modal */}
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); loadAll(); }} />}

      {/* Add Table Modal */}
      {showCreateModal && (
        <Modal title="Add Table" onClose={() => { setShowCreateModal(false); setDiscoverConnId(''); setDiscoveredTables([]); setSelectedExisting(new Set()); setDiscoverSearch(''); setCreateForm({ name: '', description: '', connectionId: '', folderId: '' }); }}>
          <div className="space-y-4">
            {/* Connection selector */}
            <CustomSelect
              label="Connection"
              value={createForm.connectionId}
              onChange={v => {
                setCreateForm(f => ({ ...f, connectionId: v }));
                setDiscoverConnId(v);
                setSelectedExisting(new Set());
                setDiscoverSearch('');
                if (v) handleDiscoverTables(v);
                else setDiscoveredTables([]);
              }}
              placeholder="None (file import only)"
              options={[
                { value: '', label: 'None (file import only)' },
                ...connections.map(c => ({
                  value: c.id,
                  label: c.name,
                  icon: <Database size={14} className={c.type === 'postgresql' ? 'text-blue-500' : c.type === 'mysql' ? 'text-orange-500' : 'text-red-500'} />,
                  description: CONNECTION_TYPE_LABELS[c.type],
                })),
              ]}
            />

            {/* Folder selector */}
            {folders.length > 0 && (
              <CustomSelect
                label="Add to Folder"
                value={createForm.folderId}
                onChange={v => setCreateForm(f => ({ ...f, folderId: v }))}
                placeholder="Root (no folder)"
                options={[
                  { value: '', label: 'Root (no folder)' },
                  ...folders.map(f => ({
                    value: f.id,
                    label: f.name,
                    icon: <FolderOpen size={14} className="text-amber-500" />,
                  })),
                ]}
              />
            )}

            {/* Discover existing tables from connection */}
            {createForm.connectionId && (
              <>
                {discoverLoading && (
                  <div className="flex items-center justify-center py-6 text-gray-400">
                    <Loader2 size={18} className="animate-spin mr-2" /> Discovering tables...
                  </div>
                )}

                {discoverError && (
                  <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                    <AlertCircle size={14} /> {discoverError}
                  </div>
                )}

                {!discoverLoading && discoveredTables.length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Existing Tables</label>
                    <div className="relative">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        className="w-full border border-gray-300 rounded-lg pl-9 pr-3 h-8 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                        placeholder="Search tables..."
                        value={discoverSearch}
                        onChange={e => setDiscoverSearch(e.target.value)}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>{discoveredTables.length} available &middot; {selectedExisting.size} selected</span>
                      <button
                        className="text-teal-600 hover:text-teal-700 font-medium"
                        onClick={() => {
                          const filtered = discoveredTables.filter(t => !discoverSearch || t.name.toLowerCase().includes(discoverSearch.toLowerCase()));
                          setSelectedExisting(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(t => t.name)));
                        }}
                      >
                        {selectedExisting.size === discoveredTables.filter(t => !discoverSearch || t.name.toLowerCase().includes(discoverSearch.toLowerCase())).length ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {discoveredTables
                        .filter(t => !discoverSearch || t.name.toLowerCase().includes(discoverSearch.toLowerCase()))
                        .map(t => (
                          <label
                            key={t.name}
                            className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${selectedExisting.has(t.name) ? 'bg-teal-50' : ''}`}
                          >
                            <input
                              type="checkbox"
                              className="accent-teal-600 w-4 h-4"
                              checked={selectedExisting.has(t.name)}
                              onChange={() => {
                                setSelectedExisting(prev => {
                                  const next = new Set(prev);
                                  if (next.has(t.name)) next.delete(t.name); else next.add(t.name);
                                  return next;
                                });
                              }}
                            />
                            <Table2 size={14} className="text-gray-400 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-gray-800">{t.name}</span>
                              {t.schema && <span className="text-xs text-gray-400 ml-2">{t.schema}</span>}
                            </div>
                          </label>
                        ))
                      }
                    </div>
                  </div>
                )}

                {/* Divider between existing and manual */}
                {!discoverLoading && (
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <div className="flex-1 border-t border-gray-200" />
                    or add manually
                    <div className="flex-1 border-t border-gray-200" />
                  </div>
                )}
              </>
            )}

            {/* Manual table name + description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Table Name {!createForm.connectionId && <span className="text-red-500">*</span>}
              </label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder={createForm.connectionId ? 'Type a table name to add manually...' : 'my_table'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
                rows={2}
                value={createForm.description}
                onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>

            {createError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {createError}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowCreateModal(false)} className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                Cancel
              </button>
              {selectedExisting.size > 0 ? (
                <button
                  onClick={handleAddExistingTables}
                  disabled={createSubmitting}
                  className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                >
                  {createSubmitting && <Loader2 size={14} className="animate-spin" />}
                  Add {selectedExisting.size} Table{selectedExisting.size > 1 ? 's' : ''}
                </button>
              ) : (
                <button
                  onClick={handleCreateTable}
                  disabled={createSubmitting || !createForm.name}
                  className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                >
                  {createSubmitting && <Loader2 size={14} className="animate-spin" />}
                  Add Table
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Create Folder Modal */}
      {showFolderModal && (
        <Modal title="Create Folder" onClose={() => setShowFolderModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Folder Name <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-gray-300 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                value={folderForm.name}
                onChange={e => setFolderForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. RESDB Tables"
                autoFocus
              />
            </div>
            {folders.length > 0 && (
              <CustomSelect
                label="Parent Folder (optional)"
                value={folderForm.parentId}
                onChange={v => setFolderForm(f => ({ ...f, parentId: v }))}
                placeholder="None (root)"
                options={[
                  { value: '', label: 'None (root)', icon: <FolderOpen size={14} className="text-gray-400" /> },
                  ...folders.map(f => ({
                    value: f.id,
                    label: f.name,
                    icon: <FolderOpen size={14} className="text-amber-500" />,
                  })),
                ]}
              />
            )}
            {folderError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {folderError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowFolderModal(false)} className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={folderSubmitting || !folderForm.name}
                className="px-3 h-9 text-[14px] rounded-lg disabled:opacity-60 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {folderSubmitting && <Loader2 size={14} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Table Confirm */}
      {deleteTarget && (
        <ConfirmDialog
          message={`Remove "${deleteTarget.name}" from the list? The actual database table will NOT be affected.`}
          onConfirm={() => handleDeleteTable(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Delete Folder Confirm */}
      {deleteFolderTarget && (
        <ConfirmDialog
          message={`Delete folder "${deleteFolderTarget.name}"? Tables inside will be moved to root.`}
          onConfirm={() => handleDeleteFolder(deleteFolderTarget)}
          onCancel={() => setDeleteFolderTarget(null)}
        />
      )}

      {/* Import column mapping modal */}
      {mappingModal && selectedTable && (
        <ImportMappingModal
          tableId={selectedTable.id}
          tableName={selectedTable.name}
          rowCount={selectedTable.rowCount}
          file={mappingModal.file}
          fileColumns={mappingModal.fileColumns}
          sampleRow={mappingModal.sampleRow}
          dbColumns={mappingModal.dbColumns}
          mode={mappingModal.mode}
          onCancel={() => setMappingModal(null)}
          onConfirm={(mode, mapping, mergeKeys, addColumns) => submitImportWithMapping(mappingModal.file, mode, mapping, mergeKeys, addColumns)}
        />
      )}

      {/* Clear-by-key modal */}
      {clearModal && (
        <ClearByKeyModal
          tableId={clearModal.table.id}
          tableName={clearModal.table.name}
          rowCount={clearModal.table.rowCount}
          dbColumns={clearModal.dbColumns}
          onCancel={() => setClearModal(null)}
          onConfirmConditions={submitClearByConditions}
        />
      )}
    </div>
  );
}
