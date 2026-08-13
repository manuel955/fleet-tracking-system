import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { databaseHealth, pool, withTransaction } from './db.js';
import { authenticate, hashPassword, publicUser, signUser, verifyPassword } from './auth.js';
import { authorizePrivateDownload, createPrivateStorageAccessUrl, deletePrivateObjectsForOwner, getStorageObject, isPublicStorageKey, normalizeStorageKey, publicStorageUrl, storageConfigured, uploadStorageObject, verifyPrivateStorageAccessToken } from './storage.js';

const requestRateBuckets = new Map();
const MAX_RATE_BUCKETS = 5000;

export function consumeRateLimit(scope, key, { limit, windowMs, now = Date.now() }) {
  const bucketKey = `${scope}:${String(key || '').trim().toLowerCase()}`;
  let bucket = requestRateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  requestRateBuckets.set(bucketKey, bucket);
  if (requestRateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [storedKey, value] of requestRateBuckets) {
      if (value.resetAt <= now || requestRateBuckets.size > MAX_RATE_BUCKETS) {
        requestRateBuckets.delete(storedKey);
      }
    }
  }
  return {
    allowed: bucket.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function enforceRateLimit(scope, key, options) {
  const result = consumeRateLimit(scope, key, options);
  if (result.allowed) return;
  const error = new Error(`Demasiados intentos. Espera ${result.retryAfterSeconds} segundos.`);
  error.statusCode = 429;
  throw error;
}

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

async function readJson(req, { maxBytes = config.maxJsonBytes } = {}) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      const error = new Error('El cuerpo de la solicitud es demasiado grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString('utf8');
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

export function hasAuthorizedPassengerAccess(user, now = Date.now()) {
  if (user?.role !== 'passenger') return false;
  if (user.passenger_access_status !== 'authorized') return false;
  if (user.passenger_access_expires_at
      && new Date(user.passenger_access_expires_at).getTime() <= now) return false;
  return true;
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
  if (!hasAuthorizedPassengerAccess(user)) {
    const error = new Error('Activa tu acceso con el código QR del hotel.');
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
  requireDashboardAdmin(user);
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
  requireDashboardAdmin(user);
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

export function normalizeDriverPlaceInput(body = {}) {
  const rawType = requiredString(body.type, 'place.type', { max: 20 });
  const type = rawType === 'hotel' || rawType === 'hotels'
    ? 'hotel'
    : rawType === 'sportVenue' || rawType === 'sportVenues'
      ? 'sportVenue'
      : null;
  if (!type) {
    const error = new Error('Tipo de lugar inválido.');
    error.statusCode = 400;
    throw error;
  }
  return {
    type,
    name: requiredString(body.name, 'place.name', { max: 160 }),
  };
}

export function peruDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

async function clearExpiredDriverPlaces() {
  // Las asignaciones son válidas solo durante el día calendario de Perú.
  // Se admite el formato antiguo assignedAt para limpiar datos previos.
  await pool.query(`
    UPDATE drivers
       SET assigned_place = NULL, updated_at = now()
     WHERE assigned_place IS NOT NULL
       AND (
         ((assigned_place ? 'assignedDate')
           AND assigned_place->>'assignedDate' <> to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD'))
         OR
         ((NOT (assigned_place ? 'assignedDate')) AND (assigned_place ? 'assignedAt')
           AND (assigned_place->>'assignedAt') ~ '^[0-9]+$'
           AND to_char(to_timestamp((assigned_place->>'assignedAt')::double precision / 1000)
                       AT TIME ZONE 'America/Lima', 'YYYY-MM-DD')
               <> to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD'))
       )`);
}

async function assignDriverPlace(user, driverIdValue, body) {
  requireDashboardAdmin(user);
  const driverId = postgresUuidOrNull(driverIdValue);
  if (!driverId) {
    const error = new Error('Conductor inválido.');
    error.statusCode = 400;
    throw error;
  }
  const input = normalizeDriverPlaceInput(body);
  const category = input.type === 'hotel' ? 'hotels' : 'sportVenues';
  const placeResult = await pool.query(
    `SELECT id, name, address, latitude, longitude
       FROM places WHERE category = $1 AND name = $2 LIMIT 1`,
    [category, input.name],
  );
  const place = placeResult.rows[0];
  if (!place) {
    const error = new Error('El lugar seleccionado no existe en el VPS.');
    error.statusCode = 404;
    throw error;
  }
  const assignedPlace = {
    id: place.id,
    type: input.type,
    name: place.name,
    address: place.address,
    lat: Number(place.latitude),
    lng: Number(place.longitude),
    assignedAt: Date.now(),
    assignedDate: peruDateKey(),
  };
  const result = await pool.query(
    `UPDATE drivers SET assigned_place = $1::jsonb, updated_at = now()
       WHERE id = $2 RETURNING id`,
    [JSON.stringify(assignedPlace), driverId],
  );
  if (!result.rowCount) {
    const error = new Error('Conductor no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  await notifyVpsDevices([driverId], 'place_assigned', {
    placeName: assignedPlace.name,
    placeType: assignedPlace.type,
    route: 'home',
    deepLink: 'driver://home',
  });
  return { ok: true, driverId, assignedPlace };
}

const DRIVER_REVIEW_FIELDS = new Set([
  'profile', 'dni', 'license', 'soat', 'circulationCard',
  'technicalReview', 'criminalRecord', 'workCertificate',
]);

function hasOwnedDriverDocument(value, driverId) {
  return ownedPrivateStorageUrl(value, `driver_documents/${driverId}/`);
}

function vpsDriverApplicationIssues(row) {
  const issues = [];
  const driverId = row.id;
  if (!String(row.display_name || '').trim()) issues.push('nombre completo');
  if (!String(row.email || '').includes('@')) issues.push('correo válido');
  if (!String(row.phone || '').trim()) issues.push('teléfono');
  if (!String(row.dni || '').trim()) issues.push('DNI');
  if (!String(row.plate || '').trim()) issues.push('placa');
  if (!String(row.vehicle_brand || '').trim()) issues.push('marca del vehículo');
  if (!String(row.vehicle_color || '').trim()) issues.push('color del vehículo');
  if (!Number.isInteger(Number(row.age)) || Number(row.age) < 18) issues.push('edad válida');
  if (!hasOwnedDriverDocument(row.profile_photo_url, driverId)) issues.push('foto de perfil');
  if (!(hasOwnedDriverDocument(row.dni_doc_url, driverId)
    || (hasOwnedDriverDocument(row.dni_front_doc_url, driverId)
      && hasOwnedDriverDocument(row.dni_back_doc_url, driverId)))) issues.push('DNI adjunto');
  const requiredDocs = [
    ['license_doc_url', 'licencia'],
    ['soat_doc_url', 'SOAT'],
    ['circulation_card_doc_url', 'tarjeta de circulación'],
    ['technical_review_doc_url', 'revisión técnica'],
    ['criminal_record_doc_url', 'récord del conductor'],
    ['work_certificate_doc_url', 'certificado laboral'],
  ];
  for (const [field, label] of requiredDocs) {
    if (!hasOwnedDriverDocument(row[field], driverId)) issues.push(label);
  }
  return [...new Set(issues)];
}

function publicDashboardDriver(row) {
  return {
    id: row.id,
    name: row.display_name || '',
    email: row.email || '',
    userStatus: row.user_status || row.status || 'active',
    approvalStatus: row.approval_status || 'pending_review',
    phone: row.phone || '',
    plate: row.plate || '',
    age: row.age == null ? null : Number(row.age),
    vehicleBrand: row.vehicle_brand || '',
    vehicleType: row.vehicle_type || '',
    vehicleColor: row.vehicle_color || '',
    vehicleSeats: row.vehicle_seats == null ? null : Number(row.vehicle_seats),
    profilePhotoUrl: dashboardDocumentUrl(row.profile_photo_url),
    dniDocUrl: dashboardDocumentUrl(row.dni_doc_url),
    dniFrontDocUrl: dashboardDocumentUrl(row.dni_front_doc_url),
    dniBackDocUrl: dashboardDocumentUrl(row.dni_back_doc_url),
    licenseDocUrl: dashboardDocumentUrl(row.license_doc_url),
    soatDocUrl: dashboardDocumentUrl(row.soat_doc_url),
    circulationCardDocUrl: dashboardDocumentUrl(row.circulation_card_doc_url),
    technicalReviewDocUrl: dashboardDocumentUrl(row.technical_review_doc_url),
    criminalRecordDocUrl: dashboardDocumentUrl(row.criminal_record_doc_url),
    workCertificateDocUrl: dashboardDocumentUrl(row.work_certificate_doc_url),
    licenseExpiresAt: row.license_expires_at == null ? null : Number(row.license_expires_at),
    soatExpiresAt: row.soat_expires_at == null ? null : Number(row.soat_expires_at),
    technicalReviewExpiresAt: row.technical_review_expires_at == null ? null : Number(row.technical_review_expires_at),
    documentsSubmittedAt: row.application_submitted_at ? new Date(row.application_submitted_at).getTime() : null,
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by || '',
    rejectionReason: row.rejection_reason || '',
    rejectionFieldKeys: row.rejection_field_keys || '',
    suspended: row.suspended === true,
    suspensionReason: row.suspension_reason || '',
    suspendedAt: row.suspended_at == null ? null : Number(row.suspended_at),
    suspendedBy: row.suspended_by || '',
    availabilityStatus: row.availability_status || 'offline',
    currentTripId: row.current_trip_id || null,
    assignedPlace: row.assigned_place || null,
    lat: row.latitude == null ? null : Number(row.latitude),
    lng: row.longitude == null ? null : Number(row.longitude),
    lastUpdate: row.recorded_at ? new Date(row.recorded_at).getTime() : null,
  };
}

async function manageVpsDriver(user, driverIdValue, body) {
  requireDashboardAdmin(user);
  const driverId = postgresUuidOrNull(driverIdValue);
  if (!driverId) throw Object.assign(new Error('Conductor inválido.'), { statusCode: 400 });
  const result = await pool.query(
    `SELECT d.*, u.display_name, u.email, u.status AS user_status,
            l.latitude, l.longitude, l.recorded_at
       FROM drivers d JOIN users u ON u.id=d.id
       LEFT JOIN driver_locations l ON l.driver_id=d.id
      WHERE d.id=$1`,
    [driverId],
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error('Conductor no encontrado.'), { statusCode: 404 });
  const action = requiredString(body.action, 'action', { max: 20 });
  if (action === 'approve') {
    if (row.approval_status !== 'pending_review') {
      throw Object.assign(new Error('Solo se puede aprobar un registro pendiente.'), { statusCode: 409 });
    }
    const issues = vpsDriverApplicationIssues(row);
    if (issues.length) {
      throw Object.assign(new Error(`No se puede aprobar. Falta o está vencido: ${issues.join(', ')}.`), { statusCode: 409, issues });
    }
    await pool.query(
      `UPDATE drivers SET approval_status='approved', rejection_reason=NULL,
          rejection_field_keys=NULL, reviewed_at=$1, reviewed_by=$2,
          updated_at=now() WHERE id=$3`,
      [Date.now(), user.email || '', driverId],
    );
    await notifyVpsDevices([driverId], 'driver_approved', { route: 'home', deepLink: 'driver://home' });
  } else if (action === 'reject') {
    const reason = String(body.reason || '').trim();
    const fields = Array.isArray(body.rejectionFields) ? [...new Set(body.rejectionFields.map((value) => String(value)))] : [];
    if (!reason) throw Object.assign(new Error('Escribe el motivo del rechazo.'), { statusCode: 400 });
    if (!fields.length || fields.some((field) => !DRIVER_REVIEW_FIELDS.has(field))) {
      throw Object.assign(new Error('Selecciona al menos un dato o documento que deba corregirse.'), { statusCode: 400 });
    }
    await pool.query(
      `UPDATE drivers SET approval_status='rejected', rejection_reason=$1,
          rejection_field_keys=$2, reviewed_at=$3, reviewed_by=$4,
          availability_status='offline', updated_at=now() WHERE id=$5`,
      [reason, fields.join(','), Date.now(), user.email || '', driverId],
    );
  } else if (action === 'suspend' || action === 'reinstate') {
    if (action === 'suspend') {
      const reason = String(body.reason || '').trim();
      if (reason.length < 5 || reason.length > 300) throw Object.assign(new Error('Escribe un motivo entre 5 y 300 caracteres.'), { statusCode: 400 });
      if (row.current_trip_id) throw Object.assign(new Error('No puedes suspender a un conductor con un viaje activo.'), { statusCode: 409 });
      await pool.query(
        `UPDATE drivers SET suspended=TRUE, suspension_reason=$1, suspended_at=$2,
            suspended_by=$3, availability_status='offline', updated_at=now() WHERE id=$4`,
        [reason, Date.now(), user.email || '', driverId],
      );
    } else {
      await pool.query(
        `UPDATE drivers SET suspended=FALSE, suspension_reason=NULL, suspended_at=NULL,
            suspended_by=NULL, updated_at=now() WHERE id=$1`,
        [driverId],
      );
    }
  } else if (action === 'delete') {
    await deleteVpsDriverAccount(driverId, user.email || 'dashboard');
    return { ok: true, deleted: true, authDeleted: true, driver: null };
  } else {
    throw Object.assign(new Error('Acción de conductor inválida.'), { statusCode: 400 });
  }
  const fresh = await pool.query(
    `SELECT d.*, u.display_name, u.email, u.status AS user_status,
            l.latitude, l.longitude, l.recorded_at
       FROM drivers d JOIN users u ON u.id=d.id
       LEFT JOIN driver_locations l ON l.driver_id=d.id WHERE d.id=$1`,
    [driverId],
  );
  return { ok: true, driver: fresh.rows[0] ? publicDashboardDriver(fresh.rows[0]) : null };
}

// El mismo borrado seguro se usa desde el dashboard y desde la propia app.
// Se conserva la relación histórica de los viajes como dato operativo
// anonimizado, pero se revocan inmediatamente los tokens push y la última
// ubicación para que una cuenta eliminada no pueda recibir alertas ni aparecer
// en la flota.
export function driverAccountDeletionBlocked(currentTripId, activeTripId) {
  return Boolean(currentTripId || activeTripId);
}

async function deleteVpsDriverAccount(driverId, actorLabel) {
  return withTransaction(async (client) => {
    const driverResult = await client.query(
      `SELECT current_trip_id FROM drivers WHERE id=$1 FOR UPDATE`,
      [driverId],
    );
    const driver = driverResult.rows[0];
    if (!driver) {
      throw Object.assign(new Error('Conductor no encontrado.'), { statusCode: 404 });
    }
    const activeTrips = await client.query(
      `SELECT id FROM trips
        WHERE driver_id=$1 AND status NOT IN ('completed', 'cancelled', 'no_drivers_available')
        LIMIT 1`,
      [driverId],
    );
    if (driverAccountDeletionBlocked(driver.current_trip_id, activeTrips.rows[0]?.id)) {
      throw Object.assign(new Error('No puedes eliminar a un conductor con un viaje activo.'), { statusCode: 409 });
    }

    const now = Date.now();
    await client.query(
      `UPDATE trips SET driver_id=NULL, updated_at=now() WHERE driver_id=$1`,
      [driverId],
    );
    const tokenResult = await client.query(
      `DELETE FROM device_tokens WHERE user_id=$1`,
      [driverId],
    );
    const locationResult = await client.query(
      `DELETE FROM driver_locations WHERE driver_id=$1`,
      [driverId],
    );
    await client.query(
      `UPDATE drivers SET approval_status='rejected', phone='',
          plate=$1, age=NULL, dni='', vehicle_brand='', vehicle_color='',
          profile_photo_url=NULL, dni_doc_url=NULL, dni_front_doc_url=NULL,
          dni_back_doc_url=NULL, license_doc_url=NULL, soat_doc_url=NULL,
          circulation_card_doc_url=NULL, technical_review_doc_url=NULL,
          criminal_record_doc_url=NULL, work_certificate_doc_url=NULL,
          license_expires_at=NULL, soat_expires_at=NULL,
          technical_review_expires_at=NULL, application_submitted_at=NULL,
          assigned_place=NULL, availability_status='offline',
          current_trip_id=NULL, suspended=TRUE,
          suspension_reason=$2, suspended_at=$3, suspended_by=$4,
          reviewed_at=$3, reviewed_by=$4, rejection_reason='Cuenta eliminada',
          rejection_field_keys=NULL, updated_at=now()
        WHERE id=$5`,
      [
        `DELETED-${driverId.slice(0, 12)}`,
        `Cuenta eliminada por ${actorLabel}`,
        now,
        actorLabel,
        driverId,
      ],
    );
    await client.query(
      `UPDATE users SET email=NULL, password_hash=NULL,
          display_name='Cuenta eliminada', status='disabled',
          session_version=session_version+1, updated_at=now()
        WHERE id=$1`,
      [driverId],
    );
    return {
      tokenCount: tokenResult.rowCount || 0,
      locationRemoved: (locationResult.rowCount || 0) > 0,
    };
  });
}

async function deleteCurrentVpsDriverAccount(user) {
  requireRole(user, ['driver']);
  const result = await deleteVpsDriverAccount(user.id, user.email || 'el conductor');
  return { ok: true, deleted: true, authDeleted: true, ...result };
}

async function deleteCurrentVpsAccount(user) {
  if (user?.role === 'driver') return deleteCurrentVpsDriverAccount(user);
  requireRole(user, ['passenger']);
  const activeTrip = await pool.query(
    `SELECT id FROM trips
      WHERE passenger_id = $1
        AND status NOT IN ('completed', 'cancelled', 'no_drivers_available')
      LIMIT 1`,
    [user.id],
  );
  if (activeTrip.rowCount) {
    throw Object.assign(new Error('Cancela o finaliza tu viaje antes de eliminar la cuenta.'), { statusCode: 409 });
  }
  // Object storage cannot participate in a PostgreSQL transaction. Delete it
  // before anonymizing the account so failures leave a retryable DB state.
  await deletePrivateObjectsForOwner(user.id);
  const result = await withTransaction(async (client) => {
    const tokenResult = await client.query('DELETE FROM device_tokens WHERE user_id=$1', [user.id]);
    await client.query(
      `UPDATE passenger_profiles SET phone='', credential_photo_url=NULL, updated_at=now()
        WHERE user_id=$1`,
      [user.id],
    );
    await client.query(
      `UPDATE users SET email=NULL, password_hash=NULL, display_name='Cuenta eliminada',
          status='disabled', passenger_access_status='revoked',
          session_version=session_version+1, updated_at=now()
        WHERE id=$1 AND role='passenger'`,
      [user.id],
    );
    return { tokenCount: tokenResult.rowCount || 0 };
  });
  return { ok: true, deleted: true, authDeleted: true, ...result };
}

async function removePlace(user, id) {
  requireDashboardAdmin(user);
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
    source: row.source || 'vps',
    createdAt: row.created_at,
  };
}

async function manageDashboardUsers(user, body) {
  requireRole(user, ['dashboard']);
  const firebaseAdmin = user.firebaseClaims?.dashboardAdmin === true
    || String(user.firebaseClaims?.dashboardRole || '').toUpperCase() === 'ADMIN';
  if (String(user.dashboard_role || '').toUpperCase() !== 'ADMIN' && !firebaseAdmin) {
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
    const users = result.rows.map((row) => publicDashboardUser(row, user.id));
    // During the migration, an existing Firebase dashboard account can still
    // authenticate through the legacy identity provider even though it has no
    // row in the VPS users table. Show that signed-in account in the list so
    // administrators can distinguish it from a missing account. It remains
    // Firebase-managed until it is explicitly recreated in the VPS account
    // manager; no password is invented or copied from Firebase.
    if (user.firebaseClaims && user.email &&
        !users.some((entry) => entry.email.toLowerCase() === user.email.toLowerCase())) {
      users.unshift(publicDashboardUser({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        status: 'active',
        dashboard_role: user.dashboard_role || user.firebaseClaims.dashboardRole || 'SUPERVISOR',
        dashboard_sede_type: user.dashboard_sede_type || user.firebaseClaims.sedeType || null,
        dashboard_sede_id: user.dashboard_sede_id || user.firebaseClaims.sedeId || null,
        sede_name: user.sede_name || user.firebaseClaims.sedeName || null,
        created_at: null,
        source: 'firebase',
      }, user.id));
    }
    return { users };
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
  requireDashboardAdmin(user);
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
  enforceRateLimit('register', email, { limit: 5, windowMs: 60 * 60 * 1000 });
  const password = requiredString(body.password, 'password', { min: 8, max: 128 });
  const role = body.role === 'driver' ? 'driver' : 'passenger';
  if (role === 'passenger') {
    const error = new Error('Primero activa el acceso con el código QR del hotel.');
    error.statusCode = 403;
    throw error;
  }
  const displayName = requiredString(body.displayName ?? body.name ?? '', 'displayName', { max: 120 });
  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (role, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, role, email, display_name, status, session_version`,
      [role, email, passwordHash, displayName],
    );
    const created = inserted.rows[0];
    if (role === 'driver') {
      const plate = requiredString(body.plate, 'plate', { max: 20 }).toUpperCase();
      const vehicleType = requiredString(body.vehicleType ?? 'Auto', 'vehicleType', { max: 40 });
      const vehicleSeats = validateVehicleCapacity(vehicleType, body.vehicleSeats ?? 4);
      await client.query(
        `INSERT INTO drivers (id, phone, plate, vehicle_type, vehicle_seats)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          created.id,
          requiredString(body.phone ?? '', 'phone', { max: 30 }),
          plate,
          vehicleType,
          vehicleSeats,
        ],
      );
    }
    return created;
    });
  } catch (error) {
    if (error?.code === '23505') {
      error.statusCode = 409;
      error.message = error.constraint === 'drivers_plate_key'
        ? 'Ya existe un conductor con esa placa.'
        : 'Ya existe una cuenta con ese correo.';
    }
    throw error;
  }
  return { token: signUser(user), user: publicUser(user) };
}

async function linkPassengerEmail(user, body) {
  assertPassengerAccess(user);
  const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
  const password = requiredString(body.password, 'password', { min: 8, max: 128 });
  if (!email.includes('@')) {
    const error = new Error('Escribe un correo válido.');
    error.statusCode = 400;
    throw error;
  }
  const passwordHash = await hashPassword(password);
  try {
    const result = await pool.query(
      `UPDATE users
          SET email=$1, password_hash=$2, session_version=session_version+1, updated_at=now()
        WHERE id=$3 AND role='passenger' AND passenger_access_status='authorized'
        RETURNING id, role, email, display_name, status, session_version,
          passenger_access_status, passenger_access_expires_at`,
      [email, passwordHash, user.id],
    );
    if (!result.rows[0]) {
      throw Object.assign(new Error('Activa tu acceso con el código QR del hotel.'), { statusCode: 403 });
    }
    return { token: signUser(result.rows[0]), user: publicUser(result.rows[0]) };
  } catch (error) {
    if (error?.code === '23505') {
      error.statusCode = 409;
      error.message = 'Ya existe una cuenta con ese correo.';
    }
    throw error;
  }
}

async function login(body) {
  const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
  enforceRateLimit('login', email, { limit: 20, windowMs: 15 * 60 * 1000 });
  const password = requiredString(body.password, 'password', { min: 1, max: 128 });
  if (!pool) throw new Error('Database is not configured');
  const result = await pool.query(
    `SELECT u.id, u.role, u.email, u.password_hash, u.display_name, u.status,
        u.session_version, u.passenger_access_status, u.passenger_access_expires_at,
        u.dashboard_role, u.dashboard_sede_type, u.dashboard_sede_id,
        p.name AS sede_name, p.address AS sede_address,
        p.latitude AS sede_lat, p.longitude AS sede_lng
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

async function ensurePasswordResetTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)');
}

async function requestPasswordReset(body) {
  const email = requiredString(body.email, 'email', { max: 254 }).toLowerCase();
  enforceRateLimit('password-reset', email, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!config.resendApiKey || !config.mailFrom) {
    throw Object.assign(new Error('La recuperación por correo aún no está configurada en el VPS.'), { statusCode: 503 });
  }
  await ensurePasswordResetTable();
  const userResult = await pool.query(
    `SELECT id, email FROM users WHERE lower(email)=lower($1) AND status='active'
       AND role IN ('driver','passenger','dashboard') LIMIT 1`,
    [email],
  );
  // Always return the same success response for unknown addresses.
  if (!userResult.rowCount) return { ok: true };
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    `UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`,
    [userResult.rows[0].id],
  );
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
    [userResult.rows[0].id, tokenHash],
  );
  const resetUrl = `${config.publicApiBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.mailFrom,
      to: [email],
      subject: 'Restablece tu contraseña de APL Logistics',
      html: `<p>Solicitaste cambiar tu contraseña de APL Logistics.</p><p><a href="${resetUrl}">Crear una contraseña nueva</a></p><p>El enlace vence en 30 minutos.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await pool.query('DELETE FROM password_reset_tokens WHERE token_hash=$1', [tokenHash]);
    throw Object.assign(new Error('No se pudo enviar el correo de recuperación.'), { statusCode: 502 });
  }
  return { ok: true };
}

async function resetPassword(body) {
  const token = requiredString(body.token, 'token', { min: 32, max: 128 });
  const password = requiredString(body.password, 'password', { min: 8, max: 128 });
  await ensurePasswordResetTable();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = await hashPassword(password);
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [tokenHash],
    );
    if (!found.rowCount) throw Object.assign(new Error('El enlace de recuperación venció o ya fue usado.'), { statusCode: 400 });
    await client.query(
      `UPDATE users SET password_hash=$1, session_version=session_version+1,
          updated_at=now() WHERE id=$2 AND status='active'`,
      [passwordHash, found.rows[0].user_id],
    );
    await client.query(`UPDATE password_reset_tokens SET used_at=now() WHERE id=$1`, [found.rows[0].id]);
    return { ok: true };
  });
  return result;
}

function resetPasswordPage(token = '') {
  const safeToken = String(token).replace(/[^a-f0-9]/gi, '');
  return `<!doctype html><meta charset="utf-8"><title>Restablecer contraseña</title><style>body{font:16px system-ui;max-width:420px;margin:48px auto;padding:0 20px}input,button{width:100%;padding:12px;margin:8px 0}button{cursor:pointer}</style><h1>Restablecer contraseña</h1><form id="f"><input id="p" type="password" minlength="8" placeholder="Nueva contraseña" required><button>Guardar</button></form><p id="m"></p><script>const t=${JSON.stringify(safeToken)};f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/v1/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,password:p.value})});m.textContent=r.ok?'Contraseña actualizada. Ya puedes iniciar sesión.':((await r.json()).message||'No se pudo actualizar.');}</script>`;
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

const VEHICLE_PASSENGER_RANGES = Object.freeze({
  Auto: [1, 4],
  SUV: [5, 7],
  'Mini van': [8, 17],
  Van: [18, 20],
  'Mini bus': [21, 38],
  Bus: [39, 45],
});

export function validateVehicleCapacity(vehicleType, vehicleSeats) {
  const range = VEHICLE_PASSENGER_RANGES[String(vehicleType || '').trim()];
  const seats = Number(vehicleSeats);
  if (!range || !Number.isInteger(seats) || seats < range[0] || seats > range[1]) {
    const error = new Error('Tipo y capacidad del vehÃ­culo no son compatibles.');
    error.statusCode = 400;
    throw error;
  }
  return seats;
}

function ownedPrivateStorageUrl(value, prefix) {
  const raw = String(value ?? '').trim();
  return raw.startsWith(`${config.publicApiBaseUrl}/api/v1/storage/download/${encodeURIComponent(prefix)}`);
}

function dashboardDocumentUrl(value) {
  const raw = String(value ?? '').trim();
  const prefix = `${config.publicApiBaseUrl}/api/v1/storage/download/`;
  if (!raw.startsWith(prefix)) return raw;
  try {
    const key = normalizeStorageKey(decodeURIComponent(raw.slice(prefix.length)));
    return createPrivateStorageAccessUrl(key);
  } catch (_) {
    return '';
  }
}

async function savePassengerProfile(user, body) {
  requireRole(user, ['passenger']);
  assertPassengerAccess(user);
  const name = requiredString(body.name ?? '', 'name', { max: 120 });
  const phone = requiredString(body.phone ?? '', 'phone', { max: 40 });
  const credentialPhotoUrl = body.credentialPhotoUrl ? requiredString(body.credentialPhotoUrl, 'credentialPhotoUrl', { max: 600 }) : null;
  if (credentialPhotoUrl && !ownedPrivateStorageUrl(credentialPhotoUrl, `passenger_credentials/${user.id}/`)) {
    throw Object.assign(new Error('La foto de credencial no pertenece a esta cuenta.'), { statusCode: 400 });
  }
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET display_name=$1, updated_at=now() WHERE id=$2', [name, user.id]);
    await client.query(
      `INSERT INTO passenger_profiles (user_id, phone, credential_photo_url, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET phone=EXCLUDED.phone,
         credential_photo_url=COALESCE(EXCLUDED.credential_photo_url, passenger_profiles.credential_photo_url), updated_at=now()`,
      [user.id, phone, credentialPhotoUrl],
    );
  });
  return { name, phone, ...(credentialPhotoUrl ? { photoUrl: credentialPhotoUrl } : {}) };
}

async function getPassengerProfile(user) {
  requireRole(user, ['passenger']);
  assertPassengerAccess(user);
  const result = await pool.query(
    `SELECT u.display_name, p.phone, p.credential_photo_url
       FROM users u LEFT JOIN passenger_profiles p ON p.user_id=u.id WHERE u.id=$1`,
    [user.id],
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error('Perfil de pasajero no encontrado.'), { statusCode: 404 });
  return { name: row.display_name || '', phone: row.phone || '', ...(row.credential_photo_url ? { photoUrl: row.credential_photo_url } : {}) };
}

async function submitDriverApplication(user, body) {
  requireRole(user, ['driver']);
  const currentResult = await pool.query('SELECT * FROM drivers WHERE id=$1', [user.id]);
  const current = currentResult.rows[0] ?? {};
  const valueOrCurrent = (value, column) => value === undefined || value === null || value === '' ? current[column] : value;
  const name = requiredString(body.name ?? user.display_name ?? '', 'name', { max: 120 });
  const phone = requiredString(valueOrCurrent(body.phone, 'phone') ?? '', 'phone', { max: 30 });
  const dni = requiredString(valueOrCurrent(body.dni, 'dni') ?? '', 'dni', { max: 30 });
  const plate = requiredString(valueOrCurrent(body.plate, 'plate') ?? '', 'plate', { max: 20 }).toUpperCase();
  const vehicleBrand = requiredString(valueOrCurrent(body.vehicleBrand, 'vehicle_brand') ?? '', 'vehicleBrand', { max: 80 });
  const vehicleType = requiredString(valueOrCurrent(body.vehicleType, 'vehicle_type') ?? 'Auto', 'vehicleType', { max: 40 });
  const vehicleColor = requiredString(valueOrCurrent(body.vehicleColor, 'vehicle_color') ?? '', 'vehicleColor', { max: 60 });
  const vehicleSeats = validateVehicleCapacity(vehicleType, valueOrCurrent(body.vehicleSeats, 'vehicle_seats') ?? 4);
  const docFields = ['profilePhotoUrl', 'dniDocUrl', 'dniFrontDocUrl', 'dniBackDocUrl', 'licenseDocUrl', 'soatDocUrl', 'circulationCardDocUrl', 'technicalReviewDocUrl', 'criminalRecordDocUrl', 'workCertificateDocUrl'];
  const docColumns = Object.fromEntries(docFields.map((field) => [field, field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]));
  const docs = {};
  for (const field of docFields) {
    if ((field === 'dniDocUrl' || field === 'dniFrontDocUrl' || field === 'dniBackDocUrl') && !body[field] && !current[docColumns[field]]) continue;
    const value = requiredString(valueOrCurrent(body[field], docColumns[field]) ?? '', field, { max: 600 });
    if (!ownedPrivateStorageUrl(value, `driver_documents/${user.id}/`)) throw Object.assign(new Error(`Documento invÃ¡lido: ${field}`), { statusCode: 400 });
    docs[docColumns[field]] = value;
  }
  if (!docs.dni_doc_url && !(docs.dni_front_doc_url && docs.dni_back_doc_url)) {
    throw Object.assign(new Error('Falta el DNI (PDF o anverso y reverso).'), { statusCode: 400 });
  }
  const age = body.age === undefined ? (current.age == null ? null : Number(current.age)) : Number(body.age);
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET display_name=$1, updated_at=now() WHERE id=$2', [name, user.id]);
    const columns = ['phone', 'plate', 'vehicle_brand', 'vehicle_type', 'vehicle_color', 'vehicle_seats', 'dni', 'age', ...Object.keys(docs)];
    const values = [phone, plate, vehicleBrand, vehicleType, vehicleColor, vehicleSeats, dni, age, ...Object.values(docs), user.id];
    const assignments = columns.map((column, index) => `${column}=$${index + 1}`).join(', ');
    await client.query(`UPDATE drivers SET ${assignments}, approval_status='pending_review', application_submitted_at=now(), updated_at=now() WHERE id=$${values.length}`, values);
  });
  return { id: user.id, approvalStatus: 'pending_review' };
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

function scheduledPickupLabel(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const local = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return day === today ? `Hoy a las ${local}` : `${day} a las ${local}`;
}

function tripAssignmentPushData(trip) {
  const label = scheduledPickupLabel(trip.scheduledPickupAt);
  return {
    tripId: trip.id,
    status: trip.status,
    pickupAddress: trip.pickupAddress,
    destinationAddress: trip.destinationAddress,
    scheduledPickupAt: trip.scheduledPickupAt,
    ...(label ? { scheduledPickupLabel: label, scheduledPickupSpeech: label } : {}),
    route: 'active-trip',
    deepLink: `driver://trip/${trip.id}`,
  };
}

function publicTrip(row) {
  const millis = (value) => value ? new Date(value).getTime() : null;
  return {
    id: row.id,
    passengerId: row.passenger_id,
    driverId: row.driver_id,
    // The passenger's trip screen needs the assigned driver's contact and
    // vehicle details immediately, before its separate location poll runs.
    driverName: row.driver_name || '',
    driverPhone: row.driver_phone || '',
    driverPlate: row.driver_plate || '',
    vehicleBrand: row.driver_vehicle_brand || '',
    vehicleType: row.driver_vehicle_type || '',
    vehicleColor: row.driver_vehicle_color || '',
    vehicleSeats: row.driver_vehicle_seats ?? null,
    status: row.status,
    pickupAddress: row.origin_address,
    pickupLat: Number(row.origin_lat),
    pickupLng: Number(row.origin_lng),
    destinationAddress: row.destination_address,
    destinationLat: Number(row.destination_lat),
    destinationLng: Number(row.destination_lng),
    passengerCount: row.passenger_count ?? 1,
    passengerName: row.passenger_name || '',
    passengerPhone: row.passenger_phone || '',
    scheduledPickupAt: millis(row.scheduled_pickup_at),
    requestedAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
    completedAt: millis(row.completed_at),
    acceptedAt: millis(row.accepted_at),
    inProgressAt: millis(row.in_progress_at),
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    rating: row.rating,
    feedbackComment: row.feedback_comment,
    feedback: row.rating == null
        && !row.feedback_comment
        && !row.incident_category
        && !row.incident_details
      ? null
      : {
          rating: row.rating,
          comment: row.feedback_comment || '',
          incidentCategory: row.incident_category || 'none',
          incidentDetails: row.incident_details || '',
          incidentStatus: row.incident_status || 'NONE',
        },
  };
}

const tripSelect = `
  SELECT id, passenger_id, driver_id, status,
    origin_address, origin_lat, origin_lng,
    destination_address, destination_lat, destination_lng,
    passenger_count, scheduled_pickup_at, created_at, updated_at,
    completed_at, accepted_at, in_progress_at,
    cancelled_by, cancel_reason, rating, feedback_comment,
    request_id, requested_passenger_name, requested_passenger_phone,
    (SELECT u.display_name FROM users u WHERE u.id = trips.driver_id) AS driver_name,
    (SELECT d.phone FROM drivers d WHERE d.id = trips.driver_id) AS driver_phone,
    (SELECT d.plate FROM drivers d WHERE d.id = trips.driver_id) AS driver_plate,
    (SELECT d.vehicle_brand FROM drivers d WHERE d.id = trips.driver_id) AS driver_vehicle_brand,
    (SELECT d.vehicle_type FROM drivers d WHERE d.id = trips.driver_id) AS driver_vehicle_type,
    (SELECT d.vehicle_color FROM drivers d WHERE d.id = trips.driver_id) AS driver_vehicle_color,
    (SELECT d.vehicle_seats FROM drivers d WHERE d.id = trips.driver_id) AS driver_vehicle_seats,
    COALESCE(requested_passenger_name,
      (SELECT u.display_name FROM users u WHERE u.id = trips.passenger_id)) AS passenger_name,
    COALESCE(requested_passenger_phone,
      (SELECT pp.phone FROM passenger_profiles pp WHERE pp.user_id = trips.passenger_id)) AS passenger_phone,
    (SELECT tf.incident_category FROM trip_feedback tf WHERE tf.trip_id=trips.id) AS incident_category,
    (SELECT tf.incident_details FROM trip_feedback tf WHERE tf.trip_id=trips.id) AS incident_details,
    (SELECT tf.incident_status FROM trip_feedback tf WHERE tf.trip_id=trips.id) AS incident_status
  FROM trips`;

async function findTrip(tripId) {
  if (!pool) throw new Error('Database is not configured');
  const result = await pool.query(`${tripSelect} WHERE id = $1`, [tripId]);
  return result.rows[0] ?? null;
}

export function buildAvailableDriverQuery(tripId, passengerCount, preferredDriverId = null) {
  const preferredClause = preferredDriverId ? 'AND d.id = $3::uuid' : '';
  return {
    text: `WITH requested_trip AS (
             SELECT origin_lat, origin_lng
               FROM trips
              WHERE id = $1
           )
           SELECT d.id
             FROM drivers d
             CROSS JOIN requested_trip t
             LEFT JOIN driver_locations l
               ON l.driver_id = d.id
              AND l.recorded_at >= now() - interval '2 minutes'
             WHERE d.approval_status = 'approved'
              AND d.suspended = FALSE
              AND d.availability_status = 'online'
              AND d.current_trip_id IS NULL
              AND d.vehicle_seats >= $2
              ${preferredClause}
            ORDER BY
              d.vehicle_seats ASC,
              CASE WHEN l.latitude IS NULL OR l.longitude IS NULL THEN 1 ELSE 0 END,
              CASE WHEN l.latitude IS NULL OR l.longitude IS NULL THEN NULL ELSE
                6371000 * acos(LEAST(1, GREATEST(-1,
                  cos(radians(t.origin_lat)) * cos(radians(l.latitude)) *
                    cos(radians(l.longitude) - radians(t.origin_lng)) +
                  sin(radians(t.origin_lat)) * sin(radians(l.latitude))
                )))
              END ASC,
              d.updated_at ASC
            FOR UPDATE OF d SKIP LOCKED
            LIMIT 1`,
    values: preferredDriverId
      ? [tripId, passengerCount, preferredDriverId]
      : [tripId, passengerCount],
  };
}

async function assignAvailableDriver(client, tripId, passengerCount) {
  const assignmentQuery = buildAvailableDriverQuery(tripId, passengerCount);
  const driverResult = await client.query(assignmentQuery.text, assignmentQuery.values);
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
    `UPDATE trips SET status = 'accepted', driver_id = $1, accepted_at = COALESCE(accepted_at, now()), updated_at = now()
      WHERE id = $2`,
    [driver.id, tripId],
  );
  await client.query(
    `UPDATE drivers SET current_trip_id = $1, updated_at = now() WHERE id = $2`,
    [tripId, driver.id],
  );
  return driver.id;
}

// A passenger can request a trip a few seconds before a driver finishes
// starting the shift. Claim the oldest pending trip when that driver becomes
// online so the passenger is not forced to press Reintentar manually.
async function assignPendingTripForDriver(client, preferredDriverId = null) {
  const pending = await client.query(
    `SELECT id, passenger_count
       FROM trips
      WHERE status IN ('searching', 'no_drivers_available')
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
  );
  const trip = pending.rows[0];
  if (!trip) return null;
  const assignmentQuery = buildAvailableDriverQuery(
    trip.id,
    trip.passenger_count ?? 1,
    preferredDriverId,
  );
  const driverResult = await client.query(assignmentQuery.text, assignmentQuery.values);
  const driverId = driverResult.rows[0]?.id;
  if (!driverId) return null;
  await client.query(
    `UPDATE trips SET status = 'accepted', driver_id = $1, accepted_at = COALESCE(accepted_at, now()), updated_at = now() WHERE id = $2`,
    [driverId, trip.id],
  );
  await client.query(
    `UPDATE drivers SET current_trip_id = $1, updated_at = now() WHERE id = $2`,
    [trip.id, driverId],
  );
  if (!driverId) return null;
  const updated = await client.query(`${tripSelect} WHERE id = $1`, [trip.id]);
  return updated.rows[0] ? publicTrip(updated.rows[0]) : null;
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
  const requestId = body.requestId == null || body.requestId === ''
    ? null
    : requiredString(body.requestId, 'requestId', { min: 16, max: 128 });
  const scheduledPickupAt = parseScheduledPickup(body.scheduledPickupAt);
  const status = scheduledPickupAt && scheduledPickupAt.getTime() > Date.now() + 60_000
    ? 'scheduled'
    : 'searching';

  const trip = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(user.id)]);
    if (requestId) {
      const existingRequest = await client.query(
        `${tripSelect} WHERE passenger_id=$1 AND request_id=$2 LIMIT 1`,
        [user.id, requestId],
      );
      if (existingRequest.rows[0]) return publicTrip(existingRequest.rows[0]);
    }
    const openTrip = await client.query(
      `${tripSelect}
        WHERE passenger_id=$1
          AND status NOT IN ('completed', 'cancelled', 'no_drivers_available')
          AND (($2::timestamptz IS NULL AND scheduled_pickup_at IS NULL)
            OR ($2::timestamptz IS NOT NULL AND scheduled_pickup_at IS NOT NULL))
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id, scheduledPickupAt],
    );
    if (openTrip.rows[0]) return publicTrip(openTrip.rows[0]);
    const inserted = await client.query(
      `INSERT INTO trips (
        passenger_id, status, origin_address, origin_lat, origin_lng,
        destination_address, destination_lat, destination_lng,
        passenger_count, scheduled_pickup_at, request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`,
      [
        user.id, status, pickupAddress, pickupLat, pickupLng,
        destinationAddress, destinationLat, destinationLng,
        passengerCount, scheduledPickupAt, requestId,
      ],
    );
    const tripId = inserted.rows[0].id;
    if (status === 'searching') await assignAvailableDriver(client, tripId, passengerCount);
    const result = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(result.rows[0]);
  });
  if (trip.driverId) {
    await notifyVpsDevices([trip.driverId], 'trip_assigned', tripAssignmentPushData(trip));
  } else if (trip.status === 'no_drivers_available') {
    await notifyVpsDevices([trip.passengerId], 'no_drivers_available', {
      tripId: trip.id,
      status: trip.status,
      reason: 'No encontramos un conductor disponible.',
      route: 'searching',
      deepLink: `passenger://trip/${trip.id}`,
    });
  }
  return trip;
}

async function createCoordinatorTrip(user, body) {
  requireDashboardCoordinator(user);
  const place = await getCoordinatorPlace(user);
  const destinationAddress = requiredString(body.destinationAddress, 'destinationAddress', { max: 255 });
  const destinationLat = parseCoordinate(body.destinationLat, 'destinationLat', -90, 90);
  const destinationLng = parseCoordinate(body.destinationLng, 'destinationLng', -180, 180);
  const passengerCount = parsePassengerCount(body.passengerCount);
  const trip = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO trips (
        passenger_id, status, origin_address, origin_lat, origin_lng,
        destination_address, destination_lat, destination_lng, passenger_count,
        requested_passenger_name, requested_passenger_phone
      ) VALUES ($1, 'searching', $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [user.id, place.address, place.lat, place.lng, destinationAddress,
        destinationLat, destinationLng, passengerCount,
        String(body.passengerName || '').trim().slice(0, 120) || user.display_name || 'Pasajero de sede',
        String(body.passengerPhone || '').trim().slice(0, 40)],
    );
    const tripId = inserted.rows[0].id;
    await assignAvailableDriver(client, tripId, passengerCount);
    const result = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    const value = publicTrip(result.rows[0]);
    return value;
  });
  if (trip.driverId) {
    await notifyVpsDevices([trip.driverId], 'trip_assigned', tripAssignmentPushData(trip));
  }
  return trip;
}

async function listCoordinatorTrips(user) {
  requireDashboardCoordinator(user);
  const result = await pool.query(
    `${tripSelect} WHERE passenger_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [user.id],
  );
  return result.rows.map(publicTrip);
}

async function getCoordinatorTripDetail(user, tripId) {
  requireDashboardCoordinator(user);
  const trip = await findTrip(tripId);
  if (!trip || trip.passenger_id !== user.id) {
    const error = new Error('Viaje no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  let driverLocation = null;
  if (trip.driver_id) {
    const result = await pool.query(
      `SELECT latitude, longitude, accuracy_m, recorded_at
         FROM driver_locations WHERE driver_id = $1`,
      [trip.driver_id],
    );
    const row = result.rows[0];
    if (row && row.latitude !== null && row.longitude !== null) {
      driverLocation = {
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
        lastUpdate: new Date(row.recorded_at).getTime(),
      };
    }
  }
  return { trip: publicTrip(trip), driverLocation };
}

async function cancelCoordinatorTrip(user, tripId, body) {
  requireDashboardCoordinator(user);
  const trip = await findTrip(tripId);
  if (!trip || trip.passenger_id !== user.id) {
    const error = new Error('Viaje no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  return cancelTrip(user, tripId, body || {});
}

function canReadTrip(user, trip) {
  if (user.role === 'dashboard') {
    return isDashboardAdmin(user)
      || (isDashboardCoordinator(user) && trip.passenger_id === user.id);
  }
  return trip.passenger_id === user.id || trip.driver_id === user.id;
}

async function listTrips(user, url) {
  requireRole(user, ['passenger', 'driver', 'dashboard']);
  if (user.role === 'passenger') assertPassengerAccess(user);
  if (user.role === 'dashboard') requireDashboardAdmin(user);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
  const conditions = [];
  const values = [];
  if (user.role === 'passenger') {
    values.push(user.id);
    conditions.push(`passenger_id = $${values.length}`);
  } else if (user.role === 'driver') {
    values.push(user.id);
    conditions.push(`driver_id = $${values.length}`);
  }
  const since = Number(url.searchParams.get('since') || 0);
  if (Number.isFinite(since) && since > 0) {
    values.push(new Date(since));
    conditions.push(`created_at >= $${values.length}`);
  }
  if (url.searchParams.get('open') === 'true') {
    conditions.push(`status NOT IN ('completed', 'cancelled', 'no_drivers_available')`);
  }
  if (url.searchParams.get('pendingFeedback') === 'true') {
    conditions.push(`status='completed'`);
    conditions.push(`NOT EXISTS (SELECT 1 FROM trip_feedback tf WHERE tf.trip_id=trips.id)`);
  }
  values.push(limit);
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`${tripSelect}${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
  return result.rows.map(publicTrip);
}

function isDashboardAdmin(user) {
  return String(user?.dashboard_role || '').toUpperCase() === 'ADMIN';
}

export function isDashboardCoordinator(user) {
  return user?.role === 'dashboard'
    && String(user?.dashboard_role || '').toUpperCase() === 'COORDINATOR';
}

function requireDashboardCoordinator(user) {
  requireRole(user, ['dashboard']);
  if (!isDashboardCoordinator(user)) {
    const error = new Error('Solo un coordinador puede gestionar solicitudes de sede.');
    error.statusCode = 403;
    throw error;
  }
}

async function getCoordinatorPlace(user) {
  const type = String(user.dashboard_sede_type || '').trim();
  const category = ['hotel', 'hotels'].includes(type) ? 'hotels'
    : ['sportVenue', 'sportVenues'].includes(type) ? 'sportVenues' : '';
  if (!user.dashboard_sede_id || !category) {
    const error = new Error('La cuenta de coordinador no tiene una sede válida.');
    error.statusCode = 403;
    throw error;
  }
  const result = await pool.query(
    `SELECT id, category, name, address, latitude, longitude
       FROM places WHERE id = $1 AND category = $2`,
    [user.dashboard_sede_id, category],
  );
  const place = result.rows[0];
  if (!place || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) {
    const error = new Error('La sede del coordinador no tiene ubicación configurada.');
    error.statusCode = 400;
    throw error;
  }
  return {
    id: place.id,
    type: place.category === 'hotels' ? 'hotel' : 'sportVenue',
    name: place.name,
    address: place.address || place.name,
    lat: Number(place.latitude),
    lng: Number(place.longitude),
  };
}

// Firebase UIDs are not UUIDs, while VPS users use UUID primary keys. Keep
// legacy Firebase dashboard accounts fully usable for alert/incident actions
// without attempting to cast their UID into a PostgreSQL UUID foreign key.
function postgresUuidOrNull(value) {
  const text = String(value ?? '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function requireDashboardAdmin(user) {
  requireRole(user, ['dashboard']);
  if (!isDashboardAdmin(user)) {
    const error = new Error('Solo un administrador puede consultar esta vista.');
    error.statusCode = 403;
    throw error;
  }
}

// A stale GPS sample is a signal problem, not a shift transition. Keeping
// this decision pure makes the invariant explicit and testable.
export function staleDriverOutcome(availabilityStatus) {
  if (availabilityStatus !== 'online') return null;
  return { availabilityStatus: 'online', alertReason: 'HEARTBEAT' };
}

async function recordDriverConnectionEvent(driverId, status, reason = null, at = new Date()) {
  const result = await pool.query(
    `SELECT d.id, d.phone, d.plate, u.display_name,
            l.latitude, l.longitude, l.accuracy_m
       FROM drivers d JOIN users u ON u.id=d.id
       LEFT JOIN driver_locations l ON l.driver_id=d.id
      WHERE d.id=$1`,
    [driverId],
  );
  const driver = result.rows[0];
  if (!driver) return null;
  await pool.query(
    `INSERT INTO driver_connection_history
       (driver_id, status, reason, driver_name, driver_plate, event_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [driverId, status, reason, driver.display_name || '', driver.plate || '', at],
  );
  if (status !== 'offline') return null;
  const alert = await pool.query(
    `INSERT INTO operation_alerts
       (driver_id, driver_name, driver_plate, driver_phone, reason,
        disconnected_at, final_lat, final_lng, final_accuracy_m)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (driver_id) WHERE status = 'OPEN' DO NOTHING
     RETURNING id, driver_id, driver_name, driver_plate, driver_phone,
       reason, status, disconnected_at, final_lat, final_lng, final_accuracy_m,
       created_at`,
    [
      driverId, driver.display_name || '', driver.plate || '', driver.phone || '',
      reason || 'MANUAL', at, driver.latitude, driver.longitude, driver.accuracy_m,
    ],
  );
  return alert.rows[0] || null;
}

// Mobile foreground services can miss one or two heartbeats while Android
// changes networks or obtains a fresh GPS fix.  Thirty seconds was short
// enough to disconnect a driver who was visibly online. Keep the server-side
// timeout below the dashboard's three-minute offline window, but allow a
// short connectivity gap before closing the shift.
export async function detectStaleDrivers({ now = new Date(), timeoutMs = 90_000 } = {}) {
  await clearExpiredDriverPlaces();
  const cutoff = new Date(now.getTime() - timeoutMs);
  const result = await pool.query(
    `SELECT d.id
       FROM drivers d LEFT JOIN driver_locations l ON l.driver_id=d.id
      WHERE d.availability_status='online'
        AND (l.recorded_at IS NULL OR l.recorded_at < $1)
      ORDER BY d.id`,
    [cutoff],
  );
  let alerted = 0;
  for (const row of result.rows) {
    // Una falta temporal de GPS no es una decisión del conductor. Mantener
    // availability_status='online' conserva el turno activo; el dashboard
    // lo pinta como señal suspendida y muestra la alerta HEARTBEAT. Solo el
    // endpoint de disponibilidad con online=false puede terminar el turno.
    if (!staleDriverOutcome('online')) continue;
    const openAlert = await pool.query(
      `SELECT 1 FROM operation_alerts
        WHERE driver_id=$1 AND status='OPEN' AND reason='HEARTBEAT'
        LIMIT 1`,
      [row.id],
    );
    if (openAlert.rowCount) continue;
    const alert = await recordDriverConnectionEvent(row.id, 'offline', 'HEARTBEAT', now);
    if (alert) alerted += 1;
  }
  return alerted;
}

function publicConnectionEvent(row) {
  return {
    status: row.status,
    reason: row.reason,
    driverName: row.driver_name || '',
    driverPlate: row.driver_plate || '',
    at: new Date(row.event_at).getTime(),
  };
}

function publicOperationAlert(row) {
  return {
    id: row.id,
    driverId: row.driver_id,
    driverName: row.driver_name || '',
    driverPlate: row.driver_plate || '',
    driverPhone: row.driver_phone || '',
    reason: row.reason,
    status: row.status,
    disconnectedAt: new Date(row.disconnected_at).getTime(),
    finalLat: row.final_lat === null ? null : Number(row.final_lat),
    finalLng: row.final_lng === null ? null : Number(row.final_lng),
    finalAccuracyM: row.final_accuracy_m === null ? null : Number(row.final_accuracy_m),
    createdAt: new Date(row.created_at).getTime(),
  };
}

function publicFeedback(row) {
  return {
    tripId: row.trip_id,
    passengerId: row.passenger_id,
    driverId: row.driver_id,
    rating: row.rating === null ? null : Number(row.rating),
    comment: row.comment || '',
    incidentCategory: row.incident_category || 'none',
    incidentDetails: row.incident_details || '',
    incidentStatus: row.incident_status || 'NONE',
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).getTime() } : {}),
  };
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
  await clearExpiredDriverPlaces();
  const includePrivateDocuments = isDashboardAdmin(user);
  const [driversResult, tripsResult] = await Promise.all([
    pool.query(`
      SELECT d.id, u.display_name, u.email, u.status AS user_status,
        d.approval_status, d.phone, d.plate, d.age, d.vehicle_brand,
        d.vehicle_type, d.vehicle_color, d.vehicle_seats,
        d.profile_photo_url, d.dni_doc_url, d.dni_front_doc_url, d.dni_back_doc_url,
        d.license_doc_url, d.soat_doc_url, d.circulation_card_doc_url,
        d.technical_review_doc_url, d.criminal_record_doc_url, d.work_certificate_doc_url,
        d.license_expires_at, d.soat_expires_at, d.technical_review_expires_at,
        d.application_submitted_at, d.reviewed_at, d.reviewed_by,
        d.rejection_reason, d.rejection_field_keys, d.suspended,
        d.suspension_reason, d.suspended_at, d.suspended_by,
        d.availability_status, d.current_trip_id, d.assigned_place,
        l.latitude, l.longitude, l.accuracy_m, l.recorded_at,
        (SELECT h.event_at FROM driver_connection_history h
          WHERE h.driver_id = d.id AND h.status = 'online'
            AND h.event_at > COALESCE((SELECT max(o.event_at)
              FROM driver_connection_history o
              WHERE o.driver_id = d.id AND o.status = 'offline'), '-infinity'::timestamptz)
          ORDER BY h.event_at DESC LIMIT 1) AS shift_started_at
      FROM drivers d
      JOIN users u ON u.id = d.id
      LEFT JOIN driver_locations l ON l.driver_id = d.id
      WHERE u.status = 'active'
      ORDER BY u.display_name ASC, d.id ASC`),
    pool.query(`${tripSelect}
      WHERE status IN ('scheduled','searching','no_drivers_available','assigned_pending_accept','accepted','arrived_at_pickup','in_progress')
         OR created_at >= now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 1000`),
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
    age: row.age == null ? null : Number(row.age),
    vehicleBrand: row.vehicle_brand || '',
    vehicleType: row.vehicle_type,
    vehicleColor: row.vehicle_color || '',
    vehicleSeats: row.vehicle_seats,
    profilePhotoUrl: includePrivateDocuments ? dashboardDocumentUrl(row.profile_photo_url) : null,
    dniDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.dni_doc_url) : null,
    dniFrontDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.dni_front_doc_url) : null,
    dniBackDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.dni_back_doc_url) : null,
    licenseDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.license_doc_url) : null,
    soatDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.soat_doc_url) : null,
    circulationCardDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.circulation_card_doc_url) : null,
    technicalReviewDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.technical_review_doc_url) : null,
    criminalRecordDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.criminal_record_doc_url) : null,
    workCertificateDocUrl: includePrivateDocuments ? dashboardDocumentUrl(row.work_certificate_doc_url) : null,
    licenseExpiresAt: row.license_expires_at == null ? null : Number(row.license_expires_at),
    soatExpiresAt: row.soat_expires_at == null ? null : Number(row.soat_expires_at),
    technicalReviewExpiresAt: row.technical_review_expires_at == null ? null : Number(row.technical_review_expires_at),
    documentsSubmittedAt: row.application_submitted_at ? new Date(row.application_submitted_at).getTime() : null,
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by || '',
    rejectionReason: row.rejection_reason || '',
    rejectionFieldKeys: row.rejection_field_keys || '',
    suspended: row.suspended === true,
    suspensionReason: row.suspension_reason || '',
    suspendedAt: row.suspended_at == null ? null : Number(row.suspended_at),
    suspendedBy: row.suspended_by || '',
    availabilityStatus: row.availability_status,
    currentTripId: row.current_trip_id,
    assignedPlace: row.assigned_place || null,
    shiftStartedAt: row.shift_started_at ? new Date(row.shift_started_at).getTime() : null,
    currentTrip: row.current_trip_id ? tripById.get(row.current_trip_id) ?? null : null,
    lat: row.latitude === null ? null : Number(row.latitude),
    lng: row.longitude === null ? null : Number(row.longitude),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    lastUpdate: row.recorded_at ? new Date(row.recorded_at).getTime() : null,
  }));

  let connectionHistory = {};
  let operationAlerts = {};
  let tripFeedback = {};
  if (isDashboardAdmin(user)) {
    const tripIds = tripsResult.rows.map((row) => row.id);
    const [historyResult, alertsResult, feedbackResult, metadataResult] = await Promise.all([
      pool.query(`SELECT id, driver_id, status, reason, driver_name, driver_plate, event_at
                    FROM driver_connection_history ORDER BY event_at DESC LIMIT 5000`),
      pool.query(`SELECT id, driver_id, driver_name, driver_plate, driver_phone, reason, status,
                         disconnected_at, final_lat, final_lng, final_accuracy_m, created_at
                    FROM operation_alerts ORDER BY created_at DESC LIMIT 100`),
      pool.query(`SELECT trip_id, passenger_id, driver_id, rating, comment, incident_category,
                         incident_details, incident_status, created_at, updated_at, resolved_at
                    FROM trip_feedback ORDER BY updated_at DESC LIMIT 500`),
      pool.query(`SELECT t.id, pu.display_name AS passenger_name, pp.phone AS passenger_phone,
                         du.display_name AS driver_name, d.plate AS driver_plate
                    FROM trips t
                    LEFT JOIN users pu ON pu.id=t.passenger_id
                    LEFT JOIN passenger_profiles pp ON pp.user_id=t.passenger_id
                    LEFT JOIN drivers d ON d.id=t.driver_id
                    LEFT JOIN users du ON du.id=d.id
                   WHERE t.id = ANY($1::uuid[])`, [tripIds]),
    ]);
    for (const row of historyResult.rows) {
      if (!connectionHistory[row.driver_id]) connectionHistory[row.driver_id] = {};
      connectionHistory[row.driver_id][String(row.id)] = publicConnectionEvent(row);
    }
    for (const row of alertsResult.rows) operationAlerts[row.id] = publicOperationAlert(row);
    for (const row of feedbackResult.rows) tripFeedback[row.trip_id] = publicFeedback(row);
    const metadata = Object.fromEntries(metadataResult.rows.map((row) => [row.id, row]));
    trips.forEach((trip) => {
      const row = metadata[trip.id];
      if (!row) return;
      trip.passengerName = row.passenger_name || '';
      trip.passengerPhone = row.passenger_phone || '';
      trip.driverName = row.driver_name || '';
      trip.driverPlate = row.driver_plate || '';
    });
  }

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
    ...(isDashboardAdmin(user) ? { connectionHistory, operationAlerts, tripFeedback } : {}),
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
  const previous = await pool.query(
    `SELECT availability_status FROM drivers
      WHERE id=$1 AND approval_status='approved' AND suspended=FALSE`,
    [user.id],
  );
  if (!previous.rows[0]) {
    const error = new Error('El conductor no esta aprobado para operar.');
    error.statusCode = 403;
    throw error;
  }
  const result = await pool.query(
    `UPDATE drivers
        SET availability_status = $1, updated_at = now()
      WHERE id = $2 AND approval_status = 'approved' AND suspended=FALSE
      RETURNING id, availability_status, current_trip_id`,
    [online ? 'online' : 'offline', user.id],
  );
  if (!result.rows[0]) {
    const error = new Error('El conductor no está aprobado para operar.');
    error.statusCode = 403;
    throw error;
  }
  if (previous.rows[0].availability_status !== result.rows[0].availability_status) {
    await recordDriverConnectionEvent(
      user.id,
      result.rows[0].availability_status,
      online ? null : 'MANUAL',
    );
  }
  const assignment = online && !result.rows[0].current_trip_id
    ? await withTransaction((client) => assignPendingTripForDriver(client, user.id))
    : null;
  if (assignment) {
    await notifyVpsDevices([assignment.driverId], 'trip_assigned', {
      tripId: assignment.id,
      status: assignment.status,
      pickupAddress: assignment.pickupAddress,
      destinationAddress: assignment.destinationAddress,
      scheduledPickupAt: assignment.scheduledPickupAt,
      route: 'active-trip',
      deepLink: `driver://trip/${assignment.id}`,
    });
  }
  return {
    driverId: result.rows[0].id,
    online: result.rows[0].availability_status === 'online',
    currentTripId: assignment?.id ?? result.rows[0].current_trip_id,
    ...(assignment ? { trip: assignment } : {}),
  };
}

async function updateDriverLocation(user, body) {
  requireRole(user, ['driver']);
  const eligible = await pool.query(
    `SELECT 1 FROM drivers
      WHERE id=$1 AND approval_status='approved' AND suspended=FALSE`,
    [user.id],
  );
  if (!eligible.rowCount) {
    throw Object.assign(new Error('El conductor no está aprobado para operar.'), { statusCode: 403 });
  }
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
  // El siguiente heartbeat recupera la señal sin tocar el turno. Cerrar la
  // alerta solo cuando llega una ubicación nueva evita falsos cierres y
  // deja intacta la desconexión manual.
  await pool.query(
    `UPDATE operation_alerts
        SET status='CLOSED', acknowledged_at=now()
      WHERE driver_id=$1 AND status='OPEN' AND reason='HEARTBEAT'`,
    [user.id],
  );
  return { driverId: user.id, latitude, longitude, accuracyM, recordedAt: Date.now() };
}

async function driverHeartbeat(user, body) {
  requireRole(user, ['driver']);
  const eligible = await pool.query(
    `SELECT 1 FROM drivers
      WHERE id=$1 AND approval_status='approved' AND suspended=FALSE`,
    [user.id],
  );
  if (!eligible.rowCount) {
    throw Object.assign(new Error('El conductor no está aprobado para operar.'), { statusCode: 403 });
  }
  // Este endpoint confirma que la app sigue viva, pero nunca escribe una
  // coordenada antigua en driver_locations. Solo updateDriverLocation puede
  // renovar el GPS y cerrar una alerta de señal perdida.
  await pool.query('UPDATE drivers SET updated_at=now() WHERE id=$1', [user.id]);
  return { driverId: user.id, heartbeatAt: Date.now() };
}

async function getDriverMe(user) {
  requireRole(user, ['driver']);
  await clearExpiredDriverPlaces();
  const result = await pool.query(
    `SELECT d.id, d.approval_status, d.phone, d.plate, d.age,
       d.vehicle_brand, d.vehicle_type, d.vehicle_color,
       d.vehicle_seats, d.availability_status, d.current_trip_id,
       d.assigned_place, d.suspended, u.display_name,
       l.latitude, l.longitude, l.accuracy_m, l.recorded_at
       FROM drivers d JOIN users u ON u.id=d.id
       LEFT JOIN driver_locations l ON l.driver_id = d.id
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
    name: row.display_name,
    phone: row.phone,
    plate: row.plate,
    age: row.age,
    vehicleBrand: row.vehicle_brand,
    vehicleType: row.vehicle_type,
    vehicleColor: row.vehicle_color,
    vehicleSeats: row.vehicle_seats,
    availabilityStatus: row.availability_status,
    connectionStatus: row.availability_status === 'online' ? 'ONLINE' : 'OFFLINE',
    suspended: row.suspended === true,
    currentTripId: row.current_trip_id,
    assignedPlace: row.assigned_place || null,
    location: row.latitude === null ? null : {
      latitude: Number(row.latitude), longitude: Number(row.longitude),
      accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
      recordedAt: new Date(row.recorded_at).getTime(),
    },
  };
}

async function updateDriverPhone(user, body) {
  requireRole(user, ['driver']);
  const phone = requiredString(body.phone, 'phone', { min: 6, max: 30 });
  const result = await pool.query(
    `UPDATE drivers SET phone=$1, updated_at=now()
      WHERE id=$2 AND approval_status='approved' AND suspended=FALSE
      RETURNING phone`,
    [phone, user.id],
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error('El conductor no está aprobado para operar.'), { statusCode: 403 });
  }
  return { phone: result.rows[0].phone };
}

async function getTripDriverLocation(user, tripId) {
  assertPassengerAccess(user);
  const trip = await findTrip(tripId);
  if (!trip || trip.passenger_id !== user.id || !trip.driver_id) {
    const error = new Error('Viaje no encontrado.');
    error.statusCode = 404;
    throw error;
  }
  if (!['accepted', 'arrived_at_pickup', 'in_progress'].includes(trip.status)) {
    const error = new Error('La ubicación del conductor solo está disponible durante el viaje activo.');
    error.statusCode = 409;
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
  const eligible = await pool.query(
    `SELECT 1 FROM drivers
      WHERE id=$1 AND approval_status='approved' AND suspended=FALSE`,
    [user.id],
  );
  if (!eligible.rowCount) {
    throw Object.assign(new Error('El conductor no está aprobado para operar.'), { statusCode: 403 });
  }
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
      `UPDATE trips SET status = $1,
         accepted_at = CASE WHEN $1 IN ('arrived_at_pickup', 'in_progress', 'completed') THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
         in_progress_at = CASE WHEN $1 IN ('in_progress', 'completed') THEN COALESCE(in_progress_at, now()) ELSE in_progress_at END,
         completed_at = CASE WHEN $2 THEN now() ELSE completed_at END,
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
  await notifyVpsDevices(
    [trip.passengerId],
    trip.status === 'completed' ? 'trip_completed' : 'trip_status',
    {
    tripId: trip.id,
    status: trip.status,
    ratingRequired: trip.status === 'completed',
    route: trip.status === 'completed' ? 'rate-trip' : 'active-trip',
    deepLink: trip.status === 'completed' ? `passenger://rate-trip/${trip.id}` : `passenger://trip/${trip.id}`,
    },
  );
  return trip;
}

export function validateDestinationUpdate(body) {
  const destinationAddress = requiredString(body.destinationAddress, 'destinationAddress', { max: 255 });
  const destinationLat = parseCoordinate(body.destinationLat, 'destinationLat', -90, 90);
  const destinationLng = parseCoordinate(body.destinationLng, 'destinationLng', -180, 180);
  return { destinationAddress, destinationLat, destinationLng };
}

export function canUpdateDestination(status) {
  return ['scheduled', 'searching', 'accepted', 'arrived_at_pickup', 'in_progress'].includes(status);
}

async function updateTripDestination(user, tripId, body) {
  assertPassengerAccess(user);
  const destination = validateDestinationUpdate(body);
  const trip = await withTransaction(async (client) => {
    const result = await client.query(`${tripSelect} WHERE id = $1 FOR UPDATE`, [tripId]);
    const current = result.rows[0];
    if (!current || current.passenger_id !== user.id) {
      const error = new Error('Viaje no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    if (!canUpdateDestination(current.status)) {
      const error = new Error('El destino ya no se puede modificar porque el viaje terminó.');
      error.statusCode = 409;
      throw error;
    }
    await client.query(
      `UPDATE trips SET destination_address=$1, destination_lat=$2, destination_lng=$3, updated_at=now()
         WHERE id=$4`,
      [destination.destinationAddress, destination.destinationLat, destination.destinationLng, tripId],
    );
    const updated = await client.query(`${tripSelect} WHERE id = $1`, [tripId]);
    return publicTrip(updated.rows[0]);
  });
  if (trip.driverId) {
    await notifyVpsDevices([trip.driverId], 'trip_updated', {
      tripId: trip.id,
      status: trip.status,
      destinationAddress: trip.destinationAddress,
      destinationLat: trip.destinationLat,
      destinationLng: trip.destinationLng,
      route: 'active-trip',
      deepLink: `driver://trip/${trip.id}`,
    });
  }
  return trip;
}

async function cancelTrip(user, tripId, body) {
  if (user?.role === 'passenger') assertPassengerAccess(user);
  else requireRole(user, ['dashboard']);
  const reason = body.reason === undefined ? null : requiredString(body.reason, 'reason', { max: 255 });
  const trip = await withTransaction(async (client) => {
    const result = await client.query(`${tripSelect} WHERE id = $1 FOR UPDATE`, [tripId]);
    const trip = result.rows[0];
    const dashboardAllowed = user.role !== 'dashboard'
      || isDashboardAdmin(user)
      || (isDashboardCoordinator(user) && trip?.passenger_id === user.id);
    if (!trip
        || (user.role === 'passenger' && trip.passenger_id !== user.id)
        || !dashboardAllowed) {
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
    const common = {
      tripId: trip.id,
      status: trip.status,
      cancelReason: trip.cancelReason,
      cancelledBy: trip.cancelledBy,
    };
    await notifyVpsDevices([trip.passengerId].filter(Boolean), 'trip_cancelled', {
      ...common,
      route: 'home',
      deepLink: 'passenger://home',
    });
    await notifyVpsDevices([trip.driverId].filter(Boolean), 'trip_cancelled', {
      ...common,
      route: 'home',
      deepLink: 'driver://home',
    });
  }
  return trip;
}

async function retryTrip(user, tripId) {
  assertPassengerAccess(user);
  const trip = await withTransaction(async (client) => {
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
  if (trip.driverId) {
    await notifyVpsDevices([trip.driverId], 'trip_assigned', tripAssignmentPushData(trip));
  } else if (trip.status === 'no_drivers_available') {
    await notifyVpsDevices([trip.passengerId], 'no_drivers_available', {
      tripId: trip.id,
      status: trip.status,
      reason: 'Aún no encontramos un conductor disponible.',
      route: 'searching',
      deepLink: `passenger://trip/${trip.id}`,
    });
  }
  return trip;
}

async function submitFeedback(user, tripId, body) {
  assertPassengerAccess(user);
  const rating = body.rating === null || body.rating === undefined || body.rating === ''
    ? null : Number(body.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    const error = new Error('rating debe estar entre 1 y 5.');
    error.statusCode = 400;
    throw error;
  }
  // El comentario es opcional cuando el pasajero solo selecciona estrellas o
  // una incidencia. `requiredString` tiene mínimo 1 por defecto y rechazaba
  // el formulario válido que envía comment: ''.
  const comment = body.comment === undefined || body.comment === null
    ? ''
    : typeof body.comment === 'string' && body.comment.trim().length <= 1000
      ? body.comment.trim()
      : requiredString(body.comment, 'comment', { max: 1000 });
  const allowedIncidents = new Set(['none', 'driver_conduct', 'service_quality', 'safety', 'lost_item', 'other']);
  const incidentCategory = String(body.incidentCategory || 'none').trim();
  const incidentDetails = String(body.incidentDetails || '').trim().slice(0, 1000);
  if (!allowedIncidents.has(incidentCategory)) {
    const error = new Error('Selecciona un tipo de incidencia valido.');
    error.statusCode = 400;
    throw error;
  }
  if (incidentCategory !== 'none' && incidentDetails.length < 10) {
    const error = new Error('Describe la incidencia con al menos 10 caracteres.');
    error.statusCode = 400;
    throw error;
  }
  if (rating === null && incidentCategory === 'none' && !comment.trim()) {
    const error = new Error('Agrega una calificacion, comentario o incidencia.');
    error.statusCode = 400;
    throw error;
  }
  const tripResult = await pool.query(
    `SELECT id, driver_id FROM trips
      WHERE id=$1 AND passenger_id=$2 AND status='completed'`,
    [tripId, user.id],
  );
  if (!tripResult.rows[0]) {
    const error = new Error('No se puede comentar este viaje.');
    error.statusCode = 404;
    throw error;
  }
  const incidentStatus = incidentCategory === 'none' ? 'NONE' : 'OPEN';
  const result = await pool.query(
    `UPDATE trips SET rating = COALESCE($1, rating), feedback_comment = $2,
        feedback_submitted_at = now(), updated_at = now()
      WHERE id = $3 AND passenger_id = $4 AND status = 'completed'
      RETURNING id, rating, feedback_comment`,
    [rating, comment, tripId, user.id],
  );
  await pool.query(
    `INSERT INTO trip_feedback
       (trip_id, passenger_id, driver_id, rating, comment, incident_category,
        incident_details, incident_status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (trip_id) DO UPDATE SET rating=COALESCE(EXCLUDED.rating, trip_feedback.rating),
       comment=EXCLUDED.comment, incident_category=EXCLUDED.incident_category,
       incident_details=EXCLUDED.incident_details, incident_status=EXCLUDED.incident_status,
       updated_at=now(), resolved_at=NULL, resolved_by=NULL`,
    [tripId, user.id, tripResult.rows[0].driver_id, rating, comment,
      incidentCategory, incidentDetails, incidentStatus],
  );
  return {
    tripId,
    rating: result.rows[0].rating,
    comment: result.rows[0].feedback_comment,
    incidentCategory,
    incidentDetails,
    incidentStatus,
  };
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

async function unregisterDeviceToken(user, body) {
  requireRole(user, ['passenger', 'driver', 'dashboard']);
  const token = requiredString(body.token, 'token', { max: 4096 });
  const result = await pool.query(
    'DELETE FROM device_tokens WHERE user_id=$1 AND token=$2',
    [user.id, token],
  );
  return { removed: result.rowCount || 0 };
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
      const updated = await client.query(`${tripSelect} WHERE id = $1`, [trip.id]);
      dispatched.push({ trip: publicTrip(updated.rows[0]), driverId });
    }
    return dispatched;
  });
  await Promise.all(dispatchedTrips.map(({ trip, driverId }) => driverId
    ? notifyVpsDevices([driverId], 'trip_assigned', tripAssignmentPushData(trip))
    : notifyVpsDevices([trip.passengerId], 'no_drivers_available', {
      tripId: trip.id,
      status: trip.status,
      reason: 'AÃºn no encontramos un conductor disponible.',
      route: 'searching',
      deepLink: `passenger://trip/${trip.id}`,
    })));
  return dispatchedTrips.length;
}

async function updateOperationAlert(user, alertId, body) {
  requireDashboardAdmin(user);
  const action = requiredString(body.action, 'action', { max: 20 });
  if (!['acknowledge', 'resolve', 'reopen'].includes(action)) {
    const error = new Error('Accion de alerta invalida.');
    error.statusCode = 400;
    throw error;
  }
  const closed = action !== 'reopen';
  const result = await pool.query(
    `UPDATE operation_alerts
        SET status=$1, acknowledged_at=CASE WHEN $2 THEN now() ELSE NULL END,
            acknowledged_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END
      WHERE id=$4
      RETURNING id, driver_id, driver_name, driver_plate, driver_phone, reason,
        status, disconnected_at, final_lat, final_lng, final_accuracy_m, created_at`,
    [closed ? 'CLOSED' : 'OPEN', closed, postgresUuidOrNull(user.id), alertId],
  );
  if (!result.rows[0]) {
    const error = new Error('Alerta no encontrada.');
    error.statusCode = 404;
    throw error;
  }
  return publicOperationAlert(result.rows[0]);
}

async function updateTripFeedback(user, tripId, body) {
  requireDashboardAdmin(user);
  const action = requiredString(body.action, 'action', { max: 20 });
  if (!['resolve', 'reopen'].includes(action)) {
    const error = new Error('Accion de incidencia invalida.');
    error.statusCode = 400;
    throw error;
  }
  const result = await pool.query(
    `UPDATE trip_feedback
        SET incident_status=$1,
            resolved_at=CASE WHEN $2 THEN now() ELSE NULL END,
            resolved_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            updated_at=now()
      WHERE trip_id=$4 AND incident_category <> 'none'
      RETURNING trip_id, passenger_id, driver_id, rating, comment, incident_category,
        incident_details, incident_status, created_at, updated_at, resolved_at`,
    [action === 'resolve' ? 'RESOLVED' : 'OPEN', action === 'resolve', postgresUuidOrNull(user.id), tripId],
  );
  if (!result.rows[0]) {
    const error = new Error('Incidencia no encontrada.');
    error.statusCode = 404;
    throw error;
  }
  return publicFeedback(result.rows[0]);
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
        return json(res, 201, await uploadStorageObject(
          user,
          await readJson(req, { maxBytes: config.maxStorageJsonBytes }),
        ));
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

      const storageTokenMatch = url.pathname.match(/^\/api\/v1\/storage\/token\/(.+)$/);
      if (req.method === 'GET' && storageTokenMatch) {
        const key = normalizeStorageKey(decodeURIComponent(storageTokenMatch[1]));
        if (!verifyPrivateStorageAccessToken(key, url.searchParams.get('token'))) {
          return json(res, 401, { error: 'Enlace de archivo vencido o inválido.' });
        }
        const object = await getStorageObject(key);
        res.writeHead(200, {
          'content-type': object.ContentType || 'application/octet-stream',
          'content-length': object.ContentLength,
          'cache-control': 'private, max-age=60',
          'access-control-allow-origin': 'https://apl.tucomprass.com',
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

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/application') {
        const user = await authenticate(req);
        return json(res, 200, await submitDriverApplication(user, await readJson(req)));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/passengers/me/profile') {
        const user = await authenticate(req);
        return json(res, 200, { profile: await getPassengerProfile(user) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/passengers/me/profile') {
        const user = await authenticate(req);
        return json(res, 200, { profile: await savePassengerProfile(user, await readJson(req)) });
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

      const driverManageMatch = url.pathname.match(/^\/api\/v1\/dashboard\/drivers\/([^/]+)\/manage$/);
      if (req.method === 'POST' && driverManageMatch) {
        const user = await authenticate(req);
        return json(res, 200, await manageVpsDriver(
          user,
          decodeURIComponent(driverManageMatch[1]),
          await readJson(req),
        ));
      }

      const driverPlaceMatch = url.pathname.match(/^\/api\/v1\/dashboard\/drivers\/([^/]+)\/place$/);
      if (req.method === 'POST' && driverPlaceMatch) {
        const user = await authenticate(req);
        return json(res, 200, await assignDriverPlace(
          user,
          decodeURIComponent(driverPlaceMatch[1]),
          await readJson(req),
        ));
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

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/link-passenger-email') {
        const user = await authenticate(req);
        return json(res, 200, await linkPassengerEmail(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
        return json(res, 200, await login(await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/request-password-reset') {
        return json(res, 200, await requestPasswordReset(await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/reset-password') {
        return json(res, 200, await resetPassword(await readJson(req)));
      }

      if (req.method === 'GET' && url.pathname === '/reset-password') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(resetPasswordPage(url.searchParams.get('token')));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
        const user = await authenticate(req);
        requireRole(user, ['passenger', 'driver', 'dashboard']);
        return json(res, 200, { user: publicUser(user) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/auth/delete-account') {
        const user = await authenticate(req);
        return json(res, 200, await deleteCurrentVpsAccount(user));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/drivers/me') {
        const user = await authenticate(req);
        return json(res, 200, await getDriverMe(user));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/me/phone') {
        const user = await authenticate(req);
        return json(res, 200, await updateDriverPhone(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/availability') {
        const user = await authenticate(req);
        return json(res, 200, await setDriverAvailability(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/location') {
        const user = await authenticate(req);
        return json(res, 200, await updateDriverLocation(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drivers/heartbeat') {
        const user = await authenticate(req);
        return json(res, 200, await driverHeartbeat(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/device-tokens') {
        const user = await authenticate(req);
        return json(res, 200, await registerDeviceToken(user, await readJson(req)));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/device-tokens/remove') {
        const user = await authenticate(req);
        return json(res, 200, await unregisterDeviceToken(user, await readJson(req)));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/overview') {
        const user = await authenticate(req);
        return json(res, 200, await dashboardOverview(user));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/coordinator/trips') {
        const user = await authenticate(req);
        return json(res, 200, { trips: await listCoordinatorTrips(user) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/dashboard/coordinator/trips') {
        const user = await authenticate(req);
        return json(res, 201, { trip: await createCoordinatorTrip(user, await readJson(req)) });
      }

      const coordinatorTripMatch = url.pathname.match(/^\/api\/v1\/dashboard\/coordinator\/trips\/([^/]+)(?:\/(cancel))?$/);
      if (coordinatorTripMatch) {
        const user = await authenticate(req);
        const tripId = decodeURIComponent(coordinatorTripMatch[1]);
        if (req.method === 'GET' && !coordinatorTripMatch[2]) {
          return json(res, 200, await getCoordinatorTripDetail(user, tripId));
        }
        if (req.method === 'POST' && coordinatorTripMatch[2] === 'cancel') {
          return json(res, 200, { trip: await cancelCoordinatorTrip(user, tripId, await readJson(req)) });
        }
      }

      const alertMatch = url.pathname.match(/^\/api\/v1\/dashboard\/alerts\/([^/]+)$/);
      if (req.method === 'POST' && alertMatch) {
        const user = await authenticate(req);
        return json(res, 200, { alert: await updateOperationAlert(user, decodeURIComponent(alertMatch[1]), await readJson(req)) });
      }

      const incidentMatch = url.pathname.match(/^\/api\/v1\/dashboard\/incidents\/([^/]+)$/);
      if (req.method === 'POST' && incidentMatch) {
        const user = await authenticate(req);
        return json(res, 200, { feedback: await updateTripFeedback(user, decodeURIComponent(incidentMatch[1]), await readJson(req)) });
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

      const tripMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)(?:\/(cancel|retry|action|feedback|destination))?$/);
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
        if (req.method === 'POST' && operation === 'destination') {
          return json(res, 200, { trip: await updateTripDestination(user, tripId, await readJson(req)) });
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
