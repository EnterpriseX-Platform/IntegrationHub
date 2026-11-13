import express, { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { guardProjects, guardProject, basketProjects, projectScope, visibleProjectIds, projectRole, roleAllows, adminOnly, feFolderRoles, isFileExplorerBasket, allowFeFolder, neededFor } from '../lib/access';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import multer from 'multer';
import { base64Upload } from '../middleware/base64Upload';
import { requireSession } from '../middleware/requireSession';
import { readLinks, writeLinks } from '../lib/fileExplorerBasket';
import { Client, SFTPWrapper } from 'ssh2';

// Configure multer for disk storage (supports large files without memory pressure)
const uploadDir = process.env.UPLOAD_TEMP_DIR || path.join(process.env.DATA_PATH || '/data', 'temp', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${file.originalname}`)
  }),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB max file size
  }
});

const router = Router();

// Non-admins reach a basket through its project or a project it is shared with:
// viewer reads files, editor uploads, moves and deletes them
router.param('id', guardProjects(basketProjects));
router.param('projectId', guardProject(async (pid) => pid));

// File Explorer basket: non-admins may only use its file and folder routes
// (no download-all, settings, shares, SFTP, process, delete basket)
router.param('id', async (req, res, next, id) => {
  try {
    if (!(await isFileExplorerBasket(id)) || !(await feFolderRoles(req, id))) return next();
    const sub = req.path.slice(`/${id}`.length);
    if (sub === '' && req.method === 'GET') return next();
    if (/^\/(files|folders)(\/|$)/.test(sub) && !/^\/files\/[^/]+\/logs$/.test(sub)) return next();
    res.status(403).json({ success: false, error: 'Admin only' });
  } catch (err) { next(err); }
});

// File Explorer: non-admins only reach files and folders inside top-level
// folders granted to them or their group (Settings › Groups)
router.param('fileId', async (req, res, next, fileId) => {
  try {
    if (!(await isFileExplorerBasket(req.params.id))) return next();
    const f = await prisma.basketFile.findUnique({ where: { id: fileId }, select: { folderId: true } });
    if (!f) return next();
    if (await allowFeFolder(req, res, req.params.id, f.folderId, neededFor(req))) next();
  } catch (err) { next(err); }
});
router.param('folderId', async (req, res, next, folderId) => {
  try {
    if (!(await isFileExplorerBasket(req.params.id))) return next();
    const f = await prisma.basketFolder.findUnique({ where: { id: folderId }, select: { parentId: true } });
    if (!f) return next();
    // a top-level folder is where access is granted, so only admins remove it
    const target = req.method === 'DELETE' && !f.parentId ? null : folderId;
    if (await allowFeFolder(req, res, req.params.id, target, neededFor(req))) next();
  } catch (err) { next(err); }
});
const BASKETS_BASE_DIR = process.env.BASKETS_DIR || './baskets';

// Helper: Check if a project has write permission to a basket
async function checkBasketWritePermission(basketId: string, projectId?: string): Promise<boolean> {
  if (!projectId) return true; // No project context = allow (internal calls)
  const basket = await prisma.basket.findUnique({ where: { id: basketId }, select: { projectId: true } });
  if (!basket) return false;
  if (basket.projectId === projectId) return true; // Owner project
  const share = await prisma.basketShare.findFirst({
    where: { basketId, projectId, permission: 'write' },
  });
  return !!share;
}

// Ensure baskets directory exists
if (!fs.existsSync(BASKETS_BASE_DIR)) {
  fs.mkdirSync(BASKETS_BASE_DIR, { recursive: true });
}

// Inactive file statuses — excluded from fileCount
// archived = moved to archive (lifecycle ended); failed = failed transfer
const INACTIVE_FILE_STATUSES = ['archived', 'failed'];
const activeFileWhere = { status: { notIn: INACTIVE_FILE_STATUSES } };

// GET /api/baskets/overview - All baskets with sessions in single request
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const [projectWhere, basketWhere] = [await projectScope(req, 'id'), await projectScope(req)];
    const [projects, baskets] = await Promise.all([
      prisma.project.findMany({
        where: projectWhere,
        select: { id: true, name: true, color: true, position: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'desc' }]
      }),
      prisma.basket.findMany({
        where: basketWhere,
        include: {
          _count: { select: { basketFiles: { where: activeFileWhere } } },
          sessions: {
            where: { status: { in: ['open', 'published', 'processing'] } },
            select: {
              id: true, batchName: true, status: true, fileCount: true, totalSize: true,
              _count: { select: { basketFiles: { where: activeFileWhere } } }
            },
            orderBy: { startedAt: 'desc' },
            take: 10
          },
          folders: {
            select: { id: true, _count: { select: { files: { where: activeFileWhere } } } }
          }
        },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }]
      })
    ]);

    const basketsWithData = baskets.map(b => {
      let fileCount = 0, activeFileCount = 0, activeSessionCount = 0;
      if (b.type === 'shares') {
        // Shares basket: include files in folders + files at root (folderId=null).
        // basketFiles._count already excludes archived/failed via activeFileWhere,
        // and root files were previously missed when only folders were summed.
        fileCount = b._count?.basketFiles || 0;
        activeFileCount = fileCount;
      } else if (b.type === 'sftp') {
        fileCount = b._count?.basketFiles || 0;
        activeFileCount = fileCount;
      } else {
        fileCount = b._count?.basketFiles || 0;
        activeFileCount = b.sessions.reduce((sum, s) => sum + s._count.basketFiles, 0);
        activeSessionCount = b.sessions.length;
      }

      const { _count, folders, ...rest } = b as any;
      return {
        ...rest,
        fileCount, activeFileCount, activeSessionCount,
        sessions: b.sessions.map(s => ({
          id: s.id, batchName: s.batchName, status: s.status,
          fileCount: s.fileCount || s._count.basketFiles, totalSize: s.totalSize
        }))
      };
    });

    const totalFiles = basketsWithData.reduce((sum, b) => sum + b.fileCount, 0);
    const activeSessions = basketsWithData.reduce((sum, b) => sum + b.activeSessionCount, 0);
    const projectsWithBaskets = [...new Set(basketsWithData.map(b => b.projectId))].length;

    res.json({
      success: true,
      data: {
        projects,
        baskets: basketsWithData,
        summary: {
          totalBaskets: basketsWithData.length,
          totalFiles,
          activeSessions,
          projectCount: projectsWithBaskets
        }
      }
    });
  } catch (error) {
    console.error('Error fetching baskets overview:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch baskets overview' });
  }
});

// GET /api/baskets - List all baskets for a project
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query;

    const visible = await visibleProjectIds(req);
    if (projectId && visible && !visible.includes(projectId as string)) {
      res.json({ success: true, data: [] });
      return;
    }
    // The File Explorer's own basket is anchored to a project only because the schema needs
    // one; it is the global workspace, not that project's basket, so keep it off basket lists.
    const feCfg = await prisma.systemConfig.findFirst({ where: { key: 'fileExplorerBasketId' }, select: { value: true } });
    const where = {
      ...(projectId ? { projectId: projectId as string } : await projectScope(req)),
      ...(feCfg?.value ? { id: { not: feCfg.value } } : {}),
    };

    const basketInclude = {
      _count: {
        select: { basketFiles: { where: activeFileWhere } }
      },
      // Include active sessions for session/batch baskets
      sessions: {
        where: {
          status: { in: ['open', 'published', 'processing'] }
        },
        select: {
          id: true,
          _count: {
            select: { basketFiles: { where: activeFileWhere } }
          }
        }
      },
      // Include folders for shares baskets
      folders: {
        select: {
          id: true,
          _count: {
            select: { files: { where: activeFileWhere } }
          }
        }
      }
    };

    const baskets = await prisma.basket.findMany({
      where,
      include: basketInclude,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }]
    });

    // Also fetch baskets shared with this project
    let sharedBaskets: typeof baskets = [];
    if (projectId) {
      const shares = await prisma.basketShare.findMany({
        where: { projectId: projectId as string },
        select: { basketId: true, permission: true }
      });
      if (shares.length > 0) {
        sharedBaskets = await prisma.basket.findMany({
          where: { id: { in: shares.map(s => s.basketId) } },
          include: basketInclude,
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }]
        });
        // Mark shared baskets
        sharedBaskets = sharedBaskets.map(b => ({
          ...b,
          _isShared: true,
          _sharePermission: shares.find(s => s.basketId === b.id)?.permission || 'read'
        })) as any;
      }
    }

    // Combine own baskets + shared baskets
    const allBaskets = [...baskets, ...sharedBaskets];

    // Calculate fileCount based on basket type
    const basketsWithFileCount = allBaskets.map(b => {
      let fileCount = 0;
      let activeFileCount = 0;
      let activeSessionCount = 0;

      if (b.type === 'shares') {
        // For shares baskets: count files in all folders
        fileCount = b.folders.reduce((sum, folder) => sum + folder._count.files, 0);
        activeFileCount = fileCount;
      } else if (b.type === 'sftp') {
        // For sftp baskets: count all files
        fileCount = b._count?.basketFiles || 0;
        activeFileCount = fileCount;
      } else {
        // For batch baskets: count all files and active session files separately
        fileCount = b._count?.basketFiles || 0;
        activeFileCount = b.sessions.reduce((sum, session) => sum + session._count.basketFiles, 0);
        activeSessionCount = b.sessions.length;
      }

      // Explicitly destructure to avoid _count overwriting fileCount
      const { _count, sessions, folders, _isShared, _sharePermission, ...rest } = b as any;

      return {
        ...rest,
        fileCount,
        activeFileCount,
        activeSessionCount,
        isShared: _isShared || false,
        sharePermission: _sharePermission,
        _count: { basketFiles: fileCount }
      };
    });

    res.json({
      success: true,
      data: basketsWithFileCount
    });
  } catch (error) {
    console.error('Error fetching baskets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch baskets' });
  }
});

// POST /api/baskets - Create a new basket
router.post('/', async (req: Request, res: Response) => {
  try {
    const { 
      name, 
      description, 
      projectId,
      type = 'batch',
      maxFiles,
      maxFileSize,
      allowedTypes,
      namingPattern,
      sftpMode,
      sftpConnectionId
    } = req.body;

    if (projectId && !roleAllows(await projectRole(req, projectId), 'editor')) {
      res.status(403).json({ success: false, error: 'You do not have access to this project' });
      return;
    }
    if (!name || !projectId) {
      res.status(400).json({ success: false, error: 'Name and projectId are required' });
      return;
    }

    // Validate basket type
    if (type !== 'batch' && type !== 'shares' && type !== 'sftp') {
      res.status(400).json({ success: false, error: 'Invalid basket type. Must be "batch", "shares", or "sftp"' });
      return;
    }

    // Create basket in DB first (Prisma auto-generates CUID)
    const basket = await prisma.basket.create({
      data: {
        name,
        description,
        path: '', // Will be updated after directory creation
        type,
        projectId,
        maxFiles: maxFiles ? parseInt(maxFiles) : null,
        maxFileSize: maxFileSize ? parseInt(maxFileSize) : null,
        allowedTypes: allowedTypes || [],
        namingPattern: namingPattern || null,
        // SFTP specific fields
        sftpMode: type === 'sftp' ? (sftpMode || 'external') : null,
        sftpConnectionId: type === 'sftp' ? sftpConnectionId : null
      }
    });

    // Create physical directory using the generated CUID
    const basketPath = path.join(BASKETS_BASE_DIR, basket.id);
    fs.mkdirSync(basketPath, { recursive: true });
    fs.mkdirSync(path.join(basketPath, 'incoming'), { recursive: true });
    fs.mkdirSync(path.join(basketPath, 'processed'), { recursive: true });

    // Update basket path
    await prisma.basket.update({
      where: { id: basket.id },
      data: { path: basketPath }
    });

    // A File Explorer basket made in a project shows up in the File Explorer right away
    if (type === 'shares') {
      const links = await readLinks();
      await writeLinks([...links, { id: `lnk_${basket.id}`, basketId: basket.id, name: basket.name, createdAt: new Date().toISOString() }]);
    }

    // Log basket creation
    await prisma.basketLog.create({
      data: {
        basketId: basket.id,
        type: 'create',
        message: `Basket created with rules: maxFiles=${maxFiles || 'unlimited'}, maxSize=${maxFileSize ? `${Math.round(maxFileSize/1024/1024)}MB` : 'unlimited'}, types=${allowedTypes?.length > 0 ? allowedTypes.join(',') : 'all'}`,
        metadata: JSON.stringify({ maxFiles, maxFileSize, allowedTypes, namingPattern })
      }
    });

    res.json({ success: true, data: basket });
  } catch (error) {
    console.error('Error creating basket:', error);
    res.status(500).json({ success: false, error: 'Failed to create basket' });
  }
});

// GET /api/baskets/:id - Get basket details
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const basket = await prisma.basket.findUnique({
      where: { id },
      include: {
        _count: {
          select: { basketFiles: true }
        },
        folders: {
          where: { parentId: null },
          include: {
            _count: {
              select: { files: true }
            }
          }
        },
        sharedWith: {
          include: {
            project: {
              select: { id: true, name: true, color: true }
            }
          }
        }
      }
    });

    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    res.json({ success: true, data: basket });
  } catch (error) {
    console.error('Error fetching basket:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch basket' });
  }
});

// GET /api/baskets/:id/trigger-flows - Get flows that trigger on this basket
router.get('/:id/trigger-flows', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Find flows with basket-trigger for this basket
    const flows = await prisma.flow.findMany({
      where: { 
        type: 'event',
        status: 'active'
      },
      select: { 
        id: true, 
        name: true, 
        nodes: true,
        status: true,
        projectId: true
      }
    });

    const triggerFlows = [];
    
    for (const flow of flows) {
      try {
        const nodes = JSON.parse(flow.nodes);
        const triggerNode = nodes.find((n: any) => n.type === 'basket-trigger');
        
        if (triggerNode && triggerNode.data?.basketId === id) {
          triggerFlows.push({
            flowId: flow.id,
            flowName: flow.name,
            flowStatus: flow.status,
            triggerOn: triggerNode.data?.triggerOn || 'published',
            filePattern: triggerNode.data?.filePattern || '*',
            autoProcess: triggerNode.data?.options?.autoProcess !== false,
            nodeLabel: triggerNode.data?.label || flow.name
          });
        }
      } catch (e) {
        console.error(`[Trigger Flows] Error parsing flow ${flow.id}:`, e);
      }
    }

    res.json({ 
      success: true, 
      data: {
        basketId: id,
        triggerCount: triggerFlows.length,
        triggers: triggerFlows
      }
    });
  } catch (error) {
    console.error('[Trigger Flows] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch trigger flows' });
  }
});

// GET /api/baskets/:id/files - Get files with pagination, search and filter
router.get('/:id/files', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      page = '1', 
      limit = '20', 
      search = '', 
      status = 'all',
      folderId
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
    const skip = (pageNum - 1) * limitNum;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Build where clause
    const where: any = { basketId: id };
    
    if (status && status !== 'all') {
      where.status = status as string;
    }
    
    // Filter by folderId - 'root' means files not in any folder
    if (folderId !== undefined) {
      if (folderId === 'root') {
        where.folderId = null;
      } else {
        where.folderId = folderId as string;
      }
    }
    // File Explorer: non-admins see only files inside their granted folders (never the top level)
    const feRoles = (await isFileExplorerBasket(id)) ? await feFolderRoles(req, id) : null;
    if (feRoles) {
      const allowed = [...feRoles.keys()];
      where.folderId = where.folderId ? (allowed.includes(where.folderId) ? where.folderId : '__none__') : { in: allowed };
    }
    
    if (search) {
      where.OR = [
        { originalName: { contains: search as string, mode: 'insensitive' } },
        { fileName: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    // Get total count
    const total = await prisma.basketFile.count({ where });

    // Get files with pagination
    const files = await prisma.basketFile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
      include: {
        _count: {
          select: { logs: true }
        }
      }
    });

    res.json({
      success: true,
      data: files,
      paging: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch files' });
  }
});

// GET /api/baskets/:id/download-all - Download all files as ZIP
router.get('/:id/download-all', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const files = await prisma.basketFile.findMany({
      where: { basketId: id }
    });

    if (files.length === 0) {
      res.status(400).json({ success: false, error: 'No files in basket' });
      return;
    }

    // Set headers for ZIP download
    const zipName = `${basket.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-files.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    // Create ZIP archive
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).json({ success: false, error: 'Failed to create archive' });
    });

    archive.pipe(res);

    // Add files to archive
    let addedCount = 0;
    for (const file of files) {
      if (fs.existsSync(file.path)) {
        archive.file(file.path, { name: file.originalName });
        addedCount++;
      }
    }

    if (addedCount === 0) {
      archive.abort();
      res.status(400).json({ success: false, error: 'No files found on disk' });
      return;
    }

    await archive.finalize();

    // Log bulk download
    await prisma.basketLog.create({
      data: {
        basketId: id,
        type: 'bulk_download',
        message: `Downloaded all files as ZIP (${addedCount} files)`,
        fileCount: addedCount,
        metadata: JSON.stringify({ zipName, filesCount: addedCount })
      }
    });
  } catch (error) {
    console.error('Error creating ZIP:', error);
    res.status(500).json({ success: false, error: 'Failed to create ZIP' });
  }
});

// GET /api/baskets/:id/files/:fileId/download - Download file
router.get('/:id/files/:fileId/download', requireSession, async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    if (!fs.existsSync(file.path)) {
      res.status(404).json({ success: false, error: 'File not found on disk' });
      return;
    }

    // Log download action
    await prisma.basketFileLog.create({
      data: {
        fileId: file.id,
        action: 'download',
        status: 'success',
        message: 'File downloaded via API'
      }
    });

    // Set headers for download with UTF-8 charset for text files
    let contentType = file.mimeType;
    if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
      contentType += '; charset=utf-8';
    }
    const encodedName = encodeURIComponent(file.originalName);
    res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', contentType);

    // Stream file
    const fileStream = fs.createReadStream(file.path);
    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read file' });
      else res.destroy();
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ success: false, error: 'Failed to download file' });
  }
});

// GET /api/baskets/:id/files/:fileId/logs - Get file processing logs
router.get('/:id/files/:fileId/logs', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const logs = await prisma.basketFileLog.findMany({
      where: { fileId },
      orderBy: { createdAt: 'desc' }
    });

    // Get flow names for logs that have flowId
    const flowIds = [...new Set(logs.filter(l => l.flowId).map(l => l.flowId))];
    const flows = flowIds.length > 0 
      ? await prisma.flow.findMany({
          where: { id: { in: flowIds as string[] } },
          select: { id: true, name: true }
        })
      : [];
    
    const flowMap = new Map(flows.map(f => [f.id, f.name]));
    
    const logsWithFlowName = logs.map(log => ({
      ...log,
      flow: log.flowId ? { name: flowMap.get(log.flowId) || 'Unknown Flow' } : null
    }));

    res.json({ success: true, data: logsWithFlowName });
  } catch (error) {
    console.error('Error fetching file logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch file logs' });
  }
});

// GET /api/baskets/:id/logs - Get basket aggregate logs
router.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = '50' } = req.query;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const logs = await prisma.basketLog.findMany({
      where: { basketId: id },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string)
    });

    // Get summary stats
    const stats = await prisma.basketLog.groupBy({
      by: ['type'],
      where: { basketId: id },
      _count: { type: true }
    });

    res.json({ 
      success: true, 
      data: logs,
      stats: stats.reduce((acc, s) => {
        acc[s.type] = s._count.type;
        return acc;
      }, {} as Record<string, number>)
    });
  } catch (error) {
    console.error('Error fetching basket logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch basket logs' });
  }
});

// POST /api/baskets/:id/files - Upload file to basket (supports both JSON base64 and multipart)
const handleBasketFileUpload = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { folderId } = req.body;

    // Permission check for shared baskets
    const projectId = req.query.projectId as string;
    if (projectId && !(await checkBasketWritePermission(id, projectId))) {
      res.status(403).json({ success: false, error: 'Read-only access: cannot upload files to this shared basket' }); return;
    }

    // Check if multipart upload (req.file exists) or JSON base64 upload
    const isMultipart = !!req.file;

    let filename: string;
    let tempFilePath: string | null = null;  // disk-stored temp file from multer
    let buffer: Buffer | null = null;        // only for legacy base64 uploads
    let fileSize: number;
    let fileMimeType: string;
    let metadata: any = {};

    if (isMultipart) {
      // Multipart upload — file is on disk (multer diskStorage)
      filename = req.body.filename || req.file!.originalname;
      tempFilePath = req.file!.path;
      fileSize = req.file!.size;
      fileMimeType = req.file!.mimetype || 'application/octet-stream';
    } else {
      // JSON base64 upload (legacy)
      const { filename: fn, content, contentType, metadata: md } = req.body;

      if (!fn || !content) {
        res.status(400).json({ success: false, error: 'Filename and content are required' });
        return;
      }

      filename = fn;
      buffer = Buffer.from(content, 'base64');
      fileSize = buffer.length;
      fileMimeType = contentType || 'application/octet-stream';
      metadata = md || {};
    }

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }
    if ((await isFileExplorerBasket(id)) && !(await allowFeFolder(req, res, id, folderId || null, 'editor'))) return;

    // Validate folder if provided
    let folderPath = '';
    if (folderId) {
      const folder = await prisma.basketFolder.findFirst({
        where: { id: folderId, basketId: id }
      });
      if (!folder) {
        res.status(404).json({ success: false, error: 'Folder not found' });
        return;
      }
      folderPath = folder.path;
    }

    // fileSize already set above

    // Clean up multer temp file on any early return
    const cleanupTemp = () => { if (tempFilePath) try { fs.unlinkSync(tempFilePath); } catch {} };
    res.on('finish', () => { /* temp file cleaned after move or on error */ });

    // Validation 1: Max files limit
    if (basket.maxFiles) {
      const currentFileCount = await prisma.basketFile.count({
        where: { basketId: id }
      });
      if (currentFileCount >= basket.maxFiles) {
        // Log validation error
        await prisma.basketLog.create({
          data: {
            basketId: id,
            type: 'validation_error',
            message: `Upload rejected: Max files limit (${basket.maxFiles}) reached`,
            metadata: JSON.stringify({ filename, attemptedSize: fileSize })
          }
        });
        res.status(400).json({ 
          success: false, 
          error: `Maximum file limit (${basket.maxFiles}) reached`,
          code: 'MAX_FILES_EXCEEDED'
        });
        cleanupTemp();
        return;
      }
    }

    // Validation 2: File size limit
    if (basket.maxFileSize && fileSize > basket.maxFileSize) {
      await prisma.basketLog.create({
        data: {
          basketId: id,
          type: 'validation_error',
          message: `Upload rejected: File size ${Math.round(fileSize/1024)}KB exceeds limit ${Math.round(basket.maxFileSize/1024)}KB`,
          fileSize: fileSize,
          metadata: JSON.stringify({ filename, maxSize: basket.maxFileSize })
        }
      });
      res.status(400).json({ 
        success: false, 
        error: `File size exceeds maximum allowed (${Math.round(basket.maxFileSize/1024/1024)}MB)`,
        code: 'FILE_SIZE_EXCEEDED'
      });
      cleanupTemp();
      return;
    }

    // Validation 3: Allowed MIME types
    if (basket.allowedTypes && basket.allowedTypes.length > 0) {
      const isAllowed = basket.allowedTypes.some(type => {
        // Support wildcards like "image/*"
        if (type.endsWith('/*')) {
          return fileMimeType.startsWith(type.replace('/*', '/'));
        }
        return fileMimeType === type;
      });
      
      if (!isAllowed) {
        await prisma.basketLog.create({
          data: {
            basketId: id,
            type: 'validation_error',
            message: `Upload rejected: File type "${fileMimeType}" not allowed`,
            metadata: JSON.stringify({ filename, allowedTypes: basket.allowedTypes })
          }
        });
        res.status(400).json({ 
          success: false, 
          error: `File type not allowed. Allowed types: ${basket.allowedTypes.join(', ')}`,
          code: 'FILE_TYPE_NOT_ALLOWED'
        });
        cleanupTemp();
        return;
      }
    }

    // Validation 4: Naming pattern
    if (basket.namingPattern) {
      const pattern = new RegExp(basket.namingPattern);
      if (!pattern.test(filename)) {
        await prisma.basketLog.create({
          data: {
            basketId: id,
            type: 'validation_error',
            message: `Upload rejected: Filename "${filename}" does not match pattern "${basket.namingPattern}"`,
            metadata: JSON.stringify({ filename, pattern: basket.namingPattern })
          }
        });
        res.status(400).json({ 
          success: false, 
          error: `Filename does not match required pattern`,
          code: 'FILENAME_PATTERN_MISMATCH'
        });
        cleanupTemp();
        return;
      }
    }

    // Get session ID from request (if provided)
    const sessionId = req.body.sessionId;
    
    // Save file to basket incoming directory
    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Determine file path based on folder or session
    let filePath: string;
    if (folderId) {
      filePath = path.join(basket.path, 'folders', folderPath, `${fileId}_${filename}`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } else if (sessionId) {
      const session = await prisma.processingSession.findFirst({
        where: { id: sessionId, basketId: id }
      });
      if (session) {
        filePath = path.join(basket.path, 'sessions', session.batchName, `${fileId}_${filename}`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } else {
        filePath = path.join(basket.path, 'incoming', `${fileId}_${filename}`);
      }
    } else {
      filePath = path.join(basket.path, 'incoming', `${fileId}_${filename}`);
    }

    // Ensure target directory exists
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Move temp file or write buffer to final path
    if (tempFilePath) {
      try {
        fs.renameSync(tempFilePath, filePath); // instant move (same filesystem)
      } catch {
        fs.copyFileSync(tempFilePath, filePath); // fallback: cross-device
        fs.unlinkSync(tempFilePath);
      }
    } else if (buffer) {
      fs.writeFileSync(filePath, buffer);
    }

    // Save to database with sessionId and folderId
    const basketFile = await prisma.basketFile.create({
      data: {
        id: fileId,
        fileName: `${fileId}_${filename}`,
        originalName: filename,
        path: filePath,
        size: fileSize,
        mimeType: fileMimeType,
        basketId: id,
        sessionId: sessionId || null,
        folderId: folderId || null,
        metadata: JSON.stringify(metadata || {}),
        status: 'pending'
      }
    });
    
    // Update session file count if sessionId provided
    if (sessionId) {
      await prisma.processingSession.update({
        where: { id: sessionId },
        data: {
          fileCount: { increment: 1 },
          totalSize: { increment: fileSize }
        }
      }).catch(err => {
        // totalSize is 32-bit; a session over 2 GB overflows it. The file is
        // already stored, and the sessions list recomputes the counters.
        console.warn('[basket upload] session counter update failed:', err?.message);
      });
    }

    // Log upload success
    await prisma.basketFileLog.create({
      data: {
        fileId: fileId,
        action: 'upload',
        status: 'success',
        message: `File uploaded: ${filename} (${fileSize} bytes)`
      }
    });

    // Log to basket logs
    await prisma.basketLog.create({
      data: {
        basketId: id,
        type: 'upload',
        message: `File uploaded: ${filename}`,
        fileCount: 1,
        fileSize: fileSize,
        metadata: JSON.stringify({ fileId, mimeType: fileMimeType })
      }
    });

    res.json({ success: true, data: basketFile });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ success: false, error: 'Failed to upload file' });
  }
};

router.post('/:id/files', upload.single('file'), ...base64Upload(uploadDir), handleBasketFileUpload);

// POST /api/baskets/:id/files/chunk — upload a large file in pieces.
// Cloudflare (and our own body limit) reject request bodies over ~100 MB, so
// the client sends base64 chunks of a few MB each. `meta` (base64url JSON)
// carries uploadId, index, total and the usual upload fields; the last chunk
// joins the pieces and goes through the normal upload handler.
const CHUNK_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
router.post('/:id/files/chunk', express.text({ type: 'text/plain', limit: '30mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    let fields: Record<string, any>;
    try {
      fields = JSON.parse(Buffer.from(String(req.query.meta || ''), 'base64url').toString('utf8'));
    } catch {
      res.status(400).json({ success: false, error: 'Invalid upload metadata' }); return;
    }
    const uploadId = String(fields.uploadId || '');
    const index = Number(fields.index);
    const total = Number(fields.total);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(uploadId) || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
      res.status(400).json({ success: false, error: 'Invalid chunk parameters' }); return;
    }
    if (typeof req.body !== 'string') {
      res.status(400).json({ success: false, error: 'Chunk body must be base64 text/plain' }); return;
    }

    const partPath = path.join(uploadDir, `chunk-${uploadId}.part`);
    if (index === 0) {
      // sweep abandoned partial uploads
      try {
        for (const f of fs.readdirSync(uploadDir)) {
          if (!f.startsWith('chunk-')) continue;
          const fp = path.join(uploadDir, f);
          if (Date.now() - fs.statSync(fp).mtimeMs > CHUNK_TMP_MAX_AGE_MS) fs.unlinkSync(fp);
        }
      } catch {}
      fs.writeFileSync(partPath, Buffer.alloc(0));
    }
    if (!fs.existsSync(partPath)) {
      res.status(400).json({ success: false, error: 'Upload not started or expired' }); return;
    }
    // chunks must arrive in order; the client sends them one at a time
    const expectedOffset = Number(fields.offset);
    if (Number.isFinite(expectedOffset) && fs.statSync(partPath).size !== expectedOffset) {
      res.status(409).json({ success: false, error: 'Chunk out of order' }); return;
    }
    fs.appendFileSync(partPath, Buffer.from(req.body.trim(), 'base64'));

    if (index < total - 1) {
      res.json({ success: true, data: { uploadId, received: index } }); return;
    }

    const originalname = path.basename(String(fields.fileName || 'upload'));
    const finalName = crypto.randomBytes(16).toString('hex');
    const finalPath = path.join(uploadDir, finalName);
    fs.renameSync(partPath, finalPath);
    (req as any).file = {
      fieldname: 'file',
      originalname,
      encoding: '7bit',
      mimetype: fields.fileType || 'application/octet-stream',
      destination: uploadDir,
      filename: finalName,
      path: finalPath,
      size: fs.statSync(finalPath).size,
    };
    for (const k of ['uploadId', 'index', 'total', 'offset', 'fileName', 'fileType']) delete fields[k];
    req.body = fields;
    next();
  } catch (error: any) {
    console.error('[basket chunk upload] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to store upload chunk' });
  }
}, handleBasketFileUpload);

// PUT /api/baskets/:id/files/:fileId - Update file status
router.put('/:id/files/:fileId', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'uploaded', 'published', 'processing', 'transferred', 'archived', 'failed'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const updateData: any = {};
    if (status) updateData.status = status;

    const updated = await prisma.basketFile.update({
      where: { id: fileId },
      data: updateData
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ success: false, error: 'Failed to update file' });
  }
});

// DELETE /api/baskets/:id/files/:fileId - Remove file from basket
router.delete('/:id/files/:fileId', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    // Log deletion before deleting
    await prisma.basketFileLog.create({
      data: {
        fileId: fileId,
        action: 'delete',
        status: 'success',
        message: `File deleted: ${file.originalName}`
      }
    });

    // Delete physical file
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    // Delete from database
    await prisma.basketFile.delete({ where: { id: fileId } });

    // keep the session's counters in step with its files
    if (file.sessionId) {
      await prisma.processingSession.updateMany({
        where: { id: file.sessionId },
        data: { fileCount: { decrement: 1 }, totalSize: { decrement: file.size || 0 } }
      }).catch(() => {});
    }

    res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

// POST /api/baskets/:id/process - Process files in basket (move to processed)
router.post('/:id/process', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { fileIds, flowId, executionId } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const files = await prisma.basketFile.findMany({
      where: { 
        basketId: id,
        id: { in: fileIds },
        status: { in: ['pending', 'processing'] }
      }
    });

    const results = [];
    for (const file of files) {
      try {
        const newPath = path.join(basket.path, 'processed', file.fileName);
        
        // Ensure processed directory exists
        if (!fs.existsSync(path.join(basket.path, 'processed'))) {
          fs.mkdirSync(path.join(basket.path, 'processed'), { recursive: true });
        }
        
        fs.renameSync(file.path, newPath);

        await prisma.basketFile.update({
          where: { id: file.id },
          data: { 
            status: 'processed',
            path: newPath,
            processedAt: new Date()
          }
        });

        // Log processing
        await prisma.basketFileLog.create({
          data: {
            fileId: file.id,
            flowId,
            executionId,
            action: 'process',
            status: 'success',
            message: `File processed by flow${flowId ? ` (Flow: ${flowId})` : ''}`,
            metadata: JSON.stringify({ newPath, processedAt: new Date() })
          }
        });

        results.push({ fileId: file.id, success: true });
      } catch (err) {
        // Log error
        await prisma.basketFileLog.create({
          data: {
            fileId: file.id,
            flowId,
            executionId,
            action: 'process',
            status: 'error',
            message: `Processing failed: ${(err as Error).message}`
          }
        });
        results.push({ fileId: file.id, success: false, error: (err as Error).message });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Error processing files:', error);
    res.status(500).json({ success: false, error: 'Failed to process files' });
  }
});

// PUT /api/baskets/:id - Update basket
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, sftpConnectionId, sftpMode, autoArchive, autoPublish, autoPublishConfig, sessionPattern, namingPattern, maxFiles, maxFileSize, allowedTypes, tags, displayOrder } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (sftpConnectionId !== undefined) updateData.sftpConnectionId = sftpConnectionId || null;
    if (sftpMode !== undefined) updateData.sftpMode = sftpMode;
    if (autoArchive !== undefined) updateData.autoArchive = autoArchive;
    if (autoPublish !== undefined) updateData.autoPublish = autoPublish;
    if (autoPublishConfig !== undefined) updateData.autoPublishConfig = autoPublishConfig;
    if (sessionPattern !== undefined) updateData.sessionPattern = sessionPattern;
    if (namingPattern !== undefined) updateData.namingPattern = namingPattern;
    if (maxFiles !== undefined) updateData.maxFiles = maxFiles;
    if (maxFileSize !== undefined) updateData.maxFileSize = maxFileSize;
    if (allowedTypes !== undefined) updateData.allowedTypes = allowedTypes;
    // Tag grouping (Baskets page): tags as JSON string, displayOrder for reorder
    if (tags !== undefined) updateData.tags = typeof tags === 'string' ? tags : JSON.stringify(tags);
    if (displayOrder !== undefined) updateData.displayOrder = Number(displayOrder);

    const updated = await prisma.basket.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { basketFiles: true } }
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating basket:', error);
    res.status(500).json({ success: false, error: 'Failed to update basket' });
  }
});

// DELETE /api/baskets/:id - Delete basket
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Delete physical directory
    if (fs.existsSync(basket.path)) {
      fs.rmSync(basket.path, { recursive: true, force: true });
    }

    // Delete from database (cascade will handle files)
    await prisma.basket.delete({ where: { id } });

    res.json({ success: true, message: 'Basket deleted' });
  } catch (error) {
    console.error('Error deleting basket:', error);
    res.status(500).json({ success: false, error: 'Failed to delete basket' });
  }
});

// GET /api/baskets/:id/files/:fileId/view - View file inline (for browser display)
router.get('/:id/files/:fileId/view', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    if (!fs.existsSync(file.path)) {
      res.status(404).json({ success: false, error: 'File not found on disk' });
      return;
    }

    // Log view action
    await prisma.basketFileLog.create({
      data: {
        fileId: file.id,
        action: 'view',
        status: 'success',
        message: 'File viewed via browser'
      }
    });

    // Set headers for inline display with UTF-8 charset for text files
    let contentType = file.mimeType;
    if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
      contentType += '; charset=utf-8';
    }
    const encodedName = encodeURIComponent(file.originalName);
    res.setHeader('Content-Disposition', `inline; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', contentType);

    // Stream file
    const fileStream = fs.createReadStream(file.path);
    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read file' });
      else res.destroy();
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error viewing file:', error);
    res.status(500).json({ success: false, error: 'Failed to view file' });
  }
});

// Cache for total line counts per fileId to avoid re-counting on paginated requests
const txtLineCountCache = new Map<string, number>();

// GET /api/baskets/:id/files/:fileId/txt-data - Read TXT with pagination for lazy loading
router.get('/:id/files/:fileId/txt-data', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 1000;
    const providedTotalLines = req.query.totalLines ? parseInt(req.query.totalLines as string) : undefined;

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    if (!fs.existsSync(file.path)) {
      res.status(404).json({ success: false, error: 'File not found on disk' });
      return;
    }

    // Check file extension
    const ext = path.extname(file.originalName).toLowerCase();
    const allowedExts = ['.txt', '.csv', '.tsv', '.log', '.dat', '.xml', '.json'];
    if (!allowedExts.includes(ext)) {
      res.status(400).json({ success: false, error: 'Not a supported text file. Allowed: ' + allowedExts.join(', ') });
      return;
    }

    // Detect encoding: check if file is valid UTF-8 or TIS-620/Windows-874
    let encoding: string = 'utf-8';
    const sampleBuffer = Buffer.alloc(4096);
    const fd = fs.openSync(file.path, 'r');
    const bytesRead = fs.readSync(fd, sampleBuffer, 0, 4096, 0);
    fs.closeSync(fd);
    if (bytesRead > 0) {
      let sample = sampleBuffer.subarray(0, bytesRead);
      // Trim to last complete UTF-8 char boundary to avoid false positives from truncated multi-byte chars
      let trimEnd = sample.length;
      for (let i = Math.max(0, trimEnd - 4); i < trimEnd; i++) {
        const b = sample[i];
        if ((b & 0x80) === 0) continue; // ASCII - safe boundary
        if ((b & 0xE0) === 0xC0 && trimEnd - i < 2) { trimEnd = i; break; } // 2-byte start, incomplete
        if ((b & 0xF0) === 0xE0 && trimEnd - i < 3) { trimEnd = i; break; } // 3-byte start, incomplete
        if ((b & 0xF8) === 0xF0 && trimEnd - i < 4) { trimEnd = i; break; } // 4-byte start, incomplete
      }
      sample = sample.subarray(0, trimEnd);

      let hasHighBytes = false;
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] > 0x7F) { hasHighBytes = true; break; }
      }

      if (hasHighBytes) {
        const decoded = sample.toString('utf-8');
        if (decoded.includes('\uFFFD')) {
          encoding = 'tis620';
        }
      }
    }

    // Determine total line count
    let totalLines: number;
    if (providedTotalLines !== undefined && providedTotalLines > 0) {
      totalLines = providedTotalLines;
    } else if (txtLineCountCache.has(fileId)) {
      totalLines = txtLineCountCache.get(fileId)!;
    } else {
      // Count lines by streaming through the file
      totalLines = await new Promise<number>((resolve, reject) => {
        let count = 0;
        let lastByte = -1;
        const countStream = fs.createReadStream(file.path, { highWaterMark: 64 * 1024 });
        countStream.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 0x0A) count++;
            lastByte = buf[i];
          }
        });
        countStream.on('end', () => {
          if (count === 0) {
            const stat = fs.statSync(file.path);
            resolve(stat.size > 0 ? 1 : 0);
          } else {
            // Only add 1 if file does NOT end with newline (last line has no \n)
            resolve(lastByte === 0x0A ? count : count + 1);
          }
        });
        countStream.on('error', reject);
      });
      txtLineCountCache.set(fileId, totalLines);
    }

    // Read lines with pagination using readline
    const readline = require('readline');
    const iconv = require('iconv-lite');

    const lines: string[] = [];
    let lineIndex = 0;
    const endLine = offset + limit;

    await new Promise<void>((resolve, reject) => {
      const rawStream = fs.createReadStream(file.path);
      rawStream.on('error', reject);
      let inputStream: NodeJS.ReadableStream = rawStream;

      // If non-UTF8 encoding, pipe through iconv decoder
      if (encoding !== 'utf-8') {
        const decoded = rawStream.pipe(iconv.decodeStream(encoding));
        decoded.on('error', reject);
        inputStream = decoded;
      }

      const rl = readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity
      });

      rl.on('line', (line: string) => {
        if (lineIndex >= offset && lineIndex < endLine) {
          lines.push(line);
        }
        lineIndex++;
        if (lineIndex >= endLine) {
          rl.close();
        }
      });

      rl.on('close', () => resolve());
      rl.on('error', reject);
    });

    res.json({
      success: true,
      data: {
        fileName: file.originalName,
        lines,
        offset,
        limit,
        totalLines,
        hasMore: offset + lines.length < totalLines,
        encoding
      }
    });
  } catch (error) {
    console.error('Error reading text file:', error);
    res.status(500).json({ success: false, error: 'Failed to read text file' });
  }
});

// In-memory cache for fully parsed XLSX files (keyed by fileId, TTL 10 min)
const xlsxCache = new Map<string, { sheets: any[]; fileName: string; parsedAt: number }>();
const XLSX_CACHE_TTL = 10 * 60 * 1000;

function cleanXlsxCache() {
  const now = Date.now();
  for (const [key, val] of xlsxCache.entries()) {
    if (now - val.parsedAt > XLSX_CACHE_TTL) xlsxCache.delete(key);
  }
}

function getCellValueStr(cell: any): string {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  const v = cell.value;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  if (typeof v === 'object' && v.richText) return v.richText.map((r: any) => r.text || '').join('');
  if (typeof v === 'object' && v.result !== undefined) return v.result == null ? '' : String(v.result);
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v);
}

// Parse XLSX using ExcelJS
async function parseXlsxFull(filePath: string): Promise<Array<{ name: string; headers: string[]; rows: string[][]; rowCount: number; colCount: number }>> {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets: Array<{ name: string; headers: string[]; rows: string[][]; rowCount: number; colCount: number }> = [];
  workbook.eachSheet((worksheet: any) => {
    const headers: string[] = [];
    const rows: string[][] = [];
    const colCount = worksheet.columnCount || 0;

    if (worksheet.rowCount > 0) {
      const headerRow = worksheet.getRow(1);
      for (let ci = 1; ci <= colCount; ci++) {
        headers.push(getCellValueStr(headerRow.getCell(ci)));
      }
    }

    for (let ri = 2; ri <= worksheet.rowCount; ri++) {
      const row = worksheet.getRow(ri);
      const cells: string[] = [];
      for (let ci = 1; ci <= colCount; ci++) {
        cells.push(getCellValueStr(row.getCell(ci)));
      }
      rows.push(cells);
    }

    sheets.push({ name: worksheet.name, headers, rows, rowCount: rows.length, colCount: headers.length });
  });

  return sheets;
}

// GET /api/baskets/:id/files/:fileId/xlsx-data - Read XLSX and return JSON for viewer
// Supports pagination: ?offset=0&limit=1000&sheet=0&sortCol=&sortDir=&filterCol=&filterValues=
router.get('/:id/files/:fileId/xlsx-data', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 0;
    const sheetIndex = parseInt(req.query.sheet as string ?? '');
    const sortCol = req.query.sortCol !== undefined ? parseInt(req.query.sortCol as string) : undefined;
    const sortDir = req.query.sortDir as string || '';
    const filterCol = req.query.filterCol !== undefined ? parseInt(req.query.filterCol as string) : undefined;
    const filterValues = req.query.filterValues as string || '';

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) { res.status(404).json({ success: false, error: 'File not found' }); return; }
    if (!fs.existsSync(file.path)) { res.status(404).json({ success: false, error: 'File not found on disk' }); return; }

    const ext = path.extname(file.originalName).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') { res.status(400).json({ success: false, error: 'Not an Excel file' }); return; }

    cleanXlsxCache();

    // Check file size — files > 25MB should be downloaded instead of viewed
    const MAX_XLSX_VIEW_SIZE = 25 * 1024 * 1024; // 25MB
    const fileSize = fs.statSync(file.path).size;
    if (fileSize > MAX_XLSX_VIEW_SIZE) {
      res.json({
        success: true,
        data: {
          tooLarge: true,
          fileName: file.originalName,
          fileSize,
        }
      });
      return;
    }

    // Parse and cache the workbook (cached for 10 min after first load)
    let cached = xlsxCache.get(fileId);
    if (!cached) {
      console.log(`[XLSX Viewer] Parsing ${file.originalName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);
      const startTime = Date.now();
      const sheets = await parseXlsxFull(file.path);
      console.log(`[XLSX Viewer] Parsed ${sheets.length} sheets, ${sheets.reduce((s: number, sh: any) => s + sh.rowCount, 0)} total rows in ${Date.now() - startTime}ms`);
      cached = { sheets, fileName: file.originalName, parsedAt: Date.now() };
      xlsxCache.set(fileId, cached);
    }

    // If no pagination params — backward compat (return all sheets with all rows)
    if (!limit && !isFinite(sheetIndex)) {
      res.json({
        success: true,
        data: {
          fileName: cached.fileName,
          sheets: cached.sheets,
          totalSheets: cached.sheets.length,
        }
      });
      return;
    }

    // Paginated response for a specific sheet
    const si = isFinite(sheetIndex) ? sheetIndex : 0;
    const sheet = cached.sheets[si];
    if (!sheet) {
      res.status(400).json({ success: false, error: 'Sheet index out of range' });
      return;
    }

    let rows = sheet.rows;

    // Apply server-side filter
    if (filterCol !== undefined && filterValues) {
      const allowed = new Set(filterValues.split('\x1f'));
      rows = rows.filter((row: string[]) => allowed.has(row[filterCol] || ''));
    }

    // Apply server-side sort
    if (sortCol !== undefined && (sortDir === 'asc' || sortDir === 'desc')) {
      rows = [...rows].sort((a: string[], b: string[]) => {
        const va = a[sortCol] || '';
        const vb = b[sortCol] || '';
        const na = Number(va);
        const nb = Number(vb);
        if (!isNaN(na) && !isNaN(nb) && va !== '' && vb !== '') return sortDir === 'asc' ? na - nb : nb - na;
        const cmp = va.localeCompare(vb, 'th');
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    const totalFiltered = rows.length;
    const pageSize = limit || totalFiltered;
    const pageRows = rows.slice(offset, offset + pageSize);

    res.json({
      success: true,
      data: {
        fileName: cached.fileName,
        sheet: {
          name: sheet.name,
          headers: sheet.headers,
          rows: pageRows,
          rowCount: sheet.rowCount,
          filteredCount: totalFiltered,
          colCount: sheet.colCount,
          offset,
          limit: pageSize,
          hasMore: offset + pageSize < totalFiltered,
        },
        sheetNames: cached.sheets.map((s: any) => ({ name: s.name, rowCount: s.rowCount, colCount: s.colCount })),
        totalSheets: cached.sheets.length,
      }
    });
  } catch (error) {
    console.error('Error reading XLSX file:', error);
    res.status(500).json({ success: false, error: 'Failed to read Excel file' });
  }
});

// DELETE /api/baskets/:id/files/:fileId - Delete a file
router.delete('/:id/files/:fileId', async (req: Request, res: Response) => {
  try {
    const { id, fileId } = req.params;

    // Permission check for shared baskets
    const projectId = req.query.projectId as string;
    if (projectId && !(await checkBasketWritePermission(id, projectId))) {
      res.status(403).json({ success: false, error: 'Read-only access: cannot delete files from this shared basket' }); return;
    }

    const file = await prisma.basketFile.findFirst({
      where: { id: fileId, basketId: id }
    });

    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    // Delete physical file
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    // Delete from database
    await prisma.basketFile.delete({
      where: { id: fileId }
    });

    // Update session file count if file belongs to a session
    if (file.sessionId) {
      await prisma.processingSession.update({
        where: { id: file.sessionId },
        data: {
          fileCount: { decrement: 1 },
          totalSize: { decrement: file.size }
        }
      });
    }

    // Log deletion
    await prisma.basketLog.create({
      data: {
        basketId: id,
        type: 'file_deleted',
        message: `File deleted: ${file.originalName}`,
        fileCount: 1,
        fileSize: file.size,
        metadata: JSON.stringify({ fileId, originalName: file.originalName })
      }
    });

    res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

// ==================== Folder Routes for Shares Baskets ====================

// GET /api/baskets/:id/folders - Get folders in a basket
router.get('/:id/folders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { parentId, all } = req.query;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    // Only allow folders for shares baskets
    if (basket.type !== 'shares') {
      res.status(400).json({ success: false, error: 'Folders are only available for Shares Baskets' });
      return;
    }

    // Build where clause
    const where: any = { basketId: id };
    
    // If 'all' param is set, get all folders for tree view
    // Otherwise filter by parentId (null = root folders)
    if (all !== 'true') {
      where.parentId = parentId as string || null;
    }
    const feRoles = (await isFileExplorerBasket(id)) ? await feFolderRoles(req, id) : null;
    if (feRoles) where.id = { in: [...feRoles.keys()] };

    const folders = await prisma.basketFolder.findMany({
      where,
      include: {
        _count: {
          select: { files: true, children: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    res.json({ success: true, data: folders });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch folders' });
  }
});

// POST /api/baskets/:id/folders - Create a folder
router.post('/:id/folders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, parentId } = req.body;

    // Permission check for shared baskets
    const projectId = req.query.projectId as string;
    if (projectId && !(await checkBasketWritePermission(id, projectId))) {
      res.status(403).json({ success: false, error: 'Read-only access: cannot create folders in this shared basket' }); return;
    }

    if (!name) {
      res.status(400).json({ success: false, error: 'Folder name is required' });
      return;
    }
    if ((await isFileExplorerBasket(id)) && !(await allowFeFolder(req, res, id, parentId || null, 'editor'))) return;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    if (basket.type !== 'shares') {
      res.status(400).json({ success: false, error: 'Folders are only available for Shares Baskets' });
      return;
    }

    // Generate folder path
    let folderPath = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    if (parentId) {
      const parent = await prisma.basketFolder.findUnique({ where: { id: parentId } });
      if (parent) {
        folderPath = path.join(parent.path, folderPath);
      }
    }

    // Create physical directory
    const fullPath = path.join(basket.path, 'folders', folderPath);
    fs.mkdirSync(fullPath, { recursive: true });

    const folder = await prisma.basketFolder.create({
      data: {
        basketId: id,
        name,
        path: folderPath,
        parentId: parentId || null
      }
    });

    res.json({ success: true, data: folder });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ success: false, error: 'Failed to create folder' });
  }
});

// DELETE /api/baskets/:id/folders/:folderId - Delete a folder
router.delete('/:id/folders/:folderId', async (req: Request, res: Response) => {
  try {
    const { id, folderId } = req.params;

    // Permission check for shared baskets
    const projectId = req.query.projectId as string;
    if (projectId && !(await checkBasketWritePermission(id, projectId))) {
      res.status(403).json({ success: false, error: 'Read-only access: cannot delete folders from this shared basket' }); return;
    }

    const folder = await prisma.basketFolder.findFirst({
      where: { id: folderId, basketId: id }
    });

    if (!folder) {
      res.status(404).json({ success: false, error: 'Folder not found' });
      return;
    }

    // Check if folder has files
    const fileCount = await prisma.basketFile.count({
      where: { folderId }
    });

    if (fileCount > 0) {
      res.status(400).json({ success: false, error: 'Cannot delete folder with files. Please move or delete files first.' });
      return;
    }

    // Check if folder has subfolders
    const subfolderCount = await prisma.basketFolder.count({
      where: { parentId: folderId }
    });

    if (subfolderCount > 0) {
      res.status(400).json({ success: false, error: 'Cannot delete folder with subfolders. Please delete subfolders first.' });
      return;
    }

    // Delete physical directory
    const basket = await prisma.basket.findUnique({ where: { id } });
    if (basket) {
      const fullPath = path.join(basket.path, 'folders', folder.path);
      if (fs.existsSync(fullPath)) {
        fs.rmdirSync(fullPath);
      }
    }

    await prisma.basketFolder.delete({ where: { id: folderId } });

    res.json({ success: true, message: 'Folder deleted' });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ success: false, error: 'Failed to delete folder' });
  }
});

// ==================== Share Routes for Shares Baskets ====================

// GET /api/baskets/:id/shares - Get projects this basket is shared with
router.get('/:id/shares', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    if (basket.type !== 'shares') {
      res.status(400).json({ success: false, error: 'Sharing is only available for Shares Baskets' });
      return;
    }

    const shares = await prisma.basketShare.findMany({
      where: { basketId: id },
      include: {
        project: {
          select: { id: true, name: true, color: true }
        }
      }
    });

    res.json({ success: true, data: shares });
  } catch (error) {
    console.error('Error fetching shares:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch shares' });
  }
});

// POST /api/baskets/:id/shares - Share basket with a project
router.post('/:id/shares', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { projectId, permission = 'read', createdBy } = req.body;

    if (!projectId) {
      res.status(400).json({ success: false, error: 'Project ID is required' });
      return;
    }

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    if (basket.type !== 'shares') {
      res.status(400).json({ success: false, error: 'Sharing is only available for Shares Baskets' });
      return;
    }

    // Cannot share with the same project
    if (basket.projectId === projectId) {
      res.status(400).json({ success: false, error: 'Cannot share basket with its own project' });
      return;
    }

    const share = await prisma.basketShare.create({
      data: {
        basketId: id,
        projectId,
        permission,
        createdBy: createdBy || 'system'
      }
    });

    res.json({ success: true, data: share });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(400).json({ success: false, error: 'Basket is already shared with this project' });
      return;
    }
    console.error('Error creating share:', error);
    res.status(500).json({ success: false, error: 'Failed to create share' });
  }
});

// DELETE /api/baskets/:id/shares/:shareId - Remove share
router.delete('/:id/shares/:shareId', async (req: Request, res: Response) => {
  try {
    const { id, shareId } = req.params;

    const share = await prisma.basketShare.findFirst({
      where: { id: shareId, basketId: id }
    });

    if (!share) {
      res.status(404).json({ success: false, error: 'Share not found' });
      return;
    }

    await prisma.basketShare.delete({ where: { id: shareId } });

    res.json({ success: true, message: 'Share removed' });
  } catch (error) {
    console.error('Error deleting share:', error);
    res.status(500).json({ success: false, error: 'Failed to delete share' });
  }
});

// GET /api/baskets/shared/:projectId - Get baskets shared with a project
router.get('/shared/:projectId', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    const shares = await prisma.basketShare.findMany({
      where: { projectId },
      include: {
        basket: {
          include: {
            project: {
              select: { id: true, name: true, color: true }
            },
            _count: {
              select: { basketFiles: true }
            }
          }
        }
      }
    });

    res.json({ 
      success: true, 
      data: shares.map(s => ({
        ...s,
        basket: {
          ...s.basket,
          fileCount: s.basket._count.basketFiles
        }
      }))
    });
  } catch (error) {
    console.error('Error fetching shared baskets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch shared baskets' });
  }
});

// POST /api/baskets/position - Update basket positions
router.post('/position', adminOnly, async (req: Request, res: Response) => {
  try {
    const { positions } = req.body;

    if (!Array.isArray(positions) || positions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Positions array is required',
      });
    }

    // Update positions in transaction
    await prisma.$transaction(
      positions.map((item: { basketId: string; position: number }) =>
        prisma.basket.update({
          where: { id: item.basketId },
          data: { displayOrder: item.position },
        })
      )
    );

    return res.json({
      success: true,
      message: 'Basket positions updated successfully',
    });
  } catch (error) {
    console.error('Error updating basket positions:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update basket positions',
    });
  }
});

// ==================== SFTP Browse Routes ====================

// Helper: Connect to SFTP server via basket's sftpConnectionId
async function getSftpConnection(basketId: string): Promise<{ sftp: SFTPWrapper; conn: Client; basePath: string }> {
  const basket = await prisma.basket.findUnique({ where: { id: basketId } });
  if (!basket) throw new Error('Basket not found');
  if (basket.type !== 'sftp') throw new Error('Basket is not SFTP type');
  if (!basket.sftpConnectionId) throw new Error('No SFTP connection configured for this basket');

  const connection = await prisma.connection.findUnique({
    where: { id: basket.sftpConnectionId }
  });
  if (!connection) throw new Error(`Connection not found: ${basket.sftpConnectionId}`);

  const config = typeof connection.config === 'string'
    ? JSON.parse(connection.config)
    : connection.config;

  const basePath = config.basePath || config.remotePath || '/';

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        resolve({ sftp, conn, basePath });
      });
    });

    conn.on('error', (err) => reject(err));

    conn.connect({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      readyTimeout: 20000,
    });
  });
}

// Path traversal protection — join basePath + relative requestedPath
function safePath(basePath: string, requestedPath: string): string {
  // Normalize: strip leading slash from requested path to treat it as relative
  const relative = requestedPath.replace(/^\/+/, '') || '.';
  const resolved = path.posix.resolve(basePath, relative);
  // Ensure resolved stays within basePath
  const normalizedBase = path.posix.resolve(basePath);
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

// GET /api/baskets/:id/sftp/ls — List directory entries
router.get('/:id/sftp/ls', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const reqPath = (req.query.path as string) || '/';

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const fullPath = safePath(basePath, reqPath);

    sftp.readdir(fullPath, (err, list) => {
      conn!.end();
      if (err) {
        console.error('[SFTP ls] Error reading directory:', err.message);
        res.status(500).json({ success: false, error: `Cannot read directory: ${err.message}` });
        return;
      }

      const entries = list
        .filter(item => !item.filename.startsWith('.'))
        .map(item => ({
          name: item.filename,
          type: item.attrs.isDirectory() ? 'directory' : 'file',
          size: item.attrs.size,
          modifiedAt: new Date((item.attrs.mtime || 0) * 1000).toISOString(),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({
        success: true,
        data: { path: reqPath, entries }
      });
    });
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP ls] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/baskets/:id/sftp/download — Download a file
router.get('/:id/sftp/download', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const reqPath = req.query.path as string;
    if (!reqPath) {
      res.status(400).json({ success: false, error: 'path query parameter is required' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const fullPath = safePath(basePath, reqPath);
    const fileName = path.posix.basename(fullPath);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const readStream = sftp.createReadStream(fullPath);
    readStream.on('error', (err: Error) => {
      conn!.end();
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: `Download failed: ${err.message}` });
      }
    });
    readStream.on('end', () => conn!.end());
    readStream.pipe(res);
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP download] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/baskets/:id/sftp/view — View file inline
router.get('/:id/sftp/view', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const reqPath = req.query.path as string;
    if (!reqPath) {
      res.status(400).json({ success: false, error: 'path query parameter is required' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const fullPath = safePath(basePath, reqPath);
    const fileName = path.posix.basename(fullPath);
    const ext = path.posix.extname(fileName).toLowerCase();

    // Determine MIME type
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
      '.json': 'application/json', '.xml': 'application/xml',
      '.html': 'text/html', '.htm': 'text/html',
      '.pdf': 'application/pdf',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
      '.js': 'text/javascript', '.css': 'text/css',
      '.log': 'text/plain', '.md': 'text/markdown',
    };
    let contentType = mimeMap[ext] || 'application/octet-stream';
    if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
      contentType += '; charset=utf-8';
    }

    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', contentType);

    const readStream = sftp.createReadStream(fullPath);
    readStream.on('error', (err: Error) => {
      conn!.end();
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: `View failed: ${err.message}` });
      }
    });
    readStream.on('end', () => conn!.end());
    readStream.pipe(res);
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP view] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/baskets/:id/sftp/upload — Upload file via multipart (streams to SFTP, no memory buffering)
// WAF-safe: avoid "upload" keyword in URL (Cloudflare blocks it from browser)
router.post('/:id/sftp/send', upload.single('file'), async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const targetPath = req.body.path || '/';

    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const dirPath = safePath(basePath, targetPath);
    const fileName = req.body.filename || req.file.originalname;
    const fullPath = path.posix.join(dirPath, fileName);

    const writeStream = sftp.createWriteStream(fullPath);
    const readStream = fs.createReadStream(req.file.path);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve());
      writeStream.on('error', (err: Error) => reject(err));
      readStream.on('error', (err: Error) => reject(err));
      readStream.pipe(writeStream);
    });

    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch {}

    conn.end();
    res.json({
      success: true,
      data: { path: path.posix.join(targetPath, fileName), size: req.file.size }
    });
  } catch (error: any) {
    // Clean up temp file on error
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    conn?.end();
    console.error('[SFTP upload] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});


// POST /api/baskets/:id/sftp/upload-chunked — Upload large file via streaming (no memory limit)
router.post('/:id/sftp/upload-chunked', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const targetPath = (req.query.path as string) || '/';
    // Read filename from X-Filename header first (avoids WAF blocking Thai chars in URL)
    const rawFileName = (req.headers['x-filename'] as string) || (req.query.filename as string);
    const fileName = rawFileName ? decodeURIComponent(rawFileName) : '';

    if (!fileName) {
      res.status(400).json({ success: false, error: 'filename required (X-Filename header or query param)' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const dirPath = safePath(basePath, targetPath);
    const fullPath = path.posix.join(dirPath, fileName);

    const writeStream = sftp.createWriteStream(fullPath);
    let totalSize = 0;

    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve());
      writeStream.on('error', (err: Error) => reject(err));
      req.on('data', (chunk: Buffer) => { totalSize += chunk.length; });
      req.on('error', (err: Error) => reject(err));
      req.pipe(writeStream);
    });

    conn.end();
    res.json({
      success: true,
      data: { path: path.posix.join(targetPath, fileName), size: totalSize }
    });
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP upload-chunked] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/baskets/:id/sftp/upload-b64 — Upload file via base64 JSON (WAF-safe, no multipart)
router.post('/:id/sftp/upload-b64', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const { filename, path: targetPath, data } = req.body;

    if (!filename || !data) {
      res.status(400).json({ success: false, error: 'filename and data (base64) are required' });
      return;
    }

    const fileBuffer = Buffer.from(data, 'base64');

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const dirPath = safePath(basePath, targetPath || '/');
    const fullPath = path.posix.join(dirPath, filename);

    const writeStream = sftp.createWriteStream(fullPath);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve());
      writeStream.on('error', (err: Error) => reject(err));
      writeStream.end(fileBuffer);
    });

    conn.end();
    res.json({
      success: true,
      data: { path: path.posix.join(targetPath || '/', filename), size: fileBuffer.length }
    });
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP upload-b64] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/baskets/:id/sftp/mkdir — Create directory
router.post('/:id/sftp/mkdir', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const { path: dirPath, name } = req.body;
    if (!name) {
      res.status(400).json({ success: false, error: 'Directory name is required' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const parentPath = safePath(basePath, dirPath || '/');
    const fullPath = path.posix.join(parentPath, name);

    sftp.mkdir(fullPath, (err: any) => {
      conn!.end();
      if (err) {
        res.status(500).json({ success: false, error: `Cannot create directory: ${err.message}` });
        return;
      }
      res.json({
        success: true,
        data: { path: path.posix.join(dirPath || '/', name) }
      });
    });
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP mkdir] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/baskets/:id/sftp/rm — Delete file or directory
router.delete('/:id/sftp/rm', async (req: Request, res: Response) => {
  let conn: Client | null = null;
  try {
    const { id } = req.params;
    const reqPath = req.query.path as string;
    const type = req.query.type as string; // 'file' or 'directory'
    if (!reqPath) {
      res.status(400).json({ success: false, error: 'path query parameter is required' });
      return;
    }

    const sftpConn = await getSftpConnection(id);
    conn = sftpConn.conn;
    const { sftp, basePath } = sftpConn;
    const fullPath = safePath(basePath, reqPath);

    const doDelete = (cb: (err: any) => void) => {
      if (type === 'directory') {
        sftp.rmdir(fullPath, cb);
      } else {
        sftp.unlink(fullPath, cb);
      }
    };

    doDelete((err: any) => {
      conn!.end();
      if (err) {
        res.status(500).json({ success: false, error: `Delete failed: ${err.message}` });
        return;
      }
      res.json({ success: true, message: `${type || 'file'} deleted` });
    });
  } catch (error: any) {
    conn?.end();
    console.error('[SFTP rm] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
