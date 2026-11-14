import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponseWrapper, Flow } from '../types';
import { maskConfig } from '../lib/connectionSecrets';
import { currentUser, visibleProjectIds, projectRole, guardProject, neededFor, MEMBER_ROLES, MemberRole } from '../lib/access';

const router = Router();

// Non-admins need membership of the project in :id. Deleting the project and
// managing its members need owner; other writes need editor; reads need viewer.
router.param('id', (req, res, next, id) => {
  const ownerOnly = req.method !== 'GET' && (req.path === `/${id}` || req.path.startsWith(`/${id}/members`));
  const need: MemberRole = ownerOnly && req.method !== 'PUT' ? 'owner' : neededFor(req);
  return guardProject(async (pid) => {
    const p = await prisma.project.findUnique({ where: { id: pid }, select: { id: true } });
    return p?.id || null;
  }, need)(req, res, next, id);
});

// GET /api/projects - List all projects
router.get('/', async (req: Request, res: Response): Promise<Response> => {
  try {
    const visible = await visibleProjectIds(req);
    const projects = await prisma.project.findMany({
      where: visible ? { id: { in: visible } } : undefined,
      orderBy: { position: 'asc' },
      include: {
        _count: {
          select: {
            flows: true,
            connections: true,
          },
        },
        flows: {
          select: {
            type: true,
          },
        },
      },
    });

    // Transform to include counts and flow types breakdown
    const projectsWithCounts = projects.map(p => {
      // Count flows by type
      const flowTypes: Record<string, number> = {};
      p.flows.forEach(flow => {
        flowTypes[flow.type] = (flowTypes[flow.type] || 0) + 1;
      });

      return {
        ...p,
        slug: p.code,
        flowCount: p._count.flows,
        connectionCount: p._count.connections,
        flowTypes,
        tags: JSON.parse(p.tags || '[]'),
      };
    });

    const response: ApiResponseWrapper<typeof projectsWithCounts> = {
      success: true,
      data: projectsWithCounts,
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching projects:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch projects',
    };
    return res.status(500).json(response);
  }
});

// POST /api/projects - Create new project
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, color, image, slug, projectGroup, agency, agencyLevel, tags } = req.body;

    if (!name || name.trim() === '') {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project name is required',
      };
      return res.status(400).json(response);
    }

    const newProject = await prisma.project.create({
      data: {
        name: name.trim(),
        code: slug?.trim() || null,
        description: description?.trim() || null,
        color: color || 'blue',
        image: image || null,
        projectGroup: projectGroup?.trim() || null,
        agency: agency?.trim() || null,
        agencyLevel: agencyLevel?.trim() || null,
        tags: tags ? JSON.stringify(tags) : '[]',
      },
    });

    // A non-admin who creates a project owns it, so they can still see it
    const me = await currentUser(req);
    if (!me.isAdmin && me.id) {
      await prisma.projectMember.create({ data: { projectId: newProject.id, userId: me.id, role: 'owner' } });
    }

    const response: ApiResponseWrapper<typeof newProject> = {
      success: true,
      data: {
        ...newProject,
        tags: JSON.parse(newProject.tags),
      },
      message: 'Project created successfully',
    };
    return res.status(201).json(response);
  } catch (error) {
    console.error('Error creating project:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to create project',
    };
    return res.status(500).json(response);
  }
});

// Must stay above GET /:id, or Express treats 'group-agency-order' as a project id (404)
// GET /api/projects/group-agency-order - Get current group and agency orders
router.get('/group-agency-order', async (_req: Request, res: Response) => {
  try {
    // Get all projects with their group and agency info
    const projects = await prisma.project.findMany({
      select: {
        id: true,
        projectGroup: true,
        agency: true,
        groupPosition: true,
        agencyPosition: true,
      },
    });

    // Extract unique groups with their positions
    const groupMap = new Map<string, number>();
    const agencyMap = new Map<string, Map<string, number>>();

    projects.forEach(p => {
      const group = p.projectGroup || 'Ungrouped';
      const agency = p.agency || 'No Agency';
      
      // Track group position (use first non-zero or max)
      if (!groupMap.has(group) || p.groupPosition > 0) {
        groupMap.set(group, p.groupPosition);
      }
      
      // Track agency position within group
      if (!agencyMap.has(group)) {
        agencyMap.set(group, new Map());
      }
      const groupAgencies = agencyMap.get(group)!;
      if (!groupAgencies.has(agency) || p.agencyPosition > 0) {
        groupAgencies.set(agency, p.agencyPosition);
      }
    });

    // Convert to sorted arrays
    const groupOrder = Array.from(groupMap.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([group]) => group);

    const agencyOrders: Record<string, string[]> = {};
    agencyMap.forEach((agencies, group) => {
      agencyOrders[group] = Array.from(agencies.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([agency]) => agency);
    });

    const response: ApiResponseWrapper<{
      groupOrder: string[];
      agencyOrders: Record<string, string[]>;
    }> = {
      success: true,
      data: {
        groupOrder,
        agencyOrders,
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching group-agency order:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch group-agency order',
    };
    return res.status(500).json(response);
  }
});

// GET /api/projects/:id - Get project details with flows, connections, scheduler, apiSpecs
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        flows: {
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            description: true,
            process: true,
            displayOrder: true,
            tags: true,
            version: true,
            createdAt: true,
            updatedAt: true,
            projectId: true,
            nodes: true,
            connections: true,
            config: true,
          },
        },
        connections: {
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        },
        schedulers: {
          orderBy: { createdAt: 'desc' },
        },
        apiSpecs: {
          orderBy: { createdAt: 'desc' },
        },
        baskets: {
          orderBy: { createdAt: 'desc' },
        },
        // Executions loaded separately via raw query to avoid TOAST overhead
        // executions: { ... },
      },
    });

    if (!project) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    // Load executions via raw query to avoid TOAST overhead on large result/output columns
    const executions: any[] = await prisma.$queryRaw`
      SELECT e.id, e."flowId", e."projectId", e.status, e."startedAt", e."endedAt",
             e."durationMs", e.error, e."errorType", e."triggerType", e."callerName",
             f.name as "flowName", f.type as "flowType"
      FROM executions e
      LEFT JOIN flows f ON e."flowId" = f.id
      WHERE e."projectId" = ${id}
      ORDER BY e."startedAt" DESC
      LIMIT 50
    `;
    const executionsWithParsedData = executions.map(exec => ({
      ...exec,
      flow: { name: exec.flowName, type: exec.flowType },
      flowName: undefined,
      flowType: undefined,
    }));

    // Parse flows tags from JSON string to array
    const flowsWithParsedTags = project.flows.map(flow => ({
      ...flow,
      tags: flow.tags ? JSON.parse(flow.tags) : [],
      nodes: flow.nodes ? JSON.parse(flow.nodes) : [],
      connections: flow.connections ? JSON.parse(flow.connections) : [],
    }));

    // SECURITY: strip cleartext secrets (passwords, keys, tokens) from each
    // connection's config before sending the project to the client.
    const maskedConnections = (project.connections || []).map((c: any) => ({
      ...c,
      config: maskConfig(c.config),
    }));

    const response: ApiResponseWrapper<any> = {
      success: true,
      data: {
        ...project,
        connections: maskedConnections,
        slug: project.code,
        flows: flowsWithParsedTags,
        executions: executionsWithParsedData,
        myRole: await projectRole(req, id),
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching project:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch project',
    };
    return res.status(500).json(response);
  }
});

// POST /api/projects/:id/flows - Create new flow
router.post('/:id/flows', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, nodes, connections: flowConnections, process, tags } = req.body;

    // Check if project exists
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    if (!name || !type) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Name and type are required',
      };
      return res.status(400).json(response);
    }

    // Create flow - id is auto-generated by Prisma (CUID)
    // Ignore any id sent from client to prevent non-CUID ids
    const newFlow = await prisma.flow.create({
      data: {
        projectId: id,
        name,
        type,
        status: 'Active',
        nodes: JSON.stringify(nodes || []),
        connections: JSON.stringify(flowConnections || []),
        process: process || null,
        tags: JSON.stringify(tags || []),
      },
    });

    const response: ApiResponseWrapper<Flow> = {
      success: true,
      data: {
        ...newFlow,
        nodes: JSON.parse(newFlow.nodes),
        connections: JSON.parse(newFlow.connections),
        tags: JSON.parse(newFlow.tags),
        createdAt: newFlow.createdAt.toISOString(),
        updatedAt: newFlow.updatedAt.toISOString(),
      } as Flow,
      message: 'Flow created successfully',
    };
    return res.status(201).json(response);
  } catch (error) {
    console.error('Error creating flow:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to create flow',
    };
    return res.status(500).json(response);
  }
});

// PUT /api/projects/:id - Update project
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, status, color, image, slug, projectGroup, agency, agencyLevel, tags } = req.body;

    // Check if project exists
    const existingProject = await prisma.project.findUnique({
      where: { id },
    });

    if (!existingProject) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    const updatedProject = await prisma.project.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(slug !== undefined && { code: slug.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(status !== undefined && { status }),
        ...(color !== undefined && { color }),
        ...(image !== undefined && { image }),
        ...(projectGroup !== undefined && { projectGroup: projectGroup?.trim() || null }),
        ...(agency !== undefined && { agency: agency?.trim() || null }),
        ...(agencyLevel !== undefined && { agencyLevel: agencyLevel?.trim() || null }),
        ...(tags !== undefined && { tags: JSON.stringify(tags) }),
        updatedAt: new Date(),
      },
    });

    const response: ApiResponseWrapper<typeof updatedProject> = {
      success: true,
      data: {
        ...updatedProject,
        tags: JSON.parse(updatedProject.tags),
      },
      message: 'Project updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating project:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update project',
    };
    return res.status(500).json(response);
  }
});

// GET /api/projects/metadata/unique-values - Get unique project groups and agencies
router.get('/metadata/unique-values', async (_req: Request, res: Response) => {
  try {
    const [projectGroups, agencies] = await Promise.all([
      prisma.project.findMany({
        where: { projectGroup: { not: null } },
        select: { projectGroup: true },
        distinct: ['projectGroup'],
      }),
      prisma.project.findMany({
        where: { agency: { not: null } },
        select: { agency: true, agencyLevel: true },
        distinct: ['agency'],
      }),
    ]);

    const uniqueProjectGroups = projectGroups
      .map(p => p.projectGroup)
      .filter((v): v is string => v !== null)
      .sort();
    
    const uniqueAgencies = agencies
      .map(a => ({ 
        name: a.agency!, 
        level: a.agencyLevel 
      }))
      .filter(a => a.name !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    const response: ApiResponseWrapper<{
      projectGroups: string[];
      agencies: { name: string; level: string | null }[];
    }> = {
      success: true,
      data: {
        projectGroups: uniqueProjectGroups,
        agencies: uniqueAgencies,
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching unique values:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch unique values',
    };
    return res.status(500).json(response);
  }
});

// DELETE /api/projects/:id - Delete project
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if project exists
    const existingProject = await prisma.project.findUnique({
      where: { id },
    });

    if (!existingProject) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    // Delete project (cascade will handle related records)
    await prisma.project.delete({
      where: { id },
    });

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Project deleted successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error deleting project:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to delete project',
    };
    return res.status(500).json(response);
  }
});

// POST /api/projects/position - Update project positions
router.post('/position', async (req: Request, res: Response) => {
  try {
    const { positions } = req.body;

    if (!Array.isArray(positions) || positions.length === 0) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Positions array is required',
      };
      return res.status(400).json(response);
    }

    // Update positions in transaction
    await prisma.$transaction(
      positions.map((item: { projectId: string; position: number }) =>
        prisma.project.update({
          where: { id: item.projectId },
          data: { position: item.position },
        })
      )
    );

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Project positions updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating project positions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update project positions',
    };
    return res.status(500).json(response);
  }
});

// POST /api/projects/group-position - Update group positions
router.post('/group-position', async (req: Request, res: Response) => {
  try {
    const { groupPositions } = req.body;

    if (!Array.isArray(groupPositions) || groupPositions.length === 0) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'groupPositions array is required',
      };
      return res.status(400).json(response);
    }

    // Update groupPosition for all projects in each group
    await prisma.$transaction(
      groupPositions.map((item: { projectGroup: string; position: number }) =>
        prisma.project.updateMany({
          where: { projectGroup: item.projectGroup },
          data: { groupPosition: item.position },
        })
      )
    );

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Group positions updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating group positions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update group positions',
    };
    return res.status(500).json(response);
  }
});

// POST /api/projects/agency-position - Update agency positions
router.post('/agency-position', async (req: Request, res: Response) => {
  try {
    const { agencyPositions } = req.body;

    if (!Array.isArray(agencyPositions) || agencyPositions.length === 0) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'agencyPositions array is required',
      };
      return res.status(400).json(response);
    }

    // Update agencyPosition for all projects in each agency within a group
    await prisma.$transaction(
      agencyPositions.map((item: { projectGroup: string; agency: string; position: number }) =>
        prisma.project.updateMany({
          where: { 
            projectGroup: item.projectGroup,
            agency: item.agency 
          },
          data: { agencyPosition: item.position },
        })
      )
    );

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Agency positions updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating agency positions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update agency positions',
    };
    return res.status(500).json(response);
  }
});


// ─── Members ─────────────────────────────────────────────────────────────────
// A grant gives a role on the project to one user or to a user group.

// GET /api/projects/:id/members - Grants on this project (viewer and up)
router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const members = await prisma.projectMember.findMany({
      where: { projectId: req.params.id },
      include: {
        user: { select: { id: true, email: true, name: true, status: true } },
        group: { select: { id: true, name: true, _count: { select: { members: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ success: true, data: members });
  } catch (error) {
    console.error('Error fetching project members:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch members' });
  }
});

// GET /api/projects/:id/members/candidates - Users and groups that can be added (owner)
router.get('/:id/members/candidates', async (req: Request, res: Response) => {
  try {
    if (!['admin', 'owner'].includes((await projectRole(req, req.params.id)) || '')) {
      return res.status(403).json({ success: false, error: 'Only the project owner can manage members' });
    }
    const [users, groups] = await Promise.all([
      prisma.user.findMany({
        where: { role: { not: 'admin' }, projectMemberships: { none: { projectId: req.params.id } } },
        select: { id: true, email: true, name: true, status: true },
        orderBy: { name: 'asc' },
      }),
      prisma.userGroup.findMany({
        where: { projectGrants: { none: { projectId: req.params.id } } },
        select: { id: true, name: true, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    return res.json({ success: true, data: { users, groups } });
  } catch (error) {
    console.error('Error fetching member candidates:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// POST /api/projects/:id/members - Grant a role to a user or a group, or change it (owner)
router.post('/:id/members', async (req: Request, res: Response) => {
  try {
    const { userId, groupId, role = 'viewer' } = req.body || {};
    if (!!userId === !!groupId || !MEMBER_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `Give either userId or groupId, and role (${MEMBER_ROLES.join('/')})` });
    }
    const projectId = req.params.id;
    if (userId && !(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (groupId && !(await prisma.userGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }
    const member = userId
      ? await prisma.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } },
          create: { projectId, userId, role },
          update: { role },
        })
      : await prisma.projectMember.upsert({
          where: { projectId_groupId: { projectId, groupId } },
          create: { projectId, groupId, role },
          update: { role },
        });
    return res.json({ success: true, data: member });
  } catch (error) {
    console.error('Error saving project member:', error);
    return res.status(500).json({ success: false, error: 'Failed to save member' });
  }
});

// DELETE /api/projects/:id/members/:memberId - Remove a grant (owner)
router.delete('/:id/members/:memberId', async (req: Request, res: Response) => {
  try {
    await prisma.projectMember.deleteMany({ where: { id: req.params.memberId, projectId: req.params.id } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing project member:', error);
    return res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

export default router;


