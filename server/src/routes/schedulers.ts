// Scheduler Routes - API endpoints for managing schedulers (new concept: standalone entity)
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { schedulerService } from '../services/scheduler';
import { executionDeadline } from '../lib/execution-progress';
import { guardProject, projectScope, projectRole, roleAllows, adminOnly } from '../lib/access';

const router = Router();

// Non-admins only see schedulers of their projects; changing or running one needs editor
router.param('id', guardProject(async (id) => {
  const s = await prisma.scheduler.findUnique({ where: { id }, select: { projectId: true } });
  return s?.projectId || null;
}));
router.param('flowId', guardProject(async (flowId) => {
  const f = await prisma.flow.findUnique({ where: { id: flowId }, select: { projectId: true } });
  return f?.projectId || null;
}));

// Helper: parse parameters JSON safely
function parseParams(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

// Serialize a scheduler row to API response shape
function serializeScheduler(s: any, execs: any[] = []) {
  return {
    id: s.id,
    flowId: s.flowId,
    flowName: s.flow?.name,
    flowStatus: s.flow?.status,
    // Tags + the flow's displayOrder come from the underlying flow so the
    // Schedulers page can group by tag exactly like the Tasks page. Retagging
    // a scheduler updates the flow's tags (single source of truth).
    flowTags: s.flow?.tags ?? '[]',
    flowDisplayOrder: s.flow?.displayOrder ?? 0,
    projectId: s.projectId,
    projectName: s.project?.name,
    name: s.name,
    schedule: s.schedule,
    timezone: s.timezone,
    status: s.status,
    enabled: s.status === 'Active',
    displayOrder: s.displayOrder,
    parameters: parseParams(s.parameters),
    maxConcurrent: s.maxConcurrent ?? 1,
    lastRun: s.lastRun,
    nextRun: s.nextRun,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    isRunning: schedulerService.hasScheduledJob(s.id),
    executions: execs,
  };
}

// GET /api/schedulers/overview - Get all scheduler data for the overview page (single request)
router.get('/overview', async (req: Request, res: Response): Promise<Response> => {
  try {
    const scope = await projectScope(req);
    const projects = await prisma.project.findMany({
      where: await projectScope(req, 'id'),
      select: { id: true, name: true, color: true, position: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    });

    const schedulers = await prisma.scheduler.findMany({
      where: scope,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        flow: { select: { id: true, name: true, status: true, tags: true, displayOrder: true } },
        project: { select: { id: true, name: true, color: true } },
      },
    });

    const flowIds = [...new Set(schedulers.map(s => s.flowId))];
    const executions: any[] = flowIds.length > 0
      ? await prisma.$queryRaw`
          SELECT e.id, e."flowId", e.status, e."startedAt", e."endedAt", e."durationMs", e.error, e."triggerType"
          FROM executions e
          WHERE e."flowId" = ANY(${flowIds})
          ORDER BY e."startedAt" DESC
        `
      : [];

    const execByFlow: Record<string, any[]> = {};
    for (const exec of executions) {
      if (!execByFlow[exec.flowId]) execByFlow[exec.flowId] = [];
      if (execByFlow[exec.flowId].length < 20) execByFlow[exec.flowId].push(exec);
    }

    const data = {
      projects,
      schedulers: schedulers.map(s => serializeScheduler(s, execByFlow[s.flowId] || [])),
    };

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching scheduler overview:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch scheduler overview' });
  }
});

// GET /api/schedulers/available-flows - List flows that can have a scheduler attached
// Returns flows with full project context (group/agency/color) for hierarchical picker
// ?all=true returns ALL flows (not just trigger/event) — used by Run Flow page
router.get('/available-flows', async (req: Request, res: Response): Promise<Response> => {
  try {
    const showAll = req.query.all === 'true';
    // Case-insensitive type match so flows stored as 'TRIGGER'/'Scheduled'/etc.
    // (created via different code paths) still appear, not just lowercase ones.
    const where = showAll
      ? {}
      : { OR: ['trigger', 'event', 'scheduled'].map(t => ({ type: { equals: t, mode: 'insensitive' as const } })) };
    const flows = await prisma.flow.findMany({
      where: { ...where, ...(await projectScope(req)) },
      select: {
        id: true, name: true, description: true, projectId: true, status: true, type: true,
        displayOrder: true, config: true,
        // tags is the JSON-string tag array — needed by the Tasks page so the
        // tag groups + drag-drop retag survive a reload. Without it the FE
        // sees every flow as tags=undefined and the optimistic UI silently
        // reverts on the next refresh.
        tags: true,
        project: {
          select: {
            id: true, name: true, color: true, status: true,
            projectGroup: true, agency: true,
            groupPosition: true, agencyPosition: true, position: true,
          },
        },
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    });
    return res.json({ success: true, data: flows });
  } catch (error) {
    console.error('Error fetching available flows:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch flows' });
  }
});

// GET /api/schedulers/by-flow/:flowId - List schedulers for a specific flow
router.get('/by-flow/:flowId', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { flowId } = req.params;
    const schedulers = await prisma.scheduler.findMany({
      where: { flowId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        flow: { select: { id: true, name: true, status: true, tags: true, displayOrder: true } },
        project: { select: { id: true, name: true } },
      },
    });
    return res.json({ success: true, data: schedulers.map(s => serializeScheduler(s)) });
  } catch (error) {
    console.error('Error fetching schedulers by flow:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch schedulers' });
  }
});

// GET /api/schedulers - List all schedulers
router.get('/', async (req: Request, res: Response): Promise<Response> => {
  try {
    const schedulers = await prisma.scheduler.findMany({
      where: await projectScope(req),
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        flow: { select: { id: true, name: true, status: true, tags: true, displayOrder: true } },
        project: { select: { id: true, name: true } },
      },
    });
    return res.json({ success: true, data: schedulers.map(s => serializeScheduler(s)) });
  } catch (error) {
    console.error('Error fetching schedulers:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch schedulers' });
  }
});

// GET /api/schedulers/:id - Get scheduler details
router.get('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const scheduler = await prisma.scheduler.findUnique({
      where: { id },
      include: {
        flow: { select: { id: true, name: true, status: true, nodes: true, connections: true } },
        project: { select: { id: true, name: true } },
      },
    });

    if (!scheduler) {
      return res.status(404).json({ success: false, error: 'Scheduler not found' });
    }

    return res.json({ success: true, data: serializeScheduler(scheduler) });
  } catch (error) {
    console.error('Error fetching scheduler:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch scheduler' });
  }
});

// POST /api/schedulers - Create new scheduler
router.post('/', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { flowId, projectId, name, schedule, timezone, parameters, maxConcurrent, enabled } = req.body;
    const flowProject = flowId ? (await prisma.flow.findUnique({ where: { id: flowId }, select: { projectId: true } }))?.projectId : null;
    for (const pid of [projectId, flowProject].filter(Boolean) as string[]) {
      if (!roleAllows(await projectRole(req, pid), 'editor')) {
        return res.status(403).json({ success: false, error: 'You do not have access to this project' });
      }
    }

    if (!flowId || !schedule) {
      return res.status(400).json({ success: false, error: 'flowId and schedule are required' });
    }

    const created = await schedulerService.createScheduler({
      flowId,
      projectId,
      name,
      schedule,
      timezone,
      parameters: parseParams(parameters),
      maxConcurrent,
      enabled,
    });

    const withRelations = await prisma.scheduler.findUnique({
      where: { id: created.id },
      include: {
        flow: { select: { id: true, name: true, status: true, tags: true, displayOrder: true } },
        project: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({
      success: true,
      data: serializeScheduler(withRelations),
      message: 'Scheduler created successfully',
    });
  } catch (error: any) {
    console.error('Error creating scheduler:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to create scheduler' });
  }
});

// PUT /api/schedulers/:id - Update scheduler
router.put('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { name, schedule, timezone, parameters, maxConcurrent, status, enabled } = req.body;

    const existing = await prisma.scheduler.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Scheduler not found' });
    }

    const opts: any = {};
    if (name !== undefined) opts.name = name;
    if (schedule !== undefined) opts.schedule = schedule;
    if (timezone !== undefined) opts.timezone = timezone;
    if (parameters !== undefined) opts.parameters = parseParams(parameters);
    if (maxConcurrent !== undefined) opts.maxConcurrent = maxConcurrent;
    if (enabled !== undefined) opts.enabled = enabled;
    else if (status !== undefined) opts.enabled = status === 'Active';

    const updated = await schedulerService.updateScheduler(id, opts);

    const withRelations = await prisma.scheduler.findUnique({
      where: { id: updated.id },
      include: {
        flow: { select: { id: true, name: true, status: true, tags: true, displayOrder: true } },
        project: { select: { id: true, name: true } },
      },
    });

    return res.json({
      success: true,
      data: serializeScheduler(withRelations),
      message: 'Scheduler updated successfully',
    });
  } catch (error: any) {
    console.error('Error updating scheduler:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to update scheduler' });
  }
});

// DELETE /api/schedulers/:id - Delete scheduler
router.delete('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const existing = await prisma.scheduler.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Scheduler not found' });
    }
    await schedulerService.deleteSchedulerById(id);
    return res.json({ success: true, message: 'Scheduler deleted successfully' });
  } catch (error) {
    console.error('Error deleting scheduler:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete scheduler' });
  }
});

// POST /api/schedulers/:id/toggle - Toggle scheduler on/off
router.post('/:id/toggle', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const existing = await prisma.scheduler.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Scheduler not found' });
    }
    const newEnabled = existing.status !== 'Active';
    const updated = await schedulerService.updateScheduler(id, { enabled: newEnabled });
    return res.json({
      success: true,
      data: serializeScheduler(updated),
      message: `Scheduler ${newEnabled ? 'enabled' : 'disabled'} successfully`,
    });
  } catch (error: any) {
    console.error('Error toggling scheduler:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to toggle scheduler' });
  }
});

// POST /api/schedulers/:id/run-now - Run scheduler immediately with its configured parameters
router.post('/:id/run-now', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { parameters: overrideParams } = req.body || {};

    const scheduler = await prisma.scheduler.findUnique({
      where: { id },
      include: {
        flow: { select: { id: true, name: true, nodes: true, connections: true, projectId: true } },
      },
    });
    if (!scheduler || !scheduler.flow) {
      return res.status(404).json({ success: false, error: 'Scheduler or associated flow not found' });
    }

    const { resolveScheduleParameters } = await import('../lib/scheduler-params');
    const baseParams = resolveScheduleParameters(parseParams(scheduler.parameters), scheduler.timezone);
    const finalParams = { ...baseParams, ...(overrideParams || {}) };

    const { ExecutionEngine,
      DatabaseExecutor, TransformExecutor, ConditionExecutor, HttpRequestExecutor,
      FileReadExecutor, FileWriteExecutor, BasketTriggerExecutor, SFTPActionExecutor,
      DelayExecutor, ForEachExecutor, OcrExecutor,
      BasketActionExecutor, AggregateSplitExecutor, AggregateJoinExecutor,
      ParallelBranchExecutor, FileEncryptExecutor, FileDecryptExecutor, EmailActionExecutor,
    } = await import('../sdk/execution');

    const nodes = typeof scheduler.flow.nodes === 'string' ? JSON.parse(scheduler.flow.nodes) : scheduler.flow.nodes;
    const connections = typeof scheduler.flow.connections === 'string' ? JSON.parse(scheduler.flow.connections) : scheduler.flow.connections;

    const execution = await prisma.execution.create({
      data: {
        flowId: scheduler.flow.id,
        projectId: scheduler.flow.projectId,
        status: 'Running',
        startedAt: new Date(),
        triggerType: 'manual',
        callerName: 'Scheduler (Run Now)',
        logs: JSON.stringify([{ timestamp: new Date().toISOString(), level: 'info', message: `Manual run from scheduler: ${scheduler.name || scheduler.flow.name}` }]),
      },
    });

    // Execute async
    (async () => {
      try {
        const engine = new ExecutionEngine({
          connections: new Map(),
          deadlineAt: executionDeadline(),
          onLog: (log) => console.log(`[ScheduledManual] ${log.level}: ${log.message}`),
          middlewares: [
            async (ctx, next) => {
              for (const [k, v] of Object.entries(finalParams)) ctx.variables.set(k, v);
              ctx.variables.set('_triggerParams', finalParams);
              await next();
            },
          ],
        });
        for (const E of [DatabaseExecutor, TransformExecutor, ConditionExecutor, HttpRequestExecutor,
          FileReadExecutor, FileWriteExecutor, BasketTriggerExecutor, SFTPActionExecutor,
          DelayExecutor, ForEachExecutor, OcrExecutor,
          BasketActionExecutor, AggregateSplitExecutor, AggregateJoinExecutor,
          ParallelBranchExecutor, FileEncryptExecutor, FileDecryptExecutor, EmailActionExecutor]) {
          engine.registerExecutor(new (E as any)());
        }

        const edges = connections.map((c: any, i: number) => ({ id: c.id || `e-${i}`, source: c.source, target: c.target, label: c.label }));
        const result = await engine.execute({ operationId: scheduler.flow!.id, nodes, edges }, {
          method: 'MANUAL', path: '/manual', headers: {}, body: finalParams, params: finalParams,
        });

        await prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: result.success ? 'Completed' : 'Failed',
            endedAt: new Date(),
            result: JSON.stringify({ success: result.success, duration: `${result.metadata.durationMs}ms`, data: result.data, error: result.error }),
          },
        });
      } catch (err: any) {
        await prisma.execution.update({
          where: { id: execution.id },
          data: { status: 'Failed', endedAt: new Date(), result: JSON.stringify({ success: false, error: err.message }) },
        });
      }
    })();

    return res.json({ success: true, data: { executionId: execution.id, parameters: finalParams }, message: 'Flow execution started' });
  } catch (error: any) {
    console.error('Error running scheduler manually:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to run scheduler' });
  }
});

// GET /api/schedulers/status/active-jobs - Get active jobs from scheduler service
router.get('/status/active-jobs', async (_req: Request, res: Response): Promise<Response> => {
  try {
    return res.json({ success: true, data: schedulerService.getActiveJobs() });
  } catch (error) {
    console.error('Error fetching active jobs:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch active jobs' });
  }
});

// POST /api/schedulers/position - Update scheduler positions within project
router.post('/position', adminOnly, async (req: Request, res: Response): Promise<Response> => {
  try {
    const { positions } = req.body;
    if (!Array.isArray(positions) || positions.length === 0) {
      return res.status(400).json({ success: false, error: 'Positions array is required' });
    }
    await prisma.$transaction(
      positions.map((item: { schedulerId: string; position: number }) =>
        prisma.scheduler.update({ where: { id: item.schedulerId }, data: { displayOrder: item.position } })
      )
    );
    return res.json({ success: true, message: 'Scheduler positions updated successfully' });
  } catch (error) {
    console.error('Error updating scheduler positions:', error);
    return res.status(500).json({ success: false, error: 'Failed to update scheduler positions' });
  }
});

export default router;
