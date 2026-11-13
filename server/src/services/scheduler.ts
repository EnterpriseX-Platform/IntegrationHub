// Scheduler Service - Manages cron jobs from `schedulers` table (standalone entity)
// New concept: scheduler is a top-level entity mapped to a flow (no schedule-trigger node needed)
import { schedule, ScheduledTask, validate } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { prisma } from '../lib/prisma';
import { resolveScheduleParameters, parseParametersJson } from '../lib/scheduler-params';
import {
  ExecutionEngine,
  DatabaseExecutor,
  TransformExecutor,
  ConditionExecutor,
  HttpRequestExecutor,
  FileReadExecutor,
  FileWriteExecutor,
  BasketTriggerExecutor,
  SFTPActionExecutor,
  EmailActionExecutor,
  DelayExecutor,
  AggregateSplitExecutor,
  AggregateJoinExecutor,
  ParallelBranchExecutor,
  ForEachExecutor,
  OcrExecutor,
  BasketActionExecutor,
  FileEncryptExecutor,
  FileDecryptExecutor,
} from '../sdk/execution';
import { buildNodeLabelMap, buildNodeLogEntries } from '../sdk/execution/nodeLogFormatter';
import { executionDeadline } from '../lib/execution-progress';

interface ScheduledJob {
  task: ScheduledTask;
  flowId: string;
  schedule: string;
  timezone?: string;
}

interface RunningExecution {
  executionId: string;
  flowId: string;
  startedAt: Date;
}

class SchedulerService {
  private jobs: Map<string, ScheduledJob> = new Map(); // keyed by schedulerId
  private runningExecutions: Map<string, RunningExecution> = new Map();
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('[Scheduler] Already initialized');
      return;
    }
    console.log('[Scheduler] Initializing...');
    try {
      const schedulers = await prisma.scheduler.findMany({
        where: { status: 'Active' },
        include: {
          flow: {
            select: { id: true, name: true, nodes: true, connections: true, projectId: true },
          },
        },
      });
      console.log(`[Scheduler] Found ${schedulers.length} active scheduler(s)`);
      for (const scheduler of schedulers) {
        if (scheduler.flow) {
          await this.scheduleJob(scheduler);
        }
      }
      this.isInitialized = true;
      console.log('[Scheduler] Initialization complete');
    } catch (error) {
      console.error('[Scheduler] Failed to initialize:', error);
      throw error;
    }
  }

  async scheduleJob(scheduler: any): Promise<boolean> {
    const { id, flowId, schedule: cronExpression, timezone, flow, parameters, maxConcurrent } = scheduler;

    if (!validate(cronExpression)) {
      console.error(`[Scheduler] Invalid cron expression: ${cronExpression} for flow ${flowId}`);
      await this.updateSchedulerStatus(id, 'Error', 'Invalid cron expression');
      return false;
    }

    this.stopJob(id);

    try {
      const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;
      const connections = typeof flow.connections === 'string' ? JSON.parse(flow.connections) : flow.connections;

      const schedulerParams = parseParametersJson(parameters);
      const tz = timezone || 'Asia/Bangkok';
      const concurrency = typeof maxConcurrent === 'number' && maxConcurrent > 0 ? maxConcurrent : 1;

      const task = schedule(cronExpression, async () => {
        await this.executeScheduledFlow({
          flowId,
          projectId: flow.projectId,
          flowName: flow.name,
          nodes,
          connections,
          schedulerId: id,
          parameters: schedulerParams,
          timezone: tz,
          maxConcurrent: concurrency,
        });
      }, {
        scheduled: true,
        timezone: tz,
      });

      this.jobs.set(id, { task, flowId, schedule: cronExpression, timezone: tz });

      const nextRun = this.getNextRunTime(cronExpression, tz);
      await this.updateSchedulerStatus(id, 'Active', null, nextRun);

      console.log(`[Scheduler] Scheduled "${scheduler.name || flow.name}" (scheduler=${id}, flow=${flowId}) with cron: ${cronExpression}`);
      return true;
    } catch (error) {
      console.error(`[Scheduler] Failed to schedule job for scheduler ${id}:`, error);
      await this.updateSchedulerStatus(id, 'Error', String(error));
      return false;
    }
  }

  private async executeScheduledFlow(opts: {
    flowId: string;
    projectId: string;
    flowName: string;
    nodes: any[];
    connections: any[];
    schedulerId?: string;
    parameters?: any[];
    timezone?: string;
    maxConcurrent?: number;
  }): Promise<void> {
    const { flowId, projectId, flowName, nodes, connections, schedulerId, parameters, timezone, maxConcurrent: maxConcurrentOpt } = opts;
    console.log(`[Scheduler] Executing scheduled flow: ${flowName} (${flowId})`);

    const runningCount = await prisma.execution.count({ where: { flowId, status: 'Running' } });
    const maxConcurrent = typeof maxConcurrentOpt === 'number' && maxConcurrentOpt > 0
      ? maxConcurrentOpt
      : this.getMaxConcurrentExecutions(nodes);

    if (runningCount >= maxConcurrent) {
      console.log(`[Scheduler] Flow ${flowName} reached max concurrent executions (${maxConcurrent}). Skipping.`);
      await prisma.execution.create({
        data: {
          flowId,
          projectId,
          status: 'Skipped',
          startedAt: new Date(),
          endedAt: new Date(),
          logs: JSON.stringify([{
            timestamp: new Date().toISOString(),
            level: 'warning',
            message: `Execution skipped: Max concurrent executions (${maxConcurrent}) reached`,
          }]),
          result: JSON.stringify({
            success: false, skipped: true, reason: 'Max concurrent executions reached',
            currentRunning: runningCount, maxAllowed: maxConcurrent,
          }),
        },
      });
      return;
    }

    let executionId: string;

    try {
      const execution = await prisma.execution.create({
        data: {
          flowId,
          projectId,
          status: 'Running',
          startedAt: new Date(),
          triggerType: 'schedule',
          callerName: 'Scheduler',
          logs: JSON.stringify([{
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `Starting scheduled flow execution: ${flowName}`,
          }]),
        },
      });

      executionId = execution.id;
      const runKey = schedulerId || flowId;
      this.runningExecutions.set(runKey, { executionId, flowId, startedAt: new Date() });

      const resolvedParams = resolveScheduleParameters(parameters || [], timezone || 'Asia/Bangkok');

      const engine = new ExecutionEngine({
        connections: new Map(),
        deadlineAt: executionDeadline(),
        onLog: (log) => console.log(`[ScheduledExecution] ${log.level}: ${log.message}`),
        middlewares: [
          async (context, next) => {
            for (const [key, value] of Object.entries(resolvedParams)) {
              context.variables.set(key, value);
            }
            context.variables.set('_triggerParams', resolvedParams);
            await next();
          },
        ],
      });

      engine.registerExecutor(new DatabaseExecutor());
      engine.registerExecutor(new TransformExecutor());
      engine.registerExecutor(new ConditionExecutor());
      engine.registerExecutor(new HttpRequestExecutor());
      engine.registerExecutor(new FileReadExecutor());
      engine.registerExecutor(new FileWriteExecutor());
      engine.registerExecutor(new BasketTriggerExecutor());
      engine.registerExecutor(new SFTPActionExecutor());
      engine.registerExecutor(new EmailActionExecutor());
      engine.registerExecutor(new DelayExecutor());
      engine.registerExecutor(new ForEachExecutor());
      engine.registerExecutor(new OcrExecutor());
      engine.registerExecutor(new BasketActionExecutor());
      engine.registerExecutor(new AggregateSplitExecutor());
      engine.registerExecutor(new AggregateJoinExecutor());
      engine.registerExecutor(new ParallelBranchExecutor());
      engine.registerExecutor(new FileEncryptExecutor());
      engine.registerExecutor(new FileDecryptExecutor());

      const processedNodes = this.processAggregateNodes(nodes);
      const edges = connections.map((conn: any, idx: number) => ({
        id: conn.id || `edge-${idx}`,
        source: conn.source,
        target: conn.target,
        label: conn.label,
      }));

      const flowDef = { operationId: flowId, nodes: processedNodes, edges };

      const result = await engine.execute(flowDef, {
        method: 'SCHEDULED',
        path: '/scheduled',
        headers: {},
        body: resolvedParams,
        params: resolvedParams,
      });

      // Rich per-node logs (label, duration, summary, error, aggregate sub-results)
      const flowNodes = typeof flowDef.nodes === 'string' ? JSON.parse(flowDef.nodes) : flowDef.nodes;
      const labelMap = buildNodeLabelMap(flowNodes);
      const execLogs: any[] = [];
      for (const nr of result.metadata.nodeResults) {
        execLogs.push(...buildNodeLogEntries(nr, labelMap.get(nr.nodeId)));
      }

      await prisma.execution.update({
        where: { id: executionId },
        data: {
          status: result.success ? 'Completed' : 'Failed',
          endedAt: new Date(),
          logs: JSON.stringify([
            { timestamp: new Date().toISOString(), level: 'info', message: `Starting scheduled flow execution: ${flowName}` },
            ...execLogs,
            {
              timestamp: new Date().toISOString(),
              level: result.success ? 'success' : 'error',
              message: result.success ? 'Flow execution completed successfully' : `Failed: ${result.error}`,
            },
          ]),
          result: JSON.stringify({
            success: result.success,
            duration: `${result.metadata.durationMs}ms`,
            data: result.data,
            nodeCount: result.metadata.nodeResults.length,
            successCount: result.metadata.nodeResults.filter((nr: any) => nr.success).length,
            failedCount: result.metadata.nodeResults.filter((nr: any) => !nr.success).length,
          }),
        },
      });

      if (schedulerId) {
        await this.updateLastRun(flowId, schedulerId);
      }

      console.log(`[Scheduler] Flow "${flowName}" execution completed: ${result.success ? 'success' : 'failed'}`);
    } catch (error) {
      console.error(`[Scheduler] Flow execution failed: ${flowName}`, error);
      if (executionId!) {
        await prisma.execution.update({
          where: { id: executionId },
          data: {
            status: 'Failed',
            endedAt: new Date(),
            error: (error as Error).message,
            logs: JSON.stringify([{
              timestamp: new Date().toISOString(),
              level: 'error',
              message: `Execution failed: ${(error as Error).message}`,
            }]),
            result: JSON.stringify({ success: false, error: (error as Error).message }),
          },
        });
      } else {
        await prisma.execution.create({
          data: {
            flowId,
            projectId,
            status: 'Failed',
            startedAt: new Date(),
            endedAt: new Date(),
            logs: JSON.stringify([{
              timestamp: new Date().toISOString(),
              level: 'error',
              message: `Execution failed: ${(error as Error).message}`,
            }]),
            result: JSON.stringify({ success: false, error: (error as Error).message }),
          },
        });
      }
    } finally {
      this.runningExecutions.delete(schedulerId || flowId);
    }
  }

  private processAggregateNodes(nodes: any[]): any[] {
    return nodes.map(node => {
      if (node.type === 'aggregate-split' || node.data?.aggregateType === 'fan-out') {
        return {
          ...node,
          type: 'aggregate-split',
          data: {
            ...node.data,
            __isAggregate: true,
            __aggregateType: 'fan-out',
            branches: node.data?.branches || 2,
            strategy: node.data?.strategy || 'parallel',
          },
        };
      }
      if (node.type === 'aggregate-join' || node.data?.aggregateType === 'fan-in') {
        return {
          ...node,
          type: 'aggregate-join',
          data: {
            ...node.data,
            __isAggregate: true,
            __aggregateType: 'fan-in',
            waitFor: node.data?.waitFor || 'all',
            timeout: node.data?.timeout || 30000,
          },
        };
      }
      return node;
    });
  }

  private getMaxConcurrentExecutions(nodes: any[]): number {
    const scheduleNode = nodes.find(n => n.type === 'schedule-trigger');
    if (scheduleNode?.data?.maxConcurrent) {
      return parseInt(scheduleNode.data.maxConcurrent, 10) || 1;
    }
    return 1;
  }

  stopJob(schedulerId: string): boolean {
    const job = this.jobs.get(schedulerId);
    if (job) {
      job.task.stop();
      this.jobs.delete(schedulerId);
      console.log(`[Scheduler] Stopped job: ${schedulerId}`);
      return true;
    }
    return false;
  }

  stopAllJobs(): void {
    console.log(`[Scheduler] Stopping all ${this.jobs.size} job(s)`);
    for (const [schedulerId, job] of this.jobs) {
      job.task.stop();
      console.log(`[Scheduler] Stopped job: ${schedulerId}`);
    }
    this.jobs.clear();
    this.isInitialized = false;
  }

  async createScheduler(opts: {
    flowId: string;
    projectId?: string;
    name?: string;
    schedule: string;
    timezone?: string;
    parameters?: any[];
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<any> {
    const { flowId, projectId, name, schedule: cronExpression, timezone, parameters, maxConcurrent, enabled } = opts;

    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      select: { id: true, name: true, projectId: true, nodes: true, connections: true },
    });
    if (!flow) throw new Error(`Flow not found: ${flowId}`);

    const status = enabled === false ? 'Inactive' : 'Active';
    const nextRun = enabled === false ? null : this.getNextRunTime(cronExpression, timezone || 'Asia/Bangkok');

    const created = await prisma.scheduler.create({
      data: {
        flowId,
        projectId: projectId || flow.projectId,
        name: name || flow.name || null,
        type: 'cron',
        schedule: cronExpression,
        timezone: timezone || 'Asia/Bangkok',
        status,
        parameters: JSON.stringify(parameters || []),
        maxConcurrent: typeof maxConcurrent === 'number' && maxConcurrent > 0 ? maxConcurrent : 1,
        nextRun,
      },
    });

    if (status === 'Active') {
      await this.scheduleJob({ ...created, flow });
    }

    return created;
  }

  async updateScheduler(schedulerId: string, opts: {
    name?: string;
    schedule?: string;
    timezone?: string;
    parameters?: any[];
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<any> {
    const existing = await prisma.scheduler.findUnique({ where: { id: schedulerId } });
    if (!existing) throw new Error(`Scheduler not found: ${schedulerId}`);

    const data: any = { updatedAt: new Date() };
    if (opts.name !== undefined) data.name = opts.name;
    if (opts.schedule !== undefined) data.schedule = opts.schedule;
    if (opts.timezone !== undefined) data.timezone = opts.timezone;
    if (opts.parameters !== undefined) data.parameters = JSON.stringify(opts.parameters);
    if (opts.maxConcurrent !== undefined && opts.maxConcurrent > 0) data.maxConcurrent = opts.maxConcurrent;
    if (opts.enabled !== undefined) {
      data.status = opts.enabled ? 'Active' : 'Inactive';
      data.nextRun = opts.enabled ? this.getNextRunTime(opts.schedule || existing.schedule, opts.timezone || existing.timezone) : null;
    }

    const updated = await prisma.scheduler.update({ where: { id: schedulerId }, data });

    this.stopJob(schedulerId);
    if (updated.status === 'Active') {
      const flow = await prisma.flow.findUnique({
        where: { id: updated.flowId },
        select: { id: true, name: true, projectId: true, nodes: true, connections: true },
      });
      if (flow) await this.scheduleJob({ ...updated, flow });
    }

    return updated;
  }

  /**
   * Legacy: Create or update scheduler by flowId (kept for backward compat).
   * @deprecated Use createScheduler() / updateScheduler() instead.
   */
  async createOrUpdateScheduler(
    flowId: string,
    projectId: string,
    cronExpression: string,
    timezone: string = 'Asia/Bangkok',
    enabled: boolean = true
  ): Promise<any> {
    const existing = await prisma.scheduler.findFirst({ where: { flowId } });
    if (existing) {
      return this.updateScheduler(existing.id, { schedule: cronExpression, timezone, enabled });
    }
    return this.createScheduler({ flowId, projectId, schedule: cronExpression, timezone, enabled });
  }

  async deleteSchedulerById(schedulerId: string): Promise<boolean> {
    try {
      this.stopJob(schedulerId);
      await prisma.scheduler.delete({ where: { id: schedulerId } });
      console.log(`[Scheduler] Deleted scheduler: ${schedulerId}`);
      return true;
    } catch (error) {
      console.error('[Scheduler] Failed to delete scheduler:', error);
      return false;
    }
  }

  /**
   * Legacy alias. Delete all schedulers for a flow.
   * @deprecated
   */
  async deleteScheduler(flowId: string): Promise<boolean> {
    try {
      const rows = await prisma.scheduler.findMany({ where: { flowId }, select: { id: true } });
      for (const r of rows) this.stopJob(r.id);
      await prisma.scheduler.deleteMany({ where: { flowId } });
      console.log(`[Scheduler] Deleted ${rows.length} scheduler(s) for flow: ${flowId}`);
      return true;
    } catch (error) {
      console.error('[Scheduler] Failed to delete scheduler:', error);
      return false;
    }
  }

  private async updateSchedulerStatus(
    schedulerId: string,
    status: string,
    errorMessage: string | null,
    nextRun?: Date | null
  ): Promise<void> {
    try {
      await prisma.scheduler.update({
        where: { id: schedulerId },
        data: {
          status,
          errorMessage: errorMessage || undefined,
          nextRun: nextRun || undefined,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('[Scheduler] Failed to update scheduler status:', error);
    }
  }

  private async updateLastRun(_flowId: string, schedulerId: string): Promise<void> {
    try {
      const scheduler = await prisma.scheduler.findUnique({ where: { id: schedulerId } });
      if (scheduler) {
        const nextRun = this.getNextRunTime(scheduler.schedule, scheduler.timezone);
        await prisma.scheduler.update({
          where: { id: schedulerId },
          data: { lastRun: new Date(), nextRun, updatedAt: new Date() },
        });
      }
    } catch (error) {
      console.error('[Scheduler] Failed to update last run:', error);
    }
  }

  private getNextRunTime(cronExpression: string, timezone: string = 'Asia/Bangkok'): Date {
    try {
      const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
      return interval.next().toDate();
    } catch {
      const now = new Date();
      return new Date(now.getTime() + 60 * 60 * 1000);
    }
  }

  getActiveJobs(): { schedulerId: string; flowId: string; schedule: string; timezone?: string }[] {
    return Array.from(this.jobs.entries()).map(([schedulerId, job]) => ({
      schedulerId,
      flowId: job.flowId,
      schedule: job.schedule,
      timezone: job.timezone,
    }));
  }

  hasScheduledJob(schedulerId: string): boolean {
    return this.jobs.has(schedulerId);
  }

  getRunningExecutions(): RunningExecution[] {
    return Array.from(this.runningExecutions.values());
  }
}

export const schedulerService = new SchedulerService();
