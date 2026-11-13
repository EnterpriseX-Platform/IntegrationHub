/**
 * Safe HTTP header writer.
 *
 * Background: HTTP header values must be ASCII (ISO-8859-1 per RFC 7230).
 * Node's `res.setHeader` throws `ERR_INVALID_CHAR` if a value contains
 * any byte outside that range — including any Thai character.
 *
 * API flow execution (`routes/flows.ts`, `routes/public.ts`) forwards
 * arbitrary headers returned by the api-output executor to the response,
 * and a flow author may legitimately want a filename like "ข้อมูล.csv"
 * in `Content-Disposition`. Blindly forwarding crashes the response with
 * a 500 before the body even starts.
 *
 * This helper writes the header safely:
 *   - Drops header names that contain non-token bytes (defensive)
 *   - For `Content-Disposition`: if the legacy `filename="..."` contains
 *     non-ASCII bytes, replace it with `filename="<ascii-fallback>";
 *     filename*=UTF-8''<percent-encoded>` per RFC 5987 / 6266
 *   - For any other header: percent-encode non-ASCII bytes in the value
 *     so the header is well-formed (recipients can `decodeURIComponent`)
 *
 * Returns `true` if the header was set, `false` if it was skipped.
 */
import type { Response } from 'express';

const ASCII_PRINTABLE_RE = /^[\x20-\x7E\t]*$/;
const TOKEN_CHAR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return true; // multi-byte unicode
    if (s.charCodeAt(i) > 0x7f) return true; // latin-1 supplement
  }
  return false;
}

function asciiFallbackFilename(name: string): string {
  // Replace any non-ASCII rune with "_". Keep file extension if present.
  const ascii = name.replace(/[^\x20-\x7E]/g, '_');
  return ascii || 'file';
}

function buildContentDisposition(raw: string): string {
  // Try to parse "<disposition-type>; filename=\"...\""
  const match = raw.match(/^(\s*[A-Za-z]+\s*)(;\s*filename\s*=\s*"([^"]*)")?(.*)$/);
  if (!match) {
    // Unknown shape — percent-encode the whole thing as a safety net
    return raw.replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c));
  }
  const dispType = match[1].trim() || 'attachment';
  const filename = match[3] || '';
  const rest = (match[4] || '').trim();

  if (!filename) {
    // No filename param at all → re-emit dispType + rest (encoded)
    return rest ? `${dispType}; ${rest.replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c))}` : dispType;
  }
  if (!hasNonAscii(filename)) {
    // Already ASCII — return original as-is
    return raw;
  }
  // RFC 5987 / 6266 form
  const fallback = asciiFallbackFilename(filename);
  const encoded = encodeURIComponent(filename);
  return `${dispType}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function setSafeHeader(res: Response, name: string, value: string): boolean {
  if (typeof name !== 'string' || !TOKEN_CHAR_RE.test(name)) {
    return false; // header name itself is invalid; drop silently
  }
  if (typeof value !== 'string') {
    // Coerce to string; non-string values aren't valid header values anyway
    value = String(value ?? '');
  }
  let safeValue = value;
  if (!ASCII_PRINTABLE_RE.test(value)) {
    if (/^content-disposition$/i.test(name)) {
      safeValue = buildContentDisposition(value);
    } else {
      // Generic fallback: percent-encode non-ASCII runs; recipients can decode.
      safeValue = value.replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c));
    }
  }
  try {
    res.setHeader(name, safeValue);
    return true;
  } catch {
    // Last-resort: stringify-escape and try once more, then give up.
    try {
      res.setHeader(name, encodeURIComponent(safeValue));
      return true;
    } catch {
      return false;
    }
  }
}
