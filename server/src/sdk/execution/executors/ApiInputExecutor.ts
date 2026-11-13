// API Input Node Executor - Processes incoming API request

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';

export class ApiInputExecutor extends NodeExecutor {
  readonly type = 'api-input';

  async executeNode(_node: ExecutionNode, context: ExecutionContext): Promise<any> {
    // API Input node simply returns the input data
    // It can also perform initial validation/parsing based on node.data.config
    
    const result = {
      method: context.input.method,
      path: context.input.path,
      headers: context.input.headers,
      query: context.input.query || {},
      body: context.input.body,
      params: context.input.params || {},
    };

    // Debug logging - API Request details
    this.log(context, 'debug', 'API Input Request', {
      method: result.method,
      path: result.path,
      query: result.query,
      params: result.params,
      headers: result.headers,
      body: result.body,
    });

    return result;
  }
}
