// Shared helper: build rich per-node log entries from NodeExecutionResult
// Used by flows.ts and scheduler.ts when persisting execution logs.
import { NodeExecutionResult } from './types';

export function formatDurationMs(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatBytes(b?: number): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Inspect node output and produce a one-line human-readable summary
export function summarizeNodeOutput(output: any, nodeType: string): string {
  if (output == null) return '';

  // Database
  if (nodeType === 'database') {
    if (typeof output.inserted === 'number') return `${output.inserted} rows inserted`;
    if (typeof output.updated === 'number') return `${output.updated} rows updated`;
    if (typeof output.deleted === 'number') return `${output.deleted} rows deleted`;
    if (typeof output.rowCount === 'number') return `${output.rowCount} rows`;
    if (Array.isArray(output.rows)) return `${output.rows.length} rows`;
  }

  // File read
  if (nodeType === 'file-read') {
    const files = Array.isArray(output.files) ? output.files : (output.fileName ? [output] : []);
    if (files.length > 0) {
      const f = files[0];
      const parts: string[] = [];
      if (files.length > 1) parts.push(`${files.length} files`);
      else if (f?.fileName || f?.name) parts.push(f.fileName || f.name);
      if (Array.isArray(f?.data)) parts.push(`${f.data.length} rows`);
      else if (typeof f?.size === 'number') parts.push(formatBytes(f.size));
      return parts.join(' · ');
    }
  }

  // File write
  if (nodeType === 'file-write') {
    if (typeof output.bytesWritten === 'number') return formatBytes(output.bytesWritten);
    if (typeof output.size === 'number') return formatBytes(output.size);
    if (output.fileName) return output.fileName;
  }

  // SFTP
  if (nodeType === 'sftp-action') {
    const transferred = output.transferred ?? output.fileCount;
    if (typeof transferred === 'number') {
      const parts = [`${transferred} files`];
      if (typeof output.totalBytes === 'number') parts.push(formatBytes(output.totalBytes));
      return parts.join(' · ');
    }
  }

  // HTTP request
  if (nodeType === 'http-request') {
    const parts: string[] = [];
    if (typeof output.status === 'number') parts.push(`HTTP ${output.status}`);
    if (typeof output.responseSize === 'number') parts.push(formatBytes(output.responseSize));
    return parts.join(' · ');
  }

  // Transform
  if (nodeType === 'transform') {
    if (Array.isArray(output)) return `${output.length} items`;
    if (Array.isArray(output?.data)) return `${output.data.length} items`;
  }

  // Condition
  if (nodeType === 'condition') {
    if (output?.matched != null) return `→ ${output.matched ? 'true' : 'false'}`;
  }

  // For-each
  if (nodeType === 'for-each') {
    if (typeof output.processed === 'number' && typeof output.total === 'number') {
      return `${output.processed}/${output.total} processed${output.errors ? ` · ${output.errors} errors` : ''}`;
    }
  }

  // Basket trigger / action
  if (nodeType === 'basket-trigger' || nodeType === 'basket-action') {
    if (output?.basketName) return output.basketName;
    if (typeof output.fileCount === 'number') return `${output.fileCount} files`;
  }

  // Generic fallbacks
  if (Array.isArray(output)) return `${output.length} items`;
  if (typeof output === 'string') return output.length > 60 ? output.slice(0, 57) + '...' : output;

  return '';
}

export interface NodeLogEntry {
  timestamp: string;
  level: 'info' | 'error' | 'success' | 'warning';
  message: string;
  nodeId?: string;
  nodeName?: string;
}

// Build log entries from a single NodeExecutionResult
// label is looked up from the flow definition by caller
export function buildNodeLogEntries(
  nr: NodeExecutionResult,
  nodeLabel?: string,
): NodeLogEntry[] {
  const label = nodeLabel || nr.nodeType;
  const dur = formatDurationMs(nr.durationMs);
  const summary = nr.success ? summarizeNodeOutput((nr as any).output, nr.nodeType) : '';
  const status = nr.success ? 'Success' : 'Failed';

  const headParts = [`[${nr.nodeType}] ${label}: ${status}`];
  if (dur) headParts.push(`(${dur})`);
  if (summary) headParts.push(`· ${summary}`);

  const entries: NodeLogEntry[] = [
    {
      timestamp: (nr.endedAt instanceof Date ? nr.endedAt.toISOString() : (nr.endedAt as any)) || new Date().toISOString(),
      level: nr.success ? 'info' : 'error',
      message: headParts.join(' '),
      nodeId: nr.nodeId,
      nodeName: label,
    },
  ];

  if (nr.error) {
    entries.push({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: `  ↳ ${nr.error}`,
      nodeId: nr.nodeId,
      nodeName: label,
    });
  }

  // Aggregate sub-results (special-case for fan-out nodes)
  const aggResults = (nr as any).output?.__aggregateResults;
  if (Array.isArray(aggResults)) {
    for (const a of aggResults) {
      entries.push({
        timestamp: new Date().toISOString(),
        level: a.success ? 'success' : 'warning',
        message: `  └─ Branch ${a.branchId}: ${a.success ? 'Success' : 'Failed'}${a.duration ? ` (${formatDurationMs(a.duration)})` : ''}`,
      });
    }
  }

  return entries;
}

// Build a Map<nodeId, label> from the flow's nodes JSON
export function buildNodeLabelMap(nodes: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of nodes || []) {
    if (n?.id) {
      const label = n.data?.label || n.data?.name || n.type || n.id;
      map.set(n.id, label);
    }
  }
  return map;
}
