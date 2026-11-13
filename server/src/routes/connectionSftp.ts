// SFTP browser for SFTP connections — list / download / upload / mkdir /
// rename / delete on the remote server, like WinSCP or FileZilla.
//
// Mounted under `${API_PREFIX}/connections`, so paths are
// `/connections/:id/sftp/...`. Each request opens its own SSH session and
// closes it when done; nothing is pooled.

import { Router, Request, Response } from 'express';
import path from 'path';
import { Client as SSHClient, SFTPWrapper } from 'ssh2';
import { prisma } from '../lib/prisma';
import { normalizePrivateKey } from '../lib/ppk-converter';
import { base64Upload } from '../middleware/base64Upload';
import { requireSession } from '../middleware/requireSession';
import os from 'os';
import fs from 'fs';
import { guardProjects } from '../lib/access';

const router = Router();

// Connections hold secrets: non-admins need editor on the connection's project.
// App-level connections (no project) are admin only.
router.param('id', guardProjects(async (id) => {
  const c = await prisma.connection.findUnique({ where: { id }, select: { projectId: true } });
  return c ? (c.projectId ? [c.projectId] : []) : null;
}, 'editor'));
// Browsing a partner's SFTP server (and deleting on it) needs a logged-in user
router.use('/:id/sftp', requireSession);
const uploadDir = path.join(os.tmpdir(), 'sftp-browser-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function loadSftpConfig(id: string): Promise<any> {
  const connection = await prisma.connection.findUnique({ where: { id } });
  if (!connection) throw new HttpError(404, 'Connection not found');
  if (connection.type !== 'sftp') throw new HttpError(400, 'Connection is not an SFTP connection');
  try {
    return typeof connection.config === 'string' ? JSON.parse(connection.config) : (connection.config || {});
  } catch {
    return {};
  }
}

/** Open an SSH + SFTP session, run `fn`, always close the session. */
async function withSftp<T>(config: any, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const conn = new SSHClient();
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    conn.on('ready', () => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    conn.on('error', reject);
    conn.connect({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      ...(config.authType === 'private-key'
        ? { privateKey: normalizePrivateKey(config.privateKey), passphrase: config.passphrase }
        : { password: config.password }),
      readyTimeout: 15000,
    });
  });
  try {
    return await fn(sftp);
  } finally {
    conn.end();
  }
}

const p = <T>(fn: (cb: (err: any, val?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, val) => (err ? reject(err) : resolve(val as T))));

/** Normalise a client-supplied remote path to an absolute POSIX path. */
function remotePath(raw: unknown, fallback = '.'): string {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  return path.posix.normalize(s);
}

function sendError(res: Response, err: any) {
  const status = err instanceof HttpError ? err.status : 500;
  console.error('[SFTP Browser]', err?.message || err);
  res.status(status).json({ success: false, error: err?.message || 'SFTP operation failed' });
}

// GET /connections/:id/sftp/list?path=/some/dir
router.get('/:id/sftp/list', async (req: Request, res: Response) => {
  try {
    const config = await loadSftpConfig(req.params.id);
    const data = await withSftp(config, async (sftp) => {
      // An explicit path must exist. With none, start at the connection's basePath; if that
      // is gone on the server (e.g. a stale path), fall back to the login home, then `/`.
      const requested = String(req.query.path ?? '').trim();
      const candidates = requested ? [requested] : [...(config.basePath ? [config.basePath] : []), '.', '/'];
      let dir = '';
      let notice: string | undefined;
      for (const c of candidates) {
        try {
          dir = await p<string>((cb) => sftp.realpath(remotePath(c), cb));
          await p<any>((cb) => sftp.stat(dir, cb));
          break;
        } catch (err) {
          if (c === candidates[candidates.length - 1]) throw err;
          if (c === config.basePath) notice = `Base path "${config.basePath}" was not found on the server`;
        }
      }
      const list = await p<any[]>((cb) => sftp.readdir(dir, cb));
      const entries = list
        .map((e) => {
          const mode = e.attrs.mode ?? 0;
          const isDir = (mode & 0o170000) === 0o040000;
          const isLink = (mode & 0o170000) === 0o120000;
          return {
            name: e.filename,
            path: path.posix.join(dir, e.filename),
            type: isDir ? 'directory' : isLink ? 'symlink' : 'file',
            size: e.attrs.size ?? 0,
            modifiedAt: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
            permissions: (mode & 0o777).toString(8).padStart(3, '0'),
            longname: e.longname,
          };
        })
        .sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
      return { path: dir, entries, notice };
    });
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /connections/:id/sftp/download?path=/some/file[&inline=1]
// Pulled with fastGet into a temp file first (like SFTPActionExecutor): a plain
// createReadStream stalls on some servers, e.g. a partner SFTP gateway.
router.get('/:id/sftp/download', async (req: Request, res: Response) => {
  const tmp = path.join(uploadDir, `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const config = await loadSftpConfig(req.params.id);
    const file = remotePath(req.query.path, '');
    if (!file) throw new HttpError(400, 'path is required');
    await withSftp(config, async (sftp) => {
      const stat = await p<any>((cb) => sftp.stat(file, cb));
      if (stat.isDirectory()) throw new HttpError(400, 'Cannot download a directory');
      await p<void>((cb) => sftp.fastGet(file, tmp, cb));
    });
    const name = path.posix.basename(file);
    const disposition = req.query.inline ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
    await new Promise<void>((resolve) => {
      const stream = fs.createReadStream(tmp);
      stream.on('error', () => { res.end(); resolve(); });
      res.on('close', () => resolve());
      stream.pipe(res);
    });
  } catch (err) {
    if (res.headersSent) res.end();
    else sendError(res, err);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
});

// POST /connections/:id/sftp/upload?meta=<b64url {fileName, dir}>  (base64 text body, or multipart)
router.post('/:id/sftp/upload', ...base64Upload(uploadDir), async (req: Request, res: Response) => {
  const file = (req as any).file;
  try {
    if (!file) throw new HttpError(400, 'No file uploaded');
    const config = await loadSftpConfig(req.params.id);
    const dir = remotePath(req.body?.dir, '');
    if (!dir) throw new HttpError(400, 'dir is required');
    const target = path.posix.join(dir, path.posix.basename(file.originalname));
    await withSftp(config, (sftp) => p<void>((cb) => sftp.fastPut(file.path, target, cb)));
    res.json({ success: true, data: { path: target, size: file.size } });
  } catch (err) {
    sendError(res, err);
  } finally {
    if (file?.path) fs.promises.unlink(file.path).catch(() => {});
  }
});

// POST /connections/:id/sftp/mkdir  { path }
router.post('/:id/sftp/mkdir', async (req: Request, res: Response) => {
  try {
    const config = await loadSftpConfig(req.params.id);
    const dir = remotePath(req.body?.path, '');
    if (!dir) throw new HttpError(400, 'path is required');
    await withSftp(config, (sftp) => p<void>((cb) => sftp.mkdir(dir, cb)));
    res.json({ success: true, data: { path: dir } });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /connections/:id/sftp/rename  { from, to }
router.post('/:id/sftp/rename', async (req: Request, res: Response) => {
  try {
    const config = await loadSftpConfig(req.params.id);
    const from = remotePath(req.body?.from, '');
    const to = remotePath(req.body?.to, '');
    if (!from || !to) throw new HttpError(400, 'from and to are required');
    await withSftp(config, (sftp) => p<void>((cb) => sftp.rename(from, to, cb)));
    res.json({ success: true, data: { path: to } });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /connections/:id/sftp/delete  { path, type: 'file' | 'directory' }
// Directories must be empty (no recursive delete on a remote partner server).
router.post('/:id/sftp/delete', async (req: Request, res: Response) => {
  try {
    const config = await loadSftpConfig(req.params.id);
    const target = remotePath(req.body?.path, '');
    if (!target || target === '/' || target === '.') throw new HttpError(400, 'Invalid path');
    await withSftp(config, (sftp) =>
      req.body?.type === 'directory'
        ? p<void>((cb) => sftp.rmdir(target, cb))
        : p<void>((cb) => sftp.unlink(target, cb)));
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
