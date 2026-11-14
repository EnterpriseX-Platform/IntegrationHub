import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Building2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { API_URL, apiFetch } from '../../config/api';

interface Member { id: string; role: string; user: { id: string; email: string; name: string | null } }
interface Tenant { id: string; slug: string; name: string; status: string; projectCount: number; members: Member[] }

const input = 'h-9 px-3 text-sm bg-white border-0 border-b border-gray-400 focus:outline-none';
const th = 'px-4 py-2 text-left text-[12px] font-semibold text-gray-700';

/** Settings → Tenants (super-admin): create tenants, suspend them, manage who belongs to each. */
export function TenantsPanel() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: '', name: '' });
  const [member, setMember] = useState({ email: '', role: 'member' });

  const load = async () => {
    try {
      const r = await fetch(`${API_URL}/admin/tenants`).then((x) => x.json());
      if (!r.success) throw new Error(r.error || 'Could not load tenants');
      setTenants(r.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tenants');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const call = async (url: string, method: string, body?: unknown) => {
    const r = await apiFetch(`${API_URL}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then((x) => x.json());
    if (!r.success) { alert(r.error || 'Failed'); return false; }
    await load();
    return true;
  };

  if (loading) return <div className="p-6 text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading tenants…</div>;

  return (
    <div className="space-y-6">
      {error && <div className="p-3 bg-red-50 text-red-700 text-sm border-l-4 border-red-600">{error}</div>}

      <div className="bg-white border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">New tenant</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-gray-600">Slug
            <input className={input} placeholder="acme" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-gray-600 flex-1 min-w-[200px]">Name
            <input className={input} placeholder="ACME Co., Ltd." value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <Button onClick={async () => { if (await call('/admin/tenants', 'POST', form)) setForm({ slug: '', name: '' }); }}>
            <Plus className="w-4 h-4 mr-1" /> Create tenant
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-gray-500">You become the tenant-admin of a tenant you create. Switch to it from the header.</p>
      </div>

      <div className="bg-white border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-100"><tr>
            <th className={th}>Tenant</th><th className={th}>Slug</th><th className={th}>Projects</th>
            <th className={th}>Members</th><th className={th}>Status</th><th className={th} />
          </tr></thead>
          <tbody>
            {tenants.map((t) => {
              const isOpen = openId === t.id;
              return [
                <tr key={t.id} className="border-t border-gray-200 hover:bg-gray-50 cursor-pointer" onClick={() => setOpenId(isOpen ? null : t.id)}>
                  <td className="px-4 py-3 text-gray-900 flex items-center gap-2">
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <Building2 className="w-4 h-4 text-gray-500" /> {t.name}
                  </td>
                  <td className="px-4 py-3 text-gray-600 font-mono">{t.slug}</td>
                  <td className="px-4 py-3 text-gray-600">{t.projectCount}</td>
                  <td className="px-4 py-3 text-gray-600">{t.members.length}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-[12px] rounded-full ${t.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>{t.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {t.slug !== 'default' && (
                      <button className="text-[13px] text-blue-600 hover:underline"
                        onClick={() => call(`/admin/tenants/${t.id}`, 'PUT', { status: t.status === 'active' ? 'suspended' : 'active' })}>
                        {t.status === 'active' ? 'Suspend' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`${t.id}-m`} className="bg-gray-50">
                    <td colSpan={6} className="px-10 py-4">
                      <div className="flex flex-wrap items-end gap-3 mb-3">
                        <input className={`${input} min-w-[240px]`} placeholder="user@email (existing user)" value={member.email}
                          onChange={(e) => setMember({ ...member, email: e.target.value })} />
                        <select className={input} value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}>
                          <option value="member">Member</option>
                          <option value="tenant-admin">Tenant admin</option>
                        </select>
                        <Button variant="secondary" onClick={async () => { if (await call(`/admin/tenants/${t.id}/members`, 'POST', member)) setMember({ email: '', role: 'member' }); }}>
                          Add member
                        </Button>
                      </div>
                      {t.members.length === 0 ? <p className="text-gray-500 text-sm">No members.</p> : (
                        <ul className="divide-y divide-gray-200 border border-gray-200 bg-white">
                          {t.members.map((m) => (
                            <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                              <span className="flex-1 text-gray-900">{m.user.name || m.user.email} <span className="text-gray-500">{m.user.email}</span></span>
                              <span className="text-[12px] text-gray-600">{m.role === 'tenant-admin' ? 'Tenant admin' : 'Member'}</span>
                              <button title="Remove" className="text-gray-500 hover:text-red-600"
                                onClick={() => call(`/admin/tenants/${t.id}/members/${m.id}`, 'DELETE')}>
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
