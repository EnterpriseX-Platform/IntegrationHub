import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { guardProjects, basketProjects } from '../lib/access';
import fs from 'fs';
import path from 'path';
import { archiveSession, archiveSessionFiles } from '../services/sessionArchive';
import { requireSession } from '../middleware/requireSession';

const router = Router();

// Non-admins reach a basket through its project or a project it is shared with:
// viewer reads files, editor uploads, moves and deletes them
router.param('id', guardProjects(async (id) => { const p = await basketProjects(id); return p === 'open' ? [] : p; }));

// Generate batch name from pattern
function generateBatchName(pattern: string): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const year = now.getFullYear();
  const buddhistYear = year + 543; // พ.ศ.
  
  // Replace placeholders
  let name = pattern
    .replace(/\{YYYY\+543\}/g, buddhistYear.toString())     // {YYYY+543} -> พ.ศ. (2567)
    .replace(/\{BYYYY\}/g, buddhistYear.toString())         // {BYYYY} -> พ.ศ. (2567)
    .replace(/\{YYYY\}/g, year.toString())                  // {YYYY} -> ค.ศ. (2024)
    .replace(/\{YY\}/g, String(year).slice(-2))            // {YY} -> ค.ศ. 2 หลัก (24)
    .replace(/\{BYY\}/g, String(buddhistYear).slice(-2))   // {BYY} -> พ.ศ. 2 หลัก (67)
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'))
    .replace(/\{YYYYMMDD\}/g, dateStr)
    .replace(/\{HH\}/g, String(now.getHours()).padStart(2, '0'))
    .replace(/\{mm\}/g, String(now.getMinutes()).padStart(2, '0'))
    .replace(/\{ss\}/g, String(now.getSeconds()).padStart(2, '0'))
    .replace(/\{HHMMSS\}/g, timeStr);
  
  // Handle sequence numbers
  if (name.includes('{NNN}')) {
    name = name.replace('{NNN}', '{SEQ3}'); // 3 digits with leading zeros
  }
  if (name.includes('{NN}')) {
    name = name.replace('{NN}', '{SEQ2}'); // 2 digits with leading zeros
  }
  if (name.includes('{N}')) {
    name = name.replace('{N}', '{SEQ1}'); // 1 digit without leading zeros
  }
  
  return name;
}

// GET /api/baskets/:id/sessions - List all processing sessions for a basket
const INT4_MAX = 2147483647;

router.get('/:id/sessions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, limit = '20', page = '1' } = req.query;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const where: any = { basketId: id };
    if (status) where.status = status as string;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const [sessions, total] = await Promise.all([
      prisma.processingSession.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take: parseInt(limit as string),
        include: {
          _count: { select: { basketFiles: true } }
        }
      }),
      prisma.processingSession.count({ where })
    ]);

    // Sync fileCount/totalSize with the files actually in each session
    // (the stored counters drift when files are deleted or moved)
    const sizes = sessions.length
      ? await prisma.basketFile.groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: sessions.map(s => s.id) } },
          _sum: { size: true }
        })
      : [];
    const sizeBySession = new Map(sizes.map(g => [g.sessionId, g._sum.size || 0]));
    for (const session of sessions) {
      const actualCount = session._count?.basketFiles || 0;
      const actualSize = sizeBySession.get(session.id) || 0;
      // totalSize is a 32-bit column: store what fits, return the real sum
      const storedSize = Math.min(actualSize, INT4_MAX);
      if (session.fileCount !== actualCount || session.totalSize !== storedSize) {
        await prisma.processingSession.update({
          where: { id: session.id },
          data: { fileCount: actualCount, totalSize: storedSize }
        }).catch(err => console.warn('[sessions] counter sync failed:', session.id, err?.message));
      }
      session.fileCount = actualCount;
      session.totalSize = actualSize;
    }

    res.json({
      success: true,
      data: sessions,
      paging: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
  }
});

// POST /api/baskets/:id/sessions - Create new processing session
router.post('/:id/sessions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { batchName: customName, publishMode = 'manual' } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Generate batch name
    let baseName = customName;
    if (!baseName) {
      baseName = generateBatchName(basket.sessionPattern);
    }
    
    // Handle {SEQ}, {SEQ1}, {SEQ2}, {SEQ3} - sequence numbers with reset logic
    let finalBatchName = baseName;
    const seqMatch = baseName.match(/\{SEQ(\d)?\}/);
    if (seqMatch) {
      const digits = seqMatch[1] ? parseInt(seqMatch[1]) : 3; // Default 3 digits
      const now = new Date();
      
      // Determine reset period based on pattern
      let fromDate: Date;
      
      if (basket.sessionPattern.includes('{YYYY-MM-DD}')) {
        // Reset daily
        fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (basket.sessionPattern.includes('{YYYY-MM}') || basket.sessionPattern.includes('{MM}')) {
        // Reset monthly
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (basket.sessionPattern.includes('{YYYY+543}') || basket.sessionPattern.includes('{BYYYY}') || basket.sessionPattern.includes('{YYYY}')) {
        // Reset yearly (support both Christian and Buddhist year)
        fromDate = new Date(now.getFullYear(), 0, 1);
      } else {
        // Default: reset daily
        fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }
      
      fromDate.setHours(0, 0, 0, 0);
      
      const count = await prisma.processingSession.count({
        where: { 
          basketId: id,
          startedAt: { gte: fromDate },
          status: { in: ['open', 'published', 'processing', 'completed', 'archived'] }
        }
      });
      const seqNum = String(count + 1).padStart(digits, '0');
      finalBatchName = baseName.replace(seqMatch[0], digits === 1 ? String(count + 1) : seqNum);
    }

    // Ensure unique name
    let uniqueName = finalBatchName;
    let suffix = 1;
    while (await prisma.processingSession.findFirst({ where: { batchName: uniqueName, basketId: id } })) {
      uniqueName = `${finalBatchName}-${suffix}`;
      suffix++;
    }

    // Create session directory
    const sessionPath = path.join(basket.path, 'sessions', uniqueName);
    fs.mkdirSync(sessionPath, { recursive: true });

    const session = await prisma.processingSession.create({
      data: {
        basketId: id,
        batchName: uniqueName,
        status: 'open',
        publishMode,
        fileCount: 0,
        totalSize: 0
      }
    });

    // Log session creation
    await prisma.sessionLog.create({
      data: {
        sessionId: session.id,
        type: 'session_created',
        message: `Processing session ${uniqueName} created (${publishMode})`,
        metadata: JSON.stringify({ path: sessionPath, publishMode })
      }
    });

    res.json({ success: true, data: session });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, error: 'Failed to create session' });
  }
});

// PUT /api/baskets/:id/sessions/:sessionId - Update session
router.put('/:id/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;
    const { batchName } = req.body;

    // Check if basket exists
    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Check if session exists and belongs to basket
    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // Update session
    const updatedSession = await prisma.processingSession.update({
      where: { id: sessionId },
      data: { 
        ...(batchName && { batchName: batchName.trim() })
      }
    });

    res.json({ success: true, data: updatedSession });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ success: false, error: 'Failed to update session' });
  }
});

// POST /api/baskets/:id/sessions/:sessionId/publish - Publish session for processing
router.post('/:id/sessions/:sessionId/publish', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;
    const { lockedBy } = req.body; // flowId or executionId

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    if (session.status !== 'open' && session.status !== 'error') {
      res.status(400).json({ success: false, error: `Session is ${session.status}, cannot publish` });
      return;
    }

    // Auto-archive if enabled before publishing
    const basket = await prisma.basket.findUnique({ where: { id } });
    let archiveResult = null;
    
    if (basket?.autoArchive && session.fileCount > 0) {
      archiveResult = await archiveSessionFiles(id, sessionId);
    }

    // Update session to published and optionally lock it
    const updateData: any = {
      status: 'published',
      publishedAt: new Date()
    };
    
    if (lockedBy) {
      updateData.lockedBy = lockedBy;
      updateData.lockedAt = new Date();
    }

    const updated = await prisma.processingSession.update({
      where: { id: sessionId },
      data: updateData
    });

    // Find and trigger auto-trigger flows
    const triggeredFlows: any[] = [];
    try {
      // Find flows with basket-trigger for this basket
      const flows = await prisma.flow.findMany({
        where: {
          type: { in: ['event', 'Event'] },
          status: { in: ['active', 'Active'] }
        },
        select: { id: true, name: true, nodes: true }
      });
      
      for (const flow of flows) {
        const nodes = JSON.parse(flow.nodes);
        const triggerNode = nodes.find((n: any) => n.type === 'basket-trigger');
        
        if (triggerNode && 
            triggerNode.data?.basketId === id && 
            triggerNode.data?.triggerOn === 'published') {
          
          // Trigger the flow
          console.log(`[Session Publish] Auto-triggering flow: ${flow.name} (${flow.id})`);
          
          triggeredFlows.push({
            flowId: flow.id,
            flowName: flow.name,
          });

          // Actually execute the flow via internal API call (fire-and-forget)
          const port = process.env.PORT || 8137;
          fetch(`http://127.0.0.1:${port}${process.env.CTX_BACKEND_PATH || '/int'}/flows/${flow.id}/execute`, {
            method: 'POST',
            // /int requires a session: run the flow as the user who published
            headers: {
              'Content-Type': 'application/json',
              ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
            },
            body: JSON.stringify({
              parameters: {
                _triggerType: 'basket',
                _basketId: id,
                _sessionId: sessionId,
                _sessionName: session.batchName,
              }
            })
          }).then(r => r.json()).then(result => {
            if (!result.success) {
              console.error(`[Session Publish] Flow ${flow.name} not started: ${result.error}`);
              return;
            }
            console.log(`[Session Publish] Flow ${flow.name} triggered:`, result.data?.execution?.id);
          }).catch(err => {
            console.error(`[Session Publish] Failed to execute flow ${flow.name}:`, err.message);
          });
        }
      }
    } catch (triggerError) {
      console.error('[Session Publish] Error triggering flows:', triggerError);
      // Don't fail the publish if trigger fails
    }

    // Log publish
    await prisma.sessionLog.create({
      data: {
        sessionId,
        type: 'session_published',
        message: `Session ${session.batchName} published for processing`,
        fileCount: session.fileCount,
        metadata: JSON.stringify({ 
          lockedBy, 
          archiveCreated: !!archiveResult,
          triggeredFlows: triggeredFlows.length > 0 ? triggeredFlows : undefined
        })
      }
    });

    res.json({ 
      success: true, 
      data: updated,
      archive: archiveResult,
      triggeredFlows: triggeredFlows.length > 0 ? triggeredFlows : undefined
    });
  } catch (error) {
    console.error('Error publishing session:', error);
    res.status(500).json({ success: false, error: 'Failed to publish session' });
  }
});

// POST /api/baskets/:id/sessions/:sessionId/archive - Archive session to ZIP
router.post('/:id/sessions/:sessionId/archive', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id },
      include: { basketFiles: true }
    });
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    if (session.archivePath) {
      res.status(400).json({ success: false, error: 'Session already archived' });
      return;
    }

    const result = await archiveSession(sessionId, 'archived from the basket');

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error archiving session:', error);
    res.status(500).json({ success: false, error: 'Failed to archive session' });
  }
});

// GET /api/baskets/:id/sessions/:sessionId/download - Download archive
router.get('/:id/sessions/:sessionId/download', requireSession, async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });
    
    if (!session || !session.archivePath || !fs.existsSync(session.archivePath)) {
      res.status(404).json({ success: false, error: 'Archive not found' });
      return;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${session.batchName}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const stream = fs.createReadStream(session.archivePath);
    stream.on('error', (err) => {
      console.error('Error streaming archive:', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read archive' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    console.error('Error downloading archive:', error);
    res.status(500).json({ success: false, error: 'Failed to download archive' });
  }
});

// POST /api/baskets/:id/sessions/:sessionId/restore - Restore archived session to new active session
router.post('/:id/sessions/:sessionId/restore', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;
    const { newBatchName } = req.body;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id },
      include: { basketFiles: true }
    });
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    if (!session.archivePath || !fs.existsSync(session.archivePath)) {
      res.status(404).json({ success: false, error: 'Archive not found' });
      return;
    }

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Generate new batch name
    const finalBatchName = newBatchName || `${session.batchName}-restored`;
    
    // Create new session
    const newSession = await prisma.processingSession.create({
      data: {
        basketId: id,
        batchName: finalBatchName,
        status: 'open',
        publishMode: 'manual',
        fileCount: 0,
        totalSize: 0
      }
    });

    // Create session directory
    const sessionPath = path.join(basket.path, 'sessions', finalBatchName);
    fs.mkdirSync(sessionPath, { recursive: true });

    // Extract ZIP and copy files
    const extract = require('extract-zip');
    const extractPath = path.join(sessionPath, 'extracted');
    fs.mkdirSync(extractPath, { recursive: true });
    
    await extract(session.archivePath, { dir: extractPath });

    // Copy files to new session and create database records
    let totalSize = 0;
    let fileCount = 0;
    
    const extractFiles = fs.readdirSync(extractPath);
    for (const fileName of extractFiles) {
      const extractedFilePath = path.join(extractPath, fileName);
      if (fs.statSync(extractedFilePath).isFile()) {
        const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newFilePath = path.join(sessionPath, `${fileId}_${fileName}`);
        
        fs.copyFileSync(extractedFilePath, newFilePath);
        const stats = fs.statSync(newFilePath);
        
        await prisma.basketFile.create({
          data: {
            id: fileId,
            basketId: id,
            sessionId: newSession.id,
            fileName: `${fileId}_${fileName}`,
            originalName: fileName,
            path: newFilePath,
            size: stats.size,
            mimeType: 'application/octet-stream', // Could detect from extension
            status: 'pending'
          }
        });
        
        totalSize += stats.size;
        fileCount++;
      }
    }

    // Update new session
    await prisma.processingSession.update({
      where: { id: newSession.id },
      data: { fileCount, totalSize }
    });

    // Clean up extracted temp folder
    fs.rmSync(extractPath, { recursive: true, force: true });

    // Log restore
    await prisma.sessionLog.create({
      data: {
        sessionId: newSession.id,
        type: 'session_restored',
        message: `Session restored from ${session.batchName}`,
        fileCount,
        metadata: JSON.stringify({ sourceSessionId: sessionId, sourceBatchName: session.batchName })
      }
    });

    res.json({ success: true, data: newSession });
  } catch (error) {
    console.error('Error restoring session:', error);
    res.status(500).json({ success: false, error: 'Failed to restore session' });
  }
});

// POST /api/baskets/:id/sessions/:sessionId/reactivate - Reactivate completed session
router.post('/:id/sessions/:sessionId/reactivate', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // Only allow reactivate completed, error, or processing (stuck) sessions (not archived)
    if (session.status === 'archived') {
      res.status(400).json({ success: false, error: 'Archived sessions cannot be reactivated. Use Restore instead.' });
      return;
    }

    if (!['completed', 'error', 'processing'].includes(session.status)) {
      res.status(400).json({ success: false, error: `Cannot reactivate session with status: ${session.status}` });
      return;
    }

    // Update session back to active
    const updated = await prisma.processingSession.update({
      where: { id: sessionId },
      data: {
        status: 'open',
        processedBy: null,
        processedAt: null,
        completedAt: null
      }
    });

    // Reset files status back to pending
    await prisma.basketFile.updateMany({
      where: { sessionId },
      data: { status: 'pending', processedAt: null }
    });

    // Log reactivation
    await prisma.sessionLog.create({
      data: {
        sessionId,
        type: 'session_reactivated',
        message: `Session ${session.batchName} reactivated from completed`,
        fileCount: session.fileCount
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error reactivating session:', error);
    res.status(500).json({ success: false, error: 'Failed to reactivate session' });
  }
});

// POST /api/baskets/:id/sessions/:sessionId/complete - Force complete a stuck processing session
router.post('/:id/sessions/:sessionId/complete', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    if (session.status !== 'processing') {
      res.status(400).json({ success: false, error: `Can only force-complete sessions in 'processing' status, current: ${session.status}` });
      return;
    }

    const updated = await prisma.processingSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        completedAt: new Date()
      }
    });

    await prisma.sessionLog.create({
      data: {
        sessionId,
        type: 'session_completed',
        message: `Session ${session.batchName} manually force-completed from processing`,
        fileCount: session.fileCount
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error force-completing session:', error);
    res.status(500).json({ success: false, error: 'Failed to force-complete session' });
  }
});

// DELETE /api/baskets/:id/sessions/:sessionId - Delete a session
router.delete('/:id/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;

    // Check if basket exists
    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Check if session exists and belongs to basket
    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id },
      include: { basketFiles: true }
    });
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // Allow deleting all session statuses (open, published, processing, completed, archived)

    // Delete physical files
    for (const file of session.basketFiles) {
      if (fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch (err) {
          console.warn(`Failed to delete file: ${file.path}`, err);
        }
      }
    }

    // Delete session directory if it exists
    const sessionPath = path.join(basket.path, 'sessions', session.batchName);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Failed to delete session directory: ${sessionPath}`, err);
      }
    }

    // Delete session (this will cascade delete basketFiles and sessionLogs via Prisma relations)
    await prisma.processingSession.delete({
      where: { id: sessionId }
    });

    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ success: false, error: 'Failed to delete session' });
  }
});

// DELETE /api/baskets/:id/sessions - Clear all completed/archived sessions (history)
router.delete('/:id/sessions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if basket exists
    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Find all completed or archived sessions
    const historySessions = await prisma.processingSession.findMany({
      where: { 
        basketId: id,
        status: { in: ['completed', 'archived'] }
      },
      include: { basketFiles: true }
    });

    let deletedCount = 0;
    
    // Delete each session
    for (const session of historySessions) {
      // Delete physical files
      for (const file of session.basketFiles) {
        if (fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            console.warn(`Failed to delete file: ${file.path}`, err);
          }
        }
      }

      // Delete session directory if it exists
      const sessionPath = path.join(basket.path, 'sessions', session.batchName);
      if (fs.existsSync(sessionPath)) {
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Failed to delete session directory: ${sessionPath}`, err);
        }
      }

      // Delete session (cascade via Prisma)
      await prisma.processingSession.delete({
        where: { id: session.id }
      });
      
      deletedCount++;
    }

    res.json({ 
      success: true, 
      data: { 
        deleted: true, 
        count: deletedCount 
      } 
    });
  } catch (error) {
    console.error('Error clearing history:', error);
    res.status(500).json({ success: false, error: 'Failed to clear history' });
  }
});

// PUT /api/baskets/:id - Update basket name/description
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Check if name is already taken in this project
    if (name) {
      const existing = await prisma.basket.findFirst({
        where: { 
          name, 
          projectId: basket.projectId, 
          NOT: { id } 
        }
      });
      if (existing) {
        res.status(400).json({ success: false, error: 'Basket name already exists in this project' });
        return;
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;

    const updated = await prisma.basket.update({
      where: { id },
      data: updateData
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating basket:', error);
    res.status(500).json({ success: false, error: 'Failed to update basket' });
  }
});

// GET /api/baskets/:id/sessions/:sessionId/files - Get files in a session
router.get('/:id/sessions/:sessionId/files', async (req: Request, res: Response) => {
  try {
    const { id, sessionId } = req.params;
    const { page = '1', limit = '50', search = '' } = req.query;

    const session = await prisma.processingSession.findFirst({
      where: { id: sessionId, basketId: id }
    });
    
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const where: any = { sessionId };
    if (search) {
      where.OR = [
        { originalName: { contains: search as string, mode: 'insensitive' } },
        { fileName: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const [files, total] = await Promise.all([
      prisma.basketFile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit as string)
      }),
      prisma.basketFile.count({ where })
    ]);

    res.json({
      success: true,
      data: files,
      session,
      paging: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Error fetching session files:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch files' });
  }
});

// PUT /api/baskets/:id/settings - Update basket settings
router.put('/:id/settings', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      sessionPattern, 
      autoArchive, 
      autoPublish, 
      autoPublishConfig,
      maxFiles,
      maxFileSize,
      allowedTypes,
      namingPattern
    } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const updateData: any = {};
    if (sessionPattern !== undefined) updateData.sessionPattern = sessionPattern;
    if (autoArchive !== undefined) updateData.autoArchive = autoArchive;
    if (autoPublish !== undefined) updateData.autoPublish = autoPublish;
    if (autoPublishConfig !== undefined) updateData.autoPublishConfig = JSON.stringify(autoPublishConfig);
    if (maxFiles !== undefined) updateData.maxFiles = maxFiles ? parseInt(maxFiles) : null;
    if (maxFileSize !== undefined) updateData.maxFileSize = maxFileSize ? parseInt(maxFileSize) * 1024 * 1024 : null;
    if (allowedTypes !== undefined) updateData.allowedTypes = allowedTypes;
    if (namingPattern !== undefined) updateData.namingPattern = namingPattern;

    const updated = await prisma.basket.update({
      where: { id },
      data: updateData
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// GET /api/baskets/:id/stats - Get basket statistics
router.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const stats = await Promise.all([
      prisma.basketFile.count({ where: { basketId: id, status: 'pending' } }),
      prisma.processingSession.count({ where: { basketId: id } }),
      prisma.processingSession.count({ where: { basketId: id, status: 'archived' } }),
      prisma.processingSession.count({ where: { basketId: id, status: 'published' } }),
      prisma.basketFile.count({ where: { basketId: id, status: 'processed' } }),
      prisma.basketFile.aggregate({
        where: { basketId: id },
        _sum: { size: true }
      })
    ]);

    res.json({
      success: true,
      data: {
        pendingFiles: stats[0],
        totalSessions: stats[1],
        archivedSessions: stats[2],
        publishedSessions: stats[3],
        processedFiles: stats[4],
        totalSize: stats[5]._sum.size || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

export default router;
