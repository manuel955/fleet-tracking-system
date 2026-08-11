import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';

const TOKEN_TTL = '7d';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash ?? '');
}

export function signUser(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email ?? null },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL },
  );
}

export function readBearer(request) {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export async function authenticate(request) {
  const token = readBearer(request);
  if (!token || !pool) return null;
  try {
    const claims = jwt.verify(token, config.jwtSecret);
    if (typeof claims !== 'object' || typeof claims.sub !== 'string') return null;
    const result = await pool.query(
      'SELECT id, role, email, display_name, status FROM users WHERE id = $1',
      [claims.sub],
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') return null;
    return user;
  } catch (_) {
    return null;
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    displayName: user.display_name,
    status: user.status,
  };
}
