// Cloudflare's WAF in front of the production host answers multipart uploads
// whose file bytes look suspicious (xlsx, zip) with 403 "Attention Required",
// so the request never reaches the server. Upload the way another app does: the
// file as base64 in a text/plain body, and every other field (file name
// included, it may be Thai) as base64url JSON in the `meta` query parameter.
// The server side is middleware/base64Upload.ts.

export const UPLOAD_B64_CONTENT_TYPE = 'text/plain;charset=UTF-8';

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '').split(',', 2)[1] || '';
      // a browser that cannot hold the whole file as one string hands back
      // nothing; sending that would store a 0-byte file on the server
      if (!b64 && file.size > 0) reject(new Error('The browser could not read this file (too large to read at once)'));
      else resolve(b64);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `url` with the file name and the other form fields packed into `?meta=`. */
export function uploadB64Url(url: string, file: File, fields: Record<string, string | undefined> = {}): string {
  const meta: Record<string, string> = { fileName: file.name, fileType: file.type || 'application/octet-stream' };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) meta[k] = v;
  return `${url}${url.includes('?') ? '&' : '?'}meta=${toBase64Url(JSON.stringify(meta))}`;
}

// Cloudflare and the server reject bodies over ~100 MB. Files above this size
// go to `<url>/chunk` in pieces (server: routes/baskets.ts, files/chunk).
export const CHUNK_UPLOAD_THRESHOLD = 20 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

function errorFrom(xhr: XMLHttpRequest): Error {
  let msg = `HTTP ${xhr.status}`;
  try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* non-JSON, e.g. a WAF page */ }
  if (xhr.status === 413) msg = 'File too large for a single request (HTTP 413)';
  return new Error(msg);
}

function postB64(url: string, body: string, headers: Record<string, string>, onProgress?: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', UPLOAD_B64_CONTENT_TYPE);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); });
    xhr.addEventListener('load', () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.responseText) : reject(errorFrom(xhr))));
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(body);
  });
}

/**
 * Upload `file` to a basket files endpoint (`.../baskets/:id/files`), whole if
 * small, in 8 MB chunks if large. `onProgress` gets 0..100.
 */
export async function uploadFileB64(
  url: string,
  file: File,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
  onProgress?: (percent: number) => void,
): Promise<string> {
  if (file.size <= CHUNK_UPLOAD_THRESHOLD) {
    const body = await fileToBase64(file);
    return postB64(uploadB64Url(url, file, fields), body, headers, (f) => onProgress?.(Math.round(f * 100)));
  }
  const total = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  const [base, query] = url.split('?');
  const chunkUrl = `${base}/chunk${query ? `?${query}` : ''}`;
  let last = '';
  for (let index = 0; index < total; index++) {
    const start = index * CHUNK_SIZE;
    const body = await fileToBase64(file.slice(start, start + CHUNK_SIZE));
    const meta = { ...fields, uploadId, index: String(index), total: String(total), offset: String(start) };
    let attempt = 0;
    for (;;) {
      try {
        last = await postB64(uploadB64Url(chunkUrl, file, meta), body, headers, (f) =>
          onProgress?.(Math.min(99, Math.round(((start + f * Math.min(CHUNK_SIZE, file.size - start)) / file.size) * 100))));
        break;
      } catch (e) {
        if (++attempt >= 3 || (e instanceof Error && /out of order|Invalid|expired/.test(e.message))) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  onProgress?.(100);
  return last;
}
