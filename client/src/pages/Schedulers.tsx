// Schedulers — Operator dashboard (refined console)
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play, Pause, RotateCcw, Search, Plus, Pencil, Trash2, BarChart3, Square,
  Loader2, CheckCircle2, XCircle, Zap, Calendar, GripVertical,
} from 'lucide-react';
import { CronExpressionParser } from 'cron-parser';
import { API_URL } from '../config/api';
import SchedulerFormModal, { SchedulerFormValues } from '../components/SchedulerFormModal';
import ProjectTreeSidebar, { SidebarFilter, SidebarProject } from '../components/operator/ProjectTreeSidebar';
import { filterByScope, buildProjectsById } from '../components/operator/operatorUtils';
import { useProjectTagGroups, parseTagsField } from '../components/operator/useProjectTagGroups';
import { TagGroupView } from '../components/operator/TagGroupView';
import { apiFetch } from '../config/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Project extends SidebarProject {}

interface SchedulerExecution {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  startedAt: string;
  endedAt?: string;
  duration?: number;
  error?: string;
}

interface Scheduler {
  id: string;
  flowId: string;
  flowName: string;
  projectId: string;
  projectName?: string;
  projectColor?: string;
  schedule: string;
  timezone?: string;
  status: 'Active' | 'Inactive' | string;
  enabled: boolean;
  parameters?: Array<{ name: string; value: string }>;
  maxConcurrent?: number;
  lastRun?: string;
  nextRun?: string;
  executions: SchedulerExecution[];
  isRunning?: boolean;
  // Tag grouping — tags + displayOrder come from the underlying flow.
  flowTags?: string;          // JSON string from flow.tags
  flowDisplayOrder?: number;
}

// Refined project color palette — explicit static classes so Tailwind keeps them.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextRunTime(cron: string, tz = 'Asia/Bangkok'): string | null {
  try {
    return CronExpressionParser.parse(cron, { tz }).next().toDate().toISOString();
  } catch { return null; }
}

function formatDuration(ms?: number): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${(ms/60000).toFixed(1)}m`;
}

function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 0) {
    const f = Math.abs(d);
    if (f < 60000) return `in ${Math.round(f/1000)}s`;
    if (f < 3600000) return `in ${Math.round(f/60000)}m`;
    if (f < 86400000) return `in ${Math.round(f/3600000)}h`;
    return new Date(iso).toLocaleDateString('en-CA');
  }
  if (d < 60000) return `${Math.round(d/1000)}s ago`;
  if (d < 3600000) return `${Math.round(d/60000)}m ago`;
  if (d < 86400000) return `${Math.round(d/3600000)}h ago`;
  return new Date(iso).toLocaleDateString('en-CA');
}

function formatAbsolute(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDateTime(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA'),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  };
}

// History as height-varying bars (vs. dots) — communicates duration at a glance.
function HistoryBars({ executions }: { executions: SchedulerExecution[] }) {
  const recent = executions.slice(0, 10).reverse();
  if (recent.length === 0) return <span className="text-[12px] tabular-nums text-slate-300">— no runs</span>;
  const maxDur = Math.max(...recent.map(e => e.duration || 100), 1);
  return (
    <div className="flex items-end gap-[3px] h-5">
      {recent.map((e, i) => {
        const c = e.status === 'completed' ? 'bg-emerald-400' :
                  e.status === 'failed'    ? 'bg-rose-400' :
                  e.status === 'running'   ? 'bg-violet-400' : 'bg-slate-300';
        const minH = 25;
        const h = Math.max(minH, Math.round(((e.duration || 0) / maxDur) * 100));
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm ${c} hover:scale-y-110 transition-transform origin-bottom`}
            style={{ height: `${h}%` }}
            title={`${e.status} · ${formatRelative(e.startedAt)} · ${formatDuration(e.duration)}`}
          />
        );
      })}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function Schedulers() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [schedulers, setSchedulers] = useState<Scheduler[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<SidebarFilter>({ scope: 'all', label: 'All Projects' });
  const [search, setSearch] = useState('');
  const [statusTab, setStatusTab] = useState<'all' | 'active' | 'paused' | 'running'>('all');

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [formInit, setFormInit] = useState<Partial<SchedulerFormValues>>();
  const [paramRunFor, setParamRunFor] = useState<Scheduler | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [killTarget, setKillTarget] = useState<Scheduler | null>(null);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const refreshing = useRef(false);

  const fetchData = useCallback(async (silent = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (!silent) setLoading(true);
    try {
      const [r, pRes] = await Promise.all([
        fetch(`${API_URL}/schedulers/overview`),
        fetch(`${API_URL}/projects`),
      ]);
      const d = await r.json();
      const pData = await pRes.json();
      if (d.success) {
        const fullProjects: any[] = pData.success ? (pData.data || []) : (d.data.projects || []);
        const schs: any[] = d.data.schedulers || [];
        const projsById = new Map(fullProjects.map((p: any) => [p.id, p]));

        const countMap = new Map<string, { total: number; active: number }>();
        for (const s of schs) {
          if (!countMap.has(s.projectId)) countMap.set(s.projectId, { total: 0, active: 0 });
          const c = countMap.get(s.projectId)!;
          c.total++;
          if (s.enabled) c.active++;
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
          count: countMap.get(p.id)?.total || 0,
          activeCount: countMap.get(p.id)?.active || 0,
        })));

        setSchedulers(schs.map((s): Scheduler => ({
          id: s.id,
          flowId: s.flowId,
          flowName: s.flowName,
          projectId: s.projectId,
          projectName: projsById.get(s.projectId)?.name,
          projectColor: projsById.get(s.projectId)?.color,
          schedule: s.schedule || '0 0 * * *',
          timezone: s.timezone,
          status: s.status,
          enabled: !!s.enabled,
          parameters: s.parameters || [],
          maxConcurrent: s.maxConcurrent,
          lastRun: s.lastRun,
          nextRun: s.nextRun || nextRunTime(s.schedule, s.timezone) || undefined,
          isRunning: (s.executions || []).some((e: any) => e.status === 'Running' && !e.endedAt),
          flowTags: s.flowTags ?? '[]',
          flowDisplayOrder: s.flowDisplayOrder ?? 0,
          executions: (s.executions || []).map((e: any) => ({
            id: e.id,
            status: e.status === 'Running' ? 'running' :
                    e.status === 'Completed' || e.status === 'Success' ? 'completed' :
                    e.status === 'Failed' ? 'failed' : 'pending',
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            duration: e.durationMs,
            error: e.error,
          })),
        })));
      }
    } finally {
      refreshing.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    fetchData();
    const i = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(i);
  }, [fetchData]);

  const projsById = useMemo(() => buildProjectsById(projects), [projects]);
  const scopeFiltered = useMemo(() =>
    filterByScope(schedulers, filter.scope, projsById, s => s.enabled),
    [schedulers, filter.scope, projsById]);

  const statusFiltered = useMemo(() => {
    switch (statusTab) {
      case 'active': return scopeFiltered.filter(s => s.enabled);
      case 'paused': return scopeFiltered.filter(s => !s.enabled);
      case 'running': return scopeFiltered.filter(s => s.isRunning);
      default: return scopeFiltered;
    }
  }, [scopeFiltered, statusTab]);

  const finalList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return statusFiltered;
    return statusFiltered.filter(s =>
      s.flowName.toLowerCase().includes(q) ||
      (s.projectName || '').toLowerCase().includes(q) ||
      s.schedule.toLowerCase().includes(q)
    );
  }, [statusFiltered, search]);

  const stats = useMemo(() => ({
    all: scopeFiltered.length,
    active: scopeFiltered.filter(s => s.enabled).length,
    paused: scopeFiltered.filter(s => !s.enabled).length,
    running: scopeFiltered.filter(s => s.isRunning).length,
  }), [scopeFiltered]);

  // Project → Tag → Scheduler grouping via the shared hook.
  // Tags live on the underlying flow, so retagging a scheduler PUTs the flow.
  const tagGroups = useProjectTagGroups<Scheduler>({
    items: finalList,
    projects,
    projectsById: projsById as any,
    getProjectId: s => s.projectId,
    getProjectName: s => s.projectName,
    getProjectColor: s => s.projectColor,
    getTags: s => parseTagsField(s.flowTags),
    getDisplayOrder: s => s.flowDisplayOrder ?? 0,
    getName: s => s.flowName,
    persistItem: (schedulerId, patch) => {
      // patch.tags + displayOrder apply to the scheduler's FLOW
      const sch = finalList.find(x => x.id === schedulerId);
      const flowId = sch?.flowId;
      if (!flowId) return Promise.resolve(new Response(null, { status: 204 }));
      return apiFetch(`${API_URL}/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayOrder: patch.displayOrder,
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        }),
      });
    },
    applyLocalPatch: (patches) => {
      const byId = new Map(patches.map(p => [p.id, p]));
      setSchedulers(prev => prev.map(s => {
        const p = byId.get(s.id);
        if (!p) return s;
        return { ...s, flowDisplayOrder: p.displayOrder, ...(p.tags !== undefined ? { flowTags: p.tags } : {}) };
      }));
    },
    reload: () => fetchData(true),
    onError: (msg) => setToast({ type: 'error', message: msg }),
  });

  // ─── Actions (preserved) ───────────────────────────────────────────────────

  const handleToggle = async (s: Scheduler) => {
    setSchedulers(prev => prev.map(x => x.id === s.id ? { ...x, enabled: !x.enabled } : x));
    try {
      const r = await fetch(`${API_URL}/schedulers/${s.id}/toggle`, { method: 'POST' });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'failed');
      fetchData(true);
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
      setSchedulers(prev => prev.map(x => x.id === s.id ? { ...x, enabled: s.enabled } : x));
    }
  };

  const handleDelete = async (s: Scheduler) => {
    if (!confirm(`Delete scheduler "${s.flowName}"?\n\nThis stops the cron job but will NOT delete the flow.`)) return;
    try {
      const r = await fetch(`${API_URL}/schedulers/${s.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setSchedulers(prev => prev.filter(x => x.id !== s.id));
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
    }
  };

  const handleEdit = async (s: Scheduler) => {
    try {
      const r = await fetch(`${API_URL}/schedulers/${s.id}`);
      const d = await r.json();
      if (d.success) {
        setFormMode('edit');
        setFormInit({
          id: d.data.id,
          flowId: d.data.flowId,
          name: d.data.name,
          schedule: d.data.schedule,
          timezone: d.data.timezone,
          parameters: d.data.parameters || [],
          maxConcurrent: d.data.maxConcurrent || 1,
          enabled: d.data.enabled,
        });
        setFormOpen(true);
      }
    } catch (e: any) {
      alert(`Failed to load: ${e.message}`);
    }
  };

  const openCreate = () => {
    setFormMode('create');
    setFormInit(undefined);
    setFormOpen(true);
  };

  const handleRunClick = (s: Scheduler) => {
    if (s.parameters && s.parameters.length > 0) {
      const init: Record<string, string> = {};
      for (const p of s.parameters) init[p.name] = String(p.value ?? '');
      setParamValues(init);
      setParamRunFor(s);
    } else {
      runWithParams(s, {});
    }
  };

  const runWithParams = async (s: Scheduler, params: Record<string, any>) => {
    try {
      const r = await fetch(`${API_URL}/schedulers/${s.id}/run-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: params }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      fetchData(true);
    } catch (e: any) {
      setToast({ type: 'error', message: `Failed: ${e.message}` });
    }
  };

  const handleKillConfirm = async () => {
    if (!killTarget) return;
    const runningExec = killTarget.executions.find(e => e.status === 'running');
    if (!runningExec) {
      setKillError('No running execution found');
      return;
    }
    setKilling(true);
    setKillError(null);
    try {
      const r = await fetch(`${API_URL}/executions/${runningExec.id}/terminate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Terminated by user from Schedulers' }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to terminate');
      setToast({ type: 'success', message: `Terminated "${killTarget.flowName}"` });
      setKillTarget(null);
      fetchData(true);
    } catch (e: any) {
      setKillError(e.message);
    } finally {
      setKilling(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex h-full items-center justify-center text-slate-500">
      <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
    </div>
  );

  return (
    <div className="flex flex-col xl:flex-row h-full bg-slate-50">
      <ProjectTreeSidebar
        projects={projects.filter(p => p.count && p.count > 0)}
        selected={filter.scope}
        onSelect={setFilter}
        itemLabel="schedulers"
        totalCount={schedulers.length}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-slate-200 bg-white">
          <div className="px-6 pt-4 pb-3">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h1 className="text-[17px] font-semibold tracking-tight text-slate-900">Schedulers</h1>
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
                    placeholder="Search by name, project, schedule…"
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
                <button
                  onClick={openCreate}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 h-9 text-[14px] font-medium text-white hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" /> New scheduler
                </button>
              </div>
            </div>

            {/* Segmented status control */}
            <div className="mt-3 inline-flex items-center rounded-lg bg-slate-100 p-0.5">
              {[
                { id: 'all',     label: 'All',     count: stats.all },
                { id: 'active',  label: 'Active',  count: stats.active,  dot: 'bg-emerald-500' },
                { id: 'paused',  label: 'Paused',  count: stats.paused,  dot: 'bg-slate-400' },
                { id: 'running', label: 'Running', count: stats.running, dot: 'bg-violet-500' },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setStatusTab(t.id as any)}
                  className={`relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-all ${
                    statusTab === t.id
                      ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/60'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
                  {t.label}
                  <span className={`tabular-nums text-[12px] ${statusTab === t.id ? 'text-slate-500' : 'text-slate-400'}`}>{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {finalList.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center px-6">
              <div className="rounded-full bg-slate-100 p-3.5 mb-3 ring-1 ring-slate-200/60">
                <Calendar className="h-5 w-5 text-slate-400" />
              </div>
              <p className="text-sm font-medium text-slate-700">
                {search ? 'No matches' : 'No schedulers in this scope'}
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                {search ? `Nothing matches "${search}".` : 'Schedulers run flows automatically on a cron schedule.'}
              </p>
              {!search && (
                <button
                  onClick={openCreate}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 h-9 text-[14px] font-medium text-white hover:bg-blue-700 whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" /> New scheduler
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 sm:px-6 py-4">
              {(() => {
                const renderRow = (s: Scheduler, drag?: import('../components/operator/TagGroupView').ItemDragHandlers) => {
                  const colors = getColor(s.projectColor);
                  const lastExec = s.executions[0];
                  const status = s.isRunning
                    ? { bg: 'bg-violet-50 ring-violet-200/60', icon: <Loader2 className="h-4 w-4 text-violet-600 animate-spin" />, label: 'Running' }
                    : s.enabled
                    ? { bg: 'bg-emerald-50 ring-emerald-200/60', icon: <span className="h-2 w-2 rounded-full bg-emerald-500" />, label: 'Active' }
                    : { bg: 'bg-slate-100 ring-slate-200/60', icon: <Pause className="h-3.5 w-3.5 text-slate-500" />, label: 'Paused' };
                  return (
                    <li
                      key={s.id}
                      draggable={drag?.draggable}
                      onDragStart={drag?.onDragStart}
                      onDragEnd={drag?.onDragEnd}
                      onDragOver={drag?.onDragOver}
                      onDrop={drag?.onDrop}
                      className={`group relative flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 rounded-lg bg-white pl-3 pr-2 py-2 sm:py-1.5 ring-1 ring-slate-200/70 hover:ring-slate-300 hover:shadow-sm transition-all ${drag?.isDragging ? 'opacity-40' : ''} ${drag?.showDropIndicatorAbove ? 'ring-2 ring-blue-400' : ''}`}
                    >
                      {drag && (
                        <span className="hidden sm:inline shrink-0 cursor-grab text-slate-300 hover:text-slate-500 -ml-1" title="Drag to reorder / retag">
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <span className={`hidden sm:inline-block shrink-0 h-2 w-2 rounded-full ${colors.edge}`} title={s.projectName} />

                      {/* Status icon — replaces calendar; shows live state */}
                      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${status.bg}`} title={status.label}>
                        {status.icon}
                      </div>

                      {/* Two-line label: flow name + cron */}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[13px] text-slate-900 leading-tight line-clamp-2 break-words sm:truncate" title={s.flowName}>{s.flowName}</div>
                        <div className="mt-0.5 text-[12px] leading-none whitespace-nowrap">
                          <code className="font-mono tabular-nums text-slate-500">{s.schedule}</code>
                          {s.nextRun && (
                            <span className="md:hidden text-slate-400"> · next {formatDateTime(s.nextRun).date} {formatDateTime(s.nextRun).time}</span>
                          )}
                        </div>
                      </div>

                      {/* Stats: Last run, Next run, History — fixed widths align across rows */}
                      <div className="hidden md:flex shrink-0 items-stretch divide-x divide-slate-200/70 text-right">
                        <div className="hidden xl:block px-3 w-[150px]">
                          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Last run</div>
                          <div className="mt-1 flex items-center justify-end gap-1 leading-none">
                            {lastExec?.status === 'completed' && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                            {lastExec?.status === 'failed' && <XCircle className="h-3 w-3 text-rose-500 shrink-0" />}
                            {s.lastRun ? (
                              <span className="text-[11.5px] text-slate-700 whitespace-nowrap tabular-nums">
                                {formatDateTime(s.lastRun).date} <span className="text-slate-400">{formatDateTime(s.lastRun).time}</span>
                              </span>
                            ) : (
                              <span className="text-[11.5px] text-slate-400">never</span>
                            )}
                          </div>
                          {lastExec?.status === 'failed' && lastExec?.error && (
                            <div
                              className="mt-1 text-[12px] text-rose-600 truncate cursor-help"
                              title={lastExec.error}
                            >
                              {lastExec.error}
                            </div>
                          )}
                        </div>
                        <div className="px-3 w-[140px]">
                          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Next run</div>
                          <div className="mt-1 text-[11.5px] text-slate-700 whitespace-nowrap tabular-nums leading-none" title={formatAbsolute(s.nextRun)}>
                            {s.nextRun ? (
                              <>{formatDateTime(s.nextRun).date} <span className="text-slate-400">{formatDateTime(s.nextRun).time}</span></>
                            ) : <span className="text-slate-400">—</span>}
                          </div>
                        </div>
                        <div className="hidden 2xl:block px-3 w-[110px]">
                          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">History</div>
                          <div className="mt-1 flex justify-end leading-none">
                            <HistoryBars executions={s.executions} />
                          </div>
                        </div>
                      </div>

                      {/* Actions — Run morphs into Kill when running, so no extra slot needed */}
                      <div className="flex w-full sm:w-auto justify-end shrink-0 items-center gap-0 pl-1 border-t border-slate-100 pt-1 sm:border-0 sm:pt-0">
                        {s.isRunning ? (
                          <button onClick={() => { setKillTarget(s); setKillError(null); }} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-rose-600 hover:bg-rose-50 transition-colors" title="Kill running execution">
                            <Square className="h-3 w-3 fill-current" />
                          </button>
                        ) : (
                          <button onClick={() => handleRunClick(s)} disabled={!s.enabled} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-blue-600 hover:text-white disabled:text-slate-300 disabled:cursor-not-allowed transition-colors" title="Run now">
                            <Zap className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button onClick={() => handleToggle(s)} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors" title={s.enabled ? 'Pause' : 'Resume'}>
                          {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => navigate(`/schedulers/${s.flowId}/logs`)} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors" title="View logs">
                          <BarChart3 className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleEdit(s)} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors" title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleDelete(s)} className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600 transition-colors" title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                };

                return (
                  <TagGroupView<Scheduler>
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
                    itemNoun="scheduler"
                    renderItem={(s, _cid, drag) => renderRow(s, drag)}
                  />
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Kill confirm dialog */}
      {killTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => !killing && setKillTarget(null)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl ring-1 ring-slate-900/5 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 ring-1 ring-rose-200/60">
                <Square className="h-4 w-4 text-rose-600 fill-current" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-slate-900">Terminate execution?</h3>
                <p className="text-[12px] text-slate-500 mt-0.5">
                  This will stop the running execution of <span className="font-medium text-slate-700">{killTarget.flowName}</span>. Partial work may be lost.
                </p>
              </div>
            </div>
            {killError && (
              <div className="px-5 py-2.5 bg-rose-50 border-b border-rose-100 text-[12px] text-rose-700">
                {killError}
              </div>
            )}
            <div className="flex justify-end gap-2 px-5 py-3 bg-slate-50">
              <button
                onClick={() => setKillTarget(null)}
                disabled={killing}
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 h-9 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                onClick={handleKillConfirm}
                disabled={killing}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-[12px] font-medium disabled:opacity-50 whitespace-nowrap bg-red-600 text-white hover:bg-red-700"
              >
                {killing && <Loader2 className="h-3 w-3 animate-spin" />}
                {killing ? 'Terminating…' : 'Terminate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-2">
          <div className={`flex items-center gap-2.5 rounded-lg shadow-lg ring-1 px-4 py-2.5 ${
            toast.type === 'success'
              ? 'bg-emerald-50 ring-emerald-200 text-emerald-800'
              : 'bg-rose-50 ring-rose-200 text-rose-800'
          }`}>
            {toast.type === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <XCircle className="h-4 w-4 text-rose-600 shrink-0" />}
            <span className="text-[12.5px] font-medium">{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 text-slate-400 hover:text-slate-700">×</button>
          </div>
        </div>
      )}

      {/* Create/Edit modal */}
      <SchedulerFormModal
        open={formOpen}
        mode={formMode}
        initialValues={formInit}
        onClose={() => setFormOpen(false)}
        onSaved={() => fetchData()}
      />

      {/* Run-with-parameters dialog */}
      {paramRunFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => setParamRunFor(null)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl ring-1 ring-slate-900/5" onClick={e => e.stopPropagation()}>
            <div className="border-b border-slate-100 px-5 py-3.5">
              <h3 className="font-semibold text-slate-900">Run “{paramRunFor.flowName}”</h3>
              <p className="text-xs text-slate-500 mt-0.5">Adjust parameters then run on demand.</p>
            </div>
            <div className="p-5 space-y-3">
              {paramRunFor.parameters?.map(p => (
                <div key={p.name}>
                  <label className="block text-[12px] font-medium uppercase tracking-wide text-slate-500 mb-1">{p.name}</label>
                  <input
                    type="text"
                    value={paramValues[p.name] ?? ''}
                    onChange={e => setParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                    className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm font-mono focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3 rounded-b-xl">
              <button onClick={() => setParamRunFor(null)} className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 h-8 text-[13px] font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap">Cancel</button>
              <button
                onClick={() => { runWithParams(paramRunFor, paramValues); setParamRunFor(null); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 h-8 text-[13px] font-medium text-white hover:bg-blue-700 whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" /> Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
