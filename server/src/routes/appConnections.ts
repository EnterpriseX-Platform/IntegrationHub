import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// ============================================
// App-Level Connections API
// ============================================

// GET /api/app-connections - List all app-level connections
router.get('/', async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.connection.findMany({
      where: { projectId: null },
      orderBy: { name: 'asc' }
    });
    
    res.json({ success: true, data: connections });
  } catch (error) {
    console.error('Error fetching app connections:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch connections' });
  }
});

// GET /api/app-connections/:id - Get single connection
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const connection = await prisma.connection.findFirst({
      where: { id, projectId: null }
    });
    
    if (!connection) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }
    
    res.json({ success: true, data: connection });
  } catch (error) {
    console.error('Error fetching connection:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch connection' });
  }
});

// POST /api/app-connections - Create app-level connection
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, type, config } = req.body;
    
    if (!name || !type) {
      res.status(400).json({ success: false, error: 'Name and type are required' });
      return;
    }
    
    const connection = await prisma.connection.create({
      data: {
        name,
        type,
        config: JSON.stringify(config || {}),
        projectId: null,
        isShared: true
      }
    });
    
    res.json({ success: true, data: connection });
  } catch (error) {
    console.error('Error creating connection:', error);
    res.status(500).json({ success: false, error: 'Failed to create connection' });
  }
});

// PUT /api/app-connections/:id - Update connection
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, config, status, sharedWith } = req.body;
    
    const existing = await prisma.connection.findFirst({
      where: { id, projectId: null }
    });
    
    if (!existing) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }
    
    const updateData: any = {};
    if (name) updateData.name = name;
    if (config) updateData.config = JSON.stringify(config);
    if (status) updateData.status = status;
    if (sharedWith) updateData.sharedWith = sharedWith;
    
    const connection = await prisma.connection.update({
      where: { id },
      data: updateData
    });
    
    res.json({ success: true, data: connection });
  } catch (error) {
    console.error('Error updating connection:', error);
    res.status(500).json({ success: false, error: 'Failed to update connection' });
  }
});

// DELETE /api/app-connections/:id - Delete connection
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const existing = await prisma.connection.findFirst({
      where: { id, projectId: null }
    });
    
    if (!existing) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }
    
    await prisma.connection.delete({ where: { id } });
    
    res.json({ success: true, message: 'Connection deleted successfully' });
  } catch (error) {
    console.error('Error deleting connection:', error);
    res.status(500).json({ success: false, error: 'Failed to delete connection' });
  }
});

// POST /api/app-connections/:id/test - Test connection
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const connection = await prisma.connection.findFirst({
      where: { id, projectId: null }
    });
    
    if (!connection) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }
    
    res.json({
      success: true,
      data: { status: 'connected', message: 'Connection test successful' }
    });
  } catch (error) {
    console.error('Error testing connection:', error);
    res.status(500).json({ success: false, error: 'Failed to test connection' });
  }
});

// ============================================
// Simple Tags API (without many-to-many)
// ============================================

// GET /api/app-connections/tags - List all tags (mock)
router.get('/tags/list', async (_req: Request, res: Response) => {
  try {
    // Return mock tags for now
    res.json({
      success: true,
      data: [
        { id: '1', name: 'Production', color: '#10B981' },
        { id: '2', name: 'Development', color: '#3B82F6' },
        { id: '3', name: 'SFTP', color: '#F59E0B' },
        { id: '4', name: 'Database', color: '#8B5CF6' }
      ]
    });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tags' });
  }
});

export default router;
