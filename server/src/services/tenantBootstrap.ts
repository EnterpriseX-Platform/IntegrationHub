import { prisma } from '../lib/prisma';

/**
 * Multi-tenancy phase 1: make sure the "default" tenant exists and that every
 * tenant-owned row without a tenantId belongs to it. Admin users become
 * tenant-admins of "default", everyone else a member. Idempotent — safe to run
 * on every start. Does not change any behaviour yet (nothing filters by tenant).
 */
export const DEFAULT_TENANT_SLUG = 'default';

// Physical table names of the models that got a `tenantId` column
const TENANT_TABLES = [
  'projects', 'user_groups', 'system_configs', 'transfer_jobs', 'tags',
  'wb_connections', 'wb_api_keys', 'wb_datasets', 'wb_folders', 'wb_saved_queries',
  'repo_connections', 'repo_api_keys', 'repo_tables', 'repo_sql_queries', 'repo_folders',
  'data_view_folders', 'data_views', 'share_links',
];

export async function ensureDefaultTenant(): Promise<string> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: DEFAULT_TENANT_SLUG },
    update: {},
    create: {
      slug: DEFAULT_TENANT_SLUG,
      name: process.env.DEFAULT_TENANT_NAME || 'Default',
    },
  });

  let moved = 0;
  for (const table of TENANT_TABLES) {
    // Table names are constants above, never user input
    moved += await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" IS NULL`,
      tenant.id,
    );
  }

  const users = await prisma.user.findMany({ select: { id: true, role: true } });
  const existing = new Set(
    (await prisma.tenantMember.findMany({ where: { tenantId: tenant.id }, select: { userId: true } }))
      .map((m) => m.userId),
  );
  const missing = users.filter((u) => !existing.has(u.id));
  if (missing.length) {
    await prisma.tenantMember.createMany({
      data: missing.map((u) => ({
        tenantId: tenant.id,
        userId: u.id,
        role: u.role === 'admin' ? 'tenant-admin' : 'member',
      })),
      skipDuplicates: true,
    });
  }

  if (moved || missing.length) {
    console.log(`[tenant] default tenant ${tenant.id}: back-filled ${moved} rows, added ${missing.length} members`);
  }
  return tenant.id;
}
