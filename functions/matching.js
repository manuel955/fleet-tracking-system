const admin = require('firebase-admin');

// Misma ventana de "conductor todavia activo" que usa el dashboard
// (dashboard/js/app.js -> OFFLINE_AFTER_MS): si no reporto GPS en los
// ultimos 3 minutos, no lo considero candidato aunque diga status=online.
const STALE_LOCATION_MS = 3 * 60 * 1000;

const DB_URL = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function accessToken() {
  const token = await admin.app().options.credential.getAccessToken();
  return token.access_token;
}

// Reclama al conductor de forma atomica usando el mecanismo de concurrencia
// optimista de la API REST de Firebase (ETag + header "if-match"), en vez
// de `ref.transaction()` del SDK -- ese metodo resulto no ser confiable
// dentro de Cloud Functions (el callback siempre recibia `current = null`
// y abortaba, incluso "calentando" la referencia primero). Con ETag: si
// otra asignacion ya modifico al conductor entre el GET y el PUT, Firebase
// responde 412 y sabemos que perdimos la carrera, sin arriesgar una doble
// asignacion.
async function claimDriver(driverId, tripId) {
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const getRes = await fetch(`${DB_URL}/drivers/${driverId}.json`, {
    headers: { ...headers, 'X-Firebase-ETag': 'true' },
  });
  const etag = getRes.headers.get('ETag');
  const current = await getRes.json();
  if (!current || current.status !== 'online') return false;

  const updated = { ...current, status: 'busy', currentTripId: tripId };
  const putRes = await fetch(`${DB_URL}/drivers/${driverId}.json`, {
    method: 'PUT',
    headers: { ...headers, 'if-match': etag, 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  return putRes.status === 200;
}

// Aviso push al conductor asignado. Mensaje solo-datos (sin bloque
// `notification`) a proposito: asi el handler de background de la app
// corre siempre y reproduce la alerta completa (canal con sonido/vibracion
// + voz TTS), en vez de que Android muestre una notificacion generica.
// Best-effort: si falla (token vencido, sin Play Services), la asignacion
// ya quedo escrita y el polling de la app la detecta igual.
async function notifyAssignedDriver(driverId, fcmToken, tripId) {
  if (!fcmToken) return;
  try {
    await admin.messaging().send({
      token: fcmToken,
      data: { type: 'trip_assigned', tripId },
      android: { priority: 'high' },
    });
  } catch (e) {
    console.error(`FCM al conductor ${driverId} fallo: ${e.message || e}`);
  }
}

// Busca al conductor disponible mas cercano y lo reclama de forma atomica
// antes de asignarlo al viaje. Si dos viajes intentan reclamar al mismo
// conductor casi al mismo tiempo, solo uno gana el "if-match"; el otro
// simplemente sigue probando con el siguiente candidato mas cercano.
async function attemptAssignment(tripId, pickupLat, pickupLng, excludeMap) {
  const db = admin.database();
  const snap = await db
    .ref('drivers')
    .orderByChild('status')
    .equalTo('online')
    .once('value');

  const candidates = [];
  snap.forEach((child) => {
    const id = child.key;
    if (excludeMap && excludeMap[id]) return;
    const d = child.val();
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    if (!d.lastUpdate || Date.now() - d.lastUpdate > STALE_LOCATION_MS) return;
    candidates.push({
      id,
      driver: d,
      dist: haversineKm(pickupLat, pickupLng, d.lat, d.lng),
    });
  });
  candidates.sort((a, b) => a.dist - b.dist);

  for (const c of candidates) {
    const claimed = await claimDriver(c.id, tripId);
    if (claimed) {
      // Asignacion automatica: no hay paso de aceptar/rechazar por parte
      // del conductor, el viaje queda "accepted" de una vez.
      const now = Date.now();
      await db.ref(`trips/${tripId}`).update({
        status: 'accepted',
        driverId: c.id,
        driverName: c.driver.name || '',
        driverPhone: c.driver.phone || '',
        driverPlate: c.driver.plate || '',
        assignedAt: now,
        acceptedAt: now,
      });
      await notifyAssignedDriver(c.id, c.driver.fcmToken, tripId);
      return;
    }
    // Perdi la carrera contra otra asignacion; sigo con el siguiente candidato.
  }

  await db.ref(`trips/${tripId}`).update({ status: 'no_drivers_available' });
}

// Libera al conductor (vuelve a 'online') solo si sigue ligado a este
// tripId -- evita pisar a un conductor que ya fue reclamado por otro viaje.
// Usa el mismo patron de ETag por la misma razon que claimDriver().
async function releaseDriver(driverId, tripId) {
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const getRes = await fetch(`${DB_URL}/drivers/${driverId}.json`, {
    headers: { ...headers, 'X-Firebase-ETag': 'true' },
  });
  const etag = getRes.headers.get('ETag');
  const current = await getRes.json();
  if (!current || current.currentTripId !== tripId) return;

  const updated = { ...current, status: 'online', currentTripId: null };
  await fetch(`${DB_URL}/drivers/${driverId}.json`, {
    method: 'PUT',
    headers: { ...headers, 'if-match': etag, 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
}

module.exports = { haversineKm, attemptAssignment, releaseDriver };
