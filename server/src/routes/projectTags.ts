import { Router, Request, Response } from 'express';
import { guardProject } from '../lib/access';
import { prisma } from '../lib/prisma';

const router = Router();

// Tags belong to a project: read with viewer, change with editor
router.param('projectId', guardProject(async (pid) => pid));
router.param('id', guardProject(async (id) => {
  const t = await prisma.projectTag.findUnique({ where: { id }, select: { projectId: true } });
  return t?.projectId || null;
}));

// GET /int/projects/:projectId/tags
// List declared tag groups for a project (newest-sort first by sortOrder, then name).
router.get('/projects/:projectId/tags', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { projectId } = req.params;
    const tags = await prisma.projectTag.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return res.json({ success: true, data: tags });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || 'Failed to list project tags' });
  }
});

// POST /int/projects/:projectId/tags
// Body: { name: string, color?: string, sortOrder?: number }
// Creates a tag definition under the given project.
// If (projectId, name) already exists, returns the existing row (idempotent for UX).
router.post('/projects/:projectId/tags', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { projectId } = req.params;
    const { name, color, sortOrder } = req.body || {};
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    // Ensure the project exists (so we don't insert orphaned rows)
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    // Idempotent upsert
    const tag = await prisma.projectTag.upsert({
      where: { projectId_name: { projectId, name: trimmed } },
      create: {
        projectId,
        name: trimmed,
        color: color || null,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      },
      update: {
        ...(color !== undefined ? { color } : {}),
        ...(typeof sortOrder === 'number' ? { sortOrder } : {}),
      },
    });
    return res.json({ success: true, data: tag });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || 'Failed to create project tag' });
  }
});

// PUT /int/project-tags/:id
// Update an existing project tag (rename, recolor, reorder).
router.put('/project-tags/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    const { name, color, sortOrder } = req.body || {};
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (color !== undefined) data.color = color;
    if (typeof sortOrder === 'number') data.sortOrder = sortOrder;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields provided' });
    }
    const tag = await prisma.projectTag.update({ where: { id }, data });
    return res.json({ success: true, data: tag });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Project tag not found' });
    }
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A tag with that name already exists in this project' });
    }
    return res.status(500).json({ success: false, error: error?.message || 'Failed to update project tag' });
  }
});

// DELETE /int/project-tags/:id
// Removes a tag definition. Does NOT untag entities — they keep their tag
// strings on their JSON tags column. The deleted tag will simply stop
// appearing as an empty droppable group; if an entity still has it the
// group will re-materialize from the entity data on next render.
router.delete('/project-tags/:id', async (req: Request, res: Response): Promise<Response> => {
  try {
    const { id } = req.params;
    await prisma.projectTag.delete({ where: { id } });
    return res.json({ success: true });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Project tag not found' });
    }
    return res.status(500).json({ success: false, error: error?.message || 'Failed to delete project tag' });
  }
});

export default router;
