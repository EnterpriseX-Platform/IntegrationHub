// Mask / preserve cleartext secrets inside a connection `config` blob.
//
// `config` (DB String column) holds SFTP/DB passwords, API keys, private keys,
// OAuth tokens, etc. We must never send those to the client, but the edit form
// still needs to round-trip a connection: so we MASK secrets on every response
// and, on update, PRESERVE the stored secret whenever the incoming value is left
// blank (the form sends "" for "unchanged").
//
// NOTE: this only sanitizes HTTP responses. Server-side flow execution reads the
// real config straight from the DB, so SFTP/DB connectivity is unaffected.

export const SECRET_KEYS = [
  'password',
  'privateKey',
  'passphrase',
  'token',
  'apiKey',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'serviceAccountKey',
  'secret',
];

function isSecretKey(k: string): boolean {
  return SECRET_KEYS.includes(k);
}

function maskObj(o: any): any {
  if (Array.isArray(o)) return o.map(maskObj);
  if (o && typeof o === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (isSecretKey(k) && typeof v === 'string' && v !== '') out[k] = '';
      else out[k] = maskObj(v);
    }
    return out;
  }
  return o;
}

// Mask secrets. Accepts a JSON string or an object; returns the SAME shape
// (string in → string out) so response formats are unchanged.
export function maskConfig(config: any): any {
  if (config == null) return config;
  if (typeof config === 'string') {
    try {
      return JSON.stringify(maskObj(JSON.parse(config)));
    } catch {
      return config;
    }
  }
  return maskObj(config);
}

function toObj(v: any): any {
  if (v == null) return {};
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v;
}

function mergeObj(inc: any, ex: any): any {
  if (inc && typeof inc === 'object' && !Array.isArray(inc)) {
    const exo = ex && typeof ex === 'object' && !Array.isArray(ex) ? ex : {};
    const out: any = { ...inc };
    for (const k of Object.keys(inc)) {
      if (isSecretKey(k)) {
        const v = inc[k];
        if ((v === '' || v === undefined || v === null) && exo[k] !== undefined && exo[k] !== '') {
          out[k] = exo[k]; // keep the existing secret when the form left it blank
        }
      } else if (inc[k] && typeof inc[k] === 'object') {
        out[k] = mergeObj(inc[k], exo[k]);
      }
    }
    return out;
  }
  return inc;
}

// For update: keep existing secret values wherever the incoming config leaves a
// secret field blank. Accepts string|object for both; returns a plain object.
export function mergeSecrets(incoming: any, existing: any): any {
  return mergeObj(toObj(incoming), toObj(existing));
}
