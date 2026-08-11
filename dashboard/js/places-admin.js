// ---------------------------------------------------------------------------
// Seccion "Lugares": sedes deportivas y hoteles que el pasajero elige desde
// botones flotantes en la app. Viven en config/sportVenues y config/hotels.
// ---------------------------------------------------------------------------

const PLACE_LISTS = [
  { key: 'sportVenues', label: 'Sedes deportivas' },
  { key: 'hotels', label: 'Hoteles' },
];

const placesViewEl = document.getElementById('places-view');
let placesSubscribed = false;
let placesCache = {};
let placesLoadError = '';
const FIREBASE_CONFIG_REST_URL = String(firebaseConfig?.databaseURL || '').replace(/\/$/, '');

function startPlaces() {
  if (placesSubscribed) return;
  placesSubscribed = true;
  // Renderizar de inmediato evita la pantalla blanca aunque Firebase tarde
  // en abrir el listener. El REST público de config sirve como respaldo y
  // conserva los lugares ya existentes durante la migración al VPS.
  placesLoadError = '';
  renderPlaces();
  if (window.vpsApiBaseUrl) {
    refreshPlacesFromVps();
    return;
  }
  PLACE_LISTS.forEach((list) => {
    db.ref(`config/${list.key}`).on(
      'value',
      (snapshot) => {
        placesCache[list.key] = snapshot.val() || {};
        placesLoadError = '';
        renderPlaces();
      },
      (error) => {
        placesLoadError = error?.message || 'No se pudo leer Firebase.';
        renderPlaces();
      },
    );
  });
  refreshPlacesFromRest();
}

async function refreshPlacesFromVps() {
  try {
    const snapshot = await window.vpsConfigApi.publicConfig();
    PLACE_LISTS.forEach((list) => {
      const rows = Array.isArray(snapshot?.places?.[list.key]) ? snapshot.places[list.key] : [];
      placesCache[list.key] = Object.fromEntries(rows.map((place) => [place.id || place.name, place]));
    });
    placesLoadError = '';
  } catch (error) {
    placesLoadError = error?.message || 'No se pudieron cargar los lugares del VPS.';
  }
  renderPlaces();
}

async function refreshPlacesFromRest() {
  if (!FIREBASE_CONFIG_REST_URL) return;
  try {
    const results = await Promise.all(PLACE_LISTS.map(async (list) => {
      const response = await fetch(`${FIREBASE_CONFIG_REST_URL}/config/${list.key}.json`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Firebase ${response.status}`);
      return [list.key, (await response.json()) || {}];
    }));
    results.forEach(([key, value]) => { placesCache[key] = value; });
    placesLoadError = '';
    renderPlaces();
  } catch (error) {
    placesLoadError = error?.message || 'No se pudieron cargar los lugares.';
    renderPlaces();
  }
}

function renderPlaces() {
  const errorHtml = placesLoadError
    ? `<p class="settings-feedback error">No se pudo actualizar la lista: ${escapeHtml(placesLoadError)}. Reintentando con Firebase...</p>`
    : '';
  placesViewEl.innerHTML = errorHtml + PLACE_LISTS.map((list) => placeListCardHtml(list)).join('');

  PLACE_LISTS.forEach((list) => {
    document.getElementById(`place-form-${list.key}`).addEventListener('submit', (event) => {
      event.preventDefault();
      addPlace(list.key);
    });
  });

  placesViewEl.querySelectorAll('[data-delete-place]').forEach((button) => {
    button.addEventListener('click', () => {
      const [key, id] = button.getAttribute('data-delete-place').split('|');
      if (!confirm('Eliminar este lugar?')) return;
      if (window.vpsApiBaseUrl) {
        auth.currentUser.getIdToken()
          .then((token) => window.vpsConfigApi.request(`/api/v1/dashboard/places/${encodeURIComponent(id)}`, { token, method: 'DELETE' }))
          .then(() => refreshPlacesFromVps())
          .catch((error) => { placesLoadError = error.message || 'No se pudo eliminar.'; renderPlaces(); });
      } else {
        db.ref(`config/${key}/${id}`).remove();
      }
    });
  });
}

function placeListCardHtml(list) {
  const entries = Object.entries(placesCache[list.key] || {});
  const rows = entries.length
    ? entries.map(([id, place]) => `
        <li class="place-row">
          <div>
            <b>${escapeHtml(place.name || '-')}</b>
            <div class="place-address">${escapeHtml(place.address || '-')}</div>
          </div>
          <button type="button" class="place-delete-btn" data-delete-place="${list.key}|${id}">Eliminar</button>
        </li>
      `).join('')
    : '<p class="empty-list">Sin lugares todavia.</p>';

  return `
    <div class="settings-card place-settings-card">
      <h3>${list.label}</h3>
      <p class="settings-hint">Aparecen en la app de pasajeros al tocar el boton de ${list.label}.</p>
      <form id="place-form-${list.key}" class="settings-form place-form">
        <input type="text" id="place-name-${list.key}" placeholder="Nombre" required />
        <input type="text" id="place-address-${list.key}" placeholder="Direccion" required />
        <button type="submit">Agregar</button>
      </form>
      <p id="place-feedback-${list.key}" class="settings-feedback"></p>
      <ul class="place-list">${rows}</ul>
    </div>
  `;
}

async function addPlace(key) {
  const nameInput = document.getElementById(`place-name-${key}`);
  const addressInput = document.getElementById(`place-address-${key}`);
  const feedback = document.getElementById(`place-feedback-${key}`);
  const name = nameInput.value.trim();
  const address = addressInput.value.trim();
  if (!name || !address) return;

  feedback.textContent = 'Buscando direccion...';
  feedback.className = 'settings-feedback';

  try {
    if (!map || typeof map.geocodeAddress !== 'function') {
      throw new Error('El mapa todavia no esta listo');
    }
    const location = await map.geocodeAddress(address);
    const place = {
      name,
      address,
      lat: location.lat,
      lng: location.lng,
    };
    if (window.vpsApiBaseUrl) {
      const token = await auth.currentUser.getIdToken();
      await window.vpsConfigApi.request('/api/v1/dashboard/places', {
        token,
        method: 'POST',
        body: { category: key, ...place },
      });
      await refreshPlacesFromVps();
    } else {
      await db.ref(`config/${key}`).push(place);
    }
    nameInput.value = '';
    addressInput.value = '';
    feedback.textContent = 'Agregado.';
    feedback.className = 'settings-feedback success';
  } catch (error) {
    feedback.textContent = `Error al geocodificar o guardar: ${error.message || error}`;
    feedback.className = 'settings-feedback error';
  }
}
