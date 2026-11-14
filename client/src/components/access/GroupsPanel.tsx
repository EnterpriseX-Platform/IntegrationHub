import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Search, X, Loader2, Users, ChevronRight, ChevronDown, Folder, Table2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { API_URL, apiFetch } from '../../config/api';
import { Avatar, PeoplePicker, Segmented } from './PeoplePicker';

interface GroupUser { id: string; email: string; name: string | null; status: string; role?: string }
interface Group {
  id: string;
  name: string;
  description: string | null;
  members: { id: string; user: GroupUser }[];
  projectGrants: Grant[];
  tableGrants: Grant[];
  folderGrants: Grant[];
  _count: { projectGrants: number; tableGrants: number; folderGrants: number };
}
type Role = 'viewer' | 'editor' | 'owner';
type Kind = 'project' | 'table' | 'folder';
interface Target { id: string; name: string; projectGroup?: string | null; description?: string | null; folderId?: string | null }
interface RepoFolderT { id: string; name: string; parentId: string | null }
interface Grant { id: string; role: Role; project?: Target; table?: Target; folder?: Target }
interface Targets { projects: Target[]; tables: Target[]; repoFolders: RepoFolderT[]; folders: Target[] }

const th = 'px-3 py-2 text-left text-[12px] font-medium text-gray-500 uppercase tracking-wider';

/** Settings → Groups: user groups that projects and repository tables can be shared with. */
export function GroupsPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<GroupUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [targets, setTargets] = useState<Targets>({ projects: [], tables: [], repoFolders: [], folders: [] });

  const load = async () => {
    try {
      const [g, u, t] = await Promise.all([
        fetch(`${API_URL}/admin/groups`).then((r) => r.json()),
        fetch(`${API_URL}/admin/users`).then((r) => r.json()),
        fetch(`${API_URL}/admin/grant-targets`).then((r) => r.json()),
      ]);
      if (t.success) setTargets(t.data);
      if (!g.success) throw new Error(g.error || 'Could not load groups');
      setGroups(g.data);
      setUsers((u.data || []) as GroupUser[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load groups');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const call = async (url: string, method: string, body?: unknown) => {
    const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) { setError(j.error || `Request failed (${r.status})`); return null; }
    await load();
    return j;
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => !q || g.name.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q));
  }, [groups, query]);

  const open = groups.find((g) => g.id === openId) || null;

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" />Loading groups…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search groups..."
            className="w-full pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
        <Button onClick={() => setCreating(true)} size="md" leftIcon={<Plus className="h-3.5 w-3.5" />} className="whitespace-nowrap">New Group</Button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-center gap-2 text-sm text-red-700">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className={th}>Group</th>
                <th className={th}>Members</th>
                <th className={`${th} hidden sm:table-cell`}>Projects</th>
                <th className={`${th} hidden sm:table-cell`}>Tables</th>
                <th className={`${th} hidden md:table-cell`}>Folders</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {shown.map((g) => (
                <tr key={g.id} onClick={() => setOpenId(g.id)} className="hover:bg-gray-50 transition-colors cursor-pointer">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar text={g.name} kind="group" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{g.name}</div>
                        {g.description && <div className="text-xs text-gray-500 truncate">{g.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {g.members.length === 0 ? (
                      <span className="text-xs text-gray-400">No members</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex -space-x-1.5">
                          {g.members.slice(0, 4).map((m) => (
                            <div key={m.id} className="ring-2 ring-white rounded-md"><Avatar text={m.user.name || m.user.email} size="sm" /></div>
                          ))}
                        </div>
                        <span className="text-xs text-gray-600">{g.members.length}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 hidden sm:table-cell">{g._count.projectGrants}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 hidden sm:table-cell">{g._count.tableGrants}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600 hidden md:table-cell">{g._count.folderGrants}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <ChevronRight className="w-4 h-4 text-gray-400 inline" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && (
          <div className="text-center py-10 px-4">
            <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">{query ? 'No groups match your search' : 'No groups yet — create one, add people, then share projects or tables with it'}</p>
          </div>
        )}
      </div>

      {open && <GroupPanel group={open} users={users} targets={targets} onClose={() => setOpenId(null)} call={call} />}
      {creating && (
        <GroupPanel
          group={null}
          users={users}
          targets={targets}
          onClose={() => setCreating(false)}
          call={call}
          onCreated={(id) => { setCreating(false); setOpenId(id); }}
        />
      )}
    </div>
  );
}

interface PanelProps {
  group: Group | null;
  users: GroupUser[];
  targets: Targets;
  onClose: () => void;
  call: (url: string, method: string, body?: unknown) => Promise<{ data?: { id: string } } | null>;
  onCreated?: (id: string) => void;
}

type Tab = 'members' | 'projects' | 'tables' | 'folders';
const roleLabel = (r: Role) => r[0].toUpperCase() + r.slice(1);

/**
 * Slide-over on the right for one group (or a new one): the name on top, then
 * tabs for members and for what the group can see. Rendered into <body> so it
 * covers the app header too.
 */
function GroupPanel({ group, users, targets, onClose, call, onCreated }: PanelProps) {
  const [name, setName] = useState(group?.name || '');
  const [desc, setDesc] = useState(group?.description || '');
  const [tab, setTab] = useState<Tab>('members');
  useEffect(() => { setName(group?.name || ''); setDesc(group?.description || ''); }, [group?.id, group?.name, group?.description]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const dirty = group ? name.trim() !== group.name || (desc.trim() || null) !== (group.description || null) : !!name.trim();

  const save = async () => {
    if (!name.trim()) return;
    if (group) await call(`${API_URL}/admin/groups/${group.id}`, 'PUT', { name, description: desc });
    else {
      const j = await call(`${API_URL}/admin/groups`, 'POST', { name, description: desc });
      if (j?.data?.id) onCreated?.(j.data.id);
    }
  };

  const remove = async () => {
    if (!group) return;
    const grants = group._count.projectGrants + group._count.tableGrants + group._count.folderGrants;
    const msg = grants ? `Delete group "${group.name}"? The ${grants} access grant(s) it has are removed too.` : `Delete group "${group.name}"?`;
    if (window.confirm(msg) && (await call(`${API_URL}/admin/groups/${group.id}`, 'DELETE'))) onClose();
  };

  const tabs: { id: Tab; label: string; count: number }[] = group ? [
    { id: 'members', label: 'Members', count: group.members.length },
    { id: 'projects', label: 'Projects', count: group.projectGrants.length },
    { id: 'tables', label: 'Tables', count: group.tableGrants.length },
    { id: 'folders', label: 'Folders', count: group.folderGrants.length },
  ] : [];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-gray-900/30" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-white shadow-xl flex flex-col">
        {/* Name and description */}
        <div className="px-5 pt-4 pb-3 border-b border-gray-200 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0 space-y-1">
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!group} placeholder="Group name"
                className="w-full -ml-2 px-2 py-1 text-base font-semibold text-gray-900 rounded-md border border-transparent hover:border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none" />
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Add a description"
                className="w-full -ml-2 px-2 py-0.5 text-sm text-gray-500 rounded-md border border-transparent hover:border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none" />
            </div>
            <button onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"><X className="w-4 h-4" /></button>
          </div>
          {dirty && (
            <div className="flex justify-end gap-2">
              {group && <Button size="sm" variant="secondary" onClick={() => { setName(group.name); setDesc(group.description || ''); }}>Cancel</Button>}
              <Button size="sm" onClick={save} disabled={!name.trim()}>{group ? 'Save' : 'Create group'}</Button>
            </div>
          )}
        </div>

        {group && (
          <nav className="flex gap-5 px-5 border-b border-gray-200">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`py-2.5 -mb-px border-b-2 text-sm font-medium whitespace-nowrap ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                {t.label} <span className={`ml-1 text-xs ${tab === t.id ? 'text-blue-500' : 'text-gray-400'}`}>{t.count}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!group && <p className="text-sm text-gray-500">Name the group, then add members and choose what it can see.</p>}
          {group && tab === 'members' && <MembersTab group={group} users={users} call={call} />}
          {group && tab === 'projects' && (
            <GrantTab kind="project" roles={['viewer', 'editor', 'owner']} group={group} call={call}
              grants={group.projectGrants} pick={(g) => g.project}
              help="Members see these projects with their flows, runs, connections, schedulers and baskets.">
              {(_role, have, add) => (
                <PeoplePicker
                  options={targets.projects.filter((t) => !have.has(t.id)).map((t) => ({ key: t.id, label: t.name, sub: t.projectGroup || undefined, kind: 'user' as const }))}
                  placeholder="Search projects…" emptyText="Every project is already shared" addLabel="Add" onAdd={add}
                />
              )}
            </GrantTab>
          )}
          {group && tab === 'tables' && (
            <GrantTab kind="table" roles={['viewer', 'editor']} group={group} call={call}
              grants={group.tableGrants} pick={(g) => g.table}
              subOf={(t) => {
                const full = targets.tables.find((x) => x.id === t?.id);
                const path: string[] = [];
                for (let f = targets.repoFolders.find((x) => x.id === full?.folderId); f; f = targets.repoFolders.find((x) => x.id === f!.parentId)) path.unshift(f.name);
                return path.length ? path.join(' / ') : 'No folder';
              }}
              help="Tick a folder to share every table in it, or open it and pick tables.">
              {(_role, have, add) => <TableTree folders={targets.repoFolders} tables={targets.tables} have={have} onAdd={add} />}
            </GrantTab>
          )}
          {group && tab === 'folders' && (
            <GrantTab kind="folder" roles={['viewer', 'editor']} group={group} call={call}
              grants={group.folderGrants} pick={(g) => g.folder}
              help="Top-level File Explorer folders; everything inside comes with them.">
              {(_role, have, add) => (
                <PeoplePicker
                  options={targets.folders.filter((t) => !have.has(t.id)).map((t) => ({ key: t.id, label: t.name, kind: 'user' as const }))}
                  placeholder="Search folders…" emptyText={targets.folders.length ? 'Every folder is already shared' : 'No folders in File Explorer yet'} addLabel="Add" onAdd={add}
                />
              )}
            </GrantTab>
          )}
        </div>

        {group && (
          <div className="px-5 py-3 border-t border-gray-200">
            <button onClick={remove} className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700">
              <Trash2 className="w-4 h-4" />Delete group
            </button>
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function MembersTab({ group, users, call }: { group: Group; users: GroupUser[]; call: PanelProps['call'] }) {
  const options = users
    .filter((u) => !group.members.some((m) => m.user.id === u.id))
    .map((u) => ({
      key: u.id, label: u.name || u.email, sub: u.email, kind: 'user' as const,
      note: u.role === 'admin' ? 'admin — already sees everything' : u.status === 'inactive' ? 'inactive' : undefined,
    }));
  return (
    <div className="space-y-3">
      <PeoplePicker options={options} placeholder="Search by name or email…" emptyText="Everyone is already in this group"
        onAdd={async (keys) => { await call(`${API_URL}/admin/groups/${group.id}/members`, 'POST', { userIds: keys }); }} />
      {group.members.length === 0 ? (
        <Empty text="No members yet" />
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
          {group.members.map((m) => (
            <Row key={m.id} title={m.user.name || m.user.email} sub={m.user.email}
              onRemove={() => call(`${API_URL}/admin/groups/${group.id}/members/${m.user.id}`, 'DELETE')} removeTitle="Remove from group" />
          ))}
        </ul>
      )}
    </div>
  );
}

interface GrantTabProps {
  kind: Kind;
  roles: Role[];
  group: Group;
  call: PanelProps['call'];
  grants: Grant[];
  pick: (g: Grant) => Target | undefined;
  help: string;
  /** Second line under each shared item, e.g. its folder. */
  subOf?: (t: Target | undefined) => string | undefined;
  /** The add control; gets the role chosen for new grants and the ids already shared. */
  children: (role: Role, have: Set<string>, add: (ids: string[]) => Promise<void>) => React.ReactNode;
}

/** One kind of access: choose a role, add items, then change or remove each one. */
function GrantTab({ kind, roles, group, call, grants, pick, help, subOf, children }: GrantTabProps) {
  const [role, setRole] = useState<Role>('viewer');
  const base = `${API_URL}/admin/groups/${group.id}/grants`;
  const have = new Set(grants.map((g) => pick(g)?.id).filter(Boolean) as string[]);
  const roleOptions = roles.map((r) => ({ value: r, label: roleLabel(r) }));
  const add = async (ids: string[]) => { for (const id of ids) await call(base, 'POST', { kind, targetId: id, role }); };

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">{help}</p>
      <div className="flex items-center gap-2 text-xs text-gray-600">
        <span>New access as</span>
        <Segmented value={role} onChange={setRole} options={roleOptions} />
      </div>
      {children(role, have, add)}
      {grants.length === 0 ? (
        <Empty text="Nothing shared with this group yet" />
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
          {grants.map((g) => {
            const t = pick(g);
            return (
              <Row key={g.id} title={t?.name || '(deleted)'} sub={subOf?.(t)} removeTitle="Remove access"
                onRemove={() => call(`${base}/${kind}/${g.id}`, 'DELETE')}
                extra={<Segmented value={g.role} onChange={(r) => call(base, 'POST', { kind, targetId: t?.id, role: r })} options={roleOptions} />} />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ title, sub, extra, onRemove, removeTitle }: { title: string; sub?: string; extra?: React.ReactNode; onRemove: () => void; removeTitle: string }) {
  return (
    <li className="group/row flex items-center gap-2.5 px-3 py-2">
      <Avatar text={title} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-900 truncate">{title}</div>
        {sub && <div className="text-xs text-gray-500 truncate">{sub}</div>}
      </div>
      {extra}
      <button onClick={onRemove} title={removeTitle}
        className="p-1 rounded-md text-gray-300 hover:text-red-600 hover:bg-red-50 sm:opacity-0 sm:group-hover/row:opacity-100 transition-opacity">
        <X className="w-4 h-4" />
      </button>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-gray-500 py-4 text-center border border-dashed border-gray-200 rounded-lg">{text}</p>;
}

/** Repository tables as their folder tree with checkboxes; ticking a folder picks every table under it. */
function TableTree({ folders, tables, have, onAdd }: { folders: RepoFolderT[]; tables: Target[]; have: Set<string>; onAdd: (ids: string[]) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, RepoFolderT[]>();
    for (const f of folders) m.set(f.parentId, [...(m.get(f.parentId) || []), f]);
    return m;
  }, [folders]);
  const tablesIn = useMemo(() => {
    const m = new Map<string | null, Target[]>();
    for (const t of tables) {
      if (have.has(t.id)) continue;
      if (q && !t.name.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) continue;
      const k = t.folderId || null;
      m.set(k, [...(m.get(k) || []), t]);
    }
    return m;
  }, [tables, have, q]);
  // every table id under a folder (recursive), only those still offered
  const under = (fid: string): string[] => [
    ...(tablesIn.get(fid) || []).map((t) => t.id),
    ...(childrenOf.get(fid) || []).flatMap((c) => under(c.id)),
  ];

  const toggleIds = (ids: string[]) => setPicked((p) => {
    const n = new Set(p);
    const all = ids.every((id) => n.has(id));
    ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
    return n;
  });
  const add = async () => {
    setBusy(true);
    try { await onAdd([...picked]); setPicked(new Set()); } finally { setBusy(false); }
  };

  const renderFolder = (f: RepoFolderT, depth: number): React.ReactNode => {
    const ids = under(f.id);
    if (!ids.length) return null;
    const on = ids.filter((id) => picked.has(id)).length;
    const isOpen = open.has(f.id) || !!q;
    return (
      <div key={f.id}>
        <div className="flex items-center gap-1.5 py-1 pr-2 hover:bg-gray-50 rounded-md" style={{ paddingLeft: depth * 16 + 4 }}>
          <button onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}
            className="p-0.5 text-gray-400 hover:text-gray-600">
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <input type="checkbox" checked={on === ids.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < ids.length; }}
            onChange={() => toggleIds(ids)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
          <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span className="text-sm text-gray-800 truncate flex-1">{f.name}</span>
          <span className="text-xs text-gray-400">{ids.length}</span>
        </div>
        {isOpen && (
          <>
            {(childrenOf.get(f.id) || []).map((c) => renderFolder(c, depth + 1))}
            {(tablesIn.get(f.id) || []).map((t) => renderTable(t, depth + 1))}
          </>
        )}
      </div>
    );
  };
  const renderTable = (t: Target, depth: number) => (
    <label key={t.id} className="flex items-center gap-1.5 py-1 pr-2 hover:bg-gray-50 rounded-md cursor-pointer" style={{ paddingLeft: depth * 16 + 24 }}>
      <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggleIds([t.id])} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
      <Table2 className="w-4 h-4 text-teal-500 flex-shrink-0" />
      <span className="text-sm text-gray-800 truncate">{t.name}</span>
      {t.description && <span className="text-xs text-gray-400 truncate">· {t.description}</span>}
    </label>
  );

  const roots = childrenOf.get(null) || [];
  const loose = tablesIn.get(null) || [];
  const nothing = roots.every((f) => !under(f.id).length) && !loose.length;

  return (
    <div className="border border-gray-200 rounded-lg">
      <div className="flex items-center gap-2 p-2 border-b border-gray-100">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tables…"
            className="w-full pl-8 pr-2 py-1.5 text-sm bg-white border border-gray-200 rounded-md focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none" />
        </div>
        <button onClick={add} disabled={!picked.size || busy}
          className="h-8 px-3 rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 whitespace-nowrap">
          Add{picked.size ? ` ${picked.size}` : ''}
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {nothing ? (
          <p className="text-sm text-gray-500 py-4 text-center">{q ? 'No tables match' : 'Every table is already shared'}</p>
        ) : (
          <>
            {roots.map((f) => renderFolder(f, 0))}
            {loose.map((t) => renderTable(t, 0))}
          </>
        )}
      </div>
    </div>
  );
}
