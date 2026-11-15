import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { prisma } from '../lib/prisma';

/**
 * Give each entry a distinct name inside a zip: a second "a.csv" becomes
 * "a (2).csv", so extracting the archive gives back every file.
 */
export function uniqueZipName(name: string, used: Set<string>): string {
  const base = (name || 'file').replace(/[\\/]/g, '_');
  let candidate = base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Zip every file of a session into <basket>/archive/<batchName>.zip and record
 * the archive on the session. Does not change the session status.
 */
export async function archiveSessionFiles(basketId: string, sessionId: string) {
  const session = await prisma.processingSession.findFirst({
    where: { id: sessionId, basketId },
    include: { basketFiles: true }
  });

  if (!session || session.basketFiles.length === 0) return null;

  const basket = await prisma.basket.findUnique({ where: { id: basketId } });
  if (!basket) return null;

  const archiveDir = path.join(basket.path, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, `${session.batchName}.zip`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(archivePath);

  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const used = new Set<string>();
    for (const file of session.basketFiles) {
      if (fs.existsSync(file.path)) {
        archive.file(file.path, { name: uniqueZipName(file.originalName, used) });
      }
    }

    archive.finalize();
  });

  const archiveStats = fs.statSync(archivePath);

  await prisma.processingSession.update({
    where: { id: sessionId },
    data: {
      archivePath,
      archiveSize: archiveStats.size
    }
  });

  return { archivePath, archiveSize: archiveStats.size };
}

/**
 * Archive a session: zip its files (unless already zipped), move it to
 * 'archived' and archive its files too. An upload node picks files by basket
 * and file status across every session, so a file left 'uploaded' inside an
 * archived session would still be sent on the next run.
 */
export async function archiveSession(sessionId: string, reason: string) {
  const session = await prisma.processingSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status === 'archived') return null;

  const result = session.archivePath ? null : await archiveSessionFiles(session.basketId, sessionId);

  await prisma.processingSession.update({
    where: { id: sessionId },
    data: {
      status: 'archived',
      archivedAt: new Date()
    }
  });

  await prisma.basketFile.updateMany({
    where: { sessionId, status: { not: 'archived' } },
    data: { status: 'archived' }
  });

  await prisma.sessionLog.create({
    data: {
      sessionId,
      type: 'archive_created',
      message: `Session archived to ${session.batchName}.zip (${reason})`,
      fileCount: session.fileCount,
      metadata: JSON.stringify(result)
    }
  });

  return result;
}
