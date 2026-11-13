// sftp-action operation "download-new-folders"
//
// Files land in the flow's basket first (a session named after the subfolder) when a
// basketId is set, and are then copied into the File Explorer.
//
// For a partner that drops each delivery into its own dated subfolder (e.g. a partner's
// /inbox/DATA/2569-10-06/), copy every subfolder that has not been fully copied yet
// into the File Explorer, under <targetFolder>/<subfolder name>.
//
// "Already copied" is decided from what is in the File Explorer, not from a log:
// a subfolder is complete when every matching remote file has a basket_files row
// in the same-named File Explorer folder with the same size. Files missing or of a
// different size are (re)downloaded, so a run that died half way resumes on the
// next run instead of leaving a folder that looks done but is short a file.

import fs from 'fs';
import path from 'path';
import { Client, SFTPWrapper } from 'ssh2';
import { prisma } from '../../../lib/prisma';
import { normalizePrivateKey } from '../../../lib/ppk-converter';
import { getOrCreateShareLink } from '../../../routes/shareLinks';
import { decryptIfEncrypted, decryptedName } from '../../../lib/fileDecrypt';
import { ensureFileExplorerFolder, fileExplorerFolderPath, getOrCreateFileExplorerBasket, ensureProjectBasket } from '../../../lib/fileExplorerBasket';

export interface FolderSyncOptions {
  remotePath: string;          // parent of the dated subfolders, e.g. /inbox/DATA
  filePattern?: string;        // glob inside each subfolder, default *
  targetFolder?: string;       // File Explorer folder, default = basename(remotePath)
  startFromFolder?: string;    // skip subfolders whose name sorts before this
  maxFolders?: number;         // copy at most this many new subfolders per run (0 = all)
  linkBaseUrl?: string;        // e.g. https://example.com/integration
  groupByFiscalYear?: boolean; // put each subfolder under a Thai fiscal-year folder (Oct–Sep)
  basketId?: string;           // land files in this basket first (one session per subfolder), then copy to File Explorer
  explorerBasketId?: string;   // File Explorer basket for the copies (default: the landing basket's project basket)
  encryptionKeyId?: string;    // our key pair: decrypt files the partner encrypted with its public key
}

/** Name of the file on the SFTP server: the local copy may be renamed when decrypted (x.csv.enc -> x.csv). */
function remoteNameOf(row: { originalName: string; metadata?: string | null }): string {
  try {
    const m = row.metadata ? JSON.parse(row.metadata) : null;
    if (typeof m?.remotePath === 'string') return path.posix.basename(m.remotePath);
  } catch { /* plain row */ }
  return row.originalName;
}

function mimeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '.csv' ? 'text/csv' : ext === '.txt' ? 'text/plain' : ext === '.json' ? 'application/json' : 'application/octet-stream';
}

/**
 * Is the local copy still the file on the server? Same name is given; also same size and,
 * when both are known, same modification time — a partner re-dropping a file under the same
 * name and size (an encrypted file of the same length) must be fetched again.
 */
function isCurrentCopy(row: { size: number; metadata?: string | null; remoteModifiedAt?: Date | null; path: string },
                       rf: { size: number; mtime: number }): boolean {
  if (remoteSizeOf(row) !== rf.size || !fs.existsSync(row.path)) return false;
  if (row.remoteModifiedAt && rf.mtime && Math.abs(row.remoteModifiedAt.getTime() / 1000 - rf.mtime) >= 1) return false;
  return true;
}

/** Size of the file on the SFTP server: stored in metadata when the local copy was decrypted. */
function remoteSizeOf(row: { size: number; metadata?: string | null }): number {
  try {
    const m = row.metadata ? JSON.parse(row.metadata) : null;
    if (typeof m?.remoteSize === 'number') return m.remoteSize;
  } catch { /* plain row */ }
  return row.size;
}

/**
 * Thai fiscal year of a folder named by date (2569-10-06, 25691006, 2026-10-06):
 * the year runs 1 Oct – 30 Sep and is named after the year it ends in, so
 * 2569-10-06 belongs to ปีงบประมาณ 2570. Undated names return null.
 */
export function fiscalYearOf(folderName: string): string | null {
  const m = folderName.match(/^(\d{4})-?(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return String(month >= 10 ? year + 1 : year);
}

/** Buddhist-era date (Asia/Bangkok) of a unix time: 2569-10-26. */
function beDate(unixSeconds: number): string {
  const d = new Date((unixSeconds || Date.now() / 1000) * 1000 + 7 * 3600 * 1000);
  return `${d.getUTCFullYear() + 543}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Move a File Explorer folder (row, files and directory on disk) under a new parent. */
async function moveFolder(basket: { id: string; path: string }, folder: { id: string; name: string; path: string }, newParent: { id: string; path: string }) {
  const newPath = fileExplorerFolderPath(folder.name, newParent.path);
  const fromDir = path.join(basket.path, 'folders', folder.path);
  const toDir = path.join(basket.path, 'folders', newPath);
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  if (fs.existsSync(fromDir) && !fs.existsSync(toDir)) fs.renameSync(fromDir, toDir);
  await prisma.basketFolder.update({ where: { id: folder.id }, data: { parentId: newParent.id, path: newPath } });
  const files = await prisma.basketFile.findMany({ where: { basketId: basket.id, folderId: folder.id } });
  for (const f of files) {
    if (f.path.startsWith(fromDir)) {
      await prisma.basketFile.update({ where: { id: f.id }, data: { path: toDir + f.path.slice(fromDir.length) } });
    }
  }
  return { ...folder, path: newPath };
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

const p = <T>(fn: (cb: (err: any, val?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, val) => (err ? reject(err) : resolve(val as T))));

function globToRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

async function connect(config: any): Promise<{ conn: Client; sftp: SFTPWrapper }> {
  const conn = new Client();
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    conn.on('ready', () => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    conn.on('error', reject);
    conn.connect({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.authType === 'private-key' ? undefined : config.password,
      privateKey: config.authType === 'private-key' && config.privateKey ? normalizePrivateKey(config.privateKey) : undefined,
      passphrase: config.passphrase,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
    });
  });
  return { conn, sftp };
}

export async function downloadNewFolders(config: any, opts: FolderSyncOptions, log: Log) {
  const remoteRoot = opts.remotePath?.startsWith('/')
    ? path.posix.normalize(opts.remotePath)
    : path.posix.join(config.basePath || '/', opts.remotePath || '');
  const pattern = globToRegex(opts.filePattern || '*');
  const landing = opts.basketId ? await prisma.basket.findUnique({ where: { id: opts.basketId } }) : null;
  if (opts.basketId && !landing) throw new Error(`Basket not found: ${opts.basketId}`);
  // Copies go to the project's own basket (its "ตะกร้าเอกสาร"), deliveries at its top level;
  // without a landing basket, to the shared File Explorer under <targetFolder>.
  const chosen = opts.explorerBasketId ? await prisma.basket.findUnique({ where: { id: opts.explorerBasketId } }) : null;
  if (opts.explorerBasketId && chosen?.type !== 'shares') throw new Error(`File Explorer basket not found: ${opts.explorerBasketId}`);
  const own = !!(chosen || landing);
  const basket = chosen ?? (landing ? await ensureProjectBasket(landing.projectId) : await getOrCreateFileExplorerBasket());
  const parentName = own ? basket.name : (opts.targetFolder || path.posix.basename(remoteRoot) || 'downloads').trim();
  const parent = own ? null : await ensureFileExplorerFolder(basket, parentName, null);
  const decryptKey = opts.encryptionKeyId ? await prisma.apiKey.findUnique({ where: { id: opts.encryptionKeyId } }) : null;
  if (opts.encryptionKeyId && !decryptKey) throw new Error(`Encryption key not found: ${opts.encryptionKeyId}`);

  const { conn, sftp } = await connect(config);
  try {
    const entries = await p<any[]>((cb) => sftp.readdir(remoteRoot, cb));
    const isFile = (e: any) => ((e.attrs.mode ?? 0) & 0o170000) === 0o100000;
    const toRemoteFile = (e: any) => ({ name: e.filename as string, size: Number(e.attrs.size ?? 0), mtime: e.attrs.mtime as number });
    // Each delivery is a dated subfolder; files dropped straight into remoteRoot are
    // grouped into one delivery per day (Buddhist-era date of the file, e.g. 2569-10-26)
    const deliveries: { dirName: string; remoteDir: string; files?: { name: string; size: number; mtime: number }[] }[] = entries
      .filter((e) => ((e.attrs.mode ?? 0) & 0o170000) === 0o040000)
      .map((e) => ({ dirName: e.filename as string, remoteDir: path.posix.join(remoteRoot, e.filename) }));
    const looseByDay = new Map<string, { name: string; size: number; mtime: number }[]>();
    for (const e of entries.filter((e) => isFile(e) && pattern.test(e.filename))) {
      const day = beDate(e.attrs.mtime);
      looseByDay.set(day, [...(looseByDay.get(day) || []), toRemoteFile(e)]);
    }
    for (const [day, files] of looseByDay) deliveries.push({ dirName: day, remoteDir: remoteRoot, files });
    const dirs = deliveries
      .filter((d) => !opts.startFromFolder || d.dirName.localeCompare(opts.startFromFolder) >= 0)
      .sort((a, b) => a.dirName.localeCompare(b.dirName));

    const copied: any[] = [];
    const upToDate: string[] = [];
    let totalBytes = 0;
    let fileCount = 0;

    for (const { dirName, remoteDir, files: looseFiles } of dirs) {
      if (opts.maxFolders && copied.length >= opts.maxFolders) {
        log('info', `Stopping after ${opts.maxFolders} folder(s); the rest will be copied on the next run`);
        break;
      }
      const remoteFiles = looseFiles ?? (await p<any[]>((cb) => sftp.readdir(remoteDir, cb)))
        .filter((e) => isFile(e) && pattern.test(e.filename))
        .map(toRemoteFile);
      if (!remoteFiles.length) continue;

      // Parent for this delivery: the target folder, or its fiscal-year folder under it
      const fy = opts.groupByFiscalYear ? fiscalYearOf(dirName) : null;
      const home = fy ? await ensureFileExplorerFolder(basket, fy, parent) : parent;
      if (fy && home) {
        // A copy made before fiscal-year grouping was switched on sits directly under the target: move it
        const legacy = await prisma.basketFolder.findFirst({ where: { basketId: basket.id, name: dirName, parentId: parent ? parent.id : null } });
        const already = await prisma.basketFolder.findFirst({ where: { basketId: basket.id, name: dirName, parentId: home.id } });
        if (legacy && !already) {
          await moveFolder(basket, legacy, home);
          log('info', `Moved ${parentName}/${dirName} to ${parentName}/${fy}/${dirName}`);
        }
      }
      const folder = await ensureFileExplorerFolder(basket, dirName, home);
      const localDir = path.join(basket.path, 'folders', folder.path);
      const existing = await prisma.basketFile.findMany({ where: { basketId: basket.id, folderId: folder.id } });

      const todo = remoteFiles.filter((rf) => {
        const row = existing.find((x) => remoteNameOf(x) === rf.name);
        return !row || !isCurrentCopy(row, rf);
      });
      if (!todo.length) { upToDate.push(dirName); continue; }

      log('info', `${dirName}: copying ${todo.length} of ${remoteFiles.length} file(s)`);

      // Landing basket: one session per delivery folder, named after it
      let session: { id: string } | null = null;
      let sessionDir = '';
      if (landing) {
        session = await prisma.processingSession.findFirst({ where: { basketId: landing.id, batchName: dirName } })
          ?? await prisma.processingSession.create({ data: { basketId: landing.id, batchName: dirName, status: 'open', publishMode: 'manual', startedAt: new Date() } });
        sessionDir = path.join(landing.path, 'sessions', dirName);
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      const files: { name: string; size: number; decrypted?: boolean }[] = [];
      for (const rf of todo) {
        // Replace an incomplete or stale copy
        for (const old of existing.filter((x) => remoteNameOf(x) === rf.name)) {
          await prisma.basketFile.delete({ where: { id: old.id } }).catch(() => {});
          if (old.path && fs.existsSync(old.path)) fs.unlinkSync(old.path);
        }
        const t0 = Date.now();
        // Download to <dir>/<remote name>.part, check the size, then decrypt (or keep) into <dir>/<local name>
        // null = encrypted for someone else (e.g. our own upload to the partner): left on the server, not copied
        const fetchTo = async (dir: string): Promise<{ path: string; name: string; size: number; decrypted: boolean } | null> => {
          const part = path.join(dir, `${rf.name}.part`);
          await p<void>((cb) => sftp.fastGet(path.posix.join(remoteDir, rf.name), part, cb));
          const got = fs.statSync(part).size;
          if (got !== rf.size) {
            fs.unlinkSync(part);
            throw new Error(`${dirName}/${rf.name}: got ${got} bytes, expected ${rf.size}`);
          }
          if (decryptKey) {
            const name = decryptedName(rf.name);
            const target = path.join(dir, name);
            try {
              if (await decryptIfEncrypted(part, target, rf.name, decryptKey)) {
                fs.unlinkSync(part);
                return { path: target, name, size: fs.statSync(target).size, decrypted: true };
              }
            } catch (err) {
              fs.unlinkSync(part);
              log('warn', `  ${rf.name}: cannot decrypt with "${decryptKey.name}" (${(err as Error).message}) — skipped`);
              return null;
            }
          }
          const target = path.join(dir, rf.name);
          fs.renameSync(part, target);
          return { path: target, name: rf.name, size: rf.size, decrypted: false };
        };
        let local: { path: string; name: string; size: number; decrypted: boolean } | null;
        if (landing && session) {
          // 1) basket: reuse a complete copy from an earlier run, else download
          const row = (await prisma.basketFile.findMany({ where: { basketId: landing.id, sessionId: session.id } }))
            .find((x) => remoteNameOf(x) === rf.name);
          if (row && isCurrentCopy(row, rf)) {
            local = { path: row.path, name: row.fileName, size: row.size, decrypted: row.fileName !== rf.name };
          } else {
            if (row) await prisma.basketFile.delete({ where: { id: row.id } }).catch(() => {});
            local = await fetchTo(sessionDir);
            if (!local) continue;
            await prisma.basketFile.create({
              data: {
                basketId: landing.id, sessionId: session.id, fileName: local.name, originalName: local.name, size: local.size,
                mimeType: mimeOf(local.name),
                path: local.path, status: 'uploaded', remoteModifiedAt: rf.mtime ? new Date(rf.mtime * 1000) : null,
                metadata: JSON.stringify({ source: 'sftp', remotePath: path.posix.join(remoteDir, rf.name), remoteSize: rf.size, decrypted: local.decrypted }),
              },
            });
          }
          // 2) File Explorer: copy from the basket
          const dest = path.join(localDir, local.name);
          fs.copyFileSync(local.path, `${dest}.part`);
          fs.renameSync(`${dest}.part`, dest);
          local = { ...local, path: dest };
        } else {
          local = await fetchTo(localDir);
          if (!local) continue;
        }
        await prisma.basketFile.create({
          data: {
            basketId: basket.id,
            folderId: folder.id,
            fileName: local.name,
            originalName: local.name,
            size: local.size,
            mimeType: mimeOf(local.name),
            path: local.path,
            status: 'uploaded',
            remoteModifiedAt: rf.mtime ? new Date(rf.mtime * 1000) : null,
            metadata: JSON.stringify({ source: 'sftp', remotePath: path.posix.join(remoteDir, rf.name), remoteSize: rf.size, decrypted: local.decrypted, downloadedAt: new Date().toISOString() }),
          },
        });
        if (local.decrypted) log('info', `  ${rf.name} decrypted → ${local.name}`);
        log('info', `  ${rf.name} ${formatSize(rf.size)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        files.push({ name: local.name, size: local.size, ...(local.decrypted ? { decrypted: true } : {}) });
        totalBytes += local.size;
        fileCount++;
      }

      if (landing && session) {
        const rows = await prisma.basketFile.findMany({ where: { basketId: landing.id, sessionId: session.id } });
        const bytes = rows.reduce((n, r) => n + r.size, 0);
        await prisma.processingSession.update({
          where: { id: session.id },
          data: { fileCount: rows.length, totalSize: Math.min(bytes, 2147483647) },
        });
      }

      const share = opts.linkBaseUrl ? await getOrCreateShareLink({ folderId: folder.id }) : null;
      copied.push({
        name: dirName,
        remotePath: remoteDir,
        fiscalYear: fy,
        fileExplorerPath: fy ? `${parentName}/${fy}/${dirName}` : `${parentName}/${dirName}`,
        files,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
        link: share ? `${opts.linkBaseUrl!.replace(/\/$/, '')}/share/${share.id}` : null,
      });
    }

    const summary = copied.length
      ? copied.map((f) => [
          `${f.name} (${f.files.length} files, ${formatSize(f.totalBytes)})`,
          ...f.files.map((x: any) => `  - ${x.name}  ${formatSize(x.size)}`),
          ...(f.link ? [`  ${f.link}`] : []),
        ].join('\n')).join('\n\n')
      : 'No new folders.';

    return {
      operation: 'download-new-folders',
      remotePath: remoteRoot,
      fileExplorerFolder: parentName,
      newFolders: copied,
      newFolderCount: copied.length,
      newFolderNames: copied.map((f) => f.name),
      upToDateFolders: upToDate,
      fileCount,
      totalBytes,
      hasNew: copied.length > 0,
      summary,
    };
  } finally {
    conn.end();
  }
}
