// ---------------------------------------------------------------------------
// Panel de control de flota: Mapbox + Firebase RTDB.
// Los listeners, filtros y estados de negocio permanecen en este archivo;
// MapboxMapAdapter solo implementa la capa visual y las APIs cartograficas.
// ---------------------------------------------------------------------------

const STALE_AFTER_MS = 45 * 1000;   // GPS "atrasado" (visual mas tenue) despues de 45s
                                     // (la app manda cada 5s, esto da margen a ~9 envios)
const OFFLINE_AFTER_MS = 3 * 60 * 1000; // se retira el marcador del mapa tras 3 min sin GPS
const GPS_RENDER_INTERVAL_MS = 5 * 1000;
const ROUTE_RECALCULATION_INTERVAL_MS = 30 * 1000;
const ROUTE_RECALCULATION_DISTANCE_METERS = 50;
const VPS_API_BASE_URL = String(window.vpsApiBaseUrl || '').replace(/\/$/, '');
let vpsPollTimer = null;
let vpsPublicConfigTimer = null;
let gpsRenderTimer = null;
let vpsDashboardRequest = null;
let vpsDashboardRequestSequence = 0;

const STATE_COLORS = {
  connecting: '#0ea5e9',
  suspended: '#f59e0b',
  available: '#06c167', // verde: libre en la red
  to_pickup: '#ff9500', // naranja: yendo a recoger / esperando en el punto de recogida
  on_trip: '#276ef1',   // azul: pasajero a bordo, rumbo al destino
  offline: '#9ca3af',   // gris: desconectado o sin señal reciente
};

const STATE_LABELS = {
  connecting: 'Conectando GPS',
  suspended: 'Sin se\u00f1al',
  available: 'Disponible',
  to_pickup: 'En ruta de recogida',
  on_trip: 'En viaje',
  offline: 'Desconectado',
};

const TRIP_STATUS_LABELS = {
  scheduled: 'Programado, esperando hora de despacho',
  searching: 'Buscando conductor',
  assigned_pending_accept: 'Asignado',
  accepted: 'Asignado, en camino a recoger',
  arrived_at_pickup: 'Esperando en el punto de recogida',
  in_progress: 'Viaje en curso',
  completed: 'Completado',
  cancelled: 'Cancelado',
  no_drivers_available: 'Sin conductores disponibles',
};

let map;
let markers = {};        // driverId -> Mapbox marker handle
const lastKnownMarkerIds = new Set(); // marcadores temporales de conductores seleccionados sin GPS reciente
let selectionHalo = null; // aro de color detras del auto seleccionado
let driversCache = {};   // driverId -> data
let mapPlacesCache = { hotels: {}, sportVenues: {} };
const carIconCache = new Map();
const haloIconCache = new Map();
let sidebarRenderFrame = null;

let activeTripListeners = {}; // tripId -> callback, solo para conductores 'busy'
let activeTripsCache = {};    // tripId -> trip data (viajes en curso)
let todayTripsCache = {};     // tripId -> trip data (viajes pedidos hoy, para stats)

let expandedDriverId = null;  // conductor con la tarjeta abierta en el sidebar
let activeFilter = 'all';     // filtro de estado activo en el sidebar

let routePolyline = null;
let targetMarker = null; // punto de recogida o destino del tramo que se esta dibujando
let routeReqToken = 0;
let lastRouteEtaSeconds = null;
let lastRouteOrigin = null; // {lat,lng} del conductor usado para la ruta ya dibujada
let lastRouteTarget = null; // {lat,lng} destino de la ruta ya dibujada
let lastRouteRequestedAt = 0;
let routeRequestInFlight = false;

let mapboxReady = false;
let userAuthenticated = false;
let subscribed = false;
window.dashboardIsAdmin = false;
window.dashboardRole = '';
window.dashboardIsCoordinator = false;
const coordinatorAppEl = document.getElementById('coordinator-app');

// ---------------------------------------------------------------------------
// Autenticacion
// ---------------------------------------------------------------------------

const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginSubtitle = document.getElementById('login-subtitle');
const tabLogin = document.getElementById('tab-login');
const submitBtn = document.getElementById('login-submit');
const resetPasswordBtn = document.getElementById('login-reset-password');

function syncDashboardRoleNavigation() {
  document.querySelectorAll('[data-admin-only-nav]').forEach((element) => {
    element.classList.toggle('hidden', window.dashboardRole !== 'ADMIN');
  });
}

const AUTH_ERROR_MESSAGES = {
  'auth/invalid-email': 'Correo inválido.',
  'auth/user-not-found': 'Credenciales inválidas o usuario no existe.',
  'auth/wrong-password': 'Credenciales inválidas o usuario no existe.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión en vez de registrarte.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/invalid-login-credentials': 'Correo o contraseña incorrectos.',
  'auth/user-disabled': 'Esta cuenta está deshabilitada.',
  'auth/unauthorized-domain': 'Este dominio no está autorizado para iniciar sesión.',
  'auth/network-request-failed': 'No se pudo conectar con Firebase. Revisa tu conexión.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  'auth/operation-not-allowed': 'El inicio de sesión por correo está deshabilitado.',
  'auth/password-reset-unavailable': 'La recuperación por correo no está configurada en el VPS.',
};

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.remove('success');
  loginError.textContent = '';
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    loginError.textContent = AUTH_ERROR_MESSAGES[err.code]
      || `No se pudo iniciar sesión. Código: ${err.code || 'desconocido'}.`;
  }
});

resetPasswordBtn.addEventListener('click', async () => {
  loginError.textContent = '';
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    loginError.textContent = 'Escribe primero el correo de tu cuenta.';
    return;
  }
  resetPasswordBtn.disabled = true;
  try {
    await auth.sendPasswordResetEmail(email);
    loginError.classList.add('success');
    loginError.textContent = 'Si el correo está registrado, recibirás un enlace para cambiar la contraseña.';
  } catch (err) {
    loginError.classList.remove('success');
    loginError.textContent = AUTH_ERROR_MESSAGES[err.code]
      || 'No se pudo enviar el correo de recuperación. Intenta nuevamente.';
  } finally {
    resetPasswordBtn.disabled = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

async function initializeDashboardAdmin(user) {
  try {
    const token = await user.getIdToken();
    const response = await fetch('https://us-central1-rastreoflota-53052.cloudfunctions.net/initializeDashboardAdmin', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    window.dashboardIsAdmin = response.ok && result.isAdmin === true;
    if (window.dashboardIsAdmin) await user.getIdToken(true);
    // Si el usuario ya abrio Configuracion, vuelve a pintarla en cuanto el
    // rol llegue para que aparezcan los apartados sin otro inicio de sesion.
    if (typeof renderSettings === 'function') renderSettings();
    if (typeof window.startOperationAlerts === 'function') window.startOperationAlerts();
  } catch (_) {
    // El dashboard sigue funcionando para cuentas existentes; el apartado de
    // usuarios mostrara un mensaje si la cuenta no es administradora.
  }
}

let authFlowId = 0;

auth.onAuthStateChanged(async (user) => {
  const flowId = ++authFlowId;
  if (!user) {
    if (typeof window.stopCoordinatorDispatch === 'function') window.stopCoordinatorDispatch();
    loginScreen.classList.remove('hidden');
    appEl.classList.add('hidden');
    coordinatorAppEl.classList.add('hidden');
    userAuthenticated = false;
    window.dashboardRole = '';
    window.dashboardIsAdmin = false;
    window.dashboardIsCoordinator = false;
    subscribed = false;
    if (vpsPollTimer) clearInterval(vpsPollTimer);
    if (vpsPublicConfigTimer) clearInterval(vpsPublicConfigTimer);
    if (gpsRenderTimer) clearInterval(gpsRenderTimer);
    vpsPollTimer = null;
    vpsPublicConfigTimer = null;
    gpsRenderTimer = null;
    vpsDashboardRequest?.abort();
    vpsDashboardRequest = null;
    if (typeof resetDriversAdminSubscriptions === 'function') resetDriversAdminSubscriptions();
    return;
  }

  loginScreen.classList.add('hidden');
  appEl.classList.add('hidden');
  coordinatorAppEl.classList.add('hidden');
  userAuthenticated = true;

  try {
    let tokenResult = await user.getIdTokenResult();
    let claims = tokenResult.claims || {};
    // El propietario puede recuperar el claim ADMIN una sola vez si se creó
    // antes de que existiera el sistema de roles.
    if (!window.vpsApiBaseUrl && claims.dashboardRole !== 'COORDINATOR') {
      await initializeDashboardAdmin(user);
      if (flowId !== authFlowId || !auth.currentUser) return;
      tokenResult = await user.getIdTokenResult(true);
      claims = tokenResult.claims || {};
    }

    if (claims.dashboardRole === 'COORDINATOR') {
      window.dashboardRole = 'COORDINATOR';
      window.dashboardIsAdmin = false;
      window.dashboardIsCoordinator = true;
      coordinatorAppEl.classList.remove('hidden');
      if (typeof window.startCoordinatorDispatch === 'function') {
        window.startCoordinatorDispatch(user, claims);
      }
      return;
    }

    if (claims.dashboardUser === true || claims.dashboardAdmin === true) {
      window.dashboardRole = claims.dashboardAdmin === true ? 'ADMIN' : (claims.dashboardRole || 'SUPERVISOR');
      window.dashboardIsAdmin = claims.dashboardAdmin === true || claims.dashboardRole === 'ADMIN';
      window.dashboardIsCoordinator = false;
      syncDashboardRoleNavigation();
      appEl.classList.remove('hidden');
      // En modo VPS la inicialización Firebase heredada se omite; arranca
      // igualmente el polling de alertas para que el panel no quede vacío.
      if (typeof window.startOperationAlerts === 'function') window.startOperationAlerts();
      tryStartDashboard();
      return;
    }

    throw new Error('Esta cuenta no tiene un rol de Dashboard asignado.');
  } catch (error) {
    if (flowId !== authFlowId) return;
    loginScreen.classList.remove('hidden');
    appEl.classList.add('hidden');
    coordinatorAppEl.classList.add('hidden');
    userAuthenticated = false;
    loginError.textContent = error.message || 'No tienes acceso a este panel.';
    await auth.signOut();
  }
});

function tryStartDashboard() {
  if (!userAuthenticated) return;
  if (!map) {
    initMap();
    return;
  }
  if (!mapboxReady) return;
  if (!subscribed) {
    subscribed = true;
    if (VPS_API_BASE_URL) {
      refreshVpsDashboard();
      refreshVpsPublicConfig();
      vpsPollTimer = setInterval(refreshVpsDashboard, 5000);
      vpsPublicConfigTimer = setInterval(refreshVpsPublicConfig, 60000);
      gpsRenderTimer = setInterval(() => {
        if (!map) return;
        Object.entries(driversCache).forEach(([driverId, d]) => updateMarkerForDriver(driverId, d));
        scheduleSidebarRender();
      }, GPS_RENDER_INTERVAL_MS);
      return;
    }
    subscribeToDrivers();
    subscribeTodayTrips();
    ['hotels', 'sportVenues'].forEach((key) => db.ref(`config/${key}`).on('value', (snapshot) => {
      mapPlacesCache[key] = snapshot.val() || {};
      scheduleSidebarRender();
    }));
    // Los marcadores y la lista ya se actualizan solos en tiempo real con
    // cada escritura de Firebase. Este timer detecta el paso del tiempo SIN
    // que llegue un dato nuevo (ej. un conductor se desconecto) y refresca
    // el estado visual (tenue / retirado del mapa).
    setInterval(() => {
      if (!map) return;
      Object.entries(driversCache).forEach(([driverId, d]) => updateMarkerForDriver(driverId, d));
      scheduleSidebarRender();
    }, GPS_RENDER_INTERVAL_MS);
  }
}

async function refreshVpsPublicConfig() {
  if (!VPS_API_BASE_URL || !window.vpsConfigApi) return;
  try {
    const snapshot = await window.vpsConfigApi.publicConfig();
    const lists = snapshot?.places || {};
    for (const key of ['hotels', 'sportVenues']) {
      const entries = Array.isArray(lists[key]) ? lists[key] : [];
      mapPlacesCache[key] = Object.fromEntries(entries.map((place) => [place.id || place.name, place]));
    }
    if (snapshot?.dashboardName) {
      document.querySelectorAll('[data-dashboard-name]').forEach((element) => {
        element.textContent = snapshot.dashboardName;
      });
    }
    scheduleSidebarRender();
  } catch (_) {
    // The last good place list remains usable during a brief VPS outage.
  }
}

async function refreshVpsDashboard() {
  if (!VPS_API_BASE_URL || !auth.currentUser || !userAuthenticated) return;
  vpsDashboardRequest?.abort();
  const request = new AbortController();
  vpsDashboardRequest = request;
  const sequence = ++vpsDashboardRequestSequence;
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch(`${VPS_API_BASE_URL}/api/v1/dashboard/overview`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok) throw new Error(`VPS dashboard ${response.status}`);
    const snapshot = await response.json();
    if (sequence !== vpsDashboardRequestSequence || request.signal.aborted) return;
    window.latestVpsDashboardSnapshot = snapshot;
    const nextDrivers = Object.fromEntries((snapshot.drivers || []).map((driver) => [driver.id, driver]));
    driversCache = nextDrivers;
    activeTripsCache = Object.fromEntries((snapshot.trips || [])
      .filter((trip) => !['completed', 'cancelled'].includes(trip.status) && trip.driverId)
      .map((trip) => [trip.id, trip]));
    todayTripsCache = Object.fromEntries((snapshot.trips || []).map((trip) => [trip.id, trip]));

    const seenIds = new Set(Object.keys(driversCache));
    Object.keys(markers).forEach((id) => {
      if (!seenIds.has(id)) {
        markers[id].setMap(null);
        delete markers[id];
      }
    });
    if (expandedDriverId && !seenIds.has(expandedDriverId)) {
      expandedDriverId = null;
      clearRoute();
    }
    Object.entries(driversCache).forEach(([driverId, driver]) => updateMarkerForDriver(driverId, driver));
    scheduleSidebarRender();
    window.vpsDashboardLastError = '';
  } catch (error) {
    if (request.signal.aborted) return;
    // Keep the last good snapshot visible. The top-level live indicator and
    // freshness rules make a stale VPS connection obvious without blanking
    // the operator's map during a short network hiccup.
    window.vpsDashboardLastError = error?.message || 'VPS unavailable';
  } finally {
    if (vpsDashboardRequest === request) vpsDashboardRequest = null;
  }
}

// La vista Conductores puede confirmar una eliminación antes del siguiente
// sondeo de cinco segundos. Retira también el marcador y la tarjeta del mapa
// de inmediato; el siguiente snapshot VPS vuelve a ser la fuente de verdad.
window.removeDriverFromDashboard = function removeDriverFromDashboard(driverId) {
  const id = String(driverId || '');
  if (!id) return;
  delete driversCache[id];
  if (markers[id]) {
    markers[id].setMap(null);
    delete markers[id];
  }
  if (expandedDriverId === id) {
    expandedDriverId = null;
    clearRoute();
  }
  scheduleSidebarRender();
};

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------

function initMap() {
  try {
    map = new MapboxMapAdapter({
      container: 'map',
      center: { lat: -12.0464, lng: -77.0428 },
      zoom: 12,
    });
    map.ready
      .then(() => {
        mapboxReady = true;
        tryStartDashboard();
      })
      .catch(() => {
        mapboxReady = false;
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.innerHTML = '<div class="map-fallback">No se pudo cargar el mapa. Revisa la conexion y el token de Mapbox.</div>';
      });
  } catch (_) {
    mapboxReady = false;
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.innerHTML = '<div class="map-fallback">El mapa no esta configurado. Contacta al administrador.</div>';
  }
}

function centerMapOnFleet() {
  if (!map) return;

  // El marcador es la fuente de verdad visual: evita que un snapshot de
  // Firebase que acaba de cambiar deje al boton centrando coordenadas viejas.
  const markerPoints = Object.values(markers)
    .map((marker) => marker.getPosition())
    .filter((point) => (
      point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
    ));

  const freshPoints = Object.values(driversCache)
    .filter((driver) => (
      driver?.approvalStatus === 'approved'
      && typeof driver.lat === 'number'
      && typeof driver.lng === 'number'
      && freshnessStatus(driver.lastUpdate || 0) !== 'offline'
    ))
    .map((driver) => ({ lat: driver.lat, lng: driver.lng }));

  // Si todos estan desconectados, usa sus ultimas coordenadas conocidas en
  // vez de volver silenciosamente al centro de Lima. Asi el boton sigue
  // siendo util para localizar el ultimo punto reportado.
  const points = markerPoints.length
    ? markerPoints
    : freshPoints.length
      ? freshPoints
    : Object.values(driversCache)
      .filter((driver) => (
        driver?.approvalStatus === 'approved'
        && typeof driver.lat === 'number'
        && typeof driver.lng === 'number'
      ))
      .map((driver) => ({ lat: driver.lat, lng: driver.lng }));

  if (!points.length) {
    const fallback = { lat: -12.0464, lng: -77.0428 };
    if (typeof map.setView === 'function') map.setView(fallback, 12);
    else { map.setCenter(fallback); map.setZoom(12); }
    return;
  }

  if (points.length === 1) {
    if (typeof map.setView === 'function') map.setView(points[0], 15);
    else { map.setCenter(points[0]); map.setZoom(15); }
    return;
  }

  const bounds = new mapboxgl.LngLatBounds();
  points.forEach((point) => bounds.extend([point.lng, point.lat]));
  map.fitBounds(bounds, 72);
  map.once('idle', () => {
    if ((map.getZoom() || 0) > 16) map.setZoom(16);
  });
}

function freshnessStatus(lastUpdate) {
  return window.DriverState.freshnessStatus(lastUpdate);
}

// Estado operativo real del conductor (el que define el color en el mapa),
// combinando disponibilidad (drivers.status), el viaje que trae asignado
// (si aplica) y si sigue reportando GPS.
function driverState(d) {
  return window.DriverState.driverState(d, activeTripsCache);
}

function buildCarIcon(state) {
  if (carIconCache.has(state)) return carIconCache.get(state);
  const color = STATE_COLORS[state] || STATE_COLORS.offline;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="17" fill="#ffffff" stroke="${color}" stroke-width="2"/>
      <g transform="translate(6,10)">
        <path d="M2.5 10.5 L4 4.5 C4.4 3.2 5.5 2.5 6.8 2.5 H17.2 C18.5 2.5 19.6 3.2 20 4.5 L21.5 10.5 V15 C21.5 15.8 20.8 16.5 20 16.5 H19 C18.2 16.5 17.5 15.8 17.5 15 V14 H6.5 V15 C6.5 15.8 5.8 16.5 5 16.5 H4 C3.2 16.5 2.5 15.8 2.5 15 Z" fill="${color}"/>
        <rect x="5.5" y="4.5" width="13" height="4" rx="1" fill="#ffffff" opacity="0.9"/>
        <circle cx="6" cy="16.5" r="2" fill="#1f2937"/>
        <circle cx="18" cy="16.5" r="2" fill="#1f2937"/>
      </g>
    </svg>
  `;
  const icon = {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    width: 36,
    height: 36,
  };
  carIconCache.set(state, icon);
  return icon;
}

// Aro de color detras del auto seleccionado en el mapa (marca cual esta
// activo sin abrir un InfoWindow encima).
function buildHaloIcon(state) {
  if (haloIconCache.has(state)) return haloIconCache.get(state);
  const color = STATE_COLORS[state] || STATE_COLORS.offline;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r="25" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="3"/>
    </svg>
  `;
  const icon = {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    width: 56,
    height: 56,
  };
  haloIconCache.set(state, icon);
  return icon;
}

// Crea/mueve/quita el aro segun cual conductor este seleccionado; se llama
// cada vez que cambia la seleccion y cada vez que se mueve el auto
// seleccionado, para que el aro lo siga.
function updateSelectionHalo() {
  const marker = expandedDriverId && markers[expandedDriverId];
  if (!marker) {
    if (selectionHalo) {
      selectionHalo.setMap(null);
      selectionHalo = null;
    }
    return;
  }

  const state = driverState(driversCache[expandedDriverId]);
  const icon = buildHaloIcon(state);
  if (selectionHalo) {
    selectionHalo.setPosition(marker.getPosition());
    selectionHalo.setIcon(icon);
  } else {
    selectionHalo = map.createMarker({
      position: marker.getPosition(),
      map,
      icon,
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Suscripcion en tiempo real a Firebase
// ---------------------------------------------------------------------------

function subscribeToDrivers() {
  db.ref('drivers').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    // El mapa y la lista operativa solo muestran conductores aprobados. La
    // revision documental vive en la seccion Conductores y no debe aparecer
    // como conectado aunque conserve un estado antiguo en Firebase.
    driversCache = Object.fromEntries(
      Object.entries(data).filter(([, driver]) => driver?.approvalStatus === 'approved')
    );

    const seenIds = new Set(Object.keys(driversCache));

    // Elimina marcadores de conductores que ya no existen
    Object.keys(markers).forEach((id) => {
      if (!seenIds.has(id)) {
        markers[id].setMap(null);
        delete markers[id];
      }
    });
    if (expandedDriverId && !seenIds.has(expandedDriverId)) {
      expandedDriverId = null;
      clearRoute();
    }

    syncActiveTripListeners(driversCache);
    Object.entries(driversCache).forEach(([driverId, d]) => updateMarkerForDriver(driverId, d));

    scheduleSidebarRender();
  });
}

// Agrupa varios eventos de Firebase que llegan en el mismo ciclo del
// navegador. El mapa sigue actualizandose en cada evento; solo se evita
// reconstruir el HTML completo varias veces seguidas.
function scheduleSidebarRender() {
  if (sidebarRenderFrame !== null) return;
  sidebarRenderFrame = requestAnimationFrame(() => {
    sidebarRenderFrame = null;
    renderSidebar();
  });
}

// El historial de viajes (regla ".read" a nivel /trips) solo lo puede leer
// el dashboard (login con password); conductores y pasajeros usan auth
// anonima y siguen limitados a leer sus propios viajes por registro.
function subscribeTodayTrips() {
  const todayStartMs = new Date().setHours(0, 0, 0, 0);
  db.ref('trips')
    .orderByChild('requestedAt')
    .startAt(todayStartMs)
    .on('value', (snapshot) => {
      todayTripsCache = snapshot.val() || {};
      scheduleSidebarRender();
    });
}

// Mantiene un listener por cada viaje que un conductor 'busy' trae asignado
// (para saber si va en camino a recoger o ya lleva al pasajero, y dibujar la
// ruta). Se suscribe/desuscribe segun cambia drivers.currentTripId, en vez
// de escuchar todo /trips para no leer viajes irrelevantes.
function syncActiveTripListeners(driversData) {
  const needed = new Set();
  Object.values(driversData).forEach((d) => {
    if (d.currentTripId) needed.add(d.currentTripId);
  });

  Object.keys(activeTripListeners).forEach((tripId) => {
    if (!needed.has(tripId)) {
      db.ref(`trips/${tripId}`).off('value', activeTripListeners[tripId]);
      delete activeTripListeners[tripId];
      delete activeTripsCache[tripId];
    }
  });

  needed.forEach((tripId) => {
    if (activeTripListeners[tripId]) return;
    const callback = (snapshot) => {
      activeTripsCache[tripId] = snapshot.val();
      Object.entries(driversCache).forEach(([id, d]) => updateMarkerForDriver(id, d));
      scheduleSidebarRender();

      const expanded = expandedDriverId && driversCache[expandedDriverId];
      if (expanded && expanded.currentTripId === tripId) refreshRouteForSelected(true);
    };
    db.ref(`trips/${tripId}`).on('value', callback);
    activeTripListeners[tripId] = callback;
  });
}

// Crea/mueve el marcador si el conductor sigue reportando GPS reciente
// (menos de OFFLINE_AFTER_MS); lo retira del mapa si dejo de reportar.
function updateMarkerForDriver(driverId, d) {
  if (d.approvalStatus !== 'approved') {
    removeMarker(driverId);
    return;
  }
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') {
    removeMarker(driverId);
    return;
  }
  if (freshnessStatus(d.lastUpdate || 0) === 'offline') {
    const state = driverState(d);
    // Conserva visible la ultima posicion solo mientras el conductor esta
    // seleccionado; el resto de los marcadores antiguos se retira como
    // antes para no presentar una ubicacion como si fuera actual.
    if (state === 'connecting' || state === 'suspended' || expandedDriverId === driverId) {
      if (!markers[driverId]) createLastKnownMarker(driverId, d, state);
      if (markers[driverId]) {
        markers[driverId].setIcon(buildCarIcon(state));
        markers[driverId].setOpacity(0.55);
      }
      updateSelectionHalo();
      return;
    }
    removeMarker(driverId);
    return;
  }

  const state = driverState(d);
  const isStale = freshnessStatus(d.lastUpdate || 0) === 'stale';
  const position = { lat: d.lat, lng: d.lng };
  const icon = buildCarIcon(state);

  if (markers[driverId]) {
    lastKnownMarkerIds.delete(driverId);
    // El GPS envia muestras cada ~2 s; una animacion de 5 s dejaba el
    // marcador visualmente atrasado hasta una cuadra cuando el vehiculo
    // avanzaba. Interpolamos solo lo suficiente para evitar saltos.
    markers[driverId].setPosition(position, { durationMs: 900 });
    markers[driverId].setIcon(icon);
    markers[driverId].setOpacity(isStale ? 0.55 : 1);
  } else {
    const marker = map.createMarker({
      position,
      map,
      icon,
      opacity: isStale ? 0.55 : 1,
      title: d.name || driverId,
      zIndex: 10,
    });
    marker.addListener('click', () => selectDriver(driverId, { fromMap: true }));
    markers[driverId] = marker;
  }

  if (expandedDriverId === driverId) {
    updateSelectionHalo();
    // El conductor seleccionado mando una posicion nueva: si se desvio de
    // la ruta ya dibujada, esto la recalcula desde donde esta ahora.
    refreshRouteForSelected();
  }
}

function createLastKnownMarker(driverId, d, state = 'offline') {
  if (!map || typeof d?.lat !== 'number' || typeof d?.lng !== 'number') return null;
  const marker = map.createMarker({
    position: { lat: d.lat, lng: d.lng },
    map,
    icon: buildCarIcon(state),
    opacity: 0.55,
    title: `${d.name || driverId} · última ubicación conocida`,
    zIndex: 10,
  });
  marker.addListener('click', () => selectDriver(driverId, { fromMap: true }));
  markers[driverId] = marker;
  lastKnownMarkerIds.add(driverId);
  return marker;
}

function removeMarker(driverId) {
  if (markers[driverId]) {
    markers[driverId].setMap(null);
    delete markers[driverId];
  }
  lastKnownMarkerIds.delete(driverId);
  if (expandedDriverId === driverId) updateSelectionHalo(); // ya no hay marcador: quita el aro
}

// ---------------------------------------------------------------------------
// Seleccion de conductor: centra el mapa, marca el auto y abre la tarjeta
// ---------------------------------------------------------------------------

function selectDriver(driverId, { fromMap } = {}) {
  expandedDriverId = expandedDriverId === driverId ? null : driverId;
  renderSidebar();

  const driver = driversCache[driverId];
  let marker = markers[driverId];
  if (expandedDriverId && !marker) marker = createLastKnownMarker(driverId, driver);
  if (expandedDriverId && marker) {
    if (!fromMap && typeof map.setView === 'function') map.setView(marker.getPosition(), 15);
    else map.setCenter(marker.getPosition());
  }
  updateSelectionHalo();

  refreshRouteForSelected(true);
}

// ---------------------------------------------------------------------------
// Ruta en vivo (Mapbox Directions API) para el conductor seleccionado
// ---------------------------------------------------------------------------

function clearRoute() {
  if (routePolyline) {
    routePolyline.setMap(null);
    routePolyline = null;
  }
  if (targetMarker) {
    targetMarker.setMap(null);
    targetMarker = null;
  }
  lastRouteEtaSeconds = null;
}

// `targetType` distingue si el tramo va hacia el punto de recogida o hacia
// el destino final, para pintar el pin del color correcto (mismo criterio
// de color que ya usan passenger-app/driver-app: azul para recogida,
// violeta para destino).
function drawRoute(path, target, targetType) {
  clearRoute();
  routePolyline = map.createPolyline({
    path,
    map,
    strokeColor: '#000000',
    strokeOpacity: 0.85,
    strokeWeight: 5,
  });
  if (target) {
    const color = targetType === 'pickup' ? '#1d4ed8' : '#7c3aed';
    const pinSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#fff" stroke="${color}" stroke-width="3"/><circle cx="16" cy="16" r="6" fill="${color}"/></svg>`;
    targetMarker = map.createMarker({
      position: target,
      map,
      icon: {
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(pinSvg)}`,
        width: 32,
        height: 32,
      },
      title: targetType === 'pickup' ? 'Punto de recogida' : 'Destino',
      zIndex: 5,
    });
  }
}

async function computeRoute(origin, destination) {
  if (!map) throw new Error('Mapbox aun no esta listo');
  return map.computeRoute(origin, destination);
}

async function computeEtaMatrix(origin, destination) {
  if (!map || typeof map.computeMatrix !== 'function') return null;
  const matrix = await map.computeMatrix([origin, destination], {
    sources: [0],
    destinations: [1],
  });
  const seconds = Number(matrix?.durations?.[0]?.[0]);
  return Number.isFinite(seconds) ? seconds : null;
}

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Dibuja la ruta real del tramo que el conductor seleccionado esta
// recorriendo ahora mismo: auto->punto de recogida si va en camino, o
// recogida->destino si ya lleva al pasajero. Si Mapbox Directions falla, cae a una
// linea recta entre los mismos dos puntos (igual que el patron ya usado en
// passenger-app/lib/services/directions_service.dart).
//
// Se llama tanto al seleccionar un conductor / cambiar el estado del viaje
// (force=true, siempre recalcula) como en cada actualizacion de GPS del
// conductor seleccionado (force=false): asi si el conductor se desvia de la
// ruta sugerida, la linea se vuelve a trazar desde su posicion real en vez
// de quedar pegada a donde estaba cuando se calculo por ultima vez.
async function refreshRouteForSelected(force = false) {
  const d = expandedDriverId && driversCache[expandedDriverId];
  // Igual que driverState(): currentTripId manda sobre 'status', para que
  // la ruta no desaparezca si 'status' quedo desincronizado en 'online'
  // con un viaje todavia en curso.
  if (!d || !d.currentTripId) {
    lastRouteOrigin = null;
    lastRouteTarget = null;
    lastRouteRequestedAt = 0;
    clearRoute();
    return;
  }

  const trip = activeTripsCache[d.currentTripId];
  if (!trip || trip.status === 'cancelled' || trip.status === 'completed') {
    lastRouteOrigin = null;
    lastRouteTarget = null;
    lastRouteRequestedAt = 0;
    clearRoute();
    return;
  }

  const state = driverState(d);
  const origin = { lat: d.lat, lng: d.lng };
  let destination = null;
  let targetType = null;
  if (state === 'to_pickup' && typeof trip.pickupLat === 'number') {
    destination = { lat: trip.pickupLat, lng: trip.pickupLng };
    targetType = 'pickup';
  } else if (state === 'on_trip' && typeof trip.destinationLat === 'number') {
    destination = { lat: trip.destinationLat, lng: trip.destinationLng };
    targetType = 'destination';
  }
  if (!destination) {
    lastRouteOrigin = null;
    lastRouteTarget = null;
    lastRouteRequestedAt = 0;
    clearRoute();
    return;
  }

  // El GPS reenvia la posicion cada ~5s. La ruta visual no necesita pedir
  // Directions en cada escritura: solo se recalcula si el conductor avanzo
  // al menos 50m y no se ha pedido una ruta en los ultimos 30s. Un cambio de
  // destino siempre fuerza una consulta nueva.
  const targetChanged = !lastRouteTarget
    || metersBetween(lastRouteTarget, destination) >= 10;
  const tooSoon = Date.now() - lastRouteRequestedAt < ROUTE_RECALCULATION_INTERVAL_MS;
  if (!targetChanged && tooSoon) return;
  if (routeRequestInFlight) return;
  if (!force && !targetChanged && lastRouteOrigin
      && metersBetween(lastRouteOrigin, origin) < ROUTE_RECALCULATION_DISTANCE_METERS) {
    return;
  }

  const token = ++routeReqToken;
  routeRequestInFlight = true;
  lastRouteOrigin = origin;
  lastRouteTarget = destination;
  lastRouteRequestedAt = Date.now();

  try {
    const result = await computeRoute(origin, destination);
    if (token !== routeReqToken) return; // la seleccion cambio mientras esperabamos
    drawRoute(result.path, destination, targetType);
    let matrixEtaSeconds = null;
    try {
      matrixEtaSeconds = await computeEtaMatrix(origin, destination);
    } catch (_) {
      // Directions sigue siendo un fallback valido si Matrix falla.
    }
    if (token !== routeReqToken) return;
    lastRouteEtaSeconds = matrixEtaSeconds ?? result.durationSeconds;
  } catch (e) {
    if (token !== routeReqToken) return;
    drawRoute([origin, destination], destination, targetType);
    lastRouteEtaSeconds = null;
  } finally {
    routeRequestInFlight = false;
  }
  scheduleSidebarRender();
}

function formatEta(seconds) {
  if (seconds == null) return null;
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? 'menos de 1 min' : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// Sidebar: filtros de estado, busqueda y tarjeta expandible
// ---------------------------------------------------------------------------

const driverListEl = document.getElementById('driver-list');
const driverCountEl = document.getElementById('driver-count');
const mapViewFullscreenEl = document.getElementById('map-view');
const mapFullscreenBtn = document.getElementById('map-fullscreen-btn');
const mapCenterBtn = document.getElementById('map-center-btn');
const searchInput = document.getElementById('search-input');
const filterPillsEl = document.getElementById('status-filters');
const overviewActiveCountEl = document.getElementById('overview-active-count');
const overviewAvailableCountEl = document.getElementById('overview-available-count');
const overviewTripsCountEl = document.getElementById('overview-trips-count');
const overviewEtaCountEl = document.getElementById('overview-eta-count');
const overviewClockEl = document.getElementById('overview-clock');

if (mapCenterBtn) mapCenterBtn.addEventListener('click', centerMapOnFleet);

if (mapFullscreenBtn && mapViewFullscreenEl) {
  function syncMapFullscreenFallbackButton() {
    const active = mapViewFullscreenEl.classList.contains('map-fullscreen-fallback');
    mapFullscreenBtn.textContent = active ? 'X' : '⛶';
    mapFullscreenBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Ver mapa en pantalla completa');
    mapFullscreenBtn.setAttribute('title', active ? 'Salir de pantalla completa' : 'Ver mapa en pantalla completa');
    if (map) setTimeout(() => map.resize(), 80);
  }

  mapFullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (typeof mapViewFullscreenEl.requestFullscreen === 'function') await mapViewFullscreenEl.requestFullscreen();
      else throw new Error('Fullscreen API no disponible');
    } catch (error) {
      mapViewFullscreenEl.classList.toggle('map-fullscreen-fallback');
      syncMapFullscreenFallbackButton();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === mapViewFullscreenEl || mapViewFullscreenEl.classList.contains('map-fullscreen-fallback');
    mapFullscreenBtn.textContent = active ? '×' : '⛶';
    mapFullscreenBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Ver mapa en pantalla completa');
    if (map) setTimeout(() => map.resize(), 80);
  });
}

searchInput.addEventListener('input', renderSidebar);

filterPillsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-pill');
  if (!btn) return;
  activeFilter = btn.getAttribute('data-filter');
  filterPillsEl.querySelectorAll('.filter-pill').forEach((el) => {
    el.classList.toggle('active', el === btn);
  });
  renderSidebar();
});

function completedTripsToday(driverId) {
  return Object.values(todayTripsCache).filter(
    (t) => t.driverId === driverId && t.status === 'completed'
  ).length;
}

function updateOverviewStats() {
  const approved = Object.values(driversCache).filter((d) => d.approvalStatus === 'approved');
  const active = approved.filter((d) => driverState(d) !== 'offline');
  const available = approved.filter((d) => driverState(d) === 'available');
  const trips = Object.values(todayTripsCache).filter((trip) => trip.status !== 'cancelled');
  const completed = Object.values(todayTripsCache).filter((trip) => trip.status === 'completed');
  const cancelled = Object.values(todayTripsCache).filter((trip) => trip.status === 'cancelled');
  const busy = approved.filter((d) => driverState(d) === 'to_pickup' || driverState(d) === 'on_trip');
  const durations = completed
    .map((trip) => window.TripDuration?.tripDurationMs(trip) ?? null)
    .filter((duration) => duration != null);
  const averageDurationSeconds = durations.length
    ? Math.round(durations.reduce((total, duration) => total + duration, 0) / durations.length / 1000)
    : null;

  if (overviewActiveCountEl) overviewActiveCountEl.textContent = String(active.length).padStart(2, '0');
  if (overviewAvailableCountEl) overviewAvailableCountEl.textContent = String(available.length).padStart(2, '0');
  if (overviewTripsCountEl) overviewTripsCountEl.textContent = String(trips.length).padStart(2, '0');
  if (overviewEtaCountEl) overviewEtaCountEl.textContent = averageDurationSeconds == null ? '--:--' : formatEta(averageDurationSeconds);
  const activeDelta = document.getElementById('overview-active-delta');
  const tripsDelta = document.getElementById('overview-trips-delta');
  if (activeDelta) activeDelta.textContent = `${busy.length} en servicio`;
  if (tripsDelta) tripsDelta.textContent = `${completed.length} completados · ${cancelled.length} cancelados`;
  if (overviewClockEl) {
    overviewClockEl.textContent = new Intl.DateTimeFormat('es-PE', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).replace(',', ' ·');
  }
}

function renderSidebar() {
  const query = searchInput.value.trim().toLowerCase();

  const entries = Object.entries(driversCache).filter(([driverId, d]) => {
    if (d.approvalStatus !== 'approved') return false;
    if (query) {
      const matches = [d.name, d.plate, d.hotel]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(query));
      if (!matches) return false;
    }
    if (activeFilter !== 'all' && driverState(d) !== activeFilter) return false;
    return true;
  });

  driverCountEl.textContent = `${Object.values(driversCache).filter((d) => d.approvalStatus === 'approved').length} vehículos`;
  updateOverviewStats();

  driverListEl.innerHTML = entries.length
    ? entries.map(([driverId, d]) => driverCardHtml(driverId, d)).join('')
    : '<p class="empty-list">Sin conductores para este filtro.</p>';

  driverListEl.querySelectorAll('.driver-card-header').forEach((header) => {
    header.addEventListener('click', () => {
      selectDriver(header.closest('.driver-card').getAttribute('data-id'));
    });
  });

  driverListEl.querySelectorAll('[data-cancel-trip]').forEach((btn) => {
    btn.addEventListener('click', () => cancelTrip(btn.getAttribute('data-cancel-trip')));
  });
  driverListEl.querySelectorAll('[data-map-assign-place]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const driverId = btn.getAttribute('data-map-assign-place');
      const select = document.querySelector(`[data-map-place-select="${driverId}"]`);
      if (!select.value) return alert('Selecciona un hotel o sede deportiva.');
      const [type, name] = select.value.split('|');
      try {
        if (VPS_API_BASE_URL) {
          const token = await auth.currentUser.getIdToken();
          await window.vpsConfigApi.assignDriverPlace(driverId, { type, name }, token);
          await refreshVpsDashboard();
          return;
        }
        await manageDriver({ action: 'assignPlace', driverId, place: { type, name } });
      } catch (error) { alert(error.message); }
    });
  });
}

function mapPlaceOptions(d) {
  const current = d.assignedPlace?.name || '';
  return ['<option value="">Asignar hotel o sede…</option>',
    ...Object.values(mapPlacesCache.hotels).map((place) => `<option value="hotel|${escapeHtml(place.name)}"${current === place.name ? ' selected' : ''}>Hotel: ${escapeHtml(place.name)}</option>`),
    ...Object.values(mapPlacesCache.sportVenues).map((place) => `<option value="sportVenue|${escapeHtml(place.name)}"${current === place.name ? ' selected' : ''}>Sede: ${escapeHtml(place.name)}</option>`),
  ].join('');
}

// Cancelacion de un viaje ya asignado: solo el dashboard (login con
// password) tiene permiso de escritura para poner un viaje en 'cancelled'
// una vez que tiene driverId (ver database/firebase-rules.json) -- ni
// pasajero ni conductor pueden hacerlo desde ese punto en adelante.
async function cancelTrip(tripId) {
  if (window.dashboardRole !== 'ADMIN') return;
  const reason = prompt('Motivo de cancelación (quedará registrado):');
  if (reason == null) return;
  if (reason.trim().length < 5) return alert('Escribe un motivo de al menos 5 caracteres.');
  try {
    const token = await auth.currentUser.getIdToken();
    const endpoint = VPS_API_BASE_URL
      ? `${VPS_API_BASE_URL}/api/v1/trips/${encodeURIComponent(tripId)}/cancel`
      : 'https://us-central1-rastreoflota-53052.cloudfunctions.net/cancelDashboardTrip';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(VPS_API_BASE_URL ? { reason: reason.trim() } : { tripId, reason: reason.trim() }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo cancelar el viaje.');
    // Actualiza la vista de inmediato. El trigger libera el conductor y
    // notifica a las apps de forma asíncrona, pero el operador no debe ver el
    // viaje pegado en ruta mientras espera ese evento.
    if (activeTripsCache[tripId]) activeTripsCache[tripId] = { ...activeTripsCache[tripId], ...(result.trip || {}), status: 'cancelled' };
    if (todayTripsCache[tripId]) todayTripsCache[tripId] = { ...todayTripsCache[tripId], ...(result.trip || {}), status: 'cancelled' };
    if (expandedDriverId && driversCache[expandedDriverId]?.currentTripId === tripId) {
      clearRoute();
    }
    scheduleSidebarRender();
  } catch (error) {
    alert(error.message || error);
  }
}

function driverCardHtml(driverId, d) {
  const state = driverState(d);
  const isStale = freshnessStatus(d.lastUpdate || 0) === 'stale';
  const expanded = expandedDriverId === driverId;

  return `
    <li class="driver-card ${expanded ? 'expanded' : ''}" data-id="${driverId}">
      <div class="driver-card-header">
        <div class="name">
          <span class="status-dot state-${state} ${isStale ? 'is-stale' : ''}"></span>
          ${escapeHtml(d.name || 'Sin nombre')}
        </div>
        <div class="meta">${escapeHtml(d.plate || '-')} &middot; ${STATE_LABELS[state]}</div>
      </div>
      ${expanded ? driverDetailHtml(driverId, d, state) : ''}
    </li>
  `;
}

function driverDetailHtml(driverId, d, state) {
  const lastUpdateStr = d.lastUpdate ? new Date(d.lastUpdate).toLocaleTimeString() : '-';
  const phoneDigits = (d.phone || '').replace(/[^+\d]/g, '');
  const whatsappDigits = phoneDigits.replace('+', '');
  const trip = d.currentTripId ? activeTripsCache[d.currentTripId] : null;
  const eta = formatEta(lastRouteEtaSeconds);

  const tripIsActive = trip && !['completed', 'cancelled'].includes(trip.status);
  const tripCancellable = tripIsActive && window.dashboardRole === 'ADMIN';
  const tripBlock = tripIsActive
    ? `
      <div class="detail-section trip-section">
        <h4>Viaje actual</h4>
        <div class="row"><b>Pasajero:</b> ${escapeHtml(trip.passengerName || '-')}</div>
        <div class="row"><b>Estado:</b> ${escapeHtml(TRIP_STATUS_LABELS[trip.status] || trip.status || '-')}</div>
        <div class="row"><b>Recogida:</b> ${escapeHtml(trip.pickupAddress || '-')}</div>
        <div class="row"><b>Se dirige a:</b> ${escapeHtml(trip.destinationAddress || '-')}</div>
        ${eta ? `<div class="row"><b>Tiempo de llegada:</b> ${eta}</div>` : ''}
        ${trip.scheduledPickupLabel ? `<div class="row"><b>Recogida programada:</b> ${escapeHtml(trip.scheduledPickupLabel)}</div>` : ''}
        ${
          tripCancellable
            ? `<button type="button" class="cancel-trip-btn" data-cancel-trip="${d.currentTripId}" onclick="event.stopPropagation()">Cancelar viaje</button>`
            : ''
        }
      </div>
    `
    : '';

  return `
    <div class="detail-section">
      <div class="row"><b>Edad:</b> ${escapeHtml(String(d.age ?? '-'))}</div>
      <div class="row"><b>Lugar asignado:</b> ${escapeHtml(d.assignedPlace?.name || d.hotel || '-')}</div>
      <div class="row"><b>Teléfono:</b> ${escapeHtml(d.phone || '-')}</div>
      <div class="row"><b>Tipo de vehiculo:</b> ${escapeHtml(d.vehicleType || '-')}</div>
      <div class="row"><b>Capacidad:</b> ${d.vehicleSeats ? `${escapeHtml(String(d.vehicleSeats))} pasajeros` : '-'}</div>
      <div class="row"><b>Última actualización GPS:</b> ${lastUpdateStr}</div>
    </div>
    ${tripBlock}
    <div class="map-place-assignment">
      <select data-map-place-select="${driverId}">${mapPlaceOptions(d)}</select>
      <button type="button" data-map-assign-place="${driverId}">Asignar lugar</button>
    </div>
    ${
      phoneDigits
        ? `<div class="contact-actions">
            <a class="call-btn" href="tel:${phoneDigits}" onclick="event.stopPropagation()">Llamar</a>
            <a class="whatsapp-btn" href="https://wa.me/${whatsappDigits}" target="_blank" rel="noopener" onclick="event.stopPropagation()">WhatsApp</a>
          </div>`
        : ''
    }
  `;
}
