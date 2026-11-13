import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponseWrapper, Execution, ExecutionLog } from '../types';
import { guardProject, visibleProjectIds, projectRole, roleAllows } from '../lib/access';

const router = Router();

// Non-admins only see runs of projects they belong to
router.param('id', guardProject(async (execId) => {
  const e = await prisma.execution.findUnique({ where: { id: execId }, select: { projectId: true } });
  return e?.projectId || null;
}));
router.param('flowId', guardProject(async (flowId) => {
  const f = await prisma.flow.findUnique({ where: { id: flowId }, select: { projectId: true } });
  return f?.projectId || null;
}));

// GET /api/executions - List all executions with pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId, status, flowId, page = '1', limit = '20' } = req.query;
    
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    // Build filter conditions
    const where: any = {};
    
    if (projectId) {
      where.projectId = projectId as string;
    }
    const visible = await visibleProjectIds(req);
    if (visible) where.projectId = projectId ? (visible.includes(projectId as string) ? projectId : '__none__') : { in: visible };

    if (status) {
      where.status = status as string;
    }

    if (flowId) {
      where.flowId = flowId as string;
    }

    // Get total count for pagination
    const totalCount = await prisma.execution.count({ where });

    // Get executions with pagination (exclude heavy fields: result, output, logs, input)
    const executions = await prisma.execution.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip,
      take: limitNum,
      select: {
        id: true,
        flowId: true,
        projectId: true,
        sourceType: true,
        sourceId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        httpStatusCode: true,
        errorType: true,
        responseSize: true,
        error: true,
        triggerType: true,
        callerName: true,
        flow: {
          select: {
            id: true,
            name: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
      },
    });

    // Enrich repo-import executions with the source RepoTable's name so the
    // FE can show "Repo Import: tableName" without a second round-trip.
    const repoImportIds = executions
      .filter(e => e.sourceType === 'repo-import' && e.sourceId)
      .map(e => e.sourceId as string);
    let repoTablesById: Record<string, { id: string; name: string }> = {};
    if (repoImportIds.length > 0) {
      const tables = await prisma.repoTable.findMany({
        where: { id: { in: repoImportIds } },
        select: { id: true, name: true },
      });
      repoTablesById = Object.fromEntries(tables.map(t => [t.id, t]));
    }
    const enriched = executions.map(e =>
      e.sourceType === 'repo-import' && e.sourceId
        ? { ...e, repoTable: repoTablesById[e.sourceId] || null }
        : e
    );

    const response: ApiResponseWrapper<{
      executions: typeof enriched;
      pagination: {
        page: number;
        limit: number;
        totalCount: number;
        totalPages: number;
      };
    }> = {
      success: true,
      data: {
        executions: enriched,
        pagination: {
          page: pageNum,
          limit: limitNum,
          totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching executions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch executions',
    };
    return res.status(500).json(response);
  }
});

// ─── รายงานประวัติการเชื่อมโยงข้อมูล (data-linkage history report) ────────────
// GET /int/executions/export — the Export button on the Executions page.
// Mirrors whatever the operator is looking at: same time range, same project.

const REPORT_RANGES: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Thai status wording used in the printed report. */
function thaiStatus(status: string): string {
  switch ((status || '').toLowerCase()) {
    case 'completed':
    case 'success': return 'สำเร็จ';
    case 'failed': return 'ไม่สำเร็จ';
    case 'running': return 'กำลังทำงาน';
    case 'skipped': return 'ข้าม';
    case 'terminated': return 'ยกเลิก';
    default: return status || '-';
  }
}

/**
 * ประเภทการเชื่อมโยง — how the data actually moved, read off the flow graph
 * rather than `flow.type` (which describes how the flow is *triggered*, so
 * every partner API API pull would otherwise read as "scheduled").
 * An http-request wins over a file node: the partner API ZIP download calls the
 * API and only then parks the payload in a basket.
 */
const API_NODES = new Set(['http-request', 'api-input', 'api-output']);
const FILE_NODES = new Set(['sftp-action', 'file-read', 'file-write']);

function linkKind(flow: { type: string; nodes: string } | undefined): 'API' | 'File' {
  if (!flow) return 'File';
  let types: string[] = [];
  try {
    const parsed = JSON.parse(flow.nodes || '[]');
    if (Array.isArray(parsed)) types = parsed.map((n: any) => String(n?.type || ''));
  } catch { /* malformed graph — fall through to flow.type */ }
  if (types.some(t => API_NODES.has(t))) return 'API';
  if (types.some(t => FILE_NODES.has(t))) return 'File';
  return (flow.type || '').toUpperCase() === 'API_SPEC' ? 'API' : 'File';
}

/** Buddhist-era date parts in Asia/Bangkok, independent of the server's TZ. */
function bangkokParts(d: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
}

function thaiDate(d: Date): string {
  const p = bangkokParts(d);
  return `${p.day}/${p.month}/${Number(p.year) + 543}`;
}

function thaiDateTime(d: Date): string {
  const p = bangkokParts(d);
  return `${p.day}/${p.month}/${Number(p.year) + 543} ${p.hour}.${p.minute} น.`;
}

router.get('/export', async (req: Request, res: Response) => {
  try {
    const format = ((req.query.format as string) || 'xlsx').toLowerCase();
    if (format !== 'xlsx' && format !== 'csv') {
      return res.status(400).json({ success: false, error: 'format must be xlsx or csv' });
    }

    const range = (req.query.range as string) || '7d';
    const where: any = {};
    if (range !== 'all') {
      const span = REPORT_RANGES[range];
      if (!span) {
        return res.status(400).json({
          success: false,
          error: `range must be one of ${Object.keys(REPORT_RANGES).join(', ')} or all`,
        });
      }
      where.startedAt = { gte: new Date(Date.now() - span) };
    }
    if (req.query.projectId) where.projectId = req.query.projectId as string;
    const visible = await visibleProjectIds(req);
    if (visible) where.projectId = where.projectId ? (visible.includes(where.projectId) ? where.projectId : '__none__') : { in: visible };
    if (req.query.status) where.status = req.query.status as string;

    const executions = await prisma.execution.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        flowId: true,
        flow: { select: { id: true, name: true } },
        project: { select: { name: true, agency: true } },
      },
    });

    // Flow graphs are fetched once per flow, not once per execution — `nodes`
    // is the heaviest column on the table and a report repeats flows a lot.
    const flowIds = [...new Set(executions.map(e => e.flowId).filter(Boolean))] as string[];
    const flows = flowIds.length
      ? await prisma.flow.findMany({
          where: { id: { in: flowIds } },
          select: { id: true, type: true, nodes: true },
        })
      : [];
    const kindByFlow = new Map(flows.map(f => [f.id, linkKind(f)]));

    const rows = executions.map((e, i) => ({
      order: i + 1,
      name: e.flow?.name || '(ไม่ระบุ)',
      date: thaiDate(e.startedAt),
      status: thaiStatus(e.status),
      agency: e.project?.agency || e.project?.name || '-',
      kind: (e.flowId && kindByFlow.get(e.flowId)) || 'File',
    }));

    const rawPrinter = (req.headers['x-user-name'] as string) || '';
    let printedBy = '';
    if (rawPrinter) {
      try { printedBy = decodeURIComponent(rawPrinter); }
      catch { printedBy = rawPrinter; }
    }

    const TITLE = 'รายงานประวัติการเชื่อมโยงข้อมูล';
    const HEADERS = ['ลำดับ', 'รายชื่อการเชื่อมโยง', 'วันที่เชื่อมโยง', 'สถานะ', 'หน่วยงาน', 'ประเภท'];
    const printedAt = thaiDateTime(new Date());
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const esc = (v: any) => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="data-linkage-report-${stamp}.csv"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.write('﻿'); // BOM so Excel reads the Thai as UTF-8
      res.write(`${esc(TITLE)}\n`);
      res.write(`${esc('วันที่: ' + printedAt)}\n`);
      res.write(`${esc('ผู้พิมพ์: ' + printedBy)}\n\n`);
      res.write(HEADERS.map(esc).join(',') + '\n');
      for (const r of rows) {
        res.write([r.order, r.name, r.date, r.status, r.agency, r.kind].map(esc).join(',') + '\n');
      }
      return res.end();
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('รายงานการเชื่อมโยง');
    ws.columns = [
      { width: 8 }, { width: 55 }, { width: 16 }, { width: 12 }, { width: 34 }, { width: 10 },
    ];

    ws.mergeCells('A1:F1');
    const title = ws.getCell('A1');
    title.value = TITLE;
    title.font = { bold: true, size: 16 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    const stampCell = (row: number, text: string) => {
      ws.mergeCells(`D${row}:F${row}`);
      const c = ws.getCell(`D${row}`);
      c.value = text;
      c.font = { bold: true, size: 10 };
      c.alignment = { horizontal: 'right' };
    };
    stampCell(3, `วันที่: ${printedAt}`);
    stampCell(4, `ผู้พิมพ์: ${printedBy}`);

    const border = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };

    const headerRow = ws.getRow(6);
    HEADERS.forEach((h, i) => {
      const c = headerRow.getCell(i + 1);
      c.value = h;
      c.font = { bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      c.border = border;
    });
    headerRow.height = 22;
    headerRow.commit();

    rows.forEach((r, i) => {
      const row = ws.getRow(7 + i);
      const values = [r.order, r.name, r.date, r.status, r.agency, r.kind];
      values.forEach((v, c) => {
        const cell = row.getCell(c + 1);
        cell.value = v;
        cell.border = border;
        // Only the linkage name reads as prose; everything else is a code or a
        // date and sits better centred, matching the printed form.
        cell.alignment = c === 1
          ? { horizontal: 'left', vertical: 'middle', wrapText: true }
          : { horizontal: 'center', vertical: 'middle' };
      });
      row.commit();
    });

    // Repeat the title + column headers on every printed page.
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.views = [{ state: 'frozen', ySplit: 6 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="data-linkage-report-${stamp}.xlsx"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await wb.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('Error exporting execution report:', error);
    return res.status(500).json({ success: false, error: 'Failed to export report' });
  }
});

// GET /api/executions/:id/logs - Get execution logs
router.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if execution exists
    const execution = await prisma.execution.findUnique({
      where: { id },
      include: {
        flow: {
          select: {
            id: true,
            name: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!execution) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Execution not found',
      };
      return res.status(404).json(response);
    }

    // Get logs from execution (stored as JSON string)
    const logs = execution.logs ? JSON.parse(execution.logs) : [];

    const response: ApiResponseWrapper<{ execution: Execution; logs: ExecutionLog[] }> = {
      success: true,
      data: {
        execution: {
          id: execution.id,
          flowId: execution.flowId,
          projectId: execution.projectId,
          status: execution.status as 'Running' | 'Completed' | 'Failed' | 'Pending',
          startedAt: execution.startedAt.toISOString(),
          endedAt: execution.endedAt?.toISOString(),
          logs: execution.logs ? JSON.parse(execution.logs) : [],
          result: execution.result ? JSON.parse(execution.result) : {},
        } as Execution,
        logs: logs.map((log: any) => ({
          timestamp: log.timestamp,
          level: log.level as 'info' | 'success' | 'error' | 'warning',
          message: log.message,
          nodeId: log.nodeId || undefined,
          nodeName: log.nodeName || undefined,
        })) as ExecutionLog[],
      },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching execution logs:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch execution logs',
    };
    return res.status(500).json(response);
  }
});

// POST /api/executions - Create new execution
router.post('/', async (req: Request, res: Response) => {
  try {
    const { flowId, projectId, status = 'Pending', triggerType = 'manual' } = req.body;

    if (!flowId || !projectId) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Flow ID and Project ID are required',
      };
      return res.status(400).json(response);
    }

    // Verify flow exists
    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!flow) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Flow not found',
      };
      return res.status(404).json(response);
    }
    if (!roleAllows(await projectRole(req, flow.projectId), 'editor')) {
      return res.status(403).json({ success: false, error: 'You do not have access to this project' });
    }

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project not found',
      };
      return res.status(404).json(response);
    }

    const execution = await prisma.execution.create({
      data: {
        flowId,
        projectId,
        status,
        triggerType,
        startedAt: new Date(),
      },
    });

    const response: ApiResponseWrapper<Execution> = {
      success: true,
      data: {
        id: execution.id,
        flowId: execution.flowId,
        projectId: execution.projectId,
        status: execution.status as 'Running' | 'Completed' | 'Failed' | 'Pending',
        triggerType: execution.triggerType,
        startedAt: execution.startedAt.toISOString(),
        endedAt: execution.endedAt?.toISOString(),
        logs: execution.logs ? JSON.parse(execution.logs) : [],
        result: execution.result ? JSON.parse(execution.result) : {},
      } as Execution,
      message: 'Execution created successfully',
    };
    return res.status(201).json(response);
  } catch (error) {
    console.error('Error creating execution:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to create execution',
    };
    return res.status(500).json(response);
  }
});

// POST /api/executions/:id/terminate - Terminate a running execution
router.post('/:id/terminate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason = 'Terminated by user' } = req.body;

    // Check if execution exists and is running
    const execution = await prisma.execution.findUnique({
      where: { id },
    });

    if (!execution) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Execution not found',
      };
      return res.status(404).json(response);
    }

    // Only allow terminating running or pending executions
    if (execution.status !== 'Running' && execution.status !== 'Pending') {
      const response: ApiResponseWrapper = {
        success: false,
        error: `Cannot terminate execution with status: ${execution.status}. Only running or pending executions can be terminated.`,
      };
      return res.status(400).json(response);
    }

    // Update execution status to Failed with termination info
    const updatedExecution = await prisma.execution.update({
      where: { id },
      data: {
        status: 'Failed',
        endedAt: new Date(),
        error: reason,
        logs: JSON.stringify([
          ...(execution.logs ? JSON.parse(execution.logs) : []),
          {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: `Execution terminated: ${reason}`,
          },
        ]),
      },
    });

    // TODO: In a real implementation, you would also:
    // 1. Send kill signal to the actual process if it's running in a worker
    // 2. Clean up any resources
    // 3. Notify via WebSocket if implemented

    const response: ApiResponseWrapper<Execution> = {
      success: true,
      data: {
        id: updatedExecution.id,
        flowId: updatedExecution.flowId,
        projectId: updatedExecution.projectId,
        status: updatedExecution.status as 'Running' | 'Completed' | 'Failed' | 'Pending',
        startedAt: updatedExecution.startedAt.toISOString(),
        endedAt: updatedExecution.endedAt?.toISOString(),
        logs: updatedExecution.logs ? JSON.parse(updatedExecution.logs) : [],
        result: updatedExecution.result ? JSON.parse(updatedExecution.result) : {},
        error: updatedExecution.error || undefined,
      } as Execution,
      message: 'Execution terminated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error terminating execution:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to terminate execution',
    };
    return res.status(500).json(response);
  }
});

// DELETE /api/executions/clear - Clear executions based on filters
router.delete('/clear', async (req: Request, res: Response) => {
  try {
    const { projectId, status, flowId, flowType, dateRange } = req.query;

    if (!projectId) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Project ID is required',
      };
      return res.status(400).json(response);
    }
    if (!roleAllows(await projectRole(req, projectId as string), 'editor')) {
      return res.status(403).json({ success: false, error: 'You do not have access to this project' });
    }

    // Build filter conditions
    const where: any = {
      projectId: projectId as string,
    };

    // Status filter
    if (status && status !== 'all') {
      if (status === 'success') {
        where.status = { in: ['Completed', 'Success'] };
      } else if (status === 'failed') {
        where.status = 'Failed';
      } else if (status === 'running') {
        where.status = 'Running';
      }
    }

    // Flow filter
    if (flowId && flowId !== 'all') {
      where.flowId = flowId as string;
    }

    // Flow type filter
    if (flowType && flowType !== 'all') {
      const flows = await prisma.flow.findMany({
        where: {
          projectId: projectId as string,
          type: flowType === 'api' ? 'API_SPEC' : 'TRIGGER',
        },
        select: { id: true },
      });
      const flowIds = flows.map(f => f.id);
      where.flowId = { in: flowIds };
    }

    // Date range filter
    if (dateRange && dateRange !== 'all') {
      const now = new Date();
      let startDate: Date;

      switch (dateRange as string) {
        case 'today':
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case 'yesterday':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 1);
          startDate.setHours(0, 0, 0, 0);
          break;
        case '7days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 7);
          startDate.setHours(0, 0, 0, 0);
          break;
        case '30days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 30);
          startDate.setHours(0, 0, 0, 0);
          break;
        default:
          startDate = new Date(2000, 0, 1);
      }

      where.startedAt = {
        gte: startDate,
      };
    }

    // Get count before deletion
    const countToDelete = await prisma.execution.count({ where });

    if (countToDelete === 0) {
      const response: ApiResponseWrapper = {
        success: true,
        message: 'No executions found matching the criteria',
        data: { deletedCount: 0 },
      };
      return res.json(response);
    }

    // Delete executions
    const deleteResult = await prisma.execution.deleteMany({ where });

    const response: ApiResponseWrapper<{ deletedCount: number }> = {
      success: true,
      message: `Successfully cleared ${deleteResult.count} execution(s)`,
      data: { deletedCount: deleteResult.count },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error clearing executions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to clear executions',
    };
    return res.status(500).json(response);
  }
});

// DELETE /api/executions/:id - Delete a single execution
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if execution exists
    const execution = await prisma.execution.findUnique({
      where: { id },
    });

    if (!execution) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Execution not found',
      };
      return res.status(404).json(response);
    }

    // Delete execution
    await prisma.execution.delete({ where: { id } });

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Execution deleted successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error deleting execution:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to delete execution',
    };
    return res.status(500).json(response);
  }
});

// DELETE /api/executions/flow/:flowId - Delete all executions for a flow
router.delete('/flow/:flowId', async (req: Request, res: Response) => {
  try {
    const { flowId } = req.params;
    const { year } = req.query;

    // Build filter
    const where: any = { flowId };
    
    // Filter by year if provided
    if (year) {
      const yearNum = parseInt(year as string, 10);
      where.startedAt = {
        gte: new Date(yearNum, 0, 1),
        lt: new Date(yearNum + 1, 0, 1),
      };
    }

    // Get count before deletion
    const countToDelete = await prisma.execution.count({ where });

    if (countToDelete === 0) {
      const response: ApiResponseWrapper = {
        success: true,
        message: 'No executions found for this flow',
        data: { deletedCount: 0 },
      };
      return res.json(response);
    }

    // Delete executions
    const deleteResult = await prisma.execution.deleteMany({ where });

    const response: ApiResponseWrapper<{ deletedCount: number }> = {
      success: true,
      message: `Successfully deleted ${deleteResult.count} execution(s)`,
      data: { deletedCount: deleteResult.count },
    };
    return res.json(response);
  } catch (error) {
    console.error('Error deleting flow executions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to delete executions',
    };
    return res.status(500).json(response);
  }
});

export default router;
