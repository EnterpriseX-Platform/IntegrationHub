// Delay Executor - Pause execution

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';

interface DelayData {
  duration?: number; // amount expressed in `unit`
  unit?: 'ms' | 'seconds' | 'minutes' | 'hours';
  seconds?: number; // legacy field — value in seconds (older saved flows)
}

export class DelayExecutor extends NodeExecutor {
  readonly type = 'delay';

  async executeNode(node: ExecutionNode, _context: ExecutionContext): Promise<any> {
    const data = node.data as DelayData;

    // Calculate delay in ms.
    // Prefer duration + unit (current UI). Fall back to the legacy `seconds`
    // field so flows saved before the duration/unit migration still honour
    // the configured value instead of silently using the 1000ms default.
    let delayMs: number;
    let unit = data.unit || 'ms';
    if (data.duration !== undefined && data.duration !== null) {
      delayMs = data.duration;
      switch (data.unit) {
        case 'seconds':
          delayMs *= 1000;
          break;
        case 'minutes':
          delayMs *= 60 * 1000;
          break;
        case 'hours':
          delayMs *= 60 * 60 * 1000;
          break;
        // 'ms' or unset: use the raw value
      }
    } else if (data.seconds !== undefined && data.seconds !== null) {
      delayMs = data.seconds * 1000;
      unit = 'seconds';
    } else {
      delayMs = 1000;
    }

    // Limit max delay to 5 minutes for safety
    delayMs = Math.min(delayMs, 5 * 60 * 1000);

    await new Promise(resolve => setTimeout(resolve, delayMs));

    return {
      delayed: delayMs,
      unit,
      resumedAt: new Date().toISOString(),
    };
  }
}
