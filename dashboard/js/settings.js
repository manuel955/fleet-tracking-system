// ---------------------------------------------------------------------------
// Seccion "Configuracion": valores compartidos por driver-app y
// passenger-app -- numero de soporte y publicacion de nuevas versiones de
// cada app. Todo vive bajo config/ en Firebase (lectura publica, escritura
// solo desde aqui con login por password -- ver
// database/firebase-rules.json) mas los APK en Storage bajo app_releases/
// (ver database/storage.rules).
// ---------------------------------------------------------------------------

const settingsViewEl = document.getElementById('settings-view');
let settingsSubscribed = false;
let currentSupportPhone = '';
let settingsSection = 'home';

function normalizeSupportPhone(value) {
  const raw = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!raw) return '';
  if (raw.startsWith('00')) return `+${raw.slice(2)}`;
  if (raw.startsWith('+')) return `+${raw.slice(1).replace(/\D/g, '')}`;
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('51') ? `+${digits}` : `+51${digits}`;
}

function isValidSupportPhone(value) {
  return /^\+519\d{8}$/.test(value);
}

// Nombre de archivo fijo por app: cada version nueva sobreescribe la
// anterior, asi AppConfig.apkDownloadUrl en cada app Flutter nunca cambia y
// no hace falta guardar la URL en ningun lado, solo el numero de build.
const UPDATE_APPS = [
  { key: 'driver', label: 'App de conductores', storagePath: 'app_releases/driver-app.apk', buildField: 'driverAppBuild' },
  { key: 'passenger', label: 'App de pasajeros', storagePath: 'app_releases/passenger-app.apk', buildField: 'passengerAppBuild' },
];

const BRAND_APPS = [
  { key: 'driver', label: 'App de conductores', defaultName: 'APL Conductores' },
  { key: 'passenger', label: 'App de pasajeros', defaultName: 'APL Pasajeros' },
];

let currentBuilds = {}; // buildField -> numero
let currentAppBranding = {};
let appDownloadUrls = {};
let currentDashboardName = 'APL Logistic';
let currentDashboardLogoUrl = '';
let dashboardUsers = [];
let dashboardUserCreateOpen = false;
let dashboardPlacesCache = { hotels: {}, sportVenues: {} };
let passengerInvites = null;
let passengerInviteCreateOpen = false;
let currentPassengerInvite = null;

function applyDashboardName(name) {
  const value = name || 'APL Logistic';
  document.querySelectorAll('[data-dashboard-name]').forEach((element) => {
    element.textContent = value;
  });
  document.title = value;
}

// El nombre del dashboard es publico para que tambien se muestre antes de
// iniciar sesion, pero solo una cuenta de administrador puede modificarlo.
db.ref('config/dashboardName').on('value', (snapshot) => {
  currentDashboardName = snapshot.val() || 'APL Logistic';
  applyDashboardName(currentDashboardName);
  if (settingsSubscribed) renderSettings();
});
db.ref('config/dashboardLogoUrl').on('value', (snapshot) => {
  currentDashboardLogoUrl = snapshot.val() || '';
  applyDashboardLogo(currentDashboardLogoUrl);
  if (settingsSubscribed) renderSettings();
});

function applyDashboardLogo(url) {
  document.querySelectorAll('[data-dashboard-icon]').forEach((element) => {
    element.style.backgroundImage = url ? `url("${url}")` : '';
    element.style.backgroundSize = 'cover';
    element.style.backgroundPosition = 'center';
    element.textContent = url ? '' : 'APL';
  });
}

function startSettings() {
  if (settingsSubscribed) return;
  settingsSubscribed = true;
  db.ref('config/supportPhone').on('value', (snapshot) => {
    const raw = snapshot.val() || '';
    currentSupportPhone = normalizeSupportPhone(raw);
    if (raw && currentSupportPhone && raw !== currentSupportPhone) {
      db.ref('config/supportPhone').set(currentSupportPhone).catch(() => {});
    }
    renderSettings();
  });
  UPDATE_APPS.forEach((app) => {
    db.ref(`config/${app.buildField}`).on('value', (snapshot) => {
      currentBuilds[app.buildField] = snapshot.val();
      renderSettings();
    });
  });
  db.ref('config/appBranding').on('value', (snapshot) => {
    currentAppBranding = snapshot.val() || {};
    renderSettings();
  });
  ['hotels', 'sportVenues'].forEach((key) => db.ref(`config/${key}`).on('value', (snapshot) => {
    dashboardPlacesCache[key] = snapshot.val() || {};
    if (settingsSection === 'users') renderDashboardUsers();
  }));
  loadAppDownloadUrls();
}

async function loadAppDownloadUrls() {
  await Promise.all(UPDATE_APPS.map(async (app) => {
    try {
      appDownloadUrls[app.key] = await storage.ref(app.storagePath).getDownloadURL();
    } catch (_) {
      appDownloadUrls[app.key] = '';
    }
  }));
  if (settingsSection === 'apps') renderApps();
}

function renderSettings() {
  if (settingsSection === 'updates') {
    renderUpdates();
    return;
  }
  if (settingsSection === 'apps') {
    renderApps();
    return;
  }
  if (settingsSection === 'users') {
    renderDashboardUsers();
    return;
  }
  if (settingsSection === 'passenger-access') {
    renderPassengerAccess();
    return;
  }
  if (settingsSection === 'dashboard') {
    renderDashboardSettings();
    return;
  }
  if (settingsSection === 'support') {
    renderSupportSettings();
    return;
  }

  settingsViewEl.innerHTML = `
    <div class="settings-home-heading">
      <h2>Panel de administración</h2>
      <p>Gestiona las aplicaciones, los accesos y la información del panel.</p>
    </div>
    <div class="settings-shortcuts">
    ${window.dashboardIsAdmin ? `
      <button type="button" id="open-updates" class="settings-section-link">
        <span>
          <b>Actualizaciones</b>
          <small>Publica nuevas versiones de las apps</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" id="open-apps" class="settings-section-link">
        <span>
          <b>Apps</b>
          <small>Cambia el nombre y el ícono de cada app</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" id="open-dashboard-users" class="settings-section-link">
        <span>
          <b>Usuarios del dashboard</b>
          <small>Crea y administra quién puede ingresar</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" id="open-passenger-access" class="settings-section-link">
        <span>
          <b>Acceso de pasajeros</b>
          <small>Genera QR temporales para huéspedes autorizados</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" id="open-dashboard-settings" class="settings-section-link">
        <span>
          <b>Dashboard</b>
          <small>Cambia el nombre y el logo del panel</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
    ` : ''}

    <button type="button" id="open-support-settings" class="settings-section-link">
      <span>
        <b>Número de soporte</b>
        <small>Configura el teléfono de llamadas y WhatsApp</small>
      </span>
      <span aria-hidden="true">›</span>
    </button>
    </div>
  `;

  const updatesButton = document.getElementById('open-updates');
  if (updatesButton) updatesButton.addEventListener('click', () => {
    settingsSection = 'updates';
    renderSettings();
  });
  const appsButton = document.getElementById('open-apps');
  if (appsButton) appsButton.addEventListener('click', () => {
    settingsSection = 'apps';
    renderSettings();
  });
  const usersButton = document.getElementById('open-dashboard-users');
  if (usersButton) usersButton.addEventListener('click', () => {
    settingsSection = 'users';
    loadDashboardUsers();
  });
  const dashboardButton = document.getElementById('open-dashboard-settings');
  if (dashboardButton) dashboardButton.addEventListener('click', () => { settingsSection = 'dashboard'; renderSettings(); });
  const passengerAccessButton = document.getElementById('open-passenger-access');
  if (passengerAccessButton) passengerAccessButton.addEventListener('click', () => {
    settingsSection = 'passenger-access';
    loadPassengerInvites();
  });
  document.getElementById('open-support-settings').addEventListener('click', () => { settingsSection = 'support'; renderSettings(); });
}

function renderDashboardSettings() {
  settingsViewEl.innerHTML = `<button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="settings-card apps-settings-card">
      <h3>Dashboard</h3><p class="settings-hint">Personaliza el nombre y el logo del panel.</p>
      <label class="settings-field-label" for="dashboard-name-input">Nombre del dashboard</label>
      <form id="dashboard-name-form" class="settings-form"><input id="dashboard-name-input" maxlength="60" value="${escapeHtml(currentDashboardName)}" required /><button type="submit">Guardar</button></form>
      <p id="dashboard-name-feedback" class="settings-feedback"></p>
      <label class="settings-field-label" for="dashboard-logo-input">Logo del dashboard</label>
      <p class="settings-hint">PNG, JPG o WebP de hasta 2 MB.</p>
      <form id="dashboard-logo-form" class="app-branding-form"><input id="dashboard-logo-input" type="file" accept="image/png,image/jpeg,image/webp" /><button type="submit">Guardar logo</button></form>
      <p id="dashboard-logo-feedback" class="settings-feedback"></p>
    </div>`;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
  document.getElementById('dashboard-name-form').addEventListener('submit', (event) => { event.preventDefault(); const name = document.getElementById('dashboard-name-input').value.trim(); if (name) saveDashboardName(name); });
  document.getElementById('dashboard-logo-form').addEventListener('submit', (event) => { event.preventDefault(); saveDashboardLogo(document.getElementById('dashboard-logo-input').files[0]); });
}

async function passengerInvitesRequest(payload) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(
    'https://us-central1-rastreoflota-53052.cloudfunctions.net/managePassengerInvites',
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'No se pudo administrar el acceso de pasajeros.');
  return result;
}

async function loadPassengerInvites() {
  passengerInvites = null;
  renderSettings();
  try {
    passengerInvites = (await passengerInvitesRequest({ action: 'list' })).invites || [];
  } catch (error) {
    passengerInvites = { error: error.message || String(error) };
  }
  renderSettings();
}

function passengerInviteHotelOptions() {
  const hotels = Object.entries(dashboardPlacesCache.hotels || {});
  return `<option value="">Selecciona un hotel…</option>${hotels.map(([id, place]) => `<option value="${escapeHtml(id)}">${escapeHtml(place.name || id)}${place.address ? ` · ${escapeHtml(place.address)}` : ''}</option>`).join('')}`;
}

function passengerInviteStatus(invite) {
  if (invite.status === 'revoked') return 'Revocado';
  if (invite.status === 'used' || Number(invite.uses) >= Number(invite.maxUses)) return 'Utilizado';
  if (Number(invite.expiresAt) <= Date.now()) return 'Vencido';
  return 'Activo';
}

function passengerInviteDate(value) {
  return value ? new Date(Number(value)).toLocaleString('es-PE') : '—';
}

function renderPassengerAccess() {
  if (passengerInvites === null) {
    settingsViewEl.innerHTML = '<p class="settings-hint">Cargando invitaciones…</p>';
    return;
  }
  if (passengerInvites?.error) {
    settingsViewEl.innerHTML = `<button type="button" id="back-to-settings" class="settings-back">← Configuración</button><p class="settings-feedback error">${escapeHtml(passengerInvites.error)}</p>`;
    document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
    return;
  }
  const current = currentPassengerInvite;
  const rows = passengerInvites.map((invite) => {
    const status = passengerInviteStatus(invite);
    const canRevoke = status === 'Activo';
    return `<tr>
      <td><strong>${escapeHtml(invite.hotelName || 'Hotel')}</strong><small>${escapeHtml(invite.hotelAddress || '')}</small></td>
      <td>${passengerInviteDate(invite.createdAt)}</td>
      <td>${passengerInviteDate(invite.expiresAt)}</td>
      <td>${Number(invite.uses || 0)} / ${Number(invite.maxUses || 1)}</td>
      <td><span class="attendance-status ${status === 'Activo' ? 'active' : 'closed'}">${status}</span></td>
      <td>${canRevoke ? `<button type="button" class="settings-table-action" data-revoke-passenger-invite="${escapeHtml(invite.id)}">Revocar</button>` : '—'}</td>
    </tr>`;
  }).join('');
  const hotelsExist = Object.keys(dashboardPlacesCache.hotels || {}).length > 0;
  settingsViewEl.innerHTML = `
    <button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="dashboard-users-toolbar">
      <div><span class="overview-eyebrow">ACCESO CONTROLADO</span><h2>QR para pasajeros</h2><p>Genera invitaciones temporales para huéspedes autorizados.</p></div>
      <button type="button" id="toggle-passenger-invite" class="dashboard-add-user-btn">${passengerInviteCreateOpen ? 'Cerrar' : 'Generar QR'}</button>
    </div>
    <div class="settings-card passenger-invite-create ${passengerInviteCreateOpen ? '' : 'hidden'}">
      <h3>Nueva invitación</h3>
      <p class="settings-hint">El QR no contiene datos personales. Solo activa el acceso al hotel seleccionado.</p>
      <form id="passenger-invite-form" class="app-branding-form">
        <label>Hotel<select id="passenger-invite-hotel" required>${passengerInviteHotelOptions()}</select></label>
        <label>Válido por horas<input id="passenger-invite-hours" type="number" min="1" max="720" value="24" required /></label>
        <label>Usos máximos<input id="passenger-invite-uses" type="number" min="1" max="100" value="1" required /></label>
        <button type="submit" ${hotelsExist ? '' : 'disabled'}>Crear invitación</button>
      </form>
      ${hotelsExist ? '' : '<p class="settings-feedback error">Primero registra un hotel en Lugares.</p>'}
      <p id="passenger-invite-feedback" class="settings-feedback"></p>
    </div>
    ${current ? `<div class="settings-card passenger-invite-result"><h3>QR listo para entregar</h3><p><b>${escapeHtml(current.hotelName)}</b><br>Válido hasta ${escapeHtml(passengerInviteDate(current.expiresAt))}</p><canvas id="passenger-invite-qr" width="280" height="280"></canvas><p class="settings-hint">También puedes compartir este código manualmente:</p><code>${escapeHtml(current.token)}</code><button type="button" id="copy-passenger-invite" class="settings-secondary-btn">Copiar código</button></div>` : ''}
    <div class="dashboard-users-table-wrap"><table class="dashboard-users-table"><thead><tr><th>Hotel</th><th>Creado</th><th>Vence</th><th>Usos</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dashboard-empty-row">Todavía no hay invitaciones.</td></tr>'}</tbody></table></div>
  `;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; currentPassengerInvite = null; renderSettings(); });
  document.getElementById('toggle-passenger-invite').addEventListener('click', () => { passengerInviteCreateOpen = !passengerInviteCreateOpen; renderPassengerAccess(); });
  const form = document.getElementById('passenger-invite-form');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = document.getElementById('passenger-invite-feedback');
    feedback.textContent = 'Generando QR…';
    try {
      const result = await passengerInvitesRequest({
        action: 'create',
        hotelId: document.getElementById('passenger-invite-hotel').value,
        durationHours: Number(document.getElementById('passenger-invite-hours').value),
        maxUses: Number(document.getElementById('passenger-invite-uses').value),
      });
      currentPassengerInvite = result.invite;
      passengerInviteCreateOpen = false;
      await loadPassengerInvites();
      renderPassengerAccess();
      const canvas = document.getElementById('passenger-invite-qr');
      if (canvas && window.QRCode?.toCanvas) window.QRCode.toCanvas(canvas, currentPassengerInvite.qrValue, { width: 280, margin: 2 });
    } catch (error) {
      feedback.textContent = error.message || String(error);
      feedback.className = 'settings-feedback error';
    }
  });
  settingsViewEl.querySelectorAll('[data-revoke-passenger-invite]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('¿Revocar esta invitación QR?')) return;
    await passengerInvitesRequest({ action: 'revoke', inviteId: button.getAttribute('data-revoke-passenger-invite') });
    loadPassengerInvites();
  }));
  const copyButton = document.getElementById('copy-passenger-invite');
  if (copyButton) copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(currentPassengerInvite.token);
    copyButton.textContent = 'Código copiado';
  });
  if (current) {
    const canvas = document.getElementById('passenger-invite-qr');
    if (canvas && window.QRCode?.toCanvas) window.QRCode.toCanvas(canvas, current.qrValue, { width: 280, margin: 2 });
  }
}

function renderSupportSettings() {
  settingsViewEl.innerHTML = `<button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="settings-card apps-settings-card"><h3>Número de soporte</h3><p class="settings-hint">Teléfono usado por los botones de llamada y WhatsApp de ambas apps. Incluye código de país, por ejemplo +51987654321.</p>
      <form id="support-phone-form" class="settings-form"><input type="tel" id="support-phone-input" placeholder="+51987654321" value="${escapeHtml(currentSupportPhone)}" pattern="\\+519[0-9]{8}" required /><button type="submit">Guardar</button></form><p id="settings-feedback" class="settings-feedback"></p>
    </div>`;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
  document.getElementById('support-phone-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('support-phone-input');
    const value = normalizeSupportPhone(input.value);
    const feedback = document.getElementById('settings-feedback');
    if (!isValidSupportPhone(value)) {
      feedback.textContent = 'Ingresa un celular peruano válido, por ejemplo +51987654321.';
      feedback.className = 'settings-feedback error';
      return;
    }
    input.value = value;
    saveSupportPhone(value);
  });
}

async function saveDashboardLogo(file) {
  if (!file) return;
  const feedback = document.getElementById('dashboard-logo-feedback');
  feedback.textContent = 'Subiendo logo…';
  try {
    const ref = storage.ref('dashboard_branding/logo');
    await ref.put(file, { contentType: file.type });
    await db.ref('config/dashboardLogoUrl').set(await ref.getDownloadURL());
    feedback.textContent = 'Logo actualizado.';
    feedback.className = 'settings-feedback success';
  } catch (error) { feedback.textContent = error.message || error; feedback.className = 'settings-feedback error'; }
}

async function dashboardUsersRequest(payload) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(
    'https://us-central1-rastreoflota-53052.cloudfunctions.net/manageDashboardUsers',
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'No se pudo administrar los usuarios');
  return result;
}

function dashboardPlaceOptions(selectedType = '', selectedId = '', placeholder = 'Selecciona una sede / hotel') {
  const entries = ['sportVenues', 'hotels'].flatMap((type) => Object.entries(dashboardPlacesCache[type] || {}).map(([id, place]) => ({
    type, id, name: place.name || id, address: place.address || '',
  })));
  return `<option value="">${placeholder}</option>${entries.map((place) => `
    <option value="${escapeHtml(`${place.type}|${place.id}`)}"${place.type === selectedType && place.id === selectedId ? ' selected' : ''}>
      ${escapeHtml(`${place.name}${place.address ? ` · ${place.address}` : ''}`)}
    </option>
  `).join('')}`;
}

function parseDashboardPlaceValue(value) {
  const [sedeType, sedeId] = String(value || '').split('|');
  return { sedeType: sedeType || '', sedeId: sedeId || '' };
}

async function loadDashboardUsers() {
  dashboardUsers = null;
  renderDashboardUsers();
  try {
    const result = await dashboardUsersRequest({ action: 'list' });
    dashboardUsers = result.users;
  } catch (error) {
    dashboardUsers = { error: error.message || String(error) };
  }
  renderDashboardUsers();
}

function renderDashboardUsers() {
  if (dashboardUsers === null) {
    settingsViewEl.innerHTML = '<p class="settings-hint">Cargando usuarios…</p>';
    return;
  }
  if (dashboardUsers?.error) {
    settingsViewEl.innerHTML = `<button type="button" id="back-to-settings" class="settings-back">← Configuración</button><p class="settings-feedback error">${escapeHtml(dashboardUsers.error)}</p>`;
    document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
    return;
  }
  settingsViewEl.innerHTML = `
    <button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="dashboard-users-toolbar">
       <div>
        <h2>Usuarios del dashboard</h2>
        <p>Administra quién puede ingresar al panel.</p>
       </div>
       <button type="button" id="show-create-dashboard-user" class="dashboard-add-user-btn">Nuevo usuario</button>
    </div>
    <div id="dashboard-create-panel" class="dashboard-user-modal${dashboardUserCreateOpen ? '' : ' hidden'}">
      <div class="dashboard-user-modal-card">
      <button type="button" id="close-create-dashboard-user" class="dashboard-modal-close" aria-label="Cerrar">×</button>
      <h3>Nuevo usuario</h3>
      <form id="create-dashboard-user" class="app-branding-form">
        <label>Nombre<input id="new-dashboard-name" type="text" maxlength="60" required /></label>
        <label>Email<input id="new-dashboard-email" type="email" placeholder="correo@empresa.com" required /></label>
        <label>Contraseña<input id="new-dashboard-password" type="password" placeholder="Mínimo 6 caracteres" minlength="6" required /></label>
        <label>Rol<select id="new-dashboard-role"><option value="coordinator">Coordinador</option><option value="supervisor">Supervisor</option><option value="admin">Administrador</option></select></label>
        <label id="new-dashboard-sede-field">Sede / hotel asignado<select id="new-dashboard-sede" required>${dashboardPlaceOptions()}</select></label>
        <button type="submit">Crear usuario</button>
      </form>
      <p id="dashboard-users-feedback" class="settings-feedback"></p>
      </div>
    </div>
    <div class="dashboard-users-table-wrap">
      <table class="dashboard-users-table">
        <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Sede</th><th>Estado</th><th>Creado</th><th>Acciones</th></tr></thead>
        <tbody>${dashboardUsers.map((user) => dashboardUserCardHtml(user)).join('') || '<tr><td colspan="7" class="dashboard-empty-row">No hay usuarios.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
  document.getElementById('show-create-dashboard-user').addEventListener('click', () => {
    dashboardUserCreateOpen = !dashboardUserCreateOpen;
    renderDashboardUsers();
  });
  document.getElementById('close-create-dashboard-user').addEventListener('click', () => { dashboardUserCreateOpen = false; renderDashboardUsers(); });
  const newRoleSelect = document.getElementById('new-dashboard-role');
  const newSedeField = document.getElementById('new-dashboard-sede-field');
  const newSedeSelect = document.getElementById('new-dashboard-sede');
  const syncNewRoleFields = () => {
    const isCoordinator = newRoleSelect.value === 'coordinator';
    newSedeField.classList.toggle('hidden', !isCoordinator);
    newSedeSelect.required = isCoordinator;
    newSedeSelect.disabled = !isCoordinator;
  };
  newRoleSelect.addEventListener('change', syncNewRoleFields);
  syncNewRoleFields();
  document.getElementById('create-dashboard-user').addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = document.getElementById('dashboard-users-feedback');
    try {
      feedback.textContent = 'Creando…';
      const role = newRoleSelect.value;
      const sede = role === 'coordinator' ? parseDashboardPlaceValue(newSedeSelect.value) : {};
      await dashboardUsersRequest({ action: 'create', name: document.getElementById('new-dashboard-name').value, email: document.getElementById('new-dashboard-email').value, password: document.getElementById('new-dashboard-password').value, role, ...sede });
      dashboardUserCreateOpen = false;
      await loadDashboardUsers();
    } catch (error) { feedback.textContent = error.message; feedback.className = 'settings-feedback error'; }
  });
  dashboardUsers.forEach((user) => bindDashboardUserControls(user));
}

function dashboardUserCardHtml(user) {
  const name = user.name || (user.email ? user.email.split('@')[0] : 'Usuario');
  const state = user.disabled ? 'Inactivo' : 'Activo';
  const sede = user.sedeName || '—';
  const roleControl = user.isCurrent
    ? '<span class="dashboard-role-static">Administrador</span>'
    : `<select id="dashboard-role-${user.uid}" class="dashboard-role-select">
        <option value="coordinator"${user.role === 'coordinator' ? ' selected' : ''}>Coordinador</option>
        <option value="supervisor"${user.role === 'supervisor' ? ' selected' : ''}>Supervisor</option>
        <option value="admin"${user.role === 'admin' ? ' selected' : ''}>Administrador</option>
      </select>`;
  const sedeControl = user.isCurrent
    ? '<span>—</span>'
    : `<select id="dashboard-sede-${user.uid}" class="dashboard-sede-select${user.role === 'coordinator' ? '' : ' hidden'}">${dashboardPlaceOptions(user.sedeType, user.sedeId)}</select>`;
  return `<tr>
    <td><b>${escapeHtml(name)}</b>${user.isCurrent ? ' <small>(tu)</small>' : ''}</td>
    <td>${escapeHtml(user.email)}</td>
    <td>${roleControl}</td>
    <td>${sedeControl}</td>
    <td><span class="dashboard-status ${user.disabled ? 'inactive' : 'active'}">${state}</span></td>
    <td>${formatDashboardDate(user.createdAt)}</td>
    <td class="dashboard-user-actions"><button type="button" data-save-user="${user.uid}" class="dashboard-table-action">Editar</button>${user.isCurrent ? '' : `<button type="button" data-delete-user="${user.uid}" class="dashboard-table-action danger">Eliminar</button>`}</td>
  </tr>`;
}

function bindDashboardUserControls(user) {
  const roleSelect = document.getElementById(`dashboard-role-${user.uid}`);
  const sedeSelect = document.getElementById(`dashboard-sede-${user.uid}`);
  if (roleSelect && sedeSelect) {
    roleSelect.addEventListener('change', () => {
      sedeSelect.classList.toggle('hidden', roleSelect.value !== 'coordinator');
    });
  }
  document.querySelector(`[data-save-user="${user.uid}"]`).addEventListener('click', async () => {
    try {
      const role = user.isCurrent ? 'admin' : roleSelect.value;
      const sede = role === 'coordinator' ? parseDashboardPlaceValue(sedeSelect.value) : {};
      if (role === 'coordinator' && (!sede.sedeId || !sede.sedeType)) {
        throw new Error('Selecciona una sede para el coordinador.');
      }
      await dashboardUsersRequest({ action: 'update', uid: user.uid, role, ...sede });
      await loadDashboardUsers();
    } catch (error) { alert(error.message); }
  });
  const remove = document.querySelector(`[data-delete-user="${user.uid}"]`);
  if (remove) remove.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar el acceso de ${user.email}?`)) return;
    try { await dashboardUsersRequest({ action: 'delete', uid: user.uid }); await loadDashboardUsers(); } catch (error) { alert(error.message); }
  });
}

function formatDashboardDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function saveDashboardName(name) {
  const feedback = document.getElementById('dashboard-name-feedback');
  feedback.textContent = 'Guardando…';
  feedback.className = 'settings-feedback';
  db.ref('config/dashboardName')
    .set(name)
    .then(() => {
      feedback.textContent = 'Nombre actualizado.';
      feedback.className = 'settings-feedback success';
    })
    .catch((error) => {
      feedback.textContent = `Error al guardar: ${error.message || error}`;
      feedback.className = 'settings-feedback error';
    });
}

function renderUpdates() {
  settingsViewEl.innerHTML = `
    <button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="updates-page">
      <div class="updates-heading">
      <h3>Actualizaciones de las apps</h3>
      <p class="settings-hint">
        Genera y publica la APK automáticamente. Al finalizar, los teléfonos
        recibirán el aviso de actualización al abrir la app.
      </p>
      </div>
      <div class="updates-grid">${UPDATE_APPS.map((app) => updateAppCardHtml(app)).join('')}</div>
    </div>
  `;

  document.getElementById('back-to-settings').addEventListener('click', () => {
    settingsSection = 'home';
    renderSettings();
  });

  UPDATE_APPS.forEach((app) => {
    document.getElementById(`generate-update-${app.key}`).addEventListener('click', () => requestBrandedAppBuild(app, `update-feedback-${app.key}`));
    document.getElementById(`update-form-${app.key}`).addEventListener('submit', (event) => {
      event.preventDefault();
      const file = document.getElementById(`update-file-${app.key}`).files[0];
      const build = Number.parseInt(document.getElementById(`update-build-${app.key}`).value, 10);
      const feedback = document.getElementById(`update-feedback-${app.key}`);
      if (!file || !build || build < 1) {
        feedback.textContent = 'Selecciona un archivo APK y escribe un n\u00famero de build mayor a 0.';
        feedback.className = 'settings-feedback error';
        return;
      }
      if (!file.name.toLowerCase().endsWith('.apk')) {
        feedback.textContent = 'El archivo seleccionado debe terminar en .apk.';
        feedback.className = 'settings-feedback error';
        return;
      }
      publishAppUpdate(app, file, build);
    });
  });
}

function renderApps() {
  settingsViewEl.innerHTML = `
    <button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="settings-card apps-settings-card">
      <h3>Apps</h3>
      <p class="settings-hint">
        Define el nombre visible y el ícono de cada aplicación. Al guardar,
        se genera automáticamente un APK nuevo y los teléfonos recibirán el
        aviso para instalarlo y aplicar la marca.
      </p>
      <div class="apps-branding-grid">
        ${BRAND_APPS.map((app) => appBrandingCardHtml(app)).join('')}
      </div>
    </div>
  `;

  document.getElementById('back-to-settings').addEventListener('click', () => {
    settingsSection = 'home';
    renderSettings();
  });

  BRAND_APPS.forEach((app) => {
    document.getElementById(`app-branding-form-${app.key}`).addEventListener('submit', (event) => {
      event.preventDefault();
      const name = document.getElementById(`app-name-${app.key}`).value.trim();
      const icon = document.getElementById(`app-icon-${app.key}`).files[0];
      if (!name) return;
      saveAppBranding(app, name, icon);
    });
    document.getElementById(`build-branded-app-${app.key}`).addEventListener('click', () => {
      requestBrandedAppBuild(app);
    });
  });
}

function appBrandingCardHtml(app) {
  const branding = currentAppBranding[app.key] || {};
  const build = currentBuilds[`${app.key}AppBuild`];
  const downloadUrl = appDownloadUrls[app.key] || '';
  const icon = branding.iconUrl
    ? `<img class="app-branding-icon" src="${escapeHtml(branding.iconUrl)}" alt="Ícono de ${escapeHtml(app.label)}" />`
    : '<img class="app-branding-icon" src="assets/apl-mark.png" alt="Ícono APL" />';
  return `
    <div class="app-branding-block">
      <div class="app-branding-header">${icon}<b>${escapeHtml(app.label)}</b></div>
      <form id="app-branding-form-${app.key}" class="app-branding-form">
        <label for="app-name-${app.key}">Nombre de la app</label>
        <input id="app-name-${app.key}" maxlength="40" value="${escapeHtml(branding.name || app.defaultName)}" required />
        <label for="app-icon-${app.key}">Ícono (PNG, JPG o WebP)</label>
        <input id="app-icon-${app.key}" type="file" accept="image/png,image/jpeg,image/webp" />
        <button type="submit">Guardar y generar APK</button>
      </form>
      <button type="button" id="build-branded-app-${app.key}" class="build-branded-app-btn">
        Volver a generar APK
      </button>
      <p id="app-branding-feedback-${app.key}" class="settings-feedback"></p>
      <div class="app-download-card">
        <div>
          <b>Descargar última actualización</b>
          <small>${build ? `Build ${escapeHtml(String(build))}` : 'Todavía no hay una versión publicada'}</small>
        </div>
        ${downloadUrl
          ? `<a class="app-download-btn" href="${escapeHtml(downloadUrl)}" download>Descargar APK</a>`
          : '<span class="app-download-disabled">No disponible</span>'}
      </div>
    </div>
  `;
}

async function saveAppBranding(app, name, icon) {
  const feedback = document.getElementById(`app-branding-feedback-${app.key}`);
  feedback.className = 'settings-feedback';
  feedback.textContent = icon ? 'Subiendo ícono…' : 'Guardando…';
  try {
    const changes = { name };
    if (icon) {
      const iconRef = storage.ref(`app_branding/${app.key}-icon`);
      await iconRef.put(icon, { contentType: icon.type });
      changes.iconUrl = await iconRef.getDownloadURL();
    }
    await db.ref(`config/appBranding/${app.key}`).update(changes);
    feedback.textContent = 'Guardado. Iniciando APK con el nombre e ícono nuevos…';
    feedback.className = 'settings-feedback success';
    await requestBrandedAppBuild(app);
  } catch (error) {
    feedback.textContent = `Error al guardar: ${error.message || error}`;
    feedback.className = 'settings-feedback error';
  }
}

async function requestBrandedAppBuild(app, feedbackId = `app-branding-feedback-${app.key}`) {
  const feedback = document.getElementById(feedbackId);
  feedback.className = 'settings-feedback';
  feedback.textContent = 'Solicitando compilación…';
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch(
      'https://us-central1-rastreoflota-53052.cloudfunctions.net/requestAppBrandingBuild',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: app.key }),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo iniciar la compilación.');
    feedback.textContent = `Compilación iniciada: build ${result.build}. La app avisará cuando esté publicada.`;
    feedback.className = 'settings-feedback success';
  } catch (error) {
    feedback.textContent = `Error al iniciar la compilación: ${error.message || error}`;
    feedback.className = 'settings-feedback error';
  }
}

function updateAppCardHtml(app) {
  const build = currentBuilds[app.buildField];
  return `
    <div class="update-app-block">
      <div class="update-app-header">
        <b>${escapeHtml(app.label)}</b>
        <span class="update-current-build">${build ? `Versión publicada: build ${build}` : 'Sin versión publicada aún'}</span>
      </div>
      <p class="settings-hint">Sube una APK que ya tengas en esta computadora. Si usas el bot\u00f3n autom\u00e1tico, no necesitas subir nada aqu\u00ed.</p>
      <form id="update-form-${app.key}" class="manual-update-form">
        <input type="file" id="update-file-${app.key}" accept=".apk,application/vnd.android.package-archive" required />
        <input type="number" id="update-build-${app.key}" placeholder="Número de build" min="1" required />
        <button type="submit">Publicar APK</button>
      </form>
      <div class="update-or">o</div>
      <button type="button" id="generate-update-${app.key}" class="build-branded-app-btn">Generar APK automáticamente</button>
      <p id="update-feedback-${app.key}" class="settings-feedback"></p>
    </div>
  `;
}

function saveSupportPhone(value) {
  value = normalizeSupportPhone(value);
  if (!isValidSupportPhone(value)) return;
  const feedback = document.getElementById('settings-feedback');
  feedback.textContent = 'Guardando...';
  feedback.className = 'settings-feedback';

  db.ref('config/supportPhone')
    .set(value)
    .then(() => {
      feedback.textContent = 'Guardado. Los cambios se reflejan de inmediato en ambas apps.';
      feedback.className = 'settings-feedback success';
    })
    .catch((err) => {
      feedback.textContent = `Error al guardar: ${err.message || err}`;
      feedback.className = 'settings-feedback error';
    });
}

function publishAppUpdate(app, file, build) {
  const feedback = document.getElementById(`update-feedback-${app.key}`);
  feedback.className = 'settings-feedback';

  const uploadTask = storage.ref(app.storagePath).put(file, {
    contentType: 'application/vnd.android.package-archive',
  });

  uploadTask.on(
    'state_changed',
    (snapshot) => {
      const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
      feedback.textContent = `Subiendo... ${pct}%`;
    },
    (err) => {
      feedback.textContent = `Error al subir el APK: ${err.message || err}`;
      feedback.className = 'settings-feedback error';
    },
    () => {
      // El build solo se publica (y dispara el aviso de actualizacion en las
      // apps) despues de que el archivo termino de subir, para que nunca
      // quede un numero de version apuntando a un APK incompleto.
      db.ref(`config/${app.buildField}`)
        .set(build)
        .then(() => {
          feedback.textContent = `Publicado: ${app.label} build ${build}.`;
          feedback.className = 'settings-feedback success';
        })
        .catch((err) => {
          feedback.textContent = `El APK se subió, pero no se pudo publicar el número de versión: ${err.message || err}`;
          feedback.className = 'settings-feedback error';
        });
    }
  );
}
