import crypto from 'crypto';

// RSA keys for the Secrets Vault. Public keys are stored as SPKI PEM and
// private keys as unencrypted PKCS#8 PEM: flows decrypt unattended, so a
// passphrase is only used to unlock a key while importing it.

/** Parse an OpenSSH `ssh-rsa AAAA... comment` line into a KeyObject. */
function parseOpenSshRsa(line: string): crypto.KeyObject {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] || '', 'base64');
  let off = 0;
  const next = () => {
    const len = blob.readUInt32BE(off);
    off += 4;
    const v = blob.subarray(off, off + len);
    off += len;
    return v;
  };
  if (next().toString() !== 'ssh-rsa') throw new Error('Not an ssh-rsa key');
  const e = next();
  const n = next();
  const b64url = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    return b.subarray(i).toString('base64url');
  };
  return crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' });
}

/**
 * Validate an RSA public key and return it as SPKI PEM.
 * Accepts SPKI PEM, PKCS#1 PEM (BEGIN RSA PUBLIC KEY), X.509 certificate PEM
 * and OpenSSH `ssh-rsa` lines. Rejects private keys and non-RSA keys.
 */
export function normalizeRsaPublicKey(input: string): string {
  const text = input.trim();
  if (/PRIVATE KEY-----/.test(text)) {
    throw new Error('This is a private key — paste it in the Private Key field');
  }
  let key: crypto.KeyObject;
  if (text.startsWith('ssh-rsa ')) {
    key = parseOpenSshRsa(text);
  } else if (text.includes('BEGIN CERTIFICATE')) {
    key = new crypto.X509Certificate(text).publicKey;
  } else {
    key = crypto.createPublicKey(text);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Expected an RSA key, got ${key.asymmetricKeyType?.toUpperCase() || 'unknown'}`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength || 0;
  if (bits < 2048) throw new Error(`RSA key is ${bits} bits; at least 2048 is required`);
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Validate an RSA private key (PKCS#1 or PKCS#8, optionally passphrase-protected)
 * and return it as unencrypted PKCS#8 PEM.
 */
export function normalizeRsaPrivateKey(input: string, passphrase?: string): string {
  const text = input.trim();
  const isEncrypted = /ENCRYPTED/.test(text);
  if (isEncrypted && !passphrase) {
    throw new Error('Private key is passphrase-protected — enter its passphrase');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(isEncrypted ? { key: text, passphrase } : text);
  } catch (err: any) {
    if (isEncrypted) throw new Error('Wrong passphrase for the private key');
    throw err;
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Expected an RSA key, got ${key.asymmetricKeyType?.toUpperCase() || 'unknown'}`);
  }
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** True when the private key belongs to the public key. */
export function rsaKeysMatch(publicPem: string, privatePem: string): boolean {
  const fromPrivate = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'der' });
  const given = crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return fromPrivate.equals(given);
}

/**
 * Load a stored RSA private key for decryption. Keys generated before
 * passphrases were dropped are still encrypted PEM and need the passphrase.
 */
export function loadRsaPrivateKey(pem: string | null | undefined, passphrase?: string): crypto.KeyObject {
  if (!pem) throw new Error('This RSA key has no private key — import one to decrypt');
  if (/ENCRYPTED/.test(pem)) {
    if (!passphrase) {
      throw new Error('RSA private key is passphrase-protected — re-import it with its passphrase in Secrets Vault');
    }
    return crypto.createPrivateKey({ key: pem, passphrase });
  }
  return crypto.createPrivateKey(pem);
}
