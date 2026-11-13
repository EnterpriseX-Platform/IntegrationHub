// Execution Engine SDK - Main Engine Class

import { EventEmitter } from 'events';
import {
  FlowDefinition,
  ExecutionInput,
  ExecutionResult,
  ExecutionContext,
  NodeExecutionResult,
  ExecutionLog,
  EngineConfig,
  ExecutionMiddleware,
} from './types';
import { NodeExecutor } from './NodeExecutor';

export class ExecutionEngine extends EventEmitter {
  private executors = new Map<string, NodeExecutor>();
  private config: EngineConfig;
  private middlewares: ExecutionMiddleware[] = [];
  private deadlineAt?: number;

  constructor(config: EngineConfig) {
    super();
    this.config = config;
    this.middlewares = config.middlewares || [];
    this.deadlineAt = config.deadlineAt;
  }

  /**
   * Cooperative abort. Called between nodes and between for-each batches —
   * the only points where the engine is guaranteed to hold control. Without
   * this a flow whose item list is huge (e.g. a basket-trigger that picked up
   * 20k+ files) keeps running for days with no way to stop it.
   */
  private checkDeadline(): void {
    if (this.deadlineAt && Date.now() > this.deadlineAt) {
      throw new Error(
        `Execution timeout: exceeded the maximum run time (deadline ${new Date(this.deadlineAt).toISOString()})`
      );
    }
  }

  // Register a node executor
  registerExecutor(executor: NodeExecutor): void {
    this.executors.set(executor.type, executor);
    this.emit('executor:registered', executor.type);
  }

  // Unregister a node executor
  unregisterExecutor(type: string): void {
    this.executors.delete(type);
    this.emit('executor:unregistered', type);
  }

  // Main execution method
  async execute(flow: FlowDefinition, input: ExecutionInput): Promise<ExecutionResult> {
    const startedAt = new Date();
    const operationId = flow.operationId;

    this.emit('execution:start', { operationId, startedAt });

    // Initialize execution context
    const context: ExecutionContext = {
      flow,
      input,
      variables: new Map(),
      nodeResults: new Map(),
      logs: [],
      apiSpec: this.config.apiSpec,
    };

    try {
      // Run pre-execution middlewares
      await this.runMiddlewares(context);

      // Execute flow
      const result = await this.executeFlow(context);

      const endedAt = new Date();
      const executionResult: ExecutionResult = {
        success: true,
        statusCode: result.statusCode || 200,
        data: result.body,
        metadata: {
          operationId,
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          nodeResults: Array.from(context.nodeResults.values()),
        },
      };

      this.emit('execution:complete', executionResult);
      return executionResult;
    } catch (error) {
      const endedAt = new Date();
      const executionResult: ExecutionResult = {
        success: false,
        statusCode: 500,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          operationId,
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          nodeResults: Array.from(context.nodeResults.values()),
        },
      };

      this.emit('execution:error', error, executionResult);
      return executionResult;
    }
  }

  private async executeFlow(context: ExecutionContext): Promise<{ statusCode: number; body?: any }> {
    const { flow } = context;
    
    // Build adjacency list
    const adjacencyList = new Map<string, string[]>();
    for (const edge of flow.edges) {
      if (!adjacencyList.has(edge.source)) {
        adjacencyList.set(edge.source, []);
      }
      adjacencyList.get(edge.source)!.push(edge.target);
    }

    // Find start node (api-input) or first node with no incoming edges
    const incomingNodes = new Set(flow.edges.map(e => e.target));
    let currentNodeId = flow.nodes.find(n => n.type === 'api-input')?.id ||
                       flow.nodes.find(n => !incomingNodes.has(n.id))?.id;

    if (!currentNodeId) {
      throw new Error('No start node found in flow');
    }

    // Execute nodes in sequence
    let finalOutput: any;
    const visited = new Set<string>();

    while (currentNodeId && !visited.has(currentNodeId)) {
      this.checkDeadline();
      visited.add(currentNodeId);

      const node = flow.nodes.find(n => n.id === currentNodeId);
      if (!node) {
        throw new Error(`Node not found: ${currentNodeId}`);
      }

      // Execute node
      const result = await this.executeNode(node, context);
      finalOutput = result.output;
      
      // Store result and pass to next node as input
      // Note: result is already stored by NodeExecutor, just need to pass output to next node
      context.input = result.output;  // Pass output as input to next node
      const nextNodes = adjacencyList.get(currentNodeId) || [];
      
      if (node.type === 'condition') {
        // For condition nodes, use the condition result to determine next node(s)
        // Supports multiple matching edges (fan-out from a single condition branch)
        const conditionResult = result.output;
        const matchingEdges = flow.edges.filter(e =>
          e.source === currentNodeId &&
          (conditionResult.result
            ? (e.label === 'true' || e.label === 'yes')
            : (e.label === 'false' || e.label === 'no' || !e.label))
        );

        if (matchingEdges.length === 0) {
          currentNodeId = undefined;
        } else if (matchingEdges.length === 1) {
          // Linear continuation
          currentNodeId = matchingEdges[0].target;
        } else {
          // Multiple matching edges → fan-out (parallel branches with optional join)
          const branchTargets = matchingEdges.map(e => e.target);
          this.emit('node:log', node.id, `Condition fan-out: ${branchTargets.length} branches`);

          // Try to find a join node (e.g. aggregate-join) reachable from all branches
          const joinNodeId = this.findJoinNode(branchTargets, adjacencyList, flow);

          const branchPromises = branchTargets.map(async (branchStartId, idx) => {
            const branchContext: ExecutionContext = {
              flow: context.flow,
              input: context.input,
              variables: new Map(context.variables),
              nodeResults: context.nodeResults,
              logs: context.logs,
              apiSpec: context.apiSpec,
            };

            this.emit('node:log', node.id, `Branch ${idx + 1}: starting at ${branchStartId}`);

            try {
              if (joinNodeId) {
                await this.executeChainUntil(branchStartId, branchContext, adjacencyList, flow, joinNodeId);
              } else {
                await this.executeChain(branchStartId, branchContext, adjacencyList, flow);
              }
              return { branch: idx, success: true };
            } catch (err: any) {
              console.error(`[Condition Fan-out] Branch ${idx + 1} error:`, err.message);
              this.emit('node:log', node.id, `Branch ${idx + 1} error: ${err.message}`);
              return { branch: idx, success: false, error: err.message };
            }
          });

          const branchResults = await Promise.allSettled(branchPromises);
          const summary = branchResults.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: 'rejected' });
          this.emit('node:log', node.id, `Condition fan-out completed: ${summary.filter((s: any) => s.success).length}/${branchTargets.length} succeeded`);

          // Continue after join if found, otherwise stop here (each branch already ran to its own end)
          currentNodeId = joinNodeId;
        }
      } else if (node.type === 'for-each') {
        // For-each loop: iterate over items, execute body chain for each
        const forEachResult = result.output;
        const items = forEachResult.items || [];
        const workers = forEachResult.workers || 1;
        const bodyEdge = flow.edges.find(e => e.source === currentNodeId && e.label === 'body');

        const deferred = forEachResult.deferredItems || 0;
        this.emit('node:log', node.id,
          `For-each: ${items.length} items to process (workers: ${workers})` +
          (deferred > 0 ? ` — ${deferred} of ${forEachResult.matchedItems} deferred by maxItems=${forEachResult.maxItems}` : '')
        );

        if (workers <= 1) {
          // Sequential mode (original behavior)
          for (let i = 0; i < items.length; i++) {
            this.checkDeadline();
            context.variables.set(forEachResult.itemVar, items[i]);
            context.variables.set(forEachResult.indexVar || 'loopIndex', i);
            context.variables.set('loopTotal', items.length);

            this.emit('node:log', node.id, `Loop iteration ${i + 1}/${items.length}`);

            if (bodyEdge) {
              await this.executeChain(bodyEdge.target, context, adjacencyList, flow);
            }
          }
        } else {
          // Parallel workers mode — process items in batches
          const loopResults: any[] = [];
          const errors: { index: number; error: string }[] = [];

          for (let batchStart = 0; batchStart < items.length; batchStart += workers) {
            this.checkDeadline();
            const batchEnd = Math.min(batchStart + workers, items.length);
            const batch = items.slice(batchStart, batchEnd);

            this.emit('node:log', node.id, `Batch ${Math.floor(batchStart / workers) + 1}: items ${batchStart + 1}-${batchEnd}/${items.length} (${batch.length} workers)`);

            // Create isolated contexts for each worker
            const workerPromises = batch.map(async (item: any, batchIndex: number) => {
              const itemIndex = batchStart + batchIndex;

              // Create isolated context per worker (shared flow, own variables copy)
              const workerContext: ExecutionContext = {
                flow: context.flow,
                input: context.input,
                variables: new Map(context.variables), // copy shared vars
                nodeResults: context.nodeResults,       // share results (for logging)
                logs: context.logs,                     // share logs
                apiSpec: context.apiSpec,
              };

              // Set loop variables in worker context
              workerContext.variables.set(forEachResult.itemVar, item);
              workerContext.variables.set(forEachResult.indexVar || 'loopIndex', itemIndex);
              workerContext.variables.set('loopTotal', items.length);

              try {
                if (bodyEdge) {
                  await this.executeChain(bodyEdge.target, workerContext, adjacencyList, flow);
                }
                // Collect per-item result from worker's variables
                const lastBodyNodeId = this.getLastNodeInChain(bodyEdge!.target, adjacencyList, flow);
                const itemResult = lastBodyNodeId ? workerContext.variables.get(lastBodyNodeId) : undefined;
                return { index: itemIndex, success: true, result: itemResult };
              } catch (err: any) {
                errors.push({ index: itemIndex, error: err.message });
                console.error(`[ForEach] Worker error at item ${itemIndex + 1}:`, err.message);
                this.emit('node:log', node.id, `Worker error at item ${itemIndex + 1}: ${err.message}`);
                return { index: itemIndex, success: false, error: err.message };
              }
            });

            const batchResults = await Promise.allSettled(workerPromises);
            for (const r of batchResults) {
              if (r.status === 'fulfilled') {
                loopResults.push(r.value);
              }
            }
          }

          // Store loop results summary in context
          context.variables.set('loopResults', loopResults);
          context.variables.set('loopErrors', errors);
          context.variables.set('loopTotal', items.length);
          context.variables.set('loopSuccessCount', loopResults.filter(r => r.success).length);
          context.variables.set('loopErrorCount', errors.length);

          this.emit('node:log', node.id,
            `For-each completed: ${loopResults.filter(r => r.success).length} success, ${errors.length} errors`
          );
        }

        // After loop, continue to 'done' edge
        // Find the done edge (any edge that is NOT 'body')
        const doneTarget = flow.edges.find(e =>
          e.source === currentNodeId && e.label !== 'body'
        );
        currentNodeId = doneTarget?.target;
      } else if (node.type === 'aggregate-split') {
        // Fan-out: execute all outgoing branches in parallel, converge at aggregate-join
        const branchTargets = nextNodes;
        this.emit('node:log', node.id, `Fan-out: ${branchTargets.length} branches`);

        // Find the join node — look for aggregate-join that's reachable from all branches
        const joinNodeId = this.findJoinNode(branchTargets, adjacencyList, flow);

        // Execute all branches in parallel with isolated contexts
        const branchPromises = branchTargets.map(async (branchStartId, idx) => {
          const branchContext: ExecutionContext = {
            flow: context.flow,
            input: context.input,
            variables: new Map(context.variables),
            nodeResults: context.nodeResults,
            logs: context.logs,
            apiSpec: context.apiSpec,
          };

          this.emit('node:log', node.id, `Branch ${idx + 1}: starting at ${branchStartId}`);

          try {
            // Execute chain until we hit the join node or a dead end
            await this.executeChainUntil(branchStartId, branchContext, adjacencyList, flow, joinNodeId);
            return { branch: idx, success: true };
          } catch (err: any) {
            console.error(`[AggregateSplit] Branch ${idx + 1} error:`, err.message);
            this.emit('node:log', node.id, `Branch ${idx + 1} error: ${err.message}`);
            return { branch: idx, success: false, error: err.message };
          }
        });

        const branchResults = await Promise.allSettled(branchPromises);
        const summary = branchResults.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: 'rejected' });
        context.variables.set(`__aggregate_branches_summary`, summary);

        this.emit('node:log', node.id, `Fan-out completed: ${summary.filter(s => s.success).length}/${branchTargets.length} succeeded`);

        // Continue to the join node
        currentNodeId = joinNodeId;
      } else if (node.type === 'api-output') {
        // Stop at api-output node
        return result.output;
      } else {
        // Continue to next node (usually just one for linear flows)
        currentNodeId = nextNodes[0];
      }
    }

    // Auto-close any sessions that the basket-trigger started.
    // After all flow nodes finish successfully, sessions whose work is done
    // (e.g. files imported into DB, files transformed and saved) should move
    // out of 'open'/'processing' so they don't keep appearing as "active".
    await this.closeTriggeredSessions(context, /* success */ true);

    // If no api-output node was found, return the last output
    return { statusCode: 200, body: finalOutput };
  }

  /**
   * Mark all `triggerSessionIds` (set by basket-trigger) as completed.
   * Called after the flow finishes — without this, sessions stay 'open' /
   * 'processing' forever and the basket UI shows them as active indefinitely.
   */
  private async closeTriggeredSessions(context: ExecutionContext, success: boolean): Promise<void> {
    try {
      const ids = context.variables.get('triggerSessionIds') as string[] | undefined;
      if (!ids || ids.length === 0) return;

      // A capped for-each only got through part of the session's files. Closing
      // it here would mark the untouched remainder as completed.
      if (context.variables.get('__foreach_incomplete')) {
        this.emit('node:log', '_engine',
          `Leaving ${ids.length} session(s) open: a for-each stopped at its maxItems limit, so their files are not all processed`);
        return;
      }

      // Lazy require so we don't bloat module load for non-DB flows
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { prisma } = require('../../lib/prisma');
      const newStatus = success ? 'completed' : 'archived';
      const now = new Date();

      const result = await prisma.processingSession.updateMany({
        where: {
          id: { in: ids },
          // Only auto-close sessions that haven't already been finalised
          status: { in: ['open', 'published', 'processing'] },
        },
        data: {
          status: newStatus,
          completedAt: now,
        },
      });

      if (result.count > 0) {
        this.emit('node:log', '_engine', `Auto-closed ${result.count} session(s) as ${newStatus}`);
      }

      // Log to session_logs so users can see why state changed
      for (const sessionId of ids) {
        try {
          await prisma.sessionLog.create({
            data: {
              sessionId,
              type: 'session_completed',
              message: `Session ${newStatus} after flow execution`,
              metadata: JSON.stringify({ success, completedAt: now, flowId: context.flow.operationId }),
            },
          });
        } catch (_) { /* swallow log failures — non-critical */ }
      }

      // "Archive after processing" on the basket-trigger: move the finished
      // sessions on to 'archived'. The checkbox existed in the designer but was
      // never acted on, so pushed sessions sat in 'completed' forever.
      const trigger = context.flow.nodes.find(n => n.type === 'basket-trigger');
      if (success && trigger?.data?.options?.archiveAfterTransfer) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { archiveSession } = require('../../services/sessionArchive');
        for (const sessionId of ids) {
          try {
            await archiveSession(sessionId, `Archive after processing, flow ${context.flow.operationId}`);
            this.emit('node:log', '_engine', `Archived session ${sessionId} (Archive after processing)`);
          } catch (err: any) {
            console.error(`[ExecutionEngine] Archive after processing failed for session ${sessionId}:`, err.message);
          }
        }
      }
    } catch (err: any) {
      console.error('[ExecutionEngine] closeTriggeredSessions failed:', err.message);
    }
  }

  private async executeChain(
    startId: string,
    context: ExecutionContext,
    adjacencyList: Map<string, string[]>,
    flow: FlowDefinition
  ): Promise<void> {
    let nodeId: string | undefined = startId;
    const chainVisited = new Set<string>();

    while (nodeId && !chainVisited.has(nodeId)) {
      chainVisited.add(nodeId);
      const node = flow.nodes.find(n => n.id === nodeId);
      if (!node || node.type === 'for-each') break; // stop at another loop boundary

      const result = await this.executeNode(node, context);
      context.input = result.output;

      if (node.type === 'condition') {
        const conditionResult = result.output;
        const nextEdge = flow.edges.find(e =>
          e.source === nodeId &&
          (conditionResult.result ? e.label === 'true' : (e.label === 'false' || !e.label))
        );
        nodeId = nextEdge?.target;
      } else {
        const nextNodes = adjacencyList.get(nodeId) || [];
        nodeId = nextNodes[0];
      }
    }
  }

  /**
   * Follow the chain from startId to find the last node (for collecting loop results)
   */
  private getLastNodeInChain(
    startId: string,
    adjacencyList: Map<string, string[]>,
    flow: FlowDefinition
  ): string | undefined {
    let nodeId: string | undefined = startId;
    let lastId: string | undefined = startId;
    const visited = new Set<string>();

    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = flow.nodes.find(n => n.id === nodeId);
      if (!node || node.type === 'for-each') break;
      lastId = nodeId;
      const nextArr: string[] = adjacencyList.get(nodeId) || [];
      nodeId = nextArr[0];
    }

    return lastId;
  }

  /**
   * Execute a chain of nodes until hitting a stop node (e.g., aggregate-join)
   */
  private async executeChainUntil(
    startId: string,
    context: ExecutionContext,
    adjacencyList: Map<string, string[]>,
    flow: FlowDefinition,
    stopNodeId?: string
  ): Promise<void> {
    let nodeId: string | undefined = startId;
    const chainVisited = new Set<string>();

    while (nodeId && !chainVisited.has(nodeId)) {
      // Stop before the join node
      if (stopNodeId && nodeId === stopNodeId) break;

      chainVisited.add(nodeId);
      const node = flow.nodes.find(n => n.id === nodeId);
      if (!node) break;

      const result = await this.executeNode(node, context);
      context.input = result.output;

      if (node.type === 'condition') {
        const conditionResult = result.output;
        const nextEdge = flow.edges.find(e =>
          e.source === nodeId &&
          (conditionResult.result ? e.label === 'true' : (e.label === 'false' || !e.label))
        );
        nodeId = nextEdge?.target;
      } else {
        const nextNodes = adjacencyList.get(nodeId) || [];
        nodeId = nextNodes[0];
      }
    }
  }

  /**
   * Find the aggregate-join node reachable from branch targets
   */
  private findJoinNode(
    branchTargets: string[],
    adjacencyList: Map<string, string[]>,
    flow: FlowDefinition
  ): string | undefined {
    // Follow each branch to find a common aggregate-join node
    for (const startId of branchTargets) {
      let nodeId: string | undefined = startId;
      const visited = new Set<string>();
      while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = flow.nodes.find(n => n.id === nodeId);
        if (node?.type === 'aggregate-join') return nodeId;
        const nextArr: string[] = adjacencyList.get(nodeId) || [];
        nodeId = nextArr[0];
      }
    }
    return undefined;
  }

  private async executeNode(node: any, context: ExecutionContext): Promise<NodeExecutionResult> {
    const executor = this.executors.get(node.type);
    
    if (!executor) {
      throw new Error(`No executor registered for node type: ${node.type}`);
    }

    this.emit('node:start', node.id, context);
    this.config.onNodeStart?.(node.id, context);

    try {
      const result = await executor.execute(node, context);
      
      this.emit('node:complete', node.id, result, context);
      this.config.onNodeComplete?.(node.id, result, context);
      
      return result;
    } catch (error) {
      this.emit('node:error', node.id, error, context);
      this.config.onNodeError?.(node.id, error as Error, context);
      throw error;
    }
  }

  private async runMiddlewares(context: ExecutionContext): Promise<void> {
    for (const middleware of this.middlewares) {
      let nextCalled = false;
      await middleware(context, async () => {
        nextCalled = true;
      });
      if (!nextCalled) {
        break;
      }
    }
  }

  // Utility: Get execution logs
  getLogs(context: ExecutionContext): ExecutionLog[] {
    return context.logs;
  }

  // Utility: Clear connection pools (for cleanup)
  async cleanup(): Promise<void> {
    // This will be implemented in DatabaseExecutor to close pools
    this.emit('engine:cleanup');
  }
}
