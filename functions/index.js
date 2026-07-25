const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();

const { attemptAssignment, releaseDriver } = require('./matching');
const { sendPush } = require('./notifications');

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
      trip.scheduledPickupLabel
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
          trip.scheduledPickupLabel
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
        trip.scheduledPickupLabel
      );
    }

    if (after === 'completed' || after === 'cancelled') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (trip.driverId) await releaseDriver(trip.driverId, tripId);
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
    await sendPush(driver.fcmToken, 'trip_updated', { tripId });
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
    await sendPush(driver.fcmToken, 'approval_status', {
      status: after,
      rejectionReason: after === 'rejected' ? driver.rejectionReason || '' : '',
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
