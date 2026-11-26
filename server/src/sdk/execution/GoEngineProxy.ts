// Go engine proxy — same API as ExecutionEngine, runs the flow in engine-go.
//
// The Go service walks the flow graph and runs the node types it implements
// natively. For every other node type it calls back into this server
// (handleEngineNodeCallback), which runs the original TypeScript executor
// against a context kept here. Values that JSON cannot carry (Set, Map,
// Buffer, Date) therefore stay intact on this side; only changed variables
// travel between the two processes.

import { EventEmitter } from 'events';
import http from 'http';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import {
  EngineConfig, ExecutionContext, ExecutionInput, ExecutionResult, FlowDefinition, NodeExecutionResult,
} from './types';
import { NodeExecutor } from './NodeExecutor';
import { ExecutionEngine } from './ExecutionEngine';
import { closeTriggeredSessions } from './sessionFinalizer';

const GO_URL = process.env.ENGINE_GO_URL || 'http://127.0.0.1:8140';
// Per-process secret: only the Go engine this server talks to can call back.
const CALLBACK_TOKEN = process.env.ENGINE_CALLBACK_TOKEN || crypto.randomBytes(24).toString('hex');

interface RunState {
  executors: Map<string, NodeExecutor>;
  root: ExecutionContext;
  contexts: Map<string, ExecutionContext>;
}

const runs = new Map<string, RunState>();

/** JSON-safe copy for sending to Go (Set → array, Map → object, Buffer → note). */
// Dates cross to and from the Go engine as {"$ixDate": ISO} (plain JSON
// would turn them into strings).
const DATE_KEY = '$ixDate';

function reviveDates(v: any): any {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = reviveDates(v[i]);
    return v;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === DATE_KEY && typeof v[DATE_KEY] === 'string') return new Date(v[DATE_KEY]);
    for (const k of keys) v[k] = reviveDates(v[k]);
  }
  return v;
}

function jsonSafe(v: any, tagDates = true): any {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v, function (this: any, k: string, x: any) {
      const raw = this[k];
      if (tagDates && raw instanceof Date) return isNaN(raw.getTime()) ? null : { [DATE_KEY]: raw.toISOString() };
      if (x instanceof Set) return [...x];
      if (x instanceof Map) return Object.fromEntries(x);
      if (typeof x === 'bigint') return x.toString();
      if (x && x.type === 'Buffer' && Array.isArray(x.data)) return `[Buffer ${x.data.length} bytes]`;
      return x;
    }));
  } catch {
    return null;
  }
}

function sizeOf(v: any): number | undefined {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Set || v instanceof Map) return v.size;
  return undefined;
}

function reviveResult(r: any): NodeExecutionResult {
  return { ...r, startedAt: new Date(r.startedAt), endedAt: new Date(r.endedAt) };
}

export class GoEngineProxy extends EventEmitter {
  private executors = new Map<string, NodeExecutor>();
  private local: ExecutionEngine;

  constructor(private config: EngineConfig) {
    super();
    // Used as is when the Go engine is not reachable.
    this.local = new ExecutionEngine(config);
    for (const ev of ['node:start', 'node:complete', 'node:error', 'node:log', 'execution:start', 'execution:complete', 'execution:error']) {
      this.local.on(ev, (...a: any[]) => this.emit(ev, ...a));
    }
  }

  registerExecutor(executor: NodeExecutor): void {
    this.executors.set(executor.type, executor);
    this.local.registerExecutor(executor);
  }

  unregisterExecutor(type: string): void {
    this.executors.delete(type);
    this.local.unregisterExecutor(type);
  }

  async cleanup(): Promise<void> {
    await this.local.cleanup();
  }

  async execute(flow: FlowDefinition, input: ExecutionInput): Promise<ExecutionResult> {
    if (!(await goEngineAvailable())) {
      console.warn('[engine] Go engine not reachable — running this flow on the Node engine');
      return this.local.execute(flow, input);
    }

    const runId = crypto.randomBytes(12).toString('hex');
    const root: ExecutionContext = {
      flow, input, variables: new Map(), nodeResults: new Map(), logs: [], apiSpec: this.config.apiSpec,
    };
    runs.set(runId, { executors: this.executors, root, contexts: new Map([['root', root]]) });
    const startedAt = new Date();
    this.emit('execution:start', { operationId: flow.operationId, startedAt });

    try {
      // Pre-execution middlewares (trigger parameters etc.) run here, as before.
      for (const mw of this.config.middlewares || []) {
        let next = false;
        await mw(root, async () => { next = true; });
        if (!next) break;
      }
      const variables: Record<string, any> = {};
      for (const [k, v] of root.variables) variables[k] = jsonSafe(v);

      const port = parseInt(process.env.PORT || '3001', 10);
      const done = await this.stream({
        runId, flow, input, variables,
        apiSpec: this.config.apiSpec,
        deadlineAt: this.config.deadlineAt || 0,
        callbackUrl: process.env.ENGINE_CALLBACK_URL || `http://127.0.0.1:${port}/internal/engine/node`,
        callbackToken: CALLBACK_TOKEN,
      }, root);

      for (const [k, v] of Object.entries(done.varChanges || {})) root.variables.set(k, v);
      for (const l of done.logs || []) root.logs.push({ ...l, timestamp: new Date(l.timestamp) });

      const r = done.result;
      const result: ExecutionResult = {
        success: r.success,
        statusCode: r.statusCode,
        data: r.data,
        error: r.error,
        metadata: {
          operationId: r.metadata.operationId,
          startedAt: new Date(r.metadata.startedAt),
          endedAt: new Date(r.metadata.endedAt),
          durationMs: r.metadata.durationMs,
          nodeResults: (r.metadata.nodeResults || []).map(reviveResult),
        },
      };
      if (result.success) {
        await closeTriggeredSessions(root, true, (msg) => this.emit('node:log', '_engine', msg));
        this.emit('execution:complete', result);
      } else {
        this.emit('execution:error', new Error(result.error), result);
      }
      return result;
    } catch (err: any) {
      const endedAt = new Date();
      const result: ExecutionResult = {
        success: false, statusCode: 500, error: err?.message || String(err),
        metadata: {
          operationId: flow.operationId, startedAt, endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          nodeResults: Array.from(root.nodeResults.values()),
        },
      };
      this.emit('execution:error', err, result);
      return result;
    } finally {
      runs.delete(runId);
    }
  }

  /** POST the run to Go and replay its NDJSON events as engine events. */
  private stream(body: any, root: ExecutionContext): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL('/execute', GO_URL);
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      }, (res) => {
        if (res.statusCode !== 200) {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => reject(new Error(`Go engine refused the run (HTTP ${res.statusCode}): ${text.slice(0, 300)}`)));
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        let done: any = null;
        res.on('data', (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            switch (ev.event) {
              case 'node:start':
                this.emit('node:start', ev.nodeId, root);
                this.config.onNodeStart?.(ev.nodeId, root);
                break;
              case 'node:complete': {
                const r = reviveResult(ev.result);
                this.emit('node:complete', ev.nodeId, r, root);
                this.config.onNodeComplete?.(ev.nodeId, r, root);
                break;
              }
              case 'node:error': {
                const e = new Error(ev.error);
                this.emit('node:error', ev.nodeId, e, root);
                this.config.onNodeError?.(ev.nodeId, e, root);
                break;
              }
              case 'node:log':
                this.emit('node:log', ev.nodeId, ev.message);
                break;
              case 'done':
                done = ev;
                break;
            }
          }
        });
        res.on('end', () => (done ? resolve(done) : reject(new Error('Go engine connection closed before the run finished'))));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(0);
      req.end(payload);
    });
  }
}

// ── Availability (cached briefly so every run does not pay a probe) ─────────

let lastProbe = 0;
let lastOk = false;

export async function goEngineAvailable(): Promise<boolean> {
  if (Date.now() - lastProbe < 10_000) return lastOk;
  lastProbe = Date.now();
  lastOk = await new Promise<boolean>((resolve) => {
    const req = http.get(new URL('/health', GO_URL), (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
  return lastOk;
}

// ── Callbacks from the Go engine ────────────────────────────────────────────

function callbackAllowed(req: Request): boolean {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return req.get('X-Engine-Token') === CALLBACK_TOKEN && (loopback || !!process.env.ENGINE_CALLBACK_URL);
}

/** GET /internal/engine/connection/:id — a stored connection for a Go executor. */
export async function handleEngineConnectionCallback(req: Request, res: Response): Promise<void> {
  if (!callbackAllowed(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../../lib/prisma');
  const conn = await prisma.connection.findUnique({ where: { id: req.params.id } });
  if (!conn) {
    res.json({ error: `Connection not found: ${req.params.id}` });
    return;
  }
  let config: any = {};
  try { config = typeof conn.config === 'string' ? JSON.parse(conn.config) : conn.config; } catch { config = conn.config || {}; }
  res.json({ id: conn.id, name: conn.name, type: conn.type, status: conn.status, config });
}

/** POST /internal/engine/node — Go asks this server to run one node. */
export async function handleEngineNodeCallback(req: Request, res: Response): Promise<void> {
  if (!callbackAllowed(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const { runId, ctxId, parentCtxId, node, input, varUpdates, resultUpdates } = req.body || {};
  const run = runs.get(runId);
  if (!run) {
    res.status(404).json({ error: `Unknown run ${runId}` });
    return;
  }

  let ctx = run.contexts.get(ctxId);
  if (!ctx) {
    const parent = run.contexts.get(parentCtxId) || run.root;
    ctx = {
      flow: run.root.flow, input, variables: new Map(parent.variables),
      nodeResults: run.root.nodeResults, logs: run.root.logs, apiSpec: run.root.apiSpec,
    };
    run.contexts.set(ctxId, ctx);
  }
  for (const [k, v] of Object.entries(varUpdates || {})) ctx.variables.set(k, reviveDates(v));
  for (const [id, r] of Object.entries(resultUpdates || {})) {
    const rr: any = r;
    ctx.nodeResults.set(id, reviveResult({ ...rr, output: reviveDates(rr.output) }));
  }
  ctx.input = reviveDates(input);

  const executor = run.executors.get(node.type);
  if (!executor) {
    res.json({ error: `No executor registered for node type: ${node.type}` });
    return;
  }

  const before = new Map<string, { v: any; n?: number }>();
  for (const [k, v] of ctx.variables) before.set(k, { v, n: sizeOf(v) });
  const logStart = ctx.logs.length;

  let result: NodeExecutionResult | undefined;
  let error: string | undefined;
  try {
    result = await executor.execute(node, ctx);
  } catch (err: any) {
    error = err?.message || String(err);
    result = ctx.nodeResults.get(node.id);
  }

  const varChanges: Record<string, any> = {};
  for (const [k, v] of ctx.variables) {
    const b = before.get(k);
    if (!b || b.v !== v || b.n !== sizeOf(v)) varChanges[k] = jsonSafe(v);
  }
  res.json({
    result: result ? { ...result, output: jsonSafe(result.output) } : undefined,
    varChanges,
    logs: jsonSafe(ctx.logs.slice(logStart), false),
    error,
  });
}

/** The engine every route uses: Go when ENGINE=go, Node otherwise. */
export function createExecutionEngine(config: EngineConfig): ExecutionEngine | GoEngineProxy {
  return (process.env.ENGINE || '').toLowerCase() === 'go' ? new GoEngineProxy(config) : new ExecutionEngine(config);
}
