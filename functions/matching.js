const admin = require('firebase-admin');
const { sendPush } = require('./notifications');

// Misma ventana de "conductor todavia activo" que usa el dashboard
// (dashboard/js/app.js -> OFFLINE_AFTER_MS): si no reporto GPS en los
// ultimos 3 minutos, no lo considero candidato aunque diga status=online.
const STALE_LOCATION_MS = 3 * 60 * 1000;
const SEARCH_RADII_KM = [2, 4];

const DB_URL = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';
const DB_REQUEST_TIMEOUT_MS = 10000;
const VEHICLE_CATEGORIES = [
  { type: 'Auto', maxSeats: 4 },
  { type: 'SUV', maxSeats: 7 },
  { type: 'Mini van', maxSeats: 17 },
  { type: 'Van', maxSeats: 20 },
  { type: 'Mini bus', maxSeats: 38 },
  { type: 'Bus', maxSeats: 45 },
];

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

async function readWithEtag(path, token) {
  const response = await fetch(`${DB_URL}/${path}.json`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Firebase-ETag': 'true' },
    signal: AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`No se pudo leer ${path} (${response.status}).`);
  const etag = response.headers.get('ETag');
  if (!etag) throw new Error(`Firebase no devolvio ETag para ${path}.`);
  return { etag, value: await response.json() };
}

async function putIfUnchanged(path, value, etag, token) {
  return fetch(`${DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'if-match': etag,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
  });
}

async function updateTripWhileDispatchableWithToken(tripId, buildUpdate, token) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { etag, value: current } = await readWithEtag(`trips/${tripId}`, token);
    if (!current || !['searching', 'scheduled'].includes(current.status)) return false;
    const response = await putIfUnchanged(
      `trips/${tripId}`,
      { ...current, ...buildUpdate(current) },
      etag,
      token,
    );
    if (response.ok) return true;
    if (response.status !== 412) {
      throw new Error(`No se pudo actualizar el viaje ${tripId} (${response.status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
  }
  throw new Error(`El viaje ${tripId} cambio varias veces durante la asignacion.`);
}

async function updateTripWhileDispatchable(tripId, buildUpdate) {
  return updateTripWhileDispatchableWithToken(tripId, buildUpdate, await accessToken());
}

// Reclama al conductor de forma atomica usando el mecanismo de concurrencia
// optimista de la API REST de Firebase (ETag + header "if-match"), en vez
// de `ref.transaction()` del SDK -- ese metodo resulto no ser confiable
// dentro de Cloud Functions (el callback siempre recibia `current = null`
// y abortaba, incluso "calentando" la referencia primero). Con ETag: si
// otra asignacion ya modifico al conductor entre el GET y el PUT, Firebase
// responde 412 y sabemos que perdimos la carrera, sin arriesgar una doble
// asignacion.
async function claimDriverWithToken(driverId, tripId, token, now = Date.now()) {
  const { etag, value: current } = await readWithEtag(`drivers/${driverId}`, token);
  if (
    !current ||
    current.status !== 'online' ||
    current.approvalStatus !== 'approved'
  ) {
    return false;
  }

  const updated = {
    ...current,
    status: 'busy',
    currentTripId: tripId,
    assignmentClaimedAt: now,
  };
  const putRes = await putIfUnchanged(`drivers/${driverId}`, updated, etag, token);
  if (putRes.status === 200) return true;
  if (putRes.status === 412) return false;
  throw new Error(`No se pudo reclamar el conductor ${driverId} (${putRes.status}).`);
}

async function claimDriver(driverId, tripId) {
  return claimDriverWithToken(driverId, tripId, await accessToken());
}

function categoryIndexForDriver(driver) {
  const typeIndex = VEHICLE_CATEGORIES.findIndex(
    (category) => category.type === driver.vehicleType,
  );
  if (typeIndex >= 0) return typeIndex;

  const seats = Number(driver.vehicleSeats);
  return VEHICLE_CATEGORIES.findIndex((category) => seats <= category.maxSeats);
}

function sortByDistance(a, b) {
  return a.dist - b.dist;
}

function rankCandidates(candidates, requestedPassengers) {
  const minimumCategory = VEHICLE_CATEGORIES.findIndex(
    (category) => requestedPassengers <= category.maxSeats,
  );
  if (minimumCategory < 0) return [];

  // La prioridad es la categoria minima que cubre la cantidad solicitada.
  // La distancia solo desempata dentro de esa categoria: un Auto mas lejano
  // debe ganar a un SUV cercano cuando se pidio un viaje de 1 a 4 pasajeros.
  return candidates
    .filter((candidate) => candidate.categoryIndex >= minimumCategory)
    .sort(
      (a, b) =>
        a.categoryIndex - b.categoryIndex || sortByDistance(a, b),
    );
}

function selectCandidate(candidates, requestedPassengers) {
  return rankCandidates(candidates, requestedPassengers)[0] || null;
}

function rankedCandidatesByRadius(candidates, requestedPassengers) {
  return SEARCH_RADII_KM.map((radiusKm) =>
    rankCandidates(
      candidates.filter((candidate) => candidate.dist <= radiusKm),
      requestedPassengers,
    ),
  );
}

function buildNoDriversReason(requestedPassengers, stats) {
  if (
    !Number.isInteger(requestedPassengers) ||
    requestedPassengers < 1 ||
    requestedPassengers > 45
  ) {
    return 'La cantidad de pasajeros solicitada no es válida. Elige entre 1 y 45 pasajeros.';
  }
  if (stats.onlineApproved === 0) {
    return 'No hay conductores aprobados disponibles en este momento.';
  }
  if (stats.freshLocation === 0) {
    return 'Hay conductores aprobados, pero ninguno está enviando su ubicación actualizada.';
  }
  if (stats.capacity === 0) {
    return `Hay conductores disponibles, pero ninguno tiene capacidad para ${requestedPassengers} pasajeros.`;
  }
  return `No encontramos un vehículo disponible cerca para ${requestedPassengers} pasajeros. Puedes reintentar en unos segundos.`;
}

// Busca al conductor disponible mas cercano y lo reclama de forma atomica
// antes de asignarlo al viaje. Si dos viajes intentan reclamar al mismo
// conductor casi al mismo tiempo, solo uno gana el "if-match"; el otro
// simplemente sigue probando con el siguiente candidato mas cercano.
async function attemptAssignment(
  tripId,
  pickupLat,
  pickupLng,
  excludeMap,
  scheduledPickupLabel,
  passengerCount = 1,
) {
  const db = admin.database();
  const requestedPassengers = Number(passengerCount);
  const stats = { onlineApproved: 0, freshLocation: 0, capacity: 0 };
  if (!Number.isInteger(requestedPassengers) || requestedPassengers < 1 || requestedPassengers > 45) {
    await updateTripWhileDispatchable(tripId, () => ({
      status: 'no_drivers_available',
      noDriversReason: buildNoDriversReason(requestedPassengers, stats),
    }));
    return;
  }
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
    if (d.approvalStatus !== 'approved') return;
    stats.onlineApproved += 1;
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    if (!d.lastUpdate || Date.now() - d.lastUpdate > STALE_LOCATION_MS) return;
    stats.freshLocation += 1;
    const seats = Number(d.vehicleSeats);
    if (!Number.isInteger(seats) || seats < requestedPassengers) return;
    stats.capacity += 1;
    const categoryIndex = categoryIndexForDriver(d);
    if (categoryIndex < 0) return;
    candidates.push({
      id,
      driver: d,
      dist: haversineKm(pickupLat, pickupLng, d.lat, d.lng),
      categoryIndex,
    });
  });

  for (const rankedCandidates of rankedCandidatesByRadius(
    candidates,
    requestedPassengers,
  )) {
    for (const c of rankedCandidates) {
      const claimed = await claimDriver(c.id, tripId);
      if (claimed) {
        // El conductor se reclama primero, pero la asignacion del viaje tambien
        // es condicional. Si el pasajero cancelo o otro worker gano la carrera,
        // liberamos este conductor en vez de revivir/sobrescribir el viaje.
        let assigned = false;
        try {
          const now = Date.now();
          assigned = await updateTripWhileDispatchable(tripId, () => ({
            status: 'accepted',
            driverId: c.id,
            driverName: c.driver.name || '',
            driverPhone: c.driver.phone || '',
            driverPlate: c.driver.plate || '',
            driverPhotoUrl: c.driver.profilePhotoUrl || '',
            vehicleBrand: c.driver.vehicleBrand || '',
            vehicleType: c.driver.vehicleType || '',
            vehicleColor: c.driver.vehicleColor || '',
            vehicleSeats: c.driver.vehicleSeats || 0,
            passengerCount: requestedPassengers,
            noDriversReason: null,
            assignedAt: now,
            acceptedAt: now,
          }));
        } catch (error) {
          await releaseDriver(c.id, tripId);
          throw error;
        }
        if (!assigned) {
          await releaseDriver(c.id, tripId);
          return;
        }
        // Aviso push al conductor asignado (best-effort: si falla, la
        // asignacion ya quedo escrita y el polling de la app la detecta igual).
        // Si el viaje era programado, se manda la hora para que la app la
        // diga en la notificacion/voz en vez del generico "nuevo servicio".
        await sendPush(
          c.driver.fcmToken,
          'trip_assigned',
          scheduledPickupLabel ? { tripId, scheduledPickupLabel } : { tripId }
        );
        return;
      }
      // Perdi la carrera contra otra asignacion; sigo con el siguiente
      // candidato elegible respetando el orden de prioridad.
    }
  }

  await updateTripWhileDispatchable(tripId, () => ({
    status: 'no_drivers_available',
    noDriversReason: buildNoDriversReason(requestedPassengers, stats),
  }));
}

// Libera al conductor (vuelve a 'online') solo si sigue ligado a este
// tripId -- evita pisar a un conductor que ya fue reclamado por otro viaje.
// Usa el mismo patron de ETag por la misma razon que claimDriver().
async function releaseDriverWithToken(driverId, tripId, token) {
  // El GPS y el cambio de estado actualizan el mismo nodo del conductor.
  // Si una de esas escrituras ocurre entre el GET y el PUT, Firebase responde
  // 412 (ETag vencido). Reintentamos con el estado mas reciente para no dejar
  // un currentTripId colgado despues de cancelar o completar un viaje.
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { etag, value: current } = await readWithEtag(`drivers/${driverId}`, token);
    // Si otro viaje ya tomo el vehiculo, no debemos liberarlo ni pisar esa
    // nueva asignacion.
    if (!current || current.currentTripId !== tripId) return false;

    const updated = {
      ...current,
      status: current.turno_activo === false ? null : 'online',
      currentTripId: null,
      assignmentClaimedAt: null,
    };
    const putRes = await putIfUnchanged(`drivers/${driverId}`, updated, etag, token);
    if (putRes.status === 200) return true;
    if (putRes.status !== 412) {
      throw new Error(`No se pudo liberar el conductor (${putRes.status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }

  throw new Error(`La liberacion del conductor ${driverId} perdio varias carreras de escritura.`);
}

async function releaseDriver(driverId, tripId) {
  return releaseDriverWithToken(driverId, tripId, await accessToken());
}

module.exports = {
  SEARCH_RADII_KM,
  haversineKm,
  attemptAssignment,
  claimDriverWithToken,
  releaseDriver,
  releaseDriverWithToken,
  categoryIndexForDriver,
  buildNoDriversReason,
  rankCandidates,
  rankedCandidatesByRadius,
  selectCandidate,
  updateTripWhileDispatchableWithToken,
};
