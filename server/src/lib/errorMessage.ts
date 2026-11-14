/**
 * A human-readable message for any thrown value.
 *
 * Node's dual-stack connect for "localhost" (pg, ssh2, fetch…) throws an
 * AggregateError whose own `.message` is EMPTY — the real reasons
 * (ECONNREFUSED ::1, ECONNREFUSED 127.0.0.1) are in `.errors`. Using
 * `err.message` alone showed users a blank error.
 */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err == null) return fallback;
  const e: any = err;
  if (Array.isArray(e.errors) && e.errors.length) {
    const inner = e.errors.map((x: any) => x?.message || x?.code).filter(Boolean);
    const uniq = [...new Set(inner)];
    if (uniq.length) return uniq.join('; ');
  }
  if (typeof e.message === 'string' && e.message.trim()) return e.message;
  if (e.code) return String(e.code);
  return typeof err === 'string' ? err : fallback;
}
