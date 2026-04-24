import jwt from 'jsonwebtoken';
import { getConfig } from '../../config/env.js';

export type JwtPayload = { sub: string; email: string };

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getConfig().JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getConfig().JWT_SECRET) as JwtPayload;
}
