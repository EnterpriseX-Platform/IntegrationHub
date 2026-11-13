// Aggregate Executor - Implements Fan-out/Fan-in pattern for parallel execution

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';

interface BranchResult {
  branchId: string;
  success: boolean;
  data?: any;
  error?: string;
  duration: number;
}

interface AggregateSplitConfig {
  branches: number;
  strategy: 'parallel' | 'sequential';
  branchConfig?: any[];
}

interface AggregateJoinConfig {
  waitFor: 'all' | 'any' | number;
  timeout: number;
}

export class AggregateSplitExecutor extends NodeExecutor {
  readonly type = 'aggregate-split';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const config = node.data as AggregateSplitConfig;
    const branches = config?.branches || 2;
    const strategy = config?.strategy || 'parallel';

    console.log(`[AggregateSplit] Creating ${branches} branches with ${strategy} strategy`);

    // Store branch configuration in context for downstream nodes
    const branchInfo = {
      type: 'fan-out',
      totalBranches: branches,
      strategy,
      branchIds: Array.from({ length: branches }, (_, i) => `${node.id}-branch-${i + 1}`),
      createdAt: new Date().toISOString(),
    };

    // Initialize branch results container
    context.variables.set(`__aggregate_${node.id}_branches`, branchInfo);
    context.variables.set(`__aggregate_${node.id}_results`, []);

    return {
      __isAggregate: true,
      __aggregateType: 'fan-out',
      branches: branchInfo.branchIds,
      strategy,
      input: context.variables.get('input'),
    };
  }
}

export class AggregateJoinExecutor extends NodeExecutor {
  readonly type = 'aggregate-join';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const config = node.data as AggregateJoinConfig;
    const waitFor = config?.waitFor || 'all';
    const timeout = config?.timeout || 30000;
    // TODO: Implement timeout handling
    void timeout;

    // Find upstream split node
    const splitNodeId = this.findUpstreamSplitNode(node, context);
    if (!splitNodeId) {
      throw new Error('No upstream aggregate-split node found');
    }

    // Get branch results
    const results: BranchResult[] = context.variables.get(`__aggregate_${splitNodeId}_results`) || [];
    const branchInfo = context.variables.get(`__aggregate_${splitNodeId}_branches`);

    console.log(`[AggregateJoin] Aggregating ${results.length}/${branchInfo?.totalBranches || '?'} branches`);

    // Check if we should wait for more results
    const shouldWait = this.shouldWaitForMoreResults(results, branchInfo?.totalBranches || 0, waitFor);
    
    if (shouldWait) {
      // In real implementation, this would wait for async results
      // For now, we return a pending state
      return {
        __isAggregate: true,
        __aggregateType: 'fan-in',
        status: 'waiting',
        received: results.length,
        expected: branchInfo?.totalBranches || 0,
        waitFor,
      };
    }

    // Aggregate results
    const aggregated = this.aggregateResults(results, waitFor);

    return {
      __isAggregate: true,
      __aggregateType: 'fan-in',
      status: 'completed',
      results: aggregated,
      summary: {
        total: results.length,
        success: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        avgDuration: results.reduce((acc, r) => acc + r.duration, 0) / results.length,
      },
    };
  }

  private findUpstreamSplitNode(_node: ExecutionNode, context: ExecutionContext): string | null {
    // Look for the nearest upstream aggregate-split node
    // This is simplified - in real implementation, traverse the graph
    for (const [key] of context.variables.entries()) {
      if (key.startsWith('__aggregate_') && key.endsWith('_branches')) {
        return key.replace('__aggregate_', '').replace('_branches', '');
      }
    }
    return null;
  }

  private shouldWaitForMoreResults(
    results: BranchResult[], 
    totalBranches: number, 
    waitFor: 'all' | 'any' | number
  ): boolean {
    if (waitFor === 'all') {
      return results.length < totalBranches;
    }
    if (waitFor === 'any') {
      return results.length === 0;
    }
    // waitFor is a number
    return results.length < (waitFor as number);
  }

  private aggregateResults(results: BranchResult[], waitFor: 'all' | 'any' | number): any {
    if (waitFor === 'any') {
      // Return first successful result
      const firstSuccess = results.find(r => r.success);
      return firstSuccess?.data || null;
    }

    // Return all results
    return {
      allResults: results,
      successfulResults: results.filter(r => r.success).map(r => r.data),
      failedResults: results.filter(r => !r.success).map(r => ({ error: r.error, branchId: r.branchId })),
    };
  }
}

// Parallel Branch Executor - Executes branches in parallel
export class ParallelBranchExecutor extends NodeExecutor {
  readonly type = 'parallel-branch';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const branchId = node.data?.branchId || 'unknown';
    const parentSplitId = node.data?.parentSplitId;

    console.log(`[ParallelBranch] Executing branch: ${branchId}`);

    // Mark this branch as running
    const results: BranchResult[] = context.variables.get(`__aggregate_${parentSplitId}_results`) || [];
    
    const startTime = Date.now();
    
    try {
      // Execute branch logic here
      // This would typically call other nodes in the branch
      
      const result: BranchResult = {
        branchId,
        success: true,
        data: context.variables.get('input'),
        duration: Date.now() - startTime,
      };

      // Store result
      results.push(result);
      context.variables.set(`__aggregate_${parentSplitId}_results`, results);

      return {
        __isBranch: true,
        branchId,
        success: true,
        duration: result.duration,
      };
    } catch (error) {
      const result: BranchResult = {
        branchId,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };

      results.push(result);
      context.variables.set(`__aggregate_${parentSplitId}_results`, results);

      throw error;
    }
  }
}
