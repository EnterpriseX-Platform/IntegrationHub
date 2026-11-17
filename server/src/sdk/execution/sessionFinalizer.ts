// Shared by the Node engine and the Go engine proxy.

import { ExecutionContext } from './types';

/**
 * Mark all `triggerSessionIds` (set by basket-trigger) as completed.
 * Called after the flow finishes — without this, sessions stay 'open' /
 * 'processing' forever and the basket UI shows them as active indefinitely.
 */
export async function closeTriggeredSessions(
  context: ExecutionContext,
  success: boolean,
  emitLog: (message: string) => void,
): Promise<void> {
  try {
    const ids = context.variables.get('triggerSessionIds') as string[] | undefined;
    if (!ids || ids.length === 0) return;

    // A capped for-each only got through part of the session's files. Closing
    // it here would mark the untouched remainder as completed.
    if (context.variables.get('__foreach_incomplete')) {
      emitLog(`Leaving ${ids.length} session(s) open: a for-each stopped at its maxItems limit, so their files are not all processed`);
      return;
    }

    // Lazy require so we don't bloat module load for non-DB flows
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('../../lib/prisma');
    const newStatus = success ? 'completed' : 'archived';
    const now = new Date();

    const result = await prisma.processingSession.updateMany({
      where: {
        id: { in: ids },
        // Only auto-close sessions that haven't already been finalised
        status: { in: ['open', 'published', 'processing'] },
      },
      data: {
        status: newStatus,
        completedAt: now,
      },
    });

    if (result.count > 0) {
      emitLog(`Auto-closed ${result.count} session(s) as ${newStatus}`);
    }

    // Log to session_logs so users can see why state changed
    for (const sessionId of ids) {
      try {
        await prisma.sessionLog.create({
          data: {
            sessionId,
            type: 'session_completed',
            message: `Session ${newStatus} after flow execution`,
            metadata: JSON.stringify({ success, completedAt: now, flowId: context.flow.operationId }),
          },
        });
      } catch (_) { /* swallow log failures — non-critical */ }
    }

    // "Archive after processing" on the basket-trigger: move the finished
    // sessions on to 'archived'. The checkbox existed in the designer but was
    // never acted on, so pushed sessions sat in 'completed' forever.
    const trigger = context.flow.nodes.find(n => n.type === 'basket-trigger');
    if (success && trigger?.data?.options?.archiveAfterTransfer) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { archiveSession } = require('../../services/sessionArchive');
      for (const sessionId of ids) {
        try {
          await archiveSession(sessionId, `Archive after processing, flow ${context.flow.operationId}`);
          emitLog(`Archived session ${sessionId} (Archive after processing)`);
        } catch (err: any) {
          console.error(`[Engine] Archive after processing failed for session ${sessionId}:`, err.message);
        }
      }
    }
  } catch (err: any) {
    console.error('[Engine] closeTriggeredSessions failed:', err.message);
  }
}
