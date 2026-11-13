import { Router, Request, Response } from 'express';
import { guardProject, projectScope } from '../lib/access';
import { prisma } from '../lib/prisma';

const router = Router();

// Non-admins only see API specs of their projects
router.param('id', guardProject(async (id) => {
  const a = await prisma.apiSpec.findUnique({ where: { id }, select: { projectId: true } });
  return a?.projectId || null;
}));

// GET /api/api-specs - List all API specs
router.get('/', async (req: Request, res: Response) => {
  try {
    const apiSpecs = await prisma.apiSpec.findMany({
      where: await projectScope(req),
      orderBy: { createdAt: 'desc' },
      include: {
        project: {
          select: { id: true, name: true },
        },
      },
    });

    return res.json({
      success: true,
      data: apiSpecs,
    });
  } catch (error) {
    console.error('Error fetching API specs:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch API specs',
    });
  }
});

// GET /api/api-specs/:id - Get single API spec
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const apiSpec = await prisma.apiSpec.findUnique({
      where: { id },
      include: {
        project: {
          select: { id: true, name: true },
        },
      },
    });

    if (!apiSpec) {
      return res.status(404).json({
        success: false,
        error: 'API spec not found',
      });
    }

    return res.json({
      success: true,
      data: apiSpec,
    });
  } catch (error) {
    console.error('Error fetching API spec:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch API spec',
    });
  }
});

// POST /api/api-specs - Create new API spec
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, path, method, description, projectId } = req.body;

    if (!name || !path || !method || !projectId) {
      return res.status(400).json({
        success: false,
        error: 'Name, path, method, and projectId are required',
      });
    }

    const apiSpec = await prisma.apiSpec.create({
      data: {
        name: name.trim(),
        basePath: path.trim(),
        description: description?.trim() || null,
        projectId,
        operations: JSON.stringify([{ method: method.toUpperCase(), path: path.trim() }]),
        components: '{}',
      },
    });

    return res.status(201).json({
      success: true,
      data: apiSpec,
      message: 'API spec created successfully',
    });
  } catch (error) {
    console.error('Error creating API spec:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create API spec',
    });
  }
});

// PUT /api/api-specs/:id - Update API spec
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, path, method, description, parameters, responses } = req.body;

    const existing = await prisma.apiSpec.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'API spec not found',
      });
    }

    const updated = await prisma.apiSpec.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(path && { basePath: path.trim() }),
        ...(method && { method: method.toUpperCase() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(parameters && { parameters: typeof parameters === 'string' ? parameters : JSON.stringify(parameters) }),
        ...(responses && { responses: typeof responses === 'string' ? responses : JSON.stringify(responses) }),
      },
    });

    return res.json({
      success: true,
      data: updated,
      message: 'API spec updated successfully',
    });
  } catch (error) {
    console.error('Error updating API spec:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update API spec',
    });
  }
});

// DELETE /api/api-specs/:id - Delete API spec
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.apiSpec.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'API spec not found',
      });
    }

    await prisma.apiSpec.delete({ where: { id } });

    return res.json({
      success: true,
      message: 'API spec deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting API spec:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete API spec',
    });
  }
});

export default router;
