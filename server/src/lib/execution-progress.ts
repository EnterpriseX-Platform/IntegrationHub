// Live progress logging + run-time limits for flow executions.
//
// Background: the execute route used to write the execution's `logs` column
// exactly once, after the engine returned. A long run therefore showed nothing
// but "Initializing nodes..." for its entire life, and a run that never
// returned (or a container restart) left the row stuck on `Running` forever.
// This module gives the route a throttled writer so progress lands in the DB
// while the flow is still going, plus the shared timeout/stale-sweep settings.

import { prisma } from './prisma';

export interface ProgressLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'success';
  message: string;
}

/** Maximum wall-clock time for a single execution (default 6h; 0 disables). */
export const EXECUTION_TIMEOUT_MS = parseInt(
  process.env.FLOW_EXECUTION_TIMEOUT_MS || String(6 * 60 * 60 * 1000),
  10
);

/** Executions still `Running` after this many hours are treated as orphaned. */
export const EXECUTION_STALE_HOURS = parseInt(process.env.EXECUTION_STALE_HOURS || '12', 10);

/** Compute the deadline to hand the engine, or undefined when disabled. */
export function executionDeadline(startedAt: number = Date.now()): number | undefined {
  return EXECUTION_TIMEOUT_MS > 0 ? startedAt + EXECUTION_TIMEOUT_MS : undefined;
}

// Keep the persisted log bounded: a 20k-item loop emits one line per batch, and
// the whole array is serialised into a single column on every flush.
const HEAD_KEEP = 50;
const TAIL_KEEP = 250;
const FLUSH_INTERVAL_MS = 3000;

export class ExecutionProgressLogger {
  private head: ProgressLogEntry[] = [];
  private tail: ProgressLogEntry[] = [];
  private droppedCount = 0;
  private lastFlushAt = 0;
  private flushing = false;
  private dirty = false;

  constructor(private readonly executionId: string, initial: ProgressLogEntry[] = []) {
    this.head = initial.slice(0, HEAD_KEEP);
    if (initial.length > HEAD_KEEP) this.tail = initial.slice(HEAD_KEEP);
  }

  add(level: ProgressLogEntry['level'], message: string): void {
    const entry: ProgressLogEntry = { timestamp: new Date().toISOString(), level, message };
    if (this.head.length < HEAD_KEEP) {
      this.head.push(entry);
    } else {
      this.tail.push(entry);
      while (this.tail.length > TAIL_KEEP) {
        this.tail.shift();
        this.droppedCount++;
      }
    }
    this.dirty = true;
  }

  /** Current view of the log, with a marker where entries were elided. */
  snapshot(): ProgressLogEntry[] {
    if (this.droppedCount === 0) return [...this.head, ...this.tail];
    return [
      ...this.head,
      {
        timestamp: new Date().toISOString(),
        level: 'info' as const,
        message: `… ${this.droppedCount} earlier progress line(s) omitted …`,
      },
      ...this.tail,
    ];
  }

  /** Write to the DB, at most once per FLUSH_INTERVAL_MS unless forced. */
  async flush(force = false): Promise<void> {
    if (!force && (!this.dirty || this.flushing)) return;
    if (!force && Date.now() - this.lastFlushAt < FLUSH_INTERVAL_MS) return;

    this.flushing = true;
    this.dirty = false;
    this.lastFlushAt = Date.now();
    try {
      await prisma.execution.update({
        where: { id: this.executionId },
        data: { logs: JSON.stringify(this.snapshot()) },
      });
    } catch (err) {
      // Never let log persistence break the run it is reporting on.
      console.warn(`[ExecutionProgress] flush failed for ${this.executionId}:`, (err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  /** Fire-and-forget flush for use inside synchronous engine event handlers. */
  flushSoon(): void {
    void this.flush().catch(() => undefined);
  }
}

/**
 * Mark executions that have been `Running` past the stale window as Failed.
 * Called on boot and periodically: a run whose process died (OOM, restart,
 * redeploy) has no other way back out of `Running`, and the Run Flow screen
 * keeps showing it as in-flight indefinitely.
 */
export async function sweepStaleExecutions(reason = 'Marked failed: execution exceeded the stale threshold (process likely restarted)'): Promise<number> {
  if (EXECUTION_STALE_HOURS <= 0) return 0;
  const cutoff = new Date(Date.now() - EXECUTION_STALE_HOURS * 60 * 60 * 1000);

  try {
    const stale = await prisma.execution.findMany({
      where: { status: { in: ['Running', 'Pending'] }, startedAt: { lt: cutoff } },
      select: { id: true, logs: true },
    });
    if (stale.length === 0) return 0;

    const now = new Date();
    for (const { id, logs } of stale) {
      // Keep whatever progress the run managed to record — it is the only
      // evidence of how far it got before the process went away.
      let existing: ProgressLogEntry[] = [];
      try {
        if (logs) existing = JSON.parse(logs);
        if (!Array.isArray(existing)) existing = [];
      } catch { existing = []; }

      await prisma.execution.update({
        where: { id },
        data: {
          status: 'Failed',
          endedAt: now,
          errorType: 'timeout',
          error: reason,
          logs: JSON.stringify([
            ...existing,
            { timestamp: now.toISOString(), level: 'error', message: reason },
          ]),
        },
      });
    }
    console.log(`[ExecutionSweep] marked ${stale.length} stale execution(s) as Failed (older than ${EXECUTION_STALE_HOURS}h)`);
    return stale.length;
  } catch (err) {
    console.error('[ExecutionSweep] failed:', (err as Error).message);
    return 0;
  }
}
