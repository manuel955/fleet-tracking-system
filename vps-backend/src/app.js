import http from 'node:http';
import { config } from './config.js';
import { databaseHealth, pool, withTransaction } from './db.js';
import { authenticate, hashPassword, publicUser, signUser, verifyPassword } from './auth.js';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (_) {
    const error = new Error('El cuerpo debe ser JSON válido.');
    error.statusCode = 400;
    throw error;
  }
}

function requiredString(value, field, { min = 1, max = 255 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    const error = new Error(`Campo inválido: ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function requireRole(user, roles) {
  if (!user) {
    const error = new Error('Sesión requerida.');
    error.statusCode = 401;
    throw error;
  }
  if (!roles.includes(user.role)) {
    const error = new Error('No tienes permiso para esta operación.');
    error.statusCode = 403;
    throw error;
  }
}

async function register(body) {
  const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
  const password = requiredString(body.password, 'password', { min: 8, max: 128 });
  const role = body.role === 'driver' ? 'driver' : 'passenger';
  const displayName = requiredString(body.displayName ?? body.name ?? '', 'displayName', { max: 120 });
  const passwordHash = await hashPassword(password);

  const user = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (role, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, role, email, display_name, status`,
      [role, email, passwordHash, displayName],
    );
    const created = inserted.rows[0];
    if (role === 'driver') {
      const plate = requiredString(body.plate, 'plate', { max: 20 }).toUpperCase();
      await client.query(
        `INSERT INTO drivers (id, phone, plate, vehicle_type, vehicle_seats)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          created.id,
          requiredString(body.phone ?? '', 'phone', { max: 30 }),
          plate,
          body.vehicleType ?? 'Auto',
          Number(body.vehicleSeats ?? 4),
        ],
      );
    }
    return created;
  });
  return { token: signUser(user), user: publicUser(user) };
}

async function login(body) {
  const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
  const password = requiredString(body.password, 'password', { min: 1, max: 128 });
  if (!pool) throw new Error('Database is not configured');
  const result = await pool.query(
    'SELECT id, role, email, password_hash, display_name, status FROM users WHERE email = $1',
    [email],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash)) || user.status !== 'active') {
    const error = new Error('Credenciales inválidas.');
    error.statusCode = 401;
    throw error;
  }
  return { token: signUser(user), user: publicUser(user) };
}

export function createApp({ health = databaseHealth } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        const database = await health();
        const healthy = database.reachable || !database.configured;
        return json(res, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          service: 'apl-logistics-vps-backend',
          database,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/meta') {
        return json(res, 200, {
          apiVersion: 'v1',
          migration: 'firebase-parallel',
          realtime: 'websocket-pending',
          storage: config.s3Bucket ? 's3-compatible' : 'unconfigured',
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/register') {
        return json(res, 201, await register(await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
        return json(res, 200, await login(await readJson(req)));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
        const user = await authenticate(req);
        requireRole(user, ['passenger', 'driver', 'dashboard']);
        return json(res, 200, { user: publicUser(user) });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, error.statusCode ?? 503, {
        error: 'service_unavailable',
        message: config.nodeEnv === 'production' ? 'Service unavailable' : error.message,
      });
    }
  });
}
