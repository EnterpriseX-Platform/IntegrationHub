import { AsyncLocalStorage } from 'async_hooks';

/**
 * The tenant the current request works in. Set by requireSession for every
 * logged-in /int request and read by the Prisma tenant extension
 * (lib/prisma.ts), which adds the tenant filter to queries on its own.
 *
 * Code that runs outside a request (scheduler, basket triggers, public API
 * with API keys, startup jobs) has no context and is not filtered.
 */
export interface TenantContext {
  tenantId: string;
  /** The "default" tenant also owns rows whose tenantId is still null. */
  isDefault: boolean;
}

const store = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentTenant(): TenantContext | undefined {
  return store.getStore();
}

/** Run without any tenant filter, e.g. a system job started from a request. */
export function runWithoutTenant<T>(fn: () => T): T {
  return store.exit(fn);
}
