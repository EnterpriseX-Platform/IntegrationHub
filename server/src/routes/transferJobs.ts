import { Router, Request, Response } from 'express';
import { guardProject, visibleProjectIds } from '../lib/access';
import { prisma } from '../lib/prisma';
import { Client } from 'ssh2';
import path from 'path';

const router = Router();

// Non-admins only see transfer jobs of their projects; running or changing one needs editor
router.param('id', guardProject(async (id) => {
  const t = await prisma.transferJob.findUnique({ where: { id }, select: { flow: { select: { projectId: true } } } });
  return t?.flow?.projectId || null;
}));

// GET /api/transfer-jobs - List all transfer jobs
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId, flowId } = req.query;
    
    const where: any = {};
    if (projectId) where.projectId = projectId as string;
    const visible = await visibleProjectIds(req);
    if (visible) where.flow = { projectId: { in: visible } };
    if (flowId) where.flowId = flowId as string;
    
    const jobs = await prisma.transferJob.findMany({
      where,
      include: {
        basket: {
          select: { name: true }
        },
        _count: {
          select: { logs: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: jobs });
  } catch (error) {
    console.error('Error fetching transfer jobs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch transfer jobs' });
  }
});

// POST /api/transfer-jobs - Create a new transfer job
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name,
      sourceBasketId,
      destinationType,
      destinationConfig,
      filePattern,
      schedule,
      projectId,
      flowId
    } = req.body;

    if (!name || !sourceBasketId || !projectId) {
      res.status(400).json({ 
        success: false, 
        error: 'Name, sourceBasketId, and projectId are required' 
      });
      return;
    }

    // Calculate next run if schedule provided
    if (schedule) {
      calculateNextRun(schedule);
    }

    const job = await prisma.transferJob.create({
      data: {
        sourceBasketId,
        targetType: destinationType || 'sftp',
        targetConfig: JSON.stringify(destinationConfig || {}),
        filePattern: filePattern || '*',
        schedule,
        flowId
      }
    });

    res.json({ success: true, data: job });
  } catch (error) {
    console.error('Error creating transfer job:', error);
    res.status(500).json({ success: false, error: 'Failed to create transfer job' });
  }
});

// GET /api/transfer-jobs/:id - Get job details with logs
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const job = await prisma.transferJob.findUnique({
      where: { id },
      include: {
        basket: true,
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      }
    });

    if (!job) {
      res.status(404).json({ success: false, error: 'Transfer job not found' });
      return;
    }

    res.json({ success: true, data: job });
  } catch (error) {
    console.error('Error fetching transfer job:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch transfer job' });
  }
});

// POST /api/transfer-jobs/:id/execute - Execute transfer job immediately
router.post('/:id/execute', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const job = await prisma.transferJob.findUnique({
      where: { id },
      include: { basket: { include: { basketFiles: true } } }
    });

    if (!job) {
      res.status(404).json({ success: false, error: 'Transfer job not found' });
      return;
    }

    // Update last run time
    await prisma.transferJob.update({
      where: { id },
      data: { 
        updatedAt: new Date()
      }
    });

    // Filter files by pattern
    const pattern = job.filePattern || '*';
    const filesToTransfer = job.basket?.basketFiles?.filter((file: any) => {
      if (file.status !== 'pending' && file.status !== 'processed') return false;
      return matchPattern(file.originalName, pattern);
    }) || [];

    if (filesToTransfer.length === 0) {
      res.json({ success: true, message: 'No files to transfer', transferred: 0 });
      return;
    }

    // Execute transfer based on destination type
    const config = JSON.parse(job.targetConfig);
    const results = [];

    for (const file of filesToTransfer) {
      const log = await prisma.transferLog.create({
        data: {
          jobId: id,
          status: 'started',
          message: `Starting transfer for file ${file.fileName || file.id}`
        }
      });

      try {
        if (job.targetType === 'sftp') {
          await transferViaSFTP(file, config);
        }

        // Update file status
        await prisma.basketFile.update({
          where: { id: file.id },
          data: { 
            status: 'transferred'
          }
        });

        // Update log
        await prisma.transferLog.update({
          where: { id: log.id },
          data: {
            status: 'success',
            message: 'Transfer completed successfully'
          }
        });

        results.push({ fileId: file.id, success: true });
      } catch (err) {
        await prisma.transferLog.update({
          where: { id: log.id },
          data: {
            status: 'failed',
            message: (err as Error).message
          }
        });

        results.push({ fileId: file.id, success: false, error: (err as Error).message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    
    res.json({
      success: true,
      message: `Transferred ${successCount}/${filesToTransfer.length} files`,
      data: results
    });
  } catch (error) {
    console.error('Error executing transfer job:', error);
    res.status(500).json({ success: false, error: 'Failed to execute transfer job' });
  }
});

// PUT /api/transfer-jobs/:id - Update transfer job
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, destinationConfig, filePattern, schedule, status } = req.body;

    const job = await prisma.transferJob.findUnique({ where: { id } });
    if (!job) {
      res.status(404).json({ success: false, error: 'Transfer job not found' });
      return;
    }

    let nextRunAt = undefined;
    if (schedule !== undefined) {
      nextRunAt = schedule ? calculateNextRun(schedule) : null;
    }

    const updated = await prisma.transferJob.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(destinationConfig && { destinationConfig: JSON.stringify(destinationConfig) }),
        ...(filePattern && { filePattern }),
        ...(schedule !== undefined && { schedule }),
        ...(status && { status }),
        ...(nextRunAt !== undefined && { nextRunAt }),
        updatedAt: new Date()
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating transfer job:', error);
    res.status(500).json({ success: false, error: 'Failed to update transfer job' });
  }
});

// DELETE /api/transfer-jobs/:id - Delete transfer job
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.transferJob.delete({ where: { id } });
    res.json({ success: true, message: 'Transfer job deleted' });
  } catch (error) {
    console.error('Error deleting transfer job:', error);
    res.status(500).json({ success: false, error: 'Failed to delete transfer job' });
  }
});

// Helper function to transfer via SFTP
async function transferViaSFTP(
  file: { path: string; originalName: string },
  config: {
    host: string;
    port: number;
    username: string;
    password: string;
    remotePath: string;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(new Error(`SFTP error: ${err.message}`));
        }

        const remoteFileName = path.join(
          config.remotePath || '/upload',
          file.originalName
        );
        
        sftp.fastPut(file.path, remoteFileName, (err) => {
          conn.end();
          
          if (err) {
            return reject(new Error(`Transfer error: ${err.message}`));
          }
          
          resolve();
        });
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`Connection error: ${err.message}`));
    });

    conn.connect({
      host: config.host || 'localhost',
      port: config.port || 2222,
      username: config.username || 'dga',
      password: config.password || 'dga123',
      readyTimeout: 20000,
    });
  });
}

// Helper function to match file pattern
function matchPattern(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;
  
  // Simple glob matching
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
  );
  return regex.test(filename);
}

// Helper function to calculate next run time from cron expression
function calculateNextRun(_schedule: string): Date {
  // For now, simple implementation - add 5 minutes
  // In production, use a proper cron parser like node-cron or node-schedule
  const now = new Date();
  now.setMinutes(now.getMinutes() + 5);
  return now;
}

export default router;
