import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

/**
 * Require a logged-in user (a valid row in `sessions`, as issued by /auth/login).
 *
 * The token is read from `Authorization: Bearer <token>` or, for plain browser
 * downloads (<a href>, window.open) that cannot send a header, from `?token=`.
 */
function reject(req: Request, res: Response, error: string) {
  // Logged so a caller that breaks (a script or partner system that never logged in) shows up
  console.warn(`[auth] 401 ${req.method} ${req.originalUrl.split('?')[0]} — ${error} — ip=${req.ip} ua="${req.get('user-agent') || ''}"`);
  res.status(401).json({ success: false, error });
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  // Emergency switch: REQUIRE_LOGIN=false turns the check off without a rebuild
  if (process.env.REQUIRE_LOGIN === 'false') return next();
  if (req.method === 'OPTIONS') return next();

  const header = req.headers.authorization;
  const token = (header?.startsWith('Bearer ') ? header.slice(7) : '') || (typeof req.query.token === 'string' ? req.query.token : '');
  if (!token) return reject(req, res, 'Login required');
  try {
    const session = await prisma.session.findUnique({ where: { token } });
    if (!session || session.expiresAt < new Date()) return reject(req, res, 'Session expired — please log in again');
    (req as any).userId = session.userId;
    next();
  } catch (err) {
    next(err);
  }
}
