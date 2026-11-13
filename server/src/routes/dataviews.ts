// Data Views — CRUD routes for saving Workbench view configs (fields, filters, pivot)
import { Router, Request, Response } from 'express';
import { adminOnly } from '../lib/access';
import { prisma } from '../lib/prisma';
import { authMiddleware } from './auth';

const router = Router();
router.use(authMiddleware);

// Saved views over global data sources — admin only
router.use(adminOnly);

// ─── Folders ──────────────────────────────────────────────────────────────────

// GET /folders — list all folders (tree)
router.get('/folders', async (_req: Request, res: Response) => {
  try {
    const folders = await prisma.dataViewFolder.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        children: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        _count: { select: { views: true } },
      },
      where: { parentId: null },
    });
    res.json({ success: true, data: folders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /folders — create folder
router.post('/folders', async (req: Request, res: Response) => {
  const { name, parentId } = req.body as { name: string; parentId?: string };
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'name required' }); return; }
  try {
    const folder = await prisma.dataViewFolder.create({
      data: { name: name.trim(), parentId: parentId || null },
    });
    res.json({ success: true, data: folder });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /folders/:id — rename folder
router.put('/folders/:id', async (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  try {
    const folder = await prisma.dataViewFolder.update({
      where: { id: req.params.id },
      data: { name: name.trim() },
    });
    res.json({ success: true, data: folder });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /folders/:id — delete folder (cascade deletes views inside)
router.delete('/folders/:id', async (req: Request, res: Response) => {
  try {
    await prisma.dataViewFolder.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Views ────────────────────────────────────────────────────────────────────

// GET / — list all views (with optional folderId filter)
router.get('/', async (req: Request, res: Response) => {
  const { folderId, datasetId } = req.query as Record<string, string>;
  try {
    const views = await prisma.dataView.findMany({
      where: {
        ...(folderId !== undefined ? { folderId: folderId || null } : {}),
        ...(datasetId ? { datasetId } : {}),
      },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: { folder: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: views });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /:id — get single view
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const view = await prisma.dataView.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { id: true, name: true } } },
    });
    if (!view) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    res.json({ success: true, data: view });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST / — create view
router.post('/', async (req: Request, res: Response) => {
  const { name, description, folderId, datasetId, wbFolderId, viewType, fields, filters, pivot, sortBy } = req.body as {
    name: string;
    description?: string;
    folderId?: string;
    datasetId: string;
    wbFolderId?: string;
    viewType?: string;
    fields?: unknown[];
    filters?: unknown[];
    pivot?: Record<string, unknown>;
    sortBy?: unknown[];
  };

  if (!name?.trim()) { res.status(400).json({ success: false, error: 'name required' }); return; }
  if (!datasetId) { res.status(400).json({ success: false, error: 'datasetId required' }); return; }

  try {
    const view = await prisma.dataView.create({
      data: {
        name: name.trim(),
        description: description?.trim(),
        folderId: folderId || null,
        datasetId,
        wbFolderId: wbFolderId || null,
        viewType: viewType || 'flat',
        fields: JSON.stringify(fields || []),
        filters: JSON.stringify(filters || []),
        pivot: JSON.stringify(pivot || {}),
        sortBy: JSON.stringify(sortBy || []),
      },
      include: { folder: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: view });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /:id — update view
router.put('/:id', async (req: Request, res: Response) => {
  const { name, description, folderId, wbFolderId, viewType, fields, filters, pivot, sortBy } = req.body as {
    name?: string;
    description?: string;
    folderId?: string | null;
    wbFolderId?: string | null;
    viewType?: string;
    fields?: unknown[];
    filters?: unknown[];
    pivot?: Record<string, unknown>;
    sortBy?: unknown[];
  };

  try {
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (description !== undefined) data.description = description?.trim() || null;
    if ('folderId' in req.body) data.folderId = folderId || null;
    if ('wbFolderId' in req.body) data.wbFolderId = wbFolderId || null;
    if (viewType !== undefined) data.viewType = viewType;
    if (fields !== undefined) data.fields = JSON.stringify(fields);
    if (filters !== undefined) data.filters = JSON.stringify(filters);
    if (pivot !== undefined) data.pivot = JSON.stringify(pivot);
    if (sortBy !== undefined) data.sortBy = JSON.stringify(sortBy);

    const view = await prisma.dataView.update({
      where: { id: req.params.id },
      data,
      include: { folder: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: view });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /:id — delete view
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.dataView.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
