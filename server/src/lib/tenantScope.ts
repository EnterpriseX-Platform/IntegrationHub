import { Prisma } from '@prisma/client';
import { currentTenant } from './tenantContext';

/** Models that carry their own `tenantId` column (filtered + stamped on create). */
const DIRECT = new Set([
  'Project', 'UserGroup', 'TransferJob', 'Tag',
  'WbConnection', 'WbApiKey', 'WbDataset', 'WbFolder', 'WbSavedQuery',
  'RepoConnection', 'RepoApiKey', 'RepoTable', 'RepoSqlQuery', 'RepoFolder',
  'DataViewFolder', 'DataView', 'ShareLink',
]);
// SystemConfig also has the column but stays global until per-tenant settings (phase 3).

/** Models owned through their project (filtered by project.tenantId). */
const VIA_PROJECT: Record<string, { optional: boolean }> = {
  Flow: { optional: false },
  Scheduler: { optional: false },
  ApiKey: { optional: false },
  ApiSpec: { optional: false },
  Basket: { optional: false },
  ProjectTag: { optional: false },
  Execution: { optional: true },   // non-flow executions have no project
  Connection: { optional: true },  // app-level connections have no project
};

const WHERE_OPS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert',
]);

function ownFilter(tenantId: string, isDefault: boolean): any {
  return isDefault ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
}

function filterFor(model: string, tenantId: string, isDefault: boolean): any | null {
  if (DIRECT.has(model)) return ownFilter(tenantId, isDefault);
  const via = VIA_PROJECT[model];
  if (!via) return null;
  const byProject = { project: ownFilter(tenantId, isDefault) };
  // Rows without a project are shared rows; only the default tenant sees them
  return via.optional && isDefault ? { OR: [{ projectId: null }, byProject] } : byProject;
}

function stamp(data: any, tenantId: string) {
  if (data && typeof data === 'object' && data.tenantId === undefined) data.tenantId = tenantId;
}

/**
 * Prisma extension: inside a request with a tenant context, every query on a
 * tenant-owned model is limited to that tenant, and creates are stamped with it.
 */
export const tenantScope = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = currentTenant();
        if (!ctx || !model) return query(args);
        const a: any = args ?? {};

        if (DIRECT.has(model)) {
          if (operation === 'create') stamp(a.data, ctx.tenantId);
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            (Array.isArray(a.data) ? a.data : [a.data]).forEach((d: any) => stamp(d, ctx.tenantId));
          }
          if (operation === 'upsert') stamp(a.create, ctx.tenantId);
        }

        const filter = WHERE_OPS.has(operation) ? filterFor(model, ctx.tenantId, ctx.isDefault) : null;
        if (filter) a.where = a.where ? { ...a.where, AND: [...[].concat(a.where.AND ?? []), filter] } : filter;
        return query(a);
      },
    },
  },
});
