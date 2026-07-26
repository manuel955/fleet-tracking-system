// ---------------------------------------------------------------------------
// Seccion "Lugares": sedes deportivas y hoteles que el pasajero elige desde
// botones flotantes en la app (sin escribir la direccion a mano). Viven en
// config/sportVenues y config/hotels (ver database/firebase-rules.json),
// lectura publica, escritura solo dashboard-admin -- mismo patron que el
// resto de config/ (settings.js).
// ---------------------------------------------------------------------------

const PLACE_LISTS = [
  { key: 'sportVenues', label: 'Sedes deportivas' },
  { key: 'hotels', label: 'Hoteles' },
];

const placesViewEl = document.getElementById('places-view');
let placesSubscribed = false;
let placesCache = {}; // key -> { $id: {name, address, lat, lng} }

function startPlaces() {
  if (placesSubscribed) return;
  placesSubscribed = true;
  PLACE_LISTS.forEach((list) => {
    db.ref(`config/${list.key}`).on('value', (snapshot) => {
      placesCache[list.key] = snapshot.val() || {};
      renderPlaces();
    });
  });
}

function renderPlaces() {
  placesViewEl.innerHTML = PLACE_LISTS.map((list) => placeListCardHtml(list)).join('');

  PLACE_LISTS.forEach((list) => {
    document.getElementById(`place-form-${list.key}`).addEventListener('submit', (e) => {
      e.preventDefault();
      addPlace(list.key);
    });
  });

  placesViewEl.querySelectorAll('[data-delete-place]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [key, id] = btn.getAttribute('data-delete-place').split('|');
      if (confirm('¿Eliminar este lugar?')) db.ref(`config/${key}/${id}`).remove();
    });
  });
}

function placeListCardHtml(list) {
  const entries = Object.entries(placesCache[list.key] || {});
  const rows = entries.length
    ? entries
        .map(
          ([id, p]) => `
        <li class="place-row">
          <div>
            <b>${escapeHtml(p.name || '-')}</b>
            <div class="place-address">${escapeHtml(p.address || '-')}</div>
          </div>
          <button type="button" class="place-delete-btn" data-delete-place="${list.key}|${id}">Eliminar</button>
        </li>
      `
        )
        .join('')
    : '<p class="empty-list">Sin lugares todavía.</p>';

  return `
    <div class="settings-card place-settings-card">
      <h3>${list.label}</h3>
      <p class="settings-hint">
        Aparecen en la app de pasajeros al tocar el botón "${list.label}" en
        Inicio, para pedir un viaje directo sin escribir la dirección.
      </p>
      <form id="place-form-${list.key}" class="settings-form place-form">
        <input type="text" id="place-name-${list.key}" placeholder="Nombre" required />
        <input type="text" id="place-address-${list.key}" placeholder="Dirección" required />
        <button type="submit">Agregar</button>
      </form>
      <p id="place-feedback-${list.key}" class="settings-feedback"></p>
      <ul class="place-list">${rows}</ul>
    </div>
  `;
}

function addPlace(key) {
  const nameInput = document.getElementById(`place-name-${key}`);
  const addressInput = document.getElementById(`place-address-${key}`);
  const feedback = document.getElementById(`place-feedback-${key}`);
  const name = nameInput.value.trim();
  const address = addressInput.value.trim();
  if (!name || !address) return;

  feedback.textContent = 'Buscando dirección...';
  feedback.className = 'settings-feedback';

  new google.maps.Geocoder().geocode({ address }, (results, status) => {
    if (status !== 'OK' || !results[0]) {
      feedback.textContent = 'No se encontró esa dirección. Revisa que esté bien escrita.';
      feedback.className = 'settings-feedback error';
      return;
    }
    const loc = results[0].geometry.location;
    db.ref(`config/${key}`)
      .push({ name, address, lat: loc.lat(), lng: loc.lng() })
      .then(() => {
        nameInput.value = '';
        addressInput.value = '';
        feedback.textContent = 'Agregado.';
        feedback.className = 'settings-feedback success';
      })
      .catch((err) => {
        feedback.textContent = `Error al guardar: ${err.message || err}`;
        feedback.className = 'settings-feedback error';
      });
  });
}
