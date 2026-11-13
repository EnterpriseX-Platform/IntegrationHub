// The single global File Explorer basket ("shares" type), shared by the
// /file-explorer routes and flow executors that deliver files into it.
// Its id is persisted in `system_configs` so the same basket is reused across restarts.

import fs from 'fs';
import path from 'path';
import { prisma } from './prisma';

const BASKETS_BASE_DIR = process.env.BASKETS_DIR || './baskets';
const FILE_EXPLORER_CONFIG_KEY = 'fileExplorerBasketId';

/** Locate (or create) the single global File Explorer basket. */
export async function getOrCreateFileExplorerBasket() {
  // 1. Look up the stored basket id in system_configs
  const cfg = await prisma.systemConfig.findFirst({ where: { key: FILE_EXPLORER_CONFIG_KEY } });
  if (cfg?.value) {
    const existing = await prisma.basket.findUnique({ where: { id: cfg.value } });
    if (existing) return existing;
    // Stored id is stale — fall through and create a new one
  }

  // 2. Pick any project to anchor the basket (projectId is required by the schema).
  //    The basket is treated as global by being referenced from system_configs;
  //    project ownership here is just a structural placeholder.
  const anyProject = await prisma.project.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!anyProject) {
    throw new Error('Cannot initialise File Explorer: no project exists yet.');
  }

  // 3. Create the basket on disk + in DB
  const dirName = `file-explorer-${Date.now()}`;
  const basketPath = path.join(BASKETS_BASE_DIR, dirName);
  fs.mkdirSync(path.join(basketPath, 'folders'), { recursive: true });

  const basket = await prisma.basket.create({
    data: {
      name: 'File Explorer',
      description: 'Personal workspace — copy files from any basket and organise into folders.',
      type: 'shares',
      path: basketPath,
      projectId: anyProject.id,
      autoArchive: false,
      autoPublish: 'manual',
      displayOrder: 0,
    },
  });

  // 4. Persist the id in system_configs so we always pick it up next time
  await prisma.systemConfig.upsert({
    where: { key: FILE_EXPLORER_CONFIG_KEY },
    update: { value: basket.id, description: 'ID of the global File Explorer basket' },
    create: {
      key: FILE_EXPLORER_CONFIG_KEY,
      value: basket.id,
      description: 'ID of the global File Explorer basket',
      category: 'platform',
      isSecret: false,
    },
  });

  return basket;
}


/** Folder path as the folder routes build it: sanitised, lower-case, joined to the parent path. */
export function fileExplorerFolderPath(name: string, parentPath?: string | null): string {
  const seg = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return parentPath ? path.join(parentPath, seg) : seg;
}

/** Find or create a (sub)folder by display name under parentId, creating it on disk too. */
export async function ensureFileExplorerFolder(basket: { id: string; path: string }, name: string, parent?: { id: string; path: string } | null) {
  const existing = await prisma.basketFolder.findFirst({
    where: { basketId: basket.id, name, parentId: parent ? parent.id : null },
  });
  const folder = existing ?? await prisma.basketFolder.create({
    data: { basketId: basket.id, name, path: fileExplorerFolderPath(name, parent?.path), parentId: parent ? parent.id : null },
  });
  fs.mkdirSync(path.join(basket.path, 'folders', folder.path), { recursive: true });
  return folder;
}


// ── Project baskets ─────────────────────────────────────────────────────────
// Every project has a Share Folder named after it, shown as its "ตะกร้าเอกสาร"
// entry in the File Explorer. Marked with settings.feProjectBasket.

export const PROJECT_BASKET_MARK = 'feProjectBasket';
const LINKS_KEY = 'fileExplorerLinks';

export interface BasketLink { id: string; basketId: string; name: string; createdAt: string; createdBy?: string | null; projectBasket?: boolean }

export async function readLinks(): Promise<BasketLink[]> {
  const cfg = await prisma.systemConfig.findFirst({ where: { key: LINKS_KEY } });
  try { return cfg?.value ? JSON.parse(cfg.value) : []; } catch { return []; }
}

export async function writeLinks(links: BasketLink[]) {
  await prisma.systemConfig.upsert({
    where: { key: LINKS_KEY },
    update: { value: JSON.stringify(links) },
    create: { key: LINKS_KEY, value: JSON.stringify(links), category: 'general', description: 'Baskets shown in the File Explorer' },
  });
}

/** The project's Share Folder (created, named and linked on demand). */
export async function ensureProjectBasket(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) throw new Error(`Project not found: ${projectId}`);
  let basket = await prisma.basket.findFirst({
    where: { projectId, type: 'shares', settings: { contains: `"${PROJECT_BASKET_MARK}":true` } },
  });
  if (!basket) {
    const created = await prisma.basket.create({
      data: {
        projectId, name: project.name, type: 'shares', path: '',
        settings: JSON.stringify({ [PROJECT_BASKET_MARK]: true }),
      },
    });
    const dir = path.join(BASKETS_BASE_DIR, created.id);
    fs.mkdirSync(path.join(dir, 'folders'), { recursive: true });
    basket = await prisma.basket.update({ where: { id: created.id }, data: { path: dir } });
    console.log(`[FileExplorer] created project basket "${project.name}" (${created.id})`);
  } else if (basket.name !== project.name) {
    basket = await prisma.basket.update({ where: { id: basket.id }, data: { name: project.name } }); // project renamed
  }
  const links = await readLinks();
  const link = links.find((l) => l.basketId === basket!.id);
  if (!link) {
    await writeLinks([...links, { id: `lnk_${basket.id}`, basketId: basket.id, name: project.name, createdAt: new Date().toISOString(), projectBasket: true }]);
  } else if (link.name !== project.name || !link.projectBasket) {
    await writeLinks(links.map((l) => (l.basketId === basket!.id ? { ...l, name: project.name, projectBasket: true } : l)));
  }
  return basket;
}
