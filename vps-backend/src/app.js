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
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
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
  requireRole(user, ['passenger']);
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
  requireRole(user, ['passenger']);
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
  requireRole(user, ['passenger', 'dashboard']);
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
  requireRole(user, ['passenger']);
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
  requireRole(user, ['passenger']);
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
      'SELECT token FROM device_tokens WHERE user_id = ANY($1::uuid[])',
      [userIds],
    );
    const tokens = result.rows.map((row) => row.token).filter(Boolean);
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
    if (!response.ok) console.error(`FCM webhook returned ${response.status}`);
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
          migration: 'vps-core-firebase-auth-fcm',
          realtime: 'dashboard-polling',
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
