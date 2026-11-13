// Transform Node Executor - Transforms data using mapping or code

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';

interface TransformNodeData {
  label?: string;
  mapping?: Record<string, any>;
  code?: string;
}

export class TransformExecutor extends NodeExecutor {
  readonly type = 'transform';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as TransformNodeData;
    
    // Get input from previous node
    let input: any = {};
    const incomingEdge = context.flow.edges.find(e => e.target === node.id);
    if (incomingEdge && context.nodeResults) {
      const prevResult = context.nodeResults.get(incomingEdge.source);
      if (prevResult?.output) {
        input = prevResult.output;
      }
    }

    // Debug logging input
    this.log(context, 'debug', 'Transform Input', { input });

    let result: any;

    // Apply mapping if defined
    if (data.mapping) {
      result = this.applyMapping(data.mapping, context);
      this.log(context, 'debug', 'Transform Mapping Applied', { 
        mapping: data.mapping,
        result,
      });
      return result;
    }

    // Execute code if defined (sandboxed)
    if (data.code) {
      // For security, only allow simple transformations
      // In production, use a proper sandbox like vm2 or isolated-vm
      result = this.executeCode(data.code, input, context);
      this.log(context, 'debug', 'Transform Code Executed', {
        code: data.code,
        input,
        result,
      });
      return result;
    }

    // Default: pass through
    this.log(context, 'debug', 'Transform Pass Through', { input });
    return input;
  }

  private applyMapping(mapping: Record<string, any>, context: ExecutionContext): any {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        result[key] = this.resolveTemplate(value, context);
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.applyMapping(value, context);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  private executeCode(code: string, input: any, context: ExecutionContext): any {
    // Simple transformation - just return the mapping logic
    // In production, this should be properly sandboxed
    try {
      // Create a safe context with limited variables
      const fn = new Function('input', 'vars', 'context', `
        "use strict";
        ${code}
      `);
      
      const vars = Object.fromEntries(context.variables || new Map());
      return fn(input, vars, context);
    } catch (error) {
      throw new Error(`Transform code execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
