import { useState, useEffect, useRef, useMemo } from 'react';
import { X, Plus, Trash2, Info, Search, Check, ChevronDown, Clock } from 'lucide-react';
import { API_URL } from '../config/api';
import { resolveDateTimePlaceholders } from '../utils/datetimePlaceholders';

export interface SchedulerFormValues {
  id?: string;
  flowId: string;
  name?: string;
  schedule: string;
  timezone: string;
  parameters: { name: string; value: string; description?: string }[];
  maxConcurrent: number;
  enabled: boolean;
}

interface FlowOption {
  id: string;
  name: string;
  description?: string | null;
  projectId: string;
  status?: string;
  displayOrder?: number;
  project?: {
    id: string;
    name: string;
    color?: string;
    status?: string;
    projectGroup?: string | null;
    agency?: string | null;
    groupPosition?: number;
    agencyPosition?: number;
    position?: number;
  };
}

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  initialValues?: Partial<SchedulerFormValues>;
  onClose: () => void;
  onSaved: () => void;
}

const CRON_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Daily at 6am', value: '0 6 * * *' },
  { label: 'Monday at 9am', value: '0 9 * * 1' },
  { label: 'First of month', value: '0 0 1 * *' },
  { label: 'Yearly (Jan 1)', value: '0 0 1 1 *' },
];

const TIMEZONES = ['Asia/Bangkok', 'UTC', 'Asia/Singapore', 'Asia/Tokyo', 'America/New_York', 'Europe/London'];

// Project color palette (matches Projects page)
const PROJECT_COLORS: Record<string, { bg: string; text: string; ring: string }> = {
  blue:   { bg: 'bg-blue-500',   text: 'text-blue-600',   ring: 'ring-blue-200' },
  purple: { bg: 'bg-purple-500', text: 'text-purple-600', ring: 'ring-purple-200' },
  green:  { bg: 'bg-green-500',  text: 'text-green-600',  ring: 'ring-green-200' },
  orange: { bg: 'bg-orange-500', text: 'text-orange-600', ring: 'ring-orange-200' },
  pink:   { bg: 'bg-pink-500',   text: 'text-pink-600',   ring: 'ring-pink-200' },
  cyan:   { bg: 'bg-cyan-500',   text: 'text-cyan-600',   ring: 'ring-cyan-200' },
  indigo: { bg: 'bg-indigo-500', text: 'text-indigo-600', ring: 'ring-indigo-200' },
  amber:  { bg: 'bg-amber-500',  text: 'text-amber-600',  ring: 'ring-amber-200' },
  red:    { bg: 'bg-red-500',    text: 'text-red-600',    ring: 'ring-red-200' },
  teal:   { bg: 'bg-teal-500',   text: 'text-teal-600',   ring: 'ring-teal-200' },
};
const getProjectColors = (c?: string) => PROJECT_COLORS[c || 'blue'] || PROJECT_COLORS.blue;

const TEMPLATE_HINTS = [
  { token: '{{year}}', desc: 'Current year (YYYY)' },
  { token: '{{year+543}}', desc: 'Buddhist year (พ.ศ.)' },
  { token: '{{year-1}}', desc: 'Previous year' },
  { token: '{{month}}', desc: 'Current month (MM)' },
  { token: '{{day}}', desc: 'Current day (DD)' },
  { token: '{{date}}', desc: 'YYYY-MM-DD' },
  { token: '{{date+1}}', desc: 'Tomorrow' },
  { token: '{{datetime}}', desc: 'ISO datetime' },
];

export default function SchedulerFormModal({ open, mode, initialValues, onClose, onSaved }: Props) {
  const [flows, setFlows] = useState<FlowOption[]>([]);
  const [form, setForm] = useState<SchedulerFormValues>({
    flowId: '',
    name: '',
    schedule: '0 0 * * *',
    timezone: 'Asia/Bangkok',
    parameters: [],
    maxConcurrent: 1,
    enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flow search combobox state
  const [flowQuery, setFlowQuery] = useState('');
  const [flowDropdownOpen, setFlowDropdownOpen] = useState(false);
  const flowComboRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (flowComboRef.current && !flowComboRef.current.contains(e.target as Node)) {
        setFlowDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filtered flows by search query (matches flow name, project name, or description)
  const filteredFlows = useMemo(() => {
    const q = flowQuery.trim().toLowerCase();
    return flows.filter(f => {
      if (!q) return true;
      const projectName = f.project?.name?.toLowerCase() || '';
      const desc = f.description?.toLowerCase() || '';
      return f.name.toLowerCase().includes(q) || projectName.includes(q) || desc.includes(q);
    });
  }, [flows, flowQuery]);

  // Group filtered flows by project for hierarchical display
  const flowsByProject = useMemo(() => {
    const groups = new Map<string, { project: FlowOption['project']; flows: FlowOption[] }>();
    for (const f of filteredFlows) {
      if (!f.project) continue;
      const key = f.project.id;
      if (!groups.has(key)) {
        groups.set(key, { project: f.project, flows: [] });
      }
      groups.get(key)!.flows.push(f);
    }
    return Array.from(groups.values()).sort((a, b) =>
      (a.project?.position ?? 999) - (b.project?.position ?? 999) ||
      (a.project?.name || '').localeCompare(b.project?.name || '')
    );
  }, [filteredFlows]);

  const selectedFlow = flows.find(f => f.id === form.flowId);

  // Declared / auto-detected variables for the selected flow
  const [declaredVars, setDeclaredVars] = useState<{
    name: string;
    type?: 'text' | 'number' | 'date' | 'dropdown';
    label?: string;
    description?: string;
    required?: boolean;
    default?: string;
    options?: { value: string; label?: string }[];
  }[]>([]);
  const [loadingVars, setLoadingVars] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Fetch available flows (only for create mode)
    fetch(`${API_URL}/schedulers/available-flows`)
      .then(r => r.json())
      .then(d => { if (d.success) setFlows(d.data); })
      .catch(() => {});
  }, [open]);

  // When flow changes — load its declared variables + auto-detected tokens
  useEffect(() => {
    if (!form.flowId) { setDeclaredVars([]); return; }
    setLoadingVars(true);
    fetch(`${API_URL}/flows/${form.flowId}`)
      .then(r => r.json())
      .then(d => {
        if (!d.success) return;
        const f = d.data;
        let cfg: any = {};
        try { cfg = typeof f.config === 'string' ? JSON.parse(f.config || '{}') : (f.config || {}); } catch {}
        const declared = Array.isArray(cfg.variables) ? cfg.variables : [];
        // Auto-detect tokens from nodes
        let detected = new Set<string>();
        try {
          const nodes = typeof f.nodes === 'string' ? JSON.parse(f.nodes || '[]') : (f.nodes || []);
          const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
          const walk = (v: any) => {
            if (typeof v === 'string') { let m; while ((m = re.exec(v))) detected.add(m[1]); }
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
          };
          walk(nodes);
        } catch {}
        // year/month/day NOT in RESERVED — user often passes FY year explicitly
        const RESERVED = new Set(['trigger','vars','input','body','path','query','header','extension','timestamp','datetime','date','date+1','year+543','year-1','currentFile','currentItem','item','fileName','index','triggeredAt','triggeredDate']);
        const undeclared = [...detected].filter(n => !RESERVED.has(n) && !declared.find((v: any) => v.name === n));
        const autoDeclared = undeclared.map(n => ({ name: n, type: 'text' as const }));
        const all = [...declared, ...autoDeclared];
        setDeclaredVars(all);
        // Seed form.parameters for new variables that don't already have a value
        setForm(prev => {
          const existing = new Map(prev.parameters.map(p => [p.name, p]));
          const merged: typeof prev.parameters = [];
          for (const v of all) {
            const cur = existing.get(v.name);
            merged.push(cur || { name: v.name, value: resolveDateTimePlaceholders(v.default || ''), description: v.description });
          }
          // Keep any user-added params not in declared list
          for (const p of prev.parameters) {
            if (!all.find(v => v.name === p.name)) merged.push(p);
          }
          return { ...prev, parameters: merged };
        });
      })
      .catch(() => {})
      .finally(() => setLoadingVars(false));
  }, [form.flowId]);

  useEffect(() => {
    if (open && initialValues) {
      setForm({
        id: initialValues.id,
        flowId: initialValues.flowId || '',
        name: initialValues.name || '',
        schedule: initialValues.schedule || '0 0 * * *',
        timezone: initialValues.timezone || 'Asia/Bangkok',
        parameters: initialValues.parameters || [],
        maxConcurrent: initialValues.maxConcurrent || 1,
        enabled: initialValues.enabled !== false,
      });
      setError(null);
    }
  }, [open, initialValues]);

  if (!open) return null;

  const update = <K extends keyof SchedulerFormValues>(key: K, value: SchedulerFormValues[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const addParam = () => {
    update('parameters', [...form.parameters, { name: '', value: '', description: '' }]);
  };
  const removeParam = (idx: number) => {
    update('parameters', form.parameters.filter((_, i) => i !== idx));
  };
  const setParam = (idx: number, field: 'name' | 'value' | 'description', value: string) => {
    update('parameters', form.parameters.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const handleSave = async () => {
    setError(null);
    if (!form.flowId) { setError('Please select a Flow'); return; }
    if (!form.schedule.trim()) { setError('Cron expression is required'); return; }
    setSaving(true);
    try {
      const url = mode === 'edit' && form.id
        ? `${API_URL}/schedulers/${form.id}`
        : `${API_URL}/schedulers`;
      const method = mode === 'edit' ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowId: form.flowId,
          name: form.name || undefined,
          schedule: form.schedule,
          timezone: form.timezone,
          parameters: form.parameters.filter(p => p.name.trim()),
          maxConcurrent: form.maxConcurrent,
          enabled: form.enabled,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to save scheduler');
        return;
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to save scheduler');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {mode === 'edit' ? 'Edit Scheduler' : 'New Scheduler'}
          </h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {/* Flow picker - searchable combobox */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Flow <span className="text-red-500">*</span></label>
            <div className="relative" ref={flowComboRef}>
              <button
                type="button"
                disabled={mode === 'edit'}
                onClick={() => setFlowDropdownOpen(!flowDropdownOpen)}
                className={`flex w-full items-center justify-between rounded-md border border-gray-300 px-3 py-2 text-left text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  mode === 'edit' ? 'cursor-not-allowed bg-gray-50 text-gray-600' : 'bg-white hover:border-gray-400'
                } ${flowDropdownOpen ? 'ring-1 ring-blue-500 border-blue-500' : ''}`}
              >
                {selectedFlow ? (
                  <span className="flex items-center gap-2.5 min-w-0">
                    {(() => {
                      const c = getProjectColors(selectedFlow.project?.color);
                      const init = (selectedFlow.project?.name || '?').charAt(0).toUpperCase();
                      return (
                        <>
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs font-semibold text-white ${c.bg}`}>
                            {init}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className={`text-xs ${c.text}`}>{selectedFlow.project?.name}</span>
                              <span className="text-gray-300 text-xs">·</span>
                              <Clock className="h-3 w-3 text-gray-400 shrink-0" />
                              <span className="truncate font-medium text-gray-900">{selectedFlow.name}</span>
                            </span>
                          </span>
                        </>
                      );
                    })()}
                  </span>
                ) : (
                  <span className="text-gray-400">Search and select a flow…</span>
                )}
                <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${flowDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {flowDropdownOpen && mode !== 'edit' && (
                <div className="absolute left-0 right-0 z-20 mt-1 max-h-[32rem] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
                  {/* Sticky header: search only */}
                  <div className="sticky top-0 border-b border-gray-100 bg-white p-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        type="text"
                        autoFocus
                        value={flowQuery}
                        onChange={(e) => setFlowQuery(e.target.value)}
                        placeholder="Search by flow name, project, or description…"
                        className="w-full rounded-md border border-gray-200 pl-8 pr-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  {/* Scrollable list: hierarchical project cards */}
                  <div className="max-h-[22rem] overflow-y-auto p-2 space-y-3 bg-gray-50">
                    {flowsByProject.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-gray-500">
                        No flows match the current filters
                      </div>
                    ) : (
                      flowsByProject.map(({ project, flows: projectFlows }) => {
                        const colors = getProjectColors(project?.color);
                        const projectInitial = (project?.name || '?').charAt(0).toUpperCase();
                        const isProjectActive = project?.status === 'Active' || project?.status === 'active';
                        return (
                          <div key={project?.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                            {/* Project header (Projects page style) */}
                            <div className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 bg-white">
                              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white ${colors.bg}`}>
                                {projectInitial}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className={`font-semibold text-sm truncate ${colors.text}`}>
                                  {project?.name}
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className={`h-1.5 w-1.5 rounded-full ${isProjectActive ? 'bg-blue-500' : 'bg-gray-300'}`} />
                                  <span className="text-[12px] text-gray-500 capitalize">{project?.status || 'unknown'}</span>
                                  <span className="text-gray-300 text-[12px] mx-1">·</span>
                                  <span className="text-[12px] text-gray-500">{projectFlows.length} flow{projectFlows.length !== 1 ? 's' : ''}</span>
                                </div>
                              </div>
                            </div>
                            {/* Flow cards (like flow list on Project page) */}
                            <div className="p-2 space-y-1.5">
                              {projectFlows.map(f => {
                                const isSelected = f.id === form.flowId;
                                const isFlowActive = f.status === 'Active' || f.status === 'active';
                                return (
                                  <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => {
                                      update('flowId', f.id);
                                      setFlowQuery('');
                                      setFlowDropdownOpen(false);
                                    }}
                                    className={`flex w-full items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                                      isSelected
                                        ? `border-blue-400 bg-blue-50 ring-1 ${colors.ring}`
                                        : 'border-gray-100 bg-white hover:border-gray-300 hover:bg-gray-50'
                                    }`}
                                  >
                                    <Clock className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${colors.text}`} />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className={`font-medium text-sm truncate ${isSelected ? 'text-blue-700' : colors.text}`}>
                                          {f.name}
                                        </span>
                                        <span className={`inline-flex items-center gap-1 text-[12px] ${isFlowActive ? 'text-green-600' : 'text-gray-400'}`}>
                                          <span className={`h-1.5 w-1.5 rounded-full ${isFlowActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                                          {f.status || 'draft'}
                                        </span>
                                      </div>
                                      {f.description && (
                                        <div className="text-xs text-gray-500 mt-0.5 truncate">{f.description}</div>
                                      )}
                                    </div>
                                    {isSelected && <Check className="h-4 w-4 shrink-0 text-blue-600 mt-0.5" />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Footer counter */}
                  <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 text-xs text-gray-500">
                    {filteredFlows.length} of {flows.length} flow{flows.length !== 1 ? 's' : ''}
                    {flowQuery && (
                      <button
                        type="button"
                        onClick={() => setFlowQuery('')}
                        className="ml-2 text-blue-600 hover:text-blue-700"
                      >
                        Clear search
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {mode === 'edit' && (
              <p className="mt-1 text-xs text-gray-500">Flow cannot be changed after creation.</p>
            )}
          </div>

          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name (optional)</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="e.g. Daily Morning Run"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Cron */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Cron Expression <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.schedule}
              onChange={(e) => update('schedule', e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {CRON_PRESETS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => update('schedule', p.value)}
                  className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Timezone + MaxConcurrent */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Timezone</label>
              <select
                value={form.timezone}
                onChange={(e) => update('timezone', e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Max Concurrent Runs</label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxConcurrent}
                onChange={(e) => update('maxConcurrent', parseInt(e.target.value, 10) || 1)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Parameters */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">Parameters</label>
              <button type="button" onClick={addParam} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
                <Plus className="h-3.5 w-3.5" /> Add parameter
              </button>
            </div>
            {loadingVars && (
              <p className="mb-2 text-xs text-gray-500">Loading flow variables…</p>
            )}
            {form.parameters.length === 0 ? (
              <p className="rounded-md border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                No parameters. Click "Add parameter" to inject values into the flow execution.
              </p>
            ) : (
              <div className="space-y-2">
                {form.parameters.map((p, i) => {
                  const def = declaredVars.find(v => v.name === p.name);
                  const isDeclared = !!def;
                  const isDropdown = def?.type === 'dropdown' && def.options && def.options.length > 0;
                  return (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-36 shrink-0">
                        <input
                          type="text"
                          placeholder="name"
                          value={p.name}
                          onChange={(e) => setParam(i, 'name', e.target.value)}
                          readOnly={isDeclared}
                          className={`w-full rounded-md border px-2 py-1.5 text-sm ${isDeclared ? 'border-blue-200 bg-blue-50 text-blue-800 font-medium' : 'border-gray-300'}`}
                          title={def?.label || p.name}
                        />
                        {def?.label && (
                          <div className="mt-0.5 px-1 text-[12px] text-gray-500 truncate" title={def.label}>{def.label}{def.required && <span className="text-rose-600"> *</span>}</div>
                        )}
                      </div>
                      {isDropdown ? (
                        <select
                          value={p.value}
                          onChange={(e) => setParam(i, 'value', e.target.value)}
                          className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                        >
                          <option value="">{def!.required ? '— Select —' : '— None —'}</option>
                          {def!.options!.map(o => (
                            <option key={o.value} value={o.value}>{o.label || o.value}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
                          placeholder={def?.description || 'value (supports {{year}}, {{year+543}}, ...)'}
                          value={p.value}
                          onChange={(e) => setParam(i, 'value', e.target.value)}
                          className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 font-mono text-sm"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeParam(i)}
                        disabled={isDeclared && def?.required}
                        title={isDeclared && def?.required ? 'Required variable cannot be removed' : 'Remove'}
                        className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-2 flex items-start gap-1.5 rounded-md bg-blue-50 px-2.5 py-2 text-xs text-blue-800">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div>
                <strong>Template tokens:</strong>{' '}
                {TEMPLATE_HINTS.map((h, i) => (
                  <span key={h.token}>
                    <code className="rounded bg-white/60 px-1 font-mono">{h.token}</code>
                    {i < TEMPLATE_HINTS.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Enabled toggle */}
          <div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => update('enabled', e.target.checked)}
                className="h-4 w-4 rounded text-blue-600"
              />
              <span className="text-sm text-gray-700">Enabled (start running immediately)</span>
            </label>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 h-9 text-[14px] font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-lg px-3 h-9 text-[14px] font-medium disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
          >
            {saving ? 'Saving…' : mode === 'edit' ? 'Save Changes' : 'Create Scheduler'}
          </button>
        </div>
      </div>
    </div>
  );
}
