import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { databaseHealth, pool, withTransaction } from './db.js';
import { authenticate, hashPassword, publicUser, signUser, verifyPassword } from './auth.js';
import { authorizePrivateDownload, getStorageObject, isPublicStorageKey, normalizeStorageKey, publicStorageUrl, storageConfigured, uploadStorageObject } from './storage.js';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const DASHBOARD_ORIGINS = new Set([
  'https://apl.tucomprass.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !DASHBOARD_ORIGINS.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'Origin');
  return true;
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

async function readPublicConfig() {
  if (!pool) throw new Error('Database is not configured');
  const [configResult, placesResult] = await Promise.all([
    pool.query('SELECT key, value FROM app_config ORDER BY key'),
    pool.query(`SELECT id, category, name, address, latitude, longitude
                  FROM places ORDER BY category, name`),
  ]);
  const configValues = Object.fromEntries(
    configResult.rows.map((row) => [row.key, row.value]),
  );
  const places = { hotels: [], sportVenues: [] };
  for (const row of placesResult.rows) {
    if (!places[row.category]) continue;
    places[row.category].push({
      id: row.id,
      name: row.name,
      address: row.address,
      lat: Number(row.latitude),
      lng: Number(row.longitude),
    });
  }
  return { ...configValues, places };
}

const PUBLIC_CONFIG_KEYS = new Set([
  'supportPhone', 'driverAppBuild', 'passengerAppBuild',
  'dashboardName', 'dashboardLogoUrl', 'appBranding',
  'driverApkUrl', 'passengerApkUrl',
]);

function inviteTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeInviteToken(value) {
  let token = String(value ?? '').trim();
  if (token.startsWith('apl-passenger://')) {
    try { token = new URL(token).searchParams.get('token') || ''; } catch (_) { token = ''; }
  }
  if (token.startsWith('http://') || token.startsWith('https://')) {
    try { token = new URL(token).searchParams.get('token') || ''; } catch (_) { token = ''; }
  }
  return /^[a-f0-9]{32,128}$/i.test(token) ? token.toLowerCase() : null;
}

function assertPassengerAccess(user) {
  requireRole(user, ['passenger']);
  if (user.passenger_access_status === 'revoked') {
    const error = new Error('El acceso de pasajero fue revocado.');
    error.statusCode = 403;
    throw error;
  }
  if (user.passenger_access_expires_at && new Date(user.passenger_access_expires_at).getTime() <= Date.now()) {
    const error = new Error('El acceso de pasajero ya venció.');
    error.statusCode = 403;
    throw error;
  }
}

function publicInvite(row, token = null) {
  const createdAt = new Date(row.created_at).getTime();
  const expiresAt = new Date(row.expires_at).getTime();
  const invite = {
    id: row.id,
    hotelId: row.hotel_id,
    hotelName: row.hotel_name,
    hotelAddress: row.hotel_address,
    createdAt,
    expiresAt,
    maxUses: row.max_uses,
    uses: row.uses,
    status: row.status,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : 0,
  };
  if (token) {
    invite.token = token;
    invite.qrValue = `apl-passenger://access?token=${encodeURIComponent(token)}`;
  }
  return invite;
}

async function savePublicConfig(user, key, value) {
  requireRole(user, ['dashboard']);
  if (!PUBLIC_CONFIG_KEYS.has(key)) {
    const error = new Error('Clave de configuración no permitida.');
    error.statusCode = 400;
    throw error;
  }
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  return { key, value };
}

async function savePlace(user, body) {
  requireRole(user, ['dashboard']);
  const category = requiredString(body.category, 'category', { max: 20 });
  if (!['hotels', 'sportVenues'].includes(category)) {
    const error = new Error('Categoría de lugar inválida.');
    error.statusCode = 400;
    throw error;
  }
  const name = requiredString(body.name, 'name', { max: 160 });
  const address = requiredString(body.address ?? '', 'address', { min: 0, max: 255 });
  const latitude = parseCoordinate(body.lat ?? body.latitude, 'lat', -90, 90);
  const longitude = parseCoordinate(body.lng ?? body.longitude, 'lng', -180, 180);
  const id = requiredString(body.id ?? randomUUID(), 'id', { max: 120 });
  await pool.query(
    `INSERT INTO places (id, category, name, address, latitude, longitude, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET category=EXCLUDED.category, name=EXCLUDED.name,
       address=EXCLUDED.address, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
       updated_at=now()`,
    [id, category, name, address, latitude, longitude],
  );
  return { id, category, name, address, lat: latitude, lng: longitude };
}

async function removePlace(user, id) {
  requireRole(user, ['dashboard']);
  const result = await pool.query('DELETE FROM places WHERE id = $1 RETURNING id', [id]);
  if (!result.rowCount) {
    const error = new Error('Lugar no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  return { id };
}

function normalizeDashboardRole(value) {
  const role = String(value ?? 'supervisor').trim().toLowerCase();
  if (!['admin', 'supervisor', 'coordinator'].includes(role)) {
    const error = new Error('Rol de dashboard inválido.');
    error.statusCode = 400;
    throw error;
  }
  return role;
}

function dashboardRoleClaim(role) {
  return role === 'admin' ? 'ADMIN' : role === 'coordinator' ? 'COORDINATOR' : 'SUPERVISOR';
}

function publicDashboardUser(row, currentId) {
  return {
    uid: row.id,
    name: row.display_name || '',
    email: row.email || '',
    disabled: row.status !== 'active',
    role: String(row.dashboard_role || 'SUPERVISOR').toLowerCase(),
    sedeId: row.dashboard_sede_id || '',
    sedeType: row.dashboard_sede_type || '',
    sedeName: row.sede_name || '',
    isCurrent: row.id === currentId,
    createdAt: row.created_at,
  };
}

async function manageDashboardUsers(user, body) {
  requireRole(user, ['dashboard']);
  if (String(user.dashboard_role || '').toUpperCase() !== 'ADMIN') {
    const error = new Error('Solo un administrador puede gestionar usuarios.');
    error.statusCode = 403;
    throw error;
  }
  const action = requiredString(body.action, 'action', { max: 20 });
  if (action === 'list') {
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.status, u.created_at,
          u.dashboard_role, u.dashboard_sede_type, u.dashboard_sede_id,
          p.name AS sede_name
       FROM users u
       LEFT JOIN places p ON p.id = u.dashboard_sede_id
       WHERE u.role = 'dashboard' ORDER BY u.created_at`,
    );
    return { users: result.rows.map((row) => publicDashboardUser(row, user.id)) };
  }
  if (action === 'create') {
    const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
    const name = requiredString(body.name ?? '', 'name', { max: 120 });
    const password = requiredString(body.password, 'password', { min: 8, max: 128 });
    const role = normalizeDashboardRole(body.role);
    const sedeType = role === 'coordinator' ? requiredString(body.sedeType, 'sedeType', { max: 20 }) : null;
    const sedeId = role === 'coordinator' ? requiredString(body.sedeId, 'sedeId', { max: 120 }) : null;
    if (role === 'coordinator') {
      const category = ['hotel', 'hotels'].includes(sedeType) ? 'hotels' : ['sportVenue', 'sportVenues'].includes(sedeType) ? 'sportVenues' : '';
      const place = await pool.query('SELECT 1 FROM places WHERE id = $1 AND category = $2', [sedeId, category]);
      if (!place.rowCount) {
        const error = new Error('La sede seleccionada no existe.');
        error.statusCode = 400;
        throw error;
      }
    }
    const passwordHash = await hashPassword(password);
    try {
      const result = await pool.query(
        `INSERT INTO users (role, email, password_hash, display_name, dashboard_role, dashboard_sede_type, dashboard_sede_id)
         VALUES ('dashboard', $1, $2, $3, $4, $5, $6)
         RETURNING id, email, display_name, status, created_at, dashboard_role, dashboard_sede_type, dashboard_sede_id`,
        [email, passwordHash, name, dashboardRoleClaim(role), sedeType, sedeId],
      );
      return { user: publicDashboardUser(result.rows[0], user.id) };
    } catch (error) {
      if (error?.code === '23505') {
        error.statusCode = 409;
        error.message = 'Ya existe una cuenta con ese correo.';
      }
      throw error;
    }
  }
  if (action === 'grantAdmin') {
    const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
    const result = await pool.query(
      `UPDATE users SET role='dashboard', dashboard_role='ADMIN', dashboard_sede_type=NULL,
         dashboard_sede_id=NULL, updated_at=now() WHERE email=$1 RETURNING id`,
      [email],
    );
    if (!result.rowCount) {
      const error = new Error('Usuario no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    return { ok: true };
  }
  if (action === 'update') {
    const id = requiredString(body.uid, 'uid', { max: 120 });
    if (id === user.id && body.role && normalizeDashboardRole(body.role) !== 'admin') {
      const error = new Error('No puedes quitarte el rol de administrador.');
      error.statusCode = 400;
      throw error;
    }
    const changes = [];
    const values = [];
    const add = (sql, value) => { values.push(value); changes.push(`${sql} = $${values.length}`); };
    if (body.email) add('email', requiredString(body.email, 'email', { max: 254 }).toLowerCase());
    if (body.name !== undefined) add('display_name', requiredString(body.name, 'name', { max: 120 }));
    if (body.password !== undefined) add('password_hash', await hashPassword(requiredString(body.password, 'password', { min: 8, max: 128 })));
    if (typeof body.disabled === 'boolean') add('status', body.disabled ? 'disabled' : 'active');
    if (body.role) {
      const role = normalizeDashboardRole(body.role);
      add('dashboard_role', dashboardRoleClaim(role));
      add('dashboard_sede_type', role === 'coordinator' ? requiredString(body.sedeType, 'sedeType', { max: 20 }) : null);
      add('dashboard_sede_id', role === 'coordinator' ? requiredString(body.sedeId, 'sedeId', { max: 120 }) : null);
    }
    if (!changes.length) {
      const error = new Error('No hay cambios para guardar.');
      error.statusCode = 400;
      throw error;
    }
    values.push(id);
    const result = await pool.query(
      `UPDATE users SET ${changes.join(', ')}, updated_at=now() WHERE id=$${values.length} AND role='dashboard' RETURNING id`,
      values,
    );
    if (!result.rowCount) {
      const error = new Error('Usuario de dashboard no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    return { ok: true };
  }
  if (action === 'delete') {
    const id = requiredString(body.uid, 'uid', { max: 120 });
    if (id === user.id) {
      const error = new Error('No puedes eliminar tu propia cuenta.');
      error.statusCode = 400;
      throw error;
    }
    const result = await pool.query(`DELETE FROM users WHERE id=$1 AND role='dashboard'`, [id]);
    if (!result.rowCount) {
      const error = new Error('Usuario de dashboard no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    return { ok: true };
  }
  const error = new Error('Acción inválida.');
  error.statusCode = 400;
  throw error;
}

async function managePassengerInvites(user, body) {
  requireRole(user, ['dashboard']);
  const action = requiredString(body.action, 'action', { max: 20 });
  if (action === 'list') {
    const result = await pool.query('SELECT * FROM passenger_invites ORDER BY created_at DESC');
    return { invites: result.rows.map((row) => publicInvite(row)) };
  }
  if (action === 'create') {
    const hotelId = requiredString(body.hotelId, 'hotelId', { max: 120 });
    const placeResult = await pool.query(
      `SELECT id, name, address, latitude, longitude FROM places
       WHERE id = $1 AND category = 'hotels'`,
      [hotelId],
    );
    const place = placeResult.rows[0];
    if (!place) {
      const error = new Error('Selecciona un hotel válido.');
      error.statusCode = 400;
      throw error;
    }
    const durationHours = Math.trunc(Math.min(720, Math.max(1, Number(body.durationHours ?? 24))));
    const maxUses = Math.trunc(Math.min(100, Math.max(1, Number(body.maxUses ?? 1))));
    if (!Number.isFinite(durationHours) || !Number.isFinite(maxUses)) {
      const error = new Error('Duración o cantidad de usos inválida.');
      error.statusCode = 400;
      throw error;
    }
    const token = randomBytes(16).toString('hex');
    const id = inviteTokenHash(token);
    const result = await pool.query(
      `INSERT INTO passenger_invites
       (id, hotel_id, hotel_name, hotel_address, hotel_lat, hotel_lng, created_by, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 * interval '1 hour'), $9)
       RETURNING *`,
      [id, place.id, place.name, place.address, place.latitude, place.longitude, user.id || user.email || 'dashboard', durationHours, maxUses],
    );
    return { invite: publicInvite(result.rows[0], token) };
  }
  if (action === 'revoke') {
    const inviteId = requiredString(body.inviteId, 'inviteId', { max: 128 }).toLowerCase();
    const result = await withTransaction(async (client) => {
      const inviteResult = await client.query('SELECT * FROM passenger_invites WHERE id = $1 FOR UPDATE', [inviteId]);
      const invite = inviteResult.rows[0];
      if (!invite) {
        const error = new Error('La invitación no existe.');
        error.statusCode = 404;
        throw error;
      }
      await client.query(`UPDATE passenger_invites SET status = 'revoked' WHERE id = $1`, [inviteId]);
      const revoked = await client.query(
        `UPDATE users SET passenger_access_status = 'revoked', updated_at = now()
         WHERE passenger_access_invite_id = $1 AND passenger_access_status = 'authorized'`,
        [inviteId],
      );
      return { revokedAccesses: revoked.rowCount || 0 };
    });
    return { ok: true, ...result };
  }
  const error = new Error('Acción inválida.');
  error.statusCode = 400;
  throw error;
}

async function redeemPassengerInvite(body) {
  const token = normalizeInviteToken(body.code ?? body.token);
  if (!token) {
    const error = new Error('Código QR inválido.');
    error.statusCode = 400;
    throw error;
  }
  const inviteId = inviteTokenHash(token);
  const result = await withTransaction(async (client) => {
    const inviteResult = await client.query('SELECT * FROM passenger_invites WHERE id = $1 FOR UPDATE', [inviteId]);
    const invite = inviteResult.rows[0];
    if (!invite || invite.status === 'revoked' || new Date(invite.expires_at).getTime() <= Date.now() || invite.uses >= invite.max_uses) {
      const error = new Error('El código QR está vencido, revocado o ya fue utilizado.');
      error.statusCode = 409;
      throw error;
    }
    const guestId = randomUUID();
    const guestEmail = `guest-${guestId}@guest.apl.invalid`;
    const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
    const usedBy = invite.used_by && typeof invite.used_by === 'object' ? invite.used_by : {};
    usedBy[guestId] = Date.now();
    const uses = invite.uses + 1;
    await client.query(
      `UPDATE passenger_invites SET uses = $1, last_used_at = now(),
       status = CASE WHEN $1 >= max_uses THEN 'used' ELSE 'active' END, used_by = $2::jsonb
       WHERE id = $3`,
      [uses, JSON.stringify(usedBy), inviteId],
    );
    const userResult = await client.query(
      `INSERT INTO users (id, role, email, password_hash, display_name,
         passenger_access_invite_id, passenger_access_status, passenger_access_expires_at)
       VALUES ($1, 'passenger', $2, $3, $4, $5, 'authorized', $6)
       RETURNING id, role, email, display_name, status`,
      [guestId, guestEmail, passwordHash, invite.hotel_name, inviteId, invite.expires_at],
    );
    return { user: userResult.rows[0], invite };
  });
  return {
    token: signUser(result.user),
    user: publicUser(result.user),
    access: {
      status: 'authorized',
      legacy: false,
      inviteHash: inviteId,
      hotelName: result.invite.hotel_name,
      hotelAddress: result.invite.hotel_address,
      expiresAt: new Date(result.invite.expires_at).getTime(),
    },
  };
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
    `SELECT u.id, u.role, u.email, u.password_hash, u.display_name, u.status,
        u.dashboard_role, u.dashboard_sede_type, u.dashboard_sede_id, p.name AS sede_name
     FROM users u LEFT JOIN places p ON p.id = u.dashboard_sede_id WHERE u.email = $1`,
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

function parseCoordinate(value, field, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`Campo inválido: ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function parsePassengerCount(value) {
  const count = Number(value ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 45) {
    const error = new Error('passengerCount debe estar entre 1 y 45.');
    error.statusCode = 400;
    throw error;
  }
  return count;
}

function parseScheduledPickup(value) {
  if (value === null || value === undefined || value === '') return null;
  const millis = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(millis) || millis < Date.now() - 60_000) {
    const error = new Error('scheduledPickupAt debe ser una fecha futura válida.');
    error.statusCode = 400;
    throw error;
  }
  return new Date(millis);
}

function publicTrip(row) {
  const millis = (value) => value ? new Date(value).getTime() : null;
  return {
    id: row.id,
    passengerId: row.passenger_id,
    driverId: row.driver_id,
    status: row.status,
    pickupAddress: row.origin_address,
    pickupLat: Number(row.origin_lat),
    pickupLng: Number(row.origin_lng),
    destinationAddress: row.destination_address,
    destinationLat: Number(row.destination_lat),
    destinationLng: Number(row.destination_lng),
    passengerCount: row.passenger_count ?? 1,
    scheduledPickupAt: millis(row.scheduled_pickup_at),
    requestedAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
    completedAt: millis(row.completed_at),
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    rating: row.rating,
    feedbackComment: row.feedback_comment,
  };
}

const tripSelect = `
  SELECT id, passenger_id, driver_id, status,
    origin_address, origin_lat, origin_lng,
    destination_address, destination_lat, destination_lng,
    passenger_count, scheduled_pickup_at, created_at, updated_at,
    completed_at, cancelled_by, cancel_reason, rating, feedback_comment
  FROM trips`;

async function findTrip(tripId) {
  if (!pool) throw new Error('Database is not configured');
  const result = await pool.query(`${tripSelect} WHERE id = $1`, [tripId]);
  return result.rows[0] ?? null;
}

async function assignAvailableDriver(client, tripId, passengerCount) {
  const driverResult = await client.query(
    `SELECT d.id
       FROM drivers d
      WHERE d.approval_status = 'approved'
        AND d.availability_status = 'online'
        AND d.current_trip_id IS NULL
        AND d.vehicle_seats >= $1
      ORDER BY d.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [passengerCount],
  );
  const driver = driverResult.rows[0];
  if (!driver) {
    await client.query(
      `UPDATE trips SET status = 'no_drivers_available', driver_id = NULL,
         updated_at = now() WHERE id = $1`,
      [tripId],
    );
    return null;
  }
  await client.query(
    `UPDATE trips SET status = 'accepted', driver_id = $1, updated_at = now()
      WHERE id = $2`,
    [driver.id, tripId],
  );
  await client.query(
    `UPDATE drivers SET current_trip_id = $1, updated_at = now() WHERE id = $2`,
    [tripId, driver.id],
  );
  return driver.id;
}

async function createTrip(user, body) {
  assertPassengerAccess(user);
  const pickupAddress = requiredString(body.pickupAddress ?? body.originAddress, 'pickupAddress', { max: 255 });
  const destinationAddress = requiredString(body.destinationAddress, 'destinationAddress', { max: 255 });
  const pickupLat = parseCoordinate(body.pickupLat ?? body.originLat, 'pickupLat', -90, 90);
  const pickupLng = parseCoordinate(body.pickupLng ?? body.originLng, 'pickupLng', -180, 180);
  const destinationLat = parseCoordinate(body.destinationLat, 'destinationLat', -90, 90);
  const destinationLng = parseCoordinate(body.destinationLng, 'destinationLng', -180, 180);
  const passengerCount = parsePassengerCount(body.passengerCount);
  const scheduledPickupAt = parseScheduledPickup(body.scheduledPickupAt);
  const status = scheduledPickupAt && scheduledPickupAt.getTime() > Date.now() + 60_000
    ? 'scheduled'
    : 'searching';

  const trip = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO trips (
        passenger_id, status, origin_address, origin_lat, origin_lng,
        destination_address, destination_lat, destination_lng,
        passenger_count, scheduled_pickup_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        user.id, status, pickupAddress, pickupLat, pickupLng,
        destinationAddress, destinationLat, destinationLng,
        passengerCount, scheduledPickupAt,
      ],
    );
    const tripId = inserted.rows[0].id;
    if (status === 'searching') await assignAvailableDriver(client, tripId, passengerCount);
    const result = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(result.rows[0]);
  });
  if (trip.driverId) {
    await notifyVpsDevices([trip.driverId], 'trip_assigned', {
      tripId: trip.id,
      status: trip.status,
      pickupAddress: trip.pickupAddress,
      destinationAddress: trip.destinationAddress,
      scheduledPickupAt: trip.scheduledPickupAt,
      route: 'active-trip',
      deepLink: `driver://trip/${trip.id}`,
    });
  }
  return trip;
}

function canReadTrip(user, trip) {
  return user.role === 'dashboard' || trip.passenger_id === user.id || trip.driver_id === user.id;
}

async function listTrips(user, url) {
  requireRole(user, ['passenger', 'driver', 'dashboard']);
  if (user.role === 'passenger') assertPassengerAccess(user);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 100);
  const conditions = [];
  const values = [];
  if (user.role === 'passenger') {
    values.push(user.id);
    conditions.push(`passenger_id = $${values.length}`);
  } else if (user.role === 'driver') {
    values.push(user.id);
    conditions.push(`driver_id = $${values.length}`);
  }
  values.push(limit);
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`${tripSelect}${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
  return result.rows.map(publicTrip);
}

/**
 * Read-only operational snapshot for the VPS-backed dashboard. Firebase
 * remains the login/FCM provider, but this endpoint makes PostgreSQL the
 * source of truth for the map, driver cards and trip counters. It is kept as
 * one bounded snapshot so the browser can poll safely without opening a
 * database or WebSocket connection from the public network.
 */
async function dashboardOverview(user) {
  requireRole(user, ['dashboard']);
  const [driversResult, tripsResult] = await Promise.all([
    pool.query(`
      SELECT d.id, u.display_name, u.email, u.status AS user_status,
        d.approval_status, d.phone, d.plate, d.vehicle_type, d.vehicle_seats,
        d.availability_status, d.current_trip_id,
        l.latitude, l.longitude, l.accuracy_m, l.recorded_at
      FROM drivers d
      JOIN users u ON u.id = d.id
      LEFT JOIN driver_locations l ON l.driver_id = d.id
      ORDER BY u.display_name ASC, d.id ASC`),
    pool.query(`${tripSelect} ORDER BY created_at DESC LIMIT 200`),
  ]);

  const trips = tripsResult.rows.map(publicTrip);
  const tripById = new Map(trips.map((trip) => [trip.id, trip]));
  const drivers = driversResult.rows.map((row) => ({
    id: row.id,
    name: row.display_name,
    email: row.email,
    userStatus: row.user_status,
    approvalStatus: row.approval_status,
    phone: row.phone,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    vehicleSeats: row.vehicle_seats,
    availabilityStatus: row.availability_status,
    currentTripId: row.current_trip_id,
    currentTrip: row.current_trip_id ? tripById.get(row.current_trip_id) ?? null : null,
    lat: row.latitude === null ? null : Number(row.latitude),
    lng: row.longitude === null ? null : Number(row.longitude),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    lastUpdate: row.recorded_at ? new Date(row.recorded_at).getTime() : null,
  }));

  const todayTrips = trips.filter((trip) => {
    const timestamp = Number(trip.requestedAt || 0);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return timestamp >= start.getTime();
  });
  return {
    updatedAt: Date.now(),
    drivers,
    trips,
    stats: {
      vehicles: drivers.filter((driver) => driver.approvalStatus === 'approved').length,
      active: drivers.filter((driver) => driver.approvalStatus === 'approved' && driver.availabilityStatus !== 'offline').length,
      available: drivers.filter((driver) => driver.approvalStatus === 'approved' && driver.availabilityStatus === 'online' && !driver.currentTripId).length,
      tripsToday: todayTrips.filter((trip) => trip.status !== 'cancelled').length,
      completedToday: todayTrips.filter((trip) => trip.status === 'completed').length,
      cancelledToday: todayTrips.filter((trip) => trip.status === 'cancelled').length,
    },
  };
}

async function setDriverAvailability(user, body) {
  requireRole(user, ['driver']);
  const online = body.online === true || body.online === 'true';
  const result = await pool.query(
    `UPDATE drivers
        SET availability_status = $1, updated_at = now()
      WHERE id = $2 AND approval_status = 'approved'
      RETURNING id, availability_status, current_trip_id`,
    [online ? 'online' : 'offline', user.id],
  );
  if (!result.rows[0]) {
    const error = new Error('El conductor no está aprobado para operar.');
    error.statusCode = 403;
    throw error;
  }
  return {
    driverId: result.rows[0].id,
    online: result.rows[0].availability_status === 'online',
    currentTripId: result.rows[0].current_trip_id,
  };
}

async function updateDriverLocation(user, body) {
  requireRole(user, ['driver']);
  const latitude = parseCoordinate(body.latitude, 'latitude', -90, 90);
  const longitude = parseCoordinate(body.longitude, 'longitude', -180, 180);
  const accuracyM = body.accuracyM === undefined ? null : parseCoordinate(body.accuracyM, 'accuracyM', 0, 10000);
  await pool.query(
    `INSERT INTO driver_locations (driver_id, latitude, longitude, accuracy_m, recorded_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (driver_id) DO UPDATE SET latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude, accuracy_m = EXCLUDED.accuracy_m,
       recorded_at = now()`,
    [user.id, latitude, longitude, accuracyM],
  );
  return { driverId: user.id, latitude, longitude, accuracyM, recordedAt: Date.now() };
}

async function getDriverMe(user) {
  requireRole(user, ['driver']);
  const result = await pool.query(
    `SELECT d.id, d.approval_status, d.phone, d.plate, d.vehicle_type,
       d.vehicle_seats, d.availability_status, d.current_trip_id,
       l.latitude, l.longitude, l.accuracy_m, l.recorded_at
       FROM drivers d LEFT JOIN driver_locations l ON l.driver_id = d.id
      WHERE d.id = $1`,
    [user.id],
  );
  if (!result.rows[0]) {
    const error = new Error('Perfil de conductor no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    approvalStatus: row.approval_status,
    phone: row.phone,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    vehicleSeats: row.vehicle_seats,
    availabilityStatus: row.availability_status,
    currentTripId: row.current_trip_id,
    location: row.latitude === null ? null : {
      latitude: Number(row.latitude), longitude: Number(row.longitude),
      accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
      recordedAt: new Date(row.recorded_at).getTime(),
    },
  };
}

async function getTripDriverLocation(user, tripId) {
  assertPassengerAccess(user);
  const trip = await findTrip(tripId);
  if (!trip || trip.passenger_id !== user.id || !trip.driver_id) {
    const error = new Error('Viaje no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  const result = await pool.query(
    `SELECT d.id, u.display_name, d.phone, d.plate, d.vehicle_type,
            d.vehicle_seats, l.latitude, l.longitude, l.accuracy_m,
            l.recorded_at
       FROM drivers d
       JOIN users u ON u.id = d.id
       LEFT JOIN driver_locations l ON l.driver_id = d.id
      WHERE d.id = $1`,
    [trip.driver_id],
  );
  const row = result.rows[0];
  return {
    tripId,
    driverId: trip.driver_id,
    driverName: row?.display_name ?? '',
    name: row?.display_name ?? '',
    driverPhone: row?.phone ?? '',
    phone: row?.phone ?? '',
    driverPlate: row?.plate ?? '',
    plate: row?.plate ?? '',
    vehicleType: row?.vehicle_type ?? '',
    vehicleSeats: row?.vehicle_seats ?? null,
    location: row?.latitude === null || row?.latitude === undefined
      ? null
      : {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
          recordedAt: new Date(row.recorded_at).getTime(),
        },
  };
}

const driverTransitions = Object.freeze({
  accepted: 'arrived_at_pickup',
  arrived_at_pickup: 'in_progress',
  in_progress: 'completed',
});

async function advanceDriverTrip(user, tripId, body) {
  requireRole(user, ['driver']);
  const action = requiredString(body.action ?? body.newStatus, 'action', { max: 40 });
  const requestedStatus = ({ arrive: 'arrived_at_pickup', start: 'in_progress', complete: 'completed' })[action] ?? action;
  const trip = await withTransaction(async (client) => {
    const result = await client.query(`${tripSelect} WHERE id = $1 FOR UPDATE`, [tripId]);
    const trip = result.rows[0];
    if (!trip || trip.driver_id !== user.id) {
      const error = new Error('Viaje no encontrado para este conductor.');
      error.statusCode = 404;
      throw error;
    }
    if (driverTransitions[trip.status] !== requestedStatus) {
      const error = new Error(`El viaje no puede pasar de ${trip.status} a ${requestedStatus}.`);
      error.statusCode = 409;
      throw error;
    }
    const completed = requestedStatus === 'completed';
    await client.query(
      `UPDATE trips SET status = $1, completed_at = CASE WHEN $2 THEN now() ELSE completed_at END,
         updated_at = now() WHERE id = $3`,
      [requestedStatus, completed, tripId],
    );
    if (completed) {
      await client.query(
        `UPDATE drivers SET current_trip_id = NULL, updated_at = now() WHERE id = $1`,
        [user.id],
      );
    }
    const updated = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(updated.rows[0]);
  });
  await notifyVpsDevices([trip.passengerId], 'trip_status', {
    tripId: trip.id,
    status: trip.status,
    ratingRequired: trip.status === 'completed',
    route: trip.status === 'completed' ? 'rate-trip' : 'active-trip',
    deepLink: trip.status === 'completed' ? `passenger://rate-trip/${trip.id}` : `passenger://trip/${trip.id}`,
  });
  return trip;
}

async function cancelTrip(user, tripId, body) {
  if (user?.role === 'passenger') assertPassengerAccess(user);
  else requireRole(user, ['dashboard']);
  const reason = body.reason === undefined ? null : requiredString(body.reason, 'reason', { max: 255 });
  const trip = await withTransaction(async (client) => {
    const result = await client.query(`${tripSelect} WHERE id = $1 FOR UPDATE`, [tripId]);
    const trip = result.rows[0];
    if (!trip || (user.role === 'passenger' && trip.passenger_id !== user.id)) {
      const error = new Error('Viaje no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    if (['completed', 'cancelled'].includes(trip.status)) {
      return publicTrip(trip);
    }
    await client.query(
      `UPDATE trips SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2, updated_at = now()
        WHERE id = $3`,
      [user.role, reason, tripId],
    );
    if (trip.driver_id) {
      await client.query(
        `UPDATE drivers SET current_trip_id = NULL, updated_at = now() WHERE id = $1`,
        [trip.driver_id],
      );
    }
    const updated = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(updated.rows[0]);
  });
  if (trip.status === 'cancelled') {
    const recipientIds = [trip.passengerId, trip.driverId].filter(Boolean);
    await notifyVpsDevices(recipientIds, 'trip_cancelled', {
      tripId: trip.id,
      status: trip.status,
      cancelReason: trip.cancelReason,
      cancelledBy: trip.cancelledBy,
      route: 'home',
      deepLink: 'passenger://home',
    });
  }
  return trip;
}

async function retryTrip(user, tripId) {
  assertPassengerAccess(user);
  return withTransaction(async (client) => {
    const result = await client.query(`${tripSelect} WHERE id = $1 FOR UPDATE`, [tripId]);
    const trip = result.rows[0];
    if (!trip || trip.passenger_id !== user.id) {
      const error = new Error('Viaje no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    if (!['no_drivers_available', 'searching'].includes(trip.status)) {
      return publicTrip(trip);
    }
    await client.query(`UPDATE trips SET status = 'searching', updated_at = now() WHERE id = $1`, [tripId]);
    await assignAvailableDriver(client, tripId, trip.passenger_count ?? 1);
    const updated = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(updated.rows[0]);
  });
}

async function submitFeedback(user, tripId, body) {
  assertPassengerAccess(user);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error('rating debe estar entre 1 y 5.');
    error.statusCode = 400;
    throw error;
  }
  const comment = body.comment === undefined ? '' : requiredString(body.comment, 'comment', { max: 1000 });
  const result = await pool.query(
    `UPDATE trips SET rating = $1, feedback_comment = $2, feedback_submitted_at = now(), updated_at = now()
      WHERE id = $3 AND passenger_id = $4 AND status = 'completed' AND rating IS NULL
      RETURNING id, rating, feedback_comment`,
    [rating, comment, tripId, user.id],
  );
  if (!result.rows[0]) {
    const error = new Error('No se puede calificar este viaje o ya fue calificado.');
    error.statusCode = 409;
    throw error;
  }
  return { tripId, rating: result.rows[0].rating, comment: result.rows[0].feedback_comment };
}

async function registerDeviceToken(user, body) {
  requireRole(user, ['passenger', 'driver', 'dashboard']);
  const token = requiredString(body.token, 'token', { max: 4096 });
  const platform = requiredString(body.platform, 'platform', { max: 10 }).toLowerCase();
  if (!['android', 'ios', 'web'].includes(platform)) {
    const error = new Error('platform debe ser android, ios o web.');
    error.statusCode = 400;
    throw error;
  }
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, platform, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform, updated_at = now()`,
    [user.id, token, platform],
  );
  return { registered: true };
}

async function notifyVpsDevices(userIds, type, data = {}) {
  if (!config.fcmWebhookUrl || !config.fcmWebhookSecret || !pool || !userIds?.length) return;
  try {
    const result = await pool.query(
      'SELECT id, token FROM device_tokens WHERE user_id = ANY($1::uuid[])',
      [userIds],
    );
    const tokenRows = result.rows.filter((row) => row.token);
    const tokens = tokenRows.map((row) => row.token);
    if (!tokens.length) return;
    const response = await fetch(config.fcmWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vps-push-secret': config.fcmWebhookSecret,
      },
      body: JSON.stringify({ tokens, type, data }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`FCM webhook returned ${response.status}`);
      return;
    }
    const staleCodes = new Set([
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
    ]);
    const staleIds = (Array.isArray(payload.failures) ? payload.failures : [])
      .filter((failure) => staleCodes.has(failure?.code))
      .map((failure) => tokenRows[Number(failure.index)]?.id)
      .filter(Boolean);
    if (staleIds.length) {
      await pool.query('DELETE FROM device_tokens WHERE id = ANY($1::bigint[])', [staleIds]);
    }
    if (Number(payload.failed || 0) > 0) {
      console.error(`FCM webhook delivered ${payload.sent || 0}, failed ${payload.failed}`);
    }
  } catch (error) {
    // A push outage must never roll back a committed trip transition.
    console.error(`FCM webhook failed: ${error?.message || error}`);
  }
}

/**
 * Promueve viajes programados cuya hora ya llegó y ejecuta el mismo
 * emparejamiento transaccional que usa una solicitud inmediata. El proceso
 * se ejecuta desde server.js y es idempotente: cada fila se bloquea antes de
 * cambiar de estado, por lo que dos instancias no despachan el mismo viaje.
 */
export async function dispatchScheduledTrips({ now = new Date() } = {}) {
  const dispatchedTrips = await withTransaction(async (client) => {
    const due = await client.query(
      `${tripSelect}
        WHERE status = 'scheduled' AND scheduled_pickup_at <= $1
        ORDER BY scheduled_pickup_at ASC
        FOR UPDATE SKIP LOCKED`,
      [now],
    );
    const dispatched = [];
    for (const trip of due.rows) {
      await client.query(
        `UPDATE trips SET status = 'searching', updated_at = now() WHERE id = $1`,
        [trip.id],
      );
      const driverId = await assignAvailableDriver(client, trip.id, trip.passenger_count ?? 1);
      if (driverId) {
        const updated = await client.query(`${tripSelect} WHERE id = $1`, [trip.id]);
        dispatched.push({ trip: publicTrip(updated.rows[0]), driverId });
      }
    }
    return dispatched;
  });
  await Promise.all(dispatchedTrips.map(({ trip, driverId }) => notifyVpsDevices([driverId], 'trip_assigned', {
    tripId: trip.id,
    status: trip.status,
    pickupAddress: trip.pickupAddress,
    destinationAddress: trip.destinationAddress,
    scheduledPickupAt: trip.scheduledPickupAt,
    route: 'active-trip',
    deepLink: `driver://trip/${trip.id}`,
  })));
  return dispatchedTrips.length;
}

export function createApp({ health = databaseHealth } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const corsEnabled = applyCors(req, res);

      if (req.method === 'OPTIONS') {
        return res.writeHead(corsEnabled ? 204 : 403).end();
      }

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
          migration: 'vps-core-config-firebase-auth-fcm',
          realtime: 'dashboard-polling',
          storage: storageConfigured() ? 's3-compatible' : 'unconfigured',
          storagePublicBaseUrl: config.publicApiBaseUrl,
        });
      }

      const publicStorageMatch = url.pathname.match(/^\/api\/v1\/storage\/public\/(.+)$/);
      if (req.method === 'GET' && publicStorageMatch) {
        const key = decodeURIComponent(publicStorageMatch[1]);
        if (!isPublicStorageKey(key)) return json(res, 404, { error: 'Archivo no encontrado.' });
        const object = await getStorageObject(key);
        res.writeHead(200, {
          'content-type': object.ContentType || 'application/octet-stream',
          'content-length': object.ContentLength,
          'cache-control': object.CacheControl || 'public, max-age=300',
          'etag': object.ETag || '',
        });
        object.Body.pipe(res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/storage/upload') {
        const user = await authenticate(req);
        return json(res, 201, await uploadStorageObject(user, await readJson(req)));
      }

      const storageDownloadMatch = url.pathname.match(/^\/api\/v1\/storage\/download\/(.+)$/);
      if (req.method === 'GET' && storageDownloadMatch) {
        const user = await authenticate(req);
        const key = normalizeStorageKey(decodeURIComponent(storageDownloadMatch[1]));
        await authorizePrivateDownload(user, key);
        const object = await getStorageObject(key);
        res.writeHead(200, {
          'content-type': object.ContentType || 'application/octet-stream',
          'content-length': object.ContentLength,
          'cache-control': 'private, max-age=60',
          'etag': object.ETag || '',
        });
        object.Body.pipe(res);
        return;
      }

      // Public, cache-free configuration for the mobile apps. Operational
      // data (trips/GPS) never comes from this endpoint; it is only the small
      // set of places, support and update values formerly kept in RTDB.
      if (req.method === 'GET' && url.pathname === '/api/v1/public/config') {
        return json(res, 200, await readPublicConfig());
      }

      const publicPlacesMatch = url.pathname.match(/^\/api\/v1\/public\/places\/(hotels|sportVenues)$/);
      if (req.method === 'GET' && publicPlacesMatch) {
        const configSnapshot = await readPublicConfig();
        return json(res, 200, { places: configSnapshot.places[publicPlacesMatch[1]] || [] });
      }

      const configWriteMatch = url.pathname.match(/^\/api\/v1\/dashboard\/config\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'PUT' && configWriteMatch) {
        const user = await authenticate(req);
        const body = await readJson(req);
        return json(res, 200, await savePublicConfig(user, configWriteMatch[1], body.value));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/dashboard/places') {
        const user = await authenticate(req);
        return json(res, 200, { place: await savePlace(user, await readJson(req)) });
      }

      const placeDeleteMatch = url.pathname.match(/^\/api\/v1\/dashboard\/places\/([^/]+)$/);
      if (req.method === 'DELETE' && placeDeleteMatch) {
        const user = await authenticate(req);
        return json(res, 200, await removePlace(user, decodeURIComponent(placeDeleteMatch[1])));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/dashboard/passenger-invites') {
        const user = await authenticate(req);
        return json(res, 200, await managePassengerInvites(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/dashboard/users') {
        const user = await authenticate(req);
        return json(res, 200, await manageDashboardUsers(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/passenger-invites/redeem') {
        return json(res, 200, await redeemPassengerInvite(await readJson(req)));
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

      if (req.method === 'GET' && url.pathname === '/api/v1/drivers/me') {
        const user = await authenticate(req);
        return json(res, 200, await getDriverMe(user));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/availability') {
        const user = await authenticate(req);
        return json(res, 200, await setDriverAvailability(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/location') {
        const user = await authenticate(req);
        return json(res, 200, await updateDriverLocation(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/device-tokens') {
        const user = await authenticate(req);
        return json(res, 200, await registerDeviceToken(user, await readJson(req)));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/overview') {
        const user = await authenticate(req);
        return json(res, 200, await dashboardOverview(user));
      }

      const driverLocationMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/driver-location$/);
      if (req.method === 'GET' && driverLocationMatch) {
        const user = await authenticate(req);
        const tripId = decodeURIComponent(driverLocationMatch[1]);
        return json(res, 200, await getTripDriverLocation(user, tripId));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/trips') {
        const user = await authenticate(req);
        return json(res, 200, { trips: await listTrips(user, url) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/trips') {
        const user = await authenticate(req);
        return json(res, 201, { trip: await createTrip(user, await readJson(req)) });
      }

      const tripMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)(?:\/(cancel|retry|action|feedback))?$/);
      if (tripMatch) {
        const tripId = decodeURIComponent(tripMatch[1]);
        const operation = tripMatch[2];
        const user = await authenticate(req);
        if (req.method === 'GET' && !operation) {
          requireRole(user, ['passenger', 'driver', 'dashboard']);
          const trip = await findTrip(tripId);
          if (!trip || !canReadTrip(user, trip)) {
            const error = new Error('Viaje no encontrado.');
            error.statusCode = 404;
            throw error;
          }
          return json(res, 200, { trip: publicTrip(trip) });
        }
        if (req.method === 'POST' && operation === 'cancel') {
          return json(res, 200, { trip: await cancelTrip(user, tripId, await readJson(req)) });
        }
        if (req.method === 'POST' && operation === 'retry') {
          return json(res, 200, { trip: await retryTrip(user, tripId) });
        }
        if (req.method === 'POST' && operation === 'action') {
          return json(res, 200, { trip: await advanceDriverTrip(user, tripId, await readJson(req)) });
        }
        if (req.method === 'POST' && operation === 'feedback') {
          return json(res, 200, { feedback: await submitFeedback(user, tripId, await readJson(req)) });
        }
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.error('request failed', req.method, req.url, error?.code ?? '', error?.message ?? error);
      const statusCode = error.statusCode ?? (error.code === '23505' ? 409 : 503);
      return json(res, statusCode, {
        error: statusCode === 401 ? 'unauthorized' :
          statusCode === 403 ? 'forbidden' :
            statusCode === 409 ? 'conflict' :
              statusCode === 400 ? 'bad_request' : 'service_unavailable',
        message: statusCode < 500 || config.nodeEnv !== 'production'
          ? error.message
          : 'Service unavailable',
      });
    }
  });
}
