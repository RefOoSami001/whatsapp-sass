import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../modules/auth/jwt.js';
import { AppError } from '../common/errors.js';

export type AuthedRequest = Request & { userId?: string; userEmail?: string };

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) {
    return next(new AppError('UNAUTHORIZED', 'Missing bearer token', 401));
  }
  try {
    const p = verifyToken(token);
    req.userId = p.sub;
    req.userEmail = p.email;
    return next();
  } catch {
    return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
  }
}
