// Share links: /share/<id> → a File Explorer folder or file. Login is still required to open one.

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { getOrCreateFileExplorerBasket } from '../lib/fileExplorerBasket';
import { allowFeFolder } from '../lib/access';

const router = Router();

/** Find the live link for a folder/file, or create one. */
export async function getOrCreateShareLink(target: { folderId?: string | null; fileId?: string | null }, createdBy?: string) {
  const basket = await getOrCreateFileExplorerBasket();
  const where = { basketId: basket.id, folderId: target.folderId ?? null, fileId: target.fileId ?? null, revokedAt: null };
  return (await prisma.shareLink.findFirst({ where })) ?? prisma.shareLink.create({ data: { ...where, createdBy } });
}

// POST /share-links { folderId?, fileId? } → { id }
router.post('/', async (req: Request, res: Response) => {
  try {
    const { folderId, fileId } = req.body || {};
    // Only share what you can see: a folder you have, or a file inside one
    const fe = await getOrCreateFileExplorerBasket();
    const target = fileId ? (await prisma.basketFile.findUnique({ where: { id: fileId }, select: { folderId: true } }))?.folderId ?? null : folderId ?? null;
    if (!(await allowFeFolder(req, res, fe.id, target, 'viewer'))) return;
    const link = await getOrCreateShareLink({ folderId, fileId }, (req as any).userId);
    res.json({ success: true, data: { id: link.id } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /share-links/:id → { folderId, fileId }
router.get('/:id', async (req: Request, res: Response) => {
  const link = await prisma.shareLink.findUnique({ where: { id: req.params.id } });
  if (!link || link.revokedAt) {
    res.status(404).json({ success: false, error: 'Link not found or revoked' });
    return;
  }
  res.json({ success: true, data: { folderId: link.folderId, fileId: link.fileId } });
});

export default router;
