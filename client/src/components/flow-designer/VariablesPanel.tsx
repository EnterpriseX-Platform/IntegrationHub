// VariablesPanel — manage flow.config.variables (used by Scheduler + Run Task)
import { useEffect, useState } from 'react';
import { Plus, Trash2, Save, Loader2, ChevronDown, Info, X, Edit3 } from 'lucide-react';
import { API_URL } from '../../config/api';

export interface FlowVariable {
  name: string;
  type: 'text' | 'number' | 'date' | 'dropdown';
  label?: string;
  description?: string;
  required?: boolean;
  default?: string;
  options?: { value: string; label?: string }[];
}

interface Props {
  flowId: string;
  /** Optional: callback after save */
  onSaved?: (vars: FlowVariable[]) => void;
}

const TYPE_OPTIONS = [
  { value: 'text',     label: 'Text',     desc: 'Plain string input' },
  { value: 'number',   label: 'Number',   desc: 'Numeric input' },
  { value: 'date',     label: 'Date',     desc: 'Date picker (YYYY-MM-DD)' },
  { value: 'dropdown', label: 'Dropdown', desc: 'Pick from a list' },
] as const;

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export default function VariablesPanel({ flowId, onSaved }: Props) {
  const [vars, setVars] = useState<FlowVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);

  // Detected tokens from flow nodes (vars referenced in SQL/filename/etc.)
  const [detected, setDetected] = useState<string[]>([]);
  // Snapshot of currently-saved variables (for dirty-check)
  const [snapshot, setSnapshot] = useState<string>('[]');

  useEffect(() => {
    if (!flowId) return;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API_URL}/flows/${flowId}`);
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Failed to load flow');
        const flow = d.data;
        let cfg: any = {};
        try {
          cfg = typeof flow.config === 'string' ? JSON.parse(flow.config || '{}') : (flow.config || {});
        } catch {}
        const declared: FlowVariable[] = Array.isArray(cfg.variables) ? cfg.variables : [];
        setVars(declared);
        setSnapshot(JSON.stringify(declared));

        // Detect {{var}} tokens from node configs
        try {
          const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes || '[]') : (flow.nodes || []);
          const RESERVED = new Set([
            // Engine namespaces / system tokens
            'trigger', 'vars', 'input', 'body', 'path', 'query', 'header',
            'extension', 'timestamp', 'datetime',
            // FileWriteExecutor / SFTPActionExecutor filename placeholders — auto-resolved
            // at runtime (FileWriteExecutor.ts:150-166, SFTPActionExecutor.ts:23-35).
            // Users never need to declare these as parameters.
            'YYYYMMDD', 'HHmm', 'HHmmss', 'time',
            'YYYY', 'YY', 'MM', 'DD', 'HH', 'mm', 'ss',
            'BYYYY', 'BYY', 'buddhistYear',
            // Derived tokens (computed from year/date — user declares year, engine computes these)
            'date', 'date+1', 'year+543', 'year-1',
            // Runtime variables set by upstream nodes (for-each, file-read, etc.)
            'currentFile', 'currentItem', 'item', 'fileName', 'index',
            'triggeredAt', 'triggeredDate',
            // NOTE: year/month/day are NOT reserved — user often passes FY year explicitly,
            //       so we want them to show up in detection as "declare-able"
          ]);
          const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
          const found = new Set<string>();
          const walk = (v: any) => {
            if (typeof v === 'string') {
              let m;
              while ((m = re.exec(v))) found.add(m[1]);
            } else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
          };
          walk(nodes);
          setDetected([...found].filter(n => !RESERVED.has(n)));
        } catch {}
      } catch (e: any) {
        setMsg({ kind: 'err', text: e.message || 'Failed to load' });
      } finally {
        setLoading(false);
      }
    })();
  }, [flowId]);

  const dirty = JSON.stringify(vars) !== snapshot;

  const addVar = (preset?: Partial<FlowVariable>) => {
    setVars(vs => [
      ...vs,
      { name: preset?.name || '', type: preset?.type || 'text', label: preset?.label || '', required: false, ...preset },
    ]);
    setEditIdx(vars.length);
  };

  const removeVar = (idx: number) => {
    setVars(vs => vs.filter((_, i) => i !== idx));
    setEditIdx(null);
  };

  const updateVar = (idx: number, patch: Partial<FlowVariable>) => {
    setVars(vs => vs.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const save = async () => {
    // Validate
    const seen = new Set<string>();
    for (const v of vars) {
      if (!v.name?.trim()) { setMsg({ kind: 'err', text: 'Variable name cannot be empty' }); return; }
      if (!NAME_RE.test(v.name)) { setMsg({ kind: 'err', text: `Invalid name "${v.name}" — use letters/digits/underscore, must start with a letter` }); return; }
      if (seen.has(v.name)) { setMsg({ kind: 'err', text: `Duplicate variable name: ${v.name}` }); return; }
      seen.add(v.name);
      if (v.type === 'dropdown' && (!v.options || v.options.length === 0)) {
        setMsg({ kind: 'err', text: `Dropdown variable "${v.name}" needs at least 1 option` });
        return;
      }
    }

    setSaving(true); setMsg(null);
    try {
      // Fetch current flow to merge
      const rg = await fetch(`${API_URL}/flows/${flowId}`);
      const dg = await rg.json();
      if (!dg.success) throw new Error('Failed to load flow');
      const flow = dg.data;
      let cfg: any = {};
      try { cfg = typeof flow.config === 'string' ? JSON.parse(flow.config || '{}') : (flow.config || {}); } catch {}
      cfg.variables = vars;

      // Build update payload (preserve everything else)
      const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes || '[]') : (flow.nodes || []);
      const edges = typeof flow.connections === 'string' ? JSON.parse(flow.connections || '[]') : (flow.connections || []);
      const body = {
        name: flow.name,
        description: flow.description,
        type: flow.type,
        nodes, connections: edges, config: cfg,
        process: flow.process, tags: flow.tags,
      };
      const r = await fetch(`${API_URL}/flows/${flowId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'PUT' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Save failed');

      setSnapshot(JSON.stringify(vars));
      setMsg({ kind: 'ok', text: 'Variables saved' });
      onSaved?.(vars);
      setTimeout(() => setMsg(null), 3000);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  // Variables referenced in flow but NOT yet declared
  const undeclared = detected.filter(d => !vars.find(v => v.name === d));

  if (loading) {
    return (
      <div className="bg-white rounded-xl border p-6">
        <div className="flex items-center gap-2 text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading variables…
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border p-6">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-medium text-gray-900">Variables</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Parameters this flow accepts at runtime. Reference them as <code className="rounded bg-gray-100 px-1 font-mono text-[10.5px]">{'{{name}}'}</code> in SQL, file names, and session patterns.
            Shown in Scheduler &amp; Run Task forms.
          </p>
        </div>
        <button
          onClick={() => addVar()}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 text-white px-2.5 h-8 text-[13px] font-medium hover:bg-blue-700 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" /> Add Variable
        </button>
      </div>

      {/* Undeclared tokens suggestion */}
      {undeclared.length > 0 && (
        <div className="mt-3 rounded-md bg-amber-50 ring-1 ring-inset ring-amber-200/60 px-3 py-2 text-xs">
          <div className="flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-amber-800">Detected in flow but not declared:</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {undeclared.map(n => (
                  <button
                    key={n}
                    onClick={() => addVar({ name: n })}
                    className="inline-flex items-center gap-1 rounded bg-white ring-1 ring-amber-200 px-1.5 py-0.5 text-[10.5px] font-mono text-amber-900 hover:bg-amber-100"
                    title={`Add variable "${n}"`}
                  >
                    <Plus className="h-2.5 w-2.5" /> {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Variable list */}
      {vars.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          No variables yet. Click <span className="font-medium text-gray-700">Add Variable</span> to define one.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {vars.map((v, idx) => (
            <VarRow
              key={idx}
              v={v}
              editing={editIdx === idx}
              onEdit={() => setEditIdx(editIdx === idx ? null : idx)}
              onChange={patch => updateVar(idx, patch)}
              onRemove={() => removeVar(idx)}
            />
          ))}
        </div>
      )}

      {/* Save bar */}
      <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
        {msg ? (
          <div className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-700'}`}>{msg.text}</div>
        ) : (
          <div className="text-xs text-gray-400">{dirty ? 'Unsaved changes' : 'Up to date'}</div>
        )}
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="inline-flex items-center gap-1.5 rounded-lg disabled:cursor-not-allowed px-3 h-9 text-[14px] font-medium transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving…' : 'Save Variables'}
        </button>
      </div>
    </div>
  );
}

// ─── Single variable row ──────────────────────────────────────────────────
function VarRow({ v, editing, onEdit, onChange, onRemove }: {
  v: FlowVariable;
  editing: boolean;
  onEdit: () => void;
  onChange: (p: Partial<FlowVariable>) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`rounded-md border ${editing ? 'border-blue-300 bg-blue-50/30' : 'border-gray-200 bg-white'} px-3 py-2`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-700">{`{{${v.name || '?'}}}`}</code>
        {v.label && <span className="text-sm text-gray-700">{v.label}</span>}
        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[12px] font-medium text-gray-600">
          {v.type === 'dropdown' && <ChevronDown className="h-2.5 w-2.5" />}
          {v.type}
        </span>
        {v.required && <span className="rounded bg-rose-50 ring-1 ring-rose-200/60 px-1.5 py-0.5 text-[12px] font-medium text-rose-700">required</span>}
        {v.default && <span className="text-[10.5px] text-gray-500">default: <code className="rounded bg-gray-50 px-1 font-mono">{v.default}</code></span>}
        {v.type === 'dropdown' && v.options && (
          <span className="text-[10.5px] text-gray-500">{v.options.length} options</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={onEdit} className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-700" title={editing ? 'Collapse' : 'Edit'}>
            <Edit3 className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRemove} className="rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600" title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3">
          <div>
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">Name *</label>
            <input
              type="text"
              value={v.name}
              onChange={e => onChange({ name: e.target.value })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. year"
            />
          </div>
          <div>
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">Label</label>
            <input
              type="text"
              value={v.label || ''}
              onChange={e => onChange({ label: e.target.value })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. ปีงบประมาณ"
            />
          </div>
          <div>
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">Type</label>
            <select
              value={v.type}
              onChange={e => onChange({ type: e.target.value as any })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">
              Default Value
              {v.type === 'dropdown' && (!v.options || v.options.length === 0) && (
                <span className="ml-1 text-[12px] normal-case text-gray-400">(add options first)</span>
              )}
            </label>
            {v.type === 'dropdown' && v.options && v.options.length > 0 ? (
              <select
                value={v.default || ''}
                onChange={e => onChange({ default: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— no default —</option>
                {v.options.map(o => (
                  <option key={o.value} value={o.value}>{o.label || o.value}</option>
                ))}
              </select>
            ) : v.type === 'date' ? (
              <input
                type="date"
                value={v.default || ''}
                onChange={e => onChange({ default: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : v.type === 'number' ? (
              <input
                type="number"
                value={v.default || ''}
                onChange={e => onChange({ default: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="(optional)"
              />
            ) : (
              <input
                type="text"
                value={v.default || ''}
                onChange={e => onChange({ default: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="(optional) — supports {{year+543}}, {{date+1}}, etc."
              />
            )}
          </div>
          <div className="col-span-2">
            <label className="block text-[10.5px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">Description</label>
            <input
              type="text"
              value={v.description || ''}
              onChange={e => onChange({ description: e.target.value })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="(optional) hint shown under the field"
            />
          </div>
          <div className="col-span-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!v.required}
                onChange={e => onChange({ required: e.target.checked })}
                className="h-3.5 w-3.5 rounded text-blue-600"
              />
              <span className="text-xs text-gray-700">Required (user must provide a value)</span>
            </label>
          </div>

          {/* Dropdown options editor */}
          {v.type === 'dropdown' && (
            <div className="col-span-2">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[10.5px] uppercase tracking-wide text-gray-500 font-medium">Options *</label>
                <button
                  onClick={() => onChange({ options: [...(v.options || []), { value: '', label: '' }] })}
                  className="inline-flex items-center gap-0.5 text-[12px] text-blue-600 hover:text-blue-700"
                >
                  <Plus className="h-3 w-3" /> Add option
                </button>
              </div>
              {(v.options || []).length === 0 ? (
                <p className="rounded border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                  No options yet. Add at least one.
                </p>
              ) : (
                <div className="space-y-1">
                  {(v.options || []).map((o, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={o.value}
                        onChange={e => {
                          const opts = [...(v.options || [])];
                          opts[oi] = { ...opts[oi], value: e.target.value };
                          onChange({ options: opts });
                        }}
                        className="w-1/3 rounded border border-gray-300 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="value"
                      />
                      <input
                        type="text"
                        value={o.label || ''}
                        onChange={e => {
                          const opts = [...(v.options || [])];
                          opts[oi] = { ...opts[oi], label: e.target.value };
                          onChange({ options: opts });
                        }}
                        className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="label (shown in dropdown)"
                      />
                      <button
                        onClick={() => onChange({ options: (v.options || []).filter((_, i) => i !== oi) })}
                        className="rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
