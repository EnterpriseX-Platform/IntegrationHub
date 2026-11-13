// Base Node Executor - Abstract class for all node executors

import { ExecutionNode, ExecutionContext, NodeExecutionResult } from './types';

export abstract class NodeExecutor {
  abstract readonly type: string;

  async execute(node: ExecutionNode, context: ExecutionContext): Promise<NodeExecutionResult> {
    const startedAt = new Date();
    
    try {
      this.log(context, 'info', `Executing ${this.type} node: ${node.id}`);
      
      const output = await this.executeNode(node, context);
      
      const endedAt = new Date();
      const result: NodeExecutionResult = {
        nodeId: node.id,
        nodeType: this.type,
        success: true,
        output,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };

      // Store result in context variables
      context.nodeResults.set(node.id, result);
      const varName = node.data?.varName || node.id;
      context.variables.set(varName, output);
      // Keep node.id mapping for backward compatibility
      if (varName !== node.id) {
        context.variables.set(node.id, output);
      }

      this.log(context, 'info', `Node ${node.id} (${varName}) completed successfully`);
      
      return result;
    } catch (error) {
      const endedAt = new Date();
      const result: NodeExecutionResult = {
        nodeId: node.id,
        nodeType: this.type,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };

      context.nodeResults.set(node.id, result);
      
      this.log(context, 'error', `Node ${node.id} failed: ${result.error}`);
      
      throw error;
    }
  }

  protected abstract executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any>;

  protected log(context: ExecutionContext, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
    const log = {
      timestamp: new Date(),
      level,
      nodeId: this.getNodeIdFromContext(context),
      message,
      data,
    };
    context.logs.push(log);
  }

  private getNodeIdFromContext(_context: ExecutionContext): string | undefined {
    // Get the currently executing node ID from stack trace or context
    return undefined;
  }

  // Helper: Resolve template strings like "{{input.params.id}}" or "{{path.year}}"
  protected resolveTemplate(template: string, context: ExecutionContext): any {
    if (typeof template !== 'string') return template;
    
    // Match outermost {{...}} - handle nested braces
    const trimmed = template.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
      // Find the matching closing braces (account for nested ones)
      let depth = 0;
      let endIndex = -1;
      for (let i = 0; i < trimmed.length - 1; i++) {
        if (trimmed.slice(i, i + 2) === '{{') {
          depth++;
          i++;
        } else if (trimmed.slice(i, i + 2) === '}}') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
          i++;
        }
      }
      
      if (endIndex > 2) {
        const path = trimmed.slice(2, endIndex).trim();
        const value = this.getStandardValue(context, path);
        
        // If there's remaining content after the template, do string replacement
        const remaining = trimmed.slice(endIndex + 2);
        if (remaining) {
          return (value !== undefined ? String(value) : '') + remaining;
        }
        
        return value;
      }
    }
    
    // Mixed string template with multiple {{...}} - return string
    const regex = /\{\{(.*?)\}\}/g;
    return template.replace(regex, (match, path) => {
      const value = this.getStandardValue(context, path.trim());
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Get value using standard naming convention:
   * - path.xxx -> context.input.params.xxx
   * - query.xxx -> context.input.query.xxx  
   * - body.xxx -> context.input.body.xxx
   * - header.xxx -> context.input.headers.xxx
   * - input.xxx -> context.input.xxx (fallback)
   * - vars.xxx -> context.variables.get(xxx)
   */
  protected getStandardValue(context: ExecutionContext, path: string): any {
    // Safety check
    if (!context) return undefined;
    
    const parts = path.split('.');
    if (parts.length >= 2) {
      const [source, ...rest] = parts;
      const key = rest.join('.');

      switch (source.toLowerCase()) {
        case 'path':
          return this.getValueByPath(context.input?.params || {}, key);
        case 'query':
          return this.getValueByPath(context.input?.query || {}, key);
        case 'body':
          return this.getValueByPath(context.input?.body || {}, key);
        case 'header':
        case 'headers':
          return this.getValueByPath(context.input?.headers || {}, key.toLowerCase());
        case 'input':
          return this.getValueByPath(context.input || {}, key);
        case 'var':
        case 'vars':
        case 'variable':
        case 'variables':
          return context.variables?.get(key) ?? this.getValueByPath(Object.fromEntries(context.variables || new Map()), key);
        default:
          // If no recognized prefix, try to resolve from context directly (backward compatible)
          return this.getValueByPath(context, path);
      }
    }
    
    // Single word - try variables first, then fallback to node results
    const varValue = context.variables?.get(path);
    if (varValue !== undefined) return varValue;
    
    // Try to get from node results (backward compatible)
    return this.getValueByPath(context, path);
  }

  protected getValueByPath(context: any, path: string): any {
    const parts = path.split('.');
    let value: any = undefined;

    // Check context variables first
    if (parts[0] === 'input') {
      value = context.input;
      parts.shift();
    } else if (parts[0] === 'vars' || parts[0] === 'variables') {
      value = Object.fromEntries(context.variables || new Map());
      parts.shift();
    } else {
      // Try to get from node results
      value = context.variables?.get(parts[0]);
      if (value !== undefined) {
        parts.shift();
      }
    }

    // If still undefined and context is not ExecutionContext-like, treat as plain object
    if (value === undefined && !context.input && !context.variables) {
      value = context;
    }

    // Navigate nested properties
    for (const part of parts) {
      if (value === null || value === undefined) return undefined;

      // Handle array access like "result[0]"
      const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
      if (arrayMatch) {
        const arr = value[arrayMatch[1]];
        if (Array.isArray(arr)) {
          value = arr[parseInt(arrayMatch[2])];
        } else {
          return undefined;
        }
      } else {
        value = value[part];
      }
    }

    return value;
  }
}
