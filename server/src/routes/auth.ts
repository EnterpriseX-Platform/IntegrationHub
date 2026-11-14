import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { resolveTenant, tenantsForUser } from '../lib/tenants';
import crypto from 'crypto';

const router = Router();

// Hash password
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Generate token
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// POST /auth/login - Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || user.password !== hashPassword(password)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Account is disabled'
      });
    }

    // Create session
    const token = generateToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours

    const tenant = await resolveTenant(user.id, user.role);
    await prisma.session.create({
      data: {
        userId: user.id,
        tenantId: tenant.tenantId,
        token,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || '',
        expiresAt
      }
    });

    return res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
        },
        tenantId: tenant.tenantId,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// POST /auth/logout - Logout
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (token) {
      await prisma.session.deleteMany({
        where: { token }
      });
    }

    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /auth/me - Get current user
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const session = await prisma.session.findUnique({
      where: { token }
    });

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    const tenant = await resolveTenant(user.id, user.role, session.tenantId);
    const tenants = await tenantsForUser(user.id, user.role);
    return res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        tenantId: tenant.tenantId,
        tenantRole: tenant.role,
        tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: t.role, branding: safeJson(t.branding) })),
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

function safeJson(v: string | null | undefined) {
  try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}

async function sessionFromHeader(req: Request) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token } });
  if (!session || session.expiresAt < new Date()) return null;
  return session;
}

// POST /auth/switch-tenant { tenantId } - change the active tenant of this login
router.post('/switch-tenant', async (req: Request, res: Response) => {
  try {
    const session = await sessionFromHeader(req);
    if (!session) return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return res.status(401).json({ success: false, error: 'User not found' });
    const wanted = String(req.body?.tenantId || '');
    const list = await tenantsForUser(user.id, user.role);
    const t = list.find((x) => x.id === wanted || x.slug === wanted);
    if (!t) return res.status(403).json({ success: false, error: 'You are not a member of that tenant' });
    await prisma.session.update({ where: { id: session.id }, data: { tenantId: t.id } });
    return res.json({ success: true, data: { tenantId: t.id, slug: t.slug, name: t.name, role: t.role } });
  } catch (error) {
    console.error('Switch tenant error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Middleware to check authentication
export async function authMiddleware(req: Request, res: Response, next: Function) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const session = await prisma.session.findUnique({
      where: { token }
    });

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    // Attach user to request
    (req as any).user = user;
    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}

// Middleware to check admin role
export function adminMiddleware(req: Request, res: Response, next: Function) {
  const user = (req as any).user;
  
  if (!user || user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }
  
  return next();
}

export default router;
