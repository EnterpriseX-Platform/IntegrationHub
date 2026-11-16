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

/**
 * HTTP status for a thrown value: Prisma "record not found" is 404, a broken
 * reference (unknown user, table…) is 400; anything else is a server error.
 */
export function errorStatus(err: unknown): number {
  const code = (err as any)?.code;
  if (code === 'P2025') return 404;
  if (code === 'P2003' || code === 'P2002') return 400;
  return 500;
}

/** errorMessage, with Prisma codes turned into words a user can act on. */
export function errorText(err: unknown): string {
  const code = (err as any)?.code;
  if (code === 'P2025') return 'Not found';
  if (code === 'P2003') return 'A referenced record does not exist';
  if (code === 'P2002') return 'Already exists';
  return errorMessage(err);
}
