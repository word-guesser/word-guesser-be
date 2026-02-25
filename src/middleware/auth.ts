import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../lib/jwt';
import { prisma } from '../lib/prisma';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      currentUser?: {
        id: string;
        googleId: string;
        email: string;
        displayName: string;
        avatar?: string | null;
      };
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : req.cookies?.token;

  if (!token) {
    res.status(401).json({ message: 'Bạn chưa đăng nhập.' });
    return;
  }

  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn.' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ message: 'Người dùng không tồn tại.' });
    return;
  }

  req.currentUser = user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.currentUser) {
    res.status(401).json({ message: 'Bạn chưa đăng nhập.' });
    return;
  }
  next();
}
