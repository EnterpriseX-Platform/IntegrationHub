// Decrypt a received file with a Secrets Vault key — our own key pair, whose
// public half the partner used to encrypt. Files that are not encrypted are
// left alone, so a partner can switch to encryption without breaking the flow.

import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { loadRsaPrivateKey } from './rsaKeys';

const RSA_HYBRID_MAGIC = Buffer.from('RSAH');
const RSA_HYBRID_VERSION = 1;
const ENCRYPTED_EXT = /\.(enc|pgp|gpg)$/i;

export interface DecryptKey {
  name: string;
  algorithm: string | null;
  publicKey: string | null;
  secretKey: string | null;
}

function readHead(filePath: string, bytes: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Name of the decrypted file: drops a trailing .enc / .pgp / .gpg. */
export function decryptedName(fileName: string): string {
  return fileName.replace(ENCRYPTED_EXT, '') || fileName;
}

/** Whether the file is encrypted in a format this key can decrypt. */
export function isEncryptedFor(filePath: string, fileName: string, algorithm: string): boolean {
  const head = readHead(filePath, 1100);
  if (algorithm === 'rsa') return head.subarray(0, 4).equals(RSA_HYBRID_MAGIC) || isJsonEnvelope(head) || isDotEnvelope(head);
  if (algorithm === 'pgp') {
    return /\.(pgp|gpg)$/i.test(fileName) || head.toString('latin1').startsWith('-----BEGIN PGP MESSAGE');
  }
  return false;
}

/**
 * JSON envelope (partner format, format "example-envelope-v1"):
 * { key_algorithm: RSA-OAEP, oaep_hash: SHA-256, content_algorithm: AES-256-GCM,
 *   encrypted_key, nonce, ciphertext, tag }, all base64.
 */
function isJsonEnvelope(head: Buffer): boolean {
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return text.startsWith('{') && /"(format|key_algorithm|encrypted_key)"/.test(text);
}

async function decryptJsonEnvelope(inPath: string, outPath: string, key: DecryptKey) {
  const env = JSON.parse(fs.readFileSync(inPath, 'utf8').replace(/^\uFEFF/, ''));
  for (const f of ['encrypted_key', 'nonce', 'ciphertext', 'tag']) {
    if (typeof env[f] !== 'string') throw new Error(`Envelope is missing "${f}"`);
  }
  if (env.content_algorithm && !/^AES-256-GCM$/i.test(env.content_algorithm)) {
    throw new Error(`Unsupported content_algorithm: ${env.content_algorithm}`);
  }
  const hash = String(env.oaep_hash || 'SHA-256').toLowerCase().replace('-', '');
  const aesKey = crypto.privateDecrypt(
    { key: loadRsaPrivateKey(key.secretKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash },
    Buffer.from(env.encrypted_key, 'base64')
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  fs.writeFileSync(outPath, Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]));
}

/**
 * Dot envelope (some partner files): three base64 parts joined by "."
 *   RSA-OAEP-SHA256(aesKey) . nonce(12) . AES-256-GCM ciphertext || tag(16)
 * Recognised from the head: an RSA-sized first part, then a 12-byte nonce.
 */
function isDotEnvelope(head: Buffer): boolean {
  const m = head.toString('latin1').replace(/^\uFEFF/, '').trimStart().match(/^([A-Za-z0-9+/]+=*)\.([A-Za-z0-9+/]+=*)\./);
  if (!m) return false;
  const keyBytes = Buffer.from(m[1], 'base64').length;
  return [128, 256, 384, 512].includes(keyBytes) && Buffer.from(m[2], 'base64').length === 12;
}

async function decryptDotEnvelope(inPath: string, outPath: string, key: DecryptKey) {
  const parts = fs.readFileSync(inPath, 'latin1').replace(/^\uFEFF/, '').trim().split('.');
  if (parts.length !== 3) throw new Error(`Expected 3 dot-separated parts, got ${parts.length}`);
  const [encKey, nonce, body] = parts.map((x) => Buffer.from(x, 'base64'));
  if (body.length < 16) throw new Error('Ciphertext is too short');
  const aesKey = crypto.privateDecrypt(
    { key: loadRsaPrivateKey(key.secretKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    encKey
  );
  const decipher = crypto.createDecipheriv(`aes-${aesKey.length * 8}-gcm` as crypto.CipherGCMTypes, aesKey, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  fs.writeFileSync(outPath, Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]));
}

/** RSA hybrid: [RSAH][ver][keyLen(2)][RSA-OAEP(aesKey)][iv(12)][AES-256-GCM data][tag(16)], streamed. */
async function decryptRsaHybrid(inPath: string, outPath: string, key: DecryptKey) {
  const size = fs.statSync(inPath).size;
  const head = readHead(inPath, 7 + 1024 + 12);
  if (head[4] !== RSA_HYBRID_VERSION) throw new Error(`Unsupported RSA hybrid format version: ${head[4]}`);
  const keyLen = head.readUInt16BE(5);
  if (keyLen === 0 || keyLen > 1024) throw new Error(`Invalid encrypted key length: ${keyLen}`);
  const encKey = head.subarray(7, 7 + keyLen);
  const iv = head.subarray(7 + keyLen, 7 + keyLen + 12);
  const dataStart = 7 + keyLen + 12;
  if (size < dataStart + 16) throw new Error('File is too short to be RSA-encrypted');

  const aesKey = crypto.privateDecrypt(
    { key: loadRsaPrivateKey(key.secretKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    encKey
  );
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(inPath, 'r');
  try { fs.readSync(fd, tag, 0, 16, size - 16); } finally { fs.closeSync(fd); }

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const input = size - 16 > dataStart
    ? fs.createReadStream(inPath, { start: dataStart, end: size - 17 })
    : Readable.from([]);
  await pipeline(input, decipher, fs.createWriteStream(outPath));
}

async function decryptPgp(inPath: string, outPath: string, key: DecryptKey) {
  const openpgp = await import('openpgp');
  if (!key.secretKey) throw new Error(`Key "${key.name}" has no private key`);
  let privateKey = await openpgp.readPrivateKey({ armoredKey: key.secretKey });
  if (!privateKey.isDecrypted()) privateKey = await openpgp.decryptKey({ privateKey, passphrase: '' });
  const raw = fs.readFileSync(inPath);
  const message = raw.toString('latin1').startsWith('-----BEGIN PGP MESSAGE')
    ? await openpgp.readMessage({ armoredMessage: raw.toString('utf8') })
    : await openpgp.readMessage({ binaryMessage: raw });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'binary' });
  fs.writeFileSync(outPath, data as Uint8Array);
}

/**
 * Decrypt `inPath` into `outPath` when it is encrypted for `key`; returns false
 * (and writes nothing) when the file is plain.
 */
export async function decryptIfEncrypted(inPath: string, outPath: string, fileName: string, key: DecryptKey): Promise<boolean> {
  const algorithm = key.algorithm || 'pgp';
  if (!isEncryptedFor(inPath, fileName, algorithm)) return false;
  const tmp = `${outPath}.dec`;
  try {
    if (algorithm === 'rsa' && isJsonEnvelope(readHead(inPath, 64))) await decryptJsonEnvelope(inPath, tmp, key);
    else if (algorithm === 'rsa' && isDotEnvelope(readHead(inPath, 1100))) await decryptDotEnvelope(inPath, tmp, key);
    else if (algorithm === 'rsa') await decryptRsaHybrid(inPath, tmp, key);
    else await decryptPgp(inPath, tmp, key);
    fs.renameSync(tmp, outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}
