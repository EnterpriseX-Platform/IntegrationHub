// For-Each Loop Executor - Iterates over an array, executing body chain for each item
// Supports parallel workers for concurrent processing of items

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';

interface ForEachData {
  source: string;       // path to array (e.g., "vars.trigger.files", "triggerFiles")
  itemVar: string;      // variable name for current item (e.g., "currentFile")
  indexVar?: string;    // variable name for index (default: "loopIndex")
  filterPattern?: string; // glob pattern to filter items by name (e.g., "*AnnualPay*.csv")
  workers?: number;     // number of parallel workers (default: 1 = sequential)
  maxItems?: number;    // hard cap on items processed per run (0 = unlimited)
}

// Opt-in cap, OFF by default (0 = unlimited).
//
// Deliberately not a default: nothing in a loop body marks its item as done, so
// capping does not "defer" work — the flow finishes, basket-trigger auto-closes
// the session as completed, and every item past the cap is silently dropped.
// Runaway runs are bounded by the execution deadline instead, which stops the
// run without pretending the remaining work was handled. Only set this when the
// loop body itself tracks progress. Per-node `maxItems` overrides the env.
const DEFAULT_MAX_ITEMS = parseInt(process.env.FLOW_FOREACH_MAX_ITEMS || '0', 10);

export class ForEachExecutor extends NodeExecutor {
  readonly type = 'for-each';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as ForEachData;
    const source = data.source || 'triggerFiles';
    const itemVar = data.itemVar || 'currentFile';
    const indexVar = data.indexVar || 'loopIndex';

    // Resolve source array from context
    const items = this.resolveSourceArray(source, context);

    // Nothing upstream produced the array: treat as "no work", not a failure.
    // A trigger that matched no files is a normal outcome of pressing Run, and
    // it must not surface to the operator as a crash.
    if (items === undefined || items === null) {
      this.log(context, 'warn', `For-each source "${source}" is empty or unset — no items to process.`);
      return { items: [], itemVar, indexVar, totalItems: 0, matchedItems: 0, deferredItems: 0, maxItems: 0, workers: 1 };
    }

    // A wrong type is still a real misconfiguration worth failing on.
    if (!Array.isArray(items)) {
      throw new Error(`For-each source "${source}" is not an array (got ${typeof items})`);
    }

    // Apply filter pattern if specified (glob-like: *AnnualPay*.csv)
    let filteredItems = items;
    if (data.filterPattern) {
      const pattern = data.filterPattern;
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
      filteredItems = items.filter(item => {
        // Try item.fileName, item.name, or path.basename(item.path)
        const name = item?.fileName || item?.name || (item?.path ? item.path.split('/').pop() : String(item));
        return regex.test(name);
      });
    }

    // Clamp workers to 1-20 range
    const workers = Math.max(1, Math.min(data.workers || 1, 20));

    // Cap the batch when explicitly asked to. Warn rather than fail — deployed
    // batch flows must keep running.
    const matchedCount = filteredItems.length;
    const maxItems = data.maxItems !== undefined ? data.maxItems : DEFAULT_MAX_ITEMS;
    let deferredItems = 0;
    if (maxItems > 0 && matchedCount > maxItems) {
      deferredItems = matchedCount - maxItems;
      filteredItems = filteredItems.slice(0, maxItems);
      this.log(
        context,
        'warn',
        `For-each source has ${matchedCount} items, above maxItems=${maxItems}. ` +
          `Processing the first ${maxItems}; ${deferredItems} left unprocessed. ` +
          `Any basket session behind this loop is left open so the remainder is not marked done.`
      );
      // Tell the engine not to auto-close the trigger's sessions: the run is
      // only partially through them, and closing would report the untouched
      // items as completed.
      context.variables.set('__foreach_incomplete', true);
    }

    return {
      items: filteredItems,
      itemVar,
      indexVar,
      totalItems: filteredItems.length,
      matchedItems: matchedCount,
      deferredItems,
      maxItems,
      workers,
    };
  }

  private resolveSourceArray(source: string, context: ExecutionContext): any {
    // Try direct variable lookup first
    const directVar = context.variables.get(source);
    if (directVar !== undefined) return directVar;

    // Try dot-path resolution: "vars.trigger.files" or "trigger.files"
    const parts = source.split('.');
    let value: any;

    if (parts[0] === 'vars' && parts.length > 1) {
      // vars.nodeId.field... → context.variables.get(nodeId).field...
      value = context.variables.get(parts[1]);
      for (let i = 2; i < parts.length; i++) {
        value = value?.[parts[i]];
      }
    } else {
      // nodeId.field → context.variables.get(nodeId).field
      value = context.variables.get(parts[0]);
      for (let i = 1; i < parts.length; i++) {
        value = value?.[parts[i]];
      }
    }

    // Fallback: try from input
    if (value === undefined) {
      value = context.input;
      for (const part of parts) {
        value = value?.[part];
      }
    }

    return value;
  }
}
