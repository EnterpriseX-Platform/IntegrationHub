// Operator dashboard sidebar — Project navigation
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SidebarProject {
  id: string;
  name: string;
  color?: string;
  status?: string;
  projectGroup?: string | null;
  agency?: string | null;
  groupPosition?: number;
  agencyPosition?: number;
  position?: number;
  count?: number;
  activeCount?: number;
}

export interface SidebarFilter {
  scope: string;
  label: string;
}

interface Props {
  projects: SidebarProject[];
  selected: string;
  onSelect: (filter: SidebarFilter) => void;
  itemLabel?: string;
  totalCount?: number;
  totalActive?: number;
}

const COLOR: Record<string, { mark: string; text: string; tint: string }> = {
  blue:   { mark: 'bg-blue-500',   text: 'text-blue-600',   tint: 'bg-blue-50/60' },
  purple: { mark: 'bg-purple-500', text: 'text-purple-600', tint: 'bg-purple-50/60' },
  green:  { mark: 'bg-green-500',  text: 'text-green-600',  tint: 'bg-green-50/60' },
  orange: { mark: 'bg-orange-500', text: 'text-orange-600', tint: 'bg-orange-50/60' },
  pink:   { mark: 'bg-pink-500',   text: 'text-pink-600',   tint: 'bg-pink-50/60' },
  cyan:   { mark: 'bg-cyan-500',   text: 'text-cyan-600',   tint: 'bg-cyan-50/60' },
  indigo: { mark: 'bg-indigo-500', text: 'text-indigo-600', tint: 'bg-indigo-50/60' },
  amber:  { mark: 'bg-amber-500',  text: 'text-amber-600',  tint: 'bg-amber-50/60' },
  red:    { mark: 'bg-red-500',    text: 'text-red-600',    tint: 'bg-red-50/60' },
  teal:   { mark: 'bg-teal-500',   text: 'text-teal-600',   tint: 'bg-teal-50/60' },
};
const c = (x?: string) => COLOR[x || 'blue'] || COLOR.blue;

interface AgencyGroup { name: string; position: number; projects: SidebarProject[] }
interface ProjectGroup { name: string; position: number; agencies: Map<string, AgencyGroup> }

export default function ProjectTreeSidebar({
  projects, selected, onSelect, itemLabel = 'items', totalCount,
}: Props) {
  const [query, setQuery] = useState('');

  const tree = useMemo(() => {
    const groups = new Map<string, ProjectGroup>();
    const q = query.trim().toLowerCase();
    for (const p of projects) {
      if (q) {
        const matchProj = p.name.toLowerCase().includes(q);
        const matchGroup = (p.projectGroup || '').toLowerCase().includes(q);
        const matchAgency = (p.agency || '').toLowerCase().includes(q);
        if (!matchProj && !matchGroup && !matchAgency) continue;
      }
      const groupName = p.projectGroup || 'Uncategorized';
      if (!groups.has(groupName)) {
        groups.set(groupName, { name: groupName, position: p.groupPosition ?? 999, agencies: new Map() });
      }
      const group = groups.get(groupName)!;
      const agencyName = p.agency || '—';
      if (!group.agencies.has(agencyName)) {
        group.agencies.set(agencyName, { name: agencyName, position: p.agencyPosition ?? 999, projects: [] });
      }
      group.agencies.get(agencyName)!.projects.push(p);
    }
    const sortedGroups = Array.from(groups.values()).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const g of sortedGroups) {
      const sorted = Array.from(g.agencies.values()).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      for (const a of sorted) {
        a.projects.sort((x, y) => (x.position ?? 999) - (y.position ?? 999) || x.name.localeCompare(y.name));
      }
      g.agencies = new Map(sorted.map(a => [a.name, a]));
    }
    return sortedGroups;
  }, [projects, query]);

  const panel = (
    <>
      {/* Search */}
      <div className="px-5 pt-5 pb-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a project"
            className="w-full bg-transparent border-0 border-b border-slate-200 pl-6 pr-6 py-2 text-[14px] placeholder:text-slate-400 focus:border-slate-900 focus:outline-none transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-0 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tree */}
      <div
        className="flex-1 overflow-y-auto pb-6 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {/* All projects — quiet entry */}
        <button
          type="button"
          onClick={() => onSelect({ scope: 'all', label: 'All Projects' })}
          className={`flex w-full items-baseline justify-between px-5 py-2 text-[14px] transition-colors ${
            selected === 'all'
              ? 'text-slate-900 font-semibold'
              : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          <span>All projects</span>
          <span className="text-[11.5px] tabular-nums opacity-60">{projects.length}</span>
        </button>

        {tree.length === 0 && (
          <p className="px-5 py-8 text-center text-xs text-slate-400">
            {query ? `No matches for "${query}"` : 'No projects'}
          </p>
        )}

        {/* Flat project list — sorted by group → agency → project position */}
        <div className="mt-2">
          {tree.flatMap(group =>
            Array.from(group.agencies.values()).flatMap(agency =>
              agency.projects.map(p => {
                const projKey = `project:${p.id}`;
                const isSelected = selected === projKey;
                const isActive = (p.activeCount || 0) > 0;
                const co = c(p.color);

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelect({ scope: projKey, label: p.name })}
                    className={`group/p relative flex w-full items-center gap-3 pl-5 pr-5 py-2 text-left transition-colors ${
                      isSelected ? co.tint : 'hover:bg-slate-50/70'
                    }`}
                  >
                    <span className="relative shrink-0">
                      <span className={`block h-2.5 w-2.5 rounded-full ${co.mark}`} />
                      {isActive && (
                        <span className={`absolute -inset-1 rounded-full ${co.mark} opacity-20 blur-[2px]`} />
                      )}
                    </span>
                    <span className={`flex-1 truncate text-[14px] tracking-tight ${
                      isSelected
                        ? 'font-semibold text-slate-900'
                        : isActive
                          ? 'font-medium text-slate-900'
                          : 'text-slate-700'
                    }`}>
                      {p.name}
                    </span>
                    {(p.count || 0) > 0 && (
                      <span className={`shrink-0 text-[11.5px] tabular-nums ${
                        isActive ? co.text + ' font-medium' : 'text-slate-300'
                      }`}>
                        {isActive ? `${p.activeCount}` : p.count}
                      </span>
                    )}
                  </button>
                );
              })
            )
          )}
        </div>
      </div>

      {/* Footer */}
      {totalCount !== undefined && (
        <div className="px-5 py-3 border-t border-slate-100 text-[11.5px] text-slate-400">
          {totalCount} {itemLabel}
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Phones: a dropdown of the same projects, grouped like the tree */}
      <div className="md:hidden shrink-0 px-4 py-2 bg-white border-b border-slate-200/70">
        <MobileProjectPicker
          tree={tree}
          projects={projects}
          selected={selected}
          totalCount={totalCount}
          onSelect={onSelect}
        />
      </div>

      <aside className="hidden md:flex w-72 shrink-0 border-r border-slate-200/70 bg-white flex-col h-full">
        {panel}
      </aside>
    </>
  );
}

function MobileProjectPicker({ tree, projects, selected, totalCount, onSelect }: {
  tree: ProjectGroup[];
  projects: SidebarProject[];
  selected: string;
  totalCount?: number;
  onSelect: (filter: SidebarFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const current = projects.find((p) => `project:${p.id}` === selected);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (f: SidebarFilter) => { onSelect(f); setOpen(false); setQ(''); };
  const needle = q.trim().toLowerCase();
  const groups = tree
    .map((g) => ({
      name: g.name,
      items: Array.from(g.agencies.values()).flatMap((a) => a.projects)
        .filter((p) => !needle || p.name.toLowerCase().includes(needle)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full h-10 flex items-center gap-2.5 px-3 rounded-lg border bg-white text-left transition-colors ${
          open ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'
        }`}
      >
        {current
          ? <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c(current.color).mark}`} />
          : <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-slate-300" />}
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-900">
          {current ? current.name : 'All Projects'}
        </span>
        <span className="text-xs tabular-nums text-slate-400">{current ? current.count ?? '' : totalCount ?? ''}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-40 rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a project"
                className="w-full h-9 pl-8 pr-8 rounded-lg bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:bg-white focus:ring-1 focus:ring-blue-200"
              />
              {q && (
                <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto py-1 overscroll-contain">
            {!needle && (
              <PickerRow
                label="All Projects"
                count={totalCount}
                active={selected === 'all'}
                onClick={() => pick({ scope: 'all', label: 'All Projects' })}
              />
            )}
            {groups.map((g) => (
              <div key={g.name}>
                <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.name}</div>
                {g.items.map((p) => (
                  <PickerRow
                    key={p.id}
                    label={p.name}
                    count={p.count}
                    dot={c(p.color).mark}
                    active={selected === `project:${p.id}`}
                    onClick={() => pick({ scope: `project:${p.id}`, label: p.name })}
                  />
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-slate-400">No project matches “{q}”</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PickerRow({ label, count, dot, active, onClick }: {
  label: string; count?: number; dot?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-sm ${
        active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 active:bg-slate-50'
      }`}
    >
      {dot ? <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} /> : <span className="h-2 w-2 shrink-0" />}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {count !== undefined && (
        <span className={`min-w-[1.5rem] px-1.5 rounded-full text-center text-[11px] tabular-nums ${active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
          {count}
        </span>
      )}
      <Check className={`h-4 w-4 shrink-0 ${active ? 'text-blue-600' : 'invisible'}`} />
    </button>
  );
}
