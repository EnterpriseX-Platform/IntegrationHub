import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, Users, X } from 'lucide-react';

export interface PickOption {
  /** Unique key, e.g. "u:<id>" or "g:<id>". */
  key: string;
  label: string;
  sub?: string;
  kind: 'user' | 'group';
  note?: string;
}

function initials(text: string): string {
  return text.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase() || '?';
}

export function Avatar({ text, kind = 'user', size = 'md' }: { text: string; kind?: 'user' | 'group'; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-xs';
  return (
    <div className={`${box} flex-shrink-0 rounded-md bg-blue-50 text-blue-700 font-medium flex items-center justify-center`}>
      {kind === 'group' ? <Users className="w-3.5 h-3.5" /> : initials(text)}
    </div>
  );
}

interface Props {
  options: PickOption[];
  placeholder?: string;
  /** Called with the picked keys when the user confirms. */
  onAdd: (keys: string[]) => void | Promise<void>;
  addLabel?: string;
  emptyText?: string;
  /** Extra control shown next to the Add button, e.g. a role switch. */
  extra?: React.ReactNode;
}

/** Search-as-you-type picker for users and groups: pick one or more, then Add. */
export function PeoplePicker({ options, placeholder = 'Search people…', onAdd, addLabel = 'Add', emptyText = 'No one left to add', extra }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Drop picks that are no longer offered (e.g. after they were added)
  useEffect(() => { setPicked((p) => p.filter((k) => options.some((o) => o.key === k))); }, [options]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => !q || o.label.toLowerCase().includes(q) || (o.sub || '').toLowerCase().includes(q));
  }, [options, query]);

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const byKey = (key: string) => options.find((o) => o.key === key);

  const add = async () => {
    if (!picked.length) return;
    setBusy(true);
    try { await onAdd(picked); setPicked([]); setQuery(''); setOpen(false); } finally { setBusy(false); }
  };

  return (
    <div ref={boxRef} className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="relative flex-1 min-w-0">
          <div
            className={`flex flex-wrap items-center gap-1 min-h-[36px] pl-8 pr-2 py-1 bg-white border rounded-lg cursor-text ${open ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-gray-200'}`}
            onClick={() => setOpen(true)}
          >
            <Search className="absolute left-2.5 top-[11px] w-3.5 h-3.5 text-gray-400" />
            {picked.map((k) => {
              const o = byKey(k);
              if (!o) return null;
              return (
                <span key={k} className="inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs">
                  <Avatar text={o.label} kind={o.kind} size="sm" />
                  <span className="max-w-[140px] truncate">{o.label}</span>
                  <button onClick={(e) => { e.stopPropagation(); toggle(k); }} className="hover:text-blue-900"><X className="w-3 h-3" /></button>
                </span>
              );
            })}
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && shown[0]) { e.preventDefault(); toggle(shown[0].key); setQuery(''); }
                if (e.key === 'Backspace' && !query && picked.length) setPicked((p) => p.slice(0, -1));
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder={picked.length ? '' : placeholder}
              className="flex-1 min-w-[120px] py-1 text-sm outline-none bg-transparent placeholder-gray-400"
            />
          </div>

          {open && (
            <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
              {shown.length === 0 ? (
                <div className="px-3 py-3 text-sm text-gray-500">{options.length ? 'No matches' : emptyText}</div>
              ) : (
                shown.map((o) => {
                  const on = picked.includes(o.key);
                  return (
                    <button
                      key={o.key}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggle(o.key)}
                      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-gray-50 ${on ? 'bg-blue-50/60' : ''}`}
                    >
                      <Avatar text={o.label} kind={o.kind} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900 truncate">{o.label}</div>
                        {(o.sub || o.note) && (
                          <div className="text-xs text-gray-500 truncate">{[o.sub, o.note].filter(Boolean).join(' · ')}</div>
                        )}
                      </div>
                      {on && <Check className="w-4 h-4 text-blue-600 flex-shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        {extra}
        <button
          onClick={add}
          disabled={!picked.length || busy}
          className="h-9 px-3.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 whitespace-nowrap"
        >
          {addLabel}{picked.length > 1 ? ` ${picked.length}` : ''}
        </button>
      </div>
    </div>
  );
}

/** Compact segmented control, used for roles. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex h-9 p-0.5 rounded-lg bg-gray-100 flex-shrink-0">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-2.5 rounded-md text-xs font-medium transition-colors ${value === o.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
