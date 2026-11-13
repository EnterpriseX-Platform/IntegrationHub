import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { API_URL, apiFetch } from '../../config/api';
import { Avatar, PeoplePicker, Segmented } from './PeoplePicker';

type Role = 'viewer' | 'editor' | 'owner';
interface Principal { id: string; name: string | null; email?: string; _count?: { members: number } }
interface Grant { id: string; role: Role; user: Principal | null; group: Principal | null }

const ROLE_HELP: Record<Role, string> = {
  viewer: 'Can view',
  editor: 'Can view, change and run',
  owner: 'Can also manage access',
};

const roleLabel = (r: Role) => r[0].toUpperCase() + r.slice(1);

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 'project' or 'table' — picks the API and the roles on offer. */
  kind: 'project' | 'table';
  id: string;
  name: string;
  /** Read-only list for people who may see but not change access. */
  canManage: boolean;
}

/** Who can see a project or a repository table: individual users and user groups, each with a role. */
export function AccessModal({ isOpen, onClose, kind, id, name, canManage }: Props) {
  const base = kind === 'project' ? `${API_URL}/projects/${id}/members` : `${API_URL}/data-repository/tables/${id}/members`;
  const roles: Role[] = kind === 'project' ? ['viewer', 'editor', 'owner'] : ['viewer', 'editor'];

  const [grants, setGrants] = useState<Grant[]>([]);
  const [users, setUsers] = useState<Principal[]>([]);
  const [groups, setGroups] = useState<Principal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('viewer');

  const load = async () => {
    setLoading(true);
    try {
      if (kind === 'project') {
        const g = await fetch(base).then((r) => r.json());
        if (!g.success) throw new Error(g.error);
        setGrants(g.data);
        if (canManage) {
          const c = await fetch(`${base}/candidates`).then((r) => r.json());
          if (c.success) { setUsers(c.data.users); setGroups(c.data.groups); }
        }
      } else {
        const j = await fetch(base).then((r) => r.json());
        if (!j.success) throw new Error(j.error);
        setGrants(j.data.members); setUsers(j.data.users); setGroups(j.data.groups);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load access');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isOpen) load(); }, [isOpen, id]);

  const send = async (url: string, method: string, body?: unknown) => {
    const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) { setError(j.error || `Request failed (${r.status})`); return; }
    await load();
  };

  const add = async (keys: string[]) => {
    for (const k of keys) {
      const [type, pid] = k.split(':');
      await send(base, 'POST', type === 'g' ? { groupId: pid, role } : { userId: pid, role });
    }
  };

  const changeRole = (g: Grant, r: Role) =>
    send(base, 'POST', g.group ? { groupId: g.group.id, role: r } : { userId: g.user!.id, role: r });

  const granted = new Set(grants.map((g) => (g.group ? `g:${g.group.id}` : `u:${g.user?.id}`)));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Access — ${name}`} size="2xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Admins see every {kind}. Other users see this {kind} only if it is shared with them or with one of their groups.
        </p>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-center gap-2 text-sm text-red-700">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {canManage && (
          <PeoplePicker
            options={[
              ...groups.filter((g) => !granted.has(`g:${g.id}`)).map((g) => ({
                key: `g:${g.id}`, label: g.name || '', sub: `Group · ${g._count?.members ?? 0} members`, kind: 'group' as const,
              })),
              ...users.filter((u) => !granted.has(`u:${u.id}`)).map((u) => ({
                key: `u:${u.id}`, label: u.name || u.email || '', sub: u.email, kind: 'user' as const,
              })),
            ]}
            placeholder="Search groups or people…"
            emptyText="Everyone available already has access"
            addLabel="Share"
            onAdd={add}
            extra={<Segmented value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: roleLabel(r), title: ROLE_HELP[r] }))} />}
          />
        )}
        {canManage && !loading && users.length === 0 && groups.length === 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            There is no one to share with yet. Admins already see everything — add users with the User role in Settings › User Management, or create a group in Settings › Groups.
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
        ) : grants.length === 0 ? (
          <div className="text-center py-6 text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg">
            Not shared yet — only admins can see this {kind}.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {grants.map((g) => {
              const isGroup = !!g.group;
              const p = (g.group || g.user)!;
              return (
                <li key={g.id} className="flex items-center gap-3 px-3 py-2">
                  <Avatar text={p.name || p.email || ''} kind={isGroup ? 'group' : 'user'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{p.name || p.email}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {isGroup ? `Group · ${p._count?.members ?? 0} members` : p.email}
                    </div>
                  </div>
                  {canManage ? (
                    <Segmented value={g.role} onChange={(r) => changeRole(g, r)} options={roles.map((r) => ({ value: r, label: roleLabel(r), title: ROLE_HELP[r] }))} />
                  ) : (
                    <span className="text-xs text-gray-600">{roleLabel(g.role)}</span>
                  )}
                  {canManage && (
                    <button onClick={() => send(`${base}/${g.id}`, 'DELETE')} className="text-gray-400 hover:text-red-600 p-1 rounded" title="Remove access">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <ul className="text-xs text-gray-500 space-y-0.5">
          {roles.map((r) => <li key={r}><span className="font-medium text-gray-700">{roleLabel(r)}</span> — {ROLE_HELP[r]}</li>)}
        </ul>
      </div>
    </Modal>
  );
}
