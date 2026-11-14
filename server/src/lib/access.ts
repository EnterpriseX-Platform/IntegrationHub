import { Request, Response, NextFunction } from 'express';
import { prisma } from './prisma';

/**
 * Who may see what. Admins see everything. Other users see only the projects
 * and Data Repository tables granted to them or to one of their user groups:
 *   viewer — read; editor — also change and run; owner (projects only) — also manage members.
 */
export type MemberRole = 'viewer' | 'editor' | 'owner';
const RANK: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
export const MEMBER_ROLES: MemberRole[] = ['viewer', 'editor', 'owner'];

interface CurrentUser { id: string | null; isAdmin: boolean }

/** The logged-in user, cached on the request. isAdmin = super-admin or tenant-admin of the request's tenant.
 *  With REQUIRE_LOGIN=false there is no user and nothing is restricted. */
export async function currentUser(req: Request): Promise<CurrentUser> {
  const r = req as any;
  if (r._currentUser) return r._currentUser;
  const userId: string | undefined = r.userId;
  // No user: only REQUIRE_LOGIN=false leaves everything open. Any other route that
  // reaches here without a session gets no admin rights.
  let user: CurrentUser = { id: null, isAdmin: process.env.REQUIRE_LOGIN === 'false' };
  if (userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    const active = u?.status !== 'inactive';
    // Super-admin (role admin), or tenant-admin of the tenant this request works in
    user = { id: userId, isAdmin: active && (u?.role === 'admin' || r.tenantRole === 'tenant-admin') };
  }
  r._currentUser = user;
  return user;
}

/** Group ids the user belongs to, cached on the request. */
async function groupIds(req: Request, userId: string): Promise<string[]> {
  const r = req as any;
  if (!r._groupIds) {
    const rows = await prisma.userGroupMember.findMany({ where: { userId }, select: { groupId: true } });
    r._groupIds = rows.map((x) => x.groupId);
  }
  return r._groupIds;
}

/** Grants that apply to the user: given to them directly or to one of their groups. */
async function grantFilter(req: Request, userId: string) {
  const groups = await groupIds(req, userId);
  return { OR: [{ userId }, ...(groups.length ? [{ groupId: { in: groups } }] : [])] };
}

function highest(roles: string[]): MemberRole | null {
  let best: MemberRole | null = null;
  for (const r of roles) if (RANK[r] && (!best || RANK[r] > RANK[best])) best = r as MemberRole;
  return best;
}

/** Project ids the user may see, or null when they may see every project. */
export async function visibleProjectIds(req: Request): Promise<string[] | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return null;
  const rows = await prisma.projectMember.findMany({ where: await grantFilter(req, u.id!), select: { projectId: true } });
  return [...new Set(rows.map((r) => r.projectId))];
}

/** Repository table ids the user may see, or null when they may see every table. */
export async function visibleTableIds(req: Request): Promise<string[] | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return null;
  const rows = await prisma.repoTableMember.findMany({ where: await grantFilter(req, u.id!), select: { tableId: true } });
  return [...new Set(rows.map((r) => r.tableId))];
}

/** 'admin', the highest role from the user's own and group grants, or null when they have no access. */
export async function projectRole(req: Request, projectId: string): Promise<'admin' | MemberRole | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return 'admin';
  const rows = await prisma.projectMember.findMany({ where: { projectId, ...(await grantFilter(req, u.id!)) }, select: { role: true } });
  return highest(rows.map((r) => r.role));
}

export async function tableRole(req: Request, tableId: string): Promise<'admin' | MemberRole | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return 'admin';
  const rows = await prisma.repoTableMember.findMany({ where: { tableId, ...(await grantFilter(req, u.id!)) }, select: { role: true } });
  return highest(rows.map((r) => r.role));
}

export function roleAllows(role: 'admin' | MemberRole | null, need: MemberRole): boolean {
  if (role === 'admin') return true;
  return !!role && RANK[role] >= RANK[need];
}

/** Reads need viewer; anything else needs editor. */
export function neededFor(req: Request): MemberRole {
  return ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'viewer' : 'editor';
}

function forbid(res: Response, what: string) {
  res.status(403).json({ success: false, error: `You do not have access to this ${what}` });
}

/**
 * Express param handler: resolve the project behind the route param and check the role.
 * `resolve` returns null when the record does not exist, so the route can answer 404 itself.
 */
export function guardProject(resolve: (value: string) => Promise<string | null>, need?: MemberRole) {
  return async (req: Request, res: Response, next: NextFunction, value: string) => {
    try {
      const u = await currentUser(req);
      if (u.isAdmin) return next();
      const projectId = await resolve(value);
      if (!projectId) return next();
      if (roleAllows(await projectRole(req, projectId), need || neededFor(req))) return next();
      return forbid(res, 'project');
    } catch (err) { return next(err); }
  };
}

export function guardTable(need?: MemberRole) {
  return async (req: Request, res: Response, next: NextFunction, tableId: string) => {
    try {
      const u = await currentUser(req);
      if (u.isAdmin) return next();
      if (roleAllows(await tableRole(req, tableId), need || neededFor(req))) return next();
      return forbid(res, 'table');
    } catch (err) { return next(err); }
  };
}

/** Route middleware: admins only. */
export async function adminOnly(req: Request, res: Response, next: NextFunction) {
  try {
    if ((await currentUser(req)).isAdmin) return next();
    res.status(403).json({ success: false, error: 'Admin only' });
  } catch (err) { next(err); }
}

/** The highest role the user has on any of these projects. */
export async function bestProjectRole(req: Request, projectIds: string[]): Promise<'admin' | MemberRole | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return 'admin';
  if (!projectIds.length) return null;
  const rows = await prisma.projectMember.findMany({
    where: { projectId: { in: projectIds }, ...(await grantFilter(req, u.id!)) },
    select: { role: true },
  });
  return highest(rows.map((r) => r.role));
}

/**
 * Like guardProject, for records that can belong to several projects (a basket
 * shared with other projects). `resolve` returns the project ids, null when the
 * record does not exist, or 'open' when every logged-in user may use it.
 */
export function guardProjects(resolve: (value: string) => Promise<string[] | null | 'open'>, need?: MemberRole) {
  return async (req: Request, res: Response, next: NextFunction, value: string) => {
    try {
      const u = await currentUser(req);
      if (u.isAdmin) return next();
      const ids = await resolve(value);
      if (ids === null || ids === 'open') return next();
      if (roleAllows(await bestProjectRole(req, ids), need || neededFor(req))) return next();
      return forbid(res, 'project');
    } catch (err) { return next(err); }
  };
}

/** Projects a basket belongs to: its own project plus projects it is shared with. 'open' for the File Explorer workspace. */
export async function basketProjects(basketId: string): Promise<string[] | null | 'open'> {
  const b = await prisma.basket.findUnique({
    where: { id: basketId },
    select: { projectId: true, sharedWith: { select: { projectId: true } } },
  });
  if (!b) return null;
  const fe = await prisma.systemConfig.findFirst({ where: { key: 'fileExplorerBasketId' }, select: { value: true } });
  if (fe?.value === basketId) return 'open';
  return [b.projectId, ...b.sharedWith.map((s) => s.projectId)];
}

/** Prisma `where` limiting records with a projectId to what the user may see (empty object for admins). */
export async function projectScope(req: Request, field = 'projectId'): Promise<Record<string, unknown>> {
  const visible = await visibleProjectIds(req);
  return visible ? { [field]: { in: visible } } : {};
}

/**
 * File Explorer: the folders a non-admin may reach, with their role. A grant on a
 * top-level folder covers every folder below it. null = admin, sees everything.
 * Cached on the request.
 */
export async function feFolderRoles(req: Request, basketId: string): Promise<Map<string, MemberRole> | null> {
  const u = await currentUser(req);
  if (u.isAdmin) return null;
  const r = req as any;
  if (r._feFolderRoles) return r._feFolderRoles;
  const [folders, grants] = await Promise.all([
    prisma.basketFolder.findMany({ where: { basketId }, select: { id: true, parentId: true } }),
    prisma.basketFolderMember.findMany({ where: { folder: { basketId }, ...(await grantFilter(req, u.id!)) }, select: { folderId: true, role: true } }),
  ]);
  const granted = new Map<string, MemberRole>();
  for (const g of grants) {
    const best = highest([g.role, granted.get(g.folderId) || ''].filter(Boolean));
    if (best) granted.set(g.folderId, best);
  }
  const parent = new Map(folders.map((f) => [f.id, f.parentId]));
  const roles = new Map<string, MemberRole>();
  for (const f of folders) {
    // walk up to the top-level folder; the closest grant on the way wins
    let cur: string | null | undefined = f.id;
    let role: MemberRole | undefined;
    for (let guard = 0; cur && guard < 100 && !role; guard++) { role = granted.get(cur); cur = parent.get(cur); }
    if (role) roles.set(f.id, role);
  }
  r._feFolderRoles = roles;
  return roles;
}

/** Whether `basketId` is the shared File Explorer basket. */
export async function isFileExplorerBasket(basketId: string): Promise<boolean> {
  const fe = await prisma.systemConfig.findFirst({ where: { key: 'fileExplorerBasketId' }, select: { value: true } });
  return fe?.value === basketId;
}

/** File Explorer check for one folder (null folder = root, admin only). Answers 403 itself; returns false then. */
export async function allowFeFolder(req: Request, res: Response, basketId: string, folderId: string | null | undefined, need: MemberRole): Promise<boolean> {
  const roles = await feFolderRoles(req, basketId);
  if (!roles) return true;
  if (folderId && roleAllows(roles.get(folderId) || null, need)) return true;
  res.status(403).json({ success: false, error: folderId ? 'You do not have access to this folder' : 'Only admins can use the top level of File Explorer' });
  return false;
}
