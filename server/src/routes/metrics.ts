import { Router, Request, Response } from 'express';
import { projectScope } from '../lib/access';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();
// Every figure counts only runs of projects the user may see (all for admins)

// Helper: Get date range from query
function getDateRange(timeRange: string): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();

  switch (timeRange) {
    case '24h':
      start.setHours(start.getHours() - 24);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    default:
      start.setHours(start.getHours() - 24);
  }

  return { start, end };
}

// Helper: Get time buckets
function getTimeBuckets(start: Date, end: Date, bucketCount: number): Date[] {
  const buckets: Date[] = [];
  const diff = end.getTime() - start.getTime();
  const interval = diff / bucketCount;

  for (let i = 0; i <= bucketCount; i++) {
    buckets.push(new Date(start.getTime() + interval * i));
  }

  return buckets;
}

// GET /api/metrics/overview
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);

    // Get executions in time range
    const executions = await prisma.execution.findMany({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
      },
      select: {
        status: true,
        durationMs: true,
        startedAt: true,
      },
    });

    const total = executions.length;
    const success = executions.filter(e => e.status === 'Completed' || e.status === 'Success').length;
    const failed = executions.filter(e => e.status === 'Failed').length;
    const running = executions.filter(e => e.status === 'Running').length;

    // Calculate throughput (executions per hour)
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720;
    const throughput = total / hours;

    // Calculate avg response time
    const completedExecutions = executions.filter(e => e.durationMs);
    const avgDuration = completedExecutions.length > 0
      ? Math.round(completedExecutions.reduce((sum, e) => sum + (e.durationMs || 0), 0) / completedExecutions.length)
      : 0;

    // Calculate error rate
    const errorRate = total > 0 ? (failed / total) * 100 : 0;

    // Calculate Apdex score (simplified: < 500ms = satisfied, < 2000ms = tolerating)
    const satisfied = completedExecutions.filter(e => (e.durationMs || 0) < 500).length;
    const tolerating = completedExecutions.filter(e => {
      const d = e.durationMs || 0;
      return d >= 500 && d < 2000;
    }).length;
    const apdex = total > 0 
      ? (satisfied + tolerating / 2) / total 
      : 1;

    res.json({
      success: true,
      data: {
        throughput: {
          current: Math.round(throughput * 10) / 10,
          unit: 'req/h',
        },
        avgResponseTime: {
          current: avgDuration,
          unit: 'ms',
        },
        errorRate: {
          current: Math.round(errorRate * 10) / 10,
          unit: '%',
        },
        apdexScore: {
          current: Math.round(apdex * 100) / 100,
          unit: 'score',
        },
        activeExecutions: running,
        total,
        success,
        failed,
      },
    });
  } catch (error) {
    console.error('Error fetching metrics overview:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics' });
  }
});

// GET /api/metrics/throughput
router.get('/throughput', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);
    
    const bucketCount = timeRange === '24h' ? 24 : timeRange === '7d' ? 7 : 30;
    const buckets = getTimeBuckets(start, end, bucketCount);

    const data = [];
    for (let i = 0; i < buckets.length - 1; i++) {
      const count = await prisma.execution.count({
        where: {
          ...(await projectScope(req)),
          startedAt: {
            gte: buckets[i],
            lt: buckets[i + 1],
          },
        },
      });

      data.push({
        time: buckets[i].toISOString(),
        label: timeRange === '24h' 
          ? buckets[i].getHours() + ':00'
          : buckets[i].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value: count,
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching throughput:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch throughput' });
  }
});

// GET /api/metrics/response-time
router.get('/response-time', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);

    const executions = await prisma.execution.findMany({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
        durationMs: {
          not: null,
        },
      },
      select: {
        durationMs: true,
        startedAt: true,
      },
      orderBy: {
        startedAt: 'asc',
      },
    });

    // Calculate percentiles over time windows
    const bucketCount = timeRange === '24h' ? 24 : timeRange === '7d' ? 7 : 30;
    const buckets = getTimeBuckets(start, end, bucketCount);
    
    const data = [];
    for (let i = 0; i < buckets.length - 1; i++) {
      const bucketExecutions = executions.filter(e => 
        e.startedAt >= buckets[i] && e.startedAt < buckets[i + 1]
      );
      
      const durations = bucketExecutions.map(e => e.durationMs || 0).sort((a, b) => a - b);
      
      const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
      const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
      const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

      data.push({
        time: buckets[i].toISOString(),
        label: timeRange === '24h'
          ? buckets[i].getHours() + ':00'
          : buckets[i].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        p50,
        p95,
        p99,
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching response time:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch response time' });
  }
});

// GET /api/metrics/error-distribution
router.get('/error-distribution', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);

    const errors = await prisma.execution.groupBy({
      by: ['errorType'],
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
        status: 'Failed',
      },
      _count: {
        errorType: true,
      },
    });

    const data = errors.map(e => ({
      type: e.errorType || 'unknown',
      count: e._count.errorType,
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching error distribution:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch error distribution' });
  }
});

// GET /api/metrics/top-flows
router.get('/top-flows', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const sortBy = (req.query.sortBy as string) || 'duration'; // 'duration' or 'errors'
    const { start, end } = getDateRange(timeRange);

    const executions = await prisma.execution.findMany({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
      },
      include: {
        flow: {
          select: {
            name: true,
          },
        },
      },
    });

    // Group by flow
    const flowMap = new Map<string, { 
      name: string; 
      total: number; 
      success: number; 
      failed: number;
      totalDuration: number;
    }>();

    executions.forEach(e => {
      // Skip non-flow executions (e.g. repo-imports) — flow metrics don't apply
      if (!e.flowId) return;
      const existing = flowMap.get(e.flowId);
      if (existing) {
        existing.total++;
        if (e.status === 'Completed' || e.status === 'Success') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
        existing.totalDuration += e.durationMs || 0;
      } else {
        flowMap.set(e.flowId, {
          name: e.flow?.name || 'Unknown',
          total: 1,
          success: e.status === 'Completed' || e.status === 'Success' ? 1 : 0,
          failed: e.status === 'Failed' ? 1 : 0,
          totalDuration: e.durationMs || 0,
        });
      }
    });

    let data = Array.from(flowMap.entries()).map(([flowId, stats]) => ({
      flowId,
      flowName: stats.name,
      totalExecutions: stats.total,
      avgDuration: stats.total > 0 ? Math.round(stats.totalDuration / stats.total) : 0,
      errorCount: stats.failed,
      errorRate: stats.total > 0 ? Math.round((stats.failed / stats.total) * 100) : 0,
    }));

    // Sort by criteria
    if (sortBy === 'duration') {
      data = data.sort((a, b) => b.avgDuration - a.avgDuration).slice(0, 10);
    } else {
      data = data.sort((a, b) => b.errorCount - a.errorCount).slice(0, 10);
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching top flows:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch top flows' });
  }
});

// GET /api/metrics/flow-types
router.get('/flow-types', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);

    const executions = await prisma.execution.findMany({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
      },
      include: {
        flow: {
          select: {
            type: true,
          },
        },
      },
    });

    const typeMap = new Map<string, { total: number; success: number; failed: number }>();

    executions.forEach(e => {
      const type = e.flow?.type || 'UNKNOWN';
      const existing = typeMap.get(type);
      if (existing) {
        existing.total++;
        if (e.status === 'Completed' || e.status === 'Success') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
      } else {
        typeMap.set(type, {
          total: 1,
          success: e.status === 'Completed' || e.status === 'Success' ? 1 : 0,
          failed: e.status === 'Failed' ? 1 : 0,
        });
      }
    });

    const data = Array.from(typeMap.entries()).map(([type, stats]) => ({
      type: type === 'API_SPEC' ? 'API Flow' : type === 'TRIGGER' ? 'Event Flow' : type,
      total: stats.total,
      success: stats.success,
      failed: stats.failed,
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching flow types:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch flow types' });
  }
});

// GET /api/metrics/response-time-histogram
router.get('/response-time-histogram', async (req: Request, res: Response) => {
  try {
    const timeRange = (req.query.timeRange as string) || '24h';
    const { start, end } = getDateRange(timeRange);

    const executions = await prisma.execution.findMany({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: start,
          lte: end,
        },
        durationMs: {
          not: null,
        },
      },
      select: {
        durationMs: true,
      },
    });

    const durations = executions.map(e => e.durationMs || 0);
    
    // Define buckets (in ms)
    const buckets = [
      { label: '< 100ms', min: 0, max: 100 },
      { label: '100-300ms', min: 100, max: 300 },
      { label: '300-500ms', min: 300, max: 500 },
      { label: '500ms-1s', min: 500, max: 1000 },
      { label: '1-2s', min: 1000, max: 2000 },
      { label: '2-5s', min: 2000, max: 5000 },
      { label: '> 5s', min: 5000, max: Infinity },
    ];

    const data = buckets.map(bucket => ({
      label: bucket.label,
      count: durations.filter(d => d >= bucket.min && d < bucket.max).length,
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching response time histogram:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch histogram' });
  }
});

// WebSocket endpoint for real-time updates (HTTP polling fallback)
router.get('/realtime', async (req: Request, res: Response) => {
  try {
    const lastMinute = new Date(Date.now() - 60000);
    
    const recentExecutions = await prisma.execution.count({
      where: {
        ...(await projectScope(req)),
        startedAt: {
          gte: lastMinute,
        },
      },
    });

    const runningExecutions = await prisma.execution.count({
      where: {
        ...(await projectScope(req)),
        status: 'Running',
      },
    });

    res.json({
      success: true,
      data: {
        recentCount: recentExecutions,
        runningCount: runningExecutions,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching realtime metrics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch realtime metrics' });
  }
});

export default router;
