const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();

const { attemptAssignment, releaseDriver } = require('./matching');

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
      trip.rejectedDriverIds || {}
    );
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
      return attemptAssignment(tripId, trip.pickupLat, trip.pickupLng, trip.rejectedDriverIds || {});
    }

    if (after === 'completed' || after === 'cancelled') {
      const tripSnap = await db.ref(`trips/${tripId}`).once('value');
      const trip = tripSnap.val();
      if (trip.driverId) await releaseDriver(trip.driverId, tripId);
      return null;
    }

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
