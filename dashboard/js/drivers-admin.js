// ---------------------------------------------------------------------------
// Seccion "Conductores": aprobacion manual de documentos de registro.
// Suscripcion propia a /drivers (independiente de driversCache de app.js)
// para no arriesgar la logica del mapa ya existente.
// ---------------------------------------------------------------------------

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DOC_FIELDS = [
  { key: 'dniDocUrl', label: 'DNI (PDF)' },
  { key: 'dniFrontDocUrl', label: 'DNI (frente)' },
  { key: 'dniBackDocUrl', label: 'DNI (dorso)' },
  { key: 'licenseDocUrl', label: 'Licencia' },
  { key: 'soatDocUrl', label: 'SOAT' },
  { key: 'circulationCardDocUrl', label: 'Tarjeta circ.' },
  { key: 'technicalReviewDocUrl', label: 'Rev. técnica' },
  { key: 'criminalRecordDocUrl', label: 'Récord' },
  { key: 'workCertificateDocUrl', label: 'Cert. laboral' },
];

const REJECTION_FIELDS = [
  { key: 'personalData', label: 'Datos personales' },
  { key: 'vehicleData', label: 'Datos del vehículo' },
  { key: 'profile', label: 'Foto de perfil' },
  { key: 'dni', label: 'DNI' },
  { key: 'license', label: 'Licencia' },
  { key: 'soat', label: 'SOAT' },
  { key: 'circulationCard', label: 'Tarjeta de circulación' },
  { key: 'technicalReview', label: 'Revisión técnica' },
  { key: 'criminalRecord', label: 'Récord del conductor' },
  { key: 'workCertificate', label: 'Certificado laboral' },
];

const REJECTION_FIELD_LABELS = Object.fromEntries(
  REJECTION_FIELDS.map((field) => [field.key, field.label])
);

const APPROVAL_LABELS = {
  pending_review: 'Pendiente',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  suspended: 'Suspendido',
};

let adminDriversCache = {};
let adminSubscribed = false;
let adminSubscribedRole = '';
let adminListenerBindings = [];
let adminActiveFilter = 'approved';
let adminDriverSearch = '';
let openRejectFormId = null;
let adminPlacesCache = { hotels: {}, sportVenues: {} };
let adminTripHistory = {};
let adminTripFeedback = {};
let adminConnectionHistory = {};
let attendanceDateFilter = { from: '', to: '' };
let attendanceCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let attendanceHoverDate = '';
let attendanceClickTimer = null;
let attendanceSearch = '';
let attendanceOutsideListenerBound = false;
let tripHistorySearch = '';
let tripHistoryDriverFilter = '';
let tripHistoryDateFilter = '';
let tripHistoryDateToFilter = '';
let tripHistoryCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let tripHistoryHoverDate = '';
let tripHistoryClickTimer = null;
let tripHistoryOutsideListenerBound = false;

// El mapa ya usa el API del VPS como fuente operativa. Las vistas de
// Conductores deben usar la misma fuente para no quedar en blanco cuando un
// listener antiguo de Firebase tarda, falla o pierde la sesión.
const DRIVER_ADMIN_VPS_API_BASE_URL = String(window.vpsApiBaseUrl || '').replace(/\/$/, '');
let driverAdminVpsTimer = null;
let driverAdminVpsError = '';

const mapViewEl = document.getElementById('map-view');
const adminViewEl = document.getElementById('drivers-admin-view');
const pendingBadgeEl = document.getElementById('pending-badge');
const navTabs = document.querySelectorAll('.nav-tab');

function openDashboardView(view) {
  if (window.dashboardRole !== 'ADMIN' && (view === 'places' || view === 'settings')) {
    view = 'map';
  }
  navTabs.forEach((tab) => tab.classList.toggle('active', tab.getAttribute('data-view') === view));
  mapViewEl.classList.toggle('hidden', view !== 'map');
  adminViewEl.classList.toggle('hidden', view !== 'drivers-admin');
  placesViewEl.classList.toggle('hidden', view !== 'places');
  settingsViewEl.classList.toggle('hidden', view !== 'settings');
  if (view === 'drivers-admin') startDriversAdmin();
  if (view === 'places') startPlaces();
  if (view === 'settings') {
    // El boton superior siempre vuelve al inicio de Configuracion, incluso
    // cuando se esta dentro de Usuarios, Apps o Actualizaciones.
    settingsSection = 'home';
    startSettings();
    renderSettings();
  }
  if (view === 'map' && map) map.resize();
}

navTabs.forEach((tab) => tab.addEventListener('click', () => openDashboardView(tab.getAttribute('data-view'))));
document.getElementById('dashboard-home-link').addEventListener('click', () => openDashboardView('map'));

function subscribeAdminValue(path, handler) {
  const reference = db.ref(path);
  reference.on('value', handler);
  adminListenerBindings.push({ reference, handler });
}

function resetDriversAdminSubscriptions() {
  if (driverAdminVpsTimer) {
    clearInterval(driverAdminVpsTimer);
    driverAdminVpsTimer = null;
  }
  adminListenerBindings.forEach(({ reference, handler }) => reference.off('value', handler));
  adminListenerBindings = [];
  adminTripHistory = {};
  adminTripFeedback = {};
  adminConnectionHistory = {};
  adminSubscribed = false;
  adminSubscribedRole = '';
}

function driverAdminFilters() {
  if (window.dashboardRole === 'ADMIN') {
    return ['approved', 'pending_review', 'rejected', 'suspended', 'all', 'trip-history', 'attendance', 'alerts', 'incidents'];
  }
  return ['approved', 'suspended', 'all'];
}

function startDriversAdmin() {
  const role = window.dashboardRole || '';
  if (adminSubscribed && adminSubscribedRole === role) return;
  if (adminSubscribed) resetDriversAdminSubscriptions();
  adminSubscribed = true;
  adminSubscribedRole = role;

  if (DRIVER_ADMIN_VPS_API_BASE_URL) {
    // Pintar el estado inicial evita una pantalla vacía mientras se obtiene
    // el primer token/snapshot. El refresco posterior reemplaza este estado.
    driverAdminVpsError = '';
    updatePendingBadge();
    renderDriversAdmin();
    refreshDriversAdminFromVps();
    if (driverAdminVpsTimer) clearInterval(driverAdminVpsTimer);
    driverAdminVpsTimer = setInterval(refreshDriversAdminFromVps, 5000);
    return;
  }

  subscribeAdminValue('drivers', (snapshot) => {
    adminDriversCache = snapshot.val() || {};
    updatePendingBadge();
    renderDriversAdmin();
  });
  ['hotels', 'sportVenues'].forEach((key) => subscribeAdminValue(`config/${key}`, (snapshot) => {
    adminPlacesCache[key] = snapshot.val() || {};
    renderDriversAdmin();
  }));
  if (role === 'ADMIN') {
    subscribeAdminValue('tripHistory', (snapshot) => { adminTripHistory = snapshot.val() || {}; renderDriversAdmin(); });
    subscribeAdminValue('tripFeedback', (snapshot) => { adminTripFeedback = snapshot.val() || {}; renderDriversAdmin(); });
    subscribeAdminValue('driverConnectionHistory', (snapshot) => { adminConnectionHistory = snapshot.val() || {}; renderDriversAdmin(); });
  }
}

function mapVpsDriverForAdmin(driver) {
  const availability = String(driver.availabilityStatus || 'offline').toLowerCase();
  const status = availability === 'online'
    ? (driver.currentTripId ? 'busy' : 'online')
    : 'offline';
  return {
    ...driver,
    approvalStatus: driver.approvalStatus || 'pending_review',
    status,
    estado_conexion: availability === 'online' ? 'ONLINE' : 'OFFLINE',
    ultima_conexion: driver.lastUpdate || null,
    lat: driver.lat,
    lng: driver.lng,
    lastUpdate: driver.lastUpdate,
    assignedPlace: driver.assignedPlace || null,
  };
}

async function refreshDriversAdminFromVps() {
  if (!DRIVER_ADMIN_VPS_API_BASE_URL) return;
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) throw new Error('Sesión del dashboard no disponible.');
    const token = await currentUser.getIdToken();
    const response = await fetch(`${DRIVER_ADMIN_VPS_API_BASE_URL}/api/v1/dashboard/overview`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `API ${response.status}`);
    adminDriversCache = Object.fromEntries(
      (Array.isArray(result.drivers) ? result.drivers : []).map((driver) => [driver.id, mapVpsDriverForAdmin(driver)]),
    );
    adminTripHistory = Object.fromEntries(
      (Array.isArray(result.trips) ? result.trips : []).map((trip) => [trip.id, trip]),
    );
    adminConnectionHistory = result.connectionHistory && typeof result.connectionHistory === 'object'
      ? result.connectionHistory : {};
    adminTripFeedback = result.tripFeedback && typeof result.tripFeedback === 'object'
      ? result.tripFeedback : {};
    driverAdminVpsError = '';
    updatePendingBadge();
    renderDriversAdmin();
  } catch (error) {
    // Mantener el toolbar/estado vacío es preferible a dejar toda la vista en
    // blanco. El siguiente ciclo reintenta sin interrumpir el mapa.
    driverAdminVpsError = error?.message || 'No se pudo cargar el API del VPS.';
    updatePendingBadge();
    renderDriversAdmin();
  }
}

function driverPlaceOptions(d) {
  const current = d.assignedPlace?.name || '';
  const options = [
    '<option value="">Asignar hotel o sede…</option>',
    ...Object.values(adminPlacesCache.hotels).map((place) => `<option value="hotel|${escapeHtml(place.name)}"${current === place.name ? ' selected' : ''}>Hotel: ${escapeHtml(place.name)}</option>`),
    ...Object.values(adminPlacesCache.sportVenues).map((place) => `<option value="sportVenue|${escapeHtml(place.name)}"${current === place.name ? ' selected' : ''}>Sede: ${escapeHtml(place.name)}</option>`),
  ];
  return options.join('');
}

function updatePendingBadge() {
  const pendingCount = Object.values(adminDriversCache).filter(
    (d) => d.approvalStatus === 'pending_review'
  ).length;
  pendingBadgeEl.textContent = String(pendingCount);
  pendingBadgeEl.classList.toggle('hidden', window.dashboardRole !== 'ADMIN' || pendingCount === 0);
}

function isPdfUrl(url) {
  return /\.pdf(\?|$)/i.test(url || '');
}

function safeDriverStorageUrl(rawValue, driverId) {
  if (window.dashboardRole !== 'ADMIN') return '';
  try {
    const url = new URL(String(rawValue || '').trim());
    const expectedPrefix = `/v0/b/rastreoflota-53052.firebasestorage.app/o/driver_documents/${driverId}/`;
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'firebasestorage.googleapis.com' ||
      !decodeURIComponent(url.pathname).startsWith(expectedPrefix) ||
      url.searchParams.get('alt') !== 'media' ||
      !url.searchParams.get('token')
    ) {
      return '';
    }
    return url.href;
  } catch (_) {
    return '';
  }
}

function docCellHtml(driverId, field, url) {
  const safeUrl = safeDriverStorageUrl(url, driverId);
  if (!safeUrl) {
    return `
      <div class="doc-item">
        <div class="doc-missing" title="No subido">—</div>
        <div class="doc-label">${escapeHtml(field.label)}</div>
      </div>
    `;
  }
  const escapedUrl = escapeHtml(safeUrl);
  const cell = isPdfUrl(safeUrl)
    ? `<a class="doc-pdf-link" href="${escapedUrl}" target="_blank" rel="noopener">📄</a>`
    : `<a href="${escapedUrl}" target="_blank" rel="noopener"><img class="doc-thumb" src="${escapedUrl}" alt="${escapeHtml(field.label)}" /></a>`;
  return `
    <div class="doc-item">
      ${cell}
      <div class="doc-label">${escapeHtml(field.label)}</div>
    </div>
  `;
}

function driverConnectionHtml(driverId, d) {
  const suspended = d.turno_activo === true && d.ultimo_motivo_desconexion === 'HEARTBEAT';
  const connection = suspended
    ? 'SIN SE&Ntilde;AL'
    : (d.estado_conexion || ((d.status === 'online' || d.status === 'busy') ? 'ONLINE' : 'OFFLINE'));
  const lastConnection = d.ultima_conexion ? new Date(Number(d.ultima_conexion)).toLocaleString('es-PE') : 'Sin registro';
  return `
    <div class="driver-connection-box" data-connection-box="${driverId}">
      <div class="driver-connection-heading">
        <div><b>Estado de conexión</b><small>${connection === 'ONLINE' ? 'En línea' : 'Fuera de línea'} · última conexión: ${escapeHtml(lastConnection)}</small></div>
        <span class="connection-state ${suspended ? 'suspended' : (connection === 'ONLINE' ? 'online' : 'offline')}">${connection}</span>
      </div>
      <small class="connection-note">Las desconexiones manuales y las pérdidas de señal generan una alerta automática.</small>
    </div>
  `;
}

function driverAdminCardHtml(driverId, d) {
  const status = d.suspended === true
    ? 'suspended'
    : (d.approvalStatus || 'pending_review');
  const profilePhotoUrl = safeDriverStorageUrl(d.profilePhotoUrl, driverId);
  const canManageDriver = window.dashboardRole === 'ADMIN';
  const rejectFormOpen = openRejectFormId === driverId;
  const rejectionLabels = String(d.rejectionFieldKeys || '')
    .split(',')
    .map((key) => REJECTION_FIELD_LABELS[key.trim()])
    .filter(Boolean);
  const expiryLabel = (value) => {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Sin registrar';
    const date = new Date(timestamp);
    const expired = timestamp <= Date.now();
    return `${date.toLocaleDateString('es-PE')}${expired ? ' · VENCIDO' : ''}`;
  };

  const rejectionBlock =
    status === 'rejected'
      ? `<div class="rejection-note">
          ${d.rejectionReason ? `<div><b>Motivo del rechazo:</b> ${escapeHtml(d.rejectionReason)}</div>` : ''}
          ${rejectionLabels.length ? `<div><b>Debe corregir:</b> ${escapeHtml(rejectionLabels.join(', '))}</div>` : ''}
        </div>`
      : '';
  const suspensionBlock = d.suspended === true
    ? `<div class="rejection-note"><div><b>Motivo de suspensión:</b> ${escapeHtml(d.suspensionReason || '-')}</div><div><b>Suspendido por:</b> ${escapeHtml(d.suspendedBy || '-')}</div></div>`
    : '';

  const actionsHtml =
    canManageDriver && status === 'pending_review'
      ? `
        <div class="driver-admin-actions">
          <button type="button" class="approve-btn" data-action="approve" data-id="${driverId}">Aprobar</button>
          <button type="button" class="reject-btn" data-action="reject" data-id="${driverId}">Rechazar</button>
        </div>
        ${
          rejectFormOpen
            ? `
          <form class="reject-form" data-reject-form="${driverId}">
            <div class="reject-fields">
              <strong>Datos o documentos que debe corregir:</strong>
              <div class="reject-fields-grid">
                ${REJECTION_FIELDS.map((field) => `<label><input type="checkbox" name="rejectionField" value="${field.key}" /> ${field.label}</label>`).join('')}
              </div>
            </div>
            <input name="rejectionReason" type="text" placeholder="Motivo del rechazo (ej. SOAT vencido)" required />
            <button type="submit" class="reject-btn">Confirmar</button>
          </form>
        `
            : ''
        }
      `
      : '';
  const suspensionActions = canManageDriver && d.approvalStatus === 'approved'
    ? `<div class="driver-admin-actions">${d.suspended === true
      ? `<button type="button" class="approve-btn" data-action="reinstate" data-id="${driverId}">Reactivar conductor</button>`
      : `<button type="button" class="reject-btn" data-action="suspend" data-id="${driverId}">Suspender conductor</button>`}</div>`
    : '';

  return `
    <div class="driver-admin-card" data-id="${driverId}">
      <div class="driver-admin-card-header">
        <img class="driver-admin-avatar" src="${escapeHtml(profilePhotoUrl)}" alt="" onerror="this.style.visibility='hidden'" />
        <div>
          <div class="driver-admin-name">${escapeHtml(d.name || 'Sin nombre')}</div>
          <div class="driver-admin-meta">${escapeHtml(d.email || '-')} &middot; DNI ${escapeHtml(d.dni || '-')}</div>
        </div>
        <span class="status-badge ${status}">${APPROVAL_LABELS[status] || status}</span>
      </div>
      <div class="detail-section">
        <div class="row"><b>Teléfono:</b> ${escapeHtml(d.phone || '-')}</div>
        <div class="row"><b>Placa:</b> ${escapeHtml(d.plate || '-')}</div>
        <div class="row"><b>Edad:</b> ${escapeHtml(String(d.age ?? '-'))}</div>
        <div class="row"><b>Lugar asignado:</b> ${escapeHtml(d.assignedPlace?.name || '-')}</div>
        <div class="row"><b>Licencia vigente hasta:</b> ${escapeHtml(expiryLabel(d.licenseExpiresAt))}</div>
        <div class="row"><b>SOAT vigente hasta:</b> ${escapeHtml(expiryLabel(d.soatExpiresAt))}</div>
        <div class="row"><b>Revisión técnica vigente hasta:</b> ${escapeHtml(expiryLabel(d.technicalReviewExpiresAt))}</div>
      </div>
      ${status !== 'rejected' ? driverConnectionHtml(driverId, d) : ''}
      ${rejectionBlock}
      ${suspensionBlock}
      ${
        !canManageDriver
          ? ''
          : status !== 'rejected'
          ? `
        <div class="driver-admin-actions">
          <button type="button" class="view-file-btn" data-action="view-file" data-id="${driverId}">Ver archivo completo</button>
          <select class="assign-place-select" data-place-select="${driverId}">${driverPlaceOptions(d)}</select>
          <button type="button" class="view-file-btn" data-action="assign-place" data-id="${driverId}">Asignar lugar</button>
          <button type="button" class="delete-driver-btn" data-action="delete-driver" data-id="${driverId}">Eliminar conductor</button>
        </div>
      `
          : `
        <div class="driver-admin-actions">
          <button type="button" class="view-file-btn" data-action="view-file" data-id="${driverId}">Ver archivo completo</button>
          <button type="button" class="delete-driver-btn" data-action="delete-driver" data-id="${driverId}">Eliminar y permitir nuevo registro</button>
        </div>
      `
      }
      ${actionsHtml}
      ${suspensionActions}
    </div>
  `;
}

function renderDriversAdmin() {
  const availableFilters = driverAdminFilters();
  if (!availableFilters.includes(adminActiveFilter)) adminActiveFilter = 'approved';
  if (adminActiveFilter === 'trip-history' || adminActiveFilter === 'attendance' || adminActiveFilter === 'alerts' || adminActiveFilter === 'incidents') {
    if (adminActiveFilter === 'attendance') {
      renderDriversAttendance();
      return;
    }
    if (adminActiveFilter === 'alerts') {
      renderPrematureDisconnectHistory();
      return;
    }
    if (adminActiveFilter === 'incidents') {
      renderTripIncidents();
      return;
    }
    renderDriversHistory();
    return;
  }
  const entries = Object.entries(adminDriversCache).filter(([, d]) => {
    if (adminActiveFilter === 'all') return true;
    const status = d.suspended === true
      ? 'suspended'
      : (d.approvalStatus || 'pending_review');
    return status === adminActiveFilter;
  }).filter(([, d]) => {
    const query = adminDriverSearch.trim().toLowerCase();
    if (!query) return true;
    return [d.name, d.plate].some((value) => String(value || '').toLowerCase().includes(query));
  });

  const toolbarHtml = `
    <div class="drivers-admin-toolbar">
      ${availableFilters
        .map(
          (f) => `
        <button type="button" class="filter-pill ${adminActiveFilter === f ? 'active' : ''}" data-admin-filter="${f}">
          ${f === 'all' ? 'Todos' : f === 'trip-history' ? 'Historial de viajes' : f === 'attendance' ? 'Asistencia' : f === 'alerts' ? 'Alertas de desconexión' : f === 'incidents' ? 'Incidencias' : APPROVAL_LABELS[f]}
        </button>
      `
        )
        .join('')}
      <label class="drivers-admin-search">Buscar conductor<input type="search" id="admin-driver-search" value="${escapeHtml(adminDriverSearch)}" placeholder="Nombre o placa..." /></label>
    </div>
  `;

  const gridHtml = entries.length
    ? `<div class="driver-admin-grid">${entries.map(([id, d]) => driverAdminCardHtml(id, d)).join('')}</div>`
    : '<p class="drivers-admin-empty">Sin conductores para este filtro.</p>';

  const vpsErrorHtml = driverAdminVpsError
    ? `<p class="settings-feedback error">No se pudo actualizar la flota: ${escapeHtml(driverAdminVpsError)}. Reintentando...</p>`
    : '';
  adminViewEl.innerHTML = toolbarHtml + vpsErrorHtml + gridHtml;

  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      adminActiveFilter = btn.getAttribute('data-admin-filter');
      renderDriversAdmin();
    });
  });

  adminViewEl.querySelectorAll('[data-action="approve"]').forEach((btn) => {
    btn.addEventListener('click', () => approveDriver(btn.getAttribute('data-id')));
  });

  adminViewEl.querySelectorAll('[data-action="view-file"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadDriverPdf(btn));
  });

  adminViewEl.querySelectorAll('[data-action="reject"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openRejectFormId = openRejectFormId === btn.getAttribute('data-id') ? null : btn.getAttribute('data-id');
      renderDriversAdmin();
    });
  });
  adminViewEl.querySelectorAll('[data-action="suspend"]').forEach((btn) => {
    btn.addEventListener('click', () => suspendDriver(btn.getAttribute('data-id')));
  });
  adminViewEl.querySelectorAll('[data-action="reinstate"]').forEach((btn) => {
    btn.addEventListener('click', () => reinstateDriver(btn.getAttribute('data-id')));
  });

  adminViewEl.querySelectorAll('[data-action="assign-place"]').forEach((btn) => {
    btn.addEventListener('click', () => assignDriverPlace(btn.getAttribute('data-id')));
  });
  adminViewEl.querySelectorAll('[data-action="delete-driver"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteDriver(btn.getAttribute('data-id')));
  });

  const driverSearchInput = document.getElementById('admin-driver-search');
  if (driverSearchInput) driverSearchInput.addEventListener('input', () => {
    const cursor = driverSearchInput.selectionStart;
    adminDriverSearch = driverSearchInput.value;
    renderDriversAdmin();
    const nextInput = document.getElementById('admin-driver-search');
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(cursor, cursor);
    }
  });
  adminViewEl.querySelectorAll('[data-reject-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const driverId = form.getAttribute('data-reject-form');
      const reason = form.querySelector('input[name="rejectionReason"]').value.trim();
      const rejectionFields = [...form.querySelectorAll('input[name="rejectionField"]:checked')]
        .map((input) => input.value);
      if (!reason) return alert('Escribe el motivo del rechazo.');
      if (!rejectionFields.length) return alert('Selecciona al menos un dato o documento que deba corregirse.');
      await rejectDriver(driverId, reason, rejectionFields);
    });
  });
}

function historyToolbarHtml() {
  return `<div class="drivers-admin-toolbar">${driverAdminFilters().map((f) => `<button type="button" class="filter-pill ${adminActiveFilter === f ? 'active' : ''}" data-admin-filter="${f}">${f === 'all' ? 'Todos' : f === 'trip-history' ? 'Historial de viajes' : f === 'attendance' ? 'Asistencia' : f === 'alerts' ? 'Alertas de desconexión' : f === 'incidents' ? 'Incidencias' : APPROVAL_LABELS[f]}</button>`).join('')}</div>`;
}

const TRIP_INCIDENT_LABELS = {
  driver_conduct: 'Conducta del conductor',
  service_quality: 'Calidad del servicio',
  safety: 'Seguridad',
  lost_item: 'Objeto perdido',
  other: 'Otro',
};

function renderTripIncidents() {
  const incidents = Object.entries(adminTripFeedback)
    .filter(([, feedback]) => feedback?.incidentCategory && feedback.incidentCategory !== 'none')
    .sort(([, a], [, b]) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const openCount = incidents.filter(([, feedback]) => feedback.incidentStatus !== 'RESOLVED').length;
  const rows = incidents.map(([tripId, feedback]) => {
    const trip = adminTripHistory[tripId] || {};
    const resolved = feedback.incidentStatus === 'RESOLVED';
    const action = resolved ? 'reopen' : 'resolve';
    const detail = `
      <details class="incident-detail">
        <summary>Ver detalle completo</summary>
        <div class="incident-detail-grid">
          <span>Viaje</span><b>${escapeHtml(tripId)}</b>
          <span>Estado del viaje</span><b>${escapeHtml(TRIP_STATUS_LABELS[trip.status] || trip.status || feedback.tripStatus || '—')}</b>
          <span>Origen</span><b>${escapeHtml(trip.pickupAddress || '—')}</b>
          <span>Destino</span><b>${escapeHtml(trip.destinationAddress || '—')}</b>
          <span>Pasajero</span><b>${escapeHtml(trip.passengerName || feedback.passengerId || '—')}</b>
          <span>Teléfono pasajero</span><b>${escapeHtml(trip.passengerPhone || '—')}</b>
          <span>Conductor</span><b>${escapeHtml(trip.driverName || adminDriversCache[feedback.driverId]?.name || '—')}</b>
          <span>Placa</span><b>${escapeHtml(trip.driverPlate || adminDriversCache[feedback.driverId]?.plate || '—')}</b>
          <span>Calificación</span><b>${feedback.rating == null ? 'No registrada' : `${escapeHtml(String(feedback.rating))}/5`}</b>
          <span>Comentario</span><b>${escapeHtml(feedback.comment || 'Sin comentario')}</b>
          <span>Detalle reportado</span><b>${escapeHtml(feedback.incidentDetails || 'Sin detalle')}</b>
          <span>Creada</span><b>${escapeHtml(new Date(Number(feedback.createdAt || 0)).toLocaleString('es-PE'))}</b>
          <span>Última actualización</span><b>${escapeHtml(new Date(Number(feedback.updatedAt || 0)).toLocaleString('es-PE'))}</b>
        </div>
      </details>`;
    return `<tr>
      <td>${new Date(Number(feedback.updatedAt || 0)).toLocaleString('es-PE')}</td>
      <td><strong>${escapeHtml(trip.passengerName || feedback.passengerId || 'Pasajero')}</strong><small>Viaje ${escapeHtml(tripId)}</small></td>
      <td><strong>${escapeHtml(trip.driverName || adminDriversCache[feedback.driverId]?.name || 'Sin conductor')}</strong><small>${escapeHtml(trip.driverPlate || adminDriversCache[feedback.driverId]?.plate || '—')}</small></td>
      <td><strong>${escapeHtml(TRIP_INCIDENT_LABELS[feedback.incidentCategory] || feedback.incidentCategory)}</strong><small>${escapeHtml(feedback.incidentDetails || 'Sin detalle')}</small>${detail}</td>
      <td><span class="trip-history-status ${resolved ? 'completed' : 'cancelled'}">${resolved ? 'Resuelta' : 'Abierta'}</span></td>
      <td><button type="button" class="settings-table-action" data-incident-action="${action}" data-trip-id="${escapeHtml(tripId)}">${resolved ? 'Reabrir' : 'Marcar resuelta'}</button></td>
    </tr>`;
  }).join('');

  adminViewEl.innerHTML = `${historyToolbarHtml()}<div class="attendance-heading"><div><h3>Incidencias de pasajeros</h3><p>Reportes posteriores al viaje que requieren seguimiento operativo.</p></div><span class="attendance-count">${openCount} abierta${openCount === 1 ? '' : 's'}</span></div><div class="dashboard-users-table-wrap"><table class="dashboard-users-table"><thead><tr><th>Fecha</th><th>Pasajero / viaje</th><th>Conductor</th><th>Incidencia</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dashboard-empty-row">Todavía no hay incidencias reportadas.</td></tr>'}</tbody></table></div>`;
  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => btn.addEventListener('click', () => {
    adminActiveFilter = btn.getAttribute('data-admin-filter');
    renderDriversAdmin();
  }));
  adminViewEl.querySelectorAll('[data-incident-action]').forEach((button) => button.addEventListener('click', () => {
    manageTripIncident(button.getAttribute('data-trip-id'), button.getAttribute('data-incident-action'), button);
  }));
}

async function manageTripIncident(tripId, action, button) {
  button.disabled = true;
  try {
    const token = await auth.currentUser.getIdToken();
    const endpoint = DRIVER_ADMIN_VPS_API_BASE_URL
      ? `${DRIVER_ADMIN_VPS_API_BASE_URL}/api/v1/dashboard/incidents/${encodeURIComponent(tripId)}`
      : 'https://us-central1-rastreoflota-53052.cloudfunctions.net/manageTripFeedback';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId, action }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || 'No se pudo actualizar la incidencia.');
    if (DRIVER_ADMIN_VPS_API_BASE_URL && result.feedback) {
      adminTripFeedback[tripId] = result.feedback;
      renderTripIncidents();
    }
  } catch (error) {
    button.disabled = false;
    alert(error.message || error);
  }
}

function attendanceSessions() {
  const sessions = window.AttendanceUtils
    ? window.AttendanceUtils.buildSessions(adminConnectionHistory, adminDriversCache)
    : [];
  return sessions.filter((session) => {
    const query = attendanceSearch.trim().toLowerCase();
    if (query && ![session.driverName, session.driverId, adminDriversCache[session.driverId]?.plate].some((value) => String(value || '').toLowerCase().includes(query))) return false;
    const key = attendanceDateKey(session.startAt);
    if (!attendanceDateFilter.from || !attendanceDateFilter.to) return true;
    return key >= attendanceDateFilter.from && key <= attendanceDateFilter.to;
  }).sort((a, b) => b.startAt - a.startAt);
}

function attendanceDateKey(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function attendanceDate(at) {
  return new Date(at).toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function attendanceTime(at, active = false) {
  if (!at) return active ? 'En curso' : 'Sin registro';
  return new Date(at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

function attendanceDuration(startAt, endAt, active = false) {
  if (!endAt) return active ? 'En curso' : 'Sin registro';
  const minutes = Math.max(0, Math.round((endAt - startAt) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h ${String(rest).padStart(2, '0')} min` : `${rest} min`;
}

function attendanceDateLabel(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function localDateInputValue(date = new Date()) {
  return attendanceDateKey(date.getTime());
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localDateInputValue(date);
}

function setAttendanceRange(from, to) {
  attendanceDateFilter = { from, to };
  attendanceHoverDate = '';
  renderDriversAttendance();
}

function markAttendanceStart(date) {
  attendanceDateFilter = { from: date, to: '' };
  attendanceHoverDate = '';
  const label = document.querySelector('#attendance-date-toggle span');
  if (label) label.textContent = `${attendanceDateLabel(date)} - …`;
  document.querySelectorAll('[data-attendance-date]').forEach((button) => {
    button.classList.toggle('selected', button.getAttribute('data-attendance-date') === date);
    button.classList.remove('preview');
  });
}

function attendanceRowsHtml(sessions) {
  return sessions.map((session) => `<tr>
    <td><strong>${escapeHtml(session.driverName)}</strong><small>${escapeHtml(session.driverId)}</small></td>
    <td>${attendanceDate(session.startAt)}</td>
    <td>${attendanceTime(session.startAt)}</td>
    <td>${attendanceTime(session.endAt, session.active)}</td>
    <td>${attendanceDuration(session.startAt, session.endAt, session.active)}</td>
    <td><span class="attendance-status ${session.active ? 'active' : 'closed'}">${session.active ? 'En turno' : 'Turno cerrado'}</span></td>
  </tr>`).join('');
}

function attendanceMonthHtml(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const weekdays = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];
  let cells = weekdays.map((day) => `<span class="attendance-weekday">${day}</span>`).join('');
  for (let index = 0; index < 42; index += 1) {
    const day = index - firstDay + 1;
    if (day < 1 || day > days) {
      cells += '<span class="attendance-day empty"></span>';
      continue;
    }
    const date = new Date(year, month, day);
    const key = localDateInputValue(date);
    const selected = key === attendanceDateFilter.from || key === attendanceDateFilter.to;
    const between = attendanceDateFilter.from && attendanceDateFilter.to && key > attendanceDateFilter.from && key < attendanceDateFilter.to;
    cells += `<button type="button" class="attendance-day${selected ? ' selected' : ''}${between ? ' between' : ''}" data-attendance-date="${key}">${day}</button>`;
  }
  return `<section class="attendance-month"><h4>${monthDate.toLocaleDateString('es-PE', { month: 'short', year: 'numeric' })}</h4><div class="attendance-calendar-grid">${cells}</div></section>`;
}

function attendanceCalendarHtml() {
  const nextMonth = new Date(attendanceCalendarMonth.getFullYear(), attendanceCalendarMonth.getMonth() + 1, 1);
  return `<div class="attendance-calendar-toolbar"><button type="button" id="attendance-calendar-prev" aria-label="Mes anterior">‹</button><strong>${attendanceCalendarMonth.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}</strong><strong>${nextMonth.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}</strong><button type="button" id="attendance-calendar-next" aria-label="Mes siguiente">›</button></div><div class="attendance-calendar-months">${attendanceMonthHtml(attendanceCalendarMonth)}${attendanceMonthHtml(nextMonth)}</div>`;
}

function renderDriversAttendance() {
  const sessions = attendanceSessions();
  const rows = attendanceRowsHtml(sessions);
  adminViewEl.innerHTML = `${historyToolbarHtml()}<div class="attendance-heading"><div><h3>Asistencia de conductores</h3><p>Inicio y término de cada turno registrados por la app.</p></div><span class="attendance-count">${sessions.length} turno${sessions.length === 1 ? '' : 's'}</span></div><div class="dashboard-users-table-wrap attendance-table-wrap"><table class="dashboard-users-table attendance-table"><thead><tr><th>Conductor</th><th>Día</th><th>Inicio de turno</th><th>Término de turno</th><th>Duración</th><th>Estado</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dashboard-empty-row">Todavía no hay turnos registrados.</td></tr>'}</tbody></table></div>`;
  const heading = adminViewEl.querySelector('.attendance-heading');
  const dateLabel = attendanceDateFilter.from || attendanceDateFilter.to
    ? `${attendanceDateLabel(attendanceDateFilter.from) || '…'} - ${attendanceDateLabel(attendanceDateFilter.to) || '…'}`
    : 'Seleccionar fechas';
  heading.insertAdjacentHTML('beforeend', `<div class="attendance-controls"><label class="attendance-search-label">Conductor<input type="search" id="attendance-search" value="${escapeHtml(attendanceSearch)}" placeholder="Nombre o placa..." /></label><div class="attendance-date-picker" id="attendance-date-picker"><button type="button" class="attendance-date-toggle" id="attendance-date-toggle">▣ <span>${dateLabel}</span></button><div class="attendance-date-popover hidden" id="attendance-date-popover"><div class="attendance-presets"><button type="button" data-attendance-preset="today">Hoy</button><button type="button" data-attendance-preset="yesterday">Ayer</button><button type="button" data-attendance-preset="7">Últimos 7 días</button><button type="button" data-attendance-preset="30">Últimos 30 días</button><button type="button" data-attendance-preset="month">Mes actual</button></div><div class="attendance-calendar">${attendanceCalendarHtml()}</div></div></div><button type="button" class="attendance-clear-btn" id="attendance-clear">Limpiar</button></div>`);
  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => btn.addEventListener('click', () => { adminActiveFilter = btn.getAttribute('data-admin-filter'); renderDriversAdmin(); }));
  const dateToggle = document.getElementById('attendance-date-toggle');
  const datePopover = document.getElementById('attendance-date-popover');
  dateToggle.addEventListener('click', () => datePopover.classList.toggle('hidden'));
  const attendanceSearchInput = document.getElementById('attendance-search');
  attendanceSearchInput.addEventListener('input', () => {
    attendanceSearch = attendanceSearchInput.value;
    const filteredSessions = attendanceSessions();
    const tbody = adminViewEl.querySelector('.attendance-table tbody');
    tbody.innerHTML = attendanceRowsHtml(filteredSessions) || '<tr><td colspan="6" class="dashboard-empty-row">Sin resultados para esa búsqueda.</td></tr>';
  });
  if (!attendanceOutsideListenerBound) {
    attendanceOutsideListenerBound = true;
    document.addEventListener('click', (event) => {
      const picker = document.getElementById('attendance-date-picker');
      const popover = document.getElementById('attendance-date-popover');
      if (popover && picker && !picker.contains(event.target)) popover.classList.add('hidden');
    });
  }
  document.getElementById('attendance-calendar-prev').addEventListener('click', () => { attendanceCalendarMonth = new Date(attendanceCalendarMonth.getFullYear(), attendanceCalendarMonth.getMonth() - 1, 1); renderDriversAttendance(); });
  document.getElementById('attendance-calendar-next').addEventListener('click', () => { attendanceCalendarMonth = new Date(attendanceCalendarMonth.getFullYear(), attendanceCalendarMonth.getMonth() + 1, 1); renderDriversAttendance(); });
  adminViewEl.querySelectorAll('[data-attendance-date]').forEach((button) => button.addEventListener('click', () => {
    const date = button.getAttribute('data-attendance-date');
    if (!attendanceDateFilter.from || attendanceDateFilter.to) markAttendanceStart(date);
    else setAttendanceRange(date < attendanceDateFilter.from ? date : attendanceDateFilter.from, date < attendanceDateFilter.from ? attendanceDateFilter.from : date);
  }));
  adminViewEl.querySelectorAll('[data-attendance-date]').forEach((button) => button.addEventListener('dblclick', () => {
    clearTimeout(attendanceClickTimer);
    const date = button.getAttribute('data-attendance-date');
    setAttendanceRange(date, date);
  }));
  const updateDatePreview = (date) => {
    attendanceHoverDate = date;
    const from = attendanceDateFilter.from;
    const to = attendanceDateFilter.to || date;
    const low = from && to ? (from < to ? from : to) : '';
    const high = from && to ? (from < to ? to : from) : '';
    adminViewEl.querySelectorAll('[data-attendance-date]').forEach((button) => {
      const key = button.getAttribute('data-attendance-date');
      button.classList.toggle('preview', Boolean(low && high && key > low && key < high && !attendanceDateFilter.to));
    });
  };
  adminViewEl.querySelectorAll('[data-attendance-date]').forEach((button) => button.addEventListener('mouseenter', () => {
    if (attendanceDateFilter.from && !attendanceDateFilter.to) updateDatePreview(button.getAttribute('data-attendance-date'));
  }));
  document.getElementById('attendance-date-popover').addEventListener('mouseleave', () => {
    if (!attendanceDateFilter.to) {
      attendanceHoverDate = '';
      adminViewEl.querySelectorAll('.attendance-day.preview').forEach((button) => button.classList.remove('preview'));
    }
  });
  adminViewEl.querySelectorAll('[data-attendance-preset]').forEach((button) => button.addEventListener('click', () => {
    const preset = button.getAttribute('data-attendance-preset');
    const today = localDateInputValue();
    if (preset === 'today') setAttendanceRange(today, today);
    else if (preset === 'yesterday') setAttendanceRange(dateDaysAgo(1), dateDaysAgo(1));
    else if (preset === 'month') setAttendanceRange(`${today.slice(0, 8)}01`, today);
    else setAttendanceRange(dateDaysAgo(Number(preset) - 1), today);
  }));
  document.getElementById('attendance-clear').addEventListener('click', () => { attendanceDateFilter = { from: '', to: '' }; renderDriversAttendance(); });
}

const TRIP_HISTORY_STATUS_LABELS = {
  completed: 'Completado',
  cancelled: 'Cancelado',
};

function tripHistoryTimestamp(trip) {
  return Number(trip.completedAt || trip.cancelledAt || trip.archivedAt || trip.requestedAt || 0);
}

function tripHistoryDateKey(trip) {
  return tripHistoryTimestamp(trip) ? attendanceDateKey(tripHistoryTimestamp(trip)) : '';
}

function tripHistoryDriverLabel(driverId, trip) {
  const driver = adminDriversCache[driverId] || {};
  return trip.driverName || driver.name || driverId || 'Sin conductor';
}

function tripHistoryDateRangeLabel() {
  if (!tripHistoryDateFilter && !tripHistoryDateToFilter) return 'Seleccionar fechas';
  return `${attendanceDateLabel(tripHistoryDateFilter) || '\u2026'} - ${attendanceDateLabel(tripHistoryDateToFilter) || '\u2026'}`;
}

function setTripHistoryRange(from, to) {
  tripHistoryDateFilter = from;
  tripHistoryDateToFilter = to || from;
  tripHistoryHoverDate = '';
  renderDriversHistory();
}

function markTripHistoryStart(date) {
  tripHistoryDateFilter = date;
  tripHistoryDateToFilter = '';
  tripHistoryHoverDate = '';
  const label = document.querySelector('#trip-history-date-toggle span');
  if (label) label.textContent = `${attendanceDateLabel(date)} - \u2026`;
  const pdfButton = document.getElementById('trip-history-pdf');
  if (pdfButton) pdfButton.disabled = true;
  document.querySelectorAll('[data-trip-history-date]').forEach((button) => {
    button.classList.toggle('selected', button.getAttribute('data-trip-history-date') === date);
    button.classList.remove('preview');
  });
}

function tripHistoryMonthHtml(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const weekdays = ['lu', 'ma', 'mi', 'ju', 'vi', 's\u00e1', 'do'];
  let cells = weekdays.map((day) => `<span class="attendance-weekday">${day}</span>`).join('');
  for (let index = 0; index < 42; index += 1) {
    const day = index - firstDay + 1;
    if (day < 1 || day > days) {
      cells += '<span class="attendance-day empty"></span>';
      continue;
    }
    const date = new Date(year, month, day);
    const key = localDateInputValue(date);
    const selected = key === tripHistoryDateFilter || key === tripHistoryDateToFilter;
    const low = tripHistoryDateFilter && tripHistoryDateToFilter && tripHistoryDateFilter < tripHistoryDateToFilter ? tripHistoryDateFilter : tripHistoryDateToFilter;
    const high = tripHistoryDateFilter && tripHistoryDateToFilter && tripHistoryDateFilter > tripHistoryDateToFilter ? tripHistoryDateFilter : tripHistoryDateToFilter;
    const between = low && high && key > low && key < high;
    cells += `<button type="button" class="attendance-day${selected ? ' selected' : ''}${between ? ' between' : ''}" data-trip-history-date="${key}">${day}</button>`;
  }
  return `<section class="attendance-month"><h4>${monthDate.toLocaleDateString('es-PE', { month: 'short', year: 'numeric' })}</h4><div class="attendance-calendar-grid">${cells}</div></section>`;
}

function tripHistoryCalendarHtml() {
  const nextMonth = new Date(tripHistoryCalendarMonth.getFullYear(), tripHistoryCalendarMonth.getMonth() + 1, 1);
  return `<div class="attendance-calendar-toolbar"><button type="button" id="trip-history-calendar-prev" aria-label="Mes anterior">\u2039</button><strong>${tripHistoryCalendarMonth.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}</strong><strong>${nextMonth.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}</strong><button type="button" id="trip-history-calendar-next" aria-label="Mes siguiente">\u203a</button></div><div class="attendance-calendar-months">${tripHistoryMonthHtml(tripHistoryCalendarMonth)}${tripHistoryMonthHtml(nextMonth)}</div>`;
}

function tripHistoryEntries() {
  const query = tripHistorySearch.trim().toLowerCase();
  return Object.entries(adminTripHistory)
    .filter(([, trip]) => {
      if (!trip || tripHistoryDriverFilter && trip.driverId !== tripHistoryDriverFilter) return false;
      if (tripHistoryDateFilter) {
        const from = tripHistoryDateToFilter && tripHistoryDateToFilter < tripHistoryDateFilter ? tripHistoryDateToFilter : tripHistoryDateFilter;
        const to = tripHistoryDateToFilter && tripHistoryDateToFilter > tripHistoryDateFilter ? tripHistoryDateToFilter : tripHistoryDateFilter;
        const key = tripHistoryDateKey(trip);
        if (!key || key < from || key > to) return false;
      }
      if (!query) return true;
      const driver = adminDriversCache[trip.driverId] || {};
      return [trip.driverName, trip.driverPlate, driver.name, driver.plate]
        .some((value) => String(value || '').toLowerCase().includes(query));
    })
    .sort(([, a], [, b]) => tripHistoryTimestamp(b) - tripHistoryTimestamp(a));
}

function tripHistoryDriverOptions() {
  const drivers = new Map();
  Object.entries(adminDriversCache).forEach(([driverId, driver]) => {
    drivers.set(driverId, { name: driver.name || driverId, plate: driver.plate || '' });
  });
  Object.values(adminTripHistory).forEach((trip) => {
    if (!trip?.driverId || drivers.has(trip.driverId)) return;
    drivers.set(trip.driverId, { name: trip.driverName || trip.driverId, plate: trip.driverPlate || '' });
  });
  return [...drivers.entries()]
    .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), 'es'))
    .map(([driverId, driver]) => `<option value="${escapeHtml(driverId)}"${tripHistoryDriverFilter === driverId ? ' selected' : ''}>${escapeHtml(driver.name)}${driver.plate ? ` · ${escapeHtml(driver.plate)}` : ''}</option>`)
    .join('');
}

function tripHistoryMapCell(trip) {
  if (!trip.routeSnapshotUrl) return '<span class="trip-history-map-pending">Se genera en PDF</span>';
  return `<a href="${escapeHtml(trip.routeSnapshotUrl)}" target="_blank" rel="noopener" class="trip-history-map-link"><img src="${escapeHtml(trip.routeSnapshotUrl)}" alt="Mapa de la ruta" loading="lazy" /></a>`;
}

function tripHistoryRowsHtml(entries) {
  return entries.map(([id, trip]) => {
    const status = trip.status === 'cancelled' ? 'cancelled' : 'completed';
    const statusLabel = TRIP_HISTORY_STATUS_LABELS[trip.status] || trip.status || 'Archivado';
    const timestamp = tripHistoryTimestamp(trip);
    return `<tr>
      <td>${timestamp ? new Date(timestamp).toLocaleString('es-PE') : '—'}</td>
      <td><strong>${escapeHtml(tripHistoryDriverLabel(trip.driverId, trip))}</strong><small>${escapeHtml(trip.driverPlate || adminDriversCache[trip.driverId]?.plate || '—')}</small></td>
      <td>${escapeHtml(trip.passengerName || '—')}<small>${escapeHtml(trip.passengerCount ? `${trip.passengerCount} pasajero${Number(trip.passengerCount) === 1 ? '' : 's'}` : '')}</small></td>
      <td>${escapeHtml(trip.pickupAddress || '—')}</td>
      <td>${escapeHtml(trip.destinationAddress || '—')}</td>
      <td><span class="trip-history-status ${status}">${escapeHtml(statusLabel)}</span>${trip.cancelReason ? `<small>${escapeHtml(trip.cancelReason)}</small>` : ''}</td>
      <td>${tripHistoryMapCell(trip)}</td>
    </tr>`;
  }).join('');
}

function renderDriversHistory() {
  const isTrips = adminActiveFilter === 'trip-history';
  const tripEntries = isTrips ? tripHistoryEntries() : [];
  const reportReady = Boolean(tripHistoryDriverFilter && tripHistoryDateFilter && tripHistoryDateToFilter);
  const rows = isTrips
    ? tripHistoryRowsHtml(tripEntries)
    : Object.entries(adminConnectionHistory).flatMap(([driverId, events]) => Object.values(events || {}).map((event) => `<tr><td>${new Date(event.at).toLocaleString('es-PE')}</td><td>${escapeHtml(event.driverName || driverId)}</td><td>${event.status === 'online' ? 'Conectado' : 'Desconectado'}</td></tr>`)).join('');
  const toolbar = historyToolbarHtml();
  const controls = isTrips ? `
    <section class="trip-history-report-card">
      <div class="trip-history-report-heading"><div><span class="overview-eyebrow">REPORTE HISTÓRICO</span><h3>Viajes de un conductor</h3><p>Selecciona un conductor y un día para revisar sus viajes y descargar el PDF.</p></div><span class="trip-history-total">${tripEntries.length} viaje${tripEntries.length === 1 ? '' : 's'}</span></div>
      <div class="trip-history-report-controls">
        <label>Conductor<select id="trip-history-driver"><option value="">Seleccionar conductor…</option>${tripHistoryDriverOptions()}</select></label>
        <div class="trip-history-date-field"><span>Día</span><div class="attendance-date-picker" id="trip-history-date-picker"><button type="button" class="attendance-date-toggle" id="trip-history-date-toggle">▣ <span>${tripHistoryDateRangeLabel()}</span></button><div class="attendance-date-popover hidden" id="trip-history-date-popover"><div class="attendance-presets"><button type="button" data-trip-history-preset="today">Hoy</button><button type="button" data-trip-history-preset="yesterday">Ayer</button><button type="button" data-trip-history-preset="7">Últimos 7 días</button><button type="button" data-trip-history-preset="30">Últimos 30 días</button><button type="button" data-trip-history-preset="month">Mes actual</button></div><div class="attendance-calendar">${tripHistoryCalendarHtml()}</div></div></div></div>
        <button type="button" id="trip-history-clear" class="attendance-clear-btn">Limpiar</button>
        <button type="button" id="trip-history-pdf" class="trip-history-pdf-btn"${reportReady ? '' : ' disabled'}>Descargar PDF</button>
      </div>
    </section>
  ` : '';
  adminViewEl.innerHTML = `${toolbar}${controls}<div class="dashboard-users-table-wrap"><table class="dashboard-users-table trip-history-table"><thead><tr>${isTrips ? '<th>Fecha</th><th>Conductor / placa</th><th>Pasajero</th><th>Origen</th><th>Destino</th><th>Estado</th><th>Mapa</th>' : '<th>Fecha</th><th>Conductor</th><th>Evento</th>'}</tr></thead><tbody>${rows || `<tr><td colspan="${isTrips ? 7 : 3}" class="dashboard-empty-row">${isTrips && reportReady ? 'No hay viajes de ese conductor en el día seleccionado.' : 'Selecciona un conductor y un día para preparar el reporte.'}</td></tr>`}</tbody></table></div>`;
  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => btn.addEventListener('click', () => { adminActiveFilter = btn.getAttribute('data-admin-filter'); renderDriversAdmin(); }));
  if (!isTrips) return;
  document.getElementById('trip-history-driver').addEventListener('change', (event) => {
    tripHistoryDriverFilter = event.target.value;
    renderDriversHistory();
  });
  const dateToggle = document.getElementById('trip-history-date-toggle');
  const datePopover = document.getElementById('trip-history-date-popover');
  dateToggle.addEventListener('click', () => datePopover.classList.toggle('hidden'));
  if (!tripHistoryOutsideListenerBound) {
    tripHistoryOutsideListenerBound = true;
    document.addEventListener('click', (event) => {
      const picker = document.getElementById('trip-history-date-picker');
      const popover = document.getElementById('trip-history-date-popover');
      if (popover && picker && !picker.contains(event.target)) popover.classList.add('hidden');
    });
  }
  document.getElementById('trip-history-calendar-prev').addEventListener('click', () => { tripHistoryCalendarMonth = new Date(tripHistoryCalendarMonth.getFullYear(), tripHistoryCalendarMonth.getMonth() - 1, 1); renderDriversHistory(); });
  document.getElementById('trip-history-calendar-next').addEventListener('click', () => { tripHistoryCalendarMonth = new Date(tripHistoryCalendarMonth.getFullYear(), tripHistoryCalendarMonth.getMonth() + 1, 1); renderDriversHistory(); });
  adminViewEl.querySelectorAll('[data-trip-history-date]').forEach((dateButton) => dateButton.addEventListener('click', () => {
    const date = dateButton.getAttribute('data-trip-history-date');
    if (!tripHistoryDateFilter || tripHistoryDateToFilter) markTripHistoryStart(date);
    else setTripHistoryRange(date < tripHistoryDateFilter ? date : tripHistoryDateFilter, date < tripHistoryDateFilter ? tripHistoryDateFilter : date);
  }));
  adminViewEl.querySelectorAll('[data-trip-history-date]').forEach((dateButton) => dateButton.addEventListener('dblclick', () => {
    clearTimeout(tripHistoryClickTimer);
    const date = dateButton.getAttribute('data-trip-history-date');
    setTripHistoryRange(date, date);
  }));
  const updateTripHistoryDatePreview = (date) => {
    tripHistoryHoverDate = date;
    const from = tripHistoryDateFilter;
    const to = tripHistoryDateToFilter || date;
    const low = from && to ? (from < to ? from : to) : '';
    const high = from && to ? (from < to ? to : from) : '';
    adminViewEl.querySelectorAll('[data-trip-history-date]').forEach((dateButton) => {
      const key = dateButton.getAttribute('data-trip-history-date');
      dateButton.classList.toggle('preview', Boolean(low && high && key > low && key < high && !tripHistoryDateToFilter));
    });
  };
  adminViewEl.querySelectorAll('[data-trip-history-date]').forEach((dateButton) => dateButton.addEventListener('mouseenter', () => {
    if (tripHistoryDateFilter && !tripHistoryDateToFilter) updateTripHistoryDatePreview(dateButton.getAttribute('data-trip-history-date'));
  }));
  datePopover.addEventListener('mouseleave', () => {
    if (!tripHistoryDateToFilter) {
      tripHistoryHoverDate = '';
      adminViewEl.querySelectorAll('.attendance-day.preview').forEach((dateButton) => dateButton.classList.remove('preview'));
    }
  });
  adminViewEl.querySelectorAll('[data-trip-history-preset]').forEach((presetButton) => presetButton.addEventListener('click', () => {
    const preset = presetButton.getAttribute('data-trip-history-preset');
    const today = localDateInputValue();
    if (preset === 'today') setTripHistoryRange(today, today);
    else if (preset === 'yesterday') setTripHistoryRange(dateDaysAgo(1), dateDaysAgo(1));
    else if (preset === 'month') setTripHistoryRange(`${today.slice(0, 8)}01`, today);
    else setTripHistoryRange(dateDaysAgo(Number(preset) - 1), today);
  }));
  document.getElementById('trip-history-clear').addEventListener('click', () => { tripHistoryDateFilter = ''; tripHistoryDateToFilter = ''; tripHistoryHoverDate = ''; renderDriversHistory(); });
  document.getElementById('trip-history-pdf').addEventListener('click', (event) => downloadTripHistoryPdfV2(event.currentTarget));
}

function dashboardMapboxToken() {
  return window.DASHBOARD_MAP_CONFIG?.accessToken || window.__MAPBOX_ACCESS_TOKEN__ || '';
}

function tripSnapshotPoint(lat, lng) {
  const point = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90
    && point.lng >= -180 && point.lng <= 180
    ? point
    : null;
}

function tripSnapshotRoutePath(trip) {
  const raw = trip.routePath;
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((key) => raw[key])
      : [];
  return values.map((point) => {
    if (Array.isArray(point)) return tripSnapshotPoint(point[0], point[1]);
    return tripSnapshotPoint(point?.lat, point?.lng);
  }).filter(Boolean);
}

function tripStaticMapUrl(trip, routePath) {
  const token = dashboardMapboxToken();
  const pickup = tripSnapshotPoint(trip.pickupLat, trip.pickupLng);
  const destination = tripSnapshotPoint(trip.destinationLat, trip.destinationLng);
  if (!token || !pickup || !destination || routePath.length < 2) return null;
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
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/auto/900x520@2x?access_token=${encodeURIComponent(token)}`;
}

async function tripHistorySnapshot(trip) {
  if (trip.routeSnapshotUrl) {
    return {
      url: trip.routeSnapshotUrl,
      routeDistanceMeters: Number.isFinite(Number(trip.routeDistanceMeters)) ? Number(trip.routeDistanceMeters) : null,
    };
  }
  const pickup = tripSnapshotPoint(trip.pickupLat, trip.pickupLng);
  const destination = tripSnapshotPoint(trip.destinationLat, trip.destinationLng);
  let routePath = tripSnapshotRoutePath(trip);
  let routeDistanceMeters = Number.isFinite(Number(trip.routeDistanceMeters)) ? Number(trip.routeDistanceMeters) : null;
  if (routePath.length < 2 && pickup && destination && dashboardMapboxToken()) {
    const coordinates = `${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}`;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?overview=full&geometries=geojson&access_token=${encodeURIComponent(dashboardMapboxToken())}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (response.ok) {
        const route = (await response.json()).routes?.[0];
        routeDistanceMeters = Number.isFinite(Number(route?.distance)) ? Number(route.distance) : routeDistanceMeters;
        routePath = (route?.geometry?.coordinates || [])
          .map((point) => tripSnapshotPoint(point?.[1], point?.[0]))
          .filter(Boolean);
      }
    } catch (_) {
      // El reporte sigue siendo valido aunque el proveedor de mapas falle.
    }
  }
  const snapshotUrl = tripStaticMapUrl(trip, routePath);
  return snapshotUrl ? { url: snapshotUrl, routePath, routeDistanceMeters } : null;
}

function pdfTripStatusColor(doc, status) {
  if (status === 'cancelled') {
    doc.setFillColor(254, 238, 237);
    doc.setTextColor(182, 72, 66);
  } else {
    doc.setFillColor(232, 248, 239);
    doc.setTextColor(0, 135, 74);
  }
}

function pdfTripStatusLabel(status) {
  return TRIP_HISTORY_STATUS_LABELS[status] || status || 'Archivado';
}

async function downloadTripHistoryPdfV2(button) {
  const driverId = tripHistoryDriverFilter;
  const dateKey = tripHistoryDateFilter;
  const dateToKey = tripHistoryDateToFilter || dateKey;
  if (!driverId || !dateKey) {
    alert('Selecciona un conductor y un d\u00eda para generar el PDF.');
    return;
  }
  const entries = tripHistoryEntries();
  if (!entries.length) {
    alert('No hay viajes de ese conductor en el d\u00eda seleccionado.');
    return;
  }

  const driver = adminDriversCache[driverId] || {};
  const driverName = driver.name || entries[0][1].driverName || driverId;
  const driverPlate = driver.plate || entries[0][1].driverPlate || '\u2014';
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando PDF\u2026';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 36;
    const contentWidth = pageWidth - margin * 2;
    const reportDate = dateKey === dateToKey
      ? attendanceDateLabel(dateKey)
      : `${attendanceDateLabel(dateKey)} - ${attendanceDateLabel(dateToKey)}`;
    const navy = [10, 38, 73];
    const dark = [14, 29, 50];
    const muted = [82, 101, 121];
    const border = [214, 223, 231];
    const greenBorder = [72, 143, 111];
    const snapshots = new Map();
    let logoDataUrl = null;

    for (const [tripId, trip] of entries) {
      snapshots.set(tripId, await tripHistorySnapshot(trip));
    }
    try {
      logoDataUrl = await fetchAsDataUrl('assets/apl-mark.png');
    } catch (_) {
      // El texto de marca se mantiene aunque el PNG no pueda cargarse.
    }

    const tripTime = (trip) => {
      const timestamp = tripHistoryTimestamp(trip);
      return timestamp
        ? new Date(timestamp).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
        : '\u2014';
    };
    const tripStatus = (trip) => pdfTripStatusLabel(trip.status).toUpperCase();
    const totalKm = entries.reduce((sum, [tripId, trip]) => {
      return sum + (Number(trip.routeDistanceMeters) || Number(snapshots.get(tripId)?.routeDistanceMeters) || 0);
    }, 0) / 1000;
    const completed = entries.filter(([, trip]) => trip.status === 'completed').length;
    const cancelled = entries.filter(([, trip]) => trip.status === 'cancelled').length;

    const drawBrandHeader = () => {
      doc.setFillColor(255, 255, 255);
      doc.rect(0, 0, pageWidth, 74, 'F');
      doc.setDrawColor(222, 229, 235);
      doc.setLineWidth(0.8);
      doc.line(margin, 72, pageWidth - margin, 72);
      if (logoDataUrl) {
        doc.addImage(logoDataUrl, 'PNG', margin, 16, 42, 42);
      } else {
        doc.setFillColor(...navy);
        doc.roundedRect(margin, 16, 42, 42, 8, 8, 'F');
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(19);
      doc.setTextColor(...navy);
      doc.text('APL', margin + 52, 34);
      doc.setFontSize(8);
      doc.setTextColor(33, 143, 143);
      doc.text('LOGISTICS', margin + 53, 47);
      doc.setFontSize(22);
      doc.setTextColor(...navy);
      doc.text('REPORTE DE VIAJES', pageWidth - margin, 43, { align: 'right' });
    };

    const drawIdentityStrip = () => {
      const y = 86;
      doc.setFillColor(244, 247, 251);
      doc.setDrawColor(218, 227, 236);
      doc.roundedRect(margin, y, contentWidth, 38, 7, 7, 'FD');
      doc.setFillColor(...navy);
      doc.circle(margin + 22, y + 19, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('i', margin + 22, y + 22, { align: 'center' });
      doc.setTextColor(...dark);
      doc.setFontSize(10);
      doc.text('Conductor:', margin + 39, y + 23);
      doc.setFont('helvetica', 'normal');
      doc.text(String(driverName), margin + 98, y + 23);
      doc.setDrawColor(182, 193, 204);
      doc.line(pageWidth / 2, y + 8, pageWidth / 2, y + 30);
      doc.setFont('helvetica', 'bold');
      doc.text('Fecha:', pageWidth / 2 + 18, y + 23);
      doc.setFont('helvetica', 'normal');
      doc.text(String(reportDate), pageWidth / 2 + 58, y + 23);
      doc.setTextColor(...muted);
      doc.setFontSize(8);
      doc.text(`Placa ${driverPlate}`, pageWidth - margin - 10, y + 11, { align: 'right' });
    };

    const drawSectionBar = (label) => {
      const y = 214;
      doc.setFillColor(...navy);
      doc.roundedRect(margin, y, contentWidth, 27, 6, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(label, margin + 11, y + 18);
      return y + 27;
    };

    const drawSummaryCard = (x, y, width, label, value, fill, accent, symbol) => {
      doc.setFillColor(...fill);
      doc.setDrawColor(222, 228, 234);
      doc.roundedRect(x, y, width, 62, 9, 9, 'FD');
      doc.setFillColor(...accent);
      doc.circle(x + 28, y + 31, 14, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(symbol === 'km' ? 10 : 14);
      doc.text(symbol === 'km' ? 'km' : symbol, x + 28, y + 35, { align: 'center' });
      doc.setTextColor(...navy);
      doc.setFontSize(8);
      doc.text(label, x + 51, y + 21);
      doc.setFontSize(20);
      doc.text(value, x + 51, y + 46);
    };

    const drawTableCell = (value, x, y, width, height, bold = false) => {
      doc.setTextColor(...dark);
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(7.4);
      const lines = doc.splitTextToSize(String(value || '\u2014'), width - 10).slice(0, 2);
      doc.text(lines, x + 5, y + (lines.length > 1 ? 12 : 17));
      doc.setDrawColor(224, 230, 235);
      doc.rect(x, y, width, height);
    };

    const drawSummaryPage = () => {
      drawBrandHeader();
      drawIdentityStrip();
      const gap = 8;
      const cardWidth = (contentWidth - gap * 3) / 4;
      const summaryY = 137;
      drawSummaryCard(margin, summaryY, cardWidth, 'VIAJES', String(entries.length), [235, 245, 253], [39, 111, 190], '\u25A0');
      drawSummaryCard(margin + cardWidth + gap, summaryY, cardWidth, 'COMPLETADOS', String(completed), [235, 249, 239], [51, 157, 81], '\u2713');
      drawSummaryCard(margin + (cardWidth + gap) * 2, summaryY, cardWidth, 'CANCELADOS', String(cancelled), [254, 239, 239], [210, 57, 57], '\u00D7');
      drawSummaryCard(margin + (cardWidth + gap) * 3, summaryY, cardWidth, 'KM TOTALES', totalKm ? totalKm.toFixed(1) : '\u2014', [235, 249, 249], [35, 145, 145], 'km');

      const tableTop = drawSectionBar('Detalle de viajes del d\u00eda');
      const columns = [
        ['Hora', 54],
        ['Origen', 130],
        ['Destino', 130],
        ['Pasajero', 100],
        ['Estado', contentWidth - 414],
      ];
      let x = margin;
      const headHeight = 25;
      doc.setFillColor(22, 54, 91);
      doc.rect(margin, tableTop, contentWidth, headHeight, 'F');
      columns.forEach(([label, width]) => {
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(label, x + 7, tableTop + 16);
        x += width;
      });
      entries.forEach(([, trip], rowIndex) => {
        const y = tableTop + headHeight + rowIndex * 35;
        if (rowIndex % 2 === 0) {
          doc.setFillColor(249, 251, 253);
          doc.rect(margin, y, contentWidth, 35, 'F');
        }
        x = margin;
        const values = [tripTime(trip), trip.pickupAddress, trip.destinationAddress, trip.passengerName];
        columns.slice(0, 4).forEach(([_, width], index) => {
          drawTableCell(values[index], x, y, width, 35);
          x += width;
        });
        const statusWidth = columns[4][1];
        drawTableCell('', x, y, statusWidth, 35);
        pdfTripStatusColor(doc, trip.status);
        const pillWidth = Math.min(statusWidth - 12, 84);
        doc.roundedRect(x + 6, y + 9, pillWidth, 17, 8, 8, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.text(tripStatus(trip), x + 6 + pillWidth / 2, y + 20, { align: 'center' });
      });
    };

    const drawTripCard = async (tripIndex, tripId, trip, x, y, width, height) => {
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...greenBorder);
      doc.setLineWidth(1.1);
      doc.roundedRect(x, y, width, height, 8, 8, 'FD');
      doc.setFillColor(trip.status === 'cancelled' ? 213 : 48, trip.status === 'cancelled' ? 63 : 151, trip.status === 'cancelled' ? 63 : 83);
      doc.circle(x + 20, y + 21, 9, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(trip.status === 'cancelled' ? '\u00D7' : '\u2713', x + 20, y + 25, { align: 'center' });
      doc.setTextColor(...navy);
      doc.setFontSize(12);
      doc.text(`Viaje ${tripIndex + 1}`, x + 36, y + 25);
      doc.setTextColor(trip.status === 'cancelled' ? 188 : 40, trip.status === 'cancelled' ? 57 : 120, trip.status === 'cancelled' ? 57 : 72);
      doc.text(`\u00B7 ${tripStatus(trip)}`, x + 96, y + 25);
      doc.setDrawColor(220, 227, 232);
      doc.setLineWidth(0.7);
      doc.line(x + 12, y + 38, x + width - 12, y + 38);

      const columnWidth = (width - 40) / 2;
      const leftX = x + 18;
      const rightX = x + width / 2 + 2;
      const labelsY = y + 57;
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(34, 113, 183);
      doc.text('ORIGEN', leftX + 12, labelsY);
      doc.setTextColor(113, 72, 168);
      doc.text('DESTINO', rightX + 12, labelsY);
      doc.setFillColor(34, 113, 183);
      doc.circle(leftX + 4, labelsY - 3, 4, 'F');
      doc.setFillColor(113, 72, 168);
      doc.circle(rightX + 4, labelsY - 3, 4, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.7);
      doc.setTextColor(...dark);
      doc.text(doc.splitTextToSize(trip.pickupAddress || '\u2014', columnWidth - 12).slice(0, 2), leftX, labelsY + 14);
      doc.text(doc.splitTextToSize(trip.destinationAddress || '\u2014', columnWidth - 12).slice(0, 2), rightX, labelsY + 14);
      doc.setTextColor(...muted);
      doc.setFontSize(7.5);
      doc.text(tripTime(trip), leftX, labelsY + 34);
      doc.text(trip.passengerName ? `Pasajero: ${trip.passengerName}` : '\u2014', rightX, labelsY + 34);

      const mapX = x + 10;
      const mapY = y + 101;
      const mapWidth = width - 20;
      const mapHeight = height - 119;
      doc.setFillColor(239, 245, 242);
      doc.roundedRect(mapX, mapY, mapWidth, mapHeight, 5, 5, 'F');
      const snapshot = snapshots.get(tripId);
      if (snapshot?.url) {
        try {
          const dataUrl = await fetchAsDataUrl(snapshot.url);
          const props = doc.getImageProperties(dataUrl);
          const scale = Math.min(mapWidth / props.width, mapHeight / props.height);
          const imageWidth = props.width * scale;
          const imageHeight = props.height * scale;
          doc.addImage(dataUrl, props.fileType || 'PNG', mapX + (mapWidth - imageWidth) / 2, mapY + (mapHeight - imageHeight) / 2, imageWidth, imageHeight);
        } catch (_) {
          doc.setTextColor(...muted);
          doc.setFontSize(8);
          doc.text('Mapa no disponible', mapX + mapWidth / 2, mapY + mapHeight / 2, { align: 'center' });
        }
      } else {
        doc.setTextColor(...muted);
        doc.setFontSize(8);
        doc.text('No hay imagen de ruta guardada', mapX + mapWidth / 2, mapY + mapHeight / 2, { align: 'center' });
      }
      doc.setDrawColor(207, 217, 212);
      doc.roundedRect(mapX, mapY, mapWidth, mapHeight, 5, 5, 'S');
      doc.setTextColor(...muted);
      doc.setFontSize(7.2);
      const note = trip.status === 'cancelled' && trip.cancelReason
        ? `Motivo: ${trip.cancelReason}`
        : 'Ruta registrada al finalizar el viaje';
      doc.text(doc.splitTextToSize(note, mapWidth - 8).slice(0, 1), mapX + 4, y + height - 8);
    };

    const drawFooter = () => {
      const pageCount = doc.getNumberOfPages();
      for (let page = 1; page <= pageCount; page += 1) {
        doc.setPage(page);
        doc.setDrawColor(220, 228, 234);
        doc.setLineWidth(0.7);
        doc.line(margin, pageHeight - 28, pageWidth - margin, pageHeight - 28);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...muted);
        doc.text('Generado por Operaciones', margin, pageHeight - 14);
        doc.text(`P\u00e1gina ${page} de ${pageCount}`, pageWidth - margin, pageHeight - 14, { align: 'right' });
      }
    };

    drawSummaryPage();
    const detailCardHeight = 304;
    const detailCardWidth = contentWidth;
    for (let groupStart = 0; groupStart < entries.length; groupStart += 2) {
      doc.addPage();
      drawBrandHeader();
      drawIdentityStrip();
      const sectionY = 132;
      doc.setFillColor(...navy);
      doc.roundedRect(margin, sectionY, contentWidth, 27, 6, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Detalle de viajes del d\u00eda \u00B7 2 viajes por hoja', margin + 11, sectionY + 18);
      const firstY = 171;
      for (let offset = 0; offset < 2 && groupStart + offset < entries.length; offset += 1) {
        const [tripId, trip] = entries[groupStart + offset];
        await drawTripCard(groupStart + offset, tripId, trip, margin, firstY + offset * (detailCardHeight + 12), detailCardWidth, detailCardHeight);
      }
    }

    drawFooter();
    const slug = (value) => String(value || '').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
    const fileDate = dateKey === dateToKey ? dateKey : `${dateKey}_a_${dateToKey}`;
    doc.save(`reporte_viajes_${slug(driverName)}_${fileDate}.pdf`);
  } catch (error) {
    alert(`No se pudo generar el PDF: ${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function downloadTripHistoryPdf(button) {
  const driverId = tripHistoryDriverFilter;
  const dateKey = tripHistoryDateFilter;
  if (!driverId || !dateKey) {
    alert('Selecciona un conductor y un día para generar el PDF.');
    return;
  }
  const entries = tripHistoryEntries();
  if (!entries.length) {
    alert('No hay viajes de ese conductor en el día seleccionado.');
    return;
  }
  const driver = adminDriversCache[driverId] || {};
  const driverName = driver.name || entries[0][1].driverName || driverId;
  const driverPlate = driver.plate || entries[0][1].driverPlate || '—';
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando PDF…';

  try {
    const { jsPDF } = window.jspdf;
    const snapshots = new Map();
    for (const [tripId, trip] of entries) {
      snapshots.set(tripId, await tripHistorySnapshot(trip));
    }
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 36;
    const contentWidth = pageWidth - margin * 2;
    const reportDate = attendanceDateLabel(dateKey);
    const completed = entries.filter(([, trip]) => trip.status === 'completed').length;
    const cancelled = entries.filter(([, trip]) => trip.status === 'cancelled').length;
    const totalKm = entries.reduce((sum, [tripId, trip]) => {
      return sum + (Number(trip.routeDistanceMeters) || Number(snapshots.get(tripId)?.routeDistanceMeters) || 0);
    }, 0) / 1000;

    const drawPageHeader = (title = 'REPORTE DE VIAJES') => {
      doc.setFillColor(8, 22, 24);
      doc.rect(0, 0, pageWidth, 74, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.setFont(undefined, 'bold');
      doc.text('APL LOGISTICS', margin, 27);
      doc.setFontSize(20);
      doc.text(title, margin, 54);
      doc.setFontSize(9);
      doc.setFont(undefined, 'normal');
      doc.text(`Generado ${new Date().toLocaleString('es-PE')}`, pageWidth - margin, 27, { align: 'right' });
      doc.setTextColor(8, 22, 24);
    };

    const drawFooter = () => {
      const pageCount = doc.getNumberOfPages();
      for (let page = 1; page <= pageCount; page += 1) {
        doc.setPage(page);
        doc.setDrawColor(220, 230, 225);
        doc.line(margin, pageHeight - 27, pageWidth - margin, pageHeight - 27);
        doc.setFontSize(8);
        doc.setTextColor(105, 125, 119);
        doc.text('Operaciones · Historial de viajes', margin, pageHeight - 13);
        doc.text(`Página ${page} de ${pageCount}`, pageWidth - margin, pageHeight - 13, { align: 'right' });
      }
    };

    drawPageHeader();
    let y = 105;
    doc.setFontSize(15);
    doc.setFont(undefined, 'bold');
    doc.text(`Conductor: ${driverName}`, margin, y);
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(91, 111, 104);
    doc.text(`Placa: ${driverPlate}   ·   Día: ${reportDate}`, margin, y + 18);
    doc.setTextColor(8, 22, 24);
    y += 52;

    const summary = [
      ['VIAJES', String(entries.length), [223, 237, 250]],
      ['COMPLETADOS', String(completed), [232, 248, 239]],
      ['CANCELADOS', String(cancelled), [254, 238, 237]],
      ['KM TOTALES', totalKm ? totalKm.toFixed(1) : '—', [232, 247, 247]],
    ];
    const gap = 8;
    const cardWidth = (contentWidth - gap * 3) / 4;
    summary.forEach(([label, value, color], index) => {
      const x = margin + index * (cardWidth + gap);
      doc.setFillColor(...color);
      doc.roundedRect(x, y, cardWidth, 62, 10, 10, 'F');
      doc.setTextColor(82, 104, 97);
      doc.setFontSize(8);
      doc.setFont(undefined, 'bold');
      doc.text(label, x + 10, y + 18);
      doc.setTextColor(8, 22, 24);
      doc.setFontSize(20);
      doc.text(value, x + 10, y + 45);
    });
    y += 88;

    doc.setFillColor(8, 35, 67);
    doc.roundedRect(margin, y, contentWidth, 26, 6, 6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text('Detalle de viajes del día', margin + 10, y + 17);
    y += 26;
    const columns = [
      ['Hora', 52], ['Origen', 112], ['Destino', 112], ['Pasajero', 82], ['Estado', 80], ['Mapa', 85],
    ];
    let x = margin;
    doc.setFillColor(241, 246, 243);
    doc.rect(margin, y, contentWidth, 24, 'F');
    columns.forEach(([label, width]) => {
      doc.setTextColor(72, 94, 87);
      doc.setFontSize(8);
      doc.text(label, x + 6, y + 15);
      x += width;
    });
    y += 24;
    entries.forEach(([, trip], rowIndex) => {
      if (y > pageHeight - 90) {
        doc.addPage();
        drawPageHeader('DETALLE DE VIAJES');
        y = 105;
      }
      if (rowIndex % 2 === 0) {
        doc.setFillColor(250, 252, 251);
        doc.rect(margin, y, contentWidth, 38, 'F');
      }
      const rowValues = [
        tripHistoryTimestamp(trip) ? new Date(tripHistoryTimestamp(trip)).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '—',
        trip.pickupAddress || '—',
        trip.destinationAddress || '—',
        trip.passengerName || '—',
      ];
      x = margin;
      [52, 112, 112, 82].forEach((width, index) => {
        doc.setTextColor(37, 55, 50);
        doc.setFontSize(7.5);
        const lines = doc.splitTextToSize(String(rowValues[index]), width - 10).slice(0, 2);
        doc.text(lines, x + 6, y + 14);
        x += width;
      });
      pdfTripStatusColor(doc, trip.status);
      doc.roundedRect(x + 5, y + 9, 67, 17, 8, 8, 'F');
      doc.setFontSize(7);
      doc.text(pdfTripStatusLabel(trip.status), x + 38.5, y + 20, { align: 'center' });
      x += 80;
      doc.setTextColor(37, 55, 50);
      doc.setFontSize(7.5);
      doc.text(trip.routeSnapshotUrl || trip.routePath ? 'Incluido' : 'Al generar', x + 6, y + 19);
      y += 38;
    });

    for (let index = 0; index < entries.length; index += 1) {
      const [tripId, trip] = entries[index];
      doc.addPage();
      drawPageHeader(`VIAJE ${index + 1} · ${pdfTripStatusLabel(trip.status).toUpperCase()}`);
      y = 105;
      pdfTripStatusColor(doc, trip.status);
      doc.roundedRect(margin, y, 92, 21, 10, 10, 'F');
      doc.setFontSize(9);
      doc.text(pdfTripStatusLabel(trip.status), margin + 46, y + 14, { align: 'center' });
      y += 42;
      doc.setTextColor(8, 22, 24);
      doc.setFontSize(11);
      doc.setFont(undefined, 'bold');
      doc.text(`Viaje ${String(tripId).slice(-8)}`, margin, y);
      doc.setFont(undefined, 'normal');
      doc.setFontSize(9);
      doc.setTextColor(75, 96, 89);
      doc.text(`Hora: ${tripHistoryTimestamp(trip) ? new Date(tripHistoryTimestamp(trip)).toLocaleTimeString('es-PE') : '—'}   ·   Pasajero: ${trip.passengerName || '—'}   ·   Pasajeros: ${trip.passengerCount || 1}`, margin, y + 17);
      y += 48;
      doc.setTextColor(8, 22, 24);
      doc.setFontSize(9);
      doc.setFont(undefined, 'bold');
      doc.text('ORIGEN', margin, y);
      doc.text('DESTINO', pageWidth / 2, y);
      doc.setFont(undefined, 'normal');
      doc.setTextColor(45, 64, 58);
      doc.text(doc.splitTextToSize(trip.pickupAddress || '—', pageWidth / 2 - margin - 16).slice(0, 2), margin, y + 16);
      doc.text(doc.splitTextToSize(trip.destinationAddress || '—', pageWidth / 2 - margin - 16).slice(0, 2), pageWidth / 2, y + 16);
      y += 58;
      if (trip.cancelReason) {
        doc.setTextColor(182, 72, 66);
        doc.text(`Motivo: ${trip.cancelReason}`, margin, y);
        y += 24;
      }
      const snapshot = snapshots.get(tripId) || null;
      if (snapshot?.url) {
        try {
          const dataUrl = await fetchAsDataUrl(snapshot.url);
          const props = doc.getImageProperties(dataUrl);
          const maxWidth = contentWidth;
          const maxHeight = pageHeight - y - 78;
          const scale = Math.min(maxWidth / props.width, maxHeight / props.height);
          const width = props.width * scale;
          const height = props.height * scale;
          doc.addImage(dataUrl, props.fileType || 'JPEG', margin, y, width, height);
          y += height + 18;
        } catch (_) {
          doc.setFillColor(242, 247, 244);
          doc.roundedRect(margin, y, contentWidth, 220, 10, 10, 'F');
          doc.setTextColor(90, 112, 103);
          doc.setFontSize(10);
          doc.text('No se pudo cargar la imagen guardada del mapa.', pageWidth / 2, y + 110, { align: 'center' });
          y += 238;
        }
      } else {
        doc.setFillColor(242, 247, 244);
        doc.roundedRect(margin, y, contentWidth, 220, 10, 10, 'F');
        doc.setTextColor(90, 112, 103);
        doc.setFontSize(10);
        doc.text('No hay geometría de ruta disponible para este viaje.', pageWidth / 2, y + 105, { align: 'center' });
        y += 238;
      }
      doc.setTextColor(90, 112, 103);
      doc.setFontSize(9);
      doc.text('Ruta registrada al finalizar el viaje · Los puntos azules y violetas indican origen y destino.', margin, Math.min(y, pageHeight - 48));
    }

    drawFooter();
    const slug = (value) => String(value || '').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
    doc.save(`reporte_viajes_${slug(driverName)}_${dateKey}.pdf`);
  } catch (error) {
    alert(`No se pudo generar el PDF: ${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function renderPrematureDisconnectHistory() {
  const alerts = typeof window.operationAlertsForHistory === 'function'
    ? window.operationAlertsForHistory()
    : [];
  const rows = alerts
    .sort((a, b) => Number(b.disconnectedAt || b.createdAt || 0) - Number(a.disconnectedAt || a.createdAt || 0))
    .map((alert) => `<tr>
      <td>${new Date(Number(alert.disconnectedAt || alert.createdAt)).toLocaleString('es-PE')}</td>
      <td><strong>${escapeHtml(alert.driverName || alert.driverId || '-')}</strong><small>${escapeHtml(alert.driverPlate || '-')}</small></td>
      <td>${escapeHtml(alert.reasonLabel || (alert.reason === 'HEARTBEAT' ? 'Pérdida de señal / heartbeat' : alert.reason === 'ADMIN' ? 'Desconexión administrativa' : 'Desconexión manual'))}</td>
      <td><span class="attendance-status ${alert.status === 'CLOSED' ? 'closed' : 'active'}">${alert.status === 'CLOSED' ? 'Reconocida' : 'Abierta'}</span></td>
    </tr>`).join('');
  adminViewEl.innerHTML = `${historyToolbarHtml()}<div class="attendance-heading"><div><h3>Historial de desconexiones</h3><p>Todo cierre manual, administrativo o pérdida de señal queda registrado para auditoría.</p></div><span class="attendance-count">${alerts.length} alerta${alerts.length === 1 ? '' : 's'}</span></div><div class="dashboard-users-table-wrap"><table class="dashboard-users-table"><thead><tr><th>Fecha y hora</th><th>Conductor / placa</th><th>Motivo</th><th>Estado</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="dashboard-empty-row">Todavía no hay alertas registradas.</td></tr>'}</tbody></table></div>`;
  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => btn.addEventListener('click', () => {
    adminActiveFilter = btn.getAttribute('data-admin-filter');
    renderDriversAdmin();
  }));
}

async function manageDriver(payload) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch('https://us-central1-rastreoflota-53052.cloudfunctions.net/manageDrivers', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'No se pudo administrar el conductor.');
  return result;
}

async function assignDriverPlace(driverId) {
  const value = document.querySelector(`[data-place-select="${driverId}"]`).value;
  if (!value) return alert('Selecciona un hotel o sede deportiva.');
  const [type, name] = value.split('|');
  try { await manageDriver({ action: 'assignPlace', driverId, place: { type, name } }); } catch (error) { alert(error.message); }
}

async function deleteDriver(driverId) {
  const driver = adminDriversCache[driverId];
  if (!driver || !confirm(`¿Eliminar definitivamente a ${driver.name || 'este conductor'}?`)) return;
  try {
    const result = await manageDriver({ action: 'delete', driverId });
    if (!result.authDeleted) {
      alert('Se eliminó el perfil, pero la cuenta de acceso ya no estaba disponible. Verifica Authentication si el correo continúa bloqueado.');
    }
  } catch (error) { alert(error.message); }
}

async function approveDriver(driverId) {
  try {
    await manageDriver({ action: 'approve', driverId });
  } catch (error) {
    alert(error.message || 'No se pudo aprobar al conductor.');
  }
}

async function suspendDriver(driverId) {
  const reason = prompt('Motivo de suspensión (quedará auditado):');
  if (reason == null) return;
  if (reason.trim().length < 5) return alert('Escribe un motivo de al menos 5 caracteres.');
  try {
    await manageDriver({ action: 'suspend', driverId, reason: reason.trim() });
  } catch (error) {
    alert(error.message || 'No se pudo suspender al conductor.');
  }
}

async function reinstateDriver(driverId) {
  if (!confirm('¿Reactivar a este conductor?')) return;
  try {
    await manageDriver({ action: 'reinstate', driverId });
  } catch (error) {
    alert(error.message || 'No se pudo reactivar al conductor.');
  }
}

async function rejectDriver(driverId, reason, rejectionFields) {
  try {
    await manageDriver({
      action: 'reject',
      driverId,
      reason,
      rejectionFields,
    });
    openRejectFormId = null;
  } catch (error) {
    alert(error.message);
  }
}

// ---------------------------------------------------------------------------
// "Ver archivo completo": genera un PDF con todos los datos del conductor y
// CADA documento incrustado como imagen (las fotos tal cual, y los PDFs
// subidos -SOAT, licencia, etc.- renderizados a imagen con pdf.js) para que
// todo se vea de un vistazo, sin tener que abrir archivos aparte.
// ---------------------------------------------------------------------------

async function fetchAsDataUrl(url) {
  // cache: 'no-store' evita que una respuesta cacheada sin CORS (de una
  // carga previa como <img>, sin modo 'cors') bloquee este fetch.
  const response = await fetch(url, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Descarga un PDF subido como documento y dibuja su primera pagina en un
// canvas, devolviendo esa imagen como data URL (mismo formato que
// fetchAsDataUrl) para poder incrustarla igual que una foto.
async function renderPdfFirstPageAsDataUrl(url) {
  const response = await fetch(url, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function documentAsDataUrl(url) {
  return isPdfUrl(url) ? renderPdfFirstPageAsDataUrl(url) : fetchAsDataUrl(url);
}

async function downloadDriverPdf(button) {
  const driverId = button.getAttribute('data-id');
  const d = adminDriversCache[driverId];
  if (!d) return;

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando PDF...';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    let y = margin;

    function ensureSpace(height) {
      if (y + height > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    }

    const status = d.suspended === true
      ? 'suspended'
      : (d.approvalStatus || 'pending_review');

    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text(d.name || 'Conductor', margin, y);
    y += 22;

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(100);
    doc.text(`Estado: ${APPROVAL_LABELS[status] || status}`, margin, y);
    y += 24;
    doc.setTextColor(0);

    const safeProfilePhotoUrl = safeDriverStorageUrl(d.profilePhotoUrl, driverId);
    if (safeProfilePhotoUrl) {
      try {
        const dataUrl = await fetchAsDataUrl(safeProfilePhotoUrl);
        const props = doc.getImageProperties(dataUrl);
        const w = 90;
        const h = (props.height / props.width) * w;
        doc.addImage(dataUrl, props.fileType || 'JPEG', pageWidth - margin - w, margin, w, h);
      } catch (e) {
        // Sin foto de perfil legible: se omite, el resto del PDF sigue igual.
        console.error('No se pudo cargar la foto de perfil:', e);
      }
    }

    const fields = [
      ['Correo', d.email],
      ['DNI', d.dni],
      ['Teléfono', d.phone],
      ['Placa', d.plate],
      ['Edad', d.age != null ? String(d.age) : null],
      ['Marca vehiculo', d.vehicleBrand],
      ['Tipo de vehiculo', d.vehicleType],
      ['Color del vehiculo', d.vehicleColor],
      ['Pasajeros', d.vehicleSeats != null ? `${d.vehicleSeats} pasajeros` : null],
      ['Estado operativo', d.status || 'Desconectado'],
      ['Registrado', d.registeredAt ? new Date(d.registeredAt).toLocaleString() : null],
      ['Documentos enviados', d.documentsSubmittedAt ? new Date(d.documentsSubmittedAt).toLocaleString() : null],
      ['Licencia vence', d.licenseExpiresAt ? new Date(d.licenseExpiresAt).toLocaleDateString('es-PE') : null],
      ['SOAT vence', d.soatExpiresAt ? new Date(d.soatExpiresAt).toLocaleDateString('es-PE') : null],
      ['Revisión técnica vence', d.technicalReviewExpiresAt ? new Date(d.technicalReviewExpiresAt).toLocaleDateString('es-PE') : null],
      ['Revisado', d.reviewedAt ? new Date(d.reviewedAt).toLocaleString() : null],
      ['Revisado por', d.reviewedBy || null],
    ];
    if (status === 'rejected' && d.rejectionReason) {
      fields.push(['Motivo de rechazo', d.rejectionReason]);
    }

    doc.setFontSize(11);
    const displayValue = (value) => value == null || value === '' ? '-' : String(value);
    fields.forEach(([label, value]) => {
      ensureSpace(18);
      doc.setFont(undefined, 'bold');
      doc.text(`${label}:`, margin, y);
      doc.setFont(undefined, 'normal');
      doc.text(displayValue(value), margin + 150, y);
      y += 18;
    });

    // Un documento por hoja, con su nombre como titulo arriba de la
    // imagen -- mas facil de revisar/imprimir uno por uno que la
    // cuadricula compartiendo pagina de antes.
    const uploadedDocFields = DOC_FIELDS.filter((field) => safeDriverStorageUrl(d[field.key], driverId));
    for (const field of uploadedDocFields) {
      const url = safeDriverStorageUrl(d[field.key], driverId);
      doc.addPage();
      y = margin;

      doc.setFontSize(16);
      doc.setFont(undefined, 'bold');
      doc.text(field.label, margin, y);
      y += 28;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(11);

      try {
        const dataUrl = await documentAsDataUrl(url);
        const props = doc.getImageProperties(dataUrl);
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = pageHeight - y - margin;
        const scale = Math.min(maxWidth / props.width, maxHeight / props.height, 1);
        const w = props.width * scale;
        const h = props.height * scale;
        doc.addImage(dataUrl, props.fileType || 'JPEG', margin, y, w, h);
      } catch (e) {
        console.error(`No se pudo cargar "${field.label}" (${url}):`, e);
        doc.setTextColor(200, 0, 0);
        doc.text(`(no se pudo cargar: ${e.message || e})`, margin, y);
        doc.setTextColor(0);
      }
    }

    const slug = (s) => (s || '').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
    const fileName = `${[slug(d.plate), slug(d.name)].filter(Boolean).join('_') || driverId}.pdf`;
    doc.save(fileName);
  } catch (e) {
    alert(`No se pudo generar el PDF: ${e.message || e}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}
