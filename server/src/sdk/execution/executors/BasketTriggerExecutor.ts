// Basket/File Trigger Executor - Triggers on basket SESSION status changes
// Important: This checks SESSION status (not file status)
// Session Lifecycle: open -> published -> processing -> completed/archived

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface BasketTriggerData {
  basketId: string;
  basketName?: string;
  // Trigger on SESSION status (not file status)
  triggerOn?: 'open' | 'published' | 'processing' | 'completed' | 'archived';
  filePattern?: string;
  /**
   * Session statuses a manual Run takes files from (a Run that no Publish
   * started). Unset keeps the old rule: `triggerOn` sessions first, and only
   * if there are none, any open / published / processing session. Lets an
   * operator run an import straight after a download without publishing.
   */
  runOnStatuses?: Array<'open' | 'published' | 'processing' | 'completed' | 'error'>;
  options?: {
    autoProcess?: boolean;
    deleteAfterTransfer?: boolean;
    archiveAfterTransfer?: boolean;
  };
}

export class BasketTriggerExecutor extends NodeExecutor {
  readonly type = 'basket-trigger';

  /**
   * Seed the variables downstream nodes expect when this trigger matched
   * nothing. Pressing Run with no pending files is a normal operator action,
   * so it has to finish as a clean no-op — not crash the loop that reads
   * `triggerFiles`.
   */
  private setEmptyTriggerVars(context: ExecutionContext, basketId: string): void {
    context.variables.set('triggerFiles', []);
    context.variables.set('triggerSessions', []);
    context.variables.set('triggerSessionIds', []);
    context.variables.set('basketId', basketId);
    context.variables.set('fileCount', 0);
    context.variables.set('sessionCount', 0);
  }

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as BasketTriggerData;

    if (!data.basketId) {
      throw new Error('Basket ID is required for basket-trigger');
    }

    // Get trigger session status (default to 'published')
    const triggerSessionStatus = data.triggerOn || 'published';
    const filePattern = data.filePattern || '*';

    // Check if a specific session was passed from publish auto-trigger
    const targetSessionId = context.input?.body?._sessionId || context.input?.params?._sessionId;

    // Get basket info
    const basket = await prisma.basket.findUnique({
      where: { id: data.basketId }
    });

    if (!basket) {
      throw new Error(`Basket not found: ${data.basketId}`);
    }

    // Find sessions to trigger on.
    // Primary match: sessions with the configured status (e.g. 'published').
    // Fallback for manual runs: if nothing matches, also consider non-terminal
    // sessions (open / processing) so the import can still process files that
    // were auto-downloaded but never explicitly published. This is important
    // for the auto-close logic — without finding a session here, the engine
    // can't mark it as completed after the flow finishes.
    const runOnStatuses = Array.isArray(data.runOnStatuses) ? data.runOnStatuses.filter(Boolean) : [];
    const pickByRunStatuses = !targetSessionId && runOnStatuses.length > 0;
    let sessions = await prisma.processingSession.findMany({
      where: {
        basketId: data.basketId,
        status: pickByRunStatuses ? { in: runOnStatuses } : triggerSessionStatus,
        ...(targetSessionId ? { id: targetSessionId } : {}),
      },
      orderBy: { startedAt: 'desc' }
    });
    if (sessions.length === 0 && !targetSessionId && !pickByRunStatuses) {
      // Fallback: pick up any non-terminal session so flow can run on it
      sessions = await prisma.processingSession.findMany({
        where: {
          basketId: data.basketId,
          status: { in: ['open', 'published', 'processing'] },
        },
        orderBy: { startedAt: 'desc' }
      });
    }

    if (sessions.length === 0) {
      // Still publish the (empty) variables a downstream for-each reads, so
      // "nothing to do" is a clean no-op run instead of the loop blowing up on
      // an undefined source.
      this.setEmptyTriggerVars(context, data.basketId);
      return {
        triggerType: 'basket',
        basketId: data.basketId,
        basketName: basket.name,
        triggerOn: triggerSessionStatus,
        pattern: filePattern,
        sessionsFound: 0,
        files: [],
        triggered: false,
        message: pickByRunStatuses
          ? `No sessions with status ${runOnStatuses.join(' / ')}`
          : `No sessions with status '${triggerSessionStatus}'`,
        triggeredAt: new Date().toISOString(),
        triggeredDate: new Date().toISOString().slice(0, 10),
      };
    }

    // Build pattern regex
    const regex = new RegExp('^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    
    // Get files from matching sessions
    // Only get files that are ready to process (published, uploaded, or pending)
    const allFiles: any[] = [];
    
    for (const session of sessions) {
      const files = await prisma.basketFile.findMany({
        where: {
          sessionId: session.id,
          status: { in: ['published', 'uploaded', 'pending'] }, // Only ready files
        }
      });
      
      // Filter by pattern
      const matchedFiles = files.filter(f => regex.test(f.fileName));
      allFiles.push(...matchedFiles.map(f => ({
        ...f,
        sessionId: session.id,
        sessionName: session.batchName,
        sessionStatus: session.status
      })));
    }
    
    if (allFiles.length === 0) {
      this.setEmptyTriggerVars(context, data.basketId);
      return {
        triggerType: 'basket',
        basketId: data.basketId,
        basketName: basket.name,
        triggerOn: triggerSessionStatus,
        pattern: filePattern,
        sessionsFound: sessions.length,
        filesFound: 0,
        files: [],
        triggered: false,
        message: `Found ${sessions.length} session(s) with status '${triggerSessionStatus}', but no ready files matching pattern`,
        triggeredAt: new Date().toISOString(),
        triggeredDate: new Date().toISOString().slice(0, 10),
      };
    }

    // Update session status to 'processing' to prevent duplicate triggers
    const sessionIds = [...new Set(allFiles.map(f => f.sessionId))];
    if (triggerSessionStatus === 'published') {
      // Auto-update to processing
      for (const sessionId of sessionIds) {
        await prisma.processingSession.update({
          where: { id: sessionId },
          data: { 
            status: 'processing',
            publishMode: 'auto'
          }
        });
      }
    }

    // Set context variables for downstream nodes
    context.variables.set('triggerFiles', allFiles);
    context.variables.set('triggerSessions', sessions);
    context.variables.set('triggerSessionIds', sessionIds);
    context.variables.set('basketId', data.basketId);
    context.variables.set('fileCount', allFiles.length);
    context.variables.set('sessionCount', sessions.length);
    
    return {
      triggerType: 'basket',
      basketId: data.basketId,
      basketName: basket.name,
      triggerOn: triggerSessionStatus,
      pattern: filePattern,
      sessionsFound: sessions.length,
      filesFound: allFiles.length,
      files: allFiles.map(f => ({
        id: f.id,
        fileName: f.fileName,
        originalName: f.originalName,
        size: f.size,
        status: f.status,
        path: f.path,
        sessionId: f.sessionId,
        sessionName: f.sessionName,
        createdAt: f.createdAt,
      })),
      triggered: true,
      triggeredAt: new Date().toISOString(),
      triggeredDate: new Date().toISOString().slice(0, 10),
      options: data.options || {},
    };
  }
}
