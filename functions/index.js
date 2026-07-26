const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();

const { attemptAssignment, releaseDriver } = require('./matching');
const { sendPush } = require('./notifications');

const BRANDING_BUCKET = 'rastreoflota-53052.firebasestorage.app';
const BRANDING_SIGNING_PATH = 'build_signing/android-debug.keystore';
const BRANDING_APPS = {
  driver: { directory: 'driver-app', buildField: 'driverAppBuild', apkPath: 'app_releases/driver-app.apk', defaultName: 'App de conductores' },
  passenger: { directory: 'passenger-app', buildField: 'passengerAppBuild', apkPath: 'app_releases/passenger-app.apk', defaultName: 'App de pasajeros' },
};
const BRANDING_BUILD_TTL_MS = 3 * 60 * 60 * 1000;
const OWNER_DASHBOARD_EMAIL = 'anfurex.3351@gmail.com';

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

function requestTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

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
            users.push({ uid: user.uid, email: user.email || '', disabled: user.disabled, role: user.customClaims?.dashboardAdmin ? 'admin' : 'supervisor', isCurrent: user.uid === manager.uid });
          }
        });
        pageToken = page.pageToken;
      } while (pageToken);
      return res.json({ users });
    }
    if (action === 'create') {
      const email = String(req.body?.email || '').trim();
      const password = String(req.body?.password || '');
      if (!email || password.length < 6) return res.status(400).json({ error: 'Correo y contraseña de al menos 6 caracteres son requeridos' });
      const user = await admin.auth().createUser({ email, password });
      const role = req.body?.role === 'admin' ? 'admin' : 'supervisor';
      await admin.auth().setCustomUserClaims(user.uid, { dashboardUser: true, dashboardAdmin: role === 'admin' });
      return res.status(201).json({ uid: user.uid });
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
        const isAdmin = req.body.role === 'admin';
        await admin.auth().setCustomUserClaims(uid, { dashboardUser: true, dashboardAdmin: isAdmin });
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
