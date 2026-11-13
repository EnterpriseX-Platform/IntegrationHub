import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { apiService } from '../services/apiService';
import { ApiResponseWrapper, Flow, Execution } from '../types';
import { schedulerService } from '../services/scheduler';
import {
  ExecutionEngine,
  DatabaseExecutor,
  ApiInputExecutor,
  ApiOutputExecutor,
  TransformExecutor,
  ConditionExecutor,
  BasketTriggerExecutor,
  SFTPActionExecutor,
  EmailActionExecutor,
  DelayExecutor,
  // Unified Integration executors
  HttpRequestExecutor,
  FileReadExecutor,
  FileWriteExecutor,
  // Loop executors
  ForEachExecutor,
  // OCR executors
  OcrExecutor,
  // Basket Action executor
  BasketActionExecutor,
  // Aggregate executors (Fan-out/Fan-in)
  AggregateSplitExecutor,
  AggregateJoinExecutor,
  ParallelBranchExecutor,
  // File Encryption/Decryption executors
  FileEncryptExecutor,
  FileDecryptExecutor,
} from '../sdk/execution';
import { buildNodeLabelMap, buildNodeLogEntries } from '../sdk/execution/nodeLogFormatter';
import { resolveDateTimePlaceholders } from '../lib/scheduler-params';
import { ExecutionProgressLogger, executionDeadline } from '../lib/execution-progress';
import { guardProject, adminOnly } from '../lib/access';

// Helper: Extract path parameters from URL based on pattern
// e.g., pattern: "/agency/{year}", path: "/agency/2567" -> { year: "2567" }
function extractPathParams(pattern: string, path: string): Record<string, string> {
  const params: Record<string, string> = {};
  
  // Convert pattern to regex
  // Replace {param} with capture group
  const paramNames: string[] = [];
  const regexPattern = pattern.replace(/\{([^}]+)\}/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  
  const regex = new RegExp(`^${regexPattern}$`);
  const match = path.match(regex);
  
  if (match) {
    paramNames.forEach((name, index) => {
      params[name] = match[index + 1];
    });
  }
  
  return params;
}

const router = Router();

// Non-admins need membership of the flow's project: viewer to read, editor to change or run
router.param('id', guardProject(async (flowId) => {
  const f = await prisma.flow.findUnique({ where: { id: flowId }, select: { projectId: true } });
  return f?.projectId || null;
}));

// GET /api/flows/:id - Get flow details
router.get('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    
    const flow = await prisma.flow.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
        executions: {
          orderBy: { startedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            startedAt: true,
            endedAt: true,
            durationMs: true,
            error: true,
            triggerType: true,
            httpStatusCode: true,
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

    const response: ApiResponseWrapper<typeof flow> = {
      success: true,
      data: flow,
    };
    return res.json(response);
  } catch (error) {
    console.error('Error fetching flow:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to fetch flow',
    };
    return res.status(500).json(response);
  }
});

// PUT /api/flows/:id - Update flow (nodes, connections)
router.put('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { name, type, status, nodes, connections: flowConnections, config, process, tags, description, displayOrder } = req.body;

    // Check if flow exists
    const existingFlow = await prisma.flow.findUnique({
      where: { id },
    });

    if (!existingFlow) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Flow not found',
      };
      return res.status(404).json(response);
    }

    const updatedFlow = await prisma.flow.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(type && { type }),
        ...(status && { status }),
        ...(description !== undefined && { description }),
        ...(process !== undefined && { process }),
        ...(tags !== undefined && { tags: typeof tags === 'string' ? tags : JSON.stringify(tags) }),
        ...(displayOrder !== undefined && { displayOrder: Number(displayOrder) }),
        ...(nodes && { nodes: typeof nodes === 'string' ? nodes : JSON.stringify(nodes) }),
        ...(flowConnections && { connections: typeof flowConnections === 'string' ? flowConnections : JSON.stringify(flowConnections) }),
        ...(config && { config: typeof config === 'string' ? config : JSON.stringify(config) }),
      },
    });

    // NOTE: scheduler management is no longer auto-synced from flow save.
    // Schedulers are now a separate entity managed via /api/schedulers endpoints.
    // The schedule-trigger node (if present) is kept for backward compat but has no effect —
    // the source of truth is the `schedulers` table.

    const response: ApiResponseWrapper<Flow> = {
      success: true,
      data: updatedFlow as unknown as Flow,
      message: 'Flow updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating flow:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update flow',
    };
    return res.status(500).json(response);
  }
});

// POST /api/flows/:id/execute - Run flow execution
router.post('/:id/execute', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { parameters } = req.body; // Optional parameters from force run
    
    const flow = await prisma.flow.findUnique({
      where: { id },
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

    // Create a new execution
    // X-User-Name is percent-encoded by the client (HTTP headers are ASCII-only).
    // Try to decode; fall back to the raw value if decoding fails (older clients).
    const rawCaller = (req.headers['x-user-name'] as string) || '';
    let callerName = 'Manual';
    if (rawCaller) {
      try { callerName = decodeURIComponent(rawCaller); }
      catch { callerName = rawCaller; }
    }
    const execution = await prisma.execution.create({
      data: {
        flowId: id,
        projectId: flow.projectId,
        status: 'Running',
        startedAt: new Date(),
        triggerType: 'manual',
        callerName,
      },
    });

    // Progress logger — writes to the execution row while the flow is still
    // running so the Run Flow screen can show where a long batch has got to.
    const progress = new ExecutionProgressLogger(execution.id);
    progress.add('info', `Starting flow execution: ${flow.name}`);
    progress.add('info', 'Initializing nodes...');
    await progress.flush(true);

    // Update flow status
    await prisma.flow.update({
      where: { id },
      data: {
        updatedAt: new Date(),
      },
    });

    // Merge caller-provided parameters with any flow.config.variables defaults.
    // Caller value wins; missing values fall back to default with template
    // resolution (so a default like "{{BYY}}" expands to "69" at run time).
    const mergedParams: Record<string, any> = (() => {
      const out: Record<string, any> = { ...(parameters || {}) };
      try {
        const cfg = typeof flow.config === 'string' ? JSON.parse(flow.config) : (flow.config || {});
        const vars: any[] = Array.isArray(cfg?.variables) ? cfg.variables : [];
        for (const v of vars) {
          if (!v?.name) continue;
          if (out[v.name] !== undefined && out[v.name] !== '') continue;
          if (v.default !== undefined && v.default !== '') {
            out[v.name] = resolveDateTimePlaceholders(String(v.default));
          }
        }
      } catch (e) {
        console.warn('[execute] failed to parse flow.config.variables:', e);
      }
      return out;
    })();

    // Execute flow using ExecutionEngine
    (async () => {
      try {
        // Initialize Execution Engine with parameter injection middleware
        const engine = new ExecutionEngine({
          connections: new Map(),
          deadlineAt: executionDeadline(execution.startedAt.getTime()),
          onLog: (log) => console.log(`[Execution] ${log.level}: ${log.message}`),
          middlewares: Object.keys(mergedParams).length > 0 ? [
            async (context, next) => {
              for (const [key, value] of Object.entries(mergedParams)) {
                context.variables.set(key, value);
              }
              context.variables.set('_triggerParams', mergedParams);
              await next();
            },
          ] : [],
        });

        // Register executors based on flow type
        const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;
        const hasEventTrigger = nodes.some((n: any) => ['basket-trigger'].includes(n.type));

        // Stream progress into the execution row. The engine reports loop
        // batches and fan-out branches via 'node:log', which is the only way a
        // long-running batch shows any sign of life before it finishes.
        const progressLabels = buildNodeLabelMap(nodes);
        engine.on('node:log', (nodeId: string, message: string) => {
          progress.add('info', `[${progressLabels.get(nodeId) || nodeId}] ${message}`);
          progress.flushSoon();
        });
        engine.on('node:start', (nodeId: string) => {
          progress.add('info', `▶ ${progressLabels.get(nodeId) || nodeId}`);
          progress.flushSoon();
        });
        engine.on('node:error', (nodeId: string, err: Error) => {
          progress.add('error', `✖ ${progressLabels.get(nodeId) || nodeId}: ${err?.message ?? err}`);
          progress.flushSoon();
        });

        if (hasEventTrigger) {
          engine.registerExecutor(new BasketTriggerExecutor());
        }
        // SFTP + Delay executors are always available (some flows like DOWNLOAD
        // start directly with sftp-action without a basket-trigger)
        engine.registerExecutor(new SFTPActionExecutor());
        engine.registerExecutor(new EmailActionExecutor());
        engine.registerExecutor(new DelayExecutor());
        // Integration executors (Unified)
        engine.registerExecutor(new DatabaseExecutor());
        engine.registerExecutor(new HttpRequestExecutor());
        engine.registerExecutor(new FileReadExecutor());
        engine.registerExecutor(new FileWriteExecutor());
        engine.registerExecutor(new TransformExecutor());
        engine.registerExecutor(new ConditionExecutor());
        engine.registerExecutor(new ForEachExecutor());
        engine.registerExecutor(new OcrExecutor());
        engine.registerExecutor(new BasketActionExecutor());
        engine.registerExecutor(new AggregateSplitExecutor());
        engine.registerExecutor(new AggregateJoinExecutor());
        engine.registerExecutor(new ParallelBranchExecutor());
        engine.registerExecutor(new FileEncryptExecutor());
        engine.registerExecutor(new FileDecryptExecutor());

        // Prepare flow definition
        const connections = typeof flow.connections === 'string' ? JSON.parse(flow.connections) : flow.connections;
        const edges = connections.map((c: any) => ({
          id: c.id,
          source: c.source,
          target: c.target,
          label: c.label,
        }));
        const flowDef = {
          operationId: id,
          nodes,
          edges,
        };

        // Execute with optional parameters from manual trigger
        const result = await engine.execute(flowDef, {
          method: 'EVENT',
          path: '/event',
          headers: {},
          body: parameters || {}, // Pass parameters from force run
          params: parameters || {}, // Also pass as params for template resolution
        });

        // Stop streaming — the rich per-node log below supersedes the progress feed.
        engine.removeAllListeners();

        // Get execution logs (rich per-node entries with label, duration, summary, error)
        const labelMap = buildNodeLabelMap(nodes);
        const execLogs = result.metadata.nodeResults.flatMap((nr: any) =>
          buildNodeLogEntries(nr, labelMap.get(nr.nodeId))
        );

        const updatedLogs = JSON.stringify([
          {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `Starting flow execution: ${flow.name}`,
          },
          {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Initializing nodes...',
          },
          ...execLogs,
          {
            timestamp: new Date().toISOString(),
            level: result.success ? 'success' : 'error',
            message: result.success ? 'Flow execution completed successfully' : `Failed: ${result.error}`,
          },
        ]);

        // Categorize error
        let errorType: string | undefined;
        if (!result.success && result.error) {
          const err = result.error.toLowerCase();
          if (err.includes('timeout')) errorType = 'timeout';
          else if (err.includes('connection') || err.includes('econnrefused')) errorType = 'connection';
          else if (err.includes('validation')) errorType = 'validation';
          else errorType = 'other';
        }

        await prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: result.success ? 'Completed' : 'Failed',
            endedAt: new Date(),
            durationMs: result.metadata.durationMs,
            httpStatusCode: result.statusCode,
            errorType,
            error: result.success ? null : (result.error ?? null),
            logs: updatedLogs,
            result: JSON.stringify({
              success: result.success,
              duration: `${result.metadata.durationMs}ms`,
              data: result.data,
            }),
          },
        });

        // Update basket session status after flow execution
        if (parameters?._triggerType === 'basket' && parameters?._sessionId) {
          try {
            const newStatus = result.success ? 'completed' : 'error';

            // Collect all session IDs that need updating:
            // 1. The session ID from the trigger parameters
            // 2. Any additional sessions that the BasketTriggerExecutor processed
            const sessionIdsToUpdate = new Set<string>();
            sessionIdsToUpdate.add(parameters._sessionId);

            // Check if execution result contains triggerSessionIds from BasketTriggerExecutor
            const triggerSessionIds = result.metadata?.nodeResults?.find(
              (nr: any) => nr.nodeType === 'basket-trigger'
            )?.output?.files?.map((f: any) => f.sessionId);
            if (triggerSessionIds) {
              triggerSessionIds.forEach((id: string) => sessionIdsToUpdate.add(id));
            }

            for (const sessionId of sessionIdsToUpdate) {
              // A session the engine already archived ("Archive after processing")
              // must not be pulled back to 'completed'.
              const updated = await prisma.processingSession.updateMany({
                where: { id: sessionId, status: { not: 'archived' } },
                data: {
                  status: newStatus,
                  ...(result.success ? { completedAt: new Date() } : {}),
                },
              });
              if (updated.count === 0) continue;
              console.log(`[Basket Session] Session ${sessionId} status updated to '${newStatus}' after flow execution`);

              // Log the status change
              await prisma.sessionLog.create({
                data: {
                  sessionId,
                  type: result.success ? 'session_completed' : 'session_error',
                  message: result.success
                    ? `Session completed successfully (execution: ${execution.id})`
                    : `Session failed: ${result.error} (execution: ${execution.id})`,
                },
              });
            }
          } catch (sessionErr) {
            console.error('[Basket Session] Failed to update session status:', (sessionErr as Error).message);
          }
        }

      } catch (err) {
        console.error('Error in flow execution:', err);
        const errorMsg = (err as Error).message;

        // Categorize error
        let errorType: string | undefined;
        const errLower = errorMsg.toLowerCase();
        if (errLower.includes('timeout')) errorType = 'timeout';
        else if (errLower.includes('connection') || errLower.includes('econnrefused')) errorType = 'connection';
        else if (errLower.includes('validation')) errorType = 'validation';
        else errorType = 'other';

        // Keep the streamed progress — on a timeout or a mid-batch crash it is
        // the only record of how far the run actually got.
        progress.add('error', `Execution failed: ${errorMsg}`);

        await prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: 'Failed',
            endedAt: new Date(),
            errorType,
            error: errorMsg,
            logs: JSON.stringify(progress.snapshot()),
            result: JSON.stringify({ success: false, error: errorMsg }),
          },
        });

        // Update basket session status to 'error' on exception
        if (parameters?._triggerType === 'basket' && parameters?._sessionId) {
          try {
            // Update the specific session from publish trigger
            // Also update any sessions that were transitioned to 'processing'
            const sessionIdsToUpdate = new Set<string>();
            sessionIdsToUpdate.add(parameters._sessionId);

            // Find any sessions that are stuck in 'processing' for this basket
            if (parameters._basketId) {
              const stuckSessions = await prisma.processingSession.findMany({
                where: {
                  basketId: parameters._basketId,
                  status: 'processing',
                },
                select: { id: true },
              });
              stuckSessions.forEach((s: { id: string }) => sessionIdsToUpdate.add(s.id));
            }

            for (const sessionId of sessionIdsToUpdate) {
              await prisma.processingSession.update({
                where: { id: sessionId },
                data: { status: 'error' },
              });
              console.log(`[Basket Session] Session ${sessionId} status updated to 'error' after execution exception`);

              await prisma.sessionLog.create({
                data: {
                  sessionId,
                  type: 'session_error',
                  message: `Session failed with exception: ${errorMsg} (execution: ${execution.id})`,
                },
              });
            }
          } catch (sessionErr) {
            console.error('[Basket Session] Failed to update session status:', (sessionErr as Error).message);
          }
        }
      }
    })();

    const response: ApiResponseWrapper<{ execution: Execution; message: string }> = {
      success: true,
      data: {
        execution: {
          id: execution.id,
          flowId: execution.flowId,
          projectId: execution.projectId,
          status: execution.status as 'Running' | 'Completed' | 'Failed' | 'Pending',
          startedAt: execution.startedAt.toISOString(),
        } as Execution,
        message: 'Flow execution started',
      },
    };
    return res.status(202).json(response);
  } catch (error) {
    console.error('Error executing flow:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to execute flow',
    };
    return res.status(500).json(response);
  }
});

// POST /api/flows/:id/test - Test API operation using Execution Engine SDK
router.post('/:id/test', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { operationId, method, path, body, query, headers, params } = req.body;

    const flow = await prisma.flow.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true } } },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Parse flow config
    let config: any = {};
    try {
      config = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      config = flow.config || {};
    }

    const operationFlows = config.operationFlows || {};
    const flowData = operationFlows[operationId];

    if (!flowData) {
      return res.status(404).json({ success: false, error: 'Operation flow not found' });
    }
    
    // Ensure flowData has operationId for schema-based transforms
    if (!flowData.operationId) {
      flowData.operationId = operationId;
    }

    // Initialize Execution Engine with apiSpec for schema-based transforms
    const engine = new ExecutionEngine({
      connections: new Map(),
      apiSpec: config.apiSpec,
      onLog: (log) => console.log(`[Execution] ${log.level}: ${log.message}`),
    });

    // Register executors
    engine.registerExecutor(new ApiInputExecutor());
    engine.registerExecutor(new ApiOutputExecutor());
    engine.registerExecutor(new DatabaseExecutor());
    engine.registerExecutor(new HttpRequestExecutor());
    engine.registerExecutor(new FileReadExecutor());
    engine.registerExecutor(new FileWriteExecutor());
    engine.registerExecutor(new TransformExecutor());
    engine.registerExecutor(new ConditionExecutor());
    engine.registerExecutor(new ForEachExecutor());
    engine.registerExecutor(new OcrExecutor());
    engine.registerExecutor(new BasketActionExecutor());
    engine.registerExecutor(new AggregateSplitExecutor());
    engine.registerExecutor(new AggregateJoinExecutor());
    engine.registerExecutor(new ParallelBranchExecutor());
    engine.registerExecutor(new FileEncryptExecutor());
    engine.registerExecutor(new FileDecryptExecutor());

    // Extract path parameters from URL if not provided
    let extractedParams = params || {};
    if (!extractedParams || Object.keys(extractedParams).length === 0) {
      // Find operation in apiSpec to get path pattern
      const operation = config.apiSpec?.operations?.find((op: any) => op.id === operationId);
      if (operation?.path && path) {
        extractedParams = extractPathParams(operation.path, path);
        console.log('[Test API] Extracted params from path:', extractedParams);
      }
    }

    // Execute flow
    const result = await engine.execute(flowData, {
      method,
      path,
      headers: headers || {},
      query: query || {},
      body,
      params: extractedParams,
    });

    // Create execution record
    await prisma.execution.create({
      data: {
        flowId: id,
        projectId: flow.projectId,
        status: result.success ? 'Completed' : 'Failed',
        startedAt: result.metadata.startedAt,
        endedAt: result.metadata.endedAt,
        result: JSON.stringify(result),
        logs: JSON.stringify(result.metadata.nodeResults.map((nr: any) => ({
          timestamp: nr.startedAt,
          level: nr.success ? 'info' : 'error',
          message: `${nr.nodeType} node ${nr.nodeId}: ${nr.success ? 'success' : nr.error}`,
        }))),
      },
    });

    // Find api-output node result
    const apiOutputResult = result.metadata.nodeResults.find((nr: any) => nr.nodeType === 'api-output');

    // Check if result is a file download
    if (result.success && result.data?._fileDownload) {
      const fileDownload = result.data._fileDownload;
      const headers = result.data.headers || {};

      // Set response headers via the safe writer — handles Thai/Unicode in
      // Content-Disposition filenames (RFC 5987) and percent-encodes other
      // header values so non-ASCII content doesn't crash the response.
      const { setSafeHeader } = require('../utils/safeHeaders');
      for (const [key, value] of Object.entries(headers)) {
        setSafeHeader(res, key, value as string);
      }

      // Stream the file
      const fs = require('fs');
      if (!fs.existsSync(fileDownload.filePath)) {
        return res.status(404).json({ success: false, error: 'Generated file is no longer on disk' });
      }
      const fileStream = fs.createReadStream(fileDownload.filePath);
      fileStream.on('error', (err: Error) => {
        console.error('Error streaming flow output file:', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read file' });
        else res.destroy();
      });
      return fileStream.pipe(res);
    }

    return res.status(result.statusCode).json({
      success: result.success,
      data: result.data,
      error: result.error,
      executionTime: `${result.metadata.durationMs}ms`,
      debug: {
        apiOutputNode: apiOutputResult ? {
          nodeId: apiOutputResult.nodeId,
          output: apiOutputResult.output,
        } : null,
        allNodes: result.metadata.nodeResults.map((nr: any) => ({
          nodeId: nr.nodeId,
          nodeType: nr.nodeType,
        })),
      },
    });
  } catch (error) {
    console.error('Error testing API:', error);
    
    // Format error message for better readability
    let errorMessage = error instanceof Error ? error.message : 'Failed to test API';
    
    // Add node information if available
    const nodeMatch = errorMessage.match(/Node\s+(\w+)/i);
    if (nodeMatch) {
      errorMessage = `[${nodeMatch[1]}] ${errorMessage}`;
    }
    
    return res.status(500).json({ 
      success: false, 
      status: 500,
      error: errorMessage,
      timestamp: new Date().toISOString(),
      hint: errorMessage.includes('Table not found') 
        ? 'Please verify the database table exists and the SQL query is correct.'
        : errorMessage.includes('Cannot connect')
        ? 'Please check database connection settings and ensure the server is accessible.'
        : undefined
    });
  }
});

// POST /api/flows/:id/test-event - Test Event Flow
router.post('/:id/test-event', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { triggerData } = req.body;

    const flow = await prisma.flow.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true } } },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Parse flow nodes and edges
    let nodes: any[] = [];
    let edges: any[] = [];
    try {
      nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : (flow.nodes || []);
      edges = typeof flow.connections === 'string' ? JSON.parse(flow.connections) : (flow.connections || []);
    } catch (e) {
      console.error('Error parsing flow data:', e);
    }

    // Initialize Execution Engine for Event Flow
    const engine = new ExecutionEngine({
      connections: new Map(),
      onLog: (log) => console.log(`[EventFlow] ${log.level}: ${log.message}`),
    });

    // Register executors
    engine.registerExecutor(new BasketTriggerExecutor());
    engine.registerExecutor(new SFTPActionExecutor());
    engine.registerExecutor(new EmailActionExecutor());
    engine.registerExecutor(new DatabaseExecutor());
    engine.registerExecutor(new HttpRequestExecutor());
    engine.registerExecutor(new TransformExecutor());
    engine.registerExecutor(new ConditionExecutor());
    engine.registerExecutor(new DelayExecutor());
    engine.registerExecutor(new FileReadExecutor());
    engine.registerExecutor(new FileWriteExecutor());
    engine.registerExecutor(new ForEachExecutor());
    engine.registerExecutor(new OcrExecutor());
    engine.registerExecutor(new BasketActionExecutor());
    engine.registerExecutor(new AggregateSplitExecutor());
    engine.registerExecutor(new AggregateJoinExecutor());
    engine.registerExecutor(new ParallelBranchExecutor());
    engine.registerExecutor(new FileEncryptExecutor());
    engine.registerExecutor(new FileDecryptExecutor());

    // Execute flow
    const flowDef = {
      operationId: id,
      nodes,
      edges,
    };

    const result = await engine.execute(flowDef, {
      method: 'EVENT',
      path: '/event',
      headers: {},
      body: triggerData,
      params: {},
    });

    return res.status(result.statusCode).json({
      success: result.success,
      data: result.data,
      error: result.error,
      executionTime: `${result.metadata.durationMs}ms`,
      nodesExecuted: result.metadata.nodeResults.map((nr: any) => ({
        nodeId: nr.nodeId,
        nodeType: nr.nodeType,
        success: nr.success,
      })),
    });
  } catch (error) {
    console.error('Error testing event flow:', error);
    return res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to test event flow' 
    });
  }
});

// POST /api/flows/:id/deploy - Deploy API to public endpoint
router.post('/:id/deploy', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { apiSpec: bodyApiSpec, deployment } = req.body;

    const flow = await prisma.flow.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
      },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Get current config
    let currentConfig: any = {};
    try {
      currentConfig = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      currentConfig = {};
    }

    // Use apiSpec from request body, or fall back to flow config
    const apiSpec = bodyApiSpec || currentConfig.apiSpec;

    // Use provided publicUrl, or existing deployment publicUrl, or generate default: /deh/{projectCode}/v1
    const PUBLIC_ROOT = process.env.PUBLIC_API_ROOT || process.env.CTX_PUBLIC || '/deh';
    const publicUrl = deployment?.publicUrl || currentConfig.deployment?.publicUrl || `${PUBLIC_ROOT}/${flow.project?.code || 'p'}/v1`;

    // Save deployment config
    const deploymentConfig = {
      deployedAt: new Date().toISOString(),
      apiSpec,
      publicUrl,
      requireApiKey: deployment?.requireApiKey ?? true,
      enabled: deployment?.enabled ?? true,
    };

    // Update flow with deployment info
    await prisma.flow.update({
      where: { id },
      data: {
        config: JSON.stringify({
          ...currentConfig,
          deployment: deploymentConfig,
        }),
        status: 'Active',
      },
    });

    // Refresh API service cache so deployed URLs take effect immediately
    await apiService.deploy(id);

    return res.json({
      success: true,
      data: {
        flowId: id,
        publicUrl,
        deployedAt: deploymentConfig.deployedAt,
        requireApiKey: deploymentConfig.requireApiKey,
        enabled: deploymentConfig.enabled,
        operations: apiSpec.operations?.map((op: any) => ({
          id: op.id,
          method: op.method,
          path: op.path,
          url: `${publicUrl}${op.path}`,
        })) || [],
      },
      message: 'API deployed successfully',
    });
  } catch (error) {
    console.error('Error deploying API:', error);
    return res.status(500).json({ success: false, error: 'Failed to deploy API' });
  }
});

// DELETE /api/flows/:id/deploy - Undeploy API (remove from public access)
router.delete('/:id/deploy', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;

    const flow = await prisma.flow.findUnique({
      where: { id },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Get current config
    let currentConfig: any = {};
    try {
      currentConfig = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      currentConfig = {};
    }

    // Update deployment config to disabled
    const updatedConfig = {
      ...currentConfig,
      deployment: {
        ...currentConfig.deployment,
        enabled: false,
        undeployedAt: new Date().toISOString(),
      },
    };

    await prisma.flow.update({
      where: { id },
      data: {
        status: 'Inactive',
        config: JSON.stringify(updatedConfig),
      },
    });

    // Refresh API service cache so undeployed URL is removed immediately
    await apiService.undeploy(id);

    return res.json({
      success: true,
      message: 'API undeployed successfully',
    });
  } catch (error) {
    console.error('Error undeploying API:', error);
    return res.status(500).json({ success: false, error: 'Failed to undeploy API' });
  }
});

// POST /api/flows/:id/event-deploy - Deploy Event Flow (schedule triggers)
router.post('/:id/event-deploy', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { triggerType, schedule: scheduleConfig } = req.body;

    const flow = await prisma.flow.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
      },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Only for event/trigger type flows
    if (flow.type !== 'trigger' && flow.type !== 'event') {
      return res.status(400).json({ success: false, error: 'Only event flows can use event-deploy' });
    }

    // Get current config
    let currentConfig: any = {};
    try {
      currentConfig = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      currentConfig = {};
    }

    // For scheduler trigger type: create/update scheduler record via scheduler service
    if (triggerType === 'scheduler' && scheduleConfig?.cron) {
      await schedulerService.createOrUpdateScheduler(
        id,
        flow.projectId,
        scheduleConfig.cron,
        scheduleConfig.timezone || 'Asia/Bangkok',
        true
      );
    }

    // Update flow status and config
    const deploymentConfig = {
      enabled: true,
      deployedAt: new Date().toISOString(),
      triggerType,
      schedule: scheduleConfig,
    };

    await prisma.flow.update({
      where: { id },
      data: {
        status: 'Active',
        config: JSON.stringify({
          ...currentConfig,
          deployment: deploymentConfig,
        }),
      },
    });

    return res.json({
      success: true,
      data: {
        flowId: id,
        status: 'Active',
        triggerType,
        deployedAt: deploymentConfig.deployedAt,
      },
      message: 'Event flow deployed successfully',
    });
  } catch (error) {
    console.error('Error deploying event flow:', error);
    return res.status(500).json({ success: false, error: 'Failed to deploy event flow' });
  }
});

// DELETE /api/flows/:id/event-deploy - Undeploy Event Flow (stop schedulers)
router.delete('/:id/event-deploy', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;

    const flow = await prisma.flow.findUnique({
      where: { id },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Stop and delete scheduler
    await schedulerService.deleteScheduler(id);

    // Get current config
    let currentConfig: any = {};
    try {
      currentConfig = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      currentConfig = {};
    }

    // Update flow status
    await prisma.flow.update({
      where: { id },
      data: {
        status: 'Inactive',
        config: JSON.stringify({
          ...currentConfig,
          deployment: {
            ...currentConfig.deployment,
            enabled: false,
            undeployedAt: new Date().toISOString(),
          },
        }),
      },
    });

    return res.json({
      success: true,
      message: 'Event flow undeployed successfully',
    });
  } catch (error) {
    console.error('Error undeploying event flow:', error);
    return res.status(500).json({ success: false, error: 'Failed to undeploy event flow' });
  }
});

// PUT /api/flows/:id/deployment - Update deployment settings
router.put('/:id/deployment', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { publicUrl, requireApiKey, enabled } = req.body;

    const flow = await prisma.flow.findUnique({
      where: { id },
    });

    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    // Get current config
    let currentConfig: any = {};
    try {
      currentConfig = flow.config ? JSON.parse(flow.config as string) : {};
    } catch (e) {
      currentConfig = {};
    }

    // Update deployment config
    const updatedConfig = {
      ...currentConfig,
      deployment: {
        publicUrl,
        requireApiKey,
        enabled,
        updatedAt: new Date().toISOString(),
      },
    };

    await prisma.flow.update({
      where: { id },
      data: {
        config: JSON.stringify(updatedConfig),
      },
    });

    return res.json({
      success: true,
      data: updatedConfig.deployment,
      message: 'Deployment settings updated',
    });
  } catch (error) {
    console.error('Error updating deployment:', error);
    return res.status(500).json({ success: false, error: 'Failed to update deployment settings' });
  }
});

// DELETE /api/flows/:id - Delete flow
router.delete('/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;

    // Check if flow exists
    const existingFlow = await prisma.flow.findUnique({
      where: { id },
    });

    if (!existingFlow) {
      const response: ApiResponseWrapper = {
        success: false,
        error: 'Flow not found',
      };
      return res.status(404).json(response);
    }

    // Stop and delete scheduler if exists
    await schedulerService.deleteScheduler(id);

    // Delete related records first (cascade delete for executions)
    await prisma.execution.deleteMany({
      where: { flowId: id },
    });

    // Delete related schedulers (backup in case service didn't delete)
    await prisma.scheduler.deleteMany({
      where: { flowId: id },
    });

    // Delete the flow
    await prisma.flow.delete({
      where: { id },
    });

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Flow deleted successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error deleting flow:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to delete flow',
    };
    return res.status(500).json(response);
  }
});

// POST /api/flows/position - Update flow positions
router.post('/position', adminOnly, async (req: Request, res: Response) => {
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
      positions.map((item: { flowId: string; position: number }) =>
        prisma.flow.update({
          where: { id: item.flowId },
          data: { displayOrder: item.position },
        })
      )
    );

    const response: ApiResponseWrapper = {
      success: true,
      message: 'Flow positions updated successfully',
    };
    return res.json(response);
  } catch (error) {
    console.error('Error updating flow positions:', error);
    const response: ApiResponseWrapper = {
      success: false,
      error: 'Failed to update flow positions',
    };
    return res.status(500).json(response);
  }
});

export default router;
