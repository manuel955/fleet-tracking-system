const functions = require('firebase-functions/v1');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();

const { attemptAssignment, releaseDriver } = require('./matching');
const { sendPush, notificationData } = require('./notifications');
const {
  disconnectReasonLabel,
  isAlertableDisconnectReason,
  normalizeDisconnectReason,
} = require('./alert-policy');
const {
  effectiveDriverHeartbeat,
  hasHeartbeatExpired,
} = require('./heartbeat-policy');
const {
  buildDriverAvailabilityUpdate,
  buildDriverLocationUpdate,
  buildHeartbeatDisconnectUpdate,
  normalizeDriverLocation,
} = require('./driver-state-policy');
const {
  EXPECTED_STATUS_BY_NEXT,
  prepareCoordinatorCancellation,
  prepareDashboardCancellation,
  prepareDriverTripTransition,
  shouldReleaseAssignment,
} = require('./trip-lifecycle-policy');
const { buildPublicationDecision, nextBuildNumber } = require('./build-policy');
const {
  REQUIRED_DRIVER_DOCUMENTS,
  driverApplicationIssues,
  validVehicleData,
} = require('./driver-application-policy');
const {
  PASSENGER_SCHEDULE_MAX_LEAD_MS,
  PASSENGER_SCHEDULE_MIN_LEAD_MS,
  passengerTripConflict,
} = require('./passenger-trip-policy');
const {
  canMigrateLegacyPassengerAccess,
  passengerAccessIsActive,
  passengerAccessPayload,
  revokePassengerAccess,
} = require('./passenger-access-policy');
const { buildTripFeedback } = require('./trip-feedback-policy');

const BRANDING_BUCKET = 'rastreoflota-53052.firebasestorage.app';
const BRANDING_APPS = {
  driver: {
    directory: 'driver-app',
    buildField: 'driverAppBuild',
    apkPath: 'app_releases/driver-app.apk',
    defaultName: 'APL Conductores',
    versionName: '1.0.1',
    minimumBuild: 54,
  },
  passenger: {
    directory: 'passenger-app',
    buildField: 'passengerAppBuild',
    apkPath: 'app_releases/passenger-app.apk',
    defaultName: 'APL Pasajeros',
    versionName: '1.0.0',
    minimumBuild: 43,
  },
};
const BRANDING_BUILD_TTL_MS = 3 * 60 * 60 * 1000;
const OWNER_DASHBOARD_EMAIL = 'anfurex.3351@gmail.com';
const DATABASE_URL = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';
const LIMA_TIME_ZONE = 'America/Lima';
const vpsPushSecretParam = defineString('VPS_PUSH_SECRET', {
  description: 'Secret shared only by the VPS and the FCM bridge',
  default: '',
});
const VPS_PUSH_SECRET = vpsPushSecretParam.value();

// The VPS owns the trip state after the migration, while this small bridge
// deliberately keeps Firebase Admin as the Android FCM sender. It accepts
// only a server-to-server secret and never exposes Admin credentials to the
// VPS or to a mobile client.
exports.sendVpsPush = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const provided = String(req.get('x-vps-push-secret') || '');
  if (!VPS_PUSH_SECRET || provided.length !== VPS_PUSH_SECRET.length
      || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(VPS_PUSH_SECRET))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body || {};
  const tokens = Array.isArray(body.tokens)
    ? body.tokens.filter((token) => typeof token === 'string' && token.length > 0).slice(0, 500)
    : [];
  const data = notificationData(body.type || 'trip_updated', body.data || {});
  if (!tokens.length) return res.status(200).json({ sent: 0, failed: 0 });
  try {
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      data,
      android: { priority: 'high', ttl: 120000, directBootOk: true },
    });
    return res.status(200).json({ sent: result.successCount, failed: result.failureCount });
  } catch (error) {
    console.error(`VPS FCM bridge fallo: ${error.message || error}`);
    return res.status(502).json({ error: 'fcm_unavailable' });
  }
});

function formatScheduledPickupSpeech(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  const time = new Intl.DateTimeFormat('es-PE', {
    timeZone: LIMA_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date).replace(/\s+/g, ' ').trim();
  const dayKey = (input) => new Intl.DateTimeFormat('en-CA', {
    timeZone: LIMA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(input);
  if (dayKey(date) === dayKey(Date.now())) return `Hoy a las ${time}`;
  const dateLabel = new Intl.DateTimeFormat('es-PE', {
    timeZone: LIMA_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(date);
  return `${dateLabel} a las ${time}`;
}
// Es un token publico pk de Mapbox, el mismo proveedor que ya usa el mapa
// cliente. Puede reemplazarse en Cloud Functions con MAPBOX_ACCESS_TOKEN sin
// tener que modificar el codigo.
const MAPBOX_PUBLIC_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || 'pk.eyJ1IjoiYW5mdXJleCIsImEiOiJjbXNlMHFxamgwNGlvMndweXo2aGFtbGlpIn0.bxWU-uN8FFTm0u7HZai9oQ';

function tripPoint(lat, lng) {
  const point = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90
    && point.lng >= -180 && point.lng <= 180
    ? point
    : null;
}

function sampleRoutePath(coordinates, maxPoints = 160) {
  if (!Array.isArray(coordinates)) return [];
  const points = coordinates
    .map((coordinate) => tripPoint(coordinate?.[1], coordinate?.[0]))
    .filter(Boolean);
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
}

function tripRouteSnapshotUrl(routePath, pickup, destination) {
  if (!MAPBOX_PUBLIC_TOKEN || routePath.length < 2) return null;
  const routeGeoJson = encodeURIComponent(JSON.stringify({
    type: 'Feature',
    properties: { stroke: '#081618', 'stroke-width': 5, 'stroke-opacity': 0.85 },
    geometry: {
      type: 'LineString',
      coordinates: routePath.map((point) => [point.lng, point.lat]),
    },
  }));
  const overlays = [
    `pin-s+1d4ed8(${pickup.lng},${pickup.lat})`,
    `pin-s+7c3aed(${destination.lng},${destination.lat})`,
    `geojson(${routeGeoJson})`,
  ].join(',');
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/auto/900x520@2x?access_token=${encodeURIComponent(MAPBOX_PUBLIC_TOKEN)}`;
}

async function createTripRouteSnapshot(trip) {
  const pickup = tripPoint(trip.pickupLat, trip.pickupLng);
  const destination = tripPoint(trip.destinationLat, trip.destinationLng);
  if (!pickup || !destination || !MAPBOX_PUBLIC_TOKEN) return {};

  const coordinates = `${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?overview=full&geometries=geojson&access_token=${encodeURIComponent(MAPBOX_PUBLIC_TOKEN)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Mapbox Directions ${response.status}`);
    const route = (await response.json()).routes?.[0];
    const routePath = sampleRoutePath(route?.geometry?.coordinates);
    if (routePath.length < 2) throw new Error('Ruta sin geometria valida');
    return {
      routePath,
      routeSnapshotUrl: tripRouteSnapshotUrl(routePath, pickup, destination),
      routeDistanceMeters: Number.isFinite(Number(route.distance)) ? Number(route.distance) : null,
      routeDurationSeconds: Number.isFinite(Number(route.duration)) ? Number(route.duration) : null,
      routeSnapshotCreatedAt: Date.now(),
    };
  } catch (error) {
    console.error('createTripRouteSnapshot', error.message || error);
    return {};
  }
}

async function buildTripHistoryRecord(trip) {
  const driver = trip.driverId
    ? ((await admin.database().ref(`drivers/${trip.driverId}`).once('value')).val() || {})
    : {};
  const routeSnapshot = await createTripRouteSnapshot(trip);
  return {
    ...trip,
    archivedAt: Date.now(),
    driverFinalLat: Number.isFinite(Number(driver.lat)) ? Number(driver.lat) : null,
    driverFinalLng: Number.isFinite(Number(driver.lng)) ? Number(driver.lng) : null,
    driverFinalHeading: Number.isFinite(Number(driver.heading)) ? Number(driver.heading) : null,
    ...routeSnapshot,
  };
}

function driverDisconnectReason(driver) {
  return normalizeDisconnectReason(driver);
}

async function createPrematureDisconnectAlert(driverId, driver, reason, disconnectedAt) {
  if (!isAlertableDisconnectReason(reason)) return null;

  // La marca se reclama con una transaccion antes de crear la alerta. Asi el
  // trigger de status y el worker de heartbeat no pueden registrar dos veces
  // la misma desconexion si observan el cambio casi al mismo tiempo.
  const markerRef = admin.database().ref(`drivers/${driverId}/ultimo_alerta_desconexion_at`);
  const claim = await markerRef.transaction((lastAlertAt) => {
    const previous = Number(lastAlertAt || 0);
    return previous >= Number(disconnectedAt) ? lastAlertAt : Number(disconnectedAt);
  });
  if (!claim.committed || Number(claim.snapshot.val()) !== Number(disconnectedAt)) return null;

  const alertRef = admin.database().ref('prematureDisconnectAlerts').push();
  const alert = {
    driverId,
    driverName: driver.name || '',
    driverPlate: driver.plate || '',
    driverPhone: driver.phone || '',
    disconnectedAt: Number(disconnectedAt),
    createdAt: Date.now(),
    reason,
    reasonLabel: disconnectReasonLabel(reason),
    finalLat: Number.isFinite(Number(driver.lat)) ? Number(driver.lat) : null,
    finalLng: Number.isFinite(Number(driver.lng)) ? Number(driver.lng) : null,
    status: 'OPEN',
    acknowledged: false,
  };
  try {
    await alertRef.set(alert);
  } catch (error) {
    // Permite que un reintento registre la alerta si RTDB fallo despues de
    // reclamar la marca de idempotencia.
    await markerRef.transaction((current) => (
      Number(current || 0) === Number(disconnectedAt) ? null : current
    )).catch(() => null);
    throw error;
  }
  return { id: alertRef.key, ...alert };
}

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function requireDashboardAdmin(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
  const decoded = await admin.auth().verifyIdToken(header.slice(7));
  if (decoded.firebase?.sign_in_provider !== 'password') throw new Error('No autorizado');
  return decoded;
}

async function requireAuthenticatedUser(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
  return admin.auth().verifyIdToken(header.slice(7));
}

// Una revocación hecha con una versión anterior podía actualizar la invitación
// sin alcanzar el registro de acceso ya canjeado. Sincroniza ese estado antes
// de aceptar cualquier operación del pasajero, de forma idempotente.
async function syncRevokedPassengerAccess(uid, access) {
  if (!access || access.legacy === true || !access.inviteHash) return access;
  const invite = (await admin.database().ref(`passengerInvites/${access.inviteHash}`).once('value')).val();
  if (!invite || invite.status !== 'revoked') return access;
  const revokedAt = Number(invite.revokedAt) || Date.now();
  const revokedBy = String(invite.revokedBy || 'system');
  const result = await admin.database().ref(`passengerAccess/${uid}`).transaction((current) => (
    revokePassengerAccess(current, access.inviteHash, revokedBy, revokedAt)
  ));
  return result.snapshot.val();
}

async function requireDashboardManager(req) {
  const user = await requireDashboardAdmin(req);
  // Los roles viven en Firebase Auth. Asi el acceso al dashboard no depende de
  // Realtime Database (ni se bloquea si esta base esta temporalmente inaccesible).
  if (user.dashboardAdmin !== true) throw new Error('No tienes permiso para administrar usuarios');
  return user;
}

const DASHBOARD_PLACE_TYPES = new Set(['hotels', 'sportVenues']);

async function getDashboardPlace(sedeType, sedeId) {
  const type = String(sedeType || '').trim();
  const id = String(sedeId || '').trim();
  if (!DASHBOARD_PLACE_TYPES.has(type) || !id) return null;
  const snapshot = await admin.database().ref(`config/${type}/${id}`).once('value');
  const place = snapshot.val();
  if (!place || !place.name || !place.address) return null;
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { id, type, name: String(place.name), address: String(place.address), lat, lng };
}

async function dashboardClaimsForRole(role, sedeType, sedeId) {
  const normalizedRole = String(role || 'supervisor').trim().toLowerCase();
  if (normalizedRole === 'admin') {
    return { dashboardUser: true, dashboardAdmin: true, dashboardRole: 'ADMIN' };
  }
  if (normalizedRole === 'coordinator') {
    const place = await getDashboardPlace(sedeType, sedeId);
    if (!place) throw new Error('Selecciona una sede u hotel existente para el coordinador');
    return {
      dashboardUser: true,
      dashboardAdmin: false,
      dashboardRole: 'COORDINATOR',
      sedeId: place.id,
      sedeType: place.type,
      sedeName: place.name,
      sedeAddress: place.address,
      sedeLat: place.lat,
      sedeLng: place.lng,
    };
  }
  return { dashboardUser: true, dashboardAdmin: false, dashboardRole: 'SUPERVISOR' };
}

async function requireDashboardCoordinator(req) {
  const user = await requireDashboardAdmin(req);
  if (user.dashboardRole !== 'COORDINATOR') throw new Error('Solo un coordinador puede usar este panel');
  const place = await getDashboardPlace(user.sedeType, user.sedeId);
  if (!place) throw new Error('La sede asignada al coordinador ya no existe');
  return { ...user, coordinatorPlace: place };
}

function requestTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Acceso controlado para pasajeros de hoteles. El valor nunca se guarda en
// claro en RTDB: el QR contiene el token, pero Firebase solo conserva su hash.
const LEGACY_PASSENGER_ACCESS_CUTOFF_MS = 1786084297175;

function parsePassengerInviteToken(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  try {
    if (/^apl-passenger:\/\//i.test(value)) {
      value = new URL(value).searchParams.get('token') || '';
    }
  } catch (_) {
    return '';
  }
  value = decodeURIComponent(value).trim();
  if (/^APL-PASSENGER:/i.test(value)) value = value.slice('APL-PASSENGER:'.length).trim();
  return /^[a-f0-9]{32}$/i.test(value) ? value.toLowerCase() : '';
}

function isOwnedPassengerCredentialUrl(rawValue, uid) {
  try {
    const url = new URL(String(rawValue || '').trim());
    const expectedPrefix = `/v0/b/${BRANDING_BUCKET}/o/passenger_credentials/${uid}/`;
    return url.protocol === 'https:'
      && url.hostname === 'firebasestorage.googleapis.com'
      && decodeURIComponent(url.pathname).startsWith(expectedPrefix)
      && url.searchParams.get('alt') === 'media'
      && Boolean(url.searchParams.get('token'));
  } catch (_) {
    return false;
  }
}

async function functionsAccessToken() {
  const token = await admin.app().options.credential.getAccessToken();
  return token.access_token;
}

const DATABASE_REQUEST_TIMEOUT_MS = 10000;

async function readDatabaseWithEtag(path, accessToken) {
  const response = await fetch(`${DATABASE_URL}/${path}.json`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Firebase-ETag': 'true',
    },
    signal: AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`No se pudo leer ${path} (${response.status}).`);
  const etag = response.headers.get('ETag');
  if (!etag) throw new Error(`Firebase no devolvio ETag para ${path}.`);
  return {
    etag,
    value: await response.json(),
  };
}

async function putDatabaseIfUnchanged(path, value, etag, accessToken) {
  return fetch(`${DATABASE_URL}/${path}.json`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'if-match': etag,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS),
  });
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isValidFirebaseKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 768
    && !/[.#$\[\]/\u0000-\u001F\u007F]/.test(value);
}

function identityKey(value) {
  return crypto.createHash('sha256').update(normalizedIdentity(value)).digest('hex');
}

const DRIVER_UNIQUE_FIELDS = ['email', 'phone', 'plate', 'dni'];
const DRIVER_IDENTITY_FIELDS = [
  ['email', 'correo'],
  ['phone', 'teléfono'],
  ['plate', 'placa'],
  ['dni', 'DNI'],
];
const DRIVER_REJECTION_FIELDS = new Set([
  'personalData',
  'vehicleData',
  'profile',
  'dni',
  'license',
  'soat',
  'circulationCard',
  'technicalReview',
  'criminalRecord',
  'workCertificate',
]);

async function releaseUniqueDriverValue(field, value, uid) {
  if (!value) return;
  const ref = admin.database().ref(`driverUnique/${field}/${identityKey(value)}`);
  await ref.transaction((current) => {
    if (current?.uid === uid) return null;
    return current;
  });
}

async function releaseDriverIdentityReservations(driverId, driver = {}) {
  await Promise.all(DRIVER_UNIQUE_FIELDS.map(async (field) => {
    const ref = admin.database().ref(`driverUnique/${field}`);
    const snapshot = await ref.once('value');
    const reservations = snapshot.val() || {};
    const removals = {};

    for (const [key, reservation] of Object.entries(reservations)) {
      if (reservation?.uid === driverId) removals[key] = null;
    }
    if (driver[field]) removals[identityKey(driver[field])] = null;
    if (Object.keys(removals).length) await ref.update(removals);
  }));
}

async function deleteDriverDocuments(driverId) {
  const bucket = admin.storage().bucket(BRANDING_BUCKET);
  const [files] = await bucket.getFiles({ prefix: `driver_documents/${driverId}/` });
  await Promise.all(files.map((file) => file.delete()));
  return files.length;
}

async function deleteStoragePrefix(prefix) {
  const bucket = admin.storage().bucket(BRANDING_BUCKET);
  const [files] = await bucket.getFiles({ prefix });
  await Promise.all(files.map((file) => file.delete()));
  return files.length;
}

// Borra los registros que contienen datos identificables de una cuenta. Se
// usa desde la ruta de autoservicio de eliminacion, no desde el dashboard:
// las cuentas eliminadas no deben dejar viajes ni documentos huérfanos.
async function deleteUserTripRecords(uid) {
  const db = admin.database();
  const [tripsSnap, historySnap, driverHistorySnap, coordinatorSnap] = await Promise.all([
    db.ref('trips').once('value'),
    db.ref('tripHistory').once('value'),
    db.ref('driverTripHistory').once('value'),
    db.ref('coordinatorTrips').once('value'),
  ]);

  const removals = {};
  const affectedTripIds = new Set();
  const markTrip = (path, tripId, trip) => {
    if (!trip || (trip.passengerId !== uid && trip.driverId !== uid)) return;
    removals[path] = null;
    if (tripId) affectedTripIds.add(tripId);
  };

  for (const [tripId, trip] of Object.entries(tripsSnap.val() || {})) {
    markTrip(`trips/${tripId}`, tripId, trip);
  }
  for (const [tripId, trip] of Object.entries(historySnap.val() || {})) {
    markTrip(`tripHistory/${tripId}`, tripId, trip);
  }

  for (const [driverId, driverTrips] of Object.entries(driverHistorySnap.val() || {})) {
    if (driverId === uid) {
      removals[`driverTripHistory/${driverId}`] = null;
      for (const tripId of Object.keys(driverTrips || {})) affectedTripIds.add(tripId);
      continue;
    }
    for (const [tripId, trip] of Object.entries(driverTrips || {})) {
      markTrip(`driverTripHistory/${driverId}/${tripId}`, tripId, trip);
    }
  }

  // Los coordinadores tienen espejos privados por sede. Quitamos los viajes
  // afectados para que una cuenta eliminada tampoco quede visible allí.
  for (const [coordinatorUid, coordinatorTrips] of Object.entries(coordinatorSnap.val() || {})) {
    for (const tripId of affectedTripIds) {
      if (coordinatorTrips?.[tripId]) {
        removals[`coordinatorTrips/${coordinatorUid}/${tripId}`] = null;
      }
    }
  }

  if (Object.keys(removals).length) await db.ref().update(removals);
  return affectedTripIds.size;
}

// Eliminacion de cuenta iniciada por el propio conductor o pasajero. La
// identidad se valida con Firebase Auth y la cuenta se elimina al final,
// despues de retirar perfil, documentos, ubicaciones y viajes identificables.
exports.deleteMyAccount = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const user = await requireAuthenticatedUser(req);
    const uid = user.uid;
    const db = admin.database();
    const driverRef = db.ref(`drivers/${uid}`);
    const passengerRef = db.ref(`passengers/${uid}`);
    const [driverSnap, passengerSnap, tripsSnap] = await Promise.all([
      driverRef.once('value'),
      passengerRef.once('value'),
      db.ref('trips').once('value'),
    ]);
    const driver = driverSnap.val() || null;
    const passenger = passengerSnap.val() || null;
    const activeStatuses = new Set(['assigned_pending_accept', 'accepted', 'arrived_at_pickup', 'in_progress']);
    const activeTrip = Object.values(tripsSnap.val() || {}).find((trip) =>
      (trip?.driverId === uid || trip?.passengerId === uid) && activeStatuses.has(trip?.status));

    if (activeTrip || driver?.currentTripId || driver?.status === 'busy') {
      return res.status(409).json({
        error: 'Termina o cancela el viaje activo antes de eliminar la cuenta.',
      });
    }

    await deleteUserTripRecords(uid);
    const removals = {
      [`drivers/${uid}`]: driver ? null : undefined,
      [`driverLocations/${uid}`]: driver ? null : undefined,
      [`driverConnectionHistory/${uid}`]: driver ? null : undefined,
      [`passengers/${uid}`]: passenger ? null : undefined,
      [`passengerAccess/${uid}`]: passenger ? null : undefined,
    };
    Object.keys(removals).forEach((path) => {
      if (removals[path] === undefined) delete removals[path];
    });
    if (Object.keys(removals).length) await db.ref().update(removals);

    if (driver) {
      await Promise.all([
        deleteStoragePrefix(`driver_documents/${uid}/`),
        releaseDriverIdentityReservations(uid, driver),
      ]);
    }
    if (passenger) await deleteStoragePrefix(`passenger_credentials/${uid}/`);

    await admin.auth().deleteUser(uid).catch((error) => {
      if (error?.code !== 'auth/user-not-found') throw error;
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('deleteMyAccount', error);
    return res.status(400).json({ error: error.message || 'No se pudo eliminar la cuenta.' });
  }
});

async function reserveUniqueDriverValue(field, value, uid) {
  const ref = admin.database().ref(`driverUnique/${field}/${identityKey(value)}`);
  const current = (await ref.once('value')).val();
  if (current?.uid && current.uid !== uid) {
    const activeDriver = await admin.database().ref(`drivers/${current.uid}`).once('value');
    if (!activeDriver.exists()) {
      await ref.transaction((reservation) => (
        reservation?.uid === current.uid ? null : reservation
      ));
    }
  }
  const result = await ref.transaction((current) => current || { uid, value: normalizedIdentity(value), reservedAt: Date.now() });
  return result.committed && result.snapshot.val()?.uid === uid;
}

exports.reserveDriverIdentity = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
    const user = await admin.auth().verifyIdToken(header.slice(7));
    const { email, phone, plate, dni, name, vehicleType, vehicleColor, vehicleSeats } = req.body || {};
    if (!email || !phone || !plate || !dni || !name) {
      return res.status(400).json({ error: 'Completa correo, teléfono, placa, DNI y nombre.' });
    }
    if (normalizedIdentity(email) !== normalizedIdentity(user.email)) {
      return res.status(400).json({ error: 'El correo del registro no coincide con la cuenta creada.' });
    }
    if (!/^\+\d{8,19}$/.test(String(phone).trim())) {
      return res.status(400).json({ error: 'El teléfono no tiene un formato válido.' });
    }
    if (!validVehicleData(vehicleType, vehicleColor, vehicleSeats)) {
      return res.status(400).json({ error: 'Selecciona un tipo, color y cantidad de pasajeros válidos.' });
    }
    const fields = [
      ['email', email, 'correo'],
      ['phone', phone, 'teléfono'],
      ['plate', plate, 'placa'],
      ['dni', dni, 'DNI'],
    ];
    const existingDrivers = (await admin.database().ref('drivers').once('value')).val() || {};
    for (const [, driver] of Object.entries(existingDrivers)) {
      for (const [field, value, label] of fields) {
        if (normalizedIdentity(driver[field]) === normalizedIdentity(value)) {
          await admin.auth().deleteUser(user.uid).catch(() => null);
          return res.status(409).json({ error: `Ya existe un conductor con ese ${label}.` });
        }
      }
    }
    const reserved = [];
    for (const [field, value, label] of fields) {
      const ok = await reserveUniqueDriverValue(field, value, user.uid);
      if (!ok) {
        await Promise.all(reserved.map(([reservedField, reservedValue]) => releaseUniqueDriverValue(reservedField, reservedValue, user.uid)));
        await admin.auth().deleteUser(user.uid).catch(() => null);
        return res.status(409).json({ error: `Ya existe un conductor con ese ${label}.` });
      }
      reserved.push([field, value]);
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('reserveDriverIdentity', error);
    return res.status(400).json({ error: error.message || 'No se pudo validar el registro.' });
  }
});

const DRIVER_APPLICATION_FIELDS = [
  'name',
  'age',
  'phone',
  'dni',
  'plate',
  'vehicleBrand',
  'vehicleType',
  'vehicleColor',
  'vehicleSeats',
  'profilePhotoUrl',
  'dniDocUrl',
  'dniFrontDocUrl',
  'dniBackDocUrl',
  'licenseDocUrl',
  'licenseExpiresAt',
  'soatDocUrl',
  'soatExpiresAt',
  'circulationCardDocUrl',
  'technicalReviewDocUrl',
  'technicalReviewExpiresAt',
  'criminalRecordDocUrl',
  'workCertificateDocUrl',
];

async function reserveDriverApplicationIdentities(uid, application) {
  const drivers = (await admin.database().ref('drivers').once('value')).val() || {};
  for (const [driverId, driver] of Object.entries(drivers)) {
    if (driverId === uid) continue;
    for (const [field, label] of DRIVER_IDENTITY_FIELDS) {
      if (normalizedIdentity(driver?.[field]) === normalizedIdentity(application[field])) {
        return { ok: false, error: `Ya existe un conductor con ese ${label}.`, reserved: [] };
      }
    }
  }

  const reserved = [];
  for (const [field, label] of DRIVER_IDENTITY_FIELDS) {
    const value = application[field];
    const ok = await reserveUniqueDriverValue(field, value, uid);
    if (!ok) {
      await Promise.all(reserved.map(([reservedField, reservedValue]) => (
        releaseUniqueDriverValue(reservedField, reservedValue, uid)
      )));
      return { ok: false, error: `Ya existe un conductor con ese ${label}.`, reserved: [] };
    }
    reserved.push([field, value]);
  }
  return { ok: true, reserved };
}

// Cierra el alta únicamente cuando la solicitud está completa. La operación
// es reintentable: si la app se cerró después de crear la cuenta o subir una
// parte de los archivos, el mismo correo y contraseña pueden continuar sin
// crear otro UID ni dejar reservas huérfanas.
exports.completeDriverRegistration = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  let reservation = null;
  let authenticatedUid = '';
  try {
    const user = await requireAuthenticatedUser(req);
    authenticatedUid = user.uid;
    if (!user.email || user.firebase?.sign_in_provider !== 'password') {
      return res.status(403).json({ error: 'El registro requiere una cuenta de correo y contraseña.' });
    }

    const application = { email: normalizedIdentity(user.email) };
    for (const field of DRIVER_APPLICATION_FIELDS) application[field] = req.body?.[field];
    application.name = String(application.name || '').trim();
    application.age = Number(application.age);
    application.phone = String(application.phone || '').trim();
    application.dni = String(application.dni || '').trim();
    application.plate = String(application.plate || '').trim().toUpperCase();
    application.vehicleBrand = String(application.vehicleBrand || '').trim();
    application.vehicleType = String(application.vehicleType || '').trim();
    application.vehicleColor = String(application.vehicleColor || '').trim();
    application.vehicleSeats = Number(application.vehicleSeats);

    const driverRef = admin.database().ref(`drivers/${user.uid}`);
    const current = (await driverRef.once('value')).val();
    if (current) {
      if (current.approvalStatus === 'pending_review') {
        return res.json({ ok: true, resumed: true });
      }
      return res.status(409).json({ error: 'La cuenta ya tiene un registro de conductor.' });
    }

    const issues = driverApplicationIssues(application, user.uid, BRANDING_BUCKET);
    if (issues.length) {
      return res.status(400).json({
        error: `Completa o corrige: ${issues.join(', ')}.`,
        issues,
      });
    }

    reservation = await reserveDriverApplicationIdentities(user.uid, application);
    if (!reservation.ok) return res.status(409).json({ error: reservation.error });

    const now = Date.now();
    await driverRef.set({
      ...application,
      approvalStatus: 'pending_review',
      registeredAt: now,
      documentsSubmittedAt: now,
    });
    reservation = null;
    return res.json({ ok: true, resumed: false });
  } catch (error) {
    if (reservation?.ok) {
      await Promise.all(reservation.reserved.map(([field, value]) => (
        releaseUniqueDriverValue(field, value, authenticatedUid)
      ))).catch(() => null);
    }
    console.error('completeDriverRegistration', error);
    return res.status(400).json({ error: error.message || 'No se pudo completar el registro.' });
  }
});

const PERSONAL_DRIVER_FIELDS = ['name', 'age', 'phone', 'dni'];
const VEHICLE_DRIVER_FIELDS = [
  'plate',
  'vehicleBrand',
  'vehicleType',
  'vehicleColor',
  'vehicleSeats',
];

function requestedDocumentUpdate(body, document) {
  const alternatives = document.alternatives || [document.fields];
  const selected = alternatives.find((fields) => fields.every((field) => body?.[field]));
  if (!selected) return null;
  const update = {};
  for (const fields of alternatives) {
    for (const field of fields) update[field] = null;
  }
  for (const field of selected) update[field] = body[field];
  if (document.expiresField) update[document.expiresField] = Number(body?.[document.expiresField]);
  return update;
}

async function reserveChangedDriverIdentities(uid, current, updated) {
  const changed = DRIVER_IDENTITY_FIELDS.filter(([field]) => (
    normalizedIdentity(current[field]) !== normalizedIdentity(updated[field])
  ));
  if (!changed.length) return { ok: true, reserved: [] };

  const drivers = (await admin.database().ref('drivers').once('value')).val() || {};
  for (const [driverId, driver] of Object.entries(drivers)) {
    if (driverId === uid) continue;
    for (const [field, label] of changed) {
      if (normalizedIdentity(driver?.[field]) === normalizedIdentity(updated[field])) {
        return { ok: false, error: `Ya existe un conductor con ese ${label}.`, reserved: [] };
      }
    }
  }

  const reserved = [];
  for (const [field, label] of changed) {
    const value = updated[field];
    if (!(await reserveUniqueDriverValue(field, value, uid))) {
      await Promise.all(reserved.map(([reservedField, reservedValue]) => (
        releaseUniqueDriverValue(reservedField, reservedValue, uid)
      )));
      return { ok: false, error: `Ya existe un conductor con ese ${label}.`, reserved: [] };
    }
    reserved.push([field, value]);
  }
  return { ok: true, reserved, changed };
}

exports.resubmitDriverApplication = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  let identityReservation = null;
  let userId = '';
  try {
    const user = await requireAuthenticatedUser(req);
    userId = user.uid;
    const driverRef = admin.database().ref(`drivers/${user.uid}`);
    const current = (await driverRef.once('value')).val();
    if (!current) return res.status(404).json({ error: 'Perfil de conductor no encontrado.' });
    if (current.approvalStatus !== 'rejected') {
      return res.status(409).json({ error: 'El registro ya no está rechazado.' });
    }

    const rejectionFields = new Set(String(current.rejectionFieldKeys || '')
      .split(',').map((field) => field.trim()).filter(Boolean));
    const updates = {};

    if (rejectionFields.has('personalData')) {
      for (const field of PERSONAL_DRIVER_FIELDS) updates[field] = req.body?.[field];
    }
    if (rejectionFields.has('vehicleData')) {
      for (const field of VEHICLE_DRIVER_FIELDS) updates[field] = req.body?.[field];
    }

    const rejectedDocuments = REQUIRED_DRIVER_DOCUMENTS.filter((document) => (
      rejectionFields.has(document.key)
    ));
    for (const document of rejectedDocuments) {
      const documentUpdate = requestedDocumentUpdate(req.body, document);
      if (!documentUpdate) {
        return res.status(400).json({ error: `Vuelve a subir ${document.label}.` });
      }
      Object.assign(updates, documentUpdate);
    }

    // Compatibilidad con rechazos antiguos que no guardaban campos: se
    // acepta al menos un documento, pero nunca cambios silenciosos de perfil.
    if (!rejectionFields.size) {
      for (const document of REQUIRED_DRIVER_DOCUMENTS) {
        const documentUpdate = requestedDocumentUpdate(req.body, document);
        if (documentUpdate) Object.assign(updates, documentUpdate);
      }
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No se recibió ninguna corrección autorizada.' });
    }

    const merged = {
      ...current,
      ...updates,
      email: normalizedIdentity(current.email || user.email),
      name: String(updates.name ?? current.name ?? '').trim(),
      age: Number(updates.age ?? current.age),
      phone: String(updates.phone ?? current.phone ?? '').trim(),
      dni: String(updates.dni ?? current.dni ?? '').trim(),
      plate: String(updates.plate ?? current.plate ?? '').trim().toUpperCase(),
      vehicleBrand: String(updates.vehicleBrand ?? current.vehicleBrand ?? '').trim(),
      vehicleType: String(updates.vehicleType ?? current.vehicleType ?? '').trim(),
      vehicleColor: String(updates.vehicleColor ?? current.vehicleColor ?? '').trim(),
      vehicleSeats: Number(updates.vehicleSeats ?? current.vehicleSeats),
    };
    const issues = driverApplicationIssues(merged, user.uid, BRANDING_BUCKET);
    if (issues.length) {
      return res.status(400).json({
        error: `Completa o corrige: ${issues.join(', ')}.`,
        issues,
      });
    }

    identityReservation = await reserveChangedDriverIdentities(user.uid, current, merged);
    if (!identityReservation.ok) return res.status(409).json({ error: identityReservation.error });

    const expectedReview = Number(current.reviewedAt || 0);
    const transaction = await driverRef.transaction((latest) => {
      if (!latest || latest.approvalStatus !== 'rejected') return;
      if (Number(latest.reviewedAt || 0) !== expectedReview) return;
      return {
        ...latest,
        ...updates,
        name: merged.name,
        age: merged.age,
        phone: merged.phone,
        dni: merged.dni,
        plate: merged.plate,
        vehicleBrand: merged.vehicleBrand,
        vehicleType: merged.vehicleType,
        vehicleColor: merged.vehicleColor,
        vehicleSeats: merged.vehicleSeats,
        approvalStatus: 'pending_review',
        rejectionReason: null,
        rejectionFieldKeys: null,
        documentsSubmittedAt: Date.now(),
      };
    });
    if (!transaction.committed) {
      return res.status(409).json({ error: 'La revisión cambió mientras corregías. Actualiza e intenta de nuevo.' });
    }

    for (const [field] of identityReservation.changed || []) {
      await releaseUniqueDriverValue(field, current[field], user.uid);
    }
    identityReservation = null;
    return res.json({ ok: true });
  } catch (error) {
    console.error('resubmitDriverApplication', error);
    return res.status(400).json({ error: error.message || 'No se pudo reenviar el registro.' });
  } finally {
    if (identityReservation?.ok) {
      await Promise.all(identityReservation.reserved.map(([field, value]) => (
        releaseUniqueDriverValue(field, value, userId)
      ))).catch(() => null);
    }
  }
});

async function recordAuditEvent(actor, action, targetType, targetId, details = {}) {
  const eventRef = admin.database().ref('auditLogs').push();
  await eventRef.set({
    action,
    targetType,
    targetId,
    actorUid: actor?.uid || '',
    actorEmail: actor?.email || '',
    actorRole: actor?.dashboardRole || (actor?.dashboardAdmin === true ? 'ADMIN' : ''),
    createdAt: Date.now(),
    details,
  });
  return eventRef.key;
}

exports.manageDrivers = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const { action, driverId, place } = req.body || {};
    if (!driverId) return res.status(400).json({ error: 'Conductor requerido' });
    const driverRef = admin.database().ref(`drivers/${driverId}`);
    const driver = (await driverRef.once('value')).val();
    // La eliminacion debe poder reintentarse aunque una version anterior
    // haya quitado el perfil y dejado la cuenta de Authentication o sus
    // reservas unicas pendientes.
    if (!driver && action !== 'delete') return res.status(404).json({ error: 'Conductor no encontrado' });
    if (action === 'approve') {
      if (driver.approvalStatus !== 'pending_review') {
        return res.status(409).json({ error: 'Solo se puede aprobar un registro pendiente.' });
      }
      const issues = driverApplicationIssues(driver, driverId, BRANDING_BUCKET);
      if (issues.length) {
        return res.status(409).json({
          error: `No se puede aprobar. Falta o está vencido: ${issues.join(', ')}.`,
          issues,
        });
      }
      await driverRef.update({
        approvalStatus: 'approved',
        rejectionReason: null,
        rejectionFieldKeys: null,
        reviewedAt: Date.now(),
        reviewedBy: manager.email || '',
      });
      await recordAuditEvent(manager, 'DRIVER_APPROVED', 'driver', driverId);
      return res.json({ ok: true });
    }
    if (action === 'assignPlace') {
      if (!place?.name || !place?.type) return res.status(400).json({ error: 'Selecciona un hotel o sede.' });
      const assignedPlace = { name: String(place.name), type: String(place.type), assignedAt: Date.now() };
      await driverRef.update({ assignedPlace });
      await sendPush(driver.fcmToken, 'place_assigned', {
        placeName: assignedPlace.name,
        placeType: assignedPlace.type,
        route: 'home',
        deepLink: 'driver://home',
      });
      await recordAuditEvent(manager, 'DRIVER_PLACE_ASSIGNED', 'driver', driverId, assignedPlace);
      return res.json({ ok: true });
    }
    if (action === 'suspend') {
      const reason = String(req.body?.reason || '').trim();
      if (reason.length < 5 || reason.length > 300) {
        return res.status(400).json({ error: 'Escribe un motivo entre 5 y 300 caracteres.' });
      }
      if (driver.currentTripId || driver.status === 'busy') {
        return res.status(409).json({ error: 'No puedes suspender a un conductor con un viaje activo.' });
      }
      const now = Date.now();
      await driverRef.update({
        suspended: true,
        suspensionReason: reason,
        suspendedAt: now,
        suspendedBy: manager.email || '',
        status: null,
        turno_activo: false,
        estado_conexion: 'OFFLINE',
        ultima_conexion: now,
        ultimo_motivo_desconexion: 'ADMIN',
      });
      await recordAuditEvent(manager, 'DRIVER_SUSPENDED', 'driver', driverId, { reason });
      await sendPush(driver.fcmToken, 'driver_suspended', { reason });
      return res.json({ ok: true });
    }
    if (action === 'reinstate') {
      await driverRef.update({
        suspended: null,
        suspensionReason: null,
        suspendedAt: null,
        suspendedBy: null,
      });
      await recordAuditEvent(manager, 'DRIVER_REINSTATED', 'driver', driverId);
      return res.json({ ok: true });
    }
    if (action === 'reject') {
      const reason = String(req.body?.reason || '').trim();
      const rejectionFields = Array.isArray(req.body?.rejectionFields)
        ? [...new Set(req.body.rejectionFields.map((field) => String(field)))]
        : [];
      if (!reason) return res.status(400).json({ error: 'Escribe el motivo del rechazo.' });
      if (!rejectionFields.length || rejectionFields.some((field) => !DRIVER_REJECTION_FIELDS.has(field))) {
        return res.status(400).json({ error: 'Selecciona al menos un dato o documento que deba corregirse.' });
      }
      if (driver.currentTripId || driver.status === 'busy') {
        return res.status(409).json({ error: 'No puedes rechazar a un conductor con un viaje activo.' });
      }
      await driverRef.update({
        approvalStatus: 'rejected',
        rejectionReason: reason,
        rejectionFieldKeys: rejectionFields.join(','),
        reviewedAt: Date.now(),
        reviewedBy: manager.email || '',
        status: null,
        estado_conexion: 'OFFLINE',
        ultima_conexion: Date.now(),
        ultimo_motivo_desconexion: 'ADMIN',
        currentTripId: null,
      });
      await recordAuditEvent(manager, 'DRIVER_REJECTED', 'driver', driverId, {
        reason,
        rejectionFields,
      });
      return res.json({ ok: true });
    }
    if (action === 'delete') {
      let authDeleted = false;
      try {
        await admin.auth().deleteUser(driverId);
        authDeleted = true;
      } catch (error) {
        // Si la cuenta ya no existe en Authentication, el borrado del
        // perfil se puede completar. Otros errores no deben ocultarse:
        // dejar el perfil visible permite reintentar y evita correos
        // bloqueados sin avisar al administrador.
        if (error?.code !== 'auth/user-not-found') throw error;
      }
      await deleteDriverDocuments(driverId);
      // Primero libera todas las reservas de identidad. Se revisan también
      // reservas antiguas ligadas a este UID, para que un conductor eliminado
      // desde el dashboard pueda registrarse otra vez con sus mismos datos.
      await releaseDriverIdentityReservations(driverId, driver || {});
      await Promise.all([
        driverRef.remove(),
        admin.database().ref(`driverConnectionHistory/${driverId}`).remove(),
      ]);
      await recordAuditEvent(manager, 'DRIVER_DELETED', 'driver', driverId, {
        email: driver?.email || '',
      });
      return res.json({ ok: true, authDeleted });
    }
    return res.status(400).json({ error: 'Accion invalida' });
  } catch (error) {
    console.error('manageDrivers', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Cierra una alerta sin permitir que el navegador edite directamente el
// historial operativo. La escritura queda auditada con el usuario y la hora
// en que el administrador la reconocio.
exports.manageOperationAlert = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const alertId = String(req.body?.alertId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!alertId) return res.status(400).json({ error: 'Alerta requerida' });
    if (!['acknowledge', 'close'].includes(action)) {
      return res.status(400).json({ error: 'Accion invalida' });
    }
    const alertRef = admin.database().ref(`prematureDisconnectAlerts/${alertId}`);
    const snapshot = await alertRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ error: 'Alerta no encontrada' });
    const now = Date.now();
    await alertRef.update({
      status: 'CLOSED',
      acknowledged: true,
      acknowledgedAt: now,
      acknowledgedBy: manager.email || manager.uid,
    });
    return res.json({ ok: true, status: 'CLOSED', acknowledgedAt: now });
  } catch (error) {
    console.error('manageOperationAlert', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Punto unico para iniciar/terminar la disponibilidad. La app no escribe el
// estado operativo directamente: el backend registra cada desconexion para
// auditoria y alerta en tiempo real.
exports.setDriverAvailability = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
    const user = await admin.auth().verifyIdToken(header.slice(7));
    const driverId = user.uid;
    if (req.body?.uid && String(req.body.uid) !== driverId) {
      return res.status(403).json({ error: 'La sesión no corresponde al conductor.' });
    }
    const online = req.body?.online === true;
    const now = Date.now();
    const accessToken = await functionsAccessToken();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: current } = await readDatabaseWithEtag(`drivers/${driverId}`, accessToken);
      const decision = buildDriverAvailabilityUpdate(current, online, now);
      if (!decision.ok) return res.status(decision.httpStatus).json({ error: decision.error });

      const response = await putDatabaseIfUnchanged(
        `drivers/${driverId}`,
        decision.value,
        etag,
        accessToken,
      );
      if (response.ok) return res.json({ ok: true, status: decision.publicStatus });
      if (response.status !== 412) {
        throw new Error(`No se pudo actualizar el turno (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
    return res.status(409).json({ error: 'El turno cambio mientras se actualizaba. Intenta nuevamente.' });
  } catch (error) {
    console.error('setDriverAvailability', error);
    return res.status(403).json({ error: error.message || 'No se pudo actualizar el turno.' });
  }
});

// Publica una posicion GPS desde el telefono sin permitir escrituras directas
// sobre todo el perfil del conductor. Las reglas RTDB mantienen bloqueado el
// nodo padre `drivers/{uid}`; esta funcion valida el token, el perfil aprobado
// y actualiza unicamente los campos de ubicacion necesarios.
exports.updateDriverLocation = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
    const user = await admin.auth().verifyIdToken(header.slice(7));
    const driverId = user.uid;
    const normalizedLocation = normalizeDriverLocation(req.body);
    if (!normalizedLocation) {
      return res.status(400).json({ error: 'Coordenadas GPS invalidas.' });
    }

    // La hora la fija el servidor para evitar falsos heartbeats por un reloj
    // incorrecto del teléfono.
    const lastUpdate = Date.now();
    const location = { ...normalizedLocation, lastUpdate };
    // ETag + if-match mantiene atomica la comprobacion del turno y la escritura
    // del heartbeat. Si el conductor termina el turno en medio, Firebase
    // responde 412 y reintentamos contra el estado nuevo sin reactivarlo.
    const accessToken = await functionsAccessToken();
    let profileUpdated = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: current } = await readDatabaseWithEtag(`drivers/${driverId}`, accessToken);
      const decision = buildDriverLocationUpdate(current, normalizedLocation, lastUpdate);
      if (!decision.ok) return res.status(decision.httpStatus).json({ error: decision.error });

      const response = await putDatabaseIfUnchanged(
        `drivers/${driverId}`,
        decision.value,
        etag,
        accessToken,
      );
      if (response.ok) {
        profileUpdated = true;
        break;
      }
      if (response.status !== 412) {
        throw new Error(`No se pudo guardar la ubicacion (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
    if (!profileUpdated) throw new Error('La ubicacion cambio varias veces; intenta nuevamente.');
    await admin.database().ref(`driverLocations/${driverId}`).set(location);
    return res.json({ ok: true, lastUpdate });
  } catch (error) {
    console.error('updateDriverLocation', error);
    return res.status(403).json({ error: error.message || 'No se pudo actualizar la ubicacion.' });
  }
});

// Avanza el viaje exclusivamente desde el backend. La app puede perder su
// proceso y volver a abrirse, pero nunca debe poder finalizar un viaje solo
// porque aun no recupero el GPS. La validacion de cercania se hace con la
// ultima posicion GPS recibida en el servidor y la escritura condicional
// protege contra dos gestos simultaneos o una pantalla antigua.
exports.advanceDriverTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
    const user = await admin.auth().verifyIdToken(header.slice(7));
    const tripId = String(req.body?.tripId || '').trim();
    const newStatus = String(req.body?.newStatus || '').trim();
    const expectedStatus = EXPECTED_STATUS_BY_NEXT[newStatus];
    if (!isValidFirebaseKey(tripId) || !expectedStatus) {
      return res.status(400).json({ error: 'Transicion de viaje invalida.' });
    }

    const driver = newStatus === 'arrived_at_pickup' || newStatus === 'completed'
      ? ((await admin.database().ref(`drivers/${user.uid}`).once('value')).val() || {})
      : null;
    const accessToken = await functionsAccessToken();

    // La transición usa el mismo patrón ETag/if-match que la asignación de
    // conductores. Así una cancelación o cambio de destino concurrente no
    // puede quedar confirmado como un avance falso ni recrear un viaje borrado.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: current } = await readDatabaseWithEtag(`trips/${tripId}`, accessToken);
      const decision = prepareDriverTripTransition({
        trip: current,
        driverId: user.uid,
        newStatus,
        driver,
        now: Date.now(),
      });
      if (decision.alreadyApplied) {
        return res.json({ ok: true, status: newStatus, alreadyApplied: true });
      }
      if (!decision.ok) {
        if (decision.httpStatus === 409) {
          console.warn('advanceDriverTrip state conflict', {
            tripId,
            newStatus,
            expectedStatus,
            currentStatus: decision.currentStatus || null,
            driverId: user.uid,
          });
        }
        const errorBody = { error: decision.error };
        if (Object.hasOwn(decision, 'currentStatus')) errorBody.currentStatus = decision.currentStatus;
        if (Object.hasOwn(decision, 'distanceMeters')) errorBody.distanceMeters = decision.distanceMeters;
        return res.status(decision.httpStatus).json(errorBody);
      }

      const response = await putDatabaseIfUnchanged(
        `trips/${tripId}`,
        decision.value,
        etag,
        accessToken,
      );
      if (response.ok) return res.json({ ok: true, status: newStatus });
      if (response.status !== 412) {
        throw new Error(`No se pudo guardar el viaje (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }

    console.warn('advanceDriverTrip conditional update retry exhausted', {
      tripId,
      newStatus,
      expectedStatus,
      driverId: user.uid,
    });
    return res.status(409).json({
      error: 'No se pudo confirmar el viaje. Desliza nuevamente.',
      currentStatus: expectedStatus,
    });
  } catch (error) {
    console.error('advanceDriverTrip', error);
    return res.status(403).json({ error: error.message || 'No se pudo actualizar el viaje.' });
  }
});

// Permite corregir el telefono del conductor sin limite de veces.
exports.updateDriverProfileOnce = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('No autorizado');
    const user = await admin.auth().verifyIdToken(header.slice(7));
    const { phone } = req.body || {};
    const cleanPhone = String(phone || '').trim();

    if (!/^\+\d{8,19}$/.test(cleanPhone)) {
      return res.status(400).json({ error: 'El teléfono no tiene un formato válido.' });
    }
    const token = await functionsAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const profileUrl = `${DATABASE_URL}/drivers/${user.uid}.json`;
    const getResponse = await fetch(profileUrl, {
      headers: { ...headers, 'X-Firebase-ETag': 'true' },
      signal: AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS),
    });
    if (!getResponse.ok) {
      throw new Error(`No se pudo consultar el perfil (${getResponse.status})`);
    }

    const etag = getResponse.headers.get('ETag');
    const current = await getResponse.json();
    if (!current) return res.status(404).json({ error: 'Perfil de conductor no encontrado.' });
    if (current.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'El conductor todavía no está aprobado.' });
    }

    const currentPhone = String(current.phone || '').trim();
    const phoneChanged = normalizedIdentity(currentPhone) !== normalizedIdentity(cleanPhone);
    let phoneReserved = false;
    if (phoneChanged) {
      const drivers = (await admin.database().ref('drivers').once('value')).val() || {};
      const conflict = Object.entries(drivers).some(([driverId, driver]) => (
        driverId !== user.uid && normalizedIdentity(driver.phone) === normalizedIdentity(cleanPhone)
      ));
      if (conflict) return res.status(409).json({ error: 'Ya existe un conductor con ese teléfono.' });

      phoneReserved = await reserveUniqueDriverValue('phone', cleanPhone, user.uid);
      if (!phoneReserved) return res.status(409).json({ error: 'Ya existe un conductor con ese teléfono.' });
    }

    const updated = {
      ...current,
      phone: cleanPhone,
      profileEditedAt: Date.now(),
    };
    const putResponse = await fetch(profileUrl, {
      method: 'PUT',
      headers: {
        ...headers,
        'if-match': etag,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updated),
      signal: AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS),
    });
    if (putResponse.status === 412) {
      if (phoneReserved) await releaseUniqueDriverValue('phone', cleanPhone, user.uid);
      return res.status(409).json({ error: 'El perfil cambió mientras se guardaba. Intenta nuevamente.' });
    }
    if (!putResponse.ok) {
      if (phoneReserved) await releaseUniqueDriverValue('phone', cleanPhone, user.uid);
      throw new Error(`No se pudo guardar el perfil (${putResponse.status})`);
    }

    if (phoneChanged && currentPhone) {
      await releaseUniqueDriverValue('phone', currentPhone, user.uid);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('updateDriverProfileOnce', error);
    return res.status(401).json({ error: error.message || 'No se pudo actualizar el perfil.' });
  }
});

async function validBuildRequest(requestId, token) {
  const snapshot = await admin.database().ref(`appBuildRequests/${requestId}`).once('value');
  const request = snapshot.val();
  if (!request || request.status !== 'building' || request.expiresAt < Date.now()) return null;
  return request.tokenHash === requestTokenHash(token) ? request : null;
}

// El dashboard llama esta funcion con su idToken. La funcion crea una orden
// de un solo uso, activa GitHub Actions y le entrega a ese flujo una URL de
// carga temporal; asi GitHub no necesita almacenar credenciales de Firebase.
exports.requestAppBrandingBuild = functions
  .runWith({ secrets: ['GITHUB_DISPATCH_TOKEN'] })
  .https.onRequest(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

    try {
      await requireDashboardManager(req);
      const app = BRANDING_APPS[req.body?.app];
      const appKey = req.body?.app;
      if (!app) return res.status(400).json({ error: 'App invalida' });

      const configSnap = await admin.database().ref('config').once('value');
      const config = configSnap.val() || {};
      const branding = config.appBranding?.[appKey] || {};
      const buildSequenceRef = admin.database().ref(`appBuildSequences/${appKey}`);
      const buildReservation = await buildSequenceRef.transaction((current) => nextBuildNumber({
        configuredBuild: config[app.buildField],
        reservedBuild: current,
        minimumBuild: app.minimumBuild,
      }));
      if (!buildReservation.committed) throw new Error('No se pudo reservar un número de build.');
      const build = Number(buildReservation.snapshot.val());
      const requestId = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + BRANDING_BUILD_TTL_MS;
      const bucket = admin.storage().bucket(BRANDING_BUCKET);
      const [uploadUrl] = await bucket.file(app.apkPath).getSignedUrl({
        version: 'v4', action: 'write', expires: expiresAt, contentType: 'application/vnd.android.package-archive',
      });
      await admin.database().ref(`appBuildRequests/${requestId}`).set({
        app: appKey,
        build,
        versionName: app.versionName,
        name: branding.name || app.defaultName,
        iconUrl: branding.iconUrl || '',
        apkPath: app.apkPath,
        uploadUrl,
        tokenHash: requestTokenHash(token),
        status: 'building',
        createdAt: Date.now(),
        expiresAt,
      });

      const githubResponse = await fetch(
        'https://api.github.com/repos/manuel955/fleet-tracking-system/actions/workflows/build-branded-app.yml/dispatches',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'master', inputs: { app: appKey, request_id: requestId, build_token: token } }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!githubResponse.ok) {
        await admin.database().ref(`appBuildRequests/${requestId}/status`).set('failed');
        throw new Error(`GitHub no acepto la compilacion (${githubResponse.status})`);
      }
      return res.status(202).json({ build, requestId });
    } catch (error) {
      console.error('requestAppBrandingBuild', error);
      return res.status(401).json({ error: error.message || 'No se pudo iniciar la compilacion' });
    }
  });

// Solo GitHub Actions conoce el token de un solo uso que recibe al despachar
// el workflow. Devuelve la marca y URL firmada para subir la APK terminada.
exports.getAppBrandingBuild = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const request = await validBuildRequest(String(req.query.requestId || ''), String(req.query.token || ''));
  if (!request) return res.status(404).json({ error: 'Solicitud invalida o vencida' });
  return res.json({
    app: request.app,
    build: request.build,
    versionName: request.versionName,
    name: request.name,
    iconUrl: request.iconUrl,
    uploadUrl: request.uploadUrl,
  });
});

// Se llama solo despues de que GitHub subio la APK a la URL firmada. Verifica
// que el objeto exista antes de publicar el build que obliga a actualizar.
exports.completeAppBrandingBuild = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  const requestId = String(req.body?.requestId || '');
  const request = await validBuildRequest(requestId, String(req.body?.token || ''));
  if (!request) return res.status(404).json({ error: 'Solicitud invalida o vencida' });
  const app = BRANDING_APPS[request.app];
  const [exists] = await admin.storage().bucket(BRANDING_BUCKET).file(request.apkPath).exists();
  if (!exists) return res.status(409).json({ error: 'La APK aun no fue subida' });
  const buildRef = admin.database().ref(`config/${app.buildField}`);
  const publication = await buildRef.transaction((current) => {
    const decision = buildPublicationDecision(current, request.build);
    return decision.ok ? decision.value : undefined;
  });
  if (!publication.committed) {
    const currentBuild = Number((await buildRef.once('value')).val() || 0);
    await admin.database().ref(`appBuildRequests/${requestId}`).update({
      status: 'superseded',
      supersededAt: Date.now(),
      currentBuild,
    });
    return res.status(409).json({ error: `Ya existe un build superior (${currentBuild}).` });
  }
  await admin.database().ref(`appBuildRequests/${requestId}`).update({ status: 'published', publishedAt: Date.now() });
  return res.json({ build: request.build });
});

// El propietario designado recupera su rol mediante Firebase Auth. Los roles
// se guardan como custom claims y no requieren Realtime Database.
exports.initializeDashboardAdmin = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const user = await requireDashboardAdmin(req);
    const isOwner = user.email?.toLowerCase() === OWNER_DASHBOARD_EMAIL;
    if (isOwner && user.dashboardAdmin !== true) {
      await admin.auth().setCustomUserClaims(user.uid, { dashboardAdmin: true, dashboardUser: true });
    }
    const isAdmin = isOwner || user.dashboardAdmin === true;
    if (!isAdmin) throw new Error('No tienes permiso para administrar usuarios');
    return res.json({ ok: true, isAdmin });
  } catch (error) {
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Invitaciones QR para pasajeros autorizados por un hotel. Solo el
// administrador puede crearlas o revocarlas; el token en claro se devuelve
// una sola vez para que el dashboard lo convierta en QR.
exports.managePassengerInvites = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const action = String(req.body?.action || '').trim();
    const invitesRef = admin.database().ref('passengerInvites');

    if (action === 'list') {
      const snapshot = await invitesRef.once('value');
      const invites = Object.entries(snapshot.val() || {})
        .map(([hash, invite]) => ({
          id: hash,
          hotelId: invite.hotelId || '',
          hotelName: invite.hotelName || '',
          hotelAddress: invite.hotelAddress || '',
          createdAt: Number(invite.createdAt || 0),
          expiresAt: Number(invite.expiresAt || 0),
          maxUses: Number(invite.maxUses || 1),
          uses: Number(invite.uses || 0),
          status: invite.status || 'active',
          createdBy: invite.createdBy || '',
          lastUsedAt: Number(invite.lastUsedAt || 0),
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ invites });
    }

    if (action === 'create') {
      const hotelId = String(req.body?.hotelId || '').trim();
      const place = await getDashboardPlace('hotels', hotelId);
      if (!place) return res.status(400).json({ error: 'Selecciona un hotel válido.' });
      const requestedDuration = Number(req.body?.durationHours ?? 24);
      const requestedMaxUses = Number(req.body?.maxUses ?? 1);
      if (!Number.isFinite(requestedDuration) || !Number.isFinite(requestedMaxUses)) {
        return res.status(400).json({ error: 'Duración o cantidad de usos inválida.' });
      }
      const durationHours = Math.trunc(Math.min(720, Math.max(1, requestedDuration)));
      const maxUses = Math.trunc(Math.min(100, Math.max(1, requestedMaxUses)));
      const token = crypto.randomBytes(16).toString('hex');
      const hash = requestTokenHash(token);
      const now = Date.now();
      const invite = {
        type: 'hotel',
        hotelId: place.id,
        hotelName: place.name,
        hotelAddress: place.address,
        hotelLat: place.lat,
        hotelLng: place.lng,
        createdAt: now,
        expiresAt: now + durationHours * 60 * 60 * 1000,
        maxUses,
        uses: 0,
        status: 'active',
        createdBy: manager.uid,
      };
      await invitesRef.child(hash).set(invite);
      return res.status(201).json({
        invite: {
          id: hash,
          token,
          qrValue: `apl-passenger://access?token=${encodeURIComponent(token)}`,
          hotelId: place.id,
          hotelName: place.name,
          hotelAddress: place.address,
          createdAt: now,
          expiresAt: invite.expiresAt,
          maxUses,
        },
      });
    }

    if (action === 'revoke') {
      const inviteId = String(req.body?.inviteId || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(inviteId)) return res.status(400).json({ error: 'Invitación inválida.' });
      const inviteRef = invitesRef.child(inviteId);
      const invite = (await inviteRef.once('value')).val();
      if (!invite) return res.status(404).json({ error: 'La invitación no existe.' });
      const revokedAt = Date.now();
      await inviteRef.update({ status: 'revoked', revokedAt, revokedBy: manager.uid });

      const redeemedUserIds = Object.keys(invite.usedBy || {});
      const revocations = await Promise.all(redeemedUserIds.map(async (uid) => {
        const result = await admin.database().ref(`passengerAccess/${uid}`).transaction((current) => (
          revokePassengerAccess(current, inviteId, manager.uid, revokedAt)
        ));
        return result.committed ? uid : null;
      }));
      const revokedAccesses = revocations.filter(Boolean).length;
      await recordAuditEvent(manager, 'PASSENGER_INVITE_REVOKED', 'passengerInvite', inviteId, {
        revokedAccesses,
      });
      return res.json({ ok: true, revokedAccesses });
    }

    return res.status(400).json({ error: 'Acción inválida.' });
  } catch (error) {
    console.error('managePassengerInvites', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Canjea un QR desde la app de pasajeros. La transacción hace que un QR de
// un solo uso no pueda ser reclamado simultáneamente por dos dispositivos.
exports.redeemPassengerInvite = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const user = await requireAuthenticatedUser(req);
    const token = parsePassengerInviteToken(req.body?.code || req.body?.token);
    if (!token) return res.status(400).json({ error: 'Código QR inválido.' });
    const inviteHash = requestTokenHash(token);
    const inviteRef = admin.database().ref(`passengerInvites/${inviteHash}`);
    const result = await inviteRef.transaction((current) => {
      if (!current || current.status === 'revoked' || Number(current.expiresAt || 0) <= Date.now()) return current;
      const usedBy = current.usedBy && typeof current.usedBy === 'object' ? current.usedBy : {};
      if (usedBy[user.uid]) return current;
      const uses = Number(current.uses || 0);
      const maxUses = Math.max(1, Number(current.maxUses || 1));
      if (uses >= maxUses) return current;
      return {
        ...current,
        uses: uses + 1,
        lastUsedAt: Date.now(),
        status: uses + 1 >= maxUses ? 'used' : 'active',
        usedBy: { ...usedBy, [user.uid]: Date.now() },
      };
    });
    const invite = result.snapshot.val();
    if (!result.committed || !invite?.usedBy?.[user.uid]) {
      return res.status(409).json({ error: 'El código QR está vencido, revocado o ya fue utilizado.' });
    }
    const access = passengerAccessPayload({ ...invite, inviteHash }, 'invite');
    await admin.database().ref(`passengerAccess/${user.uid}`).set(access);
    return res.json({ ok: true, access });
  } catch (error) {
    console.error('redeemPassengerInvite', error);
    return res.status(403).json({ error: error.message || 'No se pudo activar el acceso' });
  }
});

// Conserva las cuentas de pasajeros ya existentes al activar el control QR.
// Solo un perfil creado antes del corte puede usar esta migración automática.
exports.ensurePassengerAccess = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const user = await requireAuthenticatedUser(req);
    const accessRef = admin.database().ref(`passengerAccess/${user.uid}`);
    const access = await syncRevokedPassengerAccess(
      user.uid,
      (await accessRef.once('value')).val(),
    );
    if (passengerAccessIsActive(access)) return res.json({ ok: true, access });
    const passenger = (await admin.database().ref(`passengers/${user.uid}`).once('value')).val();
    if (!passenger || !canMigrateLegacyPassengerAccess(
      access,
      passenger.registeredAt,
      LEGACY_PASSENGER_ACCESS_CUTOFF_MS,
    )) {
      return res.status(403).json({ error: 'Activa primero el acceso con el código QR del hotel.' });
    }
    const legacyAccess = passengerAccessPayload({
      hotelId: passenger.hotelId || '',
      hotelName: passenger.hotelName || 'Acceso anterior',
      hotelAddress: passenger.hotelAddress || '',
      hotelLat: Number(passenger.hotelLat),
      hotelLng: Number(passenger.hotelLng),
      grantedAt: Number(passenger.registeredAt),
    }, 'legacy');
    await accessRef.set(legacyAccess);
    return res.json({ ok: true, access: legacyAccess });
  } catch (error) {
    console.error('ensurePassengerAccess', error);
    return res.status(403).json({ error: error.message || 'No se pudo validar el acceso' });
  }
});

// La escritura del perfil queda del lado del servidor después de validar la
// autorización. Así una cuenta anónima no puede autoconcederse acceso.
exports.registerPassengerProfile = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const user = await requireAuthenticatedUser(req);
    const access = (await admin.database().ref(`passengerAccess/${user.uid}`).once('value')).val();
    if (!passengerAccessIsActive(access)) return res.status(403).json({ error: 'Activa primero el acceso con el código QR del hotel.' });
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const phone = String(req.body?.phone || '').trim().slice(0, 40);
    const credentialPhotoUrl = String(req.body?.credentialPhotoUrl || '').trim();
    if (!name || !phone || !credentialPhotoUrl) return res.status(400).json({ error: 'Nombre, teléfono y credencial son obligatorios.' });
    if (!isOwnedPassengerCredentialUrl(credentialPhotoUrl, user.uid)) {
      return res.status(400).json({ error: 'La credencial debe pertenecer a la cuenta autenticada.' });
    }
    const passengerRef = admin.database().ref(`passengers/${user.uid}`);
    const current = (await passengerRef.once('value')).val() || {};
    await passengerRef.set({
      name,
      phone,
      credentialPhotoUrl,
      registeredAt: Number(current.registeredAt || Date.now()),
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('registerPassengerProfile', error);
    return res.status(403).json({ error: error.message || 'No se pudo registrar el pasajero' });
  }
});

// Vincula una cuenta anónima existente con una cuenta recuperable de Firebase
// Auth. Se conserva el historial y el acceso del hotel; no se sobrescribe un
// perfil que ya exista en la cuenta de destino.
exports.migratePassengerAccount = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const targetUser = await requireAuthenticatedUser(req);
    const oldToken = String(req.body?.oldIdToken || '').trim();
    if (!oldToken) return res.json({ ok: true, migrated: false });
    const oldUser = await admin.auth().verifyIdToken(oldToken);
    if (!oldUser.uid || oldUser.uid === targetUser.uid) return res.json({ ok: true, migrated: false });

    const db = admin.database();
    const [oldPassengerSnap, oldAccessSnap, targetPassengerSnap] = await Promise.all([
      db.ref(`passengers/${oldUser.uid}`).once('value'),
      db.ref(`passengerAccess/${oldUser.uid}`).once('value'),
      db.ref(`passengers/${targetUser.uid}`).once('value'),
    ]);
    const oldPassenger = oldPassengerSnap.val();
    const oldAccess = oldAccessSnap.val();
    if (!oldPassenger && !oldAccess) return res.json({ ok: true, migrated: false });
    if (targetPassengerSnap.exists()) return res.status(409).json({ error: 'La cuenta de destino ya tiene otro perfil de pasajero.' });

    const updates = {};
    if (oldPassenger) updates[`passengers/${targetUser.uid}`] = oldPassenger;
    if (oldAccess) updates[`passengerAccess/${targetUser.uid}`] = oldAccess;
    const tripsSnap = await db.ref('trips').orderByChild('passengerId').equalTo(oldUser.uid).once('value');
    Object.keys(tripsSnap.val() || {}).forEach((tripId) => {
      updates[`trips/${tripId}/passengerId`] = targetUser.uid;
    });
    if (Object.keys(updates).length) await db.ref().update(updates);
    await db.ref(`passengers/${oldUser.uid}`).remove();
    await db.ref(`passengerAccess/${oldUser.uid}`).remove();
    await admin.auth().deleteUser(oldUser.uid).catch((error) => {
      if (error?.code !== 'auth/user-not-found') throw error;
    });
    return res.json({ ok: true, migrated: true, tripCount: Object.keys(tripsSnap.val() || {}).length });
  } catch (error) {
    console.error('migratePassengerAccount', error);
    return res.status(403).json({ error: error.message || 'No se pudo recuperar la cuenta' });
  }
});

exports.manageDashboardUsers = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const action = req.body?.action;
    if (action === 'list') {
      const users = [];
      let pageToken;
      do {
        const page = await admin.auth().listUsers(1000, pageToken);
        page.users.forEach((user) => {
          if (user.customClaims?.dashboardUser || user.customClaims?.dashboardAdmin || user.uid === manager.uid) {
            const role = user.customClaims?.dashboardAdmin
              ? 'admin'
              : user.customClaims?.dashboardRole === 'COORDINATOR'
                ? 'coordinator'
                : 'supervisor';
            users.push({
              uid: user.uid,
              name: user.displayName || '',
              email: user.email || '',
              disabled: user.disabled,
              role,
              sedeId: user.customClaims?.sedeId || '',
              sedeType: user.customClaims?.sedeType || '',
              sedeName: user.customClaims?.sedeName || '',
              isCurrent: user.uid === manager.uid,
              createdAt: user.metadata.creationTime || '',
            });
          }
        });
        pageToken = page.pageToken;
      } while (pageToken);
      return res.json({ users });
    }
    if (action === 'create') {
      const email = String(req.body?.email || '').trim();
      const name = String(req.body?.name || '').trim();
      const password = String(req.body?.password || '');
      if (!email || password.length < 6) return res.status(400).json({ error: 'Correo y contraseña de al menos 6 caracteres son requeridos' });
      const role = String(req.body?.role || 'supervisor').trim().toLowerCase();
      const claims = await dashboardClaimsForRole(role, req.body?.sedeType, req.body?.sedeId);
      const user = await admin.auth().createUser({ email, password, displayName: name });
      try {
        await admin.auth().setCustomUserClaims(user.uid, claims);
      } catch (error) {
        await admin.auth().deleteUser(user.uid).catch(() => null);
        throw error;
      }
      return res.status(201).json({ uid: user.uid, role, sedeId: claims.sedeId || null, sedeType: claims.sedeType || null });
    }
    if (action === 'grantAdmin') {
      const email = String(req.body?.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Correo requerido' });
      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().setCustomUserClaims(user.uid, { dashboardUser: true, dashboardAdmin: true });
      return res.json({ ok: true });
    }
    if (action === 'update') {
      const uid = String(req.body?.uid || '');
      const changes = {};
      if (req.body?.email) changes.email = String(req.body.email).trim();
      if (req.body?.password) {
        if (String(req.body.password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        changes.password = String(req.body.password);
      }
      if (typeof req.body?.disabled === 'boolean') changes.disabled = req.body.disabled;
      if (!uid || (Object.keys(changes).length === 0 && !req.body?.role)) return res.status(400).json({ error: 'No hay cambios para guardar' });
      if (Object.keys(changes).length) await admin.auth().updateUser(uid, changes);
      if (req.body?.role && uid !== manager.uid) {
        const claims = await dashboardClaimsForRole(req.body.role, req.body?.sedeType, req.body?.sedeId);
        await admin.auth().setCustomUserClaims(uid, claims);
      }
      return res.json({ ok: true });
    }
    if (action === 'delete') {
      const uid = String(req.body?.uid || '');
      if (!uid || uid === manager.uid) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
      await admin.auth().deleteUser(uid);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Accion invalida' });
  } catch (error) {
    console.error('manageDashboardUsers', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

exports.createPassengerTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });

  let lockRef = null;
  let lockToken = '';
  try {
    const passenger = await requireAuthenticatedUser(req);
    const requestId = String(req.body?.requestId || '').trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(requestId)) {
      return res.status(400).json({ error: 'Identificador de solicitud inválido.' });
    }

    const tripId = `${passenger.uid}_${requestId}`;
    const tripRef = admin.database().ref(`trips/${tripId}`);
    const existing = (await tripRef.once('value')).val();
    if (existing) {
      if (existing.passengerId !== passenger.uid || existing.clientRequestId !== requestId) {
        return res.status(409).json({ error: 'La solicitud entra en conflicto con otro viaje.' });
      }
      return res.json({ ok: true, tripId, trip: existing, idempotent: true });
    }

    const db = admin.database();
    const [profileSnapshot, accessSnapshot] = await Promise.all([
      db.ref(`passengers/${passenger.uid}`).once('value'),
      db.ref(`passengerAccess/${passenger.uid}`).once('value'),
    ]);
    const profile = profileSnapshot.val();
    const access = await syncRevokedPassengerAccess(
      passenger.uid,
      accessSnapshot.val(),
    );
    const registeredAt = Number(profile?.registeredAt || 0);
    const legacyAccess = canMigrateLegacyPassengerAccess(
      access,
      registeredAt,
      LEGACY_PASSENGER_ACCESS_CUTOFF_MS,
    );
    if (!profile || (!passengerAccessIsActive(access) && !legacyAccess)) {
      return res.status(403).json({ error: 'Tu acceso de pasajero no está vigente.' });
    }

    const pickup = tripPoint(req.body?.pickupLat, req.body?.pickupLng);
    const destination = tripPoint(req.body?.destinationLat, req.body?.destinationLng);
    const pickupAddress = String(req.body?.pickupAddress || '').trim().slice(0, 300);
    const destinationAddress = String(req.body?.destinationAddress || '').trim().slice(0, 300);
    const passengerCount = Number(req.body?.passengerCount);
    if (!pickup || !destination || !pickupAddress || !destinationAddress) {
      return res.status(400).json({ error: 'Selecciona un origen y destino válidos.' });
    }
    if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 45) {
      return res.status(400).json({ error: 'El número de pasajeros debe estar entre 1 y 45.' });
    }

    const now = Date.now();
    const requestedSchedule = req.body?.scheduledPickupAt;
    const scheduledPickupAt = requestedSchedule == null ? null : Number(requestedSchedule);
    if (scheduledPickupAt != null && (
      !Number.isFinite(scheduledPickupAt)
      || scheduledPickupAt < now + PASSENGER_SCHEDULE_MIN_LEAD_MS
      || scheduledPickupAt > now + PASSENGER_SCHEDULE_MAX_LEAD_MS
    )) {
      return res.status(400).json({ error: 'Programa el viaje entre 15 minutos y 30 días desde ahora.' });
    }

    // Serializa pedidos simultáneos de una misma cuenta. El viaje usa además
    // un ID determinista, por lo que repetir la misma solicitud nunca duplica.
    lockToken = crypto.randomBytes(16).toString('hex');
    lockRef = db.ref(`passengerTripLocks/${passenger.uid}`);
    const lock = await lockRef.transaction((current) => {
      if (current && Number(current.expiresAt || 0) > now) return;
      return { token: lockToken, expiresAt: now + 15000 };
    });
    if (!lock.committed || lock.snapshot.val()?.token !== lockToken) {
      return res.status(409).json({
        code: 'REQUEST_IN_PROGRESS',
        error: 'Ya se está procesando otra solicitud. Intenta nuevamente en unos segundos.',
      });
    }

    const passengerTrips = (await db.ref('trips')
      .orderByChild('passengerId').equalTo(passenger.uid).once('value')).val() || {};
    const conflict = passengerTripConflict(passengerTrips, scheduledPickupAt, now);
    if (conflict) {
      const messages = {
        ACTIVE_TRIP_EXISTS: 'Ya tienes un viaje activo.',
        SCHEDULED_TRIP_EXISTS: 'Ya tienes un viaje programado.',
        SCHEDULED_TRIP_TOO_CLOSE: 'Tu viaje programado está demasiado cerca para pedir otro ahora.',
      };
      return res.status(409).json({
        code: conflict.code,
        existingTripId: conflict.tripId,
        error: messages[conflict.code],
      });
    }

    const scheduledPickupLabel = scheduledPickupAt == null
      ? null
      : new Intl.DateTimeFormat('es-PE', {
        timeZone: LIMA_TIME_ZONE,
        day: '2-digit',
        month: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(scheduledPickupAt));
    const scheduledPickupSpeech = scheduledPickupAt == null
      ? null
      : formatScheduledPickupSpeech(scheduledPickupAt);
    const trip = {
      passengerId: passenger.uid,
      passengerName: String(profile.name || 'Pasajero').trim().slice(0, 120),
      passengerPhone: String(profile.phone || '').trim().slice(0, 40),
      ...(profile.photoUrl ? { passengerPhotoUrl: String(profile.photoUrl) } : {}),
      passengerCount,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      destinationAddress,
      ...(scheduledPickupAt == null ? {} : { scheduledPickupAt, scheduledPickupLabel }),
      ...(scheduledPickupSpeech ? { scheduledPickupSpeech } : {}),
      status: scheduledPickupAt == null ? 'searching' : 'scheduled',
      requestedAt: now,
      rejectedDriverIds: {},
      clientRequestId: requestId,
    };
    const created = await tripRef.transaction((current) => current || trip);
    const saved = created.snapshot.val();
    if (!created.committed || saved?.passengerId !== passenger.uid || saved?.clientRequestId !== requestId) {
      throw new Error('No se pudo confirmar la creación del viaje.');
    }
    return res.status(201).json({ ok: true, tripId, trip: saved, idempotent: false });
  } catch (error) {
    console.error('createPassengerTrip', error);
    return res.status(400).json({ error: error.message || 'No se pudo crear el viaje.' });
  } finally {
    if (lockRef && lockToken) {
      await lockRef.transaction((current) => current?.token === lockToken ? null : current).catch(() => null);
    }
  }
});

// Reintento explícito para un viaje que no encontró conductor. Mantenerlo en
// una función autenticada evita que el cliente tenga que reconstruir el viaje
// (y evita perder el motivo visible mientras el despacho vuelve a intentarlo).
exports.retryPassengerTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const passenger = await requireAuthenticatedUser(req);
    const tripId = String(req.body?.tripId || '').trim();
    if (!isValidFirebaseKey(tripId)) return res.status(400).json({ error: 'Viaje invalido.' });
    const accessToken = await functionsAccessToken();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: trip } = await readDatabaseWithEtag(`trips/${tripId}`, accessToken);
      if (!trip || trip.passengerId !== passenger.uid) {
        return res.status(404).json({ error: 'Viaje no encontrado.' });
      }
      if (trip.status !== 'no_drivers_available') {
        return res.status(409).json({
          error: trip.status === 'searching'
            ? 'Este viaje ya está buscando conductor.'
            : 'Este viaje ya no se puede reintentar.',
          status: trip.status,
        });
      }
      const now = Date.now();
      const next = {
        ...trip,
        status: 'searching',
        requestedAt: now,
        noDriversReason: null,
        noDriversReasonCode: null,
        noDriversCheckedAt: null,
        retryAvailable: null,
        retryCount: Number(trip.retryCount || 0) + 1,
        lastRetryAt: now,
      };
      const response = await putDatabaseIfUnchanged(`trips/${tripId}`, next, etag, accessToken);
      if (response.ok) {
        // El trigger de estado realiza la asignación de forma asíncrona. La
        // respuesta deja al cliente en una pantalla de búsqueda determinista.
        return res.json({
          ok: true,
          tripId,
          status: 'searching',
          message: 'Estamos buscando un conductor nuevamente.',
          trip: next,
        });
      }
      if (response.status !== 412) throw new Error(`No se pudo reintentar el viaje (${response.status}).`);
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
    return res.status(409).json({ error: 'El viaje cambió mientras se reintentaba. Actualiza e intenta nuevamente.' });
  } catch (error) {
    console.error('retryPassengerTrip', error);
    return res.status(/No autorizado/.test(String(error.message || '')) ? 403 : 400)
      .json({ error: error.message || 'No se pudo reintentar el viaje.' });
  }
});

// Los coordinadores crean solicitudes desde su sede asignada. El servidor
// rellena siempre el origen y el usuario solicitante para que el cliente no
// pueda cambiar de sede ni hacerse pasar por otra cuenta.
exports.createCoordinatorTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const coordinator = await requireDashboardCoordinator(req);
    const destinationAddress = String(req.body?.destinationAddress || '').trim();
    const destinationLat = Number(req.body?.destinationLat);
    const destinationLng = Number(req.body?.destinationLng);
    if (!destinationAddress || destinationAddress.length > 300) {
      return res.status(400).json({ error: 'Selecciona un destino válido.' });
    }
    if (!Number.isFinite(destinationLat) || destinationLat < -90 || destinationLat > 90 || !Number.isFinite(destinationLng) || destinationLng < -180 || destinationLng > 180) {
      return res.status(400).json({ error: 'El destino no tiene coordenadas válidas.' });
    }

    const now = Date.now();
    const passengerName = String(req.body?.passengerName || '').trim().slice(0, 120);
    const passengerPhone = String(req.body?.passengerPhone || '').trim().slice(0, 40);
    const passengerCount = Number(req.body?.passengerCount ?? 1);
    if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 45) {
      return res.status(400).json({ error: 'El número de pasajeros debe estar entre 1 y 45.' });
    }
    const tripRef = admin.database().ref('trips').push();
    const trip = {
      passengerId: coordinator.uid,
      passengerName: passengerName || 'Pasajero de sede',
      passengerPhone,
      passengerCount,
      pickupLat: coordinator.coordinatorPlace.lat,
      pickupLng: coordinator.coordinatorPlace.lng,
      pickupAddress: coordinator.coordinatorPlace.address,
      destinationLat,
      destinationLng,
      destinationAddress,
      status: 'searching',
      requestedAt: now,
      rejectedDriverIds: {},
      dispatcherUid: coordinator.uid,
      dispatcherSedeId: coordinator.coordinatorPlace.id,
      dispatcherSedeType: coordinator.coordinatorPlace.type,
      dispatcherSedeName: coordinator.coordinatorPlace.name,
      createdByRole: 'COORDINATOR',
    };
    await tripRef.set(trip);
    return res.status(201).json({ ok: true, tripId: tripRef.key, trip });
  } catch (error) {
    console.error('createCoordinatorTrip', error);
    return res.status(403).json({ error: error.message || 'No se pudo crear el viaje' });
  }
});

// Devuelve el estado actual del conductor asignado sin exponer la flota al
// coordinador. Solo acepta viajes creados por la propia sede.
exports.getCoordinatorTripDetail = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const coordinator = await requireDashboardCoordinator(req);
    const tripId = String(req.query.tripId || '').trim();
    if (!tripId) return res.status(400).json({ error: 'Viaje requerido' });
    const snapshot = await admin.database().ref(`trips/${tripId}`).once('value');
    const trip = snapshot.val();
    if (!trip || trip.dispatcherUid !== coordinator.uid) return res.status(404).json({ error: 'Viaje no encontrado' });
    let driverLocation = null;
    if (trip.driverId) {
      const driver = (await admin.database().ref(`drivers/${trip.driverId}`).once('value')).val() || {};
      if (Number.isFinite(Number(driver.lat)) && Number.isFinite(Number(driver.lng))) {
        driverLocation = { lat: Number(driver.lat), lng: Number(driver.lng), lastUpdate: Number(driver.lastUpdate || 0) };
      }
    }
    return res.json({ trip, driverLocation });
  } catch (error) {
    console.error('getCoordinatorTripDetail', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Un coordinador puede cancelar antes de que el conductor inicie el viaje.
// La liberación del conductor queda a cargo del trigger de estado existente.
exports.cancelCoordinatorTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const coordinator = await requireDashboardCoordinator(req);
    const tripId = String(req.body?.tripId || '').trim();
    if (!isValidFirebaseKey(tripId)) return res.status(400).json({ error: 'Viaje requerido' });

    // Una lectura seguida de update() permitía que la cancelación pisara una
    // transición concurrente a in_progress. ETag + if-match vuelve atómica la
    // comprobación del estado y conserva cualquier asignación recién creada.
    const accessToken = await functionsAccessToken();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: trip } = await readDatabaseWithEtag(`trips/${tripId}`, accessToken);
      const decision = prepareCoordinatorCancellation(trip, coordinator.uid, Date.now());
      if (!decision.ok) return res.status(decision.httpStatus).json({ error: decision.error });

      const response = await putDatabaseIfUnchanged(
        `trips/${tripId}`,
        decision.value,
        etag,
        accessToken,
      );
      if (response.ok) return res.json({
        ok: true,
        tripId,
        status: 'cancelled',
        cancelledAt: decision.value.cancelledAt,
        message: 'Viaje cancelado. Se notificó al pasajero y al conductor.',
        trip: decision.value,
      });
      if (response.status !== 412) {
        throw new Error(`No se pudo cancelar el viaje (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
    return res.status(409).json({ error: 'El viaje cambió mientras se cancelaba. Intenta nuevamente.' });
  } catch (error) {
    console.error('cancelCoordinatorTrip', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

exports.cancelDashboardTrip = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const tripId = String(req.body?.tripId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!isValidFirebaseKey(tripId)) return res.status(400).json({ error: 'Viaje requerido' });

    const accessToken = await functionsAccessToken();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { etag, value: trip } = await readDatabaseWithEtag(`trips/${tripId}`, accessToken);
      const decision = prepareDashboardCancellation(trip, manager.email, reason, Date.now());
      if (!decision.ok) return res.status(decision.httpStatus).json({ error: decision.error });
      const response = await putDatabaseIfUnchanged(
        `trips/${tripId}`,
        decision.value,
        etag,
        accessToken,
      );
      if (response.ok) {
        await recordAuditEvent(manager, 'TRIP_CANCELLED', 'trip', tripId, { reason });
        return res.json({
          ok: true,
          tripId,
          status: 'cancelled',
          cancelledAt: decision.value.cancelledAt,
          message: 'Viaje cancelado. Se notificó al pasajero y al conductor.',
          trip: decision.value,
        });
      }
      if (response.status !== 412) {
        throw new Error(`No se pudo cancelar el viaje (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
    return res.status(409).json({ error: 'El viaje cambió mientras se cancelaba. Actualiza e intenta nuevamente.' });
  } catch (error) {
    console.error('cancelDashboardTrip', error);
    return res.status(403).json({ error: error.message || 'No autorizado' });
  }
});

// Espejo privado para que la interfaz coordinadora use la sincronización en
// tiempo real de RTDB sin concederle lectura de todos los viajes.
exports.syncCoordinatorTrip = functions.database
  .ref('/trips/{tripId}')
  .onWrite(async (change, context) => {
    const before = change.before.val() || {};
    const after = change.after.val();
    const tripId = context.params.tripId;
    const writes = [];
    if (before.dispatcherUid && (!after || after.dispatcherUid !== before.dispatcherUid)) {
      writes.push(admin.database().ref(`coordinatorTrips/${before.dispatcherUid}/${tripId}`).remove());
    }
    if (after?.dispatcherUid) {
      writes.push(admin.database().ref(`coordinatorTrips/${after.dispatcherUid}/${tripId}`).set(after));
    }
    await Promise.all(writes);
    return null;
  });

// Se dispara al crear /trips/{tripId} (el pasajero acaba de pedir un
// viaje con status: 'searching'). Busca y reclama al conductor disponible
// mas cercano.
exports.assignDriverOnTripCreate = functions.database
  .ref('/trips/{tripId}')
  .onCreate(async (snapshot, context) => {
    const trip = snapshot.val();
    if (!trip || trip.status !== 'searching') return null;
    return attemptAssignment(
      context.params.tripId,
      trip.pickupLat,
      trip.pickupLng,
      trip.rejectedDriverIds || {},
      trip.scheduledPickupLabel,
      trip.passengerCount,
      trip.scheduledPickupSpeech
    );
  });

// Regla fija y simple (sin llamar a ninguna API de rutas desde Cloud
// Functions): despachar cada viaje programado 10 minutos antes de la hora
// elegida por el pasajero.
const SCHEDULED_TRIP_DISPATCH_BEFORE_MS = 10 * 60 * 1000;

// Corre cada minuto (Cloud Scheduler): revisa los viajes en 'scheduled'
// (creados por el pasajero con una hora de recogida futura, ver
// RequestRideScreen/TripService.requestRide en passenger-app) y despacha
// (busca y reclama conductor, igual que un viaje normal) los que ya
// entraron a la ventana de 10 minutos antes de su hora programada.
exports.dispatchScheduledTrips = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async () => {
    const db = admin.database();
    const snap = await db.ref('trips').orderByChild('status').equalTo('scheduled').once('value');
    if (!snap.exists()) return null;

    const now = Date.now();
    const entries = [];
    snap.forEach((child) => {
      entries.push([child.key, child.val()]);
    });

    for (const [tripId, trip] of entries) {
      // Dato invalido/viejo o ya dentro de la ventana de 10 min: despachar.
      const scheduledAt = trip.scheduledPickupAt;
      const dispatch = !scheduledAt || scheduledAt - now <= SCHEDULED_TRIP_DISPATCH_BEFORE_MS;
      if (dispatch) {
        const passengerTrips = (await db.ref('trips')
          .orderByChild('passengerId').equalTo(trip.passengerId).once('value')).val() || {};
        delete passengerTrips[tripId];
        // Una reserva no se convierte en un segundo viaje activo si el
        // pasajero todavía está realizando otro. Se reevalúa al minuto.
        if (passengerTripConflict(passengerTrips, scheduledAt, now)?.code === 'ACTIVE_TRIP_EXISTS') {
          continue;
        }
        await attemptAssignment(
          tripId,
          trip.pickupLat,
          trip.pickupLng,
          trip.rejectedDriverIds || {},
          trip.scheduledPickupLabel,
          trip.passengerCount,
          trip.scheduledPickupSpeech
        );
      }
    }

    return null;
  });

// Repara asignaciones que quedaron persistidas por una carrera o por una
// ejecucion interrumpida entre reclamar al conductor y confirmar el viaje.
// Solo libera viajes cerrados del mismo conductor o reclamos huerfanos que
// superaron la ventana de seguridad.
exports.reconcileClosedTripAssignments = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async () => {
    const db = admin.database();
    const [driversSnap, tripsSnap] = await Promise.all([
      db.ref('drivers').once('value'),
      db.ref('trips').once('value'),
    ]);
    const drivers = driversSnap.val() || {};
    const trips = tripsSnap.val() || {};
    const repairs = [];
    const now = Date.now();

    for (const [driverId, driver] of Object.entries(drivers)) {
      const tripId = driver?.currentTripId;
      const trip = tripId ? trips[tripId] : null;
      if (shouldReleaseAssignment(driverId, driver, trip, now)) {
        repairs.push(releaseDriver(driverId, tripId));
      }
    }

    await Promise.all(repairs);
    return null;
  });

// Reacciona solo a las transiciones que necesitan coordinacion en el
// servidor:
//  - 'no_drivers_available' -> 'searching' (el pasajero reintento manualmente)
//                -> vuelve a intentar la asignacion.
//  - 'completed' / 'cancelled' -> libera al conductor.
// La asignacion es automatica y el conductor no puede rechazar ni cancelar
// un viaje ya asignado, asi que 'accepted' / 'arrived_at_pickup' /
// 'in_progress' los escribe directo la app del conductor sin que el
// servidor tenga que hacer nada mas.
exports.handleTripStatusChange = functions.database
  .ref('/trips/{tripId}/status')
  // Archiva datos, ruta y snapshot del mapa al cerrar cada viaje.
  .onUpdate(async (change, context) => {
    const tripId = context.params.tripId;
    const before = change.before.val();
    const after = change.after.val();
    const db = admin.database();

    if (after === 'searching' && before === 'no_drivers_available') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      return attemptAssignment(
        tripId,
        trip.pickupLat,
        trip.pickupLng,
        trip.rejectedDriverIds || {},
        trip.scheduledPickupLabel,
        trip.passengerCount,
        trip.scheduledPickupSpeech
      );
    }

    if (after === 'no_drivers_available' && before !== 'no_drivers_available') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (!trip?.passengerId) return null;
      const passenger = (await db.ref(`passengers/${trip.passengerId}`).once('value')).val() || {};
      await sendPush(passenger.fcmToken, 'no_drivers_available', {
        tripId,
        status: 'no_drivers_available',
        reason: trip.noDriversReason || 'No encontramos un conductor disponible.',
        reasonCode: trip.noDriversReasonCode || 'NO_DRIVER_NEARBY',
        retryAvailable: 'true',
        route: 'active-trip',
        deepLink: `passenger://trip/${tripId}`,
      });
      return null;
    }

    if (after === 'completed' || after === 'cancelled') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (!trip) return null;
      if (trip.driverId) await releaseDriver(trip.driverId, tripId);
      if (after === 'cancelled') {
        const reason = trip.cancelReason || 'El viaje fue cancelado.';
        if (trip.driverId) {
          const driverSnap = await db.ref(`drivers/${trip.driverId}`).once('value');
          const driver = driverSnap.val() || {};
          await sendPush(driver.fcmToken, 'trip_cancelled', {
            tripId,
            status: 'cancelled',
            reason,
            cancelReason: reason,
            cancelledBy: trip.cancelledBy || 'system',
            route: 'active-trip',
            deepLink: `driver://trip/${tripId}`,
          });
        }
        if (trip.passengerId && trip.cancelledBy !== 'passenger') {
          const passengerSnap = await db.ref(`passengers/${trip.passengerId}`).once('value');
          const passenger = passengerSnap.val() || {};
          await sendPush(passenger.fcmToken, 'trip_cancelled', {
            tripId,
            status: 'cancelled',
            reason,
            cancelReason: reason,
            cancelledBy: trip.cancelledBy || 'system',
            route: 'active-trip',
            deepLink: `passenger://trip/${tripId}`,
          });
        }
      } else if (after === 'completed' && trip.passengerId) {
        const passenger = (await db.ref(`passengers/${trip.passengerId}`).once('value')).val() || {};
        await sendPush(passenger.fcmToken, 'trip_completed', {
          tripId,
          status: 'completed',
          ratingRequired: 'true',
          route: 'rate-trip',
          deepLink: `passenger://trip/${tripId}/rate`,
        });
      }
      const historyTrip = await buildTripHistoryRecord(trip);
      const historyWrites = {
        [`tripHistory/${tripId}`]: historyTrip,
      };
      if (trip.driverId) {
        historyWrites[`driverTripHistory/${trip.driverId}/${tripId}`] = historyTrip;
      }
      await db.ref().update(historyWrites);
      return null;
    }

    if (after === 'arrived_at_pickup') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (!trip) return null;
      const passengerSnap = await db.ref(`passengers/${trip.passengerId}`).once('value');
      const passenger = passengerSnap.val() || {};
      await sendPush(passenger.fcmToken, 'driver_arrived', {
        tripId,
        status: 'arrived_at_pickup',
        route: 'active-trip',
        deepLink: `passenger://trip/${tripId}`,
      });
      return null;
    }

    return null;
  });

// Registra conexiones, desconexiones y alertas para el historial del
// dashboard. `busy` tambien representa una conexion activa, por eso no se
// genera un evento adicional cuando el conductor recibe un viaje.
exports.recordDriverConnection = functions.database
  .ref('/drivers/{driverId}/status')
  .onWrite(async (change, context) => {
    const before = change.before.val();
    const after = change.after.val();
    const wasConnected = before === 'online' || before === 'busy';
    const isConnected = after === 'online' || after === 'busy';
    if (wasConnected === isConnected) return null;

    const driverId = context.params.driverId;
    const driverSnap = await admin.database().ref(`drivers/${driverId}`).once('value');
    const driver = driverSnap.val() || {};
    const at = Number(driver.ultima_conexion || Date.now());
    const status = isConnected ? 'online' : 'offline';
    await admin.database().ref(`driverConnectionHistory/${driverId}`).push({
      status,
      driverName: driver.name || '',
      driverPlate: driver.plate || '',
      reason: status === 'offline' ? driverDisconnectReason(driver) : null,
      at,
    });

    if (!isConnected) {
      await createPrematureDisconnectAlert(
        driverId,
        driver,
        driverDisconnectReason(driver),
        at
      );
    }
    return null;
  });

// Revisa los heartbeats GPS. La app envia `lastUpdate` cada 5 segundos, pero
// el worker solo se ejecuta una vez por minuto para mantener bajo el consumo
// de recursos. Si no hay señal durante 30 segundos, cierra el turno como una
// perdida de heartbeat y emite la misma alerta que una desconexion manual.
exports.detectPrematureDriverDisconnects = functions.pubsub
  .schedule('every 1 minutes')
  .timeZone(LIMA_TIME_ZONE)
  .onRun(async () => {
    const db = admin.database();
    const snapshot = await db.ref('drivers').once('value');
    const accessToken = await functionsAccessToken();
    const now = Date.now();
    const tasks = [];

    snapshot.forEach((child) => {
      const driverId = child.key;
      const driver = child.val() || {};
      const connected = driver.status === 'online' || driver.status === 'busy';
      const lastHeartbeat = effectiveDriverHeartbeat(driver);
      if (!connected || !hasHeartbeatExpired(lastHeartbeat, now)) return;
      if (Number(driver.ultimo_alerta_desconexion_at || 0) >= lastHeartbeat) return;

      tasks.push((async () => {
        const { etag, value: currentValue } = await readDatabaseWithEtag(`drivers/${driverId}`, accessToken);
        const current = currentValue || null;
        const decision = buildHeartbeatDisconnectUpdate(current, lastHeartbeat, now);
        if (!decision) return;

        const response = await putDatabaseIfUnchanged(
          `drivers/${driverId}`,
          decision.value,
          etag,
          accessToken,
        );
        if (response.status === 412) return;
        if (!response.ok) throw new Error(`No se pudo cerrar el heartbeat de ${driverId} (${response.status}).`);
        await createPrematureDisconnectAlert(
          driverId,
          current,
          'HEARTBEAT',
          decision.disconnectedAt,
        );
      })());
    });

    await Promise.all(tasks);
    return null;
  });

// Avisa al conductor si el pasajero modifica el destino de un viaje ya
// asignado (ver TripService.updateDestination en passenger-app). Escucha
// solo `destinationAddress` (no todo el trip) para no dispararse con otros
// campos que cambian seguido (posicion del conductor no vive en /trips).
// onUpdate no se dispara en la creacion del trip (ahi no hay "antes"), asi
// que esto solo reacciona a ediciones posteriores.
exports.notifyTripUpdated = functions.database
  .ref('/trips/{tripId}/destinationAddress')
  .onUpdate(async (change, context) => {
    const tripId = context.params.tripId;
    const tripSnap = await admin.database().ref(`trips/${tripId}`).once('value');
    const trip = tripSnap.val();
    if (!trip || !trip.driverId) return null;
    if (trip.status === 'completed' || trip.status === 'cancelled') return null;

    const driverSnap = await admin.database().ref(`drivers/${trip.driverId}`).once('value');
    const driver = driverSnap.val() || {};
    await sendPush(driver.fcmToken, 'trip_updated', {
      tripId,
      destinationAddress: trip.destinationAddress || '',
      route: 'active-trip',
      deepLink: `driver://trip/${tripId}`,
    });
    return null;
  });

// Avisa al conductor cuando el dashboard aprueba o rechaza su registro
// (ver approveDriver/rejectDriver en dashboard/js/drivers-admin.js).
exports.notifyApprovalStatusChange = functions.database
  .ref('/drivers/{driverId}/approvalStatus')
  .onUpdate(async (change, context) => {
    const after = change.after.val();
    if (after !== 'approved' && after !== 'rejected') return null;

    const driverId = context.params.driverId;
    const driverSnap = await admin.database().ref(`drivers/${driverId}`).once('value');
    const driver = driverSnap.val() || {};
    if (after === 'rejected') {
      // Defensa adicional para rechazos antiguos o escrituras directas: un
      // rechazado no puede conservar estado operativo ni dejar un viaje
      // asignado apuntando a su cuenta.
      if (driver.currentTripId) {
        const tripRef = admin.database().ref(`trips/${driver.currentTripId}`);
        const trip = (await tripRef.once('value')).val();
        if (trip && !['completed', 'cancelled'].includes(trip.status)) {
          await tripRef.update({
            status: 'cancelled',
            cancelledBy: 'dashboard',
            cancelReason: 'El conductor fue rechazado por el dashboard.',
            cancelledAt: Date.now(),
          });
        }
      }
      await admin.database().ref(`drivers/${driverId}`).update({
        status: null,
        estado_conexion: 'OFFLINE',
        ultima_conexion: Date.now(),
        ultimo_motivo_desconexion: 'ADMIN',
        currentTripId: null,
      });
    }
    await sendPush(driver.fcmToken, 'approval_status', {
      status: after,
      rejectionReason: after === 'rejected' ? driver.rejectionReason || '' : '',
      rejectionFieldKeys: after === 'rejected' ? driver.rejectionFieldKeys || '' : '',
      reviewedAt: driver.reviewedAt ? String(driver.reviewedAt) : '',
      route: after === 'approved' ? 'home' : 'profile',
      deepLink: after === 'approved' ? 'driver://home' : 'driver://profile',
    });
    return null;
  });

// Historial de viajes de un pasajero (pestaña "Actividad" y "Recientes" en
// passenger-app). Las reglas de RTDB solo autorizan lectura POR REGISTRO
// (`/trips/{tripId}`), no a nivel del nodo `/trips` completo -- eso es a
// proposito, para que ningun pasajero pueda leer los viajes de otro. Pero
// eso tambien significa que un query tipo orderBy/equalTo directo desde el
// cliente contra `/trips.json` siempre da "permission denied", porque en
// RTDB las reglas se evaluan en el nodo consultado, no por cada hijo que
// matchea. La unica forma de listar "mis viajes" es que el Admin SDK
// (que ignora las reglas) haga el query aca, verificando primero que el
// idToken sea valido y usando su propio uid -- nunca uno que mande el
// cliente.
exports.submitTripFeedback = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const passenger = await requireAuthenticatedUser(req);
    const tripId = String(req.body?.tripId || '').trim();
    if (!tripId || tripId.length > 160 || /[.#$\[\]]/.test(tripId)) {
      return res.status(400).json({ error: 'Viaje invalido.' });
    }
    const feedbackPath = `tripFeedback/${tripId}`;
    const [tripSnapshot, accessToken] = await Promise.all([
      admin.database().ref(`trips/${tripId}`).once('value'),
      functionsAccessToken(),
    ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await readDatabaseWithEtag(feedbackPath, accessToken);
      const feedback = buildTripFeedback(
        req.body,
        tripSnapshot.val(),
        passenger.uid,
        Date.now(),
        existing.value,
      );
      const writeResponse = await putDatabaseIfUnchanged(
        feedbackPath,
        feedback,
        existing.etag,
        accessToken,
      );
      if (writeResponse.ok) return res.json({ ok: true, feedback });
      if (writeResponse.status !== 412) {
        throw new Error(`No se pudo guardar el comentario (${writeResponse.status}).`);
      }
    }
    return res.status(409).json({
      error: 'La incidencia cambio mientras la editabas. Revisa los datos e intenta nuevamente.',
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'No se pudo guardar tu comentario.' });
  }
});

exports.manageTripFeedback = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  try {
    const manager = await requireDashboardManager(req);
    const tripId = String(req.body?.tripId || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!tripId || tripId.length > 160 || /[.#$\[\]]/.test(tripId)
      || !['resolve', 'reopen'].includes(action)) {
      return res.status(400).json({ error: 'Solicitud invalida.' });
    }
    const now = Date.now();
    const feedbackPath = `tripFeedback/${tripId}`;
    const accessToken = await functionsAccessToken();
    const existing = await readDatabaseWithEtag(feedbackPath, accessToken);
    if (!existing.value || existing.value.incidentCategory === 'none') {
      return res.status(404).json({ error: 'Incidencia no encontrada.' });
    }
    let feedback;
    if (action === 'resolve') {
      feedback = {
        ...existing.value,
        incidentStatus: 'RESOLVED',
        resolvedAt: now,
        resolvedBy: manager.uid,
        updatedAt: now,
      };
    } else {
      feedback = { ...existing.value, incidentStatus: 'OPEN', updatedAt: now };
      delete feedback.resolvedAt;
      delete feedback.resolvedBy;
    }
    const writeResponse = await putDatabaseIfUnchanged(
      feedbackPath,
      feedback,
      existing.etag,
      accessToken,
    );
    if (writeResponse.status === 412) {
      return res.status(409).json({
        error: 'La incidencia cambio mientras la actualizabas. Recarga e intenta nuevamente.',
      });
    }
    if (!writeResponse.ok) {
      throw new Error(`No se pudo actualizar la incidencia (${writeResponse.status}).`);
    }
    await recordAuditEvent(
      manager,
      action === 'resolve' ? 'TRIP_INCIDENT_RESOLVED' : 'TRIP_INCIDENT_REOPENED',
      'trip',
      tripId,
    );
    return res.json({ ok: true, feedback });
  } catch (error) {
    const forbidden = /No autorizado|permiso/.test(String(error.message || ''));
    return res.status(forbidden ? 403 : 500).json({
      error: error.message || 'No se pudo actualizar la incidencia.',
    });
  }
});

exports.getMyTrips = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo no permitido' });

  try {
    const passenger = await requireAuthenticatedUser(req);
    const all = req.query.all === 'true';
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const db = admin.database();
    const [tripSnapshot, feedbackSnapshot] = await Promise.all([
      db.ref('trips').orderByChild('passengerId').equalTo(passenger.uid).once('value'),
      db.ref('tripFeedback').orderByChild('passengerId').equalTo(passenger.uid).once('value'),
    ]);
    const trips = tripSnapshot.val() || {};
    const feedbackByTrip = feedbackSnapshot.val() || {};
    const filtered = {};
    for (const [id, trip] of Object.entries(trips)) {
      if (all || (trip.requestedAt || 0) >= cutoff) {
        filtered[id] = { ...trip, feedback: feedbackByTrip[id] || null };
      }
    }
    return res.status(200).json(filtered);
  } catch (error) {
    return res.status(401).json({ error: error.message || 'Token invalido' });
  }
});
