import jwt from 'jsonwebtoken';
const { sign, verify } = jwt;
import { env } from '../config/env.js';

const ADMIN_EXPIRES_IN = 60 * 60 * 24; // 24 hours

export function signAdminToken(): string {
  return sign({ sub: 'admin' }, env.JWT_SECRET, { expiresIn: ADMIN_EXPIRES_IN });
}

export function verifyAdminToken(token: string): boolean {
  try {
    const payload = verify(token, env.JWT_SECRET) as { sub: string };
    return payload.sub === 'admin';
  } catch {
    return false;
  }
}
