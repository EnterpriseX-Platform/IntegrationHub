// Condition Node Executor - Evaluates conditions and routes flow

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ConditionNodeData {
  label?: string;
  condition: string;
  checkDuplicate?: boolean; // Enable duplicate check
  duplicateKey?: string;    // Parameter name to check (e.g., 'year', 'fy')
}

export class ConditionExecutor extends NodeExecutor {
  readonly type = 'condition';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as ConditionNodeData;
    
    if (!data.condition) {
      throw new Error('Condition node missing condition expression');
    }

    // Get input from previous node — store reference, don't copy large data
    let input: any = {};
    let prevNodeVarName: string | undefined;
    const incomingEdge = context.flow.edges.find(e => e.target === node.id);
    if (incomingEdge && context.nodeResults) {
      const prevResult = context.nodeResults.get(incomingEdge.source);
      if (prevResult?.output) {
        input = prevResult.output;
        // Find varName of previous node
        const prevNode = context.flow.nodes.find((n: any) => n.id === incomingEdge.source);
        prevNodeVarName = prevNode?.data?.varName || incomingEdge.source;
      }
    }
    // Store previous output in context.variables for downstream access
    context.variables.set('_conditionInput', input);

    // Pre-process executions.exists() if present in condition
    let processedCondition = data.condition;
    const execExistsMatch = data.condition.match(/executions\.exists\(([^)]+)\)/);
    
    if (execExistsMatch) {
      const argsStr = execExistsMatch[1];
      const existsResult = await this.processExecutionExists(argsStr, context);
      // Replace executions.exists(...) with true/false
      processedCondition = data.condition.replace(
        /executions\.exists\([^)]+\)/g, 
        existsResult ? 'true' : 'false'
      );
    }
    
    // Also check legacy checkDuplicate flag
    let duplicateCheckResult: { checked: boolean; passed?: boolean; isDuplicate?: boolean; key?: string; value?: any } = { checked: false };
    
    if (data.checkDuplicate && !execExistsMatch) {
      const triggerParams = context.variables.get('_triggerParams') || {};
      const dupKey = data.duplicateKey || 'year';
      const dupValue = triggerParams[dupKey];
      
      if (dupValue !== undefined) {
        const isDup = await this.checkDuplicateExecution(context.flow.operationId, dupKey, String(dupValue));
        duplicateCheckResult = {
          checked: true,
          passed: !isDup,
          isDuplicate: isDup,
          key: dupKey,
          value: dupValue,
        };
        
        // Store result for condition evaluation
        context.variables.set('executionsExists', isDup);
        context.variables.set('duplicateKey', dupKey);
        context.variables.set('duplicateValue', dupValue);
        
        if (isDup) {
          console.log(`[ConditionExecutor] Duplicate found for ${dupKey}=${dupValue}`);
        }
      }
    }
    
    // Evaluate condition
    const conditionResult = this.evaluateCondition(processedCondition, context);
    
    // Find outgoing edges based on condition result
    const outgoingEdges = context.flow.edges.filter(e => e.source === node.id);
    const matchingEdge = outgoingEdges.find(e => {
      if (conditionResult) return e.label === 'true' || e.label === 'yes';
      return e.label === 'false' || e.label === 'no' || !e.label;
    });

    return {
      condition: data.condition,
      processedCondition,
      result: conditionResult,
      nextNodeId: matchingEdge?.target,
      prevNodeVarName,
      // Pass lightweight summary instead of full data to avoid OOM on large datasets
      inputSummary: {
        rowCount: input?.rows?.length ?? input?.rowCount ?? (Array.isArray(input) ? input.length : undefined),
      },
      duplicateCheck: duplicateCheckResult.checked ? duplicateCheckResult : undefined,
    };
  }

  /**
   * Process executions.exists() and return result
   */
  private async processExecutionExists(argsStr: string, context: ExecutionContext): Promise<boolean> {
    // Parse: year={{year}} or 'year', {{year}}
    let key: string | undefined;
    let value: any;
    
    const keyValueMatch = argsStr.match(/(\w+)\s*=\s*(.+)/);
    if (keyValueMatch) {
      key = keyValueMatch[1];
      const valueExpr = keyValueMatch[2].trim();
      value = this.getValueByPath(context, valueExpr.replace(/^\{\{|\}\}$/g, ''));
    } else {
      const parts = argsStr.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        key = parts[0].replace(/^['"]|['"]$/g, '');
        const valueExpr = parts[1];
        value = this.getValueByPath(context, valueExpr.replace(/^\{\{|\}\}$/g, ''));
      }
    }
    
    if (!key || value === undefined) {
      console.error('[ConditionExecutor] Invalid executions.exists() format:', argsStr);
      return false;
    }
    
    // Check execution logs
    const exists = await this.checkDuplicateExecution(context.flow.operationId, key, String(value));
    
    // Store for reference
    context.variables.set('executionsExists', exists);
    context.variables.set('executionsCheckKey', key);
    context.variables.set('executionsCheckValue', value);
    
    return exists;
  }

  private evaluateCondition(condition: string, context: ExecutionContext): boolean {
    console.log('[ConditionExecutor] Evaluating:', condition);
    
    // Check for executions.exists() pattern
    // Pattern: executions.exists(key=value) or executions.exists('key', value)
    const execExistsMatch = condition.match(/executions\.exists\(([^)]+)\)/);
    if (execExistsMatch) {
      return this.evaluateExecutionExists(execExistsMatch[1], condition, context);
    }
    
    // Check if condition is a template expression
    const templateMatch = condition.match(/^\{\{(.+)\}\}$/);
    
    if (templateMatch) {
      const expr = templateMatch[1].trim();
      
      // Check if expression contains operators (comparison, logical)
      if (/[><=!&|]/.test(expr)) {
        // It's an expression - evaluate it
        // Replace variable references with actual values
        // Support hyphenated names like "check-exist.rows.length"
        const resolvedExpr = expr.replace(/([a-zA-Z_][a-zA-Z0-9_-]*(?:(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)|(?:\[\d+\]))*)/g, (match) => {
          // Skip JavaScript keywords and literals
          if (['true', 'false', 'null', 'undefined'].includes(match)) return match;

          const value = this.getValueByPath(context, match);
          if (value === undefined) return 'undefined';
          if (value === null) return 'null';
          if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
          if (typeof value === 'number' || typeof value === 'boolean') return String(value);
          // For arrays/objects, avoid JSON.stringify on large data — use length or truthy check
          if (Array.isArray(value)) return String(value.length > 0);
          if (typeof value === 'object') return 'true';
          return String(value);
        });
        
        try {
          const result = Boolean(eval(resolvedExpr));
          console.log('[ConditionExecutor] Resolved expr:', resolvedExpr, 'Result:', result);
          return result;
        } catch (e) {
          console.error('Condition evaluation failed:', resolvedExpr, e);
          return false;
        }
      } else {
        // It's just a property path - resolve and check truthiness
        const value = this.getValueByPath(context, expr);
        return Boolean(value);
      }
    }
    
    // Not a template - evaluate as expression or check truthiness
    try {
      return Boolean(eval(condition));
    } catch {
      return Boolean(condition);
    }
  }

  /**
   * Evaluate executions.exists() condition
   * Supports: executions.exists(year={{year}}) or executions.exists('year', {{year}})
   */
  private evaluateExecutionExists(argsStr: string, _fullCondition: string, context: ExecutionContext): boolean {
    // Parse arguments
    // Format 1: year={{year}} 
    // Format 2: 'year', {{year}}
    
    let key: string | undefined;
    let value: any;
    
    // Try format: key=value
    const keyValueMatch = argsStr.match(/(\w+)\s*=\s*(.+)/);
    if (keyValueMatch) {
      key = keyValueMatch[1];
      const valueExpr = keyValueMatch[2].trim();
      // Resolve value from context
      value = this.getValueByPath(context, valueExpr.replace(/^\{\{|\}\}$/g, ''));
    } else {
      // Try format: 'key', value
      const parts = argsStr.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        key = parts[0].replace(/^['"]|['"]$/g, ''); // Remove quotes
        const valueExpr = parts[1];
        value = this.getValueByPath(context, valueExpr.replace(/^\{\{|\}\}$/g, ''));
      }
    }
    
    if (!key || value === undefined) {
      console.error('[ConditionExecutor] Invalid executions.exists() format:', argsStr);
      return false;
    }
    
    // Check execution logs (async but we need sync result for evaluateCondition)
    // This is a limitation - we'll handle this in executeNode instead
    // For now, return false and let executeNode handle the actual check
    
    // Store the check request for async handling
    context.variables.set('_pendingDuplicateCheck', { key, value });
    
    // Return true for now, actual check happens in executeNode
    return true;
  }

  /**
   * Check if execution with specific parameter value already exists
   */
  private async checkDuplicateExecution(
    flowId: string,
    paramKey: string,
    paramValue: string
  ): Promise<boolean> {
    try {
      // Find successful executions for this flow (last 365 days)
      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - 365);

      const executions = await prisma.execution.findMany({
        where: {
          flowId,
          status: 'Success',
          startedAt: {
            gte: lookbackDate,
          },
        },
        orderBy: {
          startedAt: 'desc',
        },
        take: 50,
      });

      for (const execution of executions) {
        try {
          const result = execution.result ? JSON.parse(execution.result) : null;
          if (result && result.trigger && result.trigger.parameters) {
            const execParams = result.trigger.parameters;
            const execValue = execParams[paramKey];
            
            if (execValue !== undefined && String(execValue) === paramValue) {
              console.log(`[ConditionExecutor] Duplicate found: Flow ${flowId} already executed with ${paramKey}=${paramValue} on ${execution.startedAt}`);
              return true;
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      return false;
    } catch (error) {
      console.error('[ConditionExecutor] Error checking duplicate execution:', error);
      return false; // Allow execution if check fails
    }
  }
}
