import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { API_URL, apiFetch } from '../../config/api';
import { refreshCurrentUser, useCurrentUser } from '../../lib/currentUser';

/** Header control (Carbon UI-shell style): shows the active tenant and switches to another one. */
export function TenantSwitcher() {
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tenants = user?.tenants || [];
  const active = tenants.find((t) => t.id === user?.tenantId);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (tenants.length < 2 || !active) return null;

  const pick = async (id: string) => {
    if (id === user?.tenantId) { setOpen(false); return; }
    setBusy(true);
    try {
      const res = await apiFetch(`${API_URL}/auth/switch-tenant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await refreshCurrentUser(true);
      // Every page holds tenant data in state: start clean on the new tenant
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not switch tenant');
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="Switch tenant"
        className="h-12 flex items-center gap-2 px-4 text-[#f4f4f4] hover:bg-[#262626]"
      >
        <span className="w-2.5 h-2.5 bg-[#08bdba]" />
        <span className="text-[13px] max-w-[140px] truncate">{active.name}</span>
        <ChevronDown className={`w-4 h-4 text-[#a8a8a8] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full w-64 bg-white border border-gray-200 shadow-lg z-50 py-1">
          <div className="px-4 py-2 text-[12px] uppercase tracking-wider text-gray-500">Tenants</div>
          {tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm text-gray-900 hover:bg-gray-100"
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate">{t.name}</span>
                <span className="block text-[12px] text-gray-500">{t.slug} · {t.role === 'tenant-admin' ? 'Admin' : 'Member'}</span>
              </span>
              {t.id === user?.tenantId && <Check className="w-4 h-4 text-blue-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
