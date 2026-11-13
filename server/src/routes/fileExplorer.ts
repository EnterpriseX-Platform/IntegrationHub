// File Explorer route — global personal file workspace
//
// Single global "shares" basket where users can copy files from any source basket,
// organize into folders (e.g. by year), and view them with existing viewers.
// Basket ID is persisted in `system_configs` so the same basket is reused across restarts.

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { projectScope, basketProjects, bestProjectRole, roleAllows, allowFeFolder } from '../lib/access';

const router = Router();
// Re-exported for existing importers; the basket lookup lives in lib so flow executors can share it.
export { getOrCreateFileExplorerBasket } from '../lib/fileExplorerBasket';
import { getOrCreateFileExplorerBasket, readLinks, writeLinks, BasketLink } from '../lib/fileExplorerBasket';

/** GET /file-explorer — returns the basket (auto-creates the first time it's called). */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const basket = await getOrCreateFileExplorerBasket();
    res.json({ success: true, data: basket });
  } catch (err: any) {
    console.error('[FileExplorer] init failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /file-explorer/copy
 * Body: { sourceBasketId, sourceFileId, targetFolderId? }
 * Copies the bytes of an existing basket_file into the File Explorer basket
 * (optionally under a folder). Source file is left untouched.
 */
router.post('/copy', async (req: Request, res: Response) => {
  try {
    const { sourceBasketId, sourceFileId, targetFolderId, targetBasketId } = req.body as {
      sourceBasketId?: string;
      sourceFileId?: string;
      targetFolderId?: string | null;
      /** a project's Share Folder; default the File Explorer */
      targetBasketId?: string;
    };
    if (!sourceBasketId || !sourceFileId) {
      res.status(400).json({ success: false, error: 'sourceBasketId and sourceFileId are required' });
      return;
    }

    // 1. Resolve source file
    const owners = await basketProjects(sourceBasketId);
    if (Array.isArray(owners) && !roleAllows(await bestProjectRole(req, owners), 'viewer')) {
      res.status(403).json({ success: false, error: 'You do not have access to this basket' });
      return;
    }

    const sourceFile = await prisma.basketFile.findFirst({
      where: { id: sourceFileId, basketId: sourceBasketId },
    });
    if (!sourceFile) {
      res.status(404).json({ success: false, error: 'Source file not found' });
      return;
    }
    if (!fs.existsSync(sourceFile.path)) {
      res.status(404).json({ success: false, error: `Source file missing on disk: ${sourceFile.path}` });
      return;
    }

    // 2. Resolve the target basket (a Share Folder, by default the File Explorer)
    const fe = await getOrCreateFileExplorerBasket();
    const feBasket = targetBasketId && targetBasketId !== fe.id
      ? await prisma.basket.findFirst({ where: { id: targetBasketId, type: 'shares' } })
      : fe;
    if (!feBasket) { res.status(404).json({ success: false, error: 'Target basket not found' }); return; }
    if (feBasket.id === fe.id) {
      if (!(await allowFeFolder(req, res, feBasket.id, targetFolderId || null, 'editor'))) return;
    } else {
      const owners = await basketProjects(feBasket.id);
      if (Array.isArray(owners) && !roleAllows(await bestProjectRole(req, owners), 'editor')) {
        res.status(403).json({ success: false, error: 'You need editor access to this basket' }); return;
      }
    }

    // 3. Resolve target folder
    let folderRelPath = '';
    if (targetFolderId) {
      const folder = await prisma.basketFolder.findFirst({
        where: { id: targetFolderId, basketId: feBasket.id },
      });
      if (!folder) {
        res.status(404).json({ success: false, error: 'Target folder not found in this basket' });
        return;
      }
      folderRelPath = folder.path;
    }

    // 4. Compute destination path — preserve original name, avoid overwrite by suffixing
    const destDir = folderRelPath
      ? path.join(feBasket.path, 'folders', folderRelPath)
      : path.join(feBasket.path, 'root');
    fs.mkdirSync(destDir, { recursive: true });

    const origName = sourceFile.originalName || sourceFile.fileName;
    const parsed = path.parse(origName);
    let destName = origName;
    let counter = 1;
    while (fs.existsSync(path.join(destDir, destName))) {
      destName = `${parsed.name} (${counter})${parsed.ext}`;
      counter++;
    }
    const destPath = path.join(destDir, destName);

    // 5. Copy bytes
    fs.copyFileSync(sourceFile.path, destPath);
    const stats = fs.statSync(destPath);

    // 6. Register new basket_file row
    const created = await prisma.basketFile.create({
      data: {
        basketId: feBasket.id,
        sessionId: null,
        folderId: targetFolderId || null,
        fileName: destName,
        originalName: destName,
        size: stats.size,
        mimeType: sourceFile.mimeType,
        path: destPath,
        status: 'uploaded',
        metadata: JSON.stringify({
          copiedFrom: { basketId: sourceBasketId, fileId: sourceFileId, originalName: sourceFile.originalName },
          copiedAt: new Date().toISOString(),
        }),
      },
    });

    res.json({ success: true, data: created });
  } catch (err: any) {
    console.error('[FileExplorer] copy failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /file-explorer/sources
 * Lists all baskets that can be copied FROM (excludes the FE basket itself).
 * Each entry shows current file count for quick UI display.
 */
// The File Explorer itself is a workspace every logged-in user shares; the
// baskets offered as copy sources are only those of the user's projects.
router.get('/sources', async (req: Request, res: Response) => {
  try {
    const fe = await getOrCreateFileExplorerBasket();
    const baskets = await prisma.basket.findMany({
      where: { id: { not: fe.id }, ...(await projectScope(req)) },
      orderBy: [{ projectId: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, type: true, projectId: true,
        _count: { select: { basketFiles: true } },
      },
    });
    res.json({ success: true, data: baskets });
  } catch (err: any) {
    console.error('[FileExplorer] sources failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /file-explorer/folders/:folderId/download — the folder (and its subfolders) as one zip.
 * Streamed, so a 1+ GB delivery never sits in memory. folderId "root" = files outside any folder.
 * Needs login like the rest of /int (browser downloads pass ?token=).
 */
router.get('/folders/:folderId/download', async (req: Request, res: Response) => {
  try {
    const fe = await getOrCreateFileExplorerBasket();
    const wanted = (req.query.basketId as string) || fe.id;
    const basket = wanted === fe.id ? fe : await prisma.basket.findFirst({ where: { id: wanted, type: 'shares' } });
    if (!basket) { res.status(404).json({ success: false, error: 'Basket not found' }); return; }
    if (basket.id !== fe.id) {
      const owners = await basketProjects(basket.id);
      if (Array.isArray(owners) && !roleAllows(await bestProjectRole(req, owners), 'viewer')) {
        res.status(403).json({ success: false, error: 'You do not have access to this basket' }); return;
      }
    }
    const all = await prisma.basketFolder.findMany({ where: { basketId: basket.id } });
    const isRoot = req.params.folderId === 'root';
    const top = isRoot ? null : all.find((f) => f.id === req.params.folderId);
    if (!isRoot && !top) {
      res.status(404).json({ success: false, error: 'Folder not found' });
      return;
    }
    if (basket.id === fe.id && !(await allowFeFolder(req, res, basket.id, top ? top.id : null, 'viewer'))) return;

    // folder id → path inside the zip (relative to the folder being downloaded)
    const rel = new Map<string | null, string>([[top ? top.id : null, '']]);
    if (top) {
      const queue = [top];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const child of all.filter((f) => f.parentId === cur.id)) {
          rel.set(child.id, path.posix.join(rel.get(cur.id) || '', child.name));
          queue.push(child);
        }
      }
    }
    const files = await prisma.basketFile.findMany({
      where: { basketId: basket.id, folderId: isRoot ? null : { in: [...rel.keys()] as string[] } },
      orderBy: { originalName: 'asc' },
    });

    const zipName = `${top ? top.name : basket.id === fe.id ? 'root' : basket.name}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);

    // Light compression: CSVs still shrink a lot, and a 1 GB folder does not take minutes of CPU
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err) => { console.error('[FileExplorer] zip error:', err.message); res.destroy(err); });
    req.on('close', () => archive.abort());
    archive.pipe(res);
    for (const f of files) {
      if (!fs.existsSync(f.path)) continue;
      archive.file(f.path, { name: path.posix.join(rel.get(f.folderId) || '', f.originalName || f.fileName) });
    }
    await archive.finalize();
  } catch (err: any) {
    console.error('[FileExplorer] download-all failed:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    else res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Linked baskets — a project's basket shown in the File Explorer next to its own
// folders. Read-only view of the basket (sessions or folders, then files); the
// files stay in the basket. The list lives in system_configs, so no schema change.
// ─────────────────────────────────────────────────────────────────────────────

/** Can the caller see (or, with need='editor', change) this basket? */
async function basketAllowed(req: Request, basketId: string, need: 'viewer' | 'editor'): Promise<boolean> {
  const owners = await basketProjects(basketId);
  return !Array.isArray(owners) || roleAllows(await bestProjectRole(req, owners), need);
}

const FILE_FIELDS = { id: true, fileName: true, originalName: true, size: true, mimeType: true, status: true, createdAt: true } as const;

/** GET /file-explorer/links — linked baskets the caller can see. */
router.get('/links', async (req: Request, res: Response) => {
  try {
    const links = (await readLinks()).sort((a, b) => Number(!!b.projectBasket) - Number(!!a.projectBasket) || a.name.localeCompare(b.name, 'th'));
    const baskets = await prisma.basket.findMany({
      where: { id: { in: links.map((l) => l.basketId) } },
      select: { id: true, name: true, type: true, projectId: true, project: { select: { name: true } }, _count: { select: { basketFiles: true } } },
    });
    const out = [];
    for (const l of links) {
      const b = baskets.find((x) => x.id === l.basketId);
      if (!b || !(await basketAllowed(req, b.id, 'viewer'))) continue;
      out.push({
        id: l.id, name: l.name, basketId: b.id, basketName: b.name, basketType: b.type, projectBasket: !!l.projectBasket,
        projectId: b.projectId, projectName: b.project?.name ?? null, fileCount: b._count.basketFiles,
      });
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    console.error('[FileExplorer] links failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /file-explorer/links { basketId, name? } — link a project's basket into the File Explorer. */
router.post('/links', async (req: Request, res: Response) => {
  try {
    const { basketId, name } = req.body as { basketId?: string; name?: string };
    if (!basketId) { res.status(400).json({ success: false, error: 'basketId is required' }); return; }
    const basket = await prisma.basket.findUnique({ where: { id: basketId }, include: { project: { select: { name: true } } } });
    if (!basket) { res.status(404).json({ success: false, error: 'Basket not found' }); return; }
    const fe = await getOrCreateFileExplorerBasket();
    if (basket.id === fe.id) { res.status(400).json({ success: false, error: 'Cannot link the File Explorer to itself' }); return; }
    if (basket.type === 'sftp') { res.status(400).json({ success: false, error: 'SFTP baskets cannot be linked — they browse a remote server' }); return; }
    if (!(await basketAllowed(req, basketId, 'editor'))) { res.status(403).json({ success: false, error: 'You need editor access to this basket' }); return; }

    const links = await readLinks();
    const existing = links.find((l) => l.basketId === basketId);
    if (existing) { res.json({ success: true, data: existing }); return; }   // e.g. a new File Explorer basket links itself
    const link: BasketLink = {
      id: `lnk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      basketId,
      name: (name || '').trim() || `${basket.project?.name ? `${basket.project.name} · ` : ''}${basket.name}`,
      createdAt: new Date().toISOString(),
      createdBy: (req as any).userId ?? null,
    };
    await writeLinks([...links, link]);
    res.json({ success: true, data: link });
  } catch (err: any) {
    console.error('[FileExplorer] link failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /file-explorer/links/:id — unlink (the basket and its files are untouched). */
router.delete('/links/:id', async (req: Request, res: Response) => {
  try {
    const links = await readLinks();
    const link = links.find((l) => l.id === req.params.id);
    if (!link) { res.status(404).json({ success: false, error: 'Link not found' }); return; }
    if (!(await basketAllowed(req, link.basketId, 'editor'))) { res.status(403).json({ success: false, error: 'You need editor access to this basket' }); return; }
    await writeLinks(links.filter((l) => l.id !== link.id));
    res.json({ success: true });
  } catch (err: any) {
    console.error('[FileExplorer] unlink failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /file-explorer/links/:id/items?sessionId=&folderId=
 * Batch basket: top level lists its sessions as folders (plus files outside any session);
 * ?sessionId= lists one session's files. Shares basket: folders and files by ?folderId=.
 */
router.get('/links/:id/items', async (req: Request, res: Response) => {
  try {
    const link = (await readLinks()).find((l) => l.id === req.params.id);
    if (!link) { res.status(404).json({ success: false, error: 'Link not found' }); return; }
    const basket = await prisma.basket.findUnique({ where: { id: link.basketId } });
    if (!basket) { res.status(404).json({ success: false, error: 'The linked basket no longer exists' }); return; }
    if (!(await basketAllowed(req, basket.id, 'viewer'))) { res.status(403).json({ success: false, error: 'You do not have access to this basket' }); return; }

    const sessionId = (req.query.sessionId as string) || null;
    const folderId = (req.query.folderId as string) || null;
    let folders: { id: string; name: string; kind: 'session' | 'folder'; status?: string; fileCount: number }[] = [];
    let files;

    if (basket.type === 'batch') {
      if (sessionId) {
        files = await prisma.basketFile.findMany({ where: { basketId: basket.id, sessionId }, orderBy: { originalName: 'asc' }, select: FILE_FIELDS });
      } else {
        const sessions = await prisma.processingSession.findMany({
          where: { basketId: basket.id },
          orderBy: { batchName: 'desc' },
          select: { id: true, batchName: true, status: true, _count: { select: { basketFiles: true } } },
        });
        folders = sessions.map((s) => ({ id: s.id, name: s.batchName, kind: 'session' as const, status: s.status, fileCount: s._count.basketFiles }));
        files = await prisma.basketFile.findMany({ where: { basketId: basket.id, sessionId: null }, orderBy: { originalName: 'asc' }, select: FILE_FIELDS });
      }
    } else {
      const sub = await prisma.basketFolder.findMany({
        where: { basketId: basket.id, parentId: folderId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, _count: { select: { files: true } } },
      });
      folders = sub.map((f) => ({ id: f.id, name: f.name, kind: 'folder' as const, fileCount: f._count.files }));
      files = await prisma.basketFile.findMany({ where: { basketId: basket.id, folderId }, orderBy: { originalName: 'asc' }, select: FILE_FIELDS });
    }
    res.json({ success: true, data: { basketId: basket.id, basketType: basket.type, folders, files } });
  } catch (err: any) {
    console.error('[FileExplorer] link items failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
