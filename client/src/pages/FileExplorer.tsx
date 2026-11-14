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
  Check, ChevronDown,
  FolderTree, FolderPlus, Folder as FolderIcon, FolderOpen, ChevronRight,
  File as FileIcon, FileSpreadsheet, FileText, Eye, Download, Trash2, MoreVertical,
  ArrowRight, RefreshCw, Database, HardDrive, Inbox, Loader2, FileInput, X, Link2,
  Upload, Package, Unlink, Plus, Search,
} from 'lucide-react';
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
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const list = Object.entries(projects).sort(([, a], [, b]) => a.localeCompare(b, 'th')).filter(([, n]) => n.toLowerCase().includes(q.toLowerCase()));
  const initial = (n: string) => (n.replace(/^[^A-Za-z\u0E00-\u0E7F]+/, '')[0] || '?').toUpperCase();
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className={cx('flex h-9 w-full items-center gap-2 rounded-lg border bg-white px-2.5 text-left text-[13px]', open ? 'border-brand ring-2 ring-brand/20' : 'border-slate-200 hover:border-slate-300')}>
        {value ? <>
          <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded bg-brand text-[12px] font-semibold text-white">{initial(projects[value] || '')}</span>
          <span className="min-w-0 flex-1 truncate">{projects[value]}</span>
        </> : <span className="flex-1 text-slate-400">Select project…</span>}
        <ChevronDown className={cx('h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search project"
                className="h-8 w-full rounded border border-slate-200 pl-7 pr-2 text-[12.5px] outline-none focus:border-brand" />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {list.length === 0 && <div className="px-2 py-3 text-center text-[12px] text-slate-400">No project found</div>}
            {list.map(([id, n]) => (
              <button key={id} type="button" onClick={() => { onChange(id); setOpen(false); setQ(''); }}
                className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px]', id === value ? 'bg-brand/10 text-brand' : 'hover:bg-slate-50')}>
                <span className={cx('grid h-5 w-5 flex-shrink-0 place-items-center rounded text-[12px] font-semibold', id === value ? 'bg-brand text-white' : 'bg-slate-200 text-slate-600')}>{initial(n)}</span>
                <span className="min-w-0 flex-1 truncate">{n}</span>
                {id === value && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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
        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
        Loading File Explorer…
      </div>
    );
  }
  if (error || !cur) {
    return (
      <div className="p-8 max-w-xl">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4">
          <h2 className="font-medium mb-2">File Explorer unavailable</h2>
          <p className="text-sm">{error || 'Could not resolve the File Explorer basket.'}</p>
          <button
            onClick={() => setLoadAttempt(n => n + 1)}
            className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 text-[13px] bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-100"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
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
  const btn = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 hover:bg-slate-50 disabled:opacity-50';
  const primary = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded bg-brand px-3 text-[12.5px] font-medium text-white hover:bg-brand/90 disabled:opacity-50';
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
              <button type="button" onClick={() => setShowLinkModal(true)} title="Link a project basket" aria-label="Link basket"
                className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-200 hover:text-brand">
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
            {single
              ? <>{basketEntry('single', inFe && currentFolderId === null, single.name, 'File Explorer', <FolderTree className="h-3.5 w-3.5" />, () => openFeFolder(null),
                  canWrite ? <button type="button" onClick={() => openAddSubfolder(null)} title="New folder" className="grid h-6 w-6 place-items-center rounded text-slate-400 opacity-0 hover:bg-slate-200 hover:text-brand group-hover:opacity-100"><FolderPlus className="h-3.5 w-3.5" /></button> : undefined)}
                  {tree}</>
              : <>
                  {(feHasContent || cur.isFe) && basketEntry('fe', inFe && cur.isFe, 'File Explorer', '', <FolderTree className="h-3.5 w-3.5" />, () => (cur.isFe ? openFeFolder(null) : goFeRoot()),
                    canWrite && cur.isFe ? <button type="button" onClick={() => openAddSubfolder(null)} title="New folder" className="grid h-6 w-6 place-items-center rounded text-slate-400 opacity-0 hover:bg-slate-200 hover:text-brand group-hover:opacity-100"><FolderPlus className="h-3.5 w-3.5" /></button> : undefined)}
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
                            <button type="button" onClick={() => unlinkBasket(l)} title="Unlink (the basket is not deleted)"
                              className="grid h-6 w-6 flex-shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200 hover:text-red-600 sm:opacity-0 sm:group-hover:opacity-100">
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
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
                <span className={cx('rounded px-2 py-1 text-[11.5px]', /Copied|Uploaded \d+ file/.test(copyMessage) && !copyMessage.includes(':') ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
                  {copyMessage}
                </span>
              )}
              <div className="relative w-[160px] lg:w-[200px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search this folder"
                  className="h-8 w-full rounded border border-slate-200 bg-white pl-7 pr-7 text-[12.5px] outline-none focus:border-brand" />
                {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"><X className="h-3 w-3" /></button>}
              </div>
              {sel.size > 0 ? (
                <>
                  <span className="whitespace-nowrap text-[12px] text-slate-400">Selected <b className="text-slate-800">{n0(sel.size)}</b></span>
                  <button type="button" onClick={downloadSelected} className={primary}><Download className="h-3.5 w-3.5" /> Download selected</button>
                  <button type="button" onClick={() => setSel(new Set())} className={btn} title="Clear selection"><X className="h-3.5 w-3.5" /></button>
                </>
              ) : (
                <>
                  {inFe && canWrite && (
                    <button type="button" onClick={() => openAddSubfolder(currentFolderId)} className={btn} title="New folder">
                      <FolderPlus className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {inFe && canWrite && (
                    <button type="button" onClick={() => setShowCopyModal(true)} className={btn} title="Copy files from a basket">
                      <FileInput className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {feOnly && (
                    <button type="button" onClick={() => copyLink()} className={btn} title="Copy a link to this folder (opening it requires login)">
                      <Link2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {inFe && canWrite && (
                    <>
                      <input ref={uploadRef} type="file" multiple hidden onChange={onUpload} />
                      <button type="button" onClick={() => uploadRef.current?.click()} disabled={busy} className={btn} title="Upload">
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      </button>
                    </>
                  )}
                  {inFe && (
                    <a href={withAuthToken(`${API_URL}/file-explorer/folders/${currentFolderId ?? 'root'}/download?basketId=${cur.id}`)} className={primary}
                      title="Download every file in this folder (including subfolders) as a ZIP">
                      <Download className="h-3.5 w-3.5" /><span className="hidden sm:inline">Download ZIP</span>
                    </a>
                  )}
                </>
              )}
              <button type="button" onClick={() => (inFe ? reloadFE() : reloadLink())} title="Refresh" className={btn}>
                <RefreshCw className={cx('h-3.5 w-3.5', isLoadingList && 'animate-spin')} />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {isLoadingList ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : folderItems.length === 0 && fileItems.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-[13px] text-slate-400">
                <FolderOpen className="h-10 w-10" strokeWidth={1.2} />
                {q ? 'No matches' : 'This folder is empty'}
                {!q && canWrite && inFe && (
                  <button type="button" onClick={() => uploadRef.current?.click()} className="text-[12.5px] text-brand hover:underline">Upload files</button>
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
                    <table className="w-full text-[12.5px]">
                      <thead className="sticky top-0 bg-white">
                        <tr className="border-b border-slate-200 text-left text-[11.5px] text-slate-400">
                          <th className="w-8 py-1.5 pl-3">
                            <input type="checkbox" checked={allSel} aria-label="Select all" className="h-3.5 w-3.5 accent-brand"
                              onChange={() => setSel(allSel ? new Set() : new Set(pageItems.map(f => f.id)))} />
                          </th>
                          <th className="py-1.5 font-medium">Name</th>
                          <th className="w-[90px] py-1.5 pr-2 text-right font-medium">Size</th>
                          <th className="w-[110px] py-1.5 pr-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {pageItems.map(f => {
                          const name = f.originalName || f.fileName;
                          const on = sel.has(f.id);
                          return (
                            <tr key={f.id} id={`fe-file-${f.id}`}
                              className={cx('group align-middle', on ? 'bg-brand/10' : feOnly && f.id === highlightFileId ? 'bg-amber-50' : 'hover:bg-slate-50')}>
                              <td className="py-1.5 pl-3">
                                <input type="checkbox" checked={on} aria-label={`Select ${name}`} className="h-3.5 w-3.5 accent-brand"
                                  onChange={() => setSel(prev => { const s = new Set(prev); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); return s; })} />
                              </td>
                              <td className="py-1.5 pr-2">
                                <button type="button" onClick={() => viewFile(fileBasketId, f.id, name)} className="flex min-w-0 items-center gap-2 text-left hover:text-brand">
                                  {rowIcon(name)}
                                  <span className="min-w-0 break-all leading-snug">{name}{!inFe && <span className="ml-1.5 text-[12px] text-slate-400">{f.status}</span>}</span>
                                </button>
                              </td>
                              <td className="whitespace-nowrap py-1.5 pr-2 text-right text-[12px] tabular-nums text-slate-400">{formatSize(f.size)}</td>
                              <td className="py-1.5 pr-3">
                                <div className="flex justify-end gap-0.5 md:opacity-0 md:group-hover:opacity-100">
                                  {feOnly && <button type="button" title="Copy link to this file" onClick={() => copyLink(f.id)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand"><Link2 className="h-3.5 w-3.5" /></button>}
                                  <button type="button" title="View" onClick={() => viewFile(fileBasketId, f.id, name)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand"><Eye className="h-3.5 w-3.5" /></button>
                                  <button type="button" title="Download" onClick={() => downloadFile(fileBasketId, f.id, name)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand"><Download className="h-3.5 w-3.5" /></button>
                                  {canWrite && <button type="button" title="Delete" onClick={() => deleteFile(f.id)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
          {fileItems.length > 0 && (
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2 text-[11.5px] text-slate-500">
              <span className="tabular-nums">Showing {n0((pageNo - 1) * pageSize + 1)}–{n0((pageNo - 1) * pageSize + pageItems.length)} of {n0(fileItems.length)} items</span>
              <span className="ml-2">Per page</span>
              <div className="flex overflow-hidden rounded border border-slate-200">
                {[50, 100, 200].map(n => (
                  <button key={n} type="button" onClick={() => { setPageSize(n); setPage(1); }}
                    className={cx('px-2.5 py-1 tabular-nums', n === pageSize ? 'bg-brand text-white' : 'hover:bg-slate-50')}>{n}</button>
                ))}
              </div>
              {pages > 1 && (
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">‹</button>
                  <span className="tabular-nums">{pageNo} / {pages}</span>
                  <button type="button" disabled={pageNo >= pages} onClick={() => setPage(pageNo + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">›</button>
                </div>
              )}
            </div>
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <Package className="w-4 h-4 text-brand" />
          <h2 className="text-[14px] font-medium text-slate-900">Add basket</h2>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-500" /></button>
        </div>
        <div className="flex gap-1 px-4 pt-3">
          {([['create', 'Create new'], ['link', 'Link existing basket']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setMode(k); setErr(null); }}
              className={cx('rounded-lg px-3 py-1.5 text-[12.5px]', mode === k ? 'bg-brand/10 font-medium text-brand' : 'text-slate-500 hover:bg-slate-50')}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'create' ? (
          <div className="space-y-3 px-4 py-4">
            <div className="block">
              <span className="mb-1 block text-[12px] text-slate-500">Project</span>
              <ProjectPicker projects={projects} value={newProject} onChange={setNewProject} />
            </div>
            <label className="block">
              <span className="mb-1 block text-[12px] text-slate-500">Basket name</span>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Meeting documents"
                onKeyDown={e => { if (e.key === 'Enter') create(); }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </label>
            <p className="text-[11.5px] text-slate-400">Created as a File Explorer basket in the selected project — everyone with access to that project can see it</p>
            {err && <div className="text-[12px] text-red-600">{err}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="text-[13px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Cancel</button>
              <button type="button" onClick={create} disabled={!newProject || !newName.trim() || saving}
                className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-lg bg-brand text-white hover:opacity-90 disabled:opacity-40">
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Create basket
              </button>
            </div>
          </div>
        ) : (<>
        <div className="px-4 pt-3">
          <input autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search project or basket…"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 && <div className="px-2 py-6 text-center text-[13px] text-slate-400">No basket found</div>}
          {groups.map(([pn, list]) => (
            <div key={pn} className="mb-2">
              <div className="px-2 py-1 text-[12px] font-medium text-slate-400">{pn}</div>
              {list.map(b => {
                const linked = linkedIds.includes(b.id);
                const on = picked?.id === b.id;
                return (
                  <button key={b.id} type="button" disabled={linked} onClick={() => setPicked(b)}
                    className={cx('w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2.5 text-[13px]',
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
        <div className="px-4 py-3 border-t border-slate-200 space-y-2">
          <input value={name} onChange={e => setName(e.target.value)} disabled={!picked}
            placeholder={picked ? `Display name (blank = ${(picked.projectId && projects[picked.projectId]) ? `${projects[picked.projectId]} · ` : ''}${picked.name})` : 'Select a basket first'}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-50" />
          {err && <div className="text-[12px] text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="text-[13px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Cancel</button>
            <button type="button" onClick={save} disabled={!picked || saving}
              className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-lg bg-brand text-white hover:opacity-90 disabled:opacity-40">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Link basket
            </button>
          </div>
        </div>
        </>)}
      </div>
    </div>
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2">
            <FileInput className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Copy from Basket</h2>
            <span className="text-sm text-gray-500 ml-2">→ destination: <strong>{targetFolderName}</strong></span>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body: basket picker + file picker — stacks on mobile, side-by-side on md+ */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 overflow-hidden">
          {/* Source baskets */}
          <div className="border-r overflow-hidden flex flex-col">
            <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-2 shrink-0">
              <Database className="w-4 h-4 text-gray-500" />
              <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">1. Pick a basket</span>
              <input
                type="text"
                placeholder="Filter…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                className="ml-auto px-2 py-0.5 text-xs border rounded w-32"
              />
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
                <button
                  className="ml-auto text-xs text-blue-600 hover:underline"
                  onClick={() => setSelectedFileIds(selectedFileIds.length === files.length ? [] : files.map(f => f.id))}
                >
                  {selectedFileIds.length === files.length ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
            <div className="overflow-y-auto flex-1">
              {!selectedSource && <div className="px-3 py-4 text-sm text-gray-500">Pick a basket on the left.</div>}
              {selectedSource && loadingFiles && (
                <div className="px-3 py-4 text-sm text-gray-500 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              )}
              {selectedSource && !loadingFiles && files.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-500">No files in this basket.</div>
              )}
              {files.map(f => (
                <label
                  key={f.id}
                  className={`flex items-center items-start gap-2 px-3 h-9 border-b text-sm hover:bg-blue-50 cursor-pointer ${selectedFileIds.includes(f.id) ? 'bg-blue-50' : ''} whitespace-nowrap`}
                >
                  <input
                    type="checkbox"
                    checked={selectedFileIds.includes(f.id)}
                    onChange={() => setSelectedFileIds(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="mt-0.5"
                  />
                  {fileIcon(f.originalName || f.fileName)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{f.originalName || f.fileName}</div>
                    <div className="text-xs text-gray-500">{formatSize(f.size)} · {f.status}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {err && <span className="text-red-600">⚠ {err}</span>}
            {!err && selectedFileIds.length > 0 && (
              <span>Will copy <strong>{selectedFileIds.length}</strong> file(s) → <strong>{targetFolderName}</strong></span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={copying} className="inline-flex items-center justify-center px-3 h-9 text-[14px] border rounded hover:bg-white whitespace-nowrap">
              Cancel
            </button>
            <button
              onClick={doCopy}
              disabled={copying || selectedFileIds.length === 0 || !selectedSource}
              className="inline-flex items-center gap-2 px-3 h-9 text-[14px] disabled:cursor-not-allowed rounded whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
            >
              {copying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {copying ? 'Copying…' : `Copy ${selectedFileIds.length || ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
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
      {(onAddSubfolder || !isRoot) && <button
        onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
        className={`p-0.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        title="Folder actions"
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>}
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
      <input
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) onSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={`new folder in ${parentName}`}
        className="flex-1 min-w-0 text-xs bg-white border border-slate-200 rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-brand/30"
        disabled={creating}
      />
      <button
        onClick={onSubmit}
        disabled={creating || !value.trim()}
        className="inline-flex items-center justify-center px-2 h-7 text-[12px] rounded disabled:opacity-40 whitespace-nowrap bg-brand text-white hover:opacity-90"
        title="Create"
      >
        ✓
      </button>
      <button
        onClick={onCancel}
        className="inline-flex items-center justify-center px-1.5 h-7 text-[12px] text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded whitespace-nowrap"
        title="Cancel (Esc)"
      >
        ×
      </button>
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
