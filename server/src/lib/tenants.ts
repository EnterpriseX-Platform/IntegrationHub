import { prisma } from './prisma';
import { DEFAULT_TENANT_SLUG } from '../services/tenantBootstrap';

let defaultTenantId: string | null = null;

export async function getDefaultTenantId(): Promise<string> {
  if (defaultTenantId) return defaultTenantId;
  const t = await prisma.tenant.upsert({
    where: { slug: DEFAULT_TENANT_SLUG },
    update: {},
    create: { slug: DEFAULT_TENANT_SLUG, name: process.env.DEFAULT_TENANT_NAME || 'Default' },
  });
  defaultTenantId = t.id;
  return t.id;
}

export function isSuperAdmin(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === 'admin';
}

/** Tenants the user can enter: their memberships, or every active tenant for a super-admin. */
export async function tenantsForUser(userId: string, role?: string | null) {
  if (isSuperAdmin({ role })) {
    const all = await prisma.tenant.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    const mine = await prisma.tenantMember.findMany({ where: { userId } });
    const roleOf = new Map(mine.map((m) => [m.tenantId, m.role]));
    return all.map((t) => ({ ...t, role: roleOf.get(t.id) || 'tenant-admin' }));
  }
  const rows = await prisma.tenantMember.findMany({
    where: { userId, tenant: { status: 'active' } },
    include: { tenant: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ ...r.tenant, role: r.role }));
}

/**
 * Which tenant a request works in: the one requested (switch / X-Tenant-Id) if
 * the user may enter it, else the session's tenant, else the user's first
 * tenant, else "default".
 */
export async function resolveTenant(userId: string, role: string | null | undefined, wanted?: string | null) {
  const list = await tenantsForUser(userId, role);
  const pick = (id?: string | null) => (id ? list.find((t) => t.id === id || t.slug === id) : undefined);
  const defaultId = await getDefaultTenantId();
  const t = pick(wanted) || pick(defaultId) || list[0];
  if (t) return { tenantId: t.id, role: t.role as string, isDefault: t.id === defaultId };
  // No membership at all (e.g. a user created before tenants existed): treat as default member
  return { tenantId: defaultId, role: 'member', isDefault: true };
}
