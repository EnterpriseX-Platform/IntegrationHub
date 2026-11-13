// SFTP browser for an SFTP connection — WinSCP/FileZilla-style remote view:
// navigate folders, download, upload, new folder, rename, delete.
// Server side: server/src/routes/connectionSftp.ts

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiFetch, authHeaders, withAuthToken } from '../../config/api';
import {
  AlertCircle, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, CornerLeftUp, Download, Eye, FileText, Folder, FolderOpen,
  FolderPlus, HardDrive, Home, Info, Link2, Loader2, Pencil, RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react';
import { fileToBase64, uploadB64Url, UPLOAD_B64_CONTENT_TYPE } from '../../utils/uploadB64';

interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string | null;
  permissions: string;
}

interface Props {
  connectionId: string;
  connectionName: string;
  onClose: () => void;
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function parentOf(p: string) {
  if (!p || p === '/') return '/';
  const parts = p.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

const PREVIEW_MAX = 5 * 1024 * 1024;
const TEXT_EXT = ['txt','csv','tsv','json','xml','log','md','sql','yml','yaml','ini','conf','properties','sh','html','htm','js','ts','dat','asc','pgp','gpg','ctl','out','err'];
const IMAGE_EXT = ['png','jpg','jpeg','gif','bmp','webp','svg'];

function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

type Preview =
  | { kind: 'text'; entry: Entry; bytes: ArrayBuffer }
  | { kind: 'image' | 'pdf'; entry: Entry; url: string }
  | { kind: 'loading'; entry: Entry };

interface TreeProps {
  listUrl: string;
  path: string;
  name: string;
  currentPath: string;
  onOpen: (path: string) => void;
  depth?: number;
}

/** Lazy-loading folder tree, like the left pane of WinSCP/FileZilla. */
function FolderTree({ listUrl, path, name, currentPath, onOpen, depth = 0 }: TreeProps) {
  const [open, setOpen] = useState(depth === 0 || currentPath.startsWith(path.replace(/\/$/, '') + '/'));
  const [children, setChildren] = useState<Entry[] | null>(null);

  useEffect(() => {
    if (!open || children) return;
    fetch(`${listUrl}?path=${encodeURIComponent(path)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((j) => setChildren(j.success ? j.data.entries.filter((e: Entry) => e.type === 'directory') : []))
      .catch(() => setChildren([]));
  }, [open, children, listUrl, path]);

  const active = currentPath === path;
  return (
    <div>
      <div
        className={`flex items-center gap-1 h-7 pr-2 cursor-pointer whitespace-nowrap rounded-md ${active ? 'bg-blue-100 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-200/60'}`}
        style={{ paddingLeft: depth * 14 + 2 }}
        onClick={() => onOpen(path)}
      >
        <button
          className="h-5 w-5 inline-flex items-center justify-center text-gray-400 hover:text-gray-700"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {open
          ? <FolderOpen size={15} className="shrink-0 text-amber-500" />
          : <Folder size={15} className="shrink-0 text-amber-500 fill-amber-100" />}
        <span className="truncate">{name}</span>
      </div>
      {open && children?.map((c) => (
        <FolderTree key={c.path} listUrl={listUrl} path={c.path} name={c.name} currentPath={currentPath} onOpen={onOpen} depth={depth + 1} />
      ))}
      {open && children === null && (
        <div className="h-6 flex items-center text-xs text-gray-400" style={{ paddingLeft: depth * 14 + 26 }}>Loading…</div>
      )}
    </div>
  );
}

export default function SftpBrowserModal({ connectionId, connectionName, onClose }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [encoding, setEncoding] = useState<'utf-8' | 'windows-874'>('utf-8');
  const [treeKey, setTreeKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const crumbRef = useRef<HTMLDivElement>(null);
  const base = api(`/connections/${connectionId}/sftp`);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/list?path=${encodeURIComponent(dir)}`, { headers: authHeaders() });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'List failed');
      setCurrentPath(json.data.path);
      setPathInput(json.data.path);
      setEntries(json.data.entries);
      setNotice(json.data.notice || null);
      setSelected(null);
      setPreview((prev) => {
        if (prev && 'url' in prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(''); }, [load]);
  useEffect(() => { crumbRef.current?.scrollTo({ left: crumbRef.current.scrollWidth }); }, [currentPath, editingPath]);

  const post = async (action: string, body: unknown) => {
    const res = await apiFetch(`${base}/${action}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || `${action} failed`);
    return json;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load(currentPath);
      setTreeKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Let the browser download it natively: shows its own progress and never holds a
  // 600 MB file in page memory. Errors come back as the server's JSON page.
  const download = (entry: Entry) => {
    const a = document.createElement('a');
    a.href = withAuthToken(`${base}/download?path=${encodeURIComponent(entry.path)}`);
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    run(`Uploading ${files.length} file(s)`, async () => {
      for (const file of Array.from(files)) {
        const body = await fileToBase64(file);
        const res = await fetch(uploadB64Url(`${base}/upload`, file, { dir: currentPath }), {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': UPLOAD_B64_CONTENT_TYPE }),
          body,
        });
        const json = await res.json();
        if (!json.success) throw new Error(`${file.name}: ${json.error || 'upload failed'}`);
      }
    });
    if (fileInput.current) fileInput.current.value = '';
  };

  const mkdir = () => {
    const name = window.prompt('New folder name');
    if (!name) return;
    run('Creating folder', () => post('mkdir', { path: `${currentPath.replace(/\/$/, '')}/${name}` }));
  };

  const rename = (entry: Entry) => {
    const name = window.prompt('Rename to', entry.name);
    if (!name || name === entry.name) return;
    run('Renaming', () => post('rename', { from: entry.path, to: `${parentOf(entry.path).replace(/\/$/, '')}/${name}` }));
  };

  const remove = (entry: Entry) => {
    const what = entry.type === 'directory' ? 'folder (must be empty)' : 'file';
    if (!window.confirm(`Delete ${what} "${entry.name}" on the remote server?`)) return;
    run('Deleting', () => post('delete', { path: entry.path, type: entry.type }));
  };

  const closePreview = () => {
    if (preview && 'url' in preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const view = async (entry: Entry) => {
    const ext = extOf(entry.name);
    const kind = IMAGE_EXT.includes(ext) ? 'image' : ext === 'pdf' ? 'pdf' : 'text';
    if (kind === 'text' && ext && !TEXT_EXT.includes(ext)) {
      if (!window.confirm(`.${ext} may be a binary file. Preview it as text anyway? (Cancel = download)`)) {
        download(entry);
        return;
      }
    }
    if (entry.size > PREVIEW_MAX) {
      setError(`${entry.name} is ${formatSize(entry.size)} — too large to preview (max ${formatSize(PREVIEW_MAX)}). Download it instead.`);
      return;
    }
    closePreview();
    setPreview({ kind: 'loading', entry });
    try {
      const res = await fetch(`${base}/download?path=${encodeURIComponent(entry.path)}`, { headers: authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || `Preview failed (${res.status})`);
      }
      const blob = await res.blob();
      if (kind === 'text') {
        setPreview({ kind, entry, bytes: await blob.arrayBuffer() });
      } else {
        const typed = new Blob([blob], { type: kind === 'pdf' ? 'application/pdf' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}` });
        setPreview({ kind, entry, url: URL.createObjectURL(typed) });
      }
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const open = (entry: Entry) => {
    if (entry.type === 'file') view(entry);
    else load(entry.path);
  };

  const visible = entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()));
  const crumbs = currentPath.split('/').filter(Boolean);
  const folderCount = entries.filter((e) => e.type === 'directory').length;
  const fileCount = entries.length - folderCount;
  const iconBtn = 'h-8 w-8 inline-flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 disabled:hover:bg-transparent';
  const rowBtn = 'h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:bg-white hover:shadow-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 backdrop-blur-[1px] p-0 sm:p-6" onClick={onClose}>
      <div className="bg-white sm:rounded-xl shadow-2xl w-full max-w-[1400px] h-full sm:h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-3 sm:px-5 py-3 sm:py-3.5 border-b border-gray-200">
          <div className="h-9 w-9 rounded-lg bg-green-50 text-green-600 flex items-center justify-center shrink-0">
            <HardDrive size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-gray-900 truncate">{connectionName}</h2>
            <p className="text-xs text-gray-500">SFTP Browser</p>
          </div>
          <button onClick={onClose} className={iconBtn} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-5 py-2 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center">
            <button className={iconBtn} title="Up one level" onClick={() => load(parentOf(currentPath))} disabled={loading || currentPath === '/'}>
              <ArrowUp size={16} />
            </button>
            <button className={iconBtn} title="Home" onClick={() => load('')} disabled={loading}>
              <Home size={16} />
            </button>
            <button className={iconBtn} title="Refresh" onClick={() => load(currentPath)} disabled={loading}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Path: breadcrumb, click to type a path */}
          <div className="flex-1 min-w-0 h-8 bg-white border border-gray-300 rounded-md flex items-center">
            {editingPath ? (
              <form className="flex-1" onSubmit={(e) => { e.preventDefault(); setEditingPath(false); load(pathInput); }}>
                <input
                  autoFocus
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onBlur={() => { setEditingPath(false); setPathInput(currentPath); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setEditingPath(false); setPathInput(currentPath); } }}
                  className="w-full h-8 px-2.5 text-sm font-mono bg-transparent outline-none"
                />
              </form>
            ) : (
              <div className="flex-1 min-w-0 flex items-center h-full px-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-sm cursor-text" ref={crumbRef} onClick={() => setEditingPath(true)} title="Click to type a path">
                <button className="px-1 rounded text-gray-500 hover:text-blue-600 hover:bg-blue-50" onClick={(e) => { e.stopPropagation(); load('/'); }}>/</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="flex items-center shrink-0">
                    <ChevronRight size={13} className="text-gray-300" />
                    <button
                      className={`px-1 rounded hover:text-blue-600 hover:bg-blue-50 ${i === crumbs.length - 1 ? 'text-gray-900 font-medium' : 'text-gray-600'}`}
                      onClick={(e) => { e.stopPropagation(); load('/' + crumbs.slice(0, i + 1).join('/')); }}
                    >
                      {c}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="relative order-last w-full sm:order-none sm:w-auto">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-full sm:w-44 pl-8 pr-2 text-sm bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Filter"
            />
          </div>
          <button
            className="h-9 px-2.5 inline-flex items-center gap-1.5 text-[14px] font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            onClick={mkdir}
            disabled={!!busy}
            title="New folder"
          >
            <FolderPlus size={15} /><span className="hidden md:inline">New folder</span>
          </button>
          <button
            className="h-9 px-3 inline-flex items-center gap-1.5 text-[14px] font-medium rounded-lg shadow-sm disabled:opacity-50 bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => fileInput.current?.click()}
            disabled={!!busy}
            title="Upload files"
          >
            <Upload size={15} /><span className="hidden md:inline">Upload</span>
          </button>
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        </div>

        {/* Status line */}
        {(error || busy || notice) && (
          <div className={`flex items-center gap-2 px-5 py-2 text-sm border-b ${
            error ? 'bg-red-50 text-red-700 border-red-100' : busy ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-amber-50 text-amber-800 border-amber-100'
          }`}>
            {error ? <AlertCircle size={15} className="shrink-0" /> : busy ? <Loader2 size={15} className="shrink-0 animate-spin" /> : <Info size={15} className="shrink-0" />}
            <span className="flex-1 min-w-0">
              {error || (busy ? `${busy}…` : `${notice} — showing ${currentPath} instead.`)}
            </span>
            {error && <button className="text-red-500 hover:text-red-700" onClick={() => setError(null)}><X size={14} /></button>}
          </div>
        )}

        <div className="relative flex-1 flex min-h-0">
          {/* Folder tree */}
          <div className={`w-56 shrink-0 border-r border-gray-200 bg-gray-50/70 overflow-auto py-2 px-1.5 text-sm hidden ${preview ? 'xl:block' : 'lg:block'}`}>
            <FolderTree key={treeKey} listUrl={`${base}/list`} path="/" name="/" currentPath={currentPath} onOpen={load} />
          </div>

          {/* File list */}
          <div
            className="flex-1 min-w-0 overflow-auto"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}
          >
            <table className="w-full text-sm table-fixed">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <th className="text-left font-semibold px-3 sm:px-4 py-2.5">Name</th>
                  <th className="text-right font-semibold px-3 py-2.5 w-20 sm:w-24">Size</th>
                  <th className={`text-left font-semibold px-3 py-2.5 w-40 hidden md:table-cell ${preview ? 'lg:hidden' : ''}`}>Modified</th>
                  <th className={`text-left font-semibold px-3 py-2.5 w-16 hidden ${preview ? '' : 'lg:table-cell'}`}>Perm</th>
                </tr>
              </thead>
              <tbody>
                {currentPath !== '/' && currentPath && (
                  <tr className="cursor-pointer select-none hover:bg-gray-50 border-b border-gray-100" onDoubleClick={() => load(parentOf(currentPath))} onClick={() => load(parentOf(currentPath))}>
                    <td className="px-4 py-2 text-gray-500">
                      <span className="inline-flex items-center gap-2.5"><CornerLeftUp size={16} className="text-gray-400" />..</span>
                    </td>
                    <td />
                    <td className={`hidden md:table-cell ${preview ? 'lg:hidden' : ''}`} />
                    <td className={`hidden ${preview ? '' : 'lg:table-cell'}`} />
                  </tr>
                )}
                {visible.map((e) => {
                  const active = selected === e.path || preview?.entry.path === e.path;
                  return (
                    <tr
                      key={e.path}
                      className={`group cursor-pointer select-none border-b border-gray-100 ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => setSelected(e.path)}
                      onDoubleClick={() => open(e)}
                    >
                      <td className="relative px-3 sm:px-4 py-2.5 sm:py-2" title={e.name}>
                        <span className="flex items-center gap-2.5 min-w-0">
                          {e.type === 'directory'
                            ? <Folder size={17} className="shrink-0 text-amber-500 fill-amber-100" />
                            : e.type === 'symlink'
                              ? <Link2 size={17} className="shrink-0 text-gray-400" />
                              : <FileText size={17} className="shrink-0 text-gray-400" />}
                          <span className={`truncate ${e.type === 'directory' ? 'text-gray-900' : 'text-gray-700'}`}>{e.name}</span>
                        </span>
                        <span className={`absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-0.5 rounded-md px-1 ${active ? 'bg-blue-50' : 'bg-gray-50 hidden group-hover:inline-flex'}`}>
                          {e.type !== 'directory' && (
                            <button title="Preview" className={`${rowBtn} hover:text-blue-600`} onClick={(ev) => { ev.stopPropagation(); view(e); }}>
                              <Eye size={15} />
                            </button>
                          )}
                          {e.type !== 'directory' && (
                            <button title="Download" className={`${rowBtn} hover:text-green-600`} onClick={(ev) => { ev.stopPropagation(); download(e); }}>
                              <Download size={15} />
                            </button>
                          )}
                          <button title="Rename" className={`${rowBtn} hover:text-blue-600`} onClick={(ev) => { ev.stopPropagation(); rename(e); }}>
                            <Pencil size={14} />
                          </button>
                          <button title="Delete" className={`${rowBtn} hover:text-red-600`} onClick={(ev) => { ev.stopPropagation(); remove(e); }}>
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums whitespace-nowrap">{e.type === 'directory' ? '—' : formatSize(e.size)}</td>
                      <td className={`px-3 py-2 text-gray-500 tabular-nums whitespace-nowrap hidden md:table-cell ${preview ? 'lg:hidden' : ''}`}>
                          {e.modifiedAt ? new Date(e.modifiedAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : ''}
                        </td>
                      <td className={`px-3 py-2 text-gray-400 font-mono text-xs hidden ${preview ? '' : 'lg:table-cell'}`}>{e.permissions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && visible.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <FolderOpen size={40} strokeWidth={1.25} />
                <p className="mt-3 text-sm">{filter ? 'No files match the filter' : 'This folder is empty'}</p>
                {!filter && <p className="text-xs mt-1">Drop files here to upload</p>}
              </div>
            )}
          </div>

          {/* Preview */}
          {preview && (
            <div className="absolute inset-0 z-20 lg:static lg:z-auto lg:w-[44%] lg:min-w-[360px] shrink-0 lg:border-l border-gray-200 flex flex-col min-h-0 bg-gray-50">
              <div className="flex items-center gap-2 px-4 h-11 border-b border-gray-200 bg-white">
                <button className={`${rowBtn} lg:hidden -ml-2`} onClick={closePreview} title="Back to files"><ArrowLeft size={16} /></button>
                <FileText size={16} className="text-gray-400 shrink-0 hidden lg:block" />
                <span className="text-sm font-medium text-gray-900 truncate flex-1" title={preview.entry.path}>{preview.entry.name}</span>
                {preview.kind === 'text' && (
                  <select
                    value={encoding}
                    onChange={(e) => setEncoding(e.target.value as 'utf-8' | 'windows-874')}
                    className="h-8 text-xs border border-gray-300 rounded-md px-1.5 bg-white"
                    title="Text encoding"
                  >
                    <option value="utf-8">UTF-8</option>
                    <option value="windows-874">TIS-620</option>
                  </select>
                )}
                <button title="Download" className={`${rowBtn} hover:text-green-600`} onClick={() => download(preview.entry)}>
                  <Download size={15} />
                </button>
                <button title="Close preview" className={`${rowBtn} hover:text-gray-900`} onClick={closePreview}>
                  <X size={15} />
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {preview.kind === 'loading' && (
                  <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" />Loading preview…</div>
                )}
                {preview.kind === 'text' && (
                  <pre className="m-3 p-3 bg-white border border-gray-200 rounded-md text-xs leading-5 font-mono whitespace-pre-wrap break-all text-gray-800">
                    {new TextDecoder(encoding).decode(preview.bytes)}
                  </pre>
                )}
                {preview.kind === 'image' && (
                  <div className="p-4 flex justify-center"><img src={preview.url} alt={preview.entry.name} className="max-w-full rounded border border-gray-200 bg-white" /></div>
                )}
                {preview.kind === 'pdf' && (
                  <iframe src={preview.url} title={preview.entry.name} className="w-full h-full" />
                )}
              </div>
              <div className="px-4 py-1.5 border-t border-gray-200 bg-white text-xs text-gray-500">
                {formatSize(preview.entry.size)}
                {preview.entry.modifiedAt && ` · ${new Date(preview.entry.modifiedAt).toLocaleString('en-GB', { hour12: false })}`}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-2 border-t border-gray-200 bg-gray-50 text-xs text-gray-500">
          <span>{folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} file{fileCount === 1 ? '' : 's'}</span>
          <span className="hidden md:inline text-gray-400">Double-click a folder to open it or a file to preview · Drag files here to upload</span>
        </div>
      </div>
    </div>
  );
}
