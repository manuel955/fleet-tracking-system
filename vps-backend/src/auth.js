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

let firebaseCertificates = { expiresAt: 0, values: null };

async function getFirebaseCertificates() {
  if (firebaseCertificates.values && firebaseCertificates.expiresAt > Date.now()) {
    return firebaseCertificates.values;
  }
  const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!response.ok) throw new Error(`Firebase certificate request failed: ${response.status}`);
  const values = await response.json();
  const maxAge = Number((response.headers.get('cache-control') || '').match(/max-age=(\d+)/i)?.[1] || 3600);
  firebaseCertificates = { values, expiresAt: Date.now() + Math.max(60, maxAge - 30) * 1000 };
  return values;
}

async function authenticateFirebaseDashboardToken(token) {
  if (!config.firebaseDashboardAuth || !config.firebaseProjectId) return null;
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || typeof decoded.header?.kid !== 'string') return null;
  const certs = await getFirebaseCertificates();
  const certificate = certs[decoded.header.kid];
  if (!certificate) return null;
  const claims = jwt.verify(token, certificate, {
    algorithms: ['RS256'],
    audience: config.firebaseProjectId,
    issuer: `https://securetoken.google.com/${config.firebaseProjectId}`,
  });
  if (typeof claims !== 'object' || typeof claims.sub !== 'string') return null;
  // Do not turn an ordinary passenger/driver Firebase session into a
  // dashboard session. The custom claims are assigned by the existing
  // initializeDashboardAdmin/manageDashboardUsers functions.
  const isDashboard = claims.dashboardUser === true
    || claims.dashboardAdmin === true
    || claims.dashboardRole === 'ADMIN'
    || claims.dashboardRole === 'SUPERVISOR'
    || claims.dashboardRole === 'COORDINATOR';
  if (!isDashboard) return null;
  return {
    id: claims.sub,
    role: 'dashboard',
    email: claims.email ?? null,
    display_name: claims.name ?? claims.email ?? '',
    status: 'active',
    dashboard_role: claims.dashboardRole ?? (claims.dashboardAdmin === true ? 'ADMIN' : 'SUPERVISOR'),
    dashboard_sede_type: claims.sedeType ?? null,
    dashboard_sede_id: claims.sedeId ?? null,
    sede_name: claims.sedeName ?? null,
    firebaseClaims: claims,
  };
}

export async function authenticate(request) {
  const token = readBearer(request);
  if (!token || !pool) return null;
  try {
    const claims = jwt.verify(token, config.jwtSecret);
    if (typeof claims !== 'object' || typeof claims.sub !== 'string') return null;
    const result = await pool.query(
      `SELECT u.id, u.role, u.email, u.display_name, u.status,
          u.passenger_access_invite_id, u.passenger_access_status, u.passenger_access_expires_at,
          u.dashboard_role, u.dashboard_sede_type, u.dashboard_sede_id,
          p.name AS sede_name, p.address AS sede_address,
          p.latitude AS sede_lat, p.longitude AS sede_lng
       FROM users u LEFT JOIN places p ON p.id = u.dashboard_sede_id
      WHERE u.id = $1`,
      [claims.sub],
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') return null;
    return user;
  } catch (_) {
    try {
      return await authenticateFirebaseDashboardToken(token);
    } catch (_) {
      return null;
    }
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    displayName: user.display_name,
    status: user.status,
    dashboardRole: user.dashboard_role ?? null,
    sedeType: user.dashboard_sede_type ?? null,
    sedeId: user.dashboard_sede_id ?? null,
    sedeName: user.sede_name ?? null,
    sedeAddress: user.sede_address ?? null,
    sedeLat: user.sede_lat == null ? null : Number(user.sede_lat),
    sedeLng: user.sede_lng == null ? null : Number(user.sede_lng),
  };
}
