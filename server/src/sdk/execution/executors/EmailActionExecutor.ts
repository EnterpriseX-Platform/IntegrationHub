// Email Action Executor - Send email through an SMTP connection
//
// Node data:
//   connectionId   SMTP connection (host/port/secure/username/password/from)
//   to, cc, bcc    comma/semicolon separated, {{templates}} allowed
//   subject, body  {{templates}} allowed; bodyFormat 'text' | 'html'
//   attachments    one path or {{template}} per line. A template may resolve to a
//                  path, an array of paths, or objects carrying path/localPath/filePath
//                  (e.g. the files an sftp-action / file-write node produced)
//   zipAttachments pack every attachment into one zip, zipPassword encrypts it (AES-256)
//   maxAttachmentMB refuse to send when attachments exceed this (default 20)

import fs from 'fs';
import os from 'os';
import path from 'path';
import nodemailer from 'nodemailer';
import archiver from 'archiver';
import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { prisma } from '../../../lib/prisma';

let zipEncryptableRegistered = false;
function registerZipEncryptable() {
  if (zipEncryptableRegistered) return;
  try {
    archiver.registerFormat('zip-encryptable', require('archiver-zip-encryptable'));
  } catch {
    // already registered elsewhere (routes/apiKeys.ts registers it at load)
  }
  zipEncryptableRegistered = true;
}

interface EmailActionData {
  connectionId?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyFormat?: 'text' | 'html';
  attachments?: string;
  zipAttachments?: boolean;
  zipName?: string;
  zipPassword?: string;
  maxAttachmentMB?: number;
}

function splitAddresses(value: string): string[] {
  return value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Flatten whatever a template resolved to into file paths. */
function collectPaths(value: unknown, out: string[]) {
  if (value == null) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return;
    // A template that resolved to an object/array arrives JSON-stringified
    if ((s.startsWith('[') || s.startsWith('{'))) {
      try { collectPaths(JSON.parse(s), out); return; } catch { /* plain path */ }
    }
    out.push(s);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v) => collectPaths(v, out)); return; }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const p = o.localPath ?? o.filePath ?? o.path;
    if (typeof p === 'string') { out.push(p); return; }
    if (Array.isArray(o.files)) collectPaths(o.files, out);
  }
}

export class EmailActionExecutor extends NodeExecutor {
  readonly type = 'email-action';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as EmailActionData;

    if (!data.connectionId) throw new Error('Email action: select an SMTP connection');
    const connection = await prisma.connection.findUnique({ where: { id: data.connectionId } });
    if (!connection) throw new Error(`Email action: connection not found (${data.connectionId})`);
    if (connection.type !== 'smtp') throw new Error(`Email action: "${connection.name}" is not an SMTP connection`);
    const config: any = typeof connection.config === 'string' ? JSON.parse(connection.config) : (connection.config || {});

    const to = splitAddresses(this.resolveTemplate(data.to || '', context));
    if (!to.length) {
      // No recipient configured yet (e.g. a flow set up before the mailing list is agreed):
      // skip quietly instead of failing the whole run after its real work is done.
      this.log(context, 'warn', 'Email skipped: no recipient (To) configured');
      return { status: 'skipped', reason: 'no recipient', subject: this.resolveTemplate(data.subject || '', context) };
    }
    const cc = splitAddresses(this.resolveTemplate(data.cc || '', context));
    const bcc = splitAddresses(this.resolveTemplate(data.bcc || '', context));
    const subject = this.resolveTemplate(data.subject || '', context);
    const body = this.resolveTemplate(data.body || '', context);

    // Attachments
    const paths: string[] = [];
    for (const line of (data.attachments || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      // A line that is a single {{template}} resolves to the raw value (path, array or object)
      collectPaths(this.resolveTemplate(line, context), paths);
    }
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`Email action: attachment not found: ${p}`);
    }

    const tempFiles: string[] = [];
    try {
      let attachments: { filename: string; path: string }[] = paths.map((p) => ({ filename: path.basename(p), path: p }));

      if (data.zipAttachments && attachments.length) {
        const zipName = (this.resolveTemplate(data.zipName || '', context) || 'attachments').replace(/\.zip$/i, '') + '.zip';
        const password = this.resolveTemplate(data.zipPassword || '', context);
        const zipPath = path.join(os.tmpdir(), `email-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        tempFiles.push(zipPath);
        await this.zip(attachments, zipPath, password);
        attachments = [{ filename: zipName, path: zipPath }];
        this.log(context, 'info', `Zipped ${paths.length} file(s) into ${zipName}${password ? ' (password protected)' : ''}`);
      }

      const totalBytes = attachments.reduce((n, a) => n + fs.statSync(a.path).size, 0);
      const maxMB = data.maxAttachmentMB ?? 20;
      if (totalBytes > maxMB * 1024 * 1024) {
        throw new Error(`Email action: attachments are ${(totalBytes / 1048576).toFixed(1)} MB, over the ${maxMB} MB limit. Send a link instead, or raise "Max attachment size" if the mail server accepts it.`);
      }

      const transporter = nodemailer.createTransport({
        host: config.host,
        port: Number(config.port) || 587,
        secure: config.secure === true || config.secure === 'true' || Number(config.port) === 465,
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
        tls: config.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
        // An SMTP relay sometimes takes 20+ s to greet; another service
        // uses 60 s timeouts plus retries against it for the same reason.
        connectionTimeout: 60000,
        greetingTimeout: 60000,
        socketTimeout: 60000,
      });

      const from = config.fromName ? `"${config.fromName}" <${config.fromAddress || config.username}>` : (config.fromAddress || config.username);
      const message = {
        from,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject,
        ...(data.bodyFormat === 'html' ? { html: body } : { text: body }),
        attachments,
      };
      // Retry connection-level failures (slow greeting, timeout, refused); a rejected
      // recipient or message is final and is not retried.
      let info: any;
      for (let attempt = 1; ; attempt++) {
        try {
          info = await transporter.sendMail(message);
          break;
        } catch (err: any) {
          const transient = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED'].includes(err?.code)
            || /greeting never received|timeout/i.test(err?.message || '');
          if (!transient || attempt >= 3) throw err;
          this.log(context, 'warn', `Mail server did not answer (${err.message}); retry ${attempt}/2 in 10 s`);
          await new Promise((r) => setTimeout(r, 10000));
        }
      }

      this.log(context, 'info', `Email sent to ${to.join(', ')} (${info.messageId})`);
      return {
        to, cc, bcc, subject,
        attachments: attachments.map((a) => a.filename),
        attachmentBytes: totalBytes,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        status: 'sent',
        sentAt: new Date().toISOString(),
      };
    } finally {
      for (const f of tempFiles) fs.promises.unlink(f).catch(() => {});
    }
  }

  private zip(files: { filename: string; path: string }[], dest: string, password: string): Promise<void> {
    if (password) registerZipEncryptable();
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(dest);
      const archive = password
        ? archiver('zip-encryptable' as any, { zlib: { level: 9 }, forceLocalTime: true, password } as any)
        : archiver('zip', { zlib: { level: 9 } });
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(output);
      for (const f of files) archive.file(f.path, { name: f.filename });
      archive.finalize();
    });
  }
}
