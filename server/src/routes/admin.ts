import { Router, Request, Response } from 'express';
import os from 'os';
import { prisma } from '../lib/prisma';
import { authMiddleware, adminMiddleware } from './auth';

const router = Router();

// All routes require authentication and admin role
router.use(authMiddleware);
router.use(adminMiddleware);

// GET /admin/config - Get all system configs
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const configs = await prisma.systemConfig.findMany({
      orderBy: { category: 'asc' }
    });

    // Hide secret values
    const sanitizedConfigs = configs.map(config => ({
      ...config,
      value: config.isSecret ? '********' : config.value
    }));

    return res.json({
      success: true,
      data: sanitizedConfigs
    });
  } catch (error) {
    console.error('Get config error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /admin/config/:key - Get specific config
router.get('/config/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    
    const config = await prisma.systemConfig.findUnique({
      where: { key }
    });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Config not found'
      });
    }

    return res.json({
      success: true,
      data: {
        ...config,
        value: config.isSecret ? '********' : config.value
      }
    });
  } catch (error) {
    console.error('Get config error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// POST /admin/config - Create or update config
router.post('/config', async (req: Request, res: Response) => {
  try {
    const { key, value, description, category, isSecret } = req.body;
    const user = (req as any).user;

    if (!key || value === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Key and value are required'
      });
    }

    const config = await prisma.systemConfig.upsert({
      where: { key },
      update: {
        value,
        description,
        category,
        isSecret,
        updatedBy: user.id
      },
      create: {
        key,
        value,
        description,
        category: category || 'general',
        isSecret: isSecret || false,
        updatedBy: user.id
      }
    });

    return res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Save config error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// DELETE /admin/config/:key - Delete config
router.delete('/config/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    
    await prisma.systemConfig.delete({
      where: { key }
    });

    return res.json({
      success: true,
      message: 'Config deleted successfully'
    });
  } catch (error) {
    console.error('Delete config error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /admin/users - Get all users
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// POST /admin/users - Create user
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { email, name, password, role, status } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const crypto = await import('crypto');
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
        role: role || 'user',
        status: status || 'active'
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true
      }
    });

    // New users join the tenant the admin is working in
    if ((req as any).tenantId) {
      await prisma.tenantMember.create({
        data: { tenantId: (req as any).tenantId, userId: user.id, role: role === 'admin' ? 'tenant-admin' : 'member' },
      }).catch(() => undefined);
    }

    return res.json({
      success: true,
      data: user
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      });
    }
    console.error('Create user error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// PUT /admin/users/:id - Update user
router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, role, status, password } = req.body;

    const updateData: any = { name, role, status };

    if (password) {
      const crypto = await import('crypto');
      updateData.password = crypto.createHash('sha256').update(password).digest('hex');
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        updatedAt: true
      }
    });

    return res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// DELETE /admin/users/:id - Delete user
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    await prisma.user.delete({
      where: { id }
    });

    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ─── Tenants (super-admin; this router is admin-only) ───────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// GET /admin/tenants - every tenant with member/project counts
router.get('/tenants', async (_req: Request, res: Response) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'asc' },
      include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
    });
    const counts = await prisma.$queryRaw<{ tenantId: string | null; n: bigint }[]>`
      SELECT "tenantId", COUNT(*) AS n FROM projects GROUP BY "tenantId"`;
    const byTenant = new Map(counts.map((c) => [c.tenantId, Number(c.n)]));
    return res.json({
      success: true,
      data: tenants.map((t) => ({
        ...t,
        projectCount: byTenant.get(t.id) || 0,
        members: t.members.map((m) => ({ id: m.id, role: m.role, user: m.user })),
      })),
    });
  } catch (error) {
    console.error('List tenants error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /admin/tenants { slug, name } - the creator becomes its tenant-admin
router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ success: false, error: 'Slug: 3-40 chars, a-z 0-9 and -' });
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    const userId = (req as any).user?.id;
    const tenant = await prisma.tenant.create({
      data: { slug, name, members: userId ? { create: { userId, role: 'tenant-admin' } } : undefined },
    });
    return res.json({ success: true, data: tenant });
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'Slug already exists' });
    console.error('Create tenant error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /admin/tenants/:id { name?, status?, branding? }
router.put('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const { name, status, branding } = req.body || {};
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' });
    if (status && !['active', 'suspended'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
    if (status === 'suspended' && tenant.slug === 'default') return res.status(400).json({ success: false, error: 'The default tenant cannot be suspended' });
    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        ...(name ? { name: String(name) } : {}),
        ...(status ? { status } : {}),
        ...(branding !== undefined ? { branding: JSON.stringify(branding || {}) } : {}),
      },
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update tenant error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/members { email, role } - add or change a member
router.post('/tenants/:id/members', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const role = req.body?.role === 'tenant-admin' ? 'tenant-admin' : 'member';
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ success: false, error: 'No user with that email' });
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' });
    const member = await prisma.tenantMember.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role },
      create: { tenantId: tenant.id, userId: user.id, role },
    });
    return res.json({ success: true, data: member });
  } catch (error) {
    console.error('Add tenant member error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /admin/tenants/:id/members/:memberId
router.delete('/tenants/:id/members/:memberId', async (req: Request, res: Response) => {
  try {
    await prisma.tenantMember.deleteMany({ where: { id: req.params.memberId, tenantId: req.params.id } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Remove tenant member error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /admin/stats - Get system statistics
// ─── User groups ─────────────────────────────────────────────────────────────
// Access to projects and repository tables can be granted to a group; every member gets it.

router.get('/groups', async (_req: Request, res: Response) => {
  try {
    const groups = await prisma.userGroup.findMany({
      orderBy: { name: 'asc' },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, status: true } } }, orderBy: { createdAt: 'asc' } },
        projectGrants: { select: { id: true, role: true, project: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
        tableGrants: { select: { id: true, role: true, table: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
        folderGrants: { select: { id: true, role: true, folder: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { projectGrants: true, tableGrants: true, folderGrants: true } },
      },
    });
    return res.json({ success: true, data: groups });
  } catch (error) {
    console.error('Error fetching groups:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch groups' });
  }
});

router.post('/groups', async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Group name is required' });
    const group = await prisma.userGroup.create({ data: { name, description: req.body?.description?.trim() || null } });
    return res.status(201).json({ success: true, data: group });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ success: false, error: 'A group with this name already exists' });
    console.error('Error creating group:', error);
    return res.status(500).json({ success: false, error: 'Failed to create group' });
  }
});

router.put('/groups/:id', async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body || {};
    const group = await prisma.userGroup.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(description !== undefined && { description: description ? String(description).trim() : null }),
      },
    });
    return res.json({ success: true, data: group });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ success: false, error: 'A group with this name already exists' });
    console.error('Error updating group:', error);
    return res.status(500).json({ success: false, error: 'Failed to update group' });
  }
});

// Deleting a group also removes the access it granted
router.delete('/groups/:id', async (req: Request, res: Response) => {
  try {
    await prisma.userGroup.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
});

router.post('/groups/:id/members', async (req: Request, res: Response) => {
  try {
    const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId].filter(Boolean);
    if (!userIds.length) return res.status(400).json({ success: false, error: 'userId or userIds is required' });
    await prisma.userGroupMember.createMany({
      data: userIds.map((userId) => ({ groupId: req.params.id, userId })),
      skipDuplicates: true,
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error adding group members:', error);
    return res.status(500).json({ success: false, error: 'Failed to add members' });
  }
});

router.delete('/groups/:id/members/:userId', async (req: Request, res: Response) => {
  try {
    await prisma.userGroupMember.deleteMany({ where: { groupId: req.params.id, userId: req.params.userId } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing group member:', error);
    return res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

// ─── What a group can see ────────────────────────────────────────────────────
// kind: project (viewer/editor/owner), table (viewer/editor), folder = top-level
// File Explorer folder (viewer/editor)

const GRANT_ROLES: Record<string, string[]> = { project: ['viewer', 'editor', 'owner'], table: ['viewer', 'editor'], folder: ['viewer', 'editor'] };

// GET /admin/grant-targets - Everything that can be shared with a group
router.get('/grant-targets', async (_req: Request, res: Response) => {
  try {
    const fe = await prisma.systemConfig.findFirst({ where: { key: 'fileExplorerBasketId' }, select: { value: true } });
    const [projects, tables, repoFolders, folders] = await Promise.all([
      prisma.project.findMany({ select: { id: true, name: true, projectGroup: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      prisma.repoTable.findMany({ select: { id: true, name: true, description: true, folderId: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.repoFolder.findMany({ select: { id: true, name: true, parentId: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      fe?.value
        ? prisma.basketFolder.findMany({ where: { basketId: fe.value, parentId: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
        : Promise.resolve([]),
    ]);
    return res.json({ success: true, data: { projects, tables, repoFolders, folders } });
  } catch (error) {
    console.error('Error fetching grant targets:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch projects, tables and folders' });
  }
});

// POST /admin/groups/:id/grants { kind, targetId, role } - Share with the group, or change the role
router.post('/groups/:id/grants', async (req: Request, res: Response) => {
  try {
    const { kind, targetId, role = 'viewer' } = req.body || {};
    const groupId = req.params.id;
    if (!GRANT_ROLES[kind] || !targetId || !GRANT_ROLES[kind].includes(role)) {
      return res.status(400).json({ success: false, error: 'kind (project/table/folder), targetId and a valid role are required' });
    }
    let grant;
    if (kind === 'project') {
      grant = await prisma.projectMember.upsert({ where: { projectId_groupId: { projectId: targetId, groupId } }, create: { projectId: targetId, groupId, role }, update: { role } });
    } else if (kind === 'table') {
      grant = await prisma.repoTableMember.upsert({ where: { tableId_groupId: { tableId: targetId, groupId } }, create: { tableId: targetId, groupId, role }, update: { role } });
    } else {
      grant = await prisma.basketFolderMember.upsert({ where: { folderId_groupId: { folderId: targetId, groupId } }, create: { folderId: targetId, groupId, role }, update: { role } });
    }
    return res.json({ success: true, data: grant });
  } catch (error) {
    console.error('Error saving group grant:', error);
    return res.status(500).json({ success: false, error: 'Failed to save access' });
  }
});

// DELETE /admin/groups/:id/grants/:kind/:grantId - Stop sharing with the group
router.delete('/groups/:id/grants/:kind/:grantId', async (req: Request, res: Response) => {
  try {
    const { id: groupId, kind, grantId } = req.params;
    const where = { id: grantId, groupId };
    if (kind === 'project') await prisma.projectMember.deleteMany({ where });
    else if (kind === 'table') await prisma.repoTableMember.deleteMany({ where });
    else if (kind === 'folder') await prisma.basketFolderMember.deleteMany({ where });
    else return res.status(400).json({ success: false, error: 'Unknown kind' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing group grant:', error);
    return res.status(500).json({ success: false, error: 'Failed to remove access' });
  }
});

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [
      projectCount,
      flowCount,
      executionCount,
      userCount,
      apiSpecCount
    ] = await Promise.all([
      prisma.project.count(),
      prisma.flow.count(),
      prisma.execution.count(),
      prisma.user.count(),
      prisma.flow.count({ where: { type: 'API_SPEC' } })
    ]);

    return res.json({
      success: true,
      data: {
        projects: projectCount,
        flows: flowCount,
        executions: executionCount,
        users: userCount,
        apiSpecs: apiSpecCount
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Database location from DATABASE_URL, without credentials or query string.
function describeDatabase(url: string | undefined) {
  const providers: Record<string, string> = {
    postgresql: 'PostgreSQL', postgres: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server', file: 'SQLite',
  };
  try {
    const u = new URL(url || '');
    const scheme = u.protocol.replace(/:$/, '');
    return {
      provider: providers[scheme] || scheme,
      host: u.hostname || null,
      port: u.port ? Number(u.port) : scheme.startsWith('postgres') ? 5432 : null,
      name: decodeURIComponent(u.pathname.replace(/^\//, '')) || null,
    };
  } catch {
    return { provider: null, host: null, port: null, name: null };
  }
}

// GET /admin/system-info - Live server, database and runtime details for Settings
router.get('/system-info', async (_req: Request, res: Response) => {
  const started = Date.now();
  let connected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    connected = true;
  } catch (error) {
    console.error('System info DB check failed:', error);
  }

  return res.json({
    success: true,
    data: {
      database: {
        ...describeDatabase(process.env.DATABASE_URL),
        status: connected ? 'connected' : 'disconnected',
        latencyMs: connected ? Date.now() - started : null,
      },
      application: {
        environment: process.env.NODE_ENV || 'development',
        basePath: process.env.CTX_BASE_PATH || '/integration',
        nodeVersion: process.version,
      },
      server: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.arch()}`,
        uptimeSeconds: Math.round(process.uptime()),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
  });
});

export default router;
