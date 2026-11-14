// Baskets — Operator dashboard (refined console)
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, RotateCcw, Package, Clock, Loader2, ArrowUpRight, FolderOpen,
  Inbox, Server, Folder, GripVertical,
} from 'lucide-react';
import { API_URL } from '../config/api';
import ProjectTreeSidebar, { SidebarFilter, SidebarProject } from '../components/operator/ProjectTreeSidebar';
import { filterByScope, buildProjectsById } from '../components/operator/operatorUtils';
import { useProjectTagGroups, parseTagsField } from '../components/operator/useProjectTagGroups';
import { TagGroupView } from '../components/operator/TagGroupView';
import { apiFetch } from '../config/api';

interface Project extends SidebarProject {}

interface Basket {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  projectName?: string;
  projectColor?: string;
  type: 'batch' | 'shares' | 'sftp' | string;
  sftpMode?: string;
  fileCount: number;
  activeFileCount?: number;
  activeSessionCount?: number;
  createdAt: string;
  updatedAt: string;
  tags?: string;          // JSON string of tag-name array
  displayOrder?: number;
}

const PROJECT_COLORS: Record<string, { dot: string; chip: string; chipText: string; edge: string }> = {
  blue:   { dot: 'bg-blue-500',   chip: 'bg-blue-50',   chipText: 'text-blue-700',   edge: 'bg-blue-400'   },
  purple: { dot: 'bg-purple-500', chip: 'bg-purple-50', chipText: 'text-purple-700', edge: 'bg-purple-400' },
  green:  { dot: 'bg-green-500',  chip: 'bg-green-50',  chipText: 'text-green-700',  edge: 'bg-green-400'  },
  orange: { dot: 'bg-orange-500', chip: 'bg-orange-50', chipText: 'text-orange-700', edge: 'bg-orange-400' },
  pink:   { dot: 'bg-pink-500',   chip: 'bg-pink-50',   chipText: 'text-pink-700',   edge: 'bg-pink-400'   },
  cyan:   { dot: 'bg-cyan-500',   chip: 'bg-cyan-50',   chipText: 'text-cyan-700',   edge: 'bg-cyan-400'   },
  indigo: { dot: 'bg-indigo-500', chip: 'bg-indigo-50', chipText: 'text-indigo-700', edge: 'bg-indigo-400' },
  amber:  { dot: 'bg-amber-500',  chip: 'bg-amber-50',  chipText: 'text-amber-700',  edge: 'bg-amber-400'  },
  red:    { dot: 'bg-red-500',    chip: 'bg-red-50',    chipText: 'text-red-700',    edge: 'bg-red-400'    },
  teal:   { dot: 'bg-teal-500',   chip: 'bg-teal-50',   chipText: 'text-teal-700',   edge: 'bg-teal-400'   },
};
const getColor = (c?: string) => PROJECT_COLORS[c || 'blue'] || PROJECT_COLORS.blue;

function TypeBadge({ type, sftpMode }: { type: string; sftpMode?: string }) {
  const cfg =
    type === 'sftp'
      ? { bg: 'bg-violet-50', text: 'text-violet-700', ring: 'ring-violet-200/60', label: `SFTP${sftpMode ? ` · ${sftpMode}` : ''}` }
      : type === 'shares'
      ? { bg: 'bg-cyan-50',   text: 'text-cyan-700',   ring: 'ring-cyan-200/60',   label: 'Shares' }
      : { bg: 'bg-slate-100', text: 'text-slate-700',  ring: 'ring-slate-200/60',  label: 'Batch' };
  return (
    <span className={`inline-flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset whitespace-nowrap ${cfg.bg} ${cfg.text} ${cfg.ring}`}>
      {cfg.label}
    </span>
  );
}

function formatDateTime(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA'),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  };
}

// Type-based icon styling (matches ProjectBaskets page exactly):
//   batch  → orange Package, shares → cyan Folder, sftp → purple Server
function getTypeIcon(type: string) {
  if (type === 'sftp')   return { bg: 'bg-purple-100', text: 'text-purple-600', Icon: Server };
  if (type === 'shares') return { bg: 'bg-cyan-100',   text: 'text-cyan-600',   Icon: Folder };
  return                        { bg: 'bg-orange-100', text: 'text-orange-600', Icon: Package };
}

interface RowOpts {
  basket: Basket;
  navigate: (path: string) => void;
  scope: string;
  draggable: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: (e: React.DragEvent, b: Basket) => void;
  onDragOver: (e: React.DragEvent, b: Basket) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, b: Basket) => void;
}
function renderBasketRow(opts: RowOpts) {
  const { basket: b, navigate, scope, draggable, isDragging, isDropTarget,
          onDragStart, onDragOver, onDragLeave, onDrop } = opts;
  const colors = getColor(b.projectColor);
  const typeIcon = getTypeIcon(b.type);
  return (
    <li
      key={b.id}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, b)}
      onDragOver={(e) => onDragOver(e, b)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, b)}
      onClick={() => navigate(`/projects/${b.projectId}/baskets?basket=${b.id}`)}
      className={`group relative flex items-center gap-3 rounded-lg bg-white pl-2 pr-2 py-2 ring-1 transition-all cursor-pointer ${
        isDragging ? 'opacity-30 scale-[0.98]' : ''
      } ${
        isDropTarget ? 'ring-blue-400 ring-2' : 'ring-slate-200/70 hover:ring-slate-300 hover:shadow-sm'
      }`}
    >
      {draggable && (
        <GripVertical
          className="shrink-0 h-3.5 w-3.5 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab"
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className={`shrink-0 h-2 w-2 rounded-full ${colors.edge}`} title={b.projectName} />
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${typeIcon.bg} ring-1 ring-inset ring-black/5`}>
        <typeIcon.Icon className={`h-3.5 w-3.5 ${typeIcon.text}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-medium text-[13px] text-slate-900 truncate">{b.name}</span>
          {b.description && (
            <span className="text-[12px] text-slate-500 truncate">— {b.description}</span>
          )}
        </div>
      </div>
      <div className="hidden lg:flex shrink-0 items-center gap-1 w-[160px]">
        <span className="w-[88px] inline-flex">
          {scope === 'all' && b.projectName && (
            <span className={`inline-flex items-center rounded ${colors.chip} px-1.5 py-0.5 text-[12px] font-medium ${colors.chipText} ring-1 ring-inset ring-black/5 truncate w-full`}>
              {b.projectName}
            </span>
          )}
        </span>
        <span className="w-[68px] inline-flex">
          <TypeBadge type={b.type} sftpMode={b.sftpMode} />
        </span>
      </div>
      <div className="hidden md:flex shrink-0 items-center divide-x divide-slate-200/70 text-right">
        <div className="px-3">
          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Files</div>
          <div className="mt-0.5 text-[13px] font-mono tabular-nums text-slate-800 leading-none">{b.fileCount.toLocaleString()}</div>
        </div>
        <div className="px-3">
          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Active</div>
          <div className={`mt-0.5 text-[13px] font-mono tabular-nums leading-none ${(b.activeFileCount || 0) > 0 ? 'text-emerald-700 font-semibold' : 'text-slate-300'}`}>
            {b.activeFileCount || 0}
          </div>
        </div>
        <div className="px-3">
          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Sessions</div>
          <div className="mt-0.5 flex items-center justify-end leading-none">
            {(b.activeSessionCount || 0) > 0 ? (
              <span className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0 text-[12px] font-medium text-violet-700 ring-1 ring-inset ring-violet-200/60 tabular-nums">
                <Clock className="h-2.5 w-2.5" />
                {b.activeSessionCount}
              </span>
            ) : (
              <span className="text-[13px] text-slate-300">—</span>
            )}
          </div>
        </div>
        <div className="px-3 min-w-[120px]">
          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Updated</div>
          <div className="mt-0.5 text-[11.5px] text-slate-700 whitespace-nowrap tabular-nums leading-none">
            {formatDateTime(b.updatedAt).date} <span className="text-slate-400">{formatDateTime(b.updatedAt).time}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/projects/${b.projectId}/baskets`); }}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          title="Open in project"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/projects/${b.projectId}/baskets?basket=${b.id}`); }}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-700 hover:bg-blue-600 hover:text-white transition-colors"
          title="View basket"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function BasketManagement() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<SidebarFilter>({ scope: 'all', label: 'All Projects' });
  const [search, setSearch] = useState('');
  const [typeTab, setTypeTab] = useState<'all' | 'batch' | 'shares' | 'sftp'>('all');
  const refreshing = useRef(false);

  // Lightweight toast for tag-group errors (drag-drop is now owned by the
  // shared useProjectTagGroups hook, which calls onError → setCopyMessage).
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!copyMessage) return;
    const t = setTimeout(() => setCopyMessage(null), 4000);
    return () => clearTimeout(t);
  }, [copyMessage]);

  const fetchData = useCallback(async (silent = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (!silent) setLoading(true);
    try {
      const [bRes, pRes] = await Promise.all([
        fetch(`${API_URL}/baskets/overview`),
        fetch(`${API_URL}/projects`),
      ]);
      const bData = await bRes.json();
      const pData = await pRes.json();

      const fullProjects: any[] = pData.success ? (pData.data || []) : [];
      const projsById = new Map<string, any>(fullProjects.map(p => [p.id, p]));

      if (bData.success) {
        const bs: any[] = bData.data?.baskets || [];

        const mapped: Basket[] = bs.map((b: any) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          projectId: b.projectId,
          projectName: projsById.get(b.projectId)?.name,
          projectColor: projsById.get(b.projectId)?.color,
          type: b.type,
          sftpMode: b.sftpMode,
          fileCount: b.fileCount || 0,
          activeFileCount: b.activeFileCount || 0,
          activeSessionCount: b.activeSessionCount || 0,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          tags: b.tags ?? '[]',
          displayOrder: b.displayOrder ?? 0,
        }));
        setBaskets(mapped);

        const counts = new Map<string, { total: number; active: number }>();
        for (const b of mapped) {
          if (!counts.has(b.projectId)) counts.set(b.projectId, { total: 0, active: 0 });
          const c = counts.get(b.projectId)!;
          c.total++;
          if (b.activeSessionCount && b.activeSessionCount > 0) c.active++;
        }

        setProjects(fullProjects.map((p: any) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          status: p.status,
          projectGroup: p.projectGroup,
          agency: p.agency,
          groupPosition: p.groupPosition,
          agencyPosition: p.agencyPosition,
          position: p.position,
          count: counts.get(p.id)?.total || 0,
          activeCount: counts.get(p.id)?.active || 0,
        })));
      }
    } finally {
      refreshing.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(i);
  }, [fetchData]);

  const projsById = useMemo(() => buildProjectsById(projects), [projects]);

  const scopeFiltered = useMemo(() =>
    filterByScope(baskets, filter.scope, projsById, b => (b.activeSessionCount || 0) > 0),
    [baskets, filter.scope, projsById]);

  const typeFiltered = useMemo(() => {
    if (typeTab === 'all') return scopeFiltered;
    return scopeFiltered.filter(b => b.type === typeTab);
  }, [scopeFiltered, typeTab]);

  const finalList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return typeFiltered;
    return typeFiltered.filter(b =>
      b.name.toLowerCase().includes(q) ||
      (b.projectName || '').toLowerCase().includes(q) ||
      (b.description || '').toLowerCase().includes(q)
    );
  }, [typeFiltered, search]);

  // Project → Tag → Basket grouping via the shared hook (same UX as Tasks).
  const tagGroups = useProjectTagGroups<Basket>({
    items: finalList,
    projects,
    projectsById: projsById as any,
    getProjectId: b => b.projectId,
    getProjectName: b => b.projectName,
    getProjectColor: b => b.projectColor,
    getTags: b => parseTagsField(b.tags),
    getDisplayOrder: b => b.displayOrder ?? 0,
    getName: b => b.name,
    persistItem: (basketId, patch) =>
      apiFetch(`${API_URL}/baskets/${basketId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayOrder: patch.displayOrder,
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        }),
      }),
    applyLocalPatch: (patches) => {
      const byId = new Map(patches.map(p => [p.id, p]));
      setBaskets(prev => prev.map(b => {
        const p = byId.get(b.id);
        if (!p) return b;
        return { ...b, displayOrder: p.displayOrder, ...(p.tags !== undefined ? { tags: p.tags } : {}) };
      }));
    },
    reload: () => fetchData(true),
    onError: (msg) => setCopyMessage(msg),
  });

  const stats = useMemo(() => ({
    all: scopeFiltered.length,
    batch: scopeFiltered.filter(b => b.type === 'batch').length,
    shares: scopeFiltered.filter(b => b.type === 'shares').length,
    sftp: scopeFiltered.filter(b => b.type === 'sftp').length,
  }), [scopeFiltered]);

  if (loading) return (
    <div className="flex h-full items-center justify-center text-slate-500">
      <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
    </div>
  );

  return (
    <div className="flex flex-col xl:flex-row h-full bg-slate-50">
      {copyMessage && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2.5 rounded-lg shadow-lg ring-1 px-4 py-2.5 bg-rose-50 ring-rose-200 text-rose-800">
            <span className="text-[12.5px] font-medium">{copyMessage}</span>
            <button onClick={() => setCopyMessage(null)} className="ml-2 text-slate-400 hover:text-slate-700">×</button>
          </div>
        </div>
      )}
      <ProjectTreeSidebar
        projects={projects.filter(p => p.count && p.count > 0)}
        selected={filter.scope}
        onSelect={setFilter}
        itemLabel="baskets"
        totalCount={baskets.length}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-slate-200 bg-white">
          <div className="px-6 pt-4 pb-3">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h1 className="text-[17px] font-semibold tracking-tight text-slate-900">Baskets</h1>
                  <span className="text-[12px] tabular-nums text-slate-400">
                    {filter.label} · {finalList.length} of {scopeFiltered.length}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search by name, project, description…"
                    className="w-full rounded-md border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100 transition-colors"
                  />
                </div>
                <button
                  onClick={() => fetchData()}
                  className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                  title="Refresh"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Segmented type control */}
            <div className="mt-3 inline-flex items-center rounded-lg bg-slate-100 p-0.5">
              {[
                { id: 'all',    label: 'All',    count: stats.all },
                { id: 'batch',  label: 'Batch',  count: stats.batch,  dot: 'bg-slate-400'  },
                { id: 'shares', label: 'Shares', count: stats.shares, dot: 'bg-cyan-500'   },
                { id: 'sftp',   label: 'SFTP',   count: stats.sftp,   dot: 'bg-violet-500' },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setTypeTab(t.id as any)}
                  className={`relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-all ${
                    typeTab === t.id
                      ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/60'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
                  {t.label}
                  <span className={`tabular-nums text-[12px] ${typeTab === t.id ? 'text-slate-500' : 'text-slate-400'}`}>{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Cards */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {finalList.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center px-6">
              <div className="rounded-full bg-slate-100 p-3.5 mb-3 ring-1 ring-slate-200/60">
                <Inbox className="h-5 w-5 text-slate-400" />
              </div>
              <p className="text-sm font-medium text-slate-700">
                {search ? 'No matches' : 'No baskets in this scope'}
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                {search ? `Nothing matches "${search}".` : 'Pick a different project or basket type.'}
              </p>
            </div>
          ) : (
            <TagGroupView<Basket>
              grouped={tagGroups.grouped}
              addingTagFor={tagGroups.addingTagFor}
              setAddingTagFor={tagGroups.setAddingTagFor}
              newTagName={tagGroups.newTagName}
              setNewTagName={tagGroups.setNewTagName}
              handleAddTag={tagGroups.handleAddTag}
              handleRemoveTagGroup={tagGroups.handleRemoveTagGroup}
              draggedId={tagGroups.draggedId}
              setDraggedId={tagGroups.setDraggedId}
              dropTarget={tagGroups.dropTarget}
              setDropTarget={tagGroups.setDropTarget}
              handleDrop={tagGroups.handleDrop}
              colorEdge={(c) => getColor(c).edge}
              itemNoun="basket"
              renderItem={(b, _cid, drag) => renderBasketRow({
                basket: b, navigate, scope: filter.scope,
                draggable: drag.draggable,
                isDragging: drag.isDragging,
                isDropTarget: drag.showDropIndicatorAbove,
                onDragStart: (e) => drag.onDragStart(e),
                onDragOver: (e) => drag.onDragOver(e),
                onDragLeave: () => {},
                onDrop: (e) => drag.onDrop(e),
              })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
