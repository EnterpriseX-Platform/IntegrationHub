import { currentTenant } from './tenantContext';
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
export async function resolveTenant(userId: string, role: string | null | undefined, wanted?: string | null): Promise<{ tenantId: string; role: string; isDefault: boolean } | null> {
  const list = await tenantsForUser(userId, role);
  const pick = (id?: string | null) => (id ? list.find((t) => t.id === id || t.slug === id) : undefined);
  const defaultId = await getDefaultTenantId();
  const t = pick(wanted) || pick(defaultId) || list[0];
  if (t) return { tenantId: t.id, role: t.role as string, isDefault: t.id === defaultId };
  // Only a user with NO memberships at all (created before tenants existed) falls back
  // to "default". A user whose tenants are all suspended gets no tenant — they used to
  // land in "default" and could keep working there.
  const anyMembership = await prisma.tenantMember.count({ where: { userId } });
  if (anyMembership > 0) return null;
  return { tenantId: defaultId, role: 'member', isDefault: true };
}

/**
 * Prisma `where` fragment limiting users to the current tenant. The default
 * tenant also owns users that have no membership yet (pre-tenancy accounts).
 */
export function tenantUserWhere(): Record<string, any> {
  const ctx = currentTenant();
  if (!ctx) return {};
  const mine = { tenantMemberships: { some: { tenantId: ctx.tenantId } } };
  return ctx.isDefault ? { OR: [mine, { tenantMemberships: { none: {} } }] } : mine;
}
