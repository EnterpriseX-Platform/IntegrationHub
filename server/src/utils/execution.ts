import prisma from '../lib/prisma';
import { NodeConnection, ExecutionStatus, FlowType } from '../types';

export interface ExecutionResult {
  success: boolean;
  executionId?: string;
  message: string;
  nodeResults: NodeExecutionResult[];
  duration?: number;
  error?: string;
}

export interface NodeExecutionResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
  output?: any;
  error?: string;
  duration: number;
}

export interface ExecutionContext {
  flowId: string;
  flowName: string;
  projectId: string;
  projectName: string;
  type: FlowType;
  executionId: string;
  variables: Record<string, any>;
}

/**
 * Execute a flow by running its nodes sequentially
 */
export async function executeFlow(
  flowId: string,
  triggerData?: Record<string, any>
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const nodeResults: NodeExecutionResult[] = [];

  try {
    // Get flow with nodes and connections
    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      include: {
        project: true,
      },
    });

    if (!flow) {
      return {
        success: false,
        message: `Flow not found: ${flowId}`,
        nodeResults,
      };
    }

    // Create execution record
    const execution = await prisma.execution.create({
      data: {
        flowId,
        projectId: flow.projectId,
        status: 'Running',
        startedAt: new Date(),
        logs: JSON.stringify([]),
        result: JSON.stringify({}),
      },
    });

    // Create execution context
    const context: ExecutionContext = {
      flowId,
      flowName: flow.name,
      projectId: flow.projectId,
      projectName: flow.project.name,
      type: flow.type as FlowType,
      executionId: execution.id,
      variables: { ...triggerData },
    };

    // Parse nodes and connections from JSON strings
    const nodes = JSON.parse(flow.nodes || '[]');
    const connections = JSON.parse(flow.connections || '[]');

    // Log execution start
    await logExecutionStep(execution.id, 'info', 'Starting flow execution...', null, null);

    // Build execution graph
    const nodeMap = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
    const connectionMap = buildConnectionMap(connections as NodeConnection[]);

    // Find starting nodes (nodes with no incoming connections or trigger/api-input nodes)
    const startNodes = nodes.filter((node: any) => 
      node.type === 'trigger' || node.type === 'api-input' || node.type === 'webhook'
    );

    if (startNodes.length === 0) {
      await updateExecutionStatus(execution.id, 'Failed', Date.now() - startTime);
      await logExecutionStep(execution.id, 'error', 'No starting node found in flow', null, null);
      return {
        success: false,
        executionId: execution.id,
        message: 'No starting node found in flow',
        nodeResults,
      };
    }

    // Execute flow starting from each start node
    for (const startNode of startNodes) {
      await executeNodeChain(startNode, nodeMap, connectionMap, context, nodeResults);
    }

    // Check if any node failed
    const failedNode = nodeResults.find(r => r.status === 'failed');
    const hasFailure = !!failedNode;
    const finalStatus: ExecutionStatus = hasFailure ? 'Failed' : 'Completed';
    const duration = Date.now() - startTime;

    // Update execution status with error info
    await updateExecutionStatus(execution.id, finalStatus, duration, failedNode?.error);

    // Update flow with execution result
    await prisma.flow.update({
      where: { id: flowId },
      data: {
        updatedAt: new Date(),
      },
    });

    await logExecutionStep(
      execution.id,
      hasFailure ? 'error' : 'success',
      hasFailure ? 'Flow execution failed' : 'Flow execution completed successfully',
      null,
      null
    );

    return {
      success: !hasFailure,
      executionId: execution.id,
      message: hasFailure ? 'Flow execution failed' : 'Flow execution completed successfully',
      nodeResults,
      duration,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Execution error: ${errorMessage}`,
      nodeResults,
      error: errorMessage,
    };
  }
}

/**
 * Execute a chain of nodes starting from a given node
 */
async function executeNodeChain(
  startNode: any,
  nodeMap: Map<string, any>,
  connectionMap: Map<string, string[]>,
  context: ExecutionContext,
  results: NodeExecutionResult[]
): Promise<void> {
  const visited = new Set<string>();
  const queue: string[] = [startNode.id];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    // Execute the node
    const result = await executeNode(node, context);
    results.push(result);

    // If node failed, stop this chain
    if (result.status === 'failed') {
      break;
    }

    // Add next nodes to queue
    const nextNodeIds = connectionMap.get(nodeId) || [];
    queue.push(...nextNodeIds);
  }
}

/**
 * Execute a single node
 */
async function executeNode(node: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const nodeStartTime = Date.now();
  const config = parseConfig(node.config);

  try {
    await logExecutionStep(
      context.executionId,
      'info',
      `Executing: ${node.label}...`,
      node.id,
      node.label
    );

    let result: NodeExecutionResult;

    switch (node.type) {
      case 'trigger':
        result = await executeTriggerNode(node, config, context);
        break;
      case 'api-input':
        result = await executeApiInputNode(node, config, context);
        break;
      case 'api-output':
        result = await executeApiOutputNode(node, config, context);
        break;
      case 'http':
        result = await executeHttpNode(node, config, context);
        break;
      case 'database':
        result = await executeDatabaseNode(node, config, context);
        break;
      case 'sftp':
        result = await executeSftpNode(node, config, context);
        break;
      case 'transform':
        result = await executeTransformNode(node, config, context);
        break;
      case 'condition':
        result = await executeConditionNode(node, config, context);
        break;
      case 'loop':
        result = await executeLoopNode(node, config, context);
        break;
      case 'webhook':
        result = await executeWebhookNode(node, config, context);
        break;
      default:
        result = {
          nodeId: node.id,
          nodeName: node.label,
          nodeType: node.type,
          status: 'success',
          message: `Unknown node type: ${node.type}`,
          duration: Date.now() - nodeStartTime,
        };
    }

    // Log result
    await logExecutionStep(
      context.executionId,
      result.status === 'success' ? 'success' : 'error',
      `${node.label}: ${result.status === 'success' ? 'Success' : 'Failed'} - ${result.message}`,
      node.id,
      node.label
    );

    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const duration = Date.now() - nodeStartTime;

    await logExecutionStep(
      context.executionId,
      'error',
      `${node.label}: Error - ${errorMessage}`,
      node.id,
      node.label
    );

    return {
      nodeId: node.id,
      nodeName: node.label,
      nodeType: node.type,
      status: 'failed',
      message: errorMessage,
      error: errorMessage,
      duration,
    };
  }
}

// Node type specific executors
async function executeTriggerNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const duration = 100; // Simulated duration
  
  // Store trigger data in context
  if (config.schedule) {
    context.variables.triggerSchedule = config.schedule;
  }

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Trigger executed: ${config.schedule || 'Manual'}`,
    output: { triggered: true, timestamp: new Date().toISOString() },
    duration,
  };
}

async function executeApiInputNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const duration = 50;
  
  // Validate input parameters
  const requiredParams = config.requiredParams || [];
  const missingParams = requiredParams.filter((p: string) => !context.variables[p]);
  
  if (missingParams.length > 0) {
    return {
      nodeId: node.id,
      nodeName: node.label,
      nodeType: node.type,
      status: 'failed',
      message: `Missing required parameters: ${missingParams.join(', ')}`,
      duration,
    };
  }

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: 'Input validation passed',
    output: { validated: true, params: context.variables },
    duration,
  };
}

async function executeApiOutputNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const duration = 50;
  const statusCode = config.status || 200;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Response sent: ${statusCode} OK`,
    output: { statusCode, data: context.variables },
    duration,
  };
}

async function executeHttpNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const startTime = Date.now();
  
  // Simulate HTTP request
  await simulateDelay(config.timeout || 1000);
  
  const duration = Date.now() - startTime;
  
  // Mock response
  const response = {
    status: 200,
    data: { message: 'HTTP request successful', timestamp: new Date().toISOString() },
  };

  // Store response in context
  context.variables.httpResponse = response;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `HTTP request completed: ${response.status} OK`,
    output: response,
    duration,
  };
}

async function executeDatabaseNode(node: any, config: any, _context: ExecutionContext): Promise<NodeExecutionResult> {
  const startTime = Date.now();
  
  // Simulate database operation
  await simulateDelay(500);
  
  const duration = Date.now() - startTime;
  const operation = config.operation || 'QUERY';
  const recordCount = Math.floor(Math.random() * 200) + 50;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Database ${operation} completed: ${recordCount} records`,
    output: { operation, recordCount },
    duration,
  };
}

async function executeSftpNode(node: any, config: any, _context: ExecutionContext): Promise<NodeExecutionResult> {
  const startTime = Date.now();
  
  // Simulate SFTP operation
  await simulateDelay(800);
  
  const duration = Date.now() - startTime;
  const operation = config.operation || 'DOWNLOAD';
  const fileCount = Math.floor(Math.random() * 10) + 1;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `SFTP ${operation} completed: ${fileCount} files`,
    output: { operation, fileCount, host: config.host },
    duration,
  };
}

async function executeTransformNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const startTime = Date.now();
  
  // Simulate data transformation
  await simulateDelay(200);
  
  const duration = Date.now() - startTime;
  const mappings = config.mappings || 1;

  // Transform data in context
  if (context.variables.httpResponse?.data) {
    context.variables.transformedData = {
      ...context.variables.httpResponse.data,
      transformed: true,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Data transformation completed: ${mappings} mappings applied`,
    output: { mappings, transformed: true },
    duration,
  };
}

async function executeConditionNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const duration = 50;
  
  // Evaluate condition
  const condition = config.condition || 'true';
  const result = evaluateCondition(condition, context.variables);

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Condition evaluated: ${result ? 'True' : 'False'}`,
    output: { condition, result },
    duration,
  };
}

async function executeLoopNode(node: any, config: any, context: ExecutionContext): Promise<NodeExecutionResult> {
  const startTime = Date.now();
  
  const iterations = config.iterations || 1;
  const items = context.variables[config.itemsVar] || [];
  const actualIterations = Math.min(iterations, items.length || iterations);

  // Simulate loop execution
  await simulateDelay(100 * actualIterations);
  
  const duration = Date.now() - startTime;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Loop completed: ${actualIterations} iterations`,
    output: { iterations: actualIterations },
    duration,
  };
}

async function executeWebhookNode(node: any, config: any, _context: ExecutionContext): Promise<NodeExecutionResult> {
  const duration = 100;

  return {
    nodeId: node.id,
    nodeName: node.label,
    nodeType: node.type,
    status: 'success',
    message: `Webhook received: ${config.method || 'POST'}`,
    output: { webhookId: node.id, timestamp: new Date().toISOString() },
    duration,
  };
}

// Helper functions
function buildConnectionMap(connections: NodeConnection[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  
  for (const conn of connections) {
    const existing = map.get(conn.source) || [];
    existing.push(conn.target);
    map.set(conn.source, existing);
  }
  
  return map;
}

function parseConfig(configStr: string): any {
  try {
    return JSON.parse(configStr);
  } catch {
    return {};
  }
}

async function logExecutionStep(
  executionId: string,
  level: 'info' | 'success' | 'error' | 'warning',
  message: string,
  nodeId: string | null,
  nodeName: string | null
): Promise<void> {
  try {
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
    });
    
    if (!execution) return;
    
    const logs = JSON.parse(execution.logs || '[]');
    logs.push({
      level,
      message,
      nodeId,
      nodeName,
      timestamp: new Date().toISOString(),
    });
    
    await prisma.execution.update({
      where: { id: executionId },
      data: {
        logs: JSON.stringify(logs),
      },
    });
  } catch (error) {
    console.error('Failed to log execution step:', error);
  }
}

async function updateExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
  duration: number,
  errorMessage?: string
): Promise<void> {
  // Categorize error if failed
  let errorType: string | undefined;
  if (status === 'Failed' && errorMessage) {
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      errorType = 'timeout';
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection')) {
      errorType = 'connection';
    } else if (errorMessage.includes('validation') || errorMessage.includes('Validation')) {
      errorType = 'validation';
    } else if (errorMessage.includes('cancelled') || errorMessage.includes('Cancel')) {
      errorType = 'cancelled';
    } else {
      errorType = 'other';
    }
  }

  await prisma.execution.update({
    where: { id: executionId },
    data: {
      status,
      endedAt: status !== 'Running' ? new Date() : null,
      durationMs: duration,
      errorType,
      result: JSON.stringify({ duration }),
    },
  });
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.min(ms, 100)));
}

function evaluateCondition(condition: string, variables: Record<string, any>): boolean {
  try {
    // Simple condition evaluation - in production, use a proper expression parser
    if (condition === 'true') return true;
    if (condition === 'false') return false;
    
    // Check for variable comparison
    const parts = condition.split(' ');
    if (parts.length === 3) {
      const [left, operator, right] = parts;
      const leftValue = variables[left] ?? left;
      const rightValue = variables[right] ?? right;
      
      switch (operator) {
        case '==': return leftValue == rightValue;
        case '!=': return leftValue != rightValue;
        case '>': return Number(leftValue) > Number(rightValue);
        case '<': return Number(leftValue) < Number(rightValue);
        case '>=': return Number(leftValue) >= Number(rightValue);
        case '<=': return Number(leftValue) <= Number(rightValue);
      }
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Get execution logs
 */
export async function getExecutionLogs(executionId: string) {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
  });
  
  if (!execution) {
    return [];
  }
  
  return JSON.parse(execution.logs || '[]');
}

/**
 * Cancel a running execution
 */
export async function cancelExecution(executionId: string): Promise<boolean> {
  try {
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
    });

    if (!execution || execution.status !== 'Running') {
      return false;
    }

    await prisma.execution.update({
      where: { id: executionId },
      data: {
        status: 'Failed',
        endedAt: new Date(),
      },
    });

    await logExecutionStep(executionId, 'error', 'Execution cancelled by user', null, null);

    return true;
  } catch (error) {
    console.error('Failed to cancel execution:', error);
    return false;
  }
}

/**
 * Retry a failed execution
 */
export async function retryExecution(executionId: string): Promise<ExecutionResult> {
  try {
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
    });

    if (!execution) {
      return {
        success: false,
        message: `Execution not found: ${executionId}`,
        nodeResults: [],
      };
    }

    // Retry the flow — only meaningful for flow-sourced executions
    if (!execution.flowId) {
      return {
        success: false,
        message: 'Cannot retry a non-flow execution (e.g. repo-import)',
        nodeResults: [],
      };
    }
    return executeFlow(execution.flowId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Retry failed: ${errorMessage}`,
      nodeResults: [],
    };
  }
}

export default {
  executeFlow,
  getExecutionLogs,
  cancelExecution,
  retryExecution,
};
