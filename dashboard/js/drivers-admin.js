// ---------------------------------------------------------------------------
// Seccion "Conductores": aprobacion manual de documentos de registro.
// Suscripcion propia a /drivers (independiente de driversCache de app.js)
// para no arriesgar la logica del mapa ya existente.
// ---------------------------------------------------------------------------

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
  { key: 'profile', label: 'Foto de perfil' },
  { key: 'dni', label: 'DNI' },
  { key: 'license', label: 'Licencia' },
  { key: 'soat', label: 'SOAT' },
  { key: 'circulationCard', label: 'Tarjeta de circulaciÃ³n' },
  { key: 'technicalReview', label: 'RevisiÃ³n tÃ©cnica' },
  { key: 'criminalRecord', label: 'RÃ©cord del conductor' },
  { key: 'workCertificate', label: 'Certificado laboral' },
];

const REJECTION_FIELD_LABELS = Object.fromEntries(
  REJECTION_FIELDS.map((field) => [field.key, field.label])
);

const APPROVAL_LABELS = {
  pending_review: 'Pendiente',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

let adminDriversCache = {};
let adminSubscribed = false;
let adminActiveFilter = 'approved';
let openRejectFormId = null;
let adminPlacesCache = { hotels: {}, sportVenues: {} };
let adminTripHistory = {};
let adminConnectionHistory = {};
let attendanceDateFilter = { from: '', to: '' };
let attendanceCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let attendanceHoverDate = '';
let attendanceClickTimer = null;
let attendanceSearch = '';
let attendanceOutsideListenerBound = false;
let tripHistorySearch = '';

const mapViewEl = document.getElementById('map-view');
const adminViewEl = document.getElementById('drivers-admin-view');
const pendingBadgeEl = document.getElementById('pending-badge');
const navTabs = document.querySelectorAll('.nav-tab');

function openDashboardView(view) {
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

function startDriversAdmin() {
  if (adminSubscribed) return;
  adminSubscribed = true;
  db.ref('drivers').on('value', (snapshot) => {
    adminDriversCache = snapshot.val() || {};
    updatePendingBadge();
    renderDriversAdmin();
  });
  ['hotels', 'sportVenues'].forEach((key) => db.ref(`config/${key}`).on('value', (snapshot) => {
    adminPlacesCache[key] = snapshot.val() || {};
    renderDriversAdmin();
  }));
  db.ref('tripHistory').on('value', (snapshot) => { adminTripHistory = snapshot.val() || {}; renderDriversAdmin(); });
  db.ref('driverConnectionHistory').on('value', (snapshot) => { adminConnectionHistory = snapshot.val() || {}; renderDriversAdmin(); });
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
  pendingBadgeEl.classList.toggle('hidden', pendingCount === 0);
}

function isPdfUrl(url) {
  return /\.pdf(\?|$)/i.test(url || '');
}

function docCellHtml(driverId, field, url) {
  if (!url) {
    return `
      <div class="doc-item">
        <div class="doc-missing" title="No subido">—</div>
        <div class="doc-label">${escapeHtml(field.label)}</div>
      </div>
    `;
  }
  const cell = isPdfUrl(url)
    ? `<a class="doc-pdf-link" href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📄</a>`
    : `<img class="doc-thumb" src="${url}" alt="${escapeHtml(field.label)}" onclick="window.open('${url}', '_blank')" />`;
  return `
    <div class="doc-item">
      ${cell}
      <div class="doc-label">${escapeHtml(field.label)}</div>
    </div>
  `;
}

function driverConnectionHtml(driverId, d) {
  const connection = d.estado_conexion || ((d.status === 'online' || d.status === 'busy') ? 'ONLINE' : 'OFFLINE');
  const lastConnection = d.ultima_conexion ? new Date(Number(d.ultima_conexion)).toLocaleString('es-PE') : 'Sin registro';
  return `
    <div class="driver-connection-box" data-connection-box="${driverId}">
      <div class="driver-connection-heading">
        <div><b>Estado de conexión</b><small>${connection === 'ONLINE' ? 'En línea' : 'Fuera de línea'} · última conexión: ${escapeHtml(lastConnection)}</small></div>
        <span class="connection-state ${connection === 'ONLINE' ? 'online' : 'offline'}">${connection}</span>
      </div>
      <small class="connection-note">Las desconexiones manuales y las pérdidas de señal generan una alerta automática.</small>
    </div>
  `;
}

function driverAdminCardHtml(driverId, d) {
  const status = d.approvalStatus || 'pending_review';
  const rejectFormOpen = openRejectFormId === driverId;
  const rejectionLabels = String(d.rejectionFieldKeys || '')
    .split(',')
    .map((key) => REJECTION_FIELD_LABELS[key.trim()])
    .filter(Boolean);

  const rejectionBlock =
    status === 'rejected'
      ? `<div class="rejection-note">
          ${d.rejectionReason ? `<div><b>Motivo del rechazo:</b> ${escapeHtml(d.rejectionReason)}</div>` : ''}
          ${rejectionLabels.length ? `<div><b>Debe corregir:</b> ${escapeHtml(rejectionLabels.join(', '))}</div>` : ''}
        </div>`
      : '';

  const actionsHtml =
    status === 'pending_review'
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
              <strong>Documentos que debe corregir:</strong>
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

  return `
    <div class="driver-admin-card" data-id="${driverId}">
      <div class="driver-admin-card-header">
        <img class="driver-admin-avatar" src="${d.profilePhotoUrl || ''}" alt="" onerror="this.style.visibility='hidden'" />
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
      </div>
      ${status !== 'rejected' ? driverConnectionHtml(driverId, d) : ''}
      ${rejectionBlock}
      ${
        status !== 'rejected'
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
    </div>
  `;
}

function renderDriversAdmin() {
  if (adminActiveFilter === 'trip-history' || adminActiveFilter === 'attendance' || adminActiveFilter === 'alerts') {
    if (adminActiveFilter === 'attendance') {
      renderDriversAttendance();
      return;
    }
    if (adminActiveFilter === 'alerts') {
      renderPrematureDisconnectHistory();
      return;
    }
    renderDriversHistory();
    return;
  }
  const entries = Object.entries(adminDriversCache).filter(([, d]) => {
    if (adminActiveFilter === 'all') return true;
    return (d.approvalStatus || 'pending_review') === adminActiveFilter;
  });

  const toolbarHtml = `
    <div class="drivers-admin-toolbar">
      ${['approved', 'pending_review', 'rejected', 'all', 'trip-history', 'attendance', 'alerts']
        .map(
          (f) => `
        <button type="button" class="filter-pill ${adminActiveFilter === f ? 'active' : ''}" data-admin-filter="${f}">
          ${f === 'all' ? 'Todos' : f === 'trip-history' ? 'Historial de viajes' : f === 'attendance' ? 'Asistencia' : f === 'alerts' ? 'Alertas de desconexión' : APPROVAL_LABELS[f]}
        </button>
      `
        )
        .join('')}
    </div>
  `;

  const gridHtml = entries.length
    ? `<div class="driver-admin-grid">${entries.map(([id, d]) => driverAdminCardHtml(id, d)).join('')}</div>`
    : '<p class="drivers-admin-empty">Sin conductores para este filtro.</p>';

  adminViewEl.innerHTML = toolbarHtml + gridHtml;

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

  adminViewEl.querySelectorAll('[data-action="assign-place"]').forEach((btn) => {
    btn.addEventListener('click', () => assignDriverPlace(btn.getAttribute('data-id')));
  });
  adminViewEl.querySelectorAll('[data-action="delete-driver"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteDriver(btn.getAttribute('data-id')));
  });
  adminViewEl.querySelectorAll('[data-reject-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const driverId = form.getAttribute('data-reject-form');
      const reason = form.querySelector('input[name="rejectionReason"]').value.trim();
      const rejectionFields = [...form.querySelectorAll('input[name="rejectionField"]:checked')]
        .map((input) => input.value);
      if (!reason) return alert('Escribe el motivo del rechazo.');
      if (!rejectionFields.length) return alert('Selecciona al menos un documento que deba corregirse.');
      await rejectDriver(driverId, reason, rejectionFields);
    });
  });
}

function historyToolbarHtml() {
  return `<div class="drivers-admin-toolbar">${['approved', 'pending_review', 'rejected', 'all', 'trip-history', 'attendance', 'alerts'].map((f) => `<button type="button" class="filter-pill ${adminActiveFilter === f ? 'active' : ''}" data-admin-filter="${f}">${f === 'all' ? 'Todos' : f === 'trip-history' ? 'Historial de viajes' : f === 'attendance' ? 'Asistencia' : f === 'alerts' ? 'Alertas de desconexión' : APPROVAL_LABELS[f]}</button>`).join('')}</div>`;
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

function renderDriversHistory() {
  const isTrips = adminActiveFilter === 'trip-history';
  const query = tripHistorySearch.trim().toLowerCase();
  const tripEntries = Object.entries(adminTripHistory).filter(([, trip]) => {
    if (!query) return true;
    const driver = adminDriversCache[trip.driverId] || {};
    return [trip.driverName, trip.driverPlate, driver.name, driver.plate].some((value) => String(value || '').toLowerCase().includes(query));
  });
  const rows = isTrips
    ? tripEntries.map(([id, trip]) => `<tr><td>${new Date(trip.completedAt || trip.cancelledAt || trip.archivedAt).toLocaleString('es-PE')}</td><td><strong>${escapeHtml(trip.driverName || adminDriversCache[trip.driverId]?.name || '-')}</strong><small>${escapeHtml(trip.driverPlate || adminDriversCache[trip.driverId]?.plate || '-')}</small></td><td>${escapeHtml(trip.passengerName || '-')}</td><td>${escapeHtml(trip.pickupAddress || '-')}</td><td>${escapeHtml(trip.destinationAddress || '-')}</td><td>${escapeHtml(trip.status || '-')}</td></tr>`)
    : Object.entries(adminConnectionHistory).flatMap(([driverId, events]) => Object.values(events || {}).map((event) => `<tr><td>${new Date(event.at).toLocaleString('es-PE')}</td><td>${escapeHtml(event.driverName || driverId)}</td><td>${event.status === 'online' ? 'Conectado' : 'Desconectado'}</td></tr>`));
  adminViewEl.innerHTML = `${historyToolbarHtml()}${isTrips ? `<div class="history-search-row"><label for="trip-history-search">Buscar conductor</label><input id="trip-history-search" type="search" value="${escapeHtml(tripHistorySearch)}" placeholder="Nombre o placa..." /></div>` : ''}<div class="dashboard-users-table-wrap"><table class="dashboard-users-table"><thead><tr>${isTrips ? '<th>Fecha</th><th>Conductor / placa</th><th>Pasajero</th><th>Origen</th><th>Destino</th><th>Estado</th>' : '<th>Fecha</th><th>Conductor</th><th>Evento</th>'}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${isTrips ? 6 : 3}" class="dashboard-empty-row">Sin registros todavía.</td></tr>`}</tbody></table></div>`;
  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => btn.addEventListener('click', () => { adminActiveFilter = btn.getAttribute('data-admin-filter'); renderDriversAdmin(); }));
  if (isTrips) {
    const searchInput = document.getElementById('trip-history-search');
    searchInput.addEventListener('input', () => {
      tripHistorySearch = searchInput.value;
      const nextQuery = tripHistorySearch.trim().toLowerCase();
      const filtered = Object.entries(adminTripHistory).filter(([, trip]) => {
        if (!nextQuery) return true;
        const driver = adminDriversCache[trip.driverId] || {};
        return [trip.driverName, trip.driverPlate, driver.name, driver.plate].some((value) => String(value || '').toLowerCase().includes(nextQuery));
      });
      const tbody = adminViewEl.querySelector('tbody');
      tbody.innerHTML = filtered.map(([, trip]) => `<tr><td>${new Date(trip.completedAt || trip.cancelledAt || trip.archivedAt).toLocaleString('es-PE')}</td><td><strong>${escapeHtml(trip.driverName || adminDriversCache[trip.driverId]?.name || '-')}</strong><small>${escapeHtml(trip.driverPlate || adminDriversCache[trip.driverId]?.plate || '-')}</small></td><td>${escapeHtml(trip.passengerName || '-')}</td><td>${escapeHtml(trip.pickupAddress || '-')}</td><td>${escapeHtml(trip.destinationAddress || '-')}</td><td>${escapeHtml(trip.status || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="dashboard-empty-row">Sin resultados para esa búsqueda.</td></tr>';
    });
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
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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

function approveDriver(driverId) {
  db.ref(`drivers/${driverId}`).update({
    approvalStatus: 'approved',
    rejectionReason: null,
    rejectionFieldKeys: null,
    reviewedAt: Date.now(),
    reviewedBy: auth.currentUser ? auth.currentUser.email : null,
  });
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
  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
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
  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
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

    const status = d.approvalStatus || 'pending_review';

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

    if (d.profilePhotoUrl) {
      try {
        const dataUrl = await fetchAsDataUrl(d.profilePhotoUrl);
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
    const uploadedDocFields = DOC_FIELDS.filter((field) => d[field.key]);
    for (const field of uploadedDocFields) {
      const url = d[field.key];
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
