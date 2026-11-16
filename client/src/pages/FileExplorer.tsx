/* File Explorer — styled like the another app file hub.
 *
 * Left card  : "storage" — the File Explorer's own folder tree, then the project
 *              baskets linked into it (read-only: sessions/folders → files).
 * Right card : breadcrumb + toolbar on one row, then folders and files as tiles
 *              (grid) or rows (list). Files get a coloured badge by type.
 * Copy-from-Basket and Link-basket open as overlay modals.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  FolderTree, FolderPlus, Folder as FolderIcon, FolderOpen, ChevronRight,
  File as FileIcon, FileSpreadsheet, FileText, Eye, Download, Trash2, MoreVertical,
  ArrowRight, RefreshCw, Database, HardDrive, Inbox, Loader2, FileInput, X, Link2,
  Upload, Unlink, Plus,
} from 'lucide-react';
import {
  Button as CdsButton, ComposedModal, ModalHeader, ModalBody, ModalFooter, TextInput, Search, ComboBox, Checkbox,
  IconButton, InlineLoading, InlineNotification, Tag, Tabs, TabList, Tab, Pagination,
  TableContainer, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
} from '@carbon/react';
import { Button } from '../components/ui/Button';
import { API_URL, apiFetch, withAuthToken } from '../config/api';
import { uploadFileB64 } from '../utils/uploadB64';

/* ─────────── Types ─────────── */
interface Basket {
  id: string;
  name: string;
  type: 'batch' | 'shares' | 'sftp';
  projectId: string | null;
  path?: string;
}
interface SourceBasket extends Basket {
  _count?: { basketFiles: number };
}
interface BasketFile {
  id: string;
  fileName: string;
  originalName: string;
  size: number;
  mimeType?: string;
  status: string;
  folderId?: string | null;
  createdAt: string;
}
interface Folder {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  _count?: { files: number; children: number };
}
/** A project basket linked into the File Explorer */
interface BasketLink {
  id: string;
  name: string;
  basketId: string;
  basketName: string;
  basketType: Basket['type'];
  projectId: string | null;
  projectName: string | null;
  fileCount: number;
  /** the project's own Share Folder (named after the project, always present) */
  projectBasket?: boolean;
}
/** One level inside a linked basket: a batch session or a shares folder */
interface LinkFolder { id: string; name: string; kind: 'session' | 'folder'; status?: string; fileCount: number }
/** Where the right-hand card is looking */
type Source =
  | { kind: 'fe' }
  | { kind: 'link'; link: BasketLink; trail: LinkFolder[] };

/* ─────────── Helpers ─────────── */
function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem('token');
  const headers = new Headers(options?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return apiFetch(url, { ...options, headers });
}
function formatSize(bytes?: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return <FileSpreadsheet className="w-4 h-4 text-green-600" />;
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === 'log') return <FileText className="w-4 h-4 text-blue-600" />;
  if (ext === 'json') return <FileText className="w-4 h-4 text-amber-600" />;
  return <FileIcon className="w-4 h-4 text-gray-500" />;
}
function basketIcon(type: string) {
  if (type === 'sftp') return <HardDrive className="w-4 h-4 text-purple-500" />;
  if (type === 'shares') return <FolderTree className="w-4 h-4 text-blue-500" />;
  return <Inbox className="w-4 h-4 text-gray-500" />;
}

/** Row icon like a typical file list: PDF red, sheets green, archives purple, others slate */
function rowIcon(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const tone = ext === 'pdf' ? 'text-red-600'
    : ['xls', 'xlsx', 'xlsm', 'csv'].includes(ext) ? 'text-emerald-600'
    : ['zip', 'rar', '7z', 'gz'].includes(ext) ? 'text-violet-600'
    : ['enc', 'pgp', 'gpg'].includes(ext) ? 'text-amber-600'
    : 'text-slate-500';
  const Icon = ['xls', 'xlsx', 'xlsm', 'csv'].includes(ext) ? FileSpreadsheet : FileText;
  return <Icon size={16} strokeWidth={1.5} className={cx('mt-[1px] flex-shrink-0', tone)} />;
}

/** Project dropdown with search (replaces the native <select>) */
function ProjectPicker({ projects, value, onChange }: { projects: Record<string, string>; value: string; onChange: (id: string) => void }) {
  const items = Object.entries(projects).sort(([, a], [, b]) => a.localeCompare(b, 'th')).map(([id, name]) => ({ id, name }));
  const selected = items.find(i => i.id === value) || null;
  return (
    <ComboBox
      id="fe-project-picker"
      titleText="Project"
      size="md"
      placeholder="Select project…"
      items={items}
      selectedItem={selected}
      itemToString={(i: { id: string; name: string } | null) => i?.name || ''}
      shouldFilterItem={({ item, inputValue }: { item: { id: string; name: string }; inputValue: string | null }) =>
        !inputValue || item.name.toLowerCase().includes(inputValue.toLowerCase())}
      onChange={({ selectedItem }: { selectedItem?: { id: string; name: string } | null }) => { if (selectedItem) onChange(selectedItem.id); }}
    />
  );
}


const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ─────────── Main page ─────────── */
export default function FileExplorer() {
  return <ShareFolderExplorer />;
}

/** The shares basket the folder view is showing: the File Explorer itself, a linked shares basket, or (single mode) one project's Share Folder */
interface SharesTarget { id: string; name: string; isFe: boolean; linkId?: string }

/**
 * Folder/file view for shares baskets.
 * Without `basket` it is the global File Explorer (its own folders + linked baskets);
 * with `basket` it shows just that Share Folder (used by the project's Baskets page).
 */
export function ShareFolderExplorer({ basket: single, readOnly = false, embedded = false }: {
  basket?: { id: string; name: string };
  readOnly?: boolean;
  /** inside another modal: no page padding, fills the parent */
  embedded?: boolean;
} = {}) {
  const [feBasket, setFeBasket] = useState<Basket | null>(null);
  const [cur, setCur] = useState<SharesTarget | null>(single ? { id: single.id, name: single.name, isFe: false } : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // File Explorer's own folders
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [feFiles, setFeFiles] = useState<BasketFile[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Linked baskets
  const [links, setLinks] = useState<BasketLink[]>([]);
  const [source, setSource] = useState<Source>({ kind: 'fe' });
  const [linkFolders, setLinkFolders] = useState<LinkFolder[]>([]);
  const [linkFiles, setLinkFiles] = useState<BasketFile[]>([]);
  const [linkBasketId, setLinkBasketId] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);


  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { setSel(new Set()); setQ(''); }, [currentFolderId, source, cur?.id]);

  // ?folder=<folder id or path> opens that folder (links sent by flows, e.g. new data);
  // the URL follows the current folder so it can be copied and shared.
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingFolderPath = useRef<string | null>(searchParams.get('folder'));
  const highlightFileId = searchParams.get('file');

  // Copy modal
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const flash = (msg: string, ms = 3000) => { setCopyMessage(msg); setTimeout(() => setCopyMessage(null), ms); };

  /* ── Initial load ── */
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (single) { setLoading(false); return; }
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const r = await authFetch(`${API_URL}/file-explorer`);
        // A proxy or gateway error comes back with an empty or HTML body, so
        // don't surface the JSON parser's message to the user.
        const j = await r.json().catch(() => null);
        if (!j) throw new Error(`Can't reach the server (HTTP ${r.status}).`);
        if (!j.success) throw new Error(j.error || 'Failed to load File Explorer');
        setFeBasket(j.data);
        setCur(c => c ?? { id: j.data.id, name: 'File Explorer', isFe: true });
      } catch (e: unknown) {
        setError(e instanceof TypeError ? "Can't reach the server." : (e instanceof Error ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAttempt, single]);

  const reloadFE = useCallback(async () => {
    if (!cur) return;
    const listFiles = async () => {
      const all: BasketFile[] = [];
      for (let page = 1; page <= 50; page++) {
        const j = await authFetch(`${API_URL}/baskets/${cur.id}/files?limit=100&page=${page}&folderId=${currentFolderId ?? 'root'}`).then(r => r.json());
        if (!j.success) break;
        all.push(...(j.data || []));
        if (!j.paging || page >= j.paging.totalPages) break;
      }
      return all;
    };
    const [fr, files] = await Promise.all([
      // ?all=true → the FULL folder tree (root + all nested subfolders)
      authFetch(`${API_URL}/baskets/${cur.id}/folders?all=true`).then(r => r.json()),
      listFiles(),
    ]);
    if (fr.success) setFolders(fr.data || []);
    setFeFiles(files);
  }, [cur, currentFolderId]);

  const reloadLinks = useCallback(async () => {
    const j = await authFetch(`${API_URL}/file-explorer/links`).then(r => r.json()).catch(() => null);
    if (j?.success) setLinks(j.data || []);
  }, []);

  // The shared File Explorer only shows while something is still in it (its folders moved to the project baskets)
  const [feHasContent, setFeHasContent] = useState(true);
  useEffect(() => {
    if (!feBasket || single) return;
    Promise.all([
      authFetch(`${API_URL}/baskets/${feBasket.id}/folders?all=true`).then(r => r.json()),
      authFetch(`${API_URL}/baskets/${feBasket.id}/files?limit=1&folderId=root`).then(r => r.json()),
    ]).then(([fo, fi]) => setFeHasContent((fo.data || []).length > 0 || (fi.data || []).length > 0)).catch(() => {});
  }, [feBasket, single]);

  useEffect(() => {
    if (cur) reloadFE();
  }, [cur, currentFolderId, reloadFE]);
  useEffect(() => { if (feBasket && !single) reloadLinks(); }, [feBasket, single, reloadLinks]);

  // Linked basket contents
  const reloadLink = useCallback(async () => {
    if (source.kind !== 'link') return;
    const last = source.trail[source.trail.length - 1];
    const q = !last ? '' : last.kind === 'session' ? `?sessionId=${last.id}` : `?folderId=${last.id}`;
    setLinkLoading(true);
    try {
      const j = await authFetch(`${API_URL}/file-explorer/links/${source.link.id}/items${q}`).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'Failed to load the basket');
      setLinkFolders(j.data.folders || []);
      setLinkFiles(j.data.files || []);
      setLinkBasketId(j.data.basketId);
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Failed to load the basket', 5000);
      setLinkFolders([]); setLinkFiles([]);
    } finally { setLinkLoading(false); }
  }, [source]);
  useEffect(() => { reloadLink(); }, [reloadLink]);


  // ?file= highlights that file; bring it into view once listed
  useEffect(() => {
    if (highlightFileId) document.getElementById(`fe-file-${highlightFileId}`)?.scrollIntoView({ block: 'center' });
  }, [highlightFileId, feFiles]);

  /** Copy a link to the open folder (or one file in it). Opening it needs a login. */
  const copyLink = async (fileId?: string) => {
    const r = await authFetch(`${API_URL}/share-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: currentFolderId, fileId: fileId ?? null }),
    }).then(res => res.json()).catch(() => null);
    if (!r?.success) { flash('Could not create the link'); return; }
    const base = (import.meta.env.VITE_BASE_PATH || '/integration').replace(/\/$/, '');
    const url = `${window.location.origin}${base}/share/${r.data.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this link', url);
      return;
    }
    flash('Copied link — opening it requires login');
  };

  // Resolve ?folder= once the folder tree has loaded
  useEffect(() => {
    const wanted = pendingFolderPath.current;
    if (!wanted || folders.length === 0 || !cur?.isFe) return;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    // ?folder= holds the folder id (cuid); older links carried its path
    const target = folders.find(f => f.id === wanted) ?? folders.find(f => norm(f.path) === norm(wanted));
    if (!target) { pendingFolderPath.current = null; return; }
    if (currentFolderId === target.id) { pendingFolderPath.current = null; return; } // link applied
    const ancestors = new Set<string>();
    for (let cur: Folder | undefined = target; cur?.parentId; cur = folders.find(f => f.id === cur!.parentId)) {
      ancestors.add(cur.parentId);
    }
    setExpandedFolders(prev => new Set([...prev, ...ancestors]));
    setCurrentFolderId(target.id);
  }, [folders, currentFolderId, cur]);

  // Keep ?folder= in step with the open folder
  useEffect(() => {
    if (single) return;
    if (pendingFolderPath.current) return; // still resolving the link we were opened with
    const id = source.kind === 'fe' && cur?.isFe ? currentFolderId || undefined : undefined;
    if ((searchParams.get('folder') || undefined) === id) return;
    const next = new URLSearchParams(searchParams);
    if (id) next.set('folder', id); else next.delete('folder');
    next.delete('file'); // a file highlight belongs to the folder it was linked from
    setSearchParams(next, { replace: true });
  }, [currentFolderId, source, cur, single, folders, searchParams, setSearchParams]);

  const subfolders = useMemo(
    () => folders.filter(f => (f.parentId ?? null) === (currentFolderId ?? null)).sort((a, b) => a.name.localeCompare(b.name)),
    [folders, currentFolderId],
  );

  const folderChildren = useMemo(() => {
    const map: Record<string, Folder[]> = { ROOT: [] };
    for (const f of folders) {
      const k = f.parentId ?? 'ROOT';
      (map[k] = map[k] || []).push(f);
    }
    return map;
  }, [folders]);


  /* ── Navigation ── */
  /** Switch the folder view to another shares basket (File Explorer ↔ a linked Share Folder) */
  const switchShares = (target: SharesTarget) => {
    setSource({ kind: 'fe' });
    if (cur?.id !== target.id) {
      setFolders([]); setFeFiles([]);
      setExpandedFolders(new Set());
      cancelNewFolder();
      setCur(target);
    }
    setCurrentFolderId(null);
  };
  const openFeFolder = (id: string | null) => { setSource({ kind: 'fe' }); setCurrentFolderId(id); };
  const goFeRoot = () => { if (feBasket) switchShares({ id: feBasket.id, name: 'File Explorer', isFe: true }); };
  const openLink = (link: BasketLink, trail: LinkFolder[] = []) => {
    // A linked Share Folder opens in the full folder view (upload, folders…); a batch basket as read-only sessions
    if (link.basketType === 'shares' && trail.length === 0) {
      switchShares({ id: link.basketId, name: link.name, isFe: false, linkId: link.id });
      return;
    }
    setSource({ kind: 'link', link, trail });
  };

  // With the shared File Explorer empty, open the first project basket (unless a ?folder= link points into it)
  useEffect(() => {
    if (single || feHasContent || !cur?.isFe || pendingFolderPath.current || links.length === 0) return;
    openLink(links[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, feHasContent, cur?.isFe, links]);

  /* ── Actions ── */
  // Which folder the new-folder input will be created INSIDE (null = root),
  // independent of which folder is open.
  const [addSubfolderParentId, setAddSubfolderParentId] = useState<string | null | undefined>(undefined);

  const openAddSubfolder = (parentId: string | null) => {
    setSource({ kind: 'fe' });
    setAddSubfolderParentId(parentId);
    setShowNewFolderInput(true);
    if (parentId) setExpandedFolders(new Set([...expandedFolders, parentId]));
  };

  const createFolder = async () => {
    if (!cur || !newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      // kebab → Add subfolder sets the parent; the toolbar button uses the open folder
      const parentId = addSubfolderParentId !== undefined ? addSubfolderParentId : currentFolderId;
      const r = await authFetch(`${API_URL}/baskets/${cur.id}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim(), parentId }),
      });
      const j = await r.json();
      if (j.success) {
        setNewFolderName('');
        setShowNewFolderInput(false);
        setAddSubfolderParentId(undefined);
        if (parentId) setExpandedFolders(prev => new Set([...prev, parentId]));
        await reloadFE();
      } else {
        alert(j.error || 'Failed to create folder');
      }
    } finally { setCreatingFolder(false); }
  };
  const cancelNewFolder = () => { setShowNewFolderInput(false); setNewFolderName(''); setAddSubfolderParentId(undefined); };

  const deleteFolder = async (folderId: string) => {
    if (!cur) return;
    if (!confirm('Delete this folder? It must be empty (no files or sub-folders).')) return;
    const r = await authFetch(`${API_URL}/baskets/${cur.id}/folders/${folderId}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.success) {
      if (currentFolderId === folderId) setCurrentFolderId(null);
      await reloadFE();
    } else {
      alert(j.error || 'Delete failed');
    }
  };

  const deleteFile = async (fileId: string) => {
    if (!cur) return;
    if (!confirm(cur.isFe ? 'Delete this file from File Explorer? (Original copy in the source basket is not affected.)' : `Delete this file from ${cur.name}?`)) return;
    const r = await authFetch(`${API_URL}/baskets/${cur.id}/files/${fileId}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.success) await reloadFE();
    else alert(j.error || 'Delete failed');
  };

  /** Upload into the open File Explorer folder — base64 body, the way Cloudflare lets through */
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!cur || list.length === 0) return;
    setBusy(true);
    let ok = 0; let lastErr = '';
    for (const file of list) {
      try {
        // large files go up in chunks (Cloudflare caps a request at ~100 MB)
        const text = await uploadFileB64(`${API_URL}/baskets/${cur.id}/files`, file, { folderId: currentFolderId ?? undefined });
        let j: { success?: boolean; error?: string } | null = null;
        try { j = JSON.parse(text); } catch { /* not JSON */ }
        if (!j?.success) throw new Error(j?.error || 'Upload failed');
        ok++;
      } catch (err: unknown) { lastErr = err instanceof Error ? err.message : String(err); }
    }
    setBusy(false);
    await reloadFE();
    flash(lastErr ? `Uploaded ${ok}/${list.length}: ${lastErr}` : `Uploaded ${ok} file${ok === 1 ? '' : 's'}`, 5000);
  };

  const unlinkBasket = async (link: BasketLink) => {
    if (!confirm(`Remove "${link.name}" from the File Explorer?\nThe basket and its files are not touched.`)) return;
    const j = await authFetch(`${API_URL}/file-explorer/links/${link.id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
    if (!j?.success) { alert(j?.error || 'Unlink failed'); return; }
    if ((source.kind === 'link' && source.link.id === link.id) || cur?.linkId === link.id) goFeRoot();
    await reloadLinks();
  };

  const downloadFile = (basketId: string, fileId: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/download`);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const viewFile = (basketId: string, fileId: string, fileName: string) => {
    const base = (import.meta.env.VITE_BASE_PATH || '/').replace(/\/$/, '');
    if (/\.xlsx?$/i.test(fileName)) {
      window.open(`${base}/viewer/xlsx?basketId=${basketId}&fileId=${fileId}`, '_blank');
    } else if (/\.(txt|csv|tsv|log|dat)$/i.test(fileName)) {
      window.open(`${base}/viewer/txt?basketId=${basketId}&fileId=${fileId}`, '_blank');
    } else {
      window.open(withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/view`), '_blank');
    }
  };

  const currentFolderName = () => {
    const rootName = cur?.name || 'File Explorer';
    if (!currentFolderId) return rootName;
    return folders.find(f => f.id === currentFolderId)?.name || rootName;
  };

  /* ── Render ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-slate-500 text-[13px]">
        <InlineLoading description="Loading File Explorer…" />
      </div>
    );
  }
  if (error || !cur) {
    return (
      <div className="p-8 max-w-xl">
        <InlineNotification kind="error" lowContrast hideCloseButton title="File Explorer unavailable"
          subtitle={error || 'Could not resolve the File Explorer basket.'} />
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setLoadAttempt(n => n + 1)} leftIcon={<RefreshCw className="w-3.5 h-3.5" />}>
          Retry
        </Button>
      </div>
    );
  }

  const inFe = source.kind === 'fe';           // folder view of `cur` (not a batch link's sessions)
  const feOnly = inFe && cur.isFe;             // copy link / download all / copy from basket live in the File Explorer
  const canWrite = inFe && !readOnly;
  const shownFolders = inFe ? subfolders : [];
  const shownFiles = inFe ? feFiles : linkFiles;
  const fileBasketId = inFe ? cur.id : (linkBasketId || '');
  const isLoadingList = !inFe && linkLoading;
  const n0 = (n: number) => n.toLocaleString('en-US');

  // Search filters the open level (folders and files) by name
  const ql = q.trim().toLowerCase();
  const match = (name: string) => !ql || name.toLowerCase().includes(ql);
  const folderItems: { id: string; name: string; sub: string; open: () => void }[] = inFe
    ? shownFolders.filter(f => match(f.name)).map(f => ({
        id: f.id, name: f.name,
        sub: f._count ? `${f._count.children > 0 ? `${n0(f._count.children)} folders · ` : ''}${n0(f._count.files)} files` : '',
        open: () => { if (currentFolderId) setExpandedFolders(prev => new Set([...prev, currentFolderId])); openFeFolder(f.id); },
      }))
    : source.kind === 'link' ? linkFolders.filter(f => match(f.name)).map(f => ({
        id: f.id, name: f.name, sub: `${n0(f.fileCount)} files${f.status ? ` · ${f.status}` : ''}`,
        open: () => openLink(source.link, [...source.trail, f]),
      })) : [];
  const fileItems = shownFiles.filter(f => match(f.originalName || f.fileName));
  const pages = Math.max(1, Math.ceil(fileItems.length / pageSize));
  const pageNo = Math.min(page, pages);
  const pageItems = fileItems.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const allSel = pageItems.length > 0 && pageItems.every(f => sel.has(f.id));
  const totalBytes = shownFiles.reduce((n, f) => n + (f.size || 0), 0);
  const title = inFe ? currentFolderName() : (source.trail[source.trail.length - 1]?.name ?? source.link.name);
  const basketLabel = inFe ? cur.name : source.link.name;
  const downloadSelected = () => {
    shownFiles.filter(f => sel.has(f.id)).forEach((f, i) => setTimeout(() => downloadFile(fileBasketId, f.id, f.originalName || f.fileName), i * 400));
  };

  /* left pane: one "basket" entry (icon square + name + hint) */
  const basketEntry = (key: string, on: boolean, name: string, hint: string, icon: JSX.Element, onClick: () => void, extra?: JSX.Element) => (
    <div key={key} className={cx('group flex items-center gap-2 rounded-sm px-2 py-1.5', on ? 'bg-brand/10 text-brand' : 'hover:bg-slate-100')}>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cx('grid h-6 w-6 flex-shrink-0 place-items-center rounded', on ? 'bg-brand text-white' : 'bg-slate-200 text-slate-600')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[12.5px] leading-snug', on && 'font-semibold')} title={name}>{name}</span>
          {hint && <span className="block truncate text-[10.5px] text-slate-400">{hint}</span>}
        </span>
      </button>
      {extra}
    </div>
  );

  const tree = (
    <div className="pb-1">
      {showNewFolderInput && addSubfolderParentId === null && (
        <InlineNewFolderInput level={1} parentName={cur.name} value={newFolderName} creating={creatingFolder}
          onChange={setNewFolderName} onSubmit={createFolder} onCancel={cancelNewFolder} />
      )}
      <FolderTreeView
        folders={folders}
        folderChildren={folderChildren}
        expandedFolders={expandedFolders}
        setExpandedFolders={setExpandedFolders}
        currentFolderId={inFe ? currentFolderId : '__none__'}
        setCurrentFolderId={openFeFolder}
        onDeleteFolder={deleteFolder}
        onAddSubfolder={canWrite ? openAddSubfolder : undefined}
        inlineNewFolder={showNewFolderInput && addSubfolderParentId != null ? {
          forFolderId: addSubfolderParentId,
          parentName: folders.find(f => f.id === addSubfolderParentId)?.name ?? 'folder',
          value: newFolderName,
          creating: creatingFolder,
          onChange: setNewFolderName,
          onSubmit: createFolder,
          onCancel: cancelNewFolder,
        } : null}
        parentId={null}
        level={1}
      />
    </div>
  );

  return (
    // Like a typical "Baskets": no cards, a full-height workspace split by one line
    <div className={cx('relative h-full min-h-0 overflow-hidden bg-white', embedded && 'rounded-b-xl')}>
      <div className="grid h-full min-h-[520px] grid-cols-1 sm:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)]">

        {/* ── Navigation pane ── */}
        <nav aria-label="Baskets" className="flex max-h-[300px] min-h-0 flex-col border-b border-slate-200 bg-slate-50/60 sm:max-h-none sm:border-b-0 sm:border-r">
          <div className="flex items-center gap-1 px-3 pb-1 pt-2.5">
            <span className="flex-1 text-[11.5px] font-medium text-slate-400">Baskets</span>
            {!single && (
              <IconButton kind="ghost" size="sm" label="Link a project basket" onClick={() => setShowLinkModal(true)}>
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
            {single
              ? <>{basketEntry('single', inFe && currentFolderId === null, single.name, 'File Explorer', <FolderTree className="h-3.5 w-3.5" />, () => openFeFolder(null),
                  canWrite ? <IconButton kind="ghost" size="sm" label="New folder" className="opacity-0 group-hover:opacity-100" onClick={() => openAddSubfolder(null)}><FolderPlus className="h-3.5 w-3.5" /></IconButton> : undefined)}
                  {tree}</>
              : <>
                  {(feHasContent || cur.isFe) && basketEntry('fe', inFe && cur.isFe, 'File Explorer', '', <FolderTree className="h-3.5 w-3.5" />, () => (cur.isFe ? openFeFolder(null) : goFeRoot()),
                    canWrite && cur.isFe ? <IconButton kind="ghost" size="sm" label="New folder" className="opacity-0 group-hover:opacity-100" onClick={() => openAddSubfolder(null)}><FolderPlus className="h-3.5 w-3.5" /></IconButton> : undefined)}
                  {cur.isFe && inFe && tree}
                  {links.map(l => {
                    const on = (source.kind === 'link' && source.link.id === l.id) || (inFe && cur.linkId === l.id);
                    return (
                      <div key={l.id}>
                        {basketEntry(l.id, on, l.name,
                          l.projectBasket
                            ? `${n0(l.fileCount)} files`
                            : `${l.projectName ? `${l.projectName} · ` : ''}${l.basketType === 'batch' ? 'sessions' : 'File Explorer'} · ${n0(l.fileCount)} files`,
                          l.basketType === 'batch' ? <Inbox className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />,
                          () => openLink(l),
                          (
                            <IconButton kind="ghost" size="sm" label="Unlink (the basket is not deleted)" className="flex-shrink-0 sm:opacity-0 sm:group-hover:opacity-100" onClick={() => unlinkBasket(l)}>
                              <Unlink className="h-3.5 w-3.5" />
                            </IconButton>
                          ))}
                        {inFe && cur.linkId === l.id && tree}
                      </div>
                    );
                  })}
                </>}
          </div>
        </nav>

        {/* ── Content ── */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2.5">
            <div className="min-w-[120px] flex-1">
              <div className="truncate text-[14px] font-semibold leading-snug text-slate-900">{title}</div>
              <div className="truncate text-[11.5px] tabular-nums text-slate-400">
                {title !== basketLabel && <span className="whitespace-nowrap">{basketLabel} · </span>}
                {folderItems.length > 0 && <span className="whitespace-nowrap">{n0(folderItems.length)} folders · </span>}
                <span className="whitespace-nowrap">{n0(shownFiles.length)} files</span>
                {totalBytes > 0 && <span className="whitespace-nowrap"> · {formatSize(totalBytes)}</span>}
                {!canWrite && <span className="whitespace-nowrap"> · Read-only</span>}
              </div>
            </div>

            <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
              {copyMessage && (
                <Tag size="sm" type={/Copied|Uploaded \d+ file/.test(copyMessage) && !copyMessage.includes(':') ? 'green' : 'warm-gray'}>
                  {copyMessage}
                </Tag>
              )}
              <div className="relative w-[160px] lg:w-[200px]">
                <Search id="fe-folder-search" size="md" labelText="Search this folder" placeholder="Search this folder"
                  value={q} onChange={(e: any) => setQ(e.target.value)} onClear={() => setQ('')} />
              </div>
              {sel.size > 0 ? (
                <>
                  <span className="whitespace-nowrap text-[12px] text-slate-400">Selected <b className="text-slate-800">{n0(sel.size)}</b></span>
                  <Button variant="primary" size="sm" onClick={downloadSelected} leftIcon={<Download className="h-3.5 w-3.5" />}>Download selected</Button>
                  <IconButton kind="ghost" size="sm" label="Clear selection" onClick={() => setSel(new Set())}><X className="h-3.5 w-3.5" /></IconButton>
                </>
              ) : (
                <>
                  {inFe && canWrite && (
                    <IconButton kind="ghost" size="sm" label="New folder" onClick={() => openAddSubfolder(currentFolderId)}>
                      <FolderPlus className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                  {inFe && canWrite && (
                    <IconButton kind="ghost" size="sm" label="Copy files from a basket" onClick={() => setShowCopyModal(true)}>
                      <FileInput className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                  {feOnly && (
                    <IconButton kind="ghost" size="sm" label="Copy a link to this folder (opening it requires login)" onClick={() => copyLink()}>
                      <Link2 className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                  {inFe && canWrite && (
                    <>
                      <input ref={uploadRef} type="file" multiple hidden onChange={onUpload} />
                      <IconButton kind="ghost" size="sm" label="Upload" onClick={() => uploadRef.current?.click()} disabled={busy}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      </IconButton>
                    </>
                  )}
                  {inFe && (
                    <CdsButton kind="primary" size="sm" href={withAuthToken(`${API_URL}/file-explorer/folders/${currentFolderId ?? 'root'}/download?basketId=${cur.id}`)}
                      title="Download every file in this folder (including subfolders) as a ZIP" renderIcon={Download}>
                      Download ZIP
                    </CdsButton>
                  )}
                </>
              )}
              <IconButton kind="ghost" size="sm" label="Refresh" onClick={() => (inFe ? reloadFE() : reloadLink())}>
                <RefreshCw className={cx('h-3.5 w-3.5', isLoadingList && 'animate-spin')} />
              </IconButton>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {isLoadingList ? (
              <div className="flex flex-1 items-center justify-center"><InlineLoading className="w-auto" description="Loading…" /></div>
            ) : folderItems.length === 0 && fileItems.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-[13px] text-slate-400">
                <FolderOpen className="h-10 w-10" strokeWidth={1.2} />
                {q ? 'No matches' : 'This folder is empty'}
                {!q && canWrite && inFe && (
                  <Button variant="ghost" size="sm" onClick={() => uploadRef.current?.click()} leftIcon={<Upload className="h-3.5 w-3.5" />}>Upload files</Button>
                )}
              </div>
            ) : (
              <>
                {folderItems.length > 0 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] content-start gap-1 p-3">
                    {folderItems.map(f => (
                      <button key={f.id} type="button" onClick={f.open}
                        className="flex flex-col items-center gap-1 rounded-lg border border-transparent p-2.5 text-center transition-colors hover:bg-slate-100">
                        <FolderIcon className="h-[46px] w-[46px] fill-amber-200 text-amber-500" strokeWidth={1.4} />
                        <span className="line-clamp-2 break-all text-[12.5px] leading-snug text-slate-800">{f.name}</span>
                        {f.sub && <span className="text-[12px] tabular-nums text-slate-400">{f.sub}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {fileItems.length > 0 && (
                  <div className={cx('flex-1 overflow-x-auto', folderItems.length > 0 && 'border-t border-slate-100')}>
                    <TableContainer>
                    <Table size="sm" useZebraStyles={false} stickyHeader={false}>
                      <TableHead>
                        <TableRow>
                          <TableHeader className="w-8">
                            <Checkbox id="fe-select-all" labelText="Select all" hideLabel checked={allSel}
                              onChange={() => setSel(allSel ? new Set() : new Set(pageItems.map(f => f.id)))} />
                          </TableHeader>
                          <TableHeader>Name</TableHeader>
                          <TableHeader className="w-[90px] text-right">Size</TableHeader>
                          <TableHeader className="w-[160px]" aria-label="Actions" />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {pageItems.map(f => {
                          const name = f.originalName || f.fileName;
                          const on = sel.has(f.id);
                          return (
                            <TableRow key={f.id} id={`fe-file-${f.id}`} isSelected={on}
                              className={cx('group align-middle', on ? 'bg-brand/10' : feOnly && f.id === highlightFileId ? 'bg-amber-50' : '')}>
                              <TableCell>
                                <Checkbox id={`fe-select-${f.id}`} labelText={`Select ${name}`} hideLabel checked={on}
                                  onChange={() => setSel(prev => { const s = new Set(prev); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); return s; })} />
                              </TableCell>
                              <TableCell>
                                <button type="button" onClick={() => viewFile(fileBasketId, f.id, name)} className="flex min-w-0 items-center gap-2 text-left hover:text-brand">
                                  {rowIcon(name)}
                                  <span className="min-w-0 break-all leading-snug">{name}{!inFe && <span className="ml-1.5 text-[12px] text-slate-400">{f.status}</span>}</span>
                                </button>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right tabular-nums text-slate-500">{formatSize(f.size)}</TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-0.5 md:opacity-0 md:group-hover:opacity-100">
                                  {feOnly && <IconButton kind="ghost" size="sm" label="Copy link to this file" onClick={() => copyLink(f.id)}><Link2 className="h-3.5 w-3.5" /></IconButton>}
                                  <IconButton kind="ghost" size="sm" label="View" onClick={() => viewFile(fileBasketId, f.id, name)}><Eye className="h-3.5 w-3.5" /></IconButton>
                                  <IconButton kind="ghost" size="sm" label="Download" onClick={() => downloadFile(fileBasketId, f.id, name)}><Download className="h-3.5 w-3.5" /></IconButton>
                                  {canWrite && <IconButton kind="ghost" size="sm" label="Delete" onClick={() => deleteFile(f.id)}><Trash2 className="h-3.5 w-3.5" /></IconButton>}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    </TableContainer>
                  </div>
                )}
              </>
            )}
          </div>
          {fileItems.length > 0 && (
            <Pagination
              className="flex-shrink-0"
              size="sm"
              page={pageNo}
              pageSize={pageSize}
              pageSizes={[50, 100, 200]}
              totalItems={fileItems.length}
              onChange={({ page, pageSize: ps }: { page: number; pageSize: number }) => {
                if (ps !== pageSize) { setPageSize(ps); setPage(1); } else setPage(page);
              }}
            />
          )}
        </div>
      </div>

      {/* ─── Modals ─── */}
      {showCopyModal && (
        <CopyFromBasketModal
          targetBasketId={cur.id}
          targetFolderId={currentFolderId}
          targetFolderName={currentFolderName()}
          onClose={() => setShowCopyModal(false)}
          onCopied={(msg) => { flash(msg, 5000); reloadFE(); }}
        />
      )}
      {showLinkModal && (
        <LinkBasketModal
          linkedIds={links.map(l => l.basketId)}
          onClose={() => setShowLinkModal(false)}
          onLinked={async (link) => {
            setShowLinkModal(false);
            await reloadLinks();
            openLink({ ...link } as BasketLink);
          }}
        />
      )}
    </div>
  );
}

/* ─────────── Link-a-basket modal ─────────── */
function LinkBasketModal({ linkedIds, onClose, onLinked }: {
  linkedIds: string[]; onClose: () => void; onLinked: (link: BasketLink) => void;
}) {
  const [sources, setSources] = useState<(SourceBasket & { projectName?: string })[]>([]);
  const [projects, setProjects] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<SourceBasket | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // New basket: create a Share Folder in a project; or link one that exists
  const [mode, setMode] = useState<'create' | 'link'>('create');
  const [newProject, setNewProject] = useState('');
  const [newName, setNewName] = useState('');

  const create = async () => {
    if (!newProject || !newName.trim()) return;
    setSaving(true); setErr(null);
    try {
      const b = await authFetch(`${API_URL}/baskets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), type: 'shares', projectId: newProject, description: 'File Explorer' }),
      }).then(r => r.json());
      if (!b.success) throw new Error(b.error || 'Create failed');
      const j = await authFetch(`${API_URL}/file-explorer/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basketId: b.data.id, name: newName.trim() }),
      }).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'Link failed');
      onLinked({
        id: j.data.id, name: j.data.name, basketId: b.data.id, basketName: b.data.name, basketType: 'shares',
        projectId: newProject, projectName: projects[newProject] || null, fileCount: 0,
      });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };

  useEffect(() => {
    authFetch(`${API_URL}/file-explorer/sources`).then(r => r.json()).then(j => { if (j.success) setSources(j.data || []); });
    authFetch(`${API_URL}/projects`).then(r => r.json()).then(j => {
      if (j.success) setProjects(Object.fromEntries((j.data || []).map((p: { id: string; name: string }) => [p.id, p.name])));
    }).catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: Record<string, SourceBasket[]> = {};
    for (const b of sources) {
      if (b.type === 'sftp') continue;
      const pn = (b.projectId && projects[b.projectId]) || 'No project';
      if (q && !`${pn} ${b.name}`.toLowerCase().includes(q)) continue;
      (out[pn] = out[pn] || []).push(b);
    }
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b));
  }, [sources, projects, filter]);

  const save = async () => {
    if (!picked) return;
    setSaving(true); setErr(null);
    try {
      const j = await authFetch(`${API_URL}/file-explorer/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basketId: picked.id, name: name.trim() || undefined }),
      }).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'Link failed');
      onLinked({
        id: j.data.id, name: j.data.name, basketId: picked.id, basketName: picked.name, basketType: picked.type,
        projectId: picked.projectId, projectName: (picked.projectId && projects[picked.projectId]) || null,
        fileCount: picked._count?.basketFiles ?? 0,
      });
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };

  return (
    <ComposedModal open size="sm" onClose={() => { onClose(); return false; }}>
      <ModalHeader title="Add basket" />
      <ModalBody hasForm>
        <Tabs selectedIndex={mode === 'create' ? 0 : 1} onChange={({ selectedIndex }: { selectedIndex: number }) => { setMode(selectedIndex === 0 ? 'create' : 'link'); setErr(null); }}>
          <TabList aria-label="Add basket mode">
            <Tab>Create new</Tab>
            <Tab>Link existing basket</Tab>
          </TabList>
        </Tabs>
        {mode === 'create' ? (
          <div className="space-y-3 pt-4">
            <div className="block">
              <ProjectPicker projects={projects} value={newProject} onChange={setNewProject} />
            </div>
            <TextInput id="fe-new-basket-name" labelText="Basket name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Meeting documents"
              onKeyDown={e => { if (e.key === 'Enter') create(); }}
              helperText="Created as a File Explorer basket in the selected project — everyone with access to that project can see it" />
            {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Error" subtitle={err} />}
          </div>
        ) : (<>
        <div className="pt-4">
          <Search id="fe-link-filter" size="md" labelText="Search project or basket" autoFocus value={filter}
            onChange={(e: any) => setFilter(e.target.value)} onClear={() => setFilter('')} placeholder="Search project or basket…" />
        </div>
        <div className="max-h-[40vh] overflow-y-auto py-2">
          {groups.length === 0 && <div className="px-2 py-6 text-center text-[13px] text-slate-400">No basket found</div>}
          {groups.map(([pn, list]) => (
            <div key={pn} className="mb-2">
              <div className="px-2 py-1 text-[12px] font-medium text-slate-400">{pn}</div>
              {list.map(b => {
                const linked = linkedIds.includes(b.id);
                const on = picked?.id === b.id;
                return (
                  <button key={b.id} type="button" disabled={linked} onClick={() => setPicked(b)}
                    className={cx('w-full text-left px-2 py-1.5 flex items-center gap-2.5 text-[13px]',
                      on ? 'bg-brand/10 text-brand' : 'hover:bg-slate-50 text-slate-700', linked && 'opacity-40 cursor-not-allowed')}>
                    {basketIcon(b.type)}
                    <span className="flex-1 min-w-0 truncate">{b.name}</span>
                    <span className="text-[12px] text-slate-400">{linked ? 'Linked' : `${b.type} · ${b._count?.basketFiles ?? 0} files`}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <TextInput id="fe-link-display-name" labelText="Display name" hideLabel value={name} onChange={e => setName(e.target.value)} disabled={!picked}
            placeholder={picked ? `Display name (blank = ${(picked.projectId && projects[picked.projectId]) ? `${projects[picked.projectId]} · ` : ''}${picked.name})` : 'Select a basket first'} />
          {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Error" subtitle={err} />}
        </div>
        </>)}
      </ModalBody>
      <ModalFooter>
        <CdsButton kind="secondary" onClick={onClose}>Cancel</CdsButton>
        {mode === 'create' ? (
          <CdsButton kind="primary" onClick={create} disabled={!newProject || !newName.trim() || saving}>
            {saving ? 'Creating…' : 'Create basket'}
          </CdsButton>
        ) : (
          <CdsButton kind="primary" onClick={save} disabled={!picked || saving}>
            {saving ? 'Linking…' : 'Link basket'}
          </CdsButton>
        )}
      </ModalFooter>
    </ComposedModal>
  );
}

/* ─────────── Copy-from-Basket Modal ─────────── */
interface CopyFromBasketModalProps {
  targetBasketId: string;
  targetFolderId: string | null;
  targetFolderName: string;
  onClose: () => void;
  onCopied: (message: string) => void;
}
function CopyFromBasketModal({ targetBasketId, targetFolderId, targetFolderName, onClose, onCopied }: CopyFromBasketModalProps) {
  const [sources, setSources] = useState<SourceBasket[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedSource, setSelectedSource] = useState<SourceBasket | null>(null);
  const [files, setFiles] = useState<BasketFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`${API_URL}/file-explorer/sources`)
      .then(r => r.json())
      .then(j => { if (j.success) setSources(j.data || []); });
  }, []);

  useEffect(() => {
    if (!selectedSource) { setFiles([]); setSelectedFileIds([]); return; }
    setLoadingFiles(true);
    authFetch(`${API_URL}/baskets/${selectedSource.id}/files?limit=500`)
      .then(r => r.json())
      .then(j => { setFiles(j.success ? j.data || [] : []); setSelectedFileIds([]); })
      .finally(() => setLoadingFiles(false));
  }, [selectedSource]);

  const filteredSources = useMemo(() => {
    if (!filter.trim()) return sources;
    const q = filter.toLowerCase();
    return sources.filter(b => b.name.toLowerCase().includes(q));
  }, [sources, filter]);

  const doCopy = async () => {
    if (!selectedSource || selectedFileIds.length === 0) return;
    setCopying(true);
    setErr(null);
    let ok = 0, fail = 0;
    let lastErr = '';
    for (const fileId of selectedFileIds) {
      try {
        const r = await authFetch(`${API_URL}/file-explorer/copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceBasketId: selectedSource.id,
            sourceFileId: fileId,
            targetFolderId,
            targetBasketId,
          }),
        });
        const j = await r.json();
        if (j.success) ok++;
        else { fail++; lastErr = j.error || 'copy failed'; }
      } catch (e: unknown) {
        fail++;
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setCopying(false);
    if (ok > 0) {
      onCopied(
        fail === 0
          ? `Copied ${ok} file${ok > 1 ? 's' : ''} into ${targetFolderName}`
          : `Copied ${ok}/${ok + fail}: ${lastErr}`
      );
      onClose();
    } else {
      setErr(lastErr || 'Copy failed');
    }
  };

  return (
    <ComposedModal open size="lg" preventCloseOnClickOutside={copying} onClose={() => { onClose(); return false; }}>
      <ModalHeader title="Copy from Basket" label={`Destination: ${targetFolderName}`} />
      <ModalBody className="h-[60vh] flex flex-col">
        {/* Body: basket picker + file picker — stacks on mobile, side-by-side on md+ */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 overflow-hidden border border-slate-200">
          {/* Source baskets */}
          <div className="border-r overflow-hidden flex flex-col">
            <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-2 shrink-0">
              <Database className="w-4 h-4 text-gray-500" />
              <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">1. Pick a basket</span>
              <div className="ml-auto w-40">
                <Search id="fe-copy-filter" size="sm" labelText="Filter baskets" placeholder="Filter…" value={filter}
                  onChange={(e: any) => setFilter(e.target.value)} onClear={() => setFilter('')} />
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredSources.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-500">No baskets found.</div>
              )}
              {filteredSources.map(b => (
                <button
                  key={b.id}
                  onClick={() => setSelectedSource(b)}
                  className={`w-full text-left px-3 py-2 border-b text-sm hover:bg-blue-50 flex items-center gap-2 ${selectedSource?.id === b.id ? 'bg-blue-100' : ''}`}
                >
                  {basketIcon(b.type)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{b.name}</div>
                    <div className="text-xs text-gray-500">{b.type} · {b._count?.basketFiles ?? 0} files</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Files in selected basket */}
          <div className="overflow-hidden flex flex-col">
            <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-2 shrink-0">
              <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                2. Pick files{selectedFileIds.length > 0 && ` (${selectedFileIds.length} selected)`}
              </span>
              {files.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setSelectedFileIds(selectedFileIds.length === files.length ? [] : files.map(f => f.id))}
                >
                  {selectedFileIds.length === files.length ? 'Clear all' : 'Select all'}
                </Button>
              )}
            </div>
            <div className="overflow-y-auto flex-1">
              {!selectedSource && <div className="px-3 py-4 text-sm text-gray-500">Pick a basket on the left.</div>}
              {selectedSource && loadingFiles && (
                <div className="px-3 py-4">
                  <InlineLoading description="Loading…" />
                </div>
              )}
              {selectedSource && !loadingFiles && files.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-500">No files in this basket.</div>
              )}
              {files.map(f => (
                <div
                  key={f.id}
                  className={`flex items-center gap-2 px-3 py-1 border-b text-sm hover:bg-blue-50 ${selectedFileIds.includes(f.id) ? 'bg-blue-50' : ''} whitespace-nowrap`}
                >
                  <Checkbox
                    id={`fe-copy-file-${f.id}`}
                    labelText={`Select ${f.originalName || f.fileName}`}
                    hideLabel
                    checked={selectedFileIds.includes(f.id)}
                    onChange={() => setSelectedFileIds(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                  />
                  {fileIcon(f.originalName || f.fileName)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{f.originalName || f.fileName}</div>
                    <div className="text-xs text-gray-500">{formatSize(f.size)} · {f.status}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pt-3 text-sm text-gray-600">
          {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Copy failed" subtitle={err} />}
          {!err && selectedFileIds.length > 0 && (
            <span>Will copy <strong>{selectedFileIds.length}</strong> file(s) → <strong>{targetFolderName}</strong></span>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <CdsButton kind="secondary" onClick={onClose} disabled={copying}>Cancel</CdsButton>
        <CdsButton
          kind="primary"
          onClick={doCopy}
          disabled={copying || selectedFileIds.length === 0 || !selectedSource}
          renderIcon={copying ? undefined : ArrowRight}
        >
          {copying ? 'Copying…' : `Copy ${selectedFileIds.length || ''}`}
        </CdsButton>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ─────────── Folder tree subcomponents ─────────── */
interface FolderRowProps {
  folder: Folder | null;
  rootLabel?: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onAddSubfolder?: () => void;
  level?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}
function FolderRow({ folder, rootLabel = 'File Explorer', selected, onSelect, onDelete, onAddSubfolder, level = 0, hasChildren, isExpanded, onToggle }: FolderRowProps) {
  const isRoot = folder === null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const isEmpty = isRoot ? false : ((folder!._count?.files ?? 0) + (folder!._count?.children ?? 0) === 0);

  return (
    <div
      className={`relative flex items-center gap-1 pr-1 py-1 rounded-sm cursor-pointer text-[12.5px] group ${selected ? 'bg-brand/10 text-brand font-semibold' : 'hover:bg-slate-100 text-slate-700'}`}
      style={{ paddingLeft: 8 + level * 14 }}
      onClick={onSelect}
    >
      {hasChildren ? (
        <button onClick={e => { e.stopPropagation(); onToggle?.(); }} className="grid h-6 w-5 place-items-center rounded text-slate-400 hover:bg-slate-200">
          <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </button>
      ) : (
        <span className="w-5" />
      )}
      {isRoot ? <FolderTree className="w-4 h-4 text-brand" /> : (isExpanded ? <FolderOpen className="w-4 h-4 text-amber-500" /> : <FolderIcon className="w-4 h-4 text-amber-500" />)}
      <span className="truncate flex-1">{isRoot ? rootLabel : folder!.name}</span>
      {!isRoot && folder!._count && (
        <span className="flex-shrink-0 text-[12px] tabular-nums font-normal text-slate-400 group-hover:hidden">{folder!._count.files.toLocaleString('en-US')}</span>
      )}
      {/* Kebab — inline, appears on hover. Click to open menu with
          "Add subfolder" + (when empty) "Delete folder". */}
      {(onAddSubfolder || !isRoot) && <IconButton
        kind="ghost"
        size="sm"
        label="Folder actions"
        onClick={(e: any) => { e.stopPropagation(); setMenuOpen(o => !o); }}
        className={`transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </IconButton>}
      {menuOpen && (
        <div
          ref={menuRef}
          onClick={e => e.stopPropagation()}
          className="absolute right-1 top-8 z-50 min-w-[170px] bg-white border border-slate-200 rounded-lg shadow-lg py-1 text-xs"
        >
          {onAddSubfolder && (
            <button
              onClick={() => { setMenuOpen(false); onAddSubfolder(); }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 flex items-center gap-2"
            >
              <FolderPlus className="w-3.5 h-3.5 text-brand" />
              {isRoot ? 'New folder' : 'New subfolder'}
            </button>
          )}
          {!isRoot && isEmpty && (
            <button
              onClick={() => { setMenuOpen(false); onDelete(); }}
              className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete folder
            </button>
          )}
          {!isRoot && !isEmpty && (
            <div className="px-3 py-1.5 text-gray-400 italic select-none">
              <Trash2 className="w-3 h-3 inline-block mr-1.5 -mt-0.5" />
              Cannot delete (not empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface InlineNewFolderInputProps {
  level: number;
  parentName: string;
  value: string;
  creating: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}
function InlineNewFolderInput({ level, parentName, value, creating, onChange, onSubmit, onCancel }: InlineNewFolderInputProps) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-brand/5 border border-brand/20 mt-0.5 mb-0.5"
      style={{ paddingLeft: 8 + level * 14 }}
    >
      <span className="w-4" />
      <FolderPlus className="w-3.5 h-3.5 text-brand shrink-0" />
      <div className="flex-1 min-w-0">
        <TextInput
          id={`fe-new-folder-${level}`}
          labelText="New folder name"
          hideLabel
          size="sm"
          autoFocus
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && value.trim()) onSubmit();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={`new folder in ${parentName}`}
          disabled={creating}
        />
      </div>
      <IconButton kind="primary" size="sm" label="Create" onClick={onSubmit} disabled={creating || !value.trim()}>
        <Check className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton kind="ghost" size="sm" label="Cancel (Esc)" onClick={onCancel}>
        <X className="w-3.5 h-3.5" />
      </IconButton>
    </div>
  );
}

interface FolderTreeViewProps {
  folders: Folder[];
  folderChildren: Record<string, Folder[]>;
  expandedFolders: Set<string>;
  setExpandedFolders: (s: Set<string>) => void;
  currentFolderId: string | null;
  setCurrentFolderId: (id: string | null) => void;
  onDeleteFolder: (id: string) => void;
  onAddSubfolder?: (parentId: string | null) => void;
  parentId: string | null;
  level: number;
  inlineNewFolder?: {
    forFolderId: string;
    parentName: string;
    value: string;
    creating: boolean;
    onChange: (v: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
  } | null;
}
function FolderTreeView({ folders, folderChildren, expandedFolders, setExpandedFolders, currentFolderId, setCurrentFolderId, onDeleteFolder, onAddSubfolder, parentId, level, inlineNewFolder }: FolderTreeViewProps) {
  const children = folderChildren[parentId ?? 'ROOT'] || [];
  return (
    <>
      {children.map(f => {
        const subs = folderChildren[f.id] || [];
        const hasKids = subs.length > 0;
        const showInlineHere = inlineNewFolder?.forFolderId === f.id;
        // Force-expand the folder while we're showing the input inside it
        const expanded = expandedFolders.has(f.id) || showInlineHere;
        return (
          <div key={f.id}>
            <FolderRow
              folder={f}
              selected={currentFolderId === f.id}
              onSelect={() => setCurrentFolderId(f.id)}
              onDelete={() => onDeleteFolder(f.id)}
              onAddSubfolder={onAddSubfolder ? () => onAddSubfolder(f.id) : undefined}
              level={level}
              hasChildren={hasKids || showInlineHere}
              isExpanded={expanded}
              onToggle={() => {
                const next = new Set(expandedFolders);
                if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                setExpandedFolders(next);
              }}
            />
            {showInlineHere && (
              <InlineNewFolderInput
                level={level + 1}
                parentName={inlineNewFolder!.parentName}
                value={inlineNewFolder!.value}
                creating={inlineNewFolder!.creating}
                onChange={inlineNewFolder!.onChange}
                onSubmit={inlineNewFolder!.onSubmit}
                onCancel={inlineNewFolder!.onCancel}
              />
            )}
            {(hasKids || showInlineHere) && expanded && (
              <FolderTreeView
                folders={folders}
                folderChildren={folderChildren}
                expandedFolders={expandedFolders}
                setExpandedFolders={setExpandedFolders}
                currentFolderId={currentFolderId}
                setCurrentFolderId={setCurrentFolderId}
                onDeleteFolder={onDeleteFolder}
                onAddSubfolder={onAddSubfolder}
                parentId={f.id}
                level={level + 1}
                inlineNewFolder={inlineNewFolder}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
