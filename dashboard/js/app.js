// ---------------------------------------------------------------------------
// Panel de control de flota: mapa en tiempo real con Google Maps + Firebase RTDB
// ---------------------------------------------------------------------------

const STALE_AFTER_MS = 45 * 1000;   // GPS "atrasado" (visual mas tenue) despues de 45s
                                     // (la app manda cada 15s, esto da margen a ~3 envios)
const OFFLINE_AFTER_MS = 3 * 60 * 1000; // se retira el marcador del mapa tras 3 min sin GPS

const STATE_COLORS = {
  available: '#06c167', // verde: libre en la red
  to_pickup: '#ff9500', // naranja: yendo a recoger / esperando en el punto de recogida
  on_trip: '#276ef1',   // azul: pasajero a bordo, rumbo al destino
  offline: '#9ca3af',   // gris: fuera de turno o sin señal reciente
};

const STATE_LABELS = {
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
let markers = {};        // driverId -> google.maps.Marker
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

let googleMapsReady = false;
let userAuthenticated = false;
let subscribed = false;
window.dashboardIsAdmin = false;

// Llamado por el callback del script de Google Maps (ver index.html)
function onGoogleMapsReady() {
  googleMapsReady = true;
  tryStartDashboard();
}

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

const AUTH_ERROR_MESSAGES = {
  'auth/invalid-email': 'Correo inválido.',
  'auth/user-not-found': 'Credenciales inválidas o usuario no existe.',
  'auth/wrong-password': 'Credenciales inválidas o usuario no existe.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión en vez de registrarte.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
};

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    loginError.textContent = AUTH_ERROR_MESSAGES[err.code] || 'Ocurrió un error. Intenta de nuevo.';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

async function initializeDashboardAdmin(user) {
  try {
    const token = await user.getIdToken();
    const response = await fetch('https://us-central1-rastreoflota-53052.cloudfunctions.net/initializeDashboardAdmin', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json().catch(() => ({}));
    window.dashboardIsAdmin = response.ok && result.isAdmin === true;
    if (window.dashboardIsAdmin) await user.getIdToken(true);
    // Si el usuario ya abrio Configuracion, vuelve a pintarla en cuanto el
    // rol llegue para que aparezcan los apartados sin otro inicio de sesion.
    if (typeof renderSettings === 'function') renderSettings();
  } catch (_) {
    // El dashboard sigue funcionando para cuentas existentes; el apartado de
    // usuarios mostrara un mensaje si la cuenta no es administradora.
  }
}

auth.onAuthStateChanged((user) => {
  if (user) {
    loginScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    userAuthenticated = true;
    initializeDashboardAdmin(user);
    tryStartDashboard();
  } else {
    loginScreen.classList.remove('hidden');
    appEl.classList.add('hidden');
    userAuthenticated = false;
  }
});

function tryStartDashboard() {
  if (!googleMapsReady || !userAuthenticated) return;
  if (!map) initMap();
  if (!subscribed) {
    subscribed = true;
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
    }, 10000);
  }
}

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: -12.0464, lng: -77.0428 }, // Lima, Peru por defecto
    zoom: 12,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

}

function freshnessStatus(lastUpdate) {
  const age = Date.now() - lastUpdate;
  if (age <= STALE_AFTER_MS) return 'online';
  if (age <= OFFLINE_AFTER_MS) return 'stale';
  return 'offline';
}

// Estado operativo real del conductor (el que define el color en el mapa),
// combinando disponibilidad (drivers.status), el viaje que trae asignado
// (si aplica) y si sigue reportando GPS.
function driverState(d) {
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return 'offline';
  if (freshnessStatus(d.lastUpdate || 0) === 'offline') return 'offline';

  // currentTripId manda sobre 'status': si el conductor tiene un viaje
  // asignado se considera ocupado aunque 'status' haya quedado
  // desincronizado en 'online' (bug conocido -- reabrir driver-app a mitad
  // de un viaje pisaba la disponibilidad sin tocar currentTripId, dejando
  // al conductor "disponible" en el mapa mientras el viaje seguia en
  // curso). Sin esto tambien se perdia el listener del viaje activo
  // (ver syncActiveTripListeners) y el boton de cancelar desaparecia.
  if (d.currentTripId) {
    const trip = activeTripsCache[d.currentTripId];
    if (trip && trip.status === 'in_progress') return 'on_trip';
    return 'to_pickup'; // accepted / arrived_at_pickup, o el trip aun no cargo
  }

  if (d.status === 'online') return 'available';

  return 'offline'; // fuera de turno (sin status), aunque siga reportando GPS
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
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 18),
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
    scaledSize: new google.maps.Size(56, 56),
    anchor: new google.maps.Point(28, 28),
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
    selectionHalo = new google.maps.Marker({
      position: marker.getPosition(),
      map,
      icon,
      clickable: false,
      zIndex: 1,
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
    driversCache = data;

    const seenIds = new Set(Object.keys(data));

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

    syncActiveTripListeners(data);
    Object.entries(data).forEach(([driverId, d]) => updateMarkerForDriver(driverId, d));

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
  if (d.approvalStatus === 'rejected') {
    removeMarker(driverId);
    return;
  }
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') {
    removeMarker(driverId);
    return;
  }
  if (freshnessStatus(d.lastUpdate || 0) === 'offline') {
    removeMarker(driverId);
    return;
  }

  const state = driverState(d);
  const isStale = freshnessStatus(d.lastUpdate || 0) === 'stale';
  const position = { lat: d.lat, lng: d.lng };
  const icon = buildCarIcon(state);

  if (markers[driverId]) {
    markers[driverId].setPosition(position);
    markers[driverId].setIcon(icon);
    markers[driverId].setOpacity(isStale ? 0.55 : 1);
  } else {
    const marker = new google.maps.Marker({
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

function removeMarker(driverId) {
  if (markers[driverId]) {
    markers[driverId].setMap(null);
    delete markers[driverId];
  }
  if (expandedDriverId === driverId) updateSelectionHalo(); // ya no hay marcador: quita el aro
}

// ---------------------------------------------------------------------------
// Seleccion de conductor: centra el mapa, marca el auto y abre la tarjeta
// ---------------------------------------------------------------------------

function selectDriver(driverId, { fromMap } = {}) {
  expandedDriverId = expandedDriverId === driverId ? null : driverId;
  renderSidebar();

  const marker = markers[driverId];
  if (expandedDriverId && marker) {
    map.setCenter(marker.getPosition());
    if (!fromMap) map.setZoom(15);
  }
  updateSelectionHalo();

  refreshRouteForSelected(true);
}

// ---------------------------------------------------------------------------
// Ruta en vivo (Routes API v2) para el conductor seleccionado
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
  routePolyline = new google.maps.Polyline({
    path,
    map,
    strokeColor: '#000000',
    strokeOpacity: 0.85,
    strokeWeight: 5,
  });
  if (target) {
    targetMarker = new google.maps.Marker({
      position: target,
      map,
      icon: {
        url: `https://maps.google.com/mapfiles/ms/icons/${targetType === 'pickup' ? 'blue' : 'purple'}-dot.png`,
      },
      title: targetType === 'pickup' ? 'Punto de recogida' : 'Destino',
      zIndex: 5,
    });
  }
}

async function computeRoute(origin, destination) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.duration',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      languageCode: 'es',
    }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}`);
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) throw new Error('Routes API: sin rutas');

  const durationSeconds = route.duration ? parseInt(route.duration, 10) : null; // ej. "412s"
  return { path: decodePolyline(route.polyline.encodedPolyline), durationSeconds };
}

function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
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
// recogida->destino si ya lleva al pasajero. Si Routes API falla, cae a una
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
    clearRoute();
    return;
  }

  const trip = activeTripsCache[d.currentTripId];
  if (!trip) {
    lastRouteOrigin = null;
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
    clearRoute();
    return;
  }

  // El GPS reenvia la posicion cada ~15s aunque el conductor este detenido;
  // sin este filtro se recalcularia la ruta (llamada a Routes API) sin
  // necesidad en cada envio. Solo se salta el filtro cuando fuerza el
  // recalculo (cambio de seleccion o del propio viaje), donde el origen o
  // destino pudo cambiar aunque la posicion no se haya movido.
  if (!force && lastRouteOrigin && metersBetween(lastRouteOrigin, origin) < 25) {
    return;
  }

  const token = ++routeReqToken;
  lastRouteOrigin = origin;

  try {
    const result = await computeRoute(origin, destination);
    if (token !== routeReqToken) return; // la seleccion cambio mientras esperabamos
    drawRoute(result.path, destination, targetType);
    lastRouteEtaSeconds = result.durationSeconds;
  } catch (e) {
    if (token !== routeReqToken) return;
    drawRoute([origin, destination], destination, targetType);
    lastRouteEtaSeconds = null;
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
const searchInput = document.getElementById('search-input');
const filterPillsEl = document.getElementById('status-filters');

if (mapFullscreenBtn && mapViewFullscreenEl) {
  mapFullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await mapViewFullscreenEl.requestFullscreen();
    } catch (error) {
      mapViewFullscreenEl.classList.toggle('map-fullscreen-fallback');
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === mapViewFullscreenEl || mapViewFullscreenEl.classList.contains('map-fullscreen-fallback');
    mapFullscreenBtn.textContent = active ? '×' : '⛶';
    mapFullscreenBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Ver mapa en pantalla completa');
    if (map) setTimeout(() => google.maps.event.trigger(map, 'resize'), 80);
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

function renderSidebar() {
  const query = searchInput.value.trim().toLowerCase();

  const entries = Object.entries(driversCache).filter(([driverId, d]) => {
    if (d.approvalStatus === 'rejected') return false;
    if (query) {
      const matches = [d.name, d.plate, d.hotel]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(query));
      if (!matches) return false;
    }
    if (activeFilter !== 'all' && driverState(d) !== activeFilter) return false;
    return true;
  });

  driverCountEl.textContent = `${Object.values(driversCache).filter((d) => d.approvalStatus !== 'rejected').length} vehículos`;

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
      try { await manageDriver({ action: 'assignPlace', driverId, place: { type, name } }); } catch (error) { alert(error.message); }
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
function cancelTrip(tripId) {
  if (!confirm('¿Cancelar este viaje? El conductor quedará disponible de nuevo.')) return;
  db.ref(`trips/${tripId}`).update({
    status: 'cancelled',
    cancelledBy: 'admin',
    cancelledAt: Date.now(),
    cancelReason: auth.currentUser ? `Cancelado por ${auth.currentUser.email}` : 'Cancelado por admin',
  });
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

  const tripCancellable = trip && trip.status !== 'completed' && trip.status !== 'cancelled';
  const tripBlock = trip
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
      <div class="row"><b>Viajes completados hoy:</b> ${completedTripsToday(driverId)}</div>
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
