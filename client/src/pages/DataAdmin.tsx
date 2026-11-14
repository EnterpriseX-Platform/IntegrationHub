import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder, FolderOpen, ChevronRight, ChevronDown,
  Plus, Upload, Database, Table2, RefreshCw, Trash2,
  Check, AlertCircle,
  Download, Copy, Loader2,
  FileUp, Plug, Radio
} from 'lucide-react';
import { API_URL, apiFetch } from '../config/api';

// Auth-aware fetch helper
function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem('token');
  const headers = new Headers(options?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return apiFetch(url, { ...options, headers });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DataFolder {
  id: string;
  name: string;
  slug: string;
  path: string;
  description?: string;
  parentId?: string | null;
  children?: DataFolder[];
  datasets?: DataAdminDataset[];
}

interface DataAdminDataset {
  id: string;
  folderId: string;
  name: string;
  slug: string;
  description?: string;
  sourceType: 'import' | 'connection' | 'api-push';
  connectionId?: string;
  syncSql?: string;
  fieldMask: string;
  rowCount: number;
  lastSyncAt?: string;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError?: string;
  folder?: DataFolder;
}

interface FieldMaskEntry {
  original: string;
  alias: string;
  visible: boolean;
}

interface Connection {
  id: string;
  name: string;
  type: string;
}

// ─── Folder Tree ──────────────────────────────────────────────────────────────

function FolderNode({
  folder,
  level,
  selectedId,
  onSelect,
  onNewFolder,
  onDeleteFolder,
}: {
  folder: DataFolder;
  level: number;
  selectedId: string | null;
  onSelect: (folder: DataFolder) => void;
  onNewFolder: (parentId: string) => void;
  onDeleteFolder: (folder: DataFolder) => void;
}) {
  const [expanded, setExpanded] = useState(level === 0);
  const hasChildren = (folder.children?.length ?? 0) > 0;
  const hasDatasets = (folder.datasets?.length ?? 0) > 0;
  const isSelected = selectedId === folder.id;

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 px-2 rounded cursor-pointer group text-sm ${
          isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100 text-gray-700'
        }`}
        style={{ paddingLeft: `${8 + level * 16}px` }}
        onClick={() => { setExpanded(!expanded); onSelect(folder); }}
      >
        <span className="flex-shrink-0 w-4">
          {hasChildren || hasDatasets
            ? expanded
              ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
              : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
            : null}
        </span>
        {expanded ? <FolderOpen className="h-4 w-4 text-amber-500 flex-shrink-0" /> : <Folder className="h-4 w-4 text-amber-400 flex-shrink-0" />}
        <span className="flex-1 truncate font-medium">{folder.name}</span>
        <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onNewFolder(folder.id); }}
            className="p-0.5 hover:bg-gray-200 rounded"
            title="New subfolder"
          >
            <Plus className="h-3 w-3 text-gray-500" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder); }}
            className="p-0.5 hover:bg-red-100 rounded"
            title="Delete folder"
          >
            <Trash2 className="h-3 w-3 text-red-400" />
          </button>
        </div>
      </div>
      {expanded && (
        <div>
          {folder.datasets?.map(ds => (
            <DatasetItem
              key={ds.id}
              dataset={ds}
              level={level + 1}
              isSelected={selectedId === `ds_${ds.id}`}
              onSelect={() => onSelect({ ...folder, id: `ds_${ds.id}` } as any)}
            />
          ))}
          {folder.children?.map(child => (
            <FolderNode
              key={child.id}
              folder={child}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onNewFolder={onNewFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DatasetItem({ dataset, level, isSelected, onSelect }: {
  dataset: DataAdminDataset;
  level: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const SourceIcon = dataset.sourceType === 'import' ? FileUp : dataset.sourceType === 'connection' ? Plug : Radio;
  return (
    <div
      onClick={onSelect}
      style={{ paddingLeft: `${8 + level * 16 + 20}px` }}
      className={`flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-sm ${
        isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100 text-gray-600'
      }`}
    >
      <Table2 className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" />
      <span className="flex-1 truncate">{dataset.name}</span>
      <span className="text-[12px] text-gray-400 flex-shrink-0 inline-flex items-center gap-1" title={dataset.sourceType}>
        <SourceIcon className="h-3 w-3" /> {dataset.rowCount.toLocaleString()}
      </span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DataAdmin() {
  const [folders, setFolders] = useState<DataFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<DataFolder | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<DataAdminDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'data' | 'columns' | 'import'>('overview');

  // Dataset data preview
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [previewColumns, setPreviewColumns] = useState<string[]>([]);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewWhere, setPreviewWhere] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  // Field mask
  const [fieldMask, setFieldMask] = useState<FieldMaskEntry[]>([]);
  const [fieldMaskDirty, setFieldMaskDirty] = useState(false);
  const [savingMask, setSavingMask] = useState(false);

  // Import
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ rowCount: number; columns: string[] } | null>(null);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync
  const [connections, setConnections] = useState<Connection[]>([]);
  const [syncConnId, setSyncConnId] = useState('');
  const [syncSql, setSyncSql] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');

  // Modals
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderModalParentId, setFolderModalParentId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const [showDatasetModal, setShowDatasetModal] = useState(false);
  const [dsName, setDsName] = useState('');
  const [dsSourceType, setDsSourceType] = useState<'import' | 'connection' | 'api-push'>('import');
  const [savingFolder, setSavingFolder] = useState(false);
  const [savingDs, setSavingDs] = useState(false);

  // Clone modal
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [clonePath, setClonePath] = useState('');
  const [cloning, setCloning] = useState(false);

  const PREVIEW_PAGE_SIZE = 100;

  // ─── Data Loading ─────────────────────────────────────────────────────────

  const loadFolders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/data-admin/folders`);
      const data = await res.json();
      if (data.success) {
        setFolders(buildTree(data.data.folders));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  useEffect(() => {
    authFetch(`${API_URL}/connections`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const dbConns = (d.data?.connections || d.data || []).filter(
            (c: Connection) => ['postgresql', 'mysql', 'oracle', 'sqlite'].some(t => c.type?.includes(t))
          );
          setConnections(dbConns);
        }
      }).catch(() => {});
  }, []);

  /** Build nested tree from flat array using materialized path */
  function buildTree(flat: DataFolder[]): DataFolder[] {
    const map = new Map<string, DataFolder>();
    const roots: DataFolder[] = [];
    for (const f of flat) {
      map.set(f.id, { ...f, children: [], datasets: f.datasets || [] });
    }
    for (const f of map.values()) {
      if (!f.parentId) {
        roots.push(f);
      } else {
        const parent = map.get(f.parentId);
        if (parent) { parent.children = parent.children || []; parent.children.push(f); }
        else roots.push(f);
      }
    }
    return roots;
  }

  function findDataset(_folderId: string, dsId: string): DataAdminDataset | null {
    // Flatten all datasets
    function findInFolders(folderList: DataFolder[]): DataAdminDataset | null {
      for (const f of folderList) {
        const found = (f.datasets || []).find(d => d.id === dsId);
        if (found) return found;
        const childFound = findInFolders(f.children || []);
        if (childFound) return childFound;
      }
      return null;
    }
    return findInFolders(folders);
  }

  // Handle tree node selection
  function handleTreeSelect(node: DataFolder) {
    if (node.id.startsWith('ds_')) {
      const dsId = node.id.replace('ds_', '');
      const ds = findDataset('', dsId);
      if (ds) {
        setSelectedDataset(ds);
        setSelectedFolder(null);
        setTab('overview');
        setImportResult(null);
        setImportError('');
        loadFieldMask(ds);
      }
    } else {
      setSelectedFolder(node);
      setSelectedDataset(null);
    }
  }

  async function loadFieldMask(ds: DataAdminDataset) {
    let mask: FieldMaskEntry[] = [];
    try { mask = JSON.parse(ds.fieldMask || '[]'); } catch { mask = []; }
    setFieldMask(mask);
    setFieldMaskDirty(false);
  }

  async function loadPreview(ds: DataAdminDataset, page = 1, where = '') {
    setPreviewLoading(true);
    try {
      const res = await authFetch(`${API_URL}/data-admin/datasets/${ds.id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: PREVIEW_PAGE_SIZE, offset: (page - 1) * PREVIEW_PAGE_SIZE, where: where || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        setPreviewRows(data.data.rows || []);
        setPreviewTotal(data.data.totalCount ?? 0);
        if (data.data.rows?.length > 0) {
          setPreviewColumns(Object.keys(data.data.rows[0]));
        } else {
          setPreviewColumns([]);
        }
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'data' && selectedDataset) {
      loadPreview(selectedDataset, previewPage, previewWhere);
    }
  }, [tab, selectedDataset, previewPage]);

  // ─── Import ────────────────────────────────────────────────────────────────

  async function handleImport() {
    if (!importFile || !selectedDataset) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', importFile);
      const res = await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}/import`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setImportResult(data.data);
        setImportFile(null);
        await loadFolders();
        // Refresh dataset info
        const dsRes = await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}`);
        const dsData = await dsRes.json();
        if (dsData.success) {
          setSelectedDataset(dsData.data.dataset);
          loadFieldMask(dsData.data.dataset);
        }
      } else {
        setImportError(data.error || 'Import failed');
      }
    } catch (e: any) {
      setImportError(e.message);
    } finally {
      setImporting(false);
    }
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async function handleSync() {
    if (!selectedDataset) return;
    setSyncing(true);
    setSyncError('');
    // Save connection + sql first
    await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: syncConnId, syncSql }),
    });
    const res = await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}/sync`, {
      method: 'POST',
    });
    const data = await res.json();
    if (data.success) {
      setImportResult(data.data);
      await loadFolders();
      const dsRes = await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}`);
      const dsData = await dsRes.json();
      if (dsData.success) { setSelectedDataset(dsData.data.dataset); loadFieldMask(dsData.data.dataset); }
    } else {
      setSyncError(data.error || 'Sync failed');
    }
    setSyncing(false);
  }

  // ─── Field Mask ───────────────────────────────────────────────────────────

  async function saveFieldMask() {
    if (!selectedDataset) return;
    setSavingMask(true);
    await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}/columns`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: fieldMask }),
    });
    setSavingMask(false);
    setFieldMaskDirty(false);
  }

  // ─── Create Folder ────────────────────────────────────────────────────────

  async function createFolder() {
    if (!folderName.trim()) return;
    setSavingFolder(true);
    const res = await authFetch(`${API_URL}/data-admin/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName.trim(), parentId: folderModalParentId }),
    });
    const data = await res.json();
    setSavingFolder(false);
    if (data.success) {
      setShowFolderModal(false);
      setFolderName('');
      await loadFolders();
    }
  }

  // ─── Create Dataset ───────────────────────────────────────────────────────

  async function createDataset() {
    if (!dsName.trim() || !selectedFolder) return;
    setSavingDs(true);
    const folderId = selectedFolder.id.startsWith('ds_') ? '' : selectedFolder.id;
    if (!folderId) { setSavingDs(false); return; }
    const res = await authFetch(`${API_URL}/data-admin/datasets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, name: dsName.trim(), sourceType: dsSourceType }),
    });
    const data = await res.json();
    setSavingDs(false);
    if (data.success) {
      setShowDatasetModal(false);
      setDsName('');
      await loadFolders();
    }
  }

  // ─── Clone ────────────────────────────────────────────────────────────────

  async function handleClone() {
    if (!selectedDataset || !clonePath.trim()) return;
    setCloning(true);
    const res = await authFetch(`${API_URL}/data-admin/datasets/${selectedDataset.id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath: clonePath }),
    });
    const data = await res.json();
    setCloning(false);
    if (data.success) {
      setShowCloneModal(false);
      setClonePath('');
      await loadFolders();
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async function deleteDataset(ds: DataAdminDataset) {
    if (!confirm(`Delete dataset "${ds.name}"? This will permanently delete all data.`)) return;
    await authFetch(`${API_URL}/data-admin/datasets/${ds.id}`, { method: 'DELETE' });
    setSelectedDataset(null);
    await loadFolders();
  }

  async function deleteFolder(folder: DataFolder) {
    if (!confirm(`Delete folder "${folder.name}" and all its contents?`)) return;
    await authFetch(`${API_URL}/data-admin/folders/${folder.id}`, { method: 'DELETE' });
    setSelectedFolder(null);
    await loadFolders();
  }

  // ─── Export CSV ──────────────────────────────────────────────────────────

  function exportCsv() {
    if (previewRows.length === 0) return;
    const cols = previewColumns;
    const header = cols.join(',');
    const rows = previewRows.map(r =>
      cols.map(c => {
        const v = String(r[c] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    );
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedDataset?.name || 'data'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Source badge helper ─────────────────────────────────────────────────

  function sourceTypeBadge(type: string) {
    if (type === 'import') return <span className="px-2 py-0.5 rounded-full text-[12px] bg-blue-100 text-blue-700">Import</span>;
    if (type === 'connection') return <span className="px-2 py-0.5 rounded-full text-[12px] bg-green-100 text-green-700">Live DB</span>;
    return <span className="px-2 py-0.5 rounded-full text-[12px] bg-purple-100 text-purple-700">API Push</span>;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full bg-gray-50">
      {/* Left: Folder Tree */}
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-sm text-gray-900 flex items-center gap-2">
            <Database className="h-4 w-4 text-blue-500" /> Data Admin
          </h2>
          <div className="flex gap-1">
            <button
              onClick={() => { setFolderModalParentId(null); setShowFolderModal(true); }}
              className="p-1 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-700"
              title="New root folder"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button onClick={loadFolders} className="p-1 hover:bg-gray-100 rounded text-gray-500" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto py-2 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
            </div>
          ) : folders.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs px-4">
              No folders yet.<br />Click + to create one.
            </div>
          ) : (
            folders.map(f => (
              <FolderNode
                key={f.id}
                folder={f}
                level={0}
                selectedId={selectedDataset ? `ds_${selectedDataset.id}` : selectedFolder?.id ?? null}
                onSelect={handleTreeSelect}
                onNewFolder={(parentId) => { setFolderModalParentId(parentId); setShowFolderModal(true); }}
                onDeleteFolder={deleteFolder}
              />
            ))
          )}
        </div>
      </div>

      {/* Right: Content panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedDataset && !selectedFolder ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <Database className="h-16 w-16 mx-auto mb-4 text-gray-200" />
              <p className="text-lg font-medium text-gray-500">Data Admin</p>
              <p className="text-sm mt-1">Select a folder or dataset from the tree</p>
              <button
                onClick={() => { setFolderModalParentId(null); setShowFolderModal(true); }}
                className="inline-flex items-center justify-center mt-4 px-3.5 h-9 bg-blue-600 text-white rounded-lg text-[14px] hover:bg-blue-700 whitespace-nowrap"
              >
                Create First Folder
              </button>
            </div>
          </div>
        ) : selectedFolder && !selectedDataset ? (
          /* Folder view */
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                  {selectedFolder.path.split('/').map((seg, i, arr) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <ChevronRight className="h-3 w-3" />}
                      <span className={i === arr.length - 1 ? 'font-semibold text-gray-900' : ''}>{seg}</span>
                    </span>
                  ))}
                </div>
                <p className="text-sm text-gray-500">{selectedFolder.datasets?.length ?? 0} datasets</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowDatasetModal(true)}
                  className="flex items-center gap-2 px-3 h-9 bg-blue-600 text-white rounded-lg text-[14px] hover:bg-blue-700 whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" /> New Dataset
                </button>
              </div>
            </div>
            {(selectedFolder.datasets?.length ?? 0) === 0 ? (
              <div className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center text-gray-400">
                <Table2 className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p>No datasets in this folder</p>
                <button onClick={() => setShowDatasetModal(true)} className="mt-3 text-blue-600 text-sm hover:underline">
                  + Create dataset
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {selectedFolder.datasets?.map(ds => (
                  <div
                    key={ds.id}
                    onClick={() => { setSelectedDataset(ds); setSelectedFolder(null); loadFieldMask(ds); setTab('overview'); }}
                    className="bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Table2 className="h-5 w-5 text-blue-500" />
                        <span className="font-medium text-sm text-gray-900">{ds.name}</span>
                      </div>
                      {sourceTypeBadge(ds.sourceType)}
                    </div>
                    <p className="text-xs text-gray-500">{ds.rowCount.toLocaleString()} rows</p>
                    {ds.lastSyncAt && (
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(ds.lastSyncAt).toLocaleString('en-GB', { hour12: false })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : selectedDataset ? (
          /* Dataset view */
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-6 py-4 bg-white border-b border-gray-200 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs text-gray-500 mb-0.5">
                  {selectedDataset.folder?.path.split('/').map((seg, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <ChevronRight className="h-3 w-3" />}
                      <span>{seg}</span>
                    </span>
                  ))}
                  <ChevronRight className="h-3 w-3" />
                  <span className="font-semibold text-gray-900">{selectedDataset.name}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {sourceTypeBadge(selectedDataset.sourceType)}
                  <span className="text-xs text-gray-500">{selectedDataset.rowCount.toLocaleString()} rows</span>
                  {selectedDataset.syncStatus === 'syncing' && (
                    <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCloneModal(true)}
                  className="flex items-center gap-1.5 px-3 h-9 border border-gray-200 text-gray-600 rounded-lg text-[14px] hover:bg-gray-50 whitespace-nowrap"
                >
                  <Copy className="h-4 w-4" /> Clone
                </button>
                <button
                  onClick={() => deleteDataset(selectedDataset)}
                  className="flex items-center gap-1.5 px-3 h-9 border border-red-200 text-red-600 rounded-lg text-[14px] hover:bg-red-50 whitespace-nowrap"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 bg-white px-6">
              {(['overview', 'data', 'columns', 'import'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`py-2.5 px-4 text-sm font-medium border-b-2 transition-colors capitalize ${
                    tab === t ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t === 'import' ? (selectedDataset.sourceType === 'connection' ? 'Connection' : 'Import') : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-auto p-6">

              {/* Overview Tab */}
              {tab === 'overview' && (
                <div className="max-w-2xl space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <p className="text-xs text-gray-500 mb-1">Rows</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {selectedDataset.sourceType === 'connection' ? 'Live' : selectedDataset.rowCount.toLocaleString()}
                      </p>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <p className="text-xs text-gray-500 mb-1">Source</p>
                      <div className="mt-1">{sourceTypeBadge(selectedDataset.sourceType)}</div>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <p className="text-xs text-gray-500 mb-1">Last Updated</p>
                      <p className="text-sm font-medium text-gray-700">
                        {selectedDataset.lastSyncAt
                          ? new Date(selectedDataset.lastSyncAt).toLocaleString('en-GB', { hour12: false })
                          : '-'}
                      </p>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <p className="text-xs text-gray-500 mb-1">Visible Columns</p>
                      <p className="text-sm font-medium text-gray-700">
                        {fieldMask.filter(f => f.visible).length} / {fieldMask.length}
                      </p>
                    </div>
                  </div>
                  {selectedDataset.description && (
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <p className="text-xs text-gray-500 mb-1">Description</p>
                      <p className="text-sm text-gray-700">{selectedDataset.description}</p>
                    </div>
                  )}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-xs font-semibold text-blue-700 mb-1">Flow Node Path</p>
                    <code className="text-sm text-blue-800 font-mono">
                      {selectedDataset.folder?.path}/{selectedDataset.slug}
                    </code>
                    <p className="text-xs text-blue-500 mt-1">Use this path in the Data Admin node</p>
                  </div>
                  {selectedDataset.syncStatus === 'error' && selectedDataset.syncError && (
                    <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                      <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-red-700">{selectedDataset.syncError}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Data Tab */}
              {tab === 'data' && (
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      value={previewWhere}
                      onChange={e => setPreviewWhere(e.target.value)}
                      placeholder="WHERE clause filter, e.g. year = '2567'"
                      className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 font-mono"
                      onKeyDown={e => e.key === 'Enter' && loadPreview(selectedDataset, 1, previewWhere)}
                    />
                    <button
                      onClick={() => { setPreviewPage(1); loadPreview(selectedDataset, 1, previewWhere); }}
                      className="inline-flex items-center justify-center px-3 h-9 bg-blue-600 text-white rounded-lg text-[14px] hover:bg-blue-700 whitespace-nowrap"
                    >
                      Apply
                    </button>
                    <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 h-9 border border-gray-200 text-gray-600 rounded-lg text-[14px] hover:bg-gray-50 whitespace-nowrap">
                      <Download className="h-4 w-4" /> CSV
                    </button>
                  </div>

                  {previewLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-6 w-6 text-blue-500 animate-spin" />
                    </div>
                  ) : previewRows.length === 0 ? (
                    <div className="text-center py-12 text-gray-400">
                      {selectedDataset.sourceType === 'connection'
                        ? <span>Configure connection first — <button className="text-blue-500 underline" onClick={() => setTab('import')}>go to Connection tab</button></span>
                        : 'No data — import or sync first'}
                    </div>
                  ) : (
                    <>
                      <div className="overflow-auto flex-1 border border-gray-200 rounded-lg bg-white">
                        <table className="min-w-full text-xs">
                          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                            <tr>
                              <th className="px-3 py-2 text-left text-gray-500 font-medium w-10">#</th>
                              {previewColumns.map(col => (
                                <th key={col} className="px-3 py-2 text-left text-gray-700 font-medium whitespace-nowrap">{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {previewRows.map((row, i) => (
                              <tr key={i} className="hover:bg-gray-50">
                                <td className="px-3 py-1.5 text-gray-400">{(previewPage - 1) * PREVIEW_PAGE_SIZE + i + 1}</td>
                                {previewColumns.map(col => (
                                  <td key={col} className="px-3 py-1.5 text-gray-700 max-w-xs truncate">
                                    {row[col] === null || row[col] === undefined ? <span className="text-gray-300 italic">null</span> : String(row[col])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                        <span>Showing {(previewPage - 1) * PREVIEW_PAGE_SIZE + 1}–{Math.min(previewPage * PREVIEW_PAGE_SIZE, previewTotal)} of {previewTotal.toLocaleString()}</span>
                        <div className="flex gap-2">
                          <button disabled={previewPage === 1} onClick={() => setPreviewPage(p => p - 1)} className="inline-flex items-center justify-center px-2 h-8 border rounded disabled:opacity-40 whitespace-nowrap">Prev</button>
                          <button disabled={previewPage * PREVIEW_PAGE_SIZE >= previewTotal} onClick={() => setPreviewPage(p => p + 1)} className="inline-flex items-center justify-center px-2 h-8 border rounded disabled:opacity-40 whitespace-nowrap">Next</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Columns Tab */}
              {tab === 'columns' && (
                <div className="max-w-2xl">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm text-gray-600">Configure which columns are visible and their display names</p>
                    {fieldMaskDirty && (
                      <button
                        onClick={saveFieldMask}
                        disabled={savingMask}
                        className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {savingMask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        Save
                      </button>
                    )}
                  </div>
                  {fieldMask.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-sm">No columns — import data first</div>
                  ) : (
                    <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                      <div className="grid grid-cols-12 px-4 py-2 text-xs font-medium text-gray-500 bg-gray-50 rounded-t-lg">
                        <span className="col-span-1">Show</span>
                        <span className="col-span-4">Column</span>
                        <span className="col-span-7">Alias (display name)</span>
                      </div>
                      {fieldMask.map((f, i) => (
                        <div key={f.original} className="grid grid-cols-12 px-4 py-2 items-center">
                          <div className="col-span-1">
                            <input
                              type="checkbox"
                              checked={f.visible}
                              onChange={() => {
                                const updated = [...fieldMask];
                                updated[i] = { ...f, visible: !f.visible };
                                setFieldMask(updated);
                                setFieldMaskDirty(true);
                              }}
                              className="accent-blue-600"
                            />
                          </div>
                          <div className="col-span-4 text-xs font-mono text-gray-600">{f.original}</div>
                          <div className="col-span-7">
                            <input
                              value={f.alias}
                              onChange={e => {
                                const updated = [...fieldMask];
                                updated[i] = { ...f, alias: e.target.value };
                                setFieldMask(updated);
                                setFieldMaskDirty(true);
                              }}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Import / Sync Tab */}
              {tab === 'import' && (
                <div className="max-w-xl space-y-4">
                  {selectedDataset.sourceType !== 'connection' ? (
                    /* Import from file */
                    <>
                      <div>
                        <p className="text-sm font-medium text-gray-700 mb-2">Import file</p>
                        <div
                          onClick={() => fileInputRef.current?.click()}
                          className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
                        >
                          <Upload className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                          <p className="text-sm text-gray-600">
                            {importFile ? importFile.name : 'Click to select file'}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">CSV, Excel (.xlsx), TSV, JSON — max 200 MB</p>
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".csv,.tsv,.json,.xlsx,.xls"
                          className="hidden"
                          onChange={e => { setImportFile(e.target.files?.[0] || null); setImportResult(null); setImportError(''); }}
                        />
                      </div>
                      {importError && (
                        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                          <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                          <p className="text-sm text-red-700">{importError}</p>
                        </div>
                      )}
                      {importResult && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                          <p className="text-sm text-green-700 font-medium">Import successful</p>
                          <p className="text-xs text-green-600 mt-1">{importResult.rowCount.toLocaleString()} rows, {importResult.columns?.length} columns</p>
                        </div>
                      )}
                      <button
                        onClick={handleImport}
                        disabled={!importFile || importing}
                        className="flex items-center gap-2 px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        {importing ? 'Importing...' : 'Import'}
                      </button>
                    </>
                  ) : (
                    /* Sync from connection */
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Database Connection</label>
                        <select
                          value={syncConnId || selectedDataset.connectionId || ''}
                          onChange={e => setSyncConnId(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                        >
                          <option value="">Select connection...</option>
                          {connections.map(c => (
                            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">SQL Query</label>
                        <textarea
                          value={syncSql || selectedDataset.syncSql || ''}
                          onChange={e => setSyncSql(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono h-32 resize-y"
                          placeholder="SELECT * FROM table_name"
                        />
                      </div>
                      {syncError && (
                        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                          <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                          <p className="text-sm text-red-700">{syncError}</p>
                        </div>
                      )}
                      {importResult && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                          <p className="text-sm text-green-700 font-medium">Connection configured — data will load live from database</p>
                        </div>
                      )}
                      <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="flex items-center gap-2 px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        {syncing ? 'Testing...' : 'Save & Test Connection'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* Create Folder Modal */}
      {showFolderModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {folderModalParentId ? 'New Subfolder' : 'New Folder'}
            </h3>
            <input
              value={folderName}
              onChange={e => setFolderName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createFolder()}
              placeholder="Folder name (e.g. 2567, mis, ref)"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-4 focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowFolderModal(false); setFolderName(''); }} className="inline-flex items-center justify-center px-3.5 h-9 border border-gray-200 rounded-lg text-[14px] text-gray-600 hover:bg-gray-50 whitespace-nowrap">Cancel</button>
              <button
                onClick={createFolder}
                disabled={!folderName.trim() || savingFolder}
                className="inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {savingFolder ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Dataset Modal */}
      {showDatasetModal && selectedFolder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">New Dataset</h3>
            <p className="text-sm text-gray-500 mb-4">in {selectedFolder.path}</p>
            <input
              value={dsName}
              onChange={e => setDsName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createDataset()}
              placeholder="Dataset name"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-3 focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">Source type</label>
              <div className="flex gap-2">
                {(['import', 'connection', 'api-push'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setDsSourceType(t)}
                    className={`inline-flex items-center justify-center px-3 h-8 rounded-lg text-[13px] border ${dsSourceType === t ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'} whitespace-nowrap`}
                  >
                    {t === 'import' ? 'Import' : t === 'connection' ? 'DB Sync' : 'API Push'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowDatasetModal(false); setDsName(''); }} className="inline-flex items-center justify-center px-3.5 h-9 border border-gray-200 rounded-lg text-[14px] text-gray-600 hover:bg-gray-50 whitespace-nowrap">Cancel</button>
              <button
                onClick={createDataset}
                disabled={!dsName.trim() || savingDs}
                className="inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {savingDs ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clone Modal */}
      {showCloneModal && selectedDataset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Clone Dataset</h3>
            <p className="text-sm text-gray-500 mb-4">Clone "{selectedDataset.name}" to a new path</p>
            <input
              value={clonePath}
              onChange={e => setClonePath(e.target.value)}
              placeholder="Target path, e.g. 2568/mis/customers"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-4 font-mono focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowCloneModal(false); setClonePath(''); }} className="inline-flex items-center justify-center px-3.5 h-9 border border-gray-200 rounded-lg text-[14px] text-gray-600 hover:bg-gray-50 whitespace-nowrap">Cancel</button>
              <button
                onClick={handleClone}
                disabled={!clonePath.trim() || cloning}
                className="inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {cloning ? <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> : null}
                {cloning ? 'Cloning...' : 'Clone'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
