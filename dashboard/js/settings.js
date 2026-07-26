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

// Nombre de archivo fijo por app: cada version nueva sobreescribe la
// anterior, asi AppConfig.apkDownloadUrl en cada app Flutter nunca cambia y
// no hace falta guardar la URL en ningun lado, solo el numero de build.
const UPDATE_APPS = [
  { key: 'driver', label: 'App de conductores', storagePath: 'app_releases/driver-app.apk', buildField: 'driverAppBuild' },
  { key: 'passenger', label: 'App de pasajeros', storagePath: 'app_releases/passenger-app.apk', buildField: 'passengerAppBuild' },
];

const BRAND_APPS = [
  { key: 'driver', label: 'App de conductores', defaultName: 'App de conductores' },
  { key: 'passenger', label: 'App de pasajeros', defaultName: 'App de pasajeros' },
];

let currentBuilds = {}; // buildField -> numero
let currentAppBranding = {};
let currentDashboardName = 'Panel de Flota';
let currentDashboardLogoUrl = '';
let dashboardUsers = [];
let dashboardUserCreateOpen = false;

function applyDashboardName(name) {
  const value = name || 'Panel de Flota';
  document.querySelectorAll('[data-dashboard-name]').forEach((element) => {
    element.textContent = value;
  });
  document.title = value;
}

// El nombre del dashboard es publico para que tambien se muestre antes de
// iniciar sesion, pero solo una cuenta de administrador puede modificarlo.
db.ref('config/dashboardName').on('value', (snapshot) => {
  currentDashboardName = snapshot.val() || 'Panel de Flota';
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
    element.textContent = url ? '' : 'F';
  });
}

function startSettings() {
  if (settingsSubscribed) return;
  settingsSubscribed = true;
  db.ref('config/supportPhone').on('value', (snapshot) => {
    currentSupportPhone = snapshot.val() || '';
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

function renderSupportSettings() {
  settingsViewEl.innerHTML = `<button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="settings-card apps-settings-card"><h3>Número de soporte</h3><p class="settings-hint">Teléfono usado por los botones de llamada y WhatsApp de ambas apps. Incluye código de país, por ejemplo +51987654321.</p>
      <form id="support-phone-form" class="settings-form"><input type="tel" id="support-phone-input" placeholder="+51987654321" value="${escapeHtml(currentSupportPhone)}" required /><button type="submit">Guardar</button></form><p id="settings-feedback" class="settings-feedback"></p>
    </div>`;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
  document.getElementById('support-phone-form').addEventListener('submit', (event) => { event.preventDefault(); let value = document.getElementById('support-phone-input').value.trim(); if (!value) return; if (!value.startsWith('+')) value = `+51${value}`; saveSupportPhone(value); });
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
        <label>Rol<select id="new-dashboard-role"><option value="supervisor">Supervisor</option><option value="admin">Administrador</option></select></label>
        <button type="submit">Crear usuario</button>
      </form>
      <p id="dashboard-users-feedback" class="settings-feedback"></p>
      </div>
    </div>
    <div class="dashboard-users-table-wrap">
      <table class="dashboard-users-table">
        <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Creado</th><th>Acciones</th></tr></thead>
        <tbody>${dashboardUsers.map((user) => dashboardUserCardHtml(user)).join('') || '<tr><td colspan="6" class="dashboard-empty-row">No hay usuarios.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  document.getElementById('back-to-settings').addEventListener('click', () => { settingsSection = 'home'; renderSettings(); });
  document.getElementById('show-create-dashboard-user').addEventListener('click', () => {
    dashboardUserCreateOpen = !dashboardUserCreateOpen;
    renderDashboardUsers();
  });
  document.getElementById('close-create-dashboard-user').addEventListener('click', () => { dashboardUserCreateOpen = false; renderDashboardUsers(); });
  document.getElementById('create-dashboard-user').addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = document.getElementById('dashboard-users-feedback');
    try {
      feedback.textContent = 'Creando…';
      await dashboardUsersRequest({ action: 'create', name: document.getElementById('new-dashboard-name').value, email: document.getElementById('new-dashboard-email').value, password: document.getElementById('new-dashboard-password').value, role: document.getElementById('new-dashboard-role').value });
      dashboardUserCreateOpen = false;
      await loadDashboardUsers();
    } catch (error) { feedback.textContent = error.message; feedback.className = 'settings-feedback error'; }
  });
  dashboardUsers.forEach((user) => bindDashboardUserControls(user));
}

function dashboardUserCardHtml(user) {
  const name = user.name || (user.email ? user.email.split('@')[0] : 'Usuario');
  const state = user.disabled ? 'Inactivo' : 'Activo';
  return `<tr>
    <td><b>${escapeHtml(name)}</b>${user.isCurrent ? ' <small>(tu)</small>' : ''}</td>
    <td>${escapeHtml(user.email)}</td>
    <td>${user.isCurrent ? '<span class="dashboard-role-static">Administrador</span>' : `<select id="dashboard-role-${user.uid}" class="dashboard-role-select"><option value="supervisor"${user.role === 'supervisor' ? ' selected' : ''}>Supervisor</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>Administrador</option></select>`}</td>
    <td><span class="dashboard-status ${user.disabled ? 'inactive' : 'active'}">${state}</span></td>
    <td>${formatDashboardDate(user.createdAt)}</td>
    <td class="dashboard-user-actions"><button type="button" data-save-user="${user.uid}" class="dashboard-table-action">Editar</button>${user.isCurrent ? '' : `<button type="button" data-delete-user="${user.uid}" class="dashboard-table-action danger">Eliminar</button>`}</td>
  </tr>`;
}

function bindDashboardUserControls(user) {
  document.querySelector(`[data-save-user="${user.uid}"]`).addEventListener('click', async () => {
    try {
      await dashboardUsersRequest({ action: 'update', uid: user.uid, role: user.isCurrent ? 'admin' : document.getElementById(`dashboard-role-${user.uid}`).value });
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
      if (!file || !build || build < 1) return;
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
        Define el nombre visible y el ícono de cada aplicación. Para cambiar
        el nombre o ícono que aparece en el teléfono, publica después un APK nuevo.
      </p>
      ${BRAND_APPS.map((app) => appBrandingCardHtml(app)).join('<hr class="settings-divider" />')}
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
  const icon = branding.iconUrl
    ? `<img class="app-branding-icon" src="${escapeHtml(branding.iconUrl)}" alt="Ícono de ${escapeHtml(app.label)}" />`
    : '<span class="app-branding-icon app-branding-icon-placeholder">▣</span>';
  return `
    <div class="app-branding-block">
      <div class="app-branding-header">${icon}<b>${escapeHtml(app.label)}</b></div>
      <form id="app-branding-form-${app.key}" class="app-branding-form">
        <label for="app-name-${app.key}">Nombre de la app</label>
        <input id="app-name-${app.key}" maxlength="40" value="${escapeHtml(branding.name || app.defaultName)}" required />
        <label for="app-icon-${app.key}">Ícono (PNG, JPG o WebP)</label>
        <input id="app-icon-${app.key}" type="file" accept="image/png,image/jpeg,image/webp" />
        <button type="submit">Guardar cambios</button>
      </form>
      <button type="button" id="build-branded-app-${app.key}" class="build-branded-app-btn">
        Generar APK y enviar actualización
      </button>
      <p id="app-branding-feedback-${app.key}" class="settings-feedback"></p>
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
    feedback.textContent = 'Guardado. Publica un APK nuevo para aplicarlo en los teléfonos.';
    feedback.className = 'settings-feedback success';
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
      <p class="settings-hint">Sube una APK release ya compilada e indica su build.</p>
      <form id="update-form-${app.key}" class="manual-update-form">
        <input type="file" id="update-file-${app.key}" accept=".apk" required />
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
