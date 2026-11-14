// Run Flow (Tasks) — Operator dashboard (refined console)
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, RotateCcw, Play, Plus, Trash2, Info, Loader2,
  CheckCircle2, XCircle, Workflow, Pause, BarChart3, Square, ChevronDown,
  GripVertical, Tag as TagIcon, X,
} from 'lucide-react';
import { API_URL, apiFetch } from '../config/api';
import { resolveDateTimePlaceholders } from '../utils/datetimePlaceholders';
import ProjectTreeSidebar, { SidebarFilter, SidebarProject } from '../components/operator/ProjectTreeSidebar';
import { filterByScope, buildProjectsById } from '../components/operator/operatorUtils';

interface Project extends SidebarProject {}

interface Flow {
  id: string;
  name: string;
  description?: string | null;
  projectId: string;
  status?: string;
  type?: string;
  config?: string | null;  // JSON string with { variables: [...] }
  tags?: string | string[] | null;  // JSON string or array of tag names
  displayOrder?: number;
  project?: { id: string; name: string; color?: string; status?: string; projectGroup?: string | null; agency?: string | null; groupPosition?: number; agencyPosition?: number; position?: number };
}

// Parse flow.tags (server stores as JSON string)
function parseTags(tags: Flow['tags']): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(t => typeof t === 'string' && t.trim());
  try {
    const arr = JSON.parse(tags);
    return Array.isArray(arr) ? arr.filter((t: any) => typeof t === 'string' && t.trim()) : [];
  } catch { return []; }
}

// Parse declared variables from flow.config (JSON string)
function parseFlowVariables(config?: string | null): { name: string; type?: string; label?: string }[] {
  if (!config) return [];
  try {
    const cfg = typeof config === 'string' ? JSON.parse(config) : config;
    return Array.isArray(cfg?.variables) ? cfg.variables : [];
  } catch { return []; }
}

interface Execution {
  id: string;
  flowId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  callerName?: string;
  error?: string | null;
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

const TEMPLATE_HINTS = ['{{year}}', '{{year+543}}', '{{year-1}}', '{{month}}', '{{day}}', '{{date}}', '{{date+1}}', '{{datetime}}'];

function formatDuration(ms?: number): string {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${(ms/60000).toFixed(1)}m`;
}
function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return `${Math.round(d/1000)}s ago`;
  if (d < 3600000) return `${Math.round(d/60000)}m ago`;
  if (d < 86400000) return `${Math.round(d/3600000)}h ago`;
  return new Date(iso).toLocaleDateString('en-CA');
}
function formatAbsolute(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDateTime(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA'),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  };
}

function HistoryBars({ executions }: { executions: Execution[] }) {
  const recent = executions.slice(0, 10).reverse();
  if (recent.length === 0) return <span className="text-[12px] tabular-nums text-slate-300">— no runs</span>;
  const maxDur = Math.max(...recent.map(e => e.durationMs || 100), 1);
  return (
    <div className="flex items-end gap-[3px] h-5">
      {recent.map((e, i) => {
        const s = (e.status || '').toLowerCase();
        const c = (s === 'completed' || s === 'success') ? 'bg-emerald-400' :
                  s === 'failed' ? 'bg-rose-400' :
                  s === 'running' ? 'bg-violet-400' : 'bg-slate-300';
        const h = Math.max(25, Math.round(((e.durationMs || 0) / maxDur) * 100));
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm ${c} hover:scale-y-110 transition-transform origin-bottom`}
            style={{ height: `${h}%` }}
            title={`${e.status} · ${formatRelative(e.startedAt)} · ${formatDuration(e.durationMs)}`}
          />
        );
      })}
    </div>
  );
}

// ─── Run modal (refined) ─────────────────────────────────────────────────────

// Variable definition stored on flow.config.variables
interface FlowVariable {
  name: string;
  type?: 'text' | 'number' | 'date' | 'dropdown';
  label?: string;
  description?: string;
  required?: boolean;
  default?: string;
  options?: { value: string; label?: string }[];
}

function RunFlowModal({ flow, isOpen, onClose, onSubmitted }: {
  flow: Flow | null; isOpen: boolean; onClose: () => void; onSubmitted: () => void;
}) {
  const [params, setParams] = useState<{ name: string; value: string }[]>([]);
  const [declared, setDeclared] = useState<FlowVariable[]>([]);
  const [declaredValues, setDeclaredValues] = useState<Record<string, string>>({});
  const [loadingFlow, setLoadingFlow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load flow detail when modal opens.
  // Source of truth = flow.config.variables (what the user declared in the
  // designer's Deploy tab). We no longer scan node strings for {{tokens}}
  // — if the user didn't declare it on the Deploy tab, the runner won't ask.
  // Engine-side placeholders (YYYYMMDD, BYY, …) are auto-resolved by
  // executors and never need to surface here.
  useEffect(() => {
    if (!isOpen || !flow?.id) return;
    setParams([]); setDeclared([]); setDeclaredValues({}); setError(null);
    setLoadingFlow(true);
    (async () => {
      try {
        const r = await fetch(`${API_URL}/flows/${flow.id}`);
        const d = await r.json();
        if (!d.success) return;
        const f = d.data;
        let cfg: any = {};
        try { cfg = typeof f.config === 'string' ? JSON.parse(f.config || '{}') : (f.config || {}); } catch {}
        const declaredList: FlowVariable[] = Array.isArray(cfg.variables) ? cfg.variables : [];
        setDeclared(declaredList);
        const init: Record<string, string> = {};
        // Resolve {{BYY}}, {{YYYY}}, {{now}}, etc. so the user sees the actual
        // computed value (e.g. "68") in the input instead of the raw template.
        // Server applies the same resolver at execute-time, so leaving the
        // resolved value here keeps behavior identical (user can still override).
        for (const v of declaredList) init[v.name] = resolveDateTimePlaceholders(v.default || '');
        setDeclaredValues(init);
      } catch {}
      finally { setLoadingFlow(false); }
    })();
  }, [isOpen, flow?.id]);

  if (!isOpen || !flow) return null;
  const colors = getColor(flow.project?.color);

  const handleRun = async () => {
    setSubmitting(true); setError(null);
    try {
      // Validate required
      for (const v of declared) {
        if (v.required && !declaredValues[v.name]?.trim()) {
          setError(`กรุณากรอก: ${v.label || v.name}`);
          setSubmitting(false); return;
        }
      }
      const obj: Record<string, string> = { ...declaredValues };
      // Strip empty optional declared values
      for (const v of declared) if (!v.required && !obj[v.name]?.trim()) delete obj[v.name];
      // Add any extra free-form params
      for (const p of params) if (p.name.trim()) obj[p.name.trim()] = p.value;
      const userStr = localStorage.getItem('user');
      const u = userStr ? JSON.parse(userStr) : null;
      // HTTP headers must be ASCII (ISO-8859-1). User display names may contain
      // Thai or other non-ASCII characters, so percent-encode before sending.
      // Server-side flows.ts decodes with decodeURIComponent (with fallback).
      const rawName = u ? (u.name || u.email || '') : '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (rawName) headers['X-User-Name'] = encodeURIComponent(rawName);
      const r = await fetch(`${API_URL}/flows/${flow.id}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parameters: obj }),
      });
      const d = await r.json();
      if (!d.success) { setError(d.error || 'Failed'); return; }
      onSubmitted(); onClose();
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl ring-1 ring-slate-900/5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <span className={`h-2.5 w-2.5 rounded-full ${colors.dot} shrink-0`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[12px] uppercase tracking-wide">
              {flow.project?.name && <span className={`${colors.chipText} font-medium`}>{flow.project.name}</span>}
              {flow.type && <><span className="text-slate-300">·</span><span className="text-slate-500">{flow.type}</span></>}
            </div>
            <h2 className="text-base font-semibold text-slate-900 truncate">{flow.name}</h2>
            {flow.description && <p className="text-xs text-slate-500 truncate mt-0.5">{flow.description}</p>}
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {/* Declared / auto-detected variables (typed fields) */}
          {loadingFlow ? (
            <div className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading flow variables…
            </div>
          ) : declared.length > 0 ? (
            <div>
              <label className="mb-2 block text-[12px] font-semibold uppercase tracking-wide text-slate-500">Flow Variables</label>
              <div className="space-y-2.5">
                {declared.map((v) => (
                  <div key={v.name}>
                    <div className="mb-1 flex items-baseline gap-1.5">
                      <span className="text-xs font-medium text-slate-700">{v.label || v.name}</span>
                      <code className="rounded bg-slate-100 px-1 font-mono text-[12px] text-slate-500">{`{{${v.name}}}`}</code>
                      {v.required && <span className="text-[12px] text-rose-600">*</span>}
                    </div>
                    {v.type === 'dropdown' && v.options?.length ? (
                      <select
                        value={declaredValues[v.name] || ''}
                        onChange={e => setDeclaredValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                        className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
                      >
                        <option value="">{v.required ? '— Select —' : '— None —'}</option>
                        {v.options.map(o => (
                          <option key={o.value} value={o.value}>{o.label || o.value}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'}
                        value={declaredValues[v.name] || ''}
                        onChange={e => setDeclaredValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                        placeholder={v.default || v.description || ''}
                        className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
                      />
                    )}
                    {v.description && <p className="mt-0.5 text-[10.5px] text-slate-400">{v.description}</p>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Extra free-form parameters */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
                {declared.length > 0 ? 'Extra Parameters' : 'Parameters'}
              </label>
              <button onClick={() => setParams([...params, { name: '', value: '' }])} className="inline-flex items-center gap-1 text-xs text-slate-700 hover:text-slate-900">
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
            {params.length === 0 ? (
              declared.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
                  No parameters. The flow will run with defaults.
                </p>
              ) : null
            ) : (
              <div className="space-y-2">
                {params.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <input type="text" placeholder="name" value={p.name} onChange={e => setParams(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} className="w-32 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-mono focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100" />
                    <input type="text" placeholder="value" value={p.value} onChange={e => setParams(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className="flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 font-mono text-xs focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100" />
                    <button onClick={() => setParams(params.filter((_, j) => j !== i))} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-start gap-1.5 rounded-md bg-slate-50 ring-1 ring-inset ring-slate-200/60 px-2.5 py-2 text-[12px] text-slate-600">
              <Info className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-400" />
              <div>
                <span className="font-medium text-slate-700">Templates:</span> {TEMPLATE_HINTS.map((t, i) => <span key={t}><code className="rounded bg-white px-1 font-mono text-[12px] ring-1 ring-inset ring-slate-200/60">{t}</code>{i < TEMPLATE_HINTS.length - 1 ? ' ' : ''}</span>)}
              </div>
            </div>
          </div>
          {error && <div className="rounded-md bg-rose-50 ring-1 ring-rose-200/60 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3 rounded-b-xl">
          <button onClick={onClose} className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 h-9 text-[14px] font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap">Cancel</button>
          <button onClick={handleRun} disabled={submitting} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 h-9 text-[14px] font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</> : <><Play className="h-4 w-4" /> Run now</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function Tasks() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [executions, setExecutions] = useState<Record<string, Execution[]>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<SidebarFilter>({ scope: 'all', label: 'All Projects' });
  const [search, setSearch] = useState('');
  // Per-project declared tag groups — fetched from the server's ProjectTag table.
  // Shape: { [projectId]: [{ id, name }, ...] }
  // Persisted in DB so they're shared across users & devices.
  const [projectTagsById, setProjectTagsById] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  // Which project's "+ Tag" input is currently open. null when no input is shown.
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  // dropTarget.groupId is the composite `${projectId}::${tagId}` identifier
  const [dropTarget, setDropTarget] = useState<{ groupId: string; beforeId?: string } | null>(null);
  const showAllTypes = false;
  const [runFlow, setRunFlow] = useState<Flow | null>(null);
  const [killTarget, setKillTarget] = useState<Flow | null>(null);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleKillConfirm = async () => {
    if (!killTarget) return;
    const runningExec = (executions[killTarget.id] || []).find(e => (e.status || '').toLowerCase() === 'running');
    if (!runningExec) {
      setKillError('No running execution found');
      return;
    }
    setKilling(true); setKillError(null);
    try {
      const r = await fetch(`${API_URL}/executions/${runningExec.id}/terminate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Terminated by user from Run Flow' }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to terminate');
      setToast({ type: 'success', message: `Terminated "${killTarget.name}"` });
      setKillTarget(null);
      fetchData(true);
    } catch (e: any) {
      setKillError(e.message);
    } finally {
      setKilling(false);
    }
  };
  const refreshing = useRef(false);

  const fetchData = useCallback(async (silent = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (!silent) setLoading(true);
    try {
      const url = `${API_URL}/schedulers/available-flows${showAllTypes ? '?all=true' : ''}`;
      const [flowRes, execRes, projRes] = await Promise.all([
        fetch(url),
        fetch(`${API_URL}/executions?limit=200`),
        fetch(`${API_URL}/projects`),
      ]);
      const flowData = await flowRes.json();
      const execData = await execRes.json();
      const projData = await projRes.json();
      if (flowData.success) {
        const fs: Flow[] = flowData.data;
        setFlows(fs);

        const counts = new Map<string, { total: number; active: number }>();
        for (const f of fs) {
          if (!f.project) continue;
          if (!counts.has(f.project.id)) counts.set(f.project.id, { total: 0, active: 0 });
          const c = counts.get(f.project.id)!;
          c.total++;
          if (f.status === 'Active' || f.status === 'active') c.active++;
        }
        const fullProjects: any[] = projData.success ? (projData.data || []) : [];
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
      if (execData.success) {
        const list: Execution[] = execData.data?.executions || execData.data || [];
        const map: Record<string, Execution[]> = {};
        for (const e of list) {
          if (!map[e.flowId]) map[e.flowId] = [];
          if (map[e.flowId].length < 10) map[e.flowId].push(e);
        }
        setExecutions(map);
      }
    } finally {
      refreshing.current = false;
      if (!silent) setLoading(false);
    }
  }, [showAllTypes]);

  useEffect(() => {
    fetchData();
    const i = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(i);
  }, [fetchData]);

  const projsById = useMemo(() => buildProjectsById(projects), [projects]);

  const scopeFiltered = useMemo(() =>
    filterByScope(flows, filter.scope, projsById, f => f.status === 'Active' || f.status === 'active'),
    [flows, filter.scope, projsById]);

  const finalList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopeFiltered;
    return scopeFiltered.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.project?.name || '').toLowerCase().includes(q) ||
      (f.description || '').toLowerCase().includes(q)
    );
  }, [scopeFiltered, search]);

  // Fetch declared tag catalog for each project (from the ProjectTag table).
  // Refetches whenever the project list changes.
  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          projects.map(p =>
            fetch(`${API_URL}/projects/${p.id}/tags`)
              .then(r => r.json())
              .then(d => ({ projectId: p.id, tags: (d.success && Array.isArray(d.data)) ? d.data : [] }))
              .catch(() => ({ projectId: p.id, tags: [] }))
          )
        );
        if (cancelled) return;
        const map: Record<string, Array<{ id: string; name: string }>> = {};
        for (const { projectId, tags } of results) {
          map[projectId] = tags.map((t: any) => ({ id: t.id, name: t.name }));
        }
        setProjectTagsById(map);
      } catch {/* silent */}
    })();
    return () => { cancelled = true; };
  }, [projects]);

  // Two-level grouping: Project (outer) → Tag (inner) → Flow.
  // A flow with multiple tags shows in every tag sub-group of its project.
  // Flows with no tag go into "Untagged" within their project.
  // Project-declared tags (from /project-tags) appear as empty droppable
  // sub-groups under their respective project.
  type TagSubGroup = { id: string; name: string; items: typeof finalList; userAdded?: boolean };
  type ProjectGroup = { id: string; name: string; color?: string; tagGroups: TagSubGroup[]; flowCount: number };

  const groupedList = useMemo<ProjectGroup[]>(() => {
    const projectMap = new Map<string, ProjectGroup>();

    // First pass: bucket each flow into its project's tag sub-groups
    for (const f of finalList) {
      const pid = f.project?.id || 'unassigned';
      if (!projectMap.has(pid)) {
        projectMap.set(pid, {
          id: pid,
          name: f.project?.name || 'Unassigned',
          color: f.project?.color,
          tagGroups: [],
          flowCount: 0,
        });
      }
      const proj = projectMap.get(pid)!;
      proj.flowCount += 1;

      const tags = parseTags(f.tags);
      const keys = tags.length > 0 ? tags : ['__untagged__'];
      for (const tag of keys) {
        let tg = proj.tagGroups.find(g => g.id === tag);
        if (!tg) {
          tg = { id: tag, name: tag === '__untagged__' ? 'Untagged' : tag, items: [] };
          proj.tagGroups.push(tg);
        }
        tg.items.push(f);
      }
    }

    // Second pass: seed declared (server-side) tag groups per project (even when empty)
    for (const pid of Object.keys(projectTagsById)) {
      const declared = projectTagsById[pid] || [];
      if (declared.length === 0) continue;
      let proj = projectMap.get(pid);
      if (!proj) {
        const pObj = projects.find(p => p.id === pid);
        if (!pObj) continue; // unknown project, skip
        proj = {
          id: pid,
          name: pObj.name,
          color: pObj.color,
          tagGroups: [],
          flowCount: 0,
        };
        projectMap.set(pid, proj);
      }
      for (const tag of declared) {
        const existing = proj.tagGroups.find(g => g.id === tag.name);
        if (existing) {
          existing.userAdded = true; // mark for delete-X visibility (only when empty)
        } else {
          proj.tagGroups.push({ id: tag.name, name: tag.name, items: [], userAdded: true });
        }
      }
    }

    // Sort tag sub-groups within each project and rows within each tag
    for (const proj of projectMap.values()) {
      proj.tagGroups.sort((a, b) => {
        if (a.id === '__untagged__') return 1;
        if (b.id === '__untagged__') return -1;
        return a.name.localeCompare(b.name, 'th');
      });
      for (const tg of proj.tagGroups) {
        tg.items.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name));
      }
    }

    // Sort projects by groupPosition → agencyPosition → position → name
    return Array.from(projectMap.values()).sort((a, b) => {
      const pa: any = projsById.get(a.id), pb: any = projsById.get(b.id);
      const ga = pa?.groupPosition ?? 999, gb = pb?.groupPosition ?? 999;
      if (ga !== gb) return ga - gb;
      const aa = pa?.agencyPosition ?? 999, ab = pb?.agencyPosition ?? 999;
      if (aa !== ab) return aa - ab;
      const xa = pa?.position ?? 999, xb = pb?.position ?? 999;
      if (xa !== xb) return xa - xb;
      return a.name.localeCompare(b.name);
    });
  }, [finalList, projectTagsById, projects, projsById]);

  const handleAddTag = async (projectId: string) => {
    const trimmed = newTagName.trim();
    setAddingTagFor(null);
    setNewTagName('');
    if (!projectId || !trimmed || trimmed === '__untagged__') return;

    // Optimistic insert with a temp id; replaced once the server responds.
    const tempId = `tmp-${Date.now()}`;
    setProjectTagsById(prev => {
      const list = prev[projectId] || [];
      if (list.some(t => t.name === trimmed)) return prev;
      return { ...prev, [projectId]: [...list, { id: tempId, name: trimmed }] };
    });

    try {
      const r = await fetch(`${API_URL}/projects/${projectId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to add tag');
      // Swap temp row for the server-canonical one
      setProjectTagsById(prev => ({
        ...prev,
        [projectId]: (prev[projectId] || []).map(t => t.id === tempId ? { id: d.data.id, name: d.data.name } : t),
      }));
    } catch (e: any) {
      // Rollback optimistic insert on failure
      setProjectTagsById(prev => ({
        ...prev,
        [projectId]: (prev[projectId] || []).filter(t => t.id !== tempId),
      }));
      setToast({ type: 'error', message: `เพิ่ม tag ไม่สำเร็จ: ${e.message}` });
    }
  };

  const handleRemoveTagGroup = async (projectId: string, tagName: string) => {
    const tag = (projectTagsById[projectId] || []).find(t => t.name === tagName);
    if (!tag || tag.id.startsWith('tmp-')) return;

    // Optimistic remove
    const before = projectTagsById[projectId] || [];
    setProjectTagsById(prev => ({
      ...prev,
      [projectId]: (prev[projectId] || []).filter(t => t.id !== tag.id),
    }));

    try {
      // apiFetch tunnels DELETE through POST + X-HTTP-Method-Override (WAF-safe)
      const r = await apiFetch(`${API_URL}/project-tags/${tag.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to delete tag');
    } catch (e: any) {
      // Rollback
      setProjectTagsById(prev => ({ ...prev, [projectId]: before }));
      setToast({ type: 'error', message: `ลบ tag ไม่สำเร็จ: ${e.message}` });
    }
  };

  // ── Drag-and-drop reorder + retag ────────────────────────────────────────
  // Within same tag in same project: persist displayOrder.
  // Across tag groups in SAME project: also retag (swap source→target).
  // Across projects: silently ignore — flow.projectId is a real DB relation,
  // can't be reassigned via tag drag.
  const handleDrop = async (
    targetProjectId: string,
    targetTagGroup: TagSubGroup,
    insertBeforeId?: string
  ) => {
    const draggedFlow = flows.find(f => f.id === draggedId);
    setDraggedId(null); setDropTarget(null);
    if (!draggedFlow) return;

    const sourceProjectId = draggedFlow.project?.id || 'unassigned';
    if (sourceProjectId !== targetProjectId) {
      setToast({ type: 'error', message: 'ลากย้ายข้าม project ไม่ได้ — ย้ายภายใน project เดียวกันเท่านั้น' });
      return;
    }

    const proj = groupedList.find(p => p.id === targetProjectId);
    if (!proj) return;
    const sourceTagGroup = proj.tagGroups.find(g => g.items.some(it => it.id === draggedFlow.id));
    const isCrossTag = sourceTagGroup?.id !== targetTagGroup.id;

    // Compute new ordering inside target tag group
    const remaining = targetTagGroup.items.filter(it => it.id !== draggedFlow.id);
    const insertAt = insertBeforeId
      ? remaining.findIndex(it => it.id === insertBeforeId)
      : remaining.length;
    const idx = insertAt < 0 ? remaining.length : insertAt;
    const reordered = [...remaining.slice(0, idx), draggedFlow, ...remaining.slice(idx)];

    // Build PUT requests — every flow whose displayOrder changes, plus the
    // dragged flow's tags if it moved into a new tag group.
    const updates: Promise<Response>[] = [];
    reordered.forEach((f, i) => {
      const newOrder = (i + 1) * 10;
      const tagChange = isCrossTag && f.id === draggedFlow.id
        ? (() => {
            const oldTags = parseTags(draggedFlow.tags);
            const sourceTag = sourceTagGroup?.id;
            const targetTag = targetTagGroup.id;
            const newTags = oldTags
              .filter(t => !sourceTag || sourceTag === '__untagged__' || t !== sourceTag);
            if (targetTag && targetTag !== '__untagged__' && !newTags.includes(targetTag)) {
              newTags.push(targetTag);
            }
            return { tags: JSON.stringify(newTags) };
          })()
        : {};
      if (f.displayOrder !== newOrder || Object.keys(tagChange).length > 0) {
        // apiFetch tunnels PUT through POST + X-HTTP-Method-Override so
        // Cloudflare WAF (which blocks raw PUT/DELETE) lets it through.
        // Server middleware in index.ts converts it back to PUT before routing.
        updates.push(apiFetch(`${API_URL}/flows/${f.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayOrder: newOrder, ...tagChange }),
        }));
      }
    });

    // Optimistic local update
    setFlows(prev => prev.map(f => {
      const inReord = reordered.findIndex(r => r.id === f.id);
      if (inReord < 0) return f;
      const newOrder = (inReord + 1) * 10;
      if (f.id === draggedFlow.id && isCrossTag) {
        const oldTags = parseTags(f.tags);
        const newTags = oldTags.filter(t => t !== sourceTagGroup?.id);
        if (targetTagGroup.id !== '__untagged__' && !newTags.includes(targetTagGroup.id)) newTags.push(targetTagGroup.id);
        return { ...f, displayOrder: newOrder, tags: JSON.stringify(newTags) };
      }
      return { ...f, displayOrder: newOrder };
    }));

    try {
      const responses = await Promise.all(updates);
      // fetch() doesn't throw on 4xx/5xx — we have to inspect each response.
      // If any failed, surface a real error so the user knows the drag-drop
      // didn't persist (instead of just silently reverting on next refresh).
      const failed: { status: number; body: string }[] = [];
      for (const r of responses) {
        if (!r.ok) {
          let body = '';
          try { body = (await r.text()).slice(0, 200); } catch {}
          failed.push({ status: r.status, body });
        }
      }
      if (failed.length > 0) {
        console.error('[tasks] drag-drop PUT failed:', failed);
        setToast({ type: 'error', message: `บันทึก tag ไม่สำเร็จ (HTTP ${failed[0].status}): ${failed[0].body || '(no body)'}` });
        fetchData(true); // re-sync to undo the optimistic UI
      }
    } catch (e: any) {
      console.error('[tasks] reorder network error', e);
      setToast({ type: 'error', message: `network error: ${e?.message || e}` });
      fetchData(true);
    }
  };

  if (loading) return (
    <div className="flex h-full items-center justify-center text-slate-500">
      <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
    </div>
  );

  return (
    <div className="flex flex-col md:flex-row h-full bg-slate-50">
      <ProjectTreeSidebar
        projects={projects.filter(p => p.count && p.count > 0)}
        selected={filter.scope}
        onSelect={setFilter}
        itemLabel="flows"
        totalCount={flows.length}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-slate-200 bg-white">
          <div className="px-6 pt-4 pb-3">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h1 className="text-[17px] font-semibold tracking-tight text-slate-900">Run Flow</h1>
                  <span className="text-[12px] tabular-nums text-slate-400">
                    {filter.label} · {finalList.length} flows
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative w-72 max-w-full">
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
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {finalList.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center px-6">
              <div className="rounded-full bg-slate-100 p-3.5 mb-3 ring-1 ring-slate-200/60">
                <Workflow className="h-5 w-5 text-slate-400" />
              </div>
              <p className="text-sm font-medium text-slate-700">
                {search ? 'No matches' : 'No flows in this scope'}
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                {search ? `Nothing matches "${search}".` : 'Pick a different project or untick the filter.'}
              </p>
            </div>
          ) : (
            <div className="px-3 sm:px-6 py-4">
              {(() => {
                const renderRow = (f: typeof finalList[number], groupId: string) => {
                  const colors = getColor(f.project?.color);
                  const flowExecs = executions[f.id] || [];
                  const lastExec = flowExecs[0];
                  const isDragging = draggedId === f.id;
                  const showDropIndicatorAbove = dropTarget?.groupId === groupId && dropTarget?.beforeId === f.id;
                  return (
                    <li
                      key={f.id}
                      draggable
                      onDragStart={(e) => {
                        setDraggedId(f.id);
                        try { e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'move'; } catch {}
                      }}
                      onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
                      onDragOver={(e) => {
                        if (!draggedId || draggedId === f.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropTarget({ groupId, beforeId: f.id });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        // groupId is `${projectId}::${tagId}` for tag rows
                        const [pid, tagId] = groupId.split('::');
                        const proj = groupedList.find(p => p.id === pid);
                        const tg = proj?.tagGroups.find(g => g.id === tagId);
                        if (proj && tg) handleDrop(proj.id, tg, f.id);
                      }}
                      className={`group relative flex items-center gap-3 rounded-lg bg-white pl-1 pr-2 py-2 ring-1 ring-slate-200/70 hover:ring-slate-300 hover:shadow-sm transition-all ${isDragging ? 'opacity-40' : ''} ${showDropIndicatorAbove ? 'ring-2 ring-blue-400' : ''}`}
                    >
                      <span className="hidden sm:inline shrink-0 cursor-grab text-slate-300 hover:text-slate-500 px-0.5" title="Drag to reorder">
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                      <span className={`hidden sm:inline-block shrink-0 h-2 w-2 rounded-full ${colors.edge}`} title={f.project?.name} />

                      {/* Status icon — replaces workflow icon, mirrors Schedulers */}
                      {(() => {
                        const isActive = f.status === 'Active' || f.status === 'active';
                        const isRunning = (lastExec?.status || '').toLowerCase() === 'running';
                        const status = isRunning
                          ? { bg: 'bg-violet-50 ring-violet-200/60', icon: <Loader2 className="h-4 w-4 text-violet-600 animate-spin" />, label: 'Running' }
                          : isActive
                          ? { bg: 'bg-emerald-50 ring-emerald-200/60', icon: <span className="h-2 w-2 rounded-full bg-emerald-500" />, label: 'Active' }
                          : { bg: 'bg-slate-100 ring-slate-200/60', icon: <Pause className="h-3.5 w-3.5 text-slate-500" />, label: 'Inactive' };
                        return (
                          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${status.bg}`} title={status.label}>
                            {status.icon}
                          </div>
                        );
                      })()}

                      {/* Flow name + variable chips */}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[13px] text-slate-900 leading-tight line-clamp-2 break-words sm:truncate" title={f.name}>{f.name}</div>
                        {(() => {
                          const vars = parseFlowVariables(f.config);
                          if (vars.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {vars.map(v => (
                                <span
                                  key={v.name}
                                  className="inline-flex items-center gap-0.5 rounded bg-slate-100 ring-1 ring-inset ring-slate-200/60 px-1.5 py-0.5 text-[12px] font-medium text-slate-600"
                                  title={v.label ? `${v.label} ({{${v.name}}})` : `{{${v.name}}}`}
                                >
                                  {v.type === 'dropdown' && <ChevronDown className="h-2.5 w-2.5 text-slate-400" />}
                                  <span className="font-mono">{v.name}</span>
                                  {v.label && <span className="text-slate-400">·</span>}
                                  {v.label && <span>{v.label}</span>}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Stats: Last run, History — fixed widths align across rows */}
                      <div className="hidden md:flex shrink-0 items-stretch divide-x divide-slate-200/70 text-right">
                        <div className="px-3 w-[150px]">
                          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">Last run</div>
                          <div className="mt-1 flex items-center justify-end gap-1 leading-none">
                            {lastExec ? (
                              <>
                                {(lastExec.status || '').toLowerCase() === 'completed' && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                                {(lastExec.status || '').toLowerCase() === 'success' && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                                {(lastExec.status || '').toLowerCase() === 'failed' && <XCircle className="h-3 w-3 text-rose-500 shrink-0" />}
                                <span className="text-[11.5px] text-slate-700 whitespace-nowrap tabular-nums" title={formatAbsolute(lastExec.startedAt)}>
                                  {formatDateTime(lastExec.startedAt).date} <span className="text-slate-400">{formatDateTime(lastExec.startedAt).time}</span>
                                </span>
                              </>
                            ) : (
                              <span className="text-[11.5px] text-slate-400">never run</span>
                            )}
                          </div>
                          {lastExec && (lastExec.status || '').toLowerCase() === 'failed' && lastExec.error && (
                            <div
                              className="mt-1 text-[12px] text-rose-600 truncate cursor-help"
                              title={lastExec.error}
                            >
                              {lastExec.error}
                            </div>
                          )}
                        </div>
                        <div className="px-3 w-[110px]">
                          <div className="text-[12px] uppercase tracking-wide text-slate-400 font-medium leading-none">History</div>
                          <div className="mt-1 flex justify-end leading-none">
                            <HistoryBars executions={flowExecs} />
                          </div>
                        </div>
                      </div>

                      {/* Actions — Run morphs into Kill when running */}
                      <div className="flex shrink-0 items-center gap-0 pl-1">
                        <button
                          onClick={() => navigate(`/schedulers/${f.id}/logs`)}
                          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                          title="View execution log"
                        >
                          <BarChart3 className="h-3.5 w-3.5" />
                        </button>
                        {(lastExec?.status || '').toLowerCase() === 'running' ? (
                          <button
                            onClick={() => { setKillTarget(f); setKillError(null); }}
                            className="inline-flex items-center gap-1 rounded-md bg-rose-600 text-white px-2.5 py-1 text-[12px] font-medium hover:bg-rose-700 transition-colors ml-1"
                          >
                            <Square className="h-3 w-3 fill-current" /> Kill
                          </button>
                        ) : (
                          <button
                            onClick={() => setRunFlow(f)}
                            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 text-white px-2.5 py-1 text-[12px] font-medium hover:bg-blue-700 transition-colors ml-1"
                          >
                            <Play className="h-3 w-3" /> Run
                          </button>
                        )}
                      </div>
                    </li>
                  );
                };

                return (
                  <div className="space-y-7">
                    {groupedList.map(proj => {
                      const pc = getColor(proj.color);
                      const isAddingHere = addingTagFor === proj.id;
                      return (
                        <section key={proj.id}>
                          {/* Project header */}
                          <header className="flex items-center gap-2 mb-2 px-1">
                            <span className={`h-2.5 w-2.5 rounded-full ${pc.edge}`} />
                            <h2 className="text-[14px] font-semibold text-slate-900 tracking-tight">{proj.name}</h2>
                            <span className="text-[10.5px] tabular-nums text-slate-400">
                              {proj.flowCount} flow{proj.flowCount === 1 ? '' : 's'}
                            </span>
                            <span className="flex-1 h-px bg-slate-200" />
                            {/* + Tag — per-project */}
                            {isAddingHere ? (
                              <form
                                onSubmit={(e) => { e.preventDefault(); handleAddTag(proj.id); }}
                                className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-300 bg-white pl-2 pr-1 py-0.5"
                              >
                                <TagIcon className="h-3 w-3 text-slate-400" />
                                <input
                                  autoFocus
                                  value={newTagName}
                                  onChange={(e) => setNewTagName(e.target.value)}
                                  onBlur={() => handleAddTag(proj.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') { setAddingTagFor(null); setNewTagName(''); }
                                  }}
                                  placeholder="new tag name…"
                                  className="w-32 text-[11.5px] py-0.5 focus:outline-none placeholder:text-slate-400"
                                />
                              </form>
                            ) : (
                              <button
                                onClick={() => { setAddingTagFor(proj.id); setNewTagName(''); }}
                                className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 bg-white px-2 py-0.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                                title={`Add a tag group under ${proj.name}`}
                              >
                                <Plus className="h-3 w-3" /> Tag
                              </button>
                            )}
                          </header>

                          {/* Tag sub-groups within this project */}
                          <div className="space-y-3 ml-2 pl-3 border-l-2 border-slate-100">
                            {proj.tagGroups.length === 0 ? (
                              <div className="text-[11.5px] text-slate-400 italic px-2 py-1">
                                No flows yet — click <span className="font-semibold">+ Tag</span> to create a tag group.
                              </div>
                            ) : proj.tagGroups.map(tg => {
                              const compositeId = `${proj.id}::${tg.id}`;
                              const canRemove = tg.userAdded && tg.items.length === 0;
                              const isEmpty = tg.items.length === 0;
                              const isDropTargetEmpty = dropTarget?.groupId === compositeId && !dropTarget?.beforeId;
                              return (
                                <section
                                  key={tg.id}
                                  onDragOver={(e) => {
                                    if (!draggedId) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    if (!dropTarget || dropTarget.groupId !== compositeId) {
                                      setDropTarget({ groupId: compositeId, beforeId: undefined });
                                    }
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    handleDrop(proj.id, tg, dropTarget?.beforeId);
                                  }}
                                >
                                  <header className="flex items-center gap-2 mb-1.5 group/header">
                                    <TagIcon className="h-3 w-3 text-slate-400" />
                                    <h3 className="text-[12.5px] font-semibold text-slate-700">{tg.name}</h3>
                                    <span className="text-[10.5px] tabular-nums text-slate-400">{tg.items.length}</span>
                                    {canRemove && (
                                      <button
                                        onClick={() => handleRemoveTagGroup(proj.id, tg.id)}
                                        className="opacity-0 group-hover/header:opacity-100 inline-flex items-center justify-center h-4 w-4 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-all"
                                        title="Remove this empty tag group"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    )}
                                  </header>
                                  <ul className={`space-y-1.5 min-h-[8px] ${isEmpty ? `rounded-md border-2 border-dashed ${isDropTargetEmpty ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200 bg-slate-50/40'} px-3 py-3 text-center text-[12px] text-slate-400` : ''}`}>
                                    {tg.items.length > 0
                                      ? tg.items.map(f => renderRow(f, compositeId))
                                      : <li className="select-none">Drag a flow from this project here to add the "{tg.name}" tag</li>}
                                  </ul>
                                </section>
                              );
                            })}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      <RunFlowModal
        flow={runFlow}
        isOpen={!!runFlow}
        onClose={() => setRunFlow(null)}
        onSubmitted={() => fetchData(true)}
      />

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
                  This will stop the running execution of <span className="font-medium text-slate-700">{killTarget.name}</span>. Partial work may be lost.
                </p>
              </div>
            </div>
            {killError && (
              <div className="px-5 py-2.5 bg-rose-50 border-b border-rose-100 text-[12px] text-rose-700">{killError}</div>
            )}
            <div className="flex justify-end gap-2 px-5 py-3 bg-slate-50">
              <button onClick={() => setKillTarget(null)} disabled={killing} className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 h-9 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">Cancel</button>
              <button onClick={handleKillConfirm} disabled={killing} className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-[12px] font-medium disabled:opacity-50 whitespace-nowrap bg-red-600 text-white hover:bg-red-700">
                {killing && <Loader2 className="h-3 w-3 animate-spin" />}
                {killing ? 'Terminating…' : 'Terminate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className={`flex items-center gap-2.5 rounded-lg shadow-lg ring-1 px-4 py-2.5 ${
            toast.type === 'success' ? 'bg-emerald-50 ring-emerald-200 text-emerald-800' : 'bg-rose-50 ring-rose-200 text-rose-800'
          }`}>
            {toast.type === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <XCircle className="h-4 w-4 text-rose-600 shrink-0" />}
            <span className="text-[12.5px] font-medium">{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 text-slate-400 hover:text-slate-700">×</button>
          </div>
        </div>
      )}
    </div>
  );
}
