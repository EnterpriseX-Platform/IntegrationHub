import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { guardProjects, basketProjects } from '../lib/access';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

const router = Router();

// Non-admins reach a basket through its project or a project it is shared with:
// viewer reads files, editor uploads, moves and deletes them
router.param('id', guardProjects(async (id) => { const p = await basketProjects(id); return p === 'open' ? [] : p; }));

// POST /api/baskets/:id/seed - Create sample data for demo
router.post('/:id/seed', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { count = '5' } = req.body;

    const basket = await prisma.basket.findUnique({ where: { id } });
    if (!basket) {
      res.status(404).json({ success: false, error: 'Basket not found' });
      return;
    }

    const sessionCount = parseInt(count as string);
    const createdSessions = [];

    // Create sample sessions with different statuses
    const statuses = ['completed', 'completed', 'archived', 'archived', 'completed'];
    const dates = [
      new Date(Date.now() - 86400000 * 1), // 1 day ago
      new Date(Date.now() - 86400000 * 2), // 2 days ago
      new Date(Date.now() - 86400000 * 3), // 3 days ago
      new Date(Date.now() - 86400000 * 5), // 5 days ago
      new Date(Date.now() - 86400000 * 7), // 7 days ago
    ];

    for (let i = 0; i < sessionCount; i++) {
      const date = dates[i];
      const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
      const batchName = `Batch-${dateStr}-${String(i + 1).padStart(3, '0')}`;
      const status = statuses[i];

      // Create session
      const session = await prisma.processingSession.create({
        data: {
          basketId: id,
          batchName,
          status: status as any,
          publishMode: 'manual',
          fileCount: 0,
          totalSize: 0,
          startedAt: date,
          completedAt: status !== 'active' ? new Date(date.getTime() + 3600000) : null,
          archivedAt: status === 'archived' ? new Date(date.getTime() + 7200000) : null,
        }
      });

      // Create session directory
      const sessionPath = path.join(basket.path, 'sessions', batchName);
      fs.mkdirSync(sessionPath, { recursive: true });

      // Create sample files (5-15 files per session)
      const fileCount = Math.floor(Math.random() * 10) + 5;
      let totalSize = 0;
      const sampleFiles: Array<{ id: string; basketId: string; sessionId: string; fileName: string; originalName: string; path: string; size: number; mimeType: string; status: string; createdAt: Date; processedAt: Date | null }> = [];

      const fileTypes = [
        { ext: 'pdf', mime: 'application/pdf', name: 'Report' },
        { ext: 'csv', mime: 'text/csv', name: 'Data' },
        { ext: 'json', mime: 'application/json', name: 'Config' },
        { ext: 'txt', mime: 'text/plain', name: 'Log' },
        { ext: 'xml', mime: 'application/xml', name: 'Export' },
      ];

      for (let j = 0; j < fileCount; j++) {
        const fileType = fileTypes[Math.floor(Math.random() * fileTypes.length)];
        const fileId = `file-${Date.now()}-${i}-${j}`;
        const originalName = `${fileType.name}_${String(j + 1).padStart(3, '0')}_${dateStr}.${fileType.ext}`;
        const filePath = path.join(sessionPath, `${fileId}_${originalName}`);

        // Create sample file content
        const content = generateSampleContent(fileType.ext, j);
        fs.writeFileSync(filePath, content);
        const stats = fs.statSync(filePath);

        const basketFile = await prisma.basketFile.create({
          data: {
            id: fileId,
            basketId: id,
            sessionId: session.id,
            fileName: `${fileId}_${originalName}`,
            originalName,
            path: filePath,
            size: stats.size,
            mimeType: fileType.mime,
            status: 'processed',
            createdAt: date,
            processedAt: new Date(date.getTime() + 1000 * j),
          }
        });

        totalSize += stats.size;
        sampleFiles.push(basketFile as any);
      }

      // Update session with file count and size
      await prisma.processingSession.update({
        where: { id: session.id },
        data: { fileCount, totalSize }
      });

      // Create archive for archived sessions
      if (status === 'archived') {
        const archiveDir = path.join(basket.path, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, `${batchName}.zip`);

        const archive = archiver('zip', { zlib: { level: 6 } });
        const output = fs.createWriteStream(archivePath);

        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve);
          archive.on('error', reject);
          archive.pipe(output);

          for (const file of sampleFiles) {
            if (fs.existsSync(file.path)) {
              archive.file(file.path, { name: file.fileName });
            }
          }

          archive.finalize();
        });

        const archiveStats = fs.statSync(archivePath);
        await prisma.processingSession.update({
          where: { id: session.id },
          data: { archivePath, archiveSize: archiveStats.size }
        });
      }

      // Create logs for the session
      await prisma.sessionLog.create({
        data: {
          sessionId: session.id,
          type: 'session_created',
          message: `Session ${batchName} created`,
          fileCount: 0,
          createdAt: date,
        }
      });

      await prisma.sessionLog.create({
        data: {
          sessionId: session.id,
          type: 'session_completed',
          message: `Session ${batchName} completed with ${fileCount} files`,
          fileCount,
          createdAt: new Date(date.getTime() + 3600000),
        }
      });

      if (status === 'archived') {
        await prisma.sessionLog.create({
          data: {
            sessionId: session.id,
            type: 'archive_created',
            message: `Session archived to ${batchName}.zip`,
            fileCount,
            createdAt: new Date(date.getTime() + 7200000),
          }
        });
      }

      createdSessions.push({
        ...session,
        fileCount,
        totalSize,
      });
    }

    res.json({
      success: true,
      message: `Created ${sessionCount} sample sessions`,
      data: createdSessions
    });
  } catch (error) {
    console.error('Error seeding data:', error);
    res.status(500).json({ success: false, error: 'Failed to seed data' });
  }
});

// Helper to generate sample content
function generateSampleContent(ext: string, index: number): string {
  switch (ext) {
    case 'json':
      return JSON.stringify({
        id: index,
        timestamp: new Date().toISOString(),
        data: {
          records: Math.floor(Math.random() * 1000),
          status: 'processed',
          batch: index,
        },
        metadata: {
          source: 'demo-system',
          version: '1.0.0',
        }
      }, null, 2);

    case 'csv':
      return `id,name,value,date
${index},Record-${index},${Math.floor(Math.random() * 1000)},${new Date().toISOString().split('T')[0]}
${index + 1},Record-${index + 1},${Math.floor(Math.random() * 1000)},${new Date().toISOString().split('T')[0]}
${index + 2},Record-${index + 2},${Math.floor(Math.random() * 1000)},${new Date().toISOString().split('T')[0]}`;

    case 'xml':
      return `<?xml version="1.0" encoding="UTF-8"?>
<export>
  <batch id="${index}">
    <timestamp>${new Date().toISOString()}</timestamp>
    <records>${Math.floor(Math.random() * 1000)}</records>
    <status>completed</status>
  </batch>
</export>`;

    case 'txt':
      return `Processing Log - Batch ${index}
===============================
Date: ${new Date().toISOString()}
Status: Completed
Records Processed: ${Math.floor(Math.random() * 1000)}
Errors: 0
Duration: ${Math.floor(Math.random() * 60)} seconds

All files processed successfully.`;

    case 'pdf':
      // For PDF, just create a text representation (real PDF would need PDF library)
      return `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj

4 0 obj
<<
/Length 44
>>
stream
BT
/F1 12 Tf
100 700 Td
(Report ${index} - Demo PDF) Tj
ET
endstream
endobj

xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 

trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
310
%%EOF`;

    default:
      return `Sample content for file ${index} generated at ${new Date().toISOString()}`;
  }
}

export default router;
