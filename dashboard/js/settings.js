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

  settingsViewEl.innerHTML = `
    <div class="settings-card">
      <h3>Configuración</h3>
      <p class="settings-hint">Administra las opciones y herramientas del sistema.</p>
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
    </div>

    <div class="settings-card">
      <h3>Número de soporte</h3>
      <p class="settings-hint">
        Numero que usa el boton "Soporte" (llamar / WhatsApp) tanto en la app
        de conductores como en la de pasajeros. Incluye el codigo de pais,
        ej. +51987654321.
      </p>
      <form id="support-phone-form" class="settings-form">
        <input
          type="tel"
          id="support-phone-input"
          placeholder="+51987654321"
          value="${escapeHtml(currentSupportPhone)}"
          required
        />
        <button type="submit">Guardar</button>
      </form>
      <p id="settings-feedback" class="settings-feedback"></p>
    </div>
  `;

  document.getElementById('open-updates').addEventListener('click', () => {
    settingsSection = 'updates';
    renderSettings();
  });
  document.getElementById('open-apps').addEventListener('click', () => {
    settingsSection = 'apps';
    renderSettings();
  });

  document.getElementById('support-phone-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let value = document.getElementById('support-phone-input').value.trim();
    if (!value) return;
    // Mismo criterio que driver-app/passenger-app (AppConfig.defaultPhoneCountryCode):
    // si escriben solo los digitos sin "+", se asume Peru. Sin esto, tel:/wa.me
    // arman un numero invalido en las apps.
    if (!value.startsWith('+')) value = `+51${value}`;
    saveSupportPhone(value);
  });
}

function renderUpdates() {
  settingsViewEl.innerHTML = `
    <button type="button" id="back-to-settings" class="settings-back">← Configuración</button>
    <div class="settings-card">
      <h3>Actualizaciones de las apps</h3>
      <p class="settings-hint">
        Sube el APK compilado (release) de cada app. Al terminar, el número
        de versión (el "+N" de pubspec.yaml) queda publicado y las apps ya
        instaladas mostrarán un aviso para actualizar la próxima vez que se
        abran.
      </p>
      ${UPDATE_APPS.map((app) => updateAppCardHtml(app)).join('<hr class="settings-divider" />')}
    </div>
  `;

  document.getElementById('back-to-settings').addEventListener('click', () => {
    settingsSection = 'home';
    renderSettings();
  });

  UPDATE_APPS.forEach((app) => {
    const form = document.getElementById(`update-form-${app.key}`);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fileInput = document.getElementById(`update-file-${app.key}`);
      const buildInput = document.getElementById(`update-build-${app.key}`);
      const file = fileInput.files[0];
      const build = parseInt(buildInput.value, 10);
      if (!file || !build || build <= 0) return;
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

async function requestBrandedAppBuild(app) {
  const feedback = document.getElementById(`app-branding-feedback-${app.key}`);
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
      <form id="update-form-${app.key}" class="settings-form update-form">
        <input type="file" id="update-file-${app.key}" accept=".apk" required />
        <input
          type="number"
          id="update-build-${app.key}"
          class="update-build-input"
          placeholder="Build (ej. 2)"
          min="1"
          required
        />
        <button type="submit">Publicar</button>
      </form>
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
