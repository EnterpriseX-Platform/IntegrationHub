#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { apiClient } from './utils/api-client.js';
import { z } from 'zod';

// Tool Definitions
const TOOLS: Tool[] = [
  {
    name: 'get_flow',
    description: 'Get flow details by ID',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'update_flow_nodes',
    description: 'Update flow nodes and connections',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        nodes: {
          type: 'array',
          description: 'Array of flow nodes',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              data: { type: 'object' },
            },
            required: ['id', 'type', 'x', 'y'],
          },
        },
        connections: {
          type: 'array',
          description: 'Array of flow connections (edges)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['id', 'from', 'to'],
          },
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'update_schedule_trigger_params',
    description: 'Update schedule-trigger node parameters',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        nodeId: { type: 'string', description: 'Schedule-trigger node ID' },
        parameters: {
          type: 'array',
          description: 'Array of parameters',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
        cron: { type: 'string', description: 'Cron expression (optional)' },
        timezone: { type: 'string', description: 'Timezone (optional)' },
        enabled: { type: 'boolean', description: 'Enable/disable scheduler' },
      },
      required: ['flowId', 'nodeId', 'parameters'],
    },
  },
  {
    name: 'update_database_sql',
    description: 'Update database node SQL query',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        nodeId: { type: 'string', description: 'Database node ID' },
        sql: { type: 'string', description: 'SQL query' },
        connectionId: { type: 'string', description: 'Connection ID (optional)' },
      },
      required: ['flowId', 'nodeId', 'sql'],
    },
  },
  {
    name: 'execute_flow',
    description: 'Execute/Run a flow with optional parameters',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        parameters: {
          type: 'object',
          description: 'Optional parameters to pass to the flow',
          additionalProperties: true,
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'get_flow_executions',
    description: 'Get execution history of a flow',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        limit: { type: 'number', description: 'Number of executions to return', default: 10 },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'get_execution_logs',
    description: 'Get logs for a specific execution',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'Execution ID' },
      },
      required: ['executionId'],
    },
  },
  {
    name: 'list_project_flows',
    description: 'List all flows in a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'find_node_by_type',
    description: 'Find a node in flow by type',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
        nodeType: { type: 'string', description: 'Node type (e.g., schedule-trigger, database)' },
      },
      required: ['flowId', 'nodeType'],
    },
  },
  {
    name: 'analyze_flow',
    description: 'Analyze flow structure and provide summary',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID' },
      },
      required: ['flowId'],
    },
  },
];

// Tool Handlers
async function handleGetFlow(args: any) {
  const result = await apiClient.getFlow(args.flowId);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

async function handleUpdateFlowNodes(args: any) {
  const result = await apiClient.updateFlow(args.flowId, {
    nodes: JSON.stringify(args.nodes),
    connections: JSON.stringify(args.connections),
  });
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: 'Flow updated successfully' }] };
}

async function handleUpdateScheduleTriggerParams(args: any) {
  // First get the current flow
  const flowResult = await apiClient.getFlow(args.flowId);
  if (!flowResult.success) {
    return { content: [{ type: 'text', text: `Error getting flow: ${flowResult.error}` }] };
  }

  const flow = flowResult.data!;
  const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;

  // Find and update the schedule-trigger node
  const nodeIndex = nodes.findIndex((n: any) => n.id === args.nodeId && n.type === 'schedule-trigger');
  if (nodeIndex === -1) {
    return { content: [{ type: 'text', text: `Schedule-trigger node ${args.nodeId} not found` }] };
  }

  // Update node data
  nodes[nodeIndex].data = {
    ...nodes[nodeIndex].data,
    parameters: args.parameters,
    ...(args.cron && { cron: args.cron }),
    ...(args.timezone && { timezone: args.timezone }),
    ...(args.enabled !== undefined && { enabled: args.enabled }),
  };

  // Save the flow
  const updateResult = await apiClient.updateFlow(args.flowId, {
    nodes: JSON.stringify(nodes),
  });

  if (!updateResult.success) {
    return { content: [{ type: 'text', text: `Error updating flow: ${updateResult.error}` }] };
  }

  return { content: [{ type: 'text', text: `Schedule-trigger node updated with ${args.parameters.length} parameters` }] };
}

async function handleUpdateDatabaseSql(args: any) {
  // First get the current flow
  const flowResult = await apiClient.getFlow(args.flowId);
  if (!flowResult.success) {
    return { content: [{ type: 'text', text: `Error getting flow: ${flowResult.error}` }] };
  }

  const flow = flowResult.data!;
  const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;

  // Find and update the database node
  const nodeIndex = nodes.findIndex((n: any) => n.id === args.nodeId && n.type === 'database');
  if (nodeIndex === -1) {
    return { content: [{ type: 'text', text: `Database node ${args.nodeId} not found` }] };
  }

  // Update node data
  nodes[nodeIndex].data = {
    ...nodes[nodeIndex].data,
    sql: args.sql,
    ...(args.connectionId && { connectionId: args.connectionId }),
  };

  // Save the flow
  const updateResult = await apiClient.updateFlow(args.flowId, {
    nodes: JSON.stringify(nodes),
  });

  if (!updateResult.success) {
    return { content: [{ type: 'text', text: `Error updating flow: ${updateResult.error}` }] };
  }

  return { content: [{ type: 'text', text: 'Database SQL updated successfully' }] };
}

async function handleExecuteFlow(args: any) {
  const result = await apiClient.executeFlow(args.flowId, args.parameters);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: `Flow executed successfully!\nExecution ID: ${result.data?.executionId}\nResult: ${JSON.stringify(result.data, null, 2)}` }] };
}

async function handleGetFlowExecutions(args: any) {
  const result = await apiClient.getExecutions(args.flowId, args.limit || 10);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

async function handleGetExecutionLogs(args: any) {
  const result = await apiClient.getExecutionLogs(args.executionId);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

async function handleListProjectFlows(args: any) {
  const result = await apiClient.getProjectFlows(args.projectId);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
}

async function handleFindNodeByType(args: any) {
  const result = await apiClient.getFlow(args.flowId);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }

  const flow = result.data!;
  const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;
  const node = nodes.find((n: any) => n.type === args.nodeType);
  
  if (!node) {
    return { content: [{ type: 'text', text: `No node of type '${args.nodeType}' found in flow` }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(node, null, 2) }] };
}

async function handleAnalyzeFlow(args: any) {
  const result = await apiClient.getFlow(args.flowId);
  if (!result.success) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }

  const flow = result.data!;
  const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;
  const connections = (typeof flow.connections === 'string' ? JSON.parse(flow.connections) : flow.connections) || [];

  // Analyze structure
  const nodeTypes = nodes.reduce((acc: Record<string, number>, n: any) => {
    acc[n.type] = (acc[n.type] || 0) + 1;
    return acc;
  }, {});

  const scheduleTrigger = nodes.find((n: any) => n.type === 'schedule-trigger');
  const hasParameters = scheduleTrigger?.data?.parameters?.length > 0;

  const analysis = {
    name: flow.name,
    type: flow.type,
    status: flow.status,
    totalNodes: nodes.length,
    totalConnections: connections.length,
    nodeTypes,
    hasScheduleTrigger: !!scheduleTrigger,
    scheduleEnabled: scheduleTrigger?.data?.enabled ?? false,
    cron: scheduleTrigger?.data?.cron,
    hasParameters,
    parameters: scheduleTrigger?.data?.parameters || [],
    databaseNodes: nodes.filter((n: any) => n.type === 'database').map((n: any) => ({
      id: n.id,
      operation: n.data?.operation,
      hasSql: !!n.data?.sql,
    })),
  };

  return { content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }] };
}

// Main Server
const server = new Server(
  {
    name: 'integration-flow-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'get_flow':
      return handleGetFlow(args);
    case 'update_flow_nodes':
      return handleUpdateFlowNodes(args);
    case 'update_schedule_trigger_params':
      return handleUpdateScheduleTriggerParams(args);
    case 'update_database_sql':
      return handleUpdateDatabaseSql(args);
    case 'execute_flow':
      return handleExecuteFlow(args);
    case 'get_flow_executions':
      return handleGetFlowExecutions(args);
    case 'get_execution_logs':
      return handleGetExecutionLogs(args);
    case 'list_project_flows':
      return handleListProjectFlows(args);
    case 'find_node_by_type':
      return handleFindNodeByType(args);
    case 'analyze_flow':
      return handleAnalyzeFlow(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Integration Flow MCP Server running on stdio');
}

main().catch(console.error);
