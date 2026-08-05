const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();

const { attemptAssignment, releaseDriver } = require('./matching');
const { sendPush } = require('./notifications');
const {
  disconnectReasonLabel,
  isAlertableDisconnectReason,
  normalizeDisconnectReason,
} = require('./alert-policy');

const BRANDING_BUCKET = 'rastreoflota-53052.firebasestorage.app';
const BRANDING_SIGNING_PATH = 'build_signing/android-debug.keystore';
const BRANDING_APPS = {
  driver: { directory: 'driver-app', buildField: 'driverAppBuild', apkPath: 'app_releases/driver-app.apk', defaultName: 'APL Conductores' },
  passenger: { directory: 'passenger-app', buildField: 'passengerAppBuild', apkPath: 'app_releases/passenger-app.apk', defaultName: 'APL Pasajeros' },
};
const BRANDING_BUILD_TTL_MS = 3 * 60 * 60 * 1000;
const OWNER_DASHBOARD_EMAIL = 'anfurex.3351@gmail.com';
const DATABASE_URL = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';
const VEHICLE_PASSENGER_RANGES = {
  Auto: [1, 4],
  SUV: [5, 7],
  'Mini van': [8, 17],
  Van: [18, 20],
  'Mini bus': [21, 38],
  Bus: [39, 45],
};
const VEHICLE_COLORS = new Set(['Negro', 'Gris', 'Plata', 'Blanco']);
const LIMA_TIME_ZONE = 'America/Lima';
const DRIVER_HEARTBEAT_TIMEOUT_MS = 30 * 1000;
const DRIVER_ARRIVAL_RADIUS_METERS = 100;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

async function functionsAccessToken() {
  const token = await admin.app().options.credential.getAccessToken();
  return token.access_token;
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function identityKey(value) {
  return crypto.createHash('sha256').update(normalizedIdentity(value)).digest('hex');
}

const DRIVER_UNIQUE_FIELDS = ['email', 'phone', 'plate', 'dni', 'name'];
const DRIVER_REJECTION_FIELDS = new Set([
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

function isValidVehicleData(vehicleType, vehicleColor, vehicleSeats) {
  const range = VEHICLE_PASSENGER_RANGES[vehicleType];
  const seats = Number(vehicleSeats);
  return Boolean(
    range &&
      VEHICLE_COLORS.has(vehicleColor) &&
      Number.isInteger(seats) &&
      seats >= range[0] &&
      seats <= range[1]
  );
}

async function deleteDriverDocuments(driverId) {
  const bucket = admin.storage().bucket(BRANDING_BUCKET);
  const [files] = await bucket.getFiles({ prefix: `driver_documents/${driverId}/` });
  await Promise.all(files.map((file) => file.delete()));
  return files.length;
}

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
    if (!isValidVehicleData(vehicleType, vehicleColor, vehicleSeats)) {
      return res.status(400).json({ error: 'Selecciona un tipo, color y cantidad de pasajeros válidos.' });
    }
    const fields = [
      ['email', email, 'correo'],
      ['phone', phone, 'teléfono'],
      ['plate', plate, 'placa'],
      ['dni', dni, 'DNI'],
      ['name', name, 'nombre completo'],
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
    if (!driver) return res.status(404).json({ error: 'Conductor no encontrado' });
    if (action === 'assignPlace') {
      if (!place?.name || !place?.type) return res.status(400).json({ error: 'Selecciona un hotel o sede.' });
      const assignedPlace = { name: String(place.name), type: String(place.type), assignedAt: Date.now() };
      await driverRef.update({ assignedPlace });
      await sendPush(driver.fcmToken, 'place_assigned', {
        placeName: assignedPlace.name,
        placeType: assignedPlace.type,
      });
      return res.json({ ok: true });
    }
    if (action === 'reject') {
      const reason = String(req.body?.reason || '').trim();
      const rejectionFields = Array.isArray(req.body?.rejectionFields)
        ? [...new Set(req.body.rejectionFields.map((field) => String(field)))]
        : [];
      if (!reason) return res.status(400).json({ error: 'Escribe el motivo del rechazo.' });
      if (!rejectionFields.length || rejectionFields.some((field) => !DRIVER_REJECTION_FIELDS.has(field))) {
        return res.status(400).json({ error: 'Selecciona al menos un documento que deba corregirse.' });
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
      await releaseDriverIdentityReservations(driverId, driver);
      await Promise.all([
        driverRef.remove(),
        admin.database().ref(`driverConnectionHistory/${driverId}`).remove(),
      ]);
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
    const driverRef = admin.database().ref(`drivers/${driverId}`);
    const driverSnap = await driverRef.once('value');
    const driver = driverSnap.val();
    if (!driver) return res.status(404).json({ error: 'Conductor no encontrado.' });

    const now = Date.now();

    if (!online) {
      if (driver.currentTripId) {
        return res.status(409).json({ error: 'No puedes terminar el turno con un viaje activo.' });
      }
      await driverRef.update({
        status: null,
        turno_activo: false,
        estado_conexion: 'OFFLINE',
        ultima_conexion: now,
        ultimo_motivo_desconexion: 'MANUAL',
      });
      return res.json({ ok: true, status: 'offline' });
    }

    if (driver.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'El conductor todavía no está aprobado.' });
    }

    // Si la app se reinicio durante un viaje, solo debe reanudar el GPS y no
    // pisar el estado busy.
    if (driver.currentTripId) {
      await driverRef.update({
        status: 'busy',
        turno_activo: true,
        estado_conexion: 'ONLINE',
        ultima_conexion: now,
        ultimo_motivo_desconexion: null,
      });
      return res.json({ ok: true, status: 'busy' });
    }

    const transaction = await driverRef.transaction((current) => {
      if (!current || current.currentTripId) return current;
      return {
        ...current,
        status: 'online',
        turno_activo: true,
        estado_conexion: 'ONLINE',
        ultima_conexion: now,
        ultimo_motivo_desconexion: null,
      };
    });
    const result = transaction.snapshot.val() || {};
    if (result.currentTripId) {
      return res.json({ ok: true, status: 'busy' });
    }
    if (result.status !== 'online') {
      return res.status(409).json({ error: 'No se pudo iniciar el turno. Intenta nuevamente.' });
    }
    return res.json({
      ok: true,
      status: 'online',
    });
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
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const heading = Number(req.body?.heading ?? 0);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !Number.isFinite(heading) || heading < 0 || heading > 360 ||
        (lat === 0 && lng === 0)) {
      return res.status(400).json({ error: 'Coordenadas GPS invalidas.' });
    }

    const driverRef = admin.database().ref(`drivers/${driverId}`);
    const driver = (await driverRef.once('value')).val();
    if (!driver) return res.status(404).json({ error: 'Conductor no encontrado.' });
    if (driver.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'El conductor todavía no está aprobado.' });
    }
    if (driver.turno_activo !== true && !['online', 'busy'].includes(driver.status)) {
      return res.status(409).json({ error: 'El turno del conductor no está activo.' });
    }

    // La hora la fija el servidor para evitar falsos heartbeats por un reloj
    // incorrecto del teléfono.
    const lastUpdate = Date.now();
    const location = { lat, lng, heading, lastUpdate };
    await admin.database().ref().update({
      [`drivers/${driverId}/lat`]: lat,
      [`drivers/${driverId}/lng`]: lng,
      [`drivers/${driverId}/heading`]: heading,
      [`drivers/${driverId}/lastUpdate`]: lastUpdate,
      [`driverLocations/${driverId}`]: location,
    });
    return res.json({ ok: true, lastUpdate });
  } catch (error) {
    console.error('updateDriverLocation', error);
    return res.status(403).json({ error: error.message || 'No se pudo actualizar la ubicacion.' });
  }
});

// Avanza el viaje exclusivamente desde el backend. La app puede perder su
// proceso y volver a abrirse, pero nunca debe poder finalizar un viaje solo
// porque aun no recupero el GPS. La validacion de cercania se hace con la
// ultima posicion GPS recibida en el servidor y la transaccion protege contra
// dos gestos simultaneos o una pantalla antigua.
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
    const expectedByNext = {
      arrived_at_pickup: 'accepted',
      in_progress: 'arrived_at_pickup',
      completed: 'in_progress',
    };
    const expectedStatus = expectedByNext[newStatus];
    if (!tripId || !expectedStatus) {
      return res.status(400).json({ error: 'Transicion de viaje invalida.' });
    }

    const tripRef = admin.database().ref(`trips/${tripId}`);
    const tripSnapshot = await tripRef.once('value');
    const trip = tripSnapshot.val();
    if (!trip || trip.driverId !== user.uid) {
      return res.status(404).json({ error: 'Viaje no encontrado.' });
    }
    // Si la app perdio la respuesta despues de que Firebase confirmo la
    // escritura, el mismo gesto puede llegar otra vez. La transicion ya
    // aplicada es segura de repetir: no la volvemos a ejecutar, pero
    // tampoco mostramos un error falso al conductor.
    if (trip.status === newStatus) {
      return res.json({ ok: true, status: newStatus, alreadyApplied: true });
    }
    if (trip.status !== expectedStatus) {
      return res.status(409).json({
        error: 'El viaje cambio de estado. Actualiza la pantalla.',
        currentStatus: trip.status || null,
      });
    }

    if (newStatus === 'arrived_at_pickup' || newStatus === 'completed') {
      const driver = (await admin.database().ref(`drivers/${user.uid}`).once('value')).val() || {};
      const lat = Number(driver.lat);
      const lng = Number(driver.lng);
      const targetLat = Number(newStatus === 'completed' ? trip.destinationLat : trip.pickupLat);
      const targetLng = Number(newStatus === 'completed' ? trip.destinationLng : trip.pickupLng);
      if (![lat, lng, targetLat, targetLng].every(Number.isFinite)) {
        return res.status(422).json({ error: 'Aun no recibimos una posicion GPS valida. Espera unos segundos.' });
      }
      const distance = distanceMeters(lat, lng, targetLat, targetLng);
      if (distance > DRIVER_ARRIVAL_RADIUS_METERS) {
        return res.status(422).json({
          error: `Debes estar a menos de ${DRIVER_ARRIVAL_RADIUS_METERS} metros del punto. Distancia actual: ${Math.round(distance)} m.`,
          distanceMeters: Math.round(distance),
        });
      }
    }

    const timestampField = {
      arrived_at_pickup: 'arrivedAt',
      in_progress: 'inProgressAt',
      completed: 'completedAt',
    }[newStatus];
    // Una lectura/poll del viaje puede coincidir con este gesto y hacer que
    // la primera transaccion se aborte aunque nadie haya avanzado el viaje.
    // Reintentamos solo si el estado remoto sigue siendo el esperado; si ya
    // cambio a otro estado, conservamos el conflicto real.
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await tripRef.transaction((current) => {
        // El SDK puede invocar el callback una primera vez con null antes de
        // hidratar el valor remoto. Usamos la lectura validada de arriba como
        // base solo para esa primera llamada; devolver undefined cancela la
        // transaccion y provocaba el falso conflicto al pulsar "he llegado".
        const candidate = current || trip;
        if (!candidate || candidate.driverId !== user.uid || candidate.status !== expectedStatus) {
          return current;
        }
        return {
          ...candidate,
          status: newStatus,
          [timestampField]: Date.now(),
        };
      });
      if (result.committed) return res.json({ ok: true, status: newStatus });

      const latest = (await tripRef.once('value')).val() || {};
      if (latest.driverId === user.uid && latest.status === newStatus) {
        return res.json({ ok: true, status: newStatus, alreadyApplied: true });
      }
      if (latest.driverId !== user.uid || latest.status !== expectedStatus) {
        console.warn('advanceDriverTrip state conflict', {
          tripId,
          newStatus,
          expectedStatus,
          currentStatus: latest.status || null,
          driverId: user.uid,
        });
        return res.status(409).json({
          error: 'El viaje cambio de estado. Actualiza la pantalla.',
          currentStatus: latest.status || null,
        });
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }

    console.warn('advanceDriverTrip transaction retry exhausted', {
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
    });
    if (!getResponse.ok) {
      throw new Error(`No se pudo consultar el perfil (${getResponse.status})`);
    }

    const etag = getResponse.headers.get('ETag');
    const current = await getResponse.json();
    if (!current) return res.status(404).json({ error: 'Perfil de conductor no encontrado.' });
    if (current.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'El conductor todavÃ­a no estÃ¡ aprobado.' });
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
    });
    if (putResponse.status === 412) {
      if (phoneReserved) await releaseUniqueDriverValue('phone', cleanPhone, user.uid);
      return res.status(409).json({ error: 'El perfil cambiÃ³ mientras se guardaba. Intenta nuevamente.' });
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
      await requireDashboardAdmin(req);
      const app = BRANDING_APPS[req.body?.app];
      const appKey = req.body?.app;
      if (!app) return res.status(400).json({ error: 'App invalida' });

      const configSnap = await admin.database().ref('config').once('value');
      const config = configSnap.val() || {};
      const branding = config.appBranding?.[appKey] || {};
      const build = Number(config[app.buildField] || 0) + 1;
      const requestId = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + BRANDING_BUILD_TTL_MS;
      const bucket = admin.storage().bucket(BRANDING_BUCKET);
      const [uploadUrl] = await bucket.file(app.apkPath).getSignedUrl({
        version: 'v4', action: 'write', expires: expiresAt, contentType: 'application/vnd.android.package-archive',
      });
      const [signingUrl] = await bucket.file(BRANDING_SIGNING_PATH).getSignedUrl({
        version: 'v4', action: 'read', expires: expiresAt,
      });

      await admin.database().ref(`appBuildRequests/${requestId}`).set({
        app: appKey,
        build,
        name: branding.name || app.defaultName,
        iconUrl: branding.iconUrl || '',
        apkPath: app.apkPath,
        uploadUrl,
        signingUrl,
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
  return res.json({ app: request.app, build: request.build, name: request.name, iconUrl: request.iconUrl, uploadUrl: request.uploadUrl, signingUrl: request.signingUrl });
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
  await admin.database().ref(`config/${app.buildField}`).set(request.build);
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
    if (!tripId) return res.status(400).json({ error: 'Viaje requerido' });
    const tripRef = admin.database().ref(`trips/${tripId}`);
    const snapshot = await tripRef.once('value');
    const trip = snapshot.val();
    if (!trip || trip.dispatcherUid !== coordinator.uid) return res.status(404).json({ error: 'Viaje no encontrado' });
    if (['in_progress', 'completed', 'cancelled'].includes(trip.status)) {
      return res.status(409).json({ error: 'Este viaje ya inició o terminó y no puede cancelarse.' });
    }
    await tripRef.update({
      status: 'cancelled',
      cancelledBy: 'coordinator',
      cancelReason: 'Cancelado por el coordinador de la sede.',
      cancelledAt: Date.now(),
    });
    return res.json({ ok: true, status: 'cancelled' });
  } catch (error) {
    console.error('cancelCoordinatorTrip', error);
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
      trip.passengerCount
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
        await attemptAssignment(
          tripId,
          trip.pickupLat,
          trip.pickupLng,
          trip.rejectedDriverIds || {},
          trip.scheduledPickupLabel,
          trip.passengerCount
        );
      }
    }

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
        trip.passengerCount
      );
    }

    if (after === 'completed' || after === 'cancelled') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (trip.driverId) await releaseDriver(trip.driverId, tripId);
      if (after === 'cancelled' && trip.passengerId && trip.cancelledBy !== 'passenger') {
        const passengerSnap = await db.ref(`passengers/${trip.passengerId}`).once('value');
        const passenger = passengerSnap.val() || {};
        await sendPush(passenger.fcmToken, 'trip_cancelled', {
          tripId,
          reason: trip.cancelReason || 'El viaje fue cancelado.',
        });
      }
      await db.ref(`tripHistory/${tripId}`).set({ ...trip, archivedAt: Date.now() });
      return null;
    }

    if (after === 'arrived_at_pickup') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (!trip) return null;
      const passengerSnap = await db.ref(`passengers/${trip.passengerId}`).once('value');
      const passenger = passengerSnap.val() || {};
      await sendPush(passenger.fcmToken, 'driver_arrived', { tripId });
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
    const now = Date.now();
    const tasks = [];

    snapshot.forEach((child) => {
      const driverId = child.key;
      const driver = child.val() || {};
      const connected = driver.status === 'online' || driver.status === 'busy';
      const lastHeartbeat = Number(driver.lastUpdate || driver.ultima_conexion || 0);
      if (!connected || !lastHeartbeat || now - lastHeartbeat <= DRIVER_HEARTBEAT_TIMEOUT_MS) return;
      if (Number(driver.ultimo_alerta_desconexion_at || 0) >= lastHeartbeat) return;

      tasks.push((async () => {
        const currentSnap = await db.ref(`drivers/${driverId}`).once('value');
        const current = currentSnap.val() || {};
        const stillConnected = current.status === 'online' || current.status === 'busy';
        const currentHeartbeat = Number(current.lastUpdate || current.ultima_conexion || 0);
        if (!stillConnected || currentHeartbeat !== lastHeartbeat || now - currentHeartbeat <= DRIVER_HEARTBEAT_TIMEOUT_MS) return;

        const disconnectedAt = now;
        await createPrematureDisconnectAlert(driverId, current, 'HEARTBEAT', disconnectedAt);
        await db.ref(`drivers/${driverId}`).update({
          status: null,
          estado_conexion: 'OFFLINE',
          ultima_conexion: disconnectedAt,
          ultimo_motivo_desconexion: 'HEARTBEAT',
        });
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
exports.getMyTrips = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo no permitido' });
    return;
  }

  const idToken = req.query.idToken;
  if (!idToken) {
    res.status(401).json({ error: 'Falta idToken' });
    return;
  }

  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(String(idToken))).uid;
  } catch (e) {
    res.status(401).json({ error: 'Token invalido' });
    return;
  }

  const all = req.query.all === 'true';
  const days = Number(req.query.days) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const snap = await admin.database().ref('trips').orderByChild('passengerId').equalTo(uid).once('value');
  const trips = snap.val() || {};
  const filtered = {};
  for (const [id, trip] of Object.entries(trips)) {
    if (all || (trip.requestedAt || 0) >= cutoff) filtered[id] = trip;
  }
  res.status(200).json(filtered);
});
