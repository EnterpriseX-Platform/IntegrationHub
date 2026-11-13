import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Accept an upload sent the way another app sends one: the file as base64 in a
 * `text/plain` body, and every other field (fileName included) as base64url
 * JSON in the `meta` query parameter.
 *
 * Cloudflare's WAF in front of the production host answers multipart bodies
 * whose file bytes look suspicious (xlsx, zip) with 403 "Attention Required"
 * before they reach us; a pure-base64 body passes. Thai text in a query string
 * can trip it too, hence the encoded `meta`.
 *
 * Mount after `upload.single(...)`: a multipart request already has `req.file`
 * and is left alone. The decoded file is written to `dir` and `req.file` /
 * `req.body` are filled the way multer's disk storage fills them, so the route
 * behind works unchanged for both kinds of request.
 */
export function base64Upload(dir: string, allowedExt?: string[]): RequestHandler[] {
  const parseText = express.text({ type: 'text/plain', limit: '100mb' });

  const toFile = (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).file || typeof req.body !== 'string') return next();

    let fields: Record<string, any> = {};
    try {
      if (req.query.meta) fields = JSON.parse(Buffer.from(String(req.query.meta), 'base64url').toString('utf8'));
    } catch {
      res.status(400).json({ success: false, error: 'Invalid upload metadata' });
      return;
    }

    const originalname = path.basename(String(fields.fileName || 'upload'));
    const ext = path.extname(originalname).toLowerCase();
    if (allowedExt && !allowedExt.includes(ext)) {
      res.status(400).json({ success: false, error: `Unsupported file type: ${ext}` });
      return;
    }

    const buffer = Buffer.from(req.body.trim(), 'base64');
    // an empty body means the browser could not read the file (an old page
    // read big files into one string and got nothing): never store 0 bytes
    if (buffer.length === 0) {
      res.status(400).json({ success: false, error: 'The file arrived empty. Refresh the page (Ctrl+F5) and upload again.' });
      return;
    }
    const filename = crypto.randomBytes(16).toString('hex');
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);

    (req as any).file = {
      fieldname: 'file',
      originalname,
      encoding: '7bit',
      mimetype: fields.fileType || 'application/octet-stream',
      destination: dir,
      filename,
      path: filePath,
      size: buffer.length,
    };
    delete fields.fileName;
    delete fields.fileType;
    req.body = fields;
    next();
  };

  return [parseText, toFile];
}
