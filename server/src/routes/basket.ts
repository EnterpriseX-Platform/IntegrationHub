import { Router, Request, Response } from 'express';
import { adminOnly } from '../lib/access';
import { prisma } from '../lib/prisma';
import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const router = Router();

// Legacy global basket directory — admin only
router.use(adminOnly);

// Basket directory for temporary file storage
const BASKET_DIR = process.env.BASKET_DIR || './basket';

// Ensure basket directory exists
if (!fs.existsSync(BASKET_DIR)) {
  fs.mkdirSync(BASKET_DIR, { recursive: true });
}

// GET /api/basket/files - List files in basket
router.get('/files', async (_req: Request, res: Response) => {
  try {
    const files = await prisma.fileUpload.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: files,
    });
  } catch (error) {
    console.error('Error fetching basket files:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch basket files',
    });
  }
});

// POST /api/basket/upload - Upload file to basket
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const { filename, content, contentType = 'application/octet-stream' } = req.body;

    if (!filename || !content) {
      res.status(400).json({
        success: false,
        error: 'Filename and content are required',
      });
      return;
    }

    // Save file to basket directory
    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const filePath = path.join(BASKET_DIR, `${fileId}_${filename}`);
    const buffer = Buffer.from(content, 'base64');
    
    fs.writeFileSync(filePath, buffer);

    // Save to database
    const fileUpload = await prisma.fileUpload.create({
      data: {
        id: fileId,
        fileName: filename,
        originalName: filename,
        path: filePath,
        size: buffer.length,
        mimeType: contentType,
        status: 'pending',
      },
    });

    res.json({
      success: true,
      data: fileUpload,
      message: 'File uploaded to basket successfully',
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload file',
    });
  }
});

// POST /api/basket/transfer - Transfer file to SFTP
router.post('/transfer/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { sftpHost, sftpPort, sftpUser, sftpPass, remotePath } = req.body;

  try {
    const fileUpload = await prisma.fileUpload.findUnique({
      where: { id },
    });

    if (!fileUpload) {
      res.status(404).json({
        success: false,
        error: 'File not found',
      });
      return;
    }

    // Update status to transferring
    await prisma.fileUpload.update({
      where: { id },
      data: { status: 'transferring' },
    });

    // Transfer to SFTP
    const result = await transferToSFTP(
      fileUpload.path,
      sftpHost || 'localhost',
      sftpPort || 2222,
      sftpUser || 'dga',
      sftpPass || 'dga123',
      remotePath || '/upload/incoming'
    );

    // Update status
    await prisma.fileUpload.update({
      where: { id },
      data: {
        status: result.success ? 'transferred' : 'failed',
      },
    });

    res.json({
      success: result.success,
      message: result.success ? 'File transferred successfully' : 'Transfer failed',
      error: result.error,
    });
  } catch (error) {
    console.error('Error transferring file:', error);
    
    await prisma.fileUpload.update({
      where: { id },
      data: {
        status: 'failed',
      },
    });

    res.status(500).json({
      success: false,
      error: 'Failed to transfer file',
    });
  }
});

// Function to transfer file via SFTP
async function transferToSFTP(
  localPath: string,
  host: string,
  port: number,
  username: string,
  password: string,
  remotePath: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return resolve({ success: false, error: `SFTP error: ${err.message}` });
        }

        const remoteFileName = path.join(remotePath, path.basename(localPath));
        
        sftp.fastPut(localPath, remoteFileName, (err) => {
          conn.end();
          
          if (err) {
            return resolve({ success: false, error: `Transfer error: ${err.message}` });
          }
          
          resolve({ success: true });
        });
      });
    });

    conn.on('error', (err) => {
      resolve({ success: false, error: `Connection error: ${err.message}` });
    });

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 20000,
    });
  });
}

// POST /api/basket/transfer-all - Transfer all pending files
router.post('/transfer-all', async (req: Request, res: Response) => {
  const { sftpHost, sftpPort, sftpUser, sftpPass, remotePath } = req.body;

  try {
    const pendingFiles = await prisma.fileUpload.findMany({
      where: { status: 'pending' },
    });

    const results = [];
    
    for (const file of pendingFiles) {
      try {
        await prisma.fileUpload.update({
          where: { id: file.id },
          data: { status: 'transferring' },
        });

        const result = await transferToSFTP(
          file.path,
          sftpHost || 'localhost',
          sftpPort || 2222,
          sftpUser || 'dga',
          sftpPass || 'dga123',
          remotePath || '/upload/incoming'
        );

        await prisma.fileUpload.update({
          where: { id: file.id },
          data: {
            status: result.success ? 'transferred' : 'failed',
          },
        });

        results.push({
          fileId: file.id,
          fileName: file.fileName,
          success: result.success,
          error: result.error,
        } as any);
      } catch (error) {
        results.push({
          fileId: file.id,
          fileName: file.fileName,
          success: false,
          error: (error as Error).message,
        } as any);
      }
    }

    res.json({
      success: true,
      data: results,
      message: `Processed ${results.length} files`,
    });
  } catch (error) {
    console.error('Error in batch transfer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process batch transfer',
    });
  }
});

export default router;
