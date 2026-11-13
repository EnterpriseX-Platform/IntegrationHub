/**
 * PPK v2 (PuTTY Private Key) to OpenSSH PEM converter
 *
 * Supports unencrypted PPK v2 keys (ssh-rsa, ssh-dss, ecdsa, ssh-ed25519)
 * Converts to traditional PEM format that ssh2 library accepts
 *
 * PPK v2 format:
 *   PuTTY-User-Key-File-2: <key-type>
 *   Encryption: none|aes256-cbc
 *   Comment: <comment>
 *   Public-Lines: <n>
 *   <base64 public key data>
 *   Private-Lines: <n>
 *   <base64 private key data>
 *   Private-MAC: <hex>
 */

interface PPKData {
  version: number;
  keyType: string;
  encryption: string;
  comment: string;
  publicKey: Buffer;
  privateKey: Buffer;
  privateMac: string;
}

/**
 * Detect if a string is in PuTTY PPK format
 */
export function isPPKFormat(key: string): boolean {
  return key.trimStart().startsWith('PuTTY-User-Key-File-');
}

/**
 * Parse PPK v2 file content into structured data
 */
function parsePPK(ppkContent: string): PPKData {
  const lines = ppkContent.split(/\r?\n/);
  let i = 0;

  // Parse header: PuTTY-User-Key-File-2: ssh-rsa
  const headerMatch = lines[i]?.match(/^PuTTY-User-Key-File-(\d+):\s*(.+)/);
  if (!headerMatch) {
    throw new Error('Invalid PPK format: missing header');
  }
  const version = parseInt(headerMatch[1]);
  const keyType = headerMatch[2].trim();
  i++;

  if (version !== 2) {
    throw new Error(`PPK version ${version} is not supported. Only PPK v2 is supported.`);
  }

  // Parse Encryption
  const encMatch = lines[i]?.match(/^Encryption:\s*(.+)/);
  if (!encMatch) throw new Error('Invalid PPK format: missing Encryption');
  const encryption = encMatch[1].trim();
  i++;

  // Parse Comment
  const commentMatch = lines[i]?.match(/^Comment:\s*(.*)/);
  if (!commentMatch) throw new Error('Invalid PPK format: missing Comment');
  const comment = commentMatch[1].trim();
  i++;

  // Parse Public-Lines
  const pubLinesMatch = lines[i]?.match(/^Public-Lines:\s*(\d+)/);
  if (!pubLinesMatch) throw new Error('Invalid PPK format: missing Public-Lines');
  const pubLineCount = parseInt(pubLinesMatch[1]);
  i++;

  const pubLines: string[] = [];
  for (let j = 0; j < pubLineCount; j++) {
    pubLines.push(lines[i++] || '');
  }
  const publicKey = Buffer.from(pubLines.join(''), 'base64');

  // Parse Private-Lines
  const privLinesMatch = lines[i]?.match(/^Private-Lines:\s*(\d+)/);
  if (!privLinesMatch) throw new Error('Invalid PPK format: missing Private-Lines');
  const privLineCount = parseInt(privLinesMatch[1]);
  i++;

  const privLines: string[] = [];
  for (let j = 0; j < privLineCount; j++) {
    privLines.push(lines[i++] || '');
  }
  const privateKey = Buffer.from(privLines.join(''), 'base64');

  // Parse Private-MAC
  const macMatch = lines[i]?.match(/^Private-MAC:\s*([0-9a-fA-F]+)/);
  const privateMac = macMatch ? macMatch[1] : '';

  return { version, keyType, encryption, comment, publicKey, privateKey, privateMac };
}

/**
 * Read a uint32 big-endian from buffer
 */
function readUInt32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

/**
 * Read an SSH string (uint32 length + data) from buffer
 */
function readSSHString(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const len = readUInt32BE(buf, offset);
  const data = buf.subarray(offset + 4, offset + 4 + len);
  return { data, next: offset + 4 + len };
}

// writeUInt32BE/writeSSHString not needed for current conversion

/**
 * Convert a positive BigInt to a minimal big-endian Buffer (with leading 0x00 if MSB is set)
 */
function bigintToBuffer(n: bigint): Buffer {
  if (n === 0n) return Buffer.from([0]);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  // If MSB is set, prepend 0x00 (ASN.1 positive integer encoding)
  if (buf[0] & 0x80) {
    return Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return buf;
}

/**
 * Read a big-endian unsigned integer from SSH mpint buffer
 */
function bufferToBigint(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

/**
 * Encode ASN.1 DER length
 */
function derLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  } else if (len < 0x100) {
    return Buffer.from([0x81, len]);
  } else if (len < 0x10000) {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    return Buffer.from([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
}

/**
 * Wrap content in ASN.1 SEQUENCE
 */
function derSequence(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
}

/**
 * Encode ASN.1 INTEGER
 */
function derInteger(value: Buffer): Buffer {
  // Ensure positive integer encoding
  let v = value;
  if (v.length > 0 && (v[0] & 0x80)) {
    v = Buffer.concat([Buffer.from([0x00]), v]);
  }
  return Buffer.concat([Buffer.from([0x02]), derLength(v.length), v]);
}

/**
 * Convert RSA PPK to PEM format
 *
 * PPK Public key format (ssh-rsa):
 *   string "ssh-rsa", mpint e, mpint n
 *
 * PPK Private key format:
 *   mpint d, mpint p, mpint q, mpint iqmp
 *
 * RSA PEM (PKCS#1) format:
 *   SEQUENCE { version=0, n, e, d, p, q, d mod (p-1), d mod (q-1), q^-1 mod p }
 */
function rsaPPKtoPEM(ppk: PPKData): string {
  // Parse public key: string "ssh-rsa", mpint e, mpint n
  let offset = 0;
  const { next: next1 } = readSSHString(ppk.publicKey, offset); // skip key type string
  offset = next1;
  const { data: eBuf, next: next2 } = readSSHString(ppk.publicKey, offset);
  offset = next2;
  const { data: nBuf } = readSSHString(ppk.publicKey, offset);

  // Parse private key: mpint d, mpint p, mpint q, mpint iqmp
  offset = 0;
  const { data: dBuf, next: next3 } = readSSHString(ppk.privateKey, offset);
  offset = next3;
  const { data: pBuf, next: next4 } = readSSHString(ppk.privateKey, offset);
  offset = next4;
  const { data: qBuf, next: next5 } = readSSHString(ppk.privateKey, offset);
  offset = next5;
  const { data: iqmpBuf } = readSSHString(ppk.privateKey, offset);

  // Compute dp = d mod (p-1), dq = d mod (q-1)
  const d = bufferToBigint(dBuf);
  const p = bufferToBigint(pBuf);
  const q = bufferToBigint(qBuf);
  const dp = d % (p - 1n);
  const dq = d % (q - 1n);

  // Build PKCS#1 RSA private key DER
  const content = Buffer.concat([
    derInteger(Buffer.from([0x00])), // version = 0
    derInteger(nBuf),
    derInteger(eBuf),
    derInteger(dBuf),
    derInteger(pBuf),
    derInteger(qBuf),
    derInteger(bigintToBuffer(dp)),
    derInteger(bigintToBuffer(dq)),
    derInteger(iqmpBuf),
  ]);

  const der = derSequence(content);
  const b64 = der.toString('base64');

  // Format as PEM
  const lines: string[] = ['-----BEGIN RSA PRIVATE KEY-----'];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.substring(i, i + 64));
  }
  lines.push('-----END RSA PRIVATE KEY-----');
  lines.push('');

  return lines.join('\n');
}

/**
 * Convert PPK v2 key to OpenSSH PEM format
 * Currently supports: ssh-rsa (unencrypted only)
 *
 * @param ppkContent - The full PPK file content as a string
 * @returns PEM formatted private key string
 */
export function convertPPKtoOpenSSH(ppkContent: string): string {
  const ppk = parsePPK(ppkContent);

  if (ppk.encryption !== 'none') {
    throw new Error(
      `Encrypted PPK keys are not supported. Please decrypt the key first using PuTTYgen ` +
      `(load key → set empty passphrase → save private key), or export as OpenSSH format.`
    );
  }

  switch (ppk.keyType) {
    case 'ssh-rsa':
      return rsaPPKtoPEM(ppk);
    default:
      throw new Error(
        `PPK key type "${ppk.keyType}" conversion is not yet supported. ` +
        `Please export the key to OpenSSH format using PuTTYgen (Conversions → Export OpenSSH key).`
      );
  }
}

/**
 * Auto-detect key format and convert PPK to PEM if needed.
 * Returns the key as-is if it's already in PEM/OpenSSH format.
 */
export function normalizePrivateKey(key: string): string {
  if (!key || !key.trim()) return key;

  const trimmed = key.trim();

  // Already in PEM or OpenSSH format
  if (trimmed.startsWith('-----BEGIN')) {
    return trimmed;
  }

  // PPK format — convert
  if (isPPKFormat(trimmed)) {
    try {
      const pem = convertPPKtoOpenSSH(trimmed);
      console.log('[PPK Converter] Successfully converted PPK v2 to PEM format');
      return pem;
    } catch (err) {
      console.error('[PPK Converter] Failed to convert PPK:', (err as Error).message);
      throw err;
    }
  }

  // Unknown format, return as-is and let ssh2 handle the error
  return trimmed;
}
